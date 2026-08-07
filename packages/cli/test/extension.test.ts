/**
 * `ghost extension`, the terminal half of the approval gate.
 *
 * What is asserted here is the *review*: that the listing prints what an
 * operator has to weigh before approving, and that approving says what it
 * committed to. The gate itself — the digest, the drift, the four states — is
 * `@ghostai/security`'s, and testing it again through a CLI would be testing
 * the same branches with more scaffolding.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runExtension } from '#src/extension.js';
import { translationsFor } from '#src/i18n.js';

let home: string;
let out: string[];
let errOut: string[];

const t = translationsFor({ locale: 'en' });

function run(action: 'list' | 'approve' | 'revoke', id?: string): number {
  return runExtension({
    action,
    ...(id === undefined ? {} : { id }),
    home,
    out: (line) => out.push(line),
    errOut: (line) => errOut.push(line),
    env: {},
    t,
  });
}

function install(
  id: string,
  manifest: Record<string, unknown> = {},
  entry = 'export const extension = {};\n',
): string {
  const dir = join(home, 'extensions', id);
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(
    join(dir, 'ghostai.extension.json'),
    JSON.stringify({ schema: 'ghostai.extension/1', id, ...manifest }),
  );
  writeFileSync(join(dir, 'dist', 'index.js'), entry);
  return dir;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ghostai-ext-cli-'));
  out = [];
  errOut = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('ghost extension list', () => {
  it('says where to put one when there are none', () => {
    expect(run('list')).toBe(0);
    expect(out.join('\n')).toMatch(/No extensions installed under/);
    expect(out.join('\n')).toContain(join(home, 'extensions'));
  });

  it('prints what an operator has to weigh, not just the id', () => {
    // A review that shows only a name is a rubber stamp with extra steps.
    install('slack', {
      version: '1.2.0',
      description: 'Talk to the agent from Slack.',
      contributes: ['channels', 'commands'],
    });

    expect(run('list')).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('slack  [UNAPPROVED]');
    expect(text).toContain('version    1.2.0');
    expect(text).toContain('about      Talk to the agent from Slack.');
    expect(text).toContain('entry      dist/index.js');
    expect(text).toContain('adds       channels, commands');
  });

  it('says so plainly when an extension declares nothing', () => {
    // Which is not the same as harmless: it still runs arbitrary code, and a
    // blank field would read as "nothing to see here".
    install('quiet');

    run('list');

    expect(out.join('\n')).toContain('adds       nothing declared');
  });

  it('carries the whole refusal, which already names the fix', () => {
    install('slack');

    run('list');

    expect(out.join('\n')).toMatch(/ghost extension approve slack/);
  });

  it('reports a broken extension rather than hiding it', () => {
    // One that vanished from the list looks like one that was never installed,
    // and the operator goes looking in the wrong place.
    const dir = join(home, 'extensions', 'broken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ghostai.extension.json'), '{');

    expect(run('list')).toBe(0);
    expect(out.join('\n')).toContain('broken  [FAILED]');
  });
});

describe('ghost extension approve', () => {
  it('records the digest and says what that commits to', () => {
    install('slack', { contributes: ['tools'] });

    expect(run('approve', 'slack')).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('Approved slack:');
    expect(text).toMatch(/digest {5}sha256:[0-9a-f]{64}/);
    expect(text).toMatch(/changes the digest and revokes/);
    // The sentence that matters most: an operator approving this is granting
    // the code the server's own access, and nothing else on the screen says so.
    expect(text).toMatch(/runs in the server process/);
  });

  it('makes the row read approved afterwards', () => {
    install('slack');
    run('approve', 'slack');
    out = [];

    run('list');

    expect(out.join('\n')).toContain('slack  [approved]');
  });

  it('is revoked by editing any file under the directory', () => {
    // The whole reason the digest covers the tree rather than the manifest.
    const dir = install('slack');
    run('approve', 'slack');
    writeFileSync(join(dir, 'dist', 'index.js'), 'export const extension = 1;');
    out = [];

    run('list');

    expect(out.join('\n')).toContain('slack  [DRIFTED]');
  });

  it('refuses an id that is not installed, with a message and a 1', () => {
    expect(run('approve', 'nope')).toBe(1);
    expect(errOut.join('\n')).toBeTruthy();
  });

  it('asks which one when no id was given', () => {
    // A 2 rather than a 1: the operator's command line was wrong, not the
    // install.
    expect(run('approve')).toBe(2);
    expect(errOut.join('\n')).toMatch(/ghost extension list/);
  });
});

describe('ghost extension revoke', () => {
  it('forgets the approval and leaves the files alone', () => {
    install('slack');
    run('approve', 'slack');
    out = [];

    expect(run('revoke', 'slack')).toBe(0);
    expect(out.join('\n')).toMatch(/still installed/);

    out = [];
    run('list');
    expect(out.join('\n')).toContain('slack  [UNAPPROVED]');
  });
});

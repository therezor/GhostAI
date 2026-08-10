import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveGhostPaths } from '@ghostwire/core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_SKILL_FILES,
  MAX_SKILL_FILE_BYTES,
  installSkills,
  skillsTargetDir,
} from '#src/skill-install.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() ?? '', { recursive: true, force: true });
  }
});

/**
 * A disposable root.
 *
 * `realpath` because macOS hands out `/var/folders/…`, a symlink into
 * `/private/var`, and a test comparing a path it wrote against one it read back
 * passes on Linux and fails on a reviewer's laptop without it.
 */
function root(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ghostai-skillcopy-')));
  roots.push(dir);
  return dir;
}

interface Sheet {
  readonly agents?: string;
  readonly extras?: Readonly<Record<string, string>>;
}

/** A catalogue holding the named sheets. */
function catalogue(sheets: Readonly<Record<string, Sheet>>): string {
  const dir = join(root(), 'skills');
  for (const [name, sheet] of Object.entries(sheets)) {
    const sheetDir = join(dir, name);
    mkdirSync(sheetDir, { recursive: true });
    const scope = sheet.agents === undefined ? '' : `agents: ${sheet.agents}\n`;
    writeFileSync(
      join(sheetDir, 'SKILL.md'),
      `---\ndescription: What ${name} does.\n${scope}---\n\nBody of ${name}.\n`,
    );
    for (const [file, contents] of Object.entries(sheet.extras ?? {})) {
      const path = join(sheetDir, file);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, contents);
    }
  }
  return dir;
}

function target(): string {
  return join(root(), 'workspace', 'skills');
}

describe('installSkills', () => {
  it('copies a sheet and its attachments, byte for byte', () => {
    const skills = catalogue({
      'code-review': { extras: { 'checklist.md': '- Read it.\n' } },
    });
    const targetDir = target();

    const result = installSkills({
      presetId: 'coder',
      names: ['code-review'],
      catalogueSkillsDir: skills,
      targetDir,
      force: false,
    });

    expect(result.written).toEqual([{ name: 'code-review', files: 2 }]);
    expect(
      readFileSync(join(targetDir, 'code-review', 'SKILL.md'), 'utf8'),
    ).toBe(readFileSync(join(skills, 'code-review', 'SKILL.md'), 'utf8'));
    expect(
      readFileSync(join(targetDir, 'code-review', 'checklist.md'), 'utf8'),
    ).toBe('- Read it.\n');
  });

  it('does nothing at all when the preset names no sheets', () => {
    expect(
      installSkills({
        presetId: 'coder',
        names: [],
        catalogueSkillsDir: catalogue({}),
        targetDir: target(),
        force: false,
      }).written,
    ).toEqual([]);
  });

  it('reports a sheet this catalogue does not carry, and installs the rest', () => {
    // A warning rather than a refusal, unlike the toolbox half: an agent with
    // one fewer index line runs, and an agent with no toolbox cannot.
    const result = installSkills({
      presetId: 'coder',
      names: ['code-review', 'ghost-ops'],
      catalogueSkillsDir: catalogue({ 'code-review': {} }),
      targetDir: target(),
      force: false,
    });

    expect(result.missing).toEqual(['ghost-ops']);
    expect(result.written.map((sheet) => sheet.name)).toEqual(['code-review']);
  });

  it('reports every sheet as missing when there is no catalogue at all', () => {
    // The ordinary case for `ghostai agent install` with an operator's own
    // preset on a box that has never fetched a catalogue.
    const result = installSkills({
      presetId: 'coder',
      names: ['code-review'],
      catalogueSkillsDir: undefined,
      targetDir: target(),
      force: false,
    });

    expect(result.missing).toEqual(['code-review']);
    expect(result.written).toEqual([]);
  });

  it('treats a directory with no SKILL.md as absent', () => {
    // A half-checkout. Copying it would report a sheet installed that
    // `readSkills` then silently skips, with nothing anywhere saying why.
    const skills = join(root(), 'skills');
    mkdirSync(join(skills, 'code-review'), { recursive: true });
    writeFileSync(join(skills, 'code-review', 'notes.md'), 'Nothing.');

    expect(
      installSkills({
        presetId: 'coder',
        names: ['code-review'],
        catalogueSkillsDir: skills,
        targetDir: target(),
        force: false,
      }).missing,
    ).toEqual(['code-review']);
  });

  it('leaves a sheet the workspace already has alone', () => {
    const skills = catalogue({ 'code-review': {} });
    const targetDir = target();
    mkdirSync(join(targetDir, 'code-review'), { recursive: true });
    writeFileSync(join(targetDir, 'code-review', 'SKILL.md'), 'Mine.\n');

    const result = installSkills({
      presetId: 'coder',
      names: ['code-review'],
      catalogueSkillsDir: skills,
      targetDir,
      force: false,
    });

    expect(result.kept).toEqual(['code-review']);
    expect(result.written).toEqual([]);
    expect(
      readFileSync(join(targetDir, 'code-review', 'SKILL.md'), 'utf8'),
    ).toBe('Mine.\n');
  });

  it('overwrites with force, without deleting what it did not bring', () => {
    // File by file rather than a wipe: removing an operator's own file from
    // inside a sheet directory is a larger claim than `--force` makes.
    const skills = catalogue({ 'code-review': {} });
    const targetDir = target();
    mkdirSync(join(targetDir, 'code-review'), { recursive: true });
    writeFileSync(join(targetDir, 'code-review', 'SKILL.md'), 'Mine.\n');
    writeFileSync(join(targetDir, 'code-review', 'notes.md'), 'Keep me.\n');

    const result = installSkills({
      presetId: 'coder',
      names: ['code-review'],
      catalogueSkillsDir: skills,
      targetDir,
      force: true,
    });

    expect(result.written).toEqual([{ name: 'code-review', files: 1 }]);
    expect(
      readFileSync(join(targetDir, 'code-review', 'SKILL.md'), 'utf8'),
    ).toContain('Body of code-review.');
    expect(
      readFileSync(join(targetDir, 'code-review', 'notes.md'), 'utf8'),
    ).toBe('Keep me.\n');
  });

  it('skips a symlink inside a sheet rather than following it', () => {
    const skills = catalogue({ 'code-review': {} });
    const secret = join(root(), 'secret.txt');
    writeFileSync(secret, 'not yours');
    symlinkSync(secret, join(skills, 'code-review', 'link.txt'));
    const targetDir = target();

    const result = installSkills({
      presetId: 'coder',
      names: ['code-review'],
      catalogueSkillsDir: skills,
      targetDir,
      force: false,
    });

    expect(result.written).toEqual([{ name: 'code-review', files: 1 }]);
    expect(result.warnings).toEqual([
      'skill "code-review" contains a symlink (link.txt), which was skipped',
    ]);
  });

  it('treats a symlinked sheet directory as absent', () => {
    const skills = catalogue({});
    const outside = join(root(), 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'SKILL.md'), '---\ndescription: X.\n---\n\nB.');
    mkdirSync(skills, { recursive: true });
    symlinkSync(outside, join(skills, 'escaped'), 'dir');

    expect(
      installSkills({
        presetId: 'coder',
        names: ['escaped'],
        catalogueSkillsDir: skills,
        targetDir: target(),
        force: false,
      }).missing,
    ).toEqual(['escaped']);
  });

  it('stops a sheet that holds more files than the cap', () => {
    const extras: Record<string, string> = {};
    for (let index = 0; index <= MAX_SKILL_FILES; index += 1) {
      extras[`note-${String(index)}.md`] = 'x';
    }
    const skills = catalogue({ 'code-review': { extras } });

    const result = installSkills({
      presetId: 'coder',
      names: ['code-review'],
      catalogueSkillsDir: skills,
      targetDir: target(),
      force: false,
    });

    expect(result.written).toEqual([]);
    expect(result.warnings[0]).toContain('more than 64 files');
  });

  it('skips one oversized file and keeps the rest of the sheet', () => {
    const skills = catalogue({
      'code-review': {
        extras: {
          'huge.bin': 'x'.repeat(MAX_SKILL_FILE_BYTES + 1),
          'notes.md': 'small',
        },
      },
    });
    const targetDir = target();

    const result = installSkills({
      presetId: 'coder',
      names: ['code-review'],
      catalogueSkillsDir: skills,
      targetDir,
      force: false,
    });

    // The sheet still installs — one file is dropped, not the page.
    expect(result.written).toEqual([{ name: 'code-review', files: 2 }]);
    expect(existsSync(join(targetDir, 'code-review', 'huge.bin'))).toBe(false);
    expect(existsSync(join(targetDir, 'code-review', 'notes.md'))).toBe(true);
    expect(result.warnings[0]).toContain('a file over 1024 KB');
  });

  it('stops a sheet that nests deeper than the cap', () => {
    const skills = catalogue({
      'code-review': { extras: { 'a/b/c/d/e/deep.md': 'too far' } },
    });

    const result = installSkills({
      presetId: 'coder',
      names: ['code-review'],
      catalogueSkillsDir: skills,
      targetDir: target(),
      force: false,
    });

    expect(result.written).toEqual([]);
    expect(result.warnings[0]).toContain('nests deeper than 4 levels');
  });

  it('stops when the sheets together come to more than the total', () => {
    // The budget is shared across every sheet in one install, so this is the
    // one bound a single sheet cannot trip on its own.
    const megabyte = 'x'.repeat(MAX_SKILL_FILE_BYTES);
    const extras: Record<string, string> = {};
    for (let index = 0; index < 9; index += 1) {
      extras[`part-${String(index)}.bin`] = megabyte;
    }
    const skills = catalogue({ big: { extras } });

    const result = installSkills({
      presetId: 'coder',
      names: ['big'],
      catalogueSkillsDir: skills,
      targetDir: target(),
      force: false,
    });

    expect(result.written).toEqual([]);
    expect(result.warnings[0]).toContain('more than 8 MB');
  });

  it('warns when a sheet is scoped away from the agent that brought it', () => {
    const result = installSkills({
      presetId: 'coder',
      names: ['triage'],
      catalogueSkillsDir: catalogue({ triage: { agents: 'team-lead' } }),
      targetDir: target(),
      force: false,
    });

    expect(result.written).toHaveLength(1);
    expect(result.warnings).toEqual([
      'skill "triage" is scoped to team-lead, so the coder agent will not see it',
    ]);
  });

  it('says nothing when a sheet names this agent, or names none', () => {
    // An absent `agents:` means every agent, which includes this one. Asserted
    // so that "it did not warn" reads as a decision rather than an oversight.
    const result = installSkills({
      presetId: 'coder',
      names: ['shared', 'mine'],
      catalogueSkillsDir: catalogue({
        shared: {},
        mine: { agents: 'writer, coder' },
      }),
      targetDir: target(),
      force: false,
    });

    expect(result.warnings).toEqual([]);
  });
});

describe('skillsTargetDir', () => {
  function paths(home: string): ReturnType<typeof resolveGhostPaths> {
    return resolveGhostPaths({ root: home, env: {} });
  }

  it('is the default workspace, and creates nothing while resolving', () => {
    // Every install path calls this before it knows whether any preset names a
    // sheet. A `mkdir` here would make `<root>/workspace` on every
    // `ghostai agent install`, and would turn an unwritable root into an ENOENT
    // thrown over whatever the real error was.
    const home = root();
    const resolved = paths(home);

    expect(skillsTargetDir(resolved, 'default')).toBe(
      join(resolved.workspace, 'skills'),
    );
    expect(existsSync(resolved.workspace)).toBe(false);
  });

  it('is a named workspace when it exists', () => {
    const home = root();
    const resolved = paths(home);
    mkdirSync(join(resolved.workspace, 'acme'), { recursive: true });

    expect(skillsTargetDir(resolved, 'acme')).toBe(
      join(resolved.workspace, 'acme', 'skills'),
    );
  });

  it('refuses a named workspace that does not exist', () => {
    // `workspaceDirFor` validates the shape of an id and joins; the registry is
    // in SQLite and it never asks. Without this, a typo would create a tree no
    // UI ever lists and nothing ever reads.
    expect(() => skillsTargetDir(paths(root()), 'typo')).toThrow(
      /no typo workspace/,
    );
  });

  it('refuses an id that is not a workspace id at all', () => {
    expect(() => skillsTargetDir(paths(root()), '../escape')).toThrow(
      /Not a workspace id/,
    );
  });
});

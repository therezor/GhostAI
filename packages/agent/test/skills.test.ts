import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLogger, type Logger } from '@ghostwire/core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_DESCRIPTION_CHARS,
  MAX_SKILLS,
  SKILL_MAX_BYTES,
  parseSkillAgents,
  readSkills,
  skillsForAgent,
  type Skill,
} from '#src/skills.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() ?? '', { recursive: true, force: true });
  }
});

/**
 * A disposable workspace root.
 *
 * `realpath` is not optional: macOS hands out `/var/folders/…`, a symlink into
 * `/private/var`, and a test that compares the path it wrote against the path it
 * read back passes on Linux and fails on a reviewer's laptop without it.
 */
function workspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ghostai-skills-')));
  roots.push(root);
  return root;
}

function install(root: string, name: string, contents: string): void {
  const dir = join(root, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), contents);
}

function skill(description: string, body = 'Do the thing.'): string {
  return `---\ndescription: ${description}\n---\n\n${body}\n`;
}

interface Capture {
  readonly logger: Logger;
  readonly messages: () => string[];
}

function capture(): Capture {
  const chunks: string[] = [];
  const logger = createLogger({
    level: 'warn',
    destination: {
      write(chunk: string): void {
        chunks.push(chunk);
      },
    },
  });
  return {
    logger,
    messages: () =>
      chunks.map((chunk) => (JSON.parse(chunk) as { msg?: string }).msg ?? ''),
  };
}

describe('readSkills', () => {
  it('reads a directory holding a SKILL.md', async () => {
    const root = workspace();
    install(root, 'code-review', skill('Review a diff.', 'Read it. Judge it.'));

    expect(await readSkills(root)).toEqual([
      {
        name: 'code-review',
        description: 'Review a diff.',
        body: 'Read it. Judge it.',
        // Always POSIX separators: this string is handed to the model to pass
        // back to `read_file`.
        path: 'skills/code-review/SKILL.md',
        // No `agents:` line, so every agent's catalogue carries it.
        agents: [],
      },
    ]);
  });

  it('returns nothing when the workspace has no skills folder', async () => {
    // The ordinary case for every workspace that has not adopted them, so it is
    // the empty array rather than a throw or a log line.
    expect(await readSkills(workspace())).toEqual([]);
  });

  it('sorts by name, so the cached prompt prefix does not move', async () => {
    const root = workspace();
    install(root, 'zebra', skill('Last.'));
    install(root, 'alpha', skill('First.'));

    expect((await readSkills(root)).map((entry) => entry.name)).toEqual([
      'alpha',
      'zebra',
    ]);
  });

  it('skips a directory with no SKILL.md, and says so', async () => {
    const root = workspace();
    mkdirSync(join(root, 'skills', 'empty'), { recursive: true });
    install(root, 'real', skill('Kept.'));
    const log = capture();

    expect((await readSkills(root, { logger: log.logger })).map((s) => s.name)) //
      .toEqual(['real']);
    expect(log.messages()).toContain('skill has no readable SKILL.md');
  });

  it('skips a skill with no description', async () => {
    // The description is the whole basis on which a model opens the file, so a
    // skill without one cannot be advertised at all.
    const root = workspace();
    install(root, 'nameless', '---\nname: nameless\n---\n\nBody.');
    const log = capture();

    expect(await readSkills(root, { logger: log.logger })).toEqual([]);
    expect(log.messages()).toContain(
      'skill has no description and is not advertised',
    );
  });

  it('skips a skill whose description is only whitespace', async () => {
    const root = workspace();
    install(root, 'blank', '---\ndescription: "   "\n---\n\nBody.');

    expect(await readSkills(root)).toEqual([]);
  });

  it('lets the directory name win over a disagreeing frontmatter name', async () => {
    const root = workspace();
    install(
      root,
      'on-disk',
      '---\nname: in-frontmatter\ndescription: A.\n---\n\nBody.',
    );
    const log = capture();

    const [entry] = await readSkills(root, { logger: log.logger });
    expect(entry?.name).toBe('on-disk');
    expect(log.messages()).toContain(
      'skill name disagrees with its directory; the directory wins',
    );
  });

  it('says nothing when the frontmatter name agrees', async () => {
    const root = workspace();
    install(root, 'agreed', '---\nname: agreed\ndescription: A.\n---\n\nB.');
    const log = capture();

    await readSkills(root, { logger: log.logger });
    expect(log.messages()).toEqual([]);
  });

  it('collapses runs of whitespace in a description', async () => {
    // It becomes a bullet in the index, so anything that could break the line
    // is flattened before it gets there.
    const root = workspace();
    install(root, 'spaced', '---\ndescription: One\t \t two\n---\n\nBody.');

    expect((await readSkills(root))[0]?.description).toBe('One two');
  });

  it('truncates a long description', async () => {
    const root = workspace();
    install(root, 'verbose', skill('x'.repeat(MAX_DESCRIPTION_CHARS + 50)));

    const description = (await readSkills(root))[0]?.description ?? '';
    expect(description).toHaveLength(MAX_DESCRIPTION_CHARS);
    expect(description.endsWith('…')).toBe(true);
  });

  it('truncates a body past the byte cap and says it did', async () => {
    const root = workspace();
    install(root, 'huge', skill('Big.', 'y'.repeat(SKILL_MAX_BYTES + 1000)));

    const body = (await readSkills(root))[0]?.body ?? '';
    expect(body.startsWith('y'.repeat(100))).toBe(true);
    expect(body).toContain('Truncated');
  });

  it('skips a symlinked skill directory', async () => {
    // `isDirectory()` is already false for a symlink, which is what keeps a
    // link pointing out of the workspace from ever being read. Asserted rather
    // than assumed, because the guard is a property of Dirent rather than a
    // line of code someone would notice deleting.
    const root = workspace();
    install(root, 'real', skill('Kept.'));
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'SKILL.md'), skill('Escaped.'));
    symlinkSync(outside, join(root, 'skills', 'linked'), 'dir');

    expect((await readSkills(root)).map((entry) => entry.name)).toEqual([
      'real',
    ]);
  });

  it('stops at the cap and says how many it found', async () => {
    const root = workspace();
    for (let index = 0; index < MAX_SKILLS + 5; index += 1) {
      install(root, `skill-${String(index).padStart(3, '0')}`, skill('A.'));
    }
    const log = capture();

    expect(await readSkills(root, { logger: log.logger })).toHaveLength(
      MAX_SKILLS,
    );
    expect(log.messages()).toContain(
      'more skill directories than the cap; the rest are not advertised',
    );
  });

  it('reads a skill whose SKILL.md has no frontmatter as unloadable', async () => {
    const root = workspace();
    install(root, 'plain', '# Just markdown\n\nNo fence.');

    expect(await readSkills(root)).toEqual([]);
  });

  it('carries the agents a sheet is scoped to', async () => {
    const root = workspace();
    install(
      root,
      'refactor',
      '---\ndescription: How to refactor.\nagents: coder\n---\n\nBody.\n',
    );

    expect((await readSkills(root))[0]?.agents).toEqual(['coder']);
  });
});

describe('parseSkillAgents', () => {
  function parse(value: string | undefined): {
    readonly agents: readonly string[];
    readonly messages: readonly string[];
  } {
    const log = capture();
    const agents = parseSkillAgents(value, {
      skill: 'refactor',
      logger: log.logger,
    });
    return { agents, messages: log.messages() };
  }

  it('is every agent when the line is absent, and says nothing about it', () => {
    // The overwhelmingly common case, and every sheet written before scope
    // existed. A log line here would be a log line on every turn, forever.
    const { agents, messages } = parse(undefined);

    expect(agents).toEqual([]);
    expect(messages).toEqual([]);
  });

  it('reads one id, and a comma-separated list', () => {
    expect(parse('coder').agents).toEqual(['coder']);
    expect(parse('coder, writer').agents).toEqual(['coder', 'writer']);
  });

  it('trims, lower-cases and de-duplicates', () => {
    const { agents, messages } = parse('  coder ,  Writer , coder ');

    expect(agents).toEqual(['coder', 'writer']);
    // Lower-casing is not cosmetic: `isAgentId` rejects an upper-case id, so
    // without it `Writer` would be dropped rather than matched.
    expect(messages).toEqual([]);
  });

  it('accepts the YAML flow form somebody will write out of habit', () => {
    expect(parse('[coder, writer]').agents).toEqual(['coder', 'writer']);
    // The per-item unquote earns its place here and only here: the outer value
    // is not quoted, so `frontmatter.ts` leaves the inner quotes alone.
    expect(parse('[coder, "writer"]').agents).toEqual(['coder', 'writer']);
  });

  it('keeps the usable ids and warns about the rest', () => {
    const { agents, messages } = parse('coder, Not An Id');

    expect(agents).toEqual(['coder']);
    expect(messages).toEqual([
      'skill `agents:` names something that is not an agent id; those entries ' +
        'are ignored',
    ]);
  });

  it('falls open to every agent when nothing in the line is usable', () => {
    // Not scoped-to-nobody. A sheet is prose, so being shown too widely costs
    // prompt a person can see in `/skills`, and being hidden from everybody is
    // a sheet that silently stopped working with nothing anywhere to find.
    for (const value of ['', '!!, ??', '   ']) {
      const { agents, messages } = parse(value);

      expect(agents).toEqual([]);
      expect(messages).toEqual([
        'skill `agents:` names no usable agent id, so the sheet stays visible ' +
          'to every agent; write it as `agents: coder, writer`',
      ]);
    }
  });

  it('warns exactly once, however many entries are bad', () => {
    // `readSkills` re-reads on every turn, so a second line here is a second
    // line forever.
    expect(parse('!!, ??, coder, ***').messages).toHaveLength(1);
  });
});

describe('a YAML block list under agents:', () => {
  it('is read as an empty line, and warned about', async () => {
    // The trap, and the reason the empty case warns at all. `parseFrontmatter`
    // anchors its field pattern on a letter, so `- coder` never matches: it
    // clears the parent and is discarded, leaving `agents: ''`. A block list is
    // therefore indistinguishable from a bare `agents:` by the time the value
    // is read, and this is a property of the frontmatter reader that nothing
    // else in the suite pins.
    const root = workspace();
    install(
      root,
      'refactor',
      '---\ndescription: How to refactor.\nagents:\n  - coder\n---\n\nBody.\n',
    );
    const log = capture();

    expect((await readSkills(root, { logger: log.logger }))[0]?.agents).toEqual(
      [],
    );
    expect(log.messages()).toContain(
      'skill `agents:` names no usable agent id, so the sheet stays visible ' +
        'to every agent; write it as `agents: coder, writer`',
    );
  });
});

describe('skillsForAgent', () => {
  function sheet(name: string, agents: readonly string[]): Skill {
    return {
      name,
      description: `The ${name} sheet.`,
      body: 'Body.',
      path: `skills/${name}/SKILL.md`,
      agents,
    };
  }

  const shared = sheet('code-review', []);
  const scoped = sheet('refactor', ['coder']);
  const shortlist = sheet('triage', ['coder', 'team-lead']);

  it('gives every agent the unscoped sheets', () => {
    expect(skillsForAgent([shared], 'writer')).toEqual([shared]);
    expect(skillsForAgent([shared], 'default')).toEqual([shared]);
  });

  it('gives a scoped sheet only to the agents it names', () => {
    expect(skillsForAgent([shared, scoped, shortlist], 'coder')).toEqual([
      shared,
      scoped,
      shortlist,
    ]);
    expect(skillsForAgent([shared, scoped, shortlist], 'team-lead')).toEqual([
      shared,
      shortlist,
    ]);
    expect(skillsForAgent([shared, scoped, shortlist], 'writer')).toEqual([
      shared,
    ]);
  });

  it('scopes to `default` like any other agent', () => {
    expect(skillsForAgent([sheet('a', ['default'])], 'default')).toHaveLength(
      1,
    );
    expect(skillsForAgent([sheet('a', ['default'])], 'coder')).toEqual([]);
  });

  it('matches case-insensitively, since an id reaching it may not be folded', () => {
    expect(skillsForAgent([scoped], 'Coder')).toEqual([scoped]);
  });

  it('is empty for an empty catalogue', () => {
    expect(skillsForAgent([], 'coder')).toEqual([]);
  });
});

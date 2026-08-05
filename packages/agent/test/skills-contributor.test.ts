import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLogger, type Logger } from '@ghostai/core';
import type { ParsedMentions } from '@ghostai/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import type { RuntimePromptContext, StaticPromptContext } from '#src/prompt.js';
import { SkillsContributor, renderSkills } from '#src/skills-contributor.js';
import type { Skill } from '#src/skills.js';

function make(name: string, body = `Body of ${name}.`): Skill {
  return {
    name,
    description: `What ${name} does.`,
    body,
    path: `skills/${name}/SKILL.md`,
  };
}

const NONE = { pinned: [], maxPinned: 5 };

describe('renderSkills', () => {
  it('renders nothing for an empty catalogue', () => {
    // Empty rather than a bare heading: `contributorSections` drops a section
    // that trims to nothing, so this is how "no skills" becomes "no section".
    expect(renderSkills([], NONE)).toBe('');
  });

  it('indexes a skill as one line naming its path', () => {
    const section = renderSkills([make('review')], NONE);

    expect(section).toContain('## Skills');
    expect(section).toContain(
      '- `skills/review/SKILL.md` — **review**: What review does.',
    );
    // The index is a summary; the body stays on disk until the model asks.
    expect(section).not.toContain('Body of review.');
  });

  it('inlines a pinned skill and drops it from the index', () => {
    const section = renderSkills([make('a'), make('b')], {
      pinned: ['a'],
      maxPinned: 5,
    });

    expect(section).toContain('### Skill: a');
    expect(section).toContain('Body of a.');
    expect(section).not.toContain('`skills/a/SKILL.md`');
    expect(section).toContain('`skills/b/SKILL.md`');
  });

  it('keeps the framing when everything is pinned, and adds no empty index', () => {
    // This reverses an earlier rule, and the reversal is the price of the
    // section being an operator's template. The preamble used to be dropped
    // when the index was empty, because it told the model to open the files
    // below it and there were none — a conditional a placeholder cannot
    // express. The wording is now true either way ("a line below", not "each
    // line below"), and what is actually absent is the index block itself.
    const section = renderSkills([make('a')], { pinned: ['a'], maxPinned: 5 });

    expect(section).toContain('### Skill: a');
    expect(section).not.toContain('`skills/a/SKILL.md`');
    // No gap where the index would have been.
    expect(section).not.toContain('\n\n\n');
  });

  it('pins in the operator order, not the catalogue order', () => {
    // `pinnedSkills: ['c', 'a']` under a cap of one means c. Taking the
    // catalogue's order would silently pin whichever sorted first.
    const section = renderSkills([make('a'), make('c')], {
      pinned: ['c', 'a'],
      maxPinned: 1,
    });

    expect(section).toContain('### Skill: c');
    expect(section).not.toContain('### Skill: a');
    expect(section).toContain('`skills/a/SKILL.md`');
  });

  it('falls back to an index line past maxPinnedSkills', () => {
    const section = renderSkills([make('a'), make('b')], {
      pinned: ['a', 'b'],
      maxPinned: 1,
    });

    expect(section).toContain('### Skill: a');
    expect(section).toContain('`skills/b/SKILL.md`');
  });

  it('pins nothing when maxPinnedSkills is zero', () => {
    const section = renderSkills([make('a')], { pinned: ['a'], maxPinned: 0 });

    expect(section).not.toContain('### Skill: a');
    expect(section).toContain('`skills/a/SKILL.md`');
  });

  it('ignores a pin that names nothing', () => {
    const section = renderSkills([make('a')], {
      pinned: ['ghost'],
      maxPinned: 5,
    });

    expect(section).toContain('`skills/a/SKILL.md`');
    expect(section).not.toContain('ghost');
  });

  it('counts a repeated pin once', () => {
    // Otherwise `['a', 'a']` under a cap of two would spend the whole budget on
    // one skill and index the other.
    const section = renderSkills([make('a'), make('b')], {
      pinned: ['a', 'a', 'b'],
      maxPinned: 2,
    });

    expect(section).toContain('### Skill: a');
    expect(section).toContain('### Skill: b');
  });
});

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() ?? '', { recursive: true, force: true });
  }
});

function workspace(skills: Readonly<Record<string, string>> = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ghostai-skillctx-')));
  roots.push(root);
  for (const [name, description] of Object.entries(skills)) {
    const dir = join(root, 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\ndescription: ${description}\n---\n\nBody of ${name}.\n`,
    );
  }
  return root;
}

function staticContext(workspaceRoot: string): StaticPromptContext {
  return {
    workspaceRoot,
    workspaceId: 'default',
    sessionKey: 'session-1',
    agentId: 'default',
    channel: 'web',
  };
}

function runtimeContext(mentions?: ParsedMentions): RuntimePromptContext {
  return {
    ...staticContext('/unused'),
    iteration: 1,
    maxIterations: 40,
    nowMs: 0,
    ...(mentions === undefined ? {} : { mentions }),
  };
}

function mentioning(...skill: string[]): ParsedMentions {
  return { kb: [], mcp: [], skill, all: [] };
}

interface Capture {
  readonly logger: Logger;
  readonly messages: () => string[];
}

function capture(): Capture {
  const chunks: string[] = [];
  return {
    logger: createLogger({
      level: 'warn',
      destination: {
        write(chunk: string): void {
          chunks.push(chunk);
        },
      },
    }),
    messages: () =>
      chunks.map((chunk) => (JSON.parse(chunk) as { msg?: string }).msg ?? ''),
  };
}

describe('renderSkills templates', () => {
  it('renders nothing for a template that is a single space', () => {
    // The contract the other seven templates keep: empty inherits the built-in
    // and a space deletes the section, because empty already means "inherit".
    expect(
      renderSkills([make('deploy'), make('review')], {
        pinned: [],
        maxPinned: 0,
        template: ' ',
      }),
    ).toBe('');
  });

  it('uses an operator template verbatim, filling its placeholders', () => {
    const section = renderSkills([make('deploy'), make('review')], {
      pinned: [],
      maxPinned: 0,
      template: 'Sheets in {{path}} — {{count}}.\n\n{{indexLines}}',
    });

    expect(section).toContain('Sheets in skills — 2.');
    expect(section).not.toContain('## Skills');
  });

  it('leaves no gap when nothing is pinned', () => {
    // `{{pinned}}` carries its own leading blank line, so an unpinned catalogue
    // must not end on the blank line that half would have opened with.
    const section = renderSkills([make('deploy'), make('review')], {
      pinned: [],
      maxPinned: 0,
    });

    expect(section).not.toMatch(/\n\n$/u);
    expect(section).not.toContain('### Skill:');
  });

  it('leaves no gap when everything is pinned', () => {
    // The opposite half, and the case the old wording dropped a paragraph for.
    const section = renderSkills([make('deploy'), make('review')], {
      pinned: ['deploy', 'review'],
      maxPinned: 5,
    });

    expect(section).toContain('### Skill: deploy');
    expect(section).not.toMatch(/\n\n\n/u);
  });
});

describe('SkillsContributor', () => {
  it('reads the workspace named by the context, not one it remembers', async () => {
    // One AgentLoop serves every session on an agent, and those sessions can be
    // bound to different workspaces. A contributor that cached its first answer
    // would hand one workspace's skills to a turn in another.
    const contributor = new SkillsContributor({ pinned: [], maxPinned: 5 });
    const first = workspace({ alpha: 'From the first.' });
    const second = workspace({ beta: 'From the second.' });

    expect(await contributor.staticSection(staticContext(first))).toContain(
      'alpha',
    );
    expect(await contributor.staticSection(staticContext(second))).toContain(
      'beta',
    );
  });

  it('places no section when the workspace has no skills', async () => {
    const contributor = new SkillsContributor({ pinned: [], maxPinned: 5 });

    expect(
      await contributor.staticSection(staticContext(workspace())),
    ).toBeUndefined();
  });

  it('warns when a pin names a skill the workspace does not have', async () => {
    const log = capture();
    const contributor = new SkillsContributor({
      pinned: ['missing'],
      maxPinned: 5,
      logger: log.logger,
    });

    await contributor.staticSection(staticContext(workspace({ real: 'A.' })));
    expect(log.messages()).toContain(
      'pinnedSkills names a skill this workspace does not have',
    );
  });

  it('warns when more skills are pinned than the cap allows', async () => {
    const log = capture();
    const contributor = new SkillsContributor({
      pinned: ['a', 'b'],
      maxPinned: 1,
      logger: log.logger,
    });

    await contributor.staticSection(
      staticContext(workspace({ a: 'A.', b: 'B.' })),
    );
    expect(log.messages()).toContain(
      'more skills pinned than maxPinnedSkills allows; the rest are indexed',
    );
  });

  it('does not count a repeated pin towards the cap when warning', async () => {
    const log = capture();
    const contributor = new SkillsContributor({
      pinned: ['a', 'a'],
      maxPinned: 1,
      logger: log.logger,
    });

    await contributor.staticSection(staticContext(workspace({ a: 'A.' })));
    expect(log.messages()).toEqual([]);
  });

  it('places nothing in the runtime half without @skill: mentions', () => {
    const contributor = new SkillsContributor({ pinned: [], maxPinned: 5 });

    expect(contributor.runtimeSection(runtimeContext())).toBeUndefined();
    expect(contributor.runtimeSection(runtimeContext(mentioning()))) //
      .toBeUndefined();
  });

  it('tells the model to read the skills this message named', () => {
    // The runtime half rather than the static one: this is a property of one
    // message, and a static section that moved per turn would end the
    // session's cached prefix on every turn.
    const contributor = new SkillsContributor({ pinned: [], maxPinned: 5 });

    expect(
      contributor.runtimeSection(runtimeContext(mentioning('a', 'b'))),
    ).toBe(
      'Skills named on this message: read `skills/a/SKILL.md`, ' +
        '`skills/b/SKILL.md` before answering.',
    );
  });
});

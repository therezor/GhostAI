import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ParsedMentions } from '@ghostai/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import type { RuntimePromptContext, StaticPromptContext } from '#src/prompt.js';
import {
  SkillsContributor,
  renderMentionedSkills,
  renderSkills,
} from '#src/skills-contributor.js';
import { MAX_MENTIONED_SKILLS, type Skill } from '#src/skills.js';

function make(name: string, body = `Body of ${name}.`): Skill {
  return {
    name,
    description: `What ${name} does.`,
    body,
    path: `skills/${name}/SKILL.md`,
  };
}

describe('renderSkills', () => {
  it('renders nothing for an empty catalogue', () => {
    // Empty rather than a bare heading: `contributorSections` drops a section
    // that trims to nothing, so this is how "no skills" becomes "no section".
    expect(renderSkills([])).toBe('');
  });

  it('indexes a skill as one line naming its path', () => {
    const section = renderSkills([make('review')]);

    expect(section).toContain('## Skills');
    expect(section).toContain(
      '- `skills/review/SKILL.md` — **review**: What review does.',
    );
    // The index is a summary; the body stays on disk until the model asks.
    expect(section).not.toContain('Body of review.');
  });

  it('indexes every skill, because the catalogue cannot know the message', () => {
    // The counterpart to the old "a pinned skill drops out of the index" rule.
    // Nothing drops out now: what a message inlines is decided per turn, and
    // this half is the cached prefix shared by every turn in the session.
    const section = renderSkills([make('a'), make('b')]);

    expect(section).toContain('`skills/a/SKILL.md`');
    expect(section).toContain('`skills/b/SKILL.md`');
    expect(section).not.toContain('### Skill:');
  });

  it('leaves no gap after the index', () => {
    // `{{index}}` carries its own leading blank line, so a section must not end
    // on the blank line it opened with.
    const section = renderSkills([make('deploy'), make('review')]);

    expect(section).not.toMatch(/\n\n$/u);
    expect(section).not.toContain('\n\n\n');
  });

  it('renders nothing for a template that is a single space', () => {
    // The contract the other seven templates keep: empty inherits the built-in
    // and a space deletes the section, because empty already means "inherit".
    expect(renderSkills([make('deploy'), make('review')], ' ')).toBe('');
  });

  it('uses an operator template verbatim, filling its placeholders', () => {
    const section = renderSkills(
      [make('deploy'), make('review')],
      'Sheets in {{path}} — {{count}}.\n\n{{indexLines}}',
    );

    expect(section).toContain('Sheets in skills — 2.');
    expect(section).not.toContain('## Skills');
  });
});

describe('renderMentionedSkills', () => {
  const bodies = (...names: string[]) =>
    function bodyOf(name: string): string | undefined {
      return names.includes(name) ? `Body of ${name}.` : undefined;
    };

  it('renders nothing when the message named none', () => {
    expect(renderMentionedSkills([], bodies('a'))).toBeUndefined();
  });

  it('inlines the body of a skill the message named', () => {
    const block = renderMentionedSkills(['a'], bodies('a'));

    expect(block).toContain('### Skill: a');
    expect(block).toContain('Body of a.');
  });

  it('keeps the message order, not the catalogue order', () => {
    // The cap truncates, so someone who named three skills expects the first
    // two to survive a cap of two. Sorting here would drop an arbitrary one.
    const block = renderMentionedSkills(['c', 'a'], bodies('a', 'c')) ?? '';

    expect(block.indexOf('### Skill: c')).toBeLessThan(
      block.indexOf('### Skill: a'),
    );
  });

  it('inlines a repeated name once', () => {
    const block = renderMentionedSkills(['a', 'a'], bodies('a')) ?? '';

    expect(block.match(/### Skill: a/gu)).toHaveLength(1);
  });

  it('falls back to a path line for a name the workspace does not have', () => {
    // A typo, or a skill deleted since the message was written. It costs one
    // `read_file` answering "no such file", which the model recovers from —
    // which is why the names are not validated against the catalogue.
    const block = renderMentionedSkills(['ghost'], bodies('a'));

    expect(block).toBe(
      'Skills named on this message: read `skills/ghost/SKILL.md` ' +
        'before answering.',
    );
  });

  it('falls back to a path line past the cap, rather than dropping the name', () => {
    const named = Array.from(
      { length: MAX_MENTIONED_SKILLS + 1 },
      (unused, index) => `s${String(index)}`,
    );
    const block = renderMentionedSkills(named, bodies(...named)) ?? '';

    expect(block.match(/### Skill:/gu)).toHaveLength(MAX_MENTIONED_SKILLS);
    // The sheet is still reachable; it is the inlining that is capped.
    const last = named[MAX_MENTIONED_SKILLS] ?? '';
    expect(block).toContain(`\`skills/${last}/SKILL.md\``);
  });

  it('puts the paths to open before the bodies already here', () => {
    // An instruction to go and read something is useless after three thousand
    // tokens of what was read for you.
    const block = renderMentionedSkills(['ghost', 'a'], bodies('a')) ?? '';

    expect(block.indexOf('read `skills/ghost/SKILL.md`')).toBeLessThan(
      block.indexOf('### Skill: a'),
    );
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
    carry: new Map(),
  };
}

function runtimeContext(
  context: StaticPromptContext,
  mentions?: ParsedMentions,
): RuntimePromptContext {
  return {
    // Spread rather than shared by reference, because this is what the loop
    // does — and it is what carries `carry` from one half to the other.
    ...context,
    iteration: 1,
    maxIterations: 40,
    nowMs: 0,
    ...(mentions === undefined ? {} : { mentions }),
  };
}

function mentioning(...skill: string[]): ParsedMentions {
  return { mcp: [], skill, all: [] };
}

describe('SkillsContributor', () => {
  it('reads the workspace named by the context, not one it remembers', async () => {
    // One AgentLoop serves every session on an agent, and those sessions can be
    // bound to different workspaces. A contributor that cached its first answer
    // would hand one workspace's skills to a turn in another.
    const contributor = new SkillsContributor();
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
    const contributor = new SkillsContributor();

    expect(
      await contributor.staticSection(staticContext(workspace())),
    ).toBeUndefined();
  });

  it('places nothing in the runtime half without @skill: mentions', async () => {
    const contributor = new SkillsContributor();
    const context = staticContext(workspace({ a: 'A.' }));
    await contributor.staticSection(context);

    expect(contributor.runtimeSection(runtimeContext(context))).toBeUndefined();
    expect(
      contributor.runtimeSection(runtimeContext(context, mentioning())),
    ).toBeUndefined();
  });

  it('inlines the body of a skill the message named', async () => {
    // The whole feature end to end: the static half reads the bodies and leaves
    // them in `carry`, and the runtime half — which cannot do I/O — spends one
    // map lookup to inline the one this message asked for.
    const contributor = new SkillsContributor();
    const context = staticContext(workspace({ a: 'A.', b: 'B.' }));
    await contributor.staticSection(context);

    const block = contributor.runtimeSection(
      runtimeContext(context, mentioning('a')),
    );

    expect(block).toContain('### Skill: a');
    expect(block).toContain('Body of a.');
    expect(block).not.toContain('Body of b.');
  });

  it('leaves the cached half untouched by what a message named', async () => {
    // The reason the bodies go in the runtime half at all. A static section
    // that varied with the message would end the session's cached prefix on
    // every turn, which is the cost the two-half split exists to avoid.
    const contributor = new SkillsContributor();
    const first = staticContext(workspace({ a: 'A.' }));
    const second = staticContext(first.workspaceRoot);

    const withoutMention = await contributor.staticSection(first);
    await contributor.staticSection(second);
    contributor.runtimeSection(runtimeContext(second, mentioning('a')));

    expect(await contributor.staticSection(second)).toBe(withoutMention);
  });

  it('falls back to a path line when the static half never ran', () => {
    // `toolsEnabled: false` and a denied `skill` permission both drop the
    // contributor entirely, but a turn that reaches the runtime half with an
    // empty carry must still say something the model can act on.
    const contributor = new SkillsContributor();
    const context = staticContext('/unused');

    expect(
      contributor.runtimeSection(runtimeContext(context, mentioning('a'))),
    ).toBe(
      'Skills named on this message: read `skills/a/SKILL.md` before answering.',
    );
  });
});

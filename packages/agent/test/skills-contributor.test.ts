import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { StaticPromptContext } from '#src/prompt.js';
import { SkillsContributor, renderSkills } from '#src/skills-contributor.js';
import type { Skill } from '#src/skills.js';

function make(name: string, body = `Body of ${name}.`): Skill {
  return {
    name,
    description: `What ${name} does.`,
    body,
    path: `skills/${name}/SKILL.md`,
    agents: [],
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

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() ?? '', { recursive: true, force: true });
  }
});

/** A sheet's frontmatter: its description, or that plus who it is scoped to. */
type Sheet = string | { readonly description: string; readonly agents: string };

function workspace(skills: Readonly<Record<string, Sheet>> = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ghostai-skillctx-')));
  roots.push(root);
  for (const [name, sheet] of Object.entries(skills)) {
    const dir = join(root, 'skills', name);
    mkdirSync(dir, { recursive: true });
    const scope = typeof sheet === 'string' ? '' : `agents: ${sheet.agents}\n`;
    const description = typeof sheet === 'string' ? sheet : sheet.description;
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\ndescription: ${description}\n${scope}---\n\nBody of ${name}.\n`,
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

  it('indexes only the sheets this agent is meant to see', async () => {
    const root = workspace({
      'code-review': 'Review a diff.',
      refactor: { description: 'Restructure code.', agents: 'coder' },
      triage: { description: 'Sort the inbox.', agents: 'team-lead' },
    });

    const coder = await new SkillsContributor({
      agentId: 'coder',
    }).staticSection(staticContext(root));

    expect(coder).toContain('code-review');
    expect(coder).toContain('refactor');
    expect(coder).not.toContain('triage');
  });

  it('places no section when every sheet is scoped away', async () => {
    // The guard runs after the filter, so this is no section rather than a
    // `## Skills` heading with nothing under it.
    const root = workspace({
      refactor: { description: 'Restructure code.', agents: 'coder' },
    });

    expect(
      await new SkillsContributor({ agentId: 'writer' }).staticSection(
        staticContext(root),
      ),
    ).toBeUndefined();
  });

  it('advertises a `default`-scoped sheet to a contributor given no id', async () => {
    // Absent means `default`, not "advertise everything" — so a sheet scoped
    // away from `default` stays away.
    const root = workspace({
      ops: { description: 'Run the deploy.', agents: 'default' },
      refactor: { description: 'Restructure code.', agents: 'coder' },
    });

    const section = await new SkillsContributor().staticSection(
      staticContext(root),
    );

    expect(section).toContain('ops');
    expect(section).not.toContain('refactor');
  });
});

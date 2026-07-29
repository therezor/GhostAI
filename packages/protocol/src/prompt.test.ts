/**
 * The prompt template's substitution rules.
 *
 * Most of these assert what happens when the template is *wrong*, which is the
 * half that matters: an operator now owns the whole system prompt, so a typo in
 * it is a normal event rather than a bug report. The rules are that a mistake
 * stays visible and never takes the agent offline.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SYSTEM_PROMPT_TEMPLATE,
  PROMPT_PLACEHOLDERS,
  SECTION_SEPARATOR,
  hasPlaceholder,
  legacyInstructionsToTemplate,
  renderPromptTemplate,
  unknownPlaceholders,
  type PromptValues,
} from './prompt.js';

const VALUES: PromptValues = {
  name: 'Reviewer',
  workspaceId: 'acme',
  workspaceRoot: '/home/ghost/.ghostai/workspace/acme',
  runtime: 'Linux x64, Node 22.0.0',
  platformPolicy: '## Platform policy (POSIX)\n\n- Standard shell tools are available.',
};

describe('renderPromptTemplate', () => {
  it('fills every placeholder it knows', () => {
    const rendered = renderPromptTemplate(
      '{{name}} in {{workspaceId}} at {{workspaceRoot}} on {{runtime}}',
      VALUES,
    );

    expect(rendered).toBe(
      'Reviewer in acme at /home/ghost/.ghostai/workspace/acme on Linux x64, Node 22.0.0',
    );
  });

  it('fills a placeholder used more than once', () => {
    expect(renderPromptTemplate('# {{name}}\n\nYou are {{name}}.', VALUES)).toBe(
      '# Reviewer\n\nYou are Reviewer.',
    );
  });

  it('leaves an unknown placeholder verbatim rather than deleting it', () => {
    // The failure this prevents: a typo silently removing the sentence that
    // says where the workspace is, with nothing on screen to show it happened.
    expect(renderPromptTemplate('root is {{workspacRoot}}', VALUES)).toBe(
      'root is {{workspacRoot}}',
    );
  });

  it('treats spaced braces as a literal, which is the escape hatch', () => {
    expect(renderPromptTemplate('write {{ name }} to mean the placeholder', VALUES)).toBe(
      'write {{ name }} to mean the placeholder',
    );
  });

  it('never rescans what it substituted', () => {
    // A workspace whose name is itself placeholder-shaped cannot expand.
    const rendered = renderPromptTemplate('{{workspaceId}}', {
      ...VALUES,
      workspaceId: '{{workspaceRoot}}',
    });

    expect(rendered).toBe('{{workspaceRoot}}');
  });

  it('returns a template with no placeholders untouched', () => {
    expect(renderPromptTemplate('Just be helpful.', VALUES)).toBe('Just be helpful.');
  });

  it('does not throw on an empty template', () => {
    expect(renderPromptTemplate('', VALUES)).toBe('');
  });
});

describe('unknownPlaceholders', () => {
  it('finds nothing in the built-in template', () => {
    expect(unknownPlaceholders(DEFAULT_SYSTEM_PROMPT_TEMPLATE)).toEqual([]);
  });

  it('reports a typo once, however often it appears', () => {
    expect(unknownPlaceholders('{{nmae}} and {{nmae}} again')).toEqual(['nmae']);
  });

  it('reports several in the order they appear', () => {
    expect(unknownPlaceholders('{{a}} {{name}} {{b}}')).toEqual(['a', 'b']);
  });

  it('ignores the spaced literal form', () => {
    expect(unknownPlaceholders('{{ nmae }}')).toEqual([]);
  });
});

describe('DEFAULT_SYSTEM_PROMPT_TEMPLATE', () => {
  it('uses every placeholder it is allowed to, and no others', () => {
    for (const placeholder of PROMPT_PLACEHOLDERS) {
      expect(DEFAULT_SYSTEM_PROMPT_TEMPLATE).toContain(`{{${placeholder}}}`);
    }
    expect(unknownPlaceholders(DEFAULT_SYSTEM_PROMPT_TEMPLATE)).toEqual([]);
  });

  it('renders to a prompt with no braces left in it', () => {
    const rendered = renderPromptTemplate(DEFAULT_SYSTEM_PROMPT_TEMPLATE, VALUES);

    expect(rendered).not.toContain('{{');
    expect(rendered).toContain('# Reviewer');
    expect(rendered).toContain('That directory is your root');
    expect(rendered).toContain('## Guidelines');
    expect(rendered).toContain('## Platform policy (POSIX)');
  });
});

describe('legacyInstructionsToTemplate', () => {
  it('keeps the old composition exactly — built-in, then an Instructions section', () => {
    const migrated = legacyInstructionsToTemplate('Only ever read. Never write.');

    expect(migrated).toBe(
      `${DEFAULT_SYSTEM_PROMPT_TEMPLATE}${SECTION_SEPARATOR}## Instructions\n\nOnly ever read. Never write.`,
    );
  });

  it('trims the operator text without touching the template', () => {
    expect(legacyInstructionsToTemplate('  be terse  ')).toContain('## Instructions\n\nbe terse');
  });

  it('produces something the migration can recognise as already done', () => {
    expect(hasPlaceholder(legacyInstructionsToTemplate('be terse'))).toBe(true);
  });
});

describe('hasPlaceholder', () => {
  it('is false for a prompt that names none', () => {
    expect(hasPlaceholder('Only ever read. Never write.')).toBe(false);
  });

  it('is false for an unknown one, so a typo does not look migrated', () => {
    expect(hasPlaceholder('{{nmae}}')).toBe(false);
  });

  it('is true as soon as one known placeholder appears', () => {
    expect(hasPlaceholder('hello {{name}}')).toBe(true);
  });
});

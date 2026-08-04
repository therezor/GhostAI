import { describe, expect, it } from 'vitest';

import { selectTools } from '#src/filter.js';
import type { McpToolDescriptor } from '#src/session.js';

const ADVERTISED: readonly McpToolDescriptor[] = [
  { name: 'repo_list', inputSchema: { type: 'object' } },
  { name: 'repo_create', inputSchema: { type: 'object' } },
  { name: 'issue_list', inputSchema: { type: 'object' } },
];

function names(descriptors: readonly McpToolDescriptor[]): readonly string[] {
  return descriptors.map((descriptor) => descriptor.name);
}

describe('selectTools', () => {
  it('takes everything under the schema default', () => {
    const { selected, unmatched } = selectTools(ADVERTISED, ['*']);
    expect(names(selected)).toEqual(names(ADVERTISED));
    expect(unmatched).toEqual([]);
  });

  it('matches an exact upstream name', () => {
    // The upstream name, not the flattened one: it is what an operator reads in
    // the server's own documentation.
    const { selected } = selectTools(ADVERTISED, ['issue_list']);
    expect(names(selected)).toEqual(['issue_list']);
  });

  it('matches a prefix, for a server that groups its tools', () => {
    const { selected } = selectTools(ADVERTISED, ['repo_*']);
    expect(names(selected)).toEqual(['repo_list', 'repo_create']);
  });

  it('reports an entry that matches nothing', () => {
    const { selected, unmatched } = selectTools(ADVERTISED, [
      'repo_list',
      'typo_*',
    ]);
    expect(names(selected)).toEqual(['repo_list']);
    expect(unmatched).toEqual(['typo_*']);
  });

  it('selects nothing for an empty list, which is a real answer', () => {
    // Not "everything": the convention here is the opposite of
    // `tools.exec.allowedBinaries`, and this is a narrowing of a server the
    // operator already added.
    const { selected } = selectTools(ADVERTISED, []);
    expect(selected).toEqual([]);
  });

  it('keeps a wildcard winning over a narrower sibling', () => {
    const { selected, unmatched } = selectTools(ADVERTISED, ['*', 'nope']);
    expect(names(selected)).toEqual(names(ADVERTISED));
    expect(unmatched).toEqual([]);
  });
});

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  flattenToolName,
  flattenToolNames,
  isAdvertisableName,
} from '#src/names.js';

describe('flattenToolName', () => {
  it('qualifies a tool by the server that offers it', () => {
    expect(flattenToolName('github', 'create_issue')).toBe(
      'mcp_github_create-issue',
    );
  });

  it('replaces everything a provider would reject', () => {
    expect(flattenToolName('my server', 'search files!')).toBe(
      'mcp_my-server_search-files-',
    );
  });

  it('keeps underscore as the separator and nowhere else', () => {
    // Otherwise server `a_b` holding `c` and server `a` holding `b_c` would
    // both flatten to `mcp_a_b_c`, and the collision would be silent.
    expect(flattenToolName('a_b', 'c')).not.toBe(flattenToolName('a', 'b_c'));
  });

  it('keeps a long name legal, and distinct from one sharing its prefix', () => {
    const server = 'a'.repeat(20);
    const first = flattenToolName(server, `${'b'.repeat(60)}-one`);
    const second = flattenToolName(server, `${'b'.repeat(60)}-two`);

    expect(first.length).toBeLessThanOrEqual(64);
    expect(second.length).toBeLessThanOrEqual(64);
    expect(first).not.toBe(second);
    // The server prefix survives: it is how an operator recognises the row.
    expect(first.startsWith(`mcp_${server}_`)).toBe(true);
  });

  it('is stable, because the prompt prefix a provider caches keys on it', () => {
    expect(flattenToolName('github', 'create_issue')).toBe(
      flattenToolName('github', 'create_issue'),
    );
  });

  it('always produces a name a provider will accept', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.string({ minLength: 1, maxLength: 120 }),
        (server, tool) => {
          expect(isAdvertisableName(flattenToolName(server, tool))).toBe(true);
        },
      ),
    );
  });
});

describe('flattenToolNames', () => {
  it('leaves a clash-free list alone', () => {
    const { names, collisions } = flattenToolNames('github', [
      'create_issue',
      'list_issues',
    ]);
    expect([...names.values()]).toEqual([
      'mcp_github_create-issue',
      'mcp_github_list-issues',
    ]);
    expect(collisions).toEqual([]);
  });

  it('keeps both tools when two upstream names flatten to one', () => {
    // The registry would refuse the second as a conflict, losing a tool for a
    // reason nothing reports.
    const { names, collisions } = flattenToolNames('files', [
      'read file',
      'read_file',
    ]);
    expect(names.get('read file')).toBe('mcp_files_read-file');
    expect(names.get('read_file')).toBe('mcp_files_read-file_2');
    expect(collisions).toEqual(['read_file']);
    expect(new Set(names.values()).size).toBe(2);
  });

  it('gives the plain name to whichever the server advertised first', () => {
    const { names } = flattenToolNames('files', ['read_file', 'read file']);
    expect(names.get('read_file')).toBe('mcp_files_read-file');
    expect(names.get('read file')).toBe('mcp_files_read-file_2');
  });

  it('keeps a numbered name legal too', () => {
    const long = 'b'.repeat(80);
    const { names } = flattenToolNames('a'.repeat(20), [long, `${long}!`]);
    for (const name of names.values()) {
      expect(isAdvertisableName(name)).toBe(true);
    }
    expect(new Set(names.values()).size).toBe(2);
  });
});

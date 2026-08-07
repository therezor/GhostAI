/**
 * The arithmetic `@ghostai/mcp` and the extension host share.
 *
 * `packages/mcp/test/names.test.ts` covers the same rules under the `mcp`
 * prefix, because that is the caller whose collisions an operator actually
 * sees. What is asserted here is the part that is *not* MCP's: that a second
 * prefix gets the same guarantees, which is the only reason this moved.
 */

import { describe, expect, it } from 'vitest';

import {
  isAdvertisableName,
  namespacedToolName,
  namespacedToolNames,
} from '#src/names.js';

describe('namespacedToolName', () => {
  it('qualifies by prefix and owner', () => {
    expect(namespacedToolName('ext', 'slack', 'post')).toBe('ext_slack_post');
    expect(namespacedToolName('mcp', 'slack', 'post')).toBe('mcp_slack_post');
  });

  it('keeps two prefixes apart for the same owner and tool', () => {
    // The registry is flat and shared. An extension called `files` and an MCP
    // server called `files` both advertising `read` have to coexist, and the
    // prefix is the only thing between them.
    expect(namespacedToolName('ext', 'files', 'read')).not.toBe(
      namespacedToolName('mcp', 'files', 'read'),
    );
  });

  it('replaces what a provider will not accept', () => {
    expect(namespacedToolName('ext', 'my box', 'search files')).toBe(
      'ext_my-box_search-files',
    );
  });

  it('cannot let a segment forge the separator', () => {
    // `a_b` holding `c` and `a` holding `b_c` would otherwise both flatten to
    // one name, and the collision would be silent rather than merely possible.
    expect(namespacedToolName('ext', 'a_b', 'c')).not.toBe(
      namespacedToolName('ext', 'a', 'b_c'),
    );
  });

  it('stays advertisable however long the parts are', () => {
    const name = namespacedToolName('ext', 'x'.repeat(60), 'y'.repeat(60));

    expect(name).toHaveLength(64);
    expect(isAdvertisableName(name)).toBe(true);
  });

  it('keeps two long names apart rather than truncating them together', () => {
    const owner = 'x'.repeat(60);
    const first = namespacedToolName('ext', owner, 'read-the-first-thing');
    const second = namespacedToolName('ext', owner, 'read-the-second-thing');

    expect(first).not.toBe(second);
  });

  it('is stable across calls, because a prompt cache keys on it', () => {
    expect(namespacedToolName('ext', 'x'.repeat(60), 'read')).toBe(
      namespacedToolName('ext', 'x'.repeat(60), 'read'),
    );
  });
});

describe('namespacedToolNames', () => {
  it('breaks a within-owner clash rather than losing a tool', () => {
    const { names, collisions } = namespacedToolNames('ext', 'slack', [
      'read file',
      'read-file',
    ]);

    expect(names.get('read file')).toBe('ext_slack_read-file');
    expect(names.get('read-file')).toBe('ext_slack_read-file_2');
    expect(collisions).toEqual(['read-file']);
  });

  it('reports nothing when there is nothing to report', () => {
    const { collisions } = namespacedToolNames('ext', 'slack', ['a', 'b']);
    expect(collisions).toEqual([]);
  });

  it('keeps a numbered name advertisable', () => {
    const long = 'y'.repeat(60);
    const { names } = namespacedToolNames('ext', 'x'.repeat(60), [long, long]);

    for (const name of names.values()) {
      expect(isAdvertisableName(name)).toBe(true);
    }
  });
});

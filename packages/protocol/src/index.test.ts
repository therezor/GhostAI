import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from './index.js';

describe('protocol', () => {
  it('pins the wire protocol version', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

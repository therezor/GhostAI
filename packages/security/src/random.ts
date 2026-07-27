/**
 * Injectable randomness.
 *
 * Two things in this package need unpredictable bytes — the per-turn
 * tool-output nonce and the vault's AES-GCM initialisation vectors — and both
 * are worthless if the values are guessable. So the source is always
 * `node:crypto`, never `Math.random()` (which lint bans repo-wide), and it is a
 * parameter rather than a direct import so tests can pin it.
 *
 * A test that injects a counter is asserting on *wrapping and escaping*, which
 * is the part that has to be right. Nothing may inject a fixed source in
 * production: `createToolOutputNonce` with a constant is the same as having no
 * delimiter at all, because tool output could then close its own envelope.
 */

import { randomBytes } from 'node:crypto';

export type RandomSource = (size: number) => Buffer;

export const systemRandom: RandomSource = (size) => randomBytes(size);

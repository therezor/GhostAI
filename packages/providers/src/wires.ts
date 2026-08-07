/**
 * Which wire protocols this process can actually speak.
 *
 * `WIRE_PROTOCOLS` in `registry.ts` is the closed vocabulary a `ProviderSpec`
 * may name; this is the subset an adapter exists for. The two were one thing
 * until an extension needed to supply the missing half, and separating them is
 * what turns "not implemented yet" from a hard-coded `if` into a lookup that
 * something can fill.
 *
 * `openai-chat` is the only entry that ships. The other three are declared in
 * the vocabulary because the table is the single source of truth for what a
 * provider *is*, and an entry that lied about its wire would be worse than one
 * naming a wire whose adapter has not landed — the factory refuses the latter
 * loudly, and now says how to fix it.
 */

import { createOpenAIChatProvider } from './openai-chat.js';
import type { WireProtocol } from './registry.js';
import type { WireAdapter } from './types.js';

export type WireAdapters = Partial<Readonly<Record<WireProtocol, WireAdapter>>>;

/** The adapters compiled into this build. */
export const BUILTIN_WIRES: WireAdapters = {
  'openai-chat': createOpenAIChatProvider,
};

/**
 * The adapter for one wire, with an extension's table layered over the built-in
 * one.
 *
 * Layered rather than merged-and-frozen so that an extension supplying
 * `anthropic-messages` adds a wire without being able to *replace*
 * `openai-chat` — the one every local provider in the registry speaks, and the
 * one an operator would have no way to notice had been swapped.
 */
export function wireAdapterFor(
  wire: WireProtocol,
  extra?: WireAdapters,
): WireAdapter | undefined {
  return BUILTIN_WIRES[wire] ?? extra?.[wire];
}

/**
 * A tool call the model wrote into its answer instead of calling.
 *
 * Local models do this, and they do it most often on the iteration *after* a tool
 * returned an error — the point at which a turn most needs to recover. Observed
 * from `liquid/lfm2-24b-a2b`, whose first call in the same turn was a correctly
 * structured one:
 *
 * ```
 * The search tool is currently rate-limited. I will try using the `fetch` tool…
 *
 * <tool_output>
 * <tool_call>
 * {"name": "fetch", "arguments": ["https://www.bbc.com/news"]}
 * </tool_call>
 * </tool_output>
 * ```
 *
 * The provider reports no tool calls, so the loop reads that as a finished answer
 * and the turn ends `complete`. The user is shown a JSON blob as the reply, and
 * nothing anywhere says the model tried to act and failed to.
 *
 * **This module only detects. It deliberately does not execute.** Running a call
 * the model merely *described* is a different and worse bug: "how do I call
 * `exec`?" answered with an example would become an `exec`. The loop's response is
 * to tell the model what it did wrong and let it try once more — which costs one
 * iteration and cannot act on something nobody asked for.
 *
 * Detection is deliberately narrow. A name that matches no registered tool is
 * prose about tools, not an attempt to use one, and the difference matters because
 * the correction is worthless when the model was only explaining itself.
 */

/** The wrappers models reach for. `tool_call` is much the most common. */
const BLOCK = /<(tool_call|function_call|tool_use)>([\s\S]*?)<\/\1>/gi;

/** A fenced block, which some models use instead of a pseudo-XML tag. */
const FENCE = /```(?:json|tool_code|tool_call)?\s*(\{[\s\S]*?\})\s*```/gi;

/** A bare object with the two keys a call has, for models that wrap nothing. */
const BARE = /\{[^{}]*"name"\s*:\s*"([A-Za-z0-9_.-]{1,64})"[\s\S]{0,400}?\}/g;

/**
 * The name of a tool this text tried to call, if it tried to call one.
 *
 * `undefined` covers every ordinary answer, which is almost all of them — so this
 * runs the cheap `includes` guards before any regex work.
 */
export function textToolCallName(
  text: string,
  known: readonly string[],
): string | undefined {
  if (text === '' || known.length === 0) return undefined;
  // A call, however it is wrapped, always names the tool in a `"name"` field or
  // sits in one of the tag forms. Without one of those there is nothing to find,
  // and this is the path every normal answer takes.
  if (
    !text.includes('"name"') &&
    !/<(tool_call|function_call|tool_use)>/i.test(text)
  ) {
    return undefined;
  }

  const names = new Set(known);

  for (const pattern of [BLOCK, FENCE, BARE]) {
    // `lastIndex` is shared state on a module-level regex, so each use starts
    // over rather than continuing from wherever the previous call finished.
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      // `BLOCK` captures the tag name in group 1 and the body in group 2; the
      // others capture the object in group 1.
      const body = match[2] ?? match[1] ?? '';
      const named = /"name"\s*:\s*"([A-Za-z0-9_.-]{1,64})"/.exec(body);
      const name = named?.[1] ?? match[1];
      if (name !== undefined && names.has(name)) return name;
    }
  }

  return undefined;
}

/**
 * What the model is told, in the runtime half of the next iteration's prompt.
 *
 * In the prompt rather than as a message in the conversation, for two reasons:
 * the runtime half is rewritten every iteration anyway so this costs no cached
 * prefix, and a correction appended as a `user` message would read in the
 * transcript as something the operator said.
 *
 * Named tools rather than a general scolding, because "use the tool interface" is
 * advice a model that just failed to use the tool interface cannot act on. Saying
 * *which* tool it was reaching for turns it into a single concrete instruction.
 */
export function textToolCallCorrection(name: string): string {
  return `## Correction

Your previous message contained a call to \`${name}\` written as text in your
reply. That is not a tool call and nothing ran. Tool calls have to be made through
the tool-calling interface, as structured calls — never written out in the message
body, and never wrapped in tags.

Call \`${name}\` now, properly. If you cannot, say so in plain words instead and do
not write out another call.`;
}

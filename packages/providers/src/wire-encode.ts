/**
 * What a `chat/completions` request body actually looks like.
 *
 * Split out of the adapter because it has two readers rather than one: the
 * transport that sends the body, and the measurement that prices it for the
 * context inspector. The whole point of the split is that neither gets its own
 * copy — a hand-kept "what the model sees" projection somewhere else would be a
 * second statement of this file, correct on the day it was written and wrong the
 * first time a branch here changes.
 *
 * The one that had already gone wrong is why this exists. An assistant message
 * carries the model's `reasoning` beside its answer, `encodeMessage` has never
 * put it on the wire, and the inspector was measuring the stored object — so a
 * bar under the composer was billing text no provider ever received.
 *
 * Two encoding decisions live here and are bug-compatibility with the ecosystem
 * rather than preference; both moved with the code they describe:
 *
 *  - **Text-only content collapses to a plain string.** The array-of-parts form
 *    is correct per the OpenAI schema, and several local servers reject it for
 *    `system` and `tool` messages. The string form is understood everywhere.
 *  - **Tool-call arguments cross the wire verbatim.** A model emitting malformed
 *    JSON is routine; parsing it here would turn that into a transport-layer
 *    exception. The string is preserved so the tool registry can reject it as a
 *    typed tool error the model gets to see and retry against.
 *
 * Kept pure — no transport, no clock, no I/O — which is what lets the measuring
 * side call it as often as a turn iterates.
 */

import type {
  ChatMessage,
  ContentPart,
  ToolDefinition,
} from '@ghostwire/protocol';

export type WireContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface WireToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface WireMessage {
  readonly role: string;
  readonly content: string | readonly WireContentPart[] | null;
  readonly tool_calls?: readonly WireToolCall[];
  readonly tool_call_id?: string;
}

export interface WireTool {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export function encodePart(part: ContentPart): WireContentPart {
  if (part.type === 'text') return { type: 'text', text: part.text };
  // A `file` part is a workspace reference, and this wire format has nowhere to
  // put one — it is meant to have been turned into text or an image by
  // `materialiseAttachments` before the request got here. Reaching this branch
  // means a caller went straight to a provider, so render the reference rather
  // than dropping it: a model told the path can still reach for a tool, and a
  // silently missing attachment is the failure this whole change was about.
  if (part.type === 'file') {
    return {
      type: 'text',
      text: `[attachment: ${part.path} · ${part.mimeType}]`,
    };
  }
  // An inline image becomes a data URI; a signed URL is passed through for the
  // provider to fetch. Both are what `image_url` accepts.
  const url =
    part.data === undefined
      ? (part.url ?? '')
      : `data:${part.mimeType};base64,${part.data}`;
  return { type: 'image_url', image_url: { url } };
}

export function encodeContent(
  parts: readonly ContentPart[],
): string | readonly WireContentPart[] {
  const encoded = parts.map(encodePart);
  return encoded.every((part) => part.type === 'text')
    ? encoded.map((part) => part.text).join('\n')
    : encoded;
}

export function encodeMessage(message: ChatMessage): WireMessage {
  switch (message.role) {
    case 'system':
      return { role: 'system', content: message.content };
    case 'user':
      return { role: 'user', content: encodeContent(message.content) };
    case 'tool':
      return {
        role: 'tool',
        content: message.content,
        tool_call_id: message.toolCallId,
      };
    case 'assistant': {
      const content = encodeContent(message.content);
      const toolCalls = message.toolCalls.map<WireToolCall>((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.argumentsJson },
      }));
      // `reasoning` is absent by omission rather than by a line deleting it:
      // this object is built from the fields the wire has, and the model's own
      // thinking is not one of them. `AssistantMessageSchema` says the same
      // thing from the other end — it is kept beside the answer so it can be
      // shown and excluded from history replay.
      return {
        role: 'assistant',
        // `null`, not `""`: an assistant turn that only called tools has no text,
        // and several providers reject an empty string where they accept null.
        content: content === '' && toolCalls.length > 0 ? null : content,
        ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
      };
    }
  }
}

/**
 * The definitions as the body carries them.
 *
 * Three fields of a `ToolDefinition` reach a provider. `risk`, `source` and
 * anything else the registry hangs on a tool are this project's own bookkeeping
 * — they drive an approval prompt and a badge, and no model has ever seen one.
 */
export function encodeTools(
  tools: readonly ToolDefinition[],
): readonly WireTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

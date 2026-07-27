/**
 * Constructors and accessors for the canonical message union.
 *
 * The shapes themselves live in `@ghostai/protocol` — they cross the wire, so
 * the schema is their single source of truth. What lives here is the small set
 * of operations everything downstream would otherwise reimplement: building a
 * user message from a string, and reading the text back out of one.
 *
 * `textOf` is the load-bearing one. `content` is an array of parts precisely so
 * a message can carry images, but most consumers — the Telegram renderer, the
 * consolidation prompt, a log line, an assertion — want the words. Written
 * inline, that is a `filter`/`map`/`join` that gets subtly different at every
 * call site, and the differences only show up on multimodal input.
 */

import type {
  AssistantMessage,
  ChatMessage,
  ContentPart,
  ImagePart,
  SystemMessage,
  TextPart,
  ToolCall,
  ToolMessage,
  UserMessage,
} from '@ghostai/protocol';

export function textPart(text: string): TextPart {
  return { type: 'text', text };
}

/**
 * An image part.
 *
 * Exactly one of `data` (inline base64) or `url` is meaningful. A `url` is
 * always an HMAC-signed, short-lived link, never a bare workspace path: the
 * endpoint that serves it is authenticated, and a raw path would be an
 * unauthenticated read of anything the agent can see.
 */
export function imagePart(mimeType: string, source: { data: string } | { url: string }): ImagePart {
  return { type: 'image', mimeType, ...source };
}

export function systemMessage(content: string): SystemMessage {
  return { role: 'system', content };
}

/** Accepts a string for the common case, or parts for multimodal input. */
export function userMessage(content: string | readonly ContentPart[]): UserMessage {
  return {
    role: 'user',
    content: typeof content === 'string' ? [textPart(content)] : [...content],
  };
}

export interface AssistantMessageOptions {
  readonly toolCalls?: readonly ToolCall[];
  readonly reasoning?: string;
}

export function assistantMessage(
  content: string | readonly ContentPart[],
  options: AssistantMessageOptions = {},
): AssistantMessage {
  return {
    role: 'assistant',
    content: typeof content === 'string' ? [textPart(content)] : [...content],
    toolCalls: [...(options.toolCalls ?? [])],
    ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
  };
}

export interface ToolMessageOptions {
  readonly isError?: boolean;
  readonly truncated?: boolean;
}

export function toolMessage(
  toolCallId: string,
  name: string,
  content: string,
  options: ToolMessageOptions = {},
): ToolMessage {
  return {
    role: 'tool',
    toolCallId,
    name,
    content,
    isError: options.isError ?? false,
    truncated: options.truncated ?? false,
  };
}

/**
 * The text of a message, with image parts dropped.
 *
 * Parts are joined with a newline rather than concatenated: a provider that
 * splits one answer across several text parts means them as separate blocks,
 * and gluing them together silently merges the last word of one paragraph into
 * the first word of the next.
 */
export function textOf(message: ChatMessage): string {
  if (message.role === 'system' || message.role === 'tool') return message.content;
  return message.content
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

/** Whether a message carries image parts — the check before a vision request. */
export function hasImages(message: ChatMessage): boolean {
  if (message.role === 'system' || message.role === 'tool') return false;
  return message.content.some((part) => part.type === 'image');
}

/**
 * Drops image parts, leaving the text.
 *
 * The `strip images` step of the provider degradation ladder: a model that
 * rejects an image should still answer the question that came with it, rather
 * than failing the turn outright.
 */
export function withoutImages(message: ChatMessage): ChatMessage {
  if (message.role === 'system' || message.role === 'tool') return message;
  if (!hasImages(message)) return message;
  return { ...message, content: message.content.filter((part) => part.type === 'text') };
}

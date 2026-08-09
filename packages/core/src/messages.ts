/**
 * Constructors and accessors for the canonical message union.
 *
 * The shapes themselves live in `@ghostwire/protocol` — they cross the wire, so
 * the schema is their single source of truth. What lives here is the small set
 * of operations everything downstream would otherwise reimplement: building a
 * user message from a string, and reading the text back out of one.
 *
 * `textOf` is the load-bearing one. `content` is an array of parts precisely so
 * a message can carry images, but most consumers — the Telegram renderer, a
 * derived session title, a log line, an assertion — want the words. Written
 * inline, that is a `filter`/`map`/`join` that gets subtly different at every
 * call site, and the differences only show up on multimodal input.
 */

import type {
  AssistantMessage,
  ChatMessage,
  ContentPart,
  FilePart,
  ImagePart,
  SystemMessage,
  TextPart,
  ToolCall,
  ToolMessage,
  UserMessage,
} from '@ghostwire/protocol';

export function textPart(text: string): TextPart {
  return { type: 'text', text };
}

/**
 * An image part, as a *provider* takes it.
 *
 * Exactly one of `data` (inline base64) or `url` is meaningful, and a `url`
 * must be absolute and reachable from wherever the model runs. A workspace
 * file is neither — it is a `filePart`, and it becomes one of these only at
 * request time. Putting a relative signed URL here is what used to send every
 * attachment nowhere.
 */
export function imagePart(
  mimeType: string,
  source: { data: string } | { url: string },
): ImagePart {
  return { type: 'image', mimeType, ...source };
}

/** A workspace file, by reference. See `FilePartSchema` for why not by value. */
export function filePart(
  path: string,
  mimeType: string,
  details: { readonly name?: string; readonly sizeBytes?: number } = {},
): FilePart {
  return {
    type: 'file',
    path,
    mimeType,
    ...(details.name === undefined ? {} : { name: details.name }),
    ...(details.sizeBytes === undefined
      ? {}
      : { sizeBytes: details.sizeBytes }),
  };
}

export function systemMessage(content: string): SystemMessage {
  return { role: 'system', content };
}

/** Accepts a string for the common case, or parts for multimodal input. */
export function userMessage(
  content: string | readonly ContentPart[],
): UserMessage {
  return {
    role: 'user',
    content: typeof content === 'string' ? [textPart(content)] : [...content],
  };
}

interface AssistantMessageOptions {
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
    ...(options.reasoning === undefined
      ? {}
      : { reasoning: options.reasoning }),
  };
}

interface ToolMessageOptions {
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
 * The text of a message: the words, and only the words.
 *
 * Parts are joined with a newline rather than concatenated: a provider that
 * splits one answer across several text parts means them as separate blocks,
 * and gluing them together silently merges the last word of one paragraph into
 * the first word of the next.
 *
 * Image and file parts contribute nothing, deliberately. This feeds
 * `deriveSessionTitle`, and a session titled
 * `[file: uploads/ab12cd34-scan.pdf]` is worse than one left untitled — which
 * is what an attachment-only first message now gets.
 */
export function textOf(message: ChatMessage): string {
  if (message.role === 'system' || message.role === 'tool') {
    return message.content;
  }
  return message.content
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

/**
 * Whether a message carries image parts — the check before a vision request.
 *
 * A `file` part is **not** an image, however it is going to be materialised.
 * If it were, `stripImages` could fire on a request whose attachments have not
 * been read yet and delete the references before anything looked at them.
 */
export function hasImages(message: ChatMessage): boolean {
  if (message.role === 'system' || message.role === 'tool') return false;
  return message.content.some((part) => part.type === 'image');
}

/**
 * Drops image parts, keeping everything else.
 *
 * The `strip images` step of the provider degradation ladder: a model that
 * rejects an image should still answer the question that came with it, rather
 * than failing the turn outright.
 *
 * Phrased as "not an image" rather than "is text" because those stopped being
 * the same thing when `file` parts arrived: keeping only text would delete an
 * un-materialised attachment reference from the request as a side effect of a
 * degradation that has nothing to do with it.
 */
export function withoutImages(message: ChatMessage): ChatMessage {
  if (message.role === 'system' || message.role === 'tool') return message;
  if (!hasImages(message)) return message;
  return {
    ...message,
    content: message.content.filter((part) => part.type !== 'image'),
  };
}

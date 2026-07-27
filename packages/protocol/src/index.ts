/**
 * @ghostai/protocol — Zod schemas and the types derived from them.
 *
 * Every other package imports its shared shapes from here. The schemas are the
 * single source of truth: TypeScript types come from `z.infer`, JSON Schema for
 * tool definitions comes from `z.toJSONSchema`, and the HTTP layer's OpenAPI
 * document is generated from these same objects — never hand-maintained.
 */

/** Version of the wire protocol spoken over the WebSocket. */
export const PROTOCOL_VERSION = 1 as const;

export type ProtocolVersion = typeof PROTOCOL_VERSION;

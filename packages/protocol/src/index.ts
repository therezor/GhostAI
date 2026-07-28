/**
 * @ghostai/protocol — Zod schemas and the types derived from them.
 *
 * Every other package imports its shared shapes from here. The schemas are the
 * single source of truth: TypeScript types come from `z.infer`, JSON Schema for
 * tool definitions comes from `z.toJSONSchema`, and the HTTP layer's OpenAPI
 * document is generated from these same objects — never hand-maintained.
 *
 * No logic and no I/O beyond three pure functions that must behave identically
 * everywhere they run: `parseMentions` (every channel must resolve `@kb:` the
 * same way), `isLoopbackHost` (the server and the CLI must agree on what
 * counts as a remote bind before refusing to start without auth), and
 * `tokensPerSecond` (the terminal and the browser must report the same rate for
 * the same turn, and the browser cannot import the package that stores it).
 *
 * Runtime dependencies: `zod`, and nothing else — ever.
 */

export {
  MENTION_KINDS,
  isMentionKind,
  parseMentions,
  type Mention,
  type MentionKind,
  type ParsedMentions,
} from './mentions.js';

export * from './messages.js';
export * from './tools.js';
export * from './config.js';
export * from './automation.js';
export * from './ws.js';
export * from './rest.js';
export { PROTOCOL_SCHEMAS, SCHEMA_MODULES, type ProtocolSchemaName } from './schemas.js';

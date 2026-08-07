/**
 * What an extension author writes against, and nothing else.
 *
 * Two exported shapes: `Extension`, which an entry module provides, and
 * `ExtensionContext`, which the host hands it. Everything an extension can
 * reach is a member of the context — there is no singleton to import, no
 * registry to look up, and no way to get at the `ToolRegistry` or the
 * `ChannelManager` the host will eventually feed.
 *
 * **The context is a recorder, not the registries.** This is the load-bearing
 * decision in the whole package, and it buys three things at once:
 *
 *  - **Unload is exact.** The host holds the bag `activate` filled, so removing
 *    an extension is removing exactly what that bag named. Nothing has to be
 *    diffed and nothing can be missed.
 *  - **A partial `activate` installs nothing.** An extension that registers
 *    four tools and throws on the fifth leaves no trace, because the bag is
 *    discarded whole. The alternative — live handles — leaves four tools
 *    registered by an extension that is not running, which is the state
 *    `ToolRegistry.registerAll` already rolls back to avoid.
 *  - **Nothing an extension holds outlives it.** A live registry handle kept in
 *    a closure would still work after `deactivate`, and there is no way to take
 *    it back.
 *
 * What an extension can still do is everything: it is ordinary JavaScript in
 * the server process and `node:fs` is one import away. The gate in front of it
 * is the approval digest in `@ghostai/security`, and `docs/security.md` says in
 * as many words that this is the same trust level as a toolbox with host
 * `exec`. The recorder is a design for *clarity and exact teardown*, not a
 * sandbox, and reading it as one would be the dangerous mistake.
 */

import type { Clock, Logger } from '@ghostai/core';
import type { ChannelFactory } from '@ghostai/channels';
import type { ExtensionManifest } from '@ghostai/protocol';
import type { ContextContributor } from '@ghostai/agent';
import type { ProviderSpec, WireAdapter } from '@ghostai/providers';
import type { AnyTool } from '@ghostai/tools';

/**
 * A command the operator invokes, from any surface.
 *
 * The one contribution with no registry behind it, because there was none to
 * reach: `web/src/chat/commands.ts`, `cli/src/commands.ts` and
 * `channels/src/telegram/commands.ts` are three tables written out by hand, and
 * the comment at the top of the first explains why they do not share a core —
 * the surfaces agree on a vocabulary, not on an implementation. An extension's
 * command is the case that forces the issue, because there is one definition of
 * it and more than one place it has to appear. So it is served rather than
 * compiled in, and it answers with text rather than a resource key: its copy
 * ships with the extension and the translation layer has never seen it.
 */
export interface ExtensionCommand {
  /** `<extensionId>` or `<extensionId>-<suffix>`. Typed after the slash. */
  readonly id: string;
  /** The line the autocomplete shows. */
  readonly description?: string;
  /** What to write after the name, in prose. Empty means it takes none. */
  readonly argsHint?: string;
  run(input: CommandInput): Promise<CommandResult> | CommandResult;
}

export interface CommandInput {
  /** Everything the operator typed after the command name, untrimmed. */
  readonly args: string;
  /** The conversation it was typed in, when there is one. */
  readonly sessionKey: string | undefined;
  /** Fires if the request is abandoned. */
  readonly signal: AbortSignal;
}

export interface CommandResult {
  /** Shown verbatim. Not a resource key — see `ExtensionCommand`. */
  readonly message: string;
  /** `false` renders it as an error rather than a note. */
  readonly ok?: boolean;
}

/**
 * Everything an extension may reach, assembled once per activation.
 *
 * The five `register*` methods are the whole of what it can add, and each maps
 * to one entry in the manifest's `contributes`. A call whose kind the manifest
 * never declared is dropped with a warning on the extension's status row rather
 * than throwing: the declaration is disclosure for the approval screen, so an
 * extension that quietly grew a capability should be *visible*, not fatal.
 */
export interface ExtensionContext {
  readonly id: string;
  readonly manifest: ExtensionManifest;
  /**
   * This extension's block of `config.extensions.settings`, unparsed.
   *
   * Unparsed for the reason a channel's block is: the schema cannot know its
   * shape, so the extension parses it — with its own Zod schema, if it has one
   * — and reports a bad block by throwing out of `activate`, which lands on its
   * row as `failed` with the message.
   */
  readonly settings: Readonly<Record<string, unknown>>;
  /**
   * A directory this extension may write to.
   *
   * A sibling of its install directory, never a child: the approval covers
   * every byte under the install, so state written in there would revoke the
   * extension's own approval on the first write. Created lazily by the
   * extension, not by the host — an extension that never writes leaves no
   * directory behind.
   */
  readonly dataDir: string;
  readonly logger: Logger;
  readonly clock: Clock;
  /** Fires when the host unloads this extension, or the process stops. */
  readonly signal: AbortSignal;
  /**
   * A secret from the vault, under the `extensions` namespace and this id.
   *
   * The same arrangement a channel's bot token gets, and for the same reason:
   * `config.json` is a plain file that backups, dotfile repositories and screen
   * shares all reach.
   */
  secret(): string | undefined;

  registerTool(tool: AnyTool): void;
  registerChannel(factory: ChannelFactory): void;
  /**
   * A provider type, and optionally the wire it speaks.
   *
   * `spec` alone is enough for anything OpenAI-compatible — the overwhelmingly
   * common case, and the one that needs no code. `wire` is for a spec naming a
   * protocol this build has no adapter for; it cannot replace one that ships.
   */
  registerProvider(spec: ProviderSpec, wire?: WireAdapter): void;
  registerContributor(contributor: ContextContributor): void;
  registerCommand(command: ExtensionCommand): void;
}

/**
 * What an entry module exports, under the name `extension`.
 *
 * A named export rather than a default: `import-x/no-default-export` is on
 * across this repository, so a default would be the one shape the in-tree
 * example and the conformance testkit could not themselves use.
 *
 * `deactivate` is optional and is for what the abort signal cannot express — a
 * connection to close, a file to flush. Most extensions need neither, because
 * everything the host gave them is taken back when the bag is dropped.
 */
export interface Extension {
  activate(context: ExtensionContext): Promise<void> | void;
  deactivate?(): Promise<void> | void;
}

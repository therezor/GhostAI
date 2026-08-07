/**
 * The bag `activate` fills, and the two rules it enforces on the way in.
 *
 * `ExtensionContext`'s five `register*` methods land here. Nothing is applied
 * to a real registry until `activate` has returned, which is what makes a throw
 * half-way through install nothing at all — see the header of `extension.ts`.
 *
 * **Rule one: one namespace, checked once.** Every id an extension contributes
 * is `<extensionId>` or `<extensionId>-<suffix>`. A channel id becomes a
 * session-key prefix, a provider id becomes a `providers.<id>.type`, a command
 * id becomes what an operator types after a slash — three registries and one
 * character class, so two extensions cannot silently fight over a name and an
 * operator reading any of the three can tell whose it is. Tool names are the
 * exception in *spelling* only: `TOOL_NAME_PATTERN` has its own character
 * class, so a tool goes through `namespacedToolName` and comes out
 * `ext_<id>_<name>` — the same rule, transliterated.
 *
 * **Rule two: `contributes` has to mean something.** A registration whose kind
 * the manifest never declared is dropped. That keeps the approval screen
 * honest: an operator who approved "channels and commands" is not surprised by
 * a tool. It is *not* a security boundary and this file does not pretend
 * otherwise — the code is already running in-process and could reach `node:fs`
 * without asking anyone. What it stops is an honest mistake becoming an
 * invisible one.
 *
 * Both refusals are **warnings on a row**, never throws. An extension whose
 * fifth tool is misnamed should install the other four and say so, because the
 * alternative is an operator with a working extension that vanished and a log
 * line to find.
 */

import type { ChannelFactory } from '@ghostai/channels';
import type {
  ExtensionContribution,
  ExtensionManifest,
} from '@ghostai/protocol';
import type { ContextContributor } from '@ghostai/agent';
import type { ProviderSpec, WireAdapter } from '@ghostai/providers';
import { namespacedToolName, type AnyTool } from '@ghostai/tools';

import type { ExtensionCommand } from './extension.js';

/** The prefix that keeps an extension's tools out of every other namespace. */
export const EXTENSION_TOOL_PREFIX = 'ext';

/** `ext_{extension}_{tool}`, always matching `TOOL_NAME_PATTERN`. */
export function extensionToolName(
  extensionId: string,
  toolName: string,
): string {
  return namespacedToolName(EXTENSION_TOOL_PREFIX, extensionId, toolName);
}

/** A provider type an extension contributed, with its wire if it brought one. */
export interface ProviderRegistration {
  readonly spec: ProviderSpec;
  readonly wire: WireAdapter | undefined;
}

/** Everything one extension's `activate` asked for. */
export interface Registration {
  readonly tools: readonly AnyTool[];
  readonly channels: readonly ChannelFactory[];
  readonly providers: readonly ProviderRegistration[];
  readonly contributors: readonly ContextContributor[];
  readonly commands: readonly ExtensionCommand[];
  /** Ids and kinds that were refused, phrased for the operator. */
  readonly warnings: readonly string[];
}

/**
 * Collects registrations for one extension.
 *
 * A class rather than a closure because the host needs both halves of it at
 * different moments: the `register*` methods go on the context handed to
 * `activate`, and `result()` is read afterwards.
 */
export class RegistrationBag {
  private readonly id: string;
  private readonly declared: ReadonlySet<ExtensionContribution>;
  private readonly tools: AnyTool[] = [];
  private readonly channels: ChannelFactory[] = [];
  private readonly providers: ProviderRegistration[] = [];
  private readonly contributors: ContextContributor[] = [];
  private readonly commands: ExtensionCommand[] = [];
  private readonly warnings: string[] = [];

  constructor(manifest: ExtensionManifest) {
    this.id = manifest.id;
    this.declared = new Set(manifest.contributes);
  }

  addTool(tool: AnyTool): void {
    if (!this.allows('tools')) return;
    // The name is rewritten rather than checked, unlike every other id here:
    // tool names have their own character class, so an extension writing
    // `post message` is asking a reasonable thing and `namespacedToolName`
    // knows how to grant it. A refusal would be pedantry.
    const name = extensionToolName(this.id, tool.name);
    this.tools.push(name === tool.name ? tool : renamed(tool, name));
  }

  addChannel(factory: ChannelFactory): void {
    if (!this.allows('channels')) return;
    if (!this.namespaced(factory.id, 'channel')) return;
    this.channels.push(factory);
  }

  addProvider(spec: ProviderSpec, wire: WireAdapter | undefined): void {
    if (!this.allows('providers')) return;
    if (!this.namespaced(spec.id, 'provider')) return;
    this.providers.push({ spec, wire });
  }

  addContributor(contributor: ContextContributor): void {
    if (!this.allows('context')) return;
    this.contributors.push(contributor);
  }

  addCommand(command: ExtensionCommand): void {
    if (!this.allows('commands')) return;
    if (!this.namespaced(command.id, 'command')) return;
    this.commands.push(command);
  }

  result(): Registration {
    return {
      tools: this.tools,
      channels: this.channels,
      providers: this.providers,
      contributors: this.contributors,
      commands: this.commands,
      warnings: this.warnings,
    };
  }

  private allows(kind: ExtensionContribution): boolean {
    if (this.declared.has(kind)) return true;
    this.warnings.push(
      `Registered ${kind}, which the manifest's "contributes" does not declare. ` +
        `Add "${kind}" to it and re-approve.`,
    );
    return false;
  }

  private namespaced(id: string, kind: string): boolean {
    if (id === this.id || id.startsWith(`${this.id}-`)) return true;
    this.warnings.push(
      `The ${kind} "${id}" is not namespaced to this extension. ` +
        `It has to be "${this.id}" or start with "${this.id}-".`,
    );
    return false;
  }
}

/**
 * The same tool under a namespaced name.
 *
 * A shallow copy rather than a mutation, because `defineTool` freezes what it
 * returns and an extension may well hand the same object to two hosts in a
 * test. `definition` is re-bound so the name the model is told matches the name
 * the registry holds — the one place where forgetting would produce a tool the
 * model can see and cannot call.
 */
function renamed(tool: AnyTool, name: string): AnyTool {
  return {
    ...tool,
    name,
    definition: (source) => ({ ...tool.definition(source), name }),
    parseArgs: (raw) => tool.parseArgs(raw),
    execute: async (args, context) => await tool.execute(args, context),
    run: async (raw, context) => await tool.run(raw, context),
  };
}

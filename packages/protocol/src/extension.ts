/**
 * An extension: a manifest, the code it names, and what it says it contributes.
 *
 * The shape is deliberately the toolbox manifest's, because the two solve the
 * same problem. An extension's capabilities are not *settings* — they are the
 * boundary that decides what running it means — so they live in a file outside
 * the config tree, and `config.extensions` carries an id, an on/off and a block
 * of the extension's own settings, none of which can widen anything.
 *
 * Three fields are load-bearing:
 *
 *  - **`id` is the directory name, and the prefix for everything.** A channel,
 *    a provider, a command and (through `extensionToolName`) a tool all have to
 *    be named `<id>` or `<id>-<suffix>`, so one namespace check covers four
 *    registries and two extensions cannot silently fight over a name.
 *
 *  - **`entry` is a relative path, checked in `@ghostai/security`.** It is the
 *    module the host imports, and letting it escape the extension's own
 *    directory would make the digest cover something other than the code that
 *    runs.
 *
 *  - **`contributes` is disclosure, not enforcement.** It is what the approval
 *    screen shows the operator: this extension wants to add channels and
 *    commands. The host drops a registration whose kind is not listed, which
 *    keeps the declaration honest — but an extension runs in-process with full
 *    `node:` access, so nothing here is a security boundary and
 *    `docs/security.md` says so in as many words.
 *
 * What is deliberately absent is a `permissions` block. A tool an extension
 * registers is granted exactly the way every other tool is: per agent, in
 * `agents.list.<id>.tools`, where absent means disabled. A second permission
 * vocabulary reachable from a manifest would be a way to grant something the
 * operator never enabled.
 */

import { z } from 'zod';

/**
 * The registries an extension may write into.
 *
 * `context` is the system-prompt contributor seam — the one memory and skills
 * arrive through — and is named for the interface rather than for "prompt",
 * because what it contributes is a section of context and the prompt is what
 * the sections add up to.
 */
export const ExtensionContributionSchema = z.enum([
  'tools',
  'channels',
  'providers',
  'context',
  'commands',
]);
export type ExtensionContribution = z.infer<typeof ExtensionContributionSchema>;

export const ExtensionManifestSchema = z.object({
  /** Bumped only for a breaking manifest change; refused when unrecognised. */
  schema: z.literal('ghostai.extension/1'),
  /** Also the directory name, and the prefix every contributed id carries. */
  id: z.string().min(1).max(40),
  version: z.string().default('0.0.0'),
  /** Shown in the UI. Empty falls back to the id. */
  label: z.string().default(''),
  /** One sentence, shown beside the Approve button. */
  description: z.string().default(''),
  /**
   * The ESM module the host imports, relative to the extension's directory.
   *
   * A bundled file is the expectation rather than a convention: the approval
   * digest walks the whole install directory, and the file-count cap that keeps
   * that walk bounded is what makes shipping `node_modules` fail loudly instead
   * of slowly.
   */
  entry: z.string().min(1).default('dist/index.js'),
  /** What the operator is approving. See the module header. */
  contributes: z.array(ExtensionContributionSchema).default([]),
  engines: z
    .object({
      /** A semver range this build must satisfy. Empty means any. */
      ghostai: z.string().default(''),
    })
    .prefault({}),
});
export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;

/**
 * The extension contract with nothing else in it.
 *
 * `examples/loopback-channel` does this for `ChannelFactory` — the channel with
 * the transport removed, so what is left is the contract. This is the same
 * thing for `Extension`: it contributes one of each of three kinds, reaches for
 * nothing a real extension would not, and would still be under a hundred lines
 * if it were doing something useful.
 *
 * Four things a first-time reader usually gets wrong, each shown rather than
 * described:
 *
 *  - **The export is named `extension`, not default.** `importExtension` looks
 *    for that name and says so when it does not find it.
 *  - **Everything reachable is on the context.** There is no module to import
 *    for the registry, the config or the logger, and no singleton to reach for.
 *  - **`contributes` in the manifest has to match what `activate` registers.**
 *    The host drops anything beyond it and puts a warning on the extension's
 *    row; `test/hello.test.ts` catches that before an operator does.
 *  - **Every id is namespaced.** The command is `hello-time`, not `time`,
 *    because two extensions must not be able to fight over a slash command. The
 *    tool alone is exempt in *spelling*: the host rewrites `greet` to
 *    `ext_hello_greet` on the way in, since tool names have their own character
 *    class.
 *
 * Nothing here writes to `context.dataDir`, and that is the fourth thing worth
 * copying: an extension that writes during `activate` fails on an install where
 * that directory does not exist yet, so state is written lazily or not at all.
 */

import { z } from 'zod';

import type { Extension, ExtensionContext } from '@ghostai/extension-host';
import { defineTool } from '@ghostai/tools';

/**
 * The extension's own settings, parsed by the extension.
 *
 * `config.extensions.settings.hello` reaches `activate` unparsed, because the
 * config schema cannot know its shape. A bad block throws out of `activate`,
 * which lands on the row as `failed` with the message — which is exactly where
 * an operator who mistyped it should read about it.
 */
const SettingsSchema = z.object({
  greeting: z.string().default('Hello'),
});

const greetTool = (greeting: string): ReturnType<typeof defineTool> =>
  defineTool({
    name: 'greet',
    description:
      'Greet someone by name. Registered by the hello extension; harmless.',
    risk: 'safe',
    schema: z.strictObject({
      who: z.string().min(1).describe('The name to greet.'),
    }),
    execute: (args) => `${greeting}, ${args.who}!`,
  });

export const extension: Extension = {
  activate(context: ExtensionContext) {
    const settings = SettingsSchema.parse(context.settings);

    context.registerTool(greetTool(settings.greeting));

    // A prompt section. The agent reads this on every turn, so it is one short
    // paragraph — a contributor that wrote a page would cost that page in every
    // request of every turn on this install.
    context.registerContributor({
      name: 'hello',
      staticSection: () =>
        `## Hello\n\nAn example extension is installed. Its \`ext_hello_greet\` ` +
        `tool greets someone by name, and does nothing else.`,
    });

    context.registerCommand({
      id: 'hello-time',
      description: 'Show the time this install thinks it is.',
      run: () => ({
        // `context.clock`, not `Date.now()`: an extension that reads the wall
        // clock directly is one a test cannot hold still, and the host hands
        // over the same injected clock everything else here uses.
        message: `${settings.greeting} — it is ${new Date(
          context.clock.now(),
        ).toISOString()}`,
      }),
    });

    context.logger.info(
      { greeting: settings.greeting },
      'hello extension ready',
    );
  },
};

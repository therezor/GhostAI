/**
 * The conformance suite, run against this extension's own `activate`.
 *
 * This file is the point of the example as much as `src/index.ts` is: it is
 * three lines, and it is what an extension living in its own repository copies.
 * `extensionConformance` reaches into the host's real `RegistrationBag`, so the
 * two rules that are invisible from inside an extension — the namespace, and
 * `contributes` matching what `activate` does — are checked here rather than on
 * a settings panel after an operator has already installed it.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { extensionConformance } from '@ghostbot/extension-host/testkit';
import { ExtensionManifestSchema } from '@ghostbot/protocol';

import { extension } from '#src/index.js';

/**
 * The manifest that ships beside it, read rather than restated.
 *
 * A copy in the test would pass while the file on disk said something else,
 * which is the one failure this suite exists to catch.
 */
const manifest = ExtensionManifestSchema.parse(
  JSON.parse(
    readFileSync(new URL('../ghostai.extension.json', import.meta.url), 'utf8'),
  ),
);

extensionConformance({
  manifest,
  extension: () => extension,
  expect: { tools: 1, contributors: 1, commands: 1, channels: 0, providers: 0 },
});

describe('the hello extension', () => {
  it('greets with the greeting its settings gave it', async () => {
    // The settings block reaches `activate` unparsed and the extension parses
    // it — with its own Zod schema, which is what makes a typo in
    // `config.extensions.settings.hello` a `failed` row with a message rather
    // than a silent default.
    const registered: string[] = [];
    let greeted = '';

    await extension.activate({
      id: 'hello',
      manifest,
      settings: { greeting: 'Ahoy' },
      dataDir: '/nonexistent',
      logger: { info: () => undefined } as never,
      clock: { now: () => 0 } as never,
      signal: new AbortController().signal,
      secret: () => undefined,
      registerTool: (tool) => {
        registered.push(tool.name);
        // `run` answers with a string or a `ToolResult`; this tool returns the
        // former, which is the shape a handler that has nothing to attach uses.
        void tool.run({ who: 'world' }, {} as never).then((output) => {
          greeted = typeof output === 'string' ? output : output.content;
        });
      },
      registerChannel: () => undefined,
      registerProvider: () => undefined,
      registerContributor: () => undefined,
      registerCommand: () => undefined,
    });

    expect(registered).toEqual(['greet']);
    await new Promise((resolve) => setImmediate(resolve));
    expect(greeted).toBe('Ahoy, world!');
  });

  it('refuses a settings block it cannot parse, out of activate', () => {
    // Which the host turns into `state: failed` with this message beside it.
    //
    // Thrown rather than rejected, because this `activate` is synchronous — the
    // contract allows either and the host awaits whatever it gets, so an
    // extension that needs no `await` should not have to write one.
    expect(() => {
      void extension.activate({ settings: { greeting: 42 } } as never);
    }).toThrow(/expected string/);
  });
});

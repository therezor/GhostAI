/**
 * The extension conformance suite.
 *
 * What an extension author can run against their own `activate` without
 * standing up a GhostAI install. It answers the questions that only the host
 * can answer and that an extension's own unit tests structurally cannot: does
 * `activate` complete, does everything it registered survive the namespace
 * rule, and does it declare in `contributes` what it actually does.
 *
 * That last one is the case worth having a suite for. An extension whose
 * manifest says `["tools"]` and whose `activate` also registers a channel is
 * *working* in every test the author would write — the channel object is fine,
 * the factory is fine — and the host silently drops it, because `contributes`
 * is what the operator approved. A warning on a settings panel is a poor place
 * to discover that; a red test in the extension's own repository is the right
 * one.
 *
 * Reachable as `@ghostai/extension-host/testkit`, beside `@ghostai/tools`'
 * and `@ghostai/channels`', and for the same reason those two are exported: an
 * implementation living outside this repository is exactly the one that has to
 * be able to check itself. It stays off the package entry — this file imports
 * `vitest`, and the entry is in the runtime graph of everything downstream.
 */

import { describe, expect, it } from 'vitest';

import { silentLogger, systemClock } from '@ghostai/core';
import type { ExtensionManifest } from '@ghostai/protocol';

import type { Extension, ExtensionContext } from '#src/extension.js';
import { RegistrationBag, type Registration } from '#src/registration.js';

export interface ExtensionConformanceOptions {
  /** The manifest that ships beside it. Its `contributes` is under test. */
  readonly manifest: ExtensionManifest;
  /** A fresh instance per case, so nothing one case does leaks into the next. */
  readonly extension: () => Extension;
  /** The `config.extensions.settings.<id>` block to activate against. */
  readonly settings?: Readonly<Record<string, unknown>>;
  /**
   * What it must register to be worth installing.
   *
   * Optional, and worth setting: an extension that activates cleanly and
   * registers nothing passes every other case here.
   */
  readonly expect?: {
    readonly tools?: number;
    readonly channels?: number;
    readonly providers?: number;
    readonly contributors?: number;
    readonly commands?: number;
  };
}

/**
 * Runs one extension through the same recorder the host uses.
 *
 * The real `RegistrationBag`, not a stand-in — the namespace rule and the
 * `contributes` check are the things under test, so a fake would be testing
 * itself.
 */
export function extensionConformance(
  options: ExtensionConformanceOptions,
): void {
  const activate = async (): Promise<Registration> => {
    const bag = new RegistrationBag(options.manifest);
    const controller = new AbortController();
    await options.extension().activate(contextFor(options, bag, controller));
    controller.abort();
    return bag.result();
  };

  describe(`extension conformance: ${options.manifest.id}`, () => {
    it('activates without throwing', async () => {
      // A throw here is `state: failed` on the panel with the message beside
      // it, and the extension contributes nothing at all.
      await expect(activate()).resolves.toBeDefined();
    });

    it('registers nothing its manifest does not declare', async () => {
      // The case an extension's own tests cannot see. Everything it registered
      // works; the host drops what `contributes` never mentioned, because that
      // list is what the operator approved.
      const registration = await activate();
      expect(registration.warnings).toEqual([]);
    });

    it('namespaces every id it contributes', async () => {
      // Covered by the assertion above — a breach is a warning — and asserted
      // separately because the failure reads completely differently: this one
      // says an id is wrong, that one says a whole capability was undeclared.
      const registration = await activate();
      const ids = [
        ...registration.channels.map((factory) => factory.id),
        ...registration.providers.map((one) => one.spec.id),
        ...registration.commands.map((command) => command.id),
      ];

      for (const id of ids) {
        expect(
          id === options.manifest.id ||
            id.startsWith(`${options.manifest.id}-`),
        ).toBe(true);
      }
    });

    it('gets tool names the model can actually call', async () => {
      // `ext_<id>_<name>`, capped at what the OpenAI wire accepts. An extension
      // never writes this itself, so what is checked is that the rewrite
      // happened and produced something legal.
      const registration = await activate();

      for (const tool of registration.tools) {
        expect(tool.name).toMatch(/^ext_/);
        expect(tool.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
        // The definition the model is sent has to agree with the registry key,
        // or the model is told about a tool it cannot call.
        expect(tool.definition('extension').name).toBe(tool.name);
      }
    });

    it('contributes what it says it does', async () => {
      const registration = await activate();
      const wanted = options.expect ?? {};

      if (wanted.tools !== undefined) {
        expect(registration.tools).toHaveLength(wanted.tools);
      }
      if (wanted.channels !== undefined) {
        expect(registration.channels).toHaveLength(wanted.channels);
      }
      if (wanted.providers !== undefined) {
        expect(registration.providers).toHaveLength(wanted.providers);
      }
      if (wanted.contributors !== undefined) {
        expect(registration.contributors).toHaveLength(wanted.contributors);
      }
      if (wanted.commands !== undefined) {
        expect(registration.commands).toHaveLength(wanted.commands);
      }
    });

    it('can be activated twice without the first run leaking', async () => {
      // The host reloads on a settings save, and an extension that accumulated
      // state in module scope would register twice as much the second time.
      const first = await activate();
      const second = await activate();

      expect(second.tools.map((tool) => tool.name)).toEqual(
        first.tools.map((tool) => tool.name),
      );
      expect(second.commands).toHaveLength(first.commands.length);
    });
  });
}

function contextFor(
  options: ExtensionConformanceOptions,
  bag: RegistrationBag,
  controller: AbortController,
): ExtensionContext {
  return {
    id: options.manifest.id,
    manifest: options.manifest,
    settings: options.settings ?? {},
    // A path that does not exist, on purpose: an extension that writes during
    // `activate` rather than lazily fails here, which is where it should.
    dataDir: `/nonexistent/extension-data/${options.manifest.id}`,
    logger: silentLogger,
    clock: systemClock,
    signal: controller.signal,
    secret: () => undefined,
    registerTool: (tool) => {
      bag.addTool(tool);
    },
    registerChannel: (factory) => {
      bag.addChannel(factory);
    },
    registerProvider: (spec, wire) => {
      bag.addProvider(spec, wire);
    },
    registerContributor: (contributor) => {
      bag.addContributor(contributor);
    },
    registerCommand: (command) => {
      bag.addCommand(command);
    },
  };
}

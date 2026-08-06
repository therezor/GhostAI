/**
 * Installed toolboxes, and which of them an operator has approved.
 *
 * Two halves that deliberately do not trust each other. The manifest is a file
 * on disk, editable by anything with write access. The approval is a row in the
 * database recording the sha256 of the exact bytes that were reviewed. Neither
 * is authority on its own: resolution asks whether *these* bytes are approved,
 * so editing an installed toolbox silently revokes its approval and the next
 * turn refuses with a sentence naming the drift. Nobody has to remember to
 * re-approve, because they cannot avoid it.
 *
 * It lives in `@ghostai/security` rather than `@ghostai/core` for a reason the
 * layer graph makes non-negotiable: `core` may not import `security`, and the
 * approval check needs `parseToolbox` and `assertToolboxPolicy`. Putting the
 * table here also keeps the whole "may this agent run in this container"
 * decision inside the package that is meant to hold every such decision.
 *
 * The toolboxes directory sits **beside** the workspace, never inside it — the
 * same placement, and the same reason, as `agentsDir`: the jail root *is* the
 * workspace, so a manifest kept in there would be writable by `write_file`, and
 * prompt injection would become a way to rewrite the policy the agent
 * runs under.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

import { GhostError, systemClock, type Clock } from '@ghostai/core';
import type { Toolbox } from '@ghostai/protocol';

import { assertToolboxPolicy, manifestHash, parseToolbox } from './toolbox.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS toolbox_approvals (
  name           TEXT    PRIMARY KEY,
  manifest_sha256 TEXT   NOT NULL,
  image          TEXT    NOT NULL,
  approved_at_ms INTEGER NOT NULL
) STRICT;
`;

/**
 * How much of a `TOOLS.md` is loaded.
 *
 * It goes into the *cached* half of the system prompt, so the cost is paid once
 * per session rather than per iteration — but it is still real, and a reference
 * that grew without anyone noticing would quietly take a slice of every window on
 * the install. 12 KB is about 3,000 tokens, comfortably more than the reference
 * this was written for and small enough to be a decision rather than an accident.
 */
export const TOOLBOX_DOCS_MAX_BYTES = 12_288;

/** A toolbox that parsed, passed policy, and matches its recorded approval. */
export interface ApprovedToolbox {
  readonly toolbox: Toolbox;
  /** Host path of the manifest, for the read-only mount into the container. */
  readonly manifestPath: string;
  readonly manifestSha256: string;
  /**
   * `TOOLS.md` from beside the manifest, or `''` when there is none.
   *
   * Installed on the host rather than baked into the image, and that move is the
   * point. Inside the container it could only be read by the model *choosing* to
   * run `tools` — and it did not: asked a research question it answered from
   * search snippets while a reference explaining `--read` sat one command away.
   * Beside the manifest it is readable by the prompt builder, so the model is told
   * rather than invited to ask. It is still mounted into the container as part of
   * the manifest directory, so `tools` keeps working for the case where a model
   * does look.
   *
   * **Deliberately not part of the approval hash.** The hash covers policy — the
   * image, the capabilities, the network ceiling — and prose that reaches the
   * model changes nothing an operator approved about what the container may *do*.
   * Making an operator re-approve a typo fix in documentation would train them to
   * re-approve without reading, which is the one thing the gate cannot survive.
   */
  readonly docs: string;
}

/** What `list` reports, including the toolboxes that are *not* usable. */
export interface ToolboxListing {
  readonly name: string;
  readonly manifestPath: string;
  readonly toolbox: Toolbox | undefined;
  readonly approved: boolean;
  /** Why it cannot be used, or `undefined` when it can. */
  readonly problem: string | undefined;
}

interface ToolboxStoreOptions {
  readonly database: DatabaseSync;
  /** `<root>/toolboxes`, outside the jail. */
  readonly dir: string;
  readonly clock?: Clock;
}

export class ToolboxStore {
  private readonly db: DatabaseSync;
  private readonly dir: string;
  private readonly clock: Clock;

  constructor(options: ToolboxStoreOptions) {
    this.db = options.database;
    this.dir = options.dir;
    this.clock = options.clock ?? systemClock;
    this.db.exec(SCHEMA);
  }

  private stmt(sql: string): StatementSync {
    return this.db.prepare(sql);
  }

  manifestPathFor(name: string): string {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
      throw new GhostError('invalid_input', `Not a toolbox name: ${name}`, {
        details: { name },
      });
    }
    return join(this.dir, name, 'toolbox.json');
  }

  /** Raw manifest bytes, or `undefined` when nothing is installed under that name. */
  private read(name: string): Uint8Array | undefined {
    // Outside the `try`: a name that is not a slug is a caller error with its own
    // message, and letting the catch below rewrap it as "could not be read"
    // would report a filesystem problem for what is really a rejected input.
    const path = this.manifestPathFor(name);
    try {
      return readFileSync(path);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
      throw new GhostError('config', `Toolbox "${name}" could not be read`, {
        cause: error,
        details: { name },
      });
    }
  }

  private approvedHash(name: string): string | undefined {
    const row = this.stmt(
      'SELECT manifest_sha256 FROM toolbox_approvals WHERE name = ?',
    ).get(name) as { manifest_sha256: string } | undefined;
    return row?.manifest_sha256;
  }

  /**
   * The toolbox an agent named, or a refusal explaining which half is missing.
   *
   * Every failure mode gets its own sentence. "Profile not found" and "toolbox
   * found but not approved" and "toolbox edited since approval" are three
   * different things for an operator to do next, and collapsing them into one
   * message turns a two-second fix into a hunt.
   */
  require(name: string): ApprovedToolbox {
    const bytes = this.read(name);
    if (bytes === undefined) {
      throw new GhostError(
        'config',
        `No toolbox is installed under "${name}".\n` +
          `  Build and install one with \`toolboxes/build.sh ${name}\`, or clear the agent's toolbox.`,
        { details: { name } },
      );
    }

    const toolbox = parseToolbox(bytes);
    assertToolboxPolicy(toolbox);

    const hash = manifestHash(bytes);
    const approved = this.approvedHash(name);
    if (approved === undefined) {
      throw new GhostError(
        'config',
        `Toolbox "${name}" is installed but has never been approved.\n` +
          `  Review what it asks for with \`ghost toolbox list\`, then \`ghost toolbox approve ${name}\`.`,
        { details: { name } },
      );
    }
    if (approved !== hash) {
      throw new GhostError(
        'config',
        `Toolbox "${name}" has changed since it was approved.\n` +
          '  The manifest on disk no longer matches the one that was reviewed, so it will\n' +
          `  not be used. Review the change with \`ghost toolbox list\`, then approve it with\n` +
          `  \`ghost toolbox approve ${name}\`.`,
        { details: { name, approved, actual: hash } },
      );
    }

    return {
      toolbox,
      manifestPath: this.manifestPathFor(name),
      manifestSha256: hash,
      docs: this.docs(name),
    };
  }

  /** Records the hash of what is on disk now. This *is* the approval. */
  approve(name: string): ApprovedToolbox {
    const bytes = this.read(name);
    if (bytes === undefined) {
      throw new GhostError(
        'config',
        `No toolbox is installed under "${name}"`,
        {
          details: { name },
        },
      );
    }
    const toolbox = parseToolbox(bytes);
    assertToolboxPolicy(toolbox);
    const hash = manifestHash(bytes);

    this.stmt(
      `INSERT INTO toolbox_approvals (name, manifest_sha256, image, approved_at_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         manifest_sha256 = excluded.manifest_sha256,
         image = excluded.image,
         approved_at_ms = excluded.approved_at_ms`,
    ).run(name, hash, toolbox.image, this.clock.now());

    return {
      toolbox,
      manifestPath: this.manifestPathFor(name),
      manifestSha256: hash,
      docs: this.docs(name),
    };
  }

  /**
   * `TOOLS.md` from beside the manifest, or `''`.
   *
   * Absent is normal, not an error: a toolbox is complete without documentation,
   * and refusing to resolve one because a `.md` file is missing would make the
   * prose load-bearing for whether the container runs at all.
   *
   * Read on every resolution rather than cached, matching the manifest: editing
   * the reference should take effect on the next turn, and this is one small file
   * read beside one the same code path already does.
   */
  private docs(name: string): string {
    try {
      const bytes = readFileSync(join(this.dir, name, 'TOOLS.md'));
      // Sliced on *bytes* before decoding, so a huge file is never fully held in
      // memory as a string. A cut in the middle of a multi-byte character decodes
      // to a replacement char, which is a cosmetic price for a hard bound.
      return new TextDecoder().decode(
        bytes.subarray(0, TOOLBOX_DOCS_MAX_BYTES),
      );
    } catch {
      return '';
    }
  }

  /** Forgets an approval. The manifest stays on disk; it simply stops resolving. */
  revoke(name: string): void {
    this.stmt('DELETE FROM toolbox_approvals WHERE name = ?').run(name);
  }

  /**
   * Every installed toolbox, usable or not.
   *
   * A broken manifest is reported rather than skipped: a toolbox that vanishes
   * from the list because it fails to parse looks like one that was never
   * installed, and the operator goes looking in the wrong place.
   */
  list(): readonly ToolboxListing[] {
    let entries: readonly string[];
    try {
      entries = readdirSync(this.dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }

    return entries.map((name) => {
      const manifestPath = join(this.dir, name, 'toolbox.json');
      try {
        const bytes = this.read(name);
        if (bytes === undefined) {
          return {
            name,
            manifestPath,
            toolbox: undefined,
            approved: false,
            problem: 'no manifest',
          };
        }
        const toolbox = parseToolbox(bytes);
        assertToolboxPolicy(toolbox);
        const approved = this.approvedHash(name) === manifestHash(bytes);
        return {
          name,
          manifestPath,
          toolbox,
          approved,
          problem: approved
            ? undefined
            : 'not approved, or changed since approval',
        };
      } catch (error) {
        return {
          name,
          manifestPath,
          toolbox: undefined,
          approved: false,
          problem: error instanceof Error ? error.message : String(error),
        };
      }
    });
  }
}

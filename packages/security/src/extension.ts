/**
 * Whether a directory of code may be loaded into this process, and what
 * question that decision actually answers.
 *
 * The shape is `toolbox.ts`'s — parse the manifest, refuse what the machinery
 * cannot honour, hash what the operator reviewed — with one deliberate
 * difference, and it is the difference that makes the analogy hold.
 *
 * **A toolbox is authorised by its manifest alone because the manifest pins the
 * code.** `image` must be a digest, so approving those bytes approves an exact,
 * immutable container. An extension's manifest names `entry`, which is a path:
 * approving the manifest would approve a *pointer*, and the file behind it
 * could be swapped afterwards without moving a single approved byte. So the
 * digest here covers the whole install directory — every regular file under it,
 * each contributing its relative path and its own sha256 to one ordered hash.
 * Editing any of them, adding one, or removing one moves the digest and revokes
 * the approval, which is exactly what the toolbox gate buys and what a
 * manifest-only hash would only appear to.
 *
 * **What this does not buy** is worth stating in the same breath, because
 * `docs/security.md` states it too: an extension that passes runs in the server
 * process with full `node:` access. It can read the vault file, spawn a process
 * and open a socket, and nothing here stops it. The question this module
 * answers is "are these the exact bytes the operator reviewed?", not "is this
 * code safe" — which is the same question `ToolboxStore` answers, at the same
 * trust level as a toolbox with host `exec`.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { GhostError, isExtensionId } from '@ghostwire/core';
import {
  ExtensionManifestSchema,
  type ExtensionManifest,
} from '@ghostwire/protocol';

/** The file every installed extension is found by. */
export const EXTENSION_MANIFEST_FILE = 'ghostai.extension.json';

/**
 * How much of an install directory the digest will walk.
 *
 * Not a performance tuning knob — a statement of what an extension is. The
 * expectation is a manifest plus a bundled entry, which is single digits of
 * files, and a directory that blows through this is one carrying an unbundled
 * `node_modules`. Refusing loudly at that point is the difference between "this
 * extension is not shaped the way extensions are shaped" and a boot that takes
 * ninety seconds for a reason nobody can see.
 */
export const MAX_EXTENSION_FILES = 4096;
export const MAX_EXTENSION_BYTES: number = 64 * 1024 * 1024;

/**
 * What an `entry` may end in.
 *
 * ESM only, because that is what `import()` will accept from a file URL without
 * a `package.json` beside it saying so. A `.cjs` entry would load and then fail
 * on the first `export`, which is a worse error than this one.
 */
const ENTRY_EXTENSIONS: readonly string[] = ['.js', '.mjs'];

/** Parses manifest bytes, with the schema's own errors turned into a sentence. */
export function parseExtension(bytes: Uint8Array): ExtensionManifest {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (error) {
    throw new GhostError('config', 'Extension manifest is not valid JSON', {
      cause: error,
    });
  }
  const result = ExtensionManifestSchema.safeParse(json);
  if (!result.success) {
    const detail = result.error.issues
      .map(
        (issue) =>
          `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
      )
      .join('; ');
    throw new GhostError(
      'config',
      `Extension manifest is not valid: ${detail}`,
    );
  }
  return result.data;
}

/**
 * Refuses an extension the host cannot load safely.
 *
 * Separate from parsing for the reason `assertToolboxPolicy` is: a manifest can
 * be perfectly well-formed and still name something that would put the code
 * that runs outside the bytes that were approved.
 *
 * `dir` is the *install* directory, and it is resolved through `realpath`
 * before the containment check. A lexical check alone is defeated by a symlink
 * — `entry: "lib/x.js"` where `lib` points at `/etc` reads as contained and is
 * not — which is the same reasoning, and the same order, `WorkspaceJail` uses.
 */
export function assertExtensionPolicy(
  manifest: ExtensionManifest,
  dir: string,
): void {
  if (!isExtensionId(manifest.id)) {
    throw new GhostError(
      'config',
      `"${manifest.id}" is not a usable extension id.\n` +
        '  1–40 characters of lowercase letters, digits and hyphens, not starting\n' +
        '  or ending with a hyphen. The id names a directory and prefixes every\n' +
        '  tool, channel, provider and command the extension contributes.',
      { details: { id: manifest.id } },
    );
  }

  // The directory name wins nothing here — it is checked *against* the
  // manifest, and a disagreement is refused rather than resolved. Letting
  // either side win would mean the id an operator approved and the id the host
  // registers under could differ, and the approval row is keyed by id.
  const dirName = basename(resolve(dir));
  if (dirName !== manifest.id) {
    throw new GhostError(
      'config',
      `Extension "${manifest.id}" is installed in a directory called "${dirName}".\n` +
        '  The two have to agree: the approval is recorded against the id, and the\n' +
        '  directory is how the extension is found. Rename one to match the other.',
      { details: { id: manifest.id, dirName } },
    );
  }

  if (isAbsolute(manifest.entry)) {
    throw new GhostError(
      'config',
      `Extension "${manifest.id}" names an absolute entry: ${manifest.entry}\n` +
        '  The entry is relative to the extension directory, so that the digest\n' +
        '  covering that directory also covers the code that runs.',
      { details: { id: manifest.id, entry: manifest.entry } },
    );
  }

  if (!ENTRY_EXTENSIONS.some((suffix) => manifest.entry.endsWith(suffix))) {
    throw new GhostError(
      'config',
      `Extension "${manifest.id}" names an entry that is not an ES module: ${manifest.entry}\n` +
        `  It has to end in ${ENTRY_EXTENSIONS.join(' or ')}.`,
      { details: { id: manifest.id, entry: manifest.entry } },
    );
  }

  const root = realpathSync(resolve(dir));
  const entry = realpathSync(resolve(root, manifest.entry));
  if (!contains(root, entry)) {
    throw new GhostError(
      'config',
      `Extension "${manifest.id}" names an entry outside its own directory: ${manifest.entry}\n` +
        '  Resolved, that is a path the approval digest does not cover, so the code\n' +
        '  that ran would not be the code that was reviewed.',
      { details: { id: manifest.id, entry: manifest.entry, resolved: entry } },
    );
  }
}

/**
 * The digest of everything installed under one extension directory.
 *
 * Over each file's *bytes*, never over a re-serialisation of anything: the same
 * reason `manifestHash` gives, one directory wider. The relative path goes into
 * the hash beside the content so that renaming a file — which changes what
 * `entry` resolves to — moves the digest even when no byte of content did.
 *
 * `\0` separates the two halves because it is the one byte a path cannot
 * contain, so no pair of (path, hash) can be re-cut into a different pair.
 * Sorted, because `readdir` order is a property of the filesystem and an
 * approval that changed when an install was copied between machines would be
 * an approval nobody trusted.
 */
export function extensionDigest(dir: string): string {
  const root = realpathSync(resolve(dir));
  const lines: string[] = [];
  let bytes = 0;

  for (const file of walk(root, root)) {
    const content = readFileSync(file.absolute);
    bytes += content.byteLength;
    if (lines.length >= MAX_EXTENSION_FILES || bytes > MAX_EXTENSION_BYTES) {
      throw new GhostError(
        'config',
        `The extension in ${dir} is too large to authorise.\n` +
          `  The limit is ${String(MAX_EXTENSION_FILES)} files and ` +
          `${String(MAX_EXTENSION_BYTES / 1024 / 1024)} MB, and every byte under the\n` +
          '  directory is hashed. An extension is expected to ship a bundled entry\n' +
          '  rather than an installed dependency tree.',
        { details: { dir } },
      );
    }
    const hash = createHash('sha256').update(content).digest('hex');
    lines.push(`${file.relative}\0${hash}`);
  }

  lines.sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

interface WalkedFile {
  readonly absolute: string;
  readonly relative: string;
}

/**
 * Every regular file under `dir`, depth-first.
 *
 * Symlinks are followed for *files* and skipped for directories. A symlinked
 * file is content the extension ships and so has to be hashed; a symlinked
 * directory is a loop waiting to happen and a way to pull an arbitrary subtree
 * of the host into the digest, neither of which an install has a reason to do.
 */
function* walk(root: string, dir: string): Generator<WalkedFile> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(root, absolute);
    } else if (entry.isFile()) {
      yield {
        absolute,
        relative: relative(root, absolute).split(sep).join('/'),
      };
    }
  }
}

/**
 * Whether `candidate` sits strictly under `root`.
 *
 * Both are already canonical when this is called — the caller `realpath`s them
 * — so this is the lexical half and nothing more. `rel === ''` is the
 * candidate *being* the root, which for an entry file cannot happen and is
 * refused anyway rather than special-cased into an acceptance.
 */
function contains(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..';
}

/** Reads and parses the manifest an install directory holds. */
export function readExtensionManifest(dir: string): ExtensionManifest {
  return parseExtension(readFileSync(join(dir, EXTENSION_MANIFEST_FILE)));
}

/**
 * One line of Node's noise that is not ours to fix and not the operator's to
 * read.
 *
 * `node:sqlite` is flagged experimental, so every node before 26 prints
 *
 * ```text
 * (node:517098) ExperimentalWarning: SQLite is an experimental feature and
 * might change at any time
 * ```
 *
 * on stderr the moment the store opens — which is every command that touches a
 * session, on the two LTS lines `engines` supports. Nothing about it is
 * actionable: the module is chosen deliberately (see the header of
 * `@ghostwire/core`'s `session-store.ts`), and a warning nobody can act on
 * trains people to skim past the ones they can.
 *
 * It is silenced by wrapping `process.emitWarning` rather than by
 * `--disable-warning=ExperimentalWarning` or `--no-warnings`: both of those
 * would have to reach the process through the shebang, and both are blunt —
 * they would hide the next experimental API somebody reaches for by accident
 * along with this one. The predicate here matches that message and only that
 * message; anything else, including another `ExperimentalWarning`, prints as
 * Node wrote it.
 *
 * This module imports nothing, which is what keeps it inside the module-scope
 * budget `program.ts` documents: the binary loads it before anything else and
 * it costs a regex.
 */

/**
 * Matched as a prefix rather than searched for anywhere in the text, so that a
 * real warning about the database — one worth reading — is not swallowed with
 * it.
 */
const SQLITE_EXPERIMENTAL = 'SQLite is an experimental feature';

/** `process.emitWarning` with its four overloads flattened to one signature. */
type EmitWarning = (warning: string | Error, ...rest: unknown[]) => void;

/**
 * Drops the `node:sqlite` experimental warning for the rest of the process.
 *
 * Returns the undo, which is what lets a test put the real emitter back rather
 * than leave a patched global behind for whatever runs next in the worker.
 */
export function silenceSqliteExperimentalWarning(
  target: NodeJS.Process = process,
): () => void {
  const emit = target.emitWarning.bind(target) as EmitWarning;
  const patched: EmitWarning = (warning, ...rest) => {
    if (!isSqliteExperimental(warning, rest)) emit(warning, ...rest);
  };
  target.emitWarning = patched;
  return () => {
    target.emitWarning = emit;
  };
}

function isSqliteExperimental(
  warning: string | Error,
  rest: readonly unknown[],
): boolean {
  const message = typeof warning === 'string' ? warning : warning.message;
  return (
    message.startsWith(SQLITE_EXPERIMENTAL) &&
    warningType(rest[0]) === 'ExperimentalWarning'
  );
}

/**
 * The type, however the caller passed it: Node's own
 * `emitExperimentalWarning` uses the positional string, and the documented
 * options object is the other spelling of the same argument.
 */
function warningType(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  if (typeof arg !== 'object' || arg === null) return undefined;
  const { type } = arg as { readonly type?: unknown };
  return typeof type === 'string' ? type : undefined;
}

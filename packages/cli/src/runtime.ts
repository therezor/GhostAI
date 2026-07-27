/**
 * The CLI's view of `@ghostai/runtime`.
 *
 * There is nothing CLI-shaped left here. The composition root moved to its own
 * package the moment a second consumer needed it — the server shares one
 * `DatabaseSync` with its auth store and reconfigures without dropping the
 * session store, neither of which a terminal ever asks for — and duplicating
 * the wiring is how the Python original ended up with three implementations of
 * the same startup.
 *
 * What remains is the naming: `createChatRuntime` is what `ghost chat` calls,
 * and the extra members of `GhostRuntime` (`reconfigure`, `steering`, the
 * shared connection) are simply unused from here.
 */

import { createRuntime, type GhostRuntime, type RuntimeOptions } from '@ghostai/runtime';

export {
  PROVIDER_CREDENTIAL_NAMESPACE,
  findCredential,
  type RuntimeOptions,
} from '@ghostai/runtime';

export type ChatRuntime = GhostRuntime;

export function createChatRuntime(options: RuntimeOptions = {}): ChatRuntime {
  return createRuntime(options);
}

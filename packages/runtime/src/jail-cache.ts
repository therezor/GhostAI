/**
 * One `WorkspaceJail` per workspace, kept between turns.
 *
 * Constructing a jail is not free: it `mkdir`s the root and canonicalises it
 * through `realpath`, which is two syscalls on a path that every single tool
 * call needs. A turn that reads six files would pay for twelve of them, and a
 * server with several workspaces in use would pay again on every switch.
 *
 * Three decisions worth stating:
 *
 *  - **`forWorkspace` never consults the registry.** It maps an id to a
 *    directory through `workspaceDirFor` and nothing else. That is deliberate
 *    in both directions: a workspace that was *detached* still has sessions,
 *    and they must keep resolving to their own files rather than silently
 *    landing in someone else's — while an id that is not a legal slug throws
 *    `invalid_input` here rather than becoming a directory. Whether a workspace
 *    is one the user can still see is a question for the routes, which check
 *    the registry before they get this far.
 *
 *  - **The default is built eagerly, in the constructor.** `Runtime.#build`
 *    computes everything able to fail before it mutates anything, so that an
 *    unusable workspace leaves the runtime serving turns on the settings that
 *    worked a moment ago. A lazily-built default would move that failure to the
 *    first tool call of the next turn, which is exactly where it must not be.
 *
 *  - **Eviction is a plain delete.** Unlike `ProviderCache` there is nothing to
 *    release: a jail owns a canonical string and no handles, so dropping the
 *    reference is the whole of closing it.
 */

import {
  workspaceDirFor,
  DEFAULT_WORKSPACE_ID,
  type GhostPaths,
} from '@ghostbot/core';
import { WorkspaceJail, type JailResolver } from '@ghostbot/security';

/**
 * Beyond this many live jails the least-recently-used is dropped.
 *
 * Sized for what a person does: a handful of workspaces open across a working
 * session, and a miss costs one `mkdir` plus one `realpath`.
 */
export const MAX_CACHED_JAILS = 8;

interface JailCacheOptions {
  readonly paths: GhostPaths;
  readonly max?: number;
  /** Injected by tests, which count constructions rather than touch a disk. */
  readonly create?: (root: string) => WorkspaceJail;
}

export class JailCache implements JailResolver {
  private readonly paths: GhostPaths;
  private readonly max: number;
  private readonly create: (root: string) => WorkspaceJail;
  /** Insertion-ordered, which is what makes the first key the LRU victim. */
  private readonly jails = new Map<string, WorkspaceJail>();
  private readonly defaultJail: WorkspaceJail;

  constructor(options: JailCacheOptions) {
    this.paths = options.paths;
    this.max = options.max ?? MAX_CACHED_JAILS;
    this.create = options.create ?? ((root) => new WorkspaceJail({ root }));
    this.defaultJail = this.forWorkspace(DEFAULT_WORKSPACE_ID);
  }

  get default(): WorkspaceJail {
    return this.defaultJail;
  }

  forWorkspace(workspaceId: string): WorkspaceJail {
    const cached = this.jails.get(workspaceId);
    if (cached !== undefined) {
      // Re-insert so the working set stays at the young end of the map.
      this.jails.delete(workspaceId);
      this.jails.set(workspaceId, cached);
      return cached;
    }

    // Throws `invalid_input` for anything that is not a legal slug, which is
    // the second of the two places that check — the first being the route.
    const jail = this.create(workspaceDirFor(this.paths, workspaceId));
    this.jails.set(workspaceId, jail);

    if (this.jails.size > this.max) {
      const oldest = this.jails.keys().next();
      // Never evict the default: it is held by `#defaultJail` regardless, and
      // dropping its entry would make the next lookup rebuild a jail this
      // object already has.
      if (!oldest.done && oldest.value !== DEFAULT_WORKSPACE_ID) {
        this.jails.delete(oldest.value);
      } else if (!oldest.done) {
        const next = [...this.jails.keys()].find(
          (key) => key !== DEFAULT_WORKSPACE_ID,
        );
        if (next !== undefined) this.jails.delete(next);
      }
    }

    return jail;
  }

  /**
   * Drops one workspace's jail, for when its folder has moved out from under it.
   *
   * A jail canonicalises its root once, at construction, so an entry for a
   * folder that has since been renamed away holds a path that no longer exists.
   * Left in place it is mostly inert — nothing names the old id after a
   * relocation — but it stops being inert the moment a *new* workspace is
   * created on the freed folder name: the lookup would hand it a jail resolved
   * against the directory that used to be there.
   *
   * Never the default, whose entry is also held by `#defaultJail`; there is nothing
   * that can move it, so nothing asks.
   */
  evict(workspaceId: string): void {
    if (workspaceId === DEFAULT_WORKSPACE_ID) return;
    this.jails.delete(workspaceId);
  }

  clear(): void {
    this.jails.clear();
  }
}

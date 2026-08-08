/**
 * The workspace over HTTP: listing, upload, deletion, and signed media.
 *
 * Every path arrives as a workspace-relative string and goes through
 * `WorkspaceJail` before it reaches the filesystem — including the ones this
 * server signed itself. The jail returns the canonical path it verified and that
 * is the path used; nothing here re-derives one.
 *
 * `/api/media/:token` is the only route in the manifest whose credential is the
 * URL. The reasoning is in `signing.ts`; what belongs here is the consequence:
 * the response is served with `X-Content-Type-Options: nosniff` and a
 * `Content-Disposition` that refuses to render anything a browser would execute
 * in this origin. The workspace is a tree a language model writes to, so "the
 * agent produced an HTML file and the user opened it" is a path that needs
 * closing rather than a hypothetical.
 */

import {
  createReadStream,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { dirname } from 'node:path';

import {
  CreateDirectoryRequestSchema,
  FileEntrySchema,
  FileListResponseSchema,
  FileTextResponseSchema,
  FileWriteRequestSchema,
  MoveFileRequestSchema,
  SignedUrlRequestSchema,
  SignedUrlSchema,
  UploadResponseSchema,
  type CreateDirectoryRequest,
  type FileEntry,
  type FileListResponse,
  type FileTextResponse,
  type FileWriteRequest,
  type MoveFileRequest,
  type SignedUrl,
  type SignedUrlRequest,
  type UploadResponse,
} from '@ghostbot/protocol';
import {
  DEFAULT_WORKSPACE_ID,
  ensureDir,
  errnoOf,
  systemClock,
} from '@ghostbot/core';
import type { WorkspaceJail } from '@ghostbot/security';
import type { FastifyReply } from 'fastify';

import { mediaClaimOf } from '../auth.js';
import { badRequest, conflict, notFound } from '../errors.js';
import {
  DeleteQuerySchema,
  OptionalPathQuerySchema,
  PathQuerySchema,
  TokenParamsSchema,
  type DeleteQuery,
  type PathQuery,
} from '../queries.js';
import { MEDIA_SECRET_NAME, mediaUrl, signMediaToken } from '../signing.js';
import {
  entryAt,
  inlineSafe,
  listDirectory,
  mimeTypeFor,
  readText,
  MAX_TEXT_BYTES,
} from '../workspace.js';
import type { RouteDeps, RouteGroup } from './types.js';

type FileRouteId =
  | 'files.list'
  | 'files.delete'
  | 'files.upload'
  | 'files.read'
  | 'files.write'
  | 'files.mkdir'
  | 'files.move'
  | 'files.sign'
  | 'media.get';

/**
 * The cap on one upload.
 *
 * Applied as a per-route `bodyLimit`, so it is enforced by Fastify while the
 * body is still arriving rather than by this handler after the whole thing is
 * in memory. Raising the global limit instead would let every other route
 * buffer 25 MiB before anything looked at it.
 */
export const MAX_UPLOAD_BYTES: number = 25 * 1024 * 1024;

/**
 * The cap on one save.
 *
 * Twice the read limit rather than equal to it: the body is JSON, so every
 * quote, backslash and newline in the file costs a second byte on the wire, and
 * a limit equal to `MAX_TEXT_BYTES` would refuse to save a file the same route
 * had just agreed to open.
 */
export const MAX_TEXT_BODY_BYTES: number = MAX_TEXT_BYTES * 2;

/** `statSync`, with "does not exist" turned into the 404 it is. */
function statOr404(absolutePath: string, relativePath: string): Stats {
  try {
    return statSync(absolutePath);
  } catch {
    throw notFound(`No such file: ${relativePath}`);
  }
}

/** `statSync`, with "does not exist" as a value — the write path needs both. */
function statOrUndefined(absolutePath: string): Stats | undefined {
  try {
    return statSync(absolutePath);
  } catch {
    return undefined;
  }
}

export function fileRoutes(deps: RouteDeps): RouteGroup<FileRouteId> {
  const clock = deps.clock ?? systemClock;

  /**
   * The jail for one workspace, refusing an id that names no workspace.
   *
   * The registry lookup is what stops a crafted id from bringing a directory
   * into existence: `workspaceDirFor` would happily resolve any legal slug —
   * that is deliberate, so a *detached* workspace's sessions keep working — so
   * the boundary that decides "a user can still see this one" belongs here.
   */
  const jailFor = (workspaceId: string): WorkspaceJail => {
    if (deps.runtime.workspaces.get(workspaceId) === undefined) {
      throw notFound(`No such workspace: ${workspaceId}`);
    }
    return deps.runtime.agent().jailFor(workspaceId);
  };

  function sign(path: string, workspaceId: string): SignedUrl {
    const expiresAtMs =
      clock.now() + deps.runtime.config().server.auth.signedUrlTtlMs;
    const token = signMediaToken(deps.auth.ensureSecret(MEDIA_SECRET_NAME), {
      path,
      workspaceId,
      expiresAtMs,
    });
    return { url: mediaUrl(token), expiresAtMs };
  }

  return {
    'files.list': {
      summary: 'One workspace directory',
      schema: {
        querystring: OptionalPathQuerySchema,
        response: { 200: FileListResponseSchema },
      },
      handler: (request): FileListResponse => {
        const { path, workspace } = request.query as PathQuery;
        const jail = jailFor(workspace);
        const absolute = jail.resolve(path);
        const stats = statOr404(absolute, path);
        if (!stats.isDirectory()) throw badRequest(`Not a directory: ${path}`);

        return {
          // Echo the *relative* path the jail agreed to, not the input: `./a/`
          // and `a` are the same directory and a client keying on the response
          // should see one answer for both.
          path: jail.relative(absolute),
          entries: listDirectory(jail, absolute),
        };
      },
    },

    'files.delete': {
      summary: 'Delete one workspace file or directory',
      schema: { querystring: DeleteQuerySchema },
      handler: (request, reply): FastifyReply => {
        const { path, workspace, recursive } = request.query as DeleteQuery;
        const absolute = jailFor(workspace).resolve(path);
        const stats = statOr404(absolute, path);

        if (!stats.isDirectory()) {
          unlinkSync(absolute);
          return reply.status(204).send();
        }

        // A recursive delete is a large, irreversible action, and it must never
        // be something a request *happens* to do — a mistyped path or a script
        // looping over names would otherwise empty a tree. So the contents go
        // only when the caller said the word that means exactly that; an empty
        // directory has no contents to lose and needs no ceremony.
        const contents = readdirSync(absolute);
        if (contents.length > 0 && recursive !== true) {
          throw conflict(`Directory is not empty: ${path}`, {
            entryCount: contents.length,
          });
        }

        rmSync(absolute, { recursive: true });
        return reply.status(204).send();
      },
    },

    'files.upload': {
      summary: 'Write a file into the workspace',
      // The body is raw bytes, not JSON: a browser sends a `File` as-is and a
      // base64 envelope would inflate every upload by a third to describe what
      // `Content-Type` already says. See `app.ts` for the parser.
      schema: {
        querystring: PathQuerySchema,
        response: { 201: UploadResponseSchema },
      },
      bodyLimit: MAX_UPLOAD_BYTES,
      handler: (request, reply): UploadResponse => {
        const { path, workspace } = request.query as PathQuery;
        const jail = jailFor(workspace);
        const body = request.body;
        if (!Buffer.isBuffer(body)) {
          // A JSON content type reached the JSON parser and produced an object.
          // Saying so beats "empty", which sends the caller looking at the file.
          throw badRequest('Upload body must be the raw file bytes');
        }
        if (body.byteLength === 0) throw badRequest('Upload body is empty');

        const absolute = jail.resolve(path);
        ensureDir(dirname(absolute));
        writeFileSync(absolute, body);

        const relative = jail.relative(absolute);
        void reply.status(201);
        return {
          path: relative,
          sizeBytes: body.byteLength,
          mimeType: mimeTypeFor(relative),
          // Returned with the upload so a UI can render what it just sent
          // without a second round trip to ask permission to look at it.
          signedUrl: sign(relative, workspace),
        };
      },
    },

    'files.read': {
      summary: 'One workspace file, as text',
      schema: {
        querystring: PathQuerySchema,
        response: { 200: FileTextResponseSchema },
      },
      handler: (request): FileTextResponse => {
        const { path, workspace } = request.query as PathQuery;
        const jail = jailFor(workspace);
        const absolute = jail.resolve(path);
        const stats = statOr404(absolute, path);
        if (stats.isDirectory()) throw badRequest(`Not a file: ${path}`);

        const text = readText(absolute, stats.size);
        // Decided from the bytes, not from the extension: the MIME table is
        // deliberately small, so an extension check would refuse `.py` and
        // `.ts` — the files a person most wants to open — while accepting a
        // `.txt` that happens to hold a binary blob.
        if (text === undefined) throw badRequest(`Not a text file: ${path}`);

        return {
          path: jail.relative(absolute),
          content: text.content,
          sizeBytes: stats.size,
          modifiedAtMs: Math.floor(stats.mtimeMs),
          truncated: text.truncated,
        };
      },
    },

    'files.write': {
      summary: 'Write text to a workspace file',
      schema: {
        body: FileWriteRequestSchema,
        response: { 200: FileEntrySchema },
      },
      bodyLimit: MAX_TEXT_BODY_BYTES,
      handler: (request): FileEntry => {
        const { path, content, expectedModifiedAtMs, workspaceId } =
          request.body as FileWriteRequest;
        const jail = jailFor(workspaceId ?? DEFAULT_WORKSPACE_ID);
        const absolute = jail.resolve(path);
        const before = statOrUndefined(absolute);
        if (before?.isDirectory() === true) {
          throw badRequest(`Not a file: ${path}`);
        }

        // The workspace is a tree a language model writes to while somebody is
        // looking at it. An editor that loaded the file, sat open through a
        // turn, and then saved would silently delete whatever that turn wrote —
        // so a caller that says which version it read gets told when that is no
        // longer the version on disk. A caller that says nothing is creating a
        // file and has nothing to conflict with.
        if (expectedModifiedAtMs !== undefined) {
          if (before === undefined) {
            throw conflict(`Deleted since it was read: ${path}`);
          }
          if (Math.floor(before.mtimeMs) !== expectedModifiedAtMs) {
            throw conflict(`Changed since it was read: ${path}`, {
              modifiedAtMs: Math.floor(before.mtimeMs),
            });
          }
        }

        ensureDir(dirname(absolute));
        writeFileSync(absolute, content, 'utf8');

        // Stat again rather than computing the entry from `content`: the size
        // on disk is the byte length after UTF-8 encoding, and `modifiedAtMs`
        // is the value the next save has to match.
        return entryAt(jail, absolute, statSync(absolute));
      },
    },

    'files.mkdir': {
      summary: 'Create a workspace directory',
      schema: {
        body: CreateDirectoryRequestSchema,
        response: { 201: FileEntrySchema },
      },
      handler: (request, reply): FileEntry => {
        const { path, workspaceId } = request.body as CreateDirectoryRequest;
        const jail = jailFor(workspaceId ?? DEFAULT_WORKSPACE_ID);
        const absolute = jail.resolve(path);
        // Not idempotent, deliberately: "New folder" that quietly returns an
        // existing one is how two things end up sharing a directory nobody
        // meant to share.
        if (statOrUndefined(absolute) !== undefined) {
          throw conflict(`Already exists: ${path}`);
        }

        mkdirSync(absolute, { recursive: true });
        void reply.status(201);
        return entryAt(jail, absolute, statSync(absolute));
      },
    },

    'files.move': {
      summary: 'Rename or move a workspace entry',
      schema: {
        body: MoveFileRequestSchema,
        response: { 200: FileEntrySchema },
      },
      handler: (request): FileEntry => {
        const { from, to, workspaceId } = request.body as MoveFileRequest;
        const jail = jailFor(workspaceId ?? DEFAULT_WORKSPACE_ID);

        // Both ends through the jail, and the canonical paths it returns are the
        // ones used. A `to` that climbs out of the workspace is refused by the
        // same code that refuses a `from` that does — which is the whole reason
        // this is one resolve call per side rather than a join on the client's
        // string.
        const source = jail.resolve(from);
        const target = jail.resolve(to);

        const stats = statOr404(source, from);

        if (source === target) {
          // Not an error and not a write: renaming a thing to its own name is a
          // no-op, and `renameSync` onto itself is a silent success anyway.
          return entryAt(jail, source, stats);
        }

        // Refused rather than overwritten. `renameSync` will happily replace a
        // file, and a rename that destroys whatever was already at the target is
        // a data loss the operator did not ask for and cannot see afterwards.
        if (statOrUndefined(target) !== undefined) {
          throw conflict(`Already exists: ${to}`);
        }

        // A move into a folder that does not exist yet is a typo far more often
        // than it is an intention, and `renameSync` reports it as a bare ENOENT
        // that reads as "the file is missing" rather than "the folder is".
        const parent = dirname(target);
        if (statOrUndefined(parent) === undefined) {
          throw badRequest(`No such directory: ${jail.relative(parent)}`);
        }

        try {
          renameSync(source, target);
        } catch (error) {
          // The one case worth naming: a directory cannot be moved inside
          // itself, and the errno alone tells the operator nothing.
          if (errnoOf(error) === 'EINVAL') {
            throw badRequest(`Cannot move ${from} inside itself`);
          }
          throw error;
        }

        return entryAt(jail, target, statSync(target));
      },
    },

    'files.sign': {
      summary: 'Mint a short-lived URL an <img> can load',
      schema: {
        body: SignedUrlRequestSchema,
        response: { 200: SignedUrlSchema },
      },
      handler: (request): SignedUrl => {
        const { path, workspaceId } = request.body as SignedUrlRequest;
        const workspace = workspaceId ?? DEFAULT_WORKSPACE_ID;
        const jail = jailFor(workspace);
        const absolute = jail.resolve(path);
        // Signed after the file is known to exist: a URL that 404s later is a
        // worse answer than a 404 now, and the client is holding the path.
        statOr404(absolute, path);
        return sign(jail.relative(absolute), workspace);
      },
    },

    'media.get': {
      summary: 'Serve a workspace file to a signed URL',
      schema: { params: TokenParamsSchema },
      handler: (request, reply): FastifyReply => {
        // The signature was verified by the route's `onRequest` hook, which is
        // also the only thing that put a claim here.
        const claim = mediaClaimOf(request);
        if (claim === undefined) throw notFound('No such media');

        // Checked again even though this server signed it, and with `check`
        // rather than `contains`: `contains` compares an already-absolute path
        // without canonicalising, so it would happily serve a file that became
        // a symlink to `/etc/passwd` after the URL was minted. A signature says
        // who asked, not what the filesystem looks like now.
        // The claim's workspace, not the default: the token names one, and the
        // whole point of signing it is that this is the workspace the URL was
        // authorised against. It deliberately does *not* consult the registry —
        // a live token against a workspace detached a minute ago keeps working
        // until it expires, which is consistent with detaching keeping files.
        const absolute = resolveWithin(
          deps.runtime.agent().jailFor(claim.workspaceId),
          claim.path,
        );
        if (absolute === undefined) throw notFound('No such media');
        const stats = statOr404(absolute, claim.path);
        if (stats.isDirectory()) throw notFound('No such media');

        const inline = inlineSafe(claim.path);
        return (
          reply
            .header(
              'content-type',
              inline ? mimeTypeFor(claim.path) : 'application/octet-stream',
            )
            .header('content-length', stats.size)
            // Without this a browser may sniff a text file into HTML and run it.
            .header('x-content-type-options', 'nosniff')
            .header('content-disposition', inline ? 'inline' : 'attachment')
            // Private and short: the URL is a bearer credential, and a shared
            // cache holding the response would serve it to whoever asks next.
            .header('cache-control', 'private, max-age=60')
            .send(createReadStream(absolute))
        );
      },
    },
  };
}

/** The absolute path a claim names, or `undefined` if it is no longer inside. */
function resolveWithin(
  jail: WorkspaceJail,
  relativePath: string,
): string | undefined {
  const check = jail.check(relativePath);
  return check.ok ? check.path : undefined;
}

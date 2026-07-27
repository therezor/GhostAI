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

import { createReadStream, statSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { dirname } from 'node:path';

import {
  FileListResponseSchema,
  SignedUrlRequestSchema,
  SignedUrlSchema,
  UploadResponseSchema,
  type FileListResponse,
  type SignedUrl,
  type SignedUrlRequest,
  type UploadResponse,
} from '@ghostai/protocol';
import { ensureDir, systemClock } from '@ghostai/core';
import type { WorkspaceJail } from '@ghostai/security';
import type { FastifyReply } from 'fastify';

import { mediaClaimOf } from '../auth.js';
import { badRequest, notFound } from '../errors.js';
import {
  OptionalPathQuerySchema,
  PathQuerySchema,
  TokenParamsSchema,
  type PathQuery,
} from '../queries.js';
import { MEDIA_SECRET_NAME, mediaUrl, signMediaToken } from '../signing.js';
import { inlineSafe, listDirectory, mimeTypeFor } from '../workspace.js';
import type { RouteDeps, RouteGroup } from './types.js';

type FileRouteId = 'files.list' | 'files.delete' | 'files.upload' | 'files.sign' | 'media.get';

/**
 * The cap on one upload.
 *
 * Applied as a per-route `bodyLimit`, so it is enforced by Fastify while the
 * body is still arriving rather than by this handler after the whole thing is
 * in memory. Raising the global limit instead would let every other route
 * buffer 25 MiB before anything looked at it.
 */
export const MAX_UPLOAD_BYTES: number = 25 * 1024 * 1024;

/** `statSync`, with "does not exist" turned into the 404 it is. */
function statOr404(absolutePath: string, relativePath: string): Stats {
  try {
    return statSync(absolutePath);
  } catch {
    throw notFound(`No such file: ${relativePath}`);
  }
}

export function fileRoutes(deps: RouteDeps): RouteGroup<FileRouteId> {
  const clock = deps.clock ?? systemClock;
  const jail = (): WorkspaceJail => deps.runtime.agent().jail;

  function sign(path: string): SignedUrl {
    const expiresAtMs = clock.now() + deps.runtime.config().server.auth.signedUrlTtlMs;
    const token = signMediaToken(deps.auth.ensureSecret(MEDIA_SECRET_NAME), { path, expiresAtMs });
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
        const { path } = request.query as PathQuery;
        const absolute = jail().resolve(path);
        const stats = statOr404(absolute, path);
        if (!stats.isDirectory()) throw badRequest(`Not a directory: ${path}`);

        return {
          // Echo the *relative* path the jail agreed to, not the input: `./a/`
          // and `a` are the same directory and a client keying on the response
          // should see one answer for both.
          path: jail().relative(absolute),
          entries: listDirectory(jail(), absolute),
        };
      },
    },

    'files.delete': {
      summary: 'Delete one workspace file',
      schema: { querystring: PathQuerySchema },
      handler: (request, reply): FastifyReply => {
        const { path } = request.query as PathQuery;
        const absolute = jail().resolve(path);
        const stats = statOr404(absolute, path);
        // Files only. A recursive delete triggered by a URL is a large,
        // irreversible action behind a small mistake, and nothing in the UI
        // needs one — the tool the agent runs on the operator's instruction is
        // the path for that.
        if (stats.isDirectory()) throw badRequest(`Refusing to delete a directory: ${path}`);

        unlinkSync(absolute);
        return reply.status(204).send();
      },
    },

    'files.upload': {
      summary: 'Write a file into the workspace',
      // The body is raw bytes, not JSON: a browser sends a `File` as-is and a
      // base64 envelope would inflate every upload by a third to describe what
      // `Content-Type` already says. See `app.ts` for the parser.
      schema: { querystring: PathQuerySchema, response: { 201: UploadResponseSchema } },
      bodyLimit: MAX_UPLOAD_BYTES,
      handler: (request, reply): UploadResponse => {
        const { path } = request.query as PathQuery;
        const body = request.body;
        if (!Buffer.isBuffer(body)) {
          // A JSON content type reached the JSON parser and produced an object.
          // Saying so beats "empty", which sends the caller looking at the file.
          throw badRequest('Upload body must be the raw file bytes');
        }
        if (body.byteLength === 0) throw badRequest('Upload body is empty');

        const absolute = jail().resolve(path);
        ensureDir(dirname(absolute));
        writeFileSync(absolute, body);

        const relative = jail().relative(absolute);
        void reply.status(201);
        return {
          path: relative,
          sizeBytes: body.byteLength,
          mimeType: mimeTypeFor(relative),
          // Returned with the upload so a UI can render what it just sent
          // without a second round trip to ask permission to look at it.
          signedUrl: sign(relative),
        };
      },
    },

    'files.sign': {
      summary: 'Mint a short-lived URL an <img> can load',
      schema: { body: SignedUrlRequestSchema, response: { 200: SignedUrlSchema } },
      handler: (request): SignedUrl => {
        const { path } = request.body as SignedUrlRequest;
        const absolute = jail().resolve(path);
        // Signed after the file is known to exist: a URL that 404s later is a
        // worse answer than a 404 now, and the client is holding the path.
        statOr404(absolute, path);
        return sign(jail().relative(absolute));
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
        const absolute = resolveWithin(jail(), claim.path);
        if (absolute === undefined) throw notFound('No such media');
        const stats = statOr404(absolute, claim.path);
        if (stats.isDirectory()) throw notFound('No such media');

        const inline = inlineSafe(claim.path);
        return (
          reply
            .header('content-type', inline ? mimeTypeFor(claim.path) : 'application/octet-stream')
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
function resolveWithin(jail: WorkspaceJail, relativePath: string): string | undefined {
  const check = jail.check(relativePath);
  return check.ok ? check.path : undefined;
}

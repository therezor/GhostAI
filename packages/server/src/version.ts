/**
 * The served version, in a module of its own.
 *
 * `GET /api/status` reports it and the OpenAPI document carries it, so both the
 * app and the routes need it — and putting it in `app.ts` would make the route
 * modules import the file that imports them. Kept in step with `package.json`
 * by `app.test.ts`.
 *
 * One of exactly two constants a release edits by hand; the other is `VERSION`
 * in `packages/cli/src/program.ts`. Both are literals rather than a read of the
 * manifest for the same reason: the bundle lands in `dist/`, so a relative read
 * resolves differently in the workspace and in a published tarball, and the
 * failure mode is a version that is wrong rather than one that is missing.
 * Their tests are what turn "forgot to bump it" into a red suite.
 */
export const SERVER_VERSION = '0.7.0';

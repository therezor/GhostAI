/**
 * The served version, in a module of its own.
 *
 * `GET /api/status` reports it and the OpenAPI document carries it, so both the
 * app and the routes need it — and putting it in `app.ts` would make the route
 * modules import the file that imports them. Kept in step with `package.json`
 * by `app.test.ts`.
 */
export const SERVER_VERSION = '0.0.0';

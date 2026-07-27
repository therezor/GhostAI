import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * There is no `tailwind.config.js`: Tailwind 4 is CSS-first, and the `@theme`
 * blocks in `src/styles/tokens.css` are the configuration.
 *
 * The build is entirely self-contained by requirement, not by accident. Fonts
 * are npm packages emitted into `dist/assets`, nothing fetches from a CDN, and
 * `ghost serve` mounts this directory as static files behind the same origin as
 * the API — so the UI renders with the network otherwise blocked, which is what
 * a self-hosted air-gapped install actually needs.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // `@/` for anything outside the importing file's own directory — see
  // `tsconfig.json` for why the alias exists rather than a deeper relative path.
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: true,
    // The server sets its own cache headers; a hashed filename is what makes
    // an aggressive one safe.
    assetsInlineLimit: 4096,
  },
  server: {
    port: 5173,
    // `ghost serve` in the other terminal, on the config's default port. Only the dev server
    // proxies: the built app is served from the API's own origin.
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/ws': { target: 'ws://127.0.0.1:3000', ws: true },
    },
  },
});

/**
 * The entry point. Fonts first, then the stylesheet, then the app.
 *
 * `@fontsource-variable/*` is a package import, so Vite emits the woff2 files
 * into `dist/assets` and rewrites the `@font-face` URLs to point there. That is
 * the whole reason for self-hosting: a font CDN in a self-hosted privacy-first
 * product sends every user's IP to a third party on first paint, and an
 * air-gapped install renders in the fallback stack.
 */

import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/app.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';

const container = document.getElementById('root');
if (container === null) throw new Error('No #root in index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

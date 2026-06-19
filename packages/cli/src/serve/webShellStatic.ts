/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Application, NextFunction, Request, Response } from 'express';
import { resolveBundleDir } from '@qwen-code/qwen-code-core';

/**
 * Content-Security-Policy for the Web Shell HTML shell.
 *
 * Deliberately looser than the `/demo` page's `default-src 'none'`: the real
 * UI loads same-origin module scripts plus the inline performance.measure
 * patch baked into `index.html`, runs shiki/mermaid (eval + wasm + blob
 * workers), pulls katex fonts/images as `data:`, and streams SSE
 * (`connect-src 'self'`). `frame-ancestors 'none'` + `X-Frame-Options: DENY`
 * still block clickjacking. Tightening `script-src` (drop `'unsafe-inline'`
 * via a hash, externalise the inline patch) is a follow-up, not a blocker for
 * a loopback-default local tool.
 */
export const WEB_SHELL_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Locate the built Web Shell assets directory (the one containing
 * `index.html` + `assets/`). Returns `undefined` when the assets are not
 * present — e.g. a `--cli-only` build, or running before `npm run build`
 * produced `packages/web-shell/dist` — so the caller can degrade to
 * API-only instead of crashing.
 */
export function resolveWebShellDir(): string | undefined {
  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // esbuild bundle: this module is hoisted into dist/cli.js (or a
    // dist/chunks/*.js shared chunk). `resolveBundleDir` strips the
    // `chunks/` segment so we land on dist/, where copy_bundle_assets.js
    // drops the UI as dist/web-shell/.
    path.join(resolveBundleDir(import.meta.url), 'web-shell'),
    // Source / tsx run: packages/cli/src/serve/ -> packages/web-shell/dist.
    path.resolve(selfDir, '..', '..', '..', 'web-shell', 'dist'),
  ];
  for (const dir of candidates) {
    // Require BOTH index.html and assets/: a partial build (index.html
    // without its hashed chunks) would otherwise pass and serve a shell
    // whose every script/style 404s. copy_bundle_assets.js applies the same
    // two-part check before copying.
    if (
      existsSync(path.join(dir, 'index.html')) &&
      existsSync(path.join(dir, 'assets'))
    ) {
      return dir;
    }
  }
  return undefined;
}

/**
 * True when the request is a top-level document navigation (address-bar
 * load, link click, or refresh) rather than a programmatic fetch/XHR.
 *
 * Mirrors the `bypass` discriminator in `packages/web-shell/vite.config.ts`
 * so the daemon's SPA fallback claims exactly the requests the dev proxy
 * would have served `index.html` for — and leaves API fetches (which carry
 * `Accept: application/json`) to fall through to the JSON routes / 404.
 */
export function isDocumentNavigation(req: Request): boolean {
  const fetchMode = req.headers['sec-fetch-mode'];
  const fetchDest = req.headers['sec-fetch-dest'];
  const accept = req.headers.accept ?? '';
  return (
    fetchMode === 'navigate' ||
    fetchDest === 'document' ||
    accept.trim().toLowerCase().startsWith('text/html')
  );
}

/**
 * Mount the Web Shell single-page app on the daemon.
 *
 * Three layers, all registered BEFORE `bearerAuth` (the static shell carries
 * no secrets and a browser cannot attach an `Authorization` header to a
 * `<script src>` subresource or an address-bar navigation, so gating it would
 * just break the UI; the front-end's own API calls still carry the bearer via
 * `getDaemonAuthHeaders()`):
 *
 *  1. `GET /assets/*` — hashed, immutable build chunks (long-cache).
 *  2. `GET /` — the HTML shell, always (so `curl /` shows the UI too).
 *  3. SPA fallback — for deep-link navigations like `/session/<id>`; only
 *     claims document navigations, everything else falls through unchanged so
 *     the existing JSON 404 / API behaviour is preserved.
 *
 * Caller must have already verified `webShellDir` exists.
 */
export function registerWebShell(app: Application, webShellDir: string): void {
  const indexPath = path.join(webShellDir, 'index.html');
  const assetsDir = path.join(webShellDir, 'assets');

  const sendIndex = (res: Response): void => {
    res
      .status(200)
      .set('Content-Security-Policy', WEB_SHELL_CSP)
      .set('X-Frame-Options', 'DENY')
      .set('Referrer-Policy', 'no-referrer')
      // The shell must never be cached stale: a redeploy changes the hashed
      // asset names it references, so a cached index.html would point at
      // chunks that no longer exist. Asset files themselves are immutable.
      .set('Cache-Control', 'no-cache');
    res.sendFile(indexPath, { cacheControl: false }, (err) => {
      if (err && !res.headersSent) {
        res.status(500).type('text/plain').send('Failed to load Web Shell');
      }
    });
  };

  // Layer 1: hashed asset chunks. `fallthrough: true` (default) lets an
  // unknown /assets/* path continue to the SPA fallback / 404 instead of
  // ending the chain here.
  app.use(
    '/assets',
    express.static(assetsDir, {
      index: false,
      immutable: true,
      maxAge: '1y',
    }),
  );

  // Layer 2: the shell at the site root.
  app.get('/', (_req: Request, res: Response) => sendIndex(res));

  // Layer 3: SPA deep-link fallback. GET/HEAD document navigations only;
  // anything else (API fetches, non-GET) falls through untouched.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (!isDocumentNavigation(req)) return next();
    // Don't shadow the daemon's own browser-reachable endpoints. On
    // non-loopback binds /health and /demo are registered AFTER bearerAuth
    // (i.e. after this pre-auth fallback), so without this guard a browser
    // navigation to them would receive index.html instead of their real
    // response. API routes send Accept: application/json and already fail
    // isDocumentNavigation, so they need no listing here.
    if (req.path === '/health' || req.path === '/demo') return next();
    sendIndex(res);
  });
}

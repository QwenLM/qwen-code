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
import { writeStderrLine } from '../utils/stdioHelpers.js';
import { isServeDebugMode } from './debug-mode.js';

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
  // base-uri does NOT fall back to default-src; lock it so an injected <base>
  // (the SPA renders AI-generated markdown) cannot repoint relative URLs to an
  // attacker origin.
  "base-uri 'none'",
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
  // Require BOTH index.html and assets/: a partial build (index.html without
  // its hashed chunks) would otherwise pass and serve a shell whose every
  // script/style 404s. copy_bundle_assets.js applies the same two-part check.
  const hasShell = (dir: string): boolean =>
    existsSync(path.join(dir, 'index.html')) &&
    existsSync(path.join(dir, 'assets'));

  // esbuild bundle: this module is hoisted into dist/cli.js (or a
  // dist/chunks/*.js shared chunk). `resolveBundleDir` strips the `chunks/`
  // segment so we land on dist/, where copy_bundle_assets.js drops the UI as
  // dist/web-shell/.
  const bundled = path.join(resolveBundleDir(import.meta.url), 'web-shell');
  if (hasShell(bundled)) return bundled;

  // Non-bundled runs sit at different depths under the repo: tsx on source
  // (packages/cli/src/serve/), per-package `tsc` output
  // (packages/cli/dist/src/serve/), and the integration daemon harness
  // (packages/cli/dist/index.js). Walk up from this module to find a sibling
  // packages/web-shell/dist instead of hard-coding one `..` depth — which
  // only matched the tsx case and left the transpiled layouts serving no UI.
  let dir = selfDir;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'packages', 'web-shell', 'dist');
    if (hasShell(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
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
 * Build the `index.html` responder for a Web Shell dir. Sets the security
 * headers + a no-cache policy (a redeploy changes the hashed asset names
 * index.html references, so a stale shell would point at missing chunks; the
 * asset files themselves are immutable).
 */
function createSendIndex(webShellDir: string): (res: Response) => void {
  const indexPath = path.join(webShellDir, 'index.html');
  return (res: Response): void => {
    res
      .status(200)
      .set('Content-Security-Policy', WEB_SHELL_CSP)
      .set('X-Frame-Options', 'DENY')
      .set('X-Content-Type-Options', 'nosniff')
      .set('Referrer-Policy', 'no-referrer')
      .set(
        'Permissions-Policy',
        'camera=(), microphone=(), geolocation=(), payment=()',
      )
      .set('Cache-Control', 'no-cache');
    // `dotfiles: 'allow'` is required because the resolved path may pass
    // through a dotfile directory (e.g. ~/.nvm/.../web-shell/index.html).
    // The `send` library defaults to 'ignore' which returns a 404 for any
    // path containing a segment starting with '.', breaking users who
    // installed qwen via nvm.
    res.sendFile(
      indexPath,
      { cacheControl: false, dotfiles: 'allow' },
      (err) => {
        if (!err) return;
        // Only 5xx path in the serve app that would otherwise emit nothing —
        // log it like the sibling /demo handler so an operator can see why the
        // shell stopped loading (EACCES/ESTALE on a network mount, a perms
        // change, a partial deploy).
        writeStderrLine(
          `qwen serve: Web Shell index send failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (!res.headersSent) {
          res.status(500).type('text/plain').send('Failed to load Web Shell');
        } else {
          // Failed mid-stream (truncated/corrupt index.html): end the
          // half-written response instead of leaving the client on a 200 with a
          // partial body.
          res.end();
        }
      },
    );
  };
}

/**
 * Mount the Web Shell static assets BEFORE `bearerAuth`. The shell carries no
 * secrets and a browser cannot attach an `Authorization` header to a
 * `<script src>` subresource or an address-bar navigation, so gating these
 * would just break the UI. The front-end's own API calls still carry the
 * bearer via `getDaemonAuthHeaders()`.
 *
 *  - `GET /assets/*` — hashed, immutable build chunks (long-cache).
 *  - `GET /` — the HTML shell, always (so `curl /` shows the UI too).
 *
 * Caller must have already verified `webShellDir` exists.
 */
export function mountWebShellAssets(
  app: Application,
  webShellDir: string,
): void {
  const sendIndex = createSendIndex(webShellDir);
  app.use(
    '/assets',
    express.static(path.join(webShellDir, 'assets'), {
      index: false,
      immutable: true,
      maxAge: '1y',
    }),
  );
  // A request still under /assets here is a missing chunk (e.g. a stale hashed
  // name after a redeploy) — return a clean 404 rather than letting it reach
  // the SPA fallback, which would answer a browser nav to /assets/<anything>
  // with a 200 index.html. (express.static's own `fallthrough: false` can't be
  // used: it forwards a 404 error to the catch-all error handler, which turns
  // it into a 500.)
  app.use('/assets', (req: Request, res: Response) => {
    // Quiet by default (a redeploy can briefly 404 many stale chunks); surface
    // it under serve debug mode so a white-screen shell has a diagnostic trail.
    if (isServeDebugMode()) {
      writeStderrLine(
        `qwen serve: Web Shell asset not found: ${req.originalUrl}`,
      );
    }
    res.status(404).type('text/plain').send('Not found');
  });
  app.get('/', (_req: Request, res: Response) => sendIndex(res));
}

/**
 * Mount the SPA deep-link fallback (for navigations like `/session/<id>`).
 * Registered AFTER all API routes — just before the error handler — so real
 * routes, INCLUDING their `bearerAuth` 401s, always win and only genuine 404
 * misses fall through to the shell.
 *
 * This is what keeps a token-gated daemon honest: a navigation with an
 * attacker-controlled `Accept: text/html` to an authed route (e.g.
 * `/capabilities`, `/health` on a non-loopback bind) hits that route's real
 * response / 401, not this shell. Because real routes run first, no per-path
 * denylist is needed.
 *
 * Only GET/HEAD document navigations are claimed; API fetches send
 * `Accept: application/json`, fail `isDocumentNavigation`, and fall through to
 * the standard JSON 404.
 */
export function mountWebShellSpaFallback(
  app: Application,
  webShellDir: string,
): void {
  const sendIndex = createSendIndex(webShellDir);
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (!isDocumentNavigation(req)) return next();
    // Debug-only: lets an operator see deep-link navigations falling through to
    // the shell vs. hitting real routes (routing-misconfig / proxy diagnosis).
    if (isServeDebugMode()) {
      writeStderrLine(
        `qwen serve: Web Shell SPA fallback served for ${req.method} ${req.originalUrl}`,
      );
    }
    sendIndex(res);
  });
}

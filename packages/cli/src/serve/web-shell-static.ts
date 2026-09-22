/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import express from 'express';
import type { Application, NextFunction, Request, Response } from 'express';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import { isServeDebugMode } from './debug-mode.js';
import {
  isDocumentNavigation,
  WEB_SHELL_PWA_ASSETS,
  WEB_SHELL_PAGE_PATHS,
} from './web-shell-preauth.js';
export { resolveWebShellDir } from './web-shell-resolver.js';

/**
 * Content-Security-Policy for the Web Shell HTML shell.
 *
 * Deliberately looser than a `default-src 'none'` static page: the real
 * UI loads same-origin module scripts plus the inline performance.measure
 * patch baked into `index.html`, runs shiki/mermaid (eval + wasm + blob
 * workers), pulls katex fonts/images as `data:`, and streams SSE
 * (`connect-src 'self'` plus the validated `?daemon=` origin from
 * `remoteDaemonConnectOrigins`; the client asks before connecting to an origin
 * it has not used). `frame-ancestors 'none'` + `X-Frame-Options: DENY`
 * still block clickjacking. Tightening `script-src` (drop `'unsafe-inline'`
 * via a hash, externalise the inline patch) is a follow-up, not a blocker for
 * a loopback-default local tool.
 */
const WEB_SHELL_CSP_DIRECTIVES = [
  "default-src 'self'",
  // Export previews embed SRI-verified assets as data URLs; child frames stay offline.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data:",
  "style-src 'self' 'unsafe-inline' data:",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "media-src 'self' data:",
  "worker-src 'self' blob:",
  // base-uri does NOT fall back to default-src; lock it so an injected <base>
  // (the SPA renders AI-generated markdown) cannot repoint relative URLs to an
  // attacker origin.
  "base-uri 'none'",
];

export function buildWebShellPermissionsPolicy(): string {
  return [
    'camera=()',
    'microphone=(self)',
    'geolocation=()',
    'payment=()',
    'clipboard-write=(self)',
  ].join(', ');
}

/**
 * Build the Web Shell CSP. `frame-ancestors` defaults to `'none'` (the caller
 * also sets `X-Frame-Options: DENY`) to block clickjacking. When the daemon is
 * started with `--allow-origin chrome-extension://<id>`, those extension
 * origins are allowed to frame the shell so the extension can host the UI in a
 * Chrome side panel (issue #5626); X-Frame-Options is dropped in that case
 * since it can't express an allowlist.
 */
export function buildWebShellCsp(
  frameAncestors: readonly string[] = [],
  connectOrigins: readonly string[] = [],
): string {
  const fa = frameAncestors.length
    ? `frame-ancestors ${frameAncestors.join(' ')}`
    : "frame-ancestors 'none'";
  // PDF attachments use blob URLs; live previews pin their own child source.
  const frameSrc = 'frame-src http: https: blob:';
  const connectSrc = [
    "connect-src 'self'",
    ...connectOrigins,
    'https://unpkg.com/@qwen-code/',
  ].join(' ');
  return [...WEB_SHELL_CSP_DIRECTIVES, connectSrc, frameSrc, fa].join('; ');
}

/**
 * The `?daemon=` value read with the client's parser instead of `req.query`.
 *
 * Hardening against a configuration dependency, not a fix for a live defect.
 * Express 5 defaults `query parser` to `'simple'` (Node's `querystring`) and
 * nothing in this repo ever sets it, so `req.query['daemon']` never saw the
 * bracket folding `qs` produces and the previous read agreed with the client on
 * every shape a browser can send. Under `'extended'` it did not: `qs` folds
 * `?daemon[]=x` into `{ daemon: ['x'] }`, a key the client's
 * `URLSearchParams.get('daemon')` never reports, so taking `raw[0]` granted
 * `connect-src` for an origin the client never parsed — and for
 * `?daemon[]=A&daemon=B` it granted A while the client connected to B, leaving
 * the client's own target CSP-blocked. Measured over 38 query strings against
 * real sockets: 18 divergences under `extended`, 0 under `simple`, 0 after this
 * change under either. Reading the raw query with the client's own parser drops
 * the dependency on that setting altogether.
 */
export function requestedDaemonParam(originalUrl: string): string | null {
  const queryStart = originalUrl.indexOf('?');
  return new URLSearchParams(
    queryStart === -1 ? '' : originalUrl.slice(queryStart + 1),
  ).get('daemon');
}

export function remoteDaemonConnectOrigins(value: string | null): string[] {
  if (!value) return [];
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      !/^[a-z0-9._\-[\]:]+$/iu.test(url.hostname)
    ) {
      return [];
    }
    // A bracketed IPv6 host is not a valid CSP host-source (CSP3 host-part
    // excludes '[', ']' and ':'), so emitting it produces a directive the
    // browser drops. The client gate rejects a remote bracketed target for
    // the same reason; when the page itself is served from that origin,
    // 'self' already covers the connection.
    if (url.hostname.startsWith('[')) return [];
    const websocket = new URL(url.origin);
    websocket.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return [url.origin, websocket.origin];
  } catch {
    return [];
  }
}

/** Default (no-framing) Web Shell CSP. */
export const WEB_SHELL_CSP = buildWebShellCsp();

// The pre-auth discriminators live in the dependency-light
// `web-shell-preauth.ts` so the serve fast-path static closure
// (`server/self-origin.ts`) can use them without eagerly loading this
// module's express-static/CSP machinery. Re-exported here because this
// module remains their canonical import for the runtime app.
export {
  isDocumentNavigation,
  isPreAuthWebShellRequest,
} from './web-shell-preauth.js';

/**
 * Build the `index.html` responder for a Web Shell dir. Sets the security
 * headers + a no-cache policy (a redeploy changes the hashed asset names
 * index.html references, so a stale shell would point at missing chunks; the
 * asset files themselves are immutable).
 */
function createSendIndex(
  webShellDir: string,
  frameAncestors: readonly string[] = [],
): (req: Request, res: Response) => void {
  const indexPath = path.join(webShellDir, 'index.html');
  return (req: Request, res: Response): void => {
    const csp = buildWebShellCsp(
      frameAncestors,
      remoteDaemonConnectOrigins(requestedDaemonParam(req.originalUrl)),
    );
    res
      .status(200)
      .set('Content-Security-Policy', csp)
      .set('X-Content-Type-Options', 'nosniff')
      .set('Referrer-Policy', 'no-referrer')
      .set(
        // `microphone=(self)` lets the same-origin Web Shell document request
        // the mic for voice dictation (the prompt won't even appear under an
        // empty `microphone=()` allowlist). Camera/geolocation stay disabled:
        // the MCP App inner iframe is opaque-origin, so those grants cannot
        // work there, and this header also blocks delegating them to the
        // cross-origin sandbox.
        'Permissions-Policy',
        buildWebShellPermissionsPolicy(),
      )
      .set('Cache-Control', 'no-cache');
    // X-Frame-Options can't express an allowlist, so only send the hard DENY
    // when no extension is permitted to frame the shell; otherwise CSP
    // frame-ancestors (set above) governs framing.
    if (frameAncestors.length === 0) {
      res.set('X-Frame-Options', 'DENY');
    }
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
        // Log filesystem failures so an operator can see why the shell stopped
        // loading (EACCES/ESTALE on a network mount, a permissions change, or
        // a partial deploy).
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
 *  - `GET /session/:id` document navigations — the HTML shell, so a browser
 *    refresh can load before the front-end adds its bearer header.
 *  - `GET /manifest.webmanifest` and `GET /sw.js` — public PWA metadata and
 *    the origin-scoped worker, revalidated on every request.
 *
 * `GET /mcp-app-sandbox` is a separate pre-auth route mounted by
 * `mountMcpAppSandbox` (the iframe proxy, not the shell HTML).
 *
 * `isPreAuthWebShellRequest` encodes this same surface for the
 * deferred-runtime gate; keep the two in sync.
 *
 * Caller must have already verified `webShellDir` exists.
 */
export function mountWebShellAssets(
  app: Application,
  webShellDir: string,
  frameAncestors: readonly string[] = [],
): void {
  const sendIndex = createSendIndex(webShellDir, frameAncestors);
  app.use(
    '/assets',
    express.static(path.join(webShellDir, 'assets'), {
      index: false,
      maxAge: 0,
      setHeaders(res, filePath) {
        const fileName = path.basename(filePath);
        // Vite content hashes are the only safe basis for immutable caching.
        // Future unhashed assets therefore revalidate by default instead of
        // silently inheriting a one-year lifetime.
        const contentAddressed = /-[a-zA-Z0-9_-]{8,}\.[^.]+$/u.test(fileName);
        res.setHeader(
          'Cache-Control',
          contentAddressed ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
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
  app.get('/', (req: Request, res: Response) => sendIndex(req, res));
  app.get(
    [...WEB_SHELL_PAGE_PATHS, '/session/:id'],
    (req: Request, res: Response, next: NextFunction) => {
      if (!isDocumentNavigation(req)) return next();
      sendIndex(req, res);
    },
  );
  // Process-global public PWA files carry no daemon credentials or workspace data.
  for (const {
    route,
    contentType,
    serviceWorkerAllowed,
  } of WEB_SHELL_PWA_ASSETS) {
    app.get(route, (_req: Request, res: Response) => {
      res
        .set('Content-Type', contentType)
        .set('Cache-Control', 'no-cache')
        .set('X-Content-Type-Options', 'nosniff');
      if (serviceWorkerAllowed) res.set('Service-Worker-Allowed', '/');
      res.sendFile(
        path.join(webShellDir, route.slice(1)),
        { cacheControl: false, dotfiles: 'allow' },
        (err) => {
          if (!err) return;
          if (res.headersSent) {
            res.end();
            return;
          }
          const status = 'status' in err && err.status === 404 ? 404 : 500;
          if (status === 500) {
            writeStderrLine(
              `qwen serve: Web Shell asset send failed (${route}): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          res
            .status(status)
            .type('text/plain')
            .send(
              status === 404 ? 'Not found' : 'Failed to load Web Shell asset',
            );
        },
      );
    });
  }
}

/**
 * Mount the SPA deep-link fallback for routes not explicitly mounted above.
 * Registered AFTER all API routes — just before the error handler — so real
 * routes, INCLUDING their `bearerAuth` 401s, always win and only genuine 404
 * misses fall through to the shell.
 *
 * This is what keeps a token-gated daemon honest: a navigation with an
 * attacker-controlled `Accept: text/html` to an authed route (e.g.
 * `/capabilities`, `/health` on a non-loopback bind) hits that route's real
 * response / 401, not this shell. Because real routes run first, no per-path
 * denylist is needed. The exceptions are exact page and `/session/:id` document
 * navigations, which `mountWebShellAssets` claims BEFORE auth so a browser
 * refresh can load the shell. That stays safe because the route matches a
 * exact page or single session path segment, serves only document navigations,
 * and never claims JSON API fetches (including `/goals`). API subpaths like
 * `/session/:id/status` still hit `bearerAuth`.
 *
 * Only GET/HEAD document navigations are claimed; API fetches send
 * `Accept: application/json`, fail `isDocumentNavigation`, and fall through to
 * the standard JSON 404.
 */
export function mountWebShellSpaFallback(
  app: Application,
  webShellDir: string,
  frameAncestors: readonly string[] = [],
): void {
  const sendIndex = createSendIndex(webShellDir, frameAncestors);
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
    sendIndex(req, res);
  });
}

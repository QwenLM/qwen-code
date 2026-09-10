/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Request } from 'express';

/**
 * Dependency-light home of the pre-auth Web Shell request discriminators.
 *
 * `web-shell-static.ts` owns the express static mounting and CSP machinery;
 * these predicates are also needed by the serve fast-path static closure
 * (`server/self-origin.ts`), which must not eagerly load that machinery —
 * see the import-boundary guards in `fast-path.test.ts`. This module is
 * re-exported from `web-shell-static.ts`, which remains the canonical
 * import for the runtime app.
 */

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
 * Exact session deep-link document navigations: `/session/<id>` with an
 * optional trailing slash and no further segments. Expressed as a regex (not
 * an Express route) so callers outside the runtime app — the deferred-runtime
 * gate in `run-qwen-serve.ts` — can apply the same discriminator.
 */
const SESSION_DEEP_LINK_PATH = /^\/session\/[^/]+\/?$/u;

/**
 * True when the request matches a route `mountWebShellAssets` registers
 * BEFORE `bearerAuth`. The deferred-runtime gate in `createDelegatingServeApp`
 * exempts exactly these so a cold daemon answers the shell's entry points the
 * same way the warm runtime app does, instead of 401ing browser navigations
 * that cannot attach the bearer header. Percent-encoded single-segment deep
 * links (e.g. `/session/<id>%2fstatus`) also match — Express does not decode
 * `%2F` during route matching — but they cannot reach an API route or session
 * data: pre-auth answers serve only the public shell HTML or the MCP App
 * sandbox proxy, identical to `GET /` (or the startup-failure envelope).
 * Keep in sync with the routes registered in `mountWebShellAssets` and
 * `mountMcpAppSandbox`.
 */
export function isPreAuthWebShellRequest(req: Request): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  // Express route matching is case-insensitive by default, so the warm app
  // serves /Session/<id> and /Assets/* pre-auth too; mirror that exactly.
  const reqPath = req.path.toLowerCase();
  if (
    reqPath === '/' ||
    // Express non-strict routing compiles `/` to `/^(?:\/)(?:\/$)?$/i`, so
    // a raw `//` also matches `app.get('/')` pre-auth (but `///` does not).
    reqPath === '//' ||
    reqPath === '/assets' ||
    reqPath.startsWith('/assets/') ||
    reqPath === '/mcp-app-sandbox'
  )
    return true;
  return SESSION_DEEP_LINK_PATH.test(reqPath) && isDocumentNavigation(req);
}

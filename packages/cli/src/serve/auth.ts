/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { isLoopbackBind } from './loopbackBinds.js';

/**
 * Reject any request that carries an `Origin` header. CLI/SDK clients never
 * set Origin; only browsers do. Returning a deterministic 403 JSON keeps
 * the daemon from CSRF-ing itself (and is more useful to clients than the
 * 500 HTML default that the `cors` package's error-callback path produces
 * when no Express error middleware is registered).
 */
export const denyBrowserOriginCors: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (req.headers.origin) {
    res.status(403).json({ error: 'Request denied by CORS policy' });
    return;
  }
  next();
};

/**
 * Reject requests whose Host header isn't one of the bound interfaces.
 * Defense against DNS rebinding when the daemon is on loopback.
 *
 * `bind` is the hostname the listener was started with. `getPort` is read
 * lazily on each request because callers commonly request port 0 (ephemeral)
 * and only learn the actual port once `listen()` has resolved.
 */
export function hostAllowlist(
  bind: string,
  getPort: () => number,
): RequestHandler {
  if (!isLoopbackBind(bind)) {
    // For non-loopback binds the operator chose the surface area; trust the
    // bearer token gate to cover Host header spoofing.
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }
  // Cache the allowed-Host Set per port. `getPort()` is invoked
  // lazily because tests bind to ephemeral port 0 — the actual port
  // is only known after `listen()` resolves and tests can call
  // through with a placeholder port that flips later. SSE
  // heartbeats and high-frequency probes go through this middleware,
  // so allocating a fresh Set + 4 interpolated strings per request
  // is wasted work. Rebuild only when the port changes.
  let cachedPort = -1;
  let cachedAllowed: Set<string> = new Set();
  const allowedFor = (port: number): Set<string> => {
    if (port === cachedPort) return cachedAllowed;
    cachedPort = port;
    cachedAllowed = new Set([
      `localhost:${port}`,
      `127.0.0.1:${port}`,
      `[::1]:${port}`,
      `host.docker.internal:${port}`,
    ]);
    // RFC 7230 §5.4: clients may omit the port suffix when it matches
    // the URI scheme's default. http → 80, https → 443. The qwen
    // serve daemon is plain HTTP, so accept the no-port forms when
    // we're listening on port 80 (uncommon but valid for an operator
    // who points at a privileged port for clean URLs).
    if (port === 80) {
      cachedAllowed.add('localhost');
      cachedAllowed.add('127.0.0.1');
      cachedAllowed.add('[::1]');
      cachedAllowed.add('host.docker.internal');
    }
    return cachedAllowed;
  };
  return (req: Request, res: Response, next: NextFunction) => {
    const port = getPort();
    // Per RFC 7230 §5.4, Host is case-insensitive. Express normalizes
    // header *names* to lowercase but NOT values, so a Docker-proxy
    // that capitalizes the hostname (`Host: Localhost:4170`) or a
    // platform with case-preserving DNS (`HOST.docker.internal`) would
    // get 403 with an exact-string compare. Lowercase both sides.
    const host = (req.headers.host || '').toLowerCase();
    if (!allowedFor(port).has(host)) {
      res.status(403).json({ error: 'Invalid Host header' });
      return;
    }
    next();
  };
}

/**
 * Bearer token middleware. When `token` is undefined the gate is open — used
 * for the loopback-only developer default. `runQwenServe` enforces that any
 * non-loopback bind has a token, and that `--require-auth` boots only with a
 * token configured, so this no-token branch is reachable only on loopback
 * developer setups that opted out of `--require-auth`.
 */
export function bearerAuth(token: string | undefined): RequestHandler {
  if (!token) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }
  // Pre-hash the configured token once. Per-request we hash the candidate and
  // constant-time compare; this avoids leaking byte positions through string
  // inequality short-circuiting.
  const expected = createHash('sha256').update(token, 'utf8').digest();
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    // Per RFC 7235 §2.1 / RFC 7230 §3.2.6 the auth scheme token is
    // case-insensitive — `Bearer` / `bearer` / `BEARER` are all valid.
    // Lowercase the scheme before comparing; the token value itself
    // stays case-sensitive (it's user-defined opaque material).
    //
    // Hand-rolled split rather than a regex like `^(\S+)\s+(.+)$`
    // because CodeQL flags the latter as a polynomial-regex risk on
    // user-controlled input (the `\s+` / `.+` overlap can backtrack
    // on adversarial whitespace-heavy headers). Two indexOf calls
    // are O(n) total with no backtracking.
    const schemeEnd = header.indexOf(' ');
    if (schemeEnd <= 0) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const scheme = header.slice(0, schemeEnd).toLowerCase();
    if (scheme !== 'bearer') {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    // After the initial SP separator (the scheme→credentials boundary
    // matches RFC 9110 §11.6.2's `1*SP`), skip any extra BWS before
    // the credentials. RFC 7230 §3.2.6 BWS allows both SP (0x20)
    // and HTAB (0x09); accept both so a client emitting
    // `Authorization: Bearer \t<token>` (SP then HTAB) doesn't 401.
    // Pure-HTAB-as-separator (`Bearer\t<token>`) is still rejected
    // because the scheme parse uses `indexOf(' ')` — that's
    // intentional per RFC 9110, not an oversight.
    let credStart = schemeEnd + 1;
    while (
      credStart < header.length &&
      (header.charCodeAt(credStart) === 0x20 ||
        header.charCodeAt(credStart) === 0x09)
    ) {
      credStart++;
    }
    const credentials = header.slice(credStart);
    if (credentials.length === 0) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const candidate = createHash('sha256').update(credentials, 'utf8').digest();
    if (!timingSafeEqual(candidate, expected)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };
}

/**
 * Per-route mutation gate (issue #4175 PR 15).
 *
 * Wave 4 (PR 16-21) will add broadly state-changing routes — memory
 * CRUD, agent CRUD, tool enable/disable, MCP restart, file write/edit,
 * device-flow auth, etc. The roadmap calls for "a single mutation-gating
 * helper rather than open-code auth checks per route" so all those
 * routes share one choke point. This factory is that choke point;
 * Wave 1-2 routes apply it as a centralization marker (no behavior
 * change today), and Wave 4 routes opt into `strict: true` to enforce
 * "token required even on loopback" without depending on the operator
 * also passing `--require-auth`.
 *
 * Behavior matrix:
 *
 * | daemon config              | route opts        | result          |
 * | -------------------------- | ----------------- | --------------- |
 * | requireAuth=true           | any               | passthrough (1) |
 * | token configured           | any               | passthrough (2) |
 * | no token (loopback dev)    | strict=false      | passthrough     |
 * | no token (loopback dev)    | strict=true       | 401 + code      |
 *
 * (1) `--require-auth` boots only with a token, so the global
 *     `bearerAuth` middleware already 401'd unauthenticated requests
 *     before they reached this gate.
 * (2) Any token configuration makes the global `bearerAuth` enforce
 *     bearer-required-everywhere; the gate is redundant but harmless.
 *
 * The 401 body uses `code: 'token_required'` (distinct from
 * `bearerAuth`'s plain `Unauthorized` shape) so SDK clients can branch
 * on it: surface a "this route needs the daemon to be configured with
 * a token; restart with --require-auth or --token" hint rather than a
 * generic auth failure. Pre-flight via `/capabilities.features.require_auth`
 * still requires a successful unauthenticated `/capabilities` call,
 * which is only possible when the daemon has not enforced auth — so
 * the gate's own 401 is the discovery surface for routes that opt in
 * to strict mode on otherwise-open daemons.
 */
export interface MutationGateOptions {
  /**
   * When true, this route refuses to serve unauthenticated callers
   * even on loopback no-token defaults. Used by Wave 4 mutation routes
   * (memory, file edit, tool enable, MCP restart, device-flow auth)
   * that should never be reachable without explicit operator opt-in.
   * Defaults to false so Wave 1-2 routes that already exist can adopt
   * the helper without behavior change.
   */
  strict?: boolean;
}

export interface CreateMutationGateDeps {
  /** Was the daemon configured with a bearer token? */
  tokenConfigured: boolean;
  /** Was `--require-auth` passed at boot? */
  requireAuth: boolean;
}

/**
 * Build a route-scoped mutation gate factory. Returns a function that
 * — given `MutationGateOptions` — yields an Express `RequestHandler`.
 *
 * Callers cache the factory at app construction time and invoke it per
 * route, e.g.:
 *
 *   const mutate = createMutationGate({ tokenConfigured, requireAuth });
 *   app.post('/workspace/memory', mutate({ strict: true }), handler);
 *   app.post('/session', mutate(), handler);
 *
 * The factory is hot-path-friendly: the strict-passthrough decision is
 * made once at construction and the returned handler is a cheap closure.
 */
export function createMutationGate(
  deps: CreateMutationGateDeps,
): (opts?: MutationGateOptions) => RequestHandler {
  // When the global gate is already enforcing bearer auth (token set
  // via --token / env, OR --require-auth boot-checked a token), every
  // request that reaches the route handler has already passed
  // `bearerAuth`. The mutation gate becomes a passthrough — return a
  // pre-built no-op so we don't allocate one closure per route call.
  const passthrough: RequestHandler = (
    _req: Request,
    _res: Response,
    next: NextFunction,
  ) => next();
  if (deps.requireAuth || deps.tokenConfigured) {
    return () => passthrough;
  }
  // No token configured (loopback developer default). Non-strict
  // routes preserve the legacy "open on loopback" behavior; strict
  // routes refuse with a structured 401 the SDK can surface.
  //
  // Body-parser ordering (PR #4236 review #3254485915): the strict 401
  // fires AFTER `express.json()` because the gate is per-route
  // middleware, not app-level. On no-token loopback defaults a strict
  // route therefore parses the request body before refusing it —
  // bounded by `express.json({limit: '10mb'})` × `--max-connections`
  // (256 default). Loopback-only attack surface, so the worst case is
  // ~2.5 GB transient on a fully-saturated listener. The strict routes
  // Wave 4 actually adds (memory writes / file edits / device-flow
  // auth) carry small bodies in legitimate use, so the parsing-cost
  // amplification isn't a production hot path. If a future strict
  // route accepts large bodies, lift its gate to app-level (maintain a
  // strict-path Set in `createServeApp` and check it before
  // `express.json()`); tracked as a Wave 4 follow-up rather than
  // re-architecting the helper here.
  //
  // Allocation symmetry (PR #4236 review #3254467193): cache the strict
  // denier alongside `passthrough` so a route table with N strict
  // routes doesn't allocate N identical closures. The auth.test.ts
  // identity assertion anchors this — a future change that loses the
  // cache is visible.
  const strictDenier: RequestHandler = (_req: Request, res: Response) => {
    // Only list remediations that work standalone. `--require-auth` is
    // paired-required-with-a-token at boot (`runQwenServe.ts` refuses
    // to start with the flag set but no token), so naming it as a
    // third standalone option here would loop the operator into a
    // different boot error. Configuring a token via `QWEN_SERVER_TOKEN`
    // or `--token` IS the fix; the operator can decide separately
    // whether to also harden loopback with `--require-auth`.
    res.status(401).json({
      error:
        'This route requires the daemon to be configured with a bearer ' +
        'token. Set QWEN_SERVER_TOKEN or pass --token to enable bearer ' +
        'auth.',
      code: 'token_required',
    });
  };
  return (opts: MutationGateOptions = {}): RequestHandler =>
    opts.strict ? strictDenier : passthrough;
}

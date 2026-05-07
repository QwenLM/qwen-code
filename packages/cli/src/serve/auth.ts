/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import cors from 'cors';
import { isLoopbackBind } from './loopbackBinds.js';

class CORSError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CORSError';
  }
}

/**
 * Mirrors the no-browser-origin policy from
 * `packages/vscode-ide-companion/src/ide-server.ts:157-170` — CLI/SDK clients
 * never send an Origin header; browsers always do. Rejecting any Origin keeps
 * a malicious page from CSRF-ing the local daemon.
 */
export const denyBrowserOriginCors = cors({
  origin: (origin, callback) => {
    if (!origin) {
      return callback(null, true);
    }
    return callback(new CORSError('Request denied by CORS policy.'), false);
  },
});

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
  return (req: Request, res: Response, next: NextFunction) => {
    const port = getPort();
    const host = req.headers.host || '';
    if (
      host !== `localhost:${port}` &&
      host !== `127.0.0.1:${port}` &&
      host !== `[::1]:${port}` &&
      host !== `host.docker.internal:${port}`
    ) {
      res.status(403).json({ error: 'Invalid Host header' });
      return;
    }
    next();
  };
}

/**
 * Bearer token middleware. When `token` is undefined the gate is open — used
 * for the loopback-only developer default. `runQwenServe` enforces that any
 * non-loopback bind has a token.
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
    const parts = header.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const candidate = createHash('sha256').update(parts[1], 'utf8').digest();
    if (!timingSafeEqual(candidate, expected)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };
}

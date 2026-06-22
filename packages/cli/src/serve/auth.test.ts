/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { describe, expect, it } from 'vitest';
import {
  allowOriginCors,
  createMutationGate,
  denyBrowserOriginCors,
  InvalidAllowOriginPatternError,
  parseAllowOriginPatterns,
} from './auth.js';

interface GateResult {
  status?: number;
  body?: unknown;
  headers: Map<string, string>;
  nextCalled: boolean;
}

function invokeGate(
  handler: RequestHandler,
  req: { headers?: Record<string, string | undefined> } = {},
): GateResult {
  let status: number | undefined;
  let body: unknown;
  let nextCalled = false;
  const headers = new Map<string, string>();
  const response = {} as Response;
  response.status = ((code: number): Response => {
    status = code;
    return response;
  }) as Response['status'];
  response.json = ((payload: unknown): Response => {
    body = payload;
    return response;
  }) as Response['json'];
  response.setHeader = ((name: string, value: string | number): Response => {
    headers.set(name.toLowerCase(), String(value));
    return response;
  }) as Response['setHeader'];
  const next: NextFunction = () => {
    nextCalled = true;
  };

  handler({ headers: req.headers ?? {} } as Request, response, next);
  return { status, body, headers, nextCalled };
}

function invokeGatedRoute(
  deps: { tokenConfigured: boolean; requireAuth: boolean },
  gateOpts?: { strict?: boolean },
): GateResult {
  const gate = createMutationGate(deps);
  return invokeGate(gate(gateOpts));
}

describe('denyBrowserOriginCors', () => {
  it('sets Vary: Origin when rejecting browser Origin requests', () => {
    const res = invokeGate(denyBrowserOriginCors, {
      headers: { origin: 'https://evil.example.com' },
    });
    expect(res.nextCalled).toBe(false);
    expect(res.status).toBe(403);
    expect(res.headers.get('vary')).toBe('Origin');
  });
});

describe('createMutationGate (#4175 PR 15)', () => {
  it('passes through when --require-auth is on (global bearerAuth handles enforcement)', () => {
    // `requireAuth: true` is paired with a mandatory token at boot, so
    // the global bearer middleware has already 401'd unauthenticated
    // requests before they reach the gate. The gate is a no-op here.
    const res = invokeGatedRoute(
      { tokenConfigured: true, requireAuth: true },
      { strict: true },
    );
    expect(res.nextCalled).toBe(true);
    expect(res.status).toBeUndefined();
    expect(res.body).toBeUndefined();
  });

  it('passes through when a token is configured (global bearerAuth handles enforcement)', () => {
    const res = invokeGatedRoute(
      { tokenConfigured: true, requireAuth: false },
      { strict: true },
    );
    expect(res.nextCalled).toBe(true);
    expect(res.status).toBeUndefined();
  });

  it('passes through on loopback no-token default for non-strict routes', () => {
    // Backward-compat anchor: existing mutation routes (Wave 1-2) opt
    // in to the gate without `strict`, and must continue to serve
    // unauthenticated callers under the loopback developer default.
    const res = invokeGatedRoute(
      { tokenConfigured: false, requireAuth: false },
      // `strict` omitted = false
    );
    expect(res.nextCalled).toBe(true);
    expect(res.status).toBeUndefined();
  });

  it('refuses strict routes with token_required on loopback no-token default', () => {
    // The cell that makes the helper substantive: routes that opt
    // into strictness (Wave 4 file edit / memory CRUD / device-flow
    // auth) refuse to serve until the operator configures a token.
    const res = invokeGatedRoute(
      { tokenConfigured: false, requireAuth: false },
      { strict: true },
    );
    expect(res.nextCalled).toBe(false);
    expect(res.status).toBe(401);
    expect((res.body as { code?: string }).code).toBe('token_required');
    // The error message must point operators at all three remediation
    // paths, not just one. Test for keyword presence rather than
    // exact text so future copy edits don't churn the assertion.
    const body = res.body as { error?: string };
    expect(body.error).toMatch(/QWEN_SERVER_TOKEN/);
    expect(body.error).toMatch(/--token/);
    // `--require-auth` is intentionally NOT named here as a remediation:
    // setting it without a token is itself a boot-error path (see
    // `run-qwen-serve.ts`). The error must point operators at fixes that
    // work standalone.
    expect(body.error).not.toMatch(/--require-auth/);
  });

  it('returns the same passthrough handler instance across calls when global auth is on (allocation discipline)', () => {
    // The factory caches the no-op when `requireAuth || tokenConfigured`
    // so a route table with N mutation routes doesn't allocate N
    // identical closures. Not a behavioral guarantee for callers, but
    // useful as a regression anchor — if a future change makes the
    // factory return a fresh closure per call, this test will surface
    // the change so reviewers can confirm the allocation cost is
    // intentional.
    const gate = createMutationGate({
      tokenConfigured: true,
      requireAuth: false,
    });
    const a = gate();
    const b = gate({ strict: true });
    expect(a).toBe(b);
  });

  it('caches both passthrough and strict denier across calls on no-token loopback (allocation symmetry, PR #4236 review #3254467193)', () => {
    // Symmetric to the test above but for the no-token branch: with N
    // strict routes in a Wave 4 route table, the denier must be cached
    // too so we don't allocate N identical 401 closures. Identity
    // checks anchor the cache; non-strict and strict gates yield
    // distinct singletons (one passthrough, one denier).
    const gate = createMutationGate({
      tokenConfigured: false,
      requireAuth: false,
    });
    const passA = gate();
    const passB = gate({ strict: false });
    const strictA = gate({ strict: true });
    const strictB = gate({ strict: true });
    expect(passA).toBe(passB);
    expect(strictA).toBe(strictB);
    // And the two singletons must be distinct — otherwise the gate
    // would degenerate to a single shape and lose the "strict gates
    // refuse" property.
    expect(passA).not.toBe(strictA);
  });
});

interface AllowOriginResult {
  status?: number;
  body?: unknown;
  headers: Map<string, string>;
  nextCalled: boolean;
  ended: boolean;
}

function invokeAllowOrigin(
  handler: RequestHandler,
  req: {
    method?: string;
    headers?: Record<string, string | undefined>;
  } = {},
): AllowOriginResult {
  let status: number | undefined;
  let body: unknown;
  let nextCalled = false;
  let ended = false;
  const headers = new Map<string, string>();
  const response = {} as Response;
  response.status = ((code: number): Response => {
    status = code;
    return response;
  }) as Response['status'];
  response.json = ((payload: unknown): Response => {
    body = payload;
    return response;
  }) as Response['json'];
  response.setHeader = ((name: string, value: string | number): Response => {
    headers.set(name.toLowerCase(), String(value));
    return response;
  }) as Response['setHeader'];
  response.end = ((): Response => {
    ended = true;
    return response;
  }) as Response['end'];
  const next: NextFunction = () => {
    nextCalled = true;
  };
  handler(
    {
      method: req.method ?? 'GET',
      headers: req.headers ?? {},
    } as unknown as Request,
    response,
    next,
  );
  return { status, body, headers, nextCalled, ended };
}

describe('parseAllowOriginPatterns (T2.4 #4514)', () => {
  it('parses an empty list to an empty allowlist with no wildcard', () => {
    const out = parseAllowOriginPatterns([]);
    expect(out.allowAny).toBe(false);
    expect(out.origins.size).toBe(0);
  });

  it('rejects mixed-case host in the input (URL.origin normalizes, so the round-trip fails)', () => {
    // Documents the strict-by-intent rejection: operators must write
    // the canonical (lowercased) origin. Auto-normalizing would
    // silently accept ambiguous input — explicit failure is clearer.
    expect(() => parseAllowOriginPatterns(['http://Localhost:3000'])).toThrow(
      InvalidAllowOriginPatternError,
    );
  });

  it('accepts a clean canonical origin and stores it lowercased', () => {
    const out = parseAllowOriginPatterns(['http://localhost:3000']);
    expect(out.allowAny).toBe(false);
    expect(out.origins.has('http://localhost:3000')).toBe(true);
  });

  it('accepts the `*` literal and sets allowAny', () => {
    const out = parseAllowOriginPatterns(['*']);
    expect(out.allowAny).toBe(true);
    expect(out.origins.size).toBe(0);
  });

  it('accepts a mix of `*` and concrete origins', () => {
    const out = parseAllowOriginPatterns(['*', 'https://app.example.com']);
    expect(out.allowAny).toBe(true);
    expect(out.origins.has('https://app.example.com')).toBe(true);
  });

  it('rejects trailing slash — operators must write the canonical origin', () => {
    expect(() => parseAllowOriginPatterns(['http://localhost:3000/'])).toThrow(
      InvalidAllowOriginPatternError,
    );
  });

  it('rejects path components — origins do not carry paths', () => {
    expect(() =>
      parseAllowOriginPatterns(['https://app.example.com/foo']),
    ).toThrow(InvalidAllowOriginPatternError);
  });

  it('rejects userinfo — leaks credentials in capability metadata', () => {
    expect(() =>
      parseAllowOriginPatterns(['http://user:pass@example.com']),
    ).toThrow(InvalidAllowOriginPatternError);
  });

  it('rejects values that are not parseable URLs', () => {
    expect(() => parseAllowOriginPatterns(['not-a-url'])).toThrow(
      InvalidAllowOriginPatternError,
    );
  });

  it('rejects URLs with empty hostname (http://:3000)', () => {
    // Defensive lock against a future Node URL-parser change that
    // accepts the no-host form. Today it throws `Invalid URL`, which
    // the parser-error branch in `parseAllowOriginPatterns` catches.
    expect(() => parseAllowOriginPatterns(['http://:3000'])).toThrow(
      InvalidAllowOriginPatternError,
    );
  });

  it('throws on the first malformed entry, naming it for the operator', () => {
    try {
      parseAllowOriginPatterns(['http://localhost:3000', 'http://broken/']);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidAllowOriginPatternError);
      const e = err as InvalidAllowOriginPatternError;
      expect(e.pattern).toBe('http://broken/');
      expect(e.message).toContain('http://broken/');
    }
  });
});

describe('allowOriginCors (T2.4 #4514)', () => {
  const middleware = allowOriginCors(
    parseAllowOriginPatterns(['http://localhost:3000']),
  );
  const wildcardMiddleware = allowOriginCors(parseAllowOriginPatterns(['*']));

  it('passes through requests with no Origin header (CLI / SDK callers)', () => {
    const res = invokeAllowOrigin(middleware, {});
    expect(res.nextCalled).toBe(true);
    expect(res.status).toBeUndefined();
    expect(res.headers.size).toBe(0);
  });

  it('matches an allowlisted origin, sets CORS headers, and calls next()', () => {
    const res = invokeAllowOrigin(middleware, {
      method: 'GET',
      headers: { origin: 'http://localhost:3000' },
    });
    expect(res.nextCalled).toBe(true);
    expect(res.status).toBeUndefined();
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'http://localhost:3000',
    );
    expect(res.headers.get('vary')).toBe('Origin');
    expect(res.headers.get('access-control-allow-methods')).toMatch(/GET/);
    expect(res.headers.get('access-control-allow-headers')).toMatch(
      /Authorization/,
    );
    expect(res.headers.get('access-control-max-age')).toBe('86400');
    expect(res.headers.get('access-control-expose-headers')).toBe(
      'Retry-After',
    );
  });

  it('short-circuits OPTIONS preflight with 204 + CORS headers (no chain continuation)', () => {
    const res = invokeAllowOrigin(middleware, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': 'POST',
      },
    });
    expect(res.nextCalled).toBe(false);
    expect(res.ended).toBe(true);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'http://localhost:3000',
    );
  });

  it('lets plain OPTIONS requests continue after setting CORS headers', () => {
    const res = invokeAllowOrigin(middleware, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:3000' },
    });
    expect(res.nextCalled).toBe(true);
    expect(res.ended).toBe(false);
    expect(res.status).toBeUndefined();
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'http://localhost:3000',
    );
  });

  it('matches case-insensitively on scheme/host (RFC 6454 §4)', () => {
    const res = invokeAllowOrigin(middleware, {
      method: 'GET',
      headers: { origin: 'HTTP://LOCALHOST:3000' },
    });
    expect(res.nextCalled).toBe(true);
    // Echo the request's origin verbatim — browser caches use it as a
    // key paired with `Vary: Origin`, so we must echo the exact value
    // the client sent, not a normalized form.
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'HTTP://LOCALHOST:3000',
    );
  });

  it('rejects unmatched origins with the same 403 envelope as denyBrowserOriginCors', () => {
    const res = invokeAllowOrigin(middleware, {
      method: 'POST',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(res.nextCalled).toBe(false);
    expect(res.status).toBe(403);
    expect((res.body as { error?: string }).error).toBe(
      'Request denied by CORS policy',
    );
    // No CORS response headers leak on the reject path — the browser
    // would have nothing to do with them anyway (it's about to block
    // the response), but emitting them would advertise the allowlist
    // size indirectly through header presence.
    expect(res.headers.has('access-control-allow-origin')).toBe(false);
  });

  it('`*` admits any origin and echoes the request value', () => {
    const res = invokeAllowOrigin(wildcardMiddleware, {
      method: 'GET',
      headers: { origin: 'https://anywhere.example.com' },
    });
    expect(res.nextCalled).toBe(true);
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'https://anywhere.example.com',
    );
  });

  it('`Origin: null` (sandboxed iframes, file:// docs) is rejected even under `*`', () => {
    // Defense against a sandboxed-iframe attack: a malicious page can
    // spawn an `<iframe sandbox>` that gets `Origin: null`; echoing
    // `Access-Control-Allow-Origin: null` under `*` would let the
    // iframe's fetch read responses without any cross-origin defense
    // from the operator's allowlist. Explicit drop, not next().
    const res = invokeAllowOrigin(wildcardMiddleware, {
      method: 'GET',
      headers: { origin: 'null' },
    });
    expect(res.nextCalled).toBe(false);
    expect(res.status).toBe(403);
    expect((res.body as { error?: string }).error).toBe(
      'Request denied by CORS policy',
    );
    expect(res.headers.has('access-control-allow-origin')).toBe(false);
  });

  it('reject path sets `Vary: Origin` so intermediary caches do not serve a stale 403 to a different origin', () => {
    const res = invokeAllowOrigin(middleware, {
      method: 'GET',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('vary')).toBe('Origin');
  });
});

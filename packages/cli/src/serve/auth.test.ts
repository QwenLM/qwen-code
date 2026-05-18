/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { createMutationGate } from './auth.js';

interface GateResult {
  status?: number;
  body?: unknown;
  nextCalled: boolean;
}

function invokeGate(handler: RequestHandler): GateResult {
  let status: number | undefined;
  let body: unknown;
  let nextCalled = false;
  const response = {} as Response;
  response.status = ((code: number): Response => {
    status = code;
    return response;
  }) as Response['status'];
  response.json = ((payload: unknown): Response => {
    body = payload;
    return response;
  }) as Response['json'];
  const next: NextFunction = () => {
    nextCalled = true;
  };

  handler({} as Request, response, next);
  return { status, body, nextCalled };
}

function invokeGatedRoute(
  deps: { tokenConfigured: boolean; requireAuth: boolean },
  gateOpts?: { strict?: boolean },
): GateResult {
  const gate = createMutationGate(deps);
  return invokeGate(gate(gateOpts));
}

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
    // `runQwenServe.ts`). The error must point operators at fixes that
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

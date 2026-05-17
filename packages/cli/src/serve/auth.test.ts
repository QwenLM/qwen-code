/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createMutationGate } from './auth.js';

/**
 * Build a tiny Express app whose POST /test handler is gated by
 * `gate(opts)` and otherwise just returns `{ ok: true }`. Lets each
 * test slot one cell of the gate's behavior matrix into the same
 * harness without spinning up the full daemon.
 */
function gatedApp(
  deps: { tokenConfigured: boolean; requireAuth: boolean },
  gateOpts?: { strict?: boolean },
): express.Application {
  const app = express();
  const gate = createMutationGate(deps);
  app.post('/test', gate(gateOpts), (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

describe('createMutationGate (#4175 PR 15)', () => {
  it('passes through when --require-auth is on (global bearerAuth handles enforcement)', async () => {
    // `requireAuth: true` is paired with a mandatory token at boot, so
    // the global bearer middleware has already 401'd unauthenticated
    // requests before they reach the gate. The gate is a no-op here.
    const app = gatedApp(
      { tokenConfigured: true, requireAuth: true },
      { strict: true },
    );
    const res = await request(app).post('/test');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('passes through when a token is configured (global bearerAuth handles enforcement)', async () => {
    const app = gatedApp(
      { tokenConfigured: true, requireAuth: false },
      { strict: true },
    );
    const res = await request(app).post('/test');
    expect(res.status).toBe(200);
  });

  it('passes through on loopback no-token default for non-strict routes', async () => {
    // Backward-compat anchor: existing mutation routes (Wave 1-2) opt
    // in to the gate without `strict`, and must continue to serve
    // unauthenticated callers under the loopback developer default.
    const app = gatedApp(
      { tokenConfigured: false, requireAuth: false },
      // `strict` omitted = false
    );
    const res = await request(app).post('/test');
    expect(res.status).toBe(200);
  });

  it('refuses strict routes with token_required on loopback no-token default', async () => {
    // The cell that makes the helper substantive: routes that opt
    // into strictness (Wave 4 file edit / memory CRUD / device-flow
    // auth) refuse to serve until the operator configures a token.
    const app = gatedApp(
      { tokenConfigured: false, requireAuth: false },
      { strict: true },
    );
    const res = await request(app).post('/test');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('token_required');
    // The error message must point operators at all three remediation
    // paths, not just one. Test for keyword presence rather than
    // exact text so future copy edits don't churn the assertion.
    expect(res.body.error).toMatch(/QWEN_SERVER_TOKEN/);
    expect(res.body.error).toMatch(/--token/);
    // `--require-auth` is intentionally NOT named here as a remediation:
    // setting it without a token is itself a boot-error path (see
    // `runQwenServe.ts`). The error must point operators at fixes that
    // work standalone.
    expect(res.body.error).not.toMatch(/--require-auth/);
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

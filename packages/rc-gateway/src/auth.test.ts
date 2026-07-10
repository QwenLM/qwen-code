/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { TokenStore } from './tokenStore.js';
import {
  bearerResolve,
  requireScope,
  enforceSessionLock,
  resolveSubActor,
  enforceSubActorScope,
  parseSubActor,
  enforceSubActorRateLimit,
  enforceSubActorBan,
} from './auth.js';
import { SESSION_READ, APPROVE, WRITE, BRIDGE, OWNER } from './scopes.js';
import { SubActorRateLimiter } from './bridges/subActorRateLimiter.js';
import { SubActorBanStore } from './bridges/subActorBans.js';
import type { AuditEntry, AuditRecorder } from './auditLog.js';

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}

function fakeRes(): Response & { _status: number; _json: unknown } {
  const res = {
    _status: 200,
    _json: undefined as unknown,
    status(code: number) {
      this._status = code;
      return this;
    },
    json(body: unknown) {
      this._json = body;
      return this;
    },
  };
  return res as unknown as Response & { _status: number; _json: unknown };
}

describe('auth middleware', () => {
  let store: TokenStore;
  beforeEach(async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rc-auth-')), 'tokens.json');
    store = await TokenStore.open(path);
  });

  it('bearerResolve attaches rcClient for a valid token', async () => {
    const { id, token } = await store.issue([SESSION_READ], 'phone');
    const req = { headers: { authorization: `Bearer ${token}` } } as Request;
    const res = fakeRes();
    let called = false;
    bearerResolve(store)(req, res, () => {
      called = true;
    });
    expect(called).toBe(true);
    expect(req.rcClient).toEqual({ id, scopes: [SESSION_READ] });
  });

  it('bearerResolve 401s a missing/invalid token', () => {
    const req = { headers: {} } as Request;
    const res = fakeRes();
    let called = false;
    bearerResolve(store)(req, res, () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ code: 'unauthorized' });
  });

  it('requireScope passes when the scope is present', () => {
    const req = { rcClient: { id: 'x', scopes: [SESSION_READ] } } as Request;
    const res = fakeRes();
    let called = false;
    requireScope(SESSION_READ)(req, res, () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it('requireScope 403s when the scope is absent', () => {
    const req = { rcClient: { id: 'x', scopes: [] } } as Request;
    const res = fakeRes();
    let called = false;
    requireScope(SESSION_READ)(req, res, () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(res._status).toBe(403);
    expect(res._json).toMatchObject({ code: 'scope_required' });
  });

  it('requireScope passes when a higher scope implies the required scope (implication hierarchy)', () => {
    // owner implies write, approve, and session:read
    const req = { rcClient: { id: 'x', scopes: [OWNER] } } as Request;
    const res = fakeRes();
    let called = false;
    requireScope(SESSION_READ)(req, res, () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it('requireScope passes when write implies session:read', () => {
    const req = { rcClient: { id: 'x', scopes: [WRITE] } } as Request;
    const res = fakeRes();
    let called = false;
    requireScope(SESSION_READ)(req, res, () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it('records auth_failed on a bad token', () => {
    const audit = fakeAudit();
    const req = { headers: {}, path: '/rc/tokens' } as Request;
    bearerResolve(store, audit)(req, fakeRes(), () => {});
    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0]).toMatchObject({
      action: 'auth_failed',
      detail: { path: '/rc/tokens' },
    });
    expect(audit.calls[0].actorTokenId).toBeUndefined();
  });

  it('does not record when auth succeeds', async () => {
    const audit = fakeAudit();
    const { token } = await store.issue([SESSION_READ], 'phone');
    const req = { headers: { authorization: `Bearer ${token}` } } as Request;
    bearerResolve(store, audit)(req, fakeRes(), () => {});
    expect(audit.calls).toHaveLength(0);
  });

  it('bearerResolve 401s with token_expired_max_age when past max age', async () => {
    const DAY_MS = 86_400_000;
    let now = 1_000_000;
    const path2 = join(
      mkdtempSync(join(tmpdir(), 'rc-auth-age-')),
      'tokens.json',
    );
    const { TokenStore: TS } = await import('./tokenStore.js');
    const ageStore = await TS.open(path2, () => now);
    const { token } = await ageStore.issue([SESSION_READ], 'phone');
    now = 1_000_000 + 181 * DAY_MS;
    const req = {
      headers: { authorization: `Bearer ${token}` },
      path: '/rc/tokens',
    } as Request;
    const res = fakeRes();
    let called = false;
    bearerResolve(ageStore)(req, res, () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(res._status).toBe(401);
    expect((res._json as Record<string, unknown>).code).toBe(
      'token_expired_max_age',
    );
  });

  it('bearerResolve records token_expired_max_age audit action when max age exceeded', async () => {
    const DAY_MS = 86_400_000;
    let now = 1_000_000;
    const path3 = join(
      mkdtempSync(join(tmpdir(), 'rc-auth-age2-')),
      'tokens.json',
    );
    const { TokenStore: TS } = await import('./tokenStore.js');
    const ageStore = await TS.open(path3, () => now);
    const { token } = await ageStore.issue([SESSION_READ], 'phone');
    now = 1_000_000 + 181 * DAY_MS;
    const audit2 = fakeAudit();
    const req = {
      headers: { authorization: `Bearer ${token}` },
      path: '/rc/tokens',
    } as Request;
    bearerResolve(ageStore, audit2)(req, fakeRes(), () => {});
    expect(audit2.calls).toHaveLength(1);
    expect(audit2.calls[0]).toMatchObject({
      action: 'token_expired_max_age',
      detail: { path: '/rc/tokens' },
    });
  });

  it('records scope_denied with actor and required scope', () => {
    const audit = fakeAudit();
    const req = { rcClient: { id: 'x', scopes: [] } } as Request;
    requireScope(SESSION_READ, audit)(req, fakeRes(), () => {});
    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0]).toMatchObject({
      action: 'scope_denied',
      actorTokenId: 'x',
      detail: { required: SESSION_READ },
    });
  });

  it('scope_denied for a guest carries shareId+shareLabel (label on every audit line)', async () => {
    const audit = fakeAudit();
    const share = await store.issueShare({
      scopes: [SESSION_READ], // view-only: lacks APPROVE
      label: 'review for Sam',
      sessionLockId: 's1',
      ttlSec: 3600,
      parentId: 'owner-1',
    });
    const req = {
      headers: { authorization: `Bearer ${share.token}` },
    } as Request;
    // bearerResolve enriches rcClient.shareId/shareLabel, then a scope it
    // lacks is denied — that denial row must be attributable + labeled.
    bearerResolve(store, audit)(req, fakeRes(), () => {});
    requireScope(APPROVE, audit)(req, fakeRes(), () => {});
    const denied = audit.calls.find((c) => c.action === 'scope_denied');
    expect(denied!.shareId).toBe(share.id);
    expect(denied!.shareLabel).toBe('review for Sam');

    // enforceSessionLock denial on a cross-session probe is likewise labeled.
    const req2 = {
      ...req,
      params: { id: 's2' },
      path: '/session/s2/events',
    } as unknown as Request;
    enforceSessionLock(audit)(req2, fakeRes(), () => {});
    const locked = audit.calls.find(
      (c) => c.detail?.reason === 'session_locked',
    );
    expect(locked!.shareId).toBe(share.id);
    expect(locked!.shareLabel).toBe('review for Sam');
  });

  it('scope_denied for a normal token leaves shareId/shareLabel unset', () => {
    const audit = fakeAudit();
    const req = { rcClient: { id: 'x', scopes: [] } } as Request;
    requireScope(SESSION_READ, audit)(req, fakeRes(), () => {});
    const denied = audit.calls.find((c) => c.action === 'scope_denied');
    expect(denied!.shareId).toBeUndefined();
    expect(denied!.shareLabel).toBeUndefined();
  });

  it('bearerResolve carries sessionLockId onto rcClient for a share token', async () => {
    const share = await store.issueShare({
      scopes: [SESSION_READ],
      label: 'guest',
      sessionLockId: 's1',
      ttlSec: 3600,
      parentId: 'owner-1',
    });
    const req = {
      headers: { authorization: `Bearer ${share.token}` },
    } as Request;
    bearerResolve(store)(req, fakeRes(), () => {});
    expect(req.rcClient).toMatchObject({ id: share.id, sessionLockId: 's1' });
  });

  it('enforceSessionLock passes a locked token onto its own session', () => {
    const req = {
      rcClient: { id: 'x', scopes: [SESSION_READ], sessionLockId: 's1' },
      params: { id: 's1' },
      path: '/session/s1/events',
    } as unknown as Request;
    const res = fakeRes();
    let called = false;
    enforceSessionLock()(req, res, () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it('enforceSessionLock 403s a locked token on a different session + audits scope_denied', () => {
    const audit = fakeAudit();
    const req = {
      rcClient: { id: 'x', scopes: [SESSION_READ], sessionLockId: 's1' },
      params: { id: 's2' },
      path: '/session/s2/events',
    } as unknown as Request;
    const res = fakeRes();
    let called = false;
    enforceSessionLock(audit)(req, res, () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(res._status).toBe(403);
    expect(res._json).toMatchObject({ code: 'session_locked' });
    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0]).toMatchObject({
      action: 'scope_denied',
      actorTokenId: 'x',
      detail: { reason: 'session_locked', path: '/session/s2/events' },
    });
  });

  it('enforceSessionLock passes an unlocked (normal) token unaffected', () => {
    const req = {
      rcClient: { id: 'x', scopes: [SESSION_READ] },
      params: { id: 's2' },
      path: '/session/s2/events',
    } as unknown as Request;
    const res = fakeRes();
    let called = false;
    enforceSessionLock()(req, res, () => {
      called = true;
    });
    expect(called).toBe(true);
  });
});

/** A fake Express req carrying rcClient + a case-insensitive header lookup. */
function subReq(
  scopes: string[] | undefined,
  header: string | undefined,
): Request {
  const headers: Record<string, string> = {};
  if (header !== undefined) headers['x-rc-subactor'] = header;
  return {
    rcClient: scopes ? { id: 'b1', scopes } : undefined,
    header: (n: string) => headers[n.toLowerCase()],
  } as unknown as Request;
}

describe('parseSubActor', () => {
  it('accepts a well-formed <svc>:<id>', () => {
    expect(parseSubActor('telegram:alice')).toBe('telegram:alice');
    expect(parseSubActor('discord:123456789')).toBe('discord:123456789');
    expect(parseSubActor('  matrix:@a.b_c  ')).toBe('matrix:@a.b_c'); // trimmed
  });
  it('accepts fully-qualified + extended-grammar MXIDs', () => {
    expect(parseSubActor('matrix:@alice:home.example.com')).toBe(
      'matrix:@alice:home.example.com',
    );
    // Extended MXID localpart chars (/ = +) are legal and must not be rejected.
    expect(parseSubActor('matrix:@user=foo:home.example.com')).toBe(
      'matrix:@user=foo:home.example.com',
    );
    expect(parseSubActor('matrix:@a/b+c:srv.org')).toBe(
      'matrix:@a/b+c:srv.org',
    );
    // A homeserver with an explicit port (the `:` is already allowed).
    expect(parseSubActor('matrix:@alice:home.example.com:8448')).toBe(
      'matrix:@alice:home.example.com:8448',
    );
  });
  it('rejects empty / whitespace / overlong', () => {
    expect(parseSubActor(undefined)).toBeNull();
    expect(parseSubActor('')).toBeNull();
    expect(parseSubActor('   ')).toBeNull();
    expect(parseSubActor('a'.repeat(129))).toBeNull();
  });
  it('rejects injection / unsafe charset (newline, spaces, leading punct)', () => {
    expect(parseSubActor('a\nb')).toBeNull();
    expect(parseSubActor('has space')).toBeNull();
    expect(parseSubActor(':leading')).toBeNull();
    expect(parseSubActor('<script>')).toBeNull();
  });
});

describe('enforceSubActorScope middleware', () => {
  it('400s sub_actor_forbidden_scope when a non-bridge token sends X-RC-SubActor', () => {
    const req = subReq([APPROVE, WRITE, SESSION_READ], 'telegram:alice');
    const res = fakeRes();
    let called = false;
    enforceSubActorScope()(req, res, () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(res._status).toBe(400);
    expect(res._json).toMatchObject({ code: 'sub_actor_forbidden_scope' });
  });

  it('passes through a non-bridge token with NO X-RC-SubActor header', () => {
    const req = subReq([APPROVE, WRITE, SESSION_READ], undefined);
    let called = false;
    enforceSubActorScope()(req, fakeRes(), () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it('passes through a bridge token with X-RC-SubActor (allowed to assert sub-actor)', () => {
    const req = subReq([BRIDGE, SESSION_READ], 'telegram:alice');
    let called = false;
    enforceSubActorScope()(req, fakeRes(), () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it('passes through an unauthenticated request (no rcClient)', () => {
    const req = subReq(undefined, 'telegram:alice');
    let called = false;
    enforceSubActorScope()(req, fakeRes(), () => {
      called = true;
    });
    expect(called).toBe(true);
  });
});

describe('resolveSubActor middleware', () => {
  it('attaches subActor for a BRIDGE token with a valid header', () => {
    const req = subReq([BRIDGE, SESSION_READ], 'telegram:alice');
    let called = false;
    resolveSubActor()(req, fakeRes(), () => {
      called = true;
    });
    expect(called).toBe(true);
    expect(req.rcClient?.subActor).toBe('telegram:alice');
  });

  it('IGNORES the header for a non-bridge token (no attribution spoofing)', () => {
    const req = subReq([APPROVE, WRITE, SESSION_READ], 'telegram:alice');
    resolveSubActor()(req, fakeRes(), () => {});
    expect(req.rcClient?.subActor).toBeUndefined();
  });

  it('leaves subActor unset for a bridge token with an invalid header', () => {
    const req = subReq([BRIDGE], 'bad value\n');
    resolveSubActor()(req, fakeRes(), () => {});
    expect(req.rcClient?.subActor).toBeUndefined();
  });

  it('is a no-op (and calls next) when unauthenticated', () => {
    const req = subReq(undefined, 'telegram:alice');
    let called = false;
    resolveSubActor()(req, fakeRes(), () => {
      called = true;
    });
    expect(called).toBe(true);
    expect(req.rcClient).toBeUndefined();
  });
});

describe('enforceSubActorRateLimit middleware', () => {
  /** A req with a resolved subActor (a bridge-mediated request). */
  function bridgeReq(subActor: string | undefined): Request {
    return {
      rcClient: { id: 'tkn-bridge', scopes: [BRIDGE], subActor },
      params: { id: 's1' },
    } as unknown as Request;
  }

  it('passes through a request with NO sub-actor (never limits normal clients)', () => {
    const limiter = new SubActorRateLimiter();
    const mw = enforceSubActorRateLimit(limiter, 1, undefined, () => 0);
    // Even called many times, a no-subActor request is never limited.
    for (let i = 0; i < 5; i++) {
      const res = fakeRes();
      let called = false;
      mw(bridgeReq(undefined), res, () => {
        called = true;
      });
      expect(called).toBe(true);
      expect(res._status).toBe(200);
    }
  });

  it('429s a sub-actor over the cap and audits once (firstDrop)', () => {
    const audit = fakeAudit();
    const limiter = new SubActorRateLimiter();
    let t = 0;
    const mw = enforceSubActorRateLimit(limiter, 2, audit, () => t++);
    const run = () => {
      const res = fakeRes();
      let called = false;
      mw(bridgeReq('telegram:alice'), res, () => {
        called = true;
      });
      return { res, called };
    };
    expect(run().called).toBe(true); // 1
    expect(run().called).toBe(true); // 2 (at cap)
    const third = run(); // 3 → over
    expect(third.called).toBe(false);
    expect(third.res._status).toBe(429);
    expect(third.res._json).toMatchObject({ code: 'sub_actor_rate_limited' });
    const fourth = run(); // 4 → still limited, no re-audit
    expect(fourth.res._status).toBe(429);
    // Audited exactly once (the transition), carrying the subActor.
    const rows = audit.calls.filter(
      (c) => c.action === 'sub_actor_rate_limited',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].subActor).toBe('telegram:alice');
    expect(rows[0].target).toBe('s1');
  });
});

describe('enforceSubActorBan middleware', () => {
  function bridgeReq(subActor: string | undefined): Request {
    return {
      rcClient: { id: 'tkn-bridge', scopes: [BRIDGE], subActor },
      params: { id: 's1' },
    } as unknown as Request;
  }

  it('403s a banned sub-actor', () => {
    const bans = new SubActorBanStore();
    bans.ban('telegram:alice');
    const res = fakeRes();
    let called = false;
    enforceSubActorBan(bans)(bridgeReq('telegram:alice'), res, () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(res._status).toBe(403);
    expect(res._json).toMatchObject({ code: 'sub_actor_banned' });
  });

  it('passes a non-banned sub-actor and a request with no sub-actor', () => {
    const bans = new SubActorBanStore();
    bans.ban('telegram:troll');
    let a = false;
    enforceSubActorBan(bans)(bridgeReq('telegram:alice'), fakeRes(), () => {
      a = true;
    });
    expect(a).toBe(true);
    let b = false;
    enforceSubActorBan(bans)(bridgeReq(undefined), fakeRes(), () => {
      b = true;
    });
    expect(b).toBe(true);
  });
});

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { DaemonClient } from '@qwen-code/sdk';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';
import type { Policy } from './loader.js';
import { PolicyEnforcer } from './enforcer.js';
import { QuotaStore, MemoryQuotaWal, type QuotaLimit } from './quotas.js';

const NOW = 1_000_000;

function fakeAudit(): { entries: AuditEntry[]; recorder: AuditRecorder } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    recorder: { record: async (e: AuditEntry) => void entries.push(e) },
  };
}

/** A daemon whose vote returns `voteOk`; records each respondToSessionPermission. */
function fakeDaemon(voteOk: boolean): {
  daemon: DaemonClient;
  votes: Array<{ sessionId: string; requestId: string }>;
} {
  const votes: Array<{ sessionId: string; requestId: string }> = [];
  const daemon = {
    respondToSessionPermission: async (
      sessionId: string,
      requestId: string,
    ): Promise<boolean> => {
      votes.push({ sessionId, requestId });
      return voteOk;
    },
  } as unknown as DaemonClient;
  return { daemon, votes };
}

/**
 * REAL permission_request data (the daemon's ACP ToolCall verbatim): `{
 * toolCallId, title, kind, rawInput }`. The old synthetic `{ name, input }`
 * shape hid the extraction bug that Task 7 fixes — never reintroduce it here.
 */
function permEvent(
  kind: string,
  requestId = 'r1',
): { type: string; data: unknown } {
  return {
    type: 'permission_request',
    data: {
      requestId,
      toolCall: { toolCallId: 'tc1', title: 'humanized', kind, rawInput: {} },
      options: [
        { optionId: 'always', kind: 'allow_always', label: 'Always' },
        { optionId: 'ok', kind: 'allow_once', label: 'Once' },
      ],
    },
  };
}

const quotaRule = (count: number): Policy => ({
  defaults: { action: 'prompt', requireScope: 'approve' },
  rules: [
    {
      id: 'q',
      match: { tool: 'execute' },
      action: 'allow',
      maxPerWindow: { count, windowSec: 60 },
    },
  ],
});

async function storeFor(m: Record<string, QuotaLimit>): Promise<QuotaStore> {
  return QuotaStore.create(new MemoryQuotaWal(), (id) => m[id]);
}

describe('PolicyEnforcer + quota store (cycle 43 flip)', () => {
  it('consumes exactly once on a successful allow vote and audits quotaRemaining', async () => {
    const { daemon, votes } = fakeDaemon(true);
    const { entries, recorder } = fakeAudit();
    const store = await storeFor({ q: { count: 2, windowSec: 60 } });
    const enf = new PolicyEnforcer(
      daemon,
      quotaRule(2),
      recorder,
      store,
      () => NOW,
    );

    const handled = await enf.handlePermission('s1', permEvent('execute'));
    expect(handled).toBe(true);
    expect(votes).toHaveLength(1);
    expect(store.remaining('q', NOW)).toBe(1); // consumed once
    const rec = entries.find((e) => e.action === 'policy_decision');
    expect(rec?.detail).toMatchObject({
      action: 'allow',
      ruleId: 'q',
      voted: true,
      quotaRemaining: 1,
    });
  });

  it('does NOT consume when the vote fails', async () => {
    const { daemon } = fakeDaemon(false); // vote returns false
    const { recorder } = fakeAudit();
    const store = await storeFor({ q: { count: 2, windowSec: 60 } });
    const enf = new PolicyEnforcer(
      daemon,
      quotaRule(2),
      recorder,
      store,
      () => NOW,
    );

    const handled = await enf.handlePermission('s1', permEvent('execute'));
    expect(handled).toBe(false); // fell through to push
    expect(store.remaining('q', NOW)).toBe(2); // untouched
  });

  it('falls through (no auto-allow) once the quota is exhausted', async () => {
    const { daemon, votes } = fakeDaemon(true);
    const { recorder } = fakeAudit();
    const store = await storeFor({ q: { count: 2, windowSec: 60 } });
    const enf = new PolicyEnforcer(
      daemon,
      quotaRule(2),
      recorder,
      store,
      () => NOW,
    );

    expect(await enf.handlePermission('s1', permEvent('execute', 'a'))).toBe(
      true,
    );
    expect(await enf.handlePermission('s1', permEvent('execute', 'b'))).toBe(
      true,
    );
    // 3rd within the window: exhausted → rule no-match → default prompt → no vote.
    expect(await enf.handlePermission('s1', permEvent('execute', 'c'))).toBe(
      false,
    );
    expect(votes).toHaveLength(2); // only the first two allowed
    expect(store.remaining('q', NOW)).toBe(0);
  });

  it('an allow via a NON-quota rule does not consume (no WAL churn)', async () => {
    const { daemon } = fakeDaemon(true);
    const { entries, recorder } = fakeAudit();
    const wal = new MemoryQuotaWal();
    const store = await QuotaStore.create(wal, () => undefined); // nothing tracked
    const plain: Policy = {
      defaults: { action: 'prompt', requireScope: 'approve' },
      rules: [{ id: 'plain', match: { tool: 'execute' }, action: 'allow' }],
    };
    const enf = new PolicyEnforcer(daemon, plain, recorder, store, () => NOW);

    expect(await enf.handlePermission('s1', permEvent('execute'))).toBe(true);
    expect(await wal.load()).toEqual([]); // no consume persisted
    const rec = entries.find((e) => e.action === 'policy_decision');
    expect(rec?.detail).not.toHaveProperty('quotaRemaining');
  });

  it('a prompt decision never consumes', async () => {
    const { daemon } = fakeDaemon(true);
    const { recorder } = fakeAudit();
    const wal = new MemoryQuotaWal();
    const store = await QuotaStore.create(wal, (id) =>
      id === 'q' ? { count: 2, windowSec: 60 } : undefined,
    );
    const empty: Policy = {
      defaults: { action: 'prompt', requireScope: 'approve' },
      rules: [],
    };
    const enf = new PolicyEnforcer(daemon, empty, recorder, store, () => NOW);

    expect(await enf.handlePermission('s1', permEvent('execute'))).toBe(false);
    expect(await wal.load()).toEqual([]);
  });

  it('with NO store the maxPerWindow rule stays a prompt (backward compatible)', async () => {
    const { daemon, votes } = fakeDaemon(true);
    const { recorder } = fakeAudit();
    const enf = new PolicyEnforcer(daemon, quotaRule(2), recorder); // no store

    expect(await enf.handlePermission('s1', permEvent('execute'))).toBe(false);
    expect(votes).toHaveLength(0); // never auto-voted
  });
});

/**
 * A daemon whose `respondToSessionPermission` returns a Promise that only
 * settles when the test explicitly resolves it (via the returned
 * `resolvers` array, in call order) — lets a test hold two concurrent votes
 * open simultaneously with no timers/sleeps, so ordering is deterministic.
 */
function controllableDaemon(): {
  daemon: DaemonClient;
  votes: Array<{ sessionId: string; requestId: string }>;
  resolvers: Array<(ok: boolean) => void>;
} {
  const votes: Array<{ sessionId: string; requestId: string }> = [];
  const resolvers: Array<(ok: boolean) => void> = [];
  const daemon = {
    respondToSessionPermission: (
      sessionId: string,
      requestId: string,
    ): Promise<boolean> => {
      votes.push({ sessionId, requestId });
      return new Promise<boolean>((resolve) => {
        resolvers.push(resolve);
      });
    },
  } as unknown as DaemonClient;
  return { daemon, votes, resolvers };
}

describe('PolicyEnforcer + quota store: concurrent cross-session race (check-then-consume)', () => {
  it('two sessions racing the SAME count:1 rule: only one is voted-allow + consumed, the loser falls through to prompt', async () => {
    const { daemon, votes, resolvers } = controllableDaemon();
    const { entries, recorder } = fakeAudit();
    const wal = new MemoryQuotaWal();
    const store = await QuotaStore.create(wal, () => ({
      count: 1,
      windowSec: 60,
    }));
    const enf = new PolicyEnforcer(
      daemon,
      quotaRule(1),
      recorder,
      store,
      () => NOW,
    );

    // Fire both concurrently, for two DIFFERENT sessions matching the same
    // ruleId ('q'). Nothing here awaits a timer: handlePermission runs
    // synchronously up to `await respondToSessionPermission`, and the fake
    // daemon returns an externally-controlled Promise, so both calls reach
    // (or, once fixed, are turned away by their own check before reaching)
    // the vote deterministically, with no sleep involved.
    const p1 = enf.handlePermission('s1', permEvent('execute', 'r1'));
    const p2 = enf.handlePermission('s2', permEvent('execute', 'r2'));

    // THE RACE, pinned: current (buggy) code lets BOTH calls read the quota
    // as 'room' before either consumes, so both reach the daemon — votes
    // would be length 2 here. The fix closes the window by committing
    // (reserving) the slot synchronously the instant a decision is 'allow',
    // before the vote's `await` — so the second session's OWN evaluate()
    // check sees the slot already taken and never calls the daemon at all.
    // This assertion is therefore a second, sharper RED signal (RED: 2)
    // that also pins the fixed shape (GREEN: 1).
    expect(votes).toHaveLength(1);

    // Resolve whatever votes were actually cast (1 fixed / 2 unfixed) — both
    // as a successful vote, the worst case for the race: if a check-then-
    // consume gap still existed, both would now consume, exceeding count:1.
    for (const resolve of resolvers) resolve(true);
    const [h1, h2] = await Promise.all([p1, p2]);

    const handledCount = [h1, h2].filter(Boolean).length;
    expect(handledCount).toBe(1); // exactly one auto-handled (voted + consumed)

    // The definitive consume counter: how many slots were actually persisted
    // for rule 'q'. remaining() clamps at 0 and would hide a double-consume;
    // the WAL record count cannot.
    expect(await wal.load()).toHaveLength(1);

    // The winner's audit record: voted allow, quota consumed.
    const winnerRecord = entries.find(
      (e) =>
        e.action === 'policy_decision' &&
        e.detail?.['action'] === 'allow' &&
        e.detail?.['voted'] === true,
    );
    expect(winnerRecord?.detail).toMatchObject({
      ruleId: 'q',
      voted: true,
      quotaRemaining: 0,
    });

    // The loser's audit record: never voted, fell through to the policy
    // default (prompt) — proving it wasn't silently dropped, just correctly
    // turned away by its own quota check.
    const loserRecord = entries.find(
      (e) =>
        e.action === 'policy_decision' &&
        e.detail?.['action'] === 'prompt' &&
        e.detail?.['decisionSource'] === 'default',
    );
    expect(loserRecord?.detail).toMatchObject({
      voted: false,
      reason: 'default',
    });
  });

  it('a vote that THROWS releases the reservation, and the freed slot is reusable by a later call', async () => {
    const daemon = {
      respondToSessionPermission: async (): Promise<boolean> => {
        throw new Error('daemon connection reset');
      },
    } as unknown as DaemonClient;
    const { recorder } = fakeAudit();
    const wal = new MemoryQuotaWal();
    const store = await QuotaStore.create(wal, () => ({
      count: 1,
      windowSec: 60,
    }));
    const enf = new PolicyEnforcer(
      daemon,
      quotaRule(1),
      recorder,
      store,
      () => NOW,
    );

    // First call: the vote throws — must fall through, and must NOT leave the
    // reserved slot stuck (unusable forever).
    expect(await enf.handlePermission('s1', permEvent('execute', 'r1'))).toBe(
      false,
    );
    expect(store.remaining('q', NOW)).toBe(1); // released back, not stuck at 0

    // A fresh call at the SAME instant must be able to consume the freed slot
    // (proves releaseReserved() actually frees a REUSABLE slot, not just that
    // remaining() reports a number that looks right).
    const { daemon: okDaemon, votes } = fakeDaemon(true);
    const enf2 = new PolicyEnforcer(
      okDaemon,
      quotaRule(1),
      recorder,
      store,
      () => NOW,
    );
    expect(await enf2.handlePermission('s2', permEvent('execute', 'r2'))).toBe(
      true,
    );
    expect(votes).toHaveLength(1);
    expect(await wal.load()).toHaveLength(1);
    expect(store.remaining('q', NOW)).toBe(0);
  });
});

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CANCEL_VOTE_SENTINEL,
  MultiClientPermissionMediator,
  type MediatorDeps,
  type PermissionAuditPublisher,
  type PermissionDecisionReason,
} from './permissionMediator.js';
import {
  type PermissionPolicy,
  type PermissionRequestRecord,
  type PermissionResolution,
  type PermissionVote,
  type PermissionVoteOutcome,
} from './permission.js';
import { type BridgeEvent } from './eventBus.js';
import {
  CancelSentinelCollisionError,
  InvalidPermissionOptionError,
} from './bridgeErrors.js';

interface AuditCall {
  readonly kind: 'requested' | 'voted' | 'forbidden' | 'resolved' | 'timeout';
  readonly args: readonly unknown[];
}

function makeRecordingAudit(): {
  audit: PermissionAuditPublisher;
  calls: AuditCall[];
} {
  const calls: AuditCall[] = [];
  const audit: PermissionAuditPublisher = {
    recordRequested(record, policy, votersAtIssue) {
      calls.push({
        kind: 'requested',
        args: [record, policy, votersAtIssue],
      });
    },
    recordVoted(record, vote, outcome) {
      calls.push({ kind: 'voted', args: [record, vote, outcome] });
    },
    recordForbidden(record, vote, reason) {
      calls.push({ kind: 'forbidden', args: [record, vote, reason] });
    },
    recordResolved(record, resolution, decisionReason) {
      calls.push({
        kind: 'resolved',
        args: [record, resolution, decisionReason],
      });
    },
    recordTimeout(record) {
      calls.push({ kind: 'timeout', args: [record] });
    },
  };
  return { audit, calls };
}

interface EmitCall {
  readonly sessionId: string;
  readonly event: Omit<BridgeEvent, 'id' | 'v'>;
}

function makeRecordingEmit(): {
  emit: MediatorDeps['emit'];
  events: EmitCall[];
} {
  const events: EmitCall[] = [];
  const emit: MediatorDeps['emit'] = (sessionId, event) => {
    events.push({ sessionId, event });
  };
  return { emit, events };
}

function makeRecord(
  overrides: Partial<PermissionRequestRecord> = {},
): PermissionRequestRecord {
  return {
    requestId: overrides.requestId ?? 'req-1',
    sessionId: overrides.sessionId ?? 'sess-1',
    originatorClientId:
      'originatorClientId' in overrides
        ? overrides.originatorClientId
        : 'client_A',
    allowedOptionIds:
      overrides.allowedOptionIds ??
      new Set(['proceed_once', 'proceed_always', 'reject_once']),
    issuedAtMs: overrides.issuedAtMs ?? 1_000_000,
  };
}

function makeVote(overrides: Partial<PermissionVote> = {}): PermissionVote {
  return {
    requestId: overrides.requestId ?? 'req-1',
    sessionId: overrides.sessionId ?? 'sess-1',
    clientId: 'clientId' in overrides ? overrides.clientId : 'client_A',
    optionId: overrides.optionId ?? 'proceed_once',
    receivedAtMs: overrides.receivedAtMs ?? 1_000_010,
    fromLoopback: overrides.fromLoopback ?? false,
  };
}

function makeMediator(
  policy: PermissionPolicy = 'first-responder',
  voters: ReadonlySet<string> = new Set(['client_A', 'client_B', 'client_C']),
) {
  const { audit, calls } = makeRecordingAudit();
  const { emit, events } = makeRecordingEmit();
  const deps: MediatorDeps = {
    emit,
    audit,
    now: () => 1_000_000,
    votersForSession: () => voters,
  };
  const mediator = new MultiClientPermissionMediator(policy, deps);
  return { mediator, deps, audit, calls, emit, events };
}

describe('MultiClientPermissionMediator — first-responder', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('synchronously registers pending in `request()` (N1 invariant)', () => {
    const { mediator } = makeMediator();
    const record = makeRecord();

    // The Promise returned by request() must be already-pending; the
    // pending entry must be visible to peekSessionFor BEFORE we await.
    void mediator.request(record, 5_000);

    // No await between request() and peekSessionFor; the pending must
    // be in the map synchronously.
    expect(mediator.peekSessionFor(record.requestId)).toBe(record.sessionId);
  });

  it('resolves on first valid vote and emits permission_resolved with voter clientId as originator (O8)', async () => {
    const { mediator, calls, events } = makeMediator();
    const record = makeRecord();
    const promise = mediator.request(record, 5_000);

    const outcome = mediator.vote(makeVote({ clientId: 'client_B' }));
    expect(outcome).toEqual({
      kind: 'resolved',
      resolvedOptionId: 'proceed_once',
    });

    const resolution = await promise;
    expect(resolution).toEqual({ kind: 'option', optionId: 'proceed_once' });

    // Emitted exactly one permission_resolved event for the session.
    // O8 INVARIANT: originatorClientId is the VOTER's clientId, not the
    // prompt originator. This is a documented pre-F3 inconsistency
    // (permission_request stamps prompt-originator; permission_resolved
    // stamps voter). F3 deliberately preserves it for wire compat.
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      sessionId: 'sess-1',
      event: {
        type: 'permission_resolved',
        data: {
          requestId: 'req-1',
          outcome: { outcome: 'selected', optionId: 'proceed_once' },
        },
        originatorClientId: 'client_B',
      },
    });

    // Audit trail: requested → voted → resolved.
    expect(calls.map((c) => c.kind)).toEqual([
      'requested',
      'voted',
      'resolved',
    ]);

    const resolvedCall = calls[2]!;
    const decisionReason = resolvedCall.args[2] as PermissionDecisionReason;
    expect(decisionReason).toEqual({
      type: 'first-responder',
      resolverClientId: 'client_B',
    });
  });

  it('omits originatorClientId on permission_resolved when voter has no clientId', async () => {
    const { mediator, events } = makeMediator();
    const record = makeRecord();
    const promise = mediator.request(record, 5_000);

    mediator.vote(makeVote({ clientId: undefined }));
    await promise;

    // Loopback voter without X-Qwen-Client-Id — pre-F3 spread guard
    // omits the field entirely (not `originatorClientId: undefined`).
    expect(events).toHaveLength(1);
    expect(events[0]!.event).not.toHaveProperty('originatorClientId');
  });

  it('returns already_resolved on a duplicate vote and re-emits the SSE notification', async () => {
    const { mediator, events } = makeMediator();
    const record = makeRecord();
    const promise = mediator.request(record, 5_000);

    mediator.vote(makeVote({ clientId: 'client_A' }));
    await promise;

    // Late voter — same requestId, different clientId.
    const outcome = mediator.vote(
      makeVote({ clientId: 'client_C', optionId: 'proceed_always' }),
    );
    expect(outcome).toEqual({
      kind: 'already_resolved',
      resolvedOptionId: 'proceed_once',
    });

    // First permission_resolved + a re-emitted permission_already_resolved
    // for the late voter. The replayed event does NOT carry
    // `originatorClientId` — pre-F3 publishPermissionAlreadyResolved
    // omitted the field and `httpAcpBridge.test.ts:2880` enshrines
    // that wire shape. Resolver attribution lives in audit only.
    expect(events.map((e) => e.event.type)).toEqual([
      'permission_resolved',
      'permission_already_resolved',
    ]);
    const lateEvent = events[1]!;
    expect(lateEvent.event.data).toEqual({
      requestId: 'req-1',
      sessionId: 'sess-1',
      outcome: { outcome: 'selected', optionId: 'proceed_once' },
    });
    expect(lateEvent.event).not.toHaveProperty('originatorClientId');
  });

  it('returns unknown_request when the requestId was never seen', () => {
    const { mediator } = makeMediator();
    const outcome = mediator.vote(makeVote({ requestId: 'nonexistent' }));
    expect(outcome).toEqual({ kind: 'unknown_request' });
  });

  it('rejects cross-session votes as unknown_request', async () => {
    const { mediator } = makeMediator();
    const record = makeRecord();
    void mediator.request(record, 5_000);

    const outcome = mediator.vote(makeVote({ sessionId: 'sess-other' }));
    expect(outcome).toEqual({ kind: 'unknown_request' });
  });

  it('throws InvalidPermissionOptionError when optionId is not in the allow set', () => {
    const { mediator } = makeMediator();
    const record = makeRecord();
    void mediator.request(record, 5_000);

    expect(() =>
      mediator.vote(makeVote({ optionId: 'proceed_always_forged' })),
    ).toThrow(InvalidPermissionOptionError);
  });
});

describe('MultiClientPermissionMediator — voter cancel sentinel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves cancelled on cancel sentinel regardless of policy', async () => {
    for (const policy of [
      'first-responder',
      'designated',
      'consensus',
      'local-only',
    ] as const satisfies readonly PermissionPolicy[]) {
      const { mediator, events, calls } = makeMediator(policy);
      const record = makeRecord();
      const promise = mediator.request(record, 5_000);

      const outcome = mediator.vote(
        makeVote({ optionId: CANCEL_VOTE_SENTINEL }),
      );
      expect(outcome).toEqual({
        kind: 'resolved',
        resolvedOptionId: CANCEL_VOTE_SENTINEL,
      });

      const resolution = await promise;
      expect(resolution).toEqual({
        kind: 'cancelled',
        reason: 'agent_cancelled',
      });

      expect(events.map((e) => e.event.type)).toEqual(['permission_resolved']);
      expect(events[0]!.event.data).toMatchObject({
        outcome: { outcome: 'cancelled' },
      });
      expect(events[0]!.event.originatorClientId).toBe('client_A');

      const decisionReason = calls.find((c) => c.kind === 'resolved')!
        .args[2] as PermissionDecisionReason;
      expect(decisionReason).toEqual({
        type: 'voter-cancelled',
        resolverClientId: 'client_A',
      });
    }
  });

  it('does NOT validate cancel sentinel against allowedOptionIds', () => {
    // The bridge constructs the sentinel from `{outcome:'cancelled'}` which
    // never carries an optionId; the mediator must accept it without
    // checking the allow set.
    const { mediator } = makeMediator();
    const record = makeRecord({
      allowedOptionIds: new Set(['proceed_once']),
    });
    void mediator.request(record, 5_000);

    expect(() =>
      mediator.vote(makeVote({ optionId: CANCEL_VOTE_SENTINEL })),
    ).not.toThrow();
  });

  // Wenshao review #4335 / 3271978359 — the existing
  // `resolves cancelled on cancel sentinel regardless of policy`
  // test uses a voter (`client_A`) that would be ACCEPTED by every
  // policy: it's the prompt originator under designated and is in
  // votersAtIssue under consensus. The cross-policy guarantee only
  // matters for voters who would otherwise be REJECTED — these two
  // adversarial cases lock in the cross-policy escape hatch
  // semantics described on the CANCEL_VOTE_SENTINEL JSDoc.
  it('cancel sentinel resolves under `designated` even when voter is NOT the originator', async () => {
    const { mediator, events } = makeMediator('designated');
    const record = makeRecord(); // originator = 'client_A'
    const promise = mediator.request(record, 5_000);

    // A normal `proceed_once` vote from client_B would be
    // forbidden:designated_mismatch — but cancel must still resolve.
    const outcome = mediator.vote(
      makeVote({ clientId: 'client_B', optionId: CANCEL_VOTE_SENTINEL }),
    );
    expect(outcome).toEqual({
      kind: 'resolved',
      resolvedOptionId: CANCEL_VOTE_SENTINEL,
    });
    const resolution = await promise;
    expect(resolution).toEqual({
      kind: 'cancelled',
      reason: 'agent_cancelled',
    });
    expect(events.map((e) => e.event.type)).toEqual(['permission_resolved']);
  });

  it('cancel sentinel resolves under `consensus` even when voter is NOT in votersAtIssue', async () => {
    const { mediator, events } = makeMediator(
      'consensus',
      // votersAtIssue snapshot does NOT contain client_late_join
      new Set(['client_A', 'client_B']),
    );
    const record = makeRecord();
    const promise = mediator.request(record, 5_000);

    // A normal `proceed_once` vote from a non-snapshot voter would
    // be forbidden:designated_mismatch — but cancel must still resolve.
    const outcome = mediator.vote(
      makeVote({
        clientId: 'client_late_join',
        optionId: CANCEL_VOTE_SENTINEL,
      }),
    );
    expect(outcome).toEqual({
      kind: 'resolved',
      resolvedOptionId: CANCEL_VOTE_SENTINEL,
    });
    const resolution = await promise;
    expect(resolution).toEqual({
      kind: 'cancelled',
      reason: 'agent_cancelled',
    });
    expect(events.map((e) => e.event.type)).toEqual(['permission_resolved']);
  });

  it('rejects request() at issue time when allowedOptionIds collides with cancel sentinel', () => {
    // Collision defense (Commit 1 review I1): if the agent's allow
    // set legitimately contains '__cancelled__', the mediator can no
    // longer disambiguate a real vote on that option from a cancel
    // intent. Fail loud at request() rather than silently flipping
    // a real approval to cancel later.
    const { mediator } = makeMediator();
    const record = makeRecord({
      allowedOptionIds: new Set(['proceed_once', CANCEL_VOTE_SENTINEL]),
    });
    expect(() => mediator.request(record, 5_000)).toThrow(
      CancelSentinelCollisionError,
    );

    // The mediator state must remain clean after the throw — no
    // pending entry leaked.
    expect(mediator.peekSessionFor('req-1')).toBeUndefined();
  });
});

describe('MultiClientPermissionMediator — forgetSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancels every pending request matching the session', async () => {
    const { mediator, events } = makeMediator();
    const recordA = makeRecord({ requestId: 'req-A', sessionId: 'sess-1' });
    const recordB = makeRecord({ requestId: 'req-B', sessionId: 'sess-1' });
    const recordOther = makeRecord({
      requestId: 'req-C',
      sessionId: 'sess-2',
    });
    const promiseA = mediator.request(recordA, 5_000);
    const promiseB = mediator.request(recordB, 5_000);
    const promiseOther = mediator.request(recordOther, 5_000);

    mediator.forgetSession('sess-1');

    const [resA, resB] = await Promise.all([promiseA, promiseB]);
    expect(resA).toEqual({ kind: 'cancelled', reason: 'session_closed' });
    expect(resB).toEqual({ kind: 'cancelled', reason: 'session_closed' });

    // The other session's pending stays alive.
    expect(mediator.peekSessionFor('req-C')).toBe('sess-2');

    // Two permission_resolved emits, both for sess-1.
    const sess1Events = events.filter((e) => e.sessionId === 'sess-1');
    expect(sess1Events).toHaveLength(2);
    expect(sess1Events.map((e) => e.event.type)).toEqual([
      'permission_resolved',
      'permission_resolved',
    ]);

    // Resolve the third so promise doesn't dangle.
    mediator.vote(
      makeVote({
        requestId: 'req-C',
        sessionId: 'sess-2',
        optionId: 'proceed_once',
      }),
    );
    await promiseOther;
  });

  it('is idempotent — second call is a no-op', () => {
    const { mediator, events } = makeMediator();
    const record = makeRecord();
    void mediator.request(record, 5_000);

    mediator.forgetSession('sess-1');
    const eventsAfterFirst = events.length;

    mediator.forgetSession('sess-1');
    expect(events.length).toBe(eventsAfterFirst);
  });

  it('does not affect resolved entries (already-decided permissions stay queryable)', async () => {
    const { mediator } = makeMediator();
    const record = makeRecord();
    const promise = mediator.request(record, 5_000);
    mediator.vote(makeVote());
    await promise;

    mediator.forgetSession('sess-1');

    // peekSessionFor still works for the resolved record (legacy
    // bridge.respondToPermission relies on this for the
    // permission_already_resolved fallback).
    expect(mediator.peekSessionFor('req-1')).toBe('sess-1');
  });
});

describe('MultiClientPermissionMediator — timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves cancelled when the timer fires before any vote', async () => {
    const { mediator, events, calls } = makeMediator();
    const record = makeRecord();
    const promise = mediator.request(record, 5_000);

    vi.advanceTimersByTime(5_000);

    const resolution = await promise;
    expect(resolution).toEqual({ kind: 'cancelled', reason: 'timeout' });

    // Timer-driven resolution has no voter — `permission_resolved`
    // must omit `originatorClientId` rather than spread `undefined`.
    expect(events).toHaveLength(1);
    expect(events[0]!.event.type).toBe('permission_resolved');
    expect(events[0]!.event).not.toHaveProperty('originatorClientId');

    expect(calls.map((c) => c.kind)).toEqual([
      'requested',
      'timeout',
      'resolved',
    ]);

    const resolvedCall = calls[2]!;
    const decisionReason = resolvedCall.args[2] as PermissionDecisionReason;
    expect(decisionReason).toMatchObject({
      type: 'timeout',
      issuedAtMs: 1_000_000,
      timeoutMs: 5_000,
    });
    expect((decisionReason as { firedAtMs: number }).firedAtMs).toBe(1_000_000);
  });

  it('clears the timer when the entry resolves via vote', async () => {
    const { mediator, calls } = makeMediator();
    const record = makeRecord();
    const promise = mediator.request(record, 5_000);

    mediator.vote(makeVote());
    await promise;

    // Fast-forward — the cleared timer must NOT fire.
    vi.advanceTimersByTime(10_000);

    expect(calls.some((c) => c.kind === 'timeout')).toBe(false);
  });

  // Wenshao review #4335 / 3270622304 — pre-F3 wrote a stderr line on
  // every permission timeout; F3's mediator timer must preserve that
  // breadcrumb so operators tailing daemon stderr still see timeouts
  // even when the audit publisher is the no-op fallback (embedded
  // callers / unit tests).
  it('writes a stderr breadcrumb when the timer fires', async () => {
    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
      });
    try {
      const { mediator } = makeMediator();
      const record = makeRecord();
      const promise = mediator.request(record, 5_000);
      vi.advanceTimersByTime(5_000);
      await promise;

      const breadcrumb = writes.find((w) =>
        w.includes('timed out after 5000ms'),
      );
      expect(breadcrumb).toBeDefined();
      expect(breadcrumb).toContain('req-1');
      expect(breadcrumb).toContain('sess-1');
    } finally {
      writeSpy.mockRestore();
    }
  });
});

describe('MultiClientPermissionMediator — peekSessionFor', () => {
  it('returns undefined for unknown requestIds', () => {
    const { mediator } = makeMediator();
    expect(mediator.peekSessionFor('never-seen')).toBeUndefined();
  });

  it('returns sessionId for pending and resolved alike', async () => {
    const { mediator } = makeMediator();
    const record = makeRecord();
    const promise = mediator.request(record, 5_000);
    expect(mediator.peekSessionFor('req-1')).toBe('sess-1');

    mediator.vote(makeVote());
    await promise;
    expect(mediator.peekSessionFor('req-1')).toBe('sess-1');
  });
});

describe('MultiClientPermissionMediator — designated', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves when the originator votes', async () => {
    const { mediator, calls } = makeMediator('designated');
    const record = makeRecord({ originatorClientId: 'client_A' });
    const promise = mediator.request(record, 5_000);
    const outcome = mediator.vote(makeVote({ clientId: 'client_A' }));
    expect(outcome).toEqual({
      kind: 'resolved',
      resolvedOptionId: 'proceed_once',
    });
    await promise;
    const decisionReason = calls.find((c) => c.kind === 'resolved')!
      .args[2] as PermissionDecisionReason;
    expect(decisionReason).toEqual({
      type: 'designated-originator',
      originatorClientId: 'client_A',
    });
  });

  it('rejects votes from non-originators with permission_forbidden', async () => {
    const { mediator, events, calls } = makeMediator('designated');
    const record = makeRecord({ originatorClientId: 'client_A' });
    const promise = mediator.request(record, 5_000);
    const outcome = mediator.vote(makeVote({ clientId: 'client_B' }));
    expect(outcome).toEqual({
      kind: 'forbidden',
      reason: 'designated_mismatch',
    });
    expect(events.map((e) => e.event.type)).toEqual(['permission_forbidden']);
    expect(events[0]!.event.data).toEqual({
      requestId: 'req-1',
      sessionId: 'sess-1',
      clientId: 'client_B',
      reason: 'designated_mismatch',
    });
    expect(events[0]!.event.originatorClientId).toBe('client_A');
    expect(calls.find((c) => c.kind === 'forbidden')).toBeDefined();
    // The pending must still be alive after a forbidden vote.
    expect(mediator.peekSessionFor('req-1')).toBe('sess-1');
    mediator.forgetSession('sess-1');
    await promise;
  });

  it('falls back to first-responder when prompt has no originator (anonymous)', async () => {
    const { mediator, calls } = makeMediator('designated');
    const record = makeRecord({ originatorClientId: undefined });
    const promise = mediator.request(record, 5_000);
    const outcome = mediator.vote(makeVote({ clientId: 'client_C' }));
    expect(outcome).toEqual({
      kind: 'resolved',
      resolvedOptionId: 'proceed_once',
    });
    await promise;
    const decisionReason = calls.find((c) => c.kind === 'resolved')!
      .args[2] as PermissionDecisionReason;
    expect(decisionReason).toEqual({
      type: 'first-responder',
      resolverClientId: 'client_C',
    });
  });
});

describe('MultiClientPermissionMediator — consensus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves on first option to reach quorum (M=3, default N=2)', async () => {
    const { mediator, events, calls } = makeMediator(
      'consensus',
      new Set(['client_A', 'client_B', 'client_C']),
    );
    const record = makeRecord();
    const promise = mediator.request(record, 5_000);

    const v1 = mediator.vote(makeVote({ clientId: 'client_A' }));
    expect(v1).toEqual({ kind: 'recorded', votesNeeded: 1 });
    expect(events.map((e) => e.event.type)).toEqual([
      'permission_partial_vote',
    ]);
    expect(events[0]!.event.data).toEqual({
      requestId: 'req-1',
      sessionId: 'sess-1',
      votesReceived: 1,
      votesNeeded: 1,
      quorum: 2,
      optionTallies: { proceed_once: 1 },
    });

    const v2 = mediator.vote(makeVote({ clientId: 'client_B' }));
    expect(v2).toEqual({
      kind: 'resolved',
      resolvedOptionId: 'proceed_once',
    });
    await promise;

    expect(events.map((e) => e.event.type)).toEqual([
      'permission_partial_vote',
      'permission_resolved',
    ]);

    const decisionReason = calls.find((c) => c.kind === 'resolved')!
      .args[2] as PermissionDecisionReason;
    expect(decisionReason).toEqual({
      type: 'consensus-quorum',
      resolvedOptionId: 'proceed_once',
      quorum: 2,
      tally: 2,
    });
  });

  it('keeps the original vote on idempotent re-vote (no tally change, no partial_vote re-emit)', async () => {
    const { mediator, events } = makeMediator(
      'consensus',
      new Set(['client_A', 'client_B', 'client_C']),
    );
    const record = makeRecord();
    const promise = mediator.request(record, 5_000);

    mediator.vote(makeVote({ clientId: 'client_A', optionId: 'proceed_once' }));
    expect(events).toHaveLength(1);

    const v2 = mediator.vote(
      makeVote({ clientId: 'client_A', optionId: 'proceed_always' }),
    );
    expect(v2).toEqual({ kind: 'recorded', votesNeeded: 1 });
    expect(events).toHaveLength(1);

    mediator.vote(makeVote({ clientId: 'client_B', optionId: 'proceed_once' }));
    await promise;
  });

  // Wenshao review #4335 / 3271041464 — when a voter's idempotent
  // re-vote attempts a different optionId, the audit ring must
  // record the ORIGINALLY-voted option (the one in the tally), not
  // the new attempt. Otherwise an operator reading the audit trail
  // sees `client_A voted for option_B` while the tally has client_A
  // in option_A's bucket — a misleading record of a vote that
  // never counted.
  it('records the original optionId in audit on idempotent re-vote (3271041464)', async () => {
    const { mediator, calls } = makeMediator(
      'consensus',
      new Set(['client_A', 'client_B', 'client_C']),
    );
    const record = makeRecord();
    const promise = mediator.request(record, 5_000);

    // Original vote: client_A → proceed_once.
    mediator.vote(makeVote({ clientId: 'client_A', optionId: 'proceed_once' }));

    // Re-vote attempt: client_A → proceed_always (silently kept as
    // proceed_once in the tally; SHOULD be audited as proceed_once).
    mediator.vote(
      makeVote({ clientId: 'client_A', optionId: 'proceed_always' }),
    );

    // Resolve to terminate the test cleanly.
    mediator.vote(makeVote({ clientId: 'client_B', optionId: 'proceed_once' }));
    await promise;

    // Two `voted` audit calls fired (one per vote attempt). The
    // first records the original option as cast; the second records
    // the original option even though the wire attempt was different.
    const votedCalls = calls.filter((c) => c.kind === 'voted');
    expect(votedCalls).toHaveLength(3); // client_A original, client_A re-vote, client_B winning vote
    // First call — straightforward: client_A cast proceed_once.
    expect((votedCalls[0]!.args[1] as { optionId: string }).optionId).toBe(
      'proceed_once',
    );
    // Second call — the idempotent re-vote case: the audit must show
    // proceed_once (the option in the tally), NOT proceed_always
    // (the attempted re-vote). This is the regression-guard the
    // pre-fix code violated.
    expect((votedCalls[1]!.args[1] as { optionId: string }).optionId).toBe(
      'proceed_once',
    );
  });

  it('rejects anonymous voter with permission_forbidden', () => {
    const { mediator, events } = makeMediator(
      'consensus',
      new Set(['client_A', 'client_B', 'client_C']),
    );
    const record = makeRecord();
    void mediator.request(record, 5_000);

    const v = mediator.vote(makeVote({ clientId: undefined }));
    expect(v).toEqual({ kind: 'forbidden', reason: 'designated_mismatch' });
    expect(events.map((e) => e.event.type)).toEqual(['permission_forbidden']);
    // I-4 (Commit 4 review) — N3 invariant: forbidden event stamps
    // the prompt originator, not the rejected voter.
    expect(events[0]!.event.originatorClientId).toBe('client_A');
    // Anonymous voter — `clientId` MUST NOT appear on the data
    // object (no field rather than `clientId: undefined`).
    expect(events[0]!.event.data).not.toHaveProperty('clientId');
    mediator.forgetSession('sess-1');
  });

  it('rejects voter not in votersAtIssue snapshot', () => {
    const { mediator, events } = makeMediator(
      'consensus',
      new Set(['client_A', 'client_B']),
    );
    const record = makeRecord();
    void mediator.request(record, 5_000);

    const v = mediator.vote(makeVote({ clientId: 'client_late_join' }));
    expect(v).toEqual({ kind: 'forbidden', reason: 'designated_mismatch' });
    expect(events.map((e) => e.event.type)).toEqual(['permission_forbidden']);
    // I-4 (Commit 4 review) — prompt originator on N3 forbidden event.
    expect(events[0]!.event.originatorClientId).toBe('client_A');
    expect(events[0]!.event.data).toMatchObject({
      clientId: 'client_late_join',
      reason: 'designated_mismatch',
    });
    mediator.forgetSession('sess-1');
  });

  // Wenshao review #4335 / 3272568031 — `writeForbiddenStderr` has 3
  // call sites (voteDesignated / voteConsensus / voteLocalOnly) but
  // before this commit only the SSE event + audit record were tested.
  // Pin the stderr breadcrumb format and presence so a refactor can't
  // silently drop it.
  it('writes stderr breadcrumbs for all 3 forbidden-vote paths', () => {
    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
      });
    try {
      // 1. designated — non-originator voter rejected.
      {
        const { mediator } = makeMediator('designated');
        void mediator.request(makeRecord(), 5_000);
        mediator.vote(makeVote({ clientId: 'client_B' }));
        mediator.forgetSession('sess-1');
      }
      // 2. consensus — voter not in votersAtIssue rejected.
      {
        const { mediator } = makeMediator(
          'consensus',
          new Set(['client_A', 'client_B']),
        );
        void mediator.request(makeRecord(), 5_000);
        mediator.vote(makeVote({ clientId: 'client_late_join' }));
        mediator.forgetSession('sess-1');
      }
      // 3. local-only — non-loopback voter rejected.
      {
        const { mediator } = makeMediator('local-only');
        void mediator.request(makeRecord(), 5_000);
        mediator.vote(
          makeVote({ clientId: 'client_remote', fromLoopback: false }),
        );
        mediator.forgetSession('sess-1');
      }

      const breadcrumbs = writes.filter((w) => w.includes('vote rejected'));
      expect(breadcrumbs).toHaveLength(3);
      expect(breadcrumbs[0]).toContain('designated_mismatch');
      expect(breadcrumbs[0]).toContain('voter is not the prompt originator');
      expect(breadcrumbs[1]).toContain('designated_mismatch');
      expect(breadcrumbs[1]).toContain('not in consensus votersAtIssue');
      expect(breadcrumbs[2]).toContain('remote_not_allowed');
      expect(breadcrumbs[2]).toContain('local-only policy');
      // Each breadcrumb names the requestId + sessionId for grep-ability.
      for (const b of breadcrumbs) {
        expect(b).toContain('req-1');
        expect(b).toContain('sess-1');
      }
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('M=4 N=3 split 2-2 never resolves and times out', async () => {
    // I-5 (Commit 4 review) — explicitly cover the
    // "no winner; only cancel via timeout / forgetSession" case
    // that the M=3 N=2 property test cannot reach.
    const { mediator } = makeMediator(
      'consensus',
      new Set(['client_A', 'client_B', 'client_C', 'client_D']),
    );
    const record = makeRecord();
    const promise = mediator.request(record, 5_000);

    mediator.vote(makeVote({ clientId: 'client_A', optionId: 'proceed_once' }));
    mediator.vote(makeVote({ clientId: 'client_B', optionId: 'proceed_once' }));
    mediator.vote(
      makeVote({ clientId: 'client_C', optionId: 'proceed_always' }),
    );
    const v4 = mediator.vote(
      makeVote({ clientId: 'client_D', optionId: 'proceed_always' }),
    );
    // Quorum N = floor(4/2)+1 = 3. Top tally is 2/2 split. No winner.
    expect(v4).toEqual({ kind: 'recorded', votesNeeded: 1 });

    // Timeout fires → cancelled.
    vi.advanceTimersByTime(5_000);
    const resolution = await promise;
    expect(resolution).toEqual({ kind: 'cancelled', reason: 'timeout' });
  });

  it('honors consensusQuorum override capped at M', async () => {
    const { audit } = makeRecordingAudit();
    const { emit } = makeRecordingEmit();
    const deps: MediatorDeps = {
      emit,
      audit,
      consensusQuorum: 100,
      now: () => 1_000_000,
      votersForSession: () => new Set(['client_A', 'client_B', 'client_C']),
    };
    const mediator = new MultiClientPermissionMediator('consensus', deps);
    const record = makeRecord();
    const promise = mediator.request(record, 5_000);

    mediator.vote(makeVote({ clientId: 'client_A' }));
    mediator.vote(makeVote({ clientId: 'client_B' }));
    const v3 = mediator.vote(makeVote({ clientId: 'client_C' }));
    expect(v3).toEqual({ kind: 'resolved', resolvedOptionId: 'proceed_once' });
    await promise;
  });

  it('property-style: enumerate vote interleavings for M=3 N=2 — first option to N wins', async () => {
    const voters = ['client_A', 'client_B', 'client_C'];
    const options: ReadonlyArray<'option_yes' | 'option_no'> = [
      'option_yes',
      'option_no',
    ];
    for (let assignmentMask = 0; assignmentMask < 8; assignmentMask++) {
      const assignments = voters.map((_, idx) =>
        ((assignmentMask >> idx) & 1) === 1 ? options[0] : options[1],
      );
      const orderings: Array<[number, number, number]> = [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
      ];
      for (const order of orderings) {
        const { mediator } = makeMediator('consensus', new Set(voters));
        const record = makeRecord({
          requestId: `req-prop-${assignmentMask}-${order.join('')}`,
          allowedOptionIds: new Set(options),
        });
        const promise = mediator.request(record, 5_000);

        let referenceWinner: string | null = null;
        const refTally = new Map<string, Set<string>>();
        const recordedOutcomes: PermissionVoteOutcome[] = [];
        for (const idx of order) {
          const voter = voters[idx]!;
          const option = assignments[idx]!;
          if (referenceWinner === null) {
            let set = refTally.get(option);
            if (!set) {
              set = new Set();
              refTally.set(option, set);
            }
            set.add(voter);
            if (set.size >= 2) referenceWinner = option;
          }
          const outcome = mediator.vote({
            requestId: record.requestId,
            sessionId: record.sessionId,
            clientId: voter,
            optionId: option,
            receivedAtMs: 0,
            fromLoopback: false,
          });
          recordedOutcomes.push(outcome);
          if (outcome.kind === 'resolved') break;
        }

        const mediatorWinner = recordedOutcomes.find(
          (o) => o.kind === 'resolved',
        ) as { kind: 'resolved'; resolvedOptionId: string } | undefined;
        if (referenceWinner !== null) {
          expect(mediatorWinner).toBeDefined();
          expect(mediatorWinner!.resolvedOptionId).toBe(referenceWinner);
          await promise;
        } else {
          mediator.forgetSession(record.sessionId);
          await promise;
        }
      }
    }
  });

  it('emits permission_partial_vote BEFORE permission_resolved (ordering invariant)', async () => {
    const { mediator, events } = makeMediator(
      'consensus',
      new Set(['client_A', 'client_B', 'client_C']),
    );
    const record = makeRecord();
    const promise = mediator.request(record, 5_000);
    mediator.vote(makeVote({ clientId: 'client_A' }));
    mediator.vote(makeVote({ clientId: 'client_B' }));
    await promise;
    const types = events.map((e) => e.event.type);
    const partialIdx = types.indexOf('permission_partial_vote');
    const resolvedIdx = types.indexOf('permission_resolved');
    expect(partialIdx).toBeGreaterThanOrEqual(0);
    expect(resolvedIdx).toBeGreaterThan(partialIdx);
  });
});

describe('MultiClientPermissionMediator — local-only', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves on a loopback vote', async () => {
    const { mediator, calls } = makeMediator('local-only');
    const record = makeRecord();
    const promise = mediator.request(record, 5_000);
    const outcome = mediator.vote(makeVote({ fromLoopback: true }));
    expect(outcome).toEqual({
      kind: 'resolved',
      resolvedOptionId: 'proceed_once',
    });
    await promise;
    const decisionReason = calls.find((c) => c.kind === 'resolved')!
      .args[2] as PermissionDecisionReason;
    expect(decisionReason).toEqual({
      type: 'local-only-loopback',
      resolverClientId: 'client_A',
    });
  });

  it('rejects a non-loopback vote with permission_forbidden / remote_not_allowed', async () => {
    // Use a distinct prompt originator from the voter so the N3
    // stamping invariant is observable (I-4 Commit 4 review).
    const { mediator, events, calls } = makeMediator('local-only');
    const record = makeRecord({ originatorClientId: 'client_PROMPT' });
    const promise = mediator.request(record, 5_000);
    const outcome = mediator.vote(makeVote({ fromLoopback: false }));
    expect(outcome).toEqual({
      kind: 'forbidden',
      reason: 'remote_not_allowed',
    });
    expect(events.map((e) => e.event.type)).toEqual(['permission_forbidden']);
    expect(events[0]!.event.data).toEqual({
      requestId: 'req-1',
      sessionId: 'sess-1',
      clientId: 'client_A',
      reason: 'remote_not_allowed',
    });
    // I-4 (Commit 4 review) — N3 invariant: forbidden event stamps
    // the prompt originator (`client_PROMPT`), NOT the rejected
    // voter (`client_A`).
    expect(events[0]!.event.originatorClientId).toBe('client_PROMPT');
    expect(calls.find((c) => c.kind === 'forbidden')).toBeDefined();
    mediator.forgetSession('sess-1');
    await promise;
  });
});

describe('MultiClientPermissionMediator — N2 cleanup ordering', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves the Promise even when emit throws', async () => {
    const { audit } = makeRecordingAudit();
    const emit = vi.fn(() => {
      throw new Error('bus closed during shutdown');
    });
    const deps: MediatorDeps = {
      emit,
      audit,
      now: () => 0,
      votersForSession: () => new Set(['client_A']),
    };
    const mediator = new MultiClientPermissionMediator('first-responder', deps);
    const record = makeRecord();
    const promise = mediator.request(record, 5_000);

    mediator.vote(makeVote());

    const resolution: PermissionResolution = await promise;
    expect(resolution).toEqual({ kind: 'option', optionId: 'proceed_once' });

    // Pending must have been deleted despite emit throwing.
    expect(mediator.peekSessionFor('req-1')).toBe('sess-1');
    const dupOutcome: PermissionVoteOutcome = mediator.vote(makeVote());
    expect(dupOutcome.kind).toBe('already_resolved');
  });

  it('resolves the Promise even when audit throws on recordRequested + recordResolved', async () => {
    const audit: PermissionAuditPublisher = {
      recordRequested: vi.fn(() => {
        throw new Error('audit ring full');
      }),
      recordVoted: vi.fn(),
      recordForbidden: vi.fn(),
      recordResolved: vi.fn(() => {
        throw new Error('audit ring full');
      }),
      recordTimeout: vi.fn(),
    };
    const { emit } = makeRecordingEmit();
    const deps: MediatorDeps = {
      emit,
      audit,
      now: () => 0,
      votersForSession: () => new Set(['client_A']),
    };
    const mediator = new MultiClientPermissionMediator('first-responder', deps);
    const record = makeRecord();
    const promise = mediator.request(record, 5_000);

    mediator.vote(makeVote());
    const resolution = await promise;
    expect(resolution).toEqual({ kind: 'option', optionId: 'proceed_once' });
  });

  it('resolves the Promise even when audit.recordVoted throws (vote path)', async () => {
    const audit: PermissionAuditPublisher = {
      recordRequested: vi.fn(),
      recordVoted: vi.fn(() => {
        throw new Error('audit publisher transient error');
      }),
      recordForbidden: vi.fn(),
      recordResolved: vi.fn(),
      recordTimeout: vi.fn(),
    };
    const { emit } = makeRecordingEmit();
    const deps: MediatorDeps = {
      emit,
      audit,
      now: () => 0,
      votersForSession: () => new Set(['client_A']),
    };
    const mediator = new MultiClientPermissionMediator('first-responder', deps);
    const record = makeRecord();
    const promise = mediator.request(record, 5_000);

    // Pre-fix bug: recordVoted threw before resolveEntry, leaving the
    // Promise hung. With safeAudit wrapping, vote() must still resolve.
    expect(() => mediator.vote(makeVote())).not.toThrow();
    const resolution = await promise;
    expect(resolution).toEqual({ kind: 'option', optionId: 'proceed_once' });
  });

  it('resolves the Promise even when audit.recordVoted throws (cancel sentinel path)', async () => {
    const audit: PermissionAuditPublisher = {
      recordRequested: vi.fn(),
      recordVoted: vi.fn(() => {
        throw new Error('audit publisher transient error');
      }),
      recordForbidden: vi.fn(),
      recordResolved: vi.fn(),
      recordTimeout: vi.fn(),
    };
    const { emit } = makeRecordingEmit();
    const deps: MediatorDeps = {
      emit,
      audit,
      now: () => 0,
      votersForSession: () => new Set(['client_A']),
    };
    const mediator = new MultiClientPermissionMediator('first-responder', deps);
    const record = makeRecord();
    const promise = mediator.request(record, 5_000);

    expect(() =>
      mediator.vote(makeVote({ optionId: CANCEL_VOTE_SENTINEL })),
    ).not.toThrow();
    const resolution = await promise;
    expect(resolution).toEqual({
      kind: 'cancelled',
      reason: 'agent_cancelled',
    });
  });

  it('resolves the Promise even when audit.recordTimeout throws (timeout path)', async () => {
    const audit: PermissionAuditPublisher = {
      recordRequested: vi.fn(),
      recordVoted: vi.fn(),
      recordForbidden: vi.fn(),
      recordResolved: vi.fn(),
      recordTimeout: vi.fn(() => {
        throw new Error('audit publisher transient error');
      }),
    };
    const { emit } = makeRecordingEmit();
    const deps: MediatorDeps = {
      emit,
      audit,
      now: () => 9_999,
      votersForSession: () => new Set(['client_A']),
    };
    const mediator = new MultiClientPermissionMediator('first-responder', deps);
    const record = makeRecord();
    const promise = mediator.request(record, 5_000);

    // Pre-fix bug: recordTimeout was naked inside the timer callback;
    // a throw left the Promise hung permanently and the pending entry
    // leaked. With safeAudit wrapping, the timeout still resolves.
    vi.advanceTimersByTime(5_000);
    const resolution = await promise;
    expect(resolution).toEqual({ kind: 'cancelled', reason: 'timeout' });
    expect(mediator.peekSessionFor('req-1')).toBe('sess-1');
  });
});

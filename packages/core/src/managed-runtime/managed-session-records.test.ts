/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  MANAGED_SESSION_DOMAINS,
  MANAGED_SESSION_LIFECYCLE_STATES,
  MANAGED_SESSION_LIMITS,
  ManagedSessionRecordError,
  assertManagedSessionEventActor,
  assertManagedSessionTransaction,
  isManagedSessionLifecycleTransitionAllowed,
  managedSessionEventsDigest,
  parseManagedSessionCommitMarker,
  parseManagedSessionEvent,
  parseManagedSessionHeader,
  parseManagedSessionRecordJson,
  type ManagedSessionActorClass,
  type ManagedSessionDurableRef,
  type ManagedSessionEvent,
  type ManagedSessionLifecycleState,
} from './managed-session-records.js';

const DIGEST = 'a'.repeat(64);

const sessionKey = { tenantId: 't1', workspaceId: 'w1', sessionId: 's1' };

type Expected = RegExp | typeof ManagedSessionRecordError;

function ref(kind = 'managed-test'): ManagedSessionDurableRef {
  return {
    resourceId: 'res-1',
    kind,
    schemaVersion: 1,
    byteLength: 4,
    digest: DIGEST,
  };
}

function inputEvent(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    v: 1,
    sequence: 1,
    eventId: 'evt-1',
    sessionKey,
    kind: 'input.accepted',
    occurredAt: 1_700_000_000_000,
    payload: {
      inputId: 'in-1',
      turnId: 'turn-1',
      source: 'web_shell',
      contentRef: ref(),
      deadline: null,
      admissionRef: ref(),
    },
    ...overrides,
  };
}

const activationSubject = {
  type: 'activation',
  scopeId: 'scope-1',
  activationId: 'act-1',
  epoch: 3,
};

const turnSubject = { type: 'turn', turnId: 'turn-1' };

function harnessEvent(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    v: 1,
    sequence: 2,
    eventId: 'evt-2',
    sessionKey,
    kind: 'model.attempt',
    occurredAt: 1_700_000_000_001,
    subject: activationSubject,
    payload: {
      attemptId: 'att-1',
      routeRef: ref(),
      inputCheckpointRef: null,
      state: 'started',
      usageRef: null,
    },
    ...overrides,
  };
}

function eventForKind(
  kind:
    | 'message.committed'
    | 'tool.intent'
    | 'tool.receipt'
    | 'checkpoint.committed'
    | 'context.compacted'
    | 'turn.settled'
    | 'config.bound',
): Record<string, unknown> {
  const payloads = {
    'message.committed': {
      messageId: 'msg-1',
      role: 'assistant',
      contentRef: ref(),
      modelAttemptId: null,
      parentMessageId: null,
    },
    'tool.intent': {
      executionCallId: 'call-1',
      batchId: 'batch-1',
      ordinal: 0,
      toolDefinitionRef: ref(),
      argsRef: ref(),
      outcomeSource: 'runtime',
    },
    'tool.receipt': {
      executionCallId: 'call-1',
      toolOutcomeRef: ref(),
      resultRef: null,
      resources: [],
      historyRevision: 0,
    },
    'checkpoint.committed': {
      checkpointId: 'checkpoint-1',
      coveredSequence: 1,
      previousCheckpointId: null,
      stateRef: ref(),
      boundary: null,
    },
    'context.compacted': {
      compactionId: 'compaction-1',
      fromSequence: 1,
      toSequence: 1,
      summaryRef: ref(),
      replacedMessageIds: [],
      tokenCountsRef: null,
    },
    'turn.settled': {
      turnId: 'turn-1',
      outcome: 'completed',
      stopReason: null,
      resultRef: null,
      usageRef: null,
      pendingOwnersRef: null,
    },
    'config.bound': {
      revision: 1,
      previousRevision: null,
      bundleRef: ref(),
      rootSnapshotRef: ref(),
    },
  } satisfies Record<string, Record<string, unknown>>;
  const needsActivation = new Set([
    'message.committed',
    'tool.intent',
    'checkpoint.committed',
    'context.compacted',
  ]);
  return {
    v: 1,
    sequence: 2,
    eventId: `evt-${kind}`,
    sessionKey,
    kind,
    occurredAt: 1_700_000_000_001,
    ...(needsActivation.has(kind) ? { subject: activationSubject } : {}),
    payload: payloads[kind],
  };
}

/** `event` with `patch` merged into its payload. */
function withPayload(
  event: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...event, payload: { ...(event['payload'] as object), ...patch } };
}

/** Envelope `{ v, sequence, eventId: evt-<sequence>, sessionKey, kind, occurredAt: 1, ...extra, payload }`. */
function envelope(
  kind: string,
  sequence: number,
  payload: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  const eventId = `evt-${sequence}`;
  return {
    v: 1,
    sequence,
    eventId,
    sessionKey,
    kind,
    occurredAt: 1,
    ...extra,
    payload,
  };
}

const cancelPayload = (target: unknown) => ({
  requestId: 'req-1',
  target,
  reason: 'test',
  requestedBy: 'user',
});

const wakeEvent = (overrides: Record<string, unknown> = {}) =>
  envelope('wake.requested', 2, {
    wakeId: 'wake-1',
    reason: 'input',
    subject: { type: 'turn', turnId: 'turn-1' },
    sourceEventId: 'evt-1',
    requiredSequence: 1,
    ...overrides,
  });

const activationEvent = (
  phase: string,
  overrides: Record<string, unknown> = {},
) =>
  envelope('activation.changed', 3, {
    activationId: 'act-1',
    epoch: 3,
    workerId: 'worker-1',
    subject: activationSubject,
    phase,
    leaseDurationMs: 60_000,
    expiresAt: 1_700_000_060_000,
    installRef: ref(),
    boundaryRef: null,
    ...overrides,
  });

const actionEvent = (overrides: Record<string, unknown> = {}) =>
  envelope('action.changed', 5, {
    requestId: 'req-1',
    kind: 'permission',
    source: 'tool_call',
    inputRevision: 1,
    optionsRef: null,
    state: 'requested',
    decisionRef: null,
    ...overrides,
  });

const lifecycleEvent = (from: string, to: string) =>
  envelope('lifecycle.changed', 7, {
    operationId: 'op-1',
    from,
    to,
    reason: 'test',
    pendingOwnersRef: null,
  });

const expectEventError = (input: unknown, error: Expected) =>
  expect(() => parseManagedSessionEvent(input)).toThrow(error);

describe('managed session record envelope', () => {
  it('accepts a well-formed input.accepted event', () => {
    const event = parseManagedSessionEvent(inputEvent());
    expect(event.kind).toBe('input.accepted');
    expect(event.sequence).toBe(1);
    expect(event.sessionKey).toEqual(sessionKey);
    expect(event.subject).toBeUndefined();
  });

  it('rejects an unknown kind rather than skipping it', () => {
    expectEventError(
      inputEvent({ kind: 'input.maybe' }),
      ManagedSessionRecordError,
    );
  });

  it('rejects an unknown envelope or payload field', () => {
    expectEventError(inputEvent({ extra: 1 }), /unknown field "extra"/);
    expectEventError(
      withPayload(inputEvent(), { extra: 1 }),
      /unknown field "extra"/,
    );
  });

  it('requires every non-optional payload field', () => {
    const payload = { ...(inputEvent()['payload'] as Record<string, unknown>) };
    delete payload['admissionRef'];
    expectEventError(
      inputEvent({ payload }),
      /payload.admissionRef is required/,
    );
  });

  it('allows a declared optional field to be absent', () => {
    const event = parseManagedSessionEvent(
      envelope(
        'message.committed',
        4,
        {
          messageId: 'msg-1',
          role: 'assistant',
          contentRef: ref(),
          parentMessageId: null,
        },
        { subject: activationSubject },
      ),
    );
    expect(event.kind).toBe('message.committed');
  });

  it('starts formal event sequences at 1', () => {
    expectEventError(inputEvent({ sequence: 0 }), /must start at 1/);
  });

  it('rejects a negative event timestamp', () => {
    expectEventError(
      inputEvent({ occurredAt: -1 }),
      /UTC Unix milliseconds as a safe integer/,
    );
  });

  it('rejects a timestamp outside the ECMAScript UTC range', () => {
    expectEventError(
      inputEvent({ occurredAt: MANAGED_SESSION_LIMITS.maxTimeMs + 1 }),
      /maximum UTC Unix millisecond value/,
    );
  });

  it('rejects a version other than 1', () => {
    expectEventError(inputEvent({ v: 2 }), /event.v must be 1/);
  });
});

describe('managed session shared field rules', () => {
  it('rejects control characters and oversized identifiers', () => {
    expectEventError(inputEvent({ eventId: 'a\u0000b' }), /control characters/);
    expectEventError(
      inputEvent({
        eventId: 'x'.repeat(MANAGED_SESSION_LIMITS.maxIdBytes + 1),
      }),
      /exceeds 512 UTF-8 bytes/,
    );
  });

  it('counts identifier length in UTF-8 bytes, not code units', () => {
    const justOver = '\u00e9'.repeat(MANAGED_SESSION_LIMITS.maxIdBytes / 2 + 1);
    expect(justOver.length).toBeLessThan(MANAGED_SESSION_LIMITS.maxIdBytes);
    expectEventError(
      inputEvent({ eventId: justOver }),
      /exceeds 512 UTF-8 bytes/,
    );
  });

  it('accepts an identifier at the exact byte limit', () => {
    const eventId = 'x'.repeat(MANAGED_SESSION_LIMITS.maxIdBytes);
    expect(parseManagedSessionEvent(inputEvent({ eventId })).eventId).toBe(
      eventId,
    );
  });

  it('requires stable identifiers to be valid UTF-8 in NFC form', () => {
    expectEventError(inputEvent({ eventId: '\ud800' }), /valid UTF-8 text/);
    expectEventError(
      inputEvent({ eventId: 'cafe\u0301' }),
      /NFC normalization/,
    );
    expect(
      parseManagedSessionEvent(inputEvent({ eventId: '你好😀' })).eventId,
    ).toBe('你好😀');
  });

  it('enforces the free-form text byte limit', () => {
    const withSource = (length: number) =>
      withPayload(inputEvent(), { source: 'x'.repeat(length) });
    expect(() =>
      parseManagedSessionEvent(withSource(MANAGED_SESSION_LIMITS.maxTextBytes)),
    ).not.toThrow();
    expectEventError(
      withSource(MANAGED_SESSION_LIMITS.maxTextBytes + 1),
      /exceeds 4096 UTF-8 bytes/,
    );
  });

  it('rejects array subclasses before their methods can bypass validation', () => {
    class JsonArraySubclass extends Array<unknown> {}
    expectEventError(
      withPayload(eventForKind('tool.receipt'), {
        resources: new JsonArraySubclass('not-a-ref'),
      }),
      /plain JSON array/,
    );
  });

  it('keeps untrusted field names out of error-message control sequences', () => {
    const unsafeKey = 'bad\u001b[31m\nfield';
    const inputs = [
      withPayload(inputEvent(), { [unsafeKey]: true }),
      withPayload(eventForKind('tool.receipt'), {
        resources: [{ [unsafeKey]: Number.NaN }],
      }),
    ];
    for (const input of inputs) {
      try {
        parseManagedSessionEvent(input);
        throw new Error('expected validation to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(ManagedSessionRecordError);
        // eslint-disable-next-line no-control-regex
        expect((error as Error).message).not.toMatch(/[\u001b\n]/);
      }
    }
  });

  it('requires a lowercase sha-256 digest', () => {
    expectEventError(
      withPayload(inputEvent(), {
        contentRef: { ...ref(), digest: DIGEST.toUpperCase() },
      }),
      /lowercase SHA-256 hex digest/,
    );
  });

  it('requires the full session key triple', () => {
    expectEventError(
      inputEvent({ sessionKey: { tenantId: 't1', workspaceId: 'w1' } }),
      /sessionId must be a non-empty string/,
    );
  });

  it('rejects a negative or fractional sequence', () => {
    expectEventError(inputEvent({ sequence: -1 }), /non-negative safe integer/);
    expectEventError(
      inputEvent({ sequence: 1.5 }),
      /non-negative safe integer/,
    );
    expectEventError(
      inputEvent({ sequence: Number.MAX_SAFE_INTEGER }),
      /cannot advance/,
    );
  });

  it('rejects non-JSON values passed directly to a typed parser', () => {
    const cancellation = (target: unknown) =>
      envelope('cancel.requested', 2, cancelPayload(target));
    expectEventError(cancellation(Number.NaN), /numbers must be finite/);
    expectEventError(cancellation(new Date()), /plain JSON objects/);
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    expectEventError(cancellation(cycle), /must not contain cycles/);
  });

  it('walks a shared-reference graph once per distinct object', () => {
    let shared: Record<string, unknown> = { leaf: 1 };
    for (let level = 0; level < 24; level++) {
      shared = { a: shared, b: shared };
    }
    // 25 distinct objects holding ~2^24 paths serialize to ~350 MB, and
    // commit() stringifies before its byte check, so the expansion has to be
    // refused here; a small shared graph stays legal.
    expectEventError(
      envelope('cancel.requested', 2, cancelPayload(shared)),
      /expands past 8388608 bytes through shared references/,
    );
    let small: Record<string, unknown> = { leaf: 1 };
    for (let level = 0; level < 8; level++) {
      small = { a: small, b: small };
    }
    expect(() =>
      parseManagedSessionEvent(
        envelope('cancel.requested', 2, cancelPayload(small)),
      ),
    ).not.toThrow();

    let chain: unknown = null;
    for (let depth = 0; depth < 61; depth++) {
      chain = { nested: chain };
    }
    // The second path to the shared chain ends one level past the bound, so
    // the memo must not short-circuit the depth check.
    expectEventError(
      envelope(
        'cancel.requested',
        2,
        cancelPayload({ first: chain, shell: { second: chain } }),
      ),
      /maximum JSON depth/,
    );

    // One object shorter, the second path ends exactly at the bound: the
    // shared value must be accepted, as its unshared copy is.
    const fits = (chain as { nested: unknown }).nested;
    expect(() =>
      parseManagedSessionEvent(
        envelope(
          'cancel.requested',
          2,
          cancelPayload({ first: fits, shell: { second: fits } }),
        ),
      ),
    ).not.toThrow();

    // Array-shaped sharing goes through the same memo: heights propagate,
    // and expansion is bounded for arrays exactly as for objects.
    let rows: unknown = [1];
    for (let level = 0; level < 24; level++) {
      rows = [rows, rows];
    }
    expectEventError(
      envelope('cancel.requested', 2, cancelPayload(rows)),
      /expands past 8388608 bytes through shared references/,
    );
    let smallRows: unknown = [1];
    for (let level = 0; level < 8; level++) {
      smallRows = [smallRows, smallRows];
    }
    expect(() =>
      parseManagedSessionEvent(
        envelope('cancel.requested', 2, cancelPayload(smallRows)),
      ),
    ).not.toThrow();

    let rowChain: unknown = null;
    for (let depth = 0; depth < 61; depth++) {
      rowChain = [rowChain];
    }
    expectEventError(
      envelope(
        'cancel.requested',
        2,
        cancelPayload({ first: rowChain, shell: { second: rowChain } }),
      ),
      /maximum JSON depth/,
    );
    const fitsRows = (rowChain as unknown[])[0];
    expect(() =>
      parseManagedSessionEvent(
        envelope(
          'cancel.requested',
          2,
          cancelPayload({ first: fitsRows, shell: { second: fitsRows } }),
        ),
      ),
    ).not.toThrow();
  });
});

describe('managed session per-kind rules', () => {
  it.each([
    ['model.attempt', () => harnessEvent()],
    ['tool.intent', () => eventForKind('tool.intent')],
    ['context.compacted', () => eventForKind('context.compacted')],
    ['checkpoint.committed', () => eventForKind('checkpoint.committed')],
  ])('requires an activation subject for %s', (_kind, makeEvent) => {
    const missing = makeEvent();
    delete missing['subject'];
    expectEventError(missing, /requires an activation subject/);
    expectEventError(
      { ...makeEvent(), subject: { type: 'turn', turnId: 'turn-1' } },
      /requires an activation subject/,
    );
  });

  it.each([
    'tool.intent',
    'tool.receipt',
    'checkpoint.committed',
    'turn.settled',
    'config.bound',
  ] as const)('accepts a schema-exact %s event', (kind) => {
    expect(parseManagedSessionEvent(eventForKind(kind)).kind).toBe(kind);
  });

  it('validates the hook-operation subject variant', () => {
    const wake = (occurrenceId: string) =>
      wakeEvent({
        reason: 'hook',
        subject: { type: 'hook_operation', operationId: 'op-1', occurrenceId },
      });
    expect(parseManagedSessionEvent(wake('occ-1')).kind).toBe('wake.requested');
    expectEventError(wake(''), /occurrenceId must be a non-empty string/);
  });

  it('requires usageRef to be null while a model attempt is started', () => {
    expectEventError(
      withPayload(harnessEvent(), { usageRef: ref() }),
      /usageRef must be null/,
    );
  });

  it('pairs activation phase with its lease and boundary fields', () => {
    const accepts = (phase: string, overrides?: Record<string, unknown>) =>
      expect(
        parseManagedSessionEvent(activationEvent(phase, overrides)).kind,
      ).toBe('activation.changed');

    accepts('active');
    expectEventError(
      activationEvent('active', { boundaryRef: ref() }),
      /boundaryRef must be null/,
    );
    expectEventError(
      activationEvent('released'),
      /boundaryRef must be present/,
    );
    accepts('released', { boundaryRef: ref() });
    expectEventError(
      activationEvent('released', { boundaryRef: ref(), expiresAt: null }),
      /expiresAt must be present/,
    );
    expectEventError(
      activationEvent('active', { installRef: null }),
      /installRef must be present/,
    );
    expectEventError(
      activationEvent('installing', { leaseDurationMs: null }),
      /leaseDurationMs must be present/,
    );
    accepts('revoked', { boundaryRef: ref() });
    expectEventError(activationEvent('paused'), /phase must be one of/);
  });

  it('requires the payload subject to identify the activation it changes', () => {
    expect(parseManagedSessionEvent(activationEvent('active')).kind).toBe(
      'activation.changed',
    );
    // hook_operation is the hosted Hook caller's legal subject and must
    // stay accepted.
    expect(
      parseManagedSessionEvent(
        activationEvent('active', {
          subject: {
            type: 'hook_operation',
            operationId: 'op-1',
            occurrenceId: 'occ-1',
          },
        }),
      ).kind,
    ).toBe('activation.changed');
    expectEventError(
      activationEvent('active', {
        subject: { type: 'turn', turnId: 'turn-9' },
      }),
      /subject must identify the activation it changes/,
    );
    expectEventError(
      activationEvent('active', {
        subject: { ...activationSubject, activationId: 'act-2' },
      }),
      /subject must identify the activation it changes/,
    );
    expectEventError(
      activationEvent('active', {
        subject: { ...activationSubject, epoch: 4 },
      }),
      /subject must identify the activation it changes/,
    );
  });

  it('requires the envelope subject to match the payload subject', () => {
    expect(
      parseManagedSessionEvent({ ...wakeEvent(), subject: turnSubject }).kind,
    ).toBe('wake.requested');
    expect(
      parseManagedSessionEvent({
        ...activationEvent('active'),
        subject: activationSubject,
      }).kind,
    ).toBe('activation.changed');
    expectEventError(
      { ...wakeEvent(), subject: { type: 'turn', turnId: 'turn-9' } },
      /requires event.subject to match payload.subject/,
    );
    expectEventError(
      { ...activationEvent('active'), subject: turnSubject },
      /requires event.subject to match payload.subject/,
    );
    // Negative coverage for the hook_operation and activation comparison
    // branches: each differing identity field on its own must fail.
    const hookSubject = {
      type: 'hook_operation',
      operationId: 'op-1',
      occurrenceId: 'occ-1',
    };
    expectEventError(
      {
        ...wakeEvent({ subject: hookSubject }),
        subject: { ...hookSubject, operationId: 'op-2' },
      },
      /requires event.subject to match payload.subject/,
    );
    expectEventError(
      {
        ...wakeEvent({ subject: hookSubject }),
        subject: { ...hookSubject, occurrenceId: 'occ-2' },
      },
      /requires event.subject to match payload.subject/,
    );
    expectEventError(
      {
        ...activationEvent('active'),
        subject: { ...activationSubject, scopeId: 'scope-2' },
      },
      /requires event.subject to match payload.subject/,
    );
    expectEventError(
      {
        ...activationEvent('active'),
        subject: { ...activationSubject, activationId: 'act-9' },
      },
      /requires event.subject to match payload.subject/,
    );
    expectEventError(
      {
        ...activationEvent('active'),
        subject: { ...activationSubject, epoch: 9 },
      },
      /requires event.subject to match payload.subject/,
    );
  });

  it('ties the action decision reference to the decided state', () => {
    expect(parseManagedSessionEvent(actionEvent()).kind).toBe('action.changed');
    expectEventError(
      actionEvent({ state: 'decided' }),
      /decisionRef must be present/,
    );
    expectEventError(
      actionEvent({ decisionRef: ref() }),
      /decisionRef must be null/,
    );
    expectEventError(actionEvent({ source: 'guess' }), /source must be one of/);
  });

  it('accepts only registered domains with a matching record ref', () => {
    const domainEvent = (overrides: Record<string, unknown> = {}) =>
      envelope('domain.committed', 6, {
        domain: 'session_metadata',
        version: 1,
        operationId: 'op-1',
        recordRef: ref('managed-session_metadata'),
        ...overrides,
      });

    expect(parseManagedSessionEvent(domainEvent()).kind).toBe(
      'domain.committed',
    );
    expectEventError(
      domainEvent({ domain: 'history_operation' }),
      /domain must be one of/,
    );
    expectEventError(
      domainEvent({ recordRef: ref('managed-schedule') }),
      /recordRef.kind must be managed-session_metadata/,
    );
    expectEventError(domainEvent({ version: 2 }), /version must be 1/);
    expectEventError(
      domainEvent({
        recordRef: { ...ref('managed-session_metadata'), schemaVersion: 2 },
      }),
      /recordRef.schemaVersion must be 1/,
    );
  });

  it('requires event-sequence references to start at 1', () => {
    expectEventError(wakeEvent({ requiredSequence: 0 }), /must start at 1/);
    expectEventError(
      withPayload(eventForKind('checkpoint.committed'), { coveredSequence: 0 }),
      /must start at 1/,
    );
    expectEventError(
      withPayload(eventForKind('context.compacted'), { fromSequence: 0 }),
      /sequence references must start at 1/,
    );
  });

  it('rejects a predecessor reference that cannot hold', () => {
    expectEventError(
      withPayload(eventForKind('message.committed'), {
        parentMessageId: 'msg-1',
      }),
      /parentMessageId must not name itself/,
    );
    expectEventError(
      withPayload(eventForKind('checkpoint.committed'), {
        previousCheckpointId: 'checkpoint-1',
      }),
      /previousCheckpointId must not name itself/,
    );
    expectEventError(
      withPayload(eventForKind('config.bound'), {
        revision: 1,
        previousRevision: 7,
      }),
      /previousRevision must precede payload.revision/,
    );
    expectEventError(
      withPayload(eventForKind('config.bound'), {
        revision: 5,
        previousRevision: 5,
      }),
      /previousRevision must precede payload.revision/,
    );
    expectEventError(
      withPayload(wakeEvent(), { sourceEventId: 'evt-2' }),
      /sourceEventId must not name itself/,
    );
    expect(
      parseManagedSessionEvent(
        withPayload(eventForKind('config.bound'), {
          revision: 2,
          previousRevision: 1,
        }),
      ).kind,
    ).toBe('config.bound');
    expect(
      parseManagedSessionEvent(eventForKind('message.committed')).kind,
    ).toBe('message.committed');
    expect(parseManagedSessionEvent(wakeEvent()).kind).toBe('wake.requested');
  });

  it('rejects a compaction range whose end precedes its start', () => {
    expectEventError(
      envelope(
        'context.compacted',
        7,
        {
          compactionId: 'compaction-1',
          fromSequence: 4,
          toSequence: 3,
          summaryRef: ref(),
          replacedMessageIds: [],
          tokenCountsRef: null,
        },
        { subject: activationSubject },
      ),
      /toSequence must not precede payload.fromSequence/,
    );
  });

  it('registers the v1 domains including file history and session source', () => {
    expect(MANAGED_SESSION_DOMAINS).toHaveLength(33);
    expect(new Set(MANAGED_SESSION_DOMAINS).size).toBe(33);
  });

  it('validates the lifecycle target state', () => {
    expectEventError(lifecycleEvent('idle', 'sleeping'), /to must be one of/);
  });

  it('rejects a disallowed lifecycle transition', () => {
    expectEventError(
      lifecycleEvent('active', 'closed'),
      /cannot transition from active to closed/,
    );
  });
});

describe('managed session actor eligibility', () => {
  const asActor =
    (event: ManagedSessionEvent, actor: ManagedSessionActorClass) => () =>
      assertManagedSessionEventActor(event, actor);

  it('admits projected input without an activation only from a trusted entry', () => {
    const input = eventForKind('message.committed');
    delete input['subject'];
    const event = parseManagedSessionEvent(input);
    expect(() =>
      assertManagedSessionEventActor(event, 'trusted_entry'),
    ).not.toThrow();
    expect(() => assertManagedSessionEventActor(event, 'harness')).toThrow(
      /requires an activation subject/,
    );
    expect(() => assertManagedSessionEventActor(event, 'authority')).toThrow(
      /must not be requested/,
    );
  });

  it('lets only the coordinator change an activation', () => {
    const event = parseManagedSessionEvent(
      activationEvent('active', { expiresAt: 2 }),
    );
    expect(asActor(event, 'coordinator')).not.toThrow();
    expect(asActor(event, 'harness')).toThrow(
      /must not be requested by harness/,
    );
  });

  it('keeps wake.requested internal to the authority', () => {
    const event = parseManagedSessionEvent(wakeEvent());
    expect(asActor(event, 'authority')).not.toThrow();
    expect(asActor(event, 'trusted_entry')).toThrow(
      /must not be requested by trusted_entry/,
    );
  });

  it('splits action.changed between the harness and the trusted entry', () => {
    // Parses inside the asserted closure, as each check did originally.
    const check =
      (source: string, state: string, actor: ManagedSessionActorClass) => () =>
        assertManagedSessionEventActor(
          parseManagedSessionEvent({
            ...actionEvent({
              source,
              state,
              decisionRef: state === 'decided' ? ref() : null,
            }),
            subject: activationSubject,
          }),
          actor,
        );

    expect(check('tool_call', 'requested', 'harness')).not.toThrow();
    expect(check('tool_call', 'requested', 'trusted_entry')).toThrow(
      /must be requested by harness/,
    );
    expect(check('automation_run', 'requested', 'harness')).toThrow(
      /must be requested by trusted_entry/,
    );
    expect(check('tool_call', 'decided', 'harness')).toThrow(
      /must be requested by trusted_entry/,
    );
  });
});

describe('managed session lifecycle transitions', () => {
  type State = ManagedSessionLifecycleState;
  const expectTransitions = (cases: Array<[State | null, State, boolean]>) => {
    for (const [from, to, allowed] of cases) {
      expect(
        isManagedSessionLifecycleTransitionAllowed(from, to),
        `${from} -> ${to}`,
      ).toBe(allowed);
    }
  };

  it('allows only the documented transitions', () => {
    expectTransitions([
      [null, 'idle', true],
      [null, 'active', false],
      ['idle', 'active', true],
      ['active', 'closed', false],
      ['closing', 'closed', true],
      ['archived', 'closed', true],
      ['deleted', 'idle', false],
    ]);
  });

  it('blocks every state except deleted and restores a legal stage', () => {
    expectTransitions(
      MANAGED_SESSION_LIFECYCLE_STATES.flatMap(
        (state): Array<[State, State, boolean]> => [
          [
            state,
            'recovery_blocked',
            state !== 'deleted' && state !== 'recovery_blocked',
          ],
          [
            'recovery_blocked',
            state,
            state !== 'deleted' && state !== 'recovery_blocked',
          ],
        ],
      ),
    );
  });

  it('fails closed for invalid direct-call states and pins terminal transitions', () => {
    expectTransitions([
      ['sleeping' as never, 'idle', false],
      ['closed', 'deleting', true],
      ['deleting', 'deleted', true],
    ]);
  });
});

describe('managed session header', () => {
  const header = (overrides: Record<string, unknown> = {}) => ({
    formatVersion: 1,
    minimumReader: 'managed-session/1',
    sessionKey,
    engine: 'managed',
    definitionRef: ref(),
    rootSnapshotRef: ref(),
    createdBy: 'daemon',
    ...overrides,
  });
  const headerError = (overrides: Record<string, unknown>, error: Expected) =>
    expect(() => parseManagedSessionHeader(header(overrides))).toThrow(error);

  it('accepts a v1 header without a base transcript proof', () => {
    expect(parseManagedSessionHeader(header()).engine).toBe('managed');
  });

  it('refuses a newer format or reader requirement', () => {
    headerError({ formatVersion: 2 }, /is not supported by this reader/);
    headerError(
      { minimumReader: 'managed-session/2' },
      /is not supported by this reader/,
    );
    headerError(
      { minimumReader: 'managed-session/3' },
      /is not supported by this reader/,
    );
  });

  it('accepts an older minimum-reader requirement and returns its token', () => {
    expect(
      parseManagedSessionHeader(header({ minimumReader: 'managed-session/0' }))
        .minimumReader,
    ).toBe('managed-session/0');
    expect(
      parseManagedSessionHeader(header({ minimumReader: 'managed-session/1' }))
        .minimumReader,
    ).toBe('managed-session/1');
  });

  it('refuses a malformed minimum-reader token', () => {
    const malformed = [
      'managed-session/01',
      'managed-session/',
      'managed-session/1 ',
      'managed-session/1.0',
    ];
    for (const minimumReader of malformed) {
      headerError({ minimumReader }, /is not supported by this reader/);
    }
  });

  it('validates and preserves a base transcript proof', () => {
    expect(
      parseManagedSessionHeader(header({ baseTranscriptProof: ref() }))
        .baseTranscriptProof,
    ).toEqual(ref());
    headerError(
      { baseTranscriptProof: { ...ref(), digest: 'ZZ' } },
      /lowercase SHA-256/,
    );
  });

  it('uses managed validation errors for unsupported structured versions', () => {
    const unsupported = Object.create(null) as Record<string, never>;
    headerError({ formatVersion: unsupported }, ManagedSessionRecordError);
    headerError({ minimumReader: unsupported }, ManagedSessionRecordError);
  });

  it('refuses a non-managed engine', () => {
    headerError({ engine: 'legacy' }, /engine must be managed/);
  });
});

describe('managed session commit marker', () => {
  const marker = (overrides: Record<string, unknown> = {}) => ({
    transactionId: 'tx-1',
    commandId: 'cmd-1',
    operation: 'submitInput',
    contentDigest: DIGEST,
    firstSequence: 1,
    lastSequence: 2,
    eventCount: 2,
    eventsDigest: DIGEST,
    previousCommitDigest: null,
    ...overrides,
  });
  const markerError = (overrides: Record<string, unknown>, error: Expected) =>
    expect(() => parseManagedSessionCommitMarker(marker(overrides))).toThrow(
      error,
    );

  it('accepts a marker whose range matches its event count', () => {
    expect(parseManagedSessionCommitMarker(marker()).eventCount).toBe(2);
  });

  it('rejects a range that disagrees with the event count', () => {
    markerError({ lastSequence: 5 }, /must match commit.eventCount/);
  });

  it('requires the committed range to start at sequence 1 or later', () => {
    markerError(
      { firstSequence: 0, lastSequence: 1 },
      /firstSequence must start at 1/,
    );
  });

  it('rejects an empty or oversized transaction', () => {
    markerError({ eventCount: 0, lastSequence: 0 }, /at least one event/);
    markerError({ eventCount: 257, lastSequence: 257 }, /exceeds 256 events/);
    expect(
      parseManagedSessionCommitMarker(
        marker({ eventCount: 256, lastSequence: 256 }),
      ).eventCount,
    ).toBe(256);
  });
});

describe('managed session transactions', () => {
  function event(sequence: number, key = sessionKey): ManagedSessionEvent {
    return parseManagedSessionEvent(
      inputEvent({ sequence, eventId: `evt-${sequence}`, sessionKey: key }),
    );
  }
  const tx =
    (events: () => ManagedSessionEvent[], bytes = 1024) =>
    () =>
      assertManagedSessionTransaction(events(), bytes);
  const tooManyEvents = () =>
    Array.from(
      { length: MANAGED_SESSION_LIMITS.maxTransactionEvents + 1 },
      (_, index) => event(index + 1),
    );

  it('accepts a contiguous single-session range', () => {
    expect(tx(() => [event(1), event(2)])).not.toThrow();
  });

  it('preserves the event depth limit inside list validators', () => {
    let target: unknown = null;
    for (let depth = 3; depth <= MANAGED_SESSION_LIMITS.maxJsonDepth; depth++) {
      target = { nested: target };
    }
    const exactDepthEvent = parseManagedSessionEvent(
      envelope('cancel.requested', 1, cancelPayload(target), {
        eventId: 'evt-depth',
      }),
    );

    expect(tx(() => [exactDepthEvent])).not.toThrow();
    expect(() => managedSessionEventsDigest([exactDepthEvent])).not.toThrow();

    const overDepthEvent = {
      ...exactDepthEvent,
      payload: { ...exactDepthEvent.payload, target: { nested: target } },
    } as ManagedSessionEvent;
    expect(tx(() => [overDepthEvent])).toThrow(/maximum JSON depth/);
    expect(() => managedSessionEventsDigest([overDepthEvent])).toThrow(
      /maximum JSON depth/,
    );
  });

  it('rejects an empty transaction or one over the event-count limit', () => {
    expect(tx(() => [], 0)).toThrow(/must contain at least one event/);
    const events = tooManyEvents();
    expect(tx(() => events)).toThrow(/must not exceed 256 events/);
  });

  it('rejects a gap in the sequence range', () => {
    expect(tx(() => [event(1), event(3)])).toThrow(/contiguous sequence range/);
  });

  it.each([
    { ...sessionKey, tenantId: 't2' },
    { ...sessionKey, workspaceId: 'w2' },
    { ...sessionKey, sessionId: 's2' },
  ])('rejects a transaction that spans session keys', (other) => {
    expect(tx(() => [event(1), event(2, other)])).toThrow(
      /must not span sessions/,
    );
  });

  it('rejects an oversized transaction', () => {
    const max = MANAGED_SESSION_LIMITS.maxTransactionBytes;
    expect(tx(() => [event(1)], max)).not.toThrow();
    expect(tx(() => [event(1)], max + 1)).toThrow(
      /must not exceed 8388608 bytes/,
    );
  });

  it('rejects an invalid encoded transaction size', () => {
    for (const bytes of [Number.NaN, -1, 0]) {
      expect(tx(() => [event(1)], bytes)).toThrow(
        /encoded size must be a positive safe integer/,
      );
    }
  });

  it('rejects array subclasses before they can bypass transaction checks', () => {
    class EventArraySubclass extends Array<ManagedSessionEvent> {
      override forEach(): void {}
    }
    const events = new EventArraySubclass(
      event(1),
      event(3, { ...sessionKey, workspaceId: 'w2' }),
    );
    expect(tx(() => events)).toThrow(/plain JSON array/);
  });

  it('digests the complete committed events stably', () => {
    const digest = managedSessionEventsDigest([event(1), event(2)]);
    expect(digest).toBe(
      '0da902e249ff5ba1e2ce05db968cfaa30b51ef1cb089b27b496dfb7765be09b5',
    );
    expect(managedSessionEventsDigest([event(1), event(2)])).toBe(digest);
    expect(managedSessionEventsDigest([event(2), event(1)])).not.toBe(digest);
  });

  it('covers payloads, scope and timestamps in the commit digest', () => {
    const original = event(1);
    const digest = managedSessionEventsDigest([original]);
    for (const changed of [
      { ...original, occurredAt: original.occurredAt + 1 },
      { ...original, sessionKey: { ...sessionKey, tenantId: 'other' } },
      { ...original, payload: { ...original.payload, source: 'changed' } },
    ]) {
      expect(managedSessionEventsDigest([changed])).not.toBe(digest);
    }
  });

  it('bounds digest input before encoding event content', () => {
    expect(() => managedSessionEventsDigest([])).toThrow(
      /must contain at least one event/,
    );
    const events = tooManyEvents();
    expect(() => managedSessionEventsDigest(events)).toThrow(
      /must not exceed 256 events/,
    );
  });
});

describe('managed session raw record parsing', () => {
  const parseJson =
    (text: string, byteCap = 1024) =>
    () =>
      parseManagedSessionRecordJson(text, byteCap);

  it('rejects duplicate keys that JSON.parse would silently collapse', () => {
    const text = '{"a":1,"a":2}';
    expect(JSON.parse(text)).toEqual({ a: 2 });
    expect(parseJson(text)).toThrow(/duplicate JSON key "a"/);
  });

  it('detects duplicate keys written with different escapes', () => {
    expect(parseJson('{"a":1,"\\u0061":2}')).toThrow(/duplicate JSON key "a"/);
  });

  it('allows the same key name in sibling objects and inside arrays', () => {
    expect(parseJson('{"x":{"a":1},"y":{"a":2}}')()).toEqual({
      x: { a: 1 },
      y: { a: 2 },
    });
    expect(parseJson('{"list":[{"a":1},{"a":2}]}')()).toEqual({
      list: [{ a: 1 }, { a: 2 }],
    });
  });

  it('does not treat a string value that looks like a key as a key', () => {
    expect(parseJson('{"a":"b","c":"a"}')()).toEqual({ a: 'b', c: 'a' });
  });

  it('ignores braces inside string values', () => {
    expect(parseJson('{"a":"{\\"a\\":1}","b":2}')()).toEqual({
      a: '{"a":1}',
      b: 2,
    });
  });

  it('enforces the byte cap before parsing', () => {
    const text = JSON.stringify({ a: 'x'.repeat(200) });
    expect(parseJson(text, 64)).toThrow(/exceeds 64 UTF-8 bytes/);
  });

  it('requires a positive safe byte cap', () => {
    for (const byteCap of [Number.NaN, 0]) {
      expect(parseJson('{}', byteCap)).toThrow(
        /byte limit must be a positive safe integer/,
      );
    }
  });

  it('enforces the maximum JSON depth', () => {
    const nested = (depth: number) => '['.repeat(depth) + ']'.repeat(depth);
    const exact = MANAGED_SESSION_LIMITS.maxJsonDepth;
    expect(parseJson(nested(exact), 1024 * 1024)).not.toThrow();
    expect(parseJson(nested(exact + 1), 1024 * 1024)).toThrow(
      /maximum JSON depth/,
    );
  });

  it('rejects malformed JSON', () => {
    expect(parseJson('{"a":}')).toThrow(/not valid JSON/);
  });

  it('rejects non-finite numbers produced by JSON exponent overflow', () => {
    expect(parseJson('1e400')).toThrow(/numbers must be finite/);
  });

  it('uses the declared header byte cap', () => {
    const cap = MANAGED_SESSION_LIMITS.maxHeaderBytes;
    const exact = JSON.stringify('x'.repeat(cap - 2));
    expect(parseJson(exact, cap)()).toBe('x'.repeat(cap - 2));
    const over = JSON.stringify('x'.repeat(cap - 1));
    expect(parseJson(over, cap)).toThrow(/exceeds 65536 UTF-8 bytes/);
  });
});

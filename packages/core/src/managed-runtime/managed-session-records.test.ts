/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  MANAGED_SESSION_DOMAINS,
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
  type ManagedSessionDurableRef,
  type ManagedSessionEvent,
} from './managed-session-records.js';

const DIGEST = 'a'.repeat(64);

const sessionKey = { tenantId: 't1', workspaceId: 'w1', sessionId: 's1' };

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

describe('managed session record envelope', () => {
  it('accepts a well-formed input.accepted event', () => {
    const event = parseManagedSessionEvent(inputEvent());
    expect(event.kind).toBe('input.accepted');
    expect(event.sequence).toBe(1);
    expect(event.sessionKey).toEqual(sessionKey);
    expect(event.subject).toBeUndefined();
  });

  it('rejects an unknown kind rather than skipping it', () => {
    expect(() =>
      parseManagedSessionEvent(inputEvent({ kind: 'input.maybe' })),
    ).toThrow(ManagedSessionRecordError);
  });

  it('rejects an unknown envelope or payload field', () => {
    expect(() => parseManagedSessionEvent(inputEvent({ extra: 1 }))).toThrow(
      /unknown field "extra"/,
    );
    expect(() =>
      parseManagedSessionEvent(
        inputEvent({
          payload: { ...(inputEvent()['payload'] as object), extra: 1 },
        }),
      ),
    ).toThrow(/unknown field "extra"/);
  });

  it('requires every non-optional payload field', () => {
    const payload = { ...(inputEvent()['payload'] as Record<string, unknown>) };
    delete payload['admissionRef'];
    expect(() => parseManagedSessionEvent(inputEvent({ payload }))).toThrow(
      /payload.admissionRef is required/,
    );
  });

  it('allows a declared optional field to be absent', () => {
    const event = parseManagedSessionEvent({
      v: 1,
      sequence: 4,
      eventId: 'evt-4',
      sessionKey,
      kind: 'message.committed',
      occurredAt: 1,
      subject: activationSubject,
      payload: {
        messageId: 'msg-1',
        role: 'assistant',
        contentRef: ref(),
        parentMessageId: null,
      },
    });
    expect(event.kind).toBe('message.committed');
  });

  it('starts formal event sequences at 1', () => {
    expect(() => parseManagedSessionEvent(inputEvent({ sequence: 0 }))).toThrow(
      /must start at 1/,
    );
  });

  it('rejects a negative event timestamp', () => {
    expect(() =>
      parseManagedSessionEvent(inputEvent({ occurredAt: -1 })),
    ).toThrow(/UTC Unix milliseconds as a safe integer/);
  });

  it('rejects a timestamp outside the ECMAScript UTC range', () => {
    expect(() =>
      parseManagedSessionEvent(
        inputEvent({ occurredAt: MANAGED_SESSION_LIMITS.maxTimeMs + 1 }),
      ),
    ).toThrow(/maximum UTC Unix millisecond value/);
  });

  it('rejects a version other than 1', () => {
    expect(() => parseManagedSessionEvent(inputEvent({ v: 2 }))).toThrow(
      /event.v must be 1/,
    );
  });
});

describe('managed session shared field rules', () => {
  it('rejects control characters and oversized identifiers', () => {
    expect(() =>
      parseManagedSessionEvent(inputEvent({ eventId: 'a\u0000b' })),
    ).toThrow(/control characters/);
    expect(() =>
      parseManagedSessionEvent(
        inputEvent({
          eventId: 'x'.repeat(MANAGED_SESSION_LIMITS.maxIdBytes + 1),
        }),
      ),
    ).toThrow(/exceeds 512 UTF-8 bytes/);
  });

  it('counts identifier length in UTF-8 bytes, not code units', () => {
    const justOver = '\u00e9'.repeat(MANAGED_SESSION_LIMITS.maxIdBytes / 2 + 1);
    expect(justOver.length).toBeLessThan(MANAGED_SESSION_LIMITS.maxIdBytes);
    expect(() =>
      parseManagedSessionEvent(inputEvent({ eventId: justOver })),
    ).toThrow(/exceeds 512 UTF-8 bytes/);
  });

  it('accepts an identifier at the exact byte limit', () => {
    const eventId = 'x'.repeat(MANAGED_SESSION_LIMITS.maxIdBytes);
    expect(parseManagedSessionEvent(inputEvent({ eventId })).eventId).toBe(
      eventId,
    );
  });

  it('requires stable identifiers to be valid UTF-8 in NFC form', () => {
    expect(() =>
      parseManagedSessionEvent(inputEvent({ eventId: '\ud800' })),
    ).toThrow(/valid UTF-8 text/);
    expect(() =>
      parseManagedSessionEvent(inputEvent({ eventId: 'cafe\u0301' })),
    ).toThrow(/NFC normalization/);
    expect(
      parseManagedSessionEvent(inputEvent({ eventId: '你好😀' })).eventId,
    ).toBe('你好😀');
  });

  it('enforces the free-form text byte limit', () => {
    const payload = inputEvent()['payload'] as Record<string, unknown>;
    expect(() =>
      parseManagedSessionEvent(
        inputEvent({
          payload: {
            ...payload,
            source: 'x'.repeat(MANAGED_SESSION_LIMITS.maxTextBytes),
          },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      parseManagedSessionEvent(
        inputEvent({
          payload: {
            ...payload,
            source: 'x'.repeat(MANAGED_SESSION_LIMITS.maxTextBytes + 1),
          },
        }),
      ),
    ).toThrow(/exceeds 4096 UTF-8 bytes/);
  });

  it('rejects array subclasses before their methods can bypass validation', () => {
    class JsonArraySubclass extends Array<unknown> {}
    expect(() =>
      parseManagedSessionEvent({
        ...eventForKind('tool.receipt'),
        payload: {
          ...(eventForKind('tool.receipt')['payload'] as object),
          resources: new JsonArraySubclass('not-a-ref'),
        },
      }),
    ).toThrow(/plain JSON array/);
  });

  it('keeps untrusted field names out of error-message control sequences', () => {
    const unsafeKey = 'bad\u001b[31m\nfield';
    const inputs = [
      inputEvent({
        payload: {
          ...(inputEvent()['payload'] as object),
          [unsafeKey]: true,
        },
      }),
      {
        ...eventForKind('tool.receipt'),
        payload: {
          ...(eventForKind('tool.receipt')['payload'] as object),
          resources: [{ [unsafeKey]: Number.NaN }],
        },
      },
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
    const payload = {
      ...(inputEvent()['payload'] as Record<string, unknown>),
      contentRef: { ...ref(), digest: DIGEST.toUpperCase() },
    };
    expect(() => parseManagedSessionEvent(inputEvent({ payload }))).toThrow(
      /lowercase SHA-256 hex digest/,
    );
  });

  it('requires the full session key triple', () => {
    expect(() =>
      parseManagedSessionEvent(
        inputEvent({ sessionKey: { tenantId: 't1', workspaceId: 'w1' } }),
      ),
    ).toThrow(/sessionId must be a non-empty string/);
  });

  it('rejects a negative or fractional sequence', () => {
    expect(() =>
      parseManagedSessionEvent(inputEvent({ sequence: -1 })),
    ).toThrow(/non-negative safe integer/);
    expect(() =>
      parseManagedSessionEvent(inputEvent({ sequence: 1.5 })),
    ).toThrow(/non-negative safe integer/);
    expect(() =>
      parseManagedSessionEvent(
        inputEvent({ sequence: Number.MAX_SAFE_INTEGER }),
      ),
    ).toThrow(/cannot advance/);
  });

  it('rejects non-JSON values passed directly to a typed parser', () => {
    const cancellation = (target: unknown) => ({
      v: 1,
      sequence: 2,
      eventId: 'evt-2',
      sessionKey,
      kind: 'cancel.requested',
      occurredAt: 1,
      payload: {
        requestId: 'req-1',
        target,
        reason: 'test',
        requestedBy: 'user',
      },
    });
    expect(() => parseManagedSessionEvent(cancellation(Number.NaN))).toThrow(
      /numbers must be finite/,
    );
    expect(() => parseManagedSessionEvent(cancellation(new Date()))).toThrow(
      /plain JSON objects/,
    );
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    expect(() => parseManagedSessionEvent(cancellation(cycle))).toThrow(
      /must not contain cycles/,
    );
  });
});

describe('managed session per-kind rules', () => {
  it.each([
    ['model.attempt', () => harnessEvent()],
    ['message.committed', () => eventForKind('message.committed')],
    ['tool.intent', () => eventForKind('tool.intent')],
    ['context.compacted', () => eventForKind('context.compacted')],
    ['checkpoint.committed', () => eventForKind('checkpoint.committed')],
  ])('requires an activation subject for %s', (_kind, makeEvent) => {
    const missing = makeEvent();
    delete missing['subject'];
    expect(() => parseManagedSessionEvent(missing)).toThrow(
      /requires an activation subject/,
    );
    expect(() =>
      parseManagedSessionEvent({
        ...makeEvent(),
        subject: { type: 'turn', turnId: 'turn-1' },
      }),
    ).toThrow(/requires an activation subject/);
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
    const wake = {
      v: 1,
      sequence: 2,
      eventId: 'evt-2',
      sessionKey,
      kind: 'wake.requested',
      occurredAt: 1,
      payload: {
        wakeId: 'wake-1',
        reason: 'hook',
        subject: {
          type: 'hook_operation',
          operationId: 'op-1',
          occurrenceId: 'occ-1',
        },
        sourceEventId: 'evt-1',
        requiredSequence: 1,
      },
    };
    expect(parseManagedSessionEvent(wake).kind).toBe('wake.requested');
    expect(() =>
      parseManagedSessionEvent({
        ...wake,
        payload: {
          ...wake.payload,
          subject: { ...wake.payload.subject, occurrenceId: '' },
        },
      }),
    ).toThrow(/occurrenceId must be a non-empty string/);
  });

  it('requires usageRef to be null while a model attempt is started', () => {
    expect(() =>
      parseManagedSessionEvent(
        harnessEvent({
          payload: {
            attemptId: 'att-1',
            routeRef: ref(),
            inputCheckpointRef: null,
            state: 'started',
            usageRef: ref(),
          },
        }),
      ),
    ).toThrow(/usageRef must be null/);
  });

  it('pairs activation phase with its lease and boundary fields', () => {
    const activation = (
      phase: string,
      overrides: Record<string, unknown> = {},
    ) => ({
      v: 1,
      sequence: 3,
      eventId: 'evt-3',
      sessionKey,
      kind: 'activation.changed',
      occurredAt: 1,
      payload: {
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
      },
    });

    expect(parseManagedSessionEvent(activation('active')).kind).toBe(
      'activation.changed',
    );
    expect(() =>
      parseManagedSessionEvent(activation('active', { boundaryRef: ref() })),
    ).toThrow(/boundaryRef must be null/);
    expect(() => parseManagedSessionEvent(activation('released'))).toThrow(
      /boundaryRef must be present/,
    );
    expect(
      parseManagedSessionEvent(activation('released', { boundaryRef: ref() }))
        .kind,
    ).toBe('activation.changed');
    expect(() =>
      parseManagedSessionEvent(
        activation('released', { boundaryRef: ref(), expiresAt: null }),
      ),
    ).toThrow(/expiresAt must be present/);
    expect(() =>
      parseManagedSessionEvent(activation('active', { installRef: null })),
    ).toThrow(/installRef must be present/);
    expect(() =>
      parseManagedSessionEvent(
        activation('installing', { leaseDurationMs: null }),
      ),
    ).toThrow(/leaseDurationMs must be present/);
    expect(
      parseManagedSessionEvent(activation('revoked', { boundaryRef: ref() }))
        .kind,
    ).toBe('activation.changed');
    expect(() => parseManagedSessionEvent(activation('paused'))).toThrow(
      /phase must be one of/,
    );
  });

  it('ties the action decision reference to the decided state', () => {
    const action = (overrides: Record<string, unknown> = {}) => ({
      v: 1,
      sequence: 5,
      eventId: 'evt-5',
      sessionKey,
      kind: 'action.changed',
      occurredAt: 1,
      payload: {
        requestId: 'req-1',
        kind: 'permission',
        source: 'tool_call',
        inputRevision: 1,
        optionsRef: null,
        state: 'requested',
        decisionRef: null,
        ...overrides,
      },
    });

    expect(parseManagedSessionEvent(action()).kind).toBe('action.changed');
    expect(() =>
      parseManagedSessionEvent(action({ state: 'decided' })),
    ).toThrow(/decisionRef must be present/);
    expect(() =>
      parseManagedSessionEvent(action({ decisionRef: ref() })),
    ).toThrow(/decisionRef must be null/);
    expect(() => parseManagedSessionEvent(action({ source: 'guess' }))).toThrow(
      /source must be one of/,
    );
  });

  it('accepts only registered domains with a matching record ref', () => {
    const domainEvent = (overrides: Record<string, unknown> = {}) => ({
      v: 1,
      sequence: 6,
      eventId: 'evt-6',
      sessionKey,
      kind: 'domain.committed',
      occurredAt: 1,
      payload: {
        domain: 'session_metadata',
        version: 1,
        operationId: 'op-1',
        recordRef: ref('managed-session_metadata'),
        ...overrides,
      },
    });

    expect(parseManagedSessionEvent(domainEvent()).kind).toBe(
      'domain.committed',
    );
    expect(() =>
      parseManagedSessionEvent(domainEvent({ domain: 'history_operation' })),
    ).toThrow(/domain must be one of/);
    expect(() =>
      parseManagedSessionEvent(
        domainEvent({ recordRef: ref('managed-schedule') }),
      ),
    ).toThrow(/recordRef.kind must be managed-session_metadata/);
    expect(() => parseManagedSessionEvent(domainEvent({ version: 2 }))).toThrow(
      /version must be 1/,
    );
    expect(() =>
      parseManagedSessionEvent(
        domainEvent({
          recordRef: { ...ref('managed-session_metadata'), schemaVersion: 2 },
        }),
      ),
    ).toThrow(/recordRef.schemaVersion must be 1/);
  });

  it('requires event-sequence references to start at 1', () => {
    const wake = {
      v: 1,
      sequence: 2,
      eventId: 'evt-2',
      sessionKey,
      kind: 'wake.requested',
      occurredAt: 1,
      payload: {
        wakeId: 'wake-1',
        reason: 'input',
        subject: { type: 'turn', turnId: 'turn-1' },
        sourceEventId: 'evt-1',
        requiredSequence: 0,
      },
    };
    expect(() => parseManagedSessionEvent(wake)).toThrow(/must start at 1/);
    expect(() =>
      parseManagedSessionEvent({
        ...eventForKind('checkpoint.committed'),
        payload: {
          ...(eventForKind('checkpoint.committed')['payload'] as object),
          coveredSequence: 0,
        },
      }),
    ).toThrow(/must start at 1/);
    expect(() =>
      parseManagedSessionEvent({
        ...eventForKind('context.compacted'),
        payload: {
          ...(eventForKind('context.compacted')['payload'] as object),
          fromSequence: 0,
        },
      }),
    ).toThrow(/sequence references must start at 1/);
  });

  it('rejects a compaction range whose end precedes its start', () => {
    expect(() =>
      parseManagedSessionEvent({
        v: 1,
        sequence: 7,
        eventId: 'evt-7',
        sessionKey,
        kind: 'context.compacted',
        occurredAt: 1,
        subject: activationSubject,
        payload: {
          compactionId: 'compaction-1',
          fromSequence: 4,
          toSequence: 3,
          summaryRef: ref(),
          replacedMessageIds: [],
          tokenCountsRef: null,
        },
      }),
    ).toThrow(/toSequence must not precede payload.fromSequence/);
  });

  it('registers exactly the thirty v1 domains without duplicates', () => {
    expect(MANAGED_SESSION_DOMAINS).toHaveLength(30);
    expect(new Set(MANAGED_SESSION_DOMAINS).size).toBe(30);
  });

  it('validates the lifecycle target state', () => {
    const lifecycle = {
      v: 1,
      sequence: 7,
      eventId: 'evt-7',
      sessionKey,
      kind: 'lifecycle.changed',
      occurredAt: 1,
      payload: {
        operationId: 'op-1',
        from: 'idle',
        to: 'sleeping',
        reason: 'test',
        pendingOwnersRef: null,
      },
    };
    expect(() => parseManagedSessionEvent(lifecycle)).toThrow(
      /to must be one of/,
    );
  });

  it('rejects a disallowed lifecycle transition', () => {
    expect(() =>
      parseManagedSessionEvent({
        v: 1,
        sequence: 7,
        eventId: 'evt-7',
        sessionKey,
        kind: 'lifecycle.changed',
        occurredAt: 1,
        payload: {
          operationId: 'op-1',
          from: 'active',
          to: 'closed',
          reason: 'test',
          pendingOwnersRef: null,
        },
      }),
    ).toThrow(/cannot transition from active to closed/);
  });
});

describe('managed session actor eligibility', () => {
  it('lets only the coordinator change an activation', () => {
    const event = parseManagedSessionEvent({
      v: 1,
      sequence: 3,
      eventId: 'evt-3',
      sessionKey,
      kind: 'activation.changed',
      occurredAt: 1,
      payload: {
        activationId: 'act-1',
        epoch: 3,
        workerId: 'worker-1',
        subject: activationSubject,
        phase: 'active',
        leaseDurationMs: 60_000,
        expiresAt: 2,
        installRef: ref(),
        boundaryRef: null,
      },
    });
    expect(() =>
      assertManagedSessionEventActor(event, 'coordinator'),
    ).not.toThrow();
    expect(() => assertManagedSessionEventActor(event, 'harness')).toThrow(
      /must not be requested by harness/,
    );
  });

  it('keeps wake.requested internal to the authority', () => {
    const event = parseManagedSessionEvent({
      v: 1,
      sequence: 2,
      eventId: 'evt-2',
      sessionKey,
      kind: 'wake.requested',
      occurredAt: 1,
      payload: {
        wakeId: 'wake-1',
        reason: 'input',
        subject: { type: 'turn', turnId: 'turn-1' },
        sourceEventId: 'evt-1',
        requiredSequence: 1,
      },
    });
    expect(() =>
      assertManagedSessionEventActor(event, 'authority'),
    ).not.toThrow();
    expect(() =>
      assertManagedSessionEventActor(event, 'trusted_entry'),
    ).toThrow(/must not be requested by trusted_entry/);
  });

  it('splits action.changed between the harness and the trusted entry', () => {
    const action = (source: string, state: string) =>
      parseManagedSessionEvent({
        v: 1,
        sequence: 5,
        eventId: 'evt-5',
        sessionKey,
        kind: 'action.changed',
        occurredAt: 1,
        payload: {
          requestId: 'req-1',
          kind: 'permission',
          source,
          inputRevision: 1,
          optionsRef: null,
          state,
          decisionRef: state === 'decided' ? ref() : null,
        },
      });

    expect(() =>
      assertManagedSessionEventActor(
        action('tool_call', 'requested'),
        'harness',
      ),
    ).not.toThrow();
    expect(() =>
      assertManagedSessionEventActor(
        action('tool_call', 'requested'),
        'trusted_entry',
      ),
    ).toThrow(/must be requested by harness/);
    expect(() =>
      assertManagedSessionEventActor(
        action('automation_run', 'requested'),
        'harness',
      ),
    ).toThrow(/must be requested by trusted_entry/);
    expect(() =>
      assertManagedSessionEventActor(action('tool_call', 'decided'), 'harness'),
    ).toThrow(/must be requested by trusted_entry/);
  });
});

describe('managed session lifecycle transitions', () => {
  it('allows only the documented transitions', () => {
    expect(isManagedSessionLifecycleTransitionAllowed(null, 'idle')).toBe(true);
    expect(isManagedSessionLifecycleTransitionAllowed(null, 'active')).toBe(
      false,
    );
    expect(isManagedSessionLifecycleTransitionAllowed('idle', 'active')).toBe(
      true,
    );
    expect(isManagedSessionLifecycleTransitionAllowed('active', 'closed')).toBe(
      false,
    );
    expect(
      isManagedSessionLifecycleTransitionAllowed('closing', 'closed'),
    ).toBe(true);
    expect(
      isManagedSessionLifecycleTransitionAllowed('archived', 'closed'),
    ).toBe(true);
    expect(isManagedSessionLifecycleTransitionAllowed('deleted', 'idle')).toBe(
      false,
    );
  });

  it('blocks every state except deleted and restores a legal stage', () => {
    expect(
      isManagedSessionLifecycleTransitionAllowed('active', 'recovery_blocked'),
    ).toBe(true);
    expect(
      isManagedSessionLifecycleTransitionAllowed('deleted', 'recovery_blocked'),
    ).toBe(false);
    expect(
      isManagedSessionLifecycleTransitionAllowed('recovery_blocked', 'active'),
    ).toBe(true);
    expect(
      isManagedSessionLifecycleTransitionAllowed('recovery_blocked', 'deleted'),
    ).toBe(false);
    expect(
      isManagedSessionLifecycleTransitionAllowed(
        'recovery_blocked',
        'recovery_blocked',
      ),
    ).toBe(false);
  });

  it('fails closed for invalid direct-call states and pins terminal transitions', () => {
    expect(
      isManagedSessionLifecycleTransitionAllowed('sleeping' as never, 'idle'),
    ).toBe(false);
    expect(
      isManagedSessionLifecycleTransitionAllowed('closed', 'deleting'),
    ).toBe(true);
    expect(
      isManagedSessionLifecycleTransitionAllowed('deleting', 'deleted'),
    ).toBe(true);
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

  it('accepts a v1 header without a base transcript proof', () => {
    expect(parseManagedSessionHeader(header()).engine).toBe('managed');
  });

  it('refuses a newer format or reader requirement', () => {
    expect(() =>
      parseManagedSessionHeader(header({ formatVersion: 2 })),
    ).toThrow(/is not supported by this reader/);
    expect(() =>
      parseManagedSessionHeader(header({ minimumReader: 'managed-session/2' })),
    ).toThrow(/is not supported by this reader/);
  });

  it('accepts an older minimum-reader requirement and returns its token', () => {
    expect(
      parseManagedSessionHeader(header({ minimumReader: 'managed-session/0' }))
        .minimumReader,
    ).toBe('managed-session/0');
  });

  it('validates and preserves a base transcript proof', () => {
    expect(
      parseManagedSessionHeader(header({ baseTranscriptProof: ref() }))
        .baseTranscriptProof,
    ).toEqual(ref());
    expect(() =>
      parseManagedSessionHeader(
        header({ baseTranscriptProof: { ...ref(), digest: 'ZZ' } }),
      ),
    ).toThrow(/lowercase SHA-256/);
  });

  it('uses managed validation errors for unsupported structured versions', () => {
    const unsupported = Object.create(null) as Record<string, never>;
    expect(() =>
      parseManagedSessionHeader(header({ formatVersion: unsupported })),
    ).toThrow(ManagedSessionRecordError);
    expect(() =>
      parseManagedSessionHeader(header({ minimumReader: unsupported })),
    ).toThrow(ManagedSessionRecordError);
  });

  it('refuses a non-managed engine', () => {
    expect(() =>
      parseManagedSessionHeader(header({ engine: 'legacy' })),
    ).toThrow(/engine must be managed/);
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

  it('accepts a marker whose range matches its event count', () => {
    expect(parseManagedSessionCommitMarker(marker()).eventCount).toBe(2);
  });

  it('rejects a range that disagrees with the event count', () => {
    expect(() =>
      parseManagedSessionCommitMarker(marker({ lastSequence: 5 })),
    ).toThrow(/must match commit.eventCount/);
  });

  it('requires the committed range to start at sequence 1 or later', () => {
    expect(() =>
      parseManagedSessionCommitMarker(
        marker({ firstSequence: 0, lastSequence: 1 }),
      ),
    ).toThrow(/firstSequence must start at 1/);
  });

  it('rejects an empty or oversized transaction', () => {
    expect(() =>
      parseManagedSessionCommitMarker(
        marker({ eventCount: 0, lastSequence: 0 }),
      ),
    ).toThrow(/at least one event/);
    expect(() =>
      parseManagedSessionCommitMarker(
        marker({ eventCount: 257, lastSequence: 257 }),
      ),
    ).toThrow(/exceeds 256 events/);
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

  it('accepts a contiguous single-session range', () => {
    expect(() =>
      assertManagedSessionTransaction([event(1), event(2)], 1024),
    ).not.toThrow();
  });

  it('rejects an empty transaction or one over the event-count limit', () => {
    expect(() => assertManagedSessionTransaction([], 0)).toThrow(
      /must contain at least one event/,
    );
    const events = Array.from(
      { length: MANAGED_SESSION_LIMITS.maxTransactionEvents + 1 },
      (_, index) => event(index + 1),
    );
    expect(() => assertManagedSessionTransaction(events, 1024)).toThrow(
      /must not exceed 256 events/,
    );
  });

  it('rejects a gap in the sequence range', () => {
    expect(() =>
      assertManagedSessionTransaction([event(1), event(3)], 1024),
    ).toThrow(/contiguous sequence range/);
  });

  it.each([
    { ...sessionKey, tenantId: 't2' },
    { ...sessionKey, workspaceId: 'w2' },
    { ...sessionKey, sessionId: 's2' },
  ])('rejects a transaction that spans session keys', (other) => {
    expect(() =>
      assertManagedSessionTransaction([event(1), event(2, other)], 1024),
    ).toThrow(/must not span sessions/);
  });

  it('rejects an oversized transaction', () => {
    expect(() =>
      assertManagedSessionTransaction(
        [event(1)],
        MANAGED_SESSION_LIMITS.maxTransactionBytes,
      ),
    ).not.toThrow();
    expect(() =>
      assertManagedSessionTransaction(
        [event(1)],
        MANAGED_SESSION_LIMITS.maxTransactionBytes + 1,
      ),
    ).toThrow(/must not exceed 8388608 bytes/);
  });

  it('rejects an invalid encoded transaction size', () => {
    expect(() =>
      assertManagedSessionTransaction([event(1)], Number.NaN),
    ).toThrow(/encoded size must be a positive safe integer/);
    expect(() => assertManagedSessionTransaction([event(1)], -1)).toThrow(
      /encoded size must be a positive safe integer/,
    );
    expect(() => assertManagedSessionTransaction([event(1)], 0)).toThrow(
      /encoded size must be a positive safe integer/,
    );
  });

  it('rejects array subclasses before they can bypass transaction checks', () => {
    class EventArraySubclass extends Array<ManagedSessionEvent> {
      override forEach(): void {}
    }
    const events = new EventArraySubclass(
      event(1),
      event(3, { ...sessionKey, workspaceId: 'w2' }),
    );
    expect(() => assertManagedSessionTransaction(events, 1024)).toThrow(
      /plain JSON array/,
    );
  });

  it('digests the committed event identities stably', () => {
    const digest = managedSessionEventsDigest([event(1), event(2)]);
    expect(digest).toBe(
      'd384980415770708f9dd1ff12495d45c8fdbf8508aac8ddd8359362048398e8a',
    );
    expect(managedSessionEventsDigest([event(1), event(2)])).toBe(digest);
    expect(managedSessionEventsDigest([event(2), event(1)])).not.toBe(digest);
  });

  it('bounds digest input before encoding event identities', () => {
    const events = Array.from(
      { length: MANAGED_SESSION_LIMITS.maxTransactionEvents + 1 },
      (_, index) => event(index + 1),
    );
    expect(() => managedSessionEventsDigest(events)).toThrow(
      /must not exceed 256 events/,
    );
  });
});

describe('managed session raw record parsing', () => {
  it('rejects duplicate keys that JSON.parse would silently collapse', () => {
    const text = '{"a":1,"a":2}';
    expect(JSON.parse(text)).toEqual({ a: 2 });
    expect(() => parseManagedSessionRecordJson(text, 1024)).toThrow(
      /duplicate JSON key "a"/,
    );
  });

  it('detects duplicate keys written with different escapes', () => {
    expect(() =>
      parseManagedSessionRecordJson('{"a":1,"\\u0061":2}', 1024),
    ).toThrow(/duplicate JSON key "a"/);
  });

  it('allows the same key name in sibling objects and inside arrays', () => {
    expect(
      parseManagedSessionRecordJson('{"x":{"a":1},"y":{"a":2}}', 1024),
    ).toEqual({ x: { a: 1 }, y: { a: 2 } });
    expect(
      parseManagedSessionRecordJson('{"list":[{"a":1},{"a":2}]}', 1024),
    ).toEqual({ list: [{ a: 1 }, { a: 2 }] });
  });

  it('does not treat a string value that looks like a key as a key', () => {
    expect(parseManagedSessionRecordJson('{"a":"b","c":"a"}', 1024)).toEqual({
      a: 'b',
      c: 'a',
    });
  });

  it('ignores braces inside string values', () => {
    expect(
      parseManagedSessionRecordJson('{"a":"{\\"a\\":1}","b":2}', 1024),
    ).toEqual({ a: '{"a":1}', b: 2 });
  });

  it('enforces the byte cap before parsing', () => {
    const text = JSON.stringify({ a: 'x'.repeat(200) });
    expect(() => parseManagedSessionRecordJson(text, 64)).toThrow(
      /exceeds 64 UTF-8 bytes/,
    );
  });

  it('requires a positive safe byte cap', () => {
    expect(() => parseManagedSessionRecordJson('{}', Number.NaN)).toThrow(
      /byte limit must be a positive safe integer/,
    );
    expect(() => parseManagedSessionRecordJson('{}', 0)).toThrow(
      /byte limit must be a positive safe integer/,
    );
  });

  it('enforces the maximum JSON depth', () => {
    const exact = MANAGED_SESSION_LIMITS.maxJsonDepth;
    expect(() =>
      parseManagedSessionRecordJson(
        '['.repeat(exact) + ']'.repeat(exact),
        1024 * 1024,
      ),
    ).not.toThrow();
    const depth = MANAGED_SESSION_LIMITS.maxJsonDepth + 1;
    const text = '['.repeat(depth) + ']'.repeat(depth);
    expect(() => parseManagedSessionRecordJson(text, 1024 * 1024)).toThrow(
      /maximum JSON depth/,
    );
  });

  it('rejects malformed JSON', () => {
    expect(() => parseManagedSessionRecordJson('{"a":}', 1024)).toThrow(
      /not valid JSON/,
    );
  });

  it('rejects non-finite numbers produced by JSON exponent overflow', () => {
    expect(() => parseManagedSessionRecordJson('1e400', 1024)).toThrow(
      /numbers must be finite/,
    );
  });

  it('uses the declared header byte cap', () => {
    const exact = JSON.stringify(
      'x'.repeat(MANAGED_SESSION_LIMITS.maxHeaderBytes - 2),
    );
    expect(
      parseManagedSessionRecordJson(
        exact,
        MANAGED_SESSION_LIMITS.maxHeaderBytes,
      ),
    ).toBe('x'.repeat(MANAGED_SESSION_LIMITS.maxHeaderBytes - 2));
    const over = JSON.stringify(
      'x'.repeat(MANAGED_SESSION_LIMITS.maxHeaderBytes - 1),
    );
    expect(() =>
      parseManagedSessionRecordJson(
        over,
        MANAGED_SESSION_LIMITS.maxHeaderBytes,
      ),
    ).toThrow(/exceeds 65536 UTF-8 bytes/);
  });
});

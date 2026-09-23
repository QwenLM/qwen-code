/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  authorizeParsedHarnessCheckpoint,
  createAwaitActionHarnessCheckpoint,
  createAwaitRuntimeHarnessCheckpoint,
  createConsumedRuntimeResultsHarnessCheckpoint,
  createInitialHarnessCheckpoint,
  createModelOutputCommittedHarnessCheckpoint,
  createNextTurnReadyHarnessCheckpoint,
  createResultsReadyHarnessCheckpoint,
  encodeHarnessCheckpointV1,
  parseHarnessCheckpointV1,
  tryParseHarnessCheckpointV1,
  type HarnessCheckpointV1,
} from './managed-harness-checkpoint.js';
import {
  ManagedSessionRecordError,
  type ManagedSessionDurableRef,
} from './managed-session-records.js';

const DIGEST = 'b'.repeat(64);
const SESSION_KEY = {
  tenantId: 'tenant-1',
  workspaceId: 'workspace-1',
  sessionId: 'managed-session',
};

function ref(kind = 'managed-test'): ManagedSessionDurableRef {
  return {
    resourceId: 'res-1',
    kind,
    schemaVersion: 1,
    byteLength: 4,
    digest: DIGEST,
  };
}

function seed(
  overrides: Partial<Parameters<typeof createInitialHarnessCheckpoint>[0]> = {},
): HarnessCheckpointV1 {
  return createInitialHarnessCheckpoint({
    sessionKey: SESSION_KEY,
    checkpointId: 'ckpt-4',
    coveredSequence: 3,
    activationId: 'act-1',
    turnId: 'turn-1',
    promptId: null,
    definitionRevision: 'def-1',
    configRevision: 'cfg-1',
    inputDigest: DIGEST,
    previousCheckpointId: null,
    ...overrides,
  });
}

function bytesOf(checkpoint: HarnessCheckpointV1): Buffer {
  return encodeHarnessCheckpointV1(checkpoint);
}

function mutate(
  checkpoint: HarnessCheckpointV1,
  edit: (value: Record<string, unknown>) => void,
): Buffer {
  const value = JSON.parse(JSON.stringify(checkpoint)) as Record<
    string,
    unknown
  >;
  edit(value);
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function committedAttempt() {
  return {
    attemptId: 'att-1',
    routeRef: ref('managed-route'),
    capabilityRef: null,
    samplingRef: null,
    outputState: 'output_committed' as const,
    usageRef: ref('managed-usage'),
    budgetConsumed: 1,
  };
}

function requestedUserApproval() {
  return {
    requestId: 'apr-1',
    kind: 'ask_user',
    source: 'user_operation' as const,
    optionsRef: ref('managed-approval'),
    inputRevision: 'rev-1',
    confirmationVersion: null,
    state: 'requested' as const,
    decisionRef: null,
    invocationRef: null,
  };
}

function inProgressRuntime() {
  return {
    tools: {
      batchId: 'batch-1',
      items: [
        {
          functionCallId: 'fc-1',
          toolName: 'read_file',
          executionCallId: 'ex-1',
          modelMessageId: 'msg-1',
          partIndex: 0,
          ordinal: 0,
          inputDigest: DIGEST,
          outcomeSource: 'runtime' as const,
          state: 'in_progress' as const,
          outcomeRef: null,
          consumed: false,
        },
      ],
    },
    runtime: {
      bindings: [
        {
          executionCallId: 'ex-1',
          invocationBindingId: 'bind-1',
          capabilityVersion: 'cap-1',
          policyVersion: 'pol-1',
          mediaVersion: null,
          state: 'dispatch' as const,
          progressCursor: null,
        },
      ],
    },
  };
}

describe('harness checkpoint v1', () => {
  it('round-trips a before_model checkpoint with all nine groups', () => {
    const checkpoint = seed();
    expect(checkpoint.continuation.phase).toBe('before_model');
    expect(checkpoint.attempt).toBeNull();
    expect(checkpoint.tools).toBeNull();
    expect(checkpoint.runtime).toBeNull();
    expect(checkpoint.approval).toBeNull();
    expect(parseHarnessCheckpointV1(bytesOf(checkpoint))).toEqual(checkpoint);
    expect(tryParseHarnessCheckpointV1(bytesOf(checkpoint))).toEqual({
      ok: true,
      checkpoint,
    });
  });

  it('rejects an unknown continuation phase', () => {
    const bytes = mutate(seed(), (value) => {
      const continuation = value['continuation'] as Record<string, unknown>;
      continuation['phase'] = 'streaming';
    });
    expect(() => parseHarnessCheckpointV1(bytes)).toThrow(
      ManagedSessionRecordError,
    );
    expect(() => parseHarnessCheckpointV1(bytes)).toThrow(
      /continuation.phase must be one of/,
    );
    const parsed = tryParseHarnessCheckpointV1(bytes);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe('invalid');
  });

  it('rejects a before_model checkpoint that already carries an attempt', () => {
    const checkpoint = {
      ...seed(),
      attempt: committedAttempt(),
    };
    expect(() => parseHarnessCheckpointV1(bytesOf(checkpoint))).toThrow(
      /before_model cannot carry a model attempt/,
    );
  });

  it('rejects a user_operation approval that carries an invocation ref', () => {
    const checkpoint = {
      ...seed(),
      continuation: {
        phase: 'await_action' as const,
        pendingEventIds: [],
      },
      attempt: committedAttempt(),
      approval: {
        ...requestedUserApproval(),
        invocationRef: ref('managed-invocation'),
      },
    };
    expect(() => parseHarnessCheckpointV1(bytesOf(checkpoint))).toThrow(
      /approval.invocationRef must be null for a user_operation approval/,
    );
  });

  it('rejects a tool_call approval without an invocation ref', () => {
    const checkpoint = {
      ...seed(),
      continuation: {
        phase: 'await_action' as const,
        pendingEventIds: [],
      },
      attempt: committedAttempt(),
      approval: {
        ...requestedUserApproval(),
        source: 'tool_call' as const,
      },
    };
    expect(() => parseHarnessCheckpointV1(bytesOf(checkpoint))).toThrow(
      /approval.invocationRef is required for a tool_call approval/,
    );
  });

  it('rejects await_runtime without in-flight tools and dispatch bindings', () => {
    const checkpoint = {
      ...seed(),
      continuation: {
        phase: 'await_runtime' as const,
        pendingEventIds: [],
      },
      attempt: committedAttempt(),
    };
    expect(() => parseHarnessCheckpointV1(bytesOf(checkpoint))).toThrow(
      /await_runtime requires in-progress tools and dispatch bindings/,
    );
  });

  it('accepts await_action for a requested user_operation', () => {
    const checkpoint = {
      ...seed(),
      continuation: {
        phase: 'await_action' as const,
        pendingEventIds: [],
      },
      attempt: committedAttempt(),
      approval: requestedUserApproval(),
    };
    expect(parseHarnessCheckpointV1(bytesOf(checkpoint))).toEqual(checkpoint);
  });

  it('accepts await_runtime with in-progress tools and dispatch bindings', () => {
    const checkpoint = {
      ...seed(),
      continuation: {
        phase: 'await_runtime' as const,
        pendingEventIds: [],
      },
      attempt: committedAttempt(),
      tools: {
        batchId: 'batch-1',
        items: [
          {
            functionCallId: 'fc-1',
            toolName: 'read_file',
            executionCallId: 'ex-1',
            modelMessageId: 'msg-1',
            partIndex: 0,
            ordinal: 0,
            inputDigest: DIGEST,
            outcomeSource: 'runtime' as const,
            state: 'in_progress' as const,
            outcomeRef: null,
            consumed: false,
          },
        ],
      },
      runtime: {
        bindings: [
          {
            executionCallId: 'ex-1',
            invocationBindingId: 'bind-1',
            capabilityVersion: 'cap-1',
            policyVersion: 'pol-1',
            mediaVersion: null,
            state: 'dispatch' as const,
            progressCursor: 'cur-1',
          },
        ],
      },
    };
    expect(parseHarnessCheckpointV1(bytesOf(checkpoint))).toEqual(checkpoint);
  });

  it('rejects unknown fields on the checkpoint object', () => {
    const bytes = mutate(seed(), (value) => {
      value['agentSnapshot'] = { tokens: 1 };
    });
    expect(() => parseHarnessCheckpointV1(bytes)).toThrow(
      /harness checkpoint has the unknown field "agentSnapshot"/,
    );
    const parsed = tryParseHarnessCheckpointV1(bytes);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe('invalid');
  });

  it('classifies non-JSON and unversioned blobs as opaque', () => {
    expect(tryParseHarnessCheckpointV1(Buffer.from('first', 'utf8'))).toEqual({
      ok: false,
      reason: 'opaque',
      message: expect.stringMatching(/JSON/),
    });
    expect(
      tryParseHarnessCheckpointV1(
        Buffer.from('{"turn":1,"pending":[]}', 'utf8'),
      ),
    ).toEqual({
      ok: false,
      reason: 'opaque',
      message: 'checkpoint state has no Harness schemaVersion.',
    });
  });

  it('does not treat an in-flight model stream as a runnable phase', () => {
    const checkpoint = {
      ...seed(),
      continuation: {
        phase: 'model_output_committed' as const,
        pendingEventIds: [],
      },
      attempt: {
        ...committedAttempt(),
        outputState: 'started' as const,
        usageRef: null,
      },
    };
    expect(() => parseHarnessCheckpointV1(bytesOf(checkpoint))).toThrow(
      /an in-flight model stream is not a runnable checkpoint phase/,
    );
  });

  it('authorizes a parsed checkpoint only when identity matches', () => {
    const checkpoint = seed();
    expect(
      authorizeParsedHarnessCheckpoint(checkpoint, {
        sessionKey: SESSION_KEY,
        checkpointId: 'ckpt-4',
        coveredSequence: 3,
      }),
    ).toEqual({ status: 'runnable', checkpoint });
    expect(
      authorizeParsedHarnessCheckpoint(checkpoint, {
        sessionKey: { ...SESSION_KEY, sessionId: 'other-session' },
        checkpointId: 'ckpt-4',
        coveredSequence: 3,
      }),
    ).toMatchObject({ status: 'blocked', reason: 'identity_mismatch' });
  });

  it('clears in-flight groups when preparing the next-turn-ready checkpoint', () => {
    const previous = {
      ...seed(),
      continuation: {
        phase: 'turn_settled' as const,
        pendingEventIds: ['evt-1'],
      },
      attempt: committedAttempt(),
      followUp: {
        ...seed().followUp,
        pendingInputIds: ['in-2'],
      },
    };
    const next = createNextTurnReadyHarnessCheckpoint({
      previous,
      checkpointId: 'ckpt-6',
      coveredSequence: 4,
      previousCheckpointId: 'ckpt-4',
      activationId: 'act-2',
      turnId: 'turn-2',
      promptId: 'turn-2',
    });
    expect(next.continuation.phase).toBe('before_model');
    expect(next.continuation.pendingEventIds).toEqual([]);
    expect(next.attempt).toBeNull();
    expect(next.tools).toBeNull();
    expect(next.identity).toMatchObject({
      checkpointId: 'ckpt-6',
      coveredSequence: 4,
      previousCheckpointId: 'ckpt-4',
      activationId: 'act-2',
      turnId: 'turn-2',
      promptId: 'turn-2',
    });
    expect(next.resume.throughSequence).toBe(4);
    expect(next.followUp.pendingInputIds).toEqual(['in-2']);
    expect(parseHarnessCheckpointV1(bytesOf(next))).toEqual(next);
  });

  it('builds await_action from a previous checkpoint and resumes to model_output_committed', () => {
    const wait = createAwaitActionHarnessCheckpoint({
      previous: seed(),
      checkpointId: 'ckpt-5',
      coveredSequence: 4,
      previousCheckpointId: 'ckpt-4',
      attempt: committedAttempt(),
      approval: requestedUserApproval(),
    });
    expect(wait.continuation.phase).toBe('await_action');
    expect(wait.approval?.state).toBe('requested');
    expect(wait.resume.throughSequence).toBe(4);
    expect(parseHarnessCheckpointV1(bytesOf(wait))).toEqual(wait);

    const resumed = createModelOutputCommittedHarnessCheckpoint({
      previous: wait,
      checkpointId: 'ckpt-6',
      coveredSequence: 5,
      previousCheckpointId: 'ckpt-5',
    });
    expect(resumed.continuation.phase).toBe('model_output_committed');
    expect(resumed.approval).toBeNull();
    expect(resumed.attempt).toEqual(wait.attempt);
    expect(parseHarnessCheckpointV1(bytesOf(resumed))).toEqual(resumed);
  });

  it('rejects model_output_committed resume without the waited attempt', () => {
    expect(() =>
      createModelOutputCommittedHarnessCheckpoint({
        previous: seed(),
        checkpointId: 'ckpt-5',
        coveredSequence: 4,
        previousCheckpointId: 'ckpt-4',
      }),
    ).toThrow(/requires the waited attempt/);
  });

  it('builds await_runtime from a previous checkpoint and resumes to results_ready', () => {
    const wait = createAwaitRuntimeHarnessCheckpoint({
      previous: seed(),
      checkpointId: 'ckpt-5',
      coveredSequence: 4,
      previousCheckpointId: 'ckpt-4',
      attempt: committedAttempt(),
      ...inProgressRuntime(),
    });
    expect(wait.continuation.phase).toBe('await_runtime');
    expect(wait.approval).toBeNull();
    expect(wait.tools?.items[0]?.state).toBe('in_progress');
    expect(wait.runtime?.bindings[0]?.state).toBe('dispatch');
    expect(parseHarnessCheckpointV1(bytesOf(wait))).toEqual(wait);

    const outcomeRef = ref('managed-tool-outcome');
    const ready = createResultsReadyHarnessCheckpoint({
      previous: wait,
      checkpointId: 'ckpt-6',
      coveredSequence: 5,
      previousCheckpointId: 'ckpt-5',
      outcomeRef,
    });
    expect(ready.continuation.phase).toBe('results_ready');
    expect(ready.tools?.items[0]).toMatchObject({
      state: 'settled',
      outcomeRef,
      consumed: false,
    });
    expect(ready.runtime?.bindings[0]?.state).toBe('settled');
    expect(parseHarnessCheckpointV1(bytesOf(ready))).toEqual(ready);

    const consumed = createConsumedRuntimeResultsHarnessCheckpoint({
      previous: ready,
      checkpointId: 'ckpt-7',
      coveredSequence: 6,
      previousCheckpointId: 'ckpt-6',
    });
    expect(consumed.continuation.phase).toBe('results_ready');
    expect(consumed.tools?.items[0]).toMatchObject({
      state: 'settled',
      outcomeRef,
      consumed: true,
    });
    expect(parseHarnessCheckpointV1(bytesOf(consumed))).toEqual(consumed);
  });

  it('rejects await_runtime that still has a requested approval', () => {
    const previous = createAwaitActionHarnessCheckpoint({
      previous: seed(),
      checkpointId: 'ckpt-5',
      coveredSequence: 4,
      previousCheckpointId: 'ckpt-4',
      attempt: committedAttempt(),
      approval: requestedUserApproval(),
    });
    expect(() =>
      createAwaitRuntimeHarnessCheckpoint({
        previous,
        checkpointId: 'ckpt-6',
        coveredSequence: 5,
        previousCheckpointId: 'ckpt-5',
        attempt: committedAttempt(),
        ...inProgressRuntime(),
      }),
    ).toThrow(/cannot keep a requested approval/);
  });

  it('rejects consumed Runtime results without a results_ready checkpoint', () => {
    expect(() =>
      createConsumedRuntimeResultsHarnessCheckpoint({
        previous: seed(),
        checkpointId: 'ckpt-5',
        coveredSequence: 4,
        previousCheckpointId: 'ckpt-4',
      }),
    ).toThrow(/require a results_ready checkpoint/);
  });

  it('rejects results_ready resume without an await_runtime checkpoint', () => {
    expect(() =>
      createResultsReadyHarnessCheckpoint({
        previous: seed(),
        checkpointId: 'ckpt-5',
        coveredSequence: 4,
        previousCheckpointId: 'ckpt-4',
        outcomeRef: ref('managed-tool-outcome'),
      }),
    ).toThrow(/requires an await_runtime checkpoint/);
  });
});

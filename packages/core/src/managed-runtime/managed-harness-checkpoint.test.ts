/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  authorizeParsedHarnessCheckpoint,
  createAwaitActionHarnessCheckpoint,
  createAwaitAgentHarnessCheckpoint,
  createAwaitRuntimeHarnessCheckpoint,
  createConsumedAgentWaitHarnessCheckpoint,
  createConsumedRuntimeResultsHarnessCheckpoint,
  createHookStoppedRuntimeHarnessCheckpoint,
  createInitialHarnessCheckpoint,
  createModelOutputCommittedHarnessCheckpoint,
  createNextTurnReadyHarnessCheckpoint,
  createResultsReadyHarnessCheckpoint,
  createTurnSettledHarnessCheckpoint,
  encodeHarnessCheckpointV1,
  parseHarnessCheckpointV1,
  tryParseHarnessCheckpointV1,
  type HarnessAgentWaitGroup,
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

function agentWaitOf(childRunIds: readonly string[]): HarnessAgentWaitGroup {
  return {
    runs: childRunIds.map((childRunId, index) => ({
      childRunId,
      functionCallId: `fc-${index + 1}`,
      toolName: 'agent',
      modelMessageId: 'msg-1',
      consumed: false,
    })),
  };
}

describe('harness checkpoint v1', () => {
  it('round-trips a before_model checkpoint with all groups', () => {
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
      executionCallId: 'ex-1',
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

    const stopped = createHookStoppedRuntimeHarnessCheckpoint({
      previous: ready,
      checkpointId: 'ckpt-7',
      coveredSequence: 6,
      previousCheckpointId: 'ckpt-6',
    });
    expect(stopped.continuation.phase).toBe('turn_settled');
    expect(stopped.tools).toEqual(ready.tools);
    expect(stopped.runtime).toEqual(ready.runtime);
    expect(stopped.tools?.items[0]?.consumed).toBe(false);
    expect(parseHarnessCheckpointV1(bytesOf(stopped))).toEqual(stopped);
    expect(() =>
      createTurnSettledHarnessCheckpoint({
        previous: ready,
        checkpointId: 'ckpt-7',
        coveredSequence: 6,
        previousCheckpointId: 'ckpt-6',
      }),
    ).toThrow('every Runtime receipt to be consumed');
    expect(() =>
      createHookStoppedRuntimeHarnessCheckpoint({
        previous: wait,
        checkpointId: 'ckpt-7',
        coveredSequence: 6,
        previousCheckpointId: 'ckpt-6',
      }),
    ).toThrow('settled Runtime results not yet consumed');

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
    expect(() =>
      createHookStoppedRuntimeHarnessCheckpoint({
        previous: consumed,
        checkpointId: 'ckpt-8',
        coveredSequence: 7,
        previousCheckpointId: 'ckpt-7',
      }),
    ).toThrow('settled Runtime results not yet consumed');
  });

  it('settles multiple Runtime executions independently in reverse order', () => {
    const runtime = inProgressRuntime();
    const wait = createAwaitRuntimeHarnessCheckpoint({
      previous: seed(),
      checkpointId: 'ckpt-5',
      coveredSequence: 4,
      previousCheckpointId: 'ckpt-4',
      attempt: committedAttempt(),
      tools: {
        ...runtime.tools,
        items: [
          ...runtime.tools.items,
          {
            ...runtime.tools.items[0],
            functionCallId: 'fc-2',
            executionCallId: 'ex-2',
            ordinal: 1,
          },
        ],
      },
      runtime: {
        bindings: [
          ...runtime.runtime.bindings,
          {
            ...runtime.runtime.bindings[0],
            executionCallId: 'ex-2',
            invocationBindingId: 'bind-2',
          },
        ],
      },
    });
    const secondRef = ref('managed-tool-outcome-2');
    const partial = createResultsReadyHarnessCheckpoint({
      previous: wait,
      checkpointId: 'ckpt-6',
      coveredSequence: 5,
      previousCheckpointId: 'ckpt-5',
      executionCallId: 'ex-2',
      outcomeRef: secondRef,
    });
    expect(partial.continuation.phase).toBe('await_runtime');
    expect(partial.tools?.items).toMatchObject([
      { executionCallId: 'ex-1', state: 'in_progress', outcomeRef: null },
      { executionCallId: 'ex-2', state: 'settled', outcomeRef: secondRef },
    ]);
    expect(partial.runtime?.bindings.map((binding) => binding.state)).toEqual([
      'dispatch',
      'settled',
    ]);
    expect(parseHarnessCheckpointV1(bytesOf(partial))).toEqual(partial);

    const firstRef = ref('managed-tool-outcome-1');
    const ready = createResultsReadyHarnessCheckpoint({
      previous: partial,
      checkpointId: 'ckpt-7',
      coveredSequence: 6,
      previousCheckpointId: 'ckpt-6',
      executionCallId: 'ex-1',
      outcomeRef: firstRef,
    });
    expect(ready.continuation.phase).toBe('results_ready');
    expect(ready.tools?.items.map((item) => item.outcomeRef)).toEqual([
      firstRef,
      secondRef,
    ]);
    expect(ready.runtime?.bindings.map((binding) => binding.state)).toEqual([
      'settled',
      'settled',
    ]);
    expect(parseHarnessCheckpointV1(bytesOf(ready))).toEqual(ready);
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
        executionCallId: 'ex-1',
        outcomeRef: ref('managed-tool-outcome'),
      }),
    ).toThrow(/requires an await_runtime checkpoint/);
  });

  it('round-trips an await_agent checkpoint and its consumed advancement', () => {
    const wait = createAwaitAgentHarnessCheckpoint({
      previous: seed(),
      checkpointId: 'ckpt-5',
      coveredSequence: 4,
      previousCheckpointId: 'ckpt-4',
      attempt: committedAttempt(),
      agentWait: agentWaitOf(['run-1', 'run-2']),
    });
    expect(wait.continuation.phase).toBe('await_agent');
    expect(wait.approval).toBeNull();
    expect(wait.agentWait?.runs).toHaveLength(2);
    expect(parseHarnessCheckpointV1(bytesOf(wait))).toEqual(wait);

    const partial = createConsumedAgentWaitHarnessCheckpoint({
      previous: wait,
      checkpointId: 'ckpt-6',
      coveredSequence: 5,
      previousCheckpointId: 'ckpt-5',
      childRunId: 'run-1',
    });
    expect(partial.continuation.phase).toBe('await_agent');
    expect(partial.agentWait?.runs).toMatchObject([
      { childRunId: 'run-1', consumed: true },
      { childRunId: 'run-2', consumed: false },
    ]);
    expect(parseHarnessCheckpointV1(bytesOf(partial))).toEqual(partial);

    const advanced = createConsumedAgentWaitHarnessCheckpoint({
      previous: partial,
      checkpointId: 'ckpt-7',
      coveredSequence: 6,
      previousCheckpointId: 'ckpt-6',
      childRunId: 'run-2',
    });
    expect(advanced.continuation.phase).toBe('model_output_committed');
    expect(advanced.agentWait?.runs.every((run) => run.consumed)).toBe(true);
    expect(parseHarnessCheckpointV1(bytesOf(advanced))).toEqual(advanced);
  });

  it('treats a checkpoint without an agentWait key as carrying none', () => {
    const bytes = mutate(seed(), (value) => {
      delete value['agentWait'];
    });
    expect(parseHarnessCheckpointV1(bytes).agentWait).toBeNull();
  });

  it('rejects an await_agent checkpoint against the other wait families', () => {
    expect(() =>
      createAwaitAgentHarnessCheckpoint({
        previous: createAwaitActionHarnessCheckpoint({
          previous: seed(),
          checkpointId: 'ckpt-5',
          coveredSequence: 4,
          previousCheckpointId: 'ckpt-4',
          attempt: committedAttempt(),
          approval: requestedUserApproval(),
        }),
        checkpointId: 'ckpt-6',
        coveredSequence: 5,
        previousCheckpointId: 'ckpt-5',
        attempt: null,
        agentWait: agentWaitOf(['run-1']),
      }),
    ).toThrow(/cannot keep a requested approval/);
    expect(() =>
      createAwaitAgentHarnessCheckpoint({
        previous: createAwaitAgentHarnessCheckpoint({
          previous: seed(),
          checkpointId: 'ckpt-5',
          coveredSequence: 4,
          previousCheckpointId: 'ckpt-4',
          attempt: committedAttempt(),
          agentWait: agentWaitOf(['run-1']),
        }),
        checkpointId: 'ckpt-6',
        coveredSequence: 5,
        previousCheckpointId: 'ckpt-5',
        attempt: null,
        agentWait: agentWaitOf(['run-2']),
      }),
    ).toThrow(/cannot replace an unfinished agent wait/);
    expect(() =>
      createAwaitAgentHarnessCheckpoint({
        previous: createAwaitRuntimeHarnessCheckpoint({
          previous: seed(),
          checkpointId: 'ckpt-5',
          coveredSequence: 4,
          previousCheckpointId: 'ckpt-4',
          attempt: committedAttempt(),
          ...inProgressRuntime(),
        }),
        checkpointId: 'ckpt-6',
        coveredSequence: 5,
        previousCheckpointId: 'ckpt-5',
        attempt: null,
        agentWait: agentWaitOf(['run-1']),
      }),
    ).toThrow(/cannot carry in-flight Runtime work/);
    expect(() =>
      createAwaitAgentHarnessCheckpoint({
        previous: seed(),
        checkpointId: 'ckpt-5',
        coveredSequence: 4,
        previousCheckpointId: 'ckpt-4',
        attempt: null,
        agentWait: agentWaitOf(['run-1']),
      }),
    ).toThrow(/requires the attempt/);
  });

  it('replaces an all-consumed carried group, never an unfinished wait', () => {
    const first = createAwaitAgentHarnessCheckpoint({
      previous: seed(),
      checkpointId: 'ckpt-5',
      coveredSequence: 4,
      previousCheckpointId: 'ckpt-4',
      attempt: committedAttempt(),
      agentWait: agentWaitOf(['run-1']),
    });
    const consumedFirst = createConsumedAgentWaitHarnessCheckpoint({
      previous: first,
      checkpointId: 'ckpt-6',
      coveredSequence: 5,
      previousCheckpointId: 'ckpt-5',
      childRunId: 'run-1',
    });
    // The first wait folded: its group is history — the second foreground
    // call of the same batch commits its own wait over it.
    const second = createAwaitAgentHarnessCheckpoint({
      previous: consumedFirst,
      checkpointId: 'ckpt-7',
      coveredSequence: 6,
      previousCheckpointId: 'ckpt-6',
      attempt: null,
      agentWait: agentWaitOf(['run-2']),
    });
    expect(second.continuation.phase).toBe('await_agent');
    expect(second.agentWait?.runs).toMatchObject([{ childRunId: 'run-2' }]);
    expect(parseHarnessCheckpointV1(bytesOf(second))).toEqual(second);
    expect(() =>
      createAwaitAgentHarnessCheckpoint({
        previous: first,
        checkpointId: 'ckpt-7',
        coveredSequence: 6,
        previousCheckpointId: 'ckpt-6',
        attempt: null,
        agentWait: agentWaitOf(['run-2']),
      }),
    ).toThrow(/cannot replace an unfinished agent wait/);
  });

  it('rejects agentWait runs that repeat an identity or carry unknown keys', () => {
    const wait = createAwaitAgentHarnessCheckpoint({
      previous: seed(),
      checkpointId: 'ckpt-5',
      coveredSequence: 4,
      previousCheckpointId: 'ckpt-4',
      attempt: committedAttempt(),
      agentWait: agentWaitOf(['run-1']),
    });
    // A duplicated childRunId is one wait named twice.
    expect(() =>
      parseHarnessCheckpointV1(
        mutate(wait, (value) => {
          const group = value['agentWait'] as { runs: unknown[] };
          group.runs = [
            group.runs[0],
            { ...(group.runs[0] as object), functionCallId: 'fc-dup' },
          ];
        }),
      ),
    ).toThrow(/repeats "run-1"/);
    // A duplicated functionCallId defeats the resume's exactly-once key.
    expect(() =>
      parseHarnessCheckpointV1(
        mutate(wait, (value) => {
          const group = value['agentWait'] as { runs: unknown[] };
          group.runs = [
            group.runs[0],
            { ...(group.runs[0] as object), childRunId: 'run-dup' },
          ];
        }),
      ),
    ).toThrow(/repeats "fc-1"/);
    // A would-be third field family is not silently tolerated.
    expect(() =>
      parseHarnessCheckpointV1(
        mutate(wait, (value) => {
          value['agentWait'] = { runs: [], extra: true };
        }),
      ),
    ).toThrow(/unknown field/);
    expect(() =>
      parseHarnessCheckpointV1(
        mutate(wait, (value) => {
          const group = value['agentWait'] as {
            runs: Array<Record<string, unknown>>;
          };
          group.runs[0]!['ordinal'] = 0;
        }),
      ),
    ).toThrow(/unknown field/);
  });

  it('carries the consumed group into the next model round', () => {
    const wait = createAwaitAgentHarnessCheckpoint({
      previous: seed(),
      checkpointId: 'ckpt-5',
      coveredSequence: 4,
      previousCheckpointId: 'ckpt-4',
      attempt: committedAttempt(),
      agentWait: agentWaitOf(['run-1']),
    });
    const consumed = createConsumedAgentWaitHarnessCheckpoint({
      previous: wait,
      checkpointId: 'ckpt-6',
      coveredSequence: 5,
      previousCheckpointId: 'ckpt-5',
      childRunId: 'run-1',
    });
    const round = createModelOutputCommittedHarnessCheckpoint({
      previous: consumed,
      checkpointId: 'ckpt-7',
      coveredSequence: 6,
      previousCheckpointId: 'ckpt-6',
    });
    expect(round.agentWait?.runs).toMatchObject([
      { childRunId: 'run-1', consumed: true },
    ]);
    // The carried advance is the exact shape §4's branch classifies: a
    // crash here classifies the wait instead of declining model_start.
    // (R1-58: this case pins the constructor's contract — production
    // delivers the carry through createConsumedAgentWaitHarnessCheckpoint
    // above; createModelOutputCommitted's sole production caller,
    // resolveDurableWait, can never see a non-null group, and the guard's
    // legal-carry side keeps exactly this case alive.)
    expect(parseHarnessCheckpointV1(bytesOf(round))).toEqual(round);
  });

  it('rejects consumed agent waits without the matching wait', () => {
    expect(() =>
      createConsumedAgentWaitHarnessCheckpoint({
        previous: seed(),
        checkpointId: 'ckpt-5',
        coveredSequence: 4,
        previousCheckpointId: 'ckpt-4',
        childRunId: 'run-1',
      }),
    ).toThrow(/requires an await_agent checkpoint/);
    const wait = createAwaitAgentHarnessCheckpoint({
      previous: seed(),
      checkpointId: 'ckpt-5',
      coveredSequence: 4,
      previousCheckpointId: 'ckpt-4',
      attempt: committedAttempt(),
      agentWait: agentWaitOf(['run-1']),
    });
    expect(() =>
      createConsumedAgentWaitHarnessCheckpoint({
        previous: wait,
        checkpointId: 'ckpt-6',
        coveredSequence: 5,
        previousCheckpointId: 'ckpt-5',
        childRunId: 'run-other',
      }),
    ).toThrow(/has no run run-other/);
    const consumed = createConsumedAgentWaitHarnessCheckpoint({
      previous: wait,
      checkpointId: 'ckpt-6',
      coveredSequence: 5,
      previousCheckpointId: 'ckpt-5',
      childRunId: 'run-1',
    });
    expect(() =>
      createConsumedAgentWaitHarnessCheckpoint({
        previous: consumed,
        checkpointId: 'ckpt-7',
        coveredSequence: 6,
        previousCheckpointId: 'ckpt-6',
        childRunId: 'run-1',
      }),
    ).toThrow(/requires an await_agent checkpoint/);
  });

  it('rejects phase shapes that misplace the agent wait', () => {
    const wait = createAwaitAgentHarnessCheckpoint({
      previous: seed(),
      checkpointId: 'ckpt-5',
      coveredSequence: 4,
      previousCheckpointId: 'ckpt-4',
      attempt: committedAttempt(),
      agentWait: agentWaitOf(['run-1']),
    });
    // Empty run list cannot authorize the phase.
    expect(() =>
      parseHarnessCheckpointV1(
        mutate(wait, (value) => {
          value['agentWait'] = { runs: [] };
        }),
      ),
    ).toThrow(/requires the agent wait runs/);
    // In-flight Runtime work excludes the agent wait.
    const runtime = inProgressRuntime();
    expect(() =>
      parseHarnessCheckpointV1(
        mutate(wait, (value) => {
          value['tools'] = JSON.parse(JSON.stringify(runtime.tools));
          value['runtime'] = JSON.parse(JSON.stringify(runtime.runtime));
        }),
      ),
    ).toThrow(/cannot carry in-flight Runtime work/);
    // The runtime wait cannot carry the agent group either.
    const runtimeWait = createAwaitRuntimeHarnessCheckpoint({
      previous: seed(),
      checkpointId: 'ckpt-5',
      coveredSequence: 4,
      previousCheckpointId: 'ckpt-4',
      attempt: committedAttempt(),
      ...inProgressRuntime(),
    });
    expect(() =>
      parseHarnessCheckpointV1(
        mutate(runtimeWait, (value) => {
          value['agentWait'] = JSON.parse(JSON.stringify(wait.agentWait));
        }),
      ),
    ).toThrow(/cannot carry an agent wait/);
    // model_output_committed carries the group only once fully consumed.
    expect(() =>
      parseHarnessCheckpointV1(
        mutate(
          createModelOutputCommittedHarnessCheckpoint({
            previous: wait,
            checkpointId: 'ckpt-6',
            coveredSequence: 5,
            previousCheckpointId: 'ckpt-5',
          }),
          (value) => {
            value['agentWait'] = JSON.parse(JSON.stringify(wait.agentWait));
          },
        ),
      ),
    ).toThrow(/cannot carry an unconsumed agent wait/);
  });

  it('rejects the agent group at every other phase too (R1-13)', () => {
    const group = agentWaitOf(['run-1']);
    // before_model: author a shape instead of mutating one.
    expect(() =>
      parseHarnessCheckpointV1(
        mutate(seed(), (value) => {
          value['agentWait'] = JSON.parse(JSON.stringify(group));
        }),
      ),
    ).toThrow(/cannot carry an agent wait/);
    // await_action with a live approval.
    const awaited = createAwaitActionHarnessCheckpoint({
      previous: seed(),
      checkpointId: 'ckpt-5',
      coveredSequence: 4,
      previousCheckpointId: 'ckpt-4',
      attempt: committedAttempt(),
      approval: requestedUserApproval(),
    });
    expect(() =>
      parseHarnessCheckpointV1(
        mutate(awaited, (value) => {
          value['agentWait'] = JSON.parse(JSON.stringify(group));
        }),
      ),
    ).toThrow(/cannot carry an agent wait/);
    // await_agent carrying a requested approval is refused by both the
    // constructor and the parser.
    const wait = createAwaitAgentHarnessCheckpoint({
      previous: seed(),
      checkpointId: 'ckpt-5',
      coveredSequence: 4,
      previousCheckpointId: 'ckpt-4',
      attempt: committedAttempt(),
      agentWait: group,
    });
    expect(() =>
      parseHarnessCheckpointV1(
        mutate(wait, (value) => {
          value['approval'] = JSON.parse(
            JSON.stringify(requestedUserApproval()),
          );
        }),
      ),
    ).toThrow(/cannot keep a requested approval/);
    // results_ready never carries the group.
    const runtimeWait = createAwaitRuntimeHarnessCheckpoint({
      previous: seed(),
      checkpointId: 'ckpt-5',
      coveredSequence: 4,
      previousCheckpointId: 'ckpt-4',
      attempt: committedAttempt(),
      ...inProgressRuntime(),
    });
    const results = createResultsReadyHarnessCheckpoint({
      previous: runtimeWait,
      checkpointId: 'ckpt-6',
      coveredSequence: 5,
      previousCheckpointId: 'ckpt-5',
      executionCallId: 'ex-1',
      outcomeRef: ref('managed-tool-outcome'),
    });
    expect(() =>
      parseHarnessCheckpointV1(
        mutate(results, (value) => {
          value['agentWait'] = JSON.parse(JSON.stringify(group));
        }),
      ),
    ).toThrow(/cannot carry an agent wait/);
    // turn_settled never carries it either.
    const consumedResults = createConsumedRuntimeResultsHarnessCheckpoint({
      previous: results,
      checkpointId: 'ckpt-7',
      coveredSequence: 6,
      previousCheckpointId: 'ckpt-6',
    });
    const settled = createTurnSettledHarnessCheckpoint({
      previous: consumedResults,
      checkpointId: 'ckpt-8',
      coveredSequence: 7,
      previousCheckpointId: 'ckpt-7',
    });
    expect(() =>
      parseHarnessCheckpointV1(
        mutate(settled, (value) => {
          value['agentWait'] = JSON.parse(JSON.stringify(group));
        }),
      ),
    ).toThrow(/turn_settled cannot carry/);
  });

  it('double-consume of the same run is refused while runs remain (R1-13)', async () => {
    const wait = createAwaitAgentHarnessCheckpoint({
      previous: seed(),
      checkpointId: 'ckpt-5',
      coveredSequence: 4,
      previousCheckpointId: 'ckpt-4',
      attempt: committedAttempt(),
      agentWait: agentWaitOf(['run-1', 'run-2']),
    });
    const first = createConsumedAgentWaitHarnessCheckpoint({
      previous: wait,
      checkpointId: 'ckpt-6',
      coveredSequence: 5,
      previousCheckpointId: 'ckpt-5',
      childRunId: 'run-1',
    });
    // With run-2 outstanding the phase stays await_agent — so the second
    // fold of run-1 reaches the consumed guard rather than the phase
    // guard.
    expect(first.continuation.phase).toBe('await_agent');
    expect(() =>
      createConsumedAgentWaitHarnessCheckpoint({
        previous: first,
        checkpointId: 'ckpt-7',
        coveredSequence: 6,
        previousCheckpointId: 'ckpt-6',
        childRunId: 'run-1',
      }),
    ).toThrow(/is already consumed/);
  });

  it('write-side guards refuse the two rejected shapes (R1-6)', () => {
    const wait = createAwaitAgentHarnessCheckpoint({
      previous: seed(),
      checkpointId: 'ckpt-5',
      coveredSequence: 4,
      previousCheckpointId: 'ckpt-4',
      attempt: committedAttempt(),
      agentWait: agentWaitOf(['run-1']),
    });
    // An empty group cannot mint an await_agent even directly.
    expect(() =>
      createAwaitAgentHarnessCheckpoint({
        previous: seed(),
        checkpointId: 'ckpt-6',
        coveredSequence: 5,
        previousCheckpointId: 'ckpt-5',
        attempt: committedAttempt(),
        agentWait: { runs: [] },
      }),
    ).toThrow(/requires at least one run/);
    // Forwarding an unconsumed group into model_output_committed is
    // refused before the bytes could exist; this same module mints the
    // carried all-consumed shape through createConsumedAgentWait.
    expect(() =>
      createModelOutputCommittedHarnessCheckpoint({
        previous: wait,
        checkpointId: 'ckpt-6',
        coveredSequence: 5,
        previousCheckpointId: 'ckpt-5',
      }),
    ).toThrow(/cannot carry an unconsumed agent wait/);
    // The legal carry stays open: fully consumed forwards the group.
    const consumed = createConsumedAgentWaitHarnessCheckpoint({
      previous: wait,
      checkpointId: 'ckpt-6',
      coveredSequence: 5,
      previousCheckpointId: 'ckpt-5',
      childRunId: 'run-1',
    });
    expect(
      createModelOutputCommittedHarnessCheckpoint({
        previous: consumed,
        checkpointId: 'ckpt-7',
        coveredSequence: 6,
        previousCheckpointId: 'ckpt-6',
      }).agentWait?.runs,
    ).toMatchObject([{ childRunId: 'run-1', consumed: true }]);
  });

  it('omits the agentWait key whenever no group rides the checkpoint (R1-29)', () => {
    // A pre-agentWait reader rejects unknown root keys; absent parses as
    // null on both sides, so a checkpoint that carries no group must not
    // name the key — an older daemon can still open these bytes.
    const bytes = bytesOf(seed());
    expect(Object.keys(JSON.parse(bytes.toString('utf8')))).not.toContain(
      'agentWait',
    );
    expect(parseHarnessCheckpointV1(bytes).agentWait).toBeNull();
    // And the group itself always writes the key.
    const wait = createAwaitAgentHarnessCheckpoint({
      previous: seed(),
      checkpointId: 'ckpt-5',
      coveredSequence: 4,
      previousCheckpointId: 'ckpt-4',
      attempt: committedAttempt(),
      agentWait: agentWaitOf(['run-1']),
    });
    const waitBytes = bytesOf(wait);
    expect(Object.keys(JSON.parse(waitBytes.toString('utf8')))).toContain(
      'agentWait',
    );
    expect(parseHarnessCheckpointV1(waitBytes).agentWait?.runs).toHaveLength(1);
  });
});

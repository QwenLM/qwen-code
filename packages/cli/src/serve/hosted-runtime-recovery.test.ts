/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalJsonlManagedSessionJournalStore } from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import { resetManagedRuntimeDispatchGatesForTest } from '@qwen-code/qwen-code-core/managed-runtime/managed-runtime-dispatch-gate.js';
import {
  stopParkedRuntimeExecutions,
  recoverHostedRuntimeTurn,
  type HostedRecoveryTurn,
  type HostedRuntimeRecoveryOutcome,
} from './hosted-runtime-recovery.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import { HTTP_MANAGED_SESSION_STORE_CONTRACT } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';

const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const PROMPT_ID = '33333333-3333-4333-8333-333333333333';
const EXECUTION_ID = 'exec-1';
const DIGEST = 'a'.repeat(64);

function mustRecover(
  outcome: HostedRuntimeRecoveryOutcome,
): HostedRecoveryTurn {
  if (outcome.kind !== 'recovered')
    throw new Error(
      `expected a recovery, got ${outcome.kind} (${outcome.kind === 'declined' ? outcome.reason : ''})`,
    );
  return outcome.turn;
}

describe('recoverHostedRuntimeTurn', () => {
  let root: string;

  beforeEach(async () => {
    resetManagedRuntimeDispatchGatesForTest();
    root = await mkdtemp(path.join(tmpdir(), 'hosted-recovery-test-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  async function open(
    workerId: string,
    create: boolean,
    toolProfile = 'hosted-workspace-files/1',
  ) {
    const sessionKey = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const resourceStore = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: root,
      sessionKey,
    });
    const refs = create
      ? {
          definitionRef: await resourceStore.publish(
            'managed-definition',
            Buffer.from(
              JSON.stringify({
                engine: 'managed',
                sessionId: SESSION_ID,
                toolProfile,
              }),
            ),
          ),
          rootSnapshotRef: await resourceStore.publish(
            'managed-root',
            Buffer.from(JSON.stringify({ cwd: root })),
          ),
          createdBy: 'hosted-harness',
        }
      : undefined;
    return openManagedSession({
      runtimeBaseDir: root,
      transcriptPath: '',
      sessionId: SESSION_ID,
      sessionKey,
      cwd: root,
      version: 'hosted-harness/1',
      workerId,
      activationLeaseDurationMs: 60_000,
      journalStore: new LocalJsonlManagedSessionJournalStore({
        runtimeBaseDir: root,
        sessionId: SESSION_ID,
        transcriptPath: path.join(root, `${SESSION_ID}.jsonl`),
      }),
      resourceStore,
      ...(refs ? { create: refs, requireNew: true } : {}),
    });
  }

  /** Drives a fresh session to a parked await_runtime checkpoint. */
  async function parkAtAwaitRuntime(
    toolName = 'write_file',
    preJournalResult = false,
    settleBeforeClose = false,
    withIntent = true,
    extraExecutionId?: string,
    runtimeSessionId = PROMPT_ID,
  ): Promise<ManagedSession> {
    const session = await open(
      'boot-1',
      true,
      toolName === 'glob'
        ? 'hosted-workspace-files/2'
        : 'hosted-workspace-files/1',
    );
    const harness = createManagedHarnessHandle(session);
    const authority = session.authority;
    const contentRef = await session.resources.publish(
      'managed-input',
      Buffer.from(JSON.stringify([{ type: 'text', text: 'write a file' }])),
    );
    const admissionRef = await session.resources.publish(
      'managed-admission',
      Buffer.from(JSON.stringify({ promptId: PROMPT_ID, digest: 'x' })),
    );
    await authority.submitInput(
      {
        operation: 'submitInput',
        commandId: PROMPT_ID,
        sessionKey: authority.sessionHeader.sessionKey,
        contentDigest: DIGEST,
      },
      {
        inputId: PROMPT_ID,
        turnId: PROMPT_ID,
        source: 'hosted-harness',
        contentRef,
        admissionRef,
        deadline: null,
        wakeReason: 'input',
      },
    );
    await harness.ensureRunnable();
    const definitionRef = await session.resources.publish(
      'managed-tool-definition',
      Buffer.from(JSON.stringify({ name: toolName })),
    );
    const activation = session.activation;
    const executionIds = [
      EXECUTION_ID,
      ...(extraExecutionId ? [extraExecutionId] : []),
    ];
    const intentRefs = new Map();
    for (const [ordinal, executionId] of executionIds.entries()) {
      const input = Buffer.from(
        JSON.stringify({
          harnessSessionId: SESSION_ID,
          runtimeSessionId,
          payloadJson: JSON.stringify({
            toolName,
            input:
              toolName === 'glob'
                ? { pattern: '**/*.ts' }
                : { file_path: `${ordinal}.txt`, content: 'x' },
          }),
        }),
      );
      const route = await session.resources.publish(
        'managed-tool-input',
        input,
      );
      intentRefs.set(executionId, route);
      if (withIntent)
        await authority.appendExecutionEvent(
          {
            operation: 'toolIntent',
            commandId: `tool-intent:${executionId}`,
            sessionKey: authority.sessionHeader.sessionKey,
            contentDigest: route.digest,
          },
          (sequence) => ({
            v: 1,
            sequence,
            eventId: `tool-intent:${executionId}`,
            sessionKey: authority.sessionHeader.sessionKey,
            kind: 'tool.intent',
            occurredAt: Date.now(),
            subject: {
              type: 'activation',
              scopeId: activation.activationId,
              ...activation,
            },
            payload: {
              executionCallId: executionId,
              batchId: 'batch-1',
              ordinal,
              toolDefinitionRef: definitionRef,
              argsRef: route,
              outcomeSource: 'runtime',
            },
          }),
          { class: 'harness', activation },
        );
    }
    await harness.commitAwaitRuntimeBatch(
      executionIds.map((executionId, ordinal) => ({
        functionCallId: ordinal === 0 ? 'call-1' : `call-${ordinal + 1}`,
        toolName,
        executionCallId: executionId,
        invocationBindingId: executionId,
        capabilityVersion: 'workspace-capability/1',
        policyVersion: 'preapproved-workspace-tools/1',
        mediaVersion: null,
        modelMessageId: 'message-1',
        partIndex: ordinal,
        ordinal,
        inputDigest: DIGEST,
        progressCursor: null,
        attemptId: 'attempt-1',
        routeRef: intentRefs.get(executionId),
      })),
      { turnId: PROMPT_ID, promptId: PROMPT_ID },
    );
    if (preJournalResult) {
      await session.sink.write({
        uuid: 'result-1',
        parentUuid: 'message-1',
        sessionId: SESSION_ID,
        timestamp: new Date().toISOString(),
        type: 'tool_result',
        cwd: root,
        version: 'hosted-harness/1',
        daemonPromptId: PROMPT_ID,
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call-1',
                name: toolName,
                response: { executionStatus: 'success' },
              },
            },
          ],
        },
      });
    }
    if (settleBeforeClose) {
      // The parked turn's executions all settled before the owner died.
      const outcomeRef = await session.resources.publish(
        'managed-tool-outcome',
        Buffer.from(
          JSON.stringify({
            executionCallId: EXECUTION_ID,
            functionResponse: {
              id: 'call-1',
              name: toolName,
              response: { executionStatus: 'success' },
            },
          }),
        ),
      );
      await harness.resolveAwaitRuntime(EXECUTION_ID, outcomeRef);
    }
    await session.close();
    resetManagedRuntimeDispatchGatesForTest();
    return session;
  }

  const brokerOptions = { baseUrl: 'http://127.0.0.1:1', token: 'test' };

  it('settles parked executions under their original ids and reports ready', async () => {
    await parkAtAwaitRuntime();
    const acquire = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
      .mockResolvedValue();
    const execute = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'execute')
      .mockResolvedValue({
        executionStatus: 'success',
        responseParts: [{ text: 'done' }],
      } as never);
    const replacement = await open('boot-2', false);
    try {
      const recovered = mustRecover(
        await recoverHostedRuntimeTurn({
          session: replacement,
          sessionId: SESSION_ID,
          cwd: root,
          promptId: PROMPT_ID,
          brokerOptions,
          passive: false,
        }),
      );
      expect(recovered).toBeDefined();
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0]?.[0]).toBe(EXECUTION_ID);
      expect(recovered!.report).toMatchObject({
        phase: 'results_ready',
        checkpointId: replacement.authority.latestCheckpoint?.checkpointId,
        activationId: replacement.activation.activationId,
        executions: [
          {
            functionCallId: 'call-1',
            toolName: 'write_file',
            executionCallId: EXECUTION_ID,
            runtimeSessionId: PROMPT_ID,
            outcome: 'known',
            status: { state: 'settled' },
          },
        ],
      });
      const authorization =
        await replacement.authority.harnessRunAuthorization();
      expect(authorization.status).toBe('runnable');
      if (authorization.status === 'runnable') {
        expect(authorization.checkpoint.continuation.phase).toBe(
          'results_ready',
        );
      }
      const projected = await replacement.sink.project();
      const toolResult = projected.find(
        (entry) =>
          entry.daemonPromptId === PROMPT_ID && entry.type === 'tool_result',
      );
      expect(toolResult).toBeDefined();
    } finally {
      await replacement.close();
    }
    expect(acquire).toHaveBeenCalled();
  });

  it('drives each parked execution under its own id and arguments', async () => {
    const EXECUTION_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await parkAtAwaitRuntime('write_file', false, false, true, EXECUTION_2);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    const execute = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'execute')
      .mockResolvedValue({
        executionStatus: 'success',
        responseParts: [{ text: 'done' }],
      } as never);
    const replacement = await open('boot-2', false);
    try {
      const recovered = mustRecover(
        await recoverHostedRuntimeTurn({
          session: replacement,
          sessionId: SESSION_ID,
          cwd: root,
          promptId: PROMPT_ID,
          brokerOptions,
          passive: false,
        }),
      );
      expect(recovered).toBeDefined();
      // Each execution re-dispatches under its own id with its own arguments.
      expect(execute.mock.calls.map((call) => call[0])).toEqual([
        EXECUTION_ID,
        EXECUTION_2,
      ]);
      expect(
        execute.mock.calls.map(
          (call) =>
            (JSON.parse(String(call[1])) as { input: { file_path: string } })
              .input.file_path,
        ),
      ).toEqual(['0.txt', '1.txt']);
      expect(
        recovered!.report.executions.map((execution) => [
          execution.executionCallId,
          execution.outcome,
        ]),
      ).toEqual([
        [EXECUTION_ID, 'known'],
        [EXECUTION_2, 'known'],
      ]);
    } finally {
      await replacement.close();
    }
  });

  it('re-attaches the Runtime Session when nothing is left to drive', async () => {
    await parkAtAwaitRuntime('write_file', false, true);
    const acquire = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
      .mockResolvedValue();
    const execute = vi.spyOn(HostedWorkspaceBroker.prototype, 'execute');
    const replacement = await open('boot-2', false);
    try {
      const recovered = mustRecover(
        await recoverHostedRuntimeTurn({
          session: replacement,
          sessionId: SESSION_ID,
          cwd: root,
          promptId: PROMPT_ID,
          brokerOptions,
          passive: false,
        }),
      );
      // Nothing to re-dispatch, but the dead owner's Runtime Session still
      // pins the Workspace — the takeover must hold it so the terminal route
      // can hand it back.
      expect(recovered).toBeDefined();
      expect(recovered!.acquiredRuntime).toBe(true);
      expect(acquire).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await replacement.close();
    }
  });

  it('reports parked executions without dispatching on a passive load', async () => {
    await parkAtAwaitRuntime();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    const execute = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'execute')
      .mockRejectedValue(new Error('must not dispatch'));
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'prepared',
    });
    const replacement = await open('boot-2', false);
    try {
      const recovered = mustRecover(
        await recoverHostedRuntimeTurn({
          session: replacement,
          sessionId: SESSION_ID,
          cwd: root,
          promptId: PROMPT_ID,
          brokerOptions,
          passive: true,
        }),
      );
      expect(HostedWorkspaceBroker.prototype.acquire).toHaveBeenCalled();
      expect(recovered).toBeDefined();
      expect(execute).not.toHaveBeenCalled();
      // The adoption is held for the cancel route: loading never releases it.
      expect(release).not.toHaveBeenCalled();
      // A passive load only reads: nothing may be journaled for the prompt.
      expect(
        (await replacement.sink.project()).filter(
          (entry) =>
            entry.daemonPromptId === PROMPT_ID && entry.type === 'tool_result',
        ),
      ).toHaveLength(0);
      expect(recovered!.report).toMatchObject({
        phase: 'await_runtime',
        executions: [
          {
            executionCallId: EXECUTION_ID,
            outcome: 'known',
            status: { state: 'prepared' },
          },
        ],
      });
      const authorization =
        await replacement.authority.harnessRunAuthorization();
      expect(authorization.status).toBe('runnable');
      if (authorization.status === 'runnable') {
        expect(authorization.checkpoint.continuation.phase).toBe(
          'await_runtime',
        );
      }
    } finally {
      await replacement.close();
    }
  });

  it.each([undefined, { state: 'unknown' }])(
    'reports an execution the Broker cannot account for as unknown (%s)',
    async (status) => {
      await parkAtAwaitRuntime();
      vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
      const release = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'release')
        .mockResolvedValue();
      vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue(
        status,
      );
      const replacement = await open('boot-2', false);
      try {
        const recovered = mustRecover(
          await recoverHostedRuntimeTurn({
            session: replacement,
            sessionId: SESSION_ID,
            cwd: root,
            promptId: PROMPT_ID,
            brokerOptions,
            passive: true,
          }),
        );
        expect(HostedWorkspaceBroker.prototype.acquire).toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
        expect(recovered!.report.executions).toEqual([
          expect.objectContaining({
            executionCallId: EXECUTION_ID,
            outcome: 'unknown',
          }),
        ]);
        // A passive load only reads: nothing may be journaled for the prompt.
        expect(
          (await replacement.sink.project()).filter(
            (entry) =>
              entry.daemonPromptId === PROMPT_ID &&
              entry.type === 'tool_result',
          ),
        ).toHaveLength(0);
      } finally {
        await replacement.close();
      }
    },
  );

  it('declines a turn without a Runtime checkpoint as model_start', async () => {
    const session = await open('boot-1', true);
    try {
      const outcome = await recoverHostedRuntimeTurn({
        session,
        sessionId: SESSION_ID,
        cwd: root,
        promptId: PROMPT_ID,
        brokerOptions,
        passive: false,
      });
      expect(outcome).toEqual({ kind: 'declined', reason: 'model_start' });
    } finally {
      await session.close();
    }
  });

  it('answers a settled Turn as inapplicable on both load shapes', async () => {
    // A Turn written turn_settled completed: a decline would be recorded
    // as a false terminal the coordinator stamps failed (R8-2). The
    // journal is what it is — on both load shapes the kernel answers
    // inapplicable so the plain attach re-attaches and the daemon's own
    // projection writes the terminal record below.
    await parkAtAwaitRuntime();
    const replacement = await open('boot-2', false);
    vi.spyOn(
      replacement.authority,
      'harnessRunAuthorization',
    ).mockResolvedValue({
      status: 'runnable',
      checkpoint: {
        identity: {
          turnId: PROMPT_ID,
          promptId: PROMPT_ID,
          checkpointId: 'checkpoint-turn-settled',
        },
        attempt: {},
        continuation: { phase: 'turn_settled' },
        approval: null,
        output: {},
        followUp: {},
        runtime: {},
        tools: { items: [] },
      },
    } as never);
    try {
      for (const passive of [false, true]) {
        const outcome = await recoverHostedRuntimeTurn({
          session: replacement,
          sessionId: SESSION_ID,
          cwd: root,
          promptId: PROMPT_ID,
          brokerOptions,
          passive,
        });
        expect(outcome.kind).toBe('inapplicable');
      }
    } finally {
      await replacement.close();
    }
  });

  it('rejects a transiently blocked checkpoint instead of declining it', async () => {
    // A store blip while reading the timed checkpoint erases into the
    // same `blocked` status as a durable parse verdict; only the durable
    // verdicts may go terminal.
    await parkAtAwaitRuntime();
    const replacement = await open('boot-2', false);
    const authorization = vi
      .spyOn(replacement.authority, 'harnessRunAuthorization')
      .mockResolvedValue({
        status: 'blocked',
        reason: 'missing_state',
        message: 'the HTTP Managed Session writer is not active.',
      } as never);
    try {
      await expect(
        recoverHostedRuntimeTurn({
          session: replacement,
          sessionId: SESSION_ID,
          cwd: root,
          promptId: PROMPT_ID,
          brokerOptions,
          passive: false,
        }),
      ).rejects.toThrow();
      expect(authorization).toHaveBeenCalled();
    } finally {
      await replacement.close();
    }
  });

  it.each([
    {
      name: 'a checkpoint-less journal stays terminal',
      authorization: { status: 'blocked', reason: 'missing_checkpoint' },
    },
    {
      name: 'a durably absent checkpoint state stays terminal',
      authorization: { status: 'blocked', reason: 'missing_state' },
    },
  ])('declines $name', async ({ authorization: blockedVerdict }) => {
    // missing_checkpoint is only produced by a permanent journal shape,
    // and a bare missing_state (no store-error message) is a durable
    // absence — neither can change on retry, so both decline; only an
    // erased store failure (missing_state WITH the authority's message)
    // may stay retriable.
    await parkAtAwaitRuntime();
    const replacement = await open('boot-2', false);
    vi.spyOn(
      replacement.authority,
      'harnessRunAuthorization',
    ).mockResolvedValue(blockedVerdict as never);
    try {
      const outcome = await recoverHostedRuntimeTurn({
        session: replacement,
        sessionId: SESSION_ID,
        cwd: root,
        promptId: PROMPT_ID,
        brokerOptions,
        passive: false,
      });
      expect(outcome).toEqual({
        kind: 'declined',
        reason: 'checkpoint_blocked',
      });
    } finally {
      await replacement.close();
    }
  });

  it.each([true, false])(
    'answers inapplicable for an approval wait the user owns (passive=%s)',
    async (passive) => {
      // The decision belongs to the user, never to a takeover: declining
      // would write the Turn failed while the answer is still deliverable
      // (G3), so BOTH loads answer inapplicable and let the plain attach
      // carry the approval flow (bounded by the approval timeout).
      await parkAtAwaitRuntime();
      const replacement = await open('boot-2', false);
      vi.spyOn(
        replacement.authority,
        'harnessRunAuthorization',
      ).mockResolvedValue({
        status: 'runnable',
        checkpoint: {
          identity: {
            turnId: PROMPT_ID,
            promptId: PROMPT_ID,
            checkpointId: 'checkpoint-await-action',
          },
          attempt: {},
          continuation: { phase: 'await_action' },
          approval: { state: 'requested', requestId: 'request-1' },
          output: {},
          followUp: {},
          runtime: {},
          tools: { items: [] },
        },
      } as never);
      try {
        const outcome = await recoverHostedRuntimeTurn({
          session: replacement,
          sessionId: SESSION_ID,
          cwd: root,
          promptId: PROMPT_ID,
          brokerOptions,
          passive,
        });
        expect(outcome.kind).toBe('inapplicable');
      } finally {
        await replacement.close();
      }
    },
  );

  it.each([undefined, 'requested'])(
    'answers inapplicable only while the durable action record charts requested (state=%s)',
    async (durableState) => {
      // The approval branch reads the DURABLE action record, not the
      // stale checkpoint copy (P1-2): while the record stays requested,
      // the wait the user owns is unanswered.
      await parkAtAwaitRuntime();
      const replacement = await open('boot-2', false);
      vi.spyOn(
        replacement.authority,
        'harnessRunAuthorization',
      ).mockResolvedValue({
        status: 'runnable',
        checkpoint: {
          identity: {
            turnId: PROMPT_ID,
            promptId: PROMPT_ID,
            checkpointId: 'checkpoint-await-action',
          },
          attempt: {},
          continuation: { phase: 'await_action' },
          approval: { state: 'requested', requestId: 'request-1' },
          output: {},
          followUp: {},
          runtime: {},
          tools: { items: [] },
        },
      } as never);
      vi.spyOn(replacement.authority, 'action').mockReturnValue(
        (durableState === undefined
          ? undefined
          : { state: durableState }) as never,
      );
      try {
        const outcome = await recoverHostedRuntimeTurn({
          session: replacement,
          sessionId: SESSION_ID,
          cwd: root,
          promptId: PROMPT_ID,
          brokerOptions,
          passive: true,
        });
        expect(outcome.kind).toBe('inapplicable');
      } finally {
        await replacement.close();
      }
    },
  );

  it.each(['expired', 'cancelled'])(
    'throws for a durable wait that ended without a decision (state=%s)',
    async (durableState) => {
      await parkAtAwaitRuntime();
      const replacement = await open('boot-2', false);
      vi.spyOn(
        replacement.authority,
        'harnessRunAuthorization',
      ).mockResolvedValue({
        status: 'runnable',
        checkpoint: {
          identity: {
            turnId: PROMPT_ID,
            promptId: PROMPT_ID,
            checkpointId: 'checkpoint-await-action',
          },
          attempt: {},
          continuation: { phase: 'await_action' },
          approval: { state: 'requested', requestId: 'request-1' },
          output: {},
          followUp: {},
          runtime: {},
          tools: { items: [] },
        },
      } as never);
      vi.spyOn(replacement.authority, 'action').mockReturnValue({
        state: durableState,
      } as never);
      try {
        await expect(
          recoverHostedRuntimeTurn({
            session: replacement,
            sessionId: SESSION_ID,
            cwd: root,
            promptId: PROMPT_ID,
            brokerOptions,
            passive: true,
          }),
        ).rejects.toThrow('ended without a decision');
      } finally {
        await replacement.close();
      }
    },
  );

  it('declines a decided wait whose checkpoint the drive cannot resume', async () => {
    // With the durable action decided, the approval wait is over — the
    // drive load winds past inapplicable into the continuation whose own
    // checkpoint cannot drive (P1-2); its honest answer is the typed
    // checkpoint_blocked decline, never a lie-attach.
    await parkAtAwaitRuntime();
    const replacement = await open('boot-2', false);
    vi.spyOn(
      replacement.authority,
      'harnessRunAuthorization',
    ).mockResolvedValue({
      status: 'runnable',
      checkpoint: {
        identity: {
          turnId: PROMPT_ID,
          promptId: PROMPT_ID,
          checkpointId: 'checkpoint-await-action',
        },
        attempt: {},
        continuation: { phase: 'await_action' },
        approval: { state: 'requested', requestId: 'request-1' },
        output: {},
        followUp: {},
        runtime: {},
        tools: { items: [] },
      },
    } as never);
    vi.spyOn(replacement.authority, 'action').mockReturnValue({
      state: 'decided',
    } as never);
    try {
      const outcome = await recoverHostedRuntimeTurn({
        session: replacement,
        sessionId: SESSION_ID,
        cwd: root,
        promptId: PROMPT_ID,
        brokerOptions,
        passive: false,
      });
      expect(outcome).toEqual({
        kind: 'declined',
        reason: 'checkpoint_blocked',
      });
    } finally {
      await replacement.close();
    }
  });

  it('stays retriable for a model-round wait on a cancellation load', async () => {
    // R11 narrowing: a plain attach on this shape stands a Session no
    // settlement route can pay — no live waiter, no projection. The
    // cancellation side throws into the route's retriable refusal instead
    // of minting it; the drive side keeps its typed model_start decline.
    await parkAtAwaitRuntime();
    const replacement = await open('boot-2', false);
    vi.spyOn(
      replacement.authority,
      'harnessRunAuthorization',
    ).mockResolvedValue({ status: 'initial' } as never);
    try {
      await expect(
        recoverHostedRuntimeTurn({
          session: replacement,
          sessionId: SESSION_ID,
          cwd: root,
          promptId: PROMPT_ID,
          brokerOptions,
          passive: true,
        }),
      ).rejects.toThrow('first model round');
    } finally {
      await replacement.close();
    }
  });

  it.each([
    { passive: false, expected: 'throw' },
    { passive: true, expected: 'inapplicable' },
  ])(
    'stays retriable for an unproven blocked reason at the final re-read (passive=$passive)',
    async ({ passive, expected }) => {
      // A reason this file does not know is not proven durable: the drive
      // side may only keep its retriable refusal, mirroring the pre-settle
      // read — a cause erased into 'unresolved_after_settle' would
      // terminalize what could be a transient store glitch.
      await parkAtAwaitRuntime();
      vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
      vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
        state: 'prepared',
      });
      vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
      if (!passive)
        vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
          executionStatus: 'success',
          responseParts: [{ text: 'written' }],
        } as never);
      const replacement = await open('boot-2', false);
      const authority = replacement.authority;
      const original = authority.harnessRunAuthorization.bind(authority);
      let calls = 0;
      vi.spyOn(authority, 'harnessRunAuthorization').mockImplementation(() => {
        calls += 1;
        if (calls === 2)
          return Promise.resolve({
            status: 'blocked',
            reason: 'a_future_blocked_reason',
          } as never);
        return original();
      });
      try {
        const outcome = recoverHostedRuntimeTurn({
          session: replacement,
          sessionId: SESSION_ID,
          cwd: root,
          promptId: PROMPT_ID,
          brokerOptions,
          passive,
        });
        if (expected === 'throw')
          // A throw, never a terminal decline: the exact producer's text
          // may vary (the handle re-checks too), the retriable semantics
          // may not.
          await expect(outcome).rejects.toThrow('a_future_blocked_reason');
        else expect((await outcome).kind).toBe('inapplicable');
      } finally {
        await replacement.close();
      }
    },
  );

  it('stays retriable for a durable verdict on a cancellation load', async () => {
    // R11 narrowing: a durably blocked checkpoint cannot be driven and no
    // plain attach settles it — the cancellation side throws into the
    // route's retriable refusal (never terminally), while the drive side
    // declines with the typed checkpoint_blocked reason.
    await parkAtAwaitRuntime();
    const replacement = await open('boot-2', false);
    vi.spyOn(
      replacement.authority,
      'harnessRunAuthorization',
    ).mockResolvedValue({
      status: 'blocked',
      reason: 'opaque_state',
    } as never);
    try {
      await expect(
        recoverHostedRuntimeTurn({
          session: replacement,
          sessionId: SESSION_ID,
          cwd: root,
          promptId: PROMPT_ID,
          brokerOptions,
          passive: true,
        }),
      ).rejects.toThrow('durably blocked');
    } finally {
      await replacement.close();
    }
  });

  it('declines a durable blocked checkpoint verdict deterministically', async () => {
    await parkAtAwaitRuntime();
    const replacement = await open('boot-2', false);
    vi.spyOn(
      replacement.authority,
      'harnessRunAuthorization',
    ).mockResolvedValue({
      status: 'blocked',
      reason: 'opaque_state',
    } as never);
    try {
      const outcome = await recoverHostedRuntimeTurn({
        session: replacement,
        sessionId: SESSION_ID,
        cwd: root,
        promptId: PROMPT_ID,
        brokerOptions,
        passive: false,
      });
      expect(outcome).toEqual({
        kind: 'declined',
        reason: 'checkpoint_blocked',
      });
    } finally {
      await replacement.close();
    }
  });

  it('refuses a runnable checkpoint parked under another turn', async () => {
    // The parked checkpoint is runnable, but its turnId is not the prompt the
    // takeover names — the recovery must decline instead of reporting a
    // snapshot for a turn it never inspected.
    await parkAtAwaitRuntime();
    const acquire = vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire');
    const execute = vi.spyOn(HostedWorkspaceBroker.prototype, 'execute');
    const replacement = await open('boot-2', false);
    try {
      const outcome = await recoverHostedRuntimeTurn({
        session: replacement,
        sessionId: SESSION_ID,
        cwd: root,
        promptId: '99999999-9999-4999-8999-999999999999',
        brokerOptions,
        passive: false,
      });
      expect(outcome).toEqual({
        kind: 'declined',
        reason: 'unresolved_after_settle',
      });
      expect(acquire).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await replacement.close();
    }
  });

  it('declines to re-dispatch a parked execution whose intent is missing', async () => {
    // No tool.intent: the recovery cannot rebuild the original arguments, so
    // it must decline rather than dispatch a tool with nothing behind it.
    await parkAtAwaitRuntime('write_file', false, false, false);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    const execute = vi.spyOn(HostedWorkspaceBroker.prototype, 'execute');
    const replacement = await open('boot-2', false);
    try {
      const outcome = await recoverHostedRuntimeTurn({
        session: replacement,
        sessionId: SESSION_ID,
        cwd: root,
        promptId: PROMPT_ID,
        brokerOptions,
        passive: false,
      });
      expect(outcome).toEqual({
        kind: 'declined',
        reason: 'batch_not_durable',
      });
      expect(execute).not.toHaveBeenCalled();
      // Missing ownership evidence is refused before acquiring a Runtime.
      expect(release).not.toHaveBeenCalled();
    } finally {
      await replacement.close();
    }
  });

  it('cancels parked executions without settling them', async () => {
    await parkAtAwaitRuntime(
      'write_file',
      false,
      false,
      true,
      undefined,
      'hooks-old-owner',
    );
    let stopped = false;
    const order: string[] = [];
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
      async function (this: HostedWorkspaceBroker) {
        expect(this.runtimeSessionId).toBe('hooks-old-owner');
        order.push('status');
        return { state: stopped ? 'settled' : 'executing' };
      },
    );
    const cancel = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'cancel')
      .mockImplementation(async function (this: HostedWorkspaceBroker) {
        expect(this.runtimeSessionId).toBe('hooks-old-owner');
        order.push('cancel');
        stopped = true;
      });
    const replacement = await open('boot-2', false);
    try {
      const broker = await stopParkedRuntimeExecutions({
        session: replacement,
        promptId: PROMPT_ID,
        brokerOptions,
      });
      expect(broker.runtimeSessionId).toBe('hooks-old-owner');
      expect(cancel).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledWith(EXECUTION_ID);
      // Issuing the cancel is not proof of the stop: a status read must
      // observe the terminal state after it.
      expect(order[order.length - 1]).toBe('status');
      expect(order.indexOf('cancel')).toBeGreaterThan(-1);
      expect(order.indexOf('cancel')).toBeLessThan(order.lastIndexOf('status'));
      // …and the wait must not settle anything into the Session history.
      const projected = await replacement.sink.project();
      expect(
        projected.filter(
          (entry) =>
            entry.daemonPromptId === PROMPT_ID && entry.type === 'tool_result',
        ),
      ).toHaveLength(0);
      const authorization =
        await replacement.authority.harnessRunAuthorization();
      expect(
        authorization.status === 'runnable' &&
          authorization.checkpoint.tools?.items.some(
            (item) => item.state === 'in_progress',
          ),
      ).toBe(true);
    } finally {
      await replacement.close();
    }
  });

  it('refuses to re-dispatch a parked Shell execution on a continuation load', async () => {
    await parkAtAwaitRuntime('run_shell_command');
    const acquire = vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire');
    const execute = vi.spyOn(HostedWorkspaceBroker.prototype, 'execute');
    const replacement = await open('boot-2', false);
    try {
      const outcome = await recoverHostedRuntimeTurn({
        session: replacement,
        sessionId: SESSION_ID,
        cwd: root,
        promptId: PROMPT_ID,
        brokerOptions,
        passive: false,
      });
      expect(outcome).toEqual({
        kind: 'declined',
        reason: 'shell_in_flight',
      });
      expect(acquire).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await replacement.close();
    }
  });

  it('omits an oversized settled output instead of failing the load', async () => {
    await parkAtAwaitRuntime();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'x'.repeat(2 * 1024 * 1024) }],
    } as never);
    const replacement = await open('boot-2', false);
    try {
      const recovered = mustRecover(
        await recoverHostedRuntimeTurn({
          session: replacement,
          sessionId: SESSION_ID,
          cwd: root,
          promptId: PROMPT_ID,
          brokerOptions,
          passive: false,
        }),
      );
      expect(recovered).toBeDefined();
      expect(recovered!.report.phase).toBe('results_ready');
      const projected = await replacement.sink.project();
      const result = projected.find(
        (entry) =>
          entry.daemonPromptId === PROMPT_ID && entry.type === 'tool_result',
      );
      expect(JSON.stringify(result)).toContain('outputOmitted');
    } finally {
      await replacement.close();
    }
  });

  it.each(['write_file', 'read_file', 'glob'])(
    'bounds an oversized recovered %s output without replaying it again',
    async (toolName) => {
      await parkAtAwaitRuntime(toolName);
      const paths = Array.from(
        { length: 100 },
        (_, index) => 'nested/'.repeat(120) + `file-${index}.ts`,
      );
      vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
      const execute = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'execute')
        .mockResolvedValue({
          executionStatus: 'success',
          responseParts: [{ text: paths.join('\n') }],
        } as never);
      const replacement = await open('boot-2', false);
      try {
        const recovered = mustRecover(
          await recoverHostedRuntimeTurn({
            session: replacement,
            sessionId: SESSION_ID,
            cwd: root,
            promptId: PROMPT_ID,
            brokerOptions,
            passive: false,
          }),
        );
        expect(recovered.report.phase).toBe('results_ready');
        expect(execute).toHaveBeenCalledTimes(1);
        const projected = await replacement.sink.project();
        const result = projected.find(
          (entry) =>
            entry.daemonPromptId === PROMPT_ID && entry.type === 'tool_result',
        );
        const limit =
          HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes;
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
          limit,
        );
        const response =
          result?.message?.parts?.[0]?.functionResponse?.response;
        expect(response?.['executionStatus']).toBe('success');
        const authorization =
          await replacement.authority.harnessRunAuthorization();
        expect(authorization.status).toBe('runnable');
        if (authorization.status !== 'runnable')
          throw new Error('not runnable');
        const outcomeRef = authorization.checkpoint.tools?.items[0]?.outcomeRef;
        expect(outcomeRef).toBeDefined();
        const outcome = await replacement.resources.read(outcomeRef!);
        expect(outcome.byteLength).toBeLessThanOrEqual(limit);
        expect(
          JSON.parse(outcome.toString('utf8')).functionResponse.response,
        ).toEqual(response);
        if (toolName === 'glob') {
          expect(response?.['outputTruncated']).toBe(true);
          expect(response?.['outputOmitted']).toBeUndefined();
          expect(response?.['output']).toContain(paths[0]);
          expect(response?.['output']).not.toContain(paths.at(-1));
          expect(response?.['output']).toContain('Narrow the pattern or path.');
        } else {
          expect(response?.['outputOmitted']).toBe(true);
          expect(response?.['outputTruncated']).toBeUndefined();
          expect(JSON.stringify(response)).not.toContain(
            'Narrow the pattern or path.',
          );
          if (toolName === 'read_file')
            expect(JSON.stringify(response)).toContain('offset/limit');
        }
      } finally {
        await replacement.close();
      }
    },
  );

  it.each([false, true])(
    'refuses cancellation when an execution outcome is unknown (afterCancel=%s)',
    async (afterCancel) => {
      await parkAtAwaitRuntime();
      const status = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'status')
        .mockResolvedValue({ state: 'unknown' });
      if (afterCancel) status.mockResolvedValueOnce({ state: 'executing' });
      const cancel = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'cancel')
        .mockResolvedValue();
      const release = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'release')
        .mockResolvedValue();
      const replacement = await open('boot-2', false);
      try {
        await expect(
          stopParkedRuntimeExecutions({
            session: replacement,
            promptId: PROMPT_ID,
            brokerOptions,
          }),
        ).rejects.toThrow('Runtime execution outcome is unknown.');
        expect(cancel).toHaveBeenCalledTimes(afterCancel ? 1 : 0);
        expect(release).not.toHaveBeenCalled();
        const authorization =
          await replacement.authority.harnessRunAuthorization();
        expect(authorization.status).toBe('runnable');
        if (authorization.status === 'runnable')
          expect(authorization.checkpoint.continuation.phase).toBe(
            'await_runtime',
          );
      } finally {
        await replacement.close();
      }
    },
  );

  it('does not journal a tool result twice across a recovery retry', async () => {
    await parkAtAwaitRuntime('write_file', true);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'done' }],
    } as never);
    const replacement = await open('boot-2', false);
    try {
      const recovered = mustRecover(
        await recoverHostedRuntimeTurn({
          session: replacement,
          sessionId: SESSION_ID,
          cwd: root,
          promptId: PROMPT_ID,
          brokerOptions,
          passive: false,
        }),
      );
      expect(recovered).toBeDefined();
      // The retry skipped only the duplicate write: the resolve still ran, so
      // the checkpoint reached results_ready and the report says so.
      expect(recovered!.report.phase).toBe('results_ready');
      expect(recovered!.report.executions).toEqual([
        expect.objectContaining({
          executionCallId: EXECUTION_ID,
          outcome: 'known',
          status: { state: 'settled' },
        }),
      ]);
      const results = (await replacement.sink.project()).filter(
        (entry) =>
          entry.daemonPromptId === PROMPT_ID && entry.type === 'tool_result',
      );
      expect(results).toHaveLength(1);
    } finally {
      await replacement.close();
    }
  });

  it.each([false, true])(
    'keeps a shared Runtime owner during recovery (passive=%s)',
    async (passive) => {
      await parkAtAwaitRuntime(
        'write_file',
        false,
        false,
        true,
        undefined,
        'hooks-old-owner',
      );
      const acquire = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
        .mockImplementation(async function (this: HostedWorkspaceBroker) {
          expect(this.runtimeSessionId).toBe('hooks-old-owner');
        });
      const status = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'status')
        .mockImplementation(async function (this: HostedWorkspaceBroker) {
          expect(this.runtimeSessionId).toBe('hooks-old-owner');
          return { state: 'executing' };
        });
      const execute = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'execute')
        .mockImplementation(async function (this: HostedWorkspaceBroker) {
          expect(this.runtimeSessionId).toBe('hooks-old-owner');
          return {
            executionStatus: 'success',
            responseParts: [{ text: 'done' }],
          } as never;
        });
      const replacement = await open('boot-2', false);
      try {
        const recovered = mustRecover(
          await recoverHostedRuntimeTurn({
            session: replacement,
            sessionId: SESSION_ID,
            cwd: root,
            promptId: PROMPT_ID,
            brokerOptions,
            passive,
          }),
        );
        expect(recovered?.report.executions[0]?.runtimeSessionId).toBe(
          'hooks-old-owner',
        );
        // Both modes adopt the original owner now: the continuation to
        // re-dispatch into it, the cancellation to read and release it.
        expect(acquire).toHaveBeenCalledTimes(1);
        expect(execute).toHaveBeenCalledTimes(passive ? 0 : 1);
        expect(status).toHaveBeenCalledTimes(passive ? 1 : 0);
      } finally {
        await replacement.close();
      }
    },
  );

  it('reports only the state, never the result payload, from a passive read', async () => {
    await parkAtAwaitRuntime();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    });
    const replacement = await open('boot-2', false);
    try {
      const recovered = mustRecover(
        await recoverHostedRuntimeTurn({
          session: replacement,
          sessionId: SESSION_ID,
          cwd: root,
          promptId: PROMPT_ID,
          brokerOptions,
          passive: true,
        }),
      );
      expect(HostedWorkspaceBroker.prototype.acquire).toHaveBeenCalled();
      // The adoption is held for the cancel route: loading never releases it.
      expect(release).not.toHaveBeenCalled();
      // A passive load only reads: nothing may be journaled for the prompt.
      expect(
        (await replacement.sink.project()).filter(
          (entry) =>
            entry.daemonPromptId === PROMPT_ID && entry.type === 'tool_result',
        ),
      ).toHaveLength(0);
      expect(recovered!.report.executions[0]).toEqual({
        functionCallId: 'call-1',
        toolName: 'write_file',
        executionCallId: EXECUTION_ID,
        runtimeSessionId: PROMPT_ID,
        outcome: 'known',
        status: { state: 'settled' },
      });
    } finally {
      await replacement.close();
    }
  });

  it('adopts the Runtime Session on a passive results_ready load', async () => {
    // The parked turn's executions all settled before the owner died: zero
    // pending, yet the dead owner's Runtime Session still pins the Workspace.
    await parkAtAwaitRuntime('write_file', false, true);
    const acquire = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
      .mockResolvedValue();
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    const replacement = await open('boot-2', false);
    try {
      const recovered = mustRecover(
        await recoverHostedRuntimeTurn({
          session: replacement,
          sessionId: SESSION_ID,
          cwd: root,
          promptId: PROMPT_ID,
          brokerOptions,
          passive: true,
        }),
      );
      expect(acquire).toHaveBeenCalledOnce();
      expect(recovered).toBeDefined();
      expect(recovered.acquiredRuntime).toBe(true);
      expect(recovered.report.phase).toBe('results_ready');
      expect(release).not.toHaveBeenCalled();
    } finally {
      await replacement.close();
    }
  });

  it('leaves the adoption owed when a passive load fails transiently', async () => {
    await parkAtAwaitRuntime();
    const acquire = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
      .mockResolvedValue();
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status')
      .mockRejectedValueOnce(new Error('transient broker error'))
      .mockResolvedValue({ state: 'prepared' });
    const first = await open('boot-2', false);
    try {
      await expect(
        recoverHostedRuntimeTurn({
          session: first,
          sessionId: SESSION_ID,
          cwd: root,
          promptId: PROMPT_ID,
          brokerOptions,
          passive: true,
        }),
      ).rejects.toThrow('transient broker error');
      // No compensation release: a release persists RELEASED and wedges
      // every retried acquire with 409 runtime_session_not_acquirable on the
      // real Broker.
      expect(release).not.toHaveBeenCalled();
    } finally {
      await first.close();
    }
    // The retried takeover re-acquires the same identity — idempotent
    // server-side — and produces the report.
    const second = await open('boot-3', false);
    try {
      const recovered = mustRecover(
        await recoverHostedRuntimeTurn({
          session: second,
          sessionId: SESSION_ID,
          cwd: root,
          promptId: PROMPT_ID,
          brokerOptions,
          passive: true,
        }),
      );
      expect(acquire).toHaveBeenCalledTimes(2);
      expect(recovered).toBeDefined();
      expect(recovered.acquiredRuntime).toBe(true);
      expect(recovered.report.executions).toEqual([
        expect.objectContaining({
          executionCallId: EXECUTION_ID,
          outcome: 'known',
          status: { state: 'prepared' },
        }),
      ]);
      expect(release).not.toHaveBeenCalled();
    } finally {
      await second.close();
    }
  });

  it('propagates an acquire failure without a compensation release', async () => {
    await parkAtAwaitRuntime();
    const acquire = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
      .mockRejectedValue(new Error('broker unreachable'));
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    const replacement = await open('boot-2', false);
    try {
      await expect(
        recoverHostedRuntimeTurn({
          session: replacement,
          sessionId: SESSION_ID,
          cwd: root,
          promptId: PROMPT_ID,
          brokerOptions,
          passive: true,
        }),
      ).rejects.toThrow('broker unreachable');
      expect(acquire).toHaveBeenCalledOnce();
      // A lost acquire reply may still have landed READY server-side;
      // releasing here would wedge the retried takeover. Leave it owed.
      expect(release).not.toHaveBeenCalled();
    } finally {
      await replacement.close();
    }
  });

  it('leaves the adoption owed when the final authorization fails on a passive load', async () => {
    await parkAtAwaitRuntime();
    const acquire = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
      .mockResolvedValue();
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'prepared',
    });
    const first = await open('boot-2', false);
    try {
      const authority = first.authority;
      const original = authority.harnessRunAuthorization.bind(authority);
      let authorizationCalls = 0;
      vi.spyOn(authority, 'harnessRunAuthorization').mockImplementation(() => {
        authorizationCalls += 1;
        if (authorizationCalls === 2)
          return Promise.reject(new Error('store hiccup'));
        return original();
      });
      await expect(
        recoverHostedRuntimeTurn({
          session: first,
          sessionId: SESSION_ID,
          cwd: root,
          promptId: PROMPT_ID,
          brokerOptions,
          passive: true,
        }),
      ).rejects.toThrow('store hiccup');
      expect(acquire).toHaveBeenCalledOnce();
      // The load route offers the coordinator a retry, so a release here
      // would persist RELEASED and wedge every retried acquire with
      // runtime_session_not_acquirable.
      expect(release).not.toHaveBeenCalled();
    } finally {
      await first.close();
    }
    // The retried takeover re-acquires the same identity — idempotent
    // server-side — and produces the report.
    const second = await open('boot-3', false);
    try {
      const recovered = mustRecover(
        await recoverHostedRuntimeTurn({
          session: second,
          sessionId: SESSION_ID,
          cwd: root,
          promptId: PROMPT_ID,
          brokerOptions,
          passive: true,
        }),
      );
      expect(acquire).toHaveBeenCalledTimes(2);
      expect(recovered).toBeDefined();
      expect(recovered.acquiredRuntime).toBe(true);
      expect(release).not.toHaveBeenCalled();
    } finally {
      await second.close();
    }
  });

  it('leaves the adoption owed when the final authorization is not runnable on a passive load', async () => {
    await parkAtAwaitRuntime();
    const acquire = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
      .mockResolvedValue();
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'prepared',
    });
    const first = await open('boot-2', false);
    try {
      const authority = first.authority;
      const original = authority.harnessRunAuthorization.bind(authority);
      let authorizationCalls = 0;
      vi.spyOn(authority, 'harnessRunAuthorization').mockImplementation(() => {
        authorizationCalls += 1;
        if (authorizationCalls === 2)
          // A transiently blocked authorization (the erased store read,
          // carrying the authority's message) is not a reason to release:
          // the coordinator retries the load, and a release would wedge it.
          return Promise.resolve({
            status: 'blocked',
            reason: 'missing_state',
            message: 'the HTTP Managed Session writer is not active.',
          } as never);
        return original();
      });
      await expect(
        recoverHostedRuntimeTurn({
          session: first,
          sessionId: SESSION_ID,
          cwd: root,
          promptId: PROMPT_ID,
          brokerOptions,
          passive: true,
        }),
      ).rejects.toThrow('the HTTP Managed Session writer is not active.');
      expect(acquire).toHaveBeenCalledOnce();
      expect(release).not.toHaveBeenCalled();
    } finally {
      await first.close();
    }
    const second = await open('boot-3', false);
    try {
      const recovered = mustRecover(
        await recoverHostedRuntimeTurn({
          session: second,
          sessionId: SESSION_ID,
          cwd: root,
          promptId: PROMPT_ID,
          brokerOptions,
          passive: true,
        }),
      );
      expect(acquire).toHaveBeenCalledTimes(2);
      expect(recovered).toBeDefined();
      expect(recovered.acquiredRuntime).toBe(true);
      expect(release).not.toHaveBeenCalled();
    } finally {
      await second.close();
    }
  });

  it('hands the lease back when the final authorization fails on a continuation load', async () => {
    // The no-pending re-attach shape: the continuation acquires even with
    // nothing left to drive, and this route's failure exits are the only
    // handback that exists when no report is returned.
    await parkAtAwaitRuntime('write_file', false, true);
    const acquire = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
      .mockResolvedValue();
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    const replacement = await open('boot-2', false);
    try {
      const authority = replacement.authority;
      const original = authority.harnessRunAuthorization.bind(authority);
      let authorizationCalls = 0;
      vi.spyOn(authority, 'harnessRunAuthorization').mockImplementation(() => {
        authorizationCalls += 1;
        if (authorizationCalls === 2)
          return Promise.reject(new Error('store hiccup'));
        return original();
      });
      await expect(
        recoverHostedRuntimeTurn({
          session: replacement,
          sessionId: SESSION_ID,
          cwd: root,
          promptId: PROMPT_ID,
          brokerOptions,
          passive: false,
        }),
      ).rejects.toThrow('store hiccup');
      expect(acquire).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await replacement.close();
    }
  });

  it('hands the lease back when the final authorization is not runnable on a continuation load', async () => {
    await parkAtAwaitRuntime('write_file', false, true);
    const acquire = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
      .mockResolvedValue();
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    const replacement = await open('boot-2', false);
    try {
      const authority = replacement.authority;
      const original = authority.harnessRunAuthorization.bind(authority);
      let authorizationCalls = 0;
      vi.spyOn(authority, 'harnessRunAuthorization').mockImplementation(() => {
        authorizationCalls += 1;
        if (authorizationCalls === 2)
          return Promise.resolve({
            status: 'blocked',
            reason: 'missing_state',
          } as never);
        return original();
      });
      // A bare missing_state is the durable absence: the lease is handed
      // back BEFORE the classification, so the decline is the answer.
      const outcome = await recoverHostedRuntimeTurn({
        session: replacement,
        sessionId: SESSION_ID,
        cwd: root,
        promptId: PROMPT_ID,
        brokerOptions,
        passive: false,
      });
      expect(outcome).toEqual({
        kind: 'declined',
        reason: 'checkpoint_blocked',
      });
      expect(acquire).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await replacement.close();
    }
  });
});

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * #13708: the foreground child wait must be restart-recoverable. A parent
 * that admitted a foreground child and then lost its process wedged every
 * later Turn before this suite's mechanism — recovery could only decline
 * the parked Turn (model_start), the child Session stayed ACTIVE with its
 * result never consumed, and close/delete could never pay the cascade debt
 * because the parent never became attachable again.
 *
 * The suite pins the mechanism's own code: a live authority parks at the
 * durable wait, a replacement authority over the same store classifies
 * through recoverHostedRuntimeTurn, and the settle/fill/resume helpers
 * shared by every settle path fold what the checkpoint still owes. The
 * routes themselves are driven end-to-end — including one wedge minted
 * by the production admission — in hosted-harness-session.test.ts
 * (R1-8); the wedge here is minted by direct harness commits, which the
 * route cases prove reaches the same stored shape.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalJsonlManagedSessionJournalStore } from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import { resetManagedRuntimeDispatchGatesForTest } from '@qwen-code/qwen-code-core/managed-runtime/managed-runtime-dispatch-gate.js';
import type { HarnessAgentWaitRun } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-checkpoint.js';
import {
  fillParkedRoundAgentGaps,
  recoverHostedRuntimeTurn,
  settleCancelledAgentWaitRuns,
  settleInterruptedTurnRuntime,
} from './hosted-runtime-recovery.js';
import { parkNeedsNoRuntimeSettlement } from './hosted-harness-session.js';
import { HostedChildAgentSession } from './hosted-child-agent-session.js';
import {
  HOSTED_AGENT_CALL_NOT_REACHED_TEXT,
  HostedWorkspaceToolTurn,
} from './hosted-workspace-tool-turn.js';
// The Broker is mocked below purely so the ToolTurn's constructor warm-up
// never dials out; the agent path never dispatches through it.
import './hosted-workspace-broker.js';

const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const PROMPT_ID = '33333333-3333-4333-8333-333333333333';
// The production derivation (hostedChildRunIdFor), never the mock
// Broker's hardcoded runtimeSessionId ('prompt') — an id no production
// launch would mint is off the surface the fill derives from (R1-8).
const CHILD_RUN_ID = `${PROMPT_ID}:call-1`;
const DIGEST = 'a'.repeat(64);

const broker = vi.hoisted(() => ({
  warm: vi.fn().mockResolvedValue(undefined),
  acquire: vi.fn().mockResolvedValue(undefined),
  prepare: vi.fn(),
  prepareV3: vi.fn(),
  execute: vi.fn(),
  executeV3: vi.fn(),
  acknowledgeV3: vi.fn(),
  cancel: vi.fn().mockResolvedValue(undefined),
  release: vi.fn().mockResolvedValue(undefined),
  acknowledge: vi.fn().mockResolvedValue(undefined),
  registerPublisher: vi.fn().mockResolvedValue('1'),
  fileHistory: vi.fn(),
}));
vi.mock('./hosted-workspace-broker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./hosted-workspace-broker.js')>()),
  HostedWorkspaceBroker: class {
    readonly runtimeSessionId = 'prompt';
    warm = broker.warm;
    acquire = broker.acquire;
    prepare = broker.prepare;
    prepareV3 = broker.prepareV3;
    execute = broker.execute;
    executeV3 = broker.executeV3;
    acknowledgeV3 = broker.acknowledgeV3;
    cancel = broker.cancel;
    release = broker.release;
    acknowledge = broker.acknowledge;
    registerPublisher = broker.registerPublisher;
    fileHistory = broker.fileHistory;
  },
}));

describe('hosted child wait recovery (#13708)', () => {
  let root: string;
  const sessionKey = {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    sessionId: SESSION_ID,
  };

  beforeEach(async () => {
    resetManagedRuntimeDispatchGatesForTest();
    vi.clearAllMocks();
    broker.warm.mockResolvedValue(undefined);
    broker.acquire.mockResolvedValue(undefined);
    broker.cancel.mockResolvedValue(undefined);
    broker.release.mockResolvedValue(undefined);
    broker.acknowledge.mockResolvedValue(undefined);
    broker.registerPublisher.mockResolvedValue('1');
    root = await mkdtemp(path.join(tmpdir(), 'hosted-child-wait-recovery-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  async function open(workerId: string, create: boolean) {
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
                toolProfile: 'hosted-workspace-files/1',
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

  function childrenOf(session: ManagedSession): HostedChildAgentSession {
    return new HostedChildAgentSession(
      { authority: session.authority, resources: session.resources },
      sessionKey,
    );
  }

  function toolResultEntries(
    projected: Awaited<ReturnType<ManagedSession['sink']['project']>>,
  ) {
    return projected.filter(
      (entry) =>
        entry.daemonPromptId === PROMPT_ID && entry.type === 'tool_result',
    );
  }

  /** A replacement-process ToolTurn: resume arm, real commit channel.
   * The caller keeps `consumption` so the resume arm's replay-safe mark
   * is asserted, never collected silently (R1-11). */
  function resumeTurn(
    session: ManagedSession,
    consumption: string[],
  ): HostedWorkspaceToolTurn {
    return new HostedWorkspaceToolTurn(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      createManagedHarnessHandle(session),
      PROMPT_ID,
      async (type, messageParts, model, identity) => {
        const uuid = identity?.uuid ?? randomUUID();
        await session.sink.write({
          uuid,
          parentUuid: null,
          sessionId: SESSION_ID,
          timestamp: identity?.timestamp ?? new Date().toISOString(),
          model,
          type,
          cwd: root,
          version: 'test',
          daemonPromptId: PROMPT_ID,
          message: {
            role: type === 'assistant' ? 'model' : 'user',
            parts: messageParts,
          },
        });
        return uuid;
      },
      () => true,
      undefined,
      {
        resources: session.resources,
        assertWritable: async () => undefined,
      },
      undefined,
      {
        profile: 'hosted-workspace-shell/1',
        childAgents: {
          funnel: childrenOf(session),
          depth: 0,
          queueConsumption: (childRunId) => consumption.push(childRunId),
        },
      },
    );
  }

  const waitRun: HarnessAgentWaitRun = {
    childRunId: CHILD_RUN_ID,
    functionCallId: 'call-1',
    toolName: 'agent',
    // The commit-returned uuid of the assistant message that carries the
    // wait's call — production passes it as `modelMessageId`, so the round
    // selector keys on it.
    modelMessageId: 'assistant-1',
    consumed: false,
  };

  /** Parks a live session at the durable wait, then closes it (the wedge). */
  async function parkWedged(withAssistantRound = false): Promise<void> {
    const session = await open('boot-1', true);
    try {
      await park(session, withAssistantRound);
    } finally {
      await session.close();
    }
    resetManagedRuntimeDispatchGatesForTest();
  }

  /** The wedge's durable record on an already-open owner: input, runnable,
   * one admitted child, the durable wait, and (optionally) the round the
   * dead loop journaled. The RUNNING child must keep its ledger so the
   * comeback can drive it — no terminal event here. */
  async function park(
    session: ManagedSession,
    withAssistantRound: boolean,
  ): Promise<void> {
    const harness = createManagedHarnessHandle(session);
    const authority = session.authority;
    const contentRef = await session.resources.publish(
      'managed-input',
      Buffer.from(JSON.stringify([{ type: 'text', text: 'review the diff' }])),
    );
    const admissionRef = await session.resources.publish(
      'managed-admission',
      Buffer.from(JSON.stringify({ promptId: PROMPT_ID, digest: 'x' })),
    );
    await authority.submitInput(
      {
        operation: 'submitInput',
        commandId: PROMPT_ID,
        sessionKey,
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
    const launched = await childrenOf(session).admit({
      childRunId: CHILD_RUN_ID,
      ownerScopeId: SESSION_ID,
      rootSessionId: SESSION_ID,
      completion: 'tool',
      description: 'audit the diff',
      prompt: 'review the change',
      definition: {
        definitionId: 'hosted-agent/hosted-workspace-files/1',
        definitionRevision: 1,
        definitionDigest: authority.sessionHeader.definitionRef.digest,
      },
      workingDirectory: '.',
      executionCallId: CHILD_RUN_ID,
    });
    await harness.commitAwaitAgent(
      [waitRun],
      { turnId: PROMPT_ID, promptId: PROMPT_ID },
      { attemptId: 'attempt-1', routeRef: launched.inputRef },
    );
    if (withAssistantRound) {
      // The wedged batch's own round: the dead loop reached call-1's wait
      // but never the sibling call-2 — the durable journal records the
      // assistant message the resume story must account for.
      await session.sink.write({
        uuid: 'assistant-1',
        parentUuid: null,
        sessionId: SESSION_ID,
        timestamp: new Date().toISOString(),
        type: 'assistant',
        cwd: root,
        version: 'test',
        daemonPromptId: PROMPT_ID,
        message: {
          role: 'model',
          parts: [
            { functionCall: { id: 'call-1', name: 'agent', args: {} } },
            { functionCall: { id: 'call-2', name: 'agent', args: {} } },
          ],
        },
      });
    }
  }

  /** The relay lands the child's terminal result and its acceptance. */
  async function settleTheChild(session: ManagedSession): Promise<void> {
    const children = childrenOf(session);
    await children.dispatchStarted(CHILD_RUN_ID, {
      dispatchId: 'dispatch-1',
      runtime: { runtimeBindingId: 'binding-1', generation: '1' },
    });
    await children.attach(CHILD_RUN_ID, 'child-session-1');
    await children.settleCompleted(CHILD_RUN_ID, {
      result: Buffer.from('{"review":"the diff is clean"}', 'utf8'),
      receipt: Buffer.from('{"stopReason":"end_turn"}', 'utf8'),
    });
    await children.accept(CHILD_RUN_ID, {});
  }

  it('interruption point 1: re-enters the wait and folds the settled answer exactly once', async () => {
    await parkWedged();
    const replacement = await open('boot-2', false);
    try {
      const consumption: string[] = [];
      const outcome = await recoverHostedRuntimeTurn({
        session: replacement,
        sessionId: SESSION_ID,
        cwd: root,
        promptId: PROMPT_ID,
        brokerOptions: { baseUrl: 'http://127.0.0.1:1', token: 'test' },
        passive: false,
      });
      expect(outcome.kind).toBe('recovered');
      if (outcome.kind !== 'recovered') return;
      expect(outcome.turn.report.phase).toBe('await_agent');

      // The relay keeps working against the attached daemon: the child
      // settles, then the resume arm folds its answer into the tool call.
      await settleTheChild(replacement);
      await resumeTurn(replacement, consumption).resumeAgentWaitRuns(
        [waitRun],
        'recovered',
        new AbortController().signal,
      );

      const projected = await replacement.sink.project();
      const results = toolResultEntries(projected);
      expect(results).toHaveLength(1);
      expect(JSON.stringify(results[0]?.message?.parts)).toContain(
        'the diff is clean',
      );
      const authorization =
        await replacement.authority.harnessRunAuthorization();
      expect(authorization.status).toBe('runnable');
      if (authorization.status === 'runnable') {
        expect(authorization.checkpoint.continuation.phase).toBe(
          'model_output_committed',
        );
        expect(authorization.checkpoint.agentWait?.runs).toMatchObject([
          { childRunId: CHILD_RUN_ID, consumed: true },
        ]);
      }
      const children = childrenOf(replacement);
      expect(children.acceptance(CHILD_RUN_ID)).toBeDefined();
      // The replay-safe marks ran outside the fold's journaled gate:
      // the relay's accepted delivery and the parent's consumption
      // queue both advanced (R1-11).
      expect(children.record(CHILD_RUN_ID)?.run.delivery?.state).toBe(
        'accepted',
      );
      expect(consumption).toEqual([CHILD_RUN_ID]);
    } finally {
      await replacement.close();
    }
  });

  it('interruption point 2: the committed answer folds exactly once past a lost reply', async () => {
    await parkWedged();
    // The owner committed the answer, then died before the resolve — the
    // replacement must not re-commit what the journal already carries.
    const first = await open('boot-1b', false);
    try {
      await settleTheChild(first);
      await first.sink.write({
        uuid: 'fold-1',
        parentUuid: 'assistant-1',
        sessionId: SESSION_ID,
        timestamp: new Date().toISOString(),
        type: 'tool_result',
        cwd: root,
        version: 'test',
        daemonPromptId: PROMPT_ID,
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call-1',
                name: 'agent',
                response: { executionStatus: 'success' },
              },
            },
          ],
        },
      });
    } finally {
      await first.close();
    }

    const replacement = await open('boot-2', false);
    try {
      const consumption: string[] = [];
      await resumeTurn(replacement, consumption).resumeAgentWaitRuns(
        [waitRun],
        'recovered',
        new AbortController().signal,
      );
      const projected = await replacement.sink.project();
      expect(toolResultEntries(projected)).toHaveLength(1);
      const authorization =
        await replacement.authority.harnessRunAuthorization();
      expect(authorization.status).toBe('runnable');
      if (authorization.status === 'runnable') {
        expect(authorization.checkpoint.agentWait?.runs).toMatchObject([
          { childRunId: CHILD_RUN_ID, consumed: true },
        ]);
      }
      // The acceptance advanced even though the commit was skipped: the
      // wait leaves its marker either way.
      expect(childrenOf(replacement).acceptance(CHILD_RUN_ID)).toBeDefined();
    } finally {
      await replacement.close();
    }
  });

  it('a cancellation takeover abandons the wait while the child keeps its ledger', async () => {
    await parkWedged();
    const replacement = await open('boot-2', false);
    try {
      const consumption: string[] = [];
      const abort = new AbortController();
      abort.abort();
      await resumeTurn(replacement, consumption).resumeAgentWaitRuns(
        [waitRun],
        'recovered',
        abort.signal,
      );
      const projected = await replacement.sink.project();
      const results = toolResultEntries(projected);
      expect(results).toHaveLength(1);
      expect(JSON.stringify(results[0]?.message?.parts)).toContain(
        'cancelled before the child agent finished',
      );
      const authorization =
        await replacement.authority.harnessRunAuthorization();
      expect(authorization.status).toBe('runnable');
      if (authorization.status === 'runnable') {
        expect(authorization.checkpoint.agentWait?.runs).toMatchObject([
          { childRunId: CHILD_RUN_ID, consumed: true },
        ]);
      }
      // The abandoned child is not revoked: its run record stands for the
      // relay to keep driving. The abandoned fold pays no accepted
      // delivery — there is none — so the resume arm leaves the
      // consumption queue untouched here.
      const record = childrenOf(replacement).record(CHILD_RUN_ID);
      expect(record).toBeDefined();
      expect(record?.run.state).not.toBe('cancelled');
      expect(consumption).toEqual([]);
    } finally {
      await replacement.close();
    }
  });

  it('the cancel settlement abandons and resolves the wait, replayed silently', async () => {
    await parkWedged();
    const replacement = await open('boot-2', false);
    try {
      await settleCancelledAgentWaitRuns({
        managed: replacement,
        sessionId: SESSION_ID,
        promptId: PROMPT_ID,
        cwd: root,
        runs: [waitRun],
      });
      // Replayed cancel: the journaled set already carries the fold.
      await settleCancelledAgentWaitRuns({
        managed: replacement,
        sessionId: SESSION_ID,
        promptId: PROMPT_ID,
        cwd: root,
        runs: [waitRun],
      });
      const results = toolResultEntries(await replacement.sink.project());
      expect(results).toHaveLength(1);
      expect(JSON.stringify(results[0]?.message?.parts)).toContain(
        'cancelled before the child agent finished',
      );
      expect(results[0]?.parentUuid).toBe('assistant-1');
      const authorization =
        await replacement.authority.harnessRunAuthorization();
      expect(authorization.status).toBe('runnable');
      if (authorization.status === 'runnable') {
        expect(authorization.checkpoint.agentWait?.runs).toMatchObject([
          { childRunId: CHILD_RUN_ID, consumed: true },
        ]);
      }
    } finally {
      await replacement.close();
    }
  });

  it('a second death past the last fold leaves only the orphan sibling, and the fill answers it', async () => {
    await parkWedged(true);
    // First comeback: the admitted wait folds and the checkpoint lands the
    // carried all-consumed shape — then this owner dies too.
    const first = await open('boot-2', false);
    try {
      const consumption: string[] = [];
      await settleTheChild(first);
      await resumeTurn(first, consumption).resumeAgentWaitRuns(
        [{ ...waitRun, functionCallId: 'call-1' }],
        'recovered',
        new AbortController().signal,
      );
    } finally {
      await first.close();
    }
    const replacement = await open('boot-3', false);
    try {
      // The carried group classifies as the wait, every run settled — no
      // outstanding run remains, and the route arms pair the orphan call-2.
      const outcome = await recoverHostedRuntimeTurn({
        session: replacement,
        sessionId: SESSION_ID,
        cwd: root,
        promptId: PROMPT_ID,
        brokerOptions: { baseUrl: 'http://127.0.0.1:1', token: 'test' },
        passive: false,
      });
      expect(outcome.kind).toBe('recovered');
      await expect(
        fillParkedRoundAgentGaps({
          managed: replacement,
          sessionId: SESSION_ID,
          promptId: PROMPT_ID,
          cwd: root,
          gapText: HOSTED_AGENT_CALL_NOT_REACHED_TEXT,
          children: childrenOf(replacement),
        }),
      ).resolves.toBe(1);
      const results = toolResultEntries(await replacement.sink.project());
      const ids = results
        .flatMap((entry) => entry.message?.parts ?? [])
        .map((part) => part.functionResponse?.id)
        .sort();
      expect(ids).toEqual(['call-1', 'call-2']);
    } finally {
      await replacement.close();
    }
  });

  /** The admitted orphan's chain completes against the attached daemon. */
  async function settleOrphan(
    session: ManagedSession,
    runId: string,
    text: string,
  ): Promise<HostedChildAgentSession> {
    const children = childrenOf(session);
    await children.dispatchStarted(runId, {
      dispatchId: `dispatch-${runId.split(':').at(-1)}`,
      runtime: { runtimeBindingId: 'binding-2', generation: '1' },
    });
    await children.attach(runId, 'child-session-2');
    await children.settleCompleted(runId, {
      result: Buffer.from(`{"review":"${text}"}`, 'utf8'),
      receipt: Buffer.from('{"stopReason":"end_turn"}', 'utf8'),
    });
    await children.accept(runId);
    return children;
  }

  it('an admitted orphan polling mid-flight folds its late settlement truthfully', async () => {
    await parkWedged(true);
    const orphanRunId = `${PROMPT_ID}:call-2`;
    const first = await open('boot-2', false);
    try {
      const consumption: string[] = [];
      await settleTheChild(first);
      await resumeTurn(first, consumption).resumeAgentWaitRuns(
        [{ ...waitRun, functionCallId: 'call-1' }],
        'recovered',
        new AbortController().signal,
      );
      await childrenOf(first).admit({
        childRunId: orphanRunId,
        ownerScopeId: SESSION_ID,
        rootSessionId: SESSION_ID,
        completion: 'tool',
        description: 'second audit',
        prompt: 'review two',
        definition: {
          definitionId: 'hosted-agent/hosted-workspace-files/1',
          definitionRevision: 1,
          definitionDigest: first.authority.sessionHeader.definitionRef.digest,
        },
        workingDirectory: '.',
        executionCallId: orphanRunId,
      });
      // Mid-flight only: a dispatch, no settlement yet — the fill's own
      // poll must wait, and the late answer must be the truthful one.
      await childrenOf(first).dispatchStarted(orphanRunId, {
        dispatchId: 'dispatch-call-2',
        runtime: { runtimeBindingId: 'binding-2', generation: '1' },
      });
    } finally {
      await first.close();
    }
    const replacement = await open('boot-3', false);
    try {
      // The poll's wait is the behavior this case is named for: the
      // ledger read must fire more than once, never a single read that
      // gives up (R1-36).
      const ledgerReads = vi.spyOn(HostedChildAgentSession.prototype, 'record');
      const driving = (async () => {
        await new Promise((resolve) => setTimeout(resolve, 600));
        await settleOrphan(replacement, orphanRunId, 'two late diffs clean');
      })();
      const filled = await fillParkedRoundAgentGaps({
        managed: replacement,
        sessionId: SESSION_ID,
        promptId: PROMPT_ID,
        cwd: root,
        gapText: HOSTED_AGENT_CALL_NOT_REACHED_TEXT,
        children: childrenOf(replacement),
      });
      await driving;
      expect(filled).toBe(1);
      const orphanReads = ledgerReads.mock.calls.filter(
        ([runId]) => runId === orphanRunId,
      ).length;
      expect(orphanReads).toBeGreaterThan(1);
      const projected = await replacement.sink.project();
      const callTwo = toolResultEntries(projected).find((entry) =>
        entry.message?.parts?.some(
          (part) => part.functionResponse?.id === 'call-2',
        ),
      );
      expect(JSON.stringify(callTwo?.message?.parts)).toContain(
        'two late diffs clean',
      );
      expect(JSON.stringify(callTwo?.message?.parts)).not.toContain(
        'cancelled',
      );
    } finally {
      await replacement.close();
    }
  });

  it('an aborted signal abandons an admitted orphan honestly, and the child keeps its ledger', async () => {
    await parkWedged(true);
    const orphanRunId = `${PROMPT_ID}:call-2`;
    const first = await open('boot-2', false);
    try {
      const consumption: string[] = [];
      await settleTheChild(first);
      await resumeTurn(first, consumption).resumeAgentWaitRuns(
        [{ ...waitRun, functionCallId: 'call-1' }],
        'recovered',
        new AbortController().signal,
      );
      await childrenOf(first).admit({
        childRunId: orphanRunId,
        ownerScopeId: SESSION_ID,
        rootSessionId: SESSION_ID,
        completion: 'tool',
        description: 'second audit',
        prompt: 'review two',
        definition: {
          definitionId: 'hosted-agent/hosted-workspace-files/1',
          definitionRevision: 1,
          definitionDigest: first.authority.sessionHeader.definitionRef.digest,
        },
        workingDirectory: '.',
        executionCallId: orphanRunId,
      });
    } finally {
      await first.close();
    }
    const replacement = await open('boot-3', false);
    try {
      const abort = new AbortController();
      abort.abort();
      await fillParkedRoundAgentGaps({
        managed: replacement,
        sessionId: SESSION_ID,
        promptId: PROMPT_ID,
        cwd: root,
        gapText: HOSTED_AGENT_CALL_NOT_REACHED_TEXT,
        children: childrenOf(replacement),
        signal: abort.signal,
      });
      const projected = await replacement.sink.project();
      const callTwo = toolResultEntries(projected).find((entry) =>
        entry.message?.parts?.some(
          (part) => part.functionResponse?.id === 'call-2',
        ),
      );
      expect(JSON.stringify(callTwo?.message?.parts)).toContain(
        'cancelled before the child agent finished',
      );
      const record = childrenOf(replacement).record(orphanRunId);
      expect(record?.run.state).not.toBe('cancelled');
    } finally {
      await replacement.close();
    }
  });

  it('an admitted orphan never gets the fabricated answer: its own outcome folds', async () => {
    await parkWedged(true);
    const first = await open('boot-2', false);
    try {
      const consumption: string[] = [];
      await settleTheChild(first);
      await resumeTurn(first, consumption).resumeAgentWaitRuns(
        [{ ...waitRun, functionCallId: 'call-1' }],
        'recovered',
        new AbortController().signal,
      );
      // The second kill lands exactly in the accepted window: call-2's
      // child is admitted durably, its wait checkpoint never minted. The
      // ledger id derives from promptId, exactly as the launcher derives it.
      const orphanRunId = `${PROMPT_ID}:call-2`;
      await childrenOf(first).admit({
        childRunId: orphanRunId,
        ownerScopeId: SESSION_ID,
        rootSessionId: SESSION_ID,
        completion: 'tool',
        description: 'second audit',
        prompt: 'review two',
        definition: {
          definitionId: 'hosted-agent/hosted-workspace-files/1',
          definitionRevision: 1,
          definitionDigest: first.authority.sessionHeader.definitionRef.digest,
        },
        workingDirectory: '.',
        executionCallId: orphanRunId,
      });
    } finally {
      await first.close();
    }
    const replacement = await open('boot-3', false);
    try {
      const orphanRunId = `${PROMPT_ID}:call-2`;
      const children = childrenOf(replacement);
      await children.dispatchStarted(orphanRunId, {
        dispatchId: 'dispatch-2',
        runtime: { runtimeBindingId: 'binding-2', generation: '1' },
      });
      await children.attach(orphanRunId, 'child-session-2');
      await children.settleCompleted(orphanRunId, {
        result: Buffer.from('{"review":"two diffs are clean"}', 'utf8'),
        receipt: Buffer.from('{"stopReason":"end_turn"}', 'utf8'),
      });
      await children.accept(orphanRunId);
      const consumed: string[] = [];
      const filled = await fillParkedRoundAgentGaps({
        managed: replacement,
        sessionId: SESSION_ID,
        promptId: PROMPT_ID,
        cwd: root,
        gapText: HOSTED_AGENT_CALL_NOT_REACHED_TEXT,
        children,
        consume: (childRunId) => consumed.push(childRunId),
      });
      expect(filled).toBe(1);
      const projected = await replacement.sink.project();
      const callTwo = toolResultEntries(projected).find((entry) =>
        entry.message?.parts?.some(
          (part) => part.functionResponse?.id === 'call-2',
        ),
      );
      expect(JSON.stringify(callTwo?.message?.parts)).toContain(
        'two diffs are clean',
      );
      expect(JSON.stringify(callTwo?.message?.parts)).not.toContain(
        'cancelled',
      );
      expect(children.acceptance(orphanRunId)).toBeDefined();
      // The fill's replay-safe marks rides outside the fold gate: the
      // relay's delivery advanced to accepted and the parent's
      // consumption queue received the run (R1-11). The wait's own
      // call-1 stays out of the fill — its marks belong to the wait arm
      // that already ran them.
      expect(children.record(orphanRunId)?.run.delivery?.state).toBe(
        'accepted',
      );
      expect(consumed).toEqual([orphanRunId]);
    } finally {
      await replacement.close();
    }
  });

  it('an oversized admitted-orphan answer folds with the truncation marker, never as an error', async () => {
    await parkWedged(true);
    const orphanRunId = `${PROMPT_ID}:call-2`;
    const first = await open('boot-2', false);
    try {
      const consumption: string[] = [];
      await settleTheChild(first);
      await resumeTurn(first, consumption).resumeAgentWaitRuns(
        [{ ...waitRun, functionCallId: 'call-1' }],
        'recovered',
        new AbortController().signal,
      );
      await childrenOf(first).admit({
        childRunId: orphanRunId,
        ownerScopeId: SESSION_ID,
        rootSessionId: SESSION_ID,
        completion: 'tool',
        description: 'second audit',
        prompt: 'review two',
        definition: {
          definitionId: 'hosted-agent/hosted-workspace-files/1',
          definitionRevision: 1,
          definitionDigest: first.authority.sessionHeader.definitionRef.digest,
        },
        workingDirectory: '.',
        executionCallId: orphanRunId,
      });
    } finally {
      await first.close();
    }
    const replacement = await open('boot-3', false);
    try {
      const children = childrenOf(replacement);
      await children.dispatchStarted(orphanRunId, {
        dispatchId: 'dispatch-2',
        runtime: { runtimeBindingId: 'binding-2', generation: '1' },
      });
      await children.attach(orphanRunId, 'child-session-2');
      await children.settleCompleted(orphanRunId, {
        // Under the 65536-byte child-result limit (65513) yet over the
        // 64 KiB inline resource bound once wrapped in the record (~66000),
        // so the exact template predicate — not a caller lambda (R1-7) —
        // measures the fold that ships: halved down to fit with the marker.
        result: Buffer.from('{"review":"' + 'r'.repeat(65500) + '"}', 'utf8'),
        receipt: Buffer.from('{"stopReason":"end_turn"}', 'utf8'),
      });
      await children.accept(orphanRunId);
      const filled = await fillParkedRoundAgentGaps({
        managed: replacement,
        sessionId: SESSION_ID,
        promptId: PROMPT_ID,
        cwd: root,
        gapText: HOSTED_AGENT_CALL_NOT_REACHED_TEXT,
        children,
      });
      expect(filled).toBe(1);
      const projected = await replacement.sink.project();
      const callTwo = toolResultEntries(projected).find((entry) =>
        entry.message?.parts?.some(
          (part) => part.functionResponse?.id === 'call-2',
        ),
      );
      expect(JSON.stringify(callTwo?.message?.parts)).toContain(
        'truncated: the full result is on the acceptance record',
      );
      expect(children.acceptance(orphanRunId)).toBeDefined();
    } finally {
      await replacement.close();
    }
  });

  it("the wedged round's never-reached calls are answered by the gap fill, exactly once", async () => {
    await parkWedged(true);
    const replacement = await open('boot-2', false);
    try {
      const consumption: string[] = [];
      // The admitted wait folds first — only then does the round's true gap
      // stand out: call-2, which the dead loop never even admitted.
      await settleTheChild(replacement);
      await resumeTurn(replacement, consumption).resumeAgentWaitRuns(
        [{ ...waitRun, functionCallId: 'call-1' }],
        'recovered',
        new AbortController().signal,
      );
      const filled = await fillParkedRoundAgentGaps({
        managed: replacement,
        sessionId: SESSION_ID,
        promptId: PROMPT_ID,
        cwd: root,
        gapText: HOSTED_AGENT_CALL_NOT_REACHED_TEXT,
        children: childrenOf(replacement),
      });
      expect(filled).toBe(1);
      // A replayed fill is silent: the journaled set already carries both ids.
      await expect(
        fillParkedRoundAgentGaps({
          managed: replacement,
          sessionId: SESSION_ID,
          promptId: PROMPT_ID,
          cwd: root,
          gapText: HOSTED_AGENT_CALL_NOT_REACHED_TEXT,
          children: childrenOf(replacement),
        }),
      ).resolves.toBe(0);
      const projected = await replacement.sink.project();
      const results = toolResultEntries(projected);
      expect(results).toHaveLength(2);
      const callTwo = results.find((entry) =>
        entry.message?.parts?.some(
          (part) => part.functionResponse?.id === 'call-2',
        ),
      );
      // The recovery family's wording: nothing was cancelled — the owning
      // turn was interrupted (R1-49).
      expect(JSON.stringify(callTwo?.message?.parts)).toContain(
        'interrupted before this child agent was admitted',
      );
      expect(JSON.stringify(callTwo?.message?.parts)).not.toContain(
        'cancelled',
      );
      expect(
        toolResultEntries(projected).map((entry) => entry.parentUuid),
      ).toContain('assistant-1');
    } finally {
      await replacement.close();
    }
  });

  it('after the re-entry the durable basis stands clean for the next turn', async () => {
    await parkWedged();
    const replacement = await open('boot-2', false);
    try {
      const consumption: string[] = [];
      await settleTheChild(replacement);
      await resumeTurn(replacement, consumption).resumeAgentWaitRuns(
        [waitRun],
        'recovered',
        new AbortController().signal,
      );
      // The model round the consumed wait owed may start at once: the
      // wedged parent is attachable again with no owed checkpoint debt —
      // the precondition the close cascade's child operations ride on.
      const harness = createManagedHarnessHandle(replacement);
      const runnable = await harness.ensureRunnable();
      expect(runnable.continuation.phase).toBe('model_output_committed');
      const nextAuthorization =
        await replacement.authority.harnessRunAuthorization();
      expect(nextAuthorization.status).toBe('runnable');
    } finally {
      await replacement.close();
    }
    // A cold open sees the same healthy basis: no blocked authorization,
    // no agent wait leak into the next turn boundary.
    const reopened = await open('boot-3', false);
    try {
      const authorization = await reopened.authority.harnessRunAuthorization();
      expect(authorization.status).toBe('runnable');
      if (authorization.status === 'runnable') {
        expect(authorization.checkpoint.agentWait?.runs).toMatchObject([
          { consumed: true },
        ]);
      }
    } finally {
      await reopened.close();
    }
  });

  it('the parked wait is never the cancellation-takeover short-circuit (R1-3)', async () => {
    const fresh = await open('boot-0', true);
    try {
      // Baseline: no checkpoint yet — the journal alone answers the park.
      await expect(parkNeedsNoRuntimeSettlement(fresh)).resolves.toBe(true);
      await park(fresh, false);
      // The dead wait owes the child runs their settlement: settling the
      // terminal record directly would strand the dangling functionCall
      // and orphan the ledger, so the separation must refuse — at once,
      // against the still-open owner whose durable wait predicates the
      // verdict.
      await expect(parkNeedsNoRuntimeSettlement(fresh)).resolves.toBe(false);
    } finally {
      await fresh.close();
    }
    resetManagedRuntimeDispatchGatesForTest();
    // A cold open judges the same park the same way.
    const replacement = await open('boot-1', false);
    try {
      await expect(parkNeedsNoRuntimeSettlement(replacement)).resolves.toBe(
        false,
      );
    } finally {
      await replacement.close();
    }
  });

  it('a failed admitted orphan folds its terminal cause, never the never-admitted answer (R1-10)', async () => {
    await parkWedged(true);
    const orphanRunId = `${PROMPT_ID}:call-2`;
    const first = await open('boot-2', false);
    try {
      const consumption: string[] = [];
      await settleTheChild(first);
      await resumeTurn(first, consumption).resumeAgentWaitRuns(
        [{ ...waitRun, functionCallId: 'call-1' }],
        'recovered',
        new AbortController().signal,
      );
      await childrenOf(first).admit({
        childRunId: orphanRunId,
        ownerScopeId: SESSION_ID,
        rootSessionId: SESSION_ID,
        completion: 'tool',
        description: 'second audit',
        prompt: 'review two',
        definition: {
          definitionId: 'hosted-agent/hosted-workspace-files/1',
          definitionRevision: 1,
          definitionDigest: first.authority.sessionHeader.definitionRef.digest,
        },
        workingDirectory: '.',
        executionCallId: orphanRunId,
      });
      // The orphan failed before its parent died: the poll's third exit
      // must fold that terminal cause, not mint a never-admitted record.
      await childrenOf(first).settleFailed(orphanRunId, {
        stopReason: 'quota_exceeded',
        reason: 'byte_limit',
        started: false,
      });
    } finally {
      await first.close();
    }
    const replacement = await open('boot-3', false);
    try {
      const filled = await fillParkedRoundAgentGaps({
        managed: replacement,
        sessionId: SESSION_ID,
        promptId: PROMPT_ID,
        cwd: root,
        gapText: HOSTED_AGENT_CALL_NOT_REACHED_TEXT,
        children: childrenOf(replacement),
      });
      expect(filled).toBe(1);
      const projected = await replacement.sink.project();
      const callTwo = toolResultEntries(projected).find((entry) =>
        entry.message?.parts?.some(
          (part) => part.functionResponse?.id === 'call-2',
        ),
      );
      expect(JSON.stringify(callTwo?.message?.parts)).toContain(
        'Child agent run failed',
      );
      expect(JSON.stringify(callTwo?.message?.parts)).not.toContain(
        'interrupted before this child agent was admitted',
      );
    } finally {
      await replacement.close();
    }
  });

  it('a background-completion orphan folds the started receipt, never a poll (R1-24)', async () => {
    await parkWedged(true);
    const orphanRunId = `${PROMPT_ID}:call-2`;
    const first = await open('boot-2', false);
    try {
      const consumption: string[] = [];
      await settleTheChild(first);
      await resumeTurn(first, consumption).resumeAgentWaitRuns(
        [{ ...waitRun, functionCallId: 'call-1' }],
        'recovered',
        new AbortController().signal,
      );
      // Background delegations complete through the task surface, never
      // the wait's poll: the sent-completion record is all the fill has.
      await childrenOf(first).admit({
        childRunId: orphanRunId,
        ownerScopeId: SESSION_ID,
        rootSessionId: SESSION_ID,
        completion: 'sent',
        description: 'background audit',
        prompt: 'review later',
        definition: {
          definitionId: 'hosted-agent/hosted-workspace-files/1',
          definitionRevision: 1,
          definitionDigest: first.authority.sessionHeader.definitionRef.digest,
        },
        workingDirectory: '.',
        executionCallId: orphanRunId,
      });
    } finally {
      await first.close();
    }
    const replacement = await open('boot-3', false);
    try {
      const filled = await fillParkedRoundAgentGaps({
        managed: replacement,
        sessionId: SESSION_ID,
        promptId: PROMPT_ID,
        cwd: root,
        gapText: HOSTED_AGENT_CALL_NOT_REACHED_TEXT,
        children: childrenOf(replacement),
      });
      expect(filled).toBe(1);
      const projected = await replacement.sink.project();
      const callTwo = toolResultEntries(projected).find((entry) =>
        entry.message?.parts?.some(
          (part) => part.functionResponse?.id === 'call-2',
        ),
      );
      // The live background arm's started receipt names the task the
      // model should track — never the wait's abandoned answer nor the
      // never-admitted one.
      expect(JSON.stringify(callTwo?.message?.parts)).toContain(
        'started in the background',
      );
      expect(JSON.stringify(callTwo?.message?.parts)).not.toContain(
        'cancelled before the child agent finished',
      );
      expect(JSON.stringify(callTwo?.message?.parts)).not.toContain(
        'cancelled before this child agent was admitted',
      );
    } finally {
      await replacement.close();
    }
  });

  it('the interrupted-turn settlement folds the wait and answers the gaps, replayed silently (R1-3)', async () => {
    await parkWedged(true);
    const replacement = await open('boot-2', false);
    try {
      const settle = await settleInterruptedTurnRuntime({
        session: replacement,
        sessionId: SESSION_ID,
        cwd: root,
        promptId: PROMPT_ID,
        brokerOptions: undefined,
        toolProfile: true,
        children: childrenOf(replacement),
      });
      expect(settle.kind).toBe('ready');
      let results = toolResultEntries(await replacement.sink.project());
      expect(results).toHaveLength(2);
      const texts = results.flatMap((entry) =>
        (entry.message?.parts ?? []).map((part) =>
          JSON.stringify(part.functionResponse?.response),
        ),
      );
      // call-1 meets the live arm's abandoned answer; call-2, never
      // admitted, meets the interruption's own wording (R1-49).
      expect(
        texts.some((text) =>
          text.includes('cancelled before the child agent finished'),
        ),
      ).toBe(true);
      expect(
        texts.some((text) =>
          text.includes('interrupted before this child agent was admitted'),
        ),
      ).toBe(true);
      const authorization =
        await replacement.authority.harnessRunAuthorization();
      expect(authorization.status).toBe('runnable');
      if (authorization.status === 'runnable') {
        expect(authorization.checkpoint.continuation.phase).toBe(
          'model_output_committed',
        );
        expect(authorization.checkpoint.agentWait?.runs).toMatchObject([
          { childRunId: CHILD_RUN_ID, consumed: true },
        ]);
      }
      // A replayed settlement is silent: the wait stands resolved and the
      // journal already carries both answers.
      const replayed = await settleInterruptedTurnRuntime({
        session: replacement,
        sessionId: SESSION_ID,
        cwd: root,
        promptId: PROMPT_ID,
        brokerOptions: undefined,
        toolProfile: true,
        children: childrenOf(replacement),
      });
      expect(replayed.kind).toBe('ready');
      results = toolResultEntries(await replacement.sink.project());
      expect(results).toHaveLength(2);
    } finally {
      await replacement.close();
    }
  });

  it('the interrupted-turn settlement does not wait on an admitted orphan (R3-1)', async () => {
    await parkWedged(true);
    const orphanRunId = `${PROMPT_ID}:call-2`;
    const first = await open('boot-2', false);
    try {
      const consumption: string[] = [];
      await settleTheChild(first);
      await resumeTurn(first, consumption).resumeAgentWaitRuns(
        [{ ...waitRun, functionCallId: 'call-1' }],
        'recovered',
        new AbortController().signal,
      );
      await childrenOf(first).admit({
        childRunId: orphanRunId,
        ownerScopeId: SESSION_ID,
        rootSessionId: SESSION_ID,
        completion: 'tool',
        description: 'second audit',
        prompt: 'review two',
        definition: {
          definitionId: 'hosted-agent/hosted-workspace-files/1',
          definitionRevision: 1,
          definitionDigest: first.authority.sessionHeader.definitionRef.digest,
        },
        workingDirectory: '.',
        executionCallId: orphanRunId,
      });
    } finally {
      await first.close();
    }
    const replacement = await open('boot-3', false);
    try {
      // The admitted orphan never terminates in this test: the funnel's
      // settlement must fold the abandoned answer at once, exactly like
      // the takeover cancellation, not poll past its own settle.
      const settle = await settleInterruptedTurnRuntime({
        session: replacement,
        sessionId: SESSION_ID,
        cwd: root,
        promptId: PROMPT_ID,
        brokerOptions: undefined,
        toolProfile: true,
        children: childrenOf(replacement),
      });
      expect(settle.kind).toBe('ready');
      const projected = await replacement.sink.project();
      const callTwo = toolResultEntries(projected).find((entry) =>
        entry.message?.parts?.some(
          (part) => part.functionResponse?.id === 'call-2',
        ),
      );
      expect(JSON.stringify(callTwo?.message?.parts)).toContain(
        'cancelled before the child agent finished',
      );
      // The ledger keeps the orphan: it is abandoned, never revoked.
      const record = childrenOf(replacement).record(orphanRunId);
      expect(record).toBeDefined();
      expect(record?.run.state).not.toBe('cancelled');
    } finally {
      await replacement.close();
    }
  }, 10_000);
});

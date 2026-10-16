/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression suite for #13847: a Harness crash inside a batch with no
 * Runtime work must not permanently block the lead Session.
 *
 * A background `agent` launch is a journal-only commit: `startChildRun`
 * writes the child run record, but the Turn commits no checkpoint naming
 * the batch — `commitAwaitRuntimeBatch` runs only when `bindings.length`
 * is non-zero (hosted-workspace-tool-turn.ts), and the agent-wait
 * checkpoint of #13769 covers foreground waits only. A crash after
 * `startChildRun` commits and before the Turn's next checkpoint therefore
 * parks the Turn at a model-start phase (`model_output_committed` in
 * `default` approval mode, `before_model` in `yolo` — and, where no wait
 * ever checkpointed the Turn, a runnable checkpoint that names no Turn).
 *
 * Before the fix the real takeover path `recoverHostedRuntimeTurn`
 * declined that park (`model_start`, or `unresolved_after_settle` when
 * the checkpoint never bound the Turn), forever: the coordinator ended
 * the Turn `managed_runtime_recovery_blocked`, the input stayed
 * unsettled, and every later load of the lead answered 409
 * `hosted_turn_recovery_required`. The fix settles instead: the journal
 * proves the open round holds only journal-only calls, so the takeover
 * answers the owed calls by their own evidence (the committed
 * `startChildRun` as started, never as never run), writes the Turn's
 * cancelled terminal so the input settles, and answers `inapplicable` —
 * the pre-G3 "no Runtime work owed" the plain attach already pays.
 *
 * Each arm below drives ONLY production modules (local journal store,
 * `createManagedHarnessHandle`, `HostedChildAgentSession.admit` — the
 * real `startChildRun` commit — and `recoverHostedRuntimeTurn` — the
 * real takeover classification), staging the exact durable state the
 * physical rig produced. The pins assert the crash state, the settle's
 * durable consequences, and the takeover's outcome on every repeated
 * redrive.
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
import { recoverHostedRuntimeTurn } from './hosted-runtime-recovery.js';
import { HostedChildAgentSession } from './hosted-child-agent-session.js';
import { HostedTeamSession } from './hosted-team-session.js';
import {
  commitHostedFileHistory,
  readHostedFileHistory,
} from './hosted-file-history.js';
import { HARNESS_MODEL_START_PHASES } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-checkpoint.js';
import { HOSTED_TOOL_APPROVAL_POLICY } from './hosted-tool-approval.js';

const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const PROMPT_ID = '33333333-3333-4333-8333-333333333333';
const CHILD_RUN_ID = `${PROMPT_ID}:call-1`;
const ACTION_ID = '77777777-7777-4777-8777-777777777777';
const DIGEST = 'a'.repeat(64);

describe('hosted background launch recovery (#13847)', () => {
  let root: string;

  beforeEach(async () => {
    resetManagedRuntimeDispatchGatesForTest();
    root = await mkdtemp(path.join(tmpdir(), 'hosted-bg-launch-recovery-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  async function open(workerId: string, create: boolean) {
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

  async function submitTurn(session: ManagedSession): Promise<void> {
    const authority = session.authority;
    const contentRef = await session.resources.publish(
      'managed-input',
      Buffer.from(
        JSON.stringify([{ type: 'text', text: 'launch a background agent' }]),
      ),
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
  }

  /** The real `startChildRun` commit of the H4b background launch. */
  async function admitBackgroundLaunch(session: ManagedSession): Promise<void> {
    const authority = session.authority;
    const children = new HostedChildAgentSession(
      { authority, resources: session.resources },
      authority.sessionHeader.sessionKey,
    );
    await children.admit({
      childRunId: CHILD_RUN_ID,
      ownerScopeId: SESSION_ID,
      rootSessionId: SESSION_ID,
      completion: 'sent',
      description: 'investigate the flaky test',
      prompt: 'reproduce the flake and report',
      definition: {
        definitionId: 'hosted-agent/hosted-workspace-files/1',
        definitionRevision: 1,
        definitionDigest: authority.sessionHeader.definitionRef.digest,
      },
      workspaceMode: 'shared',
      workingDirectory: '.',
      executionCallId: CHILD_RUN_ID,
    });
  }

  /**
   * Drives a fresh session into the crash window of the `default` approval
   * mode arm: the batch's launch waited on approval (`await_action`), the
   * approval was granted, `resolveDurableWait` parked the Turn at
   * `model_output_committed`, `startChildRun` committed, and the owner died
   * before the Turn's next checkpoint.
   */
  async function crashAfterStartChildRunModelOutput(
    options: { withPendingHistory?: boolean } = {},
  ): Promise<void> {
    const session = await open('boot-1', true);
    try {
      const harness = createManagedHarnessHandle(session);
      await submitTurn(session);
      await harness.ensureRunnable();
      await session.sink.write({
        uuid: 'assistant-1',
        parentUuid: null,
        sessionId: SESSION_ID,
        timestamp: new Date().toISOString(),
        type: 'assistant',
        cwd: root,
        version: 'hosted-harness/1',
        daemonPromptId: PROMPT_ID,
        message: {
          role: 'assistant',
          parts: [
            {
              functionCall: {
                id: 'call-1',
                name: 'agent',
                args: {
                  description: 'investigate the flaky test',
                  prompt: 'reproduce the flake and report',
                  background: true,
                },
              },
            },
          ],
        },
      });
      await harness.commitDurableWait(
        {
          requestId: ACTION_ID,
          kind: 'execute',
          source: 'tool_call',
          optionsRef: await session.resources.publish(
            'managed-action-options',
            Buffer.from(
              JSON.stringify({
                v: 1,
                requestId: ACTION_ID,
                turnId: PROMPT_ID,
                functionCallId: 'call-1',
                toolName: 'child_agent',
                policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
                inputRevision: 1,
                createdAt: Date.now() - 20_000,
                expiresAt: Date.now() + 3_600_000,
                options: [
                  { id: 'allow', label: 'Allow once' },
                  { id: 'deny', label: 'Deny' },
                ],
              }),
            ),
          ),
          inputRevision: 'rev-1',
          invocationRef: await session.resources.publish(
            'managed-invocation',
            Buffer.from('{"toolCallId":"call-1"}', 'utf8'),
          ),
          attemptId: 'att-1',
          routeRef: await session.resources.publish(
            'managed-route',
            Buffer.from('{"model":"qwen3-coder-plus"}', 'utf8'),
          ),
        },
        { turnId: PROMPT_ID, promptId: PROMPT_ID },
      );
      // The user allowed the launch; the wait resolves and parks the Turn
      // exactly where the physical pass found it: `model_output_committed`.
      const decisionRef = await session.resources.publish(
        'managed-decision',
        Buffer.from('{"optionId":"allow"}', 'utf8'),
      );
      await session.authority.resolveAction(
        {
          operation: 'resolveAction',
          commandId: `resolveAction:${ACTION_ID}:decided`,
          sessionKey: session.authority.sessionHeader.sessionKey,
          contentDigest: decisionRef.digest,
        },
        { requestId: ACTION_ID, state: 'decided', decisionRef },
      );
      const resolved = await harness.resolveDurableWait();
      expect(resolved?.continuation.phase).toBe('model_output_committed');
      // The crash window: the background launch's `startChildRun` commit
      // lands as a journal-only write. No Runtime bindings exist, so the
      // Turn commits no `await_runtime` batch checkpoint; a background
      // launch takes no agent-wait checkpoint either (#13769 is
      // foreground-only).
      await admitBackgroundLaunch(session);
      if (options.withPendingHistory) {
        // The dead Turn's file-history marker dies with its Harness:
        // kept snapshots, owed marker — the thing the settle must clear.
        await commitHostedFileHistory(session, {
          schemaVersion: 1,
          state: { ownerSessionId: SESSION_ID, snapshots: [], files: {} },
          pendingTurn: PROMPT_ID,
          pendingUndo: null,
        });
      }
    } finally {
      // The Harness dies here: no detach, no settle, no further checkpoint.
      await session.close();
    }
  }

  /**
   * The `yolo` shape: no approval wait checkpoints the Turn, so the batch
   * runs at `before_model`; `startChildRun` commits; the owner dies.
   */
  async function crashAfterStartChildRunYolo(): Promise<void> {
    const session = await open('boot-1', true);
    try {
      const harness = createManagedHarnessHandle(session);
      await submitTurn(session);
      await harness.ensureRunnable();
      // The turn engine binds the turn identity when the model round starts.
      await harness.adoptPreparedContinuation(PROMPT_ID);
      const authorization = await session.authority.harnessRunAuthorization();
      if (authorization.status !== 'runnable')
        throw new Error('the yolo arm must park runnable');
      expect(authorization.checkpoint.continuation.phase).toBe('before_model');
      // The batch's own assistant round is durable exactly as the default
      // arm's: its call is the one the settle must answer as started.
      await session.sink.write({
        uuid: 'assistant-yolo-1',
        parentUuid: null,
        sessionId: SESSION_ID,
        timestamp: new Date().toISOString(),
        type: 'assistant',
        cwd: root,
        version: 'hosted-harness/1',
        daemonPromptId: PROMPT_ID,
        message: {
          role: 'assistant',
          parts: [
            {
              functionCall: {
                id: 'call-1',
                name: 'agent',
                args: {
                  description: 'investigate the flaky test',
                  prompt: 'reproduce the flake and report',
                  background: true,
                },
              },
            },
          ],
        },
      });
      await admitBackgroundLaunch(session);
    } finally {
      await session.close();
    }
  }

  /** Pins the durable crash state every arm stages. */
  async function expectCrashState(
    replacement: ManagedSession,
    phase: string,
    expectedTurnId: string | null = PROMPT_ID,
  ): Promise<void> {
    const authority = replacement.authority;
    const authorization = await authority.harnessRunAuthorization();
    if (authorization.status !== 'runnable')
      throw new Error(
        `the crashed park must read runnable, got ${authorization.status}`,
      );
    const checkpoint = authorization.checkpoint;
    expect(checkpoint.continuation.phase).toBe(phase);
    expect(HARNESS_MODEL_START_PHASES.has(checkpoint.continuation.phase)).toBe(
      true,
    );
    expect(checkpoint.identity.turnId).toBe(expectedTurnId);
    // The `startChildRun` journal write is durable: one child_run row at
    // revision 1 (`planned`), never dispatched, never attached, no result.
    const childRun = authority.extensionRecord('child_run', CHILD_RUN_ID);
    expect(childRun?.revision).toBe(1);
    const parsed = new HostedChildAgentSession(
      { authority, resources: replacement.resources },
      authority.sessionHeader.sessionKey,
    ).record(CHILD_RUN_ID);
    expect(parsed?.run.execution).toBe('intent');
    expect(parsed?.childSessionId).toBeNull();
    expect(parsed?.resultRef).toBeNull();
    // The Turn's input is still unsettled at crash time — the predicate
    // of the load route's `load refused (unsettled_input)` refusal.
    expect(await unsettledTurnIds(replacement)).toContain(PROMPT_ID);
  }

  /** The load route's own unsettled-input predicate, re-derived. */
  async function unsettledTurnIds(
    session: ManagedSession,
  ): Promise<Set<string>> {
    const unsettled = new Set<string>();
    for (const event of session.authority.eventsInSequenceRange(
      1,
      session.authority.committedSequence,
    )) {
      if (event.kind === 'input.accepted')
        unsettled.add(event.payload['turnId'] as string);
      if (event.kind === 'turn.settled')
        unsettled.delete(event.payload['turnId'] as string);
    }
    return unsettled;
  }

  /** The real takeover call: the replacement Harness, its real funnel. */
  async function takeover(replacement: ManagedSession) {
    return takeoverRaw(replacement, {
      children: new HostedChildAgentSession(
        {
          authority: replacement.authority,
          resources: replacement.resources,
        },
        replacement.authority.sessionHeader.sessionKey,
      ),
    });
  }

  /** Takeover with an explicit funnel set — the negative arms' own. */
  async function takeoverRaw(
    replacement: ManagedSession,
    funnels: {
      children?: HostedChildAgentSession;
      teams?: HostedTeamSession;
    },
  ) {
    return recoverHostedRuntimeTurn({
      session: replacement,
      sessionId: SESSION_ID,
      cwd: root,
      promptId: PROMPT_ID,
      brokerOptions,
      passive: false,
      ...funnels,
    });
  }

  /**
   * Stage the yolo crash window holding exactly one owed call of the
   * given tool name: the park is `before_model`, the Turn bound, and the
   * call is owed — its journal evidence never committed, so what the
   * takeover does with it is decided by the family/funnel guards alone.
   */
  async function parkYoloWithOwedCall(name: string): Promise<void> {
    const session = await open('boot-1', true);
    try {
      const harness = createManagedHarnessHandle(session);
      await submitTurn(session);
      await harness.ensureRunnable();
      await harness.adoptPreparedContinuation(PROMPT_ID);
      const authorization = await session.authority.harnessRunAuthorization();
      if (authorization.status !== 'runnable')
        throw new Error('the owed-call arm must park runnable');
      expect(authorization.checkpoint.continuation.phase).toBe('before_model');
      await session.sink.write({
        uuid: `assistant-owed-${name}`,
        parentUuid: null,
        sessionId: SESSION_ID,
        timestamp: new Date().toISOString(),
        type: 'assistant',
        cwd: root,
        version: 'hosted-harness/1',
        daemonPromptId: PROMPT_ID,
        message: {
          role: 'assistant',
          parts: [{ functionCall: { id: 'call-1', name, args: {} } }],
        },
      });
    } finally {
      await session.close();
    }
  }

  /** Pins the settle's durable consequences on every accepted arm. */
  async function expectSettledState(replacement: ManagedSession): Promise<{
    kind: string;
  }> {
    const outcome = await takeover(replacement);
    expect(outcome).toEqual({ kind: 'inapplicable' });
    // The settle is a deterministic function of the durable journal:
    // every redrive of the settled Turn answers the same inapplicable
    // and never a decline the coordinator would stamp terminally.
    const retry = await takeover(replacement);
    expect(retry).toEqual({ kind: 'inapplicable' });
    // The Turn's terminal landed: the cancelled turn.settled settles
    // the input, so the lead loads again and the child result relay can
    // record its attach and result.
    expect(await unsettledTurnIds(replacement)).not.toContain(PROMPT_ID);
    // The interrupted call earned its own evidence's answer: started by
    // the committed startChildRun, never a fabricated never-ran.
    const records = (await replacement.sink.project()).filter(
      (entry) => entry.daemonPromptId === PROMPT_ID,
    );
    const fold = records.findLast(
      (entry) =>
        entry.type === 'tool_result' &&
        JSON.stringify(entry.message?.parts).includes('call-1'),
    );
    expect(fold).toBeDefined();
    const foldJson = JSON.stringify(fold?.message?.parts);
    expect(foldJson).toContain('started in the background as');
    expect(foldJson).not.toContain('never ran');
    return outcome as { kind: string };
  }

  const brokerOptions = { baseUrl: 'http://127.0.0.1:1', token: 'test' };

  it('default mode: the takeover settles the crashed background-launch batch (was: declined model_start)', async () => {
    await crashAfterStartChildRunModelOutput();
    const replacement = await open('boot-2', false);
    try {
      await expectCrashState(replacement, 'model_output_committed');
      await expectSettledState(replacement);
    } finally {
      await replacement.close();
    }
  });

  it('yolo mode: the takeover settles the crashed background-launch batch (was: declined model_start)', async () => {
    await crashAfterStartChildRunYolo();
    const replacement = await open('boot-2', false);
    try {
      await expectCrashState(replacement, 'before_model');
      await expectSettledState(replacement);
    } finally {
      await replacement.close();
    }
  });

  it('initial status: a crash before the first checkpoint settles too', async () => {
    const session = await open('boot-1', true);
    try {
      await submitTurn(session);
      // The Harness dies before ensureRunnable: no checkpoint at all —
      // the recoverer's `initial` branch used to decline this forever.
      const crashed = await session.authority.harnessRunAuthorization();
      expect(crashed.status).toBe('initial');
    } finally {
      await session.close();
    }
    const replacement = await open('boot-2', false);
    try {
      const outcome = await takeover(replacement);
      expect(outcome).toEqual({ kind: 'inapplicable' });
      expect(await unsettledTurnIds(replacement)).not.toContain(PROMPT_ID);
      const retry = await takeover(replacement);
      expect(retry).toEqual({ kind: 'inapplicable' });
    } finally {
      await replacement.close();
    }
  });

  it('declines a park whose owed call is outside the journal-only family, without writing anything', async () => {
    await parkYoloWithOwedCall('write_file');
    const replacement = await open('boot-2', false);
    try {
      const before = (await replacement.sink.project()).filter(
        (entry) => entry.daemonPromptId === PROMPT_ID,
      ).length;
      const outcome = await takeover(replacement);
      // A Runtime call cannot be proven stopped or never run, so the
      // typed decline stands — no minted answer, no terminal, nothing.
      expect(outcome).toEqual({ kind: 'declined', reason: 'model_start' });
      const after = (await replacement.sink.project()).filter(
        (entry) => entry.daemonPromptId === PROMPT_ID,
      ).length;
      expect(after).toBe(before);
      expect(await unsettledTurnIds(replacement)).toContain(PROMPT_ID);
    } finally {
      await replacement.close();
    }
  });

  it('declines a park whose owed call lacks the evidence funnel that would answer it', async () => {
    await parkYoloWithOwedCall('agent');
    const replacement = await open('boot-2', false);
    try {
      // No children funnel: the started answer cannot be proven, so the
      // takeover keeps the typed decline instead of minting a never-ran.
      const outcome = await takeoverRaw(replacement, {});
      expect(outcome).toEqual({ kind: 'declined', reason: 'model_start' });
      expect(await unsettledTurnIds(replacement)).toContain(PROMPT_ID);
    } finally {
      await replacement.close();
    }
  });

  it('declines a park whose owed team call lacks one of its two evidence funnels', async () => {
    await parkYoloWithOwedCall('task_create');
    const replacement = await open('boot-2', false);
    try {
      // `teams` alone is not enough: a member board call's committed
      // evidence rides the command journal (H4e-b3), so the settle keeps
      // the typed decline until BOTH funnels are held.
      const outcome = await takeoverRaw(replacement, {
        teams: new HostedTeamSession(
          {
            authority: replacement.authority,
            resources: replacement.resources,
          },
          replacement.authority.sessionHeader.sessionKey,
        ),
      });
      expect(outcome).toEqual({ kind: 'declined', reason: 'model_start' });
      expect(await unsettledTurnIds(replacement)).toContain(PROMPT_ID);
    } finally {
      await replacement.close();
    }
  });

  it('drops the dead Turn pending file-history marker when it settles', async () => {
    await crashAfterStartChildRunModelOutput({ withPendingHistory: true });
    const replacement = await open('boot-2', false);
    try {
      expect((await readHostedFileHistory(replacement))?.pendingTurn).toBe(
        PROMPT_ID,
      );
      await expectSettledState(replacement);
      const history = await readHostedFileHistory(replacement);
      expect(history?.pendingTurn).toBeNull();
      expect(history?.pendingUndo).toBeNull();
      expect(history?.state).toEqual({
        ownerSessionId: SESSION_ID,
        snapshots: [],
        files: {},
      });
    } finally {
      await replacement.close();
    }
  });

  it('settles on one journal projection (no duplicate classify+answer walk)', async () => {
    await crashAfterStartChildRunModelOutput();
    const replacement = await open('boot-2', false);
    try {
      const projectSpy = vi.spyOn(replacement.sink, 'project');
      const outcome = await takeover(replacement);
      expect(outcome).toEqual({ kind: 'inapplicable' });
      // The settle's classification and its answer pass share the one
      // snapshot — a second full walk of the committed events was the
      // duplicate the review removed.
      expect(projectSpy).toHaveBeenCalledTimes(1);
      projectSpy.mockRestore();
    } finally {
      await replacement.close();
    }
  });

  it('settles a park whose owed plan approval carries its own one-funnel evidence', async () => {
    await parkYoloWithOwedCall('team_plan_approval');
    const replacement = await open('boot-2', false);
    try {
      // planDecisionEvidence lives on the teams funnel alone: with it,
      // the call joins the settle family and — nothing committed — is
      // answered as never run, ending the Turn instead of declining it.
      const outcome = await takeoverRaw(replacement, {
        teams: new HostedTeamSession(
          {
            authority: replacement.authority,
            resources: replacement.resources,
          },
          replacement.authority.sessionHeader.sessionKey,
        ),
      });
      expect(outcome).toEqual({ kind: 'inapplicable' });
      expect(await unsettledTurnIds(replacement)).not.toContain(PROMPT_ID);
      const records = (await replacement.sink.project()).filter(
        (entry) => entry.daemonPromptId === PROMPT_ID,
      );
      const fold = records.findLast(
        (entry) =>
          entry.type === 'tool_result' &&
          JSON.stringify(entry.message?.parts).includes('call-1'),
      );
      expect(fold).toBeDefined();
      expect(JSON.stringify(fold?.message?.parts)).toContain('never ran');
    } finally {
      await replacement.close();
    }
  });

  it('declines a parked plan approval without the teams evidence funnel', async () => {
    await parkYoloWithOwedCall('team_plan_approval');
    const replacement = await open('boot-2', false);
    try {
      // planDecisionEvidence rides the teams funnel alone — without it
      // the takeover cannot prove what the call committed, so the typed
      // decline stands, never a minted answer.
      const before = (await replacement.sink.project()).filter(
        (entry) => entry.daemonPromptId === PROMPT_ID,
      ).length;
      const outcome = await takeoverRaw(replacement, {});
      expect(outcome).toEqual({ kind: 'declined', reason: 'model_start' });
      expect(await unsettledTurnIds(replacement)).toContain(PROMPT_ID);
      // The decline writes nothing: the funnel guard runs before the
      // answer pass, so no minted tool_result fold lands in the journal.
      const after = (await replacement.sink.project()).filter(
        (entry) => entry.daemonPromptId === PROMPT_ID,
      ).length;
      expect(after).toBe(before);
    } finally {
      await replacement.close();
    }
  });

  it('yolo unbound: the takeover settles a park whose checkpoint never bound the Turn (was: declined unresolved_after_settle)', async () => {
    const session = await open('boot-1', true);
    try {
      const harness = createManagedHarnessHandle(session);
      await submitTurn(session);
      await harness.ensureRunnable();
      // No wait ever checkpoints this Turn, so it dies unnamed: the
      // physical rig's yolo shape — declined unresolved_after_settle.
      const assistantUuid = 'assistant-unbound-1';
      await session.sink.write({
        uuid: assistantUuid,
        parentUuid: null,
        sessionId: SESSION_ID,
        timestamp: new Date().toISOString(),
        type: 'assistant',
        cwd: root,
        version: 'hosted-harness/1',
        daemonPromptId: PROMPT_ID,
        message: {
          role: 'assistant',
          parts: [
            {
              functionCall: {
                id: 'call-1',
                name: 'agent',
                args: {
                  description: 'investigate the flaky test',
                  prompt: 'reproduce the flake and report',
                  background: true,
                },
              },
            },
          ],
        },
      });
      await admitBackgroundLaunch(session);
      const crashed = await session.authority.harnessRunAuthorization();
      if (crashed.status !== 'runnable')
        throw new Error('the unbound arm must park runnable');
      expect(crashed.checkpoint.identity.turnId).toBeNull();
    } finally {
      await session.close();
    }
    const replacement = await open('boot-2', false);
    try {
      await expectCrashState(replacement, 'before_model', null);
      await expectSettledState(replacement);
    } finally {
      await replacement.close();
    }
  });
});

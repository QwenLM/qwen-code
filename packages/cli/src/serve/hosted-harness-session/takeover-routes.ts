/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import { HTTP_MANAGED_SESSION_STORE_CONTRACT } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import type { ManagedInvocationObservation } from '@qwen-code/qwen-code-core/managed-runtime/managed-execution-diagnostics.js';
import {
  harnessCheckpointIsAgentWait,
  harnessCheckpointIsCommandWait,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-checkpoint.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import type { Application, Request, Response } from 'express';
import {
  sanitizeDaemonLogLine,
  writeStderrLineSafe,
} from '../../utils/stdioHelpers.js';
import {
  HostedModelUnavailableError,
  readHostedAgentInstructions,
} from '../hosted-agent-definition.js';
import { readHostedTurnApprovalSelection } from '../hosted-approval-selection.js';
import {
  commitHostedFileHistory,
  dropPendingHostedFileHistoryTurn,
  HOSTED_UUID,
  readHostedFileHistory,
} from '../hosted-file-history.js';
import {
  HostedImageInputUnsupportedError,
  HostedModelApiError,
  hostedToolOutputBudget,
  runHostedHarnessTextTurn,
} from '../hosted-harness-model.js';
import { parseHostedInput } from '../hosted-input.js';
import { readHostedTurnModelSelection } from '../hosted-model-selection.js';
import {
  answerResumedTurnCalls,
  fillParkedRoundAgentGaps,
  fillParkedRoundCommandGaps,
  HostedChildLedgerRecoveryRequiredError,
  settleCancelledAgentWaitRuns,
  settleCancelledCommandWaitRuns,
  settleParkedTurnCancelled,
  stopParkedRuntimeExecutions,
} from '../hosted-runtime-recovery.js';
import { HostedTextDeltaStream } from '../hosted-text-deltas.js';
import {
  isExcludedHostedRecord,
  normalizeHostedTurnRecords,
} from '../hosted-turn-history.js';
import type {
  HostedWorkspaceBroker,
  HostedWorkspaceBrokerOptions,
} from '../hosted-workspace-broker.js';
import {
  HOSTED_AGENT_CALL_NOT_ADMITTED_TEXT,
  HOSTED_AGENT_CALL_NOT_REACHED_TEXT,
  hostedRuntimeSessionId,
  HostedToolRecoveryRequiredError,
  type HostedWorkspaceContextSlot,
  HostedWorkspaceToolTurn,
  isRetryableWorkspaceAcquisition,
} from '../hosted-workspace-tool-turn.js';
import { extensionAgentsOf } from './configuration-routes.js';
import { childAgentsOf, stopPublicChildSource } from './interaction-routes.js';
import { noteSessionActivity } from './lifecycle-routes.js';
import {
  blockOnTurnRecovery,
  blockRecovery,
  type HostedRuntimeOwnership,
  liftRecoveryBlock,
  releaseIsSatisfied,
} from './runtime-ownership.js';
import {
  describeManagedError,
  error,
  harnessAuthorizationDetail,
  hostedTurnBusyReason,
  identity,
  namedStoreFailure,
  object,
  record,
} from './session-http.js';
import type { HostedSession } from './session-state.js';
import { answerRecoveredTurnCommittedCalls } from './turn-cancellation.js';
import { ensureMemberPlanMode, hostedApprovalForTurn } from './turn.js';
import {
  hasAcceptedInput,
  persistRecoveryUnobserved,
  readHostedClassifierUserText,
  unansweredPrompts,
  unsettledInputs,
  unsettledPromptId,
} from './wake-recovery.js';

export function registerHostedTakeoverRoutes({
  app,
  sessions,
  epoch,
  cwd,
  brokerOptions,
  releaseRecoveredRuntime,
}: {
  app: Application;
  sessions: Map<string, HostedSession>;
  epoch: string;
  cwd: string;
  brokerOptions: HostedWorkspaceBrokerOptions | undefined;
  releaseRecoveredRuntime: HostedRuntimeOwnership['releaseRecoveredRuntime'];
}): void {
  const recoveryRequest = (
    req: Request,
  ):
    | { promptId: string; checkpointId: string; activationId: string }
    | undefined => {
    const body = object(req.body);
    const promptId = body?.['promptId'];
    const checkpointId = body?.['checkpointId'];
    const activationId = body?.['activationId'];
    if (
      typeof promptId !== 'string' ||
      !HOSTED_UUID.test(promptId) ||
      typeof checkpointId !== 'string' ||
      checkpointId.length === 0 ||
      checkpointId.length > 512 ||
      typeof activationId !== 'string' ||
      activationId.length === 0 ||
      activationId.length > 512
    ) {
      return undefined;
    }
    return { promptId, checkpointId, activationId };
  };

  // The coordinator replays a recovery call whose reply was lost; an already
  // settled Turn answers with the current watermark instead of driving twice.
  const settledReplay = (
    session: HostedSession,
    promptId: string,
    res: Response,
  ): boolean => {
    if (
      !hasAcceptedInput(session, promptId) ||
      unsettledInputs(session).has(promptId)
    ) {
      return false;
    }
    res.status(200).json({
      accepted: true,
      promptId,
      lastEventId: session.managed.authority.committedSequence,
      eventEpoch: epoch,
    });
    return true;
  };

  const matchesRecovery = (
    session: HostedSession,
    promptId: string,
    checkpointId: string | undefined,
    activationId: string,
  ): boolean =>
    session.managed.authority.latestCheckpoint?.checkpointId === checkpointId &&
    session.managed.activation.activationId === activationId &&
    unsettledPromptId(session) === promptId;

  app.post('/session/:id/managed-runtime/continue', async (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (session.mcpClosing) return error(res, 409, 'hosted_session_closing');
    if (session.mcpBusy || session.mcpRecovering)
      return error(res, 409, 'hosted_mcp_operation_active');
    if (session.hooks) return error(res, 409, 'hosted_hook_recovery_required');
    const request = recoveryRequest(req);
    if (!request) return error(res, 400, 'invalid_managed_runtime_recovery');
    const { promptId, checkpointId, activationId } = request;
    // A blocked Turn never writes a terminal record, so a replay must meet
    // the refusal rather than re-answer an admission that will never settle.
    // A lease the still-parked Turn owns stays held, exactly like the cancel
    // route's blocked refusal: the next takeover re-acquires the still-READY
    // identity idempotently, while a release would persist RELEASED and wedge
    // every retry on runtime_session_not_acquirable. A lease whose Turn
    // already settled — the cleanup-only block — owes the handback itself:
    // the Turn is terminal, nothing re-acquires the identity, and the
    // reconcile releases it with the original owner's binding.
    if (session.blocked) {
      if (
        session.runtimeLeaseHeld !== undefined &&
        unsettledPromptId(session) !== session.runtimeLeaseHeld.promptId
      )
        releaseRecoveredRuntime(session);
      return error(
        res,
        409,
        'hosted_turn_recovery_required',
        hostedTurnBusyReason(session),
      );
    }
    // A continuation whose reply was lost is replayed by the coordinator: it
    // must get the watermark it was admitted at, running or settled, or the
    // coordinator would stream from after the Turn's own events.
    const recoveryDigest = `recovery:${checkpointId}:${activationId}`;
    const admittedRecovery = session.admissions.get(promptId);
    if (admittedRecovery?.digest === recoveryDigest) {
      if (!session.active && session.runtimeLeaseHeld?.promptId === promptId)
        releaseRecoveredRuntime(session);
      res.status(200).json({
        accepted: true,
        promptId,
        lastEventId: admittedRecovery.lastEventId,
        eventEpoch: epoch,
      });
      return;
    }
    if (session.active) return error(res, 409, 'hosted_turn_active');
    if (!session.toolProfile || !brokerOptions) {
      releaseRecoveredRuntime(session);
      return error(
        res,
        409,
        'hosted_turn_recovery_required',
        'recovery_unsupported',
      );
    }
    if (!matchesRecovery(session, promptId, checkpointId, activationId)) {
      if (settledReplay(session, promptId, res)) {
        if (session.runtimeLeaseHeld?.promptId === promptId)
          releaseRecoveredRuntime(session);
        return;
      }
      releaseRecoveredRuntime(session);
      return error(res, 409, 'hosted_recovery_identity_mismatch');
    }
    // Prove the checkpoint is continuable before answering: a 200 admission
    // for a turn that cannot continue would settle it with a bare
    // turn.settled and wedge the Session for good. The authorization read
    // itself failing is a third refusal ground, not a `not_runnable` state.
    const continueAuthorization = await session.managed.authority
      .harnessRunAuthorization()
      .then(
        (authorization) => ({ ok: true as const, authorization }),
        (cause) => ({ ok: false as const, cause }),
      );
    if (identity(req, sessions) !== session)
      return error(res, 404, 'hosted_session_not_found');
    if (session.mcpClosing) return error(res, 409, 'hosted_session_closing');
    if (session.mcpBusy || session.mcpRecovering)
      return error(res, 409, 'hosted_mcp_operation_active');
    if (session.active) return error(res, 409, 'hosted_turn_active');
    if (!continueAuthorization.ok) {
      releaseRecoveredRuntime(session);
      writeStderrLineSafe(
        `qwen serve: Hosted Session ${req.params['id']} continue: run authorization could not be read: ${sanitizeDaemonLogLine(String(continueAuthorization.cause))}`,
      );
      return error(
        res,
        409,
        'hosted_turn_recovery_required',
        'authorization_unreadable',
      );
    }
    if (continueAuthorization.authorization.status !== 'runnable') {
      releaseRecoveredRuntime(session);
      const unusable = continueAuthorization.authorization;
      writeStderrLineSafe(
        `qwen serve: Hosted Session ${req.params['id']} continue: run authorization not runnable: ${harnessAuthorizationDetail(unusable)}`,
      );
      return error(res, 409, 'hosted_turn_recovery_required', 'not_runnable');
    }
    if (
      continueAuthorization.authorization.checkpoint.continuation.phase !==
        'results_ready' &&
      // The agent wait (#13708): still outstanding, or folded past it —
      // the consumed advance lands as model_output_committed carrying the
      // wait's group. Both re-enter through the same resume arm below, and
      // so does the command wait (H4e-b3), which the takeover reports as
      // await_command.
      !harnessCheckpointIsAgentWait(
        continueAuthorization.authorization.checkpoint,
      ) &&
      !harnessCheckpointIsCommandWait(
        continueAuthorization.authorization.checkpoint,
      )
    ) {
      releaseRecoveredRuntime(session);
      writeStderrLineSafe(
        `qwen serve: Hosted Session ${req.params['id']} continue: continuation not ready: phase=${continueAuthorization.authorization.checkpoint.continuation.phase}`,
      );
      return error(
        res,
        409,
        'hosted_turn_recovery_required',
        'continuation_not_ready',
      );
    }
    const abort = new AbortController();
    session.active = { promptId, digest: '', abort };
    // The recovered Turn is now driven: session.active keeps /prompt refused
    // until the terminal record, after which the refusal no longer applies.
    session.recoveredTurn = undefined;
    session.admissions.set(promptId, {
      digest: recoveryDigest,
      lastEventId: session.managed.authority.committedSequence,
    });
    res.status(200).json({
      accepted: true,
      promptId,
      lastEventId: session.managed.authority.committedSequence,
      eventEpoch: epoch,
    });
    const sessionId = req.params['id'];
    void (async () => {
      let toolTurn: HostedWorkspaceToolTurn | undefined;
      let failureReason = 'error';
      const turnResultRecord = (state: 'cancelled' | 'error' | 'completed') =>
        record(session, sessionId, 'system', null, {
          subtype: 'turn_result',
          systemPayload: {
            promptId,
            state,
            stopReason:
              state === 'completed'
                ? 'end_turn'
                : state === 'error'
                  ? failureReason
                  : state,
            endedAt: Date.now(),
          },
        });
      try {
        const harness = createManagedHarnessHandle(session.managed);
        let projected = await session.managed.sink.project();
        const initialRawRecords =
          await session.managed.sink.projectModelRecords();
        let unanswered = unansweredPrompts(session, projected);
        let modelRecords = normalizeHostedTurnRecords(
          initialRawRecords,
          unanswered,
        );
        const settledPrompts = new Set(
          session.managed.authority
            .eventsInSequenceRange(
              1,
              session.managed.authority.committedSequence,
            )
            .filter((event) => event.kind === 'turn.settled')
            .map((event) => event.payload['turnId']),
        );
        // Split at the last assistant message carrying function calls: earlier
        // tool rounds stay in history, and only the parked round's results
        // become the resume request. Otherwise a turn that parked after two
        // tool rounds would resume with an unanswered call in between.
        const deriveRound = (unanswered: ReadonlySet<string>) => {
          const turnRecords = projected.filter(
            (entry) => entry.daemonPromptId === promptId,
          );
          let lastCallIndex = -1;
          for (const [index, entry] of turnRecords.entries()) {
            if (
              entry.type === 'assistant' &&
              entry.message?.parts?.some((part) => part.functionCall)
            ) {
              lastCallIndex = index;
            }
          }
          if (lastCallIndex < 0) {
            throw new Error(
              'Recovered Runtime turn has no journaled tool call.',
            );
          }
          const parkedRound = new Set(
            turnRecords.slice(lastCallIndex + 1).map((entry) => entry.uuid),
          );
          const history = modelRecords.filter(
            (entry) =>
              (entry.type === 'system' ||
                settledPrompts.has(entry.daemonPromptId) ||
                (entry.daemonPromptId === promptId &&
                  !parkedRound.has(entry.uuid))) &&
              !isExcludedHostedRecord(entry, unanswered),
          );
          const resumeParts = turnRecords
            .slice(lastCallIndex + 1)
            .filter((entry) => entry.type === 'tool_result')
            .flatMap((entry) => entry.message?.parts ?? []);
          return { history, resumeParts };
        };
        // An agent wait that never folded may legitimately hold no tool
        // result yet (#13708) — the fold itself produces it below, so the
        // no-results guard runs only after the resume arm has had its say.
        let { history, resumeParts } = deriveRound(unanswered);
        let parentUuid = projected.at(-1)?.uuid ?? null;
        const messageRecord = (
          type: 'assistant' | 'tool_result',
          parts: Part[],
          model: string,
          identity?: Pick<
            ChatRecord,
            'uuid' | 'timestamp' | 'clientInitiatedSkills'
          >,
        ) =>
          record(session, sessionId, type, parentUuid, {
            daemonPromptId: promptId,
            model,
            message: { role: type === 'assistant' ? 'model' : 'user', parts },
            ...identity,
          });
        const deltas = new HostedTextDeltaStream(session.managed, promptId);
        const commit = async (
          type: 'assistant' | 'tool_result',
          parts: Part[],
          model: string,
          identity?: Pick<
            ChatRecord,
            'uuid' | 'timestamp' | 'clientInitiatedSkills'
          >,
          diagnostics?: readonly ManagedInvocationObservation[],
        ) => {
          const message = messageRecord(type, parts, model, identity);
          if (type === 'assistant') {
            const streamed = deltas.takeMessageId();
            if (streamed !== undefined) message.uuid = streamed;
          }
          await session.managed.sink.write(message, diagnostics);
          parentUuid = message.uuid;
          return message.uuid;
        };
        const workspaceContext: HostedWorkspaceContextSlot = {
          read: () => session.workspaceContext,
          write: (context) => {
            session.workspaceContext = context;
          },
          invalidate: () => {
            session.workspaceContext = undefined;
          },
        };
        toolTurn = new HostedWorkspaceToolTurn(
          brokerOptions,
          session.managed,
          harness,
          promptId,
          commit,
          (type, parts, model) =>
            Buffer.byteLength(
              JSON.stringify(messageRecord(type, parts, model)),
            ) <= HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes,
          session.publication,
          session.shell,
          await hostedApprovalForTurn(session, promptId),
          {
            memory: session.memory,
            memoryOnly: !session.toolProfile,
            mcp: session.mcp,
            clientFiles: session.clientFiles,
            skills: session.skills,
            extensionConfig: session.extensionBundle
              ? {
                  revision: session.extensionBundle.configRevision,
                  packages: session.extensionBundle.packages,
                }
              : undefined,
            extensionAgents: extensionAgentsOf(session),
            allowedToolNames: session.extensionAgentTools,
            profile: session.toolProfile,
            foregroundOnly: session.foregroundOnly,
            context: workspaceContext,
            childRuns: session.childRuns,
            monitors: session.monitors,
            loops: session.loops,
            crons: session.crons,
            wakeKick: () => session.monitorWake?.kick(),
            backgroundLane: session.backgroundLane,
            childAgents: childAgentsOf(session),
            childDepth: session.childDepth,
            messages: session.messages,
            teams: session.teams,
            commands: session.commands,
            memberPlanMode: await ensureMemberPlanMode(session),
            publicPlanMode:
              (await readHostedTurnApprovalSelection(session.managed, promptId))
                ?.planMode === true,
          },
        );
        if (session.skills)
          toolTurn.setToolOutputBudget(hostedToolOutputBudget(session.cwd));
        let state: 'completed' | 'cancelled' | 'error' = 'completed';
        try {
          // The agent wait (#13708): fold every run the checkpoint still
          // owes, polling the relay ledger exactly as the live arm did, then
          // re-derive the round — the fold's own tool_result is what the
          // resume request carries.
          if (
            continueAuthorization.authorization.status === 'runnable' &&
            continueAuthorization.authorization.checkpoint.agentWait !== null
          ) {
            const outstanding =
              continueAuthorization.authorization.checkpoint.agentWait.runs.filter(
                (run) => !run.consumed,
              );
            if (outstanding.length > 0) {
              await toolTurn.resumeAgentWaitRuns(
                outstanding,
                'recovered',
                abort.signal,
              );
            } else {
              // The carried all-consumed shape: the takeover owes the
              // Turn's identity to the next Turn-bound commit — restate
              // the last resolve so this handle adopts it; without it the
              // model's next Runtime batch dies as prior-activation work
              // (R2-1). The model round must never start before the
              // adoption is durable: the resolve's own read faults surface
              // as a retriable block, and an inapplicable answer is a
              // defect, never a round start (R2-9).
              const lastRun =
                continueAuthorization.authorization.checkpoint.agentWait.runs.at(
                  -1,
                );
              if (lastRun !== undefined) {
                let adopted;
                try {
                  adopted = await harness.resolveAwaitAgent(lastRun.childRunId);
                } catch (cause) {
                  throw new HostedToolRecoveryRequiredError(cause);
                }
                if (adopted === null)
                  throw new Error(
                    'Recovered agent wait did not adopt the takeover activation.',
                  );
              }
            }
            // Outstanding or not: a crash past the last fold (the carried
            // all-consumed group) can strand sibling calls the dead loop
            // never reached — each of them still owes its model a response,
            // so the resume story answers them with the never-admitted fold.
            // The fill is replay-safe: journaled ids are skipped. The
            // answer names the interruption — nothing was cancelled here.
            const filled = await fillParkedRoundAgentGaps({
              managed: session.managed,
              sessionId,
              promptId,
              cwd: session.cwd,
              gapText: HOSTED_AGENT_CALL_NOT_REACHED_TEXT,
              children: session.childAgents,
              messages: session.messages,
              skills: session.skills,
              hooks: session.hooks,
              signal: abort.signal,
              consume: (childRunId) => session.childConsumption.add(childRunId),
            });
            if (outstanding.length > 0 || filled > 0) {
              projected = await session.managed.sink.project();
              const rawRecords =
                await session.managed.sink.projectModelRecords();
              unanswered = unansweredPrompts(session, projected);
              modelRecords = normalizeHostedTurnRecords(rawRecords, unanswered);
              ({ history, resumeParts } = deriveRound(unanswered));
            }
          }
          // H4e-b3: the command wait resumes exactly like the agent wait —
          // re-enter each outstanding run's poll with what is left of its
          // bound, then the round's never-reached calls pair off.
          if (
            continueAuthorization.authorization.status === 'runnable' &&
            continueAuthorization.authorization.checkpoint.commandWait !== null
          ) {
            const commandWait =
              continueAuthorization.authorization.checkpoint.commandWait;
            if (session.commands === undefined)
              throw new Error('Command wait checkpoint has no command funnel.');
            const outstanding = commandWait.runs.filter((run) => !run.folded);
            if (outstanding.length > 0) {
              await toolTurn.resumeCommandWaitRuns(
                outstanding,
                commandWait.holdsWorkspaceMount,
                'recovered',
                abort.signal,
              );
            } else {
              // The carried all-folded shape: restate the last resolve so
              // this handle adopts the takeover activation.
              const lastRun = commandWait.runs.at(-1);
              if (lastRun !== undefined) {
                let adopted;
                try {
                  adopted = await harness.resolveAwaitCommand(
                    lastRun.commandId,
                  );
                } catch (cause) {
                  throw new HostedToolRecoveryRequiredError(cause);
                }
                if (adopted === null)
                  throw new Error(
                    'Recovered command wait did not adopt the takeover activation.',
                  );
              }
            }
            const filled = await fillParkedRoundCommandGaps({
              managed: session.managed,
              sessionId,
              promptId,
              cwd: session.cwd,
              gapText: HOSTED_AGENT_CALL_NOT_REACHED_TEXT,
              commands: session.commands,
              children: session.childAgents,
              messages: session.messages,
              signal: abort.signal,
            });
            if (outstanding.length > 0 || filled > 0) {
              projected = await session.managed.sink.project();
              const rawRecords =
                await session.managed.sink.projectModelRecords();
              unanswered = unansweredPrompts(session, projected);
              modelRecords = normalizeHostedTurnRecords(rawRecords, unanswered);
              ({ history, resumeParts } = deriveRound(unanswered));
            }
          }
          // A sibling the Runtime reconciliation does not own (a team
          // call, a background launch) is answered before the resumed round
          // reads it: by what committed when it committed before the
          // Harness died — core's orphan repair would have the model retry
          // it, and the retry redoes the work — and as never run otherwise,
          // or the pending file history's check refuses the resume.
          const answered = await answerResumedTurnCalls({
            session: session.managed,
            sessionId,
            cwd: session.cwd,
            promptId,
            skills: session.skills,
            hooks: session.hooks,
            children: session.childAgents,
            teams: session.teams,
            messages: session.messages,
            commands: session.commands,
          });
          if (answered > 0) {
            projected = await session.managed.sink.project();
            const rawRecords = await session.managed.sink.projectModelRecords();
            unanswered = unansweredPrompts(session, projected);
            modelRecords = normalizeHostedTurnRecords(rawRecords, unanswered);
            ({ history, resumeParts } = deriveRound(unanswered));
          }
          if (resumeParts.length === 0) {
            throw new Error(
              'Recovered Runtime turn has no journaled tool results.',
            );
          }
          if (
            continueAuthorization.authorization.status === 'runnable' &&
            (continueAuthorization.authorization.checkpoint.agentWait !==
              null ||
              (continueAuthorization.authorization.checkpoint.commandWait !==
                null &&
                !continueAuthorization.authorization.checkpoint.commandWait
                  .holdsWorkspaceMount))
          ) {
            // An agent-wait resume has no Runtime results to consume and
            // must NOT claim the Workspace mount in advance of any tool
            // work: the unconditional acquire would make the parent refuse
            // its own later foreground agent call (R2-3). A command wait is
            // the same unless its Turn held the mount, which its resume arm
            // took back already: a member shares its lead's Workspace, and
            // a mount it never held is not its to claim. The pending
            // file-history obligation dies with the Turn the terminal
            // record will close, exactly like the interrupted settle.
            const savedHistory = await readHostedFileHistory(session.managed);
            if (savedHistory?.pendingTurn === promptId) {
              await commitHostedFileHistory(session.managed, {
                schemaVersion: 1,
                state: savedHistory.state,
                pendingTurn: null,
                pendingUndo: null,
              });
            }
          } else {
            // Reconcile the pending file-history obligation the recovered
            // turn left behind before inference — a text-only continuation
            // never re-acquires, so without this the marker outlives the
            // turn and wedges every later cold load.
            try {
              await toolTurn.resumeCommittedResults(abort.signal);
            } catch (cause) {
              // A retryable Workspace acquisition refusal escapes
              // resumeCommittedResults() raw (acquire() rethrows it as-is).
              // This Turn's checkpoint still holds unconsumed Runtime
              // receipts, so settling it terminally would strand them forever
              // — classify it into the outer recovery-blocked handler, which
              // leaves the Turn re-drivable by a later takeover. Any other
              // raw escape (a transient warmup failure, …) still settles
              // terminally below: the 200 is already sent and no
              // blocked-on-recovery re-drive exists on this route for it.
              // Only a recovery-classified error keeps the outer
              // recovery-blocked handling, and a Turn settling here also
              // drops its pending file-history marker, since it never resumes
              // to reconcile it.
              if (isRetryableWorkspaceAcquisition(cause))
                throw new HostedToolRecoveryRequiredError(cause);
              throw cause;
            }
          }
          const result = await runHostedHarnessTextTurn({
            sessionId,
            cwd,
            history,
            excludedPromptIds: unansweredPrompts(session, projected),
            classifierUserText: () => readHostedClassifierUserText(session),
            setLoopClassifier: (classify) => {
              session.loopClassify = classify;
            },
            commitCompression: async (payload) => {
              await session.managed.sink.write(
                record(session, sessionId, 'system', null, {
                  subtype: 'chat_compression',
                  systemPayload: payload,
                }),
              );
              // A compaction is fresh context: the next loop fire must
              // re-deliver the full guidance, not a dangling reminder.
              session.loops?.resetResolverCache();
            },
            prompt: '',
            promptId,
            memory: session.memory,
            ...(session.stores
              ? {
                  userMessages: {
                    claim: async () =>
                      (await session.stores!.claimUserMessages(promptId)).map(
                        (message) => ({
                          id: `${message.id}:${message.revision}`,
                          ...parseHostedInput(message.input),
                        }),
                      ),
                    commit: async (id: string, parts: Part[]) => {
                      const message = record(
                        session,
                        sessionId,
                        'user',
                        parentUuid,
                        {
                          uuid: id,
                          daemonPromptId: promptId,
                          subtype: 'mid_turn_user_message',
                          message: { role: 'user', parts },
                        },
                      );
                      await session.managed.sink.write(message);
                      parentUuid = message.uuid;
                    },
                    commitAssistant: async (parts: Part[], model: string) => {
                      await commit('assistant', parts, model);
                    },
                  },
                }
              : {}),
            signal: abort.signal,
            workspaceContext,
            agentDefinition: session.agentDefinition,
            modelConfig: session.modelConfig,
            publicChildModelRoute: session.publicChildModelRoute,
            modelSelection: await readHostedTurnModelSelection(
              session.managed,
              promptId,
            ),
            extensionInstructions: session.extensionContext,
            agentInstructions: await readHostedAgentInstructions(
              session.agentDefinition,
              session.managed.resources,
            ),
            skills: session.skills,
            toolTurn,
            resumeFromToolResults: resumeParts,
            textDeltas: deltas,
          });
          await commit(
            'assistant',
            result.parts ?? [{ text: result.text }],
            result.model,
          );
        } catch (cause) {
          if (cause instanceof HostedToolRecoveryRequiredError) throw cause;
          state = abort.signal.aborted ? 'cancelled' : 'error';
          if (
            state === 'error' &&
            cause instanceof HostedImageInputUnsupportedError
          )
            failureReason = 'image_input_unsupported';
          if (state === 'error' && cause instanceof HostedModelUnavailableError)
            failureReason = 'model_unavailable';
          if (state === 'error' && cause instanceof HostedModelApiError)
            failureReason = cause.code;
          if (state === 'error') {
            const storeFailure = namedStoreFailure(cause);
            if (storeFailure !== undefined) failureReason = storeFailure;
            writeStderrLineSafe(
              `qwen serve: Hosted Harness turn ${promptId} failed: ${describeManagedError(cause)}`,
            );
          }
        }
        await toolTurn.finish();
        // #13856: same hold bookkeeping as the prompt route — the close
        // owes a drain for every Runtime a turn left held.
        if (toolTurn.runtimeHeld) session.heldRuntimeTurns.add(promptId);
        await harness.settleConsumedRuntimeContinuation();
        // An interrupted drive can leave a call it committed — a team
        // write, a background launch — without its answer: the fold owes
        // it before the terminal record, or the durable settle strands
        // the orphan and the next history's orphan repair retries the work
        // under a new key. A fold refusal must not settle over unanswered
        // calls, so the Turn stays re-drivable instead.
        if (state !== 'completed') {
          try {
            await answerRecoveredTurnCommittedCalls(
              session,
              sessionId,
              promptId,
            );
          } catch (foldCause) {
            // A fold exit names its block the way the settlement exits do
            // (#13800 R2-15): a model stage that met the store keeps its
            // name — the write latch it armed leaves the fold only
            // ManagedSessionWritesStoppedError — and otherwise the fold's
            // own cause decides.
            blockRecovery(
              session,
              failureReason === 'managed_session_store_unavailable'
                ? failureReason
                : namedStoreFailure(foldCause),
            );
            writeStderrLineSafe(
              `qwen serve: Hosted Harness turn ${promptId} could not answer its committed calls: ${String(foldCause)}`,
            );
            return;
          }
        }
        await session.managed.sink.write(turnResultRecord(state));
        // A Turn that never resumes never reconciles its pending file
        // history either: retire the obligation after the terminal record
        // landed, and owe it to the next settled /prompt or close when the
        // retirement itself fails — completing here cannot be recorded as
        // an error, and a marker owed by a settled Turn must still
        // retire eventually, or every later cold load is refused.
        if (state !== 'completed') {
          try {
            await dropPendingHostedFileHistoryTurn(session.managed, promptId);
          } catch (cause) {
            session.fileHistoryOwed = promptId;
            writeStderrLineSafe(
              `qwen serve: Hosted Harness file-history retirement of settled Turn ${promptId} failed; it stays owed: ${String(cause)}`,
            );
          }
        }
        // H4b: a redriven turn that consumed child-agent tool results owes
        // the same consumption flush as executeHostedTurn — without it the
        // parent's run settles while its commits never land.
        if (
          state === 'completed' &&
          session.childAgents &&
          session.childConsumption.size > 0
        ) {
          // The settlement above is already durable: a rejected consume
          // commit must not turn this completed turn into a reported
          // failure. The failing id — and every id after it — stays owed
          // for the next completed turn or recovery.
          try {
            const consumed = [...session.childConsumption].sort();
            for (const childRunId of consumed) {
              await session.childAgents.markConsumed(childRunId);
              session.childConsumption.delete(childRunId);
            }
          } catch (cause) {
            writeStderrLineSafe(
              'qwen serve: Hosted acceptance consumption faltered (owed ids kept): ' +
                String(cause),
            );
          }
        }
      } catch (cause) {
        if (cause instanceof HostedToolRecoveryRequiredError) {
          if (cause instanceof HostedChildLedgerRecoveryRequiredError) {
            session.recoveryCancelPromptId = promptId;
            session.blocked = true;
          } else {
            session.recoveryCancelPromptId = undefined;
            blockOnTurnRecovery(session, promptId, cause);
          }
          // A new recovery must drive the parked Turn, even at the same checkpoint.
          if (
            session.recoveryCancelPromptId === promptId ||
            session.runtimeRecoveryPromptId === promptId
          )
            session.admissions.delete(promptId);
          writeStderrLineSafe(
            `qwen serve: Hosted Harness turn ${promptId} is recovery blocked: ${String(cause.cause)}`,
          );
          return;
        }
        // The terminal write (and toolTurn.finish() / the continuation
        // consumption flush) sits outside the model-stage catch above: a
        // store failure thrown from them lands here with failureReason
        // still at its 'error' initial value. Classify the original cause
        // once so the fallback record and the status surface keep the name
        // (#13800 P2). It runs ahead of the fold below, so a fold exit
        // names its block too (#13800 R2-15).
        // An already-named failure (a model-route one) keeps its name: only
        // the generic value is reclassified, as executeHostedTurn does.
        const storeFailure = namedStoreFailure(cause);
        if (storeFailure !== undefined && failureReason === 'error')
          failureReason = storeFailure;
        // A block this arm leaves is named by whichever of the turn, its
        // outer cause or the failing write met the store (#13800).
        const blockStoreFailure = (blockCause: unknown) =>
          failureReason === 'managed_session_store_unavailable'
            ? failureReason
            : (storeFailure ?? namedStoreFailure(blockCause));
        // The happy-path settle answers the drive's committed sibling calls
        // before the terminal record; this compensating arm owes the same
        // fold, or the durable settle strands a committed team/task call
        // nobody ever answers. The fold gets its own try: a fold refusal is
        // not an ambiguous terminal-write failure — the Turn stays
        // re-drivable rather than settling over unanswered calls.
        try {
          await answerRecoveredTurnCommittedCalls(session, sessionId, promptId);
        } catch (foldCause) {
          blockRecovery(session, blockStoreFailure(foldCause));
          writeStderrLineSafe(
            `qwen serve: Hosted Harness turn ${promptId} could not answer its committed calls: ${String(foldCause)}`,
          );
          return;
        }
        try {
          await session.managed.sink.write(turnResultRecord('error'));
          // The direct settle above retired the pending file-history marker
          // after its terminal record; the compensating path settles the
          // same deadline, so it retires the marker the same way.
          try {
            await dropPendingHostedFileHistoryTurn(session.managed, promptId);
          } catch (dropCause) {
            session.fileHistoryOwed = promptId;
            writeStderrLineSafe(
              `qwen serve: Hosted Harness file-history retirement of settled Turn ${promptId} failed; it stays owed: ${String(dropCause)}`,
            );
          }
        } catch (settleCause) {
          // The fallback terminal write couldn't commit either: keep the
          // named store failure for the status surface (#13800), whichever
          // of the turn, its outer cause or the settlement met the store.
          blockRecovery(session, blockStoreFailure(settleCause));
          writeStderrLineSafe(
            `qwen serve: Hosted Harness turn ${promptId} could not settle: ${String(settleCause)}`,
          );
        }
      } finally {
        // Clear availability before the unbounded publisher drain, per the
        // discipline in executeHostedTurn. A recovery-blocked exit keeps the
        // adopted lease held: the parked Turn still owns it, and a release
        // would persist RELEASED, wedging the later takeover's same-identity
        // re-acquire on runtime_session_not_acquirable. Every arm that parks
        // the re-drive blocked hands its Workspace mount back here, the way
        // the prompt route's turn does (#13800).
        if (!session.blocked) releaseRecoveredRuntime(session);
        else await toolTurn?.releaseForRecoveryBlock();
        session.active = undefined;
        noteSessionActivity(session);
        void toolTurn?.close().catch((cause: unknown) => {
          session.runtimeRecoveryPromptId = undefined;
          session.blocked = true;
          writeStderrLineSafe(
            `qwen serve: Hosted Shell publisher cleanup failed: ${String(cause)}`,
          );
        });
      }
    })();
  });

  app.post('/session/:id/managed-runtime/cancel', async (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (session.mcpClosing) return error(res, 409, 'hosted_session_closing');
    if (session.mcpBusy || session.mcpRecovering)
      return error(res, 409, 'hosted_mcp_operation_active');
    if (session.hooks) return error(res, 409, 'hosted_hook_recovery_required');
    const request = recoveryRequest(req);
    if (!request) return error(res, 400, 'invalid_managed_runtime_recovery');
    const { promptId, checkpointId, activationId } = request;
    if (session.blocked && session.recoveryCancelPromptId !== promptId) {
      // A retry-inviting refusal: keep an adopted lease owed with the
      // still-READY identity — the next takeover re-acquires it
      // idempotently, while a release would persist RELEASED and wedge
      // every retry with runtime_session_not_acquirable.
      return error(
        res,
        409,
        'hosted_turn_recovery_required',
        hostedTurnBusyReason(session),
      );
    }
    // A cancellation whose reply was lost is replayed by the coordinator: it
    // must get the watermark it was admitted at, running or settled — the
    // same contract the continue route documents.
    const recoveryDigest = `recovery:${checkpointId}:${activationId}`;
    const admittedCancel = session.admissions.get(promptId);
    if (admittedCancel?.digest === recoveryDigest) {
      await stopPublicChildSource(session, promptId);
      if (!session.active && session.runtimeLeaseHeld?.promptId === promptId)
        releaseRecoveredRuntime(session);
      res.status(200).json({
        accepted: true,
        promptId,
        lastEventId: admittedCancel.lastEventId,
        eventEpoch: epoch,
      });
      return;
    }
    if (session.active) return error(res, 409, 'hosted_turn_active');
    // A redriven cancellation carries its load-time identity, but the
    // checkpoint may legitimately have advanced underneath: an earlier
    // attempt settled the executions and then failed before the terminal
    // record. The coordinator never re-loads an attached Session, so the
    // fence is the activation plus the unsettled Turn — admit those against
    // the current checkpoint instead of refusing the only retry there is.
    const attachedToUnsettled =
      session.managed.activation.activationId === activationId &&
      unsettledPromptId(session) === promptId;
    if (!attachedToUnsettled) {
      if (
        hasAcceptedInput(session, promptId) &&
        !unsettledInputs(session).has(promptId)
      ) {
        await stopPublicChildSource(session, promptId);
        if (settledReplay(session, promptId, res)) {
          if (session.runtimeLeaseHeld?.promptId === promptId)
            releaseRecoveredRuntime(session);
          return;
        }
      }
      // A foreign-epoch cancel against a stranger's or settled Turn is not a
      // teardown: keep the lease owed and re-acquirable — the same owed
      // discipline as the refusals above. Only a genuinely settled replay
      // hands it back.
      return error(res, 409, 'hosted_recovery_identity_mismatch');
    }
    const sessionId = req.params['id'];
    // Symmetric with the continue route: without the tool profile or the
    // Broker there is no way to prove the parked executions stopped.
    if (!session.toolProfile || !brokerOptions) {
      return error(
        res,
        409,
        'hosted_turn_recovery_required',
        'recovery_unsupported',
      );
    }
    // A checkpoint whose authorization is no longer readable cannot prove
    // its parked executions; refuse like the load path instead of settling
    // a cancellation nothing verified. That read failure is not a
    // `not_runnable` state, so it is named separately and logged.
    const cancelAuthorization = await session.managed.authority
      .harnessRunAuthorization()
      .then(
        (authorization) => ({ ok: true as const, authorization }),
        (cause) => ({ ok: false as const, cause }),
      );
    if (identity(req, sessions) !== session)
      return error(res, 404, 'hosted_session_not_found');
    if (session.mcpClosing) return error(res, 409, 'hosted_session_closing');
    if (session.mcpBusy || session.mcpRecovering)
      return error(res, 409, 'hosted_mcp_operation_active');
    if (session.active) return error(res, 409, 'hosted_turn_active');
    if (!cancelAuthorization.ok) {
      writeStderrLineSafe(
        `qwen serve: Hosted Session ${sessionId} cancel: run authorization could not be read: ${sanitizeDaemonLogLine(String(cancelAuthorization.cause))}`,
      );
      // Retry-inviting refusal: keep the adopted lease owed (see the
      // blocked refusal above).
      return error(
        res,
        409,
        'hosted_turn_recovery_required',
        'authorization_unreadable',
      );
    }
    if (cancelAuthorization.authorization.status !== 'runnable') {
      const unusable = cancelAuthorization.authorization;
      writeStderrLineSafe(
        `qwen serve: Hosted Session ${sessionId} cancel: run authorization not runnable: ${harnessAuthorizationDetail(unusable)}`,
      );
      // Retry-inviting refusal: keep the adopted lease owed (see the
      // blocked refusal above).
      return error(res, 409, 'hosted_turn_recovery_required', 'not_runnable');
    }
    // The async arm is a closure: property narrowing on
    // cancelAuthorization.authorization does not reach it, so pin the
    // runnable authorization the guards above established.
    const cancelRunnable = cancelAuthorization.authorization;
    await stopPublicChildSource(session, promptId);
    // The child fence yields; another recovery may have claimed or settled it.
    if (identity(req, sessions) !== session)
      return error(res, 404, 'hosted_session_not_found');
    if (session.mcpClosing) return error(res, 409, 'hosted_session_closing');
    if (session.mcpBusy || session.mcpRecovering)
      return error(res, 409, 'hosted_mcp_operation_active');
    if (session.blocked && session.recoveryCancelPromptId !== promptId)
      return error(
        res,
        409,
        'hosted_turn_recovery_required',
        hostedTurnBusyReason(session),
      );
    const concurrentCancel = session.admissions.get(promptId);
    if (concurrentCancel?.digest === recoveryDigest) {
      if (!session.active && session.runtimeLeaseHeld?.promptId === promptId)
        releaseRecoveredRuntime(session);
      res.status(200).json({
        accepted: true,
        promptId,
        lastEventId: concurrentCancel.lastEventId,
        eventEpoch: epoch,
      });
      return;
    }
    if (session.active) return error(res, 409, 'hosted_turn_active');
    if (unsettledPromptId(session) !== promptId) {
      if (settledReplay(session, promptId, res)) {
        if (session.runtimeLeaseHeld?.promptId === promptId)
          releaseRecoveredRuntime(session);
        return;
      }
      return error(res, 409, 'hosted_recovery_identity_mismatch');
    }
    if (
      session.managed.activation.activationId !== activationId ||
      session.managed.authority.latestCheckpoint?.checkpointId !==
        cancelRunnable.checkpoint.identity.checkpointId
    )
      return error(res, 409, 'hosted_recovery_identity_mismatch');
    session.admissions.set(promptId, {
      digest: recoveryDigest,
      lastEventId: session.managed.authority.committedSequence,
    });
    // There is no snapshot to consume anymore: the re-answer recomputes
    // from the attached state, so nothing in the admission can damage a
    // later redrive (D6).
    session.active = { promptId, digest: '', abort: new AbortController() };
    void (async () => {
      // The checkpoint moved the moment the parked executions journaled
      // cancelled, so a failure anywhere after that point can no longer be
      // re-driven against the same recovery identity — the failure handling
      // below keys on it, not on the failing step.
      let settledDurable = false;
      // Executions the stop accepted on the Broker's terminal fence alone:
      // their journal entry must stay honest (no stop was observed), on the
      // first settle and on a compensating retry alike.
      let unobserved: ReadonlySet<string> | undefined;
      let broker: HostedWorkspaceBroker | undefined;
      try {
        // The phase-shape invariants decide the two settlement shapes
        // outright (R1-51): the agent wait's park names outstanding runs
        // to fold, the carried all-consumed shape names none — either way
        // the round pairs off — while no group means the Runtime park.
        const agentWait = cancelRunnable.checkpoint.agentWait;
        const commandWait = cancelRunnable.checkpoint.commandWait;
        if (commandWait !== null) {
          // H4e-b3's own mirror of the agent-wait cancellation: the
          // outstanding command runs answer by what their journal
          // committed (decision 14), the resolve moves the checkpoint
          // past the wait, and the round's never-reached calls pair off
          // from the same journal — no Broker binding ever exists to stop.
          if (session.commands === undefined) {
            void (async () => {
              session.active = undefined;
              noteSessionActivity(session);
              throw new Error('Command wait checkpoint has no command funnel.');
            })();
          } else {
            const outstanding = commandWait.runs.filter((run) => !run.folded);
            if (outstanding.length > 0) {
              await settleCancelledCommandWaitRuns({
                managed: session.managed,
                sessionId,
                promptId,
                cwd: session.cwd,
                runs: outstanding,
                commands: session.commands,
              });
            }
            const cancelCommandFillAbort = new AbortController();
            cancelCommandFillAbort.abort();
            await fillParkedRoundCommandGaps({
              managed: session.managed,
              sessionId,
              promptId,
              cwd: session.cwd,
              gapText: HOSTED_AGENT_CALL_NOT_ADMITTED_TEXT,
              commands: session.commands,
              children: session.childAgents,
              messages: session.messages,
              signal: cancelCommandFillAbort.signal,
            });
          }
        } else if (agentWait !== null) {
          // The agent wait (#13708): no Runtime executions exist to stop or
          // settle — each outstanding run is folded as the abandoned answer
          // the live arm itself would have written, and the resolve moves
          // the checkpoint past the wait so the terminal record can land.
          const outstanding = agentWait.runs.filter((run) => !run.consumed);
          if (outstanding.length > 0) {
            await settleCancelledAgentWaitRuns({
              managed: session.managed,
              sessionId,
              promptId,
              cwd: session.cwd,
              runs: outstanding,
            });
          }
          // Outstanding or not: the round's never-reached calls pair off
          // the same way the Runtime family's cancellation settles its
          // pending items — no unpaired functionCall survives into a later
          // Turn's history. A crash past the last fold can strand sibling
          // calls the all-consumed group no longer names. A cancelled
          // takeover never waits on an admitted foreground orphan either:
          // the abandoned-wait fold is the live arm's own answer for an
          // aborted wait — pre-aborting here settles at once while the
          // child keeps its ledger, instead of holding the cancel (and its
          // HTTP reply) hostage to the orphan's terminal (R2-2).
          const cancelFillAbort = new AbortController();
          cancelFillAbort.abort();
          await fillParkedRoundAgentGaps({
            managed: session.managed,
            sessionId,
            promptId,
            cwd: session.cwd,
            gapText: HOSTED_AGENT_CALL_NOT_ADMITTED_TEXT,
            children: session.childAgents,
            messages: session.messages,
            signal: cancelFillAbort.signal,
            consume: (childRunId) => session.childConsumption.add(childRunId),
          });
        } else {
          // A retried cancel recomputes the stop from Broker state, but a
          // record reclaimed between attempts then certifies as
          // already-stopped. Accumulate the unobserved ids on the Session so
          // the retry cannot downgrade them to a witnessed stop — including
          // the ids a stop counted before throwing, which its return value
          // would have discarded.
          const carried = new Set(session.recoveryUnobserved?.get(promptId));
          let stopped: Awaited<ReturnType<typeof stopParkedRuntimeExecutions>>;
          try {
            stopped = await stopParkedRuntimeExecutions({
              session: session.managed,
              promptId,
              brokerOptions,
              carryUnobservedInto: carried,
            });
          } finally {
            persistRecoveryUnobserved(session, promptId, carried);
          }
          broker = stopped.broker;
          unobserved = carried;
          // Settle the parked executions as cancelled so the terminal record
          // can move the checkpoint past the durable wait instead of wedging
          // the session on its next prompt.
          const settleFromCheckpointId =
            session.managed.authority.latestCheckpoint?.checkpointId;
          try {
            const settleOutcome = await settleParkedTurnCancelled({
              session: session.managed,
              sessionId,
              cwd: session.cwd,
              promptId,
              unobserved,
              broker,
              shell: session.shell,
            });
            if (settleOutcome === 'not-runnable')
              throw new Error(
                'Cancelled settle cannot verify the park (authorization not runnable).',
              );
            // A resolved settle is not proof by itself: only a settle that
            // journaled — or a noop whose recovery identity already moved —
            // may license the terminal record below.
            settledDurable =
              settleOutcome === 'settled' ||
              !matchesRecovery(
                session,
                promptId,
                settleFromCheckpointId,
                activationId,
              );
          } catch (cause) {
            // The checkpoint moves inside the settle, one resolveAwaitRuntime
            // at a time: a partially applied settle no longer reads like the
            // identity this drive started from, and only that read — never the
            // request's load-time checkpointId, which the admission fence
            // deliberately admitted possibly stale — can tell a re-drivable
            // miss from an irrevocable movement.
            settledDurable = !matchesRecovery(
              session,
              promptId,
              settleFromCheckpointId,
              activationId,
            );
            throw cause;
          }
        }
        // A Runtime park's non-Runtime siblings (a team call, a background
        // launch) that committed before the Harness died are answered by
        // what committed; the settlements above answer only what they own.
        await answerRecoveredTurnCommittedCalls(session, sessionId, promptId);
        // Whatever shape the wait was in, its round is fully answered now:
        // the folds above landed (or the journaled proof they were never
        // owed), so only the terminal record below settles the Turn.
        // The cancelled Turn never continues, so its pending file-history
        // obligation dies with it — keep the snapshots, drop the marker, or
        // every later load stays refused.
        await dropPendingHostedFileHistoryTurn(session.managed, promptId);
        await session.managed.sink.write(
          record(session, sessionId, 'system', null, {
            subtype: 'turn_result',
            systemPayload: {
              promptId,
              state: 'cancelled',
              stopReason: 'cancelled',
              endedAt: Date.now(),
            },
          }),
        );
        // The recovered Turn settled, so /prompt stops refusing the Session.
        // The refusal stays armed on the retryable failure path, where the
        // coordinator's retry re-drives the same Turn.
        session.recoveredTurn = undefined;
        session.recoveryUnobserved?.delete(promptId);
        // The original owner's Runtime Session keeps the Workspace lease
        // pinned; the passive takeover adopted it on load. Release only
        // after the terminal record is durable: the release persists
        // RELEASED (a same-identity re-acquire then conflicts forever), so a
        // failure between release and settle would wedge the Turn without a
        // retry, while a stranded READY lease is re-acquired idempotently.
        // It must also stay after the stop loop: the Broker refuses with
        // runtime_session_busy while an execution is active. An agent wait
        // never held one — its recovery acquires nothing (acquiredRuntime
        // false), so there is no lease to hand back here.
        const releaseBroker = broker;
        const handedBack =
          releaseBroker === undefined ||
          (session.mcp &&
            releaseBroker.runtimeSessionId !== hostedRuntimeSessionId(promptId))
            ? false
            : await releaseBroker.release().then(
                () => true,
                (cause: unknown) => {
                  if (releaseIsSatisfied(cause)) return true;
                  // The Turn is already durable, so a handback failure must
                  // not refuse an answered cancellation. Leave the lease
                  // owed; later replays and the session close retry it.
                  writeStderrLineSafe(
                    `qwen serve: Hosted Harness release of recovered Runtime ${releaseBroker.runtimeSessionId} failed after the cancellation settled: ${String(cause)}`,
                  );
                  return false;
                },
              );
        if (handedBack) {
          // The release discharged the lease the load adopted, or it never
          // existed; the teardown skips what is now a redundant handback.
          session.runtimeLeaseHeld = undefined;
          session.runtimeLeaseOwedByTerminalRoute = false;
        } else if (broker !== undefined) {
          // Owed under the identity whose release just failed: the next
          // settled /prompt, a cancel replay, or close hands it back on the
          // same key.
          session.runtimeLeaseHeld = {
            promptId,
            runtimeSessionId: broker.runtimeSessionId,
          };
          session.runtimeLeaseOwedByTerminalRoute = true;
        }
        // Answer at the admission watermark: the cancelled turn_result
        // streams in from there, and a replayed cancel replays it exactly.
        res.status(200).json({
          accepted: true,
          promptId,
          lastEventId: session.admissions.get(promptId)!.lastEventId,
          eventEpoch: epoch,
        });
      } catch (cause) {
        writeStderrLineSafe(
          `qwen serve: Hosted Harness turn ${promptId} could not settle the cancellation: ${String(cause)}`,
        );
        if (settledDurable) {
          // The checkpoint already moved — on a clean settle or already
          // inside it, one resolveAwaitRuntime at a time — so no re-drive
          // can ever match the recovery identity again. Finish the settle
          // idempotently first (the journaled set journals nothing twice),
          // because the terminal record must not land while a parked
          // execution still lacks its functionResponse. With the record
          // landed, the admission stays replayable at its own watermark.
          const completed = await settleParkedTurnCancelled({
            session: session.managed,
            sessionId,
            cwd: session.cwd,
            promptId,
            unobserved,
            broker,
            shell: session.shell,
          }).then(
            // A noop is completion here — the identity already moved past
            // this settle — but a not-runnable read proves nothing, so it
            // keeps the retry re-drivable like a thrown failure does.
            (outcome) => outcome !== 'not-runnable',
            () => false,
          );
          if (!completed) {
            // Still re-drivable: the settle is idempotent, so drop the
            // admission and let the coordinator's retry fall through to the
            // attached-to-unsettled drive and re-run it — a permanent block
            // would refuse the one retry that can finish the settle. The
            // armed marker keeps the failure visible to a status poll, and
            // a genuinely unfinishable settle keeps answering 503 to every
            // retried cancel.
            session.admissions.delete(promptId);
          } else {
            let landed = false;
            try {
              // The happy path runs the sibling-answer fold between the
              // settle and the terminal record; the compensating path owes
              // it too — the kept admission replays a retried cancel
              // without re-driving, so a call left unpaired here would
              // stay unpaired forever.
              await answerRecoveredTurnCommittedCalls(
                session,
                sessionId,
                promptId,
              );
              await session.managed.sink.write(
                record(session, sessionId, 'system', null, {
                  subtype: 'turn_result',
                  systemPayload: {
                    promptId,
                    state: 'cancelled',
                    stopReason: 'cancelled',
                    endedAt: Date.now(),
                  },
                }),
              );
              landed = true;
            } catch (writeCause) {
              writeStderrLineSafe(
                `qwen serve: Hosted Harness turn ${promptId} settled the cancellation but its terminal record was refused: ${String(writeCause)}`,
              );
            }
            if (landed) {
              // Only a durably settled Turn's marker may be owed to the
              // settled-/prompt or close retry: owing an unsettled Turn's
              // marker would let close retire the very record a later
              // takeover needs to reconcile the resume.
              session.fileHistoryOwed = promptId;
              session.recoveredTurn = undefined;
              session.recoveryUnobserved?.delete(promptId);
            } else {
              session.admissions.delete(promptId);
              // The rejected write is ambiguous: it may have committed and
              // only lost its acknowledgement. A committed turn.settled
              // means no attached-to-unsettled retry can ever match again
              // and the settled replay answers every retry from the
              // watermark without clearing anything, so treat it like the
              // landed path — owe the settled Turn's marker and disarm — or
              // the Session wedges forever on a record that exists.
              // Without the event the Turn still reads unsettled, so the
              // failure stays as re-drivable as the nothing-moved path
              // below: the coordinator's retry re-runs the idempotent
              // settle and re-attempts the record, while the armed recovery
              // marker keeps refusing a fresh prompt meanwhile.
              const settledRecordLanded = session.managed.authority
                .eventsInSequenceRange(
                  1,
                  session.managed.authority.committedSequence,
                )
                .some(
                  (event) =>
                    event.kind === 'turn.settled' &&
                    event.payload['turnId'] === promptId,
                );
              if (settledRecordLanded) {
                session.fileHistoryOwed = promptId;
                session.recoveredTurn = undefined;
                session.recoveryUnobserved?.delete(promptId);
              }
            }
          }
        } else {
          // The terminal write may have committed and only lost its
          // acknowledgement — a settle that answers noop over a prior
          // attempt's committed record reaches the write with settledDurable
          // false. Disambiguate exactly like the sibling branch above: a
          // committed turn.settled means no attached-to-unsettled retry can
          // ever match again and the settled replay answers every retry
          // from the watermark, so disarm the marker and keep the admission
          // — deleting it would wedge the Session on a record that exists.
          // The file-history half is not owed here: the drop ahead of the
          // write already ran. Without the event nothing durable moved, so
          // the failure is fully re-drivable — whether or not a replay
          // already answered 200 while this drive ran: the first request
          // still gets this retry-inviting 503, and the coordinator's retry
          // must fall through the replay branch to the attached-to-unsettled
          // drive instead of meeting a permanent block. The armed recovery
          // marker keeps the failure visible to a status poll in the
          // meantime.
          const settledRecordLanded = session.managed.authority
            .eventsInSequenceRange(
              1,
              session.managed.authority.committedSequence,
            )
            .some(
              (event) =>
                event.kind === 'turn.settled' &&
                event.payload['turnId'] === promptId,
            );
          if (settledRecordLanded) {
            session.recoveredTurn = undefined;
            session.recoveryUnobserved?.delete(promptId);
          } else {
            session.admissions.delete(promptId);
          }
        }
        if (!res.headersSent) error(res, 503, 'managed_runtime_cancel_failed');
      } finally {
        // No handback here: the coordinator retries a failed cancel, and a
        // release would wedge that retry; the success path above already
        // released and discharged the flag itself.
        if (
          session.recoveryCancelPromptId === promptId &&
          !unsettledInputs(session).has(promptId)
        )
          liftRecoveryBlock(session);
        session.active = undefined;
        noteSessionActivity(session);
      }
    })();
  });
}

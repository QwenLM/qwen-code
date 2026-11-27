/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import { WorkflowStartCancelledError } from '@qwen-code/qwen-code-core/agents/runtime/workflow-runner.js';
import { convertToFunctionErrorResponse } from '@qwen-code/qwen-code-core/core/coreToolScheduler.js';
import { HTTP_MANAGED_SESSION_STORE_CONTRACT } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { managedCommandId } from '@qwen-code/qwen-code-core/managed-runtime/managed-command-id.js';
import type { ManagedInvocationObservation } from '@qwen-code/qwen-code-core/managed-runtime/managed-execution-diagnostics.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import { ManagedHookActivationController } from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-activation.js';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import {
  assertManagedSessionDurableRef,
  type ManagedSessionDurableRef,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import type { Application, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { writeStderrLineSafe } from '../../utils/stdioHelpers.js';
import {
  type HostedActionParkRegistration,
  registerHostedActionPark,
} from '../hosted-action-parking.js';
import {
  HostedModelUnavailableError,
  readHostedAgentInstructions,
} from '../hosted-agent-definition.js';
import type { RestoredHostedApprovalContinuation } from '../hosted-approval-continuation.js';
import {
  createHostedLiveApprovalReader,
  type HostedApprovalSelection,
  hostedTurnApproval,
  parseHostedApprovalSelection,
  readHostedTurnApprovalSelection,
} from '../hosted-approval-selection.js';
import {
  commitHostedFileHistory,
  dropPendingHostedFileHistoryTurn,
  HOSTED_UUID,
  readHostedFileHistory,
} from '../hosted-file-history.js';
import type { HostedHarnessInstance } from '../hosted-harness-instance.js';
import {
  HostedImageInputUnsupportedError,
  HostedModelApiError,
  HostedModelRoundLimitError,
  hostedToolOutputBudget,
  runHostedHarnessTextTurn,
} from '../hosted-harness-model.js';
import {
  HOSTED_ATTACHMENT_INPUT_BYTES,
  parseHostedInput,
  readHostedInput,
} from '../hosted-input.js';
import { HostedMcpConnectionQuotaError } from '../hosted-mcp-session.js';
import { hasPlanModeBlock, inputBodyText } from '../hosted-member-chain.js';
import {
  createHostedModelRequest,
  type HostedModelRequest,
  publishHostedModelRequest,
} from '../hosted-model-recovery.js';
import {
  type HostedModelSelection,
  parseHostedModelSelection,
  readHostedTurnModelSelection,
} from '../hosted-model-selection.js';
import { monitorWakeNeedsRecovery } from '../hosted-monitor-wake-turn.js';
import {
  acquireHostedQuestionRuntime,
  questionWaitDefinitionAdmitted,
  waitForHostedQuestion,
} from '../hosted-question-wait.js';
import { HostedRecoveryQuiescingError } from '../hosted-runtime-recovery.js';
import { HostedTextDeltaStream } from '../hosted-text-deltas.js';
import {
  endHostedAction,
  hostedActionAllowed,
  hostedActionDenied,
  hostedLiveApprovalPoll,
  readHostedActionOptions,
} from '../hosted-tool-approval.js';
import { oweHostedTurnCleanup } from '../hosted-turn-cleanup.js';
import {
  isExcludedHostedRecord,
  normalizeHostedTurnRecords,
} from '../hosted-turn-history.js';
import { readHostedQuestionDecision } from '../hosted-user-question.js';
import { isHostedWakeContinuationId } from '../hosted-wake-continuation.js';
import {
  type HostedWorkflowLaunch,
  parseHostedWorkflowLaunchBlock,
  runHostedWorkflowTurn,
  workflowLaunchSummaryText,
} from '../hosted-workflow-turn.js';
import {
  HostedWorkspaceBroker,
  type HostedWorkspaceBrokerOptions,
} from '../hosted-workspace-broker.js';
import {
  HOSTED_WORKSPACE_EXTERNAL_FILES_PROFILE,
  HOSTED_WORKSPACE_EXTERNAL_SHELL_PROFILE,
} from '../hosted-workspace-profiles.js';
import {
  type HostedApprovalTurnOptions,
  HostedToolRecoveryRequiredError,
  type HostedWorkspaceContextSlot,
  HostedWorkspaceToolTurn,
  isRetryableWorkspaceAcquisition,
} from '../hosted-workspace-tool-turn.js';
import { extensionAgentsOf } from './configuration-routes.js';
import { startHostedEventIngest } from './event-ingest.js';
import { childAgentsOf, stopPublicChildSource } from './interaction-routes.js';
import { compressionBusy, noteSessionActivity } from './lifecycle-routes.js';
import {
  blockOnTurnRecovery,
  blockRecovery,
  type HostedRuntimeOwnership,
  liftRecoveryBlock,
  retainHostedCleanupHolds,
  retryHostedCleanup,
} from './runtime-ownership.js';
import {
  describeManagedError,
  error,
  hostedTurnBusyReason,
  identity,
  namedStoreFailure,
  object,
  record,
} from './session-http.js';
import type { HostedSession, HostedSuspensionStats } from './session-state.js';
import {
  parkNeedsNoRuntimeSettlement,
  settleCancelledHarnessTurn,
  settleCancelledHookTurn,
} from './turn-cancellation.js';
import {
  acceptedInputSequence,
  hasPendingWakePark,
  readHostedClassifierUserText,
  unansweredPrompts,
  unsettledInputs,
} from './wake-recovery.js';

const DIGEST = /^sha256:[0-9a-f]{64}$/u;

/**
 * The prompt deadline timer and the cancel route abort the same controller,
 * so the deadline aborts with a distinguishing reason; settlement reads it
 * back to keep an expiry from being recorded as a user cancellation.
 */
const HOSTED_TURN_DEADLINE = new Error(
  'The Hosted Harness Turn deadline expired.',
);

/**
 * One prompt-gate Hook reconcile pass gets the grace a single broker poll
 * gets: each status round-trip is itself bounded by the broker's fetch
 * timeout, and a stalled Runtime must not multiply that bound by every
 * pending record while the route waits.
 */
const HOSTED_HOOK_RECONCILE_BUDGET_MS = 30_000;

/**
 * The terminal classification of a turn whose runner threw. A deadline
 * expiry is an attributable failure, never a cancellation.
 */
function settledTurnOutcome(abort: AbortController): {
  state: 'cancelled' | 'error';
  stopReason: string;
} {
  if (!abort.signal.aborted) return { state: 'error', stopReason: 'error' };
  return abort.signal.reason === HOSTED_TURN_DEADLINE
    ? { state: 'error', stopReason: 'deadline_exceeded' }
    : { state: 'cancelled', stopReason: 'cancelled' };
}

export async function hostedApprovalForTurn(
  session: HostedSession,
  promptId: string,
): Promise<HostedApprovalTurnOptions | undefined> {
  if (!session.approval) return undefined;
  const live =
    session.stores &&
    !session.definition?.['lineage'] &&
    [
      'hosted-workspace-files/1',
      'hosted-workspace-shell/1',
      'hosted-workspace-shell/3',
      'hosted-workspace-shell/4',
      'hosted-workspace-files/3',
      HOSTED_WORKSPACE_EXTERNAL_FILES_PROFILE,
      HOSTED_WORKSPACE_EXTERNAL_SHELL_PROFILE,
      'hosted-workspace-files/4',
    ].includes(session.toolProfile ?? '');
  const admission = await readHostedTurnApprovalSelection(
    session.managed,
    promptId,
    live ? () => session.stores!.approvalSelection() : undefined,
  );
  const settings = (await hostedTurnApproval(
    session.managed,
    promptId,
    session.approval,
    admission,
  ))!;
  return {
    settings,
    waiters: session.waiters,
    isBlocked: () => session.blocked,
    ...(live
      ? {
          readSettings: createHostedLiveApprovalReader(
            settings,
            admission,
            () => session.stores!.approvalSelection(),
          ),
        }
      : {}),
  };
}

/**
 * H4e-b3 decisions 5/9: whether this run's first committed input carried
 * an unescaped `plan-mode="required"` preamble. Only a Session with a
 * lineage has a composed first input to read; a root Session's user
 * prompt never makes one. The body's route shape is the `/prompt`
 * array-of-parts, while funnel-written inputs carry a bare `{text}`.
 */
async function hostedFirstInputPlanMode(
  managed: ManagedSession,
): Promise<boolean> {
  const first = managed.authority
    .readEvents({ afterSequence: 0 })
    .find((event) => event.kind === 'input.accepted');
  if (first === undefined) return false;
  const ref = assertManagedSessionDurableRef(
    first.payload['contentRef'],
    'member first input',
  );
  const body = JSON.parse(
    (await managed.resources.read(ref)).toString('utf8'),
  ) as unknown;
  const text = inputBodyText(body);
  return text !== undefined && hasPlanModeBlock(text);
}

/**
 * H4e-b3a review finding: a member Session's plan mode settles only once
 * its first input is durable — at Session create it has none committed
 * yet, so the flag is answered lazily on every turn construction until a
 * positive answer is cached. A root prompt never arms it.
 */
export async function ensureMemberPlanMode(
  session: HostedSession,
): Promise<boolean> {
  if (session.memberPlanMode === true || session.toolProfile === undefined)
    return session.memberPlanMode === true;
  const lineage = object(session.definition?.['lineage']);
  if (
    typeof lineage?.['parentSessionId'] !== 'string' ||
    typeof lineage['parentChildRunId'] !== 'string'
  )
    return false;
  const planMode = await hostedFirstInputPlanMode(session.managed);
  if (planMode) session.memberPlanMode = true;
  return planMode;
}

// A resumed Turn restarts from this text, so an Action park refuses a Turn
// without it exactly as the recovery arms do. A hosted-harness input that
// carries only attachments restarts from empty text, as its live Turn ran:
// executeHostedTurn reads the attachments back from the input itself.
export async function hostedOriginalPromptText(
  managed: ManagedSession,
  promptId: string,
): Promise<string | undefined> {
  const user = (await managed.sink.project()).find(
    (item) => item.type === 'user' && item.daemonPromptId === promptId,
  );
  const text = user?.message?.parts
    ?.flatMap((part) => (typeof part.text === 'string' ? [part.text] : []))
    .join('\n');
  if (text) return text;
  return (await readHostedInput(managed, promptId, '')).attachments.length
    ? ''
    : undefined;
}

export async function startHostedRecoveredTurn(
  session: HostedSession,
  sessionId: string,
  cwd: string,
  resume: { promptId: string; text: string; parts: Part[] },
  brokerOptions: HostedWorkspaceBrokerOptions | undefined,
  resumeApproval?: RestoredHostedApprovalContinuation,
  resumeModel?: HostedModelRequest,
  cancellationTakeover = false,
): Promise<void> {
  if (session.poolAccepting?.() === false)
    throw new HostedRecoveryQuiescingError('The Harness is quiescing.');
  const abort = new AbortController();
  const accepted = session.managed.authority
    .eventsInSequenceRange(1, session.managed.authority.committedSequence)
    .find(
      (event) =>
        event.kind === 'input.accepted' &&
        event.payload['turnId'] === resume.promptId,
    );
  const deadline = accepted?.payload['deadline'];
  const cancelled =
    cancellationTakeover ||
    session.managed.authority
      .eventsInSequenceRange(1, session.managed.authority.committedSequence)
      .some(
        (event) =>
          event.kind === 'cancel.requested' &&
          object(event.payload['target'])?.['turnId'] === resume.promptId,
      );
  const timer =
    !cancelled && typeof deadline === 'number'
      ? setTimeout(
          () => abort.abort(HOSTED_TURN_DEADLINE),
          Math.max(0, deadline - Date.now()),
        )
      : undefined;
  timer?.unref();
  session.deadlineTimer = timer;
  if (cancelled) {
    await stopPublicChildSource(session, resume.promptId);
    abort.abort();
  } else if (typeof deadline === 'number' && deadline <= Date.now())
    abort.abort(HOSTED_TURN_DEADLINE);
  session.active = {
    promptId: resume.promptId,
    digest: '',
    abort,
  };
  let resolveReady!: () => void;
  let rejectReady!: (cause: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // The record reaches this callback even when its own commit later dies,
  // so the turn's already-computed stopReason outlives the raw cause —
  // an armed write latch reports that only as ManagedSessionWritesStoppedError.
  let turnResult: ChatRecord | undefined;
  const resumed = executeHostedTurn(
    session,
    sessionId,
    cwd,
    resume.promptId,
    resume.text,
    abort,
    brokerOptions,
    resumeApproval || resumeModel ? undefined : resume.parts,
    (result) => {
      turnResult = result;
    },
    resolveReady,
    resumeApproval,
    resumeModel,
  );
  // Do not attach a Session whose original continuation cannot acquire
  // Workspace ownership. The caller can retry load without losing it.
  void resumed.catch(rejectReady);
  void resumed
    .catch((cause: unknown) => {
      // The automatic bare-load recovery drives the turn entirely inside
      // this helper — without routing through the prompt-route or
      // manual-continue fallbacks that already keep the named store
      // failure. Classify the original cause here too; when a terminal
      // write died on the armed write latch the cause only reads back as
      // ManagedSessionWritesStoppedError, so fall back to the stopReason
      // the turn already computed, exactly as the prompt route does
      // (#13800; memory only, never a persisted terminal claim).
      const storeFailure = namedStoreFailure(cause);
      const recordedStopReason = (
        turnResult?.systemPayload as { stopReason?: unknown } | undefined
      )?.['stopReason'];
      blockRecovery(
        session,
        storeFailure ??
          (recordedStopReason === 'managed_session_store_unavailable'
            ? 'managed_session_store_unavailable'
            : undefined),
      );
      writeStderrLineSafe(
        'qwen serve: Hosted Harness recovery remained blocked: ' +
          describeManagedError(cause),
      );
    })
    .finally(() => {
      if (timer) clearTimeout(timer);
      if (session.deadlineTimer === timer) session.deadlineTimer = undefined;
      session.active = undefined;
      noteSessionActivity(session);
    });
  await ready;
  liftRecoveryBlock(session);
}

// E2E fault injection only (QWEN_E2E_CRASH_BEFORE_ASSISTANT_COMMIT=<sessionId>, set
// by the packaged finished-before-commit arm on the generation that must crash):
// once the main model stream's Finished marker is durable but before the assistant
// output commits, hold the turn so the runner can SIGKILL this generation inside
// that window. The next generation must reissue the saved request rather than
// compensate an already-committed terminal. The flag is never set in production.
const crashBeforeCommitSession =
  process.env['QWEN_E2E_CRASH_BEFORE_ASSISTANT_COMMIT'];

let crashBeforeCommitFired = false;

export async function executeHostedTurn(
  session: HostedSession,
  sessionId: string,
  cwd: string,
  promptId: string,
  text: string,
  abort: AbortController,
  brokerOptions: HostedWorkspaceBrokerOptions | undefined,
  resumeFromToolResults?: Part[],
  onTurnResult?: (result: ChatRecord) => void,
  onResumeReady?: () => void,
  resumeApproval?: RestoredHostedApprovalContinuation,
  resumeModel?: HostedModelRequest,
  workflowLaunch?: HostedWorkflowLaunch,
): Promise<ChatRecord> {
  const authority = session.managed.authority;
  const promptInput = workflowLaunch
    ? { text, parts: [{ text }], attachments: [] }
    : await readHostedInput(session.managed, promptId, text);
  const harness = createManagedHarnessHandle(session.managed);
  let questionRecoveryBroker: HostedWorkspaceBroker | undefined;
  if (resumeModel) {
    await harness.adoptPreparedContinuation(promptId, true);
    session.workspaceContext = resumeModel.workspaceContext ?? undefined;
    await new HostedTextDeltaStream(session.managed, promptId).retractOriginal(
      resumeModel.messageId,
      resumeModel,
    );
    const attempt = authority
      .eventsInSequenceRange(1, authority.committedSequence)
      .findLast(
        (event) =>
          event.kind === 'model.attempt' &&
          typeof event.payload['attemptId'] === 'string' &&
          event.payload['attemptId'].startsWith(`${promptId}:main:`),
      );
    if (attempt?.payload['state'] === 'started') {
      const activation = session.managed.activation;
      const commandId = managedCommandId(
        `${attempt.payload['attemptId']}:abandoned`,
      );
      await authority.appendExecutionEvent(
        {
          operation: 'hostedModelAttempt',
          commandId,
          sessionKey: authority.sessionHeader.sessionKey,
          contentDigest: (
            attempt.payload['routeRef'] as unknown as ManagedSessionDurableRef
          ).digest,
        },
        (sequence) => ({
          v: 1,
          sequence,
          eventId: commandId,
          sessionKey: authority.sessionHeader.sessionKey,
          kind: 'model.attempt',
          occurredAt: Date.now(),
          subject: {
            type: 'activation',
            scopeId: activation.activationId,
            ...activation,
          },
          payload: { ...attempt.payload, state: 'abandoned' },
        }),
        { class: 'harness', activation },
      );
    }
  }
  if (resumeApproval) {
    const plan = resumeApproval.plan;
    if (plan.runtime?.provisionerKind) {
      if (
        !brokerOptions ||
        session.mcp ||
        session.hooks ||
        session.foregroundOnly ||
        (await ensureMemberPlanMode(session)) ||
        !questionWaitDefinitionAdmitted(
          session.definition,
          session.childDepth ?? 0,
        )
      )
        throw new HostedToolRecoveryRequiredError(
          'Original question Session is not qualified.',
        );
      questionRecoveryBroker = new HostedWorkspaceBroker(
        brokerOptions,
        authority.sessionHeader.sessionKey,
        plan.runtime.runtimeSessionId,
      );
      questionRecoveryBroker.runtime = {
        bindingId: plan.runtime.bindingId,
        generation: plan.runtime.generation,
        workspaceGeneration: plan.runtime.workspaceGeneration,
      };
    }
    if (plan.stage === 'approval') {
      const actionId = plan.actionId!;
      const original = authority.action(actionId)!;
      const options = await readHostedActionOptions(session.managed, original);
      let parkRegistration: HostedActionParkRegistration | undefined;
      try {
        const liveApproval =
          options.toolName !== 'exit_plan_mode' &&
          !options.requiresHumanDecision
            ? await hostedApprovalForTurn(session, promptId)
            : undefined;
        parkRegistration =
          options.continuationRef !== undefined
            ? {
                promptId,
                options,
                settings: liveApproval?.settings,
                livePoll:
                  liveApproval !== undefined &&
                  liveApproval.readSettings !== undefined,
                globProfile: false,
                freeze: () => session.waiters.park(actionId),
              }
            : undefined;
        if (parkRegistration)
          registerHostedActionPark(session.managed, parkRegistration);
        onResumeReady?.();
        if (
          plan.runtime &&
          questionRecoveryBroker &&
          original.state === 'requested' &&
          !abort.signal.aborted &&
          Date.now() < options.expiresAt
        ) {
          const history = await readHostedFileHistory(session.managed);
          if (history?.pendingTurn || history?.pendingUndo)
            throw new Error('Question file history is still owed.');
          await oweHostedTurnCleanup(
            session.managed,
            promptId,
            questionRecoveryBroker,
          );
          const acquired = await acquireHostedQuestionRuntime(
            questionRecoveryBroker,
            plan.runtime,
            abort.signal,
            options.expiresAt,
          );
          if (acquired)
            await waitForHostedQuestion({
              session: session.managed,
              broker: questionRecoveryBroker,
              brokerOptions: brokerOptions!,
              waiters: session.waiters,
              requestId: actionId,
              expiresAt: options.expiresAt,
              signal: abort.signal,
              registerFreeze: (freeze) => {
                if (parkRegistration) parkRegistration.freeze = freeze;
              },
            });
        } else
          await session.waiters.wait(
            actionId,
            options.expiresAt,
            abort.signal,
            () =>
              authority.action(actionId)?.state !== 'requested' ||
              authority.writesStopped,
            liveApproval?.readSettings
              ? hostedLiveApprovalPoll(
                  session.managed,
                  session.waiters,
                  options,
                  liveApproval.readSettings,
                  abort.signal,
                  false,
                  liveApproval.isBlocked,
                )
              : undefined,
          );
      } catch (cause) {
        throw new HostedToolRecoveryRequiredError(cause);
      } finally {
        if (parkRegistration)
          registerHostedActionPark(session.managed, undefined);
      }
      if (authority.action(actionId)?.state === 'requested')
        await endHostedAction(
          session.managed,
          actionId,
          abort.signal.aborted ? 'cancelled' : 'expired',
        );
      const action = authority.action(actionId)!;
      await harness.resolveDurableWait();
      if (action.state === 'decided' && options.v === 4)
        await readHostedQuestionDecision(session.managed, action, options);
      if (
        action.state === 'decided' &&
        options.v !== 4 &&
        !hostedActionAllowed(action, options.policyRevision) &&
        !hostedActionDenied(action, options.policyRevision)
      )
        throw new HostedToolRecoveryRequiredError(
          'Unknown original approval verdict.',
        );
      const calls = plan.calls.map((item, index) =>
        index === plan.approvalOrdinal
          ? {
              ...item,
              refusal:
                (options.v === 4 && action.state === 'decided') ||
                hostedActionAllowed(action, options.policyRevision)
                  ? null
                  : 'Original approval denied the call.',
            }
          : item,
      );
      resumeApproval = { ...resumeApproval, plan: { ...plan, calls } };
    }
    const expired = plan.calls.some(
      (item) =>
        item.actionId && authority.action(item.actionId)?.state === 'expired',
    );
    const cancelled = plan.calls.some(
      (item) =>
        item.actionId && authority.action(item.actionId)?.state === 'cancelled',
    );
    if (abort.signal.aborted || expired || cancelled) {
      if (!(await parkNeedsNoRuntimeSettlement(session.managed)))
        throw new HostedToolRecoveryRequiredError(
          'Original cancellation still owes Runtime outcomes.',
        );
      const fileHistory = await readHostedFileHistory(session.managed);
      if (fileHistory?.pendingUndo)
        throw new HostedToolRecoveryRequiredError(
          'Original file history undo is still owed.',
        );
      if (fileHistory?.pendingTurn === promptId)
        await commitHostedFileHistory(session.managed, {
          ...fileHistory,
          pendingTurn: null,
          pendingMessageId: undefined,
        });
      const answered = new Set(
        (await session.managed.sink.project())
          .filter(
            (item) =>
              item.type === 'tool_result' && item.daemonPromptId === promptId,
          )
          .flatMap(
            (item) =>
              item.message?.parts?.flatMap((part) =>
                part.functionResponse?.id ? [part.functionResponse.id] : [],
              ) ?? [],
          ),
      );
      const results = plan.calls.flatMap((item) =>
        answered.has(item.call.callId)
          ? []
          : convertToFunctionErrorResponse(
              item.call.name,
              item.call.callId,
              [],
              expired
                ? 'Original approval expired.'
                : 'Original Turn was cancelled.',
            ),
      );
      if (results.length)
        await session.managed.sink.write(
          record(session, sessionId, 'tool_result', plan.batchId, {
            daemonPromptId: promptId,
            model: plan.model,
            message: { role: 'user', parts: results },
          }),
        );
      await settleCancelledHarnessTurn(
        session.managed,
        session,
        sessionId,
        promptId,
      );
      const terminal = (await session.managed.sink.project()).findLast(
        (item) =>
          item.subtype === 'turn_result' &&
          object(item.systemPayload)?.['promptId'] === promptId,
      )!;
      if (brokerOptions) await retryHostedCleanup(session, brokerOptions);
      onResumeReady?.();
      return terminal;
    }
    await harness.adoptPreparedContinuation(promptId);
  }
  let turnResult: ChatRecord | undefined;
  let toolTurn: HostedWorkspaceToolTurn | undefined;
  const running = new ManagedHookActivationController(session.managed).runTurn(
    promptId,
    async (modelScope) =>
      harness.run(async () => {
        const projected = await session.managed.sink.project();
        const rawModelRecords =
          await session.managed.sink.projectModelRecords();
        const unanswered = unansweredPrompts(session, projected);
        const modelRecords = normalizeHostedTurnRecords(
          rawModelRecords,
          unanswered,
        );
        const settledPrompts = new Set(
          authority
            .eventsInSequenceRange(1, authority.committedSequence)
            .filter((event) => event.kind === 'turn.settled')
            .map((event) => event.payload['turnId']),
        );
        const history = (
          session.toolProfile
            ? modelRecords.filter(
                (entry) =>
                  entry.type === 'system' ||
                  settledPrompts.has(entry.daemonPromptId) ||
                  ((resumeFromToolResults || resumeApproval || resumeModel) &&
                    entry.daemonPromptId === promptId),
              )
            : modelRecords
        ).filter((entry) => !isExcludedHostedRecord(entry, unanswered));
        let parentUuid = projected.at(-1)?.uuid ?? null;
        if (!resumeFromToolResults && !resumeApproval && !resumeModel) {
          const continuation = isHostedWakeContinuationId(promptId);
          const inputRecord = record(
            session,
            sessionId,
            continuation ? 'system' : 'user',
            parentUuid,
            {
              daemonPromptId: promptId,
              ...(continuation
                ? { subtype: 'turn_attempt' }
                : { message: { role: 'user', parts: promptInput.parts } }),
            },
          );
          const initialQueued = await session.stores?.claimUserMessages(
            promptId,
            true,
          );
          if (initialQueued?.length)
            inputRecord.uuid = `${initialQueued[0].id}:${initialQueued[0].revision}`;
          await session.managed.sink.write(inputRecord);
          parentUuid = inputRecord.uuid;
        }
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
          if (type === 'assistant' && deltas) {
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
        // #13803: a workflow Turn owns no tool turn — its work is the
        // runner's own dispatch, and the Session's broker-backed tool
        // surface belongs to model turns.
        toolTurn =
          workflowLaunch === undefined &&
          ((session.toolProfile && brokerOptions) || session.memory)
            ? new HostedWorkspaceToolTurn(
                brokerOptions,
                session.managed,
                harness,
                promptId,
                commit,
                (type, parts, model) =>
                  Buffer.byteLength(
                    JSON.stringify(messageRecord(type, parts, model)),
                  ) <=
                  HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes,
                session.publication,
                session.shell,
                await hostedApprovalForTurn(session, promptId),
                {
                  recoveryBroker: questionRecoveryBroker,
                  memory: session.memory,
                  memoryOnly: !session.toolProfile,
                  mcp: session.mcp,
                  clientFiles: session.clientFiles,
                  hooks: session.hooks,
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
                    (
                      await readHostedTurnApprovalSelection(
                        session.managed,
                        promptId,
                      )
                    )?.planMode === true,
                },
              )
            : undefined;
        if (toolTurn && session.skills)
          toolTurn.setToolOutputBudget(hostedToolOutputBudget(session.cwd));
        if (resumeApproval) {
          if (!toolTurn)
            throw new HostedToolRecoveryRequiredError(
              'Saved tool owner is unavailable.',
            );
          const authorization = await authority.harnessRunAuthorization();
          if (authorization.status !== 'runnable')
            throw new HostedToolRecoveryRequiredError(
              'Saved tool continuation is blocked.',
            );
          const parts = await toolTurn.resumeSavedNativeBatch(
            resumeApproval,
            resumeApproval.plan.approvalOrdinal + 1,
            abort.signal,
          );
          resumeFromToolResults = parts;
          onResumeReady?.();
        } else if (resumeFromToolResults || resumeModel?.pendingToolResults) {
          if (!toolTurn)
            throw new HostedToolRecoveryRequiredError(
              'Tool turn is unavailable.',
            );
          try {
            await toolTurn.resumeCommittedResults(abort.signal);
          } catch (cause) {
            if (isRetryableWorkspaceAcquisition(cause)) throw cause;
            if (cause instanceof HostedToolRecoveryRequiredError) throw cause;
            throw new HostedToolRecoveryRequiredError(cause);
          }
          onResumeReady?.();
        }
        if (resumeModel && !resumeModel.pendingToolResults) onResumeReady?.();
        let state: 'completed' | 'cancelled' | 'error' = 'completed';
        let stopReason = 'end_turn';
        try {
          const result =
            workflowLaunch !== undefined
              ? await runHostedWorkflowTurn({
                  sessionId,
                  cwd,
                  launch: workflowLaunch,
                  signal: abort.signal,
                  agentDefinition: session.agentDefinition,
                  modelConfig: session.modelConfig,
                })
              : await runHostedHarnessTextTurn({
                  sessionId,
                  cwd,
                  history,
                  excludedPromptIds: unansweredPrompts(session, projected),
                  classifierUserText: () =>
                    readHostedClassifierUserText(session),
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
                  prompt: text,
                  attachmentParts: promptInput.attachments,
                  promptId,
                  ...(session.stores
                    ? {
                        userMessages: {
                          claim: async () =>
                            (
                              await session.stores!.claimUserMessages(promptId)
                            ).map((message) => ({
                              id: `${message.id}:${message.revision}`,
                              ...parseHostedInput(message.input),
                            })),
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
                          commitAssistant: async (
                            parts: Part[],
                            model: string,
                          ) => {
                            await commit('assistant', parts, model);
                          },
                        },
                      }
                    : {}),
                  signal: abort.signal,
                  modelScope,
                  workspaceContext,
                  agentDefinition: session.agentDefinition,
                  modelConfig: session.modelConfig,
                  memory: session.memory,
                  userPrompt: authority
                    .eventsInSequenceRange(1, authority.committedSequence)
                    .some(
                      (event) =>
                        event.kind === 'input.accepted' &&
                        event.payload['inputId'] === promptId &&
                        event.payload['source'] === 'hosted-harness',
                    ),
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
                  ...(session.hooks ? { hooks: session.hooks } : {}),
                  ...(toolTurn ? { toolTurn } : {}),
                  ...(resumeFromToolResults ? { resumeFromToolResults } : {}),
                  ...(resumeApproval
                    ? { initialRound: resumeApproval.plan.round + 1 }
                    : {}),
                  ...(resumeModel ? { resumeModel } : {}),
                  ...(!session.hooks
                    ? {
                        prepareModel: async (
                          prepared,
                          round,
                          pendingToolResults,
                          context,
                          captureUnsupported,
                        ) => {
                          if (captureUnsupported) return undefined;
                          const snapshot = createHostedModelRequest(
                            session.managed,
                            promptId,
                            prepared,
                            round,
                            pendingToolResults,
                            context,
                            session.streamOwner,
                          );
                          const ref = await publishHostedModelRequest(
                            session.managed,
                            snapshot,
                          );
                          deltas.bindMessageId(snapshot.messageId);
                          return ref;
                        },
                      }
                    : {}),
                  ...(deltas ? { textDeltas: deltas } : {}),
                });
          if (
            crashBeforeCommitSession === sessionId &&
            !crashBeforeCommitFired
          ) {
            // The stream's Finished marker is already durable (the model layer's
            // finally committed a usage-only output_committed); the assistant
            // message.committed below is not. Hold here so the runner crashes this
            // generation inside the B3a window and the next one must reissue. The
            // hold still observes the Turn's abort signal: a leaked flag must not
            // park a real Session uncancellably, so a cancel/deadline/daemon abort
            // rejects into the enclosing catch and settles the Turn instead.
            crashBeforeCommitFired = true;
            writeStderrLineSafe(
              `qwen serve: E2E holding finished turn before assistant commit for Session ${sessionId} prompt ${promptId}`,
            );
            await new Promise<never>((_resolve, reject) => {
              const release = (): void =>
                reject(abort.signal.reason ?? new Error('aborted'));
              if (abort.signal.aborted) release();
              else
                abort.signal.addEventListener('abort', release, { once: true });
            });
          }
          await commit(
            'assistant',
            result.parts ?? [{ text: result.text }],
            result.model,
          );
        } catch (cause) {
          if (monitorWakeNeedsRecovery(cause)) throw cause;
          const outcome = settledTurnOutcome(abort);
          state = outcome.state;
          stopReason = outcome.stopReason;
          if (
            stopReason === 'error' &&
            cause instanceof HostedImageInputUnsupportedError
          )
            stopReason = 'image_input_unsupported';
          // A deadline expiry must keep naming the deadline: only a generic
          // error outcome may be reclassified as a model-route failure.
          if (
            stopReason === 'error' &&
            cause instanceof HostedModelUnavailableError
          )
            stopReason = 'model_unavailable';
          if (
            stopReason === 'error' &&
            cause instanceof HostedModelRoundLimitError
          )
            stopReason = 'model_round_limit';
          if (stopReason === 'error' && cause instanceof HostedModelApiError)
            stopReason = cause.code;
          if (
            stopReason === 'error' &&
            cause instanceof WorkflowStartCancelledError
          ) {
            // A registry-side cancel while the workflow start is held
            // (cancelStarting/abortAll reaches the run's controller with
            // this Turn's signal live) is a cancelled Turn, not a failed
            // one — the Workflow tool answers the same error as cancelled.
            state = 'cancelled';
            stopReason = 'cancelled';
          }
          if (stopReason === 'error') {
            const storeFailure = namedStoreFailure(cause);
            if (storeFailure !== undefined) stopReason = storeFailure;
          }
          if (state === 'error') {
            // The model layer surfaces any abort as a cancellation, so a
            // deadline expiry names the deadline, not the thrown cause.
            writeStderrLineSafe(
              stopReason === 'deadline_exceeded'
                ? `qwen serve: Hosted Harness turn ${promptId} exceeded its deadline.`
                : 'qwen serve: Hosted Harness turn ' +
                    promptId +
                    ' failed: ' +
                    String(cause),
            );
          }
        }
        await toolTurn?.finish();
        // #13856: a turn that ended with its Runtime held owes the close
        // that Runtime's drain — the run outlives the turn by design.
        if (toolTurn?.runtimeHeld) session.heldRuntimeTurns.add(promptId);
        turnResult = record(session, sessionId, 'system', null, {
          subtype: 'turn_result',
          systemPayload: { promptId, state, stopReason, endedAt: Date.now() },
        });
        onTurnResult?.(turnResult);
        await session.managed.sink.write(turnResult);
        try {
          session.cleanupHolds?.delete(promptId);
          retainHostedCleanupHolds(session, await toolTurn?.cleanup());
          if (toolTurn?.runtimeHeld) session.heldRuntimeTurns.add(promptId);
        } catch (cause) {
          if (!session.blocked) {
            session.cleanupBlocked = true;
            session.blocked = true;
            session.monitorWake?.kick();
          }
          writeStderrLineSafe(
            'qwen serve: Turn completed with cleanup still owed: ' +
              String(cause),
          );
          // The owed cleanup keeps retrying its full release; the mount
          // goes back now, or the parked Session wedges its storage until
          // that release lands (#13800).
          await toolTurn?.releaseForRecoveryBlock();
        }
        // H4b: the tool-arm results this turn answered are consumed
        // facts only once the turn's own settlement commits durably — a
        // crash before this point leaves accepted-not-consumed evidence
        // (H4b decision 6), never a consumed claim without a settled
        // Turn; each id leaves the owed set as it commits, so a commit
        // that dies mid-flush keeps the remainder owed, never widened
        // and never silently dropped.
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
      }),
  );
  // Session availability must not gate on publisher cleanup: the drain is
  // unbounded, and a stalled Session Store would otherwise leave the Session
  // permanently unavailable and undeletable. Each turn owns its publisher,
  // so a next turn shares no listener or capture state with this drain.
  try {
    await running.finally(() => {
      void toolTurn?.close().catch((cause: unknown) => {
        session.runtimeRecoveryPromptId = undefined;
        session.blocked = true;
        writeStderrLineSafe(
          'qwen serve: Hosted Shell publisher cleanup failed: ' + String(cause),
        );
      });
    });
  } catch (cause) {
    // The recovery-blocked exit hands back the Workspace mount before the
    // block verdict parks the Session: the lease is the turn's, and a turn
    // that never runs again must not hold it against every later Session
    // on the same storage (#13800). finish() kept it for the uncertain
    // case; the block transition is exactly where the turn proves it will
    // never replay, so this is where the exclusion ends. A turn whose
    // terminal record never landed skipped the cleanup its release is owed
    // to; the route may park it blocked over that write, and the durable
    // cleanup debt keeps owing the full release, so its mount goes back too.
    if (monitorWakeNeedsRecovery(cause) || toolTurn?.cleanupPending)
      await toolTurn?.releaseForRecoveryBlock();
    throw cause;
  }
  if (!turnResult) throw new Error('Hosted turn did not settle.');
  return turnResult;
}

export function registerHostedPromptRoute({
  app,
  sessions,
  epoch,
  instance,
  brokerOptions,
  suspensionStats,
  cwd,
  releaseRecoveredRuntime,
}: {
  app: Application;
  sessions: Map<string, HostedSession>;
  epoch: string;
  instance: HostedHarnessInstance | undefined;
  brokerOptions: HostedWorkspaceBrokerOptions | undefined;
  suspensionStats: HostedSuspensionStats;
  cwd: string;
  releaseRecoveredRuntime: HostedRuntimeOwnership['releaseRecoveredRuntime'];
}): void {
  const admitPrompt = async (
    req: Request,
    res: Response,
    reconciled = false,
  ): Promise<void> => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (session.recoveryCleanupOnly)
      return error(res, 409, 'hosted_turn_recovery_required');
    if (session.mcpClosing) return error(res, 409, 'hosted_session_closing');
    if (session.hooksBusy)
      return error(res, 409, 'hosted_hook_operation_active');
    if (session.mcpBusy || session.mcpRecovering)
      return error(res, 409, 'hosted_mcp_operation_active');
    const body = object(req.body);
    const promptId = body?.['promptId'];
    const prompt = body?.['prompt'];
    const digest = body?.['payloadDigest'];
    const deadlineMs = body?.['deadlineMs'];
    let approvalSelection: HostedApprovalSelection | undefined;
    try {
      approvalSelection = parseHostedApprovalSelection(
        body?.['approvalSelection'],
      );
      if (
        approvalSelection &&
        (!session.approval ||
          !(
            session.agentDefinition
              ? [
                  'hosted-workspace-files/1',
                  'hosted-workspace-shell/1',
                  'hosted-workspace-shell/3',
                  'hosted-workspace-shell/4',
                  'hosted-workspace-files/3',
                  'hosted-workspace-files/4',
                ]
              : [
                  'hosted-workspace-files/1',
                  'hosted-workspace-shell/1',
                  'hosted-workspace-shell/3',
                  'hosted-workspace-shell/4',
                  'hosted-workspace-files/2',
                  'hosted-workspace-files/3',
                  HOSTED_WORKSPACE_EXTERNAL_FILES_PROFILE,
                  HOSTED_WORKSPACE_EXTERNAL_SHELL_PROFILE,
                  'hosted-workspace-files/4',
                ]
          ).includes(session.toolProfile ?? '') ||
          (approvalSelection.revision === 0 &&
            (approvalSelection.mode !== session.approval.mode ||
              !isDeepStrictEqual(
                approvalSelection.permissionRules,
                session.approval.permissionRules,
              ))))
      )
        throw new Error('Approval selection is unavailable for this Session.');
      if (
        approvalSelection?.planMode &&
        (![
          'hosted-workspace-files/1',
          'hosted-workspace-shell/1',
          'hosted-workspace-shell/3',
          'hosted-workspace-shell/4',
        ].includes(session.toolProfile ?? '') ||
          (session.childDepth ?? 0) !== 0 ||
          session.mcp ||
          session.hooks)
      )
        throw new Error('Public Plan mode is unavailable for this Session.');
    } catch {
      return error(res, 400, 'invalid_hosted_approval_selection');
    }
    let modelSelection: HostedModelSelection | undefined;
    try {
      modelSelection = parseHostedModelSelection(body?.['modelSelection']);
    } catch {
      return error(res, 400, 'invalid_hosted_model_selection');
    }
    const workflowLaunch =
      Array.isArray(prompt) && prompt.length === 1
        ? parseHostedWorkflowLaunchBlock(prompt[0])
        : undefined;
    // #13803: a workflow_launch block names work outside any record, so it
    // is admitted only where the control plane's own creation could mint
    // it — a lined child Session at its very first prompt. Its byte-equal
    // replay answers through the ordinary dedup machinery; every other
    // shape keeps the pre-change refusal.
    if (workflowLaunch !== undefined) {
      if (modelSelection !== undefined || approvalSelection !== undefined)
        return error(res, 400, 'invalid_hosted_model_selection');
      const journaledInputs = session.managed.authority
        .eventsInSequenceRange(1, session.managed.authority.committedSequence)
        .filter((event) => event.kind === 'input.accepted');
      if (
        (session.childDepth ?? 0) < 1 ||
        (journaledInputs.length > 0 &&
          !journaledInputs.some(
            (event) => event.payload['inputId'] === promptId,
          ))
      ) {
        return error(res, 400, 'invalid_hosted_prompt');
      }
    }
    let promptInput: ReturnType<typeof parseHostedInput> | undefined;
    try {
      if (workflowLaunch === undefined) promptInput = parseHostedInput(prompt);
    } catch {
      return error(res, 400, 'invalid_hosted_prompt');
    }
    if (
      typeof promptId !== 'string' ||
      !HOSTED_UUID.test(promptId) ||
      !Array.isArray(prompt) ||
      prompt.length === 0 ||
      typeof digest !== 'string' ||
      !DIGEST.test(digest) ||
      (deadlineMs !== undefined &&
        (!Number.isSafeInteger(deadlineMs) ||
          (deadlineMs as number) < 1 ||
          (deadlineMs as number) > 2_147_483_647)) ||
      digest !==
        `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`
    ) {
      return error(res, 400, 'invalid_hosted_prompt');
    }
    // The dispatcher asks for ingest on a fresh submission it hands to this
    // Harness; the pusher then delivers the Turn's events in its place.
    const eventDelivery =
      body?.['eventDelivery'] === undefined
        ? undefined
        : object(body['eventDelivery']);
    const ingestTurnId = eventDelivery?.['turnId'];
    if (
      body?.['eventDelivery'] !== undefined &&
      (eventDelivery?.['mode'] !== 'ingest' ||
        typeof ingestTurnId !== 'string' ||
        ingestTurnId.length === 0 ||
        ingestTurnId.length > 64)
    )
      return error(res, 400, 'invalid_hosted_event_delivery');
    if (eventDelivery && !session.stores)
      return error(res, 409, 'hosted_event_ingest_unavailable');
    // #13803: a workflow child Session's first Turn carries one
    // `workflow_launch` block instead of text; the journal's user record
    // keeps the one-line summary while the full payload rides the input.
    const text = workflowLaunch
      ? workflowLaunchSummaryText(workflowLaunch)
      : promptInput!.text;
    const attachments = (promptInput?.attachments.length ?? 0) > 0;
    const maxBytes = attachments
      ? HOSTED_ATTACHMENT_INPUT_BYTES
      : HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes;
    const maxUserRecordBytes = attachments ? maxBytes + 1024 * 1024 : maxBytes;
    // A parent UUID is the largest possible parentUuid in the durable record.
    const userRecord = record(session, req.params['id'], 'user', promptId, {
      daemonPromptId: promptId,
      message: { role: 'user', parts: promptInput?.parts ?? [{ text }] },
    });
    if (
      Buffer.byteLength(JSON.stringify(prompt)) > maxBytes ||
      Buffer.byteLength(JSON.stringify(userRecord)) > maxUserRecordBytes
    )
      return error(res, 413, 'hosted_prompt_too_large');
    const existing = session.admissions.get(promptId);
    if (existing) {
      if (existing.digest !== digest)
        return error(res, 409, 'hosted_prompt_conflict');
      try {
        if (
          !isDeepStrictEqual(
            await readHostedTurnModelSelection(session.managed, promptId),
            modelSelection,
          ) ||
          !isDeepStrictEqual(
            await readHostedTurnApprovalSelection(session.managed, promptId),
            approvalSelection,
          )
        )
          return error(res, 409, 'hosted_prompt_conflict');
      } catch {
        return error(res, 409, 'hosted_prompt_recovery_required');
      }
      res.status(202).json({
        promptId,
        lastEventId: existing.lastEventId,
        eventEpoch: epoch,
      });
      return;
    }
    if (
      instance?.accepting === false &&
      acceptedInputSequence(session, promptId) === undefined
    )
      return error(res, 409, 'hosted_harness_quiescing');
    if (session.active) return error(res, 409, 'hosted_turn_active');
    // A Hook recovery fence is not terminal: reconcile the pending records
    // once — a non-cancelling poll, so no fenced occurrence re-dispatches —
    // and settle the turn the fence parked before the admission gate reads
    // either, or a Session whose cancel landed mid-evaluation stays blocked
    // for life. The gate re-arms while the Session stays blocked, not only
    // while records are pending: a pass can drain the last record and still
    // miss the settle — the budget or a client disconnect aborts the shared
    // signal between the two, and a concurrent cancel's settle declines
    // while hooksBusy is held — and blocked is written false only inside
    // settleCancelledHookTurn, so the next prompt must retry it. Only a
    // request that passed body validation and missed the idempotent replay
    // pays for the pass, and the pass is bounded and dies with the client,
    // so a stalled Runtime cannot hold the route open. hooksBusy holds a
    // concurrent prompt at the gate for the duration and is released
    // straight into the settle, which re-takes it before its first await.
    if (
      !reconciled &&
      session.hooks &&
      (session.hooks.hasPendingOperations || session.blocked)
    ) {
      const reconcileAbort = new AbortController();
      const budget = setTimeout(
        () =>
          reconcileAbort.abort(
            new Error('The Hook reconciliation deadline expired.'),
          ),
        HOSTED_HOOK_RECONCILE_BUDGET_MS,
      );
      budget.unref();
      const disconnected = () => {
        if (!res.writableEnded)
          reconcileAbort.abort(new Error('The prompting client disconnected.'));
      };
      res.once('close', disconnected);
      void (async () => {
        try {
          // A blocked Session with nothing pending has nothing to
          // reconcile — only a dropped settle to retry.
          if (session.hooks!.hasPendingOperations) {
            session.hooksBusy = true;
            try {
              await session.hooks!.reconcileUnsettled(reconcileAbort.signal);
            } finally {
              session.hooksBusy = false;
            }
          }
          await settleCancelledHookTurn(session, reconcileAbort.signal);
        } catch (cause) {
          writeStderrLineSafe(
            `qwen serve: Hosted Session ${req.params['id']} Hook reconciliation failed: ${String(cause)}`,
          );
        } finally {
          clearTimeout(budget);
          res.off('close', disconnected);
        }
        void admitPrompt(req, res, true);
      })();
      return;
    }
    // Every latch that guards the turn slot, re-runnable as one
    // expression. The wake-park probe below returns to the event loop,
    // and whatever ran meanwhile (the pump's recovery classification, a
    // concurrent admission, a DELETE closing the Session) may flip any
    // of them, so the claim's check-then-set is atomic only against the
    // LAST synchronous evaluation of this exact set: this first call
    // refuses early, the post-probe one is what guards the claim.
    const turnSlotLatch = (): string | undefined => {
      if (compressionBusy(session)) return 'session_context_busy';
      if (session.mcpClosing) return 'hosted_session_closing';
      if (session.hooksBusy) return 'hosted_hook_operation_active';
      if (session.mcpBusy || session.mcpRecovering)
        return 'hosted_mcp_operation_active';
      if (session.active) return 'hosted_turn_active';
      if (
        session.blocked ||
        session.managed.authority.currentActivation?.phase !== 'active' ||
        session.mcp?.hasPendingOperations() ||
        session.hooks?.hasPendingOperations
      )
        return 'hosted_turn_recovery_required';
      return undefined;
    };
    // The single-predicate codes are self-attributing; only the
    // multi-predicate recovery refusal names its sub-cause.
    const refuseTurnSlot = (code: string): void =>
      error(
        res,
        409,
        code,
        code === 'hosted_turn_recovery_required'
          ? hostedTurnBusyReason(session)
          : undefined,
      );
    const latched = turnSlotLatch();
    if (latched !== undefined) return refuseTurnSlot(latched);
    const acceptedSequence = acceptedInputSequence(session, promptId);
    if (acceptedSequence !== undefined) {
      if (!unsettledInputs(session).has(promptId)) {
        // The journal already accepted and settled this prompt — replay is
        // the point of the journal's commandId idempotency, so answer the
        // original admission with the watermark its own Turn flows from
        // (the sequence of input.accepted itself), rather than a
        // hint that loops the destination unboundedly. It is a replay ONLY
        // when the body proves identity: a different payload under an
        // accepted Id is a conflict, not an answer (R9-1).
        const acceptedEvent = session.managed.authority
          .eventsInSequenceRange(1, session.managed.authority.committedSequence)
          .findLast(
            (event) =>
              event.kind === 'input.accepted' &&
              event.payload['inputId'] === promptId,
          );
        const admissionRef = acceptedEvent?.payload['admissionRef'] as
          | ManagedSessionDurableRef
          | undefined;
        if (admissionRef === undefined) {
          res.status(202).json({
            promptId,
            lastEventId: acceptedSequence,
            eventEpoch: epoch,
          });
          return;
        }
        if (admissionRef !== undefined) {
          void (async () => {
            // A detached writer must answer every outcome or the request
            // hangs unhandled: a failed identity read can never certify
            // the replay, so it takes the same retriable refusal as the
            // unsettled duplicate (R9-1's deferred aftermath).
            try {
              const acceptedAdmission = object(
                JSON.parse(
                  (await session.managed.resources.read(admissionRef)).toString(
                    'utf8',
                  ),
                ),
              );
              if (
                acceptedAdmission?.['digest'] !== digest ||
                !isDeepStrictEqual(
                  parseHostedModelSelection(
                    acceptedAdmission['modelSelection'],
                  ),
                  modelSelection,
                ) ||
                !isDeepStrictEqual(
                  parseHostedApprovalSelection(
                    acceptedAdmission?.['approvalSelection'],
                  ),
                  approvalSelection,
                )
              ) {
                if (!res.headersSent) error(res, 409, 'hosted_prompt_conflict');
                return;
              }
              if (!res.headersSent)
                res.status(202).json({
                  promptId,
                  lastEventId: acceptedSequence,
                  eventEpoch: epoch,
                });
            } catch {
              if (!res.headersSent)
                error(res, 409, 'hosted_prompt_recovery_required');
            }
          })();
          return;
        }
      }
      return error(res, 409, 'hosted_prompt_recovery_required');
    }
    // A fresh Turn must not start over the recovered-but-undriven one: it
    // would supersede the checkpoint the takeover just advertised. A Session
    // that never receives continue/cancel is otherwise invisible to oncall.
    if (session.recoveredTurn !== undefined) {
      writeStderrLineSafe(
        `qwen serve: Hosted Harness refused a fresh prompt while recovered Turn ${session.recoveredTurn} is undriven.`,
      );
      return error(res, 409, 'hosted_turn_active');
    }
    // The route's own journal-state guard (R10-2): no admission may stack a
    // fresh promptId on top of a Turn the journal still holds unsettled —
    // submitInput is an unconditional conditional-append, so without this
    // gate an attached-but-parked Session (an inapplicable takeover skips
    // every latch above) would run the new prompt from the parked Turn's
    // mid-flight checkpoint, and its commit would erase that Turn's only
    // checkpoint while two unsettled inputs make every later takeover load
    // fail closed. The code is the SESSION-level wedge, NOT the
    // prompt-scoped one: `hosted_prompt_recovery_required` names exactly
    // one parked prompt (this promptId's own unsettled duplicate, emitter
    // above), because the coordinator proves a lost-reply adoption from it
    // (R11-1); a session-scope refusal must never mint that proof.
    if (unsettledInputs(session).size !== 0)
      return error(
        res,
        409,
        'hosted_turn_recovery_required',
        'inputs_unsettled',
      );
    // A wake turn a crash left parked at await_runtime — not yet settled
    // by the pump behind this load — kills an admitted prompt at "not a
    // model-start phase", post-admission, where the coordinator cannot
    // retry it. Refuse here, pre-admission with the transient-window code:
    // it clears under the pump's own recovery cycle, so the coordinator
    // retries it past the pre-admission budget while the durable
    // `hosted_turn_recovery_required` still meets it. Queued wake inputs
    // never match the checkpoint's turnId, so queuing is untouched.
    if (brokerOptions !== undefined) {
      try {
        if (await hasPendingWakePark(session)) {
          return error(res, 409, 'hosted_turn_recovery_in_progress');
        }
      } catch (cause) {
        // The probe could not prove the checkpoint free: refuse retriably
        // rather than admit against a park it read nothing about.
        writeStderrLineSafe(
          `qwen serve: Hosted prompt of session ${req.params['id']} could not probe a wake park: ${String(cause)}`,
        );
        return error(res, 409, 'hosted_turn_recovery_in_progress');
      }
    }
    // The probe returned to the event loop: the pump's own recovery
    // classification, a concurrent admission, or a DELETE closing the
    // Session may have run meanwhile. Re-run the full latch set —
    // re-reading session.active alone would certify a claim over a
    // Session the probe let wedge — then the journal's own guard; this
    // is what makes the check-then-claim above atomic again.
    const relatched = turnSlotLatch();
    if (relatched !== undefined) return refuseTurnSlot(relatched);
    if (instance?.accepting === false)
      return error(res, 409, 'hosted_harness_quiescing');
    if (unsettledInputs(session).size !== 0)
      return error(
        res,
        409,
        'hosted_turn_recovery_required',
        'inputs_unsettled',
      );
    const abort = new AbortController();
    const deadline =
      deadlineMs === undefined ? null : Date.now() + (deadlineMs as number);
    const timer =
      deadlineMs === undefined
        ? undefined
        : setTimeout(
            () => abort.abort(HOSTED_TURN_DEADLINE),
            deadlineMs as number,
          );
    timer?.unref();
    session.deadlineTimer = timer;
    session.active = { promptId, digest, abort };
    void (async () => {
      // A settled Turn's owed file-history retirement runs at admission,
      // while the busy flag still holds the gate — a retirement deferred
      // past the Turn would let the next admission race the durable marker
      // (and this Turn's first write would block on it). A failure leaves
      // it owed; the finally below retries while the flag still holds.
      const admissionOwed = session.fileHistoryOwed;
      if (admissionOwed !== undefined) {
        try {
          await dropPendingHostedFileHistoryTurn(
            session.managed,
            admissionOwed,
          );
          if (session.fileHistoryOwed === admissionOwed)
            session.fileHistoryOwed = undefined;
        } catch {
          // Left owed: the finally retries it before the busy flag clears.
        }
      }
      let admitted = false;
      let settled = false;
      let turnResult: ChatRecord | undefined;
      const turnResultRecord = (
        state: 'completed' | 'cancelled' | 'error',
        stopReason: string,
      ) =>
        record(session, req.params['id'], 'system', null, {
          subtype: 'turn_result',
          systemPayload: { promptId, state, stopReason, endedAt: Date.now() },
        });
      try {
        // MCP connection and discovery are lazy: the first readiness of a
        // load is where the reinstall cost lands, so measure it once.
        const mcpReadyStart =
          session.mcp && !session.mcpReadyMeasured ? Date.now() : undefined;
        await session.mcp?.ensureReady(abort.signal);
        if (mcpReadyStart !== undefined) {
          session.mcpReadyMeasured = true;
          suspensionStats.mcpReadyMs += Date.now() - mcpReadyStart;
        }
        await session.hooks?.ensureReady(abort.signal);
        abort.signal.throwIfAborted();
        const authority = session.managed.authority;
        const contentRef = await session.managed.resources.publish(
          'managed-input',
          Buffer.from(JSON.stringify(prompt)),
        );
        const admissionRef = await session.managed.resources.publish(
          'managed-admission',
          Buffer.from(
            JSON.stringify({
              promptId,
              digest,
              ...(modelSelection ? { modelSelection } : {}),
              ...(approvalSelection ? { approvalSelection } : {}),
            }),
          ),
        );
        abort.signal.throwIfAborted();
        await authority.submitInput(
          {
            operation: 'submitInput',
            commandId: promptId,
            sessionKey: authority.sessionHeader.sessionKey,
            contentDigest: digest.slice(7),
          },
          {
            inputId: promptId,
            turnId: promptId,
            source: 'hosted-harness',
            contentRef,
            admissionRef,
            deadline,
            wakeReason: 'input',
          },
        );
        admitted = true;
        const lastEventId = authority.committedSequence;
        session.admissions.set(promptId, { digest, lastEventId });
        res.status(202).json({ promptId, lastEventId, eventEpoch: epoch });
        if (typeof ingestTurnId === 'string')
          startHostedEventIngest({
            session,
            sessionId: req.params['id'],
            epoch,
            promptId,
            turnId: ingestTurnId,
            afterSequence: lastEventId,
          });
        turnResult = await executeHostedTurn(
          session,
          req.params['id'],
          cwd,
          promptId,
          text,
          abort,
          brokerOptions,
          undefined,
          (result) => {
            turnResult = result;
          },
          undefined,
          undefined,
          undefined,
          workflowLaunch,
        );
        settled = true;
      } catch (cause) {
        if (monitorWakeNeedsRecovery(cause)) {
          if (admitted) blockOnTurnRecovery(session, promptId, cause);
          else if (!res.headersSent)
            error(res, 503, 'hosted_mcp_recovery_required');
          writeStderrLineSafe(
            `qwen serve: Hosted Harness turn ${promptId} is recovery blocked: ${String(cause.cause)}`,
          );
          return;
        }
        if (admitted && !settled) {
          writeStderrLineSafe(
            `qwen serve: Hosted Harness turn ${promptId} could not finish after admission; retrying settlement: ${String(cause)}`,
          );
          const outcome = settledTurnOutcome(abort);
          const storeFailure =
            outcome.stopReason === 'error'
              ? namedStoreFailure(cause)
              : undefined;
          try {
            await session.managed.sink.write(
              turnResult ??
                turnResultRecord(
                  outcome.state,
                  storeFailure ?? outcome.stopReason,
                ),
            );
          } catch (settleCause) {
            // The settlement write couldn't commit (#13800): keep the named
            // failure for the status surface instead of a bare boolean. The
            // name describes the block, not the turn's outcome, so the outer
            // cause counts even for a cancelled turn, and a settlement write
            // that was the first to meet the store names it too.
            const recordedStopReason = (
              turnResult?.systemPayload as { stopReason?: unknown } | undefined
            )?.['stopReason'];
            const blockStoreFailure =
              namedStoreFailure(cause) ?? namedStoreFailure(settleCause);
            blockRecovery(
              session,
              blockStoreFailure ??
                (recordedStopReason === 'managed_session_store_unavailable'
                  ? 'managed_session_store_unavailable'
                  : undefined),
            );
            writeStderrLineSafe(
              `qwen serve: Hosted Harness turn ${promptId} could not settle: ${String(settleCause)}`,
            );
          }
        }
        if (!res.headersSent)
          error(
            res,
            cause instanceof HostedMcpConnectionQuotaError ? 409 : 503,
            cause instanceof HostedMcpConnectionQuotaError
              ? cause.message
              : 'hosted_prompt_admission_failed',
          );
      } finally {
        if (timer) clearTimeout(timer);
        if (session.deadlineTimer === timer) session.deadlineTimer = undefined;
        // Backstop for the admission-time retirement: it must finish inside
        // the busy flag, before the Session is re-admittable — a fresh
        // prompt meeting the still-pending marker would block with no
        // terminal record, and an unawaited drop would race the next Turn's
        // own commit.
        if (session.fileHistoryOwed !== undefined) {
          const owed = session.fileHistoryOwed;
          try {
            await dropPendingHostedFileHistoryTurn(session.managed, owed);
            if (session.fileHistoryOwed === owed)
              session.fileHistoryOwed = undefined;
          } catch (cause) {
            writeStderrLineSafe(
              `qwen serve: Hosted Harness file-history retirement of settled Turn ${owed} failed; it stays owed: ${String(cause)}`,
            );
          }
        }
        session.active = undefined;
        noteSessionActivity(session);
        // A settled prompt Turn is a natural retry pacing — but only for a
        // lease a terminal route already owes the Broker. A lease a passive
        // takeover merely adopted must stay owed for the next takeover's
        // idempotent re-acquire: a release here would persist RELEASED and
        // wedge every later acquire on runtime_session_not_acquirable, so
        // close() remains its only discharger. Read the owed identity from
        // the flag only, never from this Turn's own broker. A
        // recovery-blocked exit keeps the owed lease held like the
        // continue route does: the parked Turn still owns it, and a
        // release would persist RELEASED, wedging the later takeover's
        // same-identity re-acquire on runtime_session_not_acquirable.
        if (!session.blocked && session.runtimeLeaseOwedByTerminalRoute)
          releaseRecoveredRuntime(session);
      }
    })();
  };
  app.post('/session/:id/prompt', (req, res) => admitPrompt(req, res));
}

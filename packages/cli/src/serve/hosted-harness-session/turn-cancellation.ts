/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import { convertToFunctionErrorResponse } from '@qwen-code/qwen-code-core/core/coreToolScheduler.js';
import { HookEventName } from '@qwen-code/qwen-code-core/hooks/types.js';
import { HTTP_MANAGED_SESSION_STORE_CONTRACT } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import {
  harnessCheckpointIsAgentWait,
  harnessCheckpointIsCommandWait,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-checkpoint.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import {
  type HookExecution,
  parseHookExecution,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-record.js';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import type {
  ManagedSessionDurableRef,
  ManagedSessionEvent,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { Application } from 'express';
import { createHash } from 'node:crypto';
import {
  sanitizeDaemonLogLine,
  writeStderrLineSafe,
} from '../../utils/stdioHelpers.js';
import {
  canSettleHostedFileHistory,
  HOSTED_UUID,
  type HostedFileHistoryRecord,
  readHostedFileHistory,
} from '../hosted-file-history.js';
import { hostedHookOccurrenceId } from '../hosted-hook-session.js';
import { wakeHasPriorAttempt } from '../hosted-monitor-wake.js';
import { answerCommittedTurnCalls } from '../hosted-runtime-recovery.js';
import { resolveHostedAction } from '../hosted-tool-approval.js';
import { hasHostedCleanupDebt } from '../hosted-turn-cleanup.js';
import {
  HostedWorkspaceBroker,
  type HostedWorkspaceBrokerOptions,
} from '../hosted-workspace-broker.js';
import { hostedRuntimeSessionId } from '../hosted-workspace-tool-turn.js';
import { stopPublicChildSource } from './interaction-routes.js';
import { noteSessionActivity } from './lifecycle-routes.js';
import {
  blockRecovery,
  liftRecoveryBlock,
  retryHostedCleanup,
} from './runtime-ownership.js';
import {
  error,
  identity,
  namedStoreFailure,
  object,
  record,
} from './session-http.js';
import type { HostedSession } from './session-state.js';
import { isWakeOwnedInput, unsettledInputs } from './wake-recovery.js';

/**
 * A Hook record the Runtime's own reconcile proved never ran its callback:
 * either the record shows the dispatch never started, or the receipt carries
 * the Runtime's `notStarted` marker, stamped only where the callback
 * provably never ran — the republish of a definitively-ended evaluation (the
 * abandoned arm reconciles to a cancelled record, the over-budget arm to a
 * settled record carrying the timeout outcome) and the pre-dispatch aborts.
 * A measured duration cannot stand in for the marker: it is millisecond wall
 * clock, so a callback dispatched and cancelled or timed out inside its own
 * starting millisecond publishes a receipt byte-identical to a republish,
 * and that receipt must keep certifying real work, not a fence.
 */
async function isSettledHookFence(
  session: HostedSession,
  execution: HookExecution,
): Promise<boolean> {
  if (
    execution.run.state === 'cancelled' &&
    execution.run.execution === 'not_started_proven'
  )
    return true;
  if (execution.resultRef === null || execution.run.execution !== 'settled')
    return false;
  // A result that cannot be read or parsed is no fence: treat it as real
  // work, or one corrupt historical record would fail every recovery pass.
  try {
    const result = object(
      JSON.parse(
        (await session.managed.resources.read(execution.resultRef)).toString(),
      ),
    );
    return result?.['notStarted'] === true;
  } catch {
    return false;
  }
}

// An input that cannot be read or parsed proves nothing about its record:
// skip it — one corrupt resource must not reject the whole pass, and a
// skipped record never counts as a fence, so the fail-closed direction is
// unchanged.
async function readHookInput(
  session: HostedSession,
  ref: ManagedSessionDurableRef,
): Promise<Record<string, unknown> | null> {
  try {
    return object(
      JSON.parse((await session.managed.resources.read(ref)).toString()),
    );
  } catch {
    return null;
  }
}

async function recoverCancelledPreToolHook(
  session: HostedSession,
  promptId: string,
  events: readonly ManagedSessionEvent[],
  signal?: AbortSignal,
): Promise<boolean> {
  const { authority, sink } = session.managed;
  const attempts = new Map<string, unknown>();
  for (const event of events) {
    if (event.kind === 'model.attempt')
      attempts.set(
        event.payload['attemptId'] as string,
        event.payload['state'],
      );
    if (
      event.kind === 'tool.intent' ||
      event.kind === 'tool.receipt' ||
      (event.kind === 'action.changed' &&
        authority.action(event.payload['requestId'] as string)?.state ===
          'requested')
    )
      return false;
  }
  if (
    ![...attempts.values()].includes('output_committed') ||
    [...attempts.values()].some(
      (state) => state !== 'output_committed' && state !== 'abandoned',
    )
  )
    return false;
  const authorization = await authority.harnessRunAuthorization();
  if (
    authorization.status !== 'runnable' ||
    !['before_model', 'model_output_committed'].includes(
      authorization.checkpoint.continuation.phase,
    ) ||
    authorization.checkpoint.tools?.items.length
  )
    return false;
  const history = await readHostedFileHistory(session.managed);
  if (history?.pendingTurn || history?.pendingUndo) return false;
  const current = (await sink.project()).filter(
    (item) => item.daemonPromptId === promptId && item.type !== 'user',
  );
  const [assistant, ...tail] = current;
  if (
    assistant?.type !== 'assistant' ||
    tail.some((item) => item.type !== 'tool_result')
  )
    return false;
  const calls = (assistant.message?.parts ?? []).flatMap((part) =>
    part.functionCall ? [part.functionCall] : [],
  );
  if (
    !calls.length ||
    calls.some((call) => !call.id || !call.name) ||
    new Set(calls.map((call) => call.id)).size !== calls.length
  )
    return false;
  const responded = new Set<string>();
  for (const item of tail) {
    for (const part of item.message?.parts ?? []) {
      const response = part.functionResponse;
      if (
        !response?.id ||
        responded.has(response.id) ||
        !calls.some(
          (call) => call.id === response.id && call.name === response.name,
        )
      )
        return false;
      responded.add(response.id);
    }
  }
  // The occurrence match below is pure arithmetic and decides whether a
  // record can matter at all, so run it before any durable read — otherwise
  // a long-lived Session pays one resources.read per historical settled
  // record on every recovery pass.
  const expected = new Set(
    calls.map((call) =>
      hostedHookOccurrenceId(
        HookEventName.PreToolUse,
        `${promptId}:${call.id}`,
      ),
    ),
  );
  let cancelled = false;
  for (const { record } of authority.extensionRecordsInDomain(
    'hook_execution',
  )) {
    signal?.throwIfAborted();
    const execution = parseHookExecution(record);
    if (
      execution.eventName !== HookEventName.PreToolUse ||
      execution.hookId === '__plan__' ||
      !expected.has(execution.occurrenceId)
    )
      continue;
    if (
      !(
        execution.cancelRequested &&
        execution.run.state === 'cancelled' &&
        execution.run.execution === 'not_started_proven'
      ) &&
      !(await isSettledHookFence(session, execution))
    )
      continue;
    const input = await readHookInput(session, execution.inputRef);
    if (
      input?.['prompt_id'] === promptId &&
      calls.some(
        (call) =>
          input['tool_use_id'] === call.id &&
          input['tool_name'] === call.name &&
          execution.occurrenceId ===
            hostedHookOccurrenceId(
              HookEventName.PreToolUse,
              `${promptId}:${call.id}`,
            ),
      )
    ) {
      cancelled = true;
      break;
    }
  }
  if (!cancelled) return false;
  const missing = calls.filter((call) => !responded.has(call.id!));
  const refusalRecord = (parts: Part[], parentUuid: string) =>
    record(
      session,
      authority.sessionHeader.sessionKey.sessionId,
      'tool_result',
      parentUuid,
      {
        daemonPromptId: promptId,
        model: assistant.model,
        message: { role: 'user', parts },
      },
    );
  let result = refusalRecord([], current.at(-1)!.uuid);
  const maxBytes = HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes;
  for (const part of missing.flatMap((call) =>
    convertToFunctionErrorResponse(
      call.name!,
      call.id!,
      [],
      'The turn was cancelled before this tool call ran.',
    ),
  )) {
    result.message!.parts!.push(part);
    if (Buffer.byteLength(JSON.stringify(result)) <= maxBytes) continue;
    result.message!.parts!.pop();
    if (!result.message!.parts!.length)
      throw new Error(
        'Hosted tool refusal exceeds the inline Session Store limit.',
      );
    await sink.write(result);
    result = refusalRecord([part], result.uuid);
    if (Buffer.byteLength(JSON.stringify(result)) > maxBytes)
      throw new Error(
        'Hosted tool refusal exceeds the inline Session Store limit.',
      );
  }
  if (result.message!.parts!.length) await sink.write(result);
  return true;
}

/**
 * The committed-call fold the recovered Turn's continue and cancel routes
 * run before each terminal record they write. One argument list for every
 * exit: hand-copied lists dropped `commands` on three of them (#13188
 * R13-1), so a member's committed board call was left unpaired instead of
 * answering from its command journal.
 */
export function answerRecoveredTurnCommittedCalls(
  session: HostedSession,
  sessionId: string,
  promptId: string,
): Promise<number> {
  return answerCommittedTurnCalls({
    session: session.managed,
    sessionId,
    cwd: session.cwd,
    promptId,
    children: session.childAgents,
    teams: session.teams,
    messages: session.messages,
    commands: session.commands,
  });
}

// The cancellation-side settle of a provably ownerless parked Turn: the
// LoadHarnessSession.cancellationTakeover signal names the user's CANCEL
// intent, and the load's own writer fence proves the producing generation
// is dead — no execution anywhere can carry it again, so the cancelled
// terminal can only be a journal record, written here through the same
// sink translation the hook settle uses (turn.settled follows from the
// record). On write failure the caller keeps the baseline retriable
// refusal: nothing terminal is claimed about what could not be proven.
export async function settleCancelledHarnessTurn(
  managed: ManagedSession,
  session: HostedSession,
  sessionId: string,
  promptId: string,
): Promise<void> {
  await stopPublicChildSource(session, promptId);
  // A cancelled terminal whose park was an approval wait must close the
  // WAIT first, or the checkpoint dies one phase behind the journal's
  // terminal: the sink only advances next-turn checkpoints at a
  // model-start phase, and the next prompt's harness refuses
  // `await_action is not a model-start phase` (R9-3). The wait's own
  // gate is the sanctioned advance — the decision is the USER's and
  // nothing resumes: the Turn dies immediately after. Only an ENDED
  // record crosses here, exactly the cross-read the caller's gate made;
  // a still-requested wait never reaches this helper through it. A READ
  // FAILURE here is a retriable store fault, not "nothing to close":
  // the caller's gate just proved the park payable, and swallowing the
  // fault as `undefined` minted the cancelled terminal over a wait the
  // fault hid — the very Session whose next prompt then dies on the
  // checkpoint it left behind (R9-5). Let the fault propagate: the
  // caller's own catch answers the baseline retriable refusal, and the
  // store's retry ladder owns the retry.
  const settleAuthorization = await managed.authority.harnessRunAuthorization();
  // Fault-shaped authorizations are not "nothing to close" either
  // (R9-5'): the authority converts a retry-exhausted TransportError
  // into a blocked verdict in place, never as a throw, so the
  // propagation above still settles past it. `missing_state`,
  // `opaque_state` and `invalid_state` all mean this park cannot be
  // proven safe to settle; `missing_checkpoint` stays payable — it is
  // the Arm B park's honest form (a no-tool Session with history
  // provably has no checkpoint), and that arm settles unconditionally.
  if (
    settleAuthorization.status === 'blocked' &&
    settleAuthorization.reason !== 'missing_checkpoint'
  )
    throw new Error(
      `Cancelled settle cannot verify the park (authorization blocked/${settleAuthorization.reason}).`,
    );
  if (
    settleAuthorization?.status === 'runnable' &&
    settleAuthorization.checkpoint.identity.turnId === promptId &&
    settleAuthorization.checkpoint.continuation.phase === 'await_action'
  ) {
    const requestId = settleAuthorization.checkpoint.approval?.requestId;
    const actionState =
      requestId === undefined
        ? undefined
        : session.managed.authority.action(requestId)?.state;
    if (actionState !== undefined && actionState !== 'requested') {
      await createManagedHarnessHandle(managed).resolveDurableWait();
    }
  }
  // A settle that already landed answers idempotently: the coordinator's
  // next paced takeover load may race the stream home (the Turn row
  // stays CANCELLING until the replay lands), and a second write meets
  // the authority's event-id CAS — `event id turn:<id> is already
  // committed` — unless the answer re-reads what is already committed
  // (the terminal event this helper itself just wrote).
  const authority = session.managed.authority;
  const alreadySettled = authority
    .eventsInSequenceRange(1, authority.committedSequence)
    .some(
      (event) =>
        event.kind === 'turn.settled' && event.payload['turnId'] === promptId,
    );
  if (alreadySettled) return;
  // A Turn with no park can still have committed calls it never answered
  // (a team call, a background launch). They get their answers by what
  // committed before the terminal: core's orphan repair would tell the
  // next Turn's model to retry them, and the retry redoes the work.
  await answerCommittedTurnCalls({
    session: managed,
    sessionId,
    cwd: session.cwd,
    promptId,
    children: session.childAgents,
    teams: session.teams,
    messages: session.messages,
    commands: session.commands,
  });
  await managed.sink.write(
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
}

// True when a cancellation takeover may settle this park without ever
// consulting the kernel — the ownerless Turn carries NO unsettled Runtime
// work it could still owe: no checkpoint yet, a bootstrap checkpoint that
// still names no Turn, every tool item settled and consumed, or an
// approval whose durable record already says the wait ended (P1-1/2).
// "Owed work" is read off the work itself, not off whether the checkpoint
// names this Turn: a checkpoint naming an EARLIER Turn whose tools all
// settled and were consumed owes nothing to a cancelled Turn that never
// reached a tool call (R9). A Turn with executions in flight answers
// false: its faithful cancel settlement is the recovery-cancel of the
// kernel's report, not here. Exported for the wedge suite (#13708): the
// agent-wait arm is its deciding line.
export async function parkNeedsNoRuntimeSettlement(
  managed: ManagedSession,
): Promise<boolean> {
  const authorization = await managed.authority.harnessRunAuthorization();
  if (authorization.status === 'initial') return true;
  if (authorization.status !== 'runnable') return false;
  const checkpoint = authorization.checkpoint;
  // A dying Turn parked at an agent wait owes the child runs their
  // settlement: the faithful cancel is the abandoned-wait fold, never a
  // settle that would orphan the ledger.
  if (harnessCheckpointIsAgentWait(checkpoint)) return false;
  // So does one parked at a member's command wait (H4e-b3): only the
  // recovery cancel folds its runs, each answered by its own journal; a
  // plain settle would leave the checkpoint parked and refuse the next
  // Turn's model start.
  if (harnessCheckpointIsCommandWait(checkpoint)) return false;
  if (
    !(checkpoint.tools?.items ?? []).every(
      (item) => item.state === 'settled' && item.consumed,
    )
  )
    return false;
  if (checkpoint.approval !== null) {
    // The stale checkpoint copy says requested; the record decides. A
    // live wait stays out of the separation (the resolve route keeps
    // paying it); any resolved wait only has a cancelled-wait answer on a
    // CANCELLING takeover, decisions included.
    const actionState = managed.authority.action(
      checkpoint.approval.requestId,
    )?.state;
    if (actionState === undefined || actionState === 'requested') return false;
    return true;
  }
  return true;
}

export async function settleCancelledHookTurn(
  session: HostedSession,
  signal?: AbortSignal,
): Promise<void> {
  if (
    !session.blocked ||
    session.active ||
    session.hooksBusy ||
    session.mcpBusy ||
    session.mcpRecovering ||
    !session.hooks ||
    session.hooks.hasPendingOperations
  )
    return;
  session.hooksBusy = true;
  try {
    const { authority } = session.managed;
    const events = authority.eventsInSequenceRange(
      1,
      authority.committedSequence,
    );
    const projected = await session.managed.sink.project(
      authority.committedSequence,
    );
    const pending = new Map<string, number>();
    for (const event of events) {
      // A monitor notification that never ran is nobody's parked turn —
      // but once the wake actually began, its turn parks exactly like a
      // user prompt's, and the cancelled settle owns it the same way.
      if (event.kind === 'input.accepted') {
        const turnId = event.payload['turnId'];
        const queuedOnly =
          isWakeOwnedInput(event) &&
          (typeof turnId !== 'string' ||
            !wakeHasPriorAttempt(projected, turnId));
        if (!queuedOnly && typeof turnId === 'string')
          pending.set(turnId, event.sequence);
      }
      if (event.kind === 'turn.settled')
        pending.delete(event.payload['turnId'] as string);
    }
    if (pending.size !== 1) return;
    const [promptId, sequence] = [...pending][0];
    const turnEvents = events.filter((event) => event.sequence > sequence);
    const preModel = !turnEvents.some(
      (event) =>
        event.kind === 'model.attempt' ||
        event.kind === 'tool.intent' ||
        event.kind === 'tool.receipt' ||
        (event.kind === 'message.committed' &&
          event.payload['role'] !== 'user'),
    );
    const occurrenceIds = new Set([
      hostedHookOccurrenceId(HookEventName.UserPromptSubmit, promptId),
      hostedHookOccurrenceId(
        HookEventName.SessionStart,
        `session-start:${authority.sessionHeader.sessionKey.sessionId}`,
      ),
    ]);
    // A republished InstructionsLoaded evaluation fence can never carry
    // cancelRequested — status() returns a terminal record before the flag
    // could be set — and its occurrence id digests the turn's native fields,
    // which cannot be recomputed here. What identifies it arithmetically is
    // the event log: a record's creation commit carries the record id as its
    // operationId (revisions commit as `${id}:${revision}`), and the fence
    // that parked this turn was created after its input.accepted. Records
    // from earlier turns are excluded before any durable read, so a
    // long-lived Session's historical InstructionsLoaded receipts stay
    // behind the same pre-filter the occurrence match provides.
    const createdInTurn = new Set<string>();
    for (const event of turnEvents) {
      if (
        event.kind !== 'domain.committed' ||
        event.payload['domain'] !== 'hook_execution'
      )
        continue;
      const operationId = event.payload['operationId'];
      if (typeof operationId === 'string' && !operationId.includes(':'))
        createdInTurn.add(operationId);
    }
    let cancelled = false;
    if (preModel)
      for (const { record } of authority.extensionRecordsInDomain(
        'hook_execution',
      )) {
        signal?.throwIfAborted();
        const execution = parseHookExecution(record);
        const instructionsFence =
          execution.eventName === HookEventName.InstructionsLoaded &&
          execution.hookId !== '__plan__' &&
          createdInTurn.has(execution.hookExecutionId);
        if (
          (!occurrenceIds.has(execution.occurrenceId) && !instructionsFence) ||
          !(await isSettledHookFence(session, execution))
        )
          continue;
        const input = await readHookInput(session, execution.inputRef);
        if (input?.['prompt_id'] !== promptId) continue;
        cancelled = true;
        break;
      }
    if (!preModel)
      cancelled = await recoverCancelledPreToolHook(
        session,
        promptId,
        turnEvents,
        signal,
      );
    if (!cancelled) return;
    await session.managed.sink.write(
      record(
        session,
        authority.sessionHeader.sessionKey.sessionId,
        'system',
        null,
        {
          subtype: 'turn_result',
          systemPayload: {
            promptId,
            state: 'cancelled',
            stopReason: 'cancelled',
            endedAt: Date.now(),
          },
        },
      ),
    );
    liftRecoveryBlock(session);
  } finally {
    session.hooksBusy = false;
  }
}

// Projection payability for an inapplicable takeover (R11-2): the kernel
// answered "nothing is owed" because the checkpoint names turn_settled,
// while the journal never landed the terminal record. Return the promptId
// this load must settle itself — the bare branch's exact conditions — or
// null when no route can pay it, so the caller keeps the retriable
// refusal instead of attaching a healthy-looking wedge. A requested
// approval never lands here (its phase is outside the settle set): that
// wait the resolve route pays, so its caller treats null as its own
// answer instead of a refusal.
export async function settleProjectablePromptId(
  managed: ManagedSession,
  session: HostedSession,
  fileHistory: HostedFileHistoryRecord | null | undefined,
  promptId: string,
): Promise<string | null> {
  // Shell-receipt turns settle through recoverShellReceipts, Hooks through
  // their own recovery routes; nothing else projects here (mirroring the
  // bare branch's outer condition).
  if (!session.publication && !session.hooks && !fileHistory) return null;
  if (session.publication || session.hooks) return null;
  const authorization = await managed.authority.harnessRunAuthorization();
  if (authorization.status !== 'runnable') return null;
  const checkpoint = authorization.checkpoint;
  if (checkpoint.identity.promptId !== promptId) return null;
  const phase = checkpoint.continuation.phase;
  if (phase !== 'results_ready' && phase !== 'turn_settled') return null;
  if (
    !checkpoint.tools?.items.every(
      (item) =>
        item.state === 'settled' && (phase === 'turn_settled' || item.consumed),
    )
  )
    return null;
  const current = (await managed.sink.project()).filter(
    (item) => item.daemonPromptId === promptId,
  );
  const lastAssistant = current.findLastIndex(
    (item) => item.type === 'assistant',
  );
  if (lastAssistant < 0) return null;
  if (current.slice(lastAssistant + 1).length !== 0) return null;
  if (
    !current[lastAssistant].message?.parts?.every((part) => !part.functionCall)
  )
    return null;
  if (
    fileHistory &&
    (fileHistory.pendingTurn || fileHistory.pendingUndo) &&
    (await canSettleHostedFileHistory(managed, {
      ...fileHistory,
      pendingTurn: promptId,
      pendingMessageId: current[lastAssistant].uuid,
    })) !== null
  )
    return null;
  return promptId;
}

// The terminal projection an inapplicable takeover needs: exactly what the
// plain load runs when the bare branch computes settlePromptId. On failure
// the Session keeps its latch and the refusal/retry cycle does the rest.
export function runSettleProjection(
  session: HostedSession,
  sessionId: string,
  promptId: string,
  brokerOptions: HostedWorkspaceBrokerOptions | undefined,
  committedModelOutput = false,
): void {
  const abort = new AbortController();
  session.active = { promptId, digest: '', abort };
  void (async () => {
    const harness = createManagedHarnessHandle(session.managed);
    if (committedModelOutput)
      await harness.adoptPreparedContinuation(promptId, true);
    await harness.run(async () => {
      await harness.settleConsumedRuntimeContinuation();
      if (
        brokerOptions &&
        session.toolProfile &&
        !committedModelOutput &&
        !session.hooks &&
        !session.mcp &&
        !hasHostedCleanupDebt(session.managed)
      )
        await new HostedWorkspaceBroker(
          brokerOptions!,
          session.managed.authority.sessionHeader.sessionKey,
          hostedRuntimeSessionId(promptId),
        ).release();
      await session.managed.sink.write(
        record(session, sessionId, 'system', null, {
          subtype: 'turn_result',
          systemPayload: {
            promptId,
            state: 'completed',
            stopReason: 'end_turn',
            endedAt: Date.now(),
          },
        }),
      );
      if (brokerOptions) await retryHostedCleanup(session, brokerOptions);
    });
    liftRecoveryBlock(session);
  })()
    .catch((cause: unknown) => {
      // A projection whose commit met the store names the block the way
      // the turn routes do; a writer conflict or a harness-shape failure
      // leaves it unnamed (#13800 R2-14).
      blockRecovery(session, namedStoreFailure(cause));
      writeStderrLineSafe(
        'qwen serve: Hosted Harness final settlement remained blocked: ' +
          sanitizeDaemonLogLine(String(cause)),
      );
    })
    .finally(() => {
      session.active = undefined;
      noteSessionActivity(session);
    });
}

export function registerHostedCancellationRoutes(
  app: Application,
  sessions: Map<string, HostedSession>,
): void {
  app.post('/session/:id/cancel', async (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    const targetPromptId = object(req.body)?.['promptId'];
    if (targetPromptId !== undefined) {
      if (
        typeof targetPromptId !== 'string' ||
        !HOSTED_UUID.test(targetPromptId)
      )
        return error(res, 400, 'invalid_hosted_cancel');
      const authority = session.managed.authority;
      const events = authority.eventsInSequenceRange(
        1,
        authority.committedSequence,
      );
      if (
        !events.some(
          (event) =>
            event.kind === 'input.accepted' &&
            event.payload['turnId'] === targetPromptId,
        )
      )
        return error(res, 409, 'hosted_cancel_identity_mismatch');
      if (
        events.some(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === targetPromptId,
        )
      ) {
        try {
          await stopPublicChildSource(session, targetPromptId);
        } catch {
          return error(res, 503, 'hosted_cancel_commit_failed');
        }
        res.sendStatus(204);
        return;
      }
      if (session.active?.promptId !== targetPromptId)
        return error(
          res,
          409,
          'hosted_turn_recovery_required',
          'inputs_unsettled',
        );
    }
    // Honest refusal instead of a silent no-op 204 (R10-3): with no live
    // Turn in this process, nothing aborts here, while the journal still
    // holds an input unsettled — a recovered-but-undriven Turn's parked
    // executions settle only through the coordinator's
    // managed-runtime/cancel, and a requested approval whose owner died
    // with its generation keeps waiting on an answer only the streamed
    // replay can surface — so answering 204 would tell the coordinator it
    // cancelled when nothing stopped. A recovery-blocked Session whose
    // Turn already has a terminal record names nothing unsettled and keeps
    // the plain 204: the client's cancel flow hard-requires the 204 before
    // it streams the terminal record, and a definitive refusal would be
    // retried forever. An idle Session keeps the plain 204, and a
    // genuinely active one stays abortable.
    if (session.active === undefined && unsettledInputs(session).size !== 0)
      return error(
        res,
        409,
        'hosted_turn_recovery_required',
        'inputs_unsettled',
      );
    if (session.active) {
      const active = session.active;
      if (session.publicChildAgentsVersion !== 1) active.abort.abort();
      const promptId = active.promptId;
      const authority = session.managed.authority;
      const commandId = `hosted-cancel:${promptId}`;
      try {
        const commitCancel = () =>
          authority.appendExecutionEvent(
            {
              operation: 'requestCancel',
              commandId,
              sessionKey: authority.sessionHeader.sessionKey,
              contentDigest: createHash('sha256')
                .update(promptId)
                .digest('hex'),
            },
            (sequence) => ({
              v: 1,
              sequence,
              eventId: commandId,
              sessionKey: authority.sessionHeader.sessionKey,
              kind: 'cancel.requested',
              occurredAt: Date.now(),
              payload: {
                requestId: commandId,
                target: { turnId: promptId },
                reason: 'user',
                requestedBy: 'hosted',
              },
            }),
            { class: 'trusted_entry' },
          );
        if (session.publicChildAgentsVersion === 1) {
          await stopPublicChildSource(session, promptId);
        } else {
          await commitCancel();
        }
      } catch {
        return error(res, 503, 'hosted_cancel_commit_failed');
      }
    }
    res.sendStatus(204);
  });
  app.post('/session/:id/actions/:requestId/resolve', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    const requestId = req.params['requestId'];
    void resolveHostedAction(
      session.managed,
      session.waiters,
      requestId,
      req.body,
      () => session.blocked,
    ).then(
      (result) =>
        result.status === 200
          ? res.json(result.body)
          : error(res, result.status, result.code, result.reason),
      (cause) => {
        // This answer recorded nothing, so a retry is safe.
        writeStderrLineSafe(
          `qwen serve: Hosted Action ${requestId} could not be resolved: ${String(cause)}`,
        );
        error(res, 503, 'action_resolution_failed');
      },
    );
  });
}

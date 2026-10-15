/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Part } from '@google/genai';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { ManagedSessionConflictError } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import type {
  HarnessAgentWaitRun,
  HarnessCommandWaitRun,
  HarnessRunAuthorization,
  HarnessToolItem,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-checkpoint.js';
import {
  HARNESS_MODEL_START_PHASES,
  harnessCheckpointIsAgentWait,
  harnessCheckpointIsCommandWait,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-checkpoint.js';
import { managedChildTaskId } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-projection.js';
import {
  assertManagedSessionStableId,
  type ManagedSessionDurableRef,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import {
  convertToFunctionErrorResponse,
  convertToFunctionResponse,
} from '@qwen-code/qwen-code-core/core/coreToolScheduler.js';
import { HTTP_MANAGED_SESSION_STORE_CONTRACT } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import type { ManagedToolResultPayload } from './managed-runtime-tool-executor.js';
import {
  childRunEndedText,
  childWorkspaceAnswerSuffix,
  type HostedChildAgentSession,
} from './hosted-child-agent-session.js';
import type { HostedSessionMessageSession } from './hosted-session-message-session.js';
import {
  HOSTED_SKILL_APPROVAL_REFUSAL,
  HOSTED_SKILL_BATCH_REFUSAL,
  type HostedSkillCatalog,
} from './hosted-skill-catalog.js';
import {
  hostedHookOccurrenceId,
  HostedHookRecoveryRequiredError,
  type HostedHookSession,
} from './hosted-hook-session.js';
import { parseHookExecution } from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-record.js';
import {
  HookEventName,
  PreToolUseHookOutput,
  type HookOutput,
} from '@qwen-code/qwen-code-core/hooks/types.js';
import {
  sessionCommandEvidenceText,
  type HostedSessionCommandSession,
} from './hosted-session-command-session.js';
import { sessionMessageId } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-message-operations.js';
import { sessionCommandId } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-command-operations.js';
import {
  HOSTED_TEAM_TOOL_NAMES,
  type HostedTeamSession,
} from './hosted-team-session.js';
import {
  fitChildResultInline,
  HOSTED_AGENT_CALL_NOT_REACHED_TEXT,
  HOSTED_AGENT_WAIT_ABANDONED_TEXT,
  hostedChildBackgroundStartedText,
  hostedBroadcastCommitted,
  hostedChildRunIdFor,
  hostedMessageToChildText,
  HOSTED_MESSAGE_TO_PARENT_TEXT,
  hostedRouteAnswer,
  hostedTeamJoinedText,
  hostedRuntimeSessionId,
  journaledToolResultIds,
  truncateHostedGlobResponse,
} from './hosted-workspace-tool-turn.js';
import { parseTeamState } from '@qwen-code/qwen-code-core/managed-runtime/managed-team-record.js';
import {
  HostedChildChains,
  hostedPromptKey,
  hostedMemberView,
  hostedRouteDetails,
  isEndedMember,
} from './hosted-member-chain.js';
import {
  endHostedAction,
  readHostedActionOptions,
} from './hosted-tool-approval.js';
import { writeStderrLineSafe } from '../utils/stdioHelpers.js';
import {
  commitHostedFileHistory,
  readHostedFileHistory,
} from './hosted-file-history.js';
import {
  HostedWorkspaceBroker,
  type HostedWorkspaceBrokerOptions,
} from './hosted-workspace-broker.js';

/** The parked turn is not one this recovery can drive; the caller 409s. */
export class RecoveryDeclined extends Error {}

/** The states a recovery report may advertise: exactly the vocabulary the
 * hosted client's validator accepts (HostedHarnessClient's
 * RUNTIME_EXECUTION_STATES). The broker's wider union folds into it at the
 * report boundary — a still-reconcilable `unknown` becomes outcome
 * `unknown` with no status, so the compiler rejects any new broker state
 * that nobody folded deliberately. */
export type HostedRuntimeRecoveryExecutionState =
  | 'prepared'
  | 'executing'
  | 'cancel_requested'
  | 'settled'
  | 'abandoned';

export interface HostedRuntimeRecoveryExecution {
  functionCallId: string;
  toolName: string;
  executionCallId: string;
  runtimeSessionId: string;
  outcome: 'known' | 'unknown';
  status?: { state: HostedRuntimeRecoveryExecutionState };
}

export interface HostedRuntimeRecoveryReport {
  phase: 'await_runtime' | 'await_agent' | 'await_command' | 'results_ready';
  checkpointId: string;
  activationId: string;
  executions: HostedRuntimeRecoveryExecution[];
}

export type HostedRecoveryTurn = {
  promptId: string;
  report: HostedRuntimeRecoveryReport;
  /** Whether the coordinator can still drive this report: every execution
   * reads known, and a drive report reached results_ready. The takeover
   * arms the undriven marker only in that case, since the coordinator fails
   * an undrivable one without ever calling continue/cancel. */
  drivable: boolean;
} &
  // Whether the recovery acquired the Runtime Session, which a later
  // continue/cancel must release; an acquired lease carries the Broker
  // identity its handback needs.
  (| { acquiredRuntime: false }
    | { acquiredRuntime: true; runtimeSessionId: string }
  );

/**
 * Why a takeover load cannot continue the parked Turn. Every reason is a
 * deterministic function of the durable journal: retrying the load will
 * never change it, so the caller answers a typed terminal refusal instead
 * of the retriable `hosted_turn_recovery_required`.
 */
export type HostedRecoveryDeclineReason =
  /** The parked Turn waits on an approval that died with the owner. */
  | 'await_action'
  /** Parked at a model start phase (first model round or a no-tool Turn). */
  | 'model_start'
  /** A Shell execution was in flight; its drives cannot be rebuilt. */
  | 'shell_in_flight'
  /** A batch was prepared but its arguments never became durable. */
  | 'batch_not_durable'
  /** Settled in the journal, terminal record unprojected (Step 3 row). */
  | 'turn_settled'
  /** The checkpoint's durable bytes fail the parse/identity verdict. */
  | 'checkpoint_blocked'
  /** The recovered state still does not authorize this Turn. */
  | 'unresolved_after_settle';

export type HostedRuntimeRecoveryOutcome =
  | { readonly kind: 'recovered'; readonly turn: HostedRecoveryTurn }
  | { readonly kind: 'declined'; readonly reason: HostedRecoveryDeclineReason }
  /** No Runtime work a takeover owes this payload: a wait someone else
   * owns (a user approval, a model round), or a cancellation-only load
   * whose Turn needs no Runtime bookkeeping. The route answers the plain
   * attach — exactly the pre-G3 behavior for these shapes. */
  | { readonly kind: 'inapplicable' };

function declined(
  reason: HostedRecoveryDeclineReason,
): HostedRuntimeRecoveryOutcome {
  return { kind: 'declined', reason };
}

function recovered(turn: HostedRecoveryTurn): HostedRuntimeRecoveryOutcome {
  return { kind: 'recovered', turn };
}

function inapplicable(): HostedRuntimeRecoveryOutcome {
  return { kind: 'inapplicable' };
}

/** A `blocked` authorization splits into durable parse/identity verdicts
 * and erased store-call failures. `missing_checkpoint` is always durable
 * (continuation without a checkpoint, or no checkpoint committed).
 * `missing_state` splits: durable when the staged bytes are truly absent
 * (authority returns the reason alone), erased when a 429/500/503/timeout
 * read of the staged bytes was caught as `ManagedSessionRecordError` — the
 * authority records that error's message, so the message field is the
 * discriminator. Anything not in the durable set is not proven durable and
 * must NOT end a Turn: the caller throws and keeps its retriable refusal. */
export function isDurableBlockedVerdict(
  authorization: Extract<HarnessRunAuthorization, { status: 'blocked' }>,
): boolean {
  return (
    authorization.reason === 'opaque_state' ||
    authorization.reason === 'invalid_state' ||
    authorization.reason === 'identity_mismatch' ||
    authorization.reason === 'missing_checkpoint' ||
    (authorization.reason === 'missing_state' &&
      authorization.message === undefined)
  );
}

function isTransientStoreBlock(
  authorization: Extract<HarnessRunAuthorization, { status: 'blocked' }>,
): boolean {
  return (
    authorization.reason === 'missing_state' &&
    authorization.message !== undefined
  );
}

export async function originalRuntimeBroker(
  session: ManagedSession,
  promptId: string,
  items: readonly HarnessToolItem[],
  options: HostedWorkspaceBrokerOptions,
): Promise<HostedWorkspaceBroker> {
  const owners = new Set<string>();
  const intents = new Map(
    session.authority
      .eventsInSequenceRange(1, session.authority.committedSequence)
      .filter((event) => event.kind === 'tool.intent')
      .map((event) => [
        event.payload['executionCallId'],
        event.payload['argsRef'],
      ]),
  );
  for (const item of items) {
    if (item.outcomeSource !== 'runtime') continue;
    const ref = intents.get(item.executionCallId) as
      | ManagedSessionDurableRef
      | undefined;
    if (!ref) throw new RecoveryDeclined();
    if (
      ref.kind === 'managed-tool-args' &&
      item.toolName === 'run_shell_command'
    ) {
      const definition = JSON.parse(
        (
          await session.resources.read(
            session.authority.sessionHeader.definitionRef,
          )
        ).toString('utf8'),
      ) as { hookCatalog?: unknown; mcpServers?: unknown };
      if (definition.hookCatalog || definition.mcpServers)
        throw new RecoveryDeclined();
      owners.add(hostedRuntimeSessionId(promptId));
      continue;
    }
    if (ref.kind !== 'managed-tool-input') throw new RecoveryDeclined();
    const route = JSON.parse(
      (await session.resources.read(ref)).toString('utf8'),
    ) as { harnessSessionId?: unknown; runtimeSessionId?: unknown };
    if (
      route.harnessSessionId !==
        session.authority.sessionHeader.sessionKey.sessionId ||
      typeof route.runtimeSessionId !== 'string'
    )
      throw new RecoveryDeclined();
    owners.add(
      assertManagedSessionStableId(
        route.runtimeSessionId,
        'recovered Runtime owner',
      ),
    );
  }
  const [runtimeSessionId] = owners;
  if (owners.size !== 1 || !runtimeSessionId) throw new RecoveryDeclined();
  return new HostedWorkspaceBroker(
    options,
    session.authority.sessionHeader.sessionKey,
    runtimeSessionId,
  );
}

function toolResultParts(
  item: HarnessToolItem,
  result: ManagedToolResultPayload,
): Part[] {
  const responseParts = result.responseParts as Part[];
  if (
    responseParts.some(
      (part) =>
        !part ||
        typeof part !== 'object' ||
        (typeof part.text !== 'string' && !part.inlineData && !part.fileData),
    )
  )
    throw new Error('Runtime returned an unsupported tool result.');
  const converted =
    result.executionStatus === 'success'
      ? convertToFunctionResponse(item.toolName, item.functionCallId, [
          ...responseParts,
        ])
      : convertToFunctionErrorResponse(
          item.toolName,
          item.functionCallId,
          [...responseParts],
          result.error?.message ?? `Runtime tool ${result.executionStatus}.`,
        );
  const response = converted[0]?.functionResponse;
  if (!response || converted.length !== 1)
    throw new Error('Runtime result cannot be represented durably.');
  response.response = {
    ...response.response,
    executionStatus: result.executionStatus,
    ...(result.error ? { runtimeError: result.error } : {}),
  };
  return converted;
}

function outcomeBytes(item: HarnessToolItem, parts: Part[]): Buffer {
  return Buffer.from(
    JSON.stringify({ executionCallId: item.executionCallId, ...parts[0] }),
  );
}

/**
 * Settles every parked Runtime execution of a cancelled turn with a cancelled
 * outcome, so the checkpoint can leave `await_runtime` and the following
 * terminal record can advance the session to a model-start phase.
 *
 * The report distinguishes the three exits a caller must not conflate:
 * `settled` journaled the parked executions; `noop` was a legitimate
 * idempotent retry — the checkpoint no longer names the Turn or nothing
 * parked remains, either way the settle's work is already done;
 * `not-runnable` could not even verify the park (the authorization read
 * came back blocked), so nothing was journaled and the caller must treat
 * the settle as a retry-inviting failure, never as a completed one.
 */
export async function settleParkedTurnCancelled(input: {
  session: ManagedSession;
  sessionId: string;
  cwd: string;
  promptId: string;
  /** Executions the stop step accepted on the Broker's terminal fence alone
   * — no stop was ever observed for them, so they journal an honest
   * unobservable outcome instead of a cancellation nobody witnessed. */
  unobserved?: ReadonlySet<string>;
}): Promise<'settled' | 'noop' | 'not-runnable'> {
  const authorization = await input.session.authority.harnessRunAuthorization();
  if (authorization.status !== 'runnable') return 'not-runnable';
  const checkpoint = authorization.checkpoint;
  if (checkpoint.identity.turnId !== input.promptId) return 'noop';
  const pending = (checkpoint.tools?.items ?? []).filter(
    (item) => item.state === 'in_progress' && item.outcomeSource === 'runtime',
  );
  if (pending.length === 0) return 'noop';
  const harness = createManagedHarnessHandle(input.session);
  // A write-then-resolve crash window must not journal a tool_result twice
  // when the cancel retries: collect what is already durable. The durable
  // parts also pin the outcome a compensating retry publishes — a record
  // reclaimed between attempts reads as already-stopped to the fresh stop,
  // so recomputing from this attempt's Broker reads would flip an honestly
  // unobserved outcome into a witnessed cancellation that contradicts the
  // journal the checkpoint points at.
  const journaled = new Map<string, Part[]>();
  for (const entry of await input.session.sink.project()) {
    if (entry.daemonPromptId !== input.promptId || entry.type !== 'tool_result')
      continue;
    for (const part of entry.message?.parts ?? []) {
      const id = part.functionResponse?.id;
      if (typeof id === 'string') journaled.set(id, [part]);
    }
  }
  for (const item of pending) {
    let parts = journaled.get(item.functionCallId);
    if (parts === undefined) {
      const observed = !input.unobserved?.has(item.executionCallId);
      parts = convertToFunctionErrorResponse(
        item.toolName,
        item.functionCallId,
        [],
        observed
          ? 'The Runtime execution was cancelled with its owner.'
          : "The Runtime execution's outcome could not be observed: the Broker fenced the record after losing its owner.",
      );
      const response = parts[0]?.functionResponse;
      if (!response || parts.length !== 1) {
        throw new Error('Runtime result cannot be represented durably.');
      }
      response.response = {
        ...response.response,
        executionStatus: observed ? 'cancelled' : 'unknown',
      };
    }
    const outcomeRef = await input.session.resources.publish(
      'managed-tool-outcome',
      outcomeBytes(item, parts),
    );
    // The assistant's functionCall must meet its functionResponse in the next
    // turn's history, or providers reject the request as malformed.
    if (!journaled.has(item.functionCallId)) {
      await input.session.sink.write({
        uuid: randomUUID(),
        parentUuid: item.modelMessageId,
        sessionId: input.sessionId,
        timestamp: new Date().toISOString(),
        type: 'tool_result',
        cwd: input.cwd,
        version: 'hosted-harness/1',
        daemonPromptId: input.promptId,
        message: { role: 'user', parts },
      });
    }
    await harness.resolveAwaitRuntime(item.executionCallId, outcomeRef);
  }
  return 'settled';
}

/**
 * Best-effort stop for the parked executions of a recovered cancellation.
 * A cancellation only becomes durable evidence after the execution reaches a
 * terminal state — issuing cancel is not proof, since the Broker accepts a
 * cancel without having stopped anything yet. An execution the Broker never
 * knew (definitive not-found) is already stopped. A terminally abandoned
 * record is accepted without proof of a stop: the Broker fenced it
 * permanently on loss evidence, so neither cancel nor the terminal poll
 * could ever observe more — a still-reconcilable unknown fails closed
 * instead.
 */
export async function stopParkedRuntimeExecutions(input: {
  session: ManagedSession;
  promptId: string;
  brokerOptions: HostedWorkspaceBrokerOptions;
  /** Caller-owned accumulator the counted ids land in as they are counted,
   * so an attempt that throws mid-stop still carries them — a retried stop
   * reads a reclaimed record as already-stopped, and without the carry the
   * retry would certify the stop nobody observed. */
  carryUnobservedInto?: Set<string>;
}): Promise<{
  broker: HostedWorkspaceBroker;
  /** Executions accepted as complete only because the Broker fenced the
   * record terminally: no stop was observed for these, so the caller must
   * not journal them as cancelled. */
  unobserved: Set<string>;
}> {
  const authorization = await input.session.authority.harnessRunAuthorization();
  if (
    authorization.status !== 'runnable' ||
    authorization.checkpoint.identity.turnId !== input.promptId
  )
    throw new RecoveryDeclined();
  const broker = await originalRuntimeBroker(
    input.session,
    input.promptId,
    authorization.checkpoint.tools?.items ?? [],
    input.brokerOptions,
  );
  // Terminal for the pre-cancel skip — an execution the Broker never knew
  // (a definitive not-found) is already stopped, and a settled result is
  // durable. A permanently fenced record ends the wait too, but the stop
  // was never observed for it, so it is reported separately rather than
  // certified. The post-cancel poll shares only the `settled` half: a
  // record that vanishes after the cancel was issued is one the Broker
  // provably knew one read earlier, so it joins the fenced executions in
  // the unobserved set instead of being certified as a witnessed stop.
  const stopComplete = (state: { state: string } | undefined): boolean =>
    state === undefined || state.state === 'settled';
  const unobserved = input.carryUnobservedInto ?? new Set<string>();
  for (const item of authorization.checkpoint.tools?.items ?? []) {
    if (item.state !== 'in_progress' || item.outcomeSource !== 'runtime')
      continue;
    // A faulting read observed nothing, so the id rides the carry across
    // the throw — the retry would otherwise read the reclaimed record as
    // already-stopped and certify the stop nobody observed.
    let before: { state: string } | undefined;
    try {
      before = await broker.status(item.executionCallId);
    } catch (cause) {
      unobserved.add(item.executionCallId);
      throw cause;
    }
    if (before?.state === 'unknown') {
      unobserved.add(item.executionCallId);
      throw new Error('Runtime execution outcome is unknown.');
    }
    if (before?.state === 'abandoned') {
      unobserved.add(item.executionCallId);
      continue;
    }
    if (stopComplete(before)) {
      // A positive witness drops an id a transient fault counted on an
      // earlier attempt; a not-found read is no witness (see above).
      if (before?.state === 'settled') unobserved.delete(item.executionCallId);
      continue;
    }
    await broker.cancel(item.executionCallId).catch(() => undefined);
    const deadline = Date.now() + 30_000;
    for (;;) {
      let status: { state: string } | undefined;
      try {
        status = await broker.status(item.executionCallId);
      } catch (cause) {
        unobserved.add(item.executionCallId);
        throw cause;
      }
      if (status?.state === 'unknown') {
        unobserved.add(item.executionCallId);
        throw new Error('Runtime execution outcome is unknown.');
      }
      if (status === undefined || status.state === 'abandoned') {
        unobserved.add(item.executionCallId);
        break;
      }
      if (status.state === 'settled') {
        unobserved.delete(item.executionCallId);
        break;
      }
      if (Date.now() >= deadline) {
        unobserved.add(item.executionCallId);
        throw new Error(
          'Runtime execution did not reach a terminal state after cancellation.',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return { broker, unobserved };
}

/** The Runtime-facing verdict for an interrupted Turn. */
export type HostedInterruptedTurnRuntime =
  /** Nothing left to stop or settle; the caller's terminal record may land. */
  | { readonly kind: 'ready'; readonly broker?: HostedWorkspaceBroker }
  /**
   * A durable approval owns the wait. It outlives its owner only as long
   * as its own resolve route stays usable, so the caller must neither
   * settle the Turn over it nor block the Session — the parked approval
   * decides it.
   */
  | { readonly kind: 'held' };

/**
 * Answers every functionCall the dead Turn still owes with a cancelled
 * functionResponse: its assistant message is durable, and a resumed
 * thread carrying a dangling call is a malformed request the provider
 * rejects. Retry-safe — the answered set is re-derived from the journal
 * on every attempt, exactly like the parked-Runtime counterpart above.
 * A call that committed anything is answered by what committed. One that
 * committed nothing is answered as never run (`uncommitted: 'all'`), only
 * when it is a team or agent call no Runtime settlement answers
 * (`'hosted'`), or left as it was (`'none'`).
 */
async function answerAbandonedTurnCalls(input: {
  session: ManagedSession;
  sessionId: string;
  cwd: string;
  promptId: string;
  message: string;
  uncommitted?: 'all' | 'hosted' | 'none';
  children?: HostedChildAgentSession;
  teams?: HostedTeamSession;
  messages?: HostedSessionMessageSession;
  /** Calls whose Runtime stop was never observed answer with the honest
   * unobservable outcome the parked-Runtime settle journals for them —
   * never a cancellation nobody witnessed. */
  unobserved?: ReadonlySet<string>;
  commands?: HostedSessionCommandSession;
  skills?: HostedSkillCatalog;
  hooks?: HostedHookSession;
  /** A journal projection the caller already holds: one snapshot serves
   * the caller's classification and this answering pass instead of two
   * full walks of the committed events (the settle's projection walk). */
  projected?: Awaited<ReturnType<ManagedSession['sink']['project']>>;
}): Promise<number> {
  const uncommitted = input.uncommitted ?? 'all';
  const records = (
    input.projected ?? (await input.session.sink.project())
  ).filter((entry) => entry.daemonPromptId === input.promptId);
  // One authority for the exactly-once predicate: the same helper every
  // replayed fold rides, fed the projection already in hand.
  const answered = await journaledToolResultIds(
    input.session,
    input.promptId,
    records,
  );
  const owed = new Map<
    string,
    { name: string; messageId: string; args: unknown; mixedSkillBatch: boolean }
  >();
  for (const record of records.filter((entry) => entry.type === 'assistant')) {
    const parts = record.message?.parts ?? [];
    const mixedSkillBatch = parts.some(
      (part) => part.functionCall && part.functionCall.name !== 'skill',
    );
    for (const part of parts) {
      const call = part.functionCall;
      if (call?.id && call.name && !answered.has(call.id) && !owed.has(call.id))
        owed.set(call.id, {
          name: call.name,
          messageId: record.uuid,
          args: call.args ?? {},
          mixedSkillBatch,
        });
    }
  }
  let answeredNow = 0;
  for (const [functionCallId, call] of owed) {
    const callKey = hostedChildRunIdFor(input.promptId, functionCallId);
    // A background launch and a team tool write only to the journal, before
    // their answers: what committed is answered as committed, never as a
    // call that never ran.
    const launched =
      call.name === 'agent' || call.name === 'workflow'
        ? input.children?.record(callKey)
        : undefined;
    const sent =
      call.name === 'send_message'
        ? sentMessageText(input, functionCallId, callKey)
        : undefined;
    const planDecision =
      call.name === 'team_plan_approval'
        ? await input.teams?.planDecisionEvidence(callKey)
        : undefined;
    // A member's board call shares the team tools' names, but once its
    // outbound committed (H4e-b3) it is a command: answered by its own
    // journal, never as a call that never ran — that would leave the
    // entry live for the relay to deliver after the Turn gave it up.
    const commandId =
      input.commands === undefined
        ? undefined
        : sessionCommandId({
            senderSessionId:
              input.session.authority.sessionHeader.sessionKey.sessionId,
            promptKey: hostedPromptKey(input.promptId),
            callId: functionCallId,
          });
    let parts: Part[];
    if (uncommitted === 'hosted' && call.name === 'skill' && input.skills) {
      parts = await hostedSkillResponse(
        input.session,
        input.skills,
        input.promptId,
        functionCallId,
        call.args,
        call.mixedSkillBatch,
        input.hooks,
      );
    } else if (planDecision !== undefined) {
      parts = convertToFunctionResponse(call.name, functionCallId, [
        { text: planDecision },
      ]);
    } else if (
      commandId !== undefined &&
      input.commands!.command(commandId) !== undefined
    ) {
      parts = await sessionCommandJournalAnswer(input.commands!, {
        commandId,
        functionCallId,
        toolName: call.name,
      });
    } else if (sent !== undefined) {
      parts = convertToFunctionResponse(call.name, functionCallId, [
        { text: sent },
      ]);
    } else if (launched?.completion === 'sent') {
      const member = input.teams?.membership(callKey);
      parts = convertToFunctionResponse(call.name, functionCallId, [
        {
          text:
            hostedChildBackgroundStartedText(
              launched.kind,
              managedChildTaskId(
                input.session.authority.sessionHeader.sessionKey.sessionId,
                launched.run.executionCallId ?? callKey,
              ),
            ) + (member === undefined ? '' : hostedTeamJoinedText(member)),
        },
      ]);
    } else {
      const committed =
        input.teams !== undefined &&
        HOSTED_TEAM_TOOL_NAMES.includes(call.name) &&
        input.teams.committedBy(call.name, callKey);
      if (
        !committed &&
        (uncommitted === 'none' ||
          (uncommitted === 'hosted' &&
            !HOSTED_TEAM_TOOL_NAMES.includes(call.name) &&
            call.name !== 'team_plan_approval' &&
            call.name !== 'send_message' &&
            !(
              (call.name === 'agent' || call.name === 'workflow') &&
              launched === undefined
            )))
      )
        continue;
      // A call whose Runtime stop was never observed answers with the
      // honest unobservable outcome, never a cancellation nobody witnessed.
      const observed = !input.unobserved?.has(functionCallId);
      parts = convertToFunctionErrorResponse(
        call.name,
        functionCallId,
        [],
        !observed
          ? "The Runtime execution's outcome could not be observed: the Broker fenced the record after losing its owner."
          : committed
            ? `The turn was interrupted after this call committed its team change, in full or in part (${input.message}); read task_list before retrying it.`
            : `The tool call never ran: ${input.message}.`,
      );
      const response = parts[0]?.functionResponse;
      if (!response || parts.length !== 1)
        throw new Error('Runtime result cannot be represented durably.');
      response.response = {
        ...response.response,
        executionStatus: observed ? 'cancelled' : 'unknown',
      };
    }
    await input.session.sink.write({
      uuid: randomUUID(),
      parentUuid: call.messageId,
      sessionId: input.sessionId,
      timestamp: new Date().toISOString(),
      type: 'tool_result',
      cwd: input.cwd,
      version: 'hosted-harness/1',
      daemonPromptId: input.promptId,
      message: { role: 'user', parts },
    });
    answeredNow += 1;
  }
  return answeredNow;
}

/**
 * H4d-b: the answer a send_message call earned when it committed — its
 * outbox entry, or the continuation it launched for a completed child —
 * or undefined when it committed nothing. H4e-b2 names a member and tells
 * a run that proved it never started since, and answers a broadcast by
 * the recipients it committed (decision 9).
 */
function sentMessageText(
  input: {
    session: ManagedSession;
    promptId: string;
    children?: HostedChildAgentSession;
    messages?: HostedSessionMessageSession;
  },
  callId: string,
  callKey: string,
): string | undefined {
  const message = input.messages?.message(
    sessionMessageId({
      senderSessionId:
        input.session.authority.sessionHeader.sessionKey.sessionId,
      turnId: input.promptId,
      callId,
    }),
  );
  if (message?.direction === 'outbound') {
    if (message.route === 'to_parent') return HOSTED_MESSAGE_TO_PARENT_TEXT;
    if (input.children === undefined)
      return hostedMessageToChildText(message.childRunId);
    const sent = { kind: 'message', childRunId: message.childRunId } as const;
    return hostedRouteAnswer(input.children, {
      ...sent,
      ...hostedRouteDetails(input.session.authority, sent, message.messageId),
    });
  }
  const continued = input.children?.record(callKey);
  if (continued?.predecessorChildRunId) {
    const sent = {
      kind: 'continuation',
      childRunId: continued.childRunId,
      predecessorChildRunId: continued.predecessorChildRunId,
    } as const;
    return hostedRouteAnswer(input.children!, {
      ...sent,
      ...hostedRouteDetails(input.session.authority, sent),
    });
  }
  // H4e-b2 decision 9: a broadcast commits each recipient under its own
  // position's ids. Every position is probed whatever the journaled
  // arguments say, since a hook may have rewritten the input that ran.
  if (input.children === undefined) return undefined;
  const reached = hostedBroadcastCommitted({
    authority: input.session.authority,
    children: input.children,
    messages: input.messages,
    senderSessionId: input.session.authority.sessionHeader.sessionKey.sessionId,
    promptId: input.promptId,
    callId,
  });
  if (reached.length === 0) return undefined;
  const team = input.session.authority
    .extensionRecordsInDomain('team_state')
    .map((entry) => parseTeamState(entry.record))
    .find((each) => each.lifecycle !== 'deleted');
  const lines = reached
    .map(
      (each) => `- ${each.name ?? `position ${each.position}`}: ${each.text}`,
    )
    .join('\n');
  const arrived = reached.filter((each) => each.arrived).length;
  const head = `The broadcast was interrupted after it was sent to ${reached.length} member${reached.length === 1 ? '' : 's'}${arrived > 0 ? '; do not send it again to the members it reached' : ''}.`;
  // The batch rule keeps the roster the broadcast read; a team deleted or
  // replaced since leaves no roster to tell the rest by, as a live replay
  // finds (decision 9).
  if (
    team === undefined ||
    reached.some(
      (each) =>
        team.members[each.position - 1]?.childRunId !== each.rootChildRunId,
    )
  )
    return `${head} Its team has changed since, so nothing tells who else it was meant for.\n${lines}`;
  const chains = new HostedChildChains(
    input.session.authority.extensionRecordsInDomain('child_run'),
  );
  // A member the call never committed a send to, or whose send reached a
  // run that never started, did not get it; one that has ended since
  // cannot take it by name either.
  const missed: string[] = [];
  const ended: string[] = [];
  const settling: string[] = [];
  const stopping: string[] = [];
  const unconfirmed: string[] = [];
  for (const [index, member] of team.members.entries()) {
    const committed = reached.find((each) => each.position === index + 1);
    if (committed?.arrived) continue;
    if (committed?.unconfirmed) {
      unconfirmed.push(member.name);
      continue;
    }
    const view = hostedMemberView(chains, member.childRunId);
    if (view.stoppingBeforeStart) settling.push(member.name);
    else if (view.stopping) stopping.push(member.name);
    else if (isEndedMember(view)) ended.push(member.name);
    else missed.push(member.name);
  }
  return (
    `${head}\n${lines}` +
    (missed.length > 0
      ? `\nIt did not reach: ${missed.join(', ')}. Send to those members by name if they still need it.`
      : '') +
    (ended.length > 0
      ? `\nIt did not reach ${ended.join(', ')}, which ${ended.length === 1 ? 'has' : 'have'} ended and cannot take it.`
      : '') +
    (settling.length > 0
      ? `\nIt did not reach ${settling.join(', ')}, whose latest continuation ${settling.length === 1 ? 'is' : 'are'} being stopped before starting. Check task_list after ${settling.length === 1 ? 'it settles' : 'they settle'}; if ${settling.length === 1 ? 'it ends' : 'they end'} without starting, send by name if still needed.`
      : '') +
    (stopping.length > 0
      ? `\nIt did not reach ${stopping.join(', ')}, which ${stopping.length === 1 ? 'is' : 'are'} being stopped and cannot take it. For more work after ${stopping.length === 1 ? 'it ends' : 'they end'}, launch ${stopping.length === 1 ? 'a new member' : 'new members'} under new names.`
      : '') +
    (unconfirmed.length > 0
      ? `\nDelivery to ${unconfirmed.join(', ')} could not be confirmed. Check with ${unconfirmed.length === 1 ? 'that member' : 'those members'} before sending it again.`
      : '')
  );
}

/** The interruption every settle or resume route below names. */
const INTERRUPTED_HARNESS = 'the Harness that asked was interrupted';

async function hostedSkillResponse(
  session: ManagedSession,
  catalog: HostedSkillCatalog,
  promptId: string,
  callId: string,
  args: unknown,
  mixedSkillBatch: boolean,
  hooks?: HostedHookSession,
): Promise<Part[]> {
  const refused = (reason: string) =>
    convertToFunctionErrorResponse('skill', callId, [], reason);
  if (mixedSkillBatch) return refused(HOSTED_SKILL_BATCH_REFUSAL);
  const initialProblem = catalog.validationError(args);
  if (initialProblem) return refused(initialProblem);
  if (hooks) {
    const marker = session.authority.extensionRecord(
      'hook_execution',
      hostedHookOccurrenceId(HookEventName.PreToolUse, `${promptId}:${callId}`),
    );
    if (!marker) throw new HostedHookRecoveryRequiredError();
    const record = parseHookExecution(marker.record);
    if (record.run.execution === 'not_started_proven')
      return refused('The turn was cancelled before this tool call ran.');
    if (!record.resultRef) throw new HostedHookRecoveryRequiredError();
    const original = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        await session.resources.read(record.inputRef),
      ),
    ) as {
      tool_name?: string;
      tool_use_id?: string;
      prompt_id?: string;
      tool_input?: unknown;
    };
    if (
      record.hookId !== '__plan__' ||
      record.eventName !== HookEventName.PreToolUse ||
      original.tool_name !== 'skill' ||
      original.tool_use_id !== callId ||
      original.prompt_id !== promptId ||
      !isDeepStrictEqual(original.tool_input, args)
    )
      throw new HostedHookRecoveryRequiredError();
    const saved = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        await session.resources.read(record.resultRef),
      ),
    ) as { output?: HookOutput };
    const output = saved.output && new PreToolUseHookOutput(saved.output);
    const permission = output?.getPermissionDecision();
    if (
      output?.shouldStopExecution() ||
      output?.isBlockingDecision() ||
      permission === 'deny'
    )
      return refused(
        (permission === 'deny' && output?.getPermissionDecisionReason()) ||
          output?.getEffectiveReason() ||
          'PreToolUse Hook denied the call.',
      );
    if (permission === 'ask') return refused(HOSTED_SKILL_APPROVAL_REFUSAL);
    const updated = saved.output?.hookSpecificOutput?.['updatedInput'];
    if (updated && typeof updated === 'object' && !Array.isArray(updated))
      args = updated;
  }
  const problem = catalog.validationError(args);
  return problem
    ? convertToFunctionErrorResponse('skill', callId, [], problem)
    : convertToFunctionResponse('skill', callId, [
        { text: catalog.response(args) },
      ]);
}

/**
 * Answers, by what committed, the calls an interrupted Turn committed but
 * never answered — a team call's writes, a background launch's admission —
 * and leaves every other owed call as it was. Every route that only
 * SETTLES an interrupted Turn runs it before the Turn's terminal: core's
 * orphan repair would otherwise tell the next Turn's model to retry such
 * a call, and the retry redoes it under a new key (a second task, a
 * second member's child). Idempotent; returns how many calls it answered.
 */
export function answerCommittedTurnCalls(input: {
  session: ManagedSession;
  sessionId: string;
  cwd: string;
  promptId: string;
  children?: HostedChildAgentSession;
  teams?: HostedTeamSession;
  messages?: HostedSessionMessageSession;
  commands?: HostedSessionCommandSession;
}): Promise<number> {
  return answerAbandonedTurnCalls({
    ...input,
    message: INTERRUPTED_HARNESS,
    uncommitted: 'none',
  });
}

/**
 * What a route that RESUMES an interrupted Turn answers before the resumed
 * round is read: the committed calls by what committed, and every team or
 * agent call that committed nothing as never run. No Runtime settlement
 * ever answers those, and a resume needs its round whole: a pending file
 * history's check refuses a round with a call unanswered, on every
 * attempt. Runtime calls stay with the checkpoint, and an admitted child
 * is never told it did not start. Idempotent; returns how many it answered.
 */
export function answerResumedTurnCalls(input: {
  session: ManagedSession;
  sessionId: string;
  cwd: string;
  promptId: string;
  children?: HostedChildAgentSession;
  teams?: HostedTeamSession;
  messages?: HostedSessionMessageSession;
  commands?: HostedSessionCommandSession;
  skills?: HostedSkillCatalog;
  hooks?: HostedHookSession;
}): Promise<number> {
  return answerAbandonedTurnCalls({
    ...input,
    message: INTERRUPTED_HARNESS,
    uncommitted: 'hosted',
  });
}

/**
 * The agent wait's cancellation settlement (#13708): every outstanding
 * wait run folds the live arm's own abandoned answer and the resolve
 * moves the checkpoint past the wait, so the terminal record can land.
 * The journaled set keeps a replayed cancel silent; the abandoned child
 * is never revoked. Shared by the cancel route and the interrupted-turn
 * funnel: both call the same code the wedge suite pins.
 */
export async function settleCancelledAgentWaitRuns(input: {
  managed: ManagedSession;
  sessionId: string;
  promptId: string;
  cwd: string;
  runs: readonly HarnessAgentWaitRun[];
}): Promise<void> {
  const harness = createManagedHarnessHandle(input.managed);
  const journaled = await journaledToolResultIds(input.managed, input.promptId);
  for (const run of input.runs) {
    const abandoned = convertToFunctionErrorResponse(
      run.toolName,
      run.functionCallId,
      [],
      HOSTED_AGENT_WAIT_ABANDONED_TEXT,
    );
    if (!journaled.has(run.functionCallId))
      await input.managed.sink.write({
        uuid: randomUUID(),
        parentUuid: run.modelMessageId,
        sessionId: input.sessionId,
        timestamp: new Date().toISOString(),
        type: 'tool_result',
        cwd: input.cwd,
        version: 'hosted-harness/1',
        daemonPromptId: input.promptId,
        message: { role: 'user', parts: abandoned },
      });
    await harness.resolveAwaitAgent(run.childRunId);
  }
}

/**
 * The gap fill of a parked agent-wait round (#13708): a foreground batch
 * parks with some later calls of its last assistant round never reached
 * by the dead loop — the durable wait names only the admitted ones, so
 * each remaining function call must still meet its functionResponse on
 * the resume story, or the model request is malformed. Each fills with
 * the live admission's own never-admitted answer, parented to that
 * round's assistant record; the journaled set keeps a replayed fill
 * silent, and the ledger keeps it honest: a call whose child was
 * admitted in the gap between the last fold and its own wait commit is
 * NOT "never admitted" — it drives to its own terminal through the same
 * poll the live wait ran, and its answer folds truthfully (a fabricated
 * cancellation must never be minted for a live child). A call with no
 * run record fills the live admission's own never-admitted answer.
 * Shared by the continue route, the cancel route, and the
 * interrupted-turn funnel.
 */
export async function fillParkedRoundAgentGaps(input: {
  managed: ManagedSession;
  sessionId: string;
  promptId: string;
  cwd: string;
  /** The never-admitted answer's wording: the cancel route and the
   * recovery family (continue + funnel) name different causes, and the
   * durable journal must not assert one that never happened. */
  gapText: string;
  children?: HostedChildAgentSession;
  /** H4d-b: the message funnel, so a committed send_message keeps the
   * answer it earned instead of the never-admitted one. */
  messages?: HostedSessionMessageSession;
  skills?: HostedSkillCatalog;
  hooks?: HostedHookSession;
  signal?: AbortSignal;
  consume?: (childRunId: string) => void;
}): Promise<number> {
  const authorization = await input.managed.authority
    .harnessRunAuthorization()
    .catch(() => undefined);
  const waitRuns =
    authorization?.status === 'runnable'
      ? (authorization.checkpoint.agentWait?.runs ?? [])
      : [];
  // The parked round is the one the wait names, never whatever assistant
  // came later — a crash past the last fold can journal another round
  // (a plain tool call whose Runtime wait was never committed), and
  // filling THAT round writes a fabricated answer for a call with no
  // agent story at all.
  const namedRounds = new Set(waitRuns.map((run) => run.modelMessageId));
  // The wait's own calls are never gaps either: their folds and their
  // replay-safe marks belong to the wait-arm channel (settle / resume),
  // and an admitted-but-unsettled wait run polled here would hang the
  // fill forever.
  const waitedCalls = new Set(waitRuns.map((run) => run.functionCallId));
  const projected = await input.managed.sink.project();
  const assistant = projected
    .filter(
      (entry) =>
        entry.daemonPromptId === input.promptId &&
        entry.type === 'assistant' &&
        entry.message?.parts?.some((part) => part.functionCall) &&
        namedRounds.has(entry.uuid),
    )
    .at(-1);
  if (assistant === undefined) return 0;
  // Reuse the projection already in hand: a second project() walks every
  // committed event again, and nothing can change the journal between
  // the two reads (the route holds the turn for the whole recovery).
  const journaled = await journaledToolResultIds(
    input.managed,
    input.promptId,
    projected,
  );
  const writeFold = async (parts: Part[]): Promise<void> => {
    await input.managed.sink.write({
      uuid: randomUUID(),
      parentUuid: assistant.uuid,
      sessionId: input.sessionId,
      timestamp: new Date().toISOString(),
      type: 'tool_result',
      cwd: input.cwd,
      version: 'hosted-harness/1',
      model: 'recovered',
      daemonPromptId: input.promptId,
      message: { role: 'user', parts },
    });
  };
  // The fit predicate measures exactly this record shape (a uuid is always
  // 36 chars; the assistant parent is always 36; the timestamp is one ISO
  // string) — never an estimate, or the inline bound would slip. The same
  // template, never a caller lambda: the exact shape is the predicate.
  const templateRecord = (parts: Part[]): Buffer =>
    Buffer.from(
      JSON.stringify({
        uuid: '0'.repeat(36),
        parentUuid: '0'.repeat(36),
        sessionId: input.sessionId,
        timestamp: '1970-01-01T00:00:00.000Z',
        type: 'tool_result',
        cwd: input.cwd,
        version: 'hosted-harness/1',
        model: 'recovered',
        daemonPromptId: input.promptId,
        message: { role: 'user', parts },
      }),
      'utf8',
    );
  const fits = (parts: Part[]): boolean =>
    templateRecord(parts).byteLength <=
    HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes;
  const mixedSkillBatch = (assistant.message?.parts ?? []).some(
    (part) => part.functionCall && part.functionCall.name !== 'skill',
  );
  let filled = 0;
  for (const part of assistant.message?.parts ?? []) {
    const callId = part.functionCall?.id;
    const name = part.functionCall?.name;
    if (typeof callId !== 'string' || typeof name !== 'string') continue;
    if (waitedCalls.has(callId)) continue;
    // The journaled set gates only the fold, never the replay-safe marks —
    // both sibling arms in this diff document and follow the same rule.
    const foldOwed = !journaled.has(callId);
    if (name === 'skill' && input.skills) {
      if (foldOwed) {
        await writeFold(
          await hostedSkillResponse(
            input.managed,
            input.skills,
            input.promptId,
            callId,
            part.functionCall?.args ?? {},
            mixedSkillBatch,
            input.hooks,
          ),
        );
        filled += 1;
      }
      continue;
    }
    const children = input.children;
    const sent =
      name === 'send_message'
        ? sentMessageText(
            {
              session: input.managed,
              promptId: input.promptId,
              children,
              messages: input.messages,
            },
            callId,
            hostedChildRunIdFor(input.promptId, callId),
          )
        : undefined;
    if (sent !== undefined) {
      if (foldOwed) {
        await writeFold(
          convertToFunctionResponse(name, callId, [{ text: sent }]),
        );
        filled += 1;
      }
      continue;
    }
    const admitted =
      children === undefined
        ? undefined
        : children.record(hostedChildRunIdFor(input.promptId, callId));
    if (children === undefined || admitted === undefined) {
      if (foldOwed) {
        await writeFold(
          convertToFunctionErrorResponse(name, callId, [], input.gapText),
        );
        filled += 1;
      }
    } else if (admitted.completion === 'sent') {
      // A background delegation answered with the live arm's started
      // receipt: no wait row exists for it, so its consumption belongs to
      // the wake pump — never to this fill.
      if (foldOwed) {
        const taskId = managedChildTaskId(
          input.managed.authority.sessionHeader.sessionKey.sessionId,
          admitted.run.executionCallId ??
            hostedChildRunIdFor(input.promptId, callId),
        );
        await writeFold(
          convertToFunctionResponse(name, callId, [
            { text: hostedChildBackgroundStartedText(admitted.kind, taskId) },
          ]),
        );
        filled += 1;
      }
    } else {
      const runId =
        admitted.run.executionCallId ??
        hostedChildRunIdFor(input.promptId, callId);
      // Mirrors the live wait's own loop (sans the wait resolve — the
      // orphan carries no wait row): poll the ledger to a terminal and
      // fold what really happened, nothing fabricated.
      for (;;) {
        if (input.signal?.aborted === true) {
          if (foldOwed) {
            await writeFold(
              convertToFunctionErrorResponse(
                name,
                callId,
                [],
                HOSTED_AGENT_WAIT_ABANDONED_TEXT,
              ),
            );
            filled += 1;
          }
          break;
        }
        const record = children.record(runId);
        if (
          record !== undefined &&
          (record.run.state === 'failed' || record.run.state === 'cancelled')
        ) {
          if (foldOwed) {
            await writeFold(
              convertToFunctionErrorResponse(
                name,
                callId,
                [],
                childRunEndedText(record),
              ),
            );
            filled += 1;
          }
          break;
        }
        const acceptance = children.acceptance(runId);
        if (acceptance !== undefined) {
          const text = (
            await input.managed.resources.read(acceptance.contentRef)
          ).toString('utf8');
          // One fit discipline with the live arm (R3-2): the answer still
          // must land, folded to the inline bound with its marker instead
          // of erroring the recovered Turn — the full bytes stay on the
          // acceptance record, and the exact template measures the fold.
          // A worktree child's merge outcome follows, as on the live arm.
          const fitted = fitChildResultInline(
            name,
            callId,
            text,
            fits,
            await childWorkspaceAnswerSuffix(
              record?.kind === 'child_agent' ? record : undefined,
              acceptance,
              (ref) => input.managed.resources.read(ref),
            ),
          );
          if (foldOwed) {
            await writeFold(fitted);
            filled += 1;
          }
          // The replay-safe marks still run when the fold already landed.
          await children.markAccepted(runId);
          input.consume?.(runId);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    journaled.add(callId);
  }
  return filled;
}

/**
 * A member command call's answer by what its journal committed (H4e-b3
 * decision 14): an accepted entry's reply; a planned entry cancelled and
 * told as not sent; a handed-over one told it reached the leader with its
 * reply still missing and a write possibly landed; rejected, cancelled
 * and unknown said so. The settle's conflict is the relay race's own
 * evidence: once it loses, the journal is re-read and answered as it
 * committed. It never consumes the entry — no waiting call reads it.
 */
async function sessionCommandJournalAnswer(
  commands: HostedSessionCommandSession,
  run: Pick<HarnessCommandWaitRun, 'commandId' | 'functionCallId' | 'toolName'>,
): Promise<Part[]> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const record = commands.command(run.commandId);
    const state =
      record === undefined
        ? 'planned'
        : (record.run.delivery?.state ?? 'planned');
    if (state === 'accepted' || state === 'consumed') {
      const reply = await commands.readReply(run.commandId);
      if (reply === null) continue;
      return reply.outcome === 'answered'
        ? convertToFunctionResponse(run.toolName, run.functionCallId, [
            { text: reply.text },
          ])
        : convertToFunctionErrorResponse(
            run.toolName,
            run.functionCallId,
            [],
            reply.text,
          );
    }
    try {
      if (record !== undefined && state === 'planned') {
        await commands.settle(run.commandId, 'cancelled');
      } else if (state === 'accepting') {
        await commands.settle(run.commandId, 'unknown');
      }
    } catch (cause) {
      if (cause instanceof ManagedSessionConflictError) continue;
      throw cause;
    }
    return convertToFunctionErrorResponse(
      run.toolName,
      run.functionCallId,
      [],
      sessionCommandEvidenceText(
        // The accepted/consumed arm above answered already; what remains
        // of the delivery vocabulary is exactly the settle-relevant five.
        state as 'planned' | 'accepting' | 'rejected' | 'cancelled' | 'unknown',
      ),
    );
  }
  throw new Error(`Session command ${run.commandId} never settled.`);
}

/**
 * The command wait's cancellation settlement (H4e-b3 decision 14): every
 * outstanding wait run is answered by what its own journal committed —
 * an accepted entry's reply; a planned entry cancelled and told as not
 * sent; a handed-over one told it reached the leader with its reply still
 * missing and a write possibly landed; rejected, cancelled and unknown
 * said so — or the checkpoint moves past the wait with no terminal
 * record stranding the Turn. The settle's conflict is the relay race's
 * own evidence: once it loses, the journal is re-read and answered as it
 * committed. The journaled set keeps a replayed cancel silent. Shared by
 * the cancel/close path and the interrupted-turn settle.
 */
export async function settleCancelledCommandWaitRuns(input: {
  managed: ManagedSession;
  sessionId: string;
  promptId: string;
  cwd: string;
  runs: readonly HarnessCommandWaitRun[];
  commands: HostedSessionCommandSession;
}): Promise<void> {
  const harness = createManagedHarnessHandle(input.managed);
  const journaled = await journaledToolResultIds(input.managed, input.promptId);
  for (const run of input.runs) {
    const parts = await sessionCommandJournalAnswer(input.commands, run);
    if (!journaled.has(run.functionCallId))
      await input.managed.sink.write({
        uuid: randomUUID(),
        parentUuid: run.modelMessageId,
        sessionId: input.sessionId,
        timestamp: new Date().toISOString(),
        type: 'tool_result',
        cwd: input.cwd,
        version: 'hosted-harness/1',
        daemonPromptId: input.promptId,
        message: { role: 'user', parts },
      });
    await harness.resolveAwaitCommand(run.commandId);
  }
}

/**
 * The gap fill of a parked command round (H4e-b3 decision 4): a command
 * batch parks with some calls of its last assistant round never reached
 * by the dead loop — the checkpoint names every admitted command call,
 * so the only gaps are the journal-only siblings (`send_message` to
 * `"parent"`), which fill from what committed, and anything validation
 * refused, which never ran. A call named by the checkpoint is never a
 * gap: its fold and its replay-safe marks belong to the wait-arm channel
 * (settle / resume). Shared by the cancel/close path and the
 * interrupted-turn settle.
 */
export async function fillParkedRoundCommandGaps(input: {
  managed: ManagedSession;
  sessionId: string;
  promptId: string;
  cwd: string;
  /** The never-admitted sibling's answer wording, caller-named. */
  gapText: string;
  commands: HostedSessionCommandSession;
  children?: HostedChildAgentSession;
  messages?: HostedSessionMessageSession;
}): Promise<number> {
  const authorization = await input.managed.authority
    .harnessRunAuthorization()
    .catch(() => undefined);
  const waitRuns =
    authorization?.status === 'runnable'
      ? (authorization.checkpoint.commandWait?.runs ?? [])
      : [];
  const namedRounds = new Set(waitRuns.map((run) => run.modelMessageId));
  const waitedCalls = new Set(waitRuns.map((run) => run.functionCallId));
  const projected = await input.managed.sink.project();
  const assistant = projected
    .filter(
      (entry) =>
        entry.daemonPromptId === input.promptId &&
        entry.type === 'assistant' &&
        entry.message?.parts?.some((part) => part.functionCall) &&
        namedRounds.has(entry.uuid),
    )
    .at(-1);
  if (assistant === undefined) return 0;
  const journaled = await journaledToolResultIds(
    input.managed,
    input.promptId,
    projected,
  );
  let filled = 0;
  for (const part of assistant.message?.parts ?? []) {
    const callId = part.functionCall?.id;
    const name = part.functionCall?.name;
    if (typeof callId !== 'string' || typeof name !== 'string') continue;
    if (waitedCalls.has(callId)) continue;
    const foldOwed = !journaled.has(callId);
    const sent =
      name === 'send_message'
        ? await sentMessageText(
            {
              session: input.managed,
              promptId: input.promptId,
              children: input.children,
              messages: input.messages,
            },
            callId,
            hostedChildRunIdFor(input.promptId, callId),
          )
        : undefined;
    let parts: Part[] | undefined;
    if (sent !== undefined) {
      parts = convertToFunctionResponse(name, callId, [{ text: sent }]);
    } else {
      parts = convertToFunctionErrorResponse(
        name,
        callId,
        [],
        ['task_list', 'task_create', 'task_update', 'exit_plan_mode'].includes(
          name,
        )
          ? sessionCommandEvidenceText('planned')
          : input.gapText,
      );
    }
    if (foldOwed) {
      await input.managed.sink.write({
        uuid: randomUUID(),
        parentUuid: assistant.uuid,
        sessionId: input.sessionId,
        timestamp: new Date().toISOString(),
        type: 'tool_result',
        cwd: input.cwd,
        version: 'hosted-harness/1',
        model: 'recovered',
        daemonPromptId: input.promptId,
        message: { role: 'user', parts },
      });
      filled += 1;
    }
    journaled.add(callId);
  }
  return filled;
}

/**
 * The tool names a takeover may answer from the journal alone (#13847):
 * the child orchestration and team vocabulary commits its own durable
 * records before its answers, so a crash between the two leaves the
 * evidence the answer family above reads. Any other name keeps its
 * decline — an owed Runtime call cannot be proven stopped or never run.
 */
const JOURNAL_ONLY_ANSWERABLE_TOOLS: ReadonlySet<string> = new Set([
  'agent',
  'workflow',
  'send_message',
  'team_plan_approval',
  ...HOSTED_TEAM_TOOL_NAMES,
]);

/**
 * The journal-only interrupted-Turn settlement (#13847): a Turn whose
 * batch committed nothing but journal writes — a background launch, a
 * team call — parks at a model-start phase (or a checkpoint that never
 * bound it), and the typed decline for that park used to wedge the
 * Session forever: the coordinator stamps the Turn terminally failed
 * while the journal keeps the input unsettled, so every later load is
 * refused and the child result relay can never record its attach and
 * result. When the durable journal proves the Turn's still-owed calls
 * are all of the answerable family, the takeover settles instead:
 * every owed call meets its functionResponse (committed ones by their
 * own per-call evidence, the rest as never run — a dangling call would
 * make the resumed thread a malformed request), the dead Turn's pending
 * file-history obligation drops exactly as the interrupted-Turn funnel
 * drops it, and the terminal record settles the Turn so the lead loads
 * again. The answer is the pre-G3 `inapplicable`: a settled Turn owes a
 * takeover nothing, and every redrive of this state converges on the
 * plain attach. A Turn the evidence does not cover — no accepted input,
 * an owed call outside the family, or one whose evidence funnel this
 * load does not hold — returns undefined and keeps its typed decline,
 * never a minted answer. Idempotent: a retry after a partial settle
 * re-derives the owed set from the journal, and a retry after the
 * terminal lands answers `inapplicable` on the settled input.
 */
async function settleJournalOnlyInterruptedTurn(input: {
  session: ManagedSession;
  sessionId: string;
  cwd: string;
  promptId: string;
  children?: HostedChildAgentSession;
  teams?: HostedTeamSession;
  messages?: HostedSessionMessageSession;
  commands?: HostedSessionCommandSession;
}): Promise<HostedRuntimeRecoveryOutcome | undefined> {
  const authority = input.session.authority;
  let accepted = false;
  let settled = false;
  for (const event of authority.eventsInSequenceRange(
    1,
    authority.committedSequence,
  )) {
    if (
      event.kind === 'input.accepted' &&
      event.payload['turnId'] === input.promptId
    )
      accepted = true;
    else if (
      event.kind === 'turn.settled' &&
      event.payload['turnId'] === input.promptId
    )
      settled = true;
  }
  if (settled) return inapplicable();
  if (!accepted) return undefined;
  const projected = await input.session.sink.project();
  const records = projected.filter(
    (entry) => entry.daemonPromptId === input.promptId,
  );
  const answered = await journaledToolResultIds(
    input.session,
    input.promptId,
    records,
  );
  for (const record of records) {
    if (record.type !== 'assistant') continue;
    for (const part of record.message?.parts ?? []) {
      const call = part.functionCall;
      if (!call?.id || !call.name || answered.has(call.id)) continue;
      if (!JOURNAL_ONLY_ANSWERABLE_TOOLS.has(call.name)) return undefined;
      // The evidence each answer rides is per-call durable state inside
      // its own funnel; without that funnel the honest answer does not
      // exist, and a minted never-ran would be a false terminal for work
      // the journal may actually carry.
      if (
        (call.name === 'agent' || call.name === 'workflow') &&
        input.children === undefined
      )
        return undefined;
      if (
        call.name === 'send_message' &&
        (input.messages === undefined || input.children === undefined)
      )
        return undefined;
      // A team call's committed evidence rides two disjoint funnels —
      // `teams.committedBy` for a lead's own team writes, and the H4e-b3
      // command journal once a member board call's outbound commits —
      // so BOTH must be held, exactly like the send_message guard above.
      if (
        HOSTED_TEAM_TOOL_NAMES.includes(call.name) &&
        (input.teams === undefined || input.commands === undefined)
      )
        return undefined;
      // A plan approval's committed evidence is the plan decision the
      // teams funnel alone records (teams.planDecisionEvidence) — the
      // standalone HOSTED_TEAM_PLAN_TOOL never lands in the team-tools
      // name list, so it keeps its own one-funnel guard.
      if (call.name === 'team_plan_approval' && input.teams === undefined)
        return undefined;
    }
  }
  await answerAbandonedTurnCalls({
    session: input.session,
    sessionId: input.sessionId,
    cwd: input.cwd,
    promptId: input.promptId,
    message: INTERRUPTED_HARNESS,
    uncommitted: 'all',
    children: input.children,
    teams: input.teams,
    messages: input.messages,
    commands: input.commands,
    projected,
  });
  // The dead Turn's pending file-history obligation dies with it, the
  // same shape the interrupted-Turn funnel commits: kept snapshots,
  // dropped marker, or every later load stays refused on the marker.
  const savedHistory = await readHostedFileHistory(input.session);
  if (savedHistory?.pendingTurn === input.promptId) {
    await commitHostedFileHistory(input.session, {
      schemaVersion: 1,
      state: savedHistory.state,
      pendingTurn: null,
      pendingUndo: null,
    });
  }
  // The interrupted Turn's terminal: the same cancelled result the
  // channel wake settle stamps (F5), so the input settles and — with
  // the park at a model-start phase — the checkpoint hands the Session
  // over to its next Turn in the same commit.
  await input.session.sink.write({
    uuid: randomUUID(),
    parentUuid: null,
    sessionId: input.sessionId,
    timestamp: new Date().toISOString(),
    type: 'system',
    cwd: input.cwd,
    version: 'hosted-harness/1',
    subtype: 'turn_result',
    systemPayload: {
      promptId: input.promptId,
      state: 'cancelled',
      stopReason: 'harness_interruption',
      endedAt: Date.now(),
    },
  } as unknown as ChatRecord);
  return inapplicable();
}

/**
 * H5/F5 follow-up: the Runtime-facing settlement of an interrupted Turn
 * ahead of its terminal record. A Turn that died inside a tool call parked
 * its checkpoint in `await_runtime`, and a terminal record advances the
 * checkpoint from a model-start phase alone — settling only the record
 * wedges the Session on the next `requireModelStart`. Mirrors the takeover
 * cancellation: prove the parked executions stopped, settle them cancelled
 * (their functionCall must meet a functionResponse before the next model
 * round), and drop the dead Turn's pending file-history obligation on
 * every reachable checkpoint — a retry whose first attempt already left
 * the wait included — or the terminal record strands the marker at
 * `before_model`, where no load can ever clear it. A Turn parked in
 * `await_action` is held while its approval stays `requested` and its
 * deadline lives — the interrupted owner's expiry timer died with it, so
 * an unanswered ask whose deadline passed is expired here before the same
 * ending. A Turn parked at an agent wait (#13708) settles the same way the
 * takeover cancellation does: its outstanding waits fold the live arm's
 * abandoned answers, the resolve moves the checkpoint past the wait, and
 * the round's never-reached calls pair off. Once the durable Action is
 * final, the wait is advanced, the abandoned calls answered, and the
 * turn's Workspace acquisition (its promptId-named runtime session) handed
 * back with the verdict, or every later tool call in the Workspace waits
 * behind a dead holder (F9). The returned Broker releases after the
 * caller's terminal
 * record is durable, never before. Throws with nothing settled when the
 * stop cannot be proven, leaving the Turn to the recovery fleet; a
 * checkpoint the authorization could not verify (a faulting Store read
 * erases into `missing_state`) refuses the same way rather than being
 * mistaken for "no Runtime wait to settle" — and the settle's own
 * re-read after the stop refuses identically, having journaled nothing.
 */
export async function settleInterruptedTurnRuntime(input: {
  session: ManagedSession;
  sessionId: string;
  cwd: string;
  promptId: string;
  brokerOptions: HostedWorkspaceBrokerOptions | undefined;
  toolProfile: boolean;
  /** Caller-owned accumulator, exactly as in the takeover cancel drive: a
   * stop attempt that throws mid-poll must carry the ids it already
   * counted into the caller's retry — a reclaimed record then reads as
   * already-stopped, and without the carry the retry would certify the
   * stop nobody observed. */
  carryUnobservedInto?: Set<string>;
  /** The child ledger the agent-wait arm's gap fill polls — the same one
   * the live arm drives, so an admitted orphan never meets a fabricated
   * answer even here. */
  children?: HostedChildAgentSession;
  consume?: (childRunId: string) => void;
  /** H4e-b1: the team funnel that tells which team calls committed. */
  teams?: HostedTeamSession;
  /** H4d-b: the message funnel that tells which send_message committed. */
  messages?: HostedSessionMessageSession;
  /** H4e-b3: the command funnel that tells a command's committed evidence. */
  commands?: HostedSessionCommandSession;
}): Promise<HostedInterruptedTurnRuntime> {
  const authorization = await input.session.authority.harnessRunAuthorization();
  // Only a committed, readable checkpoint — or the durable absence of any
  // — can prove what the interrupted Turn left parked. A durably blocked
  // verdict names permanent damage and stays with the recovery fleet;
  // a transient one (a faulting Store read erased into missing_state)
  // refuses this attempt the same, but as an ordinary fault so the caller
  // can retry — it is never evidence of no wait either way (R4/R6 P1).
  if (authorization.status === 'blocked') {
    if (!isDurableBlockedVerdict(authorization))
      throw new Error(
        `interrupted turn checkpoint could not be verified (blocked/${authorization.reason})`,
      );
    throw new RecoveryDeclined();
  }
  let broker: HostedWorkspaceBroker | undefined;
  // The calls whose executions the stop counted on the Broker's terminal
  // fence alone, translated for the abandoned-call tail: their stop was
  // never observed, so the tail owes them the honest unobservable outcome
  // rather than a cancellation nobody witnessed.
  let unobservedCalls: ReadonlySet<string> | undefined;
  if (
    authorization.status === 'runnable' &&
    authorization.checkpoint.identity.turnId === input.promptId
  ) {
    const phase = authorization.checkpoint.continuation.phase;
    if (phase === 'await_action') {
      const requestId = authorization.checkpoint.approval?.requestId;
      const action =
        requestId === undefined
          ? undefined
          : input.session.authority.action(requestId);
      if (action === undefined) return { kind: 'held' };
      let finalState = action.state;
      if (action.state === 'requested') {
        // The interrupted owner's expiry timer died with it, so an
        // unanswered ask must expire here — the pump's slow re-derive is
        // then the owner that observes it. A still-live deadline holds.
        const options = await readHostedActionOptions(input.session, action);
        if (Date.now() < options.expiresAt) return { kind: 'held' };
        await endHostedAction(
          input.session,
          action.requestId,
          'expired',
          () => !input.session.authority.writesStopped,
        );
        finalState =
          input.session.authority.action(action.requestId)?.state ?? 'expired';
      }
      if (finalState === 'requested') return { kind: 'held' };
      // The final Action outlives the owner that died asking: advance the
      // wait the way the close path does, and let the common tail answer
      // its abandoned calls — a dangling functionCall makes the resumed
      // thread a malformed request the provider rejects.
      await createManagedHarnessHandle(input.session).resolveDurableWait();
    }
    if (phase === 'await_runtime') {
      // Symmetric with the continue/cancel routes: without the tool
      // profile or the Broker there is no way to prove the parked
      // executions stopped.
      if (!input.toolProfile || input.brokerOptions === undefined)
        throw new RecoveryDeclined();
      const stopped = await stopParkedRuntimeExecutions({
        session: input.session,
        promptId: input.promptId,
        brokerOptions: input.brokerOptions,
        carryUnobservedInto: input.carryUnobservedInto,
      });
      broker = stopped.broker;
      const settleOutcome = await settleParkedTurnCancelled({
        session: input.session,
        sessionId: input.sessionId,
        cwd: input.cwd,
        promptId: input.promptId,
        unobserved: stopped.unobserved,
      });
      // A settle that could not verify the park journaled nothing: its
      // contract names that a retry-inviting failure, never a completed
      // settle the tail and the caller's terminal record may build on.
      if (settleOutcome === 'not-runnable')
        throw new Error(
          'Interrupted turn settle cannot verify the park (authorization not runnable).',
        );
      if (stopped.unobserved.size > 0)
        unobservedCalls = new Set(
          (authorization.checkpoint.tools?.items ?? [])
            .filter((item) => stopped.unobserved.has(item.executionCallId))
            .map((item) => item.functionCallId),
        );
    }
    if (harnessCheckpointIsAgentWait(authorization.checkpoint)) {
      // The agent wait's own mirror (R1-3): no Runtime executions exist to
      // stop — each outstanding run folds the live arm's abandoned answer,
      // the resolve moves the checkpoint past the wait, and the round's
      // never-reached calls pair off before the terminal record lands.
      const outstanding = (
        authorization.checkpoint.agentWait?.runs ?? []
      ).filter((run) => !run.consumed);
      if (outstanding.length > 0) {
        await settleCancelledAgentWaitRuns({
          managed: input.session,
          sessionId: input.sessionId,
          promptId: input.promptId,
          cwd: input.cwd,
          runs: outstanding,
        });
      }
      // The funnel settles the way the takeover cancellation does — so it
      // must never outlive its own settlement: an admitted orphan folds
      // the abandoned answer at once, never a deadline-less poll that
      // would hang the attach/redrive path it runs on (R3-1).
      const settleFillAbort = new AbortController();
      settleFillAbort.abort();
      await fillParkedRoundAgentGaps({
        managed: input.session,
        sessionId: input.sessionId,
        promptId: input.promptId,
        cwd: input.cwd,
        gapText: HOSTED_AGENT_CALL_NOT_REACHED_TEXT,
        children: input.children,
        messages: input.messages,
        signal: settleFillAbort.signal,
        consume: input.consume,
      });
    }
    if (harnessCheckpointIsCommandWait(authorization.checkpoint)) {
      // H4e-b3 decision 14: no Runtime executions exist to stop either —
      // each outstanding command run answers by what its own journal
      // committed, the resolve moves the checkpoint past the wait, and
      // the round's never-reached calls pair off from the same journal.
      if (input.commands === undefined)
        throw new Error('Command wait checkpoint has no command funnel.');
      const outstanding = (
        authorization.checkpoint.commandWait?.runs ?? []
      ).filter((run) => !run.folded);
      if (outstanding.length > 0) {
        await settleCancelledCommandWaitRuns({
          managed: input.session,
          sessionId: input.sessionId,
          promptId: input.promptId,
          cwd: input.cwd,
          runs: outstanding,
          commands: input.commands,
        });
      }
      await fillParkedRoundCommandGaps({
        managed: input.session,
        sessionId: input.sessionId,
        promptId: input.promptId,
        cwd: input.cwd,
        gapText: HOSTED_AGENT_CALL_NOT_REACHED_TEXT,
        commands: input.commands,
        children: input.children,
        messages: input.messages,
      });
    }
  }
  // The dead Turn's pending file-history obligation dies with it: keep
  // the snapshots, drop the marker, or every later load stays refused.
  const savedHistory = await readHostedFileHistory(input.session);
  if (savedHistory?.pendingTurn === input.promptId) {
    await commitHostedFileHistory(input.session, {
      schemaVersion: 1,
      state: savedHistory.state,
      pendingTurn: null,
      pendingUndo: null,
    });
  }
  if (
    authorization.status === 'runnable' &&
    authorization.checkpoint.identity.turnId === input.promptId
  ) {
    // Every call the dead Turn still owes is answered on every pass,
    // identically idempotent: a settlement that split across attempts —
    // its wait advanced, its answer write faulted — leaves the retry at a
    // model-start phase with no wait left to detect, and a dangling
    // functionCall would make the resumed thread malformed (R8 P1).
    const approval = authorization.checkpoint.approval;
    const action =
      approval?.requestId === undefined
        ? undefined
        : input.session.authority.action(approval.requestId);
    await answerAbandonedTurnCalls({
      session: input.session,
      sessionId: input.sessionId,
      cwd: input.cwd,
      promptId: input.promptId,
      message:
        action !== undefined && action.state !== 'requested'
          ? `the approval ended ${action.state} after the Harness that asked was interrupted`
          : 'the Harness that asked was interrupted',
      unobserved: unobservedCalls,
      children: input.children,
      teams: input.teams,
      messages: input.messages,
      commands: input.commands,
    });
  } else {
    // A Turn whose checkpoint never bound it — a batch of team calls and
    // background launches parks nothing — still owes its committed calls
    // their answers; core's orphan repair keeps answering the rest.
    await answerCommittedTurnCalls({
      session: input.session,
      sessionId: input.sessionId,
      cwd: input.cwd,
      promptId: input.promptId,
      children: input.children,
      teams: input.teams,
      messages: input.messages,
      commands: input.commands,
    });
  }
  // The handback owed for a taken Workspace survives a settlement split
  // across attempts: a first attempt that advanced the checkpoint and
  // died before answering, or a settle failure afterwards, leaves the
  // retry at a model-start phase with no wait left to detect — yet the
  // dead Turn's runtime session still holds the lease until something
  // releases it. It also survives a Turn that acquired its Workspace
  // before any checkpoint bound its identity — a release against a
  // runtime session that never existed answers 404, which the caller's
  // release already tolerates. Every ready verdict whose trace still
  // names the interrupted Turn therefore hands that session back with
  // it, not only the wait arm's first pass (F13's acquire-first window).
  if (
    broker === undefined &&
    input.brokerOptions !== undefined &&
    (authorization.status === 'initial' ||
      (authorization.status === 'runnable' &&
        (authorization.checkpoint.identity.turnId === null ||
          authorization.checkpoint.identity.turnId === input.promptId)))
  ) {
    broker = new HostedWorkspaceBroker(
      input.brokerOptions,
      input.session.authority.sessionHeader.sessionKey,
      input.promptId,
    );
  }
  return broker === undefined ? { kind: 'ready' } : { kind: 'ready', broker };
}

/**
 * Reconciles a parked Runtime turn on a replacement Harness. A continuation
 * load (`passive: false`) re-dispatches every in-progress execution under its
 * original `executionCallId` — the Broker's durable record keeps that
 * exactly-once — commits the tool results and lets the checkpoint reach
 * `results_ready` before the caller answers. A passive load adopts the
 * original Runtime Session and reads execution states for the cancellation
 * path; it never dispatches. It reports that adoption before fallible reads,
 * so the caller retains the lease even when no recovery report returns.
 *
 * A parked state that can be taken over answers `recovered`; one that is
 * deterministically unrecoverable answers `declined` with a typed reason.
 * `inapplicable` is narrowed to the two states a plain attach pays: a
 * requested approval (either shape), resolvable durably by the user; and
 * `turn_settled`, which the load route settles by writing the missing
 * terminal record itself (R11-2) — or refuses retriably when the
 * projection cannot pay. Any other parked state (`initial`, a durably
 * blocked checkpoint, a model-start or unknown phase, a checkpoint naming
 * another Turn) throws on the cancellation side into the caller's
 * retriable refusal, because a plain attach there stands a Session no
 * settlement route can pay (R10-2/R10-1 re-checks). Thrown errors are
 * transient: the caller keeps its plain retriable refusal for them.
 */
export async function recoverHostedRuntimeTurn(input: {
  session: ManagedSession;
  sessionId: string;
  cwd: string;
  promptId: string;
  brokerOptions: HostedWorkspaceBrokerOptions;
  passive: boolean;
  /** The evidence funnels of the interrupted-Turn settlement (#13847): a
   * model-start park whose open round holds only journal-only calls
   * answers them by what committed through these — the same shapes the
   * interrupted-Turn funnel settles. A call whose funnel this load does
   * not hold keeps its typed decline instead of minting a false answer. */
  children?: HostedChildAgentSession;
  teams?: HostedTeamSession;
  messages?: HostedSessionMessageSession;
  commands?: HostedSessionCommandSession;
  onPassiveRuntimeAcquired?: (runtimeSessionId: string) => void;
  /** Set when the calling Session already holds the Runtime lease from an
   * earlier recovery of the same parked Turn (a re-answered load whose
   * first reply was lost): a failed re-acquire then says nothing about
   * the held lease, so the failure exits below must not release it — a
   * release persists RELEASED and wedges every later redrive on
   * runtime_session_not_acquirable. */
  leaseAlreadyHeld?: boolean;
}): Promise<HostedRuntimeRecoveryOutcome> {
  const { session, promptId, passive } = input;
  // One entry to the journal-only settle (#13847): every decline arm
  // below whose park the durable journal can disprove hands the same
  // funnel-honest call — named once so a later argument or precondition
  // can never drift the arms apart.
  const tryJournalOnlySettle = () =>
    settleJournalOnlyInterruptedTurn({
      session,
      sessionId: input.sessionId,
      cwd: input.cwd,
      promptId,
      children: input.children,
      teams: input.teams,
      messages: input.messages,
      commands: input.commands,
    });
  const authorization = await session.authority.harnessRunAuthorization();
  // A submitted prompt with no checkpoint yet is parked in its first model
  // round; one whose checkpoint no longer parses cannot be driven either.
  // The cancellation-side answers below deliberately throw into the
  // caller's retriable refusal instead of answering inapplicable (R11):
  // a plain attach on these shapes stands a Session no settlement route
  // can pay — no live waiter, no projection, only a durable-looking 200.
  if (authorization.status === 'initial') {
    if (passive) throw new Error('Parked in the first model round');
    const journalSettled = await tryJournalOnlySettle();
    if (journalSettled !== undefined) return journalSettled;
    return declined('model_start');
  }
  if (authorization.status === 'blocked') {
    if (isDurableBlockedVerdict(authorization)) {
      if (passive)
        throw new Error(
          authorization.message ??
            `Checkpoint read is durably blocked (${authorization.reason})`,
        );
      return declined('checkpoint_blocked');
    }
    // A store glitch while reading the staged state erased into the same
    // status as a durable verdict: transient, so the caller retries.
    if (isTransientStoreBlock(authorization))
      throw new Error(
        authorization.message ??
          `Checkpoint read was transiently blocked (${authorization.reason})`,
      );
    // A reason this file does not know is not proven durable, and only a
    // durable verdict may end a Turn: stay retriable so a reason core adds
    // later cannot silently become a terminal failure.
    throw new Error(
      authorization.message ??
        `Checkpoint read was blocked (${authorization.reason})`,
    );
  }
  let checkpoint = authorization.checkpoint;
  if (checkpoint.identity.turnId !== promptId) {
    if (passive)
      throw new Error(
        `Checkpoint names a different Turn (${checkpoint.identity.turnId})`,
      );
    // A checkpoint that never bound the Turn is the yolo journal-only
    // shape (#13847): no wait checkpointed the interrupted Turn, so its
    // crash left a runnable checkpoint that names nothing.
    if (checkpoint.identity.turnId === null) {
      const journalSettled = await tryJournalOnlySettle();
      if (journalSettled !== undefined) return journalSettled;
    }
    return declined('unresolved_after_settle');
  }
  if (
    checkpoint.continuation.phase !== 'await_runtime' &&
    checkpoint.continuation.phase !== 'results_ready'
  ) {
    // The stale checkpoint copy is not the authority on an approval
    // wait: when the owner died, the durable action record is. A still
    // requested record is a wait the USER owns — never a verdict — so
    // answer inapplicable and let the resolution write durably (D3).
    // Anything else means the wait ended already: with no takeover
    // signal the dead wait may only converge transiently (the route's
    // refusal), for CANCELLING its settle was written before this call —
    // and a drive takeover for a DECIDED wait resolves it through the
    // wait's own gate so the continuation below runs on facts, not on
    // the copy the dead owner left behind (P1-2).
    if (
      checkpoint.approval !== null &&
      checkpoint.approval.state === 'requested'
    ) {
      const actionState = session.authority.action(
        checkpoint.approval.requestId,
      )?.state;
      if (actionState === undefined || actionState === 'requested')
        return inapplicable();
      // The wait the USER owns ended: a decided wait advances through
      // its own gate when the boundary exists (the continuation below
      // runs on the fresh check); an undecided one is transient (its
      // terminal honest answer is the route's refusal, not my mint).
      if (actionState === 'decided') {
        // A drive takeover advances the wait through its own gate (it's
        // the only rider who may add a checkpoint here: a cancellation
        // never crosses it — an earlier version leaked one passively and
        // the journal's verify path had to eat a foreign wait).
        if (!passive) {
          const resolved = await createManagedHarnessHandle(session)
            .resolveDurableWait()
            .catch(() => null);
          if (resolved === null)
            throw new Error(
              'Parked approval decided but its durable wait could not be advanced',
            );
          const after = await session.authority.harnessRunAuthorization();
          if (after.status !== 'runnable')
            throw new Error(
              'Parked approval resolved to an unrunnable continuation',
            );
          checkpoint = after.checkpoint;
        }
      } else {
        throw new Error(
          `Parked approval ended without a decision (${actionState})`,
        );
      }
    }
    // The agent wait (#13708): the fold belongs to the continue/cancel
    // route's resume arm — it owns the Turn's commit channel, the inline
    // fit predicate and the consumption set — so recovery only classifies.
    // The report mirrors the wait runs exactly: a consumed run reads as
    // settled, an outstanding one as still executing. Their outcomes are
    // always known: the relay ledger keeps a waiting child observable, and
    // the coordinator's unknown-outcome gate must never fire on this phase.
    // No Runtime lease is owed: the wait holds no Broker binding. The
    // carried group on model_output_committed is the same wait a breath
    // past its last fold (every run consumed, a model round owed) — a
    // crash there must never fall back to model_start, or the settled
    // work would be read as a false terminal.
    if (harnessCheckpointIsAgentWait(checkpoint)) {
      return recovered({
        promptId,
        acquiredRuntime: false,
        report: {
          phase: 'await_agent',
          checkpointId: checkpoint.identity.checkpointId,
          activationId: session.activation.activationId,
          executions: (checkpoint.agentWait?.runs ?? []).map((run) => ({
            functionCallId: run.functionCallId,
            toolName: run.toolName,
            executionCallId: run.childRunId,
            runtimeSessionId: hostedRuntimeSessionId(promptId),
            outcome: 'known',
            status: { state: run.consumed ? 'settled' : 'executing' },
          })),
        },
        // Always drivable: every run reads known by construction, and the
        // fold belongs to the continue/cancel route's resume arm in every
        // case — unlike a driven await_runtime report still in flight.
        drivable: true,
      });
    }
    // H4e-b3: the command wait classifies exactly like the agent wait —
    // a folded run reads as settled, an outstanding one as executing, and
    // its reply is the relay's durable evidence, so every outcome is
    // known. No Runtime lease is owed on this load either: the wait owns
    // no Broker binding; the mount the checkpoint names a Turn took in an
    // earlier batch returns with its resume, not with the report.
    if (harnessCheckpointIsCommandWait(checkpoint)) {
      return recovered({
        promptId,
        acquiredRuntime: false,
        report: {
          phase: 'await_command',
          checkpointId: checkpoint.identity.checkpointId,
          activationId: session.activation.activationId,
          executions: (checkpoint.commandWait?.runs ?? []).map((run) => ({
            functionCallId: run.functionCallId,
            toolName: run.toolName,
            executionCallId: run.commandId,
            runtimeSessionId: hostedRuntimeSessionId(promptId),
            outcome: 'known',
            status: { state: run.folded ? 'settled' : 'executing' },
          })),
        },
        // Always drivable, exactly like the agent wait above: every run
        // reads known by construction and the fold belongs to the
        // continue/cancel route's resume arm.
        drivable: true,
      });
    }
    // Settled in the checkpoint while the journal never landed the settle:
    // it completed and must never be recorded as a failure — answering
    // inapplicable hands the load route the one case it DOES project
    // directly (it writes the missing terminal record itself now, or
    // refuses retriably when the projection cannot pay — R11-2). Never a
    // decline the coordinator would stamp as a false terminal (R8-2).
    if (checkpoint.continuation.phase === 'turn_settled') return inapplicable();
    if (HARNESS_MODEL_START_PHASES.has(checkpoint.continuation.phase)) {
      if (passive)
        throw new Error(
          `Parked at model start (${checkpoint.continuation.phase})`,
        );
      // The bound Turn's own journal-only park (#13847): a batch of
      // background launches or team calls committed no wait a takeover
      // can drive, so the crash left the Turn here — answerable from
      // the journal, never a terminal decline.
      const journalSettled = await tryJournalOnlySettle();
      if (journalSettled !== undefined) return journalSettled;
      return declined('model_start');
    }
    // A phase outside the model-start vocabulary is not one a takeover
    // may drive: classify by the durable verdict rather than by name.
    if (passive)
      throw new Error(
        `Parked at an unknown phase (${checkpoint.continuation.phase})`,
      );
    return declined('checkpoint_blocked');
  }
  const items = (checkpoint.tools?.items ?? []).filter(
    (item) => item.outcomeSource === 'runtime',
  );
  let broker: HostedWorkspaceBroker;
  try {
    broker = await originalRuntimeBroker(
      session,
      promptId,
      items,
      input.brokerOptions,
    );
  } catch (cause) {
    // The checkpoint's executions cannot be rebuilt durably (missing args,
    // an args kind mismatch across owners, or a split ownership) — that is
    // a deterministic function of the journal, never a retry-later. A
    // cancellation-only load needs no rebuild at all: it settles the Turn
    // through the cancel route's own fences.
    if (cause instanceof RecoveryDeclined)
      return passive ? inapplicable() : declined('batch_not_durable');
    throw cause;
  }
  const pending = items.filter((item) => item.state === 'in_progress');
  const states = new Map<
    string,
    { state: HostedRuntimeRecoveryExecutionState } | undefined
  >();
  let acquiredRuntime = false;
  if (passive && items.length > 0) {
    // A replacement Broker answers status, cancel and release only for a
    // Runtime Session it has adopted, so the cancellation path re-attaches
    // to the dead owner's one first. Acquiring dispatches nothing.
    //
    // The passive path never compensation-releases: a release persists the
    // record as RELEASED, every retried acquire of the same identity then
    // conflicts with 409 runtime_session_not_acquirable, and a load that
    // throws before registration leaves no owner a route could hand back. The
    // adoption instead stays owed to the retried takeover, which re-acquires
    // a READY session under the same identity idempotently server-side; a
    // load that reports successfully hands the lease to the cancel route.
    // The continuation takeover keeps its #13083 handback discipline for
    // now — whether the same wedge reasoning applies there is a recorded
    // follow-up, not settled by this change.
    await broker.acquire();
    acquiredRuntime = true;
    input.onPassiveRuntimeAcquired?.(broker.runtimeSessionId);
  }
  if (pending.length > 0) {
    if (passive) {
      for (const item of pending) {
        const status = await broker.status(item.executionCallId);
        // Only a still-reconcilable unknown reports as failing to account
        // for the execution; a terminally fenced abandoned record keeps its
        // distinction so the coordinator can cancel over it.
        states.set(
          item.executionCallId,
          status === undefined || status.state === 'unknown'
            ? undefined
            : { state: status.state },
        );
      }
    } else {
      // The Shell profile's drives need the original publisher, which a
      // replacement cannot rebuild; refuse rather than risk a replay.
      if (pending.some((item) => item.toolName === 'run_shell_command')) {
        return declined('shell_in_flight');
      }
      try {
        await broker.acquire();
        acquiredRuntime = true;
        const harness = createManagedHarnessHandle(session);
        // A write-then-resolve crash window must not journal a tool_result
        // twice when the recovery retries: collect what is already durable.
        const journaled = await journaledToolResultIds(session, promptId);
        const intents = new Map(
          session.authority
            .eventsInSequenceRange(1, session.authority.committedSequence)
            .filter((event) => event.kind === 'tool.intent')
            .map((event) => [
              event.payload['executionCallId'] as string,
              event,
            ]),
        );
        for (const item of pending) {
          const argsRef = intents.get(item.executionCallId)?.payload[
            'argsRef'
          ] as ManagedSessionDurableRef | undefined;
          if (argsRef === undefined) throw new RecoveryDeclined();
          const stored = JSON.parse(
            (await session.resources.read(argsRef)).toString('utf8'),
          ) as { payloadJson?: unknown };
          if (typeof stored.payloadJson !== 'string')
            throw new RecoveryDeclined();
          const result = await broker.execute(
            item.executionCallId,
            stored.payloadJson,
            new AbortController().signal,
          );
          let parts = toolResultParts(item, result);
          let outcome = outcomeBytes(item, parts);
          let record: ChatRecord = {
            uuid: randomUUID(),
            parentUuid: item.modelMessageId,
            sessionId: input.sessionId,
            timestamp: new Date().toISOString(),
            type: 'tool_result',
            cwd: input.cwd,
            version: 'hosted-harness/1',
            daemonPromptId: promptId,
            message: { role: 'user', parts },
          };
          const fits = (candidate: Part[]) =>
            outcomeBytes(item, candidate).byteLength <=
              HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes &&
            Buffer.byteLength(
              JSON.stringify({
                ...record,
                message: { role: 'user', parts: candidate },
              }),
            ) <= HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes;
          if (item.toolName === 'glob' && !fits(parts)) {
            const truncated = truncateHostedGlobResponse(parts, fits);
            if (truncated) {
              parts = truncated;
              outcome = outcomeBytes(item, parts);
              record = { ...record, message: { role: 'user', parts } };
            }
          }
          if (!fits(parts)) {
            // Mirror the live turn's durable ceiling: keep the settled outcome
            // but omit an oversized body rather than replaying the execution.
            const omitted = convertToFunctionErrorResponse(
              item.toolName,
              item.functionCallId,
              [],
              `Tool execution settled as ${result.executionStatus}, but its output exceeds the ${HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes}-byte durable Session limit and was omitted.` +
                (item.toolName === 'read_file'
                  ? ' Request a smaller offset/limit range.'
                  : ''),
            );
            const omittedResponse = omitted[0]?.functionResponse;
            if (!omittedResponse || omitted.length !== 1)
              throw new Error('Runtime result cannot be represented durably.');
            omittedResponse.response = {
              ...omittedResponse.response,
              executionStatus: result.executionStatus,
              outputOmitted: true,
            };
            parts.length = 0;
            parts.push(...omitted);
            outcome = outcomeBytes(item, parts);
            record = {
              ...record,
              message: { role: 'user', parts },
            };
          }
          const outcomeRef = await session.resources.publish(
            'managed-tool-outcome',
            outcome,
          );
          if (!journaled.has(item.functionCallId)) {
            await session.sink.write(record);
          }
          await harness.resolveAwaitRuntime(item.executionCallId, outcomeRef);
          states.set(item.executionCallId, { state: 'settled' });
        }
      } catch (cause) {
        // The caller only learns about the lease from a returned report, so
        // every failure exit here must give it back first — unless the
        // Session already held it before this call (see leaseAlreadyHeld).
        if (!input.leaseAlreadyHeld) {
          await broker.release().catch((releaseCause) => {
            writeStderrLineSafe(
              `qwen serve: Hosted Harness recovery could not release the Runtime Session: ${String(releaseCause)}`,
            );
          });
          acquiredRuntime = false;
        }
        if (cause instanceof RecoveryDeclined)
          return passive ? inapplicable() : declined('batch_not_durable');
        throw cause;
      }
    }
  } else if (!passive && items.length > 0) {
    // Nothing is left to drive, but the dead owner still holds the Runtime
    // Session it prepared these executions in. Re-attach to it so the
    // terminal route can release the Workspace for other Sessions.
    try {
      await broker.acquire();
      acquiredRuntime = true;
    } catch (cause) {
      // A lost acquire reply leaves the lease uncertain: hand back whatever
      // may exist rather than stranding it — unless the Session already holds
      // the lease (leaseAlreadyHeld), where nothing is uncertain and the
      // release would only persist RELEASED against every later redrive.
      if (!input.leaseAlreadyHeld)
        await broker.release().catch((releaseCause) => {
          writeStderrLineSafe(
            `qwen serve: Hosted Harness recovery could not release the Runtime Session: ${String(releaseCause)}`,
          );
        });
      throw cause;
    }
  }
  let finalAuthorization;
  try {
    finalAuthorization = await session.authority.harnessRunAuthorization();
  } catch (cause) {
    // A failed continuation hands the lease back — but a passive load must
    // not (see the adoption comment above): its retried takeover re-acquires
    // the READY identity idempotently, while a release would wedge it. A
    // lease the Session already held before this call stays held for the
    // same reason (leaseAlreadyHeld).
    if (acquiredRuntime && !passive && !input.leaseAlreadyHeld) {
      await broker.release().catch((releaseCause) => {
        writeStderrLineSafe(
          `qwen serve: Hosted Harness recovery could not release the Runtime Session: ${String(releaseCause)}`,
        );
      });
      acquiredRuntime = false;
    }
    throw cause;
  }
  if (finalAuthorization.status !== 'runnable') {
    // Same split as the catch above: only the continuation path hands its
    // lease back here; a passive load leaves the adoption owed.
    if (acquiredRuntime && !passive && !input.leaseAlreadyHeld) {
      await broker.release().catch((releaseCause) => {
        writeStderrLineSafe(
          `qwen serve: Hosted Harness recovery could not release the Runtime Session: ${String(releaseCause)}`,
        );
      });
    }
    if (
      finalAuthorization.status === 'blocked' &&
      isTransientStoreBlock(finalAuthorization)
    ) {
      throw new Error(
        finalAuthorization.message ??
          `Checkpoint re-read was transiently blocked (${finalAuthorization.reason})`,
      );
    }
    // A durable verdict re-read after settling is the same fact as the
    // pre-settle one, so it carries the same reason instead of blaming the
    // settlement for a checkpoint that no longer parses.
    if (
      finalAuthorization.status === 'blocked' &&
      isDurableBlockedVerdict(finalAuthorization)
    ) {
      return passive ? inapplicable() : declined('checkpoint_blocked');
    }
    if (passive) return inapplicable();
    // Same rule as the pre-settle read: a reason this file does not know
    // is not proven durable, and only a durable verdict may end the Turn
    // — stay retriable rather than terminalizing on
    // 'unresolved_after_settle'.
    throw new Error(
      finalAuthorization.status === 'blocked'
        ? (finalAuthorization.message ??
          `Checkpoint re-read was blocked (${finalAuthorization.reason})`)
        : 'Checkpoint became unavailable before the re-read settled',
    );
  }
  const finalCheckpoint = finalAuthorization.checkpoint;
  const executions: HostedRuntimeRecoveryExecution[] = items.map((item) => {
    const state = states.get(item.executionCallId);
    return {
      functionCallId: item.functionCallId,
      toolName: item.toolName,
      executionCallId: item.executionCallId,
      runtimeSessionId: broker.runtimeSessionId,
      outcome:
        item.state === 'settled' || state !== undefined ? 'known' : 'unknown',
      ...(item.state === 'settled'
        ? { status: { state: 'settled' } }
        : state === undefined
          ? {}
          : { status: state }),
    };
  });
  const report: HostedRuntimeRecoveryReport = {
    phase:
      finalCheckpoint.continuation.phase === 'results_ready'
        ? 'results_ready'
        : 'await_runtime',
    checkpointId: finalCheckpoint.identity.checkpointId,
    activationId: session.activation.activationId,
    executions,
  };
  return recovered({
    promptId,
    ...(acquiredRuntime
      ? {
          acquiredRuntime: true as const,
          runtimeSessionId: broker.runtimeSessionId,
        }
      : { acquiredRuntime: false as const }),
    report,
    // The marker arms only for a report the coordinator can drive:
    // everything answered known, and a drive report reached results_ready.
    drivable:
      executions.every((execution) => execution.outcome === 'known') &&
      (passive || report.phase === 'results_ready'),
  });
}

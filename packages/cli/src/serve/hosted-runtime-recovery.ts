/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { Part } from '@google/genai';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import type {
  HarnessRunAuthorization,
  HarnessToolItem,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-checkpoint.js';
import { HARNESS_MODEL_START_PHASES } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-checkpoint.js';
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
  hostedRuntimeSessionId,
  truncateHostedGlobResponse,
} from './hosted-workspace-tool-turn.js';
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
  phase: 'await_runtime' | 'results_ready';
  checkpointId: string;
  activationId: string;
  executions: HostedRuntimeRecoveryExecution[];
}

export interface HostedRecoveryTurn {
  promptId: string;
  report: HostedRuntimeRecoveryReport;
  /** Whether the recovery acquired the Runtime Session, which a later
   * continue/cancel must release. */
  acquiredRuntime: boolean;
  /** Whether the coordinator can still drive this report: every execution
   * reads known, and a drive report reached results_ready. The takeover
   * arms the undriven marker only in that case, since the coordinator fails
   * an undrivable one without ever calling continue/cancel. */
  drivable: boolean;
}

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
    const before = await broker.status(item.executionCallId);
    if (before?.state === 'unknown')
      throw new Error('Runtime execution outcome is unknown.');
    if (before?.state === 'abandoned') {
      unobserved.add(item.executionCallId);
      continue;
    }
    if (stopComplete(before)) continue;
    await broker.cancel(item.executionCallId).catch(() => undefined);
    const deadline = Date.now() + 30_000;
    for (;;) {
      const status = await broker.status(item.executionCallId);
      if (status?.state === 'unknown') {
        unobserved.add(item.executionCallId);
        throw new Error('Runtime execution outcome is unknown.');
      }
      if (status === undefined || status.state === 'abandoned') {
        unobserved.add(item.executionCallId);
        break;
      }
      if (status.state === 'settled') break;
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
 */
async function answerAbandonedTurnCalls(input: {
  session: ManagedSession;
  sessionId: string;
  cwd: string;
  promptId: string;
  message: string;
}): Promise<void> {
  const records = (await input.session.sink.project()).filter(
    (entry) => entry.daemonPromptId === input.promptId,
  );
  const answered = new Set(
    records
      .filter((entry) => entry.type === 'tool_result')
      .flatMap((entry) => entry.message?.parts ?? [])
      .map((part) => part.functionResponse?.id)
      .filter((id): id is string => typeof id === 'string'),
  );
  const owed = new Map<string, { name: string; messageId: string }>();
  for (const record of records.filter((entry) => entry.type === 'assistant'))
    for (const part of record.message?.parts ?? []) {
      const call = part.functionCall;
      if (call?.id && call.name && !answered.has(call.id) && !owed.has(call.id))
        owed.set(call.id, { name: call.name, messageId: record.uuid });
    }
  for (const [functionCallId, call] of owed) {
    const parts = convertToFunctionErrorResponse(
      call.name,
      functionCallId,
      [],
      `The tool call never ran: ${input.message}.`,
    );
    const response = parts[0]?.functionResponse;
    if (!response || parts.length !== 1)
      throw new Error('Runtime result cannot be represented durably.');
    response.response = {
      ...response.response,
      executionStatus: 'cancelled',
    };
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
  }
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
 * ending. Once the durable Action is final, the wait is advanced, the
 * abandoned calls answered, and the turn's Workspace acquisition (its
 * promptId-named runtime session) handed back with the verdict, or every
 * later tool call in the Workspace waits behind a dead holder (F9). The
 * returned Broker releases after the caller's terminal
 * record is durable, never before. Throws with nothing settled when the
 * stop cannot be proven, leaving the Turn to the recovery fleet; a
 * checkpoint the authorization could not verify (a faulting Store read
 * erases into `missing_state`) refuses the same way rather than being
 * mistaken for "no Runtime wait to settle".
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
      await settleParkedTurnCancelled({
        session: input.session,
        sessionId: input.sessionId,
        cwd: input.cwd,
        promptId: input.promptId,
        unobserved: stopped.unobserved,
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
  const authorization = await session.authority.harnessRunAuthorization();
  // A submitted prompt with no checkpoint yet is parked in its first model
  // round; one whose checkpoint no longer parses cannot be driven either.
  // The cancellation-side answers below deliberately throw into the
  // caller's retriable refusal instead of answering inapplicable (R11):
  // a plain attach on these shapes stands a Session no settlement route
  // can pay — no live waiter, no projection, only a durable-looking 200.
  if (authorization.status === 'initial') {
    if (passive) throw new Error('Parked in the first model round');
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
        const journaled = new Set(
          (await session.sink.project())
            .filter(
              (entry) =>
                entry.daemonPromptId === promptId &&
                entry.type === 'tool_result',
            )
            .flatMap((entry) => entry.message?.parts ?? [])
            .map((part) => part.functionResponse?.id)
            .filter((id): id is string => typeof id === 'string'),
        );
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
    acquiredRuntime,
    report,
    // The marker arms only for a report the coordinator can drive:
    // everything answered known, and a drive report reached results_ready.
    drivable:
      executions.every((execution) => execution.outcome === 'known') &&
      (passive || report.phase === 'results_ready'),
  });
}

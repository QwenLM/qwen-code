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
  HarnessAgentWaitRun,
  HarnessRunAuthorization,
  HarnessToolItem,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-checkpoint.js';
import {
  HARNESS_MODEL_START_PHASES,
  harnessCheckpointIsAgentWait,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-checkpoint.js';
import {
  managedExtensionRecordKey,
  managedTaskId,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-projection.js';
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
import type { HostedChildAgentSession } from './hosted-child-agent-session.js';
import {
  HOSTED_AGENT_CALL_NOT_REACHED_TEXT,
  HOSTED_AGENT_WAIT_ABANDONED_TEXT,
  hostedAgentBackgroundStartedText,
  hostedChildRunIdFor,
  hostedRuntimeSessionId,
  journaledToolResultIds,
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

export interface HostedRuntimeRecoveryExecution {
  functionCallId: string;
  toolName: string;
  executionCallId: string;
  runtimeSessionId: string;
  outcome: 'known' | 'unknown';
  status?: { state: string };
}

export interface HostedRuntimeRecoveryReport {
  phase: 'await_runtime' | 'await_agent' | 'results_ready';
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
 */
export async function settleParkedTurnCancelled(input: {
  session: ManagedSession;
  sessionId: string;
  cwd: string;
  promptId: string;
}): Promise<void> {
  const authorization = await input.session.authority.harnessRunAuthorization();
  if (authorization.status !== 'runnable') return;
  const checkpoint = authorization.checkpoint;
  if (checkpoint.identity.turnId !== input.promptId) return;
  const pending = (checkpoint.tools?.items ?? []).filter(
    (item) => item.state === 'in_progress' && item.outcomeSource === 'runtime',
  );
  if (pending.length === 0) return;
  const harness = createManagedHarnessHandle(input.session);
  // A write-then-resolve crash window must not journal a tool_result twice
  // when the cancel retries: collect what is already durable.
  const journaled = await journaledToolResultIds(input.session, input.promptId);
  for (const item of pending) {
    const parts = convertToFunctionErrorResponse(
      item.toolName,
      item.functionCallId,
      [],
      'The Runtime execution was cancelled with its owner.',
    );
    const response = parts[0]?.functionResponse;
    if (!response || parts.length !== 1) {
      throw new Error('Runtime result cannot be represented durably.');
    }
    response.response = {
      ...response.response,
      executionStatus: 'cancelled',
    };
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
}

/**
 * Best-effort stop for the parked executions of a recovered cancellation.
 * A cancellation only becomes durable evidence after the execution reaches a
 * terminal state — issuing cancel is not proof, since the Broker accepts a
 * cancel without having stopped anything yet. An execution the Broker never
 * knew (definitive not-found) is already stopped.
 */
export async function stopParkedRuntimeExecutions(input: {
  session: ManagedSession;
  promptId: string;
  brokerOptions: HostedWorkspaceBrokerOptions;
}): Promise<HostedWorkspaceBroker> {
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
  for (const item of authorization.checkpoint.tools?.items ?? []) {
    if (item.state !== 'in_progress' || item.outcomeSource !== 'runtime')
      continue;
    const before = await broker.status(item.executionCallId);
    if (before?.state === 'unknown')
      throw new Error('Runtime execution outcome is unknown.');
    if (before === undefined || before.state === 'settled') continue;
    await broker.cancel(item.executionCallId).catch(() => undefined);
    const deadline = Date.now() + 30_000;
    for (;;) {
      const status = await broker.status(item.executionCallId);
      if (status?.state === 'unknown')
        throw new Error('Runtime execution outcome is unknown.');
      if (status === undefined || status.state === 'settled') break;
      if (Date.now() >= deadline) {
        throw new Error(
          'Runtime execution did not reach a terminal state after cancellation.',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return broker;
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
  // One authority for the exactly-once predicate: the same helper every
  // replayed fold rides, fed the projection already in hand.
  const answered = await journaledToolResultIds(
    input.session,
    input.promptId,
    records,
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
  let filled = 0;
  for (const part of assistant.message?.parts ?? []) {
    const callId = part.functionCall?.id;
    const name = part.functionCall?.name;
    if (typeof callId !== 'string' || typeof name !== 'string') continue;
    if (waitedCalls.has(callId)) continue;
    // The journaled set gates only the fold, never the replay-safe marks —
    // both sibling arms in this diff document and follow the same rule.
    const foldOwed = !journaled.has(callId);
    const children = input.children;
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
        const taskId = managedTaskId(
          managedExtensionRecordKey(
            input.managed.authority.sessionHeader.sessionKey.sessionId,
            'child_run',
            admitted.run.executionCallId ??
              hostedChildRunIdFor(input.promptId, callId),
          ),
        );
        await writeFold(
          convertToFunctionResponse(name, callId, [
            { text: hostedAgentBackgroundStartedText(taskId) },
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
                `Child agent run ${record.run.state.replace(/^\w/, (letter) => letter.toLowerCase())} (${record.stopReason ?? 'unknown'}).`,
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
          const whole = convertToFunctionResponse(name, callId, [{ text }]);
          // The same fit discipline as the live arm: the answer still must
          // land, folded to the inline bound with its marker instead of
          // erroring the recovered Turn — the full bytes stay on the
          // acceptance record, and the fit predicate, not an estimate,
          // measures the fold.
          let fitted: Part[] | undefined;
          if (fits(whole)) {
            fitted = whole;
          } else {
            const marker =
              '\n… (truncated: the full result is on the acceptance record)';
            for (
              let head = Math.floor(text.length / 2);
              head > 0 && fitted === undefined;
              head = Math.floor(head / 2)
            ) {
              const folded = convertToFunctionResponse(name, callId, [
                { text: text.slice(0, head) + marker },
              ]);
              if (fits(folded)) fitted = folded;
            }
          }
          if (fitted === undefined)
            throw new Error(
              'Admitted child agent result cannot be recorded inline.',
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
 * mistaken for "no Runtime wait to settle".
 */
export async function settleInterruptedTurnRuntime(input: {
  session: ManagedSession;
  sessionId: string;
  cwd: string;
  promptId: string;
  brokerOptions: HostedWorkspaceBrokerOptions | undefined;
  toolProfile: boolean;
  /** The child ledger the agent-wait arm's gap fill polls — the same one
   * the live arm drives, so an admitted orphan never meets a fabricated
   * answer even here. */
  children?: HostedChildAgentSession;
  consume?: (childRunId: string) => void;
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
      broker = await stopParkedRuntimeExecutions({
        session: input.session,
        promptId: input.promptId,
        brokerOptions: input.brokerOptions,
      });
      await settleParkedTurnCancelled({
        session: input.session,
        sessionId: input.sessionId,
        cwd: input.cwd,
        promptId: input.promptId,
      });
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
      await fillParkedRoundAgentGaps({
        managed: input.session,
        sessionId: input.sessionId,
        promptId: input.promptId,
        cwd: input.cwd,
        gapText: HOSTED_AGENT_CALL_NOT_REACHED_TEXT,
        children: input.children,
        consume: input.consume,
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
  const states = new Map<string, { state: string } | undefined>();
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
        states.set(
          item.executionCallId,
          status?.state === 'unknown' ? undefined : status,
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
  return recovered({
    promptId,
    acquiredRuntime,
    report: {
      phase:
        finalCheckpoint.continuation.phase === 'results_ready'
          ? 'results_ready'
          : 'await_runtime',
      checkpointId: finalCheckpoint.identity.checkpointId,
      activationId: session.activation.activationId,
      executions,
    },
  });
}

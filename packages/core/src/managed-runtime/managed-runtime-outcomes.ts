/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import {
  createManagedHarnessHandle,
  type ManagedHarnessHandle,
} from './managed-harness-factory.js';
import {
  createNextTurnReadyHarnessCheckpoint,
  encodeHarnessCheckpointV1,
  HARNESS_TURN_COMPLETE_BOUNDARY,
  parseHarnessCheckpointV1,
  tryParseHarnessCheckpointV1,
  type HarnessCheckpointV1,
} from './managed-harness-checkpoint.js';
import type { ManagedSession } from './managed-session-assembly.js';
import type { LocalManagedSessionAuthority } from './managed-session-authority.js';
import type { ToolErrorType } from '../tools/tool-error.js';
import {
  assertManagedSessionDurableRef,
  type ManagedSessionDurableRef,
} from './managed-session-records.js';
import {
  managedToolDigest,
  managedToolFailureMessage,
  managedToolResponseParts,
} from '../tools/managed-tool-protocol.js';
import {
  convertToFunctionErrorResponse,
  convertToFunctionResponse,
} from '../core/coreToolScheduler.js';
import { getCachedGitBranch } from '../utils/gitUtils.js';

/** The tool protocol the local host dispatches over. */
export const MANAGED_RUNTIME_TOOL_CAPABILITY_VERSION =
  'managed-runtime-tool-v2';
/** The approval contract the host answers for every call it admits. */
export const MANAGED_RUNTIME_HOST_POLICY_VERSION = 'host-approval-v1';

export interface ManagedRuntimeCallAdmission {
  /** The scheduler's call id, shared by the intent, the binding and the worker reference. */
  readonly functionCallId: string;
  readonly toolName: string;
  readonly promptId: string;
  /** The final parameters as the wire carries them. */
  readonly params: Record<string, unknown>;
  /** The tool's declaration for the model: its name and parameter schema. */
  readonly toolDefinition: Record<string, unknown>;
  /** The incarnation of the worker the call goes to. */
  readonly workerIncarnation: string;
}

export interface ManagedRuntimeCallOutcome {
  readonly functionCallId: string;
  readonly executionStatus: string;
  /** The worker's payload with the model content and the error detail. */
  readonly payload: unknown;
}

const ROUTE_BODY = {
  v: 1,
  host: 'qwen-acp-managed',
  capabilityVersion: MANAGED_RUNTIME_TOOL_CAPABILITY_VERSION,
  policyVersion: MANAGED_RUNTIME_HOST_POLICY_VERSION,
} as const;

/**
 * The local host's Runtime outcome writer: every call a Managed session
 * dispatches to its worker is admitted before it leaves, settled before the
 * model continues, and forgotten by the worker afterwards. It writes through
 * the same Managed Session authority as the recorder, in the Hosted schema
 * and with the Hosted dispatch gate, so a restored log answers which calls
 * took effect without any process still running.
 */
export class LocalManagedRuntimeOutcomes {
  private readonly harness: ManagedHarnessHandle;
  private readonly definitionRefs = new Map<string, ManagedSessionDurableRef>();
  private routeRef?: Promise<ManagedSessionDurableRef>;
  private admitTail: Promise<unknown> = Promise.resolve();

  constructor(private readonly session: ManagedSession) {
    this.harness = createManagedHarnessHandle(session);
  }

  /**
   * Admits one call before its dispatch: publishes its final parameters and
   * its tool's definition, appends the `tool.intent`, and commits the
   * `await_runtime` checkpoint that covers the accumulating batch of the
   * prompt. Admissions serialize so two parallel calls cannot claim the same
   * ordinal or leapfrog each other's checkpoint contribution.
   */
  admit(input: ManagedRuntimeCallAdmission): Promise<void> {
    const run = this.admitTail.then(() => this.admitSerial(input));
    this.admitTail = run.catch(() => undefined);
    return run;
  }

  private async admitSerial(input: ManagedRuntimeCallAdmission): Promise<void> {
    const { session } = this;
    const authority = session.authority;
    const promptId = input.promptId;
    // Slices before this one recorded without checkpoints; the Runtime
    // evidence starts here, covering the committed log. A session whose
    // checkpoint blocks it stops here, before anything is dispatched.
    await this.harness.ensureCheckpoint();
    // The digest is the first per-call refusal: ensureCheckpoint above may
    // already have committed the session's initial before_model checkpoint
    // (so a blocked session reports its block ahead of this size error), but
    // nothing about the refused call — no intent, item or ordinal — is
    // written before the digest passes.
    const inputDigest = managedToolDigest(input.params);
    // Results committed but the closing steps never ran — a close or crash
    // between the batch's commits and its consumption — join them now:
    // every outcome is already committed, so closing is not replaying. The
    // close must never fire mid-turn: the live turn's own results_ready is
    // closed by the batch-end finalization after the records are flushed,
    // so only another turn's (or a restored activation's) leftover closes
    // here.
    const leftover = await this.latestCheckpoint();
    if (
      leftover?.continuation.phase === 'results_ready' &&
      (leftover.identity.turnId !== promptId ||
        leftover.identity.activationId !== session.activation.activationId)
    ) {
      await this.finalizeBatch();
    }
    const tail = await this.latestCheckpoint();
    // A turn that settled under an earlier prompt ends before this prompt's
    // batch begins, or this prompt would inherit its batch and its attempt.
    if (
      tail?.continuation.phase === 'turn_settled' &&
      tail.identity.turnId !== promptId
    ) {
      const state = encodeHarnessCheckpointV1(
        createNextTurnReadyHarnessCheckpoint({
          previous: tail,
          checkpointId: `ckpt-${authority.committedSequence + 1}`,
          coveredSequence: authority.committedSequence,
          previousCheckpointId: tail.identity.checkpointId,
          activationId: session.activation.activationId,
          turnId: promptId,
          promptId,
        }),
      );
      await authority.commitCheckpoint(
        {
          operation: 'commitCheckpoint',
          commandId: `harness:next_turn_ready:${session.activation.activationId}:${promptId}:${authority.committedSequence}`,
          sessionKey: authority.sessionHeader.sessionKey,
          contentDigest: createHash('sha256').update(state).digest('hex'),
        },
        { state, boundary: HARNESS_TURN_COMPLETE_BOUNDARY },
        { class: 'harness', activation: session.activation },
      );
    }
    const argsRef = await session.resources.publish(
      'managed-tool-args',
      Buffer.from(JSON.stringify(input.params), 'utf8'),
    );
    const definitionRef =
      this.definitionRefs.get(input.toolName) ??
      (await session.resources.publish(
        'managed-tool-definition',
        Buffer.from(JSON.stringify(input.toolDefinition), 'utf8'),
      ));
    this.definitionRefs.set(input.toolName, definitionRef);
    const checkpoint = await this.latestCheckpoint();
    // The factory assigns the shared batch state; the intent records it.
    const batchId =
      checkpoint?.tools?.batchId ?? `batch-${input.functionCallId}`;
    const ordinal = checkpoint?.tools?.items.length ?? 0;
    await authority.appendExecutionEvent(
      {
        operation: 'recordToolIntent',
        commandId: `tool-intent:${input.functionCallId}`,
        sessionKey: authority.sessionHeader.sessionKey,
        contentDigest: argsRef.digest,
      },
      (sequence) => ({
        v: 1,
        sequence,
        eventId: `tool-intent:${input.functionCallId}`,
        sessionKey: authority.sessionHeader.sessionKey,
        kind: 'tool.intent',
        occurredAt: Date.now(),
        subject: {
          type: 'activation',
          scopeId: session.activation.activationId,
          activationId: session.activation.activationId,
          epoch: session.activation.epoch,
        },
        payload: {
          executionCallId: input.functionCallId,
          batchId,
          ordinal,
          toolDefinitionRef: definitionRef,
          argsRef,
          outcomeSource: 'runtime',
        },
      }),
      { class: 'harness', activation: session.activation },
    );
    // Cached like the definitions, except a rejected publish retries: a
    // transient failure of one admission must not wedge later ones.
    this.routeRef ??= session.resources
      .publish(
        'managed-execution-route',
        Buffer.from(JSON.stringify(ROUTE_BODY), 'utf8'),
      )
      .catch((error: unknown) => {
        this.routeRef = undefined;
        throw error;
      });
    const routeRef = await this.routeRef;
    await this.harness.commitAwaitRuntimeBatch(
      [
        {
          functionCallId: input.functionCallId,
          toolName: input.toolName,
          executionCallId: input.functionCallId,
          // One binding per call: the incarnation it names, adjoined with
          // the call id, answers which physical worker the call went to and
          // stays unique across a session that reuses one worker.
          invocationBindingId: `${input.workerIncarnation}:${input.functionCallId}`,
          capabilityVersion: MANAGED_RUNTIME_TOOL_CAPABILITY_VERSION,
          policyVersion: MANAGED_RUNTIME_HOST_POLICY_VERSION,
          mediaVersion: null,
          modelMessageId: `local-model-message:${promptId}`,
          partIndex: ordinal,
          ordinal,
          inputDigest,
          progressCursor: null,
          attemptId: `attempt:${promptId}`,
          routeRef,
        },
      ],
      { turnId: promptId, promptId },
    );
  }

  /**
   * Settles one call before its result reaches the model loop: publishes its
   * execution status and wire payload as the durable outcome, appends its
   * `tool.receipt`, and settles the checkpoint item. A call that never ran
   * settles the same way, with execution status `not_started`: the log then
   * distinguishes a refused or undelivered call from a tool failure.
   */
  async settle(
    input: ManagedRuntimeCallOutcome,
  ): Promise<ManagedSessionDurableRef> {
    const { session } = this;
    const authority = session.authority;
    const outcomeBytes = Buffer.from(
      JSON.stringify({
        version: 1,
        identity: {
          sessionId: authority.sessionHeader.sessionKey.sessionId,
          executionCallId: input.functionCallId,
        },
        executionStatus: input.executionStatus,
        result: input.payload,
      }),
      'utf8',
    );
    const outcomeRef = await session.resources.publish(
      'managed-tool-outcome',
      outcomeBytes,
    );
    await authority.appendExecutionEvent(
      {
        operation: 'recordToolResult',
        commandId: input.functionCallId,
        sessionKey: authority.sessionHeader.sessionKey,
        contentDigest: createHash('sha256').update(outcomeBytes).digest('hex'),
      },
      (sequence) => ({
        v: 1,
        sequence,
        eventId: `tool-receipt:${input.functionCallId}`,
        sessionKey: authority.sessionHeader.sessionKey,
        kind: 'tool.receipt',
        occurredAt: Date.now(),
        payload: {
          executionCallId: input.functionCallId,
          toolOutcomeRef: outcomeRef,
          resultRef: outcomeRef,
          resources: [outcomeRef],
          historyRevision: sequence,
        },
      }),
      { class: 'trusted_entry' },
    );
    await this.harness.resolveAwaitRuntime(input.functionCallId, outcomeRef);
    return outcomeRef;
  }

  /**
   * Whether the log carries this call's committed receipt: the durable proof
   * the call took effect. A settle that failed after its receipt committed
   * still left that proof behind, and what proves a call may never block —
   * the restore repair settles the checkpoint item from it on the next open.
   */
  hasCommittedReceipt(executionCallId: string): boolean {
    return this.session.authority
      .eventsInSequenceRange(1, this.session.authority.committedSequence)
      .some(
        (event) =>
          event.kind === 'tool.receipt' &&
          event.payload['executionCallId'] === executionCallId,
      );
  }

  /**
   * Below a restore, a crash may stand between a call's commits: the durable
   * outcome and receipt landed while the checkpoint item never settled, or
   * both settled while the recorded `tool_result` never landed. The receipts
   * prove the calls took effect, and nothing that proves it may block — so
   * the items settle from their receipts, and the missing `tool_result`
   * records are recorded from the settled outcomes, before any gate reads.
   */
  async recoverCommittedReceipts(): Promise<void> {
    // A checkpoint that cannot be read or parsed is the restore gate's to
    // classify into a block, not this repair's: recovering against an unknown
    // state could only guess, so the repair leaves the log untouched here.
    let checkpoint: HarnessCheckpointV1 | undefined;
    try {
      const state = await this.session.authority.readCheckpointState();
      if (state !== undefined) {
        const parsed = tryParseHarnessCheckpointV1(state);
        if (parsed.ok) checkpoint = parsed.checkpoint;
      }
    } catch {
      return;
    }
    if (checkpoint === undefined) return;
    const phase = checkpoint.continuation.phase;
    if (phase === 'await_runtime') {
      const pending = (checkpoint.tools?.items ?? []).filter(
        (item) => item.state !== 'settled',
      );
      if (pending.length > 0) {
        const events = this.session.authority.eventsInSequenceRange(
          1,
          this.session.authority.committedSequence,
        );
        for (const item of pending) {
          const receipt = events.find(
            (event) =>
              event.kind === 'tool.receipt' &&
              event.payload['executionCallId'] === item.executionCallId,
          );
          if (!receipt) continue;
          const outcomeRef = assertManagedSessionDurableRef(
            receipt.payload['toolOutcomeRef'],
            'tool.receipt.toolOutcomeRef',
          );
          await this.harness.resolveAwaitRuntime(
            item.executionCallId,
            outcomeRef,
          );
        }
      }
    }
    // A settle may outlive its record on its own: the crash between the
    // resolve commit and the recorder's write leaves no pending item — and
    // a fully settled continuation reads as results_ready — so the record
    // check runs below both unconsumed phases, not only below repairs.
    if (phase === 'await_runtime' || phase === 'results_ready') {
      await this.restoreRecordedResults();
    }
  }

  private async restoreRecordedResults(): Promise<void> {
    const { session } = this;
    const checkpoint = await this.latestCheckpoint();
    const settled = (checkpoint?.tools?.items ?? []).filter(
      (item) => item.state === 'settled' && item.outcomeRef !== null,
    );
    // Nothing settled means nothing to re-record: return before the recorded
    // scan below reads a single recorded body.
    if (settled.length === 0) return;
    const events = session.authority.eventsInSequenceRange(
      1,
      session.authority.committedSequence,
    );
    // The recovered record continues the chain the live records built: its
    // parent is the committed tail. A fresh root would truncate the walk the
    // next restore builds the history from.
    let parentUuid: string | null = null;
    for (const event of events) {
      if (event.kind !== 'message.committed') continue;
      const messageId = event.payload['messageId'];
      if (typeof messageId === 'string') parentUuid = messageId;
    }
    // Whether a call already has its record is decided by the ids the
    // recorded bodies carry — the toolCallResult call id, the
    // functionResponse ids and the recovered records' own uuids — never by a
    // substring of a serialized body: a result's text can quote another
    // call's id. A body that cannot be read or parsed contributes no ids
    // rather than failing the restore.
    const recorded = new Set<string>();
    for (const event of events) {
      if (
        event.kind !== 'message.committed' ||
        event.payload['role'] !== 'tool_result'
      ) {
        continue;
      }
      const ref = assertManagedSessionDurableRef(
        event.payload['contentRef'],
        'message.committed.contentRef',
      );
      const body = await session.resources
        .read(ref)
        .then((bytes) => bytes.toString())
        .catch(() => undefined);
      if (body === undefined) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(body) as Record<string, unknown>;
      } catch {
        continue;
      }
      const toolCallResult = record['toolCallResult'] as
        | Record<string, unknown>
        | undefined;
      if (typeof toolCallResult?.['callId'] === 'string') {
        recorded.add(toolCallResult['callId']);
      }
      const parts = (
        record['message'] as Record<string, unknown> | undefined
      )?.['parts'];
      if (Array.isArray(parts)) {
        for (const part of parts) {
          const functionResponse = (
            part as Record<string, unknown> | null | undefined
          )?.['functionResponse'] as Record<string, unknown> | undefined;
          if (typeof functionResponse?.['id'] === 'string') {
            recorded.add(functionResponse['id']);
          }
        }
      }
      const uuid = record['uuid'];
      if (
        typeof uuid === 'string' &&
        uuid.startsWith('recovered-tool-result:')
      ) {
        recorded.add(uuid.slice('recovered-tool-result:'.length));
      }
    }
    const envelope = session.authority.recordEnvelope;
    // Read for a record this restore writes, never for the check itself:
    // the lookup blocks on a `git rev-parse`, and a restore with nothing to
    // re-record must not pay it.
    let branch: string | undefined;
    let branchRead = false;
    const branchForRecord = () => {
      if (!branchRead) {
        branchRead = true;
        branch = getCachedGitBranch(envelope.cwd);
      }
      return branch;
    };
    for (const item of settled) {
      if (recorded.has(item.executionCallId)) continue;
      const outcome = await session.resources
        .read(item.outcomeRef!)
        .then((bytes) => bytes.toString())
        .then((body) => {
          try {
            return JSON.parse(body) as {
              result?: {
                executionStatus?: unknown;
                responseParts?: unknown;
                error?: { message?: string; type?: string };
              };
            };
          } catch {
            return undefined;
          }
        })
        .catch(() => undefined);
      // A settled outcome whose body no longer reads still owes the model
      // its functionResponse: without one the projected history pairs the
      // assistant's functionCall with nothing, and the provider rejects the
      // next request as malformed with no gate left to say why.
      const result = outcome?.result ?? {
        executionStatus: 'error',
        error: {
          message: 'The tool call outcome cannot be read from the session log.',
        },
      };
      const executionStatus =
        typeof result.executionStatus === 'string'
          ? result.executionStatus
          : 'error';
      const status =
        executionStatus === 'success'
          ? 'success'
          : executionStatus === 'cancelled'
            ? 'cancelled'
            : 'error';
      // A part that is not an object is dropped rather than failing the
      // open: the durable body is already committed, and the live result
      // path reports the same payload as an ordinary tool error.
      const responseParts = managedToolResponseParts(
        (Array.isArray(result.responseParts)
          ? result.responseParts
          : []
        ).filter((part) => typeof part === 'object' && part !== null),
      );
      // The message the live path would have reported, synthesized from the
      // same durable payload.
      const failureMessage =
        status === 'success'
          ? undefined
          : managedToolFailureMessage({
              executionStatus,
              error: result.error,
            });
      // The model-facing parts are functionResponses in the scheduler's call
      // id space, as the live recorder writes them; the mapped parts stay on
      // the toolCallResult for UI recovery.
      const parts =
        failureMessage === undefined
          ? convertToFunctionResponse(
              item.toolName,
              item.executionCallId,
              responseParts,
            )
          : convertToFunctionErrorResponse(
              item.toolName,
              item.executionCallId,
              responseParts.length > 0 ? responseParts : failureMessage,
              failureMessage,
            );
      // The durable outcome is the recorded history: same tool_result shape
      // the recorder writes, idempotent by its deterministic id.
      const uuid = `recovered-tool-result:${item.executionCallId}`;
      const gitBranch = branchForRecord();
      await session.sink.write({
        ...envelope,
        uuid,
        parentUuid,
        sessionId: session.authority.sessionHeader.sessionKey.sessionId,
        timestamp: new Date().toISOString(),
        type: 'tool_result',
        provenance: 'tool_result',
        ...(gitBranch === undefined ? {} : { gitBranch }),
        message: {
          role: 'user',
          parts,
        },
        toolCallResult: {
          callId: item.executionCallId,
          status,
          responseParts,
          ...(failureMessage === undefined
            ? {}
            : { error: new Error(failureMessage) }),
          errorType:
            result.error?.type === undefined
              ? undefined
              : (result.error.type as ToolErrorType),
          resultDisplay: undefined,
        },
      });
      recorded.add(item.executionCallId);
      parentUuid = uuid;
    }
  }

  /**
   * Closes a recorded batch: marks the settled receipts consumed and the
   * continuation settled, so the model's next round starts from a checkpoint
   * that names no pending Runtime work. Both steps are no-ops until every
   * call of the batch settled.
   */
  async finalizeBatch(): Promise<void> {
    // A batch with no admission at all — every call refused before
    // dispatch — has no checkpoint to close.
    if (this.session.authority.latestCheckpoint === undefined) return;
    await this.harness.consumeRuntimeResults();
    await this.harness.settleConsumedRuntimeContinuation();
  }

  private async latestCheckpoint(): Promise<HarnessCheckpointV1 | undefined> {
    const state = await this.session.authority.readCheckpointState();
    return state === undefined ? undefined : parseHarnessCheckpointV1(state);
  }
}

/**
 * Whether a reopened log carries Runtime work that never settled. The answer
 * is durable: an `await_runtime` checkpoint with an unsettled item names a
 * call whose outcome nobody can learn anymore — its worker is a past
 * generation — so the session must block rather than replay it. A log at
 * `results_ready` answers no: every outcome is committed and nothing replays.
 */
export async function unresolvedRuntimeWorkReason(
  authority: LocalManagedSessionAuthority,
): Promise<string | undefined> {
  if (authority.latestCheckpoint === undefined) return undefined;
  let state: Buffer | undefined;
  try {
    state = await authority.readCheckpointState();
  } catch {
    return 'its checkpoint state cannot be read';
  }
  if (state === undefined) {
    return 'its checkpoint state cannot be read';
  }
  const parsed = tryParseHarnessCheckpointV1(state);
  if (!parsed.ok) {
    // An unparseable checkpoint is an unknowable Runtime state, which is
    // exactly the case this gate blocks for: the session opens blocked, its
    // history readable, nothing replayed.
    return 'its checkpoint state cannot be parsed as a Harness v1 checkpoint';
  }
  const checkpoint = parsed.checkpoint;
  if (checkpoint.continuation.phase !== 'await_runtime') return undefined;
  // The parser's phase shape already proved the disjunction a check here
  // would recompute: an await_runtime checkpoint it admits always carries an
  // in-progress item with its dispatch binding.
  return 'it recorded Runtime dispatches that never settled';
}

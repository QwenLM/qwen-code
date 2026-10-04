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
import type { Part } from '@google/genai';
import type { ToolErrorType } from '../tools/tool-error.js';
import {
  assertManagedSessionDurableRef,
  type ManagedSessionDurableRef,
} from './managed-session-records.js';
import { managedToolDigest } from '../tools/managed-tool-protocol.js';

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
    // The digest is the first thing that can refuse an inadmissible call:
    // nothing durable may be written before it passes.
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
   * Below a restore, a crash may stand between a call's commits: the durable
   * outcome and receipt landed while the checkpoint item never settled, or
   * both settled while the recorded `tool_result` never landed. The receipts
   * prove the calls took effect, and nothing that proves it may block — so
   * the items settle from their receipts, and the missing `tool_result`
   * records are recorded from the settled outcomes, before any gate reads.
   */
  async recoverCommittedReceipts(): Promise<void> {
    const checkpoint = await this.latestCheckpoint();
    const phase = checkpoint?.continuation.phase;
    if (phase === 'await_runtime') {
      const pending = (checkpoint?.tools?.items ?? []).filter(
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
    const events = session.authority.eventsInSequenceRange(
      1,
      session.authority.committedSequence,
    );
    const bodies: string[] = [];
    for (const event of events) {
      if (
        event.kind !== 'message.committed' ||
        event.payload['role'] !== 'tool_result'
      )
        continue;
      const ref = assertManagedSessionDurableRef(
        event.payload['contentRef'],
        'message.committed.contentRef',
      );
      bodies.push((await session.resources.read(ref)).toString());
    }
    const checkpoint = await this.latestCheckpoint();
    const settled = (checkpoint?.tools?.items ?? []).filter(
      (item) => item.state === 'settled' && item.outcomeRef !== null,
    );
    for (const item of settled) {
      if (bodies.some((body) => body.includes(item.executionCallId))) continue;
      const outcome = JSON.parse(
        (await session.resources.read(item.outcomeRef!)).toString(),
      ) as {
        result?: {
          executionStatus?: string;
          responseParts?: unknown[];
          error?: { message?: string; type?: string };
        };
      };
      const status = outcome.result?.executionStatus;
      // The worker marks text parts with a `type` that model parts do not have.
      const responseParts = (outcome.result?.responseParts ?? []).map(
        (part): Part => {
          const { type, ...rest } = part as { type?: unknown } & Record<
            string,
            unknown
          >;
          return (type === 'text' ? rest : part) as Part;
        },
      );
      // The durable outcome is the recorded history: same tool_result shape
      // the recorder writes, idempotent by its deterministic id.
      await session.sink.write({
        ...session.authority.recordEnvelope,
        uuid: `recovered-tool-result:${item.executionCallId}`,
        parentUuid: null,
        sessionId: session.authority.sessionHeader.sessionKey.sessionId,
        timestamp: new Date().toISOString(),
        type: 'tool_result',
        message: {
          role: 'user',
          parts: responseParts,
        },
        toolCallResult: {
          callId: item.executionCallId,
          status:
            status === 'success'
              ? 'success'
              : status === 'cancelled'
                ? 'cancelled'
                : 'error',
          responseParts,
          error:
            outcome.result?.error?.message !== undefined
              ? new Error(outcome.result.error.message)
              : undefined,
          errorType:
            outcome.result?.error?.type === undefined
              ? undefined
              : (outcome.result.error.type as ToolErrorType),
          resultDisplay: undefined,
        },
      });
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
  const pending =
    checkpoint.tools?.items.some((item) => item.state === 'in_progress') ===
      true ||
    checkpoint.runtime?.bindings.some(
      (binding) => binding.state === 'dispatch',
    ) === true;
  return pending
    ? 'it recorded Runtime dispatches that never settled'
    : 'it recorded an unresolved Runtime wait';
}

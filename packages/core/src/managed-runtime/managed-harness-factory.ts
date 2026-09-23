/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import {
  createAwaitActionHarnessCheckpoint,
  createAwaitRuntimeHarnessCheckpoint,
  createConsumedRuntimeResultsHarnessCheckpoint,
  createInitialHarnessCheckpoint,
  createModelOutputCommittedHarnessCheckpoint,
  createResultsReadyHarnessCheckpoint,
  createTurnSettledHarnessCheckpoint,
  encodeHarnessCheckpointV1,
  HARNESS_DURABLE_WAIT_BOUNDARY,
  HARNESS_MODEL_START_PHASES,
  HARNESS_TURN_COMPLETE_BOUNDARY,
  type HarnessActionSource,
  type HarnessCheckpointV1,
  type HarnessRunAuthorization,
} from './managed-harness-checkpoint.js';
import { managedRuntimeDispatchGate } from './managed-runtime-dispatch-gate.js';
import {
  assertManagedSessionRestoreBundle,
  ManagedSessionConflictError,
  type LocalManagedSessionAuthority,
} from './managed-session-authority.js';
import type { ManagedSession } from './managed-session-assembly.js';
import type { ManagedSessionDurableRef } from './managed-session-records.js';

export class ManagedHarnessBlockedError extends Error {
  readonly code = 'managed_harness_blocked';
  readonly reason: Exclude<
    HarnessRunAuthorization,
    { status: 'initial' | 'runnable' }
  >['reason'];

  constructor(
    authorization: Extract<HarnessRunAuthorization, { status: 'blocked' }>,
  ) {
    super(
      authorization.message ??
        `Harness recovery is blocked (${authorization.reason}).`,
    );
    this.name = 'ManagedHarnessBlockedError';
    this.reason = authorization.reason;
  }
}

export interface HarnessTurnCompleteBoundary {
  readonly kind: 'turn_complete';
  readonly checkpointId: string;
  readonly coveredSequence: number;
  readonly activationId: string;
  readonly epoch: number;
}

export interface HarnessDurableWaitBoundary {
  readonly kind: 'durable_wait';
  readonly checkpointId: string;
  readonly coveredSequence: number;
  readonly activationId: string;
  readonly epoch: number;
}

export type HarnessSafetyBoundary =
  | HarnessTurnCompleteBoundary
  | HarnessDurableWaitBoundary;

export interface ManagedDurableWaitCommit {
  readonly requestId: string;
  readonly kind: string;
  readonly source: HarnessActionSource;
  readonly optionsRef: ManagedSessionDurableRef;
  readonly inputRevision: string;
  readonly invocationRef: ManagedSessionDurableRef | null;
  readonly attemptId: string;
  readonly routeRef: ManagedSessionDurableRef;
}

export interface ManagedDurableWaitRequest {
  readonly requestId: string;
  readonly kind: string;
  readonly source: HarnessActionSource;
  readonly options: unknown;
  readonly invocation?: unknown;
}

export interface ManagedDurableWaitDecision {
  readonly requestId: string;
  readonly outcome: 'decided' | 'cancelled' | 'expired';
  readonly body?: unknown;
}

export interface ManagedAwaitRuntimeCommit {
  readonly functionCallId: string;
  readonly toolName: string;
  readonly executionCallId: string;
  readonly invocationBindingId: string;
  readonly capabilityVersion: string;
  readonly policyVersion: string;
  readonly mediaVersion: string | null;
  readonly modelMessageId: string;
  readonly partIndex: number;
  readonly ordinal: number;
  readonly inputDigest: string;
  readonly progressCursor: string | null;
  readonly attemptId: string;
  readonly routeRef: ManagedSessionDurableRef;
}

export interface ManagedAwaitRuntimeRequest {
  readonly functionCallId: string;
  readonly toolName: string;
  readonly executionCallId: string;
  readonly invocationBindingId?: string;
  readonly modelMessageId?: string;
}

export interface ManagedRuntimeFunctionResponse {
  readonly id: string;
  readonly name: string;
  readonly response?: Record<string, unknown>;
}

export interface ManagedRuntimeOutcome {
  readonly functionCallId: string;
  readonly executionCallId: string;
  readonly part: {
    readonly functionResponse: ManagedRuntimeFunctionResponse;
  };
}

export interface ManagedRuntimeOutcomeRead {
  readonly outcomes: readonly ManagedRuntimeOutcome[];
  readonly preserveCallIds: readonly string[];
}

export interface ManagedHarnessHandle {
  /** The activation this handle is allowed to present. */
  readonly activation: {
    readonly activationId: string;
    readonly epoch: number;
  };
  /**
   * Commits a `before_model` checkpoint when the session is a legal initial
   * start, then returns the parsed v1 state a model request may run from.
   * Does not send a user prompt.
   */
  ensureRunnable(): Promise<HarnessCheckpointV1>;
  /**
   * Ensures a runnable checkpoint, then runs the supplied Agent exactly once.
   * The Agent is the existing QwenAgent/ACP Session/LlmChat path, not a
   * separate runner.
   */
  run<T>(agent: () => Promise<T>): Promise<T>;
  /**
   * Observes an already-committed turn-complete or durable-wait checkpoint.
   * Does not wait for an in-flight turn, and does not invent a boundary.
   */
  requestBoundary(): Promise<HarnessSafetyBoundary>;
  /**
   * Drains this handle after a turn-complete or durable-wait checkpoint. Does
   * not release the Session writer, Runtime, or activation; a later handle
   * continues. At `await_runtime` this hands the original invocation to the
   * coordinator gate instead of cancelling it.
   */
  detach(): Promise<void>;
  /** True after {@link detach}; a successor handle continues the wait. */
  isDetached(): boolean;
  /**
   * Commits safety point B: a requested approval as `await_action` with
   * `durable_wait`. The next model request stays blocked until
   * `resolveDurableWait`.
   */
  commitDurableWait(
    request: ManagedDurableWaitCommit,
  ): Promise<HarnessDurableWaitBoundary>;
  /**
   * Clears a durable approval wait so the turn may continue from
   * `model_output_committed`. No-op when the handle is not waiting.
   */
  resolveDurableWait(): Promise<HarnessCheckpointV1 | null>;
  /**
   * Commits safety point C: an admitted Runtime tool as `await_runtime` with
   * `durable_wait`. The original executionCallId is dispatched at most once.
   */
  commitAwaitRuntime(
    request: ManagedAwaitRuntimeCommit,
  ): Promise<HarnessDurableWaitBoundary>;
  /**
   * Settles admitted Runtime work so the turn may continue from
   * `results_ready`. No-op when the handle is not waiting on Runtime.
   */
  resolveAwaitRuntime(
    outcomeRef: ManagedSessionDurableRef,
  ): Promise<HarnessCheckpointV1 | null>;
  /**
   * Marks unconsumed settled Runtime receipts as consumed after they are
   * present on the next model request. No-op when the handle is not at
   * `results_ready`.
   */
  consumeRuntimeResults(): Promise<HarnessCheckpointV1 | null>;
  /**
   * Closes a consumed `results_ready` continuation after the model request
   * finishes. No-op until every settled receipt is consumed.
   */
  settleConsumedRuntimeContinuation(): Promise<HarnessCheckpointV1 | null>;
}

/**
 * Builds a logical Harness handle for one activation. The caller must already
 * hold the session writer and a matching live activation; this does not
 * acquire either, and it does not start the model.
 */
export function createManagedHarnessHandle(
  session: Pick<ManagedSession, 'authority' | 'activation'>,
): ManagedHarnessHandle {
  return new LocalManagedHarnessHandle(session.authority, session.activation);
}

class LocalManagedHarnessHandle implements ManagedHarnessHandle {
  private ran = false;
  private detached = false;

  constructor(
    private readonly authority: LocalManagedSessionAuthority,
    readonly activation: {
      readonly activationId: string;
      readonly epoch: number;
    },
  ) {}

  async ensureRunnable(): Promise<HarnessCheckpointV1> {
    this.assertNotDetached();
    this.assertCurrentActivation();
    assertManagedSessionRestoreBundle(await this.authority.restoreBundle());
    let authorization = await this.authority.harnessRunAuthorization();
    if (authorization.status === 'initial') {
      await this.commitInitialBeforeModel();
      authorization = await this.authority.harnessRunAuthorization();
    }
    return this.requireModelStart(authorization);
  }

  async run<T>(agent: () => Promise<T>): Promise<T> {
    await this.ensureRunnable();
    if (this.ran) {
      throw new ManagedSessionConflictError(
        'a harness handle runs the Agent at most once.',
      );
    }
    this.ran = true;
    return agent();
  }

  async requestBoundary(): Promise<HarnessSafetyBoundary> {
    this.assertNotDetached();
    this.assertCurrentActivation();
    const latest = this.authority.latestCheckpoint;
    if (latest === undefined || !isHarnessSafetyBoundary(latest.boundary)) {
      throw new ManagedSessionConflictError(
        'harness is not at a turn-complete or durable-wait safety point.',
      );
    }
    const authorization = await this.requireRunnableAuthorization();
    const phase = authorization.checkpoint.continuation.phase;
    if (
      latest.boundary === HARNESS_DURABLE_WAIT_BOUNDARY &&
      phase !== 'await_action' &&
      phase !== 'await_runtime'
    ) {
      throw new ManagedSessionConflictError(
        'durable-wait checkpoint is not an await_action or await_runtime phase.',
      );
    }
    return {
      kind:
        latest.boundary === HARNESS_DURABLE_WAIT_BOUNDARY
          ? 'durable_wait'
          : 'turn_complete',
      checkpointId: latest.checkpointId,
      coveredSequence: latest.coveredSequence,
      activationId: this.activation.activationId,
      epoch: this.activation.epoch,
    };
  }

  isDetached(): boolean {
    return this.detached;
  }

  async detach(): Promise<void> {
    if (this.detached) return;
    this.assertCurrentActivation();
    if (!isHarnessSafetyBoundary(this.authority.latestCheckpoint?.boundary)) {
      throw new ManagedSessionConflictError(
        'harness cannot detach before a turn-complete or durable-wait checkpoint.',
      );
    }
    const authorization = await this.authority.harnessRunAuthorization();
    if (
      authorization.status === 'runnable' &&
      authorization.checkpoint.continuation.phase === 'await_runtime'
    ) {
      const gate = managedRuntimeDispatchGate(
        this.authority.sessionHeader.sessionKey,
      );
      for (const binding of authorization.checkpoint.runtime?.bindings ?? []) {
        gate.handoff(binding.executionCallId);
      }
    }
    this.detached = true;
  }

  async commitDurableWait(
    request: ManagedDurableWaitCommit,
  ): Promise<HarnessDurableWaitBoundary> {
    this.assertNotDetached();
    this.assertCurrentActivation();
    const latest = this.authority.latestCheckpoint;
    if (latest?.boundary === HARNESS_DURABLE_WAIT_BOUNDARY) {
      const authorization = await this.requireRunnableAuthorization();
      const approval = authorization.checkpoint.approval;
      if (
        authorization.checkpoint.continuation.phase === 'await_action' &&
        approval?.requestId === request.requestId
      ) {
        return {
          kind: 'durable_wait',
          checkpointId: latest.checkpointId,
          coveredSequence: latest.coveredSequence,
          activationId: this.activation.activationId,
          epoch: this.activation.epoch,
        };
      }
      throw new ManagedSessionConflictError(
        'harness is already waiting on a different approval.',
      );
    }

    const previous = await this.ensureRunnable();
    if (request.source === 'tool_call') {
      await this.authority.requestToolAction(
        {
          operation: 'requestToolAction',
          commandId: `requestToolAction:${request.requestId}`,
          sessionKey: this.authority.sessionHeader.sessionKey,
          contentDigest: createHash('sha256')
            .update(request.optionsRef.digest)
            .digest('hex'),
        },
        {
          requestId: request.requestId,
          kind: request.kind,
          inputRevision: 1,
          optionsRef: request.optionsRef,
        },
        { class: 'harness', activation: this.activation },
      );
    }
    const identity = this.nextCheckpointIdentity();
    const checkpoint = createAwaitActionHarnessCheckpoint({
      previous,
      ...identity,
      attempt: previous.attempt ?? {
        attemptId: request.attemptId,
        routeRef: request.routeRef,
        capabilityRef: null,
        samplingRef: null,
        outputState: 'output_committed',
        usageRef: null,
        budgetConsumed: 0,
      },
      approval: {
        requestId: request.requestId,
        kind: request.kind,
        source: request.source,
        optionsRef: request.optionsRef,
        inputRevision: request.inputRevision,
        confirmationVersion: null,
        state: 'requested',
        decisionRef: null,
        invocationRef: request.invocationRef,
      },
    });
    await this.commitHarnessCheckpoint(
      `harness:await_action:${this.activation.activationId}:${request.requestId}:${identity.coveredSequence}`,
      checkpoint,
      HARNESS_DURABLE_WAIT_BOUNDARY,
    );
    const committed = this.authority.latestCheckpoint;
    if (committed === undefined) {
      throw new ManagedSessionConflictError(
        'durable wait was committed but no checkpoint was recorded.',
      );
    }
    return {
      kind: 'durable_wait',
      checkpointId: committed.checkpointId,
      coveredSequence: committed.coveredSequence,
      activationId: this.activation.activationId,
      epoch: this.activation.epoch,
    };
  }

  async resolveDurableWait(): Promise<HarnessCheckpointV1 | null> {
    this.assertNotDetached();
    this.assertCurrentActivation();
    const latest = this.authority.latestCheckpoint;
    if (latest?.boundary !== HARNESS_DURABLE_WAIT_BOUNDARY) {
      return null;
    }
    const previous = (await this.requireRunnableAuthorization()).checkpoint;
    if (previous.continuation.phase !== 'await_action') {
      throw new ManagedSessionConflictError(
        'durable-wait checkpoint is not an await_action phase.',
      );
    }
    const requestId = previous.approval?.requestId;
    const action =
      requestId === undefined ? undefined : this.authority.action(requestId);
    if (action === undefined || action.state === 'requested') {
      throw new ManagedSessionConflictError(
        'durable wait cannot resolve before a final action decision.',
      );
    }
    const identity = this.nextCheckpointIdentity();
    const checkpoint = createModelOutputCommittedHarnessCheckpoint({
      previous,
      ...identity,
    });
    await this.commitHarnessCheckpoint(
      `harness:model_output_committed:${this.activation.activationId}:${identity.coveredSequence}`,
      checkpoint,
      null,
    );
    return checkpoint;
  }

  async commitAwaitRuntime(
    request: ManagedAwaitRuntimeCommit,
  ): Promise<HarnessDurableWaitBoundary> {
    this.assertNotDetached();
    this.assertCurrentActivation();
    const latest = this.authority.latestCheckpoint;
    if (latest?.boundary === HARNESS_DURABLE_WAIT_BOUNDARY) {
      const authorization = await this.requireRunnableAuthorization();
      const waiting = (authorization.checkpoint.tools?.items ?? []).some(
        (item) =>
          item.executionCallId === request.executionCallId &&
          item.state === 'in_progress',
      );
      if (
        authorization.checkpoint.continuation.phase === 'await_runtime' &&
        waiting === true
      ) {
        return {
          kind: 'durable_wait',
          checkpointId: latest.checkpointId,
          coveredSequence: latest.coveredSequence,
          activationId: this.activation.activationId,
          epoch: this.activation.epoch,
        };
      }
      throw new ManagedSessionConflictError(
        authorization.checkpoint.continuation.phase === 'await_action'
          ? 'approval wait must resolve before Runtime dispatch.'
          : 'harness is already waiting on a different Runtime invocation.',
      );
    }

    const previous = await this.ensureRunnable();
    const gate = managedRuntimeDispatchGate(
      this.authority.sessionHeader.sessionKey,
    );
    gate.claim(request.executionCallId);
    try {
      const identity = this.nextCheckpointIdentity();
      const priorItems = previous.tools?.items ?? [];
      const ordinal = priorItems.reduce(
        (next, item) => Math.max(next, item.ordinal + 1),
        request.ordinal,
      );
      const checkpoint = createAwaitRuntimeHarnessCheckpoint({
        previous,
        ...identity,
        attempt: previous.attempt ?? {
          attemptId: request.attemptId,
          routeRef: request.routeRef,
          capabilityRef: null,
          samplingRef: null,
          outputState: 'output_committed',
          usageRef: null,
          budgetConsumed: 0,
        },
        tools: {
          batchId: previous.tools?.batchId ?? `batch-${request.functionCallId}`,
          items: [
            ...priorItems.filter((item) => item.state === 'settled'),
            {
              functionCallId: request.functionCallId,
              toolName: request.toolName,
              executionCallId: request.executionCallId,
              modelMessageId: request.modelMessageId,
              partIndex: request.partIndex,
              ordinal,
              inputDigest: request.inputDigest,
              outcomeSource: 'runtime',
              state: 'in_progress',
              outcomeRef: null,
              consumed: false,
            },
          ],
        },
        runtime: {
          bindings: [
            ...(previous.runtime?.bindings ?? []).filter(
              (binding) => binding.state !== 'dispatch',
            ),
            {
              executionCallId: request.executionCallId,
              invocationBindingId: request.invocationBindingId,
              capabilityVersion: request.capabilityVersion,
              policyVersion: request.policyVersion,
              mediaVersion: request.mediaVersion,
              state: 'dispatch',
              progressCursor: request.progressCursor,
            },
          ],
        },
      });
      await this.commitHarnessCheckpoint(
        `harness:await_runtime:${this.activation.activationId}:${request.executionCallId}:${identity.coveredSequence}`,
        checkpoint,
        HARNESS_DURABLE_WAIT_BOUNDARY,
      );
    } catch (error) {
      gate.unclaim(request.executionCallId);
      throw error;
    }
    const committed = this.authority.latestCheckpoint;
    if (committed === undefined) {
      gate.unclaim(request.executionCallId);
      throw new ManagedSessionConflictError(
        'Runtime wait was committed but no checkpoint was recorded.',
      );
    }
    return {
      kind: 'durable_wait',
      checkpointId: committed.checkpointId,
      coveredSequence: committed.coveredSequence,
      activationId: this.activation.activationId,
      epoch: this.activation.epoch,
    };
  }

  async resolveAwaitRuntime(
    outcomeRef: ManagedSessionDurableRef,
  ): Promise<HarnessCheckpointV1 | null> {
    this.assertNotDetached();
    this.assertCurrentActivation();
    const latest = this.authority.latestCheckpoint;
    if (latest?.boundary !== HARNESS_DURABLE_WAIT_BOUNDARY) {
      return null;
    }
    const previous = (await this.requireRunnableAuthorization()).checkpoint;
    if (previous.continuation.phase !== 'await_runtime') {
      throw new ManagedSessionConflictError(
        'durable-wait checkpoint is not an await_runtime phase.',
      );
    }
    const gate = managedRuntimeDispatchGate(
      this.authority.sessionHeader.sessionKey,
    );
    for (const binding of previous.runtime?.bindings ?? []) {
      gate.settle(binding.executionCallId);
    }
    const identity = this.nextCheckpointIdentity();
    const checkpoint = createResultsReadyHarnessCheckpoint({
      previous,
      ...identity,
      outcomeRef,
    });
    await this.commitHarnessCheckpoint(
      `harness:results_ready:${this.activation.activationId}:${identity.coveredSequence}`,
      checkpoint,
      null,
    );
    return checkpoint;
  }

  async consumeRuntimeResults(): Promise<HarnessCheckpointV1 | null> {
    this.assertNotDetached();
    this.assertCurrentActivation();
    const previous = (await this.requireRunnableAuthorization()).checkpoint;
    if (previous.continuation.phase !== 'results_ready') {
      return null;
    }
    const items = previous.tools?.items ?? [];
    if (
      items.length === 0 ||
      items.every((item) => item.state !== 'settled' || item.consumed)
    ) {
      return previous;
    }
    const identity = this.nextCheckpointIdentity();
    const checkpoint = createConsumedRuntimeResultsHarnessCheckpoint({
      previous,
      ...identity,
    });
    await this.commitHarnessCheckpoint(
      `harness:results_consumed:${this.activation.activationId}:${identity.coveredSequence}`,
      checkpoint,
      null,
    );
    return checkpoint;
  }

  async settleConsumedRuntimeContinuation(): Promise<HarnessCheckpointV1 | null> {
    this.assertNotDetached();
    this.assertCurrentActivation();
    const previous = (await this.requireRunnableAuthorization()).checkpoint;
    const items = previous.tools?.items ?? [];
    if (
      previous.continuation.phase !== 'results_ready' ||
      items.length === 0 ||
      items.some((item) => item.state !== 'settled' || !item.consumed)
    ) {
      return null;
    }
    const identity = this.nextCheckpointIdentity();
    const checkpoint = createTurnSettledHarnessCheckpoint({
      previous,
      ...identity,
    });
    await this.commitHarnessCheckpoint(
      `harness:turn_settled:${this.activation.activationId}:${identity.coveredSequence}`,
      checkpoint,
      null,
    );
    return checkpoint;
  }

  private assertNotDetached(): void {
    if (this.detached) {
      throw new ManagedSessionConflictError(
        'harness handle has been detached.',
      );
    }
  }

  private assertCurrentActivation(): void {
    const current = this.authority.currentActivation;
    if (
      current === undefined ||
      current.activationId !== this.activation.activationId ||
      current.epoch !== this.activation.epoch ||
      current.phase === 'released' ||
      current.phase === 'revoked'
    ) {
      throw new ManagedSessionConflictError(
        'harness handle is not the committed activation.',
      );
    }
  }

  private async requireRunnableAuthorization(): Promise<
    Extract<HarnessRunAuthorization, { status: 'runnable' }>
  > {
    const authorization = await this.authority.harnessRunAuthorization();
    if (authorization.status === 'blocked') {
      throw new ManagedHarnessBlockedError(authorization);
    }
    if (authorization.status !== 'runnable') {
      throw new ManagedHarnessBlockedError({
        status: 'blocked',
        reason: 'missing_checkpoint',
      });
    }
    return authorization;
  }

  private requireModelStart(
    authorization: HarnessRunAuthorization,
  ): HarnessCheckpointV1 {
    if (authorization.status === 'blocked') {
      throw new ManagedHarnessBlockedError(authorization);
    }
    if (authorization.status !== 'runnable') {
      throw new ManagedHarnessBlockedError({
        status: 'blocked',
        reason: 'missing_checkpoint',
      });
    }
    const phase = authorization.checkpoint.continuation.phase;
    if (!HARNESS_MODEL_START_PHASES.has(phase)) {
      throw new ManagedHarnessBlockedError({
        status: 'blocked',
        reason: 'invalid_state',
        message: `${phase} is not a model-start phase for this Harness.`,
      });
    }
    return authorization.checkpoint;
  }

  private nextCheckpointIdentity(): {
    checkpointId: string;
    coveredSequence: number;
    previousCheckpointId: string | null;
  } {
    const coveredSequence = this.authority.committedSequence;
    return {
      checkpointId: `ckpt-${coveredSequence + 1}`,
      coveredSequence,
      previousCheckpointId:
        this.authority.latestCheckpoint?.checkpointId ?? null,
    };
  }

  private async commitInitialBeforeModel(): Promise<void> {
    const header = this.authority.sessionHeader;
    const identity = this.nextCheckpointIdentity();
    const checkpoint = createInitialHarnessCheckpoint({
      sessionKey: header.sessionKey,
      ...identity,
      activationId: this.activation.activationId,
      turnId: null,
      promptId: null,
      definitionRevision: header.definitionRef.resourceId,
      configRevision: header.rootSnapshotRef.resourceId,
      inputDigest: header.definitionRef.digest,
    });
    await this.commitHarnessCheckpoint(
      `harness:before_model:${this.activation.activationId}:${identity.coveredSequence}`,
      checkpoint,
      null,
    );
  }

  private async commitHarnessCheckpoint(
    commandId: string,
    checkpoint: HarnessCheckpointV1,
    boundary: string | null,
  ): Promise<void> {
    const header = this.authority.sessionHeader;
    const state = encodeHarnessCheckpointV1(checkpoint);
    await this.authority.commitCheckpoint(
      {
        operation: 'commitCheckpoint',
        commandId,
        sessionKey: header.sessionKey,
        contentDigest: createHash('sha256').update(state).digest('hex'),
      },
      { state, boundary },
      { class: 'harness', activation: this.activation },
    );
  }
}

function isHarnessSafetyBoundary(
  boundary: string | null | undefined,
): boundary is
  | typeof HARNESS_TURN_COMPLETE_BOUNDARY
  | typeof HARNESS_DURABLE_WAIT_BOUNDARY {
  return (
    boundary === HARNESS_TURN_COMPLETE_BOUNDARY ||
    boundary === HARNESS_DURABLE_WAIT_BOUNDARY
  );
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asFunctionResponse(
  value: unknown,
): ManagedRuntimeFunctionResponse | null {
  if (!isObjectRecord(value)) return null;
  const id = value['id'];
  const name = value['name'];
  if (typeof id !== 'string' || typeof name !== 'string') {
    return null;
  }
  const response = value['response'];
  return {
    id,
    name,
    ...(isObjectRecord(response) ? { response } : {}),
  };
}

/**
 * Reads the model-facing functionResponse from a published Runtime
 * outcome. Missing or malformed receipts are not synthesized.
 */
export function parseManagedRuntimeOutcomePart(
  functionCallId: string,
  parsed: unknown,
): ManagedRuntimeOutcome['part'] | null {
  if (!isObjectRecord(parsed)) return null;
  const nested = isObjectRecord(parsed['body']) ? parsed['body'] : undefined;
  const candidate =
    asFunctionResponse(parsed['functionResponse']) ??
    (nested === undefined
      ? null
      : asFunctionResponse(nested['functionResponse']));
  if (candidate === null) return null;
  return {
    functionResponse: {
      ...candidate,
      id: functionCallId,
    },
  };
}

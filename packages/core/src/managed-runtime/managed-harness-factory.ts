/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import {
  createInitialHarnessCheckpoint,
  encodeHarnessCheckpointV1,
  HARNESS_MODEL_START_PHASES,
  HARNESS_TURN_COMPLETE_BOUNDARY,
  type HarnessCheckpointV1,
  type HarnessRunAuthorization,
} from './managed-harness-checkpoint.js';
import {
  assertManagedSessionRestoreBundle,
  ManagedSessionConflictError,
  type LocalManagedSessionAuthority,
} from './managed-session-authority.js';
import type { ManagedSession } from './managed-session-assembly.js';

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
   * Observes an already-committed turn-complete checkpoint. Does not wait for
   * an in-flight turn, and does not invent a boundary.
   */
  requestBoundary(): Promise<HarnessTurnCompleteBoundary>;
  /**
   * Drains this handle after a turn-complete checkpoint. Does not release the
   * Session writer, Runtime, or activation; a later handle continues.
   */
  detach(): Promise<void>;
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
    // Awaited approvals and in-flight Runtime work are R2.S3.
    if (!HARNESS_MODEL_START_PHASES.has(phase)) {
      throw new ManagedHarnessBlockedError({
        status: 'blocked',
        reason: 'invalid_state',
        message: `${phase} is not a model-start phase for this Harness.`,
      });
    }
    return authorization.checkpoint;
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

  async requestBoundary(): Promise<HarnessTurnCompleteBoundary> {
    this.assertNotDetached();
    this.assertCurrentActivation();
    const latest = this.authority.latestCheckpoint;
    if (latest?.boundary !== HARNESS_TURN_COMPLETE_BOUNDARY) {
      throw new ManagedSessionConflictError(
        'harness is not at a turn-complete safety point.',
      );
    }
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
    return {
      kind: 'turn_complete',
      checkpointId: latest.checkpointId,
      coveredSequence: latest.coveredSequence,
      activationId: this.activation.activationId,
      epoch: this.activation.epoch,
    };
  }

  async detach(): Promise<void> {
    if (this.detached) return;
    this.assertCurrentActivation();
    if (
      this.authority.latestCheckpoint?.boundary !==
      HARNESS_TURN_COMPLETE_BOUNDARY
    ) {
      throw new ManagedSessionConflictError(
        'harness cannot detach before a turn-complete checkpoint.',
      );
    }
    this.detached = true;
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

  private async commitInitialBeforeModel(): Promise<void> {
    const header = this.authority.sessionHeader;
    const coveredSequence = this.authority.committedSequence;
    const checkpointId = `ckpt-${coveredSequence + 1}`;
    const checkpoint = createInitialHarnessCheckpoint({
      sessionKey: header.sessionKey,
      checkpointId,
      coveredSequence,
      activationId: this.activation.activationId,
      turnId: null,
      promptId: null,
      definitionRevision: header.definitionRef.resourceId,
      configRevision: header.rootSnapshotRef.resourceId,
      inputDigest: header.definitionRef.digest,
      previousCheckpointId:
        this.authority.latestCheckpoint?.checkpointId ?? null,
    });
    const state = encodeHarnessCheckpointV1(checkpoint);
    await this.authority.commitCheckpoint(
      {
        operation: 'commitCheckpoint',
        commandId: `harness:before_model:${this.activation.activationId}:${coveredSequence}`,
        sessionKey: header.sessionKey,
        contentDigest: createHash('sha256').update(state).digest('hex'),
      },
      { state, boundary: null },
      { class: 'harness', activation: this.activation },
    );
  }
}

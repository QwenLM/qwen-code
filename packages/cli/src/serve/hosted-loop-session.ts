/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import {
  clampWakeupSeconds,
  WAKEUP_MAX_SECONDS,
  WAKEUP_MIN_SECONDS,
} from '@qwen-code/qwen-code-core/services/cronScheduler.js';
import type {
  LocalManagedSessionAuthority,
  ManagedSessionInputRequest,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { MANAGED_AUTOMATION_LIMITS } from '@qwen-code/qwen-code-core/managed-runtime/managed-automation-operations.js';
import type {
  ManagedSessionDurableRef,
  ManagedSessionEvent,
  ManagedSessionKey,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { pendingSessionInputs } from './hosted-wake-intake.js';
import { wakeHasPriorAttempt } from './hosted-monitor-wake.js';

// The self-paced arm of /loop for Managed Sessions: a wakeup is a Session
// journal input (source `loop`, `notBefore` fire time), never a schedule
// record or a second scheduler. This funnel owns the local tool's semantics
// — clamp, default heartbeat, single unfired pending, replacement, the 24h
// chain cap, cancel — made durable and atomic on the journal. See
// docs/design/2026-11-10-managed-loop-wakeup.md.

/** The `source` of every loop wakeup input, as the wake pump admits it. */
export const LOOP_INPUT_SOURCE = 'loop';
/** The local tool's prompt schema cap. */
export const LOOP_PROMPT_MAX_CHARS = 10000;
/** The local wakeup chain budget (WAKEUP_CHAIN_MAX_AGE_MS). */
export const LOOP_CHAIN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The deployment gate (decision 8), `qwen.managed-agent.loop.enabled`. It
 * gates arming only and defaults off until the acceptance evidence lands:
 * an already-armed wakeup still fires and stays listable/cancellable, since
 * the pump delivers journal inputs regardless of the tool surface.
 */
export function isHostedLoopArmingEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env['QWEN_MANAGED_AGENT_LOOP_ENABLED'] === 'true';
}

/** The arm-time classifier review (decision 9): scheduling future model
 * input is side-effectful, so the continuation is vetted before it is
 * admitted, and the verdict rides the arm's admission resource. */
export interface HostedLoopClassifierInput {
  readonly delaySeconds: number;
  readonly prompt: string;
  readonly reason: string;
}
export interface HostedLoopClassifierVerdict {
  readonly allowed: boolean;
  readonly reason: string | null;
}
export type HostedLoopClassifier = (
  input: HostedLoopClassifierInput,
) => Promise<HostedLoopClassifierVerdict>;

export interface HostedLoopStore {
  readonly authority: {
    readonly committedSequence: number;
    submitInput: LocalManagedSessionAuthority['submitInput'];
    appendExecutionEvent: LocalManagedSessionAuthority['appendExecutionEvent'];
    eventsInSequenceRange(
      from: number,
      to: number,
    ): readonly ManagedSessionEvent[];
  };
  readonly resources: {
    publish(kind: string, bytes: Buffer): Promise<ManagedSessionDurableRef>;
  };
  readonly sink: {
    project(): Promise<ChatRecord[]>;
  };
}

export interface HostedLoopSessionOptions {
  readonly classify: HostedLoopClassifier;
  readonly cwd: string;
  readonly now?: () => number;
}

/** The outcome of a successful arm, mirroring the local tool's answer. */
export interface LoopWakeupArm {
  /** The input/turn id, `loop:<wakeupId>`; cron_delete routes it back. */
  readonly id: string;
  readonly fireAt: number;
  readonly clampedDelaySeconds: number;
  readonly wasClamped: boolean;
  /** The unfired input this arm replaced, or null. */
  readonly replacedId: string | null;
}

/** An arm refusal the model can act on (empty/oversized prompt, denied
 * admission, or an exhausted chain). */
export class LoopWakeupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoopWakeupError';
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class HostedLoopSession {
  private writes: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(
    private readonly store: HostedLoopStore,
    private readonly key: ManagedSessionKey,
    private readonly options: HostedLoopSessionOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Arms (or re-arms) the single unfired wakeup. A re-arm replaces the
   * unfired pending input in the same transaction that commits the new one;
   * a firing input (its turn already started) is never replaced. An arm
   * past the 24h chain budget is refused AND drops the unfired pending, so
   * a rejected re-arm leaves nothing behind (the local drop-before-check).
   */
  arm(params: {
    delaySeconds: number;
    prompt: string;
    reason?: string;
  }): Promise<LoopWakeupArm> {
    return this.serial(() => this.armUnserialized(params));
  }

  /**
   * Cancels a pending wakeup by its `loop:<wakeupId>` id. Idempotent: an id
   * that is not pending answers false. A wakeup whose turn already started
   * belongs to recovery and is refused (false), never settled model-free.
   */
  cancel(id: string): Promise<boolean> {
    return this.serial(() => this.cancelUnserialized(id));
  }

  private async armUnserialized(params: {
    delaySeconds: number;
    prompt: string;
    reason?: string;
  }): Promise<LoopWakeupArm> {
    if (!isHostedLoopArmingEnabled()) {
      throw new LoopWakeupError(
        'Loop wakeups are disabled on this deployment (qwen.managed-agent.loop.enabled).',
      );
    }
    const prompt = params.prompt.trim();
    if (prompt.length === 0) {
      throw new LoopWakeupError('Loop wakeup prompt must not be empty.');
    }
    if (prompt.length > LOOP_PROMPT_MAX_CHARS) {
      throw new LoopWakeupError(
        `Loop wakeup prompt exceeds ${LOOP_PROMPT_MAX_CHARS} characters.`,
      );
    }
    const clampedDelaySeconds = clampWakeupSeconds(params.delaySeconds);
    const roundedDelaySeconds = Number.isFinite(params.delaySeconds)
      ? Math.round(params.delaySeconds)
      : params.delaySeconds;
    const wasClamped =
      !Number.isFinite(params.delaySeconds) ||
      roundedDelaySeconds < WAKEUP_MIN_SECONDS ||
      roundedDelaySeconds > WAKEUP_MAX_SECONDS;
    const reason = params.reason?.trim() ?? '';

    // Decision 9: nothing fires that was not admitted. The verdict rides
    // the admission resource so a fire-time sentinel re-review can compare.
    const verdict = await this.options.classify({
      delaySeconds: clampedDelaySeconds,
      prompt,
      reason,
    });
    if (!verdict.allowed) {
      throw new LoopWakeupError(
        `Loop wakeup admission denied: ${verdict.reason ?? 'classifier refused the continuation.'}`,
      );
    }

    const envelope = Buffer.from(JSON.stringify({ text: prompt }), 'utf8');
    if (envelope.byteLength > MANAGED_AUTOMATION_LIMITS.maxInputBytes) {
      throw new LoopWakeupError(
        'Loop wakeup envelope exceeds the input size limit.',
      );
    }

    const now = this.now();
    const fireAt = now + clampedDelaySeconds * 1000;
    const events = this.store.authority.eventsInSequenceRange(
      1,
      this.store.authority.committedSequence,
    );
    const anchor = firstLoopInputOccurredAt(events) ?? now;
    const projected = await this.store.sink.project();
    const unfired = this.unfiredPending(projected, events);

    // Drop-before-check: a refused re-arm must leave no unfired wakeup, or
    // the stale one (its fire time now past) would fire one iteration past
    // the 24h limit. A firing input is never dropped.
    if (fireAt > anchor + LOOP_CHAIN_MAX_AGE_MS) {
      if (unfired !== undefined) {
        await this.settleLoopTurn(unfired.turnId, 'loop_chain_expired');
      }
      throw new LoopWakeupError(
        'Loop wakeup chain exceeded the 24h session limit. ' +
          'Omit loop_wakeup to end this loop, or start a new session.',
      );
    }

    const wakeupId = randomUUID();
    const id = `${LOOP_INPUT_SOURCE}:${wakeupId}`;
    const contentRef = await this.store.resources.publish(
      'managed-input',
      envelope,
    );
    const admissionRef = await this.store.resources.publish(
      'managed-admission',
      Buffer.from(
        JSON.stringify({
          requestedDelaySeconds: params.delaySeconds,
          clampedDelaySeconds,
          reason,
          classifier: { allowed: verdict.allowed, reason: verdict.reason },
        }),
        'utf8',
      ),
    );
    const input: ManagedSessionInputRequest = {
      inputId: id,
      turnId: id,
      source: LOOP_INPUT_SOURCE,
      contentRef,
      deadline: null,
      admissionRef,
      wakeReason: 'input',
      notBefore: fireAt,
    };
    let replacement:
      | {
          turnId: string;
          stopReason: string;
          resultRef: ManagedSessionDurableRef;
        }
      | undefined;
    if (unfired !== undefined) {
      replacement = {
        turnId: unfired.turnId,
        stopReason: 'loop_replaced',
        resultRef: await this.publishCancelledResult(
          unfired.turnId,
          'loop_replaced',
        ),
      };
    }
    await this.store.authority.submitInput(
      {
        operation: 'submitInput',
        commandId: `loop-arm:${wakeupId}`,
        sessionKey: this.key,
        contentDigest: digest({ id, fireAt, prompt, reason }),
      },
      input,
      replacement,
    );
    return {
      id,
      fireAt,
      clampedDelaySeconds,
      wasClamped,
      replacedId: unfired?.turnId ?? null,
    };
  }

  private async cancelUnserialized(id: string): Promise<boolean> {
    const events = this.store.authority.eventsInSequenceRange(
      1,
      this.store.authority.committedSequence,
    );
    const pending = pendingSessionInputs(events).find(
      (input) => input.turnId === id && input.source === LOOP_INPUT_SOURCE,
    );
    if (pending === undefined) return false;
    const projected = await this.store.sink.project();
    if (wakeHasPriorAttempt(projected, id)) return false;
    await this.settleLoopTurn(id, 'loop_cancelled');
    return true;
  }

  /**
   * The single unfired pending loop input: pending on the journal and with
   * no prior attempt in the transcript. A firing input (prior attempt) is
   * excluded — it belongs to its running turn and the recovery fleet.
   */
  private unfiredPending(
    projected: ReadonlyArray<{ readonly daemonPromptId?: string }>,
    events: readonly ManagedSessionEvent[],
  ) {
    return pendingSessionInputs(events)
      .filter((input) => input.source === LOOP_INPUT_SOURCE)
      .find((input) => !wakeHasPriorAttempt(projected, input.turnId));
  }

  /** A model-free cancelled settle, committed by the authority (no
   * activation fence), with the reader-facing turn-result body the fence
   * demands. The fixed turn:<turnId> event id refuses a turn already
   * settled. */
  private async settleLoopTurn(
    turnId: string,
    stopReason: string,
  ): Promise<void> {
    const resultRef = await this.publishCancelledResult(turnId, stopReason);
    await this.store.authority.appendExecutionEvent(
      {
        operation: 'settleLoopTurn',
        commandId: `loop-settle:${randomUUID()}`,
        sessionKey: this.key,
        contentDigest: resultRef.digest,
      },
      (sequence) => ({
        v: 1,
        sequence,
        eventId: `turn:${turnId}`,
        sessionKey: this.key,
        kind: 'turn.settled',
        occurredAt: this.now(),
        payload: {
          turnId,
          outcome: 'cancelled',
          stopReason,
          resultRef,
          usageRef: null,
          pendingOwnersRef: null,
        },
      }),
      { class: 'authority' },
    );
  }

  private publishCancelledResult(
    turnId: string,
    stopReason: string,
  ): Promise<ManagedSessionDurableRef> {
    const settle: ChatRecord = {
      uuid: randomUUID(),
      parentUuid: null,
      sessionId: this.key.sessionId,
      timestamp: new Date(this.now()).toISOString(),
      type: 'system',
      cwd: this.options.cwd,
      version: 'hosted-harness/1',
      subtype: 'turn_result',
      systemPayload: {
        promptId: turnId,
        state: 'cancelled',
        stopReason,
        endedAt: this.now(),
      },
    };
    return this.store.resources.publish(
      'managed-turn-result',
      Buffer.from(JSON.stringify(settle), 'utf8'),
    );
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.writes.then(work);
    this.writes = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/** The chain anchor: the occurredAt of the first committed loop input,
 * stable across restarts; a cancel does not reset it. */
function firstLoopInputOccurredAt(
  events: readonly ManagedSessionEvent[],
): number | undefined {
  for (const event of events) {
    if (
      event.kind === 'input.accepted' &&
      event.payload['source'] === LOOP_INPUT_SOURCE
    ) {
      return event.occurredAt;
    }
  }
  return undefined;
}

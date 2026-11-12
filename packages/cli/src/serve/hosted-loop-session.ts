/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import {
  clampWakeupSeconds,
  WAKEUP_MAX_SECONDS,
  WAKEUP_MIN_SECONDS,
} from '@qwen-code/qwen-code-core/services/cronScheduler.js';
import {
  LoopTickResolver,
  detectLoopSentinel,
  detectAutonomousSentinel,
  type LoopTickResult,
} from '@qwen-code/qwen-code-core/skills/bundled/loop/loop-tick-resolver.js';
import {
  keepAliveRearm,
  AUTONOMOUS_SENTINEL_DYNAMIC,
} from '@qwen-code/qwen-code-core/skills/bundled/loop/autonomous-loop.js';
import type {
  LocalManagedSessionAuthority,
  ManagedSessionInputRequest,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { MANAGED_AUTOMATION_LIMITS } from '@qwen-code/qwen-code-core/managed-runtime/managed-automation-operations.js';
import {
  assertManagedSessionDurableRef,
  type ManagedSessionDurableRef,
  type ManagedSessionEvent,
  type ManagedSessionKey,
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
export function isHostedLoopArmingEnabled(): boolean {
  return process.env['QWEN_MANAGED_AGENT_LOOP_ENABLED'] === 'true';
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
  /** A transient classifier outage, distinct from an explicit denial: a
   * fire-time re-review treats it as a no-op re-arm tick (the loop survives)
   * rather than settling the loop dead. */
  readonly unavailable?: boolean;
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
    read(ref: ManagedSessionDurableRef): Promise<Buffer>;
  };
  readonly sink: {
    project(): Promise<ChatRecord[]>;
  };
}

export interface HostedLoopSessionOptions {
  readonly classify: HostedLoopClassifier;
  readonly cwd: string;
  readonly now?: () => number;
  /**
   * Fire-time re-review of the resolved sentinel content (decision 5). The
   * arm-time classifier reviewed the sentinel constant, not the file text, so
   * a fire whose resolved content is a full (first/changed) delivery is
   * re-reviewed before it runs; a denial settles the input
   * `loop_admission_denied`. Omitted → a full delivery is refused rather than
   * run unreviewed (fail closed). Steady-state short reminders are not
   * re-reviewed.
   */
  readonly classifyFire?: HostedLoopClassifier;
}

/** Transient loop.md read failures that owe a no-op re-arm tick, not a thrown
 * turn (mirrors the interactive resolver's transient set). */
const LOOP_TRANSIENT_FS_CODES: readonly string[] = [
  'EACCES',
  'EIO',
  'EBUSY',
  'EPERM',
  'EISDIR',
  'ENOTDIR',
];

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
  // Per-Session fire-time resolver: its delivered-content cache scopes to this
  // conversation, so a fresh Session (restart) re-delivers the full guidance
  // and resetResolverCache() (compaction) does the same.
  private loopResolver: LoopTickResolver | undefined;

  constructor(
    private readonly store: HostedLoopStore,
    private readonly key: ManagedSessionKey,
    private readonly options: HostedLoopSessionOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  private resolver(): LoopTickResolver {
    if (!this.loopResolver) {
      const homeQwenDir = Storage.getGlobalQwenDir();
      const qwenHome = process.env['QWEN_HOME'];
      const homeDir = os.homedir();
      this.loopResolver = new LoopTickResolver({
        projectRoot: this.options.cwd,
        homeDir:
          (qwenHome ? homeQwenDir : homeDir) || path.dirname(homeQwenDir),
        homeQwenDir,
        // A Hosted Workspace is not a trusted folder (the Hosted trust model
        // pins workspaceTrusted false), so the repo-controlled project
        // `.qwen/loop.md` is never read; only the user-owned home/global file
        // or the absent-file tick. An untrusted workspace's project loop.md
        // must not feed the model.
        allowProjectFile: () => false,
      });
    }
    return this.loopResolver;
  }

  /** Forget the delivered-content cache so the next fire re-delivers the full
   * guidance — called when the Session history is compacted (fresh context). */
  resetResolverCache(): void {
    this.loopResolver?.resetCache();
  }

  /** Commit the last expanded tick once it has reached the model, so a tick
   * aborted between expansion and delivery cannot poison the cache into a
   * dangling short reminder. */
  markLoopDelivered(): void {
    this.loopResolver?.markDelivered();
  }

  /**
   * Fire-time sentinel expansion (decision 5). A non-sentinel prompt passes
   * through untouched (`expanded: false`, so the delivery does not commit the
   * resolver cache). A `loop.md` / autonomous sentinel is expanded by the
   * shared resolver (trust-gated, byte-capped, absent→autonomous,
   * transient→no-op re-arm). A full (first/changed) delivery is re-reviewed
   * by the fire-time classifier before it runs: an explicit denial settles
   * the input `loop_admission_denied` and returns null so the pump skips it
   * (ending the loop), while a transient classifier outage delivers a no-op
   * re-arm tick so the loop survives to retry on the next fire.
   */
  async expandFireText(
    turnId: string,
    text: string,
  ): Promise<{ text: string; expanded: boolean } | null> {
    const loopMode = detectLoopSentinel(text);
    const autonomousMode = loopMode ? null : detectAutonomousSentinel(text);
    if (!loopMode && !autonomousMode) return { text, expanded: false };
    const resolver = this.resolver();
    let tick: LoopTickResult;
    if (loopMode) {
      try {
        tick = await resolver.resolve(loopMode, false);
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code ?? 'unknown';
        if (loopMode === 'dynamic' && LOOP_TRANSIENT_FS_CODES.includes(code)) {
          tick = resolver.buildTransientErrorTick(loopMode, false, code);
        } else {
          throw cause;
        }
      }
    } else {
      tick = resolver.resolveAutonomous(autonomousMode!);
    }
    // Re-review only a full delivery: steady-state unchanged content (the
    // short reminder) was already reviewed when it first delivered full.
    if (tick.full) {
      const verdict = this.options.classifyFire
        ? await this.options.classifyFire({
            delaySeconds: 0,
            prompt: tick.modelText,
            reason: 'loop fire-time sentinel re-review',
          })
        : {
            allowed: false,
            reason: 'No fire-time classifier for loop expansion.',
          };
      if (!verdict.allowed) {
        if (verdict.unavailable) {
          // A transient outage must not end the loop: deliver a no-op re-arm
          // tick so the next fire re-reviews and retries. The re-arm sentinel
          // matches the loop's family (loop.md vs autonomous).
          const rearmText = loopMode
            ? resolver.buildTransientErrorTick(
                loopMode,
                false,
                'classifier_unavailable',
              ).modelText
            : `# Autonomous loop tick (dynamic pacing)\nThe fire-time classifier is temporarily unavailable. Treat this as a no-op tick. ${keepAliveRearm(
                AUTONOMOUS_SENTINEL_DYNAMIC,
              )}`;
          return { text: rearmText, expanded: true };
        }
        await this.settleLoopTurn(turnId, 'loop_admission_denied');
        return null;
      }
    }
    return { text: tick.modelText, expanded: true };
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

  /**
   * The pending unfired loop wakeups for the union cron_list surface: id,
   * fire time, and the continuation prompt read from the input envelope.
   * The fixed-interval sibling's cron jobs join this list when it lands.
   */
  list(): Promise<
    Array<{ id: string; fireAt: number | null; prompt: string }>
  > {
    return this.serial(async () => {
      const events = this.store.authority.eventsInSequenceRange(
        1,
        this.store.authority.committedSequence,
      );
      const projected = await this.store.sink.project();
      const unfired = this.unfiredPending(projected, events);
      if (unfired === undefined) return [];
      let prompt = '';
      if (unfired.contentRef !== undefined) {
        try {
          const ref = assertManagedSessionDurableRef(
            unfired.contentRef,
            'loop wakeup input',
          );
          const bytes = await this.store.resources.read(ref);
          const body = JSON.parse(bytes.toString('utf8')) as {
            text?: unknown;
          };
          if (typeof body.text === 'string') prompt = body.text;
        } catch {
          // A wakeup whose envelope cannot be read still lists by id and
          // fire time; the prompt is display-only.
          prompt = '';
        }
      }
      return [{ id: unfired.turnId, fireAt: unfired.notBefore, prompt }];
    });
  }

  private async armUnserialized(params: {
    delaySeconds: number;
    prompt: string;
    reason?: string;
  }): Promise<LoopWakeupArm> {
    if (!isHostedLoopArmingEnabled()) {
      throw new LoopWakeupError(
        'Loop wakeups are disabled on this deployment (set QWEN_MANAGED_AGENT_LOOP_ENABLED=true in the Harness environment).',
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

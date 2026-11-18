/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Phase 1 of docs/design/2026-11-16-managed-stateless-harness.md: the
// per-session idle-suspension gate and timer. This module owns the state
// machine only; the session file supplies eligibility, teardown and
// resident removal, so the races below stay unit-testable without the
// route surface. The gate lives in a registry keyed by Session id, not on
// the resident object: an uncertain teardown keeps refusing loads after
// the resident is gone, until the teardown is confirmed complete.

/** Candidate idle period; measured before suspension is enabled. */
export const HOSTED_IDLE_SUSPEND_MS = 10 * 60 * 1000;
/** Candidate per-instance concurrent cold-open cap; measured likewise. */
export const HOSTED_COLD_OPEN_LIMIT = 8;
/** Bounded wait for admitted async work before the eligibility recheck. */
export const HOSTED_SUSPEND_WORK_WAIT_MS = 30_000;
/** Teardown retries (backoff + jitter) before operator recovery. */
export const HOSTED_SUSPEND_TEARDOWN_RETRY_CAP = 5;
/**
 * Bounded post-cap reconciliation wait before the gate auto-clears. Must
 * exceed the writer lease (60s) plus the Store request timeout (30s) so the
 * lease has expired and no in-flight seal from the capped attempt remains;
 * after it, any acquire bumps the generation and fences the old seal, so the
 * next load cold-opens safely without an operator (design open question 8).
 * A candidate, validated against the real Store timeout before enablement.
 */
export const HOSTED_SUSPEND_RECONCILE_MS = 65_000;
const JITTER_FRACTION = 0.1;
const WORK_POLL_MS = 25;

export type SuspensionGate = 'open' | 'closing' | 'blocked';

export interface SessionSuspension {
  gate: SuspensionGate;
  /** Admitted async work, counted until the work's own finally. */
  admittedWork: number;
  /** The first teardown call latches this; no revert past it. */
  teardownStarted: boolean;
  lastActivity: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  teardownAttempts: number;
  /** Re-arms the idle timer; installed by the route surface at load. */
  rearm?: () => void;
}

export function createSuspension(now: number): SessionSuspension {
  return {
    gate: 'open',
    admittedWork: 0,
    teardownStarted: false,
    lastActivity: now,
    teardownAttempts: 0,
  };
}

/** The refusal a gated caller receives, or undefined while open. */
export function suspensionRefusalCode(
  suspension: SessionSuspension,
): 'hosted_session_closing' | 'hosted_session_teardown_blocked' | undefined {
  if (suspension.gate === 'closing') return 'hosted_session_closing';
  if (suspension.gate === 'blocked') return 'hosted_session_teardown_blocked';
  return undefined;
}

/**
 * Admits one unit of async work. False means the gate refused it and the
 * caller must answer the refusal code; the work never starts.
 */
export function admitSuspensionWork(suspension: SessionSuspension): boolean {
  if (suspension.gate !== 'open') return false;
  suspension.admittedWork += 1;
  return true;
}

/** Releases one unit in the work's own finally, disconnect or not. */
export function releaseSuspensionWork(suspension: SessionSuspension): void {
  if (suspension.admittedWork > 0) suspension.admittedWork -= 1;
}

export function recordSuspensionActivity(
  suspension: SessionSuspension,
  now: number,
): void {
  suspension.lastActivity = now;
}

/** Up to 10% jitter so co-idle Sessions do not suspend in lockstep. */
export function idleSuspensionDelay(
  idleMs: number,
  random: () => number = Math.random,
): number {
  return Math.round(idleMs * (1 + random() * JITTER_FRACTION));
}

export function disarmIdleSuspension(suspension: SessionSuspension): void {
  if (suspension.idleTimer !== undefined) {
    clearTimeout(suspension.idleTimer);
    suspension.idleTimer = undefined;
  }
}

export function armIdleSuspension(
  suspension: SessionSuspension,
  options: {
    readonly idleMs: number;
    readonly onTimeout: () => void;
    readonly random?: () => number;
  },
): void {
  disarmIdleSuspension(suspension);
  if (suspension.gate !== 'open') return;
  suspension.idleTimer = setTimeout(
    options.onTimeout,
    idleSuspensionDelay(options.idleMs, options.random),
  );
  suspension.idleTimer.unref?.();
}

/** Synchronous open→closing mark; the caller rechecks eligibility first. */
export function beginSuspensionClose(suspension: SessionSuspension): boolean {
  if (suspension.gate !== 'open') return false;
  suspension.gate = 'closing';
  disarmIdleSuspension(suspension);
  return true;
}

/**
 * Clears a closing gate only while teardown has not started. An abandoned
 * revertible attempt is itself activity: the Session earns a full period.
 */
export function revertSuspension(
  suspension: SessionSuspension,
  now: number,
): boolean {
  if (suspension.gate !== 'closing' || suspension.teardownStarted) return false;
  suspension.gate = 'open';
  suspension.lastActivity = now;
  return true;
}

/** The irreversible boundary: the first teardown call, not the seal. */
export function markSuspensionTeardown(suspension: SessionSuspension): void {
  suspension.teardownStarted = true;
}

export function escalateSuspension(suspension: SessionSuspension): void {
  suspension.gate = 'blocked';
  disarmIdleSuspension(suspension);
}

/** Only a confirmed-complete teardown clears the gate for a cold open. */
export function clearSuspension(suspension: SessionSuspension): void {
  suspension.gate = 'open';
  suspension.teardownStarted = false;
  suspension.teardownAttempts = 0;
  disarmIdleSuspension(suspension);
}

export interface SuspensionAttemptDeps {
  /** Pending journal inputs, including future-notBefore wakes. */
  readonly pendingInputs: () => Promise<boolean>;
  /**
   * Synchronous recheck of live work and activity freshness plus the gate
   * mark, in one section: false keeps the Session serving normally.
   */
  readonly markClosing: (attemptStart: number) => boolean;
  /** Synchronous live-work recheck after the bounded wait. */
  readonly liveWork: () => boolean;
  /** Teardown steps 2-7; throws on failure or uncertain outcome. */
  readonly teardown: () => Promise<void>;
  /** Drops the resident; the gate registry entry outlives it if blocked. */
  readonly removeResident: () => void;
  readonly rearm: () => void;
  readonly now?: () => number;
  readonly waitMs?: number;
  readonly retryCap?: number;
  /** Test seam: the backoff base, one second in production. */
  readonly retryBaseMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

export type SuspensionAttemptOutcome = 'suspended' | 'reverted' | 'blocked';

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/**
 * One idle-timeout attempt: eligibility, gate, bounded work wait, recheck,
 * then the irreversible teardown with capped precise retries. Every exit
 * before the first teardown call reverts and rearms; every exit after it
 * keeps the gate closed, escalating to operator recovery at the cap.
 */
export async function runSuspensionAttempt(
  suspension: SessionSuspension,
  deps: SuspensionAttemptDeps,
): Promise<SuspensionAttemptOutcome> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const waitMs = deps.waitMs ?? HOSTED_SUSPEND_WORK_WAIT_MS;
  const retryCap = deps.retryCap ?? HOSTED_SUSPEND_TEARDOWN_RETRY_CAP;
  const retryBaseMs = deps.retryBaseMs ?? 1000;
  const random = deps.random ?? Math.random;
  const attemptStart = now();
  const revert = (): SuspensionAttemptOutcome => {
    revertSuspension(suspension, now());
    deps.rearm();
    return 'reverted';
  };
  if (suspension.gate !== 'open') return 'reverted';
  try {
    if (await deps.pendingInputs()) return revert();
    if (suspension.gate !== 'open') return 'reverted';
    if (!deps.markClosing(attemptStart)) return revert();
    // Admitted work finishes on its own clock, including work whose HTTP
    // caller already disconnected; the response count proves nothing.
    const deadline = now() + waitMs;
    while (suspension.admittedWork > 0 && now() < deadline) {
      await sleep(WORK_POLL_MS);
    }
    if (suspension.admittedWork > 0 || deps.liveWork()) return revert();
    if (await deps.pendingInputs()) return revert();
    // Read through the refusal helper: the mark and any external
    // escalation happened inside calls TypeScript cannot narrow through.
    if (suspensionRefusalCode(suspension) !== 'hosted_session_closing')
      return 'reverted';
  } catch (cause) {
    // A failed eligibility dep must not strand the closing mark: before
    // the irreversible boundary the attempt reverts and rearms like any
    // other abandoned exit. The caller logs the rethrown cause.
    revert();
    throw cause;
  }
  markSuspensionTeardown(suspension);
  for (;;) {
    try {
      await deps.teardown();
      deps.removeResident();
      clearSuspension(suspension);
      return 'suspended';
    } catch {
      suspension.teardownAttempts += 1;
      if (suspension.teardownAttempts >= retryCap) {
        deps.removeResident();
        escalateSuspension(suspension);
        return 'blocked';
      }
      // Precise retries of the same operations, backoff with jitter; the
      // cap bounds the wait, never proves the teardown did not happen.
      await sleep(
        Math.round(
          retryBaseMs * 2 ** (suspension.teardownAttempts - 1) * (1 + random()),
        ),
      );
    }
  }
}

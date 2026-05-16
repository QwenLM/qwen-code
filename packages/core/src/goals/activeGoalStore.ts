/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The runtime state of a `/goal` registered in a session. Lives only in memory:
 * the source of truth for restore-after-resume is the conversation history
 * `goal_status` attachments, not this store.
 */
export interface ActiveGoal {
  condition: string;
  iterations: number;
  setAt: number;
  tokensAtStart: number;
  lastReason?: string;
  hookId: string;
}

const store = new Map<string, ActiveGoal>();

export function getActiveGoal(sessionId: string): ActiveGoal | undefined {
  return store.get(sessionId);
}

export function setActiveGoal(sessionId: string, goal: ActiveGoal): void {
  store.set(sessionId, goal);
}

export function clearActiveGoal(sessionId: string): ActiveGoal | undefined {
  const previous = store.get(sessionId);
  store.delete(sessionId);
  return previous;
}

export function recordGoalIteration(
  sessionId: string,
  lastReason: string,
): ActiveGoal | undefined {
  const current = store.get(sessionId);
  if (!current) return undefined;
  const updated: ActiveGoal = {
    ...current,
    iterations: current.iterations + 1,
    lastReason,
  };
  store.set(sessionId, updated);
  return updated;
}

/**
 * Test-only escape hatch — production code must scope by sessionId.
 */
export function __resetActiveGoalStoreForTests(): void {
  store.clear();
  observers.clear();
  lastTerminal.clear();
}

// ───────────────────────────────────────────────────────────────────────────
// Terminal-state observers
//
// The Stop hook callback that drives /goal runs inside core, but the UI cards
// for "Goal achieved" / "Goal aborted" need to land in CLI history. We bridge
// the two with a module-scoped observer table that the CLI command populates
// when it registers the goal and clears when the goal is unregistered.
//
// Observers are fire-and-forget — they MUST NOT throw or block the hook
// callback; any side effect (e.g. context.ui.addItem) should be guarded.
// ───────────────────────────────────────────────────────────────────────────

export type GoalTerminalKind = 'achieved' | 'aborted';

export interface GoalTerminalEvent {
  kind: GoalTerminalKind;
  condition: string;
  iterations: number;
  durationMs: number;
  lastReason?: string;
  /** Free-form note used for `aborted` (e.g. "max iterations reached"). */
  systemMessage?: string;
}

export type GoalTerminalObserver = (event: GoalTerminalEvent) => void;

const observers = new Map<string, GoalTerminalObserver>();

export function setGoalTerminalObserver(
  sessionId: string,
  observer: GoalTerminalObserver,
): void {
  observers.set(sessionId, observer);
}

export function clearGoalTerminalObserver(sessionId: string): void {
  observers.delete(sessionId);
}

export function notifyGoalTerminal(
  sessionId: string,
  event: GoalTerminalEvent,
): void {
  // Stash the last terminal event so an empty `/goal` after the loop ends
  // can surface a summary of what just happened (matches Claude Code 2.1.140
  // empty-/goal-after-achievement UX: scans transcript for last met:true
  // goal_status and renders an achievement card). We keep the cache in core
  // so the CLI command can read it without having access to UI history.
  recordLastTerminalEvent(sessionId, event);
  const observer = observers.get(sessionId);
  if (!observer) return;
  try {
    observer(event);
  } catch {
    // Observers are best-effort. Do not let UI-side errors poison the hook
    // callback — losing a card is acceptable; losing the /goal loop is not.
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Last-completed-goal cache
//
// Mirrors `yjK` in Claude Code's binary: empty `/goal` after the active goal
// is gone should show "Goal achieved · X turns · Ys" for the most recent
// actually-finished goal. Only `achieved` and `aborted` qualify (those are
// the `GoalTerminalKind`s); the user-driven `/goal clear` path emits a
// `cleared` history card directly and never flows through this notifier.
// ───────────────────────────────────────────────────────────────────────────

const lastTerminal = new Map<string, GoalTerminalEvent>();

function recordLastTerminalEvent(
  sessionId: string,
  event: GoalTerminalEvent,
): void {
  lastTerminal.set(sessionId, event);
}

export function getLastGoalTerminal(
  sessionId: string,
): GoalTerminalEvent | undefined {
  return lastTerminal.get(sessionId);
}

/**
 * Used by session resume to repopulate the cache from persisted history when
 * an in-memory restart loses the cache but the transcript still has the
 * achievement record.
 */
export function setLastGoalTerminal(
  sessionId: string,
  event: GoalTerminalEvent | undefined,
): void {
  if (!event) {
    lastTerminal.delete(sessionId);
    return;
  }
  lastTerminal.set(sessionId, event);
}

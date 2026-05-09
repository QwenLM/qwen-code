/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview `TaskRegistry` — a single thin store over the
 * polymorphic `TaskState` union. Replaces the three per-kind registry
 * classes (`BackgroundTaskRegistry`, `BackgroundShellRegistry`,
 * `MonitorRegistry`) with one map and a narrow surface. Every kind's
 * lifecycle helpers live in its own per-kind module
 * (`tasks/agent-task.ts` etc.) and call into this registry via
 * `register` / `update` / `evict` / `kill`.
 *
 * Surface (mirrors claw-code's `AppState.tasks` plus a tiny dispatcher):
 *
 *   - `register(task)` — inserts into the map and fires the change
 *     listener. Caller-supplied `task` carries every `TaskBase` field
 *     already populated (per-kind register helpers handle this).
 *   - `get(id)` / `getAll()` / `getByKind(kind)` — read access. The
 *     CLI hook reads `getAll()` to render the pill/dialog.
 *   - `update(id, updater)` — generic immutable update. The qwen-code
 *     analogue of claw-code's `updateTaskState`. Per-kind helpers funnel
 *     status transitions and field mutations through this.
 *   - `evict(id)` — drops a terminal entry. Per-kind grace timers (e.g.
 *     the agent kind's 5s cancel grace) live in the per-kind module.
 *   - `kill(id, ctx)` — polymorphic dispatch via
 *     {@link getTaskByType}. Looks up the entry's kind and calls the
 *     kind's `kill`. The only polymorphic method on the registry.
 *   - `subscribe(listener)` — single subscription for "any task
 *     changed". Replaces the trio of `setRegisterCallback /
 *     setStatusChangeCallback / setActivityChangeCallback` the old
 *     registries each carried. Activity bursts now route through the
 *     same listener; perf concerns are addressed by per-component
 *     memoization at the call site, not by splitting callbacks.
 *
 * What is intentionally NOT on the registry:
 *
 *   - No `complete` / `fail` / `cancel` / `finalize` / `appendActivity`
 *     / `emitNotification`. Each is per-kind state — the agent kind's
 *     `<task-notification>` XML emission, the monitor's terminal entry
 *     prune, the shell's exitCode wiring all live in the matching
 *     `*-task.ts` module as free functions.
 *   - No grace timers. The agent kind's 5s cancel-then-fallback timer
 *     moves into `agent-task.ts` and schedules its own `evict` if the
 *     natural settle handler doesn't fire first.
 *   - No `reset` / `abortAll`. Session shutdown coordinates these
 *     across kinds in the per-kind helpers (`agentAbortAll`,
 *     `shellAbortAll`, `monitorAbortAll`); a single `reset` on the
 *     registry would flatten kind-specific shutdown semantics.
 */

import { createDebugLogger } from '../../utils/debugLogger.js';
import type { RegistryTaskKind, TaskState } from './types.js';
import { getTaskByType, type KillContext } from './dispatcher.js';

const debugLogger = createDebugLogger('TASK_REGISTRY');

/**
 * Fires on every change to a task entry: register, update, evict, or
 * mass clear. The callback receives the affected entry, or `undefined`
 * for mass-clear / evict-all paths the registry doesn't need to
 * surface a particular row for.
 *
 * Single registry, multiple listeners: register + dialog hook + headless
 * holdback gate can subscribe simultaneously without coordinating.
 * Replaces the per-class single-callback pattern of the old registries.
 */
export type TaskChangeListener = (entry?: TaskState) => void;

/**
 * Narrow inverse of {@link TaskState} keyed by {@link RegistryTaskKind}
 * — `getByKind('agent')` returns `AgentTask[]`, `getByKind('shell')`
 * returns `ShellTask[]`, etc. Dream is excluded because the registry
 * doesn't hold dream entries; query the dream adapter instead.
 */
export type TaskOfKind<K extends RegistryTaskKind> = Extract<
  TaskState,
  { kind: K }
>;

export class TaskRegistry {
  private readonly entries = new Map<string, TaskState>();
  private readonly listeners = new Set<TaskChangeListener>();

  /**
   * Insert a fully-populated task into the registry and fire the change
   * listener. Per-kind helpers (`agentRegister`, `shellRegister`,
   * `monitorRegister`) populate the `TaskBase` envelope (`id`, `kind`,
   * `outputOffset`, `notified`) before calling this; the registry
   * stores the reference verbatim.
   *
   * Returns the registered entry so callers can chain post-register
   * mutations on the same reference.
   */
  register<T extends TaskState>(task: T): T {
    if (this.entries.has(task.id)) {
      debugLogger.warn(
        `Duplicate register for task id ${task.id}; overwriting prior entry.`,
      );
    }
    this.entries.set(task.id, task);
    this.fireChange(task);
    return task;
  }

  get(id: string): TaskState | undefined {
    return this.entries.get(id);
  }

  /** Snapshot of every entry regardless of kind or status. */
  getAll(): TaskState[] {
    return Array.from(this.entries.values());
  }

  /**
   * Filtered snapshot for a specific kind. Returned shape is narrowed
   * to the kind's per-kind type so callers don't need a runtime guard.
   */
  getByKind<K extends RegistryTaskKind>(kind: K): Array<TaskOfKind<K>> {
    const out: Array<TaskOfKind<K>> = [];
    for (const entry of this.entries.values()) {
      if (entry.kind === kind) out.push(entry as TaskOfKind<K>);
    }
    return out;
  }

  /**
   * Mutate an entry through the supplied callback, then fire the change
   * listener. The callback mutates in place and returns the same
   * reference; a returned new object is also stored, but no in-tree
   * caller relies on that path.
   *
   * No-op if the entry is missing; returns `undefined` so callers can
   * detect the missing case without a separate `get()`.
   */
  update<T extends TaskState>(
    id: string,
    updater: (current: T) => T,
  ): T | undefined {
    const current = this.entries.get(id) as T | undefined;
    if (!current) return undefined;
    const next = updater(current);
    if (next !== current) {
      this.entries.set(id, next as TaskState);
    }
    this.fireChange(next);
    return next;
  }

  /**
   * Drop a task from the registry without firing terminal notifications
   * or any kind-local cleanup. Per-kind helpers must perform that
   * cleanup before calling `evict`; this method exists so terminal +
   * notified entries can be aged out when retain caps say so. The
   * caller is responsible for the kind-specific decision about *when*
   * to evict (the agent kind's foreground-only path evicts on
   * tool-call return; the monitor kind's `pruneTerminal` evicts past
   * its 128-entry cap; etc.).
   */
  evict(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.fireChange(entry);
  }

  /**
   * Polymorphic cancel — looks up the entry and dispatches to the
   * matching kind's `kill` via {@link getTaskByType}. The kind owns
   * the abort/SIGTERM/lock-release semantics; the registry only does
   * the dispatch. No-op (returns a resolved promise) on missing ids.
   *
   * Dream entries are not held here; the cancel switch in
   * `BackgroundTaskViewContext` dispatches dream cancels through the
   * dispatcher with the dream adapter's context directly, since the
   * registry's lookup misses them.
   */
  async kill(id: string, ctx: KillContext): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    await getTaskByType(entry.kind).kill(id, ctx);
  }

  /**
   * Subscribe to every change. Returns an unsubscribe handle. Multiple
   * subscribers are supported; the registry fans out synchronously
   * inside the mutator. Listener exceptions are swallowed and logged so
   * a buggy listener can't poison the mutator's caller.
   */
  subscribe(listener: TaskChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private fireChange(entry?: TaskState): void {
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch (error) {
        debugLogger.error('Task change listener failed:', error);
      }
    }
  }

  /**
   * Test-only: drop every entry and clear all listeners. Production
   * code should never call this — session shutdown uses per-kind
   * `*AbortAll` helpers so each kind can run its own cleanup.
   */
  _resetForTest(): void {
    this.entries.clear();
    this.listeners.clear();
  }
}

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Per-kind `Task` dispatcher. Mirrors claw-code's
 * `tasks.ts:37` (`getTaskByType(type) → Task`). Each per-kind module
 * (`agent-task.ts`, `shell-task.ts`, `monitor-task.ts`,
 * `dream-task.ts`) registers its `Task` implementation here at startup;
 * `TaskRegistry.kill(id)` and the dialog's `cancelSelected` look up
 * the kind's `kill` through this table.
 *
 * The registry pattern (vs. static imports) avoids a circular
 * dependency between `registry.ts` and the per-kind modules — the
 * registry imports `getTaskByType` from this file; the per-kind
 * modules import `TaskRegistry` from `registry.ts`. With static
 * imports the cycle would be `registry → dispatcher → agent-task →
 * registry`, which ESM tolerates but JS hoisting around `const`
 * exports does not.
 *
 * Init order: `Config.initialize()` calls `registerAllTaskKinds()`
 * before any registry consumer can run.
 */

import type { TaskKind } from './types.js';
import type { TaskRegistry } from './registry.js';
import type { MemoryManager } from '../memory/manager.js';

/** Mutation handles each kind's `kill` needs. */
export interface KillContext {
  registry: TaskRegistry;
  memoryManager: MemoryManager;
}

/**
 * Polymorphic surface a kind exposes for the dispatcher to call. The
 * minimum claw-code's `Task` interface carries (`Task.ts:72`); intent is
 * deliberately narrow — the kind's lifecycle helpers live as free
 * functions in the same module rather than methods here.
 *
 * `kill` may be sync or async; the dispatcher awaits the result so
 * callers can chain post-cancel work if needed. Most implementations
 * return synchronously today (registry mutation + abort signal); the
 * `Promise<void>` return shape leaves room for a future kind whose
 * cancel needs to await an external system.
 */
export interface Task {
  kind: TaskKind;
  /** Human-readable name for logs/debug; not surfaced in the UI. */
  name: string;
  /**
   * Terminate the task identified by `id`. Implementations are
   * responsible for: aborting the kind's `AbortController`, flipping
   * the entry's `status` to `'cancelled'`, scheduling any per-kind
   * grace timer or persistence patch, and ensuring the kind's
   * terminal notification fires (or doesn't, per kind policy).
   *
   * No-op contract: implementations must be idempotent on missing /
   * already-terminal entries. Callers (`TaskRegistry.kill`, the dialog
   * cancel switch) do not pre-check.
   */
  kill(id: string, ctx: KillContext): Promise<void> | void;
}

const REGISTRY: Partial<Record<TaskKind, Task>> = {};

/**
 * Register a kind's `Task` implementation. Called once per kind at
 * `Config` initialization, before any consumer can run a cancel.
 * Idempotent — re-registering the same kind overwrites the prior
 * entry, which is what test fixtures want when they swap an
 * implementation between tests.
 */
export function registerTaskKind(task: Task): void {
  REGISTRY[task.kind] = task;
}

/**
 * Look up a kind's `Task`. Throws if the kind hasn't been registered —
 * a dispatcher miss is a programming error (the per-kind module wasn't
 * loaded), not a runtime user-input error.
 */
export function getTaskByType(kind: TaskKind): Task {
  const task = REGISTRY[kind];
  if (!task) {
    throw new Error(
      `getTaskByType: no Task registered for kind '${kind}'. ` +
        `Ensure the per-kind module is imported and registerTaskKind() ` +
        `has been called (typically at Config initialization).`,
    );
  }
  return task;
}

/**
 * Test-only: clear the dispatcher table. Tests that register a kind
 * with a mock should call this in afterEach so a later test starts
 * with a clean slate.
 */
export function _resetTaskKindsForTest(): void {
  for (const kind of Object.keys(REGISTRY)) {
    delete REGISTRY[kind as TaskKind];
  }
}

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Shared `TaskBase` envelope and discriminated `TaskState`
 * union covering the three core task kinds (agent, shell, monitor). The
 * three existing per-kind registries (`BackgroundTaskRegistry`,
 * `BackgroundShellRegistry`, `MonitorRegistry`) each hold entries that
 * extend this base; their per-kind state is layered on via intersection.
 *
 * The base envelope is intentionally narrow:
 *   - `id` / `kind` — registry key + discriminator
 *   - `description` — human label for pill/panel/dialog
 *   - `status` / `startTime` / `endTime` — lifecycle
 *   - `outputFile` / `outputOffset` — reserved path for the per-task
 *     primary stream and a byte cursor for incremental reads
 *   - `notified` — terminal-notification idempotency flag
 *   - `abortController` — unified cancellation handle
 *
 * `outputFile` is mandatory but treated as a *reserved path*, not a
 * guaranteed file. Each kind decides whether it materializes the file:
 * agents lazily open their JSONL writer on the first emitted event,
 * shells stream stdout/stderr from spawn time, and monitors today reserve
 * a path but don't attach a writer. A task that never produces output
 * has a path on its state but no file on disk.
 */

/**
 * Discriminator over the task kinds the unified `TaskRegistry` and the
 * polymorphic `kill` dispatcher route over. Three of the four kinds —
 * `agent`, `shell`, `monitor` — live inside `TaskRegistry`'s map; the
 * fourth, `dream`, lives in `MemoryManager` and is bridged in via the
 * dream adapter (`tasks/dream-task.ts`). The dispatcher carries `dream`
 * so `cancelSelected` and other consumers can dispatch uniformly across
 * all four without a kind-switch.
 */
export type TaskKind = 'agent' | 'shell' | 'monitor' | 'dream';

/**
 * Subset of `TaskKind` for entries actually held by `TaskRegistry`.
 * Excludes `dream`, which is adapted from `MemoryManager` rather than
 * registered. Used internally by the registry's `getByKind` and
 * `getAll` typings.
 */
export type RegistryTaskKind = Exclude<TaskKind, 'dream'>;

/**
 * Lifecycle states a task can occupy. `paused` and `cancelled` are
 * qwen-code extensions used for resumable agents and explicit user
 * cancellation; not every kind uses every state (shells and monitors
 * never `paused`, for example).
 */
export type TaskStatus =
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Common envelope every task carries regardless of kind. Per-kind
 * modules extend this via intersection (`TaskBase & { kind: 'agent', ... }`).
 */
export interface TaskBase {
  /** Stable id used as the registry key. Per-kind types alias this to
   *  their existing field name (e.g. `agentId`) during the back-compat
   *  window; both fields are populated to the same value at register time. */
  id: string;
  /** Discriminator selecting the per-kind shape. */
  kind: TaskKind;
  /** Human label rendered in the pill/panel/dialog. */
  description: string;
  status: TaskStatus;
  /** ms epoch when the task was registered. */
  startTime: number;
  /** ms epoch when the task transitioned out of running. */
  endTime?: number;
  /**
   * Absolute path of the per-task primary stream. Reserved at register
   * time even when no writer is attached today (monitors). Materialized
   * by each kind's writer on its first append, not at register time.
   * Note this is "first append", not "first runtime event": the agent
   * writer seeds the launch prompt as its first record at attach time,
   * so a foreground/background subagent with a prompt materializes its
   * JSONL immediately — before any tool call or model turn. A subagent
   * cancelled before any event therefore still leaves a JSONL (prompt
   * only) plus the meta sidecar, not meta alone.
   */
  outputFile: string;
  /**
   * Byte offset into `outputFile` for incremental reads. Initialized to
   * 0 and advanced by readers. Stays at 0 forever for kinds that don't
   * materialize the file (monitors).
   */
  outputOffset: number;
  /** True once the kind's terminal notification has fired. */
  notified: boolean;
  /** Unified cancellation handle. */
  abortController: AbortController;
}

/**
 * Shape callers pass to a registry's `register()`. The four `TaskBase`
 * fields the registry derives — `id`, `kind`, `outputOffset`, `notified`
 * — are omitted; everything else (including `outputFile`) is the
 * caller's responsibility unless the per-kind registration narrows it
 * further (e.g. shells let the registry alias `outputPath` →
 * `outputFile`).
 */
export type TaskRegistration<T extends TaskBase> = Omit<
  T,
  'id' | 'kind' | 'outputOffset' | 'notified'
>;

// Per-kind types live in their owning modules; the union is composed
// here so consumers can switch on `kind`.
import type { AgentTask } from './agent-task.js';
import type { ShellTask } from './shell-task.js';
import type { MonitorTask } from './monitor-task.js';

/**
 * Discriminated union over every task kind held by the unified
 * `TaskRegistry`. Dream tasks are not in this union — they live in
 * `MemoryManager` and are surfaced via the dream adapter
 * (`tasks/dream-task.ts`). Switch on `kind` to narrow to the per-kind
 * shape.
 */
export type TaskState = AgentTask | ShellTask | MonitorTask;

export type { AgentTask, ShellTask, MonitorTask };

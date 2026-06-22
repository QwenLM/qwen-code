/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview BackgroundTaskRegistry — tracks background (async) sub-agents
 * and, with `isBackgrounded: false`, the currently-running synchronous
 * sub-agents whose UI is routed through the same pill+dialog while the
 * parent turn waits on them. Both share the registry (and the dialog
 * wiring) but differ in lifecycle:
 *
 * - `isBackgrounded: true` entries persist across turns, emit a
 *   `<task-notification>` on terminal status (the parent's only return
 *   channel), and contribute to `hasUnfinalizedTasks()` so headless callers
 *   keep their loop alive.
 * - `isBackgrounded: false` entries live for the duration of the parent's
 *   tool-call, are unregistered as soon as `execute()` returns, deliver
 *   their result through the normal tool-result channel (no XML envelope),
 *   and don't participate in the headless holdback.
 */

import { ToolConfirmationOutcome } from '../tools/tools.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { escapeXml } from '../utils/xml.js';
import { patchAgentMeta } from './agent-transcript.js';
import {
  AgentEventType,
  type AgentApprovalRequestEvent,
  type AgentEventEmitter,
  type AgentToolResultEvent,
} from './runtime/agent-events.js';
import type { AgentExternalInput } from './runtime/agent-types.js';
import type { TaskBase, TaskRegistration, TaskStatus } from './tasks/types.js';

const debugLogger = createDebugLogger('BACKGROUND_TASKS');

const MAX_DESCRIPTION_LENGTH = 40;
const MAX_RECENT_ACTIVITIES = 5;
export const DEFAULT_MAX_CONCURRENT_BACKGROUND_AGENTS = 10;
export const BACKGROUND_AGENT_CONCURRENCY_ENV =
  'QWEN_CODE_MAX_BACKGROUND_AGENTS';

function normalizeBackgroundApprovalOutcome(
  outcome: Parameters<BackgroundApproval['respond']>[0],
): Parameters<BackgroundApproval['respond']>[0] {
  if (
    outcome === ToolConfirmationOutcome.ProceedAlways ||
    outcome === ToolConfirmationOutcome.ProceedAlwaysProject ||
    outcome === ToolConfirmationOutcome.ProceedAlwaysUser ||
    outcome === ToolConfirmationOutcome.ProceedAlwaysServer ||
    outcome === ToolConfirmationOutcome.ProceedAlwaysTool
  ) {
    return ToolConfirmationOutcome.ProceedOnce;
  }
  return outcome;
}

export function resolveMaxConcurrentBackgroundAgents(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[BACKGROUND_AGENT_CONCURRENCY_ENV];
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_MAX_CONCURRENT_BACKGROUND_AGENTS;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    debugLogger.warn(
      `Invalid ${BACKGROUND_AGENT_CONCURRENCY_ENV}=${JSON.stringify(raw)}, ` +
        `using default (${DEFAULT_MAX_CONCURRENT_BACKGROUND_AGENTS})`,
    );
    return DEFAULT_MAX_CONCURRENT_BACKGROUND_AGENTS;
  }

  return parsed;
}

export const MAX_CONCURRENT_BACKGROUND_AGENTS =
  resolveMaxConcurrentBackgroundAgents();

/**
 * Cap on how many fully-finalized terminal entries (those that have
 * already emitted their terminal `task-notification`) the registry
 * retains. Without this cap, every short-lived background subagent
 * leaves a row in the Background tasks dialog and pill forever,
 * crowding out the running entries the user actually opened the
 * dialog to find. Mirrors the rationale + retention pattern in
 * `MonitorRegistry.MAX_RETAINED_TERMINAL_MONITORS` and
 * `BackgroundShellRegistry.MAX_RETAINED_TERMINAL_SHELLS`.
 *
 * Entries that are still `running`, `paused`, or `cancelled` but
 * not yet notified are NEVER evicted — pruning a not-yet-notified
 * cancelled entry would break the SDK contract that every
 * `register` pairs with exactly one terminal `task-notification`.
 */
export const MAX_RETAINED_TERMINAL_AGENTS = 32;

// Grace period after cancel() before emitting a fallback cancelled
// notification. The natural handler (bgBody) almost always settles and
// emits the terminal notification with the real partial result well
// within this window; the timeout only fires for pathological tools
// that ignore AbortSignal. Must be long enough that normal scheduler
// unwind wins the race, short enough that a stuck headless wait loop
// doesn't feel hung.
const CANCEL_GRACE_MS = 5000;

/**
 * Outcome used to auto-reject a parked approval that can no longer be
 * answered (the agent terminated, or the entry was gone when the event
 * arrived). `Cancel` resolves the parked tool call as denied so the
 * agent's reasoning loop unblocks instead of hanging.
 */
const REJECTED_OUTCOME = ToolConfirmationOutcome.Cancel;

/**
 * Single source of truth for the human-facing label of a background
 * entry. Shared by the notification payload (model-facing) and the TUI
 * dialog (user-facing) so the two surfaces never drift.
 *
 * When `includePrefix` is true (default), returns `subagentType: desc`;
 * when false, returns the bare truncated description — used where the
 * subagent type is already rendered separately (e.g. the dialog header).
 */
export function buildBackgroundEntryLabel(
  entry: { description: string; subagentType?: string },
  options: { includePrefix?: boolean } = {},
): string {
  const { includePrefix = true } = options;
  let raw = entry.description;
  if (
    entry.subagentType &&
    raw.toLowerCase().startsWith(entry.subagentType.toLowerCase() + ':')
  ) {
    raw = raw.slice(entry.subagentType.length + 1).trimStart();
  }
  const truncated =
    raw.length > MAX_DESCRIPTION_LENGTH
      ? raw.slice(0, MAX_DESCRIPTION_LENGTH - 1) + '\u2026'
      : raw;
  return includePrefix && entry.subagentType
    ? `${entry.subagentType}: ${truncated}`
    : truncated;
}

// Subagent-produced strings (description, result, error) can contain `<`,
// `>`, or literal `</task-notification>` — without escaping, a subagent
// summarizing HTML or another agent's notification could close the
// envelope early and forge sibling tags (e.g. a faked <status>) that the
// parent model would treat as trusted metadata. Use the shared helper.

/**
 * @deprecated Use `TaskStatus` from `./tasks/types.js`. Kept as a one-release
 * alias so existing consumers (notably `nonInteractiveCli.ts`) compile
 * unchanged; the underlying union is identical.
 */
export type BackgroundTaskStatus = TaskStatus;

export interface AgentCompletionStats {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
}

/**
 * A tool call from a background agent that is parked waiting for the user
 * to approve or reject it from the parent session's UI ("permission
 * bubbling"). Without this, a background agent whose `approvalMode` still
 * requires confirmation for some call would be auto-denied — defeating the
 * point of backgrounding. The entry holds everything the shared
 * confirmation component needs to render plus the `respond` callback that
 * resumes the parked tool call.
 *
 * `confirmationDetails` deliberately omits `onConfirm` (the runtime owns
 * that via `respond`) — the UI renders the rest and calls `respond` with
 * the chosen outcome.
 */
export interface BackgroundApproval {
  /** Tool-call id the approval belongs to. */
  callId: string;
  /** Tool name (e.g. `Shell`) — drives the row/notification label. */
  name: string;
  /** Render-friendly one-line description of the call. */
  description: string;
  /** Everything the confirmation UI needs except the owned `onConfirm`. */
  confirmationDetails: AgentApprovalRequestEvent['confirmationDetails'];
  /** Resolve the parked call with the user's outcome. */
  respond: AgentApprovalRequestEvent['respond'];
  /** Emission timestamp (ms) — newest-first ordering in the UI. */
  at: number;
}

/**
 * A compact record of a recent tool invocation — drives the Progress
 * section of the detail dialog. The Agent tool maintains a rolling
 * buffer of these on each background entry by subscribing to the
 * subagent's event emitter.
 */
export interface BackgroundActivity {
  /** Tool name (e.g. `Bash`, `Read`). */
  name: string;
  /** Short one-line description — the tool's own render-friendly summary. */
  description: string;
  /** Emission timestamp (ms). */
  at: number;
}

/**
 * Agent kind of `TaskState`. Tracks one running subagent — either a
 * synchronous foreground run (`isBackgrounded: false`, awaited by the
 * parent's tool-call) or an async background run (`isBackgrounded: true`,
 * persists across turns and emits a terminal `<task-notification>`).
 *
 * Carries the shared `TaskBase` envelope plus agent-specific state:
 * subagent config, prompt, stats, recent activity buffer, persisted
 * sidecar metadata path, message queue, and resume hooks.
 */
export interface AgentTask extends TaskBase {
  kind: 'agent';
  /**
   * @deprecated Read `id` instead; kept as a synonym during the back-compat
   * window. Always equals `id`.
   */
  agentId: string;
  subagentType?: string;
  /**
   * True if the task is running asynchronously (parent has moved on, the
   * task persists across turns and emits a terminal XML notification).
   * False if the parent's tool-call is synchronously awaiting it; the
   * result is delivered through the normal tool-result channel and no
   * XML envelope fires. Replaces the older `flavor: 'foreground' |
   * 'background'` discriminator — same binary fact, named after the
   * question every read site asks.
   */
  isBackgrounded: boolean;
  status: TaskStatus;
  result?: string;
  error?: string;
  /**
   * Present only when the task is intentionally kept paused but cannot be
   * safely resumed under the current conditions.
   */
  resumeBlockedReason?: string;
  stats?: AgentCompletionStats;
  toolUseId?: string;
  /**
   * The original user-supplied prompt for the background task. Surfaced
   * verbatim in the detail dialog's Prompt section. Optional because
   * resume-restored entries may not have it.
   */
  prompt?: string;
  /**
   * Rolling buffer (newest last, capped at MAX_RECENT_ACTIVITIES) of
   * recent tool invocations by this agent. Feeds the detail dialog's
   * Progress section. Replaced as a new array each time an activity is
   * appended so reference-based change detection works. Optional:
   * callers may register without providing it, and `appendActivity`
   * initializes the array lazily.
   */
  recentActivities?: readonly BackgroundActivity[];
  /**
   * Tool calls this background agent has parked awaiting user approval
   * (permission bubbling). Empty/absent unless the agent opted into
   * bubbling AND a tool call reached `awaiting_approval`. Each is answered
   * via its `respond` callback; answering removes it from this list.
   * Newest last, mirroring `recentActivities`.
   */
  pendingApprovals?: readonly BackgroundApproval[];
  /** Absolute path to the agent's sidecar metadata file. */
  metaPath?: string;
  /**
   * Inputs queued for delivery between tool rounds.
   * Strings are parent `send_message` payloads; notification objects are
   * owner-routed Monitor notifications.
   */
  pendingMessages?: AgentExternalInput[];
  /**
   * Persisted sidecar status to write when the current cancellation settles.
   * Explicit user cancellation uses `cancelled`; shutdown interruption keeps
   * `running` so `/resume` can recover the work later.
   */
  persistedCancellationStatus?: Extract<TaskStatus, 'running' | 'cancelled'>;
}

/**
 * @deprecated Renamed to `AgentTask`. Kept as a one-release type alias for
 * external SDK consumers; will be removed in the release after PR 2 lands.
 */
export type BackgroundTaskEntry = AgentTask;

/**
 * Shape callers pass to {@link BackgroundTaskRegistry.register}; the
 * registry derives the shared `TaskBase` envelope (`id`, `kind`,
 * `outputOffset`, `notified`) from these and the surrounding context.
 * `outputFile` is required here because every agent run reserves a JSONL
 * transcript path at registration.
 */
export type AgentTaskRegistration = TaskRegistration<AgentTask>;

export interface BackgroundTaskRegisterOptions {
  suppressRegisterCallback?: boolean;
  preserveNotificationState?: boolean;
}

export interface NotificationMeta {
  agentId: string;
  status: TaskStatus;
  stats?: AgentCompletionStats;
  toolUseId?: string;
}

export type BackgroundNotificationCallback = (
  displayText: string,
  modelText: string,
  meta: NotificationMeta,
) => void;

export type BackgroundRegisterCallback = (entry: AgentTask) => void;

interface BackgroundTaskCancelOptions {
  notify?: boolean;
  persistedStatus?: Extract<TaskStatus, 'running' | 'cancelled'>;
}

/**
 * Fires on entry status transitions: `register`, `complete`, `fail`,
 * `cancel`, `finalizeCancelled`, `finalizeCancellationIfPending`,
 * `abandon`, `unregisterForeground`, and `reset`. Intentionally does
 * NOT fire on `appendActivity` so consumers that only care about the
 * roster don't re-render on every tool call a background agent makes.
 *
 * Ordering relative to the registry mutation falls into two camps:
 *   - **Keeps the entry around** (`register` / `complete` / `fail` /
 *     `cancel` / `finalizeCancelled` /
 *     `finalizeCancellationIfPending` / `abandon`): emit while the
 *     entry is still in the Map (the status field has been mutated
 *     in place to its terminal value), so a callback that re-reads
 *     `registry.get(entry.agentId)` sees the entry. Snapshot-style
 *     consumers calling `getAll()` see the new status too.
 *   - **Removes the entry** (`unregisterForeground`, `reset`):
 *     deletes from the Map BEFORE emitting so snapshot-style
 *     consumers drop the row. The `entry` arg carries the agent's
 *     last live state for log / display consumers; `registry.get`
 *     and `getAll` already reflect the deletion.
 */
export type BackgroundStatusChangeCallback = (entry?: AgentTask) => void;

/** Fires on `appendActivity` — scoped to detail-view consumers. */
export type BackgroundActivityChangeCallback = (entry: AgentTask) => void;

/**
 * Fires when a background agent's pending-approval queue changes (a tool
 * call is parked for confirmation, or a parked one is answered/cleared).
 * Distinct from `statusChange` so the footer pill and roster snapshot can
 * react to "needs approval" without re-rendering on every tool call, and
 * distinct from `activityChange` so a consumer can subscribe to approvals
 * alone. The arg carries the affected entry (with its current
 * `pendingApprovals`).
 */
export type BackgroundApprovalChangeCallback = (entry: AgentTask) => void;

type MessageWaiter = () => void;

export interface BackgroundTaskRegistryOptions {
  maxConcurrentBackgroundAgents?: number;
}

export class BackgroundTaskRegistry {
  private readonly agents = new Map<string, AgentTask>();
  private readonly messageWaiters = new Map<string, Set<MessageWaiter>>();
  private readonly maxConcurrentBackgroundAgents: number;
  private notificationCallback?: BackgroundNotificationCallback;
  private registerCallback?: BackgroundRegisterCallback;
  private statusChangeCallback?: BackgroundStatusChangeCallback;
  private activityChangeCallback?: BackgroundActivityChangeCallback;
  private approvalChangeCallback?: BackgroundApprovalChangeCallback;

  constructor(options: BackgroundTaskRegistryOptions = {}) {
    const configured =
      options.maxConcurrentBackgroundAgents ?? MAX_CONCURRENT_BACKGROUND_AGENTS;
    this.maxConcurrentBackgroundAgents =
      Number.isInteger(configured) && configured >= 1
        ? configured
        : MAX_CONCURRENT_BACKGROUND_AGENTS;
  }

  assertCanStartBackgroundAgent(): void {
    const running = this.getRunningBackgroundCount();
    if (running >= this.maxConcurrentBackgroundAgents) {
      debugLogger.warn(
        `Background agent concurrency cap reached: ` +
          `${running}/${this.maxConcurrentBackgroundAgents}. ` +
          `Refusing new background agent.`,
      );
      throw new Error(
        `Cannot start background agent: maximum concurrent background agents ` +
          `(${this.maxConcurrentBackgroundAgents}) reached. Stop an existing ` +
          `agent first.`,
      );
    }
  }

  register(
    registration: AgentTaskRegistration,
    options: BackgroundTaskRegisterOptions = {},
  ): AgentTask {
    if (registration.isBackgrounded && registration.status === 'running') {
      const existing = this.agents.get(registration.agentId);
      const isReplacingRunning =
        existing?.isBackgrounded === true && existing.status === 'running';
      if (!isReplacingRunning) {
        this.assertCanStartBackgroundAgent();
      }
    }

    // Mutate the registration in place to graduate it to an `AgentTask`.
    // Returning the same reference lets callers (e.g. the resume service)
    // continue using their local variable post-register and lets external
    // consumers see updates the registry makes without an extra `get()`.
    const entry = registration as AgentTask;
    entry.id = registration.agentId;
    entry.kind = 'agent';
    entry.outputOffset = options.preserveNotificationState
      ? ((registration as AgentTask).outputOffset ?? 0)
      : 0;
    entry.notified = options.preserveNotificationState
      ? ((registration as AgentTask).notified ?? false)
      : false;
    entry.pendingMessages = registration.pendingMessages ?? [];
    this.agents.set(entry.agentId, entry);
    debugLogger.info(`Registered background agent: ${entry.agentId}`);

    // Foreground entries are paired with a synchronous tool-call result on
    // the parent's response and never emit a terminal `task_notification`
    // (see emitNotification's isBackgrounded gate). Letting them fire the
    // register callback would emit a `task_started` SDK event without a
    // matching completion event, breaking the lifecycle contract for SDK
    // consumers.
    if (
      entry.isBackgrounded &&
      this.registerCallback &&
      !options.suppressRegisterCallback
    ) {
      try {
        this.registerCallback(entry);
      } catch (error) {
        debugLogger.error('Failed to emit register callback:', error);
      }
    }
    this.emitStatusChange(entry);
    return entry;
  }

  // Transition a still-running entry to 'completed' and emit the terminal
  // notification. No-op if the entry is already terminal *and* has been
  // notified — protects against duplicate emission when cancel aborts the
  // signal and the natural handler also races to completion.
  complete(
    agentId: string,
    result: string,
    stats?: AgentCompletionStats,
  ): void {
    const entry = this.agents.get(agentId);
    if (!entry) return;
    // Allow running → completed (normal path) and cancelled → completed
    // (cancel raced the natural handler: the reasoning loop finished with
    // a real result before the abort landed, and we prefer to surface that
    // real result over the bare cancel).
    if (entry.status !== 'running' && entry.status !== 'cancelled') return;
    if (entry.notified) return;

    entry.status = 'completed';
    entry.endTime = Date.now();
    entry.result = result;
    entry.stats = stats;
    debugLogger.info(`Background agent completed: ${agentId}`);

    this.rejectPendingApprovals(entry);
    this.emitNotification(entry);
    this.emitStatusChange(entry);
  }

  /**
   * Remove a foreground entry from the registry without emitting any
   * terminal notification. Called by the foreground tool-call's `finally`
   * path, which has already delivered the result through the tool-result
   * channel — the registry entry has served its UI-surfacing purpose.
   * Background entries must go through complete/fail/finalizeCancelled
   * instead, so this throws if asked to remove one.
   */
  unregisterForeground(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (!entry) return;
    if (entry.isBackgrounded) {
      throw new Error(
        `unregisterForeground called on non-foreground entry ${agentId} ` +
          `(isBackgrounded=true). ` +
          `Background entries must terminate via complete/fail/finalizeCancelled.`,
      );
    }
    // Delete BEFORE emitting so snapshot-style consumers (those that
    // re-pull `getAll()` from inside the callback) no longer include
    // this entry. The reverse order (emit-then-delete) caused the
    // foreground agent to linger as `status='running'` in the footer
    // pill / dialog: the callback's `getAll()` still saw it, and no
    // second status-change fired after the deletion. Diverges from
    // complete/fail/cancel/finalize ordering on purpose — those
    // keep the entry around (terminal state) so callbacks can inspect
    // it on re-read; unregister removes it outright.
    this.agents.delete(agentId);
    this.emitStatusChange(entry);
    debugLogger.info(`Unregistered foreground agent: ${agentId}`);
  }

  // See complete() for the cancelled → terminal path rationale.
  fail(agentId: string, error: string, stats?: AgentCompletionStats): void {
    const entry = this.agents.get(agentId);
    if (!entry) return;
    if (entry.status !== 'running' && entry.status !== 'cancelled') return;
    if (entry.notified) return;

    entry.status = 'failed';
    entry.endTime = Date.now();
    entry.error = error;
    entry.stats = stats;
    debugLogger.info(`Background agent failed: ${agentId}`);

    this.rejectPendingApprovals(entry);
    this.emitNotification(entry);
    this.emitStatusChange(entry);
  }

  // Cancellation aborts the signal and marks the entry as cancelled, but
  // does *not* emit the terminal notification immediately. The natural
  // completion path (bgBody) fires complete()/fail()/finalizeCancelled()
  // with the real partial/final result, which carries far more information
  // than a bare "cancelled" message. A deferred fallback handles the rare
  // case where a tool ignores AbortSignal and bgBody never settles — the
  // timeout lands on finalizeCancellationIfPending(), which is a no-op
  // once the natural handler has already emitted.
  //
  // Foreground entries (`isBackgrounded === false`) take a partial path
  // through this method: status flips to 'cancelled' and the meta sidecar
  // is patched, but the Map entry is *not* removed. Removal is the caller's
  // responsibility via `unregisterForeground()` in the tool-call's finally
  // path — without that follow-up, the foreground entry leaks. Callers
  // outside `agent.ts` that invoke `cancel()` on a foreground entry must
  // pair it with `unregisterForeground()`.
  cancel(agentId: string, options: BackgroundTaskCancelOptions = {}): void {
    const entry = this.agents.get(agentId);
    if (!entry || entry.status !== 'running') return;
    const persistedStatus = options.persistedStatus ?? 'cancelled';

    // Reject parked approvals BEFORE aborting. Order matters: abort()
    // synchronously unwinds the agent's awaiting tool batch, which emits a
    // synthetic TOOL_RESULT for the parked call — the approval bridge's
    // onResult then clears the queue, and a reject that ran after the abort
    // would find nothing left to answer. Rejecting first guarantees each
    // parked call's `respond(Cancel)` actually fires, and the bridge's
    // subsequent clear is a no-op on the already-emptied queue.
    this.rejectPendingApprovals(entry);
    entry.abortController.abort();
    entry.status = 'cancelled';
    entry.endTime = Date.now();
    entry.persistedCancellationStatus = persistedStatus;
    if (entry.metaPath) {
      patchAgentMeta(entry.metaPath, {
        status: persistedStatus,
        lastUpdatedAt: new Date().toISOString(),
        lastError: undefined,
      });
    }
    debugLogger.info(`Background agent cancelled: ${agentId}`);
    this.emitStatusChange(entry);

    // Foreground entries don't emit XML notifications and unregister
    // themselves in the tool-call's finally path, so the grace timer
    // would only ever no-op for them.
    if (!entry.isBackgrounded) return;

    if (options.notify === false) {
      // Session reset paths intentionally suppress the old task's terminal
      // notification so it cannot leak into a new conversation.
      entry.notified = true;
      return;
    }

    const timer = setTimeout(() => {
      this.finalizeCancellationIfPending(agentId);
    }, CANCEL_GRACE_MS);
    timer.unref?.();
  }

  /**
   * Marks a paused interrupted task as intentionally discarded/cancelled
   * without emitting a task-notification. Used when the user explicitly
   * abandons a recovered task instead of resuming it.
   */
  abandon(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (!entry || entry.status !== 'paused') return;

    entry.status = 'cancelled';
    entry.endTime = Date.now();
    entry.notified = true;
    debugLogger.info(`Abandoned paused background agent: ${agentId}`);
    this.rejectPendingApprovals(entry);
    this.emitStatusChange(entry);
  }

  // Emit the terminal cancelled notification once the agent's natural
  // handler has confirmed that the reasoning loop ended because of the
  // abort (terminateMode === CANCELLED). Attaches the partial result and
  // stats so the parent model still sees whatever work the agent had
  // captured before the abort landed, instead of a bare "cancelled" line.
  finalizeCancelled(
    agentId: string,
    partialResult: string,
    stats?: AgentCompletionStats,
  ): void {
    const entry = this.agents.get(agentId);
    if (!entry) return;
    if (entry.status !== 'running' && entry.status !== 'cancelled') return;
    if (entry.notified) return;

    entry.status = 'cancelled';
    entry.endTime ??= Date.now();
    if (partialResult) entry.result = partialResult;
    entry.stats = stats;
    this.rejectPendingApprovals(entry);
    this.emitNotification(entry);
    this.emitStatusChange(entry);
  }

  // Emit the terminal cancelled notification for entries that were cancelled
  // but for which no natural handler delivered a follow-up complete()/fail()/
  // finalizeCancelled(). Used by shutdown paths (abortAll) to guarantee the
  // SDK contract (every registered agent produces exactly one
  // task-notification).
  finalizeCancellationIfPending(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (!entry || entry.status !== 'cancelled' || entry.notified) return;
    // Defensive: the entry is already 'cancelled', which only cancel() /
    // finalizeCancelled() / abandon() produce, and all of those reject
    // parked approvals — so this is normally a no-op. Kept so the
    // one-notification-per-agent shutdown fallback can never settle an
    // entry while a parked respond() callback is still outstanding.
    this.rejectPendingApprovals(entry);
    this.emitNotification(entry);
    this.emitStatusChange(entry);
  }

  /**
   * Append a recent tool activity to a running entry's rolling buffer.
   * No-op if the entry is not running — late events after a cancellation
   * shouldn't leak into the Progress section.
   */
  appendActivity(agentId: string, activity: BackgroundActivity): void {
    const entry = this.agents.get(agentId);
    if (!entry || entry.status !== 'running') return;

    const prior = entry.recentActivities ?? [];
    const next = [...prior, activity];
    if (next.length > MAX_RECENT_ACTIVITIES) {
      next.splice(0, next.length - MAX_RECENT_ACTIVITIES);
    }
    entry.recentActivities = next;
    this.emitActivityChange(entry);
  }

  /**
   * Park a tool call awaiting user approval ("permission bubbling"). No-op
   * (and the call is auto-rejected by the caller) if the entry is not a
   * running background agent — late approvals after cancellation must not
   * resurrect a parked prompt. Duplicate callIds are ignored so a
   * re-emitted event can't double-list the same call.
   */
  addPendingApproval(agentId: string, approval: BackgroundApproval): boolean {
    const entry = this.agents.get(agentId);
    if (!entry || !entry.isBackgrounded || entry.status !== 'running') {
      return false;
    }
    const prior = entry.pendingApprovals ?? [];
    if (prior.some((a) => a.callId === approval.callId)) return false;
    entry.pendingApprovals = [...prior, approval];
    debugLogger.info(
      `Parked approval for background agent ${agentId} ` +
        `(call ${approval.callId}, ${entry.pendingApprovals.length} pending)`,
    );
    this.emitApprovalChange(entry);
    return true;
  }

  /**
   * Answer a parked approval with the user's outcome. Invokes the parked
   * call's `respond` callback (which re-enters the agent's runtime frames
   * and resumes the tool), removes it from the queue, and fires an approval
   * change. No-op if the call isn't parked (already answered or cleared).
   */
  async resolvePendingApproval(
    agentId: string,
    callId: string,
    outcome: Parameters<BackgroundApproval['respond']>[0],
    payload?: Parameters<BackgroundApproval['respond']>[1],
  ): Promise<boolean> {
    const entry = this.agents.get(agentId);
    if (!entry) return false;
    const approval = entry.pendingApprovals?.find((a) => a.callId === callId);
    if (!approval) return false;
    // Remove before responding so a re-entrant read inside the respond
    // chain (or a racing TOOL_RESULT clear) sees the call already gone.
    entry.pendingApprovals = (entry.pendingApprovals ?? []).filter(
      (a) => a.callId !== callId,
    );
    this.emitApprovalChange(entry);
    try {
      await approval.respond(
        normalizeBackgroundApprovalOutcome(outcome),
        payload,
      );
    } catch (error) {
      debugLogger.error(
        `Failed to resolve background approval for ${agentId}/${callId}:`,
        error,
      );
      this.fail(agentId, `Failed to resolve background approval: ${callId}`);
      entry.abortController.abort();
      return false;
    }
    return true;
  }

  /**
   * Drop a parked approval WITHOUT responding. Used when the underlying
   * tool call settled through another path (e.g. the scheduler resolved it
   * via an IDE confirmation handler) so the stale prompt must clear without
   * double-answering. Mirrors the foreground `pendingConfirmation` clear in
   * the Agent tool's TOOL_RESULT handler.
   */
  clearPendingApproval(agentId: string, callId: string): void {
    const entry = this.agents.get(agentId);
    if (!entry?.pendingApprovals?.length) return;
    const next = entry.pendingApprovals.filter((a) => a.callId !== callId);
    if (next.length === entry.pendingApprovals.length) return;
    entry.pendingApprovals = next;
    this.emitApprovalChange(entry);
  }

  /** Read a background agent's parked approvals (empty if none). */
  getPendingApprovals(agentId: string): readonly BackgroundApproval[] {
    return this.agents.get(agentId)?.pendingApprovals ?? [];
  }

  /**
   * Subscribe to a background agent's tool-call event stream and bridge
   * approval requests into this registry's parked-approval queue. Returns
   * an unsubscribe function the caller MUST invoke when the agent
   * terminates. Only wire this up when the agent opted into permission
   * bubbling — otherwise the scheduler auto-denies before any
   * `TOOL_WAITING_APPROVAL` fires and this would never see an event anyway.
   *
   * On agent termination any still-parked approval is auto-rejected via its
   * `respond` callback (handled by the caller's cleanup of the agent), so
   * the reasoning loop never hangs on an unanswered prompt.
   */
  bridgeApprovalEvents(
    agentId: string,
    emitter: AgentEventEmitter,
  ): () => void {
    const onWaiting = (event: AgentApprovalRequestEvent) => {
      const parked = this.addPendingApproval(agentId, {
        callId: event.callId,
        name: event.name,
        description: event.description,
        confirmationDetails: event.confirmationDetails,
        respond: event.respond,
        at: event.timestamp,
      });
      // If the entry is already gone/terminal we couldn't park it — reject
      // so the agent's reasoning loop doesn't block forever on this call.
      // `.catch()` rather than try/catch: respond is async and a late
      // rejection (frames torn down post-termination) must not escape as
      // an unhandledRejection.
      if (!parked) {
        void event.respond(REJECTED_OUTCOME).catch((error) => {
          debugLogger.error(
            `Failed to reject unparkable approval ${agentId}/${event.callId}:`,
            error,
          );
        });
      }
    };
    const onResult = (event: AgentToolResultEvent) => {
      // A result for a parked call means it settled elsewhere — clear the
      // stale prompt (without responding again).
      this.clearPendingApproval(agentId, event.callId);
    };
    emitter.on(AgentEventType.TOOL_WAITING_APPROVAL, onWaiting);
    emitter.on(AgentEventType.TOOL_RESULT, onResult);
    return () => {
      emitter.off(AgentEventType.TOOL_WAITING_APPROVAL, onWaiting);
      emitter.off(AgentEventType.TOOL_RESULT, onResult);
    };
  }

  get(agentId: string): AgentTask | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Snapshot of every entry regardless of status. Used by the TUI
   * footer/dialog to render rows for still-running AND terminal-state
   * tasks; the headless holdback loop keys off `hasUnfinalizedTasks`
   * instead, so callers that only need the running slice can filter
   * this snapshot at the call site.
   */
  getAll(): AgentTask[] {
    return Array.from(this.agents.values());
  }

  private getRunningBackgroundCount(): number {
    return Array.from(this.agents.values()).filter(
      (entry) => entry.isBackgrounded && entry.status === 'running',
    ).length;
  }

  /**
   * True if any registered task has not yet emitted its terminal
   * task-notification. Covers `running` (still executing) and
   * `cancelled`-but-not-finalized (cancel requested, but the natural
   * handler hasn't fired finalizeCancelled() yet). Headless callers
   * must keep their event loop alive while this returns true, so every
   * task_started is paired with a matching task_notification.
   */
  hasUnfinalizedTasks(): boolean {
    for (const entry of this.agents.values()) {
      // Foreground entries block the parent tool-call synchronously, so the
      // headless event loop is already pinned by the `await` on the caller's
      // promise — counting them here would be redundant and would also keep
      // the loop alive for entries that don't even emit a notification.
      if (!entry.isBackgrounded) continue;
      if (entry.status === 'running') return true;
      if (entry.status === 'cancelled' && !entry.notified) return true;
    }
    return false;
  }

  /**
   * Drops every in-memory entry without touching sidecar state.
   *
   * Used only when switching to a different session after the caller has
   * already established that no live work from the current session is still
   * running. Paused/interrupted entries remain recoverable from disk because
   * their sidecars keep the persisted status.
   */
  reset(): void {
    const firstEntry = this.agents.values().next().value as
      | AgentTask
      | undefined;
    if (!firstEntry) return;
    for (const entry of this.agents.values()) {
      // Defensive: callers (session switch via /resume, /clear) gate on
      // hasBlockingBackgroundWork() and so only reach reset() once every
      // entry is terminal — at which point parked approvals were already
      // rejected. Reject again here so a future caller that drops the guard
      // can't strand a parked respond() callback (a hung agent loop).
      this.rejectPendingApprovals(entry);
      this.wakeMessageWaiters(entry.agentId);
    }
    this.agents.clear();
    this.emitStatusChange(firstEntry);
  }

  /**
   * Enqueue a message for delivery to a running background agent.
   * The agent drains this queue between tool rounds.
   */
  queueMessage(agentId: string, message: string): boolean {
    return this.queueExternalInput(agentId, message);
  }

  /**
   * Enqueue generalized external input for an agent. Use queueMessage for the
   * parent send_message text path; this lower-level API also accepts
   * structured inputs such as owner-routed Monitor notifications.
   */
  queueExternalInput(agentId: string, input: AgentExternalInput): boolean {
    const entry = this.agents.get(agentId);
    if (!entry || entry.status !== 'running') return false;
    const queue = entry.pendingMessages!;
    queue.push(input);
    debugLogger.info(
      `Queued message for background agent ${agentId} (${queue.length} pending)`,
    );
    this.wakeMessageWaiters(agentId);
    return true;
  }

  /**
   * Drain all pending messages for an agent. Returns the messages
   * and clears the queue. Called by the agent's reasoning loop.
   */
  drainMessages(agentId: string): AgentExternalInput[] {
    const entry = this.agents.get(agentId);
    if (!entry || !entry.pendingMessages!.length) return [];
    const messages = entry.pendingMessages!.splice(0);
    debugLogger.info(
      `Drained ${messages.length} message(s) for background agent ${agentId}`,
    );
    return messages;
  }

  async waitForMessages(
    agentId: string,
    signal: AbortSignal,
  ): Promise<AgentExternalInput[]> {
    const immediate = this.drainMessages(agentId);
    if (immediate.length > 0) return immediate;

    const entry = this.agents.get(agentId);
    if (!entry || entry.status !== 'running' || signal.aborted) return [];

    return new Promise<AgentExternalInput[]>((resolve) => {
      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
        const waiters = this.messageWaiters.get(agentId);
        if (!waiters) return;
        waiters.delete(onWake);
        if (waiters.size === 0) {
          this.messageWaiters.delete(agentId);
        }
      };
      const resolveWithDrain = () => {
        cleanup();
        resolve(this.drainMessages(agentId));
      };
      const onWake = () => resolveWithDrain();
      const onAbort = () => {
        cleanup();
        resolve([]);
      };

      let waiters = this.messageWaiters.get(agentId);
      if (!waiters) {
        waiters = new Set<MessageWaiter>();
        this.messageWaiters.set(agentId, waiters);
      }
      waiters.add(onWake);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        cleanup();
        resolve([]);
        return;
      }
    });
  }

  wakeExternalInputWaiters(agentId: string): void {
    this.wakeMessageWaiters(agentId);
  }

  setNotificationCallback(
    cb: BackgroundNotificationCallback | undefined,
  ): void {
    this.notificationCallback = cb;
  }

  setRegisterCallback(cb: BackgroundRegisterCallback | undefined): void {
    this.registerCallback = cb;
  }

  setStatusChangeCallback(
    cb: BackgroundStatusChangeCallback | undefined,
  ): void {
    this.statusChangeCallback = cb;
  }

  setActivityChangeCallback(
    cb: BackgroundActivityChangeCallback | undefined,
  ): void {
    this.activityChangeCallback = cb;
  }

  setApprovalChangeCallback(
    cb: BackgroundApprovalChangeCallback | undefined,
  ): void {
    this.approvalChangeCallback = cb;
  }

  abortAll(options: BackgroundTaskCancelOptions = {}): void {
    const cancelOptions: BackgroundTaskCancelOptions = {
      persistedStatus: 'running',
      ...options,
    };
    for (const entry of Array.from(this.agents.values())) {
      if (entry.status === 'running') {
        this.cancel(entry.agentId, cancelOptions);
      }

      if (cancelOptions.notify === false) {
        entry.notified = true;
        continue;
      }

      // Shutdown path: no natural handler will run, so emit the cancelled
      // notification here to honour the one-notification-per-agent contract.
      this.finalizeCancellationIfPending(entry.agentId);
    }
    debugLogger.info('Aborted all background agents');
  }

  private buildDisplayLabel(entry: AgentTask): string {
    return buildBackgroundEntryLabel(entry);
  }

  private emitNotification(entry: AgentTask): void {
    // Mark notified *before* invoking the callback so that a re-entrant
    // terminal call inside the callback chain (cancel → complete race)
    // sees the flag and short-circuits, rather than firing twice.
    if (entry.notified) return;
    entry.notified = true;

    // Foreground entries return their result through the parent's normal
    // tool-result channel (the `returnDisplay` field on the synchronous
    // tool-call). Emitting the XML envelope on top would feed the parent
    // model the same payload twice.
    if (!entry.isBackgrounded) return;

    if (!this.notificationCallback) return;

    const statusText =
      entry.status === 'completed'
        ? 'completed'
        : entry.status === 'failed'
          ? 'failed'
          : 'was cancelled';

    const label = this.buildDisplayLabel(entry);
    const displayLine = `Background agent "${label}" ${statusText}.`;

    const xmlParts: string[] = [
      '<task-notification>',
      `<task-id>${escapeXml(entry.agentId)}</task-id>`,
    ];
    if (entry.toolUseId) {
      xmlParts.push(`<tool-use-id>${escapeXml(entry.toolUseId)}</tool-use-id>`);
    }
    xmlParts.push(
      `<status>${escapeXml(entry.status)}</status>`,
      `<summary>Agent "${escapeXml(entry.description)}" ${statusText}.</summary>`,
    );
    if (entry.result) {
      xmlParts.push(`<result>${escapeXml(entry.result)}</result>`);
    }
    if (entry.error) {
      xmlParts.push(`<result>Error: ${escapeXml(entry.error)}</result>`);
    }
    if (entry.outputFile) {
      xmlParts.push(
        `<output-file>${escapeXml(entry.outputFile)}</output-file>`,
      );
    }
    if (entry.stats) {
      xmlParts.push(
        '<usage>',
        `<total_tokens>${entry.stats.totalTokens}</total_tokens>`,
        `<tool_uses>${entry.stats.toolUses}</tool_uses>`,
        `<duration_ms>${entry.stats.durationMs}</duration_ms>`,
        '</usage>',
      );
    }
    xmlParts.push('</task-notification>');

    const meta: NotificationMeta = {
      agentId: entry.agentId,
      status: entry.status,
      stats: entry.stats,
      toolUseId: entry.toolUseId,
    };

    try {
      this.notificationCallback(displayLine, xmlParts.join('\n'), meta);
    } catch (error) {
      debugLogger.error('Failed to emit background notification:', error);
    }
  }

  private emitStatusChange(entry?: AgentTask): void {
    this.pruneTerminalEntries();
    if (!this.statusChangeCallback) return;
    try {
      this.statusChangeCallback(entry);
    } catch (error) {
      debugLogger.error('Failed to emit background status change:', error);
    }
  }

  /**
   * Evict the oldest fully-finalized terminal entries (those with
   * `notified === true`) once their count exceeds
   * `MAX_RETAINED_TERMINAL_AGENTS`. Sorted by `endTime` (then
   * `startTime` as a tiebreaker for entries that share an endTime).
   *
   * Running, paused, and cancelled-but-not-yet-notified entries are
   * excluded from the eviction set:
   *   - running / paused: the user explicitly cares about live work,
   *     and pruning a paused entry would silently drop a recoverable
   *     task without giving the user a chance to resume / abandon it.
   *   - cancelled but not notified: the natural handler (or grace
   *     timer) is still going to fire `finalizeCancelled` /
   *     `finalizeCancellationIfPending`. Evicting now would break the
   *     SDK contract that every `register` pairs with exactly one
   *     terminal `task-notification`.
   *
   * The caller (typically `emitStatusChange`) is responsible for
   * invoking this after every transition that mutates `notified` or
   * `endTime`. Cap-exceeded eviction is a best-effort: a transition
   * that sets `notified = true` outside the status-change path (the
   * `cancel({ notify: false })` shortcut and `abortAll`'s loop body)
   * may briefly carry a few extra entries until the next transition
   * triggers another prune. Both of those paths are reset / shutdown
   * adjacent — the registry is about to be cleared via `reset()`
   * anyway, so the extra retention does not leak across sessions.
   */
  private pruneTerminalEntries(): void {
    const evictable = Array.from(this.agents.values())
      .filter((entry) => entry.notified === true)
      .sort(
        (a, b) =>
          (a.endTime ?? a.startTime) - (b.endTime ?? b.startTime) ||
          a.startTime - b.startTime,
      );

    while (evictable.length > MAX_RETAINED_TERMINAL_AGENTS) {
      const oldest = evictable.shift();
      if (oldest) {
        this.agents.delete(oldest.agentId);
      }
    }
  }

  private wakeMessageWaiters(agentId: string): void {
    const waiters = this.messageWaiters.get(agentId);
    if (!waiters) return;
    this.messageWaiters.delete(agentId);
    for (const waiter of waiters) {
      waiter();
    }
  }

  private emitActivityChange(entry: AgentTask): void {
    if (!this.activityChangeCallback) return;
    try {
      this.activityChangeCallback(entry);
    } catch (error) {
      debugLogger.error('Failed to emit background activity change:', error);
    }
  }

  private emitApprovalChange(entry: AgentTask): void {
    if (!this.approvalChangeCallback) return;
    try {
      this.approvalChangeCallback(entry);
    } catch (error) {
      debugLogger.error('Failed to emit background approval change:', error);
    }
  }

  /**
   * Auto-reject and drop every parked approval for an entry. Called when
   * the entry reaches a terminal state so the agent's reasoning loop never
   * hangs on a prompt no one will answer, and the UI surface clears. Each
   * parked call is resolved with `Cancel` (denied). Safe to call on entries
   * with no parked approvals.
   */
  private rejectPendingApprovals(entry: AgentTask): void {
    const parked = entry.pendingApprovals;
    if (!parked?.length) return;
    entry.pendingApprovals = [];
    for (const approval of parked) {
      // `respond` is async — a `.catch()` on the promise is the only thing
      // that actually intercepts its rejection (a surrounding try/catch
      // would only see synchronous throws and let the rejection escape as
      // an unhandledRejection).
      void approval.respond(REJECTED_OUTCOME).catch((error) => {
        debugLogger.error(
          `Failed to auto-reject parked approval ${entry.agentId}/${approval.callId}:`,
          error,
        );
      });
    }
    this.emitApprovalChange(entry);
  }
}

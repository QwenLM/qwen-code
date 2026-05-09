/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Agent kind of `TaskState`. Tracks one running subagent
 * — either a synchronous foreground run (`isBackgrounded: false`,
 * awaited by the parent's tool-call) or an async background run
 * (`isBackgrounded: true`, persists across turns and emits a terminal
 * `<task-notification>`).
 *
 * Replaces the methods on `BackgroundTaskRegistry` with kind-local free
 * functions that operate on a passed `TaskRegistry`. Mirrors claw-code's
 * `LocalAgentTask` module shape: per-kind state owns its own type
 * declaration, lifecycle helpers, notification fan-out, and cancel
 * grace timer; the registry is kind-agnostic.
 */

import { createDebugLogger } from '../../utils/debugLogger.js';
import { escapeXml } from '../../utils/xml.js';
import { patchAgentMeta } from '../agent-transcript.js';
import type { AgentExternalInput } from '../runtime/agent-types.js';
import type { TaskBase, TaskRegistration, TaskStatus } from './types.js';
import type { TaskRegistry } from './registry.js';
import type { Task } from './dispatcher.js';

const debugLogger = createDebugLogger('AGENT_TASK');

const MAX_DESCRIPTION_LENGTH = 40;
const MAX_RECENT_ACTIVITIES = 5;

/**
 * Default cap on concurrently running background agents. Foreground
 * agents (`isBackgrounded: false`) don't count — they hold the parent
 * tool-call open and are bounded by the parent's own concurrency.
 *
 * Without a cap, repeated `run_in_background` launches consume API
 * quota and local resources with no backpressure.
 */
export const DEFAULT_MAX_CONCURRENT_BACKGROUND_AGENTS = 10;

/** Env var that overrides {@link DEFAULT_MAX_CONCURRENT_BACKGROUND_AGENTS}. */
export const BACKGROUND_AGENT_CONCURRENCY_ENV =
  'QWEN_CODE_MAX_BACKGROUND_AGENTS';

/**
 * Resolve the background-agent concurrency cap from the supplied env
 * object (defaults to `process.env`). Invalid values fall back to the
 * default and emit a debug warning.
 */
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

/**
 * Module-level resolved cap, captured at load time from `process.env`.
 * Tests override via {@link setAgentBackgroundCapForTest}; production
 * callers should not mutate it.
 */
export let MAX_CONCURRENT_BACKGROUND_AGENTS =
  resolveMaxConcurrentBackgroundAgents();

/**
 * Test-only: override the cap at runtime. Mirrors the existing
 * `setAgentNotificationCallback` pattern for module-level state.
 * Pass `undefined` to restore the env-derived default.
 */
export function setAgentBackgroundCapForTest(cap: number | undefined): void {
  MAX_CONCURRENT_BACKGROUND_AGENTS =
    cap === undefined || !Number.isInteger(cap) || cap < 1
      ? resolveMaxConcurrentBackgroundAgents()
      : cap;
}

/**
 * Cap on how many fully-finalized terminal entries (those that have
 * already emitted their terminal `task-notification`) the registry
 * retains. Without this cap, every short-lived background subagent
 * leaves a row in the Background tasks dialog and pill forever,
 * crowding out the running entries the user actually opened the
 * dialog to find. Mirrors the rationale + retention pattern in
 * `MAX_RETAINED_TERMINAL_MONITORS`.
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
 * Single source of truth for the human-facing label of an agent entry.
 * Shared by the notification payload (model-facing) and the TUI dialog
 * (user-facing) so the two surfaces never drift.
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
      ? raw.slice(0, MAX_DESCRIPTION_LENGTH - 1) + '…'
      : raw;
  return includePrefix && entry.subagentType
    ? `${entry.subagentType}: ${truncated}`
    : truncated;
}

export type BackgroundTaskStatus = TaskStatus;

export interface AgentCompletionStats {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
}

/**
 * A compact record of a recent tool invocation — drives the Progress
 * section of the detail dialog. The Agent tool maintains a rolling
 * buffer of these on each agent entry by subscribing to the subagent's
 * event emitter.
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
  status: BackgroundTaskStatus;
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
   * callers may register without providing it, and `agentAppendActivity`
   * initializes the array lazily.
   */
  recentActivities?: readonly BackgroundActivity[];
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
  persistedCancellationStatus?: Extract<
    BackgroundTaskStatus,
    'running' | 'cancelled'
  >;
}

/**
 * @deprecated Renamed to `AgentTask`. Kept as a one-release type alias for
 * external SDK consumers; will be removed in the release after PR 2 lands.
 */
export type BackgroundTaskEntry = AgentTask;

/**
 * Shape callers pass to {@link agentRegister}; the helper derives the
 * shared `TaskBase` envelope (`id`, `kind`, `outputOffset`, `notified`)
 * from these and the surrounding context. `outputFile` is required here
 * because every agent run reserves a JSONL transcript path at
 * registration.
 */
export type AgentTaskRegistration = TaskRegistration<AgentTask>;

export interface NotificationMeta {
  agentId: string;
  status: BackgroundTaskStatus;
  stats?: AgentCompletionStats;
  toolUseId?: string;
}

export type BackgroundNotificationCallback = (
  displayText: string,
  modelText: string,
  meta: NotificationMeta,
) => void;

export type BackgroundRegisterCallback = (entry: AgentTask) => void;

export interface AgentCancelOptions {
  notify?: boolean;
  persistedStatus?: Extract<BackgroundTaskStatus, 'running' | 'cancelled'>;
}

/**
 * Module-level singletons replacing the per-instance callback fields on
 * `BackgroundTaskRegistry`. The registry's polymorphic `subscribe` covers
 * UI re-renders; the two callbacks below carry the agent kind's
 * SDK-specific event signals — terminal `<task-notification>` payload
 * (model-facing) and `task_started` register fan-out (SDK consumers).
 *
 * Single subscriber on purpose: the headless and interactive entry
 * points each install exactly one of these per session, and a list
 * would invite drift in error-handling.
 */
let notificationCallback: BackgroundNotificationCallback | undefined;
let registerCallback: BackgroundRegisterCallback | undefined;

type MessageWaiter = () => void;

/**
 * Module-level waiter registry replacing the per-instance
 * `messageWaiters` field of the old `BackgroundTaskRegistry`. Keyed by
 * agentId; `agentWaitForMessages` parks a resolver here and
 * `wakeMessageWaiters` (fired by enqueue / reset) drains it. Module
 * scope is consistent with the notification/register callback
 * singletons above — one `TaskRegistry` per session.
 */
const messageWaiters = new Map<string, Set<MessageWaiter>>();

function wakeMessageWaiters(agentId: string): void {
  const waiters = messageWaiters.get(agentId);
  if (!waiters) return;
  messageWaiters.delete(agentId);
  for (const waiter of waiters) {
    waiter();
  }
}

export function setAgentNotificationCallback(
  cb: BackgroundNotificationCallback | undefined,
): void {
  notificationCallback = cb;
}

export function setAgentRegisterCallback(
  cb: BackgroundRegisterCallback | undefined,
): void {
  registerCallback = cb;
}

/**
 * Read an agent entry from the registry with the kind narrowed.
 * Returns `undefined` for missing ids and for ids that resolve to a
 * non-agent kind (defensive — callers shouldn't be passing non-agent
 * ids here, but the unified store admits the lookup).
 */
export function getAgentTask(
  registry: TaskRegistry,
  agentId: string,
): AgentTask | undefined {
  const entry = registry.get(agentId);
  if (!entry || entry.kind !== 'agent') return undefined;
  return entry;
}

/**
 * Snapshot of every agent task. Convenience over `registry.getByKind('agent')`
 * for call sites that already destructure agent-specific fields.
 */
export function getAllAgentTasks(registry: TaskRegistry): AgentTask[] {
  return registry.getByKind('agent');
}

/**
 * Count of background agents currently in `running` state. Foreground
 * entries are excluded — see {@link MAX_CONCURRENT_BACKGROUND_AGENTS}
 * for the reason. Terminal-but-not-yet-evicted entries (cancelled,
 * completed, failed) are also excluded; they no longer hold any
 * resources the cap is intended to bound.
 */
function getRunningBackgroundCount(registry: TaskRegistry): number {
  let count = 0;
  for (const entry of registry.getByKind('agent')) {
    if (entry.isBackgrounded && entry.status === 'running') count++;
  }
  return count;
}

/**
 * Throws if launching another background agent would exceed
 * {@link MAX_CONCURRENT_BACKGROUND_AGENTS}. Called twice on the launch
 * path — once as a preflight before expensive worktree/hook setup, and
 * again inside {@link agentRegister} as the authoritative race guard
 * (two parallel preflights can both pass before either registers).
 */
export function agentAssertCanStartBackground(registry: TaskRegistry): void {
  const running = getRunningBackgroundCount(registry);
  if (running >= MAX_CONCURRENT_BACKGROUND_AGENTS) {
    debugLogger.warn(
      `Background agent concurrency cap reached: ` +
        `${running}/${MAX_CONCURRENT_BACKGROUND_AGENTS}. ` +
        `Refusing new background agent.`,
    );
    throw new Error(
      `Cannot start background agent: maximum concurrent background agents ` +
        `(${MAX_CONCURRENT_BACKGROUND_AGENTS}) reached. Stop an existing ` +
        `agent first.`,
    );
  }
}

/**
 * Insert a new agent task into the registry. Mutates `registration` in
 * place to graduate it to a full `AgentTask` (populating the `TaskBase`
 * envelope and the agent-specific message queue) and then hands the
 * reference to `registry.register`. Returning the same reference keeps
 * the existing callers' post-register mutations observable through
 * `registry.get(id)` without a re-fetch.
 *
 * Foreground entries are paired with a synchronous tool-call result on
 * the parent's response and never emit a terminal `task_notification`;
 * letting them fire the SDK register callback would emit a
 * `task_started` event without a matching completion event, breaking
 * the lifecycle contract for SDK consumers.
 *
 * Throws (without mutating the registry) when registering a fresh
 * background agent would exceed {@link MAX_CONCURRENT_BACKGROUND_AGENTS}.
 * Resume of an already-running entry skips the cap check — a paused-then-
 * resumed entry was already counted when it first started, and re-applying
 * the cap on resume would deadlock recovery whenever the user already has
 * `cap` other agents running.
 */
export function agentRegister(
  registry: TaskRegistry,
  registration: AgentTaskRegistration,
): AgentTask {
  if (registration.isBackgrounded && registration.status === 'running') {
    const existing = registry.get(registration.agentId) as
      | AgentTask
      | undefined;
    const isReplacingRunning =
      existing?.kind === 'agent' &&
      existing.isBackgrounded === true &&
      existing.status === 'running';
    if (!isReplacingRunning) {
      agentAssertCanStartBackground(registry);
    }
  }

  const entry = registration as AgentTask;
  entry.id = registration.agentId;
  entry.kind = 'agent';
  entry.outputOffset = 0;
  entry.notified = false;
  entry.pendingMessages = registration.pendingMessages ?? [];
  registry.register(entry);
  debugLogger.info(`Registered background agent: ${entry.agentId}`);

  if (entry.isBackgrounded && registerCallback) {
    try {
      registerCallback(entry);
    } catch (error) {
      debugLogger.error('Failed to emit register callback:', error);
    }
  }
  pruneTerminalEntries(registry);
  return entry;
}

/**
 * Transition a still-running entry to 'completed' and emit the terminal
 * notification. No-op if the entry is already terminal *and* has been
 * notified — protects against duplicate emission when cancel aborts the
 * signal and the natural handler also races to completion.
 *
 * Allows running → completed (normal path) and cancelled → completed
 * (cancel raced the natural handler: the reasoning loop finished with
 * a real result before the abort landed, and we prefer to surface that
 * real result over the bare cancel).
 */
export function agentComplete(
  registry: TaskRegistry,
  agentId: string,
  result: string,
  stats?: AgentCompletionStats,
): void {
  const entry = registry.get(agentId) as AgentTask | undefined;
  if (!entry || entry.kind !== 'agent') return;
  if (entry.status !== 'running' && entry.status !== 'cancelled') return;
  if (entry.notified) return;

  registry.update<AgentTask>(agentId, (current) => {
    current.status = 'completed';
    current.endTime = Date.now();
    current.result = result;
    current.stats = stats;
    return current;
  });
  debugLogger.info(`Background agent completed: ${agentId}`);

  emitNotification(registry, agentId);
}

/**
 * Remove a foreground entry from the registry without emitting any
 * terminal notification. Called by the foreground tool-call's `finally`
 * path, which has already delivered the result through the tool-result
 * channel — the registry entry has served its UI-surfacing purpose.
 * Background entries must go through complete/fail/finalizeCancelled
 * instead, so this throws if asked to remove one.
 */
export function agentUnregisterForeground(
  registry: TaskRegistry,
  agentId: string,
): void {
  const entry = registry.get(agentId) as AgentTask | undefined;
  if (!entry || entry.kind !== 'agent') return;
  if (entry.isBackgrounded) {
    throw new Error(
      `agentUnregisterForeground called on non-foreground entry ${agentId} ` +
        `(isBackgrounded=true). ` +
        `Background entries must terminate via complete/fail/finalizeCancelled.`,
    );
  }
  registry.evict(agentId);
  debugLogger.info(`Unregistered foreground agent: ${agentId}`);
}

/** See {@link agentComplete} for the cancelled → terminal path rationale. */
export function agentFail(
  registry: TaskRegistry,
  agentId: string,
  error: string,
  stats?: AgentCompletionStats,
): void {
  const entry = registry.get(agentId) as AgentTask | undefined;
  if (!entry || entry.kind !== 'agent') return;
  if (entry.status !== 'running' && entry.status !== 'cancelled') return;
  if (entry.notified) return;

  registry.update<AgentTask>(agentId, (current) => {
    current.status = 'failed';
    current.endTime = Date.now();
    current.error = error;
    current.stats = stats;
    return current;
  });
  debugLogger.info(`Background agent failed: ${agentId}`);

  emitNotification(registry, agentId);
}

/**
 * Cancellation aborts the signal and marks the entry as cancelled, but
 * does *not* emit the terminal notification immediately. The natural
 * completion path (bgBody) fires complete()/fail()/finalizeCancelled()
 * with the real partial/final result, which carries far more information
 * than a bare "cancelled" message. A deferred fallback handles the rare
 * case where a tool ignores AbortSignal and bgBody never settles — the
 * timeout lands on `agentFinalizeCancellationIfPending`, which is a
 * no-op once the natural handler has already emitted.
 */
export function agentCancel(
  registry: TaskRegistry,
  agentId: string,
  options: AgentCancelOptions = {},
): void {
  const entry = registry.get(agentId) as AgentTask | undefined;
  if (!entry || entry.kind !== 'agent' || entry.status !== 'running') return;
  const persistedStatus = options.persistedStatus ?? 'cancelled';

  entry.abortController.abort();
  registry.update<AgentTask>(agentId, (current) => {
    current.status = 'cancelled';
    current.endTime = Date.now();
    current.persistedCancellationStatus = persistedStatus;
    return current;
  });
  if (entry.metaPath) {
    patchAgentMeta(entry.metaPath, {
      status: persistedStatus,
      lastUpdatedAt: new Date().toISOString(),
      lastError: undefined,
    });
  }
  debugLogger.info(`Background agent cancelled: ${agentId}`);

  // Foreground entries don't emit XML notifications and unregister
  // themselves in the tool-call's finally path, so the grace timer
  // would only ever no-op for them.
  if (!entry.isBackgrounded) return;

  if (options.notify === false) {
    // Session reset paths intentionally suppress the old task's terminal
    // notification so it cannot leak into a new conversation.
    registry.update<AgentTask>(agentId, (current) => {
      current.notified = true;
      return current;
    });
    return;
  }

  const timer = setTimeout(() => {
    agentFinalizeCancellationIfPending(registry, agentId);
  }, CANCEL_GRACE_MS);
  timer.unref?.();
}

/**
 * Marks a paused interrupted task as intentionally discarded/cancelled
 * without emitting a task-notification. Used when the user explicitly
 * abandons a recovered task instead of resuming it.
 */
export function agentAbandon(registry: TaskRegistry, agentId: string): void {
  const entry = registry.get(agentId) as AgentTask | undefined;
  if (!entry || entry.kind !== 'agent' || entry.status !== 'paused') return;

  registry.update<AgentTask>(agentId, (current) => {
    current.status = 'cancelled';
    current.endTime = Date.now();
    current.notified = true;
    return current;
  });
  debugLogger.info(`Abandoned paused background agent: ${agentId}`);
}

/**
 * Emit the terminal cancelled notification once the agent's natural
 * handler has confirmed that the reasoning loop ended because of the
 * abort (terminateMode === CANCELLED). Attaches the partial result and
 * stats so the parent model still sees whatever work the agent had
 * captured before the abort landed, instead of a bare "cancelled" line.
 */
export function agentFinalizeCancelled(
  registry: TaskRegistry,
  agentId: string,
  partialResult: string,
  stats?: AgentCompletionStats,
): void {
  const entry = registry.get(agentId) as AgentTask | undefined;
  if (!entry || entry.kind !== 'agent') return;
  if (entry.status !== 'running' && entry.status !== 'cancelled') return;
  if (entry.notified) return;

  registry.update<AgentTask>(agentId, (current) => {
    current.status = 'cancelled';
    current.endTime ??= Date.now();
    if (partialResult) current.result = partialResult;
    current.stats = stats;
    return current;
  });
  emitNotification(registry, agentId);
}

/**
 * Emit the terminal cancelled notification for entries that were
 * cancelled but for which no natural handler delivered a follow-up
 * complete/fail/finalizeCancelled. Used by shutdown paths
 * ({@link agentAbortAll}) and the cancel grace timer to guarantee the
 * SDK contract (every registered agent produces exactly one
 * task-notification).
 */
export function agentFinalizeCancellationIfPending(
  registry: TaskRegistry,
  agentId: string,
): void {
  const entry = registry.get(agentId) as AgentTask | undefined;
  if (!entry || entry.kind !== 'agent') return;
  if (entry.status !== 'cancelled' || entry.notified) return;
  emitNotification(registry, agentId);
}

/**
 * Append a recent tool activity to a running entry's rolling buffer.
 * No-op if the entry is not running — late events after a cancellation
 * shouldn't leak into the Progress section.
 */
export function agentAppendActivity(
  registry: TaskRegistry,
  agentId: string,
  activity: BackgroundActivity,
): void {
  const entry = registry.get(agentId) as AgentTask | undefined;
  if (!entry || entry.kind !== 'agent' || entry.status !== 'running') return;

  registry.update<AgentTask>(agentId, (current) => {
    const prior = current.recentActivities ?? [];
    const next = [...prior, activity];
    if (next.length > MAX_RECENT_ACTIVITIES) {
      next.splice(0, next.length - MAX_RECENT_ACTIVITIES);
    }
    current.recentActivities = next;
    return current;
  });
}

/**
 * Enqueue a message for delivery to a running background agent. The
 * agent drains this queue between tool rounds.
 */
export function agentQueueMessage(
  registry: TaskRegistry,
  agentId: string,
  message: string,
): boolean {
  return agentQueueExternalInput(registry, agentId, message);
}

/**
 * Enqueue generalized external input for an agent. Use
 * {@link agentQueueMessage} for the parent send_message text path; this
 * lower-level API also accepts structured inputs such as owner-routed
 * Monitor notifications. Wakes any parked {@link agentWaitForMessages}
 * waiter so a blocked reasoning loop picks the input up immediately.
 */
export function agentQueueExternalInput(
  registry: TaskRegistry,
  agentId: string,
  input: AgentExternalInput,
): boolean {
  const entry = registry.get(agentId) as AgentTask | undefined;
  if (!entry || entry.kind !== 'agent' || entry.status !== 'running')
    return false;
  const queue = entry.pendingMessages!;
  queue.push(input);
  debugLogger.info(
    `Queued message for background agent ${agentId} (${queue.length} pending)`,
  );
  wakeMessageWaiters(agentId);
  return true;
}

/**
 * Drain all pending messages for an agent. Returns the messages and
 * clears the queue. Called by the agent's reasoning loop.
 */
export function agentDrainMessages(
  registry: TaskRegistry,
  agentId: string,
): AgentExternalInput[] {
  const entry = registry.get(agentId) as AgentTask | undefined;
  if (!entry || entry.kind !== 'agent' || !entry.pendingMessages!.length)
    return [];
  const messages = entry.pendingMessages!.splice(0);
  debugLogger.info(
    `Drained ${messages.length} message(s) for background agent ${agentId}`,
  );
  return messages;
}

/**
 * Resolve as soon as the agent has queued external input, or with an
 * empty array if the wait is aborted or the agent is no longer running.
 * Drains immediately when input is already pending; otherwise parks a
 * waiter that `agentQueueExternalInput` / `wakeMessageWaiters` releases.
 */
export function agentWaitForMessages(
  registry: TaskRegistry,
  agentId: string,
  signal: AbortSignal,
): Promise<AgentExternalInput[]> {
  const immediate = agentDrainMessages(registry, agentId);
  if (immediate.length > 0) return Promise.resolve(immediate);

  const entry = registry.get(agentId) as AgentTask | undefined;
  if (
    !entry ||
    entry.kind !== 'agent' ||
    entry.status !== 'running' ||
    signal.aborted
  ) {
    return Promise.resolve([]);
  }

  return new Promise<AgentExternalInput[]>((resolve) => {
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      const waiters = messageWaiters.get(agentId);
      if (!waiters) return;
      waiters.delete(onWake);
      if (waiters.size === 0) {
        messageWaiters.delete(agentId);
      }
    };
    const resolveWithDrain = () => {
      cleanup();
      resolve(agentDrainMessages(registry, agentId));
    };
    const onWake = () => resolveWithDrain();
    const onAbort = () => {
      cleanup();
      resolve([]);
    };

    let waiters = messageWaiters.get(agentId);
    if (!waiters) {
      waiters = new Set<MessageWaiter>();
      messageWaiters.set(agentId, waiters);
    }
    waiters.add(onWake);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      cleanup();
      resolve([]);
    }
  });
}

/**
 * Force-wake any parked {@link agentWaitForMessages} waiter for an
 * agent without enqueuing input. Used by shutdown / reset paths so a
 * blocked reasoning loop doesn't hang.
 */
export function agentWakeExternalInputWaiters(
  _registry: TaskRegistry,
  agentId: string,
): void {
  wakeMessageWaiters(agentId);
}

/**
 * True if any registered agent task has not yet emitted its terminal
 * task-notification. Covers `running` (still executing) and
 * `cancelled`-but-not-finalized (cancel requested, but the natural
 * handler hasn't fired finalizeCancelled() yet). Headless callers must
 * keep their event loop alive while this returns true, so every
 * task_started is paired with a matching task_notification.
 *
 * Foreground entries block the parent tool-call synchronously, so the
 * headless event loop is already pinned by the `await` on the caller's
 * promise — counting them here would be redundant and would also keep
 * the loop alive for entries that don't even emit a notification.
 */
export function agentHasUnfinalizedTasks(registry: TaskRegistry): boolean {
  for (const entry of registry.getByKind('agent')) {
    if (!entry.isBackgrounded) continue;
    if (entry.status === 'running') return true;
    if (entry.status === 'cancelled' && !entry.notified) return true;
  }
  return false;
}

/**
 * Drops every in-memory agent entry without touching sidecar state.
 *
 * Used only when switching to a different session after the caller has
 * already established that no live work from the current session is
 * still running. Paused/interrupted entries remain recoverable from disk
 * because their sidecars keep the persisted status.
 */
export function agentReset(registry: TaskRegistry): void {
  let removed = 0;
  for (const entry of registry.getByKind('agent')) {
    wakeMessageWaiters(entry.agentId);
    registry.evict(entry.agentId);
    removed++;
  }
  if (removed > 0) {
    debugLogger.info(`Reset ${removed} agent entries`);
  }
}

/**
 * Cancel every still-running agent and ensure every registered agent
 * produces exactly one task-notification.
 *
 * On shutdown paths the natural settle handlers won't run, so emit the
 * cancelled notification here for any entry that's already been
 * cancelled but hasn't notified yet.
 */
export function agentAbortAll(
  registry: TaskRegistry,
  options: AgentCancelOptions = {},
): void {
  const cancelOptions: AgentCancelOptions = {
    persistedStatus: 'running',
    ...options,
  };
  for (const entry of registry.getByKind('agent')) {
    if (entry.status === 'running') {
      agentCancel(registry, entry.agentId, cancelOptions);
    }

    if (cancelOptions.notify === false) {
      registry.update<AgentTask>(entry.agentId, (current) => {
        current.notified = true;
        return current;
      });
      continue;
    }

    agentFinalizeCancellationIfPending(registry, entry.agentId);
  }
  debugLogger.info('Aborted all background agents');
}

function emitNotification(registry: TaskRegistry, agentId: string): void {
  const entry = registry.get(agentId) as AgentTask | undefined;
  if (!entry || entry.kind !== 'agent') return;

  // Mark notified *before* invoking the callback so that a re-entrant
  // terminal call inside the callback chain (cancel → complete race)
  // sees the flag and short-circuits, rather than firing twice.
  if (entry.notified) return;
  registry.update<AgentTask>(agentId, (current) => {
    current.notified = true;
    return current;
  });

  // The entry just became evictable (notified === true); enforce the
  // retain cap here so a burst of short-lived background subagents
  // can't crowd the pill/dialog. Mirrors the old registry pruning from
  // `emitStatusChange` on every notified transition.
  pruneTerminalEntries(registry);

  // Foreground entries return their result through the parent's normal
  // tool-result channel (the `returnDisplay` field on the synchronous
  // tool-call). Emitting the XML envelope on top would feed the parent
  // model the same payload twice.
  if (!entry.isBackgrounded) return;

  if (!notificationCallback) return;

  const statusText =
    entry.status === 'completed'
      ? 'completed'
      : entry.status === 'failed'
        ? 'failed'
        : 'was cancelled';

  const label = buildBackgroundEntryLabel(entry);
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
    xmlParts.push(`<output-file>${escapeXml(entry.outputFile)}</output-file>`);
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
    notificationCallback(displayLine, xmlParts.join('\n'), meta);
  } catch (error) {
    debugLogger.error('Failed to emit background notification:', error);
  }
}

/**
 * Evict the oldest fully-finalized terminal entries (those with
 * `notified === true`) once their count exceeds
 * `MAX_RETAINED_TERMINAL_AGENTS`. Sorted by `endTime` (then `startTime`
 * as a tiebreaker for entries that share an endTime).
 *
 * Running, paused, and cancelled-but-not-yet-notified entries are
 * excluded from the eviction set: the user explicitly cares about live
 * work, and evicting a not-yet-notified cancelled entry would break the
 * SDK contract that every `register` pairs with exactly one terminal
 * `task-notification`.
 */
function pruneTerminalEntries(registry: TaskRegistry): void {
  const evictable = registry
    .getByKind('agent')
    .filter((entry) => entry.notified === true)
    .sort(
      (a, b) =>
        (a.endTime ?? a.startTime) - (b.endTime ?? b.startTime) ||
        a.startTime - b.startTime,
    );

  while (evictable.length > MAX_RETAINED_TERMINAL_AGENTS) {
    const oldest = evictable.shift();
    if (oldest) {
      registry.evict(oldest.agentId);
    }
  }
}

/**
 * `Task` implementation registered with the dispatcher. The polymorphic
 * `kill` is the only method the dispatcher cares about; lifecycle
 * helpers above are called directly by the agent runner / resume
 * service / send-message tool / task-stop tool.
 */
export const AgentTaskKind: Task = {
  kind: 'agent',
  name: 'Background subagent',
  kill: (id, ctx) => {
    agentCancel(ctx.registry, id);
  },
};

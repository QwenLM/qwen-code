/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Scheduled-tasks CRUD over the durable cron file (`scheduled_tasks.json`).
 *
 * This is the daemon-side surface behind the Web Shell "Scheduled tasks"
 * page. It only reads/writes the per-project durable-task file via core's
 * `cronTasksFile` helpers (atomic writes, cross-process lock) — it does NOT
 * run a scheduler of its own. Tasks created here fire the same way
 * cron_create's durable tasks do: an agent session with durable cron enabled
 * loads them from disk (watched, 300 ms debounce) and fires them at their
 * cron time. Disabling a task (`enabled: false`) keeps it on disk but makes
 * the scheduler skip it.
 *
 * Writes use the non-strict `mutate()` gate — creating a scheduled prompt is
 * the same capability class as `POST /session/:id/prompt` (both enqueue a
 * prompt that runs with tool access), and that route is non-strict too, so a
 * loopback web-shell without a token can manage its own schedule.
 *
 * The same CRUD handlers are mounted twice: once unqualified (`/scheduled-tasks`,
 * bound to the primary workspace) and once workspace-qualified
 * (`/workspaces/:workspace/scheduled-tasks`, resolving the cron file + session
 * bridge of any registered workspace). Both share {@link
 * registerScheduledTaskCrudRoutes}; they differ only in how the target
 * workspace and its bridge are resolved per request, so a multi-workspace Web
 * Shell manages each project's schedule against that project's own file.
 */

import type { Application, Request, RequestHandler, Response } from 'express';
import { isDeepStrictEqual } from 'node:util';
import {
  readCronTasks,
  updateCronTasks,
  generateCronTaskId,
  appendCronRun,
  annotateCronRunSession,
  taskHasLegacyCondition,
  parseCron,
  nextFireTime,
  nextDurableFireMs,
  SessionService,
  Storage,
  stripTerminalControlSequences,
  MAX_JOBS,
  type CronRunSessionOutcome,
  type CronTaskDelivery,
  type DurableCronTask,
  type CronTaskRun,
} from '@qwen-code/qwen-code-core';
import { SessionNotFoundError } from '@qwen-code/acp-bridge/bridgeErrors';
import { parseCallerSuppliedSessionId } from '../../config/session-id.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { isChannelDeliveryError } from '../../runtime/channel-delivery-ipc.js';
import {
  parseChannelDelivery,
  type PublicChannelDelivery,
} from '../../runtime/channel-delivery.js';
import type { ChannelDeliveryAuthorizationStore } from '../channel-delivery-authorization.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeWithLiveCompatibilityFromParam,
  sendConversationRuntimeUnavailable,
  sendGenerationClosedError,
} from '../workspace-route-runtime.js';
import type { ConversationRuntimeActivityGate } from '../conversations/conversation-runtime-activity.js';
import {
  buildScheduledTaskRunPrompt,
  scheduledTaskRunSessionName,
  scheduledTaskRunSourceId,
  SCHEDULED_TASK_RUN_SOURCE_TYPE,
} from '../../runtime/scheduled-task-run.js';
import { createSessionOrganizationService } from '../session-organization-helpers.js';

// The per-file create cap, shared with the scheduler's MAX_JOBS. The scheduler
// caps DURABLE loads against a durable-only budget of MAX_JOBS (independent of
// session-only jobs), so a task accepted here is always loadable — no silent
// "created but never fires". Rejecting past the cap returns a clean 409.
const MAX_SCHEDULED_TASKS = MAX_JOBS;
const MAX_PROMPT_LENGTH = 100_000;
const MAX_NAME_LENGTH = 200;
const MAX_CRON_LENGTH = 200;
const MAX_ROUTING_ID_LENGTH = 128;

/**
 * The slice of the session bridge this route needs. Narrowed to a structural
 * type so tests can stub it without the full bridge.
 */
export interface ScheduledTasksSessionBridge {
  spawnOrAttach(req: {
    workspaceCwd: string;
    modelServiceId?: string;
    sessionScope?: 'single' | 'thread';
    parentSessionId?: string;
    sourceType?: string;
    sourceId?: string;
  }): Promise<{ sessionId: string }>;
  sendPrompt?(
    sessionId: string,
    req: {
      sessionId: string;
      prompt: Array<{ type: 'text'; text: string }>;
    },
    signal?: AbortSignal,
    context?: { onPromptAdmitted?: () => void },
  ): Promise<unknown>;
  closeSession(sessionId: string): Promise<unknown>;
  /** Persist a restorable transcript anchor for an eligible default session. */
  ensureDefaultSessionPersisted?(sessionId: string): Promise<void>;
  /** Advance the in-memory session-catalog revision after a successful
   * persisted removal driven by task cleanup. Optional so existing
   * structural test fakes stay source-compatible; the production bridge
   * always provides it. */
  markSessionCatalogChanged?(): void;
  /** Give the task's session a readable name so it's recognizable in the
   * session list (rather than a bare id). Best-effort. */
  updateSessionMetadata(
    sessionId: string,
    metadata: {
      displayName?: string;
      titleSource?: 'manual' | 'auto';
    },
  ): unknown;
  getSessionSummary(sessionId: string): {
    workspaceCwd: string;
    hasActivePrompt: boolean;
    pendingInteractionCount?: number;
    parentSessionId?: string;
    sourceType?: string;
    sourceId?: string;
  };
}

// Cap for the derived session display name — a session label, not the full
// prompt (which can be up to MAX_PROMPT_LENGTH).
const MAX_SESSION_NAME_LENGTH = 60;

/** Builds a readable session name for a task — or one of its per-run child
 * sessions — from its name (or prompt). Strips terminal control sequences (C0/C1/DEL/ANSI) — the bridge's title guard REJECTS
 * them, so an unsanitized control char would silently drop the whole rename and
 * leave a bare-id session — plus Unicode Bidi_Control marks (ALM/LRM/RLM,
 * embedding/override, isolates) as a Trojan-Source-style reordering defense for
 * the session list — and truncates on a code-point boundary so slicing can't
 * leave a lone surrogate rendered as `�`. */
export function scheduledTaskSessionName(label: string): string {
  const cleaned = stripTerminalControlSequences(label)
    // Unicode Bidi_Control marks: ALM (U+061C), LRM/RLM (U+200E/200F), the
    // embedding/override set (U+202A..U+202E), and the isolates (U+2066..U+2069).
    // stripTerminalControlSequences does not cover these; they can visually
    // reorder or invisibly mislead the session name.
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
  let short = cleaned;
  if (cleaned.length > MAX_SESSION_NAME_LENGTH) {
    let cut = MAX_SESSION_NAME_LENGTH - 1;
    // Don't slice between a surrogate pair — back off one unit if the boundary
    // lands right after a high surrogate.
    const boundary = cleaned.charCodeAt(cut - 1);
    if (boundary >= 0xd800 && boundary <= 0xdbff) cut -= 1;
    short = `${cleaned.slice(0, cut)}…`;
  }
  return short;
}

/**
 * The workspace a scheduled-task request operates on: the cron file lives under
 * `workspaceCwd`, and `bridge` mints/tears down the task's bound session. A
 * missing bridge means tasks are created unbound (shared per-project
 * durable-owner firing) — the same fallback a bridge-less embedding gets.
 */
export interface ScheduledTaskTarget {
  workspaceCwd: string;
  runtimeBaseDir?: string;
  bridge?: ScheduledTasksSessionBridge;
  cleanupSession?: (sessionId: string) => Promise<unknown>;
  assertGenerationOpen?: () => void;
  activity?: ConversationRuntimeActivityGate;
  resolveLiveSessionOwner?: WorkspaceRegistry['resolveLiveSessionOwner'];
}

export interface ExistingSessionScheduledTaskCreateInput {
  sessionId: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  enabled?: boolean;
  sessionMode?: 'persistent' | 'per_run';
  modelServiceId?: string;
  groupId?: string;
  name?: string;
  delivery?: CronTaskDelivery;
}

export class ExistingSessionScheduledTaskCreateError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ExistingSessionScheduledTaskCreateError';
  }
}

function assertReusableScheduledTaskSession(
  target: ScheduledTaskTarget,
  sessionId: string,
  allowActivePrompt: boolean,
  assertCallerPromptActive?: () => void,
): void {
  const { bridge, workspaceCwd } = target;
  if (!bridge) {
    throw new ExistingSessionScheduledTaskCreateError(
      409,
      'session_binding_unavailable',
      'Session management is not available for this workspace',
    );
  }
  assertCallerPromptActive?.();
  let owner:
    | ReturnType<NonNullable<ScheduledTaskTarget['resolveLiveSessionOwner']>>
    | undefined;
  try {
    owner = target.resolveLiveSessionOwner?.(sessionId);
  } catch (error) {
    writeStderrLine(
      `qwen serve: failed to resolve scheduled-task session owner '${sessionId}': ${error instanceof Error ? error.message : String(error)}`,
    );
    throw new ExistingSessionScheduledTaskCreateError(
      500,
      'scheduled_tasks_session_failed',
      'Failed to look up the requested session',
    );
  }
  if (owner?.kind === 'unavailable') {
    throw new ExistingSessionScheduledTaskCreateError(
      503,
      'workspace_runtime_unavailable',
      'The workspace runtime is unavailable',
    );
  }
  if (owner?.kind === 'ambiguous') {
    throw new ExistingSessionScheduledTaskCreateError(
      500,
      'ambiguous_session_owner',
      `Session owner is ambiguous for "${sessionId}"`,
    );
  }
  if (owner?.kind === 'found' && owner.runtime.workspaceCwd !== workspaceCwd) {
    throw new ExistingSessionScheduledTaskCreateError(
      400,
      'session_workspace_mismatch',
      "The requested session belongs to a different workspace; use that workspace's scheduled-task endpoint",
    );
  }

  let summary: ReturnType<ScheduledTasksSessionBridge['getSessionSummary']>;
  try {
    summary = bridge.getSessionSummary(sessionId);
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      throw new ExistingSessionScheduledTaskCreateError(
        404,
        'session_not_found',
        `Session '${sessionId}' was not found`,
      );
    }
    writeStderrLine(
      `qwen serve: failed to look up scheduled-task session '${sessionId}': ${error instanceof Error ? error.message : String(error)}`,
    );
    throw new ExistingSessionScheduledTaskCreateError(
      500,
      'scheduled_tasks_session_failed',
      'Failed to look up the requested session',
    );
  }
  if (summary.workspaceCwd !== workspaceCwd) {
    throw new ExistingSessionScheduledTaskCreateError(
      400,
      'session_workspace_mismatch',
      "The requested session belongs to a different workspace; use that workspace's scheduled-task endpoint",
    );
  }
  if (
    (!allowActivePrompt && summary.hasActivePrompt) ||
    (summary.pendingInteractionCount ?? 0) > 0
  ) {
    throw new ExistingSessionScheduledTaskCreateError(
      409,
      'session_busy',
      allowActivePrompt
        ? 'The caller session has a pending interaction; resolve it before binding the session to a task'
        : 'The requested session is busy; wait for its active prompt or pending interaction to finish before binding it to a task',
    );
  }
  if (summary.sourceType === 'scheduled_task') {
    throw new ExistingSessionScheduledTaskCreateError(
      409,
      'session_already_bound',
      'The requested session is already reserved for a scheduled task',
    );
  }
  if (
    summary.parentSessionId !== undefined ||
    summary.sourceId !== undefined ||
    (summary.sourceType !== undefined && summary.sourceType !== 'default')
  ) {
    throw new ExistingSessionScheduledTaskCreateError(
      409,
      'session_source_ineligible',
      'The requested session source cannot own a scheduled task',
    );
  }
}

export async function createScheduledTaskWithExistingSession(
  target: ScheduledTaskTarget,
  input: ExistingSessionScheduledTaskCreateInput,
  options:
    | { source: 'rest' }
    | { source: 'cron-tool'; assertCallerPromptActive: () => void },
): Promise<DurableCronTask> {
  if (
    input.cron.length === 0 ||
    input.cron.length > MAX_CRON_LENGTH ||
    validateCron(input.cron) !== null
  ) {
    throw new ExistingSessionScheduledTaskCreateError(
      400,
      'invalid_cron',
      'The scheduled-task cron expression is invalid',
    );
  }
  const prompt = input.prompt.trim();
  if (prompt.length === 0 || prompt.length > MAX_PROMPT_LENGTH) {
    throw new ExistingSessionScheduledTaskCreateError(
      400,
      'invalid_prompt',
      'The scheduled-task prompt is invalid',
    );
  }
  const allowActivePrompt = options.source === 'cron-tool';
  const assertCallerPromptActive =
    options.source === 'cron-tool'
      ? options.assertCallerPromptActive
      : undefined;
  assertReusableScheduledTaskSession(
    target,
    input.sessionId,
    allowActivePrompt,
    assertCallerPromptActive,
  );
  target.assertGenerationOpen?.();

  if (options.source === 'rest') {
    const ensurePersisted = target.bridge?.ensureDefaultSessionPersisted;
    if (!ensurePersisted) {
      throw new ExistingSessionScheduledTaskCreateError(
        409,
        'session_binding_unavailable',
        'Session persistence is not available for this workspace',
      );
    }
    try {
      await ensurePersisted.call(target.bridge, input.sessionId);
    } catch (error) {
      target.assertGenerationOpen?.();
      if (error instanceof SessionNotFoundError) {
        throw new ExistingSessionScheduledTaskCreateError(
          404,
          'session_not_found',
          `Session '${input.sessionId}' was not found`,
        );
      }
      writeStderrLine(
        `qwen serve: failed to persist scheduled-task session '${input.sessionId}': ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ExistingSessionScheduledTaskCreateError(
        500,
        'session_persistence_failed',
        'Failed to persist the requested session',
      );
    }
    target.assertGenerationOpen?.();
  }

  const now = Date.now();
  const task: DurableCronTask = {
    id: generateCronTaskId(),
    cron: input.cron,
    prompt,
    recurring: input.recurring,
    createdAt: now,
    lastFiredAt: now - (now % 60_000),
    enabled: input.enabled !== false,
    sessionId: input.sessionId,
    sessionOwnedByTask: false,
    sessionMode: input.sessionMode === 'per_run' ? 'per_run' : 'persistent',
    ...(input.sessionMode === 'per_run' && input.modelServiceId !== undefined
      ? { modelServiceId: input.modelServiceId }
      : {}),
    ...(input.sessionMode === 'per_run' && input.groupId !== undefined
      ? { groupId: input.groupId }
      : {}),
    ...(input.delivery !== undefined ? { delivery: input.delivery } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
  };
  let before: DurableCronTask[] | undefined;
  let after: DurableCronTask[] | undefined;
  await runWithScheduledTaskTarget(target, () =>
    updateCronTasks(
      target.workspaceCwd,
      (tasks) => {
        assertReusableScheduledTaskSession(
          target,
          input.sessionId,
          allowActivePrompt,
          assertCallerPromptActive,
        );
        if (
          tasks.some((candidate) => candidate.sessionId === input.sessionId)
        ) {
          throw new ExistingSessionScheduledTaskCreateError(
            409,
            'session_already_bound',
            'The requested session is already bound to another scheduled task',
          );
        }
        if (tasks.length >= MAX_SCHEDULED_TASKS) {
          throw new ExistingSessionScheduledTaskCreateError(
            409,
            'max_tasks_reached',
            `Maximum number of scheduled tasks (${MAX_SCHEDULED_TASKS}) reached`,
          );
        }
        before = tasks;
        after = [...tasks, task];
        return after;
      },
      { assertCanCommit: target.assertGenerationOpen },
    ),
  );
  try {
    target.assertGenerationOpen?.();
  } catch (error) {
    await rollbackCronMutation(target, before, after, 'scheduled-task create');
    throw error;
  }
  return task;
}

function requireOpenGeneration(
  target: ScheduledTaskTarget,
  res: Response,
): boolean {
  try {
    target.assertGenerationOpen?.();
    return true;
  } catch (error) {
    if (sendGenerationClosedError(res, error)) return false;
    throw error;
  }
}

async function rollbackCronMutation(
  target: ScheduledTaskTarget,
  before: DurableCronTask[] | undefined,
  after: DurableCronTask[] | undefined,
  route: string,
): Promise<void> {
  if (!before || !after) return;
  await runWithScheduledTaskTarget(target, () =>
    updateCronTasks(target.workspaceCwd, (tasks) =>
      isDeepStrictEqual(tasks, after) ? before : tasks,
    ),
  ).catch((error) => {
    writeStderrLine(
      `qwen serve: ${route} failed to roll back a stale task mutation: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

/**
 * Puts a one-shot task back after its manual run failed to dispatch.
 *
 * Unlike {@link rollbackCronMutation} this is keyed by task id, not by
 * whole-file equality: the dispatch window is wide enough for an unrelated
 * write to land on the same workspace file (a recurring task's tick persist, a
 * keepalive binding a task, another client's PATCH), and an equality-gated
 * undo would silently decline — permanently destroying a schedule that never
 * executed. Restores at the task's original position and no-ops when the task
 * is somehow still present.
 */
async function restoreConsumedOneShot(
  target: ScheduledTaskTarget,
  before: DurableCronTask[] | undefined,
  id: string,
  route: string,
): Promise<void> {
  const index = before?.findIndex((t) => t.id === id) ?? -1;
  const original = index === -1 ? undefined : before![index];
  if (!original) return;
  await runWithScheduledTaskTarget(target, () =>
    updateCronTasks(target.workspaceCwd, (tasks) => {
      if (tasks.some((t) => t.id === id)) return tasks; // never consumed → no write
      const restored = [...tasks];
      restored.splice(Math.min(index, restored.length), 0, original);
      return restored;
    }),
  ).catch((error) => {
    writeStderrLine(
      `qwen serve: ${route} failed to restore the consumed one-shot task: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

async function teardownBoundSession(
  target: ScheduledTaskTarget,
  sessionId: string,
): Promise<void> {
  if (target.cleanupSession) {
    await target.cleanupSession(sessionId).catch(() => {});
  } else if (target.bridge) {
    await target.bridge.closeSession(sessionId).catch(() => {});
    const removed = await new SessionService(target.workspaceCwd, {
      runtimeBaseDir: target.runtimeBaseDir,
    })
      .removeSession(sessionId)
      .catch(() => false);
    if (removed) target.bridge.markSessionCatalogChanged?.();
  }
}

async function dispatchTaskToFreshSession(
  target: ScheduledTaskTarget,
  task: DurableCronTask,
): Promise<string> {
  const { bridge } = target;
  const sendPrompt = bridge?.sendPrompt?.bind(bridge);
  if (!bridge || !sendPrompt || !task.sessionId) {
    throw new Error('Fresh-session dispatch is unavailable for this task');
  }
  const triggeredAt = task.lastFiredAt ?? Date.now();
  const child = await runWithScheduledTaskTarget(target, () =>
    bridge.spawnOrAttach({
      workspaceCwd: target.workspaceCwd,
      ...(task.modelServiceId ? { modelServiceId: task.modelServiceId } : {}),
      sessionScope: 'thread',
      parentSessionId: task.sessionId,
      sourceType: SCHEDULED_TASK_RUN_SOURCE_TYPE,
      sourceId: scheduledTaskRunSourceId(task.id),
    }),
  );
  try {
    bridge.updateSessionMetadata(child.sessionId, {
      displayName: scheduledTaskRunSessionName(
        task.name ?? task.prompt,
        triggeredAt,
      ),
      titleSource: 'auto',
    });
  } catch {
    // The prompt can still run with the generated session id as its label.
  }
  if (task.groupId) {
    try {
      await runWithScheduledTaskTarget(target, () =>
        createSessionOrganizationService(
          target.workspaceCwd,
        ).updateSessionOrganization(child.sessionId, {
          groupId: task.groupId,
          color: null,
        }),
      );
      bridge.markSessionCatalogChanged?.();
    } catch (error) {
      writeStderrLine(
        `qwen serve: scheduled-task session ${child.sessionId} could not be assigned to group ${task.groupId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  try {
    let markPromptAdmitted!: () => void;
    const promptAdmitted = new Promise<void>((resolve) => {
      markPromptAdmitted = resolve;
    });
    const turn = sendPrompt(
      child.sessionId,
      {
        sessionId: child.sessionId,
        prompt: [
          {
            type: 'text',
            text: buildScheduledTaskRunPrompt({
              id: task.id,
              name: task.name,
              cron: task.cron,
              prompt: task.prompt,
              triggeredAt,
              trigger: 'manual',
            }),
          },
        ],
      },
      undefined,
      {
        onPromptAdmitted: markPromptAdmitted,
      },
    );
    await Promise.race([
      promptAdmitted,
      turn.then(
        () => undefined,
        (error) => Promise.reject(error),
      ),
    ]);
    void turn.catch((error) => {
      writeStderrLine(
        `qwen serve: scheduled-task session ${child.sessionId} prompt failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  } catch (error) {
    await teardownBoundSession(target, child.sessionId);
    throw error;
  }
  return child.sessionId;
}

/**
 * Resolves the target workspace for one request. Returns null when it can't be
 * resolved (unknown or untrusted `:workspace`), in which case the resolver has
 * ALREADY sent the error response and the handler must just return.
 */
type ResolveScheduledTaskTarget = (
  req: Request,
  res: Response,
) => ScheduledTaskTarget | null;

interface RegisterScheduledTaskCrudRoutesDeps {
  /** Path prefix the five routes mount under: `''` for the primary
   * (unqualified) surface, `'/workspaces/:workspace'` for the qualified one. */
  prefix: string;
  resolveTarget: ResolveScheduledTaskTarget;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  channelDeliveryAuthorizations?: ChannelDeliveryAuthorizationStore;
}

interface RegisterScheduledTasksRoutesDeps {
  boundWorkspace: string;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  /**
   * Session bridge used to mint or validate a task session. When absent,
   * creates without `sessionId` remain unbound.
   */
  bridge?: ScheduledTasksSessionBridge;
  channelDeliveryAuthorizations?: ChannelDeliveryAuthorizationStore;
  getRuntime?: () => WorkspaceRuntime | undefined;
  cleanupSession?: (
    runtime: WorkspaceRuntime,
    sessionId: string,
  ) => Promise<unknown>;
  workspaceRegistry?: WorkspaceRegistry;
}

interface RegisterWorkspaceQualifiedScheduledTasksRoutesDeps {
  workspaceRegistry: WorkspaceRegistry;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  channelDeliveryAuthorizations?: ChannelDeliveryAuthorizationStore;
  /**
   * When true, a task created through a qualified route binds to a dedicated
   * session in the target workspace (its bridge mints one). Must mirror the
   * primary surface's `bridge` gate — the daemon only keeps bound sessions
   * resident + rehydrated when scheduled-task session management is on, so
   * binding without it would leave the task firing in a session nothing
   * revives. Off → tasks are created unbound (shared-owner firing).
   */
  manageScheduledTaskSessions: boolean;
  cleanupSession?: (
    runtime: WorkspaceRuntime,
    sessionId: string,
  ) => Promise<unknown>;
  conversationRuntimeActivity?: ConversationRuntimeActivityGate;
}

async function runWithScheduledTaskTarget<T>(
  target: ScheduledTaskTarget,
  fn: () => T | Promise<T>,
): Promise<Awaited<T>> {
  const result =
    target.runtimeBaseDir === undefined
      ? fn()
      : Storage.runWithResolvedRuntimeBaseDir(target.runtimeBaseDir, fn);
  return (await result) as Awaited<T>;
}

function sendActivityGateError(res: Response, error: unknown): boolean {
  if (
    !error ||
    typeof error !== 'object' ||
    (error as { code?: unknown }).code !== 'daemon_draining'
  ) {
    return false;
  }
  res.status(503).json({
    error: 'The daemon is draining and no longer accepts work.',
    code: 'daemon_draining',
  });
  return true;
}

/** On-the-wire task shape — normalizes the optional on-disk fields so the
 * client never has to special-case `undefined` name/enabled/runs. */
interface ScheduledTaskView {
  id: string;
  name: string | null;
  cron: string;
  prompt: string;
  recurring: boolean;
  enabled: boolean;
  createdAt: number;
  lastFiredAt: number | null;
  nextRunAt: number | null;
  sessionId: string | null;
  sessionMode: 'persistent' | 'per_run';
  modelServiceId: string | null;
  groupId: string | null;
  runs: CronTaskRun[];
  delivery?: CronTaskDelivery;
}

/** Next scheduled fire (epoch ms) for an enabled task, or null when the task
 * is disabled (it won't fire) or its cron can't be projected. A GET-time
 * snapshot the client counts down against — kept server-side so every cron
 * shape (including hand-written ones) uses core's single next-fire authority,
 * with no cron parser shipped to the browser. Uses the scheduler's jittered
 * fire time (`nextDurableFireMs`), not the bare cron boundary, so the countdown
 * matches when the task actually fires (the tick offsets each fire by a
 * deterministic per-task jitter of up to the jitter window). */
function computeNextRunAt(task: DurableCronTask): number | null {
  if (task.enabled === false) return null;
  return nextDurableFireMs(task);
}

function toView(task: DurableCronTask): ScheduledTaskView {
  return {
    id: task.id,
    name:
      typeof task.name === 'string' && task.name.length > 0 ? task.name : null,
    cron: task.cron,
    prompt: task.prompt,
    recurring: task.recurring,
    // Absent enabled defaults to enabled — tool-created tasks never write it.
    // A legacy guarded task (isolated run mode + precondition, both removed) is
    // reported as NOT runnable — `enabled: false` with no `nextRunAt` — so the
    // management UI never shows it as active or offers a Run affordance for a
    // task the scheduler refuses to fire. Fail closed on the read path too, not
    // just the tick. `POST /:id/run` rejects it as a second guard.
    enabled: task.enabled !== false && !taskHasLegacyCondition(task),
    createdAt: task.createdAt,
    lastFiredAt: task.lastFiredAt,
    nextRunAt: taskHasLegacyCondition(task) ? null : computeNextRunAt(task),
    // The task's bound session (its run-history transcript), or null for an
    // unbound tool-created/legacy task.
    sessionId:
      typeof task.sessionId === 'string' && task.sessionId.length > 0
        ? task.sessionId
        : null,
    sessionMode: task.sessionMode === 'per_run' ? 'per_run' : 'persistent',
    modelServiceId: task.modelServiceId ?? null,
    groupId: task.groupId ?? null,
    // Absent runs (tool-created / never-fired) normalizes to [] so the client
    // never special-cases undefined.
    runs: Array.isArray(task.runs) ? task.runs : [],
    ...(task.delivery !== undefined ? { delivery: task.delivery } : {}),
  };
}

// Same validation cron_create runs: parseCron rejects malformed syntax,
// nextFireTime rejects expressions that parse but never match a real date
// (e.g. "0 0 30 2 *") — which would otherwise persist a task that silently
// never fires. Returns an error message, or null when valid.
function validateCron(cron: string): string | null {
  try {
    parseCron(cron);
    nextFireTime(cron, new Date());
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * A canonical string for a cron expression's *effective* schedule, so two
 * expressions that fire identically compare equal regardless of surface form
 * (`0 9 * * *` vs `00 9 * * *`, extra whitespace, `7` vs `0` for Sunday). Used
 * to decide whether a PATCH genuinely changed the schedule before re-seating
 * the anchor. Returns null when the cron can't be parsed. The `*`-vs-full-range
 * wildness flags are included because dom/dow wildness changes cron's firing
 * semantics even when the expanded sets match.
 */
function canonicalCron(cron: string): string | null {
  try {
    const f = parseCron(cron);
    const s = (set: Set<number>) => [...set].sort((a, b) => a - b).join(',');
    return [
      s(f.minute),
      s(f.hour),
      s(f.dayOfMonth),
      s(f.month),
      s(f.dayOfWeek),
      f.domIsWild ? 'W' : '',
      f.dowIsWild ? 'W' : '',
    ].join('|');
  } catch {
    return null;
  }
}

function registerScheduledTaskCrudRoutes(
  app: Application,
  deps: RegisterScheduledTaskCrudRoutesDeps,
): void {
  const {
    prefix,
    resolveTarget,
    mutate,
    safeBody,
    channelDeliveryAuthorizations,
  } = deps;
  const base = `${prefix}/scheduled-tasks`;

  const withTarget =
    (
      handler: (
        req: Request,
        res: Response,
        target: ScheduledTaskTarget,
      ) => Promise<void>,
    ): RequestHandler =>
    async (req, res) => {
      const target = resolveTarget(req, res);
      if (!target) return;
      const operation = async () => {
        if (!requireOpenGeneration(target, res)) return;
        await handler(req, res, target);
      };
      try {
        if (target.activity) {
          await target.activity.run(operation);
        } else {
          await operation();
        }
      } catch (error) {
        if (sendActivityGateError(res, error)) return;
        throw error;
      }
    };

  // ── List ──────────────────────────────────────────────────────────
  app.get(
    base,
    withTarget(async (_req, res, target) => {
      try {
        const tasks = await runWithScheduledTaskTarget(target, () =>
          readCronTasks(target.workspaceCwd),
        );
        if (!requireOpenGeneration(target, res)) return;
        res.status(200).json({ v: 1, tasks: tasks.map(toView) });
      } catch (err) {
        if (sendActivityGateError(res, err)) return;
        // A malformed/corrupt file throws (fix-or-delete contract) rather than
        // reading as empty — surface it instead of hiding the user's tasks
        // behind a silent [].
        writeStderrLine(
          `qwen serve: GET ${base} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        res.status(500).json({
          error:
            'Failed to read scheduled tasks (the tasks file may be corrupt)',
          code: 'scheduled_tasks_read_failed',
        });
      }
    }),
  );

  // ── Create ────────────────────────────────────────────────────────
  app.post(
    base,
    mutate(),
    withTarget(async (req, res, target) => {
      const { workspaceCwd, bridge } = target;
      const body = safeBody(req);

      const cron = typeof body['cron'] === 'string' ? body['cron'].trim() : '';
      if (cron.length === 0) {
        res.status(400).json({
          error: '`cron` is required and must be a non-empty string',
          code: 'invalid_cron',
        });
        return;
      }
      if (cron.length > MAX_CRON_LENGTH) {
        res.status(400).json({
          error: `\`cron\` exceeds ${MAX_CRON_LENGTH}-character limit`,
          code: 'invalid_cron',
        });
        return;
      }
      const cronError = validateCron(cron);
      if (cronError) {
        res.status(400).json({ error: cronError, code: 'invalid_cron' });
        return;
      }

      const prompt =
        typeof body['prompt'] === 'string' ? body['prompt'].trim() : '';
      if (prompt.length === 0) {
        res.status(400).json({
          error: '`prompt` is required and must be a non-empty string',
          code: 'invalid_prompt',
        });
        return;
      }
      if (prompt.length > MAX_PROMPT_LENGTH) {
        res.status(400).json({
          error: `\`prompt\` exceeds ${MAX_PROMPT_LENGTH}-character limit`,
          code: 'invalid_prompt',
        });
        return;
      }

      const nameResult = parseNameField(body['name']);
      if (nameResult.error) {
        res.status(400).json({ error: nameResult.error, code: 'invalid_name' });
        return;
      }

      if (
        body['recurring'] !== undefined &&
        typeof body['recurring'] !== 'boolean'
      ) {
        res.status(400).json({
          error: '`recurring` must be a boolean',
          code: 'invalid_recurring',
        });
        return;
      }
      if (
        body['enabled'] !== undefined &&
        typeof body['enabled'] !== 'boolean'
      ) {
        res.status(400).json({
          error: '`enabled` must be a boolean',
          code: 'invalid_enabled',
        });
        return;
      }
      const sessionMode =
        body['sessionMode'] === undefined ? 'persistent' : body['sessionMode'];
      if (sessionMode !== 'persistent' && sessionMode !== 'per_run') {
        res.status(400).json({
          error: '`sessionMode` must be "persistent" or "per_run"',
          code: 'invalid_session_mode',
        });
        return;
      }
      const modelServiceId = body['modelServiceId'];
      if (
        modelServiceId !== undefined &&
        (typeof modelServiceId !== 'string' ||
          modelServiceId.length === 0 ||
          modelServiceId.length > MAX_ROUTING_ID_LENGTH)
      ) {
        res.status(400).json({
          error: `\`modelServiceId\` must be a non-empty string of at most ${MAX_ROUTING_ID_LENGTH} characters`,
          code: 'invalid_model_service_id',
        });
        return;
      }
      const groupId = body['groupId'];
      if (
        groupId !== undefined &&
        (typeof groupId !== 'string' ||
          groupId.length === 0 ||
          groupId.length > MAX_ROUTING_ID_LENGTH)
      ) {
        res.status(400).json({
          error: `\`groupId\` must be a non-empty string of at most ${MAX_ROUTING_ID_LENGTH} characters`,
          code: 'invalid_group_id',
        });
        return;
      }
      if (
        sessionMode !== 'per_run' &&
        (modelServiceId !== undefined || groupId !== undefined)
      ) {
        res.status(400).json({
          error:
            '`modelServiceId` and `groupId` are only supported when `sessionMode` is "per_run"',
          code: 'session_routing_requires_per_run',
        });
        return;
      }
      if (typeof groupId === 'string') {
        const groups = await runWithScheduledTaskTarget(target, () =>
          createSessionOrganizationService(workspaceCwd).listGroups(),
        );
        if (!groups.groups.some((group) => group.id === groupId)) {
          res.status(400).json({
            error: `Group not found: ${groupId}`,
            code: 'group_not_found',
          });
          return;
        }
      }
      const parsedSessionId = parseCallerSuppliedSessionId(body['sessionId']);
      if (parsedSessionId.kind === 'invalid') {
        res.status(400).json({
          error:
            '`sessionId` must be an RFC UUID v1-v5 (e.g. "550e8400-e29b-41d4-a716-446655440000")',
          code: 'invalid_session_id',
        });
        return;
      }
      const providedSessionId =
        parsedSessionId.kind === 'valid'
          ? parsedSessionId.sessionId
          : undefined;
      let delivery: PublicChannelDelivery | undefined;
      if (body['delivery'] !== undefined) {
        try {
          delivery = parseChannelDelivery(body['delivery']);
        } catch (err) {
          if (!isChannelDeliveryError(err)) throw err;
          res.status(400).json({ error: err.message, code: err.code });
          return;
        }
      }
      if (sessionMode === 'per_run' && delivery !== undefined) {
        res.status(400).json({
          error: 'Per-run sessions do not support channel delivery',
          code: 'session_mode_delivery_unsupported',
        });
        return;
      }
      const removedField = findRemovedTaskField(body);
      if (removedField) {
        res.status(400).json(removedFieldError(removedField));
        return;
      }
      const recurring = body['recurring'] !== false;
      const enabled = body['enabled'] !== false;
      const taskId = generateCronTaskId();

      if (sessionMode === 'per_run' && (!bridge || !bridge.sendPrompt)) {
        res.status(409).json({
          error: 'Fresh-session dispatch is not available for this workspace',
          code: 'session_mode_unavailable',
        });
        return;
      }

      if (providedSessionId !== undefined) {
        try {
          const task = await createScheduledTaskWithExistingSession(
            target,
            {
              sessionId: providedSessionId,
              cron,
              prompt,
              recurring,
              enabled,
              sessionMode,
              ...(typeof modelServiceId === 'string' ? { modelServiceId } : {}),
              ...(typeof groupId === 'string' ? { groupId } : {}),
              ...(delivery !== undefined ? { delivery } : {}),
              ...(nameResult.value !== undefined
                ? { name: nameResult.value }
                : {}),
            },
            { source: 'rest' },
          );
          if (task.delivery && task.sessionId) {
            channelDeliveryAuthorizations?.registerScheduledTask(workspaceCwd, {
              sessionId: task.sessionId,
              taskId: task.id,
              target: task.delivery.target,
              recurring: task.recurring,
              lastFiredAt: task.lastFiredAt ?? undefined,
            });
          }
          res.status(201).json(toView(task));
        } catch (error) {
          if (error instanceof ExistingSessionScheduledTaskCreateError) {
            if (error.code === 'workspace_runtime_unavailable') {
              res.set('Retry-After', '1');
            }
            res
              .status(error.status)
              .json({ error: error.message, code: error.code });
            return;
          }
          if (sendActivityGateError(res, error)) return;
          if (sendGenerationClosedError(res, error)) return;
          writeStderrLine(
            `qwen serve: POST ${base} failed to create a task for session '${providedSessionId}': ${error instanceof Error ? error.message : String(error)}`,
          );
          res.status(500).json({
            error: 'Failed to create scheduled task',
            code: 'scheduled_tasks_write_failed',
          });
        }
        return;
      }

      let boundSessionId: string | undefined;
      let sessionMintedHere = false;
      if (bridge) {
        // Best-effort pre-check; the write-lock checks below are authoritative.
        try {
          const tasks = await runWithScheduledTaskTarget(target, () =>
            readCronTasks(workspaceCwd),
          );
          if (tasks.length >= MAX_SCHEDULED_TASKS) {
            res.status(409).json({
              error: `Maximum number of scheduled tasks (${MAX_SCHEDULED_TASKS}) reached`,
              code: 'max_tasks_reached',
            });
            return;
          }
        } catch {
          // Read failure → skip the pre-check; the write below is authoritative.
        }
        if (!requireOpenGeneration(target, res)) return;
        try {
          const session = await runWithScheduledTaskTarget(target, () =>
            bridge.spawnOrAttach({
              workspaceCwd,
              sessionScope: 'thread',
              sourceType: 'scheduled_task',
              sourceId: taskId,
            }),
          );
          boundSessionId = session.sessionId;
          sessionMintedHere = true;
          if (!requireOpenGeneration(target, res)) {
            await teardownBoundSession(target, boundSessionId);
            return;
          }
          try {
            await runWithScheduledTaskTarget(target, async () =>
              bridge.updateSessionMetadata(boundSessionId!, {
                displayName: scheduledTaskSessionName(
                  nameResult.value ?? prompt,
                ),
                titleSource: 'auto',
              }),
            );
          } catch {
            // metadata update is non-critical
          }
        } catch (err) {
          if (sendActivityGateError(res, err)) return;
          if (sendGenerationClosedError(res, err)) return;
          writeStderrLine(
            `qwen serve: POST ${base} failed to create the task's session: ${err instanceof Error ? err.message : String(err)}`,
          );
          res.status(500).json({
            error: "Failed to create the task's session",
            code: 'scheduled_tasks_session_failed',
          });
          return;
        }
      }

      const now = Date.now();
      const task: DurableCronTask = {
        id: taskId,
        cron,
        prompt,
        recurring,
        createdAt: now,
        // Pin to the creation minute so the scheduler can't fire during the
        // minute the task was created — same guard cronScheduler.create uses.
        lastFiredAt: now - (now % 60_000),
        enabled,
        sessionMode,
        ...(typeof modelServiceId === 'string' ? { modelServiceId } : {}),
        ...(typeof groupId === 'string' ? { groupId } : {}),
        ...(delivery !== undefined ? { delivery } : {}),
        ...(boundSessionId !== undefined
          ? {
              sessionId: boundSessionId,
            }
          : {}),
        ...(nameResult.value !== undefined ? { name: nameResult.value } : {}),
      };

      // Best-effort teardown of the just-minted session when the create can't be
      // committed. closeSession only tears down the live child; removeSession also
      // deletes the persisted transcript/title record — both are needed, or a
      // rejected create (the loser of a concurrent create at the cap boundary,
      // which passes the pre-check but loses the authoritative write) would leave
      // a named session in the list with no owning task.
      const rollbackSession = async () => {
        if (boundSessionId !== undefined && sessionMintedHere) {
          await teardownBoundSession(target, boundSessionId);
        }
      };

      let overCap = false;
      let rollbackBefore: DurableCronTask[] | undefined;
      let rollbackAfter: DurableCronTask[] | undefined;
      try {
        await runWithScheduledTaskTarget(target, () =>
          updateCronTasks(
            workspaceCwd,
            (tasks) => {
              // Cap check under the write lock so two concurrent creates can't both
              // slip past a stale count. Returning the input unchanged is a no-op
              // (no write), which the flag below turns into a 409.
              if (tasks.length >= MAX_SCHEDULED_TASKS) {
                overCap = true;
                return tasks;
              }
              rollbackBefore = tasks;
              rollbackAfter = [...tasks, task];
              return rollbackAfter;
            },
            { assertCanCommit: target.assertGenerationOpen },
          ),
        );
      } catch (err) {
        await rollbackSession();
        if (sendActivityGateError(res, err)) return;
        if (sendGenerationClosedError(res, err)) return;
        writeStderrLine(
          `qwen serve: POST ${base} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        res.status(500).json({
          error: 'Failed to create scheduled task',
          code: 'scheduled_tasks_write_failed',
        });
        return;
      }
      if (rollbackBefore && rollbackAfter) {
        try {
          target.assertGenerationOpen?.();
        } catch (error) {
          await rollbackCronMutation(
            target,
            rollbackBefore,
            rollbackAfter,
            `POST ${base}`,
          );
          await rollbackSession();
          if (sendGenerationClosedError(res, error)) return;
          throw error;
        }
      }
      if (overCap) {
        await rollbackSession();
        res.status(409).json({
          error: `Maximum number of scheduled tasks (${MAX_SCHEDULED_TASKS}) reached`,
          code: 'max_tasks_reached',
        });
        return;
      }
      if (task.delivery && task.sessionId) {
        channelDeliveryAuthorizations?.registerScheduledTask(workspaceCwd, {
          sessionId: task.sessionId,
          taskId: task.id,
          target: task.delivery.target,
          recurring: task.recurring,
          lastFiredAt: task.lastFiredAt ?? undefined,
        });
      }
      res.status(201).json(toView(task));
    }),
  );

  // ── Update (name / enabled / cron / prompt / recurring / delivery) ──
  app.patch(
    `${base}/:id`,
    mutate(),
    withTarget(async (req, res, target) => {
      const { workspaceCwd, bridge } = target;
      const id = typeof req.params['id'] === 'string' ? req.params['id'] : '';
      if (id.length === 0) {
        res
          .status(400)
          .json({ error: 'Task id is required', code: 'invalid_id' });
        return;
      }
      const body = safeBody(req);

      // Pre-validate every provided field OUTSIDE the write lock — cron parsing
      // and type checks don't need it, and validating inside the mutate callback
      // would mean holding the lock to reject a bad request.
      const patch: Partial<DurableCronTask> = {};
      let clearName = false;
      let clearDelivery = false;
      let clearModelServiceId = false;
      let clearGroupId = false;

      const removedPatchField = findRemovedTaskField(body);
      if (removedPatchField) {
        res.status(400).json(removedFieldError(removedPatchField));
        return;
      }

      if ('cron' in body) {
        const cron =
          typeof body['cron'] === 'string' ? body['cron'].trim() : '';
        if (cron.length === 0 || cron.length > MAX_CRON_LENGTH) {
          res.status(400).json({
            error: '`cron` must be a non-empty string within the length limit',
            code: 'invalid_cron',
          });
          return;
        }
        const cronError = validateCron(cron);
        if (cronError) {
          res.status(400).json({ error: cronError, code: 'invalid_cron' });
          return;
        }
        patch.cron = cron;
      }
      if ('prompt' in body) {
        const prompt =
          typeof body['prompt'] === 'string' ? body['prompt'].trim() : '';
        if (prompt.length === 0 || prompt.length > MAX_PROMPT_LENGTH) {
          res.status(400).json({
            error:
              '`prompt` must be a non-empty string within the length limit',
            code: 'invalid_prompt',
          });
          return;
        }
        patch.prompt = prompt;
      }
      if ('name' in body) {
        const nameResult = parseNameField(body['name']);
        if (nameResult.error) {
          res
            .status(400)
            .json({ error: nameResult.error, code: 'invalid_name' });
          return;
        }
        if (nameResult.value === undefined) {
          clearName = true;
        } else {
          patch.name = nameResult.value;
        }
      }
      if ('recurring' in body) {
        if (typeof body['recurring'] !== 'boolean') {
          res.status(400).json({
            error: '`recurring` must be a boolean',
            code: 'invalid_recurring',
          });
          return;
        }
        patch.recurring = body['recurring'];
      }
      if ('enabled' in body) {
        if (typeof body['enabled'] !== 'boolean') {
          res.status(400).json({
            error: '`enabled` must be a boolean',
            code: 'invalid_enabled',
          });
          return;
        }
        patch.enabled = body['enabled'];
      }
      if ('sessionMode' in body) {
        if (
          body['sessionMode'] !== 'persistent' &&
          body['sessionMode'] !== 'per_run'
        ) {
          res.status(400).json({
            error: '`sessionMode` must be "persistent" or "per_run"',
            code: 'invalid_session_mode',
          });
          return;
        }
        // The per-run admission checks live inside the mutation below, where the
        // task's CURRENT mode is known: the edit dialog re-sends the task's own
        // sessionMode on every PATCH, so gating on the raw value here would make
        // a prompt-only edit of an existing per_run task unsavable wherever
        // fresh-session dispatch is unavailable.
        patch.sessionMode = body['sessionMode'];
      }
      if ('modelServiceId' in body) {
        const value = body['modelServiceId'];
        if (value === null || value === '') {
          clearModelServiceId = true;
        } else if (
          typeof value !== 'string' ||
          value.length > MAX_ROUTING_ID_LENGTH
        ) {
          res.status(400).json({
            error: `\`modelServiceId\` must be null or a non-empty string of at most ${MAX_ROUTING_ID_LENGTH} characters`,
            code: 'invalid_model_service_id',
          });
          return;
        } else {
          patch.modelServiceId = value;
        }
      }
      if ('groupId' in body) {
        const value = body['groupId'];
        if (value === null || value === '') {
          clearGroupId = true;
        } else if (
          typeof value !== 'string' ||
          value.length > MAX_ROUTING_ID_LENGTH
        ) {
          res.status(400).json({
            error: `\`groupId\` must be null or a non-empty string of at most ${MAX_ROUTING_ID_LENGTH} characters`,
            code: 'invalid_group_id',
          });
          return;
        } else {
          const groups = await runWithScheduledTaskTarget(target, () =>
            createSessionOrganizationService(workspaceCwd).listGroups(),
          );
          if (!groups.groups.some((group) => group.id === value)) {
            res.status(400).json({
              error: `Group not found: ${value}`,
              code: 'group_not_found',
            });
            return;
          }
          patch.groupId = value;
        }
      }
      if ('delivery' in body) {
        if (body['delivery'] === null) {
          clearDelivery = true;
        } else {
          try {
            patch.delivery = parseChannelDelivery(body['delivery']);
          } catch (err) {
            if (!isChannelDeliveryError(err)) throw err;
            res.status(400).json({ error: err.message, code: err.code });
            return;
          }
        }
      }
      if (
        Object.keys(patch).length === 0 &&
        !clearName &&
        !clearDelivery &&
        !clearModelServiceId &&
        !clearGroupId
      ) {
        res.status(400).json({
          error: 'No updatable fields provided',
          code: 'empty_patch',
        });
        return;
      }

      let found = false;
      let updated: DurableCronTask | undefined;
      let blockedByArchive = false;
      let blockedLegacy = false;
      let blockedSessionModeDelivery = false;
      let blockedSessionModeUnavailable = false;
      let blockedSessionModeUnbound = false;
      let rollbackBefore: DurableCronTask[] | undefined;
      let rollbackAfter: DurableCronTask[] | undefined;
      try {
        await runWithScheduledTaskTarget(target, () =>
          updateCronTasks(
            workspaceCwd,
            (tasks) => {
              const idx = tasks.findIndex((t) => t.id === id);
              if (idx === -1) return tasks; // not found → no write
              found = true;
              const current = tasks[idx]!;
              // Both per-run admission checks apply to an actual CONVERSION.
              // Re-sending the mode the task already has changes nothing, so it
              // must not be refused (see the note on `patch.sessionMode` above).
              const convertingToPerRun =
                patch.sessionMode === 'per_run' &&
                current.sessionMode !== 'per_run';
              if (convertingToPerRun && (!bridge || !bridge.sendPrompt)) {
                blockedSessionModeUnavailable = true;
                return tasks; // no write
              }
              // `dispatchTaskToFreshSession` needs a bound session to attribute
              // the child to and throws without one. Tool-created durable tasks
              // start unbound (`cron_create` omits sessionId), so accepting the
              // conversion here would leave a task whose every manual run 500s
              // with a phantom failed-run record until keepalive binds it.
              if (convertingToPerRun && !current.sessionId) {
                blockedSessionModeUnbound = true;
                return tasks; // no write
              }
              // A legacy guarded task (isolated + precondition, both removed) can't be
              // enabled: `toView` reports it disabled, so the only PATCH the Web Shell
              // sends for it is the Enable toggle — which would 200 here and then read
              // back disabled again, an Enable control that can never succeed with no
              // error explaining why. Reject the enable with the recreate remediation
              // instead of acknowledging an update that changes nothing runnable.
              if (patch.enabled === true && taskHasLegacyCondition(current)) {
                blockedLegacy = true;
                return tasks; // no write
              }
              // A task disabled BY archiving its session (`disabledByArchive`) can't
              // be re-enabled through this generic PATCH: its bound session is still
              // archived and can't fire, so flipping `enabled: true` here would show
              // an enabled task with a countdown that never runs. The task/session
              // lifecycle must stay coupled — the caller has to unarchive the session
              // (which clears the marker and reloads it). Reject and leave the file
              // untouched.
              if (
                patch.enabled === true &&
                current.disabledByArchive === true
              ) {
                blockedByArchive = true;
                return tasks; // no write
              }
              const next: DurableCronTask = { ...current, ...patch };
              // `name: null/""` clears the field rather than storing an empty name,
              // so toView reports it as unnamed and isValidTask never sees a "".
              if (clearName) delete next.name;
              if (clearDelivery) delete next.delivery;
              if (clearModelServiceId) delete next.modelServiceId;
              if (clearGroupId) delete next.groupId;
              if (next.sessionMode !== 'per_run') {
                delete next.modelServiceId;
                delete next.groupId;
              }
              if (next.sessionMode === 'per_run' && next.delivery) {
                blockedSessionModeDelivery = true;
                return tasks;
              }
              // Re-seat the task's schedule anchor to "now" whenever an edit would
              // otherwise let the scheduler retroactively fire an already-past slot.
              const justReEnabled =
                current.enabled === false && patch.enabled === true;
              // Compare the EFFECTIVE schedule, not the raw string: a cosmetic edit
              // (`0 9 * * *` → `00 9 * * *`, whitespace) must not re-seat the anchor
              // and drop a legitimately-pending catch-up fire.
              const cronChanged =
                patch.cron !== undefined &&
                canonicalCron(patch.cron) !== canonicalCron(current.cron);
              const becameRecurring =
                patch.recurring === true && current.recurring !== true;
              const becameOneShot =
                patch.recurring === false && current.recurring !== false;
              // Re-seated REGARDLESS of enabled: a schedule edit made while the task
              // is paused must not leave a stale anchor that fires retroactively when
              // it's later re-enabled in a SEPARATE request (the re-enable patch has no
              // schedule change of its own to trigger the re-seat). Re-seating a paused
              // task's anchor is harmless — it doesn't fire until enabled.
              {
                const now = Date.now();
                const minute = now - (now % 60_000);
                if (
                  next.recurring &&
                  (justReEnabled || cronChanged || becameRecurring)
                ) {
                  // A recurring task's anchor is lastFiredAt: resume from now so a
                  // re-enable / cron edit / one-shot→recurring flip doesn't retroactively
                  // fire a past slot (matters most for a bound task, whose catch-up runs
                  // on every file-watch reload).
                  next.lastFiredAt = minute;
                } else if (
                  !next.recurring &&
                  (justReEnabled || cronChanged || becameOneShot)
                ) {
                  // A one-shot's anchor is createdAt. Re-seat it on a schedule change
                  // (cron edit, or recurring→one-shot) OR a re-enable so the task fires
                  // at its NEXT occurrence — otherwise the scheduler reads its original
                  // long-past slot as a MISSED one-shot and fires + permanently deletes
                  // it. A one-shot disabled past its slot then re-enabled would
                  // otherwise be silently destroyed on the next reload.
                  next.createdAt = now;
                  next.lastFiredAt = minute;
                }
              }
              updated = next;
              rollbackBefore = tasks;
              rollbackAfter = tasks.map((t, i) => (i === idx ? next : t));
              return rollbackAfter;
            },
            { assertCanCommit: target.assertGenerationOpen },
          ),
        );
      } catch (err) {
        if (sendActivityGateError(res, err)) return;
        if (sendGenerationClosedError(res, err)) return;
        writeStderrLine(
          `qwen serve: PATCH ${base}/${id} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        res.status(500).json({
          error: 'Failed to update scheduled task',
          code: 'scheduled_tasks_write_failed',
        });
        return;
      }
      if (rollbackBefore && rollbackAfter) {
        try {
          target.assertGenerationOpen?.();
        } catch (error) {
          await rollbackCronMutation(
            target,
            rollbackBefore,
            rollbackAfter,
            `PATCH ${base}/${id}`,
          );
          if (sendGenerationClosedError(res, error)) return;
          throw error;
        }
      }
      if (blockedLegacy) {
        res.status(409).json({
          error:
            'This task uses the removed isolated run mode with a precondition and can no longer be enabled or run. Recreate it (and call the `create_sub_session` tool from the prompt if you need per-run isolation).',
          code: 'task_legacy_unsupported',
        });
        return;
      }
      if (blockedByArchive) {
        res.status(409).json({
          error:
            'This task was disabled by archiving its session; unarchive the session to re-enable it.',
          code: 'task_session_archived',
        });
        return;
      }
      if (blockedSessionModeUnavailable) {
        res.status(409).json({
          error: 'Fresh-session dispatch is not available for this workspace',
          code: 'session_mode_unavailable',
        });
        return;
      }
      if (blockedSessionModeUnbound) {
        res.status(409).json({
          error:
            'This task is not bound to a session yet, so it cannot run in a new session every run. Try again once it has run or been opened at least once.',
          code: 'session_mode_requires_bound_session',
        });
        return;
      }
      if (blockedSessionModeDelivery) {
        res.status(409).json({
          error: 'Per-run sessions do not support channel delivery',
          code: 'session_mode_delivery_unsupported',
        });
        return;
      }
      if (!found || !updated) {
        res
          .status(404)
          .json({ error: 'Task not found', code: 'task_not_found' });
        return;
      }
      // Keep the bound session's display name in sync with the task's effective
      // label (its name, or its prompt when unnamed) — the session was named
      // after the task at create, so a rename (or a prompt edit while unnamed)
      // should follow. Only when the effective label actually changed, so a bare
      // cron/enabled edit doesn't touch the session. Best-effort: a metadata
      // failure must not fail the PATCH the schedule already committed.
      const effectiveLabelChanged =
        patch.name !== undefined ||
        clearName ||
        (patch.prompt !== undefined && updated.name === undefined);
      if (
        bridge &&
        updated.sessionId &&
        updated.sessionOwnedByTask !== false &&
        effectiveLabelChanged
      ) {
        try {
          bridge.updateSessionMetadata(updated.sessionId, {
            displayName: scheduledTaskSessionName(
              updated.name ?? updated.prompt,
            ),
            titleSource: 'auto',
          });
        } catch {
          // non-critical — the schedule change already persisted
        }
      }
      if (updated.delivery && updated.sessionId) {
        channelDeliveryAuthorizations?.registerScheduledTask(workspaceCwd, {
          sessionId: updated.sessionId,
          taskId: updated.id,
          target: updated.delivery.target,
          recurring: updated.recurring,
          lastFiredAt: updated.lastFiredAt ?? undefined,
        });
      }
      if (clearDelivery && updated.sessionId) {
        channelDeliveryAuthorizations?.revokeScheduledTask(
          workspaceCwd,
          updated.sessionId,
          updated.id,
        );
      }
      res.status(200).json(toView(updated));
    }),
  );

  // ── Delete ────────────────────────────────────────────────────────
  app.delete(
    `${base}/:id`,
    mutate(),
    withTarget(async (req, res, target) => {
      const { workspaceCwd, bridge } = target;
      const id = typeof req.params['id'] === 'string' ? req.params['id'] : '';
      if (id.length === 0) {
        res
          .status(400)
          .json({ error: 'Task id is required', code: 'invalid_id' });
        return;
      }
      // Single atomic read-modify-write: capture the task's bound session AND
      // remove it in one cycle, closing the TOCTOU window a separate
      // read-then-remove would open (and cutting three file reads to one). A
      // task-owned session is torn down after; a caller-owned session survives.
      let boundSessionId: string | undefined;
      let sessionOwnedByTask = true;
      let removed = false;
      let rollbackBefore: DurableCronTask[] | undefined;
      let rollbackAfter: DurableCronTask[] | undefined;
      try {
        await runWithScheduledTaskTarget(target, () =>
          updateCronTasks(
            workspaceCwd,
            (tasks) => {
              const idx = tasks.findIndex((t) => t.id === id);
              if (idx === -1) return tasks; // not found → no write
              const match = tasks[idx]!.sessionId;
              if (typeof match === 'string' && match.length > 0) {
                boundSessionId = match;
                sessionOwnedByTask = tasks[idx]!.sessionOwnedByTask !== false;
              }
              removed = true;
              rollbackBefore = tasks;
              rollbackAfter = tasks.filter((_, i) => i !== idx);
              return rollbackAfter;
            },
            { assertCanCommit: target.assertGenerationOpen },
          ),
        );
      } catch (err) {
        if (sendActivityGateError(res, err)) return;
        if (sendGenerationClosedError(res, err)) return;
        writeStderrLine(
          `qwen serve: DELETE ${base}/${id} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        res.status(500).json({
          error: 'Failed to delete scheduled task',
          code: 'scheduled_tasks_write_failed',
        });
        return;
      }
      if (rollbackBefore && rollbackAfter) {
        try {
          target.assertGenerationOpen?.();
        } catch (error) {
          await rollbackCronMutation(
            target,
            rollbackBefore,
            rollbackAfter,
            `DELETE ${base}/${id}`,
          );
          if (sendGenerationClosedError(res, error)) return;
          throw error;
        }
      }
      if (!removed) {
        res
          .status(404)
          .json({ error: 'Task not found', code: 'task_not_found' });
        return;
      }
      // Stop the now-orphaned session (keeps its transcript on disk as history).
      if (boundSessionId && sessionOwnedByTask && bridge) {
        try {
          await runWithScheduledTaskTarget(target, () =>
            bridge.closeSession(boundSessionId!),
          );
        } catch (error) {
          if (sendActivityGateError(res, error)) return;
        }
      }
      if (boundSessionId) {
        channelDeliveryAuthorizations?.revokeScheduledTask(
          workspaceCwd,
          boundSessionId,
          id,
        );
      }
      res.status(200).json({ deleted: true, id });
    }),
  );

  // ── Manual run ────────────────────────────────────────────────────
  // Persistent tasks are recorded here and executed by the client in their
  // bound session. Per-run tasks are dispatched here because only the daemon
  // can create the fresh child session and attribute it to this run.
  app.post(
    `${base}/:id/run`,
    mutate(),
    withTarget(async (req, res, target) => {
      const { workspaceCwd } = target;
      const id = typeof req.params['id'] === 'string' ? req.params['id'] : '';
      if (id.length === 0) {
        res
          .status(400)
          .json({ error: 'Task id is required', code: 'invalid_id' });
        return;
      }
      // A manual run is stamped at its exact instant (not minute-rounded like a
      // scheduler fire): the scheduler compares slots as `slot > lastFiredAt`, so
      // a precise timestamp behaves correctly, and — unlike rounding — it can't
      // collide with the creation-minute anchor that describeLastRun reads as
      // "never run" when a task is run manually within its creation minute.
      const now = Date.now();
      let found = false;
      let blockedDisabled = false;
      let blockedLegacy = false;
      let updated: DurableCronTask | undefined;
      let rollbackBefore: DurableCronTask[] | undefined;
      let rollbackAfter: DurableCronTask[] | undefined;
      try {
        await runWithScheduledTaskTarget(target, () =>
          updateCronTasks(
            workspaceCwd,
            (tasks) => {
              const idx = tasks.findIndex((t) => t.id === id);
              if (idx === -1) return tasks; // not found → no write
              found = true;
              const current = tasks[idx]!;
              // A legacy guarded task (isolated + precondition, both removed) must not
              // run from ANY path. The scheduler already skips it and the list view
              // reports it disabled; reject a direct `/run` too — its on-disk
              // `enabled` may still be true, so the disabled check below is not enough.
              // Executing it here would run the prompt with its safety gate ignored,
              // which is exactly what the removal must never allow.
              if (taskHasLegacyCondition(current)) {
                blockedLegacy = true;
                return tasks; // no write
              }
              // A disabled task must not record a manual run: it's paused (and if it
              // was disabled by archiving its session, that session can't even fire),
              // so stamping lastFiredAt + a 'manual' entry would write a phantom "ran"
              // record. Mirrors the PATCH route's refusal to re-enable such tasks and
              // the UI, where onRunPrompt already rejects before recording.
              if (current.enabled === false) {
                blockedDisabled = true;
                return tasks; // no write
              }
              const next: DurableCronTask = {
                ...current,
                lastFiredAt: now,
                runs: appendCronRun(current.runs, {
                  at: now,
                  kind: 'manual',
                  ...(current.sessionMode !== 'per_run' && current.sessionId
                    ? { sessionId: current.sessionId }
                    : {}),
                }),
              };
              updated = next;
              // A one-shot's manual run IS its single fire — remove it from the store
              // so the scheduler doesn't ALSO fire it at its original scheduled time
              // (its slot is still in the future, so stamping lastFiredAt=now wouldn't
              // stop that fire). The response still returns the recorded run.
              rollbackBefore = tasks;
              const nextTasks = !current.recurring
                ? tasks.filter((_, i) => i !== idx)
                : tasks.map((t, i) => (i === idx ? next : t));
              rollbackAfter = nextTasks;
              return nextTasks;
            },
            { assertCanCommit: target.assertGenerationOpen },
          ),
        );
      } catch (err) {
        if (sendActivityGateError(res, err)) return;
        if (sendGenerationClosedError(res, err)) return;
        writeStderrLine(
          `qwen serve: POST ${base}/${id}/run failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        res.status(500).json({
          error: 'Failed to record scheduled task run',
          code: 'scheduled_tasks_write_failed',
        });
        return;
      }
      if (rollbackBefore && rollbackAfter) {
        try {
          target.assertGenerationOpen?.();
        } catch (error) {
          await rollbackCronMutation(
            target,
            rollbackBefore,
            rollbackAfter,
            `POST ${base}/${id}/run`,
          );
          if (sendGenerationClosedError(res, error)) return;
          throw error;
        }
      }
      if (blockedLegacy) {
        res.status(409).json({
          error:
            'This task uses the removed isolated run mode with a precondition and can no longer run. Recreate it (and call the `create_sub_session` tool from the prompt if you need per-run isolation).',
          code: 'task_legacy_unsupported',
        });
        return;
      }
      if (blockedDisabled) {
        res.status(409).json({
          error:
            'Cannot run a disabled task; enable it first (unarchive its session if it was archived).',
          code: 'task_disabled',
        });
        return;
      }
      if (!found || !updated) {
        res
          .status(404)
          .json({ error: 'Task not found', code: 'task_not_found' });
        return;
      }
      if (updated.sessionMode === 'per_run') {
        const persistOutcome = async (outcome: CronRunSessionOutcome) => {
          if (!updated!.recurring) return;
          await runWithScheduledTaskTarget(target, () =>
            updateCronTasks(
              workspaceCwd,
              (tasks) =>
                tasks.map((task) =>
                  task.id === id
                    ? annotateCronRunSession(task, now, outcome)
                    : task,
                ),
              { assertCanCommit: target.assertGenerationOpen },
            ),
          );
        };
        let childSessionId: string;
        try {
          childSessionId = await dispatchTaskToFreshSession(target, updated);
        } catch (error) {
          updated = annotateCronRunSession(updated, now, {
            dispatchFailed: true,
          });
          if (updated.recurring) {
            await persistOutcome({ dispatchFailed: true }).catch(
              (persistError) => {
                // Matches the success path and rollbackCronMutation: a lost
                // marker leaves a run record indistinguishable from an
                // un-attributed run, so say so rather than swallowing it.
                writeStderrLine(
                  `qwen serve: POST ${base}/${id}/run could not record the failed dispatch: ${persistError instanceof Error ? persistError.message : String(persistError)}`,
                );
              },
            );
          } else {
            // The mutation above consumed this one-shot before dispatch so it
            // could not race its scheduled slot. A synchronous admission
            // failure means nothing ran, so put it back unconditionally — the
            // 500 below invites a retry, and a declined undo would answer that
            // retry with 404 for a schedule that never executed.
            await restoreConsumedOneShot(
              target,
              rollbackBefore,
              id,
              `POST ${base}/${id}/run fresh-session dispatch`,
            );
          }
          writeStderrLine(
            `qwen serve: POST ${base}/${id}/run could not create a fresh session: ${error instanceof Error ? error.message : String(error)}`,
          );
          res.status(500).json({
            error: 'Failed to create a fresh session for the scheduled task',
            code: 'scheduled_task_session_dispatch_failed',
          });
          return;
        }
        updated = annotateCronRunSession(updated, now, {
          sessionId: childSessionId,
        });
        await persistOutcome({ sessionId: childSessionId }).catch((error) => {
          writeStderrLine(
            `qwen serve: POST ${base}/${id}/run could not attribute fresh session ${childSessionId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      if (!updated.recurring && updated.sessionId) {
        channelDeliveryAuthorizations?.revokeScheduledTask(
          workspaceCwd,
          updated.sessionId,
          updated.id,
        );
      }
      const view = toView(updated);
      // A consumed one-shot was removed from the store — its manual run WAS its
      // single fire, so the returned view must not advertise a future nextRunAt on
      // an entity the next GET omits (the shipped dialog reloads, but an embedder
      // gets this object from the SDK).
      if (!updated.recurring) view.nextRunAt = null;
      res.status(200).json(view);
    }),
  );
}

/**
 * The primary (unqualified) `/scheduled-tasks` surface, bound to the daemon's
 * primary workspace. Every request resolves to the same fixed workspace + bridge.
 */
export function registerScheduledTasksRoutes(
  app: Application,
  deps: RegisterScheduledTasksRoutesDeps,
): void {
  const {
    boundWorkspace,
    mutate,
    safeBody,
    bridge,
    channelDeliveryAuthorizations,
  } = deps;
  registerScheduledTaskCrudRoutes(app, {
    prefix: '',
    resolveTarget: (_req, res) => {
      const runtime = deps.getRuntime?.();
      if (deps.getRuntime && !runtime) {
        res.set('Retry-After', '1');
        res.status(503).json({
          error: 'Workspace runtime is not active',
          code: 'workspace_runtime_unavailable',
        });
        return null;
      }
      if (runtime && !requireTrustedWorkspaceRuntime(runtime, res)) return null;
      return {
        workspaceCwd: boundWorkspace,
        ...(runtime
          ? {
              runtimeBaseDir: runtime.sessionRuntimeBaseDir,
              ...(deps.cleanupSession
                ? {
                    cleanupSession: (sessionId: string) =>
                      deps.cleanupSession!(runtime, sessionId),
                  }
                : {}),
            }
          : {}),
        // The runtime bridge only refines an ENABLED deps bridge; it must never
        // re-enable binding when deps `bridge` is undefined. server.ts passes
        // the bridge only when resident task-session management is on, and a
        // bound task must always have something to keep it resident + rehydrate
        // it — the same gate the qualified surface enforces below.
        bridge: bridge === undefined ? undefined : (runtime?.bridge ?? bridge),
        ...(runtime?.generationGuard
          ? {
              assertGenerationOpen: () => runtime.generationGuard?.assertOpen(),
            }
          : {}),
        ...(deps.workspaceRegistry
          ? {
              resolveLiveSessionOwner: (sessionId: string) =>
                deps.workspaceRegistry!.resolveLiveSessionOwner(sessionId),
            }
          : {}),
      };
    },
    mutate,
    safeBody,
    channelDeliveryAuthorizations,
  });
}

/**
 * The workspace-qualified `/workspaces/:workspace/scheduled-tasks` surface. Each
 * request resolves `:workspace` (a workspace id or absolute path) to a
 * registered runtime, requiring it be trusted before any read or write — the
 * same gate the other qualified routes use — then targets that workspace's cron
 * file and, when session management is on, its bridge. Lets a multi-workspace
 * Web Shell manage every registered project's schedule, not just the primary's.
 */
export function registerWorkspaceQualifiedScheduledTasksRoutes(
  app: Application,
  deps: RegisterWorkspaceQualifiedScheduledTasksRoutesDeps,
): void {
  const {
    workspaceRegistry,
    mutate,
    safeBody,
    manageScheduledTaskSessions,
    channelDeliveryAuthorizations,
    cleanupSession,
  } = deps;
  registerScheduledTaskCrudRoutes(app, {
    prefix: '/workspaces/:workspace',
    resolveTarget: (req, res) => {
      const runtime = resolveWorkspaceRuntimeWithLiveCompatibilityFromParam(
        workspaceRegistry,
        req,
        res,
      );
      if (!runtime) return null;
      if (!requireTrustedWorkspaceRuntime(runtime, res)) return null;
      if (
        runtime.provenance === 'live-conversation' &&
        !deps.conversationRuntimeActivity
      ) {
        sendConversationRuntimeUnavailable(res);
        return null;
      }
      if (
        runtime.provenance === 'live-conversation' &&
        req.method === 'POST' &&
        req.params['id'] === undefined &&
        parseCallerSuppliedSessionId(safeBody(req)['sessionId']).kind ===
          'absent'
      ) {
        res.status(400).json({
          error:
            'Generic scheduled tasks cannot create sessions in the Conversations workspace.',
          code: 'live_session_creation_reserved',
        });
        return null;
      }
      return {
        workspaceCwd: runtime.workspaceCwd,
        runtimeBaseDir: runtime.sessionRuntimeBaseDir,
        ...(runtime.provenance === 'live-conversation' &&
        deps.conversationRuntimeActivity
          ? { activity: deps.conversationRuntimeActivity }
          : {}),
        ...(cleanupSession
          ? {
              cleanupSession: (sessionId: string) =>
                cleanupSession(runtime, sessionId),
            }
          : {}),
        // Mirror the primary surface: only bind a session when management is on,
        // so a bound task always has something to keep it resident + rehydrate it.
        bridge: manageScheduledTaskSessions ? runtime.bridge : undefined,
        ...(runtime.generationGuard
          ? {
              assertGenerationOpen: () => runtime.generationGuard?.assertOpen(),
            }
          : {}),
        resolveLiveSessionOwner: (sessionId: string) =>
          workspaceRegistry.resolveLiveSessionOwner(sessionId),
      };
    },
    mutate,
    safeBody,
    channelDeliveryAuthorizations,
  });
}

/**
 * Fields that a previous version accepted but this one has removed (the
 * isolated run mode and its precondition). A body that still carries one comes
 * from a stale SDK, a cached Web Shell, or a hand-written client that believes
 * it is installing a per-run / guarded task. Left unvalidated they would be
 * ignored as unknown keys and the caller would silently get a plain,
 * unconditional shared task — a materially different task from the one it asked
 * for. Detected on both POST and PATCH so those clients fail closed.
 */
const REMOVED_TASK_FIELDS = ['runMode', 'condition'] as const;

function findRemovedTaskField(
  body: Record<string, unknown>,
): (typeof REMOVED_TASK_FIELDS)[number] | undefined {
  return REMOVED_TASK_FIELDS.find((field) => field in body);
}

function removedFieldError(field: string): { error: string; code: string } {
  return {
    error: `\`${field}\` is no longer supported: the isolated scheduled-task run mode was removed. Every task now runs in its bound session; call the \`create_sub_session\` tool from the task prompt for per-run isolation.`,
    code: 'unsupported_field',
  };
}

/**
 * Parses an optional `name` field. Accepts:
 *  - absent / null / empty-string → `{ value: undefined }` (unnamed / clear)
 *  - a non-empty string within the length cap → `{ value: trimmed }`
 *  - anything else → `{ error }`
 */
function parseNameField(raw: unknown): { value?: string; error?: string } {
  if (raw === undefined || raw === null) return { value: undefined };
  if (typeof raw !== 'string') {
    return { error: '`name` must be a string' };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { value: undefined };
  if (trimmed.length > MAX_NAME_LENGTH) {
    return { error: `\`name\` exceeds ${MAX_NAME_LENGTH}-character limit` };
  }
  return { value: trimmed };
}

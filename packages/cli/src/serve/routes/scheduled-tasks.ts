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
  taskHasLegacyCondition,
  parseCron,
  nextFireTime,
  nextDurableFireMs,
  SessionService,
  Storage,
  stripTerminalControlSequences,
  MAX_JOBS,
  type CronTaskDelivery,
  type DurableCronTask,
  type CronTaskRun,
  type SessionLocation,
} from '@qwen-code/qwen-code-core';
import { SessionNotFoundError } from '@qwen-code/acp-bridge/bridgeErrors';
import { canonicalizeWorkspace } from '@qwen-code/acp-bridge/workspacePaths';
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

// The per-file create cap, shared with the scheduler's MAX_JOBS. The scheduler
// caps DURABLE loads against a durable-only budget of MAX_JOBS (independent of
// session-only jobs), so a task accepted here is always loadable — no silent
// "created but never fires". Rejecting past the cap returns a clean 409.
const MAX_SCHEDULED_TASKS = MAX_JOBS;
const MAX_PROMPT_LENGTH = 100_000;
const MAX_NAME_LENGTH = 200;
const MAX_CRON_LENGTH = 200;

/**
 * The slice of the session bridge this route needs: mint a task's dedicated
 * session, and tear it back down if the create fails after minting. Narrowed
 * to a structural type so tests can stub it without the full bridge.
 */
export interface ScheduledTasksSessionBridge {
  spawnOrAttach(req: {
    workspaceCwd: string;
    sessionScope?: 'single' | 'thread';
    sourceType?: string;
    sourceId?: string;
  }): Promise<{ sessionId: string }>;
  closeSession(sessionId: string): Promise<unknown>;
  /** Advance the in-memory session-catalog revision after a successful
   * persisted removal driven by task cleanup. Optional so existing
   * structural test fakes stay source-compatible; the production bridge
   * always provides it. */
  markSessionCatalogChanged?(): void;
  /** Give the task's session a readable name so it's recognizable in the
   * session list (rather than a bare id). Best-effort. */
  updateSessionMetadata(
    sessionId: string,
    metadata: { displayName?: string },
  ): unknown;
  /** Live summary for one session by id. Throws `SessionNotFoundError` when
   * no live session with that id exists on this daemon. Used to validate a
   * caller-provided session (workspace, idle) before binding it to a new
   * task. Archiving removes a session from the live map, so archived (and
   * otherwise persisted-but-not-live) ids surface as `SessionNotFoundError`
   * and are classified by the route's on-disk location probe instead. */
  getSessionSummary(sessionId: string): {
    workspaceCwd: string;
    hasActivePrompt: boolean;
  };
}

// Cap for the derived session display name — a session label, not the full
// prompt (which can be up to MAX_PROMPT_LENGTH).
const MAX_SESSION_NAME_LENGTH = 60;

/** Builds a readable session name for a task from its name (or prompt), marked
 * with a clock so scheduled-task sessions are recognizable in the list. Strips
 * terminal control sequences (C0/C1/DEL/ANSI) — the bridge's title guard REJECTS
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
  return `⏰ ${short}`;
}

/**
 * The workspace a scheduled-task request operates on: the cron file lives under
 * `workspaceCwd`, and `bridge` mints/tears down the task's bound session. A
 * missing bridge means tasks are created unbound (shared per-project
 * durable-owner firing) — the same fallback a bridge-less embedding gets.
 */
interface ScheduledTaskTarget {
  workspaceCwd: string;
  runtimeBaseDir?: string;
  bridge?: ScheduledTasksSessionBridge;
  cleanupSession?: (sessionId: string) => Promise<unknown>;
  assertGenerationOpen?: () => void;
  activity?: ConversationRuntimeActivityGate;
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
   * Session bridge used to mint a dedicated session per task. When absent
   * (e.g. a minimal embedding), tasks are created without a bound session and
   * fall back to the shared per-project durable-owner firing model.
   */
  bridge?: ScheduledTasksSessionBridge;
  channelDeliveryAuthorizations?: ChannelDeliveryAuthorizationStore;
  getRuntime?: () => WorkspaceRuntime | undefined;
  cleanupSession?: (
    runtime: WorkspaceRuntime,
    sessionId: string,
  ) => Promise<unknown>;
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
      const sessionIdResult = parseSessionIdField(body['sessionId']);
      if (sessionIdResult.error) {
        res
          .status(400)
          .json({ error: sessionIdResult.error, code: 'invalid_session_id' });
        return;
      }
      const providedSessionId = sessionIdResult.value;
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
      const removedField = findRemovedTaskField(body);
      if (removedField) {
        res.status(400).json(removedFieldError(removedField));
        return;
      }
      const recurring = body['recurring'] !== false;
      const enabled = body['enabled'] !== false;
      const taskId = generateCronTaskId();

      // Bind the task's session up front. The task is BOUND to it and fires
      // only inside it — its transcript becomes the task's run history, and
      // archiving/deleting the session stops the task. Done before the write
      // so a task never lands on disk without its session; if the bridge is
      // absent (minimal embedding) the task is created unbound (shared-owner
      // firing).
      //
      // Two binding modes:
      //  - no `sessionId` in the body: mint a DEDICATED session (the original
      //    behavior), torn back down if the create can't be committed;
      //  - `sessionId` provided: REUSE that existing session after validating
      //    it (live in this workspace, idle, not archived, not already bound
      //    to another task). It pre-existed the task, so a failed create must
      //    leave it open; after a successful create it follows the regular
      //    scheduled-task session lifecycle.
      //
      // `sessionScope: 'thread'` is REQUIRED for the mint path: the daemon's
      // default scope is 'single', which would attach to (and reuse) the
      // shared workspace session instead of minting a fresh one. Two tasks —
      // or a task and an open chat — would then bind to the same session: the
      // task renames it, scheduled runs land in the wrong transcript, and
      // deleting one task closes the shared session. Forcing 'thread'
      // guarantees each minted task session is isolated.
      let boundSessionId: string | undefined;
      // True only when THIS route minted the bound session (and must tear it
      // back down if the create fails). False for a caller-provided session.
      let sessionMintedHere = false;
      // Best-effort ⏰ rename shared by both binding modes — the mint path
      // calls it before the cron write, the reuse path strictly after commit
      // (that timing difference is the intentional part and stays at the
      // call sites). One copy so the naming payload can't drift between
      // minted and reused task sessions.
      const nameBoundSession = async () => {
        if (!bridge) return;
        try {
          await runWithScheduledTaskTarget(target, async () =>
            bridge.updateSessionMetadata(boundSessionId!, {
              displayName: scheduledTaskSessionName(nameResult.value ?? prompt),
            }),
          );
        } catch {
          // metadata update is non-critical — a rename failure must not fail
          // the create; the keepalive names bound sessions anyway.
        }
      };
      if (providedSessionId !== undefined && !bridge) {
        // Fail closed: silently creating an UNBOUND task would give the caller
        // a materially different task from the one it asked for.
        res.status(409).json({
          error:
            'Session management is not available for this workspace; omit `sessionId` to create an unbound task',
          code: 'session_binding_unavailable',
        });
        return;
      }
      if (bridge) {
        if (providedSessionId !== undefined) {
          // Validate the caller's session BEFORE any write.
          // Two lookup failures share one response shape; keep the body in
          // one place so the copies can't drift.
          const sendSessionLookupFailed = (detail: string, err: unknown) => {
            writeStderrLine(
              `qwen serve: POST ${base} ${detail} '${providedSessionId}': ${err instanceof Error ? err.message : String(err)}`,
            );
            res.status(500).json({
              error: 'Failed to look up the requested session',
              code: 'scheduled_tasks_session_failed',
            });
          };
          let summary: {
            workspaceCwd: string;
            hasActivePrompt: boolean;
          };
          try {
            summary = await runWithScheduledTaskTarget(target, () =>
              bridge.getSessionSummary(providedSessionId),
            );
          } catch (err) {
            if (err instanceof SessionNotFoundError) {
              // Archiving removes a session from the live map first, and
              // persisted-but-not-live sessions (the routine state after a
              // daemon restart or idle reaping) are absent from it too.
              // Probe the persisted location so every on-disk state reaches
              // the caller as a machine-actionable classification; only an
              // id with nothing on disk is genuinely gone (404).
              const sessionService = new SessionService(workspaceCwd, {
                runtimeBaseDir: target.runtimeBaseDir,
              });
              let location: SessionLocation;
              try {
                location = await runWithScheduledTaskTarget(target, () =>
                  sessionService.getSessionLocation(providedSessionId),
                );
                if (location === undefined) {
                  // Legacy CLI sessions may be persisted with an uppercase
                  // UUID spelling while caller ids are canonicalized to
                  // lowercase; mirror session-id-admission's fallback so
                  // those still resolve on case-sensitive filesystems.
                  const legacyId = await runWithScheduledTaskTarget(
                    target,
                    () =>
                      sessionService.findSessionIdIgnoringCase(
                        providedSessionId,
                      ),
                  );
                  if (legacyId !== undefined) {
                    location = await runWithScheduledTaskTarget(target, () =>
                      sessionService.getSessionLocation(legacyId),
                    );
                  }
                }
              } catch (err) {
                // Both probe helpers swallow ENOENT themselves and rethrow
                // every other filesystem error (EACCES/EIO/ESTALE/…), so a
                // throw here is a real failure, not "genuinely gone" — answer
                // a retryable 500 instead of misreporting an existing session
                // as 404 session_not_found (and log it, unlike a true miss).
                sendSessionLookupFailed(
                  'failed to probe persisted session state',
                  err,
                );
                return;
              }
              if (location === 'archived') {
                res.status(409).json({
                  error:
                    'The requested session is archived; unarchive it before binding it to a task',
                  code: 'session_archived',
                });
                return;
              }
              if (location === 'active' || location === 'conflict') {
                // The session exists on disk but is not live on this daemon
                // (only task-bound sessions are rehydrated at startup).
                // Reserve 404 for ids that are genuinely gone so clients
                // branching on `session_not_found` are not told an existing
                // resumable session does not exist.
                res.status(409).json({
                  error:
                    'The requested session is not live on this daemon; load it before binding it to a task',
                  code:
                    location === 'conflict'
                      ? 'session_conflict'
                      : 'session_not_live',
                });
                return;
              }
              res.status(404).json({
                error: `Session '${providedSessionId}' was not found`,
                code: 'session_not_found',
              });
              return;
            }
            sendSessionLookupFailed('failed to look up session', err);
            return;
          }
          let sameWorkspace = false;
          try {
            sameWorkspace =
              canonicalizeWorkspace(summary.workspaceCwd) ===
              canonicalizeWorkspace(workspaceCwd);
          } catch (err) {
            // canonicalizeWorkspace swallows ENOENT itself; anything thrown
            // here is a real filesystem failure (EACCES/EIO/ELOOP/ESTALE).
            // Surface it as a retryable 500 instead of a misleading
            // workspace-mismatch 400.
            sendSessionLookupFailed(
              'failed to resolve workspace paths for session',
              err,
            );
            return;
          }
          if (!sameWorkspace) {
            // Unreachable under production daemon wiring — one bridge serves
            // exactly one workspace runtime, so a cross-workspace id throws
            // SessionNotFoundError and is answered above before this runs.
            // Kept as a defense for the structural bridge interface (a
            // multi-workspace embedder can serve foreign sessions here).
            res.status(400).json({
              error:
                "The requested session belongs to a different workspace; use that workspace's scheduled-task endpoint",
              code: 'session_workspace_mismatch',
            });
            return;
          }
          if (summary.hasActivePrompt) {
            res.status(409).json({
              error:
                'The requested session is busy; wait for its active prompt to finish before binding it to a task',
              code: 'session_busy',
            });
            return;
          }
        }
        // Pre-check the cap (and duplicate binding, for a caller-provided
        // session) BEFORE spawning: an over-cap create must not spawn a
        // session it will immediately tear down, because closeSession removes
        // the live bridge entry but can leave the just-spawned+named session
        // listed as an orphan with no owning task. Best-effort — the
        // write-lock checks below stay authoritative for the concurrent race.
        try {
          const existingTasks = await runWithScheduledTaskTarget(target, () =>
            readCronTasks(workspaceCwd),
          );
          if (existingTasks.length >= MAX_SCHEDULED_TASKS) {
            res.status(409).json({
              error: `Maximum number of scheduled tasks (${MAX_SCHEDULED_TASKS}) reached`,
              code: 'max_tasks_reached',
            });
            return;
          }
          if (
            providedSessionId !== undefined &&
            existingTasks.some((t) => t.sessionId === providedSessionId)
          ) {
            res.status(409).json({
              error:
                'The requested session is already bound to another scheduled task',
              code: 'session_already_bound',
            });
            return;
          }
        } catch {
          // Read failure → skip the pre-check; the write below is authoritative.
        }
        if (!requireOpenGeneration(target, res)) return;
        if (providedSessionId !== undefined) {
          // Reuse the caller's session — no spawn (sessionMintedHere stays
          // false, so a failed create leaves it open). The ⏰ rename happens
          // only AFTER the cron write commits (below): a create that fails
          // after renaming would leave the caller's pre-existing session
          // permanently named "⏰ …" with no owning task, because
          // rollbackSession never touches caller sessions and nothing else
          // restores the prior display name.
          boundSessionId = providedSessionId;
        } else {
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
            // Name the session after the task so it's recognizable in the session
            // list. Best-effort — a nameless session still fires correctly.
            await nameBoundSession();
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
        ...(delivery !== undefined ? { delivery } : {}),
        ...(boundSessionId !== undefined
          ? {
              sessionId: boundSessionId,
              // Persist WHO owns the bound session: DELETE may only tear down
              // sessions the task itself minted — a caller-provided session
              // pre-existed the task and must survive its deletion.
              sessionOwnedByTask: sessionMintedHere,
            }
          : {}),
        ...(nameResult.value !== undefined ? { name: nameResult.value } : {}),
      };

      // Best-effort teardown of the just-minted session when the create can't be
      // committed. closeSession only tears down the live child; removeSession also
      // deletes the persisted transcript/title record — both are needed, or a
      // rejected create (the loser of a concurrent create at the cap boundary,
      // which passes the pre-check but loses the authoritative write) would leave
      // a named "⏰ …" session in the list with no owning task. A caller-provided
      // session is NEVER torn down here — it pre-existed the task and must stay
      // open when the create fails.
      const rollbackSession = async () => {
        if (boundSessionId !== undefined && sessionMintedHere) {
          await teardownBoundSession(target, boundSessionId);
        }
      };

      let overCap = false;
      let alreadyBound = false;
      let sessionGoneUnderLock = false;
      let rollbackBefore: DurableCronTask[] | undefined;
      let rollbackAfter: DurableCronTask[] | undefined;
      try {
        await runWithScheduledTaskTarget(target, () =>
          updateCronTasks(
            workspaceCwd,
            (tasks) => {
              // Same-lock duplicate-binding check in BOTH binding modes: the
              // pre-check read above is best-effort, and a concurrent create
              // may have bound the same session since. For a caller-provided
              // session that's another reuse-create; for a just-minted one
              // it's a reuse-create that committed while this request's mint
              // was still in flight (the mint registers the session in the
              // live map before THIS write commits, so the reuse path's
              // validation can pass against it). Runs before the cap check so
              // an over-cap loser never tears down a session another
              // committed task already references.
              if (
                boundSessionId !== undefined &&
                tasks.some((t) => t.sessionId === boundSessionId)
              ) {
                alreadyBound = true;
                return tasks;
              }
              // Re-validate a caller-provided session UNDER the write lock:
              // archiving/deleting tears the session out of the live map
              // BEFORE its cron hook (disable/removeTasksForSessions) runs,
              // and that hook only sees tasks already on disk — so a session
              // that left the live map between the pre-lock validation and
              // this cycle is being archived/deleted and its hook skipped
              // this (not yet written) task. Committing anyway would bind a
              // 201-returned task to an archived or gone session. Cron write
              // cycles are serialized, so a hook that runs after THIS cycle
              // sees the new task and disables/removes it correctly.
              if (providedSessionId !== undefined && bridge) {
                try {
                  bridge.getSessionSummary(providedSessionId);
                } catch (err) {
                  if (err instanceof SessionNotFoundError) {
                    sessionGoneUnderLock = true;
                    return tasks; // no write
                  }
                  throw err;
                }
              }
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
      if (sessionGoneUnderLock) {
        // Reuse mode only — a caller-provided session is never torn down
        // here, so there is nothing to roll back. Retryable: the session's
        // archive/delete completed between validation and commit.
        res.status(409).json({
          error:
            'The requested session was archived or deleted while the task was being created; retry with a live session',
          code: 'session_not_live',
        });
        return;
      }
      if (alreadyBound) {
        // NO rollbackSession here: the in-lock check fires only when a
        // COMMITTED task already references the bound session. For a
        // just-minted session that means a concurrent reuse-create won the
        // race and owns it — tearing it down would kill that task's session.
        // (For a caller-provided session rollbackSession is a no-op anyway.)
        res.status(409).json({
          error:
            'The requested session is already bound to another scheduled task',
          code: 'session_already_bound',
        });
        return;
      }
      if (providedSessionId !== undefined && bridge) {
        // Name the reused session after the task — like a minted one, but
        // strictly AFTER the cron write commits, so no failure path leaves
        // the caller's pre-existing session renamed with no owning task.
        await nameBoundSession();
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
      if (Object.keys(patch).length === 0 && !clearName && !clearDelivery) {
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
      if (bridge && updated.sessionId && effectiveLabelChanged) {
        try {
          bridge.updateSessionMetadata(updated.sessionId, {
            displayName: scheduledTaskSessionName(
              updated.name ?? updated.prompt,
            ),
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
      // session the task itself minted exists only to run it, so it's torn
      // down after; a caller-provided session pre-existed the task and stays
      // open (the persisted sessionOwnedByTask marker tells the two apart).
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
                // Absent marker = written before ownership was persisted; every
                // session bindable then was task-minted, so keep tearing down.
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
      // Stop a task-minted session (keeps its transcript on disk as history).
      // A caller-provided session is NEVER closed here — it pre-existed the
      // task, may be the user's live working session, and must survive the
      // task's deletion (same invariant the create path's rollback honors).
      if (boundSessionId && sessionOwnedByTask && bridge) {
        // Re-read just before teardown: between the removal commit above and
        // this close, a concurrent reuse-create can bind THIS session (its
        // in-lock duplicate check legitimately passes once the old task is
        // gone) — from that task's perspective the session IS caller-provided
        // and must survive. Closing on the stale capture would tear down the
        // surviving task's live session mid-use. Best-effort: a rebind that
        // commits between this re-read and the close still slips through;
        // fully closing that window needs session-scoped serialization shared
        // with the bind path (tracked as follow-up). A read failure falls
        // back to the pre-recheck behavior (close).
        let claimedBySurvivingTask = false;
        try {
          const currentTasks = await runWithScheduledTaskTarget(target, () =>
            readCronTasks(workspaceCwd),
          );
          claimedBySurvivingTask = currentTasks.some(
            (t) => t.sessionId === boundSessionId,
          );
        } catch {
          // Read failure → keep the historical behavior (close the session).
        }
        if (!claimedBySurvivingTask) {
          try {
            await runWithScheduledTaskTarget(target, () =>
              bridge.closeSession(boundSessionId!),
            );
          } catch (error) {
            if (sendActivityGateError(res, error)) return;
          }
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

  // ── Record a manual run ───────────────────────────────────────────
  // Marks the task as run *now* (updates lastFiredAt + appends a 'manual' run
  // record) so the management UI's "last run" reflects a manual trigger. The
  // prompt itself is executed by the client in the task's bound session; this
  // route only records that a run happened, keeping manual and scheduled runs
  // consistent in the history.
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
                  ...(current.sessionId
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
        bridge: runtime?.bridge ?? bridge,
        ...(runtime?.generationGuard
          ? {
              assertGenerationOpen: () => runtime.generationGuard?.assertOpen(),
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
        req.params['id'] === undefined
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

/**
 * Parses the optional `sessionId` field on POST (reuse an existing session
 * instead of minting a dedicated one). Accepts:
 *  - absent / null → `{ value: undefined }` (mint a dedicated session)
 *  - a valid caller-supplied session id → `{ value }`, canonicalized through
 *    the same parser every other caller-supplied-session-id surface uses
 *    (`parseCallerSuppliedSessionId`: UUID grammar, case-normalized,
 *    length-bounded by the grammar — no unbounded echo in error bodies or
 *    stderr, and duplicate-binding equality holds per session, not per
 *    spelling)
 *  - anything else (including empty/whitespace-only strings — a session id
 *    can't be "cleared", so unlike `name` they're an error) → `{ error }`
 */
function parseSessionIdField(raw: unknown): {
  value?: string;
  error?: string;
} {
  const parsed = parseCallerSuppliedSessionId(
    typeof raw === 'string' ? raw.trim() : raw,
  );
  if (parsed.kind === 'absent') return { value: undefined };
  if (parsed.kind === 'invalid') {
    // Same actionable grammar hint as the sibling caller-id surfaces
    // (POST /session and ACP session/new), so a malformed id gets one
    // consistent, machine-translatable answer everywhere.
    return {
      error:
        '`sessionId` must be an RFC UUID v1-v5 (e.g. "550e8400-e29b-41d4-a716-446655440000")',
    };
  }
  return { value: parsed.sessionId };
}

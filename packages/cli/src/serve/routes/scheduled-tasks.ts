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
 */

import type { Application, Request, RequestHandler } from 'express';
import {
  readCronTasks,
  updateCronTasks,
  removeCronTasks,
  generateCronTaskId,
  appendCronRun,
  parseCron,
  nextFireTime,
  MAX_JOBS,
  type DurableCronTask,
  type CronTaskRun,
} from '@qwen-code/qwen-code-core';
import { writeStderrLine } from '../../utils/stdioHelpers.js';

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
  spawnOrAttach(req: { workspaceCwd: string }): Promise<{ sessionId: string }>;
  closeSession(sessionId: string): Promise<unknown>;
  /** Give the task's session a readable name so it's recognizable in the
   * session list (rather than a bare id). Best-effort. */
  updateSessionMetadata(
    sessionId: string,
    metadata: { displayName?: string },
  ): unknown;
}

// Cap for the derived session display name — a session label, not the full
// prompt (which can be up to MAX_PROMPT_LENGTH).
const MAX_SESSION_NAME_LENGTH = 60;

/** Builds a readable session name for a task from its name (or prompt), marked
 * with a clock so scheduled-task sessions are recognizable in the list. */
export function scheduledTaskSessionName(label: string): string {
  const trimmed = label.trim().replace(/\s+/g, ' ');
  const short =
    trimmed.length > MAX_SESSION_NAME_LENGTH
      ? `${trimmed.slice(0, MAX_SESSION_NAME_LENGTH - 1)}…`
      : trimmed;
  return `⏰ ${short}`;
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
}

/** Next scheduled fire (epoch ms) for an enabled task, or null when the task
 * is disabled (it won't fire) or its cron can't be projected. A GET-time
 * snapshot the client counts down against — kept server-side so every cron
 * shape (including hand-written ones) uses core's single next-fire authority,
 * with no cron parser shipped to the browser. */
function computeNextRunAt(task: DurableCronTask): number | null {
  if (task.enabled === false) return null;
  try {
    return nextFireTime(task.cron, new Date()).getTime();
  } catch {
    return null;
  }
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
    enabled: task.enabled !== false,
    createdAt: task.createdAt,
    lastFiredAt: task.lastFiredAt,
    nextRunAt: computeNextRunAt(task),
    // The task's bound session (its run-history transcript), or null for an
    // unbound tool-created/legacy task.
    sessionId:
      typeof task.sessionId === 'string' && task.sessionId.length > 0
        ? task.sessionId
        : null,
    // Absent runs (tool-created / never-fired) normalizes to [] so the client
    // never special-cases undefined.
    runs: Array.isArray(task.runs) ? task.runs : [],
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

export function registerScheduledTasksRoutes(
  app: Application,
  deps: RegisterScheduledTasksRoutesDeps,
): void {
  const { boundWorkspace, mutate, safeBody, bridge } = deps;

  // ── List ──────────────────────────────────────────────────────────
  app.get('/scheduled-tasks', async (_req, res) => {
    try {
      const tasks = await readCronTasks(boundWorkspace);
      res.status(200).json({ v: 1, tasks: tasks.map(toView) });
    } catch (err) {
      // A malformed/corrupt file throws (fix-or-delete contract) rather than
      // reading as empty — surface it instead of hiding the user's tasks
      // behind a silent [].
      writeStderrLine(
        `qwen serve: GET /scheduled-tasks failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.status(500).json({
        error: 'Failed to read scheduled tasks (the tasks file may be corrupt)',
        code: 'scheduled_tasks_read_failed',
      });
    }
  });

  // ── Create ────────────────────────────────────────────────────────
  app.post('/scheduled-tasks', mutate(), async (req, res) => {
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
    if (body['enabled'] !== undefined && typeof body['enabled'] !== 'boolean') {
      res.status(400).json({
        error: '`enabled` must be a boolean',
        code: 'invalid_enabled',
      });
      return;
    }
    const recurring = body['recurring'] !== false;
    const enabled = body['enabled'] !== false;

    // Mint the task's dedicated session up front. The task is BOUND to it and
    // fires only inside it — its transcript becomes the task's run history, and
    // archiving/deleting the session stops the task. Done before the write so a
    // task never lands on disk without its session; if the bridge is absent
    // (minimal embedding) the task is created unbound (shared-owner firing).
    let boundSessionId: string | undefined;
    if (bridge) {
      try {
        const session = await bridge.spawnOrAttach({
          workspaceCwd: boundWorkspace,
        });
        boundSessionId = session.sessionId;
        // Name the session after the task so it's recognizable in the session
        // list. Best-effort — a nameless session still fires correctly.
        try {
          bridge.updateSessionMetadata(boundSessionId, {
            displayName: scheduledTaskSessionName(nameResult.value ?? prompt),
          });
        } catch {
          // metadata update is non-critical
        }
      } catch (err) {
        writeStderrLine(
          `qwen serve: POST /scheduled-tasks failed to create the task's session: ${err instanceof Error ? err.message : String(err)}`,
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
      id: generateCronTaskId(),
      cron,
      prompt,
      recurring,
      createdAt: now,
      // Pin to the creation minute so the scheduler can't fire during the
      // minute the task was created — same guard cronScheduler.create uses.
      lastFiredAt: now - (now % 60_000),
      enabled,
      ...(boundSessionId !== undefined ? { sessionId: boundSessionId } : {}),
      ...(nameResult.value !== undefined ? { name: nameResult.value } : {}),
    };

    // Best-effort teardown of the just-minted session when the create can't be
    // committed, so a rejected create doesn't leak a resident session.
    const rollbackSession = async () => {
      if (boundSessionId !== undefined && bridge) {
        await bridge.closeSession(boundSessionId).catch(() => {});
      }
    };

    let overCap = false;
    try {
      await updateCronTasks(boundWorkspace, (tasks) => {
        // Cap check under the write lock so two concurrent creates can't both
        // slip past a stale count. Returning the input unchanged is a no-op
        // (no write), which the flag below turns into a 409.
        if (tasks.length >= MAX_SCHEDULED_TASKS) {
          overCap = true;
          return tasks;
        }
        return [...tasks, task];
      });
    } catch (err) {
      await rollbackSession();
      writeStderrLine(
        `qwen serve: POST /scheduled-tasks failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.status(500).json({
        error: 'Failed to create scheduled task',
        code: 'scheduled_tasks_write_failed',
      });
      return;
    }
    if (overCap) {
      await rollbackSession();
      res.status(409).json({
        error: `Maximum number of scheduled tasks (${MAX_SCHEDULED_TASKS}) reached`,
        code: 'max_tasks_reached',
      });
      return;
    }
    res.status(201).json(toView(task));
  });

  // ── Update (name / enabled / cron / prompt / recurring) ────────────
  app.patch('/scheduled-tasks/:id', mutate(), async (req, res) => {
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

    if ('cron' in body) {
      const cron = typeof body['cron'] === 'string' ? body['cron'].trim() : '';
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
          error: '`prompt` must be a non-empty string within the length limit',
          code: 'invalid_prompt',
        });
        return;
      }
      patch.prompt = prompt;
    }
    if ('name' in body) {
      const nameResult = parseNameField(body['name']);
      if (nameResult.error) {
        res.status(400).json({ error: nameResult.error, code: 'invalid_name' });
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

    if (Object.keys(patch).length === 0 && !clearName) {
      res.status(400).json({
        error: 'No updatable fields provided',
        code: 'empty_patch',
      });
      return;
    }

    let found = false;
    let updated: DurableCronTask | undefined;
    try {
      await updateCronTasks(boundWorkspace, (tasks) => {
        const idx = tasks.findIndex((t) => t.id === id);
        if (idx === -1) return tasks; // not found → no write
        found = true;
        const current = tasks[idx]!;
        const next: DurableCronTask = { ...current, ...patch };
        // `name: null/""` clears the field rather than storing an empty name,
        // so toView reports it as unnamed and isValidTask never sees a "".
        if (clearName) delete next.name;
        // Re-enabling a recurring task resumes it from now instead of catching
        // up the fires it "missed" while disabled — which would run prompts the
        // user intentionally paused. Applied to every false→true transition,
        // including a task disabled before it ever ran, so its paused slot is
        // not treated as overdue on the next scheduler load. (The trade-off is
        // a re-enabled never-run task reads "last run: now" rather than "never
        // run" — a cosmetic edge, preferred over an unwanted real fire.)
        if (
          current.enabled === false &&
          patch.enabled === true &&
          next.recurring
        ) {
          const now = Date.now();
          next.lastFiredAt = now - (now % 60_000);
        }
        updated = next;
        return tasks.map((t, i) => (i === idx ? next : t));
      });
    } catch (err) {
      writeStderrLine(
        `qwen serve: PATCH /scheduled-tasks/${id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.status(500).json({
        error: 'Failed to update scheduled task',
        code: 'scheduled_tasks_write_failed',
      });
      return;
    }
    if (!found || !updated) {
      res.status(404).json({ error: 'Task not found', code: 'task_not_found' });
      return;
    }
    res.status(200).json(toView(updated));
  });

  // ── Delete ────────────────────────────────────────────────────────
  app.delete('/scheduled-tasks/:id', mutate(), async (req, res) => {
    const id = typeof req.params['id'] === 'string' ? req.params['id'] : '';
    if (id.length === 0) {
      res
        .status(400)
        .json({ error: 'Task id is required', code: 'invalid_id' });
      return;
    }
    // Capture the task's bound session before removal so it can be torn down —
    // the dedicated session exists only to run this task. Best-effort: a read
    // failure here just skips teardown; removeCronTasks below surfaces it.
    let boundSessionId: string | undefined;
    try {
      const existing = await readCronTasks(boundWorkspace);
      const match = existing.find((t) => t.id === id)?.sessionId;
      if (typeof match === 'string' && match.length > 0) boundSessionId = match;
    } catch {
      // ignore — the remove below re-reads and reports any corruption
    }

    let removed: number;
    try {
      removed = await removeCronTasks(boundWorkspace, [id]);
    } catch (err) {
      writeStderrLine(
        `qwen serve: DELETE /scheduled-tasks/${id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.status(500).json({
        error: 'Failed to delete scheduled task',
        code: 'scheduled_tasks_write_failed',
      });
      return;
    }
    if (removed === 0) {
      res.status(404).json({ error: 'Task not found', code: 'task_not_found' });
      return;
    }
    // Stop the now-orphaned session (keeps its transcript on disk as history).
    if (boundSessionId && bridge) {
      await bridge.closeSession(boundSessionId).catch(() => {});
    }
    res.status(200).json({ deleted: true, id });
  });

  // ── Record a manual run ───────────────────────────────────────────
  // Marks the task as run *now* (updates lastFiredAt + appends a 'manual' run
  // record) so the management UI's "last run" reflects a manual trigger. The
  // prompt itself is executed by the client in the task's bound session; this
  // route only records that a run happened, keeping manual and scheduled runs
  // consistent in the history.
  app.post('/scheduled-tasks/:id/run', mutate(), async (req, res) => {
    const id = typeof req.params['id'] === 'string' ? req.params['id'] : '';
    if (id.length === 0) {
      res
        .status(400)
        .json({ error: 'Task id is required', code: 'invalid_id' });
      return;
    }
    const now = Date.now();
    let found = false;
    let updated: DurableCronTask | undefined;
    try {
      await updateCronTasks(boundWorkspace, (tasks) => {
        const idx = tasks.findIndex((t) => t.id === id);
        if (idx === -1) return tasks; // not found → no write
        found = true;
        const current = tasks[idx]!;
        const next: DurableCronTask = {
          ...current,
          lastFiredAt: now,
          runs: appendCronRun(current.runs, {
            at: now,
            kind: 'manual',
            ...(current.sessionId ? { sessionId: current.sessionId } : {}),
          }),
        };
        updated = next;
        return tasks.map((t, i) => (i === idx ? next : t));
      });
    } catch (err) {
      writeStderrLine(
        `qwen serve: POST /scheduled-tasks/${id}/run failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.status(500).json({
        error: 'Failed to record scheduled task run',
        code: 'scheduled_tasks_write_failed',
      });
      return;
    }
    if (!found || !updated) {
      res.status(404).json({ error: 'Task not found', code: 'task_not_found' });
      return;
    }
    res.status(200).json(toView(updated));
  });
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

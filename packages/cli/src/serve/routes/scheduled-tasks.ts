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
  generateCronTaskId,
  appendCronRun,
  parseCron,
  nextFireTime,
  nextDurableFireMs,
  SessionService,
  stripTerminalControlSequences,
  MAX_JOBS,
  type DurableCronTask,
  type CronTaskMention,
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
  spawnOrAttach(req: {
    workspaceCwd: string;
    sessionScope?: 'single' | 'thread';
  }): Promise<{ sessionId: string }>;
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
  mentions?: CronTaskMention[];
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
    ...(Array.isArray(task.mentions) ? { mentions: task.mentions } : {}),
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

function parseMentionsField(value: unknown): {
  value?: CronTaskMention[];
  error?: string;
} {
  if (value === undefined) return {};
  if (!Array.isArray(value)) {
    return { error: '`mentions` must be an array' };
  }
  const mentions: CronTaskMention[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      return { error: '`mentions` entries must be objects' };
    }
    const mention = entry as Record<string, unknown>;
    const kind = mention['kind'];
    if (
      kind !== 'skill' &&
      kind !== 'mcp' &&
      kind !== 'extension' &&
      kind !== 'file'
    ) {
      return {
        error: '`mentions.kind` must be one of skill, mcp, extension, file',
      };
    }
    const id = mention['id'];
    const serialized = mention['serialized'];
    if (typeof id !== 'string' || id.trim().length === 0) {
      return { error: '`mentions.id` must be a non-empty string' };
    }
    if (typeof serialized !== 'string' || serialized.trim().length === 0) {
      return { error: '`mentions.serialized` must be a non-empty string' };
    }
    const label = mention['label'];
    if (label !== undefined && typeof label !== 'string') {
      return { error: '`mentions.label` must be a string' };
    }
    const valueField = mention['value'];
    if (valueField !== undefined && typeof valueField !== 'string') {
      return { error: '`mentions.value` must be a string' };
    }
    mentions.push({
      kind,
      id: id.trim(),
      serialized: serialized.trim(),
      ...(typeof label === 'string' ? { label: label.trim() } : {}),
      ...(typeof valueField === 'string' ? { value: valueField.trim() } : {}),
    });
  }
  return { value: mentions };
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

    const mentionsResult = parseMentionsField(body['mentions']);
    if (mentionsResult.error) {
      res
        .status(400)
        .json({ error: mentionsResult.error, code: 'invalid_mentions' });
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
    //
    // `sessionScope: 'thread'` is REQUIRED: the daemon's default scope is
    // 'single', which would attach to (and reuse) the shared workspace session
    // instead of minting a fresh one. Two tasks — or a task and an open chat —
    // would then bind to the same session: the task renames it, scheduled runs
    // land in the wrong transcript, and deleting one task closes the shared
    // session. Forcing 'thread' guarantees each task gets an isolated session.
    let boundSessionId: string | undefined;
    if (bridge) {
      // Pre-check the cap BEFORE spawning: an over-cap create must not spawn a
      // session it will immediately tear down, because closeSession removes the
      // live bridge entry but can leave the just-spawned+named session listed as
      // an orphan with no owning task. Best-effort — the write-lock cap check
      // below stays authoritative for the concurrent-create race.
      try {
        if (
          (await readCronTasks(boundWorkspace)).length >= MAX_SCHEDULED_TASKS
        ) {
          res.status(409).json({
            error: `Maximum number of scheduled tasks (${MAX_SCHEDULED_TASKS}) reached`,
            code: 'max_tasks_reached',
          });
          return;
        }
      } catch {
        // Read failure → skip the pre-check; the write below is authoritative.
      }
      try {
        const session = await bridge.spawnOrAttach({
          workspaceCwd: boundWorkspace,
          sessionScope: 'thread',
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
      ...(mentionsResult.value !== undefined
        ? { mentions: mentionsResult.value }
        : {}),
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
    // committed. closeSession only tears down the live child; removeSession also
    // deletes the persisted transcript/title record — both are needed, or a
    // rejected create (the loser of a concurrent create at the cap boundary,
    // which passes the pre-check but loses the authoritative write) would leave
    // a named "⏰ …" session in the list with no owning task.
    const rollbackSession = async () => {
      if (boundSessionId !== undefined && bridge) {
        await bridge.closeSession(boundSessionId).catch(() => {});
        await new SessionService(boundWorkspace)
          .removeSession(boundSessionId)
          .catch(() => {});
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
    if ('mentions' in body) {
      const mentionsResult = parseMentionsField(body['mentions']);
      if (mentionsResult.error) {
        res
          .status(400)
          .json({ error: mentionsResult.error, code: 'invalid_mentions' });
        return;
      }
      patch.mentions = mentionsResult.value ?? [];
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
    let blockedByArchive = false;
    try {
      await updateCronTasks(boundWorkspace, (tasks) => {
        const idx = tasks.findIndex((t) => t.id === id);
        if (idx === -1) return tasks; // not found → no write
        found = true;
        const current = tasks[idx]!;
        // A task disabled BY archiving its session (`disabledByArchive`) can't
        // be re-enabled through this generic PATCH: its bound session is still
        // archived and can't fire, so flipping `enabled: true` here would show
        // an enabled task with a countdown that never runs. The task/session
        // lifecycle must stay coupled — the caller has to unarchive the session
        // (which clears the marker and reloads it). Reject and leave the file
        // untouched.
        if (patch.enabled === true && current.disabledByArchive === true) {
          blockedByArchive = true;
          return tasks; // no write
        }
        const next: DurableCronTask = { ...current, ...patch };
        // `name: null/""` clears the field rather than storing an empty name,
        // so toView reports it as unnamed and isValidTask never sees a "".
        if (clearName) delete next.name;
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
    if (blockedByArchive) {
      res.status(409).json({
        error:
          'This task was disabled by archiving its session; unarchive the session to re-enable it.',
        code: 'task_session_archived',
      });
      return;
    }
    if (!found || !updated) {
      res.status(404).json({ error: 'Task not found', code: 'task_not_found' });
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
          displayName: scheduledTaskSessionName(updated.name ?? updated.prompt),
        });
      } catch {
        // non-critical — the schedule change already persisted
      }
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
    // Single atomic read-modify-write: capture the task's bound session AND
    // remove it in one cycle, closing the TOCTOU window a separate
    // read-then-remove would open (and cutting three file reads to one). The
    // dedicated session exists only to run this task, so it's torn down after.
    let boundSessionId: string | undefined;
    let removed = false;
    try {
      await updateCronTasks(boundWorkspace, (tasks) => {
        const idx = tasks.findIndex((t) => t.id === id);
        if (idx === -1) return tasks; // not found → no write
        const match = tasks[idx]!.sessionId;
        if (typeof match === 'string' && match.length > 0) {
          boundSessionId = match;
        }
        removed = true;
        return tasks.filter((_, i) => i !== idx);
      });
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
    if (!removed) {
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
    // A manual run is stamped at its exact instant (not minute-rounded like a
    // scheduler fire): the scheduler compares slots as `slot > lastFiredAt`, so
    // a precise timestamp behaves correctly, and — unlike rounding — it can't
    // collide with the creation-minute anchor that describeLastRun reads as
    // "never run" when a task is run manually within its creation minute.
    const now = Date.now();
    let found = false;
    let blockedDisabled = false;
    let updated: DurableCronTask | undefined;
    try {
      await updateCronTasks(boundWorkspace, (tasks) => {
        const idx = tasks.findIndex((t) => t.id === id);
        if (idx === -1) return tasks; // not found → no write
        found = true;
        const current = tasks[idx]!;
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
            ...(current.sessionId ? { sessionId: current.sessionId } : {}),
          }),
        };
        updated = next;
        // A one-shot's manual run IS its single fire — remove it from the store
        // so the scheduler doesn't ALSO fire it at its original scheduled time
        // (its slot is still in the future, so stamping lastFiredAt=now wouldn't
        // stop that fire). The response still returns the recorded run.
        if (!current.recurring) {
          return tasks.filter((_, i) => i !== idx);
        }
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
    if (blockedDisabled) {
      res.status(409).json({
        error:
          'Cannot run a disabled task; enable it first (unarchive its session if it was archived).',
        code: 'task_disabled',
      });
      return;
    }
    if (!found || !updated) {
      res.status(404).json({ error: 'Task not found', code: 'task_not_found' });
      return;
    }
    const view = toView(updated);
    // A consumed one-shot was removed from the store — its manual run WAS its
    // single fire, so the returned view must not advertise a future nextRunAt on
    // an entity the next GET omits (the shipped dialog reloads, but an embedder
    // gets this object from the SDK).
    if (!updated.recurring) view.nextRunAt = null;
    res.status(200).json(view);
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

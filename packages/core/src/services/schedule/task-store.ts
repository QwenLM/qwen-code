/**
 * Global store for `/schedule` daemon tasks. Each task is a directory under
 * `~/.qwen/scheduled-tasks/<taskId>/`:
 *   - `SKILL.md`    — the definition (frontmatter + self-contained prompt),
 *                     the file the user reviews / git-manages. Written only by
 *                     `/schedule` edits, never by the daemon.
 *   - `state.json`  — daemon-owned runtime state (lastFiredAt / nextRunAt /
 *                     lastRunId / enabledOverride). Kept separate so firing a
 *                     task never rewrites the user's SKILL.md.
 *   - `runs/`       — per-run transcripts + summaries (written at fire time).
 *
 * The store is global (not per-project) so a single list spans every project;
 * each task carries its own `cwd`. This mirrors Claude Code's Desktop
 * scheduled-task layout while keeping schedule metadata in the frontmatter so
 * a task is portable and reviewable.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { Storage } from '../../config/storage.js';
import { ApprovalMode, APPROVAL_MODES } from '../../config/config.js';
import {
  atomicWriteFile,
  atomicWriteJSON,
} from '../../utils/atomicFileWrite.js';
import { normalizeContent } from '../../utils/textUtils.js';
import {
  parse as parseYaml,
  stringify as stringifyYaml,
} from '../../utils/yaml-parser.js';
import { createDebugLogger } from '../../utils/debugLogger.js';

const debugLogger = createDebugLogger('SCHEDULE_STORE');

const MANIFEST_FILENAME = 'SKILL.md';
const STATE_FILENAME = 'state.json';
const RUNS_DIRNAME = 'runs';

/** Longest a sanitized task id may be — bounds the directory name. */
const MAX_TASK_ID_LENGTH = 64;

/** How a task's result is delivered. MVP supports only next-session catch-up. */
export type TaskNotify = 'next-session' | 'none';

export interface TaskSchedule {
  /** 5-field cron expression, evaluated in local time. XOR with `fireAt`. */
  cron?: string;
  /** ISO 8601 one-shot timestamp with offset. XOR with `cron`. */
  fireAt?: string;
  /** Whether the task is armed. Defaults to true. */
  enabled: boolean;
}

export interface ScheduledTask {
  /** Directory name — the authoritative, sanitized id. */
  id: string;
  name: string;
  description: string;
  schedule: TaskSchedule;
  /** Working directory the fired child runs in. */
  cwd: string;
  /** Per-task model override; undefined = daemon/default model. */
  model?: string;
  /** Approval posture passed through to the fired child as `--approval-mode`. */
  approvalMode: ApprovalMode;
  notify: TaskNotify;
  /** Run the fired child inside the sandbox. */
  sandbox: boolean;
  /** Self-contained prompt executed on each run. */
  prompt: string;
}

export interface TaskRuntimeState {
  lastFiredAt: number | null;
  nextRunAt: number | null;
  lastRunId: string | null;
  /**
   * Pauses/resumes without editing SKILL.md. When non-null it overrides
   * `schedule.enabled`; null means "defer to the manifest".
   */
  enabledOverride: boolean | null;
}

const EMPTY_STATE: TaskRuntimeState = {
  lastFiredAt: null,
  nextRunAt: null,
  lastRunId: null,
  enabledOverride: null,
};

/**
 * Normalizes an arbitrary string into a filesystem-safe kebab-case id. A
 * safety net that mirrors the reference tool's "auto-sanitized" behavior:
 * lowercased, non-alphanumerics collapsed to single hyphens, trimmed, and
 * length-bounded. Path separators and `.`/`..` can never survive.
 */
export function sanitizeTaskId(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_TASK_ID_LENGTH)
    .replace(/-+$/g, '');
  return cleaned;
}

export function getTaskDir(id: string): string {
  return path.join(Storage.getScheduledTasksDir(), id);
}

export function getTaskManifestPath(id: string): string {
  return path.join(getTaskDir(id), MANIFEST_FILENAME);
}

export function getTaskStatePath(id: string): string {
  return path.join(getTaskDir(id), STATE_FILENAME);
}

export function getTaskRunsDir(id: string): string {
  return path.join(getTaskDir(id), RUNS_DIRNAME);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function parseApprovalMode(value: unknown): ApprovalMode {
  const str = asString(value);
  if (str && (APPROVAL_MODES as string[]).includes(str)) {
    return str as ApprovalMode;
  }
  // Safe unattended default: classifier auto-approves safe actions, blocks
  // risky ones (see D7 in the design plan).
  return ApprovalMode.AUTO;
}

function parseNotify(value: unknown): TaskNotify {
  return asString(value) === 'none' ? 'none' : 'next-session';
}

/**
 * Parses a task's `SKILL.md` into a {@link ScheduledTask}. `id` is the
 * directory name (authoritative), not the frontmatter `name`. Throws on
 * missing frontmatter or when neither name nor description is present.
 */
export function parseTaskManifest(content: string, id: string): ScheduledTask {
  const normalized = normalizeContent(content);
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  if (!match) {
    throw new Error(`Invalid task ${id}: missing YAML frontmatter`);
  }
  const [, frontmatterYaml, body] = match;
  const fm = parseYaml(frontmatterYaml) as Record<string, unknown>;

  const name = asString(fm['name']) ?? id;
  const description = asString(fm['description']) ?? '';

  const scheduleRaw =
    typeof fm['schedule'] === 'object' && fm['schedule'] !== null
      ? (fm['schedule'] as Record<string, unknown>)
      : {};
  const cron = asString(scheduleRaw['cron']);
  const fireAt = asString(scheduleRaw['fireAt']);
  const schedule: TaskSchedule = {
    enabled: asBoolean(scheduleRaw['enabled'], true),
  };
  // cron and fireAt are mutually exclusive; if both are present cron wins
  // (recurring is the safer interpretation than a one-shot that self-disables).
  if (cron) schedule.cron = cron;
  else if (fireAt) schedule.fireAt = fireAt;

  return {
    id,
    name,
    description,
    schedule,
    cwd: asString(fm['cwd']) ?? process.cwd(),
    model: asString(fm['model']),
    approvalMode: parseApprovalMode(fm['approvalMode']),
    notify: parseNotify(fm['notify']),
    sandbox: asBoolean(fm['sandbox'], false),
    prompt: body.trim(),
  };
}

/** Serializes a task back to `SKILL.md` (frontmatter + prompt body). */
export function serializeTaskManifest(task: ScheduledTask): string {
  const schedule: Record<string, unknown> = { enabled: task.schedule.enabled };
  if (task.schedule.cron) schedule['cron'] = task.schedule.cron;
  else if (task.schedule.fireAt) schedule['fireAt'] = task.schedule.fireAt;

  // Ordered, only-defined keys so the emitted YAML stays stable and readable.
  const frontmatter: Record<string, unknown> = {
    name: task.name,
    description: task.description,
    schedule,
    cwd: task.cwd,
  };
  if (task.model) frontmatter['model'] = task.model;
  frontmatter['approvalMode'] = task.approvalMode;
  frontmatter['notify'] = task.notify;
  frontmatter['sandbox'] = task.sandbox;

  const yaml = stringifyYaml(frontmatter);
  const body = task.prompt.trim();
  return `---\n${yaml}---\n\n${body}\n`;
}

/** Reads one task, or null if it doesn't exist. */
export async function readTask(id: string): Promise<ScheduledTask | null> {
  let content: string;
  try {
    content = await fs.readFile(getTaskManifestPath(id), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return parseTaskManifest(content, id);
}

/**
 * Writes a task's `SKILL.md`. `noFollow` guards against a pre-placed symlink
 * (the store lives under the user runtime dir, but a task dir could be
 * hand-crafted) — replace the link with a regular file rather than writing
 * through it, matching the durable-cron write site.
 */
export async function writeTask(task: ScheduledTask): Promise<void> {
  const dir = getTaskDir(task.id);
  await fs.mkdir(dir, { recursive: true });
  await atomicWriteFile(
    getTaskManifestPath(task.id),
    serializeTaskManifest(task),
    {
      noFollow: true,
    },
  );
}

/** Lists every task in the store, skipping unparseable ones (logged). */
export async function listTasks(): Promise<ScheduledTask[]> {
  const base = Storage.getScheduledTasksDir();
  let entries: Array<import('node:fs').Dirent>;
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const tasks: ScheduledTask[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const task = await readTask(entry.name);
      if (task) tasks.push(task);
    } catch (err) {
      // A malformed manifest is skipped, not fatal — one bad task must not
      // hide the rest of the list.
      debugLogger.warn(`Skipping unparseable task ${entry.name}: ${err}`);
    }
  }
  // Stable ordering for deterministic listings.
  tasks.sort((a, b) => a.id.localeCompare(b.id));
  return tasks;
}

/** Removes a task directory entirely. Returns true if it existed. */
export async function deleteTask(id: string): Promise<boolean> {
  const dir = getTaskDir(id);
  try {
    await fs.rm(dir, { recursive: true, force: false });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** Reads a task's runtime state, defaulting to empty when absent/corrupt. */
export async function readState(id: string): Promise<TaskRuntimeState> {
  let raw: string;
  try {
    raw = await fs.readFile(getTaskStatePath(id), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return { ...EMPTY_STATE };
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<TaskRuntimeState>;
    return {
      lastFiredAt:
        typeof parsed.lastFiredAt === 'number' ? parsed.lastFiredAt : null,
      nextRunAt: typeof parsed.nextRunAt === 'number' ? parsed.nextRunAt : null,
      lastRunId: typeof parsed.lastRunId === 'string' ? parsed.lastRunId : null,
      enabledOverride:
        typeof parsed.enabledOverride === 'boolean'
          ? parsed.enabledOverride
          : null,
    };
  } catch {
    // Corrupt state is recoverable runtime data, not a definition — reset to
    // empty rather than throwing (a bad stamp just means a possible re-fire).
    debugLogger.warn(`Corrupt state.json for task ${id} — treating as empty`);
    return { ...EMPTY_STATE };
  }
}

/** Writes a task's runtime state (daemon-owned; never touches SKILL.md). */
export async function writeState(
  id: string,
  state: TaskRuntimeState,
): Promise<void> {
  const dir = getTaskDir(id);
  await fs.mkdir(dir, { recursive: true });
  await atomicWriteJSON(getTaskStatePath(id), state, { noFollow: true });
}

/** Read-modify-write of a task's runtime state. */
export async function updateState(
  id: string,
  mutate: (state: TaskRuntimeState) => TaskRuntimeState,
): Promise<TaskRuntimeState> {
  const next = mutate(await readState(id));
  await writeState(id, next);
  return next;
}

/**
 * Effective enabled flag: a runtime `enabledOverride` (pause/resume) wins over
 * the manifest's `schedule.enabled`.
 */
export function isTaskEnabled(
  task: ScheduledTask,
  state: TaskRuntimeState,
): boolean {
  return state.enabledOverride ?? task.schedule.enabled;
}

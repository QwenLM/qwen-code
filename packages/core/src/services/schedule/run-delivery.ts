/**
 * Delivery of scheduled-run results back to the user. The daemon writes one
 * `runs/<runId>.json` {@link TaskRunRecord} per fire; this module reads those
 * records (for `/schedule logs`) and tracks a global "last surfaced" cursor so
 * the next interactive session can report only runs the user hasn't seen yet
 * (mirroring the durable-cron missed-fire notification).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { Storage } from '../../config/storage.js';
import { atomicWriteJSON } from '../../utils/atomicFileWrite.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import { getTaskRunsDir, listTasks } from './task-store.js';

const debugLogger = createDebugLogger('SCHEDULE_DELIVERY');

const CURSOR_FILENAME = '.delivery-cursor.json';

export interface TaskRunRecord {
  taskId: string;
  runId: string;
  firedAt: number;
  finishedAt: number;
  exitCode: number;
  ok: boolean;
  summary: string;
}

function isRunRecord(value: unknown): value is TaskRunRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r['taskId'] === 'string' &&
    typeof r['runId'] === 'string' &&
    typeof r['finishedAt'] === 'number' &&
    typeof r['ok'] === 'boolean'
  );
}

/** Reads every run record for one task, newest first. */
export async function readTaskRunRecords(
  taskId: string,
): Promise<TaskRunRecord[]> {
  const dir = getTaskRunsDir(taskId);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const records: TaskRunRecord[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(dir, name), 'utf8');
      const parsed = JSON.parse(raw);
      if (isRunRecord(parsed)) records.push(parsed);
    } catch {
      // Skip a half-written/corrupt record rather than failing the listing.
    }
  }
  records.sort((a, b) => b.finishedAt - a.finishedAt);
  return records;
}

/** Reads run records across all tasks, newest first. */
export async function readAllRunRecords(): Promise<TaskRunRecord[]> {
  const tasks = await listTasks();
  const all: TaskRunRecord[] = [];
  for (const task of tasks) {
    all.push(...(await readTaskRunRecords(task.id)));
  }
  all.sort((a, b) => b.finishedAt - a.finishedAt);
  return all;
}

function getCursorPath(): string {
  return path.join(Storage.getScheduledTasksDir(), CURSOR_FILENAME);
}

async function readCursor(): Promise<number> {
  try {
    const raw = await fs.readFile(getCursorPath(), 'utf8');
    const parsed = JSON.parse(raw) as { lastSurfacedAt?: unknown };
    return typeof parsed.lastSurfacedAt === 'number'
      ? parsed.lastSurfacedAt
      : 0;
  } catch {
    return 0;
  }
}

/**
 * Records the high-water mark of surfaced runs. First-ever call (no cursor
 * yet) seeds it to `now` so a fresh install doesn't replay a backlog of old
 * runs on the first session.
 */
export async function markRunsSurfaced(uptoMs: number): Promise<void> {
  try {
    await fs.mkdir(Storage.getScheduledTasksDir(), { recursive: true });
    await atomicWriteJSON(
      getCursorPath(),
      { lastSurfacedAt: uptoMs },
      { noFollow: true },
    );
  } catch (err) {
    debugLogger.warn(`Failed to persist delivery cursor: ${err}`);
  }
}

/**
 * Returns runs that finished after the last surfaced cursor (newest first).
 * On the very first call (no cursor) returns [] and seeds the cursor to
 * `nowMs`, so a fresh session doesn't dump the entire history at once.
 */
export async function collectUnsurfacedRuns(
  nowMs: number = Date.now(),
): Promise<TaskRunRecord[]> {
  let cursorRaw: number | null;
  try {
    const raw = await fs.readFile(getCursorPath(), 'utf8');
    const parsed = JSON.parse(raw) as { lastSurfacedAt?: unknown };
    cursorRaw =
      typeof parsed.lastSurfacedAt === 'number' ? parsed.lastSurfacedAt : null;
  } catch {
    cursorRaw = null;
  }
  if (cursorRaw === null) {
    await markRunsSurfaced(nowMs);
    return [];
  }
  const all = await readAllRunRecords();
  return all.filter((r) => r.finishedAt > cursorRaw);
}

/**
 * Human-readable summary of completed runs for the next-session notice.
 * Informational (no approval needed) — the runs already happened.
 */
export function formatRunNotification(records: TaskRunRecord[]): string {
  if (records.length === 0) return '';
  const plural = records.length === 1 ? '' : 's';
  const header = `${records.length} scheduled task run${plural} completed while you were away:`;
  const lines = records.map((r) => {
    const status = r.ok ? '✓' : '✗';
    const when = new Date(r.finishedAt).toLocaleString();
    return `  ${status} [${r.taskId}] ${r.summary} — ${when}`;
  });
  return [header, ...lines].join('\n');
}

// Re-export so the cursor high-water mark is discoverable next to its reader.
export { readCursor as readDeliveryCursor };

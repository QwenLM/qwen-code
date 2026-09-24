/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Task ledger for the agent-prepared Batch workflow. A task freezes the
// plan, per-item state, and every submit attempt on disk *before* money is
// spent, so a crash between upload and create (or a terminal closed while
// the provider works) never loses which remote objects exist and never
// resubmits blindly. Pure bookkeeping — no network, no model.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { isPidAlive } from '@qwen-code/qwen-code-core/utils/process-liveness.js';
import type { FrozenRequest } from './batch-docs.js';

export const BATCH_TASK_SCHEMA_VERSION = 1;

// custom_id is the only handle the provider returns, so item ids ride inside
// it (`<itemId>#<attempt>`); keep the charset to what safely survives every
// layer in between.
// 60 characters leaves room for `#<attempt>` within a 64-character custom_id.
export const ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/;

const planItemSchema = z
  .object({
    id: z
      .string()
      .regex(
        ITEM_ID_PATTERN,
        'item id must be 1-60 chars of [A-Za-z0-9_-] and start alphanumeric — it becomes part of the provider custom_id',
      ),
    source: z.string().min(1, 'item source path is required'),
    target: z.string().min(1, 'item target path is required'),
  })
  .strict();

export const batchPlanSchema = z
  .object({
    version: z.literal(1),
    name: z
      .string()
      .min(1)
      .max(80)
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
        'name must be slug-safe: letters, digits, dot, dash, underscore',
      ),
    kind: z.literal('document-transform'),
    completionWindow: z
      .string()
      .regex(/^\d+[hd]$/, 'completionWindow like "24h" or "7d"')
      .optional(),
    maxCostUsd: z.number().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    expectedOutputTokensPerItem: z.number().int().positive().optional(),
    enableThinking: z.boolean().optional(),
    shared: z
      .object({
        system: z.string().optional(),
        instructions: z
          .string()
          .min(1, 'shared.instructions carries the transform rules'),
      })
      .strict(),
    items: z.array(planItemSchema).min(1, 'plan has no items'),
  })
  .strict();

export type BatchPlan = z.infer<typeof batchPlanSchema>;

// Delivery happens hours after the plan was approved, with nobody watching,
// so targets never land where a new file configures tools or runs code.
const PROTECTED_TARGET_DIRS = new Set(['.git', '.github', '.husky', '.qwen']);

export function validatePlan(raw: unknown, file: string): BatchPlan {
  const parsed = batchPlanSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`${file}: invalid batch plan:\n${issues}`);
  }
  const plan = parsed.data;
  const seenIds = new Set<string>();
  const targetOf = new Map<string, string>();
  for (const item of plan.items) {
    if (seenIds.has(item.id)) {
      throw new Error(`${file}: duplicate item id "${item.id}"`);
    }
    seenIds.add(item.id);
    const first = targetOf.get(item.target);
    if (first !== undefined) {
      throw new Error(
        `${file}: items "${first}" and "${item.id}" both write "${item.target}"; targets must be unique`,
      );
    }
    targetOf.set(item.target, item.id);
    const top = path.normalize(item.target).split(/[\\/]/)[0].toLowerCase();
    if (PROTECTED_TARGET_DIRS.has(top)) {
      throw new Error(
        `${file}: item "${item.id}" writes into ${top}/, which is not allowed for batch delivery`,
      );
    }
  }
  return plan;
}

export function loadPlanFile(file: string): BatchPlan {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(
      `${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validatePlan(raw, file);
}

export type ItemState =
  | 'pending'
  | 'submitted'
  | 'delivered'
  | 'held'
  | 'failed';

export interface TaskItem {
  id: string;
  source: string;
  target: string;
  state: ItemState;
  /** sha256 of the source content frozen into the latest attempt. */
  sourceSha256?: string;
  /** sha256 of the delivered target content. */
  deliveredSha256?: string;
  lastError?: string;
  heldReason?: string;
  /** The attempt this item's current state belongs to. Result lines from
   * any other attempt are stale: replaying attempt 1's failure while
   * attempt 2 runs must not flip the item back to `failed` (and re-bill it
   * on the next retry). */
  lastAttempt?: number;
  /** Last failure was truncation at the output limit; retrying needs a
   * larger limit, not the same request billed again. */
  truncated?: boolean;
  /** Held because the source changed since submission: `retry` resubmits
   * it against the new source. */
  sourceChanged?: boolean;
}

/** Where one upload+create cycle stands. `unknown` means the create request
 * was sent but its answer never arrived: the batch may exist and be billing,
 * and only a provider-side listing can tell. `uploaded` persisted by a
 * process that is gone means the same thing — it died with the create in
 * flight. */
export type SubmitState = 'intent' | 'uploaded' | 'created' | 'unknown';

/** Commands only run under the task lock, so an `uploaded` attempt seen on
 * load was left by a dead process and is exactly as ambiguous as `unknown`. */
export const isAmbiguous = (attempt: TaskAttempt) =>
  attempt.submitState === 'unknown' || attempt.submitState === 'uploaded';

export interface TaskAttempt {
  attempt: number;
  itemIds: string[];
  submitState: SubmitState;
  inputFileId?: string;
  batchId?: string;
  submittedAt?: string;
  error?: string;
  /** Local files once downloaded; presence means "parse from disk, never
   * re-download" so repeated collects cannot double-count usage either. */
  outputPath?: string;
  errorPath?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    requests: number;
    /** Result lines that carried no usage: the totals are a lower bound. */
    missing?: number;
  };
  /** Output limit this attempt ran with when a retry raised it. */
  maxOutputTokens?: number;
  /** Terminal provider status and job-level errors, recorded at collect. */
  finalStatus?: string;
  jobErrors?: string[];
  /** Settled, downloaded and cleaned up: later collects only re-read the
   * local files and never ask the provider about this batch again. */
  collected?: boolean;
}

export type TaskStatus =
  | 'prepared'
  | 'running'
  | 'submit-unknown'
  | 'partial'
  | 'done';

export interface BatchTask {
  schemaVersion: number;
  id: string;
  name: string;
  kind: 'document-transform';
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  projectRoot: string;
  model: string;
  completionWindow: string;
  plan: BatchPlan;
  /** The endpoint this task's batches live on. Credentials are never
   * stored — only a short hash, to notice a switched account. */
  endpoint?: { baseUrl: string; keyFingerprint: string };
  /** Realtime request parameters frozen at `run`; retries reuse them. */
  request?: FrozenRequest;
  items: TaskItem[];
  attempts: TaskAttempt[];
}

export const customIdOf = (itemId: string, attempt: number) =>
  `${itemId}#${attempt}`;

export function parseCustomId(
  customId: string,
): { itemId: string; attempt: number } | undefined {
  const match = /^(.+)#(\d+)$/.exec(customId);
  if (!match) return undefined;
  return { itemId: match[1], attempt: Number(match[2]) };
}

/**
 * Where task records live: per user, outside every repository, so they
 * never reach a commit and `collect` finds a task from any directory. Each
 * task records its own project root.
 */
export function batchHomeDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return (
    env['QWEN_BATCH_HOME'] ?? path.join(Storage.getGlobalQwenDir(), 'batch')
  );
}

/** Task records hold full copies of the sources and the generated outputs. */
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export class BatchTaskStore {
  constructor(private readonly homeDir: string) {}

  private dirOf(id: string): string {
    // The id becomes a directory name verbatim; refuse anything that could
    // walk out of the store, however it got into a task file.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
      throw new Error(`invalid task id "${id}"`);
    }
    return path.join(this.homeDir, 'tasks', id);
  }

  fileOf(id: string): string {
    return path.join(this.dirOf(id), 'task.json');
  }

  attemptDir(id: string, attempt: number): string {
    return path.join(
      this.dirOf(id),
      `attempt-${String(attempt).padStart(3, '0')}`,
    );
  }

  create(plan: BatchPlan, projectRoot: string, model: string): BatchTask {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    fs.mkdirSync(path.join(this.homeDir, 'tasks'), {
      recursive: true,
      mode: PRIVATE_DIR_MODE,
    });
    // Claim the id with an exclusive mkdir: two runs of one plan in the same
    // second must not share (and overwrite) one task record.
    let id = `${plan.name}-${stamp}`;
    for (let suffix = 2; ; suffix++) {
      try {
        fs.mkdirSync(this.dirOf(id), { mode: PRIVATE_DIR_MODE });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        id = `${plan.name}-${stamp}-${suffix}`;
      }
    }
    const now = new Date().toISOString();
    const task: BatchTask = {
      schemaVersion: BATCH_TASK_SCHEMA_VERSION,
      id,
      name: plan.name,
      kind: plan.kind,
      status: 'prepared',
      createdAt: now,
      updatedAt: now,
      projectRoot,
      model,
      completionWindow: plan.completionWindow ?? '24h',
      plan,
      items: plan.items.map((item) => ({ ...item, state: 'pending' })),
      attempts: [],
    };
    this.save(task);
    // QWEN_BATCH_HOME may point into a repository; keep it out of commits.
    const ignore = path.join(this.homeDir, '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
    return task;
  }

  /** Drop a task that never reached the provider (e.g. refused by the
   * budget gate) so it does not linger in `list`. */
  remove(id: string): void {
    fs.rmSync(this.dirOf(id), { recursive: true, force: true });
  }

  /**
   * Run `fn` holding the task's lock. Two concurrent `retry`s would both
   * submit (and bill) the same failed items; two `collect`s would race on
   * the same downloads.
   *
   * A stale lock is taken over only when its release is certain: written on
   * this host by a pid that no longer exists. A reused pid can only make us
   * refuse wrongly (safe, and the message says how to clear it); a lock from
   * another host — a shared home directory — is never taken over, because
   * its process cannot be checked from here.
   */
  async withLock<T>(
    id: string,
    fn: () => Promise<T>,
    options: { waitMs?: number } = {},
  ): Promise<T> {
    const lock = path.join(this.dirOf(id), 'lock');
    if (!fs.existsSync(path.dirname(lock))) {
      throw new Error(`no batch task "${id}" under ${this.homeDir}`);
    }
    const host = os.hostname();
    // Unique per acquisition, so release can tell our lock from a successor's.
    const token = `${process.pid}\n${host}\n${crypto.randomUUID()}\n`;
    const deadline = Date.now() + (options.waitMs ?? 0);
    let tookOver = false;
    for (;;) {
      try {
        fs.writeFileSync(lock, token, { flag: 'wx' });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const content = readLock(lock);
      if (content === undefined) continue; // released in between; try again
      const [pidText, holderHost] = content
        .split('\n')
        .map((part) => part.trim());
      const pid = Number(pidText);
      // An empty or unparseable lock is one being written right now (the
      // file exists before its content does): treat it as held. Only a
      // well-formed lock from this host whose pid is gone is stale.
      const wellFormed = /^\d+$/.test(pidText ?? '') && pid > 0;
      const elsewhere = Boolean(holderHost) && holderHost !== host;
      if (!tookOver && wellFormed && !elsewhere && !isPidAlive(pid)) {
        tookOver = true;
        if (readLock(lock) === content) fs.rmSync(lock, { force: true });
        continue;
      }
      if (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }
      const who = wellFormed
        ? ` (pid ${pid}${elsewhere ? ` on ${holderHost}` : ''})`
        : '';
      throw new Error(
        `task "${id}" is in use by another \`qwen batch\` process${who}. ` +
          `An open qwen session collects batch tasks automatically and holds the lock only briefly — try again in a few seconds. ` +
          `If no such process is running, delete ${lock} and retry.`,
      );
    }
    try {
      return await fn();
    } finally {
      // Never remove a lock someone else took over after a stale check.
      try {
        if (readLock(lock) === token) fs.rmSync(lock, { force: true });
      } catch {
        // A lock left by this process is taken over as stale once it exits.
      }
    }
  }

  load(id: string): BatchTask {
    const file = this.fileOf(id);
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(
        `cannot load task "${id}" from ${file}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    const task = raw as BatchTask;
    if (task.schemaVersion !== BATCH_TASK_SCHEMA_VERSION) {
      throw new Error(
        `task "${id}" uses schema version ${String(task.schemaVersion)}, ` +
          `this build understands ${BATCH_TASK_SCHEMA_VERSION}; not touching it`,
      );
    }
    return task;
  }

  /** Atomic write: a reader must never meet half a JSON document. */
  save(task: BatchTask): void {
    const file = this.fileOf(task.id);
    fs.mkdirSync(path.dirname(file), {
      recursive: true,
      mode: PRIVATE_DIR_MODE,
    });
    task.updatedAt = new Date().toISOString();
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(task, null, 2) + '\n', {
      mode: PRIVATE_FILE_MODE,
    });
    renameWithRetry(tmp, file);
  }

  /**
   * Every readable task, newest first. With `cache`, a task file whose mtime
   * and size are unchanged is not re-read — the session's auto-collector
   * scans every minute, and most records are long settled.
   */
  list(cache?: Map<string, { stamp: string; task: BatchTask }>): BatchTask[] {
    const root = path.join(this.homeDir, 'tasks');
    if (!fs.existsSync(root)) return [];
    const tasks: BatchTask[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        if (!cache) {
          tasks.push(this.load(entry.name));
          continue;
        }
        const stat = fs.statSync(this.fileOf(entry.name));
        const stamp = `${stat.mtimeMs}:${stat.size}`;
        let hit = cache.get(entry.name);
        if (hit?.stamp !== stamp) {
          hit = { stamp, task: this.load(entry.name) };
          cache.set(entry.name, hit);
        }
        tasks.push(hit.task);
      } catch {
        // A task another version cannot read must not hide the rest.
      }
    }
    return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

/** Roll up item states into the task-level status. */
export function refreshTaskStatus(task: BatchTask): void {
  const states = task.items.map((item) => item.state);
  if (states.every((state) => state === 'delivered')) {
    task.status = 'done';
    return;
  }
  const last = task.attempts[task.attempts.length - 1];
  // An ambiguous latest attempt outranks partial progress: its create may
  // exist and be billing, so the list must say reconcile-first rather than
  // "some items failed".
  if (last && isAmbiguous(last)) {
    task.status = 'submit-unknown';
    return;
  }
  if (
    task.attempts.length > 0 &&
    states.some((state) => state !== 'pending' && state !== 'submitted')
  ) {
    task.status = 'partial';
    return;
  }
  if (last?.submitState === 'created') {
    task.status = 'running';
  }
}

// undefined only when no lock exists; a lock that exists but cannot be read
// is reported as unparseable content, i.e. held — never a tight retry loop.
function readLock(lock: string): string | undefined {
  try {
    return fs.readFileSync(lock, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : '';
  }
}

// Windows refuses to replace a file another process has open (the session's
// auto-collector reads task files every minute); a moment later it works.
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY')) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

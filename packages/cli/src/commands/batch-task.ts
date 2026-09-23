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
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const BATCH_TASK_SCHEMA_VERSION = 1;

// custom_id is the only handle the provider returns, so item ids ride inside
// it (`<itemId>#<attempt>`); keep the charset to what safely survives every
// layer in between.
export const ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const planItemSchema = z.object({
  id: z
    .string()
    .regex(
      ITEM_ID_PATTERN,
      'item id must be 1-64 chars of [A-Za-z0-9_-] and start alphanumeric — it becomes part of the provider custom_id',
    ),
  source: z.string().min(1, 'item source path is required'),
  target: z.string().min(1, 'item target path is required'),
});

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
    shared: z.object({
      system: z.string().optional(),
      instructions: z
        .string()
        .min(1, 'shared.instructions carries the transform rules'),
    }),
    items: z.array(planItemSchema).min(1, 'plan has no items'),
  })
  .strict();

export type BatchPlan = z.infer<typeof batchPlanSchema>;

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
  };
  remoteCleaned?: boolean;
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
  items: TaskItem[];
  attempts: TaskAttempt[];
  estimate?: {
    inputTokens: number;
    outputTokens: number;
    inputPricePer1MUsd?: number;
    outputPricePer1MUsd?: number;
  };
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

export function batchHomeDir(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return env['QWEN_BATCH_HOME'] ?? path.join(cwd, '.qwen', 'batch');
}

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
    let id = `${plan.name}-${stamp}`;
    let suffix = 2;
    while (fs.existsSync(this.dirOf(id))) {
      id = `${plan.name}-${stamp}-${suffix}`;
      suffix += 1;
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
    // Inputs are full copies of the sources and outputs are generated text;
    // neither belongs in the user's commits.
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
   * the same downloads. A lock left by a crashed process is taken over.
   */
  async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const lock = path.join(this.dirOf(id), 'lock');
    if (!fs.existsSync(path.dirname(lock))) {
      throw new Error(`no batch task "${id}" under ${this.homeDir}`);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let holder = NaN;
        try {
          holder = Number(fs.readFileSync(lock, 'utf8'));
        } catch {
          // Released between our write and read; try again.
        }
        if (attempt > 0 || isProcessAlive(holder)) {
          throw new Error(
            `task "${id}" is in use by another \`qwen batch\` process` +
              `${Number.isNaN(holder) ? '' : ` (pid ${holder})`}; wait for it to finish.`,
          );
        }
        fs.rmSync(lock, { force: true });
      }
    }
    try {
      return await fn();
    } finally {
      fs.rmSync(lock, { force: true });
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
    fs.mkdirSync(path.dirname(file), { recursive: true });
    task.updatedAt = new Date().toISOString();
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(task, null, 2) + '\n');
    fs.renameSync(tmp, file);
  }

  list(): BatchTask[] {
    const root = path.join(this.homeDir, 'tasks');
    if (!fs.existsSync(root)) return [];
    const tasks: BatchTask[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        tasks.push(this.load(entry.name));
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
  if (
    task.attempts.length > 0 &&
    states.some((state) => state !== 'pending' && state !== 'submitted')
  ) {
    task.status = 'partial';
    return;
  }
  const last = task.attempts[task.attempts.length - 1];
  if (last && isAmbiguous(last)) {
    task.status = 'submit-unknown';
  } else if (last?.submitState === 'created') {
    task.status = 'running';
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

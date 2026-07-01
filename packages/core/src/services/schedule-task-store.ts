/**
 * ScheduleTaskStore: CRUD for /schedule tasks stored as SKILL.md files.
 *
 * Tasks live under `~/.qwen/scheduled-tasks/<taskId>/`
 *   SKILL.md  — definition (YAML frontmatter + prompt body)
 *   state.json — runtime state (lastFiredAt, run records array)
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

import { parse as parseYaml, stringify as stringifyYaml } from '../utils/yaml-parser.js';
import { normalizeContent } from '../utils/textUtils.js';
import { parseCron, nextFireTime } from '../utils/cronParser.js';
import { humanReadableCron } from '../utils/cronDisplay.js';
import { Storage } from '../config/storage.js';
import { atomicWriteJSON } from '../utils/atomicFileWrite.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getScheduledTasksDir(): string {
  return path.join(Storage.getGlobalQwenDir(), 'scheduled-tasks');
}

function getTaskDir(taskId: string): string {
  return path.join(getScheduledTasksDir(), sanitizeTaskId(taskId));
}

function getSkillMdPath(taskId: string): string {
  return path.join(getTaskDir(taskId), 'SKILL.md');
}

function getStateJsonPath(taskId: string): string {
  return path.join(getTaskDir(taskId), 'state.json');
}

function sanitizeTaskId(raw: string): string {
  // Remove dangerous characters: < > : " / \ | ? * and control characters
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').slice(0, 64);
}

function generateTaskId(): string {
  return randomBytes(8).toString('hex');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScheduleTaskDefinition {
  taskId: string;
  name: string;
  description?: string;
  schedule: {
    cron: string;
    enabled: boolean;
  };
  cwd: string;
  model?: string;
  approvalMode: 'plan' | 'default' | 'auto-edit' | 'auto' | 'yolo';
  notify: 'next-session';
  sandbox: boolean;
  prompt: string;
}

export interface RunRecord {
  startedAt: string;
  endedAt: string;
  exitCode: number | null;
  /** First 500 chars of stdout, trimmed. */
  outputSummary: string;
}

export interface ScheduleTaskState {
  lastFiredAt: string | null;
  runs: RunRecord[];
  /** Max runs to keep (FIFO eviction). */
  maxRuns: number;
}

export interface ScheduleTask {
  definition: ScheduleTaskDefinition;
  state: ScheduleTaskState;
}

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/;

function parseSkillMd(content: string): {
  frontmatter: Record<string, unknown>;
  prompt: string;
} {
  const normalized = normalizeContent(content);
  const match = normalized.match(FRONTMATTER_REGEX);
  if (!match) {
    return { frontmatter: {}, prompt: normalized.trim() };
  }
  const [, yamlBlock = '', body] = match;
  let frontmatter: Record<string, unknown> = {};
  if (yamlBlock.trim()) {
    try {
      frontmatter = parseYaml(yamlBlock) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `Failed to parse YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { frontmatter, prompt: body.trim() };
}

function frontmatterToDefinition(
  taskId: string,
  fm: Record<string, unknown>,
  prompt: string,
): ScheduleTaskDefinition {
  const schedule = (fm['schedule'] as Record<string, unknown>) ?? {};

  const name =
    (typeof fm['name'] === 'string' ? fm['name'] : undefined) ?? taskId;
  const description =
    typeof fm['description'] === 'string' ? fm['description'] : undefined;
  const cron =
    typeof schedule['cron'] === 'string' ? schedule['cron'] : '0 9 * * *';
  const enabled =
    typeof schedule['enabled'] === 'boolean' ? schedule['enabled'] : true;
  const cwd = typeof fm['cwd'] === 'string' ? fm['cwd'] : process.cwd();
  if (!fsSync.existsSync(cwd)) {
    throw new Error(`cwd does not exist: ${cwd}`);
  }
  const model = typeof fm['model'] === 'string' ? fm['model'] : undefined;
  const approvalMode = validateApprovalMode(fm['approvalMode']);
  const notify: 'next-session' =
    fm['notify'] === 'next-session' ? 'next-session' : 'next-session';
  const sandbox =
    typeof fm['sandbox'] === 'boolean' ? fm['sandbox'] : false;

  return {
    taskId,
    name,
    description,
    schedule: { cron, enabled },
    cwd,
    model,
    approvalMode,
    notify,
    sandbox,
    prompt,
  };
}

const VALID_APPROVAL_MODES = new Set([
  'plan',
  'default',
  'auto-edit',
  'auto',
  'yolo',
]);

function validateApprovalMode(
  value: unknown,
): ScheduleTaskDefinition['approvalMode'] {
  if (typeof value === 'string' && VALID_APPROVAL_MODES.has(value)) {
    return value as ScheduleTaskDefinition['approvalMode'];
  }
  return 'auto';
}

function definitionToFrontmatter(def: ScheduleTaskDefinition): string {
  const fm: Record<string, unknown> = {
    name: def.name,
    schedule: {
      cron: def.schedule.cron,
      enabled: def.schedule.enabled,
    },
    cwd: def.cwd,
    approvalMode: def.approvalMode,
    notify: def.notify,
    sandbox: def.sandbox,
  };
  if (def.description) fm['description'] = def.description;
  if (def.model) fm['model'] = def.model;

  const yamlBlock = stringifyYaml(fm, { lineWidth: 120 });
  return `---\n${yamlBlock}---\n\n${def.prompt}\n`;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function createScheduleTask(params: {
  name: string;
  description?: string;
  cron: string;
  cwd?: string;
  model?: string;
  approvalMode?: ScheduleTaskDefinition['approvalMode'];
  notify?: 'next-session';
  sandbox?: boolean;
  prompt: string;
}): Promise<ScheduleTask> {
  parseCron(params.cron);
  nextFireTime(params.cron, new Date());

  const cwd = params.cwd ?? process.cwd();
  if (!fsSync.existsSync(cwd)) {
    throw new Error(`cwd does not exist: ${cwd}`);
  }

  const taskId = generateTaskId();
  const definition: ScheduleTaskDefinition = {
    taskId,
    name: params.name,
    description: params.description,
    schedule: { cron: params.cron, enabled: true },
    cwd,
    model: params.model,
    approvalMode: params.approvalMode ?? 'auto',
    notify: params.notify ?? 'next-session',
    sandbox: params.sandbox ?? false,
    prompt: params.prompt.trim(),
  };

  const state: ScheduleTaskState = {
    lastFiredAt: null,
    runs: [],
    maxRuns: 50,
  };

  const dir = getTaskDir(taskId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(getSkillMdPath(taskId), definitionToFrontmatter(definition), 'utf-8');
  await atomicWriteJSON(getStateJsonPath(taskId), state);

  return { definition, state };
}

export async function readScheduleTask(taskId: string): Promise<ScheduleTask | null> {
  const skillPath = getSkillMdPath(taskId);
  const statePath = getStateJsonPath(taskId);

  let content: string;
  try {
    content = await fs.readFile(skillPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  const { frontmatter, prompt } = parseSkillMd(content);
  const definition = frontmatterToDefinition(taskId, frontmatter, prompt);

  let state: ScheduleTaskState = {
    lastFiredAt: null,
    runs: [],
    maxRuns: 50,
  };
  try {
    const raw = await fs.readFile(statePath, 'utf-8');
    state = JSON.parse(raw) as ScheduleTaskState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  return { definition, state };
}

export async function listScheduleTasks(): Promise<ScheduleTask[]> {
  const dir = getScheduledTasksDir();
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const tasks: ScheduleTask[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const task = await readScheduleTask(entry.name);
    if (task) tasks.push(task);
  }
  return tasks;
}

export async function updateScheduleTask(
  taskId: string,
  updates: Partial<{
    name: string;
    description: string;
    cron: string;
    enabled: boolean;
    cwd: string;
    model: string;
    approvalMode: ScheduleTaskDefinition['approvalMode'];
    notify: 'next-session';
    sandbox: boolean;
    prompt: string;
  }>,
): Promise<ScheduleTask | null> {
  const existing = await readScheduleTask(taskId);
  if (!existing) return null;

  if (updates.cron !== undefined) {
    parseCron(updates.cron);
    nextFireTime(updates.cron, new Date());
  }

  const def = existing.definition;
  if (updates.name !== undefined) def.name = updates.name;
  if (updates.description !== undefined) def.description = updates.description;
  if (updates.cron !== undefined) def.schedule.cron = updates.cron;
  if (updates.enabled !== undefined) def.schedule.enabled = updates.enabled;
  if (updates.cwd !== undefined) def.cwd = updates.cwd;
  if (updates.model !== undefined) def.model = updates.model;
  if (updates.approvalMode !== undefined) def.approvalMode = updates.approvalMode;
  if (updates.notify !== undefined) def.notify = updates.notify;
  if (updates.sandbox !== undefined) def.sandbox = updates.sandbox;
  if (updates.prompt !== undefined) def.prompt = updates.prompt.trim();

  await fs.writeFile(
    getSkillMdPath(taskId),
    definitionToFrontmatter(def),
    'utf-8',
  );

  return { definition: def, state: existing.state };
}

export async function deleteScheduleTask(taskId: string): Promise<boolean> {
  const dir = getTaskDir(taskId);
  try {
    await fs.access(dir);
  } catch {
    return false;
  }
  await fs.rm(dir, { recursive: true, force: true });
  return true;
}

// ---------------------------------------------------------------------------
// Run records
// ---------------------------------------------------------------------------

export async function writeScheduleRunRecord(
  taskId: string,
  record: RunRecord,
): Promise<void> {
  const statePath = getStateJsonPath(taskId);
  let state: ScheduleTaskState;

  try {
    const raw = await fs.readFile(statePath, 'utf-8');
    state = JSON.parse(raw) as ScheduleTaskState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      state = { lastFiredAt: null, runs: [], maxRuns: 50 };
    } else {
      throw err;
    }
  }

  state.lastFiredAt = record.endedAt;
  state.runs.push(record);
  if (state.runs.length > (state.maxRuns || 50)) {
    state.runs = state.runs.slice(-(state.maxRuns || 50));
  }

  await atomicWriteJSON(statePath, state);
}

export async function getScheduleRunRecords(taskId: string): Promise<RunRecord[]> {
  const statePath = getStateJsonPath(taskId);
  try {
    const raw = await fs.readFile(statePath, 'utf-8');
    const state = JSON.parse(raw) as ScheduleTaskState;
    return state.runs ?? [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export function formatScheduleTaskSummary(task: ScheduleTask): string {
  const { definition, state } = task;
  const display = humanReadableCron(definition.schedule.cron);
  const status = definition.schedule.enabled ? 'enabled' : 'disabled';
  const lastFired = state.lastFiredAt
    ? `last: ${new Date(state.lastFiredAt).toLocaleString()}`
    : 'never';
  const runs = `${state.runs.length} run(s)`;
  const model = definition.model ? ` model=${definition.model}` : '';
  const mode = ` approval=${definition.approvalMode}`;

  return [
    `${definition.taskId}  ${status}`,
    `  name: ${definition.name}`,
    definition.description ? `  desc: ${definition.description}` : null,
    `  cron: ${definition.schedule.cron} (${display})`,
    `  cwd: ${definition.cwd}`,
    `  ${lastFired}  ${runs}${model}${mode}`,
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Catch-up delivery
// ---------------------------------------------------------------------------

/**
 * Returns a summary of daemon runs that completed since `since` (ISO string).
 * Call this at session startup to surface what the daemon did while the user
 * was away.
 */
export async function getScheduleCatchUpSummary(
  since: string,
): Promise<string | null> {
  const tasks = await listScheduleTasks();
  const sinceMs = new Date(since).getTime();
  const lines: string[] = [];

  for (const task of tasks) {
    const newRuns = task.state.runs.filter((r) => {
      const endedMs = new Date(r.endedAt).getTime();
      return !isNaN(endedMs) && endedMs > sinceMs;
    });
    if (newRuns.length === 0) continue;

    const name = task.definition.name;
    for (const run of newRuns) {
      const status = run.exitCode === 0 ? 'ok' : `exit ${run.exitCode}`;
      lines.push(
        `  [${name}] ${run.startedAt} → ${status}  ${run.outputSummary.slice(0, 80)}`,
      );
    }
  }

  if (lines.length === 0) return null;
  return `Schedule daemon activity since your last session:\n${lines.join('\n')}`;
}

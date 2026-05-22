/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';

export interface AutoImproveSources {
  githubIssues: boolean;
  githubPrs: boolean;
  localSignals: boolean;
}

export interface AutoImproveConfig {
  version: 1;
  sources: AutoImproveSources;
  customSources: string[];
}

export interface AutoImproveRunRef {
  runId: string;
  status: string;
  worktreePath?: string;
  runDoc?: string;
  deliveryTarget?: AutoImproveDeliveryTarget;
}

export interface AutoImproveDeliveryTarget {
  kind: 'loop-branch' | 'issue-branch' | 'pr-branch' | 'local-only';
  branch: string;
  issueNumber?: number;
  prNumber?: number;
  pushRequested: boolean;
}

export interface AutoImproveRunRecord {
  runId: string;
  status: string;
  source?: string;
  task?: string;
  branch?: string;
  commit?: string;
  runDoc?: string;
  issueNumber?: number;
  prNumber?: number;
  updatedAt?: string;
}

export interface AutoImproveRunIndex {
  version: 1;
  runs: AutoImproveRunRecord[];
}

export interface AutoImproveLoopState {
  version: 1;
  loopId: string;
  status: 'running' | 'stopping' | 'stopped' | 'stale';
  sessionScoped: true;
  createdAt: string;
  cadence: string;
  cron: string;
  cronJobId?: string;
  targetBranch: string;
  repoRoot: string;
  deliveryPolicy: 'source-aware-local-commit';
  stopRequested: boolean;
  sourceSnapshot: AutoImproveConfig;
  prompt: string;
  currentRun?: AutoImproveRunRef;
  lastRun?: AutoImproveRunRef;
}

export interface AutoImproveActivePointer {
  activeLoopId: string;
}

export const AUTO_IMPROVE_DIR = path.join('.qwen', 'auto-improve');
export const AUTO_IMPROVE_LOOP_ID_LINE_PREFIX = '- Loop id: ';
const LOOP_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const LOOP_STATUSES = new Set(['running', 'stopping', 'stopped', 'stale']);
const ACTIVE_RUN_STATUSES = new Set(['implementing', 'testing', 'running']);
const TERMINAL_RUN_STATUSES = new Set([
  'success',
  'failed',
  'blocked',
  'cancelled',
]);

export const DEFAULT_AUTO_IMPROVE_CONFIG: AutoImproveConfig = {
  version: 1,
  sources: {
    githubIssues: false,
    githubPrs: false,
    localSignals: false,
  },
  customSources: [],
};

export function getAutoImproveRoot(repoRoot: string): string {
  return path.join(repoRoot, AUTO_IMPROVE_DIR);
}

export function getAutoImproveConfigPath(repoRoot: string): string {
  return path.join(getAutoImproveRoot(repoRoot), 'config.json');
}

export function getAutoImproveActivePath(repoRoot: string): string {
  return path.join(getAutoImproveRoot(repoRoot), 'active.json');
}

export function getAutoImproveLoopDir(
  repoRoot: string,
  loopId: string,
): string {
  assertValidLoopId(loopId);
  return path.join(getAutoImproveRoot(repoRoot), 'loops', loopId);
}

export function getAutoImproveStatePath(
  repoRoot: string,
  loopId: string,
): string {
  return path.join(getAutoImproveLoopDir(repoRoot, loopId), 'state.json');
}

export function getAutoImproveRunIndexPath(
  repoRoot: string,
  loopId: string,
): string {
  return path.join(
    getAutoImproveLoopDir(repoRoot, loopId),
    'runs',
    'index.json',
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isValidAutoImproveLoopId(loopId: string): boolean {
  return LOOP_ID_PATTERN.test(loopId);
}

function assertValidLoopId(loopId: string): void {
  if (!isValidAutoImproveLoopId(loopId)) {
    throw new Error(`Invalid auto-improve loop id: ${loopId}`);
  }
}

function readBoolean(value: unknown): boolean {
  return typeof value === 'boolean' ? value : false;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function normalizeConfig(value: unknown): AutoImproveConfig {
  if (!isRecord(value)) return DEFAULT_AUTO_IMPROVE_CONFIG;
  const rawSources = value['sources'];
  const sources = isRecord(rawSources) ? rawSources : {};
  const customSources = normalizeStringList(value['customSources']);
  const legacyUserContext =
    typeof value['userContext'] === 'string' ? value['userContext'].trim() : '';
  if (customSources.length === 0 && legacyUserContext) {
    customSources.push(legacyUserContext);
  }
  return {
    version: 1,
    sources: {
      githubIssues: readBoolean(sources['githubIssues']),
      githubPrs: readBoolean(sources['githubPrs']),
      localSignals: readBoolean(sources['localSignals']),
    },
    customSources,
  };
}

export async function ensureAutoImproveRoot(repoRoot: string): Promise<void> {
  await fs.mkdir(getAutoImproveRoot(repoRoot), { recursive: true });
}

export async function readAutoImproveConfig(
  repoRoot: string,
): Promise<AutoImproveConfig> {
  try {
    const raw = await fs.readFile(getAutoImproveConfigPath(repoRoot), 'utf8');
    return normalizeConfig(JSON.parse(raw));
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return DEFAULT_AUTO_IMPROVE_CONFIG;
    }
    throw error;
  }
}

export async function writeAutoImproveConfig(
  repoRoot: string,
  config: AutoImproveConfig,
): Promise<void> {
  await ensureAutoImproveRoot(repoRoot);
  await fs.writeFile(
    getAutoImproveConfigPath(repoRoot),
    `${JSON.stringify(normalizeConfig(config), null, 2)}\n`,
    'utf8',
  );
}

export async function readActiveAutoImproveLoop(
  repoRoot: string,
): Promise<AutoImproveActivePointer | null> {
  try {
    const raw = await fs.readFile(getAutoImproveActivePath(repoRoot), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      isRecord(parsed) &&
      typeof parsed['activeLoopId'] === 'string' &&
      isValidAutoImproveLoopId(parsed['activeLoopId'])
    ) {
      return { activeLoopId: parsed['activeLoopId'] };
    }
    return null;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return null;
    }
    throw error;
  }
}

export async function writeActiveAutoImproveLoop(
  repoRoot: string,
  loopId: string,
): Promise<void> {
  assertValidLoopId(loopId);
  await ensureAutoImproveRoot(repoRoot);
  await fs.writeFile(
    getAutoImproveActivePath(repoRoot),
    `${JSON.stringify({ activeLoopId: loopId }, null, 2)}\n`,
    'utf8',
  );
}

export async function clearActiveAutoImproveLoop(
  repoRoot: string,
): Promise<void> {
  await fs.rm(getAutoImproveActivePath(repoRoot), { force: true });
}

function normalizeRunRef(value: unknown): AutoImproveRunRef | undefined {
  if (!isRecord(value)) return undefined;
  const runId = value['runId'];
  const status = value['status'];
  if (typeof runId !== 'string' || !runId.trim()) return undefined;
  if (typeof status !== 'string' || !status.trim()) return undefined;

  const runRef: AutoImproveRunRef = {
    runId: runId.trim(),
    status: status.trim(),
  };
  const worktreePath = value['worktreePath'];
  const runDoc = value['runDoc'];
  if (typeof worktreePath === 'string' && worktreePath.trim()) {
    runRef.worktreePath = worktreePath;
  }
  if (typeof runDoc === 'string' && runDoc.trim()) {
    runRef.runDoc = runDoc;
  }

  const deliveryTarget = value['deliveryTarget'];
  if (isRecord(deliveryTarget)) {
    const kind = deliveryTarget['kind'];
    const branch = deliveryTarget['branch'];
    const pushRequested = deliveryTarget['pushRequested'];
    const issueNumber = deliveryTarget['issueNumber'];
    const prNumber = deliveryTarget['prNumber'];
    if (
      (kind === 'loop-branch' ||
        kind === 'issue-branch' ||
        kind === 'pr-branch' ||
        kind === 'local-only') &&
      typeof branch === 'string' &&
      branch.trim() &&
      typeof pushRequested === 'boolean'
    ) {
      runRef.deliveryTarget = {
        kind,
        branch,
        pushRequested,
        ...(typeof issueNumber === 'number' && Number.isFinite(issueNumber)
          ? { issueNumber }
          : {}),
        ...(typeof prNumber === 'number' && Number.isFinite(prNumber)
          ? { prNumber }
          : {}),
      };
    }
  }

  return runRef;
}

function readOptionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const raw = value[key];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

function readOptionalNumber(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const raw = value[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

function normalizeRunRecord(value: unknown): AutoImproveRunRecord | null {
  if (!isRecord(value)) return null;
  const runId = readOptionalString(value, 'runId');
  const status = readOptionalString(value, 'status');
  if (!runId || !status) return null;
  const source = readOptionalString(value, 'source');
  const task = readOptionalString(value, 'task');
  const branch = readOptionalString(value, 'branch');
  const commit = readOptionalString(value, 'commit');
  const runDoc = readOptionalString(value, 'runDoc');
  const issueNumber = readOptionalNumber(value, 'issueNumber');
  const prNumber = readOptionalNumber(value, 'prNumber');
  const updatedAt = readOptionalString(value, 'updatedAt');
  return {
    runId,
    status,
    ...(source ? { source } : {}),
    ...(task ? { task } : {}),
    ...(branch ? { branch } : {}),
    ...(commit ? { commit } : {}),
    ...(runDoc ? { runDoc } : {}),
    ...(issueNumber !== undefined ? { issueNumber } : {}),
    ...(prNumber !== undefined ? { prNumber } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function normalizeRunIndex(value: unknown): AutoImproveRunIndex {
  const runsValue = isRecord(value) ? value['runs'] : undefined;
  const runs = Array.isArray(runsValue)
    ? runsValue
        .map((record) => normalizeRunRecord(record))
        .filter((record): record is AutoImproveRunRecord => record !== null)
    : [];
  return { version: 1, runs };
}

function normalizeLoopState(value: unknown): AutoImproveLoopState | null {
  if (!isRecord(value)) return null;
  const loopId = value['loopId'];
  if (typeof loopId !== 'string' || !isValidAutoImproveLoopId(loopId)) {
    return null;
  }
  const status = value['status'];
  const state: AutoImproveLoopState = {
    version: 1,
    loopId,
    status: LOOP_STATUSES.has(String(status))
      ? (status as AutoImproveLoopState['status'])
      : 'stale',
    sessionScoped: true,
    createdAt: typeof value['createdAt'] === 'string' ? value['createdAt'] : '',
    cadence: typeof value['cadence'] === 'string' ? value['cadence'] : '',
    cron: typeof value['cron'] === 'string' ? value['cron'] : '',
    targetBranch:
      typeof value['targetBranch'] === 'string' ? value['targetBranch'] : '',
    repoRoot: typeof value['repoRoot'] === 'string' ? value['repoRoot'] : '',
    deliveryPolicy: 'source-aware-local-commit',
    stopRequested: readBoolean(value['stopRequested']),
    sourceSnapshot: normalizeConfig(value['sourceSnapshot']),
    prompt: typeof value['prompt'] === 'string' ? value['prompt'] : '',
  };
  const cronJobId = value['cronJobId'];
  if (typeof cronJobId === 'string' && cronJobId.trim()) {
    state.cronJobId = cronJobId;
  }
  const currentRun = normalizeRunRef(value['currentRun']);
  if (currentRun) state.currentRun = currentRun;
  const lastRun = normalizeRunRef(value['lastRun']);
  if (lastRun) state.lastRun = lastRun;
  return state;
}

export function isActiveAutoImproveRunRef(
  value: unknown,
): value is AutoImproveRunRef {
  const runRef = normalizeRunRef(value);
  return !!runRef && ACTIVE_RUN_STATUSES.has(runRef.status);
}

export function isTerminalAutoImproveRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

export async function readAutoImproveLoopState(
  repoRoot: string,
  loopId: string,
): Promise<AutoImproveLoopState | null> {
  try {
    const raw = await fs.readFile(
      getAutoImproveStatePath(repoRoot, loopId),
      'utf8',
    );
    return normalizeLoopState(JSON.parse(raw));
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return null;
    }
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function readAutoImproveRunIndex(
  repoRoot: string,
  loopId: string,
): Promise<AutoImproveRunIndex> {
  try {
    const raw = await fs.readFile(
      getAutoImproveRunIndexPath(repoRoot, loopId),
      'utf8',
    );
    return normalizeRunIndex(JSON.parse(raw));
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return { version: 1, runs: [] };
    }
    if (error instanceof SyntaxError) return { version: 1, runs: [] };
    throw error;
  }
}

function getLoopStateTimestamp(state: AutoImproveLoopState): number {
  const parsed = Date.parse(state.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function listAutoImproveLoopStates(
  repoRoot: string,
): Promise<AutoImproveLoopState[]> {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await fs.readdir(
      path.join(getAutoImproveRoot(repoRoot), 'loops'),
      {
        withFileTypes: true,
      },
    );
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return [];
    }
    throw error;
  }

  const states = await Promise.all(
    entries
      .filter(
        (entry) => entry.isDirectory() && isValidAutoImproveLoopId(entry.name),
      )
      .map((entry) => readAutoImproveLoopState(repoRoot, entry.name)),
  );
  return states
    .filter((state): state is AutoImproveLoopState => state !== null)
    .sort((left, right) => {
      const timeDiff =
        getLoopStateTimestamp(right) - getLoopStateTimestamp(left);
      return timeDiff || right.loopId.localeCompare(left.loopId);
    });
}

export async function writeAutoImproveLoopState(
  repoRoot: string,
  state: AutoImproveLoopState,
): Promise<void> {
  const loopDir = getAutoImproveLoopDir(repoRoot, state.loopId);
  await fs.mkdir(path.join(loopDir, 'runs'), { recursive: true });
  await fs.writeFile(
    getAutoImproveStatePath(repoRoot, state.loopId),
    `${JSON.stringify(state, null, 2)}\n`,
    'utf8',
  );
}

export async function initializeAutoImproveLoopFiles(
  repoRoot: string,
  state: AutoImproveLoopState,
): Promise<void> {
  const loopDir = getAutoImproveLoopDir(repoRoot, state.loopId);
  await fs.mkdir(path.join(loopDir, 'runs'), { recursive: true });
  await writeAutoImproveLoopState(repoRoot, state);
  await fs.writeFile(
    path.join(loopDir, 'summary.md'),
    [
      '# Auto-Improve Summary',
      '',
      `Loop: ${state.loopId}`,
      `Target branch: ${state.targetBranch}`,
      `Cadence: ${state.cadence}`,
      '',
      '| Run | Status | Task | Commit | Notes |',
      '| --- | --- | --- | --- | --- |',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.writeFile(
    getAutoImproveRunIndexPath(repoRoot, state.loopId),
    `${JSON.stringify({ version: 1, runs: [] }, null, 2)}\n`,
    'utf8',
  );
}

async function resolveRepoRoot(cwd: string): Promise<string> {
  try {
    return await new Promise<string>((resolve, reject) => {
      execFile(
        'git',
        ['-C', cwd, 'rev-parse', '--show-toplevel'],
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(stdout.trim());
        },
      );
    });
  } catch {
    return cwd;
  }
}

export async function markActiveAutoImproveRunCancelled(
  cwd: string,
  loopId: string,
): Promise<boolean> {
  const repoRoot = await resolveRepoRoot(cwd);
  const active = await readActiveAutoImproveLoop(repoRoot);
  if (active && active.activeLoopId !== loopId) return false;

  const state = await readAutoImproveLoopState(repoRoot, loopId);
  if (!state || (state.status !== 'running' && state.status !== 'stopping')) {
    return false;
  }

  if (
    state.currentRun &&
    isTerminalAutoImproveRunStatus(state.currentRun.status)
  ) {
    return false;
  }

  const cancelledRun: AutoImproveRunRef = {
    ...(state.currentRun ?? { runId: 'cancelled-by-user', status: 'running' }),
    status: 'cancelled',
  };
  state.lastRun = cancelledRun;
  delete state.currentRun;
  await writeAutoImproveLoopState(repoRoot, state);
  return true;
}

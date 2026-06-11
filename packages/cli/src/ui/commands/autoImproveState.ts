/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { createDebugLogger } from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('AUTO_IMPROVE');

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
  // ISO timestamp of when this run claimed currentRun. Used to detect a stuck
  // run (e.g. a completion write that failed, or a process killed before
  // onComplete cleared currentRun) so the next tick can reclaim it instead of
  // skipping forever.
  startedAt?: string;
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
  sessionId?: string;
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
const DELIVERY_POLICIES = new Set(['source-aware-local-commit']);
const DEFAULT_DELIVERY_POLICY: AutoImproveLoopState['deliveryPolicy'] =
  'source-aware-local-commit';
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

export const MAX_CUSTOM_SOURCE_LENGTH = 200;
export const MAX_CUSTOM_SOURCES = 10;
// The start prompt is interpolated into the tick prompt on every cron tick; cap
// it (defends a tampered state.json with a multi-MB prompt that would overflow
// the model context / burn tokens every tick). A git branch name is a single
// token, so it is both length-capped and control-char-stripped.
export const MAX_AUTO_IMPROVE_PROMPT_LENGTH = 4096;
export const MAX_TARGET_BRANCH_LENGTH = 255;

// Control chars (incl. newlines) that could forge extra lines inside the
// USER-PROVIDED DATA fence of the tick prompt. Collapsed to spaces in
// single-line fields (custom sources, target branch).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

export function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item
      .replace(CONTROL_CHARS_RE, ' ')
      .trim()
      .slice(0, MAX_CUSTOM_SOURCE_LENGTH);
    if (!trimmed || seen.has(trimmed)) continue;
    if (result.length >= MAX_CUSTOM_SOURCES) break;
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
    typeof value['userContext'] === 'string'
      ? value['userContext'].replace(CONTROL_CHARS_RE, ' ').trim()
      : '';
  if (customSources.length === 0 && legacyUserContext) {
    // Match normalizeStringList: strip control chars (above) AND length-cap, so
    // a legacy userContext with embedded newlines/control chars can't forge
    // extra lines inside the USER-PROVIDED DATA fence of the tick prompt.
    customSources.push(legacyUserContext.slice(0, MAX_CUSTOM_SOURCE_LENGTH));
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
    if (error instanceof SyntaxError) {
      debugLogger.warn(
        `Corrupt auto-improve config at ${getAutoImproveConfigPath(repoRoot)}; using defaults: ${error.message}`,
      );
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
  // Atomic write (tmp + rename), consistent with writeAutoImproveLoopState and
  // writeActiveAutoImproveLoop, so a crash mid-write can't truncate config.json
  // (the reader falls back to defaults on SyntaxError, silently losing config).
  const configPath = getAutoImproveConfigPath(repoRoot);
  const tmpPath = `${configPath}.tmp`;
  await fs.writeFile(
    tmpPath,
    `${JSON.stringify(normalizeConfig(config), null, 2)}\n`,
    'utf8',
  );
  await fs.rename(tmpPath, configPath);
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
    // A truncated/corrupt active.json (e.g. crash mid-write) must not throw on
    // every subsequent /auto-improve command — treat it as "no active pointer".
    if (error instanceof SyntaxError) {
      debugLogger.warn(
        `Corrupt auto-improve active pointer; treating as none: ${error.message}`,
      );
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
  // Atomic write (tmp + rename), consistent with writeAutoImproveLoopState, so
  // a crash mid-write can't leave a truncated active.json behind.
  const activePath = getAutoImproveActivePath(repoRoot);
  const tmpPath = `${activePath}.tmp`;
  await fs.writeFile(
    tmpPath,
    `${JSON.stringify({ activeLoopId: loopId }, null, 2)}\n`,
    'utf8',
  );
  await fs.rename(tmpPath, activePath);
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
  const startedAt = value['startedAt'];
  if (typeof worktreePath === 'string' && worktreePath.trim()) {
    runRef.worktreePath = worktreePath;
  }
  if (typeof runDoc === 'string' && runDoc.trim()) {
    runRef.runDoc = runDoc;
  }
  if (typeof startedAt === 'string' && startedAt.trim()) {
    runRef.startedAt = startedAt.trim();
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

// The run index is appended to by the LLM tick prompt and never trimmed, so it
// grows unbounded over a long-lived loop. Bound what a read loads/returns to the
// most recent records (consumers only show the last few) so `/auto-improve
// status` stays O(MAX) rather than degrading with total run count.
const MAX_RUN_INDEX_RECORDS = 100;

function normalizeRunIndex(value: unknown): AutoImproveRunIndex {
  const runsValue = isRecord(value) ? value['runs'] : undefined;
  const runs = Array.isArray(runsValue)
    ? runsValue
        .map((record) => normalizeRunRecord(record))
        .filter((record): record is AutoImproveRunRecord => record !== null)
        .slice(-MAX_RUN_INDEX_RECORDS)
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
  const isKnownStatus = LOOP_STATUSES.has(String(status));
  if (status !== undefined && !isKnownStatus) {
    // An older CLI reading a state file written by a newer one would silently
    // mark a running loop 'stale' (which startAutoImprove treats as recoverable
    // and cancels). Surface it so the downgrade is at least diagnosable.
    debugLogger.warn(
      `Auto-improve loop ${loopId}: unknown status ${JSON.stringify(status)} coerced to 'stale' (older CLI reading a newer state file?).`,
    );
  }
  // Read deliveryPolicy from the persisted state, validated against the known
  // set (mirroring the status handling above) instead of hardcoding, so a future
  // policy value is carried through — and an unknown one is logged rather than
  // silently coerced to the default.
  const persistedDeliveryPolicy = value['deliveryPolicy'];
  const isKnownDeliveryPolicy =
    typeof persistedDeliveryPolicy === 'string' &&
    DELIVERY_POLICIES.has(persistedDeliveryPolicy);
  if (persistedDeliveryPolicy !== undefined && !isKnownDeliveryPolicy) {
    debugLogger.warn(
      `Auto-improve loop ${loopId}: unknown deliveryPolicy ${JSON.stringify(
        persistedDeliveryPolicy,
      )} coerced to '${DEFAULT_DELIVERY_POLICY}' (older CLI reading a newer state file?).`,
    );
  }
  const state: AutoImproveLoopState = {
    version: 1,
    loopId,
    status: isKnownStatus
      ? (status as AutoImproveLoopState['status'])
      : 'stale',
    sessionScoped: true,
    createdAt: typeof value['createdAt'] === 'string' ? value['createdAt'] : '',
    cadence: typeof value['cadence'] === 'string' ? value['cadence'] : '',
    cron: typeof value['cron'] === 'string' ? value['cron'] : '',
    targetBranch:
      typeof value['targetBranch'] === 'string'
        ? value['targetBranch']
            .replace(CONTROL_CHARS_RE, ' ')
            .trim()
            .slice(0, MAX_TARGET_BRANCH_LENGTH)
        : '',
    repoRoot: typeof value['repoRoot'] === 'string' ? value['repoRoot'] : '',
    deliveryPolicy: isKnownDeliveryPolicy
      ? (persistedDeliveryPolicy as AutoImproveLoopState['deliveryPolicy'])
      : DEFAULT_DELIVERY_POLICY,
    stopRequested: readBoolean(value['stopRequested']),
    sourceSnapshot: normalizeConfig(value['sourceSnapshot']),
    // Cap (but keep newlines — a start prompt is legitimately multi-line; fence
    // markers are neutralized in buildTickPrompt) so a tampered state can't
    // overflow the model context on every tick.
    prompt:
      typeof value['prompt'] === 'string'
        ? value['prompt'].slice(0, MAX_AUTO_IMPROVE_PROMPT_LENGTH)
        : '',
  };
  const cronJobId = value['cronJobId'];
  if (typeof cronJobId === 'string' && cronJobId.trim()) {
    state.cronJobId = cronJobId;
  }
  const sessionId = value['sessionId'];
  if (typeof sessionId === 'string' && sessionId.trim()) {
    state.sessionId = sessionId.trim();
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

// A run is considered "stuck" once it has been active longer than any real tick
// could take. Generous on purpose: a too-aggressive value would reclaim a run
// that is still legitimately working. The runId-ownership check in
// markRunCompleted backstops this — even if a still-live run is reclaimed, its
// late completion can't clobber the run that replaced it.
export const MAX_AUTO_IMPROVE_RUN_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

export function isStaleAutoImproveRunRef(
  value: unknown,
  nowMs: number,
  maxAgeMs: number = MAX_AUTO_IMPROVE_RUN_AGE_MS,
): boolean {
  const runRef = normalizeRunRef(value);
  if (!runRef || !ACTIVE_RUN_STATUSES.has(runRef.status)) return false;
  // Without a startedAt we can't tell its age — treat as not-stale so we never
  // reclaim a run we can't reason about (forward-looking: new runs always set
  // startedAt).
  if (!runRef.startedAt) return false;
  const started = Date.parse(runRef.startedAt);
  if (!Number.isFinite(started)) return false;
  return nowMs - started > maxAgeMs;
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
    if (error instanceof SyntaxError) {
      debugLogger.warn(
        `Corrupt auto-improve loop state for loop ${loopId}; treating as missing: ${error.message}`,
      );
      return null;
    }
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
    if (error instanceof SyntaxError) {
      debugLogger.warn(
        `Corrupt auto-improve run index for loop ${loopId}; using empty index: ${error.message}`,
      );
      return { version: 1, runs: [] };
    }
    throw error;
  }
}

export async function compactAutoImproveRunIndex(
  repoRoot: string,
  loopId: string,
): Promise<void> {
  // The tick agent appends one record to index.json per run; normalizeRunIndex
  // truncates to the most recent MAX_RUN_INDEX_RECORDS on read, but nothing
  // rewrites the file, so it grows unbounded on disk (and every read pays an
  // O(N) parse). Rewrite the truncated view once the raw file exceeds the cap.
  // Read the raw record count first so we only pay the write when needed.
  let rawCount: number;
  try {
    const raw = await fs.readFile(
      getAutoImproveRunIndexPath(repoRoot, loopId),
      'utf8',
    );
    const parsed = JSON.parse(raw) as unknown;
    const runs = isRecord(parsed) ? parsed['runs'] : undefined;
    rawCount = Array.isArray(runs) ? runs.length : 0;
  } catch {
    // Missing/corrupt index: nothing to compact (reads already fall back to
    // an empty index).
    return;
  }
  // Hysteresis: compaction truncates to exactly MAX_RUN_INDEX_RECORDS, so a
  // bare `> MAX` check would re-fire every tick once the cap is reached (each
  // tick appends one record → cap+1). Only rewrite once the raw file has grown
  // to twice the cap, amortizing the read+parse+write to once per ~MAX ticks.
  if (rawCount <= MAX_RUN_INDEX_RECORDS * 2) return;
  const normalized = await readAutoImproveRunIndex(repoRoot, loopId);
  const indexPath = getAutoImproveRunIndexPath(repoRoot, loopId);
  const tmpPath = `${indexPath}.tmp`;
  await fs.writeFile(
    tmpPath,
    `${JSON.stringify(normalized, null, 2)}\n`,
    'utf8',
  );
  await fs.rename(tmpPath, indexPath);
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

// Read only the single most-recently-written loop state instead of reading +
// parsing every loop's state.json (what statusAutoImprove's no-active-loop
// fallback otherwise pays). Order the loop dirs by their state.json mtime
// (cheap stat, no read), then read from newest until a valid one is found.
export async function readMostRecentLoopState(
  repoRoot: string,
): Promise<AutoImproveLoopState | null> {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await fs.readdir(
      path.join(getAutoImproveRoot(repoRoot), 'loops'),
      { withFileTypes: true },
    );
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

  const candidates: Array<{ loopId: string; mtimeMs: number }> = [];
  await Promise.all(
    entries
      .filter(
        (entry) => entry.isDirectory() && isValidAutoImproveLoopId(entry.name),
      )
      .map(async (entry) => {
        try {
          const stat = await fs.stat(
            getAutoImproveStatePath(repoRoot, entry.name),
          );
          candidates.push({ loopId: entry.name, mtimeMs: stat.mtimeMs });
        } catch {
          // Missing/unreadable state.json — skip this dir.
        }
      }),
  );
  candidates.sort(
    (left, right) =>
      right.mtimeMs - left.mtimeMs || right.loopId.localeCompare(left.loopId),
  );
  for (const { loopId } of candidates) {
    const state = await readAutoImproveLoopState(repoRoot, loopId);
    if (state) return state;
  }
  return null;
}

export async function writeAutoImproveLoopState(
  repoRoot: string,
  state: AutoImproveLoopState,
): Promise<void> {
  const loopDir = getAutoImproveLoopDir(repoRoot, state.loopId);
  await fs.mkdir(path.join(loopDir, 'runs'), { recursive: true });
  const statePath = getAutoImproveStatePath(repoRoot, state.loopId);
  const tmpPath = `${statePath}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.rename(tmpPath, statePath);
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
        // Bound the call so a blocked git credential helper (headless/SSH)
        // can't leak the child / hang markActiveAutoImproveRunCancelled; on
        // timeout the catch below falls back to cwd. Mirrors the sibling
        // resolveRepoRoot in AutoImproveSourceDialog.tsx.
        { timeout: 10_000 },
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
  // Exported and callable with an arbitrary loopId; self-protect with an early
  // return so an invalid id can never reach assertValidLoopId (which throws)
  // via readAutoImproveLoopState below, regardless of the caller's error
  // handling or the active-pointer state.
  if (!isValidAutoImproveLoopId(loopId)) return false;
  const repoRoot = await resolveRepoRoot(cwd);
  const active = await readActiveAutoImproveLoop(repoRoot);
  // A cleared active pointer (active === null) is expected when cancelling a
  // `stopping` run that `stop` already unpointered, so we intentionally do NOT
  // bail here — the status guard below rejects fully-stopped/orphaned loops.
  if (active && active.activeLoopId !== loopId) return false;

  const state = await readAutoImproveLoopState(repoRoot, loopId);
  if (!state || (state.status !== 'running' && state.status !== 'stopping')) {
    return false;
  }

  // If currentRun was already cleared (e.g. by a concurrent markRunCompleted),
  // there is no in-flight run to cancel — bail instead of clobbering lastRun
  // with a spurious cancelled-by-user record.
  if (!state.currentRun) return false;
  if (isTerminalAutoImproveRunStatus(state.currentRun.status)) {
    return false;
  }

  const cancelledRun: AutoImproveRunRef = {
    ...state.currentRun,
    status: 'cancelled',
  };
  state.lastRun = cancelledRun;
  delete state.currentRun;
  if (state.stopRequested || state.status === 'stopping') {
    state.status = 'stopped';
  }
  await writeAutoImproveLoopState(repoRoot, state);
  return true;
}

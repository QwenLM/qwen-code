/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

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
  kind: 'loop-branch' | 'pr-branch' | 'local-only';
  branch: string;
  prNumber?: number;
  pushRequested: boolean;
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
  return path.join(getAutoImproveRoot(repoRoot), 'loops', loopId);
}

export function getAutoImproveStatePath(
  repoRoot: string,
  loopId: string,
): string {
  return path.join(getAutoImproveLoopDir(repoRoot, loopId), 'state.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
      parsed['activeLoopId'].trim()
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

export async function readAutoImproveLoopState(
  repoRoot: string,
  loopId: string,
): Promise<AutoImproveLoopState | null> {
  try {
    const raw = await fs.readFile(
      getAutoImproveStatePath(repoRoot, loopId),
      'utf8',
    );
    return JSON.parse(raw) as AutoImproveLoopState;
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

export async function writeAutoImproveLoopState(
  repoRoot: string,
  state: AutoImproveLoopState,
): Promise<void> {
  const loopDir = getAutoImproveLoopDir(repoRoot, state.loopId);
  await fs.mkdir(path.join(loopDir, 'runs'), { recursive: true });
  await fs.writeFile(
    path.join(loopDir, 'state.json'),
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
}

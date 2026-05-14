/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface SelfImproveSources {
  githubIssues: boolean;
  githubPrs: boolean;
  localSignals: boolean;
}

export interface SelfImproveConfig {
  version: 1;
  sources: SelfImproveSources;
  userContext: string;
}

export interface SelfImproveRunRef {
  runId: string;
  status: string;
  worktreePath?: string;
  runDoc?: string;
}

export interface SelfImproveLoopState {
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
  autoMerge: true;
  stopRequested: boolean;
  sourceSnapshot: SelfImproveConfig;
  prompt: string;
  currentRun?: SelfImproveRunRef;
  lastRun?: SelfImproveRunRef;
}

export interface SelfImproveActivePointer {
  activeLoopId: string;
}

export const SELF_IMPROVE_DIR = path.join('.qwen', 'self-improve');

export const DEFAULT_SELF_IMPROVE_CONFIG: SelfImproveConfig = {
  version: 1,
  sources: {
    githubIssues: false,
    githubPrs: false,
    localSignals: false,
  },
  userContext: '',
};

export function getSelfImproveRoot(repoRoot: string): string {
  return path.join(repoRoot, SELF_IMPROVE_DIR);
}

export function getSelfImproveConfigPath(repoRoot: string): string {
  return path.join(getSelfImproveRoot(repoRoot), 'config.json');
}

export function getSelfImproveActivePath(repoRoot: string): string {
  return path.join(getSelfImproveRoot(repoRoot), 'active.json');
}

export function getSelfImproveLoopDir(
  repoRoot: string,
  loopId: string,
): string {
  return path.join(getSelfImproveRoot(repoRoot), 'loops', loopId);
}

export function getSelfImproveStatePath(
  repoRoot: string,
  loopId: string,
): string {
  return path.join(getSelfImproveLoopDir(repoRoot, loopId), 'state.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBoolean(value: unknown): boolean {
  return typeof value === 'boolean' ? value : false;
}

function normalizeConfig(value: unknown): SelfImproveConfig {
  if (!isRecord(value)) return DEFAULT_SELF_IMPROVE_CONFIG;
  const rawSources = value['sources'];
  const sources = isRecord(rawSources) ? rawSources : {};
  return {
    version: 1,
    sources: {
      githubIssues: readBoolean(sources['githubIssues']),
      githubPrs: readBoolean(sources['githubPrs']),
      localSignals: readBoolean(sources['localSignals']),
    },
    userContext:
      typeof value['userContext'] === 'string' ? value['userContext'] : '',
  };
}

export async function ensureSelfImproveRoot(repoRoot: string): Promise<void> {
  await fs.mkdir(getSelfImproveRoot(repoRoot), { recursive: true });
}

export async function readSelfImproveConfig(
  repoRoot: string,
): Promise<SelfImproveConfig> {
  try {
    const raw = await fs.readFile(getSelfImproveConfigPath(repoRoot), 'utf8');
    return normalizeConfig(JSON.parse(raw));
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return DEFAULT_SELF_IMPROVE_CONFIG;
    }
    throw error;
  }
}

export async function writeSelfImproveConfig(
  repoRoot: string,
  config: SelfImproveConfig,
): Promise<void> {
  await ensureSelfImproveRoot(repoRoot);
  await fs.writeFile(
    getSelfImproveConfigPath(repoRoot),
    `${JSON.stringify(normalizeConfig(config), null, 2)}\n`,
    'utf8',
  );
}

export async function readActiveSelfImproveLoop(
  repoRoot: string,
): Promise<SelfImproveActivePointer | null> {
  try {
    const raw = await fs.readFile(getSelfImproveActivePath(repoRoot), 'utf8');
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

export async function writeActiveSelfImproveLoop(
  repoRoot: string,
  loopId: string,
): Promise<void> {
  await ensureSelfImproveRoot(repoRoot);
  await fs.writeFile(
    getSelfImproveActivePath(repoRoot),
    `${JSON.stringify({ activeLoopId: loopId }, null, 2)}\n`,
    'utf8',
  );
}

export async function clearActiveSelfImproveLoop(
  repoRoot: string,
): Promise<void> {
  await fs.rm(getSelfImproveActivePath(repoRoot), { force: true });
}

export async function readSelfImproveLoopState(
  repoRoot: string,
  loopId: string,
): Promise<SelfImproveLoopState | null> {
  try {
    const raw = await fs.readFile(
      getSelfImproveStatePath(repoRoot, loopId),
      'utf8',
    );
    return JSON.parse(raw) as SelfImproveLoopState;
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

export async function writeSelfImproveLoopState(
  repoRoot: string,
  state: SelfImproveLoopState,
): Promise<void> {
  const loopDir = getSelfImproveLoopDir(repoRoot, state.loopId);
  await fs.mkdir(path.join(loopDir, 'runs'), { recursive: true });
  await fs.writeFile(
    path.join(loopDir, 'state.json'),
    `${JSON.stringify(state, null, 2)}\n`,
    'utf8',
  );
}

export async function initializeSelfImproveLoopFiles(
  repoRoot: string,
  state: SelfImproveLoopState,
): Promise<void> {
  const loopDir = getSelfImproveLoopDir(repoRoot, state.loopId);
  await fs.mkdir(path.join(loopDir, 'runs'), { recursive: true });
  await writeSelfImproveLoopState(repoRoot, state);
  await fs.writeFile(
    path.join(loopDir, 'summary.md'),
    [
      '# Self-Improve Summary',
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

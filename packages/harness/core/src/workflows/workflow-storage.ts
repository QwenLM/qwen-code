/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import os from 'node:os';
import * as path from 'node:path';
import {
  CONFIG_DIR,
  GLOBAL_CONFIG_DIR,
} from '../utils/paths.js';
import { isNetworkPathEnforced, isNetworkShapedPath } from '../utils/pathShape.js';
import {
  WORKFLOW_MAX_SCRIPT_BYTES,
  type ResolvedWorkflowScript,
  type WorkflowAgentProgress,
  type WorkflowRunAgentIndex,
  type WorkflowRunSnapshot,
  type WorkflowMeta,
} from './workflow-types.js';
import { runLogger } from '../utils/runLogger.js';
import { isMissingPathError } from '../utils/errors.js';
import { getSessionArtifactProjectRoots } from '../services/sessionArtifactRoots.js';

export interface WorkflowRunManifest {
  runId: string;
  resumedFromRunId?: string;
  workflowName: string;
  scriptPath: string;
  source: ResolvedWorkflowScript['source'];
  args?: unknown;
  meta: WorkflowMeta;
  createdAt: string;
  updatedAt: string;
  status: 'running' | 'completed' | 'failed' | 'killed';
  outputPath?: string;
  agents?: WorkflowRunAgentIndex[];
}

export function getWorkflowSessionDir(
  projectRoot: string,
  sessionId: string,
): string {
  return path.join(projectRoot, CONFIG_DIR, 'sessions', sessionId, 'workflows');
}

/** 历史 run 原地续跑，保证 manifest、journal 和脚本仍属于同一份产物。 */
export async function resolveWorkflowRunProjectRoot(
  projectRoot: string,
  sessionId: string,
  runId: string,
  sessionTranscriptPath?: string,
): Promise<string> {
  try {
    const directory = getWorkflowTranscriptDir(projectRoot, sessionId, runId);
    if (!(await fs.stat(directory)).isDirectory()) {
      throw new Error(`Workflow run is not a directory: ${directory}`);
    }
    return projectRoot;
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  const roots = await getSessionArtifactProjectRoots(
    projectRoot,
    sessionId,
    sessionTranscriptPath,
  );
  for (const root of roots) {
    if (root === projectRoot) continue;
    try {
      const directory = getWorkflowTranscriptDir(root, sessionId, runId);
      if (!(await fs.stat(directory)).isDirectory()) {
        throw new Error(`Workflow run is not a directory: ${directory}`);
      }
      return root;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
  }
  return projectRoot;
}

export function getWorkflowTranscriptDir(
  projectRoot: string,
  sessionId: string,
  runId: string,
): string {
  return path.join(getWorkflowSessionDir(projectRoot, sessionId), 'runs', runId);
}

export function getWorkflowScriptsDir(
  projectRoot: string,
  sessionId: string,
): string {
  return path.join(getWorkflowSessionDir(projectRoot, sessionId), 'scripts');
}

export function getWorkflowOutputPath(
  projectRoot: string,
  sessionId: string,
  runId: string,
): string {
  return path.join(getWorkflowTranscriptDir(projectRoot, sessionId, runId), 'output.json');
}

export function getWorkflowRunManifestPath(
  projectRoot: string,
  sessionId: string,
  runId: string,
): string {
  return path.join(
    getWorkflowTranscriptDir(projectRoot, sessionId, runId),
    'manifest.json',
  );
}

export function getWorkflowRunSnapshotPath(
  projectRoot: string,
  sessionId: string,
  runId: string,
): string {
  return path.join(
    getWorkflowTranscriptDir(projectRoot, sessionId, runId),
    'snapshot.json',
  );
}

export function getWorkflowJournalPath(
  projectRoot: string,
  sessionId: string,
  runId: string,
): string {
  return path.join(
    getWorkflowTranscriptDir(projectRoot, sessionId, runId),
    'journal.jsonl',
  );
}

export function getProjectWorkflowsDir(projectRoot: string): string {
  return path.join(projectRoot, CONFIG_DIR, 'workflows');
}

export function getUserWorkflowsDir(homeDir = os.homedir()): string {
  return path.join(homeDir, GLOBAL_CONFIG_DIR, 'workflows');
}

export function getUserWorkflowsDirFromConfigRoot(
  configRoot: string,
): string {
  return path.join(configRoot, 'workflows');
}

export async function persistWorkflowScript(params: {
  projectRoot: string;
  sessionId: string;
  workflowName: string;
  runId: string;
  script: string;
}): Promise<string> {
  const scriptsDir = getWorkflowScriptsDir(params.projectRoot, params.sessionId);
  await fs.mkdir(scriptsDir, { recursive: true, mode: 0o700 });
  const scriptPath = path.join(
    scriptsDir,
    `${slugifyWorkflowName(params.workflowName)}-${params.runId}.js`,
  );
  await fs.writeFile(scriptPath, params.script, { encoding: 'utf8', mode: 0o600 });
  return scriptPath;
}

export async function readWorkflowScriptFile(
  scriptPath: string,
  cwd: string,
): Promise<{ script: string; scriptPath: string }> {
  // Engine-level guard, not a tool permission decision: this loader runs
  // outside the permission pipeline, so there is nothing to defer to. Uses the
  // shared classifier to also cover extended UNC, mixed sigils and automount.
  // Windows-only: enforcement follows isNetworkPathEnforced().
  if (isNetworkPathEnforced() && isNetworkShapedPath(scriptPath)) {
    throw new Error('Network workflow script paths are not allowed');
  }
  const resolvedPath = path.isAbsolute(scriptPath)
    ? scriptPath
    : path.resolve(cwd, scriptPath);
  const bytes = await fs.readFile(resolvedPath);
  if (bytes.byteLength > WORKFLOW_MAX_SCRIPT_BYTES) {
    throw new Error(`Script exceeds ${WORKFLOW_MAX_SCRIPT_BYTES} bytes`);
  }
  return { script: bytes.toString('utf8'), scriptPath: resolvedPath };
}

export async function readWorkflowRunManifest(
  projectRoot: string,
  sessionId: string,
  runId: string,
): Promise<WorkflowRunManifest> {
  const manifestPath = getWorkflowRunManifestPath(projectRoot, sessionId, runId);
  const raw = await fs.readFile(manifestPath, 'utf8');
  const parsed = JSON.parse(raw) as WorkflowRunManifest;
  if (!parsed.scriptPath || !parsed.workflowName) {
    throw new Error(`Malformed workflow manifest: ${manifestPath}`);
  }
  return parsed;
}

export async function writeWorkflowRunManifest(
  projectRoot: string,
  sessionId: string,
  manifest: WorkflowRunManifest,
): Promise<string> {
  const manifestPath = getWorkflowRunManifestPath(
    projectRoot,
    sessionId,
    manifest.runId,
  );
  await fs.mkdir(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  return manifestPath;
}

export async function writeWorkflowOutput(params: {
  projectRoot: string;
  sessionId: string;
  runId: string;
  value: unknown;
}): Promise<string> {
  const outputPath = getWorkflowOutputPath(
    params.projectRoot,
    params.sessionId,
    params.runId,
  );
  await fs.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(outputPath, JSON.stringify(params.value, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  return outputPath;
}

export async function writeWorkflowRunSnapshot(
  projectRoot: string,
  sessionId: string,
  snapshot: WorkflowRunSnapshot,
): Promise<string> {
  const snapshotPath = getWorkflowRunSnapshotPath(
    projectRoot,
    sessionId,
    snapshot.runId,
  );
  await fs.mkdir(path.dirname(snapshotPath), {
    recursive: true,
    mode: 0o700,
  });
  await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  return snapshotPath;
}

export async function readWorkflowRunSnapshot(
  projectRoot: string,
  sessionId: string,
  runId: string,
): Promise<WorkflowRunSnapshot> {
  const snapshotPath = getWorkflowRunSnapshotPath(
    projectRoot,
    sessionId,
    runId,
  );
  const raw = await fs.readFile(snapshotPath, 'utf8');
  return parseWorkflowRunSnapshot(JSON.parse(raw), snapshotPath);
}

/**
 * Lists terminal workflow history for one session.
 *
 * New runs use snapshot.json. Runs created before snapshots were introduced
 * are projected from their existing manifest.json and output.json artifacts.
 * A corrupt run is isolated so the remaining history stays browseable.
 */
export async function listWorkflowRunSnapshots(
  projectRoot: string,
  sessionId: string,
  sessionTranscriptPath?: string,
  projectRoots?: readonly string[],
): Promise<WorkflowRunSnapshot[]> {
  const roots =
    projectRoots ??
    (await getSessionArtifactProjectRoots(
      projectRoot,
      sessionId,
      sessionTranscriptPath,
    ));
  const runRoots = new Map<string, string>();
  for (const root of roots) {
    const runsDir = path.join(getWorkflowSessionDir(root, sessionId), 'runs');
    let entries;
    try {
      entries = await fs.readdir(runsDir, { withFileTypes: true });
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !runRoots.has(entry.name)) {
        runRoots.set(entry.name, root);
      }
    }
  }

  const snapshots = await Promise.all(
    [...runRoots].map(
      async ([runId, root]): Promise<WorkflowRunSnapshot | null> => {
        try {
          return await readWorkflowRunSnapshot(root, sessionId, runId);
        } catch (snapshotError) {
          if (errorCode(snapshotError) !== 'ENOENT') {
            runLogger.warn(
              `Failed to read workflow snapshot ${runId}: ${formatError(snapshotError)}`,
            );
          }
        }

        try {
          return await readLegacyWorkflowRunSnapshot(root, sessionId, runId);
        } catch (legacyError) {
          runLogger.warn(
            `Failed to read workflow history ${runId}: ${formatError(legacyError)}`,
          );
          return null;
        }
      },
    ),
  );

  return snapshots
    .filter((snapshot): snapshot is WorkflowRunSnapshot => snapshot !== null)
    .sort((a, b) => b.startTime - a.startTime);
}

export function slugifyWorkflowName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'workflow';
}

function parseWorkflowRunSnapshot(
  value: unknown,
  sourcePath: string,
): WorkflowRunSnapshot {
  if (!isRecord(value)) {
    throw new Error(`Malformed workflow snapshot: ${sourcePath}`);
  }
  const {
    version,
    sessionId,
    runId,
    taskId,
    workflowName,
    title,
    summary,
    status,
    startTime,
    endTime,
    scriptPath,
    transcriptDir,
    outputPath,
    args,
    phases,
    progress,
    agentCount,
    totalTokens,
    totalToolCalls,
    logs,
    result,
    error,
  } = value;
  if (
    version !== 1 ||
    typeof sessionId !== 'string' ||
    typeof runId !== 'string' ||
    typeof taskId !== 'string' ||
    typeof workflowName !== 'string' ||
    (title !== undefined && typeof title !== 'string') ||
    typeof summary !== 'string' ||
    !isTerminalWorkflowStatus(status) ||
    typeof startTime !== 'number' ||
    typeof endTime !== 'number' ||
    typeof scriptPath !== 'string' ||
    typeof transcriptDir !== 'string' ||
    (outputPath !== undefined && typeof outputPath !== 'string') ||
    (phases !== undefined && !Array.isArray(phases)) ||
    !Array.isArray(progress) ||
    typeof agentCount !== 'number' ||
    typeof totalTokens !== 'number' ||
    typeof totalToolCalls !== 'number' ||
    !Array.isArray(logs) ||
    (error !== undefined && typeof error !== 'string')
  ) {
    throw new Error(`Malformed workflow snapshot: ${sourcePath}`);
  }
  return {
    version,
    sessionId,
    runId,
    taskId,
    workflowName,
    ...(title !== undefined ? { title } : {}),
    summary,
    status,
    startTime,
    endTime,
    scriptPath,
    transcriptDir,
    ...(outputPath !== undefined ? { outputPath } : {}),
    ...(args !== undefined ? { args } : {}),
    ...(phases !== undefined ? { phases } : {}),
    progress,
    agentCount,
    totalTokens,
    totalToolCalls,
    logs,
    ...(result !== undefined ? { result } : {}),
    ...(error !== undefined ? { error } : {}),
  } satisfies WorkflowRunSnapshot;
}

async function readLegacyWorkflowRunSnapshot(
  projectRoot: string,
  sessionId: string,
  runId: string,
): Promise<WorkflowRunSnapshot | null> {
  const manifest = await readWorkflowRunManifest(
    projectRoot,
    sessionId,
    runId,
  );
  if (!isTerminalWorkflowStatus(manifest.status)) return null;

  const output = await readOptionalJsonRecord(
    getWorkflowOutputPath(projectRoot, sessionId, runId),
  );
  const usage = isRecord(output?.['usage']) ? output['usage'] : undefined;
  const agents = manifest.agents ?? [];
  const startTime = parseTimestamp(manifest.createdAt);
  const endTime = parseTimestamp(manifest.updatedAt, startTime);

  return {
    version: 1,
    sessionId,
    runId,
    taskId: stringValue(output?.['taskId']) ?? runId,
    workflowName: manifest.workflowName,
    title: manifest.meta.title,
    summary: manifest.meta.description,
    status: manifest.status,
    startTime,
    endTime,
    scriptPath: manifest.scriptPath,
    transcriptDir: getWorkflowTranscriptDir(projectRoot, sessionId, runId),
    outputPath: manifest.outputPath,
    args: manifest.args,
    phases: manifest.meta.phases,
    progress: agents.map(legacyAgentToProgress),
    agentCount:
      numberValue(output?.['agentCount']) ??
      numberValue(usage?.['agents']) ??
      agents.length,
    totalTokens: numberValue(output?.['totalTokens']) ?? 0,
    totalToolCalls:
      numberValue(output?.['totalToolCalls']) ??
      numberValue(usage?.['toolCalls']) ??
      0,
    logs: stringArray(output?.['logs']),
    result: output?.['result'],
    error: stringValue(output?.['error']),
  };
}

function legacyAgentToProgress(
  agent: WorkflowRunAgentIndex,
): WorkflowAgentProgress {
  return {
    type: 'workflow_agent',
    index: agent.index,
    label: agent.label,
    phaseIndex: agent.phaseIndex,
    phaseTitle: agent.phaseTitle,
    journalKey: agent.journalKey,
    agentId: agent.agentId,
    agentType: agent.agentType,
    model: agent.model,
    effort: agent.effort,
    state: agent.state,
    cached: agent.cached,
    skipped: agent.skipped,
    attempt: agent.attempts,
    outputPath: agent.outputPath,
    transcriptPath: agent.transcriptPath,
    attemptTranscriptPaths: agent.attemptTranscriptPaths,
  };
}

async function readOptionalJsonRecord(
  filePath: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
    return isRecord(value) ? value : undefined;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

function isTerminalWorkflowStatus(
  value: unknown,
): value is WorkflowRunSnapshot['status'] {
  return value === 'completed' || value === 'failed' || value === 'killed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function parseTimestamp(value: string, fallback = 0): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : fallback;
}

function errorCode(error: unknown): string | undefined {
  const code = isRecord(error) ? error['code'] : undefined;
  return typeof code === 'string' ? code : undefined;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

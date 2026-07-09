/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import type { Config } from '../config/config.js';
import { ToolNames, ToolNamesMigration } from '../tools/tool-names.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { isAllowedMemoryPath } from './memory-scoped-agent-config.js';
import {
  rebuildManagedAutoMemoryIndex,
  rebuildUserAutoMemoryIndex,
} from './indexer.js';

const debugLogger = createDebugLogger('AUTO_MEMORY_REFRESH');

export interface MemoryWriteCandidate {
  toolName: string;
  args?: Record<string, unknown>;
  status?: string;
}

export interface RefreshMemoryAfterWriteOptions {
  rebuildIndexes?: boolean;
  logContext?: string;
}

const WRITE_TOOL_NAMES = new Set<string>([
  ToolNames.WRITE_FILE,
  ToolNames.EDIT,
]);

function canonicalToolName(toolName: string): string {
  return (ToolNamesMigration as Record<string, string>)[toolName] ?? toolName;
}

function candidateFilePath(
  args: Record<string, unknown> | undefined,
): string | undefined {
  const value = args?.['file_path'] ?? args?.['path'] ?? args?.['target_file'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function resolveCandidatePath(filePath: string, projectRoot: string): string {
  return path.resolve(projectRoot, filePath);
}

function isSuccessfulWrite(candidate: MemoryWriteCandidate): boolean {
  if (candidate.status !== undefined && candidate.status !== 'success') {
    return false;
  }
  return WRITE_TOOL_NAMES.has(canonicalToolName(candidate.toolName));
}

function logPrefix(
  options?: Pick<RefreshMemoryAfterWriteOptions, 'logContext'>,
) {
  return options?.logContext ? `${options.logContext}: ` : '';
}

function classifyWrittenMemoryScope(
  candidate: MemoryWriteCandidate,
  projectRoot: string,
): 'project' | 'user' | undefined {
  if (!isSuccessfulWrite(candidate)) {
    return undefined;
  }
  const filePath = candidateFilePath(candidate.args);
  if (!filePath) {
    return undefined;
  }
  const resolved = resolveCandidatePath(filePath, projectRoot);
  if (!isAllowedMemoryPath(resolved, projectRoot)) {
    return undefined;
  }
  return isAllowedMemoryPath(resolved, projectRoot, {
    includeUserMemory: false,
  })
    ? 'project'
    : 'user';
}

export function didWriteManagedMemory(
  candidates: readonly MemoryWriteCandidate[],
  projectRoot: string,
): boolean {
  return candidates.some(
    (candidate) =>
      classifyWrittenMemoryScope(candidate, projectRoot) !== undefined,
  );
}

async function rebuildWrittenMemoryIndexes(
  candidates: readonly MemoryWriteCandidate[],
  projectRoot: string,
  options?: Pick<RefreshMemoryAfterWriteOptions, 'logContext'>,
): Promise<void> {
  let wroteProjectMemory = false;
  let wroteUserMemory = false;

  for (const candidate of candidates) {
    const scope = classifyWrittenMemoryScope(candidate, projectRoot);
    wroteProjectMemory ||= scope === 'project';
    wroteUserMemory ||= scope === 'user';
  }

  await Promise.all([
    wroteProjectMemory
      ? rebuildManagedAutoMemoryIndex(projectRoot).catch((err: unknown) => {
          debugLogger.warn(
            `${logPrefix(options)}rebuildManagedAutoMemoryIndex failed: ${err}`,
          );
        })
      : Promise.resolve(),
    wroteUserMemory
      ? rebuildUserAutoMemoryIndex().catch((err: unknown) => {
          debugLogger.warn(
            `${logPrefix(options)}rebuildUserAutoMemoryIndex failed: ${err}`,
          );
        })
      : Promise.resolve(),
  ]);
}

export async function refreshMemoryInstruction(
  config: Config,
  options?: Pick<RefreshMemoryAfterWriteOptions, 'logContext'>,
): Promise<void> {
  try {
    await config.refreshHierarchicalMemory();
  } catch (err) {
    debugLogger.warn(
      `${logPrefix(options)}refreshHierarchicalMemory failed: ${err}`,
    );
  }

  try {
    await config.getGeminiClient()?.refreshSystemInstruction();
  } catch (err) {
    debugLogger.warn(
      `${logPrefix(options)}refreshSystemInstruction failed: ${err}`,
    );
  }
}

export async function refreshMemoryAfterManagedWrite(
  config: Config,
  candidates: readonly MemoryWriteCandidate[],
  options: RefreshMemoryAfterWriteOptions = {},
): Promise<boolean> {
  if (typeof config.isManagedMemoryAvailable !== 'function') {
    return false;
  }
  if (!config.isManagedMemoryAvailable()) {
    return false;
  }

  const projectRoot = config.getProjectRoot();
  if (!didWriteManagedMemory(candidates, projectRoot)) {
    return false;
  }

  if (options.rebuildIndexes ?? true) {
    await rebuildWrittenMemoryIndexes(candidates, projectRoot, options);
  }

  await refreshMemoryInstruction(config, options);
  return true;
}

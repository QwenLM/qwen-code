/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import type { Config } from '../config/config.js';
import { normalizeQwenCustomIgnoreFileNames } from '../utils/qwenIgnoreParser.js';
import type { SerializedFileHistorySnapshot } from '../services/fileHistoryService.js';
import type { ManagedToolFileHistoryState } from './managed-tool-file-history.js';
import {
  managedToolDigest,
  ManagedToolProtocolError,
} from './managed-tool-protocol.js';

export const MANAGED_TOOL_FILE_HISTORY_MAX_BYTES = 8 * 1024 * 1024;

export interface ManagedToolExecutionContext {
  workspaceDirectories: string[];
  memoryBaseDir: string;
  lsToolEnabled: boolean;
  grepOptions?: {
    useRipgrep: boolean;
    useBuiltinRipgrep: boolean;
  };
  outputLimits?: {
    chars: number | null;
    lines: number | null;
    charsExplicit: boolean;
  };
  fileFilteringOptions: {
    respectGitIgnore: boolean;
    respectQwenIgnore: boolean;
    customIgnoreFiles: string[];
  };
}

export function captureManagedToolExecutionContext(
  config: Config,
): ManagedToolExecutionContext {
  const filtering = config.getFileFilteringOptions();
  return {
    workspaceDirectories: [...config.getWorkspaceContext().getDirectories()],
    memoryBaseDir: config.getMemoryBaseDir(),
    lsToolEnabled: config.isLsToolEnabled(),
    grepOptions: {
      useRipgrep: config.getUseRipgrep(),
      useBuiltinRipgrep: config.getUseBuiltinRipgrep(),
    },
    outputLimits: {
      chars: encodeOutputLimit(config.getTruncateToolOutputThreshold()),
      lines: encodeOutputLimit(config.getTruncateToolOutputLines()),
      charsExplicit: config.isTruncateToolOutputThresholdExplicit(),
    },
    fileFilteringOptions: {
      respectGitIgnore: filtering.respectGitIgnore,
      respectQwenIgnore: filtering.respectQwenIgnore,
      customIgnoreFiles: normalizeQwenCustomIgnoreFileNames(
        filtering.customIgnoreFiles,
      ),
    },
  };
}

export interface ManagedToolFileHistoryBinding {
  ownerSessionId: string;
  ownerRuntimeSessionId: string;
  executionCwd: string;
  executionContext?: ManagedToolExecutionContext;
  snapshots: SerializedFileHistorySnapshot[];
}

export interface ManagedToolFileHistoryClient {
  bind(
    binding: ManagedToolFileHistoryBinding,
  ): Promise<ManagedToolFileHistoryState>;
  checkpoint(promptId: string): Promise<ManagedToolFileHistoryState>;
  snapshot(): Promise<ManagedToolFileHistoryState>;
}

function record(
  value: unknown,
  keys?: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ManagedToolProtocolError();
  const result = value as Record<string, unknown>;
  if (keys && Object.keys(result).some((key) => !keys.includes(key)))
    throw new ManagedToolProtocolError();
  return result;
}

function text(value: unknown, limit: number): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > limit ||
    value.includes('\0')
  )
    throw new ManagedToolProtocolError();
  return value;
}

function uuid(value: unknown): string {
  const result = text(value, 256);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      result,
    )
  )
    throw new ManagedToolProtocolError();
  return result;
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new ManagedToolProtocolError();
  return value;
}

function timestamp(value: unknown): string {
  const result = text(value, 32);
  const date = new Date(result);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== result)
    throw new ManagedToolProtocolError();
  return result;
}

export function parseManagedToolFileHistoryPromptId(value: unknown): string {
  return text(value, 128);
}

function snapshots(value: unknown): SerializedFileHistorySnapshot[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new ManagedToolProtocolError();
  const prompts = new Set<string>();
  return value.map((item) => {
    const snapshot = record(item, [
      'promptId',
      'timestamp',
      'trackedFileBackups',
    ]);
    const promptId = parseManagedToolFileHistoryPromptId(snapshot['promptId']);
    if (prompts.has(promptId)) throw new ManagedToolProtocolError();
    prompts.add(promptId);
    return {
      promptId,
      timestamp: timestamp(snapshot['timestamp']),
      trackedFileBackups: Object.fromEntries(
        Object.entries(record(snapshot['trackedFileBackups'])).map(
          ([filePath, value]) => {
            text(filePath, 4096);
            if (filePath.split(path.sep).includes('..'))
              throw new ManagedToolProtocolError();
            const backup = record(value, [
              'backupFileName',
              'version',
              'backupTime',
              'failed',
            ]);
            const backupFileName =
              backup['backupFileName'] === null
                ? null
                : text(backup['backupFileName'], 256);
            if (
              backupFileName !== null &&
              (backupFileName === '.' ||
                backupFileName === '..' ||
                /[/\\]/.test(backupFileName))
            )
              throw new ManagedToolProtocolError();
            if ('failed' in backup && typeof backup['failed'] !== 'boolean')
              throw new ManagedToolProtocolError();
            return [
              filePath,
              {
                backupFileName,
                version: integer(backup['version']),
                backupTime: timestamp(backup['backupTime']),
                ...('failed' in backup
                  ? { failed: backup['failed'] as boolean }
                  : {}),
              },
            ];
          },
        ),
      ),
    };
  });
}

function absolutePath(value: unknown): string {
  const result = text(value, 4096);
  if (!path.isAbsolute(result) || path.normalize(result) !== result)
    throw new ManagedToolProtocolError();
  return result;
}

function encodeOutputLimit(value: number): number | null {
  return value === Number.POSITIVE_INFINITY ? null : value;
}

function outputLimit(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw new ManagedToolProtocolError();
  return value;
}

function grepOptions(
  value: unknown,
): ManagedToolExecutionContext['grepOptions'] {
  const input = record(value, ['useRipgrep', 'useBuiltinRipgrep']);
  if (
    typeof input['useRipgrep'] !== 'boolean' ||
    typeof input['useBuiltinRipgrep'] !== 'boolean'
  )
    throw new ManagedToolProtocolError();
  return {
    useRipgrep: input['useRipgrep'],
    useBuiltinRipgrep: input['useBuiltinRipgrep'],
  };
}

function outputLimits(
  value: unknown,
): ManagedToolExecutionContext['outputLimits'] {
  const input = record(value, ['chars', 'lines', 'charsExplicit']);
  if (typeof input['charsExplicit'] !== 'boolean')
    throw new ManagedToolProtocolError();
  return {
    chars: outputLimit(input['chars']),
    lines: outputLimit(input['lines']),
    charsExplicit: input['charsExplicit'],
  };
}

function executionContext(value: unknown): ManagedToolExecutionContext {
  const input = record(value, [
    'workspaceDirectories',
    'memoryBaseDir',
    'fileFilteringOptions',
    'lsToolEnabled',
    'grepOptions',
    'outputLimits',
  ]);
  const filtering = record(input['fileFilteringOptions'], [
    'respectGitIgnore',
    'respectQwenIgnore',
    'customIgnoreFiles',
  ]);
  if (
    !Array.isArray(input['workspaceDirectories']) ||
    !Array.isArray(filtering['customIgnoreFiles']) ||
    typeof filtering['respectGitIgnore'] !== 'boolean' ||
    typeof filtering['respectQwenIgnore'] !== 'boolean' ||
    typeof input['lsToolEnabled'] !== 'boolean'
  )
    throw new ManagedToolProtocolError();
  const directories = input['workspaceDirectories'].map(absolutePath);
  if (new Set(directories).size !== directories.length)
    throw new ManagedToolProtocolError();
  const customIgnoreFiles = filtering['customIgnoreFiles'].map((value) =>
    text(value, 4096),
  );
  if (
    JSON.stringify(normalizeQwenCustomIgnoreFileNames(customIgnoreFiles)) !==
    JSON.stringify(customIgnoreFiles)
  )
    throw new ManagedToolProtocolError();
  return {
    workspaceDirectories: directories,
    memoryBaseDir: absolutePath(input['memoryBaseDir']),
    lsToolEnabled: input['lsToolEnabled'],
    ...('grepOptions' in input
      ? { grepOptions: grepOptions(input['grepOptions']) }
      : {}),
    ...('outputLimits' in input
      ? { outputLimits: outputLimits(input['outputLimits']) }
      : {}),
    fileFilteringOptions: {
      respectGitIgnore: filtering['respectGitIgnore'],
      respectQwenIgnore: filtering['respectQwenIgnore'],
      customIgnoreFiles,
    },
  };
}

export function parseManagedToolFileHistoryBinding(
  value: unknown,
): ManagedToolFileHistoryBinding {
  managedToolDigest(value, MANAGED_TOOL_FILE_HISTORY_MAX_BYTES);
  const input = record(value, [
    'ownerSessionId',
    'ownerRuntimeSessionId',
    'executionCwd',
    'executionContext',
    'snapshots',
  ]);
  const executionCwd = text(input['executionCwd'], 4096);
  if (
    !path.isAbsolute(executionCwd) ||
    path.normalize(executionCwd) !== executionCwd
  )
    throw new ManagedToolProtocolError();
  return {
    ownerSessionId: uuid(input['ownerSessionId']),
    ownerRuntimeSessionId: uuid(input['ownerRuntimeSessionId']),
    executionCwd,
    ...('executionContext' in input
      ? { executionContext: executionContext(input['executionContext']) }
      : {}),
    snapshots: snapshots(input['snapshots']),
  };
}

export function parseManagedToolFileHistoryState(
  value: unknown,
): ManagedToolFileHistoryState {
  managedToolDigest(value, MANAGED_TOOL_FILE_HISTORY_MAX_BYTES);
  const input = record(value, ['ownerSessionId', 'revision', 'snapshots']);
  return {
    ownerSessionId: uuid(input['ownerSessionId']),
    revision: integer(input['revision']),
    snapshots: snapshots(input['snapshots']),
  };
}

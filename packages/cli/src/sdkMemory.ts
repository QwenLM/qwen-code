/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  directoryPermissionPattern,
  estimateTextTokens,
  type PermissionUpdate,
} from '@qwen-code/core';

export type SdkMemoryRoot = {
  id: string;
  path: string;
  access: 'read' | 'read-write';
  indexFile?: string;
};

export type SdkMemoryConsumptionFile = {
  id: string;
  path: string;
  required: boolean;
};

export type SdkMemoryConfig = {
  requester: 'sdk';
  mode: 'native' | 'custom';
  projectScope?: boolean;
  userScope?: boolean;
  generation?: {
    enabled?: boolean;
    roots?: SdkMemoryRoot[];
    prompt?: string;
    turnComplete?: {
      enabled?: boolean;
      shouldGenerateCallbackId?: string;
      timeoutMs?: number;
      onGateError?: 'skip' | 'report_failed';
    };
  };
  consumption?: {
    enabled?: boolean;
    files?: SdkMemoryConsumptionFile[];
    maxTokens?: number;
    overflow?: 'truncate' | 'fail_query';
    failureMode?: 'best_effort' | 'fail_query';
  };
};

export type SdkMemoryConsumptionResult = {
  status: 'success' | 'partial' | 'failed';
  files: Array<{
    id: string;
    path: string;
    status: 'loaded' | 'missing' | 'failed' | 'truncated';
    error?: string;
  }>;
};

type NativeMemoryIndexFileState = {
  scope: string;
  indexPath: string;
  retainIfMissing?: boolean;
  isPartialView?: boolean;
  loadError?: string;
};

export type LoadedSdkMemoryConsumption = {
  context?: Record<string, string>;
  result: SdkMemoryConsumptionResult;
  fileStates: SdkMemoryConsumptionFileState[];
  fatalError?: string;
};

export type SdkMemoryConsumptionFileState = {
  filePath: string;
  content: string;
  timestamp: number;
  isPartialView?: boolean;
  retainIfMissing?: boolean;
};

export function resolveSdkMemoryEnablement(config: SdkMemoryConfig): {
  generationEnabled: boolean;
  turnCompleteEnabled: boolean;
  consumptionEnabled: boolean;
} {
  const generationEnabled = config.generation?.enabled !== false;
  return {
    generationEnabled,
    turnCompleteEnabled:
      generationEnabled && config.generation?.turnComplete?.enabled !== false,
    consumptionEnabled: config.consumption?.enabled !== false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

export function resolveSdkMemoryPath(input: string): string {
  const expanded = input === '~' || input.startsWith(`~${path.sep}`)
    ? path.join(os.homedir(), input.slice(2))
    : input;
  return path.resolve(expanded);
}

function parseRoots(value: unknown): SdkMemoryRoot[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('memory.generation.roots must be a non-empty array');
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`memory.generation.roots[${index}] must be an object`);
    }
    const id = nonEmptyString(entry['id'], `memory.generation.roots[${index}].id`);
    if (ids.has(id)) throw new Error(`duplicate memory root id: ${id}`);
    ids.add(id);
    const rootPath = resolveSdkMemoryPath(
      nonEmptyString(entry['path'], `memory.generation.roots[${index}].path`),
    );
    const access = entry['access'] ?? 'read-write';
    if (access !== 'read' && access !== 'read-write') {
      throw new Error(`memory.generation.roots[${index}].access is invalid`);
    }
    const rawIndexFile = entry['indexFile'];
    let indexFile: string | undefined;
    if (rawIndexFile !== undefined) {
      indexFile = nonEmptyString(
        rawIndexFile,
        `memory.generation.roots[${index}].indexFile`,
      );
      const normalizedIndexFile = indexFile.replaceAll('\\', '/');
      if (
        path.posix.isAbsolute(normalizedIndexFile) ||
        path.win32.isAbsolute(indexFile) ||
        normalizedIndexFile.split('/').includes('..')
      ) {
        throw new Error(
          `memory.generation.roots[${index}].indexFile must stay within its root`,
        );
      }
    }
    return { id, path: rootPath, access, indexFile };
  });
}

function parseConsumptionFiles(
  value: unknown,
): SdkMemoryConsumptionFile[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('memory.consumption.files must be a non-empty array');
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`memory.consumption.files[${index}] must be an object`);
    }
    const id = nonEmptyString(entry['id'], `memory.consumption.files[${index}].id`);
    if (ids.has(id)) throw new Error(`duplicate memory consumption id: ${id}`);
    ids.add(id);
    const required = entry['required'];
    if (required !== undefined && typeof required !== 'boolean') {
      throw new Error(`memory.consumption.files[${index}].required must be boolean`);
    }
    return {
      id,
      path: resolveSdkMemoryPath(
        nonEmptyString(entry['path'], `memory.consumption.files[${index}].path`),
      ),
      required: required ?? false,
    };
  });
}

export function parseSdkMemoryConfig(value: unknown): SdkMemoryConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value['requester'] !== 'sdk') {
    throw new Error('memory.requester must be "sdk"');
  }
  const mode = value['mode'];
  if (mode !== 'native' && mode !== 'custom') {
    throw new Error('memory.mode must be "native" or "custom"');
  }
  const projectScope = value['projectScope'];
  if (projectScope !== undefined && typeof projectScope !== 'boolean') {
    throw new Error('memory.projectScope must be boolean');
  }
  const userScope = value['userScope'];
  if (userScope !== undefined && typeof userScope !== 'boolean') {
    throw new Error('memory.userScope must be boolean');
  }
  if (mode === 'native') {
    if (projectScope === false && userScope === false) {
      throw new Error(
        'memory native mode requires at least one enabled scope; use memory: {} to disable SDK memory',
      );
    }
    if (value['generation'] !== undefined || value['consumption'] !== undefined) {
      throw new Error(
        'memory mode "native" does not accept generation or consumption overrides',
      );
    }
    return {
      requester: 'sdk',
      mode: 'native',
      ...(projectScope !== undefined ? { projectScope } : {}),
      ...(userScope !== undefined ? { userScope } : {}),
    };
  }

  let generation: SdkMemoryConfig['generation'];
  const rawGeneration = value['generation'];
  if (rawGeneration !== undefined) {
    if (!isRecord(rawGeneration)) throw new Error('memory.generation must be an object');
    const enabled = rawGeneration['enabled'];
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      throw new Error('memory.generation.enabled must be boolean');
    }
    const roots = parseRoots(rawGeneration['roots']);
    const rawPrompt = rawGeneration['prompt'];
    const prompt =
      rawPrompt === undefined
        ? undefined
        : nonEmptyString(rawPrompt, 'memory.generation.prompt');

    let turnComplete: NonNullable<SdkMemoryConfig['generation']>['turnComplete'];
    const rawTurnComplete = rawGeneration['turnComplete'];
    if (rawTurnComplete !== undefined) {
      if (!isRecord(rawTurnComplete)) {
        throw new Error('memory.generation.turnComplete.enabled must be boolean');
      }
      const turnCompleteEnabled = rawTurnComplete['enabled'];
      if (
        turnCompleteEnabled !== undefined &&
        typeof turnCompleteEnabled !== 'boolean'
      ) {
        throw new Error('memory.generation.turnComplete.enabled must be boolean');
      }
      const rawCallbackId = rawTurnComplete['shouldGenerateCallbackId'];
      const callbackId =
        rawCallbackId === undefined
          ? undefined
          : nonEmptyString(
              rawCallbackId,
              'memory.generation.turnComplete.shouldGenerateCallbackId',
            );
      const timeoutMs = rawTurnComplete['timeoutMs'];
      if (timeoutMs !== undefined &&
          (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
        throw new Error('memory.generation.turnComplete.timeoutMs must be positive');
      }
      const onGateError = rawTurnComplete['onGateError'];
      if (onGateError !== undefined && onGateError !== 'skip' && onGateError !== 'report_failed') {
        throw new Error('memory.generation.turnComplete.onGateError is invalid');
      }
      turnComplete = {
        enabled: turnCompleteEnabled ?? true,
        shouldGenerateCallbackId: callbackId,
        timeoutMs,
        onGateError,
      };
    }

    generation = {
      enabled: enabled ?? true,
      roots,
      prompt,
      turnComplete,
    };
  }

  let consumption: SdkMemoryConfig['consumption'];
  const rawConsumption = value['consumption'];
  if (rawConsumption !== undefined) {
    if (!isRecord(rawConsumption)) {
      throw new Error('memory.consumption must be an object');
    }
    const consumptionEnabled = rawConsumption['enabled'];
    if (
      consumptionEnabled !== undefined &&
      typeof consumptionEnabled !== 'boolean'
    ) {
      throw new Error('memory.consumption.enabled must be boolean');
    }
    const maxTokens = rawConsumption['maxTokens'];
    if (maxTokens !== undefined &&
        (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens <= 0)) {
      throw new Error('memory.consumption.maxTokens must be a positive integer');
    }
    const overflow = rawConsumption['overflow'];
    if (overflow !== undefined && overflow !== 'truncate' && overflow !== 'fail_query') {
      throw new Error('memory.consumption.overflow is invalid');
    }
    const failureMode = rawConsumption['failureMode'];
    if (failureMode !== undefined && failureMode !== 'best_effort' && failureMode !== 'fail_query') {
      throw new Error('memory.consumption.failureMode is invalid');
    }
    consumption = {
      enabled: consumptionEnabled ?? true,
      files: parseConsumptionFiles(rawConsumption['files']),
      maxTokens,
      overflow,
      failureMode,
    };
  }

  return {
    requester: 'sdk',
    mode,
    ...(projectScope !== undefined ? { projectScope } : {}),
    ...(userScope !== undefined ? { userScope } : {}),
    generation,
    consumption,
  };
}

export function buildSdkMemoryPermissionUpdates(
  roots: readonly SdkMemoryRoot[],
): PermissionUpdate[] {
  const rules = roots.flatMap((root) => {
    const ruleContent = directoryPermissionPattern(root.path);
    return root.access === 'read-write'
      ? [
          { toolName: 'Read', ruleContent },
          { toolName: 'Edit', ruleContent },
        ]
      : [{ toolName: 'Read', ruleContent }];
  });
  return rules.length === 0
    ? []
    : [{ type: 'addRules', destination: 'session', behavior: 'allow', rules }];
}

export async function prepareSdkMemoryRoots(
  roots: readonly SdkMemoryRoot[],
): Promise<SdkMemoryRoot[]> {
  await Promise.all(
    roots
      .filter((root) => root.access === 'read-write')
      .map((root) => fs.mkdir(root.path, { recursive: true })),
  );
  return Promise.all(
    roots.map(async (root) => ({
      ...root,
      path: await fs.realpath(root.path),
    })),
  );
}

function truncateToTokens(content: string, maxTokens: number): string {
  const characters = Array.from(content);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTextTokens(characters.slice(0, mid).join('')) <= maxTokens) low = mid;
    else high = mid - 1;
  }
  return characters.slice(0, low).join('');
}

export async function loadSdkMemoryConsumption(
  config: NonNullable<SdkMemoryConfig['consumption']>,
): Promise<LoadedSdkMemoryConsumption> {
  const details: SdkMemoryConsumptionResult['files'] = [];
  const rendered: string[] = [];
  const fileStates: SdkMemoryConsumptionFileState[] = [];
  let remaining = config.maxTokens ?? Number.POSITIVE_INFINITY;
  let fatalError: string | undefined;

  for (const file of config.files ?? []) {
    try {
      const [content, stats] = await Promise.all([
        fs.readFile(file.path, 'utf8'),
        fs.stat(file.path),
      ]);
      const estimatedTokens = Math.ceil(estimateTextTokens(content));
      if (estimatedTokens > remaining) {
        if ((config.overflow ?? 'truncate') === 'fail_query') {
          const error = `memory consumption exceeds maxTokens at ${file.path}`;
          details.push({
            id: file.id,
            path: file.path,
            status: 'failed',
            error,
          });
          fatalError = error;
          continue;
        }
        const truncated = truncateToTokens(content, Math.max(0, remaining));
        fileStates.push({
          filePath: file.path,
          content,
          timestamp: Math.floor(stats.mtimeMs),
          isPartialView: true,
        });
        details.push({
          id: file.id,
          path: file.path,
          status: 'truncated',
        });
        rendered.push(`## ${file.id}\nPath: ${file.path}\n\n${truncated}`);
        remaining = 0;
        continue;
      }
      fileStates.push({
        filePath: file.path,
        content,
        timestamp: Math.floor(stats.mtimeMs),
      });
      details.push({ id: file.id, path: file.path, status: 'loaded' });
      rendered.push(`## ${file.id}\nPath: ${file.path}\n\n${content}`);
      remaining -= estimatedTokens;
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      const message = error instanceof Error ? error.message : String(error);
      details.push({
        id: file.id,
        path: file.path,
        status: missing ? 'missing' : 'failed',
        error: message,
      });
      if (missing) {
        fileStates.push({
          filePath: file.path,
          content: '',
          timestamp: 0,
          retainIfMissing: true,
        });
      }
      if (file.required && (config.failureMode ?? 'best_effort') === 'fail_query') {
        fatalError ??= `required memory file could not be loaded: ${file.path}`;
      }
    }
  }

  const loadedCount = details.filter(
    (file) => file.status === 'loaded' || file.status === 'truncated',
  ).length;
  const failedCount = details.length - loadedCount;
  const status = fatalError || loadedCount === 0 && failedCount > 0
    ? 'failed'
    : failedCount > 0 || details.some((file) => file.status === 'truncated')
      ? 'partial'
      : 'success';

  return {
    context: rendered.length > 0
      ? { sdkMemory: `# Persistent memory\n\n${rendered.join('\n\n')}` }
      : undefined,
    result: { status, files: details },
    fileStates,
    fatalError,
  };
}

export function buildNativeSdkMemoryConsumptionResult(
  states: readonly NativeMemoryIndexFileState[],
): SdkMemoryConsumptionResult {
  const files: SdkMemoryConsumptionResult['files'] = states.map((state) => {
    if (state.loadError) {
      return {
        id: state.scope,
        path: state.indexPath,
        status: 'failed' as const,
        error: state.loadError,
      };
    }
    if (state.retainIfMissing) {
      return {
        id: state.scope,
        path: state.indexPath,
        status: 'missing' as const,
      };
    }
    return {
      id: state.scope,
      path: state.indexPath,
      status: state.isPartialView ? ('truncated' as const) : ('loaded' as const),
    };
  });
  const availableCount = files.filter(
    (file) => file.status === 'loaded' || file.status === 'truncated',
  ).length;
  const hasIncompleteFile = files.some(
    (file) => file.status === 'missing' || file.status === 'truncated',
  );
  const status =
    files.length > 0 && availableCount === 0
      ? 'failed'
      : hasIncompleteFile
        ? 'partial'
        : 'success';
  return { status, files };
}

export function buildSdkMemoryPrompt(
  prompt: string,
  roots: readonly SdkMemoryRoot[],
): string {
  return [
    '# auto memory',
    '',
    '## SDK-provided generation instructions',
    '',
    prompt,
    '',
    '## SDK-controlled memory roots',
    '',
    ...roots.map((root) =>
      `- ${root.id}: ${root.path} (${root.access}${
        root.indexFile ? `; index: ${root.indexFile}` : ''
      })`,
    ),
    '',
    'Use only these roots for persistent memory. A root never grants access to its parent.',
  ].join('\n');
}

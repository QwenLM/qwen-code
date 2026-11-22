/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { atomicWriteFile } from '@qwen-code/qwen-code-core/atomicFileWrite';
import {
  appendShellHistoryFile,
  readShellHistoryFile,
} from '../utils/shell-history-file.js';

export type WorkspaceInputHistoryKind = 'prompt' | 'shell';

export const MAX_WORKSPACE_INPUT_HISTORY_ENTRIES = 100;
export const MAX_WORKSPACE_INPUT_HISTORY_ENTRY_CHARS = 32_768;

const PROMPT_HISTORY_FILENAME = 'input_history.json';

export interface WorkspaceInputHistorySnapshot {
  kind: WorkspaceInputHistoryKind;
  entries: string[];
  revision: string;
}

const writeQueueByPath = new Map<string, Promise<unknown>>();

export function isWorkspaceInputHistoryKind(
  value: unknown,
): value is WorkspaceInputHistoryKind {
  return value === 'prompt' || value === 'shell';
}

export function getWorkspaceInputHistoryFilePath(
  workspaceCwd: string,
  kind: WorkspaceInputHistoryKind,
): string {
  const storage = new Storage(workspaceCwd);
  if (kind === 'shell') {
    return storage.getHistoryFilePath();
  }
  return path.join(storage.getProjectTempDir(), PROMPT_HISTORY_FILENAME);
}

function computeRevision(entries: readonly string[]): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(entries))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Normalizes entries into oldest-to-newest order, deduplicating while keeping
 * each entry at its newest position, and bounding to `maxEntries`.
 */
function normalizeOldestFirst(
  rawEntries: readonly unknown[],
  maxEntries: number,
): string[] {
  const seen = new Set<string>();
  const newestFirst: string[] = [];
  for (let i = rawEntries.length - 1; i >= 0; i--) {
    const raw = rawEntries[i];
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (
      trimmed.length === 0 ||
      trimmed.length > MAX_WORKSPACE_INPUT_HISTORY_ENTRY_CHARS ||
      seen.has(trimmed)
    ) {
      continue;
    }
    seen.add(trimmed);
    newestFirst.push(trimmed);
    if (newestFirst.length >= maxEntries) break;
  }
  newestFirst.reverse();
  return newestFirst;
}

async function readRawEntriesOldestFirst(
  filePath: string,
  kind: WorkspaceInputHistoryKind,
): Promise<{ entries: string[]; fileExists: boolean }> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return { entries: [], fileExists: false };
    }
    throw error;
  }

  if (kind === 'shell') {
    return { entries: readShellHistoryFile(filePath), fileExists: true };
  }

  const parsed = JSON.parse(content) as unknown;
  if (
    !Array.isArray(parsed) ||
    !parsed.every((entry) => typeof entry === 'string')
  ) {
    throw new Error(`Invalid workspace input history file: ${filePath}`);
  }
  return {
    entries: normalizeOldestFirst(parsed, MAX_WORKSPACE_INPUT_HISTORY_ENTRIES),
    fileExists: true,
  };
}

async function writeAtomicJson(
  filePath: string,
  payload: readonly string[],
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await atomicWriteFile(filePath, JSON.stringify(payload, null, 2), {
    mode: 0o600,
    forceMode: true,
  });
}

function serializeByPath<T>(
  filePath: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = writeQueueByPath.get(filePath) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  writeQueueByPath.set(filePath, next);
  void next.then(
    () => {
      if (writeQueueByPath.get(filePath) === next) {
        writeQueueByPath.delete(filePath);
      }
    },
    () => {
      if (writeQueueByPath.get(filePath) === next) {
        writeQueueByPath.delete(filePath);
      }
    },
  );
  return next;
}

export async function readWorkspaceInputHistory(
  workspaceCwd: string,
  kind: WorkspaceInputHistoryKind,
  limit = MAX_WORKSPACE_INPUT_HISTORY_ENTRIES,
): Promise<WorkspaceInputHistorySnapshot> {
  const effectiveLimit = Math.max(
    1,
    Math.min(MAX_WORKSPACE_INPUT_HISTORY_ENTRIES, Math.floor(limit)),
  );
  const filePath = getWorkspaceInputHistoryFilePath(workspaceCwd, kind);
  const { entries } = await readRawEntriesOldestFirst(filePath, kind);
  const bounded =
    entries.length > effectiveLimit
      ? entries.slice(entries.length - effectiveLimit)
      : entries;
  return {
    kind,
    entries: bounded,
    revision: computeRevision(bounded),
  };
}

export async function appendWorkspaceInputHistory(
  workspaceCwd: string,
  kind: WorkspaceInputHistoryKind,
  rawEntry: string,
): Promise<WorkspaceInputHistorySnapshot | null> {
  const trimmed = rawEntry.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_WORKSPACE_INPUT_HISTORY_ENTRY_CHARS
  ) {
    return null;
  }

  const filePath = getWorkspaceInputHistoryFilePath(workspaceCwd, kind);
  return serializeByPath(filePath, async () => {
    if (kind === 'shell') {
      const entries = appendShellHistoryFile(filePath, trimmed);
      return { kind, entries, revision: computeRevision(entries) };
    }
    const { entries, fileExists } = await readRawEntriesOldestFirst(
      filePath,
      kind,
    );
    if (fileExists && entries[entries.length - 1] === trimmed) {
      return {
        kind,
        entries,
        revision: computeRevision(entries),
      };
    }
    const nextEntries = entries.filter((item) => item !== trimmed);
    nextEntries.push(trimmed);
    const bounded =
      nextEntries.length > MAX_WORKSPACE_INPUT_HISTORY_ENTRIES
        ? nextEntries.slice(
            nextEntries.length - MAX_WORKSPACE_INPUT_HISTORY_ENTRIES,
          )
        : nextEntries;
    await writeAtomicJson(filePath, bounded);
    return {
      kind,
      entries: bounded,
      revision: computeRevision(bounded),
    };
  });
}

export function extractPromptHistoryText(
  prompt: readonly unknown[],
  submittedPrompt?: string,
): string | undefined {
  if (typeof submittedPrompt === 'string') {
    const trimmedSubmitted = submittedPrompt.trim();
    if (trimmedSubmitted.length > 0) {
      return trimmedSubmitted;
    }
  }
  const textParts: string[] = [];
  for (const block of prompt) {
    if (
      block &&
      typeof block === 'object' &&
      !Array.isArray(block) &&
      (block as Record<string, unknown>)['type'] === 'text' &&
      typeof (block as Record<string, unknown>)['text'] === 'string'
    ) {
      const part = (
        (block as Record<string, unknown>)['text'] as string
      ).trim();
      if (part.length > 0) {
        textParts.push(part);
      }
    }
  }
  const joined = textParts.join('\n').trim();
  return joined.length > 0 ? joined : undefined;
}

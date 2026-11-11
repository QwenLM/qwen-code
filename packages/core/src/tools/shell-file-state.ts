/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import type { Config } from '../config/config.js';
import type { ToolUseContext } from './tool-types.js';
import type { FileState, FileStateCache } from '../utils/fileStateCache.js';
import { mapWithConcurrency } from '../utils/generators.js';
import { canReadFileWithoutPrompt } from './file-read-permission.js';
import { checkReadOnlyShellCommand } from './shell-permissions/shellReadOnlyValidation.js';

const WRITE_MARKERS =
  /(?:--write|--fix|--in-place|--auto-correct|>|\bsed\s+-i|\b(?:touch|gofmt|rustfmt|black|isort|swiftformat|phpcbf)\b|\b(?:format|fmt|fix)\b)/;
const FILE_STAT_CONCURRENCY = 16;

interface WatchedFile {
  path: string;
  state: FileState;
  mtimeMs: number;
}

/** Watch only already-known files; never turn a write into an implicit read. */
export async function snapshotShellFileState(
  command: string,
  cache: FileStateCache,
  options: { cwd?: string; signal?: AbortSignal } = {},
): Promise<WatchedFile[]> {
  if (
    options.signal?.aborted ||
    !WRITE_MARKERS.test(command) ||
    checkReadOnlyShellCommand(
      command,
      undefined,
      options.cwd === undefined ? undefined : { cwd: options.cwd },
    ).readonly
  )
    return [];
  return snapshotKnownShellFileState(cache, options.signal);
}

/** The caller supplies its own shell analysis; observation never evaluates a command. */
export async function snapshotKnownShellFileState(
  cache: FileStateCache,
  signal?: AbortSignal,
): Promise<WatchedFile[]> {
  if (signal?.aborted) return [];
  const watched = await mapWithConcurrency(
    [...cache.entries()],
    FILE_STAT_CONCURRENCY,
    async ([filePath, state]) => {
      if (signal?.aborted) return undefined;
      try {
        const stats = await fs.promises.stat(filePath);
        return { path: filePath, state, mtimeMs: stats.mtimeMs };
      } catch {
        // Missing or inaccessible paths cannot be compared after execution.
        return undefined;
      }
    },
  );
  return watched.filter((entry): entry is WatchedFile => entry !== undefined);
}

export async function shellChangedFilesHint(
  watched: WatchedFile[],
  cache: FileStateCache,
  config: Config,
  context?: ToolUseContext,
): Promise<string | undefined> {
  const stale = await mapWithConcurrency(
    watched,
    FILE_STAT_CONCURRENCY,
    async ({ path, state, mtimeMs }) => {
      if (context?.signal.aborted) return undefined;
      // A sibling Read/Edit may have already refreshed this entry.
      if (cache.get(path) !== state) return undefined;
      try {
        const after = await fs.promises.stat(path);
        return cache.get(path) === state &&
          after.mtimeMs !== mtimeMs &&
          Math.floor(after.mtimeMs) > state.timestamp
          ? { path, state }
          : undefined;
      } catch {
        // Detection is advisory; a deleted file will fail its next operation.
        return undefined;
      }
    },
  );
  const changed: string[] = [];
  for (const entry of stale) {
    if (context?.signal.aborted) return undefined;
    if (
      entry &&
      (await canReadFileWithoutPrompt(config, entry.path, context)) &&
      cache.get(entry.path) === entry.state
    )
      changed.push(entry.path);
  }
  if (changed.length === 0) return undefined;
  const paths = changed
    .slice(0, 5)
    .map((p) => JSON.stringify(p))
    .join(', ');
  const remainder = changed.length > 5 ? ` and ${changed.length - 5} more` : '';
  return `[${changed.length} previously read file(s) changed during this command: ${paths}${remainder}. Read the relevant content before editing.]`;
}

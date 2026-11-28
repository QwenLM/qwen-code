/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { atomicWriteFileSync } from '@qwen-code/qwen-code-core/atomicFileWrite';
import { MAX_INPUT_HISTORY_ENTRIES } from '@qwen-code/qwen-code-core/utils/input-history.js';

export const SHELL_HISTORY_MAX_ENTRIES = MAX_INPUT_HISTORY_ENTRIES;

const STALE_LOCK_MS = 10_000;
// Outlast the stale window so an orphaned lock can be reclaimed before the
// append gives up, rather than losing the new command to the retry budget.
const LOCK_RETRIES = Object.freeze({
  retries: 120,
  factor: 1.25,
  minTimeout: 10,
  maxTimeout: 100,
});

function parseJsonHistory(text: string): string[] | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every((entry): entry is string => typeof entry === 'string')
    ) {
      return parsed;
    }
  } catch {
    // Fall through to the legacy line-based format.
  }
  return undefined;
}

/**
 * Reads shell history oldest-to-newest, matching the TUI's JSON and legacy
 * line-based formats. Malformed JSON is treated as a legacy history document,
 * never as permission to drop it.
 */
export function parseShellHistoryText(text: string): string[] {
  const json = parseJsonHistory(text);
  if (json) return [...json];

  const result: string[] = [];
  let current = '';
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const match = current.match(/(\\+)$/);
    if (match && match[1].length % 2) {
      current = current.slice(0, -1) + ' ' + raw;
    } else {
      if (current) result.push(current);
      current = raw;
    }
  }
  if (current) result.push(current);
  return result;
}

export async function readShellHistoryFile(
  filePath: string,
): Promise<string[]> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
  return parseShellHistoryText(text);
}

/**
 * Serializes TUI and daemon shell-history updates across processes. Both
 * producers reread inside the stale-reclaiming lock and write oldest-to-newest.
 * Contention yields to the event loop rather than spin-waiting on its thread.
 */
export async function appendShellHistoryFile(
  filePath: string,
  command: string,
): Promise<string[]> {
  let compromised: Error | undefined;
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(filePath, {
    realpath: false,
    stale: STALE_LOCK_MS,
    retries: LOCK_RETRIES,
    onCompromised: (error: Error) => {
      compromised = error;
    },
  });
  let bounded: string[];
  try {
    const next = (await readShellHistoryFile(filePath)).filter(
      (entry) => entry !== command && entry.length > 0,
    );
    // Keep the compromise check and final atomic replacement in the same
    // event-loop turn so the lock cannot be lost during an awaited commit.
    if (compromised) throw compromised;
    next.push(command);
    bounded = next.slice(-SHELL_HISTORY_MAX_ENTRIES);
    atomicWriteFileSync(filePath, JSON.stringify(bounded, null, 2), {
      mode: 0o600,
      forceMode: true,
    });
  } finally {
    await release().catch((error: unknown) => {
      if (
        compromised &&
        (error as NodeJS.ErrnoException)?.code === 'ERELEASED'
      ) {
        return;
      }
      throw error;
    });
  }
  if (compromised) throw compromised;
  return bounded;
}

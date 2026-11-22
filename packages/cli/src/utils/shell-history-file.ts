/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { atomicWriteFileSync } from '@qwen-code/qwen-code-core/atomicFileWrite';

export const SHELL_HISTORY_MAX_ENTRIES = 100;

const LOCK_RETRY_DELAYS_MS = Array.from({ length: 250 }, () => 20);
const STALE_LOCK_MS = 10_000;
const sleepState = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(sleepState, 0, 0, ms);
}

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

export function readShellHistoryFile(filePath: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
  return parseShellHistoryText(text);
}

/**
 * Serializes TUI and daemon shell-history updates across processes. Both
 * producers reread inside this bounded lock and write oldest-to-newest.
 */
export function appendShellHistoryFile(
  filePath: string,
  command: string,
): string[] {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  let release: (() => void) | undefined;
  for (let attempt = 0; ; attempt += 1) {
    try {
      release = lockfile.lockSync(filePath, {
        realpath: false,
        stale: STALE_LOCK_MS,
      });
      break;
    } catch (error) {
      const lockError = error as NodeJS.ErrnoException;
      if (lockError.code !== 'ELOCKED') throw error;
      if (attempt >= LOCK_RETRY_DELAYS_MS.length) throw error;
      sleepSync(LOCK_RETRY_DELAYS_MS[attempt]!);
    }
  }

  try {
    const next = readShellHistoryFile(filePath).filter(
      (entry) => entry !== command && entry.length > 0,
    );
    next.push(command);
    const bounded = next.slice(-SHELL_HISTORY_MAX_ENTRIES);
    atomicWriteFileSync(filePath, JSON.stringify(bounded, null, 2), {
      mode: 0o600,
      forceMode: true,
    });
    return bounded;
  } finally {
    release();
  }
}

/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Efficient JSONL (JSON Lines) file utilities.
 *
 * Reading operations:
 * - readLines() - Reads the first N lines efficiently using buffered I/O
 * - read() - Reads entire file into memory as array
 *
 * Writing operations:
 * - writeLine() - Async append with mutex-based concurrency control
 * - writeLineSync() - Sync append (use in non-async contexts)
 * - write() - Overwrites entire file with array of objects
 *
 * Utility operations:
 * - countLines() - Counts non-empty lines
 * - exists() - Checks if file exists and is non-empty
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Mutex } from 'async-mutex';
import { createDebugLogger } from './debugLogger.js';

const debugLogger = createDebugLogger('JSONL');

/**
 * A map of file paths to mutexes for preventing concurrent writes.
 */
const fileLocks = new Map<string, Mutex>();

/**
 * Gets or creates a mutex for a specific file path.
 */
function getFileLock(filePath: string): Mutex {
  if (!fileLocks.has(filePath)) {
    fileLocks.set(filePath, new Mutex());
  }
  return fileLocks.get(filePath)!;
}

/**
 * Recovers parsed objects from a single physical line that may contain one
 * or more concatenated top-level JSON objects (i.e. a missing newline
 * separator left two records glued together as `}{`). Walks the line with a
 * brace-depth counter that respects string boundaries and `\` escapes, then
 * tries `JSON.parse` on each balanced top-level fragment. Fragments that
 * still fail to parse are skipped silently — the caller decides whether to
 * warn.
 *
 * **Limitation**: only top-level `{...}` records are recovered. A glued line
 * whose records are top-level arrays (`[...][...]`) will not split. All
 * existing JSONL writers in this codebase produce object records, so this
 * matches the actual corruption shape — extend if that ever changes.
 *
 * Exported for unit tests; not part of the module's stable surface.
 */
export function _recoverObjectsFromLine<T = unknown>(line: string): T[] {
  const out: T[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let start = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        const fragment = line.slice(start, i + 1);
        try {
          out.push(JSON.parse(fragment) as T);
        } catch {
          // Skip un-parseable fragment; caller may still recover others.
        }
        start = -1;
      } else if (depth < 0) {
        // Unbalanced close brace — reset and keep scanning for the next
        // well-formed object rather than giving up on the whole line.
        depth = 0;
        start = -1;
      }
    }
  }
  return out;
}

/**
 * Parses a single physical JSONL line tolerantly. Returns the parsed records:
 * one if the line is well-formed, multiple if it is `}{`-glued from an
 * interrupted append (the #3606 corruption shape), zero if nothing can be
 * recovered. Use this from any streaming reader that walks JSONL line-by-line
 * and wants the same recovery semantics as `read()` / `readLines()`.
 *
 * Non-object JSON values (e.g. a bare `null`, `42`, or `[1,2,3]` line) are
 * filtered out: JSONL records in this codebase are always objects, and
 * forwarding scalars or arrays would trip property accesses in callers
 * (`record.type`, `record.uuid`).
 */
export function parseLineTolerant<T>(line: string, filePath: string): T[] {
  try {
    const parsed = JSON.parse(line);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
    ) {
      return [parsed as T];
    }
    debugLogger.warn(`Skipping non-object JSONL value in ${filePath}`);
    return [];
  } catch {
    const fragments = _recoverObjectsFromLine<T>(line);
    if (fragments.length === 0) {
      debugLogger.warn(`Failed to parse line in ${filePath}`);
    } else {
      debugLogger.warn(
        `Recovered ${fragments.length} record(s) from malformed line in ${filePath}`,
      );
    }
    return fragments;
  }
}

/**
 * Reads the first N lines from a JSONL file efficiently.
 * Returns an array of parsed objects.
 */
export async function readLines<T = unknown>(
  filePath: string,
  count: number,
): Promise<T[]> {
  try {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    const results: T[] = [];
    for await (const line of rl) {
      if (results.length >= count) break;
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      for (const obj of parseLineTolerant<T>(trimmed, filePath)) {
        if (results.length >= count) break;
        results.push(obj);
      }
    }

    return results;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      debugLogger.error(
        `Error reading first ${count} lines from ${filePath}:`,
        error,
      );
    }
    return [];
  }
}

/**
 * Reads all lines from a JSONL file.
 * Returns an array of parsed objects.
 */
export async function read<T = unknown>(filePath: string): Promise<T[]> {
  try {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    const results: T[] = [];
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      for (const obj of parseLineTolerant<T>(trimmed, filePath)) {
        results.push(obj);
      }
    }

    return results;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      debugLogger.error(`Error reading ${filePath}:`, error);
    }
    return [];
  }
}

/**
 * Per-directory cache: once we've successfully created a parent dir we don't
 * need to mkdir again on subsequent writes. Cuts an async syscall off every
 * hot-path write (chat session JSONL appends).
 */
const ensuredDirs = new Set<string>();

/**
 * Test-only: clear the per-directory mkdir cache. Needed when tests mutate
 * fs state at the same directory path across cases.
 */
export function _resetEnsuredDirsCacheForTest(): void {
  ensuredDirs.clear();
}

/**
 * Appends a line to a JSONL file with concurrency control.
 * Uses a per-file mutex so concurrent callers serialize, and `fs.promises`
 * so the actual I/O does not block the event loop.
 */
export async function writeLine(
  filePath: string,
  data: unknown,
): Promise<void> {
  const lock = getFileLock(filePath);
  await lock.runExclusive(async () => {
    const line = `${JSON.stringify(data)}\n`;
    const dir = path.dirname(filePath);
    if (!ensuredDirs.has(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
      ensuredDirs.add(dir);
    }
    await fs.promises.appendFile(filePath, line, 'utf8');
  });
}

/**
 * Synchronous version of writeLine for use in non-async contexts.
 * Uses a simple flag-based locking mechanism (less robust than async version).
 */
export function writeLineSync(filePath: string, data: unknown): void {
  const line = `${JSON.stringify(data)}\n`;
  // Ensure directory exists before writing
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.appendFileSync(filePath, line, 'utf8');
}

/**
 * Overwrites a JSONL file with an array of objects.
 * Each object will be written as a separate line.
 */
export function write(filePath: string, data: unknown[]): void {
  const lines = data.map((item) => JSON.stringify(item)).join('\n');
  // Ensure directory exists before writing
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, `${lines}\n`, 'utf8');
}

/**
 * Counts the number of non-empty lines in a JSONL file.
 */
export async function countLines(filePath: string): Promise<number> {
  try {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let count = 0;
    for await (const line of rl) {
      if (line.trim().length > 0) {
        count++;
      }
    }
    return count;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      debugLogger.error(`Error counting lines in ${filePath}:`, error);
    }
    return 0;
  }
}

/**
 * Checks if a JSONL file exists and is not empty.
 */
export function exists(filePath: string): boolean {
  try {
    const stats = fs.statSync(filePath);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

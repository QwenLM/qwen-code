/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Efficient JSONL (JSON Lines) file utilities.
 *
 * Reading operations:
 * - readLines() - Reads the first N records efficiently using buffered I/O
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
import { atomicWriteFileSync } from './atomicFileWrite.js';
import readline from 'node:readline';
import { finished } from 'node:stream/promises';
import { Mutex } from 'async-mutex';
import { createDebugLogger } from './debugLogger.js';

const debugLogger = createDebugLogger('JSONL');

type JsonlReadOptions = {
  throwOnNonEnoentError?: boolean;
};

type JsonlReadLinesOptions = {
  signal?: AbortSignal;
};

interface ParsedJsonlLine<T> {
  records: T[];
  complete: boolean;
}

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
function recoverObjectsFromLine<T = unknown>(line: string): ParsedJsonlLine<T> {
  const out: T[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let start = -1;
  let complete = true;
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
      if (depth === 0) complete = false;
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
          complete = false;
          // Skip un-parseable fragment; caller may still recover others.
        }
        start = -1;
      } else if (depth < 0) {
        complete = false;
        // Unbalanced close brace — reset and keep scanning for the next
        // well-formed object rather than giving up on the whole line.
        depth = 0;
        start = -1;
      }
    } else if (depth === 0 && !/\s/.test(c)) {
      complete = false;
    }
  }
  return {
    records: out,
    complete:
      complete && out.length > 0 && depth === 0 && !inString && start === -1,
  };
}

export function _recoverObjectsFromLine<T = unknown>(line: string): T[] {
  return recoverObjectsFromLine<T>(line).records;
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
function parseLineTolerantWithIntegrity<T>(
  line: string,
  filePath: string,
): ParsedJsonlLine<T> {
  try {
    const parsed = JSON.parse(line);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
    ) {
      return { records: [parsed as T], complete: true };
    }
    debugLogger.warn(`Skipping non-object JSONL value in ${filePath}`);
    return { records: [], complete: false };
  } catch {
    const recovered = recoverObjectsFromLine<T>(line);
    if (recovered.records.length === 0) {
      debugLogger.warn(`Failed to parse line in ${filePath}`);
    } else {
      debugLogger.warn(
        `Recovered ${recovered.records.length} record(s) from malformed line in ${filePath}`,
      );
    }
    return recovered;
  }
}

export function parseLineTolerant<T>(line: string, filePath: string): T[] {
  return parseLineTolerantWithIntegrity<T>(line, filePath).records;
}

async function closeLineReader(
  rl: readline.Interface | undefined,
  fileStream: fs.ReadStream | undefined,
): Promise<void> {
  rl?.close();
  if (!fileStream || fileStream.closed) {
    return;
  }

  const closed = finished(fileStream, { cleanup: true }).catch(() => undefined);
  if (!fileStream.destroyed) {
    fileStream.destroy();
  }
  await closed;
}

async function readLinesWithIntegrityInternal<T = unknown>(
  filePath: string,
  count: number,
  options: JsonlReadLinesOptions = {},
  budget: 'records' | 'lines' = 'records',
): Promise<{ records: T[]; complete: boolean }> {
  let fileStream: fs.ReadStream | undefined;
  let rl: readline.Interface | undefined;
  try {
    options.signal?.throwIfAborted();
    fileStream = options.signal
      ? fs.createReadStream(filePath, { signal: options.signal })
      : fs.createReadStream(filePath);
    rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    const results: T[] = [];
    let complete = true;
    let scannedLines = 0;
    for await (const line of rl) {
      if (
        (budget === 'records' && results.length >= count) ||
        (budget === 'lines' && scannedLines >= count)
      ) {
        break;
      }
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      scannedLines++;
      const parsed = parseLineTolerantWithIntegrity<T>(trimmed, filePath);
      complete &&= parsed.complete;
      for (const obj of parsed.records) {
        if (budget === 'records' && results.length >= count) break;
        results.push(obj);
      }
    }

    options.signal?.throwIfAborted();
    return { records: results, complete };
  } catch (error) {
    options.signal?.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      debugLogger.error(
        `Error reading up to ${count} ${budget} from ${filePath}:`,
        error,
      );
    }
    return { records: [], complete: false };
  } finally {
    await closeLineReader(rl, fileStream);
    options.signal?.throwIfAborted();
  }
}

export async function readLines<T = unknown>(
  filePath: string,
  count: number,
  options: JsonlReadLinesOptions = {},
): Promise<T[]> {
  // The slice preserves this reader's record-budget contract: at most `count`
  // records even when a glued line recovers several.
  return (
    await readLinesWithIntegrityInternal<T>(filePath, count, options)
  ).records.slice(0, count);
}

/**
 * Reads every record from the first `count` non-empty lines. `complete`
 * reports whether each of those lines was fully recoverable, so fail-closed
 * callers get a deterministic line-prefix coverage rather than one that
 * shrinks when early lines are `}{`-glued.
 */
export async function readLinesWithIntegrity<T = unknown>(
  filePath: string,
  count: number,
  options: JsonlReadLinesOptions = {},
): Promise<{ records: T[]; complete: boolean }> {
  return readLinesWithIntegrityInternal<T>(filePath, count, options, 'lines');
}

/**
 * Reads all lines from a JSONL file.
 * Returns an array of parsed objects.
 */
export async function read<T = unknown>(
  filePath: string,
  options: JsonlReadOptions = {},
): Promise<T[]> {
  let fileStream: fs.ReadStream | undefined;
  let rl: readline.Interface | undefined;
  try {
    fileStream = fs.createReadStream(filePath);
    rl = readline.createInterface({
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
      if (options.throwOnNonEnoentError) {
        throw error;
      }
    }
    return [];
  } finally {
    await closeLineReader(rl, fileStream);
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
    // flush:true fsyncs after each line so a process killed mid-write
    // doesn't leave a glued `}{` record on disk (closes #3681). On
    // Node v22/v24 strace shows string + utf8 + flush:true does fsync
    // correctly; passing a Buffer is forward-compat insurance against
    // any future C++ fast path that might bypass JS-side flush logic
    // for the string case, with no behavior delta on tested versions.
    await fs.promises.appendFile(filePath, Buffer.from(line, 'utf8'), {
      flush: true,
    });
  });
}

/**
 * Synchronous version of writeLine for use in non-async contexts.
 *
 * NOTE: this function is unsynchronized — there is no locking. The
 * `writeLine` async variant uses a per-file `Mutex` to serialize
 * concurrent writers, but that lock is bypassed by `writeLineSync`
 * and `write()`. Callers that share a JSONL file with concurrent
 * `writeLine()` callers must serialize externally.
 *
 * `flush: true` fsyncs after each appended record so a `kill -9`
 * mid-tool-call cannot leave a glued `}{` record on disk (closes
 * #3681). The line is converted to a `Buffer` for forward-compat
 * insurance — strace on Node v22/v24 confirms string + utf8 +
 * flush:true does fsync correctly today, but Buffer is the
 * unambiguous slow-path form and protects against any future C++
 * fast-path optimization that might bypass the flush hook for
 * strings.
 */
export function writeLineSync(filePath: string, data: unknown): void {
  const line = `${JSON.stringify(data)}\n`;
  // Ensure directory exists before writing
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.appendFileSync(filePath, Buffer.from(line, 'utf8'), { flush: true });
}

/**
 * Overwrites a JSONL file with an array of objects.
 * Each object will be written as a separate line.
 */
export function write(filePath: string, data: unknown[]): void {
  // Terminate each record rather than joining with separators: joining an
  // empty array yields '' and the trailing newline then writes a 1-byte file
  // that read() reports as empty but exists() reports as non-empty.
  const lines = data.map((item) => `${JSON.stringify(item)}\n`).join('');
  // Ensure directory exists before writing
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  atomicWriteFileSync(filePath, lines, { encoding: 'utf8' });
}

/**
 * Counts the number of non-empty lines in a JSONL file.
 */
export async function countLines(filePath: string): Promise<number> {
  let fileStream: fs.ReadStream | undefined;
  let rl: readline.Interface | undefined;
  try {
    fileStream = fs.createReadStream(filePath);
    rl = readline.createInterface({
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
  } finally {
    await closeLineReader(rl, fileStream);
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

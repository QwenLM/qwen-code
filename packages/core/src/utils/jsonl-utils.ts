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

import * as nodeConstants from 'node:constants';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from './atomicFileWrite.js';
import readline from 'node:readline';
import { addAbortSignal } from 'node:stream';
import { finished } from 'node:stream/promises';
import { Mutex } from 'async-mutex';
import {
  createDebugLogger,
  getActiveDebugSessionLogPath,
  isDebugLogFileEnabled,
} from './debugLogger.js';

const debugLogger = createDebugLogger('JSONL');

type JsonlReadOptions = {
  throwOnNonEnoentError?: boolean;
  onIncompleteRead?: () => void;
};

type JsonlReadLinesOptions = {
  signal?: AbortSignal;
  stream?: fs.ReadStream;
};

interface ParsedJsonlLine<T> {
  records: T[];
  complete: boolean;
}

/**
 * A map of file paths to mutexes for preventing concurrent writes.
 */
const fileLocks = new Map<string, Mutex>();

export function _getFileLockCountForTest(): number {
  return fileLocks.size;
}

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
export function parseLineTolerantWithIntegrity<T>(
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
  let fileStream = options.stream;
  let rl: readline.Interface | undefined;
  try {
    options.signal?.throwIfAborted();
    if (fileStream && options.signal)
      addAbortSignal(options.signal, fileStream);
    fileStream ??= options.signal
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
      if (
        (budget === 'records' && results.length >= count) ||
        (budget === 'lines' && scannedLines >= count)
      ) {
        break;
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
      const parsed = parseLineTolerantWithIntegrity<T>(trimmed, filePath);
      if (!parsed.complete) options.onIncompleteRead?.();
      for (const obj of parsed.records) results.push(obj);
    }

    return results;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      options.onIncompleteRead?.();
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
interface TailDiagnosticEntry {
  attempts: number;
  pending: boolean;
  retained: boolean;
  retryAfter: number;
}
const diagnosedTailReadFailures = new Map<string, TailDiagnosticEntry>();
const MAX_DIAGNOSED_TAIL_READ_FAILURES = 128;
const MAX_TAIL_DIAGNOSTIC_DELIVERY_ATTEMPTS = 3;
// Same magnitude as the token-usage write-failure cooldown, so best-effort
// local write diagnostics share one retry window.
const TAIL_DIAGNOSTIC_RETRY_COOLDOWN_MS = 60_000;
// Tail inspection deliberately keeps its own short-lived handle per append:
// it checks the record boundary left by an interrupted append, and staying
// separate from the append/fsync path keeps this bugfix focused. Merging the
// two onto one handle is an independent performance change.
const tailProbeFlags = nodeConstants.O_RDONLY | (nodeConstants.O_NONBLOCK ?? 0);

function reportUninspectableTail(
  diagnosticKey: string,
  filePath: string,
  error: unknown,
): void {
  const previous = diagnosedTailReadFailures.get(diagnosticKey);
  // An in-flight write already covers this key, and a delivered one needs no
  // repeat.
  if (previous?.retained || previous?.pending) return;
  const now = Date.now();
  const exhausted =
    previous !== undefined &&
    previous.attempts >= MAX_TAIL_DIAGNOSTIC_DELIVERY_ATTEMPTS;
  // A spent budget admits one probe per cooldown window rather than staying
  // silent forever, so a repaired sink can report again. The counter is never
  // reset: clearing it would retry a permanently broken sink on every append.
  if (exhausted && now < previous.retryAfter) return;

  if (
    !previous &&
    diagnosedTailReadFailures.size >= MAX_DIAGNOSED_TAIL_READ_FAILURES
  ) {
    // Only a slot whose delivery already failed is reclaimable. A retained slot
    // owns a delivered suppression and a pending slot owns an in-flight one;
    // discarding either is what let a churn of distinct paths re-warn on every
    // pass. With no reclaimable slot, skip the diagnostic instead.
    const reclaimable = [...diagnosedTailReadFailures].find(
      ([, entry]) => !entry.retained && !entry.pending,
    );
    if (!reclaimable) return;
    diagnosedTailReadFailures.delete(reclaimable[0]);
  }

  const attempts = exhausted
    ? MAX_TAIL_DIAGNOSTIC_DELIVERY_ATTEMPTS
    : (previous?.attempts ?? 0) + 1;
  const entry: TailDiagnosticEntry = {
    attempts,
    pending: true,
    retained: false,
    retryAfter:
      attempts >= MAX_TAIL_DIAGNOSTIC_DELIVERY_ATTEMPTS
        ? now + TAIL_DIAGNOSTIC_RETRY_COOLDOWN_MS
        : 0,
  };
  diagnosedTailReadFailures.set(diagnosticKey, entry);

  const message = `Cannot inspect JSONL tail in ${filePath}; appending with a conservative newline separator:`;
  const warnWithDelivery = debugLogger.warnWithDelivery;
  if (warnWithDelivery) {
    warnWithDelivery.call(
      debugLogger,
      (delivered) => {
        // A stale completion must not replace state owned by a newer attempt.
        if (diagnosedTailReadFailures.get(diagnosticKey) !== entry) return;
        entry.pending = false;
        entry.retained = delivered;
      },
      message,
      error,
    );
    return;
  }

  // Compatibility loggers cannot report delivery, so preserve the previous
  // at-most-once best-effort diagnostic instead of retrying blindly.
  debugLogger.warn(message, error);
  entry.pending = false;
  entry.retained = true;
}

function canAppendWithoutTailInspection(
  filePath: string,
  error: unknown,
): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return true;

  // Node --permission reports a read denial with its own structured error.
  const readDeniedByPermissionModel =
    code === 'ERR_ACCESS_DENIED' &&
    (error as { permission?: string }).permission === 'FileSystemRead';
  // Windows can reject the read handle for a sharing violation while still
  // allowing the append handle.
  const windowsSharingViolation =
    code === 'EBUSY' && process.platform === 'win32';
  // A Linux file lease can reject the nonblocking read probe while the
  // normal blocking append succeeds after the lease is released.
  const temporarilyUnavailable = code === 'EAGAIN';
  if (
    code !== 'EACCES' &&
    code !== 'EPERM' &&
    !readDeniedByPermissionModel &&
    !windowsSharingViolation &&
    !temporarilyUnavailable
  ) {
    return false;
  }

  // Preserve append-only files when the tail cannot be read, but expose that
  // tail inspection was skipped without flooding every subsequent line.
  if (!debugLogger.isEnabled() || !isDebugLogFileEnabled()) return true;
  const debugLogPath = getActiveDebugSessionLogPath();
  if (debugLogPath === null) return true;
  reportUninspectableTail(
    JSON.stringify([filePath, debugLogPath]),
    filePath,
    error,
  );
  return true;
}

/**
 * Descriptor-based syscalls (`FileHandle.read`, `FileHandle.stat`, `fstatSync`)
 * do not carry the pathname Node attaches to path-based errors, so a fatal tail
 * inspection would otherwise reach the caller without naming the file. Annotate
 * in place rather than wrapping: callers match on the original error object and
 * its `code`, and the substantive message stays a verbatim prefix.
 */
function withTailInspectionFileContext(
  error: unknown,
  filePath: string,
): unknown {
  if (error instanceof Error && !error.message.includes(filePath)) {
    error.message = `${error.message} (file: ${filePath})`;
  }
  return error;
}

/**
 * Test-only: clear the per-write caches. Needed when tests mutate fs state at
 * the same paths across cases.
 */
export function _resetEnsuredDirsCacheForTest(): void {
  ensuredDirs.clear();
  diagnosedTailReadFailures.clear();
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
  try {
    await lock.runExclusive(async () => {
      const line = `${JSON.stringify(data)}\n`;
      const dir = path.dirname(filePath);
      if (!ensuredDirs.has(dir)) {
        await fs.promises.mkdir(dir, { recursive: true });
        ensuredDirs.add(dir);
      }
      let prefix = '';
      let existing: fs.promises.FileHandle | undefined;
      let appendHandle: fs.promises.FileHandle | undefined;
      let appendHandleReady = false;
      try {
        const fileStats = await fs.promises.stat(filePath);
        if (fileStats.isFile()) {
          existing = await fs.promises.open(filePath, tailProbeFlags);
          const stats = await existing.stat();
          if (stats.isFile() && stats.size > 0) {
            const lastByte = Buffer.allocUnsafe(1);
            const { bytesRead } = await existing.read(
              lastByte,
              0,
              1,
              stats.size - 1,
            );
            prefix = bytesRead === 1 && lastByte[0] === 0x0a ? '' : '\n';
          }
        } else {
          // Inspect and write through the same append-only handle. A read
          // probe is unnecessary here and could consume a FIFO's payload.
          // 0o600 keeps a recreated file owner-only; Node ignores mode when
          // the file already exists, so this only affects creation.
          appendHandle = await fs.promises.open(filePath, 'a', 0o600);
          existing = appendHandle;
          const stats = await appendHandle.stat();
          appendHandleReady = true;
          if (stats.isFile() && stats.size > 0) prefix = '\n';
        }
      } catch (error) {
        if (!canAppendWithoutTailInspection(filePath, error)) {
          throw withTailInspectionFileContext(error, filePath);
        }
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          // Recovery runs inside the catch, so its own descriptor errors would
          // otherwise escape without the file context the rethrow above adds.
          try {
            appendHandle = await fs.promises.open(filePath, 'a', 0o600);
            existing = appendHandle;
            const stats = await appendHandle.stat();
            appendHandleReady = true;
            if (stats.isFile() && stats.size > 0) prefix = '\n';
          } catch (recoveryError) {
            throw withTailInspectionFileContext(recoveryError, filePath);
          }
        } else {
          prefix = '\n';
        }
      } finally {
        // Only a validated writer stays open for the append below.
        if (!appendHandleReady) await existing?.close();
      }
      const openAppender = appendHandleReady ? appendHandle : undefined;
      // flush:true fsyncs after each line so a process killed mid-write
      // doesn't leave a glued `}{` record on disk (closes #3681). On
      // Node v22/v24 strace shows string + utf8 + flush:true does fsync
      // correctly; passing a Buffer is forward-compat insurance against
      // any future C++ fast path that might bypass JS-side flush logic
      // for the string case, with no behavior delta on tested versions.
      // FileHandle.appendFile does not honor flush:true on this path;
      // explicitly match the per-record fsync below it.
      try {
        await fs.promises.appendFile(
          openAppender ?? filePath,
          Buffer.from(prefix + line, 'utf8'),
          {
            flush: true,
          },
        );
        await openAppender?.sync();
      } finally {
        await openAppender?.close();
      }
    });
  } finally {
    if (fileLocks.get(filePath) === lock && !lock.isLocked()) {
      fileLocks.delete(filePath);
    }
  }
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
  let prefix = '';
  let descriptor: number | undefined;
  let appendDescriptor: number | undefined;
  let appendDescriptorReady = false;
  try {
    const fileStats = fs.statSync(filePath);
    if (fileStats.isFile()) {
      descriptor = fs.openSync(filePath, tailProbeFlags);
      const stats = fs.fstatSync(descriptor);
      if (stats.isFile() && stats.size > 0) {
        const lastByte = Buffer.allocUnsafe(1);
        const bytesRead = fs.readSync(
          descriptor,
          lastByte,
          0,
          1,
          stats.size - 1,
        );
        prefix = bytesRead === 1 && lastByte[0] === 0x0a ? '' : '\n';
      }
    } else {
      // Inspect and write through the same append-only handle. A read probe
      // is unnecessary here and could consume a FIFO's payload.
      // 0o600 keeps a recreated file owner-only; Node ignores mode when
      // the file already exists, so this only affects creation.
      appendDescriptor = fs.openSync(filePath, 'a', 0o600);
      descriptor = appendDescriptor;
      const stats = fs.fstatSync(appendDescriptor);
      appendDescriptorReady = true;
      if (stats.isFile() && stats.size > 0) prefix = '\n';
    }
  } catch (error) {
    if (!canAppendWithoutTailInspection(filePath, error)) {
      throw withTailInspectionFileContext(error, filePath);
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Recovery runs inside the catch, so its own descriptor errors would
      // otherwise escape without the file context the rethrow above adds.
      try {
        appendDescriptor = fs.openSync(filePath, 'a', 0o600);
        descriptor = appendDescriptor;
        const stats = fs.fstatSync(appendDescriptor);
        appendDescriptorReady = true;
        if (stats.isFile() && stats.size > 0) prefix = '\n';
      } catch (recoveryError) {
        throw withTailInspectionFileContext(recoveryError, filePath);
      }
    } else {
      prefix = '\n';
    }
  } finally {
    // Only a validated writer stays open for the append below.
    if (!appendDescriptorReady && descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
  const openAppender = appendDescriptorReady ? appendDescriptor : undefined;
  try {
    fs.appendFileSync(
      openAppender ?? filePath,
      Buffer.from(prefix + line, 'utf8'),
      {
        flush: true,
      },
    );
  } finally {
    if (openAppender !== undefined) fs.closeSync(openAppender);
  }
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

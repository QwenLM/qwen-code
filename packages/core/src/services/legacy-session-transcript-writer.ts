/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as nodeConstants from 'node:constants';
import fs from 'node:fs';
import type { BigIntStats } from 'node:fs';
import * as path from 'node:path';
import { Mutex } from 'async-mutex';
import { hasVerifiableInode } from '../utils/file-identity.js';
import * as jsonl from '../utils/jsonl-utils.js';
import { SessionExecutionEngineError } from './session-execution-engine.js';
import { SessionWriterUnavailableError } from './session-writer-lease.js';
import { MANAGED_SESSION_LIMITS } from '../utils/managed-session-format.js';

const EXECUTION_ENGINE_SUBTYPE = 'session_execution_engine';
const MANAGED_HEADER_SUBTYPE = 'managed_session_header_v1';
const NO_FOLLOW = nodeConstants.O_NOFOLLOW ?? 0;
const NONBLOCK = nodeConstants.O_NONBLOCK ?? 0;
const APPEND_READ_WRITE =
  nodeConstants.O_APPEND | nodeConstants.O_RDWR | NO_FOLLOW | NONBLOCK;
const APPEND_CREATE =
  APPEND_READ_WRITE | nodeConstants.O_CREAT | nodeConstants.O_EXCL;
const OWNERSHIP_HEAD_BYTES = 64 * 1024;
const OPEN_CREATE_ATTEMPTS = 8;

const fileLocks = new Map<string, Mutex>();

/** Test seam for recorder unit tests; production leaves this unset. */
export const _legacyTranscriptWriteHookForTest: {
  write?: (
    filePath: string,
    sessionId: string,
    value: unknown,
  ) => Promise<void>;
} = {};

function lockFor(filePath: string): Mutex {
  let lock = fileLocks.get(filePath);
  if (!lock) {
    lock = new Mutex();
    fileLocks.set(filePath, lock);
  }
  return lock;
}

function isSameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    hasVerifiableInode(left.ino) &&
    BigInt(left.dev) === BigInt(right.dev) &&
    BigInt(left.ino) === BigInt(right.ino)
  );
}

function assertRegularFile(stats: BigIntStats): void {
  if (!stats.isFile() || stats.nlink !== 1n || !hasVerifiableInode(stats.ino)) {
    throw new SessionWriterUnavailableError({
      cause: new Error('Session transcript is not a verifiable regular file'),
    });
  }
}

function assertPathStillNamesHandle(
  filePath: string,
  handleStats: BigIntStats,
) {
  let pathStats: BigIntStats;
  try {
    pathStats = fs.lstatSync(filePath, { bigint: true });
  } catch (error) {
    throw new SessionWriterUnavailableError({
      cause: error instanceof Error ? error : undefined,
    });
  }
  if (
    !pathStats.isFile() ||
    pathStats.isSymbolicLink() ||
    pathStats.nlink !== 1n ||
    !isSameFile(pathStats, handleStats)
  ) {
    throw new SessionWriterUnavailableError({
      cause: new Error('Session transcript path changed while opening'),
    });
  }
}

function readFromFd(fd: number, length: number, position: number): Buffer {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = fs.readSync(
      fd,
      buffer,
      offset,
      length - offset,
      position + offset,
    );
    if (count === 0) break;
    offset += count;
  }
  return buffer.subarray(0, offset);
}

type FirstLineShape = 'owner' | 'ordinary' | 'unknown';

const OWNER_SUBTYPES = new Set([
  EXECUTION_ENGINE_SUBTYPE,
  MANAGED_HEADER_SUBTYPE,
]);

/** Reads a JSON string starting at `start` (its opening quote). */
function readJsonStringAt(
  text: string,
  start: number,
): { value: string; next: number } | undefined {
  let escaped = false;
  for (let i = start + 1; i < text.length; i++) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char !== '"') continue;
    try {
      return {
        value: JSON.parse(text.slice(start, i + 1)) as string,
        next: i + 1,
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Returns the index just past a JSON value, or undefined when truncated. */
function skipJsonValue(text: string, start: number): number | undefined {
  const first = text[start];
  if (first === '"') return readJsonStringAt(text, start)?.next;
  if (first === '{' || first === '[') {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const char = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (inString) {
        if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{' || char === '[') depth++;
      else if (char === '}' || char === ']') {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return undefined;
  }
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (char === ',' || char === '}' || char === ']' || /\s/.test(char)) {
      return i;
    }
  }
  return undefined;
}

function skipJsonWhitespace(text: string, start: number): number {
  let i = start;
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

/**
 * Classifies a record whose first line is too large to scan in full.
 *
 * Only top-level keys are inspected. Engine-written records serialize `type`
 * and, for owner records, `subtype` before any large payload (`message` or
 * `systemPayload`), so the decision fits inside the head window even when the
 * record body does not. A marker substring inside a message body or a nested
 * object is never ownership evidence.
 */
function classifyTruncatedFirstLine(prefix: string): FirstLineShape {
  // `\s` consumes a leading byte-order mark as well.
  let index = skipJsonWhitespace(prefix, 0);
  if (prefix[index] !== '{') return 'unknown';
  index = skipJsonWhitespace(prefix, index + 1);
  while (index < prefix.length) {
    const char = prefix[index];
    if (char === '}') return 'ordinary';
    if (char === ',') {
      index = skipJsonWhitespace(prefix, index + 1);
      continue;
    }
    if (char !== '"') return 'unknown';
    const key = readJsonStringAt(prefix, index);
    if (!key) return 'unknown';
    index = skipJsonWhitespace(prefix, key.next);
    if (prefix[index] !== ':') return 'unknown';
    index = skipJsonWhitespace(prefix, index + 1);
    if (key.value === 'subtype') {
      if (prefix[index] !== '"') return 'unknown';
      const value = readJsonStringAt(prefix, index);
      if (!value) return 'unknown';
      return OWNER_SUBTYPES.has(value.value) ? 'owner' : 'ordinary';
    }
    if (key.value === 'type') {
      if (prefix[index] !== '"') return 'unknown';
      const value = readJsonStringAt(prefix, index);
      if (!value) return 'unknown';
      if (value.value !== 'system') return 'ordinary';
      index = skipJsonWhitespace(prefix, value.next);
      continue;
    }
    if (key.value === 'message' || key.value === 'systemPayload') {
      // The record's payload starts before any ownership subtype; owner
      // records serialize `subtype` first.
      return 'ordinary';
    }
    const next = skipJsonValue(prefix, index);
    if (next === undefined) return 'unknown';
    index = skipJsonWhitespace(prefix, next);
  }
  return 'unknown';
}

function ownerEvidenceFromFd(
  fd: number,
  stats: BigIntStats,
  filePath: string,
  sessionId: string,
): void {
  const headLength = Number(
    stats.size < BigInt(OWNERSHIP_HEAD_BYTES)
      ? stats.size
      : BigInt(OWNERSHIP_HEAD_BYTES),
  );
  const head = readFromFd(fd, headLength, 0);
  const linesToInspect = head.toString('utf8').split('\n');
  // A window that ends mid-file yields a partial final line; it is a read
  // artifact, not ownership evidence, and parsing it can only produce a false
  // "ownership could not be verified". Drop it: the single-line-larger-than-
  // the-window case is re-read in full by the block below.
  if (headLength < Number(stats.size) && linesToInspect.length > 1) {
    linesToInspect.pop();
  }
  const firstNewline = head.indexOf(10);
  if (headLength > 0 && firstNewline < 0 && headLength < Number(stats.size)) {
    // The first physical line exceeds the head window. Read further only to
    // find its newline; fail closed when that line carries an ownership
    // marker, but let an oversized ordinary legacy record fall through.
    const firstLineLength = Number(
      stats.size < BigInt(MANAGED_SESSION_LIMITS.maxEventBytes)
        ? stats.size
        : BigInt(MANAGED_SESSION_LIMITS.maxEventBytes),
    );
    const firstLine = readFromFd(fd, firstLineLength, 0);
    const newline = firstLine.indexOf(10);
    const completeFirstLine =
      newline < 0
        ? firstLine.toString('utf8')
        : firstLine.subarray(0, newline).toString('utf8');
    if (newline < 0) {
      // The whole first line exceeds even the extended bound. Decide from its
      // top-level fields: a marker inside a message body or nested object is
      // not ownership evidence, while an owner record still serializes its
      // `subtype` before any large payload.
      const shape = classifyTruncatedFirstLine(completeFirstLine);
      if (shape === 'owner') {
        throw new SessionExecutionEngineError(
          sessionId,
          'ownership record exceeds the read bound',
        );
      }
      if (shape === 'unknown') {
        throw new SessionExecutionEngineError(
          sessionId,
          'ownership could not be verified',
        );
      }
      return;
    }
    linesToInspect[0] = completeFirstLine;
  }

  for (const line of linesToInspect) {
    if (
      !line.includes(EXECUTION_ENGINE_SUBTYPE) &&
      !line.includes(MANAGED_HEADER_SUBTYPE) &&
      !line.includes('\\u')
    ) {
      continue;
    }
    const ownerShaped =
      line.includes(EXECUTION_ENGINE_SUBTYPE) ||
      line.includes(MANAGED_HEADER_SUBTYPE);
    const records = jsonl.parseLineTolerant(line, filePath);
    if (records.length === 0) {
      if (ownerShaped) {
        throw new SessionExecutionEngineError(
          sessionId,
          'ownership could not be verified',
        );
      }
      continue;
    }
    for (const record of records) {
      if (!record || typeof record !== 'object') continue;
      const candidate = record as Record<string, unknown>;
      if (candidate['subtype'] === MANAGED_HEADER_SUBTYPE) {
        throw new SessionExecutionEngineError(sessionId, 'belongs to managed');
      }
      if (candidate['subtype'] !== EXECUTION_ENGINE_SUBTYPE) continue;
      if (
        candidate['type'] !== 'system' ||
        !candidate['systemPayload'] ||
        typeof candidate['systemPayload'] !== 'object' ||
        Array.isArray(candidate['systemPayload'])
      ) {
        throw new SessionExecutionEngineError(
          sessionId,
          'ownership could not be verified',
        );
      }
      const payload = candidate['systemPayload'] as Record<string, unknown>;
      if (
        payload['version'] !== 1 ||
        (payload['engine'] !== 'legacy' && payload['engine'] !== 'managed')
      ) {
        throw new SessionExecutionEngineError(
          sessionId,
          'ownership could not be verified',
        );
      }
      if (payload['engine'] === 'managed') {
        throw new SessionExecutionEngineError(sessionId, 'belongs to managed');
      }
      // A valid Legacy owner record; nothing more to verify for this line.
    }
  }
}

function openTranscriptSync(filePath: string): {
  fd: number;
  created: boolean;
} {
  // Bounded open-or-create loop: a path that keeps flapping between absent
  // and present must end in a clear refusal, not unbounded recursion.
  for (let attempt = 0; attempt < OPEN_CREATE_ATTEMPTS; attempt++) {
    let before: BigIntStats | undefined;
    try {
      before = fs.lstatSync(filePath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    if (before !== undefined) {
      if (!before.isFile() || before.isSymbolicLink()) {
        throw new SessionWriterUnavailableError({
          cause: new Error('Session transcript path is not a regular file'),
        });
      }
      let fd: number;
      try {
        fd = fs.openSync(filePath, APPEND_READ_WRITE);
      } catch (error) {
        // The path disappeared after the lstat (external rm / retention
        // cleanup); fall through to the create attempt instead of failing
        // the whole recorder — bounded by the loop's attempt counter.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      try {
        const opened = fs.fstatSync(fd, { bigint: true });
        assertRegularFile(opened);
        if (!isSameFile(before, opened)) {
          throw new SessionWriterUnavailableError({
            cause: new Error(
              'Session transcript identity changed while opening',
            ),
          });
        }
        assertPathStillNamesHandle(filePath, opened);
        return { fd, created: false };
      } catch (error) {
        fs.closeSync(fd);
        throw error;
      }
    }

    let fd: number;
    try {
      fd = fs.openSync(filePath, APPEND_CREATE, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      assertRegularFile(opened);
      assertPathStillNamesHandle(filePath, opened);
      return { fd, created: true };
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }
  throw new SessionWriterUnavailableError({
    cause: new Error(
      `Session transcript path kept flapping between absent and present after ${OPEN_CREATE_ATTEMPTS} attempts`,
    ),
  });
}

function prepareExistingTranscript(
  fd: number,
  filePath: string,
  sessionId: string,
): void {
  const stats = fs.fstatSync(fd, { bigint: true });
  assertRegularFile(stats);
  if (stats.size > 0n) ownerEvidenceFromFd(fd, stats, filePath, sessionId);
  const mode = Number(stats.mode & 0o777n);
  if ((mode & 0o077) !== 0) {
    const ownerMode = mode & 0o700;
    if ((ownerMode & 0o200) === 0) {
      throw new SessionWriterUnavailableError({
        cause: new Error('Legacy transcript is not owner-writable'),
      });
    }
    fs.fchmodSync(fd, ownerMode);
  }
}

export async function appendLegacySessionTranscriptLine(
  filePath: string,
  sessionId: string,
  value: unknown,
): Promise<void> {
  if (_legacyTranscriptWriteHookForTest.write) {
    await _legacyTranscriptWriteHookForTest.write(filePath, sessionId, value);
    return;
  }
  const lock = lockFor(filePath);
  try {
    await lock.runExclusive(async () => {
      // JSON.stringify returns undefined for `undefined`/function/symbol
      // inputs, which cannot be a transcript record; guard it explicitly.
      const serialized: string | undefined = JSON.stringify(value);
      if (serialized === undefined) {
        throw new SessionWriterUnavailableError({
          cause: new Error('Transcript record is not JSON-serializable'),
        });
      }
      let fd: number | undefined;
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const opened = openTranscriptSync(filePath);
        fd = opened.fd;
        const initialStats = fs.fstatSync(fd, { bigint: true });
        assertRegularFile(initialStats);
        if (!opened.created) prepareExistingTranscript(fd, filePath, sessionId);
        const beforeWrite = fs.fstatSync(fd, { bigint: true });
        assertRegularFile(beforeWrite);
        assertPathStillNamesHandle(filePath, beforeWrite);
        const stats = beforeWrite;
        let prefix = '';
        if (stats.size > 0n) {
          const lastByte = readFromFd(fd, 1, Number(stats.size - 1n));
          if (lastByte.length !== 1) {
            throw new SessionWriterUnavailableError({
              cause: new Error('Could not read the transcript tail'),
            });
          }
          if (lastByte[0] !== 0x0a) prefix = '\n';
        }
        const bytes = Buffer.from(`${prefix}${serialized}\n`, 'utf8');
        let written = 0;
        while (written < bytes.length) {
          const result = fs.writeSync(
            fd,
            bytes,
            written,
            bytes.length - written,
            null,
          );
          if (result <= 0) {
            throw new SessionWriterUnavailableError({
              cause: new Error('Transcript append made no progress'),
            });
          }
          written += result;
        }
        fs.fsyncSync(fd);
        const after = fs.fstatSync(fd, { bigint: true });
        assertRegularFile(after);
        assertPathStillNamesHandle(filePath, after);
      } catch (error) {
        if (
          error instanceof SessionExecutionEngineError ||
          error instanceof SessionWriterUnavailableError
        ) {
          throw error;
        }
        throw new SessionWriterUnavailableError({
          cause: error instanceof Error ? error : undefined,
        });
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    });
  } finally {
    if (fileLocks.get(filePath) === lock && !lock.isLocked())
      fileLocks.delete(filePath);
  }
}

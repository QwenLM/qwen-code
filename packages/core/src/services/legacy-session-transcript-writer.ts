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

const EXECUTION_ENGINE_SUBTYPE = 'session_execution_engine';
const MANAGED_HEADER_SUBTYPE = 'managed_session_header_v1';
const NO_FOLLOW = nodeConstants.O_NOFOLLOW ?? 0;
const NONBLOCK = nodeConstants.O_NONBLOCK ?? 0;
const APPEND_READ_WRITE =
  nodeConstants.O_APPEND | nodeConstants.O_RDWR | NO_FOLLOW | NONBLOCK;
const APPEND_CREATE =
  APPEND_READ_WRITE | nodeConstants.O_CREAT | nodeConstants.O_EXCL;
const OWNERSHIP_HEAD_BYTES = 64 * 1024;
// Full-line JSON inspection allocates several copies; refuse lines over 32 MiB
// rather than infer ownership from a prefix or allow unbounded memory use.
const MAX_INSPECTED_LINE_BYTES = 32 * 1024 * 1024;
// One read for the boundary line: a chunk, not the file's remaining bytes.
const BOUNDARY_READ_CHUNK_BYTES = 64 * 1024;
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

/**
 * Reads the physical line that starts at `lineStart`, up to its newline or
 * EOF. Returns undefined when that line exceeds the inspectable bound.
 *
 * Reads in chunks and stops at the first newline, so appending to a large
 * transcript costs one chunk rather than every byte to its end — the tail
 * probe stays a tail probe. At most one byte past the bound is ever read, so
 * a line longer than the bound is refused rather than read in full, and both
 * the memory and the I/O of the check stay bounded.
 */
function readBoundaryLine(
  fd: number,
  lineStart: number,
  fileSize: number,
): string | undefined {
  const chunks: Buffer[] = [];
  let total = 0;
  let position = lineStart;
  while (position < fileSize) {
    const remaining = fileSize - position;
    const want = Math.min(
      BOUNDARY_READ_CHUNK_BYTES,
      remaining,
      MAX_INSPECTED_LINE_BYTES + 1 - total,
    );
    if (want <= 0) return undefined;
    const chunk = readFromFd(fd, want, position);
    if (chunk.length === 0) break;
    const newline = chunk.indexOf(10);
    if (newline >= 0) {
      chunks.push(chunk.subarray(0, newline));
      return Buffer.concat(chunks).toString('utf8');
    }
    chunks.push(chunk);
    total += chunk.length;
    position += chunk.length;
  }
  // The file ended inside the line: an EOF-terminated line still has to fit
  // the bound, or it is refused rather than read in full.
  return total > MAX_INSPECTED_LINE_BYTES
    ? undefined
    : Buffer.concat(chunks).toString('utf8');
}

type LineShape = 'ordinary' | 'torn-user' | 'owner' | 'unknown';

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

/* Accept only the observed user-message truncation shape, never an arbitrary
 * bounded prefix: a later key or glued record could still carry ownership.
 * A future field in the original record cannot be inferred from torn bytes. */
function classifyLine(line: string): LineShape {
  let index = skipJsonWhitespace(line, 0);
  if (line[index++] !== '{') return 'unknown';
  const firstKey = skipJsonWhitespace(line, index);
  let user = false;
  const keys = new Set<string>();
  for (;;) {
    index = skipJsonWhitespace(line, index);
    if (line[index] === '}' && index === firstKey) {
      return skipJsonWhitespace(line, index + 1) === line.length
        ? 'ordinary'
        : 'unknown';
    }
    if (line[index] !== '"') return 'unknown';
    const key = readJsonStringAt(line, index);
    if (!key) return 'unknown';
    if (keys.has(key.value)) return 'unknown';
    keys.add(key.value);
    index = skipJsonWhitespace(line, key.next);
    if (line[index++] !== ':') return 'unknown';
    index = skipJsonWhitespace(line, index);
    if (key.value === 'type') {
      if (line[index] !== '"') return 'unknown';
      const value = readJsonStringAt(line, index);
      if (!value) return 'unknown';
      user = value.value === 'user';
      index = value.next;
    } else if (key.value === 'subtype') {
      if (line[index] !== '"') return 'unknown';
      const value = readJsonStringAt(line, index);
      if (!value) return 'unknown';
      // An owner subtype makes this line an ownership record whatever the
      // rest holds; a user record's own subtype (`goal_runtime`, mid-turn)
      // does not — `type: "user"` already excludes an owner record.
      if (OWNER_SUBTYPES.has(value.value)) return 'owner';
      index = value.next;
    } else {
      const next = skipJsonValue(line, index);
      if (next === undefined) {
        // The remaining bytes must really be an unfinished JSON string inside
        // the user message, not arbitrary malformed or trailing record data.
        // A non-owner `subtype` is fine: recorder user records carry one
        // (`goal_runtime`, mid-turn), and `type: "user"` already excludes an
        // owner record.
        return key.value === 'message' &&
          user &&
          !hasDuplicateOwnerFields(line) &&
          isValidTornMessagePrefix(line, index) &&
          isTornUserMessage(line.slice(index))
          ? 'torn-user'
          : 'unknown';
      }
      index = next;
    }
    index = skipJsonWhitespace(line, index);
    if (index >= line.length) {
      // The outer object never closed: the line ends between keys or right
      // after a complete value. The bytes on disk name `type: "user"` and no
      // ownership field, so whatever the unwritten tail would have added, it
      // cannot turn this into an owner record — a user message is safe to
      // continue past; anything else stays refused.
      return user && !hasDuplicateOwnerFields(line) ? 'torn-user' : 'unknown';
    }
    if (line[index] === '}') {
      const rest = skipJsonWhitespace(line, index + 1);
      if (rest === line.length) return 'ordinary';
      return 'unknown';
    }
    if (line[index++] !== ',') return 'unknown';
  }
}

function isValidTornMessagePrefix(line: string, valueStart: number): boolean {
  try {
    JSON.parse(`${line.slice(0, valueStart)}null}`);
    return true;
  } catch {
    return false;
  }
}

function isTornUserMessage(value: string): boolean {
  // Validate all bytes through the unfinished string as a JSON prefix by
  // closing only the string and its containers. This excludes malformed values
  // that merely happen to contain an unterminated quote.
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of value) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{') stack.push('}');
    else if (char === '[') stack.push(']');
    else if (char === '}' || char === ']') {
      if (stack.pop() !== char) return false;
    }
  }
  if (!inString || escaped || stack.length === 0) return false;
  try {
    const message: unknown = JSON.parse(`${value}"${stack.reverse().join('')}`);
    return (
      typeof message === 'object' &&
      message !== null &&
      !Array.isArray(message) &&
      (message as Record<string, unknown>)['role'] === 'user' &&
      Array.isArray((message as Record<string, unknown>)['parts'])
    );
  } catch {
    return false;
  }
}

function hasDuplicateOwnerFields(line: string): boolean {
  const scopes: Array<Set<string> | undefined> = [];
  const ownerFields = new Set([
    'type',
    'subtype',
    'systemPayload',
    'version',
    'engine',
  ]);
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '{') scopes.push(new Set());
    else if (line[i] === '[') scopes.push(undefined);
    else if (line[i] === '}' || line[i] === ']') scopes.pop();
    else if (line[i] === '"') {
      const token = readJsonStringAt(line, i);
      if (!token) break;
      i = token.next - 1;
      const keys = scopes[scopes.length - 1];
      if (
        !keys ||
        line[skipJsonWhitespace(line, token.next)] !== ':' ||
        !ownerFields.has(token.value)
      )
        continue;
      if (keys.has(token.value)) return true;
      keys.add(token.value);
    }
  }
  return false;
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
  // A partial line at the end of the head must not hide owner evidence. Read
  // it to its newline or EOF, but refuse rather than classify a bounded prefix.
  if (headLength < Number(stats.size)) {
    const lastNewline = head.lastIndexOf(10);
    const lineStart = lastNewline + 1;
    const boundary = readBoundaryLine(fd, lineStart, Number(stats.size));
    if (boundary === undefined) {
      throw new SessionExecutionEngineError(
        sessionId,
        'ownership could not be verified: line exceeds the read bound',
      );
    }
    linesToInspect[linesToInspect.length - 1] = boundary;
  }

  for (const line of linesToInspect) {
    if (
      Buffer.byteLength(line, 'utf8') <= OWNERSHIP_HEAD_BYTES &&
      !line.includes(EXECUTION_ENGINE_SUBTYPE) &&
      !line.includes(MANAGED_HEADER_SUBTYPE) &&
      !line.includes('\\u')
    ) {
      continue;
    }
    const shape = classifyLine(line);
    if (shape === 'torn-user') continue;
    const parsed = jsonl.parseLineTolerantWithIntegrity(line, filePath);
    const records = parsed.records;
    if (
      (shape === 'unknown' && records.length <= 1) ||
      !parsed.complete ||
      hasDuplicateOwnerFields(line)
    ) {
      throw new SessionExecutionEngineError(
        sessionId,
        'ownership could not be verified',
      );
    }
    let verifiedOwner = false;
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
      verifiedOwner = true;
    }
    if (shape === 'owner' && !verifiedOwner) {
      // JSON.parse keeps only the last duplicate key; an earlier owner subtype
      // must not be erased by a later, conflicting subtype.
      throw new SessionExecutionEngineError(
        sessionId,
        'ownership could not be verified',
      );
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
      // Every later append verifies ownership by reading this record's
      // physical line. A record past the inspectable bound would be accepted
      // now and would then fail every append that follows, so refuse it
      // before it reaches the file instead of stranding the recorder.
      if (Buffer.byteLength(serialized, 'utf8') > MAX_INSPECTED_LINE_BYTES) {
        throw new SessionWriterUnavailableError({
          message: `Transcript record exceeds the ${MAX_INSPECTED_LINE_BYTES} byte verification bound`,
          cause: new Error(
            'A record this large cannot be verified on later appends',
          ),
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

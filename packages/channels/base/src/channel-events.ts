/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { open, readdir, stat, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getGlobalQwenDir, getWorkspaceScopeDirName } from './paths.js';
import { sanitizeLogText } from './sanitize.js';

/**
 * One bounded, append-only record of what a Channel did: an inbound message it
 * accepted or skipped, a publication outcome, an inbound task transition, or a
 * poll result. Records carry routing decisions and identifiers only — never
 * message text — so the journal cannot become a second copy of conversation
 * history.
 */
export const CHANNEL_EVENT_TYPES = [
  'inbound',
  'outbound',
  'task',
  'poll',
] as const;
export type ChannelEventType = (typeof CHANNEL_EVENT_TYPES)[number];

export const CHANNEL_EVENT_MAX_TEXT = 200;
export const CHANNEL_EVENT_MAX_DETAIL_KEYS = 12;
export const CHANNEL_EVENT_MAX_READ = 500;
/**
 * A Channel identity is matched against the name the management API accepted,
 * which allows up to 255 UTF-8 bytes. Code points never exceed bytes, so this
 * cap keeps every legal name intact; only the UI shortens it for display.
 */
const CHANNEL_EVENT_MAX_NAME = 255;
const CHANNEL_EVENT_MAX_FILE_BYTES = 1024 * 1024;
/**
 * Read bounds. The journal is a diagnostic tail, not an archive: a request
 * reads at most this many bytes per file and this many in total, in awaited
 * chunks, so one page poll cannot stall the daemon that also serves sessions.
 * Anything the bounds clip is reported through `truncated`.
 */
const CHANNEL_EVENT_READ_TAIL_BYTES = 256 * 1024;
const CHANNEL_EVENT_READ_BUDGET_BYTES = 4 * 1024 * 1024;
const CHANNEL_EVENT_READ_CHUNK_BYTES = 64 * 1024;
const CHANNEL_EVENT_MAX_FILES = 32;
/**
 * Filtering needs every line parsed, but retaining every parsed record would
 * hold a whole workspace's journals in memory on a page that re-polls every
 * 5 s. Past this multiple of `limit` the accumulator is trimmed to the newest
 * `limit`, which bounds retention without changing the answer.
 */
const CHANNEL_EVENT_READ_TRIM_FACTOR = 4;
const EVENT_FILE_SUFFIX = 'channel-events.jsonl';

export type ChannelEventDetail = Record<string, string | number | boolean>;

export interface ChannelEventRecord {
  at: string;
  channel: string;
  type: ChannelEventType;
  outcome: string;
  reason?: string;
  triggerKind?: string;
  repository?: string;
  thread?: string;
  number?: number;
  actor?: string;
  sessionId?: string;
  /**
   * Workspace owning `sessionId`, when the writer knows it. Bound-session
   * delivery can target a session in another workspace, and a client needs
   * the owner to open it; absent on records written before this field
   * existed, where clients fall back to the journal's own workspace.
   */
  sessionWorkspaceCwd?: string;
  messageId?: string;
  durationMs?: number;
  error?: string;
  detail?: ChannelEventDetail;
}

export type ChannelEventInput = Omit<ChannelEventRecord, 'at' | 'channel'> & {
  at?: string;
};

export interface ChannelEventQuery {
  /** Workspace-scope directories already resolved by the caller. */
  scopeDirs: readonly string[];
  channels?: readonly string[];
  types?: readonly ChannelEventType[];
  since?: number;
  limit?: number;
}

export interface ChannelEventQueryResult {
  events: ChannelEventRecord[];
  /**
   * True when older events are missing: the record limit was reached, a
   * journal was left out by the file cap or the byte budget, or a journal was
   * taller than the tail window.
   */
  truncated: boolean;
}

function text(
  value: unknown,
  maxLen = CHANNEL_EVENT_MAX_TEXT,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const sanitized = sanitizeLogText(value, maxLen);
  return sanitized.length > 0 ? sanitized : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function normalizeDetail(value: unknown): ChannelEventDetail | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const detail: ChannelEventDetail = {};
  for (const [key, entry] of Object.entries(value)) {
    const name = text(key, 64);
    if (!name) continue;
    if (typeof entry === 'string') {
      detail[name] = sanitizeLogText(entry, CHANNEL_EVENT_MAX_TEXT);
    } else if (typeof entry === 'number' && Number.isFinite(entry)) {
      detail[name] = entry;
    } else if (typeof entry === 'boolean') {
      detail[name] = entry;
    } else {
      continue;
    }
    if (Object.keys(detail).length >= CHANNEL_EVENT_MAX_DETAIL_KEYS) break;
  }
  return Object.keys(detail).length > 0 ? detail : undefined;
}

/**
 * Rebuilds a record from untrusted input (a journal line, or an event handed to
 * `appendChannelEvent`). Returns undefined when the required fields are missing
 * or invalid, so a corrupt line can never surface as a half-rendered row.
 */
export function normalizeChannelEventRecord(
  value: unknown,
): ChannelEventRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const at = text(raw['at'], 40);
  const channel = text(raw['channel'], CHANNEL_EVENT_MAX_NAME);
  const outcome = text(raw['outcome'], 64);
  const type = raw['type'];
  if (
    !at ||
    !channel ||
    !outcome ||
    !CHANNEL_EVENT_TYPES.includes(type as ChannelEventType)
  ) {
    return undefined;
  }
  const record: ChannelEventRecord = {
    at,
    channel,
    type: type as ChannelEventType,
    outcome,
  };
  const reason = text(raw['reason'], 80);
  if (reason) record.reason = reason;
  const triggerKind = text(raw['triggerKind'], 64);
  if (triggerKind) record.triggerKind = triggerKind;
  const repository = text(raw['repository'], 140);
  if (repository) record.repository = repository;
  const thread = text(raw['thread'], 80);
  if (thread) record.thread = thread;
  const number = finiteNumber(raw['number']);
  if (number !== undefined) record.number = number;
  const actor = text(raw['actor'], 100);
  if (actor) record.actor = actor;
  const sessionId = text(raw['sessionId'], 120);
  if (sessionId) record.sessionId = sessionId;
  const sessionWorkspaceCwd = text(raw['sessionWorkspaceCwd'], 1024);
  if (sessionWorkspaceCwd) record.sessionWorkspaceCwd = sessionWorkspaceCwd;
  const messageId = text(raw['messageId'], 120);
  if (messageId) record.messageId = messageId;
  const durationMs = finiteNumber(raw['durationMs']);
  if (durationMs !== undefined) record.durationMs = durationMs;
  const error = text(raw['error']);
  if (error) record.error = error;
  const detail = normalizeDetail(raw['detail']);
  if (detail) record.detail = detail;
  return record;
}

/**
 * Directory holding a Channel's workspace-scoped state files.
 */
export function channelEventScopeDir(cwd: string): string {
  return join(getGlobalQwenDir(), 'channels', getWorkspaceScopeDirName(cwd));
}

function channelEventFilePrefix(channelName: string): string {
  const encodedName = channelName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
  const nameHash = createHash('sha256')
    .update(channelName)
    .digest('hex')
    .slice(0, 16);
  return `${encodedName}-${nameHash}-`;
}

export function channelEventFilePath(channelName: string, cwd: string): string {
  return join(
    channelEventScopeDir(cwd),
    `${channelEventFilePrefix(channelName)}${EVENT_FILE_SUFFIX}`,
  );
}

function rotateIfNeeded(path: string): void {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (size < CHANNEL_EVENT_MAX_FILE_BYTES) return;
  const rotated = `${path}.1`;
  // Windows refuses to rename onto an existing file, so drop the previous
  // rotation first instead of relying on POSIX rename semantics.
  try {
    unlinkSync(rotated);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  renameSync(path, rotated);
}

/**
 * Appends one event to a Channel's journal. A failure is reported once on
 * stderr and swallowed: diagnostics must never break message handling.
 */
export function appendChannelEvent(
  channelName: string,
  cwd: string,
  input: ChannelEventInput,
): void {
  try {
    const record = normalizeChannelEventRecord({
      ...input,
      at: input.at ?? new Date().toISOString(),
      channel: channelName,
    });
    if (!record) return;
    const path = channelEventFilePath(channelName, cwd);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      chmodSync(dirname(path), 0o700);
    } catch {
      // A directory we do not own stays as created; the append below still
      // decides whether this Channel can write to it.
    }
    rotateIfNeeded(path);
    appendFileSync(path, `${JSON.stringify(record)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
  } catch (err) {
    process.stderr.write(
      `[Channel:${sanitizeLogText(channelName, 80)}] channel event write failed: ${sanitizeLogText(
        err instanceof Error ? err.message : String(err),
        200,
      )}\n`,
    );
  }
}

async function readTail(
  path: string,
  maxBytes: number,
): Promise<{ lines: string[]; bytes: number; clipped: boolean }> {
  let handle: FileHandle;
  try {
    handle = await open(path, 'r');
  } catch (err) {
    // A journal that has not been written yet is not a failure; anything else
    // (permissions, I/O) must not read as "this Channel did nothing".
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { lines: [], bytes: 0, clipped: false };
    }
    throw err;
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    // A window starting mid-file usually lands inside a line, but it can land
    // exactly on a boundary. Read one leading byte to tell the two apart, so an
    // aligned window keeps every complete record instead of dropping one for
    // nothing. Folding that byte into the first chunk keeps the read to one
    // awaited call per chunk — the daemon serves other requests between them.
    const lead = start > 0 ? 1 : 0;
    const chunks: Buffer[] = [];
    let position = start - lead;
    let bytes = 0;
    while (position < size) {
      const length = Math.min(CHANNEL_EVENT_READ_CHUNK_BYTES, size - position);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead <= 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      bytes += bytesRead;
      position += bytesRead;
    }
    const window = Buffer.concat(chunks);
    const lines = window.subarray(lead).toString('utf-8').split('\n');
    if (lead === 1 && window[0] !== 0x0a) lines.shift();
    // The skipped head is clipped data too: a journal grows to 1 MiB before it
    // rotates, so a 256 KiB tail of a busy Channel omits its own older events.
    return {
      lines: lines.filter((line) => line.length > 0),
      bytes: Math.max(0, bytes - lead),
      clipped: start > 0,
    };
  } finally {
    await handle.close();
  }
}

async function eventFiles(
  scopeDir: string,
  channels?: readonly string[],
): Promise<{ files: Array<{ path: string; size: number }>; clipped: boolean }> {
  let names: string[];
  try {
    names = await readdir(scopeDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { files: [], clipped: false };
    }
    throw err;
  }
  // Narrow to the requested identities before the read cap: otherwise busier
  // peers (rotated files count too) would make an explicitly asked for,
  // quieter Channel's retained history unreachable.
  const prefixes = channels?.map(channelEventFilePrefix);
  const candidates = names
    .filter((name) => {
      if (
        !name.endsWith(`-${EVENT_FILE_SUFFIX}`) &&
        !name.endsWith(`-${EVENT_FILE_SUFFIX}.1`)
      ) {
        return false;
      }
      return !prefixes || prefixes.some((prefix) => name.startsWith(prefix));
    })
    .map((name) => join(scopeDir, name));
  const stated = await Promise.all(
    candidates.map(async (file) => {
      try {
        const { mtimeMs, size } = await stat(file);
        return { file, at: mtimeMs, size };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw err;
      }
    }),
  );
  // Freshest first, so both the file cap and the byte budget spend their
  // allowance on the journals an operator is most likely looking at.
  const files = stated
    .filter(
      (entry): entry is { file: string; at: number; size: number } =>
        entry !== undefined,
    )
    .sort((left, right) => right.at - left.at)
    .map((entry) => ({ path: entry.file, size: entry.size }));
  return {
    files: files.slice(0, CHANNEL_EVENT_MAX_FILES),
    clipped: files.length > CHANNEL_EVENT_MAX_FILES,
  };
}

// Journal lines carry ISO timestamps from different writers; order by the
// parsed instant so a record with an offset cannot jump the queue.
function eventTime(record: ChannelEventRecord): number {
  const parsed = Date.parse(record.at);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Reads the newest events across the given workspace scopes. Every candidate
 * path is a file found inside an already-resolved scope directory, so a query
 * value can never select a path.
 *
 * The read is asynchronous and chunked: this runs inside the daemon that also
 * serves sessions, so a synchronous multi-megabyte scan would stall every
 * other request for as long as it takes.
 */
export async function readChannelEvents(
  query: ChannelEventQuery,
): Promise<ChannelEventQueryResult> {
  const limit = Math.max(
    1,
    Math.min(CHANNEL_EVENT_MAX_READ, Math.floor(query.limit ?? 100)),
  );
  const channels = query.channels?.length ? new Set(query.channels) : undefined;
  const types = query.types?.length
    ? new Set<ChannelEventType>(query.types)
    : undefined;
  const events: ChannelEventRecord[] = [];
  let budget = CHANNEL_EVENT_READ_BUDGET_BYTES;
  let clipped = false;
  let overLimit = false;

  for (const scopeDir of query.scopeDirs) {
    const candidates = await eventFiles(scopeDir, query.channels);
    clipped = clipped || candidates.clipped;
    for (const file of candidates.files) {
      // Reserve what this journal actually needs, not a full window: a small
      // journal must still be read when the remainder is under one window but
      // comfortably over its size. Stopping only when a whole journal cannot
      // fit keeps the flag's meaning ("whole journals were left out") exact.
      const window = Math.min(CHANNEL_EVENT_READ_TAIL_BYTES, file.size);
      if (budget < window) {
        clipped = true;
        break;
      }
      const tail = await readTail(file.path, window);
      budget -= tail.bytes;
      clipped = clipped || tail.clipped;
      for (const line of tail.lines) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const record = normalizeChannelEventRecord(parsed);
        if (!record) continue;
        if (channels && !channels.has(record.channel)) continue;
        if (types && !types.has(record.type)) continue;
        if (query.since !== undefined) {
          // A record whose instant cannot be parsed has no known time, so it
          // cannot satisfy a time bound. An unfiltered read still returns it
          // (the page renders the raw string) ahead of every dated record.
          const at = Date.parse(record.at);
          if (!Number.isFinite(at) || at < query.since) continue;
        }
        events.push(record);
      }
      if (events.length > limit * CHANNEL_EVENT_READ_TRIM_FACTOR) {
        // Dropping the oldest here cannot change the answer: every later
        // record sorts after an equal instant, so a dropped record can never
        // re-enter the newest `limit`. The sort is stable, which is what makes
        // that hold for records sharing a timestamp.
        events.sort((left, right) => eventTime(left) - eventTime(right));
        events.splice(0, events.length - limit);
        overLimit = true;
      }
    }
  }

  events.sort((left, right) => eventTime(left) - eventTime(right));
  if (overLimit || events.length > limit) {
    return { events: events.slice(-limit), truncated: true };
  }
  return { events, truncated: clipped };
}

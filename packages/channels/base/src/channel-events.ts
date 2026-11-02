/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
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
const CHANNEL_EVENT_READ_TAIL_BYTES = 2 * 1024 * 1024;
const CHANNEL_EVENT_MAX_FILES = 32;
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
  /** True when older events were dropped to honour `limit`. */
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

function readTail(path: string, maxBytes: number): string[] {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return [];
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return [];
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const read = readSync(
        fd,
        buffer,
        offset,
        length - offset,
        start + offset,
      );
      if (read <= 0) break;
      offset += read;
    }
    const chunk = buffer.subarray(0, offset).toString('utf-8');
    // Starting mid-file can land inside a line; drop that partial line.
    const lines = chunk.split('\n');
    if (start > 0) lines.shift();
    return lines.filter((line) => line.length > 0);
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}

function eventFiles(scopeDir: string, channels?: readonly string[]): string[] {
  try {
    // Narrow to the requested identities before the read cap: otherwise 32
    // busier peers (rotated files count too) would make an explicitly asked
    // for, quieter Channel's retained history unreachable.
    const prefixes = channels?.map(channelEventFilePrefix);
    const files = readdirSync(scopeDir)
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
    if (files.length <= CHANNEL_EVENT_MAX_FILES) return files;
    // A workspace with many Channels must not turn one request into an
    // unbounded read: keep the files touched most recently.
    return files
      .map((file) => {
        try {
          return { file, at: statSync(file).mtimeMs };
        } catch {
          return { file, at: 0 };
        }
      })
      .sort((left, right) => right.at - left.at)
      .slice(0, CHANNEL_EVENT_MAX_FILES)
      .map((entry) => entry.file);
  } catch {
    return [];
  }
}

/**
 * Reads the newest events across the given workspace scopes. Every candidate
 * path is a file found inside an already-resolved scope directory, so a query
 * value can never select a path.
 */
export function readChannelEvents(
  query: ChannelEventQuery,
): ChannelEventQueryResult {
  const limit = Math.max(
    1,
    Math.min(CHANNEL_EVENT_MAX_READ, Math.floor(query.limit ?? 100)),
  );
  const channels = query.channels?.length ? new Set(query.channels) : undefined;
  const types = query.types?.length
    ? new Set<ChannelEventType>(query.types)
    : undefined;
  const events: ChannelEventRecord[] = [];

  for (const scopeDir of query.scopeDirs) {
    for (const file of eventFiles(scopeDir, query.channels)) {
      for (const line of readTail(file, CHANNEL_EVENT_READ_TAIL_BYTES)) {
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
          const at = Date.parse(record.at);
          if (!Number.isFinite(at) || at < query.since) continue;
        }
        events.push(record);
      }
    }
  }

  // Journal lines carry ISO timestamps from different writers; order by the
  // parsed instant so a record with an offset cannot jump the queue.
  const timeOf = (record: ChannelEventRecord): number => {
    const parsed = Date.parse(record.at);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  events.sort((left, right) => timeOf(left) - timeOf(right));
  if (events.length <= limit) return { events, truncated: false };
  return { events: events.slice(-limit), truncated: true };
}

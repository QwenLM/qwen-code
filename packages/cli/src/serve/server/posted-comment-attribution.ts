/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Marker-free authorship attribution for the bound PR comment watch
 * (docs/design/2026-11-08-bound-pr-comment-watch.md).
 *
 * A bound session must not receive a comment it posted itself, but GitHub
 * gives the channel one account identity for every local session, so the
 * comment's `user.login` cannot distinguish them. The only per-session,
 * marker-free evidence is the session transcript: a shell tool result that
 * CREATED a comment carries the command and the returned comment id/URL.
 *
 * This module extracts the set of comment identifiers a session posted from
 * its transcript `tool_result` entries. Only creations attribute; reads and
 * lists do not, so a session that merely inspected a comment still receives
 * the event. Identifiers are canonical: `ic:<id>` for conversation (issue)
 * comments, `rc:<id>` for inline pull-request review comments.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

/** Canonical identifier for a conversation (issue) comment. */
export function issueCommentKey(id: string | number): string {
  return `ic:${id}`;
}

/** Canonical identifier for an inline pull-request review comment. */
export function reviewCommentKey(id: string | number): string {
  return `rc:${id}`;
}

const SHELL_TOOL_NAMES = new Set(['run_shell_command', 'shell']);

/**
 * Commands that CREATE a comment or review. Reads/lists (`gh pr view`,
 * `gh api` GET, `listComments`) deliberately do not match, so inspecting a
 * comment never suppresses its delivery.
 */
const CREATION_COMMAND_PATTERNS: readonly RegExp[] = [
  /\bgh\s+pr\s+comment\b/,
  /\bgh\s+issue\s+comment\b/,
  /\bgh\s+pr\s+review\b/,
  // gh api / curl writing to a comments or reviews collection.
  /\bgh\s+api\b[\s\S]*?\b(?:issues|pulls)\/\d+\/(?:comments|reviews)\b[\s\S]*?(?:-X\s+POST|--method\s+POST|-f\s|--field\s|-F\s|--raw-field\s|--input\s)/,
  /\bcurl\b[\s\S]*?\brepos\/[^/\s]+\/[^/\s]+\/(?:issues|pulls)\/\d+\/(?:comments|reviews)\b[\s\S]*?(?:-X\s+POST|--request\s+POST|-d\s|--data\b)/,
];

/**
 * An explicit GET is a read even when field flags are present: `gh api` sends
 * `-f`/`-F` values as query parameters on a GET, so
 * `gh api …/comments --method GET --paginate -F per_page=100` lists comments
 * and must never attribute them. Without this veto the field-flag creation
 * pattern matches and a session that only read comments is recorded as their
 * author, permanently withholding events it should receive.
 */
const EXPLICIT_GET_PATTERN = /(?:--method[=\s]+|-X\s*)GET\b/i;

function isCreationCommand(command: string): boolean {
  if (EXPLICIT_GET_PATTERN.test(command)) return false;
  return CREATION_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

/** Which collection an api/curl creation targeted, for bare JSON `id`s. */
function creationTarget(
  command: string,
): 'issue-comment' | 'review-comment' | undefined {
  if (/\bissues\/\d+\/comments\b/.test(command)) return 'issue-comment';
  if (/\bpulls\/\d+\/comments\b/.test(command)) return 'review-comment';
  return undefined;
}

/**
 * Extract posted comment identifiers from one parsed transcript entry.
 * Returns an empty array for anything that is not a shell creation result.
 * Never throws on malformed input.
 */
export function extractPostedCommentIds(entry: unknown): string[] {
  if (entry === null || typeof entry !== 'object') return [];
  const record = entry as Record<string, unknown>;
  if (record['type'] !== 'tool_result') return [];
  const message = record['message'];
  if (message === null || typeof message !== 'object') return [];
  const parts = (message as Record<string, unknown>)['parts'];
  if (!Array.isArray(parts)) return [];

  const ids = new Set<string>();
  for (const part of parts) {
    if (part === null || typeof part !== 'object') continue;
    const functionResponse = (part as Record<string, unknown>)[
      'functionResponse'
    ];
    if (functionResponse === null || typeof functionResponse !== 'object') {
      continue;
    }
    const fr = functionResponse as Record<string, unknown>;
    const name = fr['name'];
    if (typeof name !== 'string' || !SHELL_TOOL_NAMES.has(name)) continue;
    const response = fr['response'];
    if (response === null || typeof response !== 'object') continue;
    const output = (response as Record<string, unknown>)['output'];
    if (typeof output !== 'string') continue;

    // The shell tool echoes "Command: <cmd>\nDirectory: ...\nOutput: <result>".
    const command =
      output.match(/^Command: ([\s\S]*?)\nDirectory:/)?.[1] ??
      output.match(/^Command: ([\s\S]*?)\nOutput:/)?.[1] ??
      '';
    if (!command || !isCreationCommand(command)) continue;
    const result =
      output.match(/\nOutput: ([\s\S]*?)\nError:/)?.[1] ??
      output.match(/\nOutput: ([\s\S]*)$/)?.[1] ??
      '';

    for (const match of result.matchAll(/issuecomment-(\d+)/g)) {
      ids.add(issueCommentKey(match[1]!));
    }
    for (const match of result.matchAll(/discussion_r(\d+)/g)) {
      ids.add(reviewCommentKey(match[1]!));
    }
    // A bare JSON `id` only counts when the command targeted a comments
    // collection, so an unrelated numeric id in the output is not grabbed.
    const target = creationTarget(command);
    if (target) {
      for (const match of result.matchAll(/"id"\s*:\s*(\d+)/g)) {
        ids.add(
          target === 'issue-comment'
            ? issueCommentKey(match[1]!)
            : reviewCommentKey(match[1]!),
        );
      }
    }
  }
  return [...ids];
}

interface TranscriptScanCache {
  size: number;
  mtimeMs: number;
  /** Bytes consumed up to (and including) the last complete newline. */
  offset: number;
  ids: Set<string>;
}

const scanCache = new Map<string, TranscriptScanCache>();

/**
 * Bound the cache like the worker's wake-cwd cache: each entry retains a full
 * id set for the life of the process, so an unbounded map would grow with every
 * session ever looked up. Evict the oldest entry when full; an evicted session
 * simply rescans on its next lookup.
 */
const MAX_TRANSCRIPT_SCAN_CACHE = 256;

/** Test hook: drop cached scans (e.g. when a fixture rewrites a transcript). */
export function clearPostedCommentScanCache(): void {
  scanCache.clear();
}

async function readRange(
  path: string,
  start: number,
  end: number,
): Promise<string> {
  if (end <= start) return '';
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path, { start, end: end - 1 });
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Return the set of comment identifiers the session at `transcriptPath` has
 * posted, scanning incrementally: an unchanged file is answered from cache,
 * a grown file scans only the appended bytes, and a shrunk file rescans from
 * the start. Transcripts are append-only per session, so growth is treated as
 * an append; a file replaced in place by a larger one is not detected (the
 * per-session path makes this a non-goal). A missing or unreadable transcript
 * yields an empty set (fail-open for delivery) — the caller logs it; it is
 * never a reason to prune bindings.
 */
export async function postedCommentIdsForTranscript(
  transcriptPath: string,
): Promise<ReadonlySet<string>> {
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(transcriptPath);
  } catch {
    scanCache.delete(transcriptPath);
    return new Set();
  }
  if (!stats.isFile()) return new Set();

  const cached = scanCache.get(transcriptPath);
  if (
    cached &&
    cached.size === stats.size &&
    cached.mtimeMs === stats.mtimeMs
  ) {
    return cached.ids;
  }

  let offset = 0;
  let ids = new Set<string>();
  if (cached && stats.size > cached.size) {
    offset = cached.offset;
    ids = new Set(cached.ids);
  }

  let text: string;
  try {
    text = await readRange(transcriptPath, offset, stats.size);
  } catch {
    return cached?.ids ?? new Set();
  }

  // Consume only complete lines; leave a trailing partial line for the next
  // scan so a mid-write append is never parsed as a broken record.
  const lastNewline = text.lastIndexOf('\n');
  const consumable = lastNewline === -1 ? '' : text.slice(0, lastNewline + 1);
  const consumedBytes = Buffer.byteLength(consumable, 'utf8');
  for (const line of consumable.split('\n')) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    for (const id of extractPostedCommentIds(entry)) ids.add(id);
  }

  if (
    scanCache.size >= MAX_TRANSCRIPT_SCAN_CACHE &&
    !scanCache.has(transcriptPath)
  ) {
    const oldest = scanCache.keys().next().value;
    if (oldest !== undefined) scanCache.delete(oldest);
  }
  scanCache.set(transcriptPath, {
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    offset: offset + consumedBytes,
    ids,
  });
  return ids;
}

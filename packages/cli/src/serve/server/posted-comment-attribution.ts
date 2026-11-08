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
 * comment never suppresses its delivery. Subcommand patterns are tested on the
 * quote-stripped stage; path patterns on a quote-unwrapped copy (a quoted
 * collection path still counts).
 */
const SUBCOMMAND_PATTERNS: readonly RegExp[] = [
  /\bgh\s+pr\s+comment\b/,
  /\bgh\s+issue\s+comment\b/,
  /\bgh\s+pr\s+review\b/,
];

const PATH_PATTERNS: readonly RegExp[] = [
  // gh api / curl writing to a comments or reviews collection.
  /\bgh\s+api\b[\s\S]*?\b(?:issues|pulls)\/\d+\/(?:comments|reviews)\b[\s\S]*?(?:-X\s+POST|--method\s+POST|-f\s|--field\s|-F\s|--raw-field\s|--input\s)/,
  /\bcurl\b[\s\S]*?\brepos\/[^/\s]+\/[^/\s]+\/(?:issues|pulls)\/\d+\/(?:comments|reviews)\b[\s\S]*?(?:-X\s+POST|--request\s+POST|-d\s|--data\b)/,
  // curl commonly puts the write flags before the URL.
  /\bcurl\b[\s\S]*?(?:-X\s+POST|--request\s+POST|-d\s|--data\b)[\s\S]*?\brepos\/[^/\s]+\/[^/\s]+\/(?:issues|pulls)\/\d+\/(?:comments|reviews)\b/,
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

/**
 * A quoted GET method value (`--method "GET"`, `-X 'GET'`) is a real GET flag;
 * unwrap it so the veto still sees it after quote-stripping. GET text inside a
 * quoted body (`-f body='--method GET'`) is not a flag and must not veto a POST.
 */
const QUOTED_GET_VALUE_PATTERN = /(--method[=\s]+|-X\s*)["']GET["']/gi;

/**
 * Drop quoted spans so a creation subcommand or write flag inside a quoted
 * argument is not mistaken for the real command: `grep 'gh pr comment' …` is a
 * read, and `--jq '.[] | .id'` must not fragment the pipeline split below.
 * Best-effort (escaped quotes are not modeled), consistent with the module's
 * best-effort attribution that fails open toward delivery.
 */
function stripQuotedSpans(command: string): string {
  return command.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
}

/**
 * Split a shell chain into pipeline stages on separators OUTSIDE quotes only.
 * A write flag must sit in the SAME stage as the collection path to count as a
 * creation: `gh api …/comments --jq … ; stat -f '%Sm' …` is a GET listing
 * followed by an unrelated `-f`, not a POST. Splitting inside quotes would also
 * tear a read-only search such as `rg 'gh api|gh pr comment' …` into unbalanced
 * fragments and mistake the quoted `gh pr comment` for a real creation, so a
 * separator only ends a stage when no quote is open. A newline is a boundary
 * too. Best-effort: escaped quotes are not modeled.
 */
function commandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    // A backslash-newline is a line continuation, not a command boundary: the
    // write flag on the continued line belongs to the same stage as the path.
    if (
      ch === '\\' &&
      (command[i + 1] === '\n' ||
        (command[i + 1] === '\r' && command[i + 2] === '\n'))
    ) {
      current += ' ';
      i += command[i + 1] === '\r' ? 2 : 1;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '\n' || ch === '\r') {
      segments.push(current);
      current = '';
      continue;
    }
    if (ch === '&') {
      // `&&` ends a stage; `&>` and `>&` are redirections, not boundaries; a
      // lone `&` backgrounds the command and ends the stage.
      if (command[i + 1] === '&') {
        segments.push(current);
        current = '';
        i++;
      } else if (command[i + 1] === '>' || current.endsWith('>')) {
        current += ch;
      } else {
        segments.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments;
}

/**
 * A path-based creation must be led by `gh api` / `curl`, optionally behind a
 * wrapper command (env/time/nohup/command/sudo with its flags/assignments) or an
 * assignment capture (`cid=$(…)` / backticks). The lead-in is what rejects a
 * read-only search that merely quotes a creation (`rg 'gh api … -X POST'`): its
 * stage starts with the search tool, not a wrapper or the API command. A flag's
 * optional value never consumes the `gh` of `gh api`.
 */
const API_STAGE_START =
  /^\s*(?:(?:env|time|nohup|command|sudo)\s+(?:(?:-[A-Za-z][A-Za-z-]*(?:\s+(?!gh\b)[^\s]+)?|[A-Za-z_][A-Za-z0-9_]*=[^\s]*)\s+)*|[A-Za-z_][A-Za-z0-9_]*=(?:\$\(|`)\s*)*(?:gh\s+api|curl)\b/;

function segmentIsCreation(segment: string): boolean {
  // An explicit GET is a read even with field flags (gh api sends them as query
  // parameters on a GET). Unwrap a quoted GET method value first so the veto
  // still sees it, then strip quoted spans so GET text inside a body does not
  // veto a genuine POST.
  const getProbe = stripQuotedSpans(
    segment.replace(QUOTED_GET_VALUE_PATTERN, '$1GET'),
  );
  if (EXPLICIT_GET_PATTERN.test(getProbe)) return false;
  const stripped = stripQuotedSpans(segment);
  // curl -G / --get sends a GET even when -d/--data is present (the data becomes
  // query parameters), so a -G listing is a read, not a creation.
  if (
    /\bcurl\b/.test(stripped) &&
    /(?:^|\s)(?:--get|-[A-Za-z]*G[A-Za-z]*)(?:\s|$)/.test(stripped)
  ) {
    return false;
  }
  if (SUBCOMMAND_PATTERNS.some((pattern) => pattern.test(stripped)))
    return true;
  // A quoted collection path still counts, so test the path patterns on a copy
  // with quote characters removed (content kept). Require the stage to be led by
  // gh api / curl (possibly behind a wrapper or capture) so a read-only search
  // quoting such a command is not mistaken for a creation.
  const unwrapped = segment.replace(/['"]/g, '');
  if (
    API_STAGE_START.test(unwrapped) &&
    PATH_PATTERNS.some((pattern) => pattern.test(unwrapped))
  ) {
    return true;
  }
  return false;
}

/** The first stage that is a creation, for both detection and target typing. */
function creationSegment(command: string): string | undefined {
  return commandSegments(command).find((segment) => segmentIsCreation(segment));
}

/**
 * Which collection the creation stage targeted, for bare JSON `id`s. Inspect the
 * creation stage only, so a command that also reads another collection does not
 * key the created id to the wrong one.
 */
function creationTarget(
  segment: string,
): 'issue-comment' | 'review-comment' | undefined {
  const unwrapped = segment.replace(/['"]/g, '');
  if (/\bissues\/\d+\/comments\b/.test(unwrapped)) return 'issue-comment';
  if (/\bpulls\/\d+\/comments\b/.test(unwrapped)) return 'review-comment';
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
    const segment = command ? creationSegment(command) : undefined;
    if (!segment) continue;
    const result =
      output.match(/\nOutput: ([\s\S]*?)\nError:/)?.[1] ??
      output.match(/\nOutput: ([\s\S]*)$/)?.[1] ??
      '';

    // Harvest only a creation-shaped response, never a listing or free text: a
    // create returns exactly one comment URL, a single JSON object, or a bare
    // id. A compound "create && list" or a body quoting another comment's URL
    // yields several candidates, which is ambiguous — attribute nothing there
    // (fail-open: the author may self-echo once, but a mere reader is never
    // credited with comments it only listed).
    const urlMatches = [...result.matchAll(/issuecomment-(\d+)/g)].map((m) =>
      issueCommentKey(m[1]!),
    );
    urlMatches.push(
      ...[...result.matchAll(/discussion_r(\d+)/g)].map((m) =>
        reviewCommentKey(m[1]!),
      ),
    );
    if (urlMatches.length === 1) {
      ids.add(urlMatches[0]!);
    }
    const target = creationTarget(segment);
    if (target) {
      const trimmed = result.trim();
      const keyFor = (id: string | number): string =>
        target === 'issue-comment' ? issueCommentKey(id) : reviewCommentKey(id);
      // A single JSON object's top-level id (not a listing array, not a nested
      // user.id).
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const parsed: unknown = JSON.parse(trimmed);
          if (
            parsed !== null &&
            typeof parsed === 'object' &&
            !Array.isArray(parsed)
          ) {
            const id = (parsed as { id?: unknown }).id;
            if (typeof id === 'number' && Number.isSafeInteger(id)) {
              ids.add(keyFor(id));
            }
          }
        } catch {
          // Not JSON; fall through to the bare-id shape.
        }
      }
      // A recognised creation whose whole output is a bare number is the
      // `gh api … --input payload.json --jq '.id'` publish shape.
      if (/^\d+$/.test(trimmed)) {
        ids.add(keyFor(trimmed));
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

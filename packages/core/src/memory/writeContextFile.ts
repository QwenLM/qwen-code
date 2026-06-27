/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  E_TIMEOUT,
  Mutex,
  withTimeout,
  type MutexInterface,
} from 'async-mutex';
import { Storage } from '../config/storage.js';
import { getCurrentGeminiMdFilename, MEMORY_SECTION_HEADER } from './const.js';

/**
 * Per-resolved-file mutex map. Two simultaneous `writeWorkspaceContextFile`
 * calls targeting the same file would otherwise race read-then-write:
 * both reads see the same existing content, both compose new content in
 * memory, and the later `fs.writeFile` overwrites the earlier append.
 * Result is a silently-lost entry with both callers observing success.
 *
 * Pattern mirrors `packages/core/src/utils/jsonl-utils.ts:36-46`. The
 * Map grows by one entry per unique resolved path; production has at
 * most two (workspace QWEN.md + global QWEN.md), so no cleanup is
 * required. Tests use tmpdirs and clean up with `afterEach` — the Map
 * keeps inert entries between tests but each entry is a single Mutex
 * that acquires no resources when idle.
 */
const fileLocks = new Map<string, MutexInterface>();

/**
 * Per-file-mutex acquire deadline. A wedged filesystem (NFS hiccup,
 * disk I/O stall, locked OneDrive sync target) would otherwise let
 * `runExclusive` hold indefinitely — every subsequent `POST
 * /workspace/memory` for the same path queues up with no deadline,
 * no abort path, and no diagnostic. 30 s is generous for any sane
 * filesystem op while bounded enough that a single stalled write
 * doesn't silently consume the daemon's request budget.
 *
 * On timeout `withTimeout` rejects with the sentinel `E_TIMEOUT`,
 * which `writeWorkspaceContextFile` catches and rethrows as the
 * typed `WorkspaceMemoryWriteTimeoutError` for the route to map to
 * a 500 `memory_write_timeout`.
 */
const FILE_LOCK_TIMEOUT_MS = 30_000;

function getFileLock(filePath: string): MutexInterface {
  let lock = fileLocks.get(filePath);
  if (!lock) {
    lock = withTimeout(new Mutex(), FILE_LOCK_TIMEOUT_MS);
    fileLocks.set(filePath, lock);
  }
  return lock;
}

/**
 * Thrown when the per-file mutex acquire times out. The route maps
 * this to a 500 with `code: 'memory_write_timeout'` so SDK callers
 * can branch on a stalled-fs / hung-write condition without parsing
 * a generic 500.
 */
export class WorkspaceMemoryWriteTimeoutError extends Error {
  readonly filePath: string;
  readonly timeoutMs: number;
  constructor(filePath: string, timeoutMs: number) {
    super(
      `Workspace memory write at ${filePath} did not acquire the per-file ` +
        `lock within ${timeoutMs}ms — another write may be stalled (NFS / ` +
        `OneDrive / locked file). Retry or restart the daemon.`,
    );
    this.name = 'WorkspaceMemoryWriteTimeoutError';
    this.filePath = filePath;
    this.timeoutMs = timeoutMs;
  }
}

export type WriteContextFileScope = 'workspace' | 'global';
export type WriteContextFileMode = 'append' | 'replace';

export interface WriteContextFileOptions {
  scope: WriteContextFileScope;
  mode: WriteContextFileMode;
  /**
   * Content to write. For `append`, this is added under the
   * `MEMORY_SECTION_HEADER` block. For `replace`, this becomes the
   * file's full contents.
   */
  content: string;
  /**
   * Absolute path to the workspace root (used when `scope === 'workspace'`).
   * Ignored for `global` writes.
   */
  projectRoot: string;
}

export interface WriteContextFileResult {
  filePath: string;
  /**
   * Bytes actually written by this call. `0` on the no-op short-
   * circuit path (`changed: false`). NOT a measurement of the file's
   * on-disk size — callers that need that should `fs.stat` the
   * returned `filePath` directly.
   */
  bytesWritten: number;
  /**
   * `true` when the call actually mutated the file on disk; `false`
   * when the helper short-circuited because the requested write would
   * have been a no-op (e.g. `mode: 'append'` with whitespace-only
   * content). Callers like the `qwen serve` POST route use this to
   * suppress spurious `memory_changed` events that would otherwise
   * fan out for a write that didn't change anything.
   */
  changed: boolean;
}

/**
 * Append/replace `QWEN.md` for the workspace or the user's global
 * `~/.qwen/` directory. Used by the `qwen serve` daemon's
 * `POST /workspace/memory` route (issue #4175 PR 16) and any other
 * caller that needs to mutate hierarchical memory through code.
 *
 * Append mode preserves any prose already in the file: when a
 * `## Qwen Added Memories` section exists, the new content is
 * appended to the end of the file; when it doesn't, a fresh section
 * header is added before the content. This matches the shape the
 * agent-side `save_memory` tool produces, so files written through
 * the daemon route round-trip cleanly with the existing CLI surface.
 *
 * Replace mode overwrites the whole file with `content` verbatim.
 * Callers should canonicalize/validate `content` before passing.
 *
 * Path safety: `projectRoot` MUST be absolute. Callers are expected
 * to pass a daemon-canonicalized workspace path (the bridge's
 * `boundWorkspace`); this helper does not re-canonicalize.
 */
export async function writeWorkspaceContextFile(
  options: WriteContextFileOptions,
): Promise<WriteContextFileResult> {
  if (!path.isAbsolute(options.projectRoot)) {
    throw new Error(
      `writeWorkspaceContextFile: projectRoot must be absolute, got "${options.projectRoot}"`,
    );
  }
  const filePath = resolveContextFilePath(options.scope, options.projectRoot);

  // Hold the per-file mutex for the entire read-compose-write sequence
  // INCLUDING the whitespace-only no-op detection. Two concurrent
  // POSTs targeting the same file (one whitespace-only, one with real
  // content) would otherwise let the no-op `fs.stat` see a stale size
  // — the no-op's `changed: false` would still be correct but
  // `bytesWritten` could lag the post-write reality. Holding the
  // mutex makes the snapshot consistent. `replace` mode also acquires
  // the lock so a concurrent `replace` + `append` against the same
  // file produces a deterministic last-write rather than a partial
  // composite.
  try {
    return await getFileLock(filePath).runExclusive(
      async () => await runWrite(filePath, options),
    );
  } catch (err) {
    // `withTimeout` rejects with the `E_TIMEOUT` sentinel when the
    // mutex acquire deadline elapses — typically a wedged write on
    // a stalled FS (NFS hiccup, locked OneDrive sync, kernel I/O
    // hang). Translate to a typed error so the route can map to a
    // structured 500 instead of a generic catch-all.
    if (err === E_TIMEOUT) {
      throw new WorkspaceMemoryWriteTimeoutError(
        filePath,
        FILE_LOCK_TIMEOUT_MS,
      );
    }
    throw err;
  }
}

async function runWrite(
  filePath: string,
  options: WriteContextFileOptions,
): Promise<WriteContextFileResult> {
  if (options.mode === 'append' && isWhitespaceOnly(options.content)) {
    // No-op short-circuit. Skip the mkdir + writeFile path entirely
    // so the parent dir mtime isn't bumped on a request that
    // changed nothing — the whitespace-only `\n\n` case from a
    // flaky pipeline must not reach the filesystem at all.
    //
    // `bytesWritten` is `0` (zero bytes were actually written),
    // not the existing file's `stat.size`. Earlier revisions returned
    // `stat.size` here so the response carried "current file size",
    // but that conflated two semantics under one field: clients
    // accumulating writes via `sum(bytesWritten)` got the file size
    // added in for every whitespace POST. `changed: false` already
    // gives clients the no-op signal; the byte count should remain
    // true to its field name.
    return { filePath, bytesWritten: 0, changed: false };
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });

  if (options.mode === 'replace') {
    await fs.writeFile(filePath, options.content, {
      encoding: 'utf8',
      mode: 0o644,
    });
    return {
      filePath,
      bytesWritten: Buffer.byteLength(options.content, 'utf8'),
      changed: true,
    };
  }

  const next = await composeAppendedContent(filePath, options.content);
  await fs.writeFile(filePath, next, { encoding: 'utf8', mode: 0o644 });
  return {
    filePath,
    bytesWritten: Buffer.byteLength(next, 'utf8'),
    changed: true,
  };
}

function resolveContextFilePath(
  scope: WriteContextFileScope,
  projectRoot: string,
): string {
  // Honor `setGeminiMdFilename()` overrides so POST writes to the same
  // file GET surfaces. With the prior `DEFAULT_CONTEXT_FILENAME` hard-
  // code, a deployment that switched the context filename to
  // `AGENTS.md` would have GET listing the new file while POST kept
  // appending to a stale `QWEN.md` — clients then observed "I just
  // wrote content but it's missing from /workspace/memory". Mirrors the
  // discovery path's `getAllGeminiMdFilenames()` usage in
  // `workspace-memory.ts:collectWorkspaceMemoryStatus`.
  const filename = getCurrentGeminiMdFilename();
  if (scope === 'workspace') {
    return path.join(projectRoot, filename);
  }
  return path.join(Storage.getGlobalQwenDir(), filename);
}

/**
 * Cap on the existing-file size we'll read into memory before
 * appending. The POST route caps NEW content at 1 MB but a malicious
 * or accidental client could grow the file to arbitrary size over
 * time (workspace QWEN.md is operator-controlled but the global
 * `~/.qwen/QWEN.md` may have been edited externally). 16 MB sits
 * three orders of magnitude above any realistic user-authored
 * memory file while still bounding the daemon's transient memory
 * cost per append. Hitting this cap means QWEN.md has grown past
 * any reasonable size and the operator should clean it up — we
 * 500 the route with a structured error rather than try to
 * stream-process a corrupted file.
 */
const MAX_EXISTING_FILE_BYTES = 16 * 1024 * 1024;

export class WorkspaceMemoryFileTooLargeError extends Error {
  readonly filePath: string;
  readonly bytes: number;
  readonly limit: number;
  constructor(filePath: string, bytes: number, limit: number) {
    super(
      `Existing memory file at ${filePath} is ${bytes} bytes, exceeds ` +
        `the ${limit}-byte cap for safe append. Trim the file or use ` +
        `mode=replace to overwrite it.`,
    );
    this.name = 'WorkspaceMemoryFileTooLargeError';
    this.filePath = filePath;
    this.bytes = bytes;
    this.limit = limit;
  }
}

async function composeAppendedContent(
  filePath: string,
  newContent: string,
): Promise<string> {
  let existing = '';
  try {
    // `stat` first so we can refuse pathological files BEFORE pulling
    // them into memory. Without this check a 200 MB QWEN.md would
    // load fully into the daemon's heap on every append, even though
    // the route's 1 MB new-content cap caught the request body.
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_EXISTING_FILE_BYTES) {
      throw new WorkspaceMemoryFileTooLargeError(
        filePath,
        stat.size,
        MAX_EXISTING_FILE_BYTES,
      );
    }
    existing = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (err instanceof WorkspaceMemoryFileTooLargeError) throw err;
    if (!isEnoent(err)) throw err;
  }

  const trimmed = trimNewlines(newContent);
  if (trimmed.length === 0) return existing;

  if (existing.length === 0) {
    return `${MEMORY_SECTION_HEADER}\n${trimmed}\n`;
  }

  const sectionIdx = existing.indexOf(MEMORY_SECTION_HEADER);
  if (sectionIdx === -1) {
    const sep = existing.endsWith('\n') ? '' : '\n';
    return `${existing}${sep}\n${MEMORY_SECTION_HEADER}\n${trimmed}\n`;
  }

  // Section header found. Append the new entry INSIDE the section, not
  // necessarily at the end of the file. Without this guard, a file
  // whose `## Qwen Added Memories` block is followed by another
  // `## ...` heading would land each new entry past the next heading
  // — silently moving entries into the wrong section.
  //
  // The naive `indexOf('\n## ')` scan, however, can match `## ` lines
  // INSIDE fenced code blocks (` ``` `) — common in user-authored
  // QWEN.md memory entries that quote API documentation containing
  // markdown headings. Track fence state while scanning and only
  // accept matches outside fences. If no real heading is found
  // (memory section is the last block), keep the previous behavior
  // of appending to EOF.
  const afterHeaderIdx = sectionIdx + MEMORY_SECTION_HEADER.length;
  const nextHeaderRel = findNextTopLevelHeading(existing, afterHeaderIdx);
  if (nextHeaderRel === -1) {
    const sep = existing.endsWith('\n') ? '' : '\n';
    return `${existing}${sep}${trimmed}\n`;
  }
  const insertAt = afterHeaderIdx + nextHeaderRel;
  const before = existing.slice(0, insertAt);
  const after = existing.slice(insertAt);
  const sep = before.endsWith('\n') ? '' : '\n';
  return `${before}${sep}${trimmed}\n${after}`;
}

/**
 * Find the byte offset of the next `\n## ` heading in `text` starting
 * at position `start`, skipping any matches that fall inside a fenced
 * code block (lines opening with ``` ``` `` `). Returns the offset
 * RELATIVE TO `start` (so callers can do `start + result`), or `-1`
 * when no real heading is found.
 *
 * The fence detector is line-based: a line whose first three
 * characters are ``` ``` `` ` toggles fence state. Doesn't model
 * indented code blocks (4+ leading spaces) — `## ` inside an
 * indented code block is rare enough not to justify the parser
 * complexity, and a misclassification only causes us to fall back
 * to EOF-append, which is the legacy behavior.
 */
function findNextTopLevelHeading(text: string, start: number): number {
  let inFence = false;
  let lineStart = start;
  for (let i = start; i < text.length; i++) {
    if (text.charCodeAt(i) !== 0x0a /* \n */) continue;
    const nextLineStart = i + 1;
    // Toggle fence state if the JUST-FINISHED line opens/closes a
    // fence. Strict prefix check — leading whitespace is intentional
    // because a 4-space-indented "```" is markdown code-block content,
    // not a fence marker. CommonMark allows both ` ``` ` and `~~~` as
    // fence delimiters; both must toggle the inside-fence state so a
    // `## heading` inside a `~~~` block isn't treated as a section
    // boundary.
    if (
      text.startsWith('```', lineStart) ||
      text.startsWith('~~~', lineStart)
    ) {
      inFence = !inFence;
    }
    // Heading match runs against the boundary `\n## ` (the four chars
    // starting at the newline we just observed). Skip when in fence.
    if (!inFence && text.startsWith('## ', nextLineStart)) {
      return i - start; // relative offset of the `\n` separator
    }
    lineStart = nextLineStart;
  }
  return -1;
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'ENOENT'
  );
}

/**
 * Hand-rolled `^\s+|\s+$` substitute. CodeQL's polynomial-regex
 * detector flags `\s+` with anchors as a ReDoS risk on
 * attacker-controlled input; the linear loop sidesteps the rule
 * without changing behavior. Mirrors the same pattern used by
 * `auth.ts:120-125` for header-credential parsing.
 */
function isWhitespaceOnly(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // ASCII space, tab, line feed, carriage return, form feed,
    // vertical tab. All non-printable whitespace control chars the
    // route's "no-op append" check should treat as empty content.
    if (
      c !== 0x20 &&
      c !== 0x09 &&
      c !== 0x0a &&
      c !== 0x0d &&
      c !== 0x0c &&
      c !== 0x0b
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Hand-rolled `^\n+|\n+$` substitute. Same CodeQL rationale as
 * `isWhitespaceOnly`. Trims only `\n` so the section-header insert
 * path keeps its newline framing semantics — a leading `\t` in
 * `newContent` is preserved as part of the user's bullet, while
 * `\n\n- entry\n` collapses to `- entry`.
 */
function trimNewlines(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) === 0x0a) start++;
  while (end > start && s.charCodeAt(end - 1) === 0x0a) end--;
  return start === 0 && end === s.length ? s : s.slice(start, end);
}

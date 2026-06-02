/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * postCompactAttachments — pure builders for the message blocks injected
 * AFTER the summary in a compacted history. Replaces qwen-code's tail-
 * preservation model (split-point + last 30%) with claude-code's
 * "summary + restored attachments" model.
 *
 * Everything in this module is message-history-driven: no separate state
 * caches, no new message types. Extractors walk `Content[]`, builders
 * produce ordinary user/model `Content` objects with text/inlineData parts.
 */

import type { Content, Part } from '@google/genai';
import { readFile, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { resolve as resolvePath, sep as pathSep } from 'node:path';
import { CHARS_PER_TOKEN } from './tokenEstimation.js';
import { getFunctionResponseParts } from './compactionInputSlimming.js';

export const POST_COMPACT_MAX_FILES_TO_RESTORE = 5;

/**
 * Find the longest run of consecutive backticks in `s`. Used to choose
 * a CommonMark-safe fence: a fence one backtick longer than any run
 * inside the fenced content cannot be closed prematurely.
 */
function longestBacktickRun(s: string): number {
  let longest = 0;
  let current = 0;
  for (const ch of s) {
    if (ch === '`') {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

/**
 * Strip control characters from a path before rendering it into an
 * attachment's markdown text. The path itself stays usable for tool
 * calls (we just don't print the dangerous characters). A path with a
 * literal newline could otherwise inject markdown structure into the
 * model's view of the attachment.
 */
function sanitizePathForDisplay(path: string): string {
  return path.replace(/[\r\n\t]/g, '');
}
export const POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000;
export const POST_COMPACT_TOKEN_BUDGET = 50_000;
export const POST_COMPACT_MAX_IMAGES_TO_RESTORE = 3;

/** Tool names that signal "this turn touched a file at args.file_path". */
const FILE_TOUCHING_TOOLS = new Set<string>([
  'read_file',
  'write_file',
  'edit',
  'replace', // legacy alias for 'edit' — may appear in old sessions (see ToolNamesMigration)
]);

/**
 * Collect the ids of tool calls whose `functionResponse` reported an error
 * (`response.error` present) — denied, cancelled, or otherwise failed. A
 * successful call carries `response.output` and no `error`, so it is not
 * collected. Used to keep denied/failed file reads out of restoration.
 */
function collectFailedCallIds(history: Content[]): Set<string> {
  const failed = new Set<string>();
  for (const content of history) {
    for (const part of content.parts ?? []) {
      const fr = part.functionResponse as
        | { id?: string; response?: Record<string, unknown> }
        | undefined;
      if (fr?.id && fr.response && 'error' in fr.response) {
        failed.add(fr.id);
      }
    }
  }
  return failed;
}

/**
 * Walk the history newest-first, collect the most recently touched file
 * paths, deduplicated. Older mentions of the same path are dropped in
 * favor of the most recent one.
 */
export function extractRecentFilePaths(
  history: Content[],
  maxFiles: number,
): string[] {
  if (maxFiles <= 0) return [];

  // A denied / errored tool call still leaves its `functionCall` in history,
  // paired with an error `functionResponse` (`response.error`). Restoring
  // such a path would read the file straight off disk during compaction —
  // bypassing the very permission the call was denied. Collect those failed
  // call ids so we can skip them: never re-read a file the agent didn't
  // successfully read.
  const failedCallIds = collectFailedCallIds(history);

  const seen = new Set<string>();
  for (let i = history.length - 1; i >= 0; i--) {
    const content = history[i];
    if (content.role !== 'model') continue;
    // Iterate parts in REVERSE within a single content so parallel tool
    // calls (multiple functionCall parts in one model turn) are treated
    // as "the last call is the most recent". Forward iteration here would
    // pick the FIRST 5 of a 6-parallel batch, dropping the actually-most-
    // recent call — discovered via real-session E2E.
    const parts = content.parts ?? [];
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j];
      const call = part.functionCall;
      if (!call || !FILE_TOUCHING_TOOLS.has(call.name ?? '')) continue;
      // Skip paths whose tool call failed (denied / errored).
      if (call.id && failedCallIds.has(call.id)) continue;
      const args = call.args as { file_path?: unknown } | undefined;
      const filePath =
        typeof args?.file_path === 'string' ? args.file_path : undefined;
      if (!filePath || seen.has(filePath)) continue;
      seen.add(filePath);
      if (seen.size >= maxFiles) return [...seen];
    }
  }
  return [...seen];
}

export interface ExtractedImage {
  /** The original `inlineData` part, ready to embed verbatim. */
  part: Part;
  /** Turn index in the original history (for metadata header). */
  turnIndex: number;
  /** Name of the tool whose call immediately preceded this image, if any. */
  sourceToolName?: string;
  /** Args of that tool call, for the metadata header. */
  sourceToolArgs?: Record<string, unknown>;
}

/**
 * Walk a single content's parts in REVERSE and return every image part
 * it carries — both top-level `inlineData` (user-pasted images) and
 * images nested inside `functionResponse.parts` (qwen-code's tool-media
 * carrier; see coreToolScheduler.convertToFunctionResponse). Reverse
 * order means the last-emitted image is treated as the most recent.
 *
 * Walking only the top-level shape — as this module originally did —
 * silently drops every tool-returned screenshot, because
 * `convertToFunctionResponse` ALWAYS nests tool media under
 * `functionResponse.parts` and never at the top level. That made the
 * whole screenshot-restoration feature a no-op for real computer-use
 * sessions while the unit tests (which fabricated a top-level shape)
 * stayed green.
 */
function imagePartsInContentReverse(content: Content): Part[] {
  const result: Part[] = [];
  const parts = content.parts ?? [];
  for (let j = parts.length - 1; j >= 0; j--) {
    const part = parts[j];
    if (part.inlineData?.mimeType?.startsWith('image/')) {
      result.push(part);
      continue;
    }
    const nested = getFunctionResponseParts(part);
    if (nested) {
      for (let k = nested.length - 1; k >= 0; k--) {
        const inner = nested[k];
        if (inner.inlineData?.mimeType?.startsWith('image/')) {
          result.push(inner);
        }
      }
    }
  }
  return result;
}

/**
 * Walk the history newest-first, collect up to `maxImages` image parts
 * (top-level user-pasted images AND tool-returned images nested in
 * `functionResponse.parts`), and pair each with the preceding
 * model+functionCall (if any) as source-tool metadata.
 *
 * Returns oldest-first so callers can compose a chronological strip
 * (last user-visible state ends up at the bottom of the attachment).
 */
export function extractRecentImages(
  history: Content[],
  maxImages: number,
): ExtractedImage[] {
  if (maxImages <= 0) return [];

  const collected: ExtractedImage[] = [];

  outer: for (let i = history.length - 1; i >= 0; i--) {
    const content = history[i];
    const imageParts = imagePartsInContentReverse(content);
    if (imageParts.length === 0) continue;

    // Attribute via the most recent model+functionCall sitting at i-1
    // (the typical (model+fc, user+fr) pair shape). Shared across every
    // image in this turn — for parallel tool calls this attributes all
    // images to the first call, an accepted simplification.
    let sourceToolName: string | undefined;
    let sourceToolArgs: Record<string, unknown> | undefined;
    const prev = history[i - 1];
    if (prev?.role === 'model') {
      const fc = prev.parts?.find((p) => p.functionCall)?.functionCall;
      if (fc) {
        sourceToolName = fc.name ?? undefined;
        sourceToolArgs =
          (fc.args as Record<string, unknown> | undefined) ?? undefined;
      }
    }

    for (const part of imageParts) {
      collected.unshift({ part, turnIndex: i, sourceToolName, sourceToolArgs });
      if (collected.length >= maxImages) break outer;
    }
  }

  return collected;
}

/**
 * Count images RETURNED BY TOOLS across the whole history — inlineData
 * image parts nested inside `functionResponse.parts`. User-pasted
 * top-level images are intentionally excluded: this drives the
 * computer-use screenshot-overflow auto-compact trigger, whose concern
 * is screenshot accumulation from tool results, not occasional pastes.
 */
export function countToolResponseImages(history: Content[]): number {
  let count = 0;
  for (const content of history) {
    for (const part of content.parts ?? []) {
      const nested = getFunctionResponseParts(part);
      if (!nested) continue;
      for (const inner of nested) {
        if (inner.inlineData?.mimeType?.startsWith('image/')) count++;
      }
    }
  }
  return count;
}

export type FileEmbedResult =
  | { kind: 'embed'; content: string }
  | { kind: 'reference' }
  | { kind: 'missing' }
  | { kind: 'binary' };

const BINARY_DETECT_SAMPLE = 512;
const BINARY_NONPRINTABLE_THRESHOLD = 0.3;

/**
 * Read a file from disk and decide whether to embed its full content
 * (small files, ≤ maxTokens × CHARS_PER_TOKEN) or only return a path
 * reference (large files; the agent must call read_file to view them).
 *
 * Returns 'missing' if the file no longer exists (deleted between when
 * it was last touched and compaction time), 'binary' if it appears to
 * contain non-text data.
 */
export async function readFileSizeAdaptive(
  filePath: string,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<FileEmbedResult> {
  // Honor abort BEFORE issuing the I/O so a cancelled compaction does not
  // even start the read (per Finding 5).
  if (signal?.aborted) return { kind: 'missing' };

  const maxChars = maxTokens * CHARS_PER_TOKEN;
  // Byte-size pre-check: avoid loading a multi-GB file into a Buffer just to
  // discover it's too large — that would exhaust the V8 heap mid-compaction,
  // exactly when we're trying to REDUCE memory. UTF-8 is at most 4 bytes per
  // char, so any file whose byte size exceeds maxChars*4 cannot fit within
  // maxChars chars; short-circuit it to a reference without reading it.
  try {
    const { size } = await stat(filePath);
    if (size > maxChars * 4) return { kind: 'reference' };
  } catch {
    // ENOENT / permission / etc. — treat as missing, same as the read path.
    return { kind: 'missing' };
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(filePath, { signal });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'missing' };
    }
    if ((err as { name?: string }).name === 'AbortError') {
      return { kind: 'missing' };
    }
    // Permission errors, IO errors, etc. — treat as missing for the
    // purpose of compaction. The agent can still retry via read_file
    // and get a real error there if it's load-bearing.
    return { kind: 'missing' };
  }

  // Binary detection on first BINARY_DETECT_SAMPLE bytes. Counts
  // bytes outside printable ASCII + common whitespace as suspicious.
  const sample = buffer.subarray(
    0,
    Math.min(buffer.length, BINARY_DETECT_SAMPLE),
  );
  let nonPrintable = 0;
  for (const byte of sample) {
    const printable =
      (byte >= 0x20 && byte <= 0x7e) || // ASCII printable
      byte === 0x09 || // tab
      byte === 0x0a || // LF
      byte === 0x0d || // CR
      byte >= 0x80; // utf-8 continuation bytes — treat as printable
    if (!printable) nonPrintable++;
  }
  if (
    sample.length > 0 &&
    nonPrintable / sample.length > BINARY_NONPRINTABLE_THRESHOLD
  ) {
    return { kind: 'binary' };
  }

  // Decode once and compare against the cap by character length, not
  // byte length. A 3-byte UTF-8 character (e.g. Chinese) would otherwise
  // be triple-counted against the budget. The decoded value is reused
  // for the embed branch so this costs nothing extra.
  const decoded = buffer.toString('utf-8');
  if (decoded.length > maxChars) {
    return { kind: 'reference' };
  }

  return { kind: 'embed', content: decoded };
}

/**
 * Compose the file-restoration section of a post-compact history. Reads
 * each file from disk, classifies as embed/reference/missing/binary, and
 * produces:
 *  - One reference block listing all large files (path only), if any.
 *  - One embed block per small file with full content.
 *  - Nothing for missing/binary files.
 *
 * Total embedded chars are capped at POST_COMPACT_TOKEN_BUDGET ×
 * CHARS_PER_TOKEN. Files that would push over the budget are downgraded
 * to references.
 */
export async function buildFileRestorationBlocks(
  filePaths: string[],
  signal?: AbortSignal,
): Promise<Content[]> {
  const references: string[] = [];
  const embeds: Array<{ path: string; content: string }> = [];

  let usedChars = 0;
  const budgetChars = POST_COMPACT_TOKEN_BUDGET * CHARS_PER_TOKEN;

  for (const filePath of filePaths) {
    if (signal?.aborted) break;
    const result = await readFileSizeAdaptive(
      filePath,
      POST_COMPACT_MAX_TOKENS_PER_FILE,
      signal,
    );
    if (result.kind === 'missing' || result.kind === 'binary') continue;
    if (result.kind === 'reference') {
      references.push(filePath);
      continue;
    }
    // embed — check global budget; downgrade to reference if over.
    if (usedChars + result.content.length > budgetChars) {
      references.push(filePath);
      continue;
    }
    embeds.push({ path: filePath, content: result.content });
    usedChars += result.content.length;
  }

  const blocks: Content[] = [];

  if (references.length > 0) {
    const lines = [
      'The following files were recently accessed before context was compacted. They are listed as reference only because they are large. Use `read_file` to view current content for any file you need:',
      '',
      ...references.map((p) => `- ${sanitizePathForDisplay(p)}`),
    ];
    blocks.push({
      role: 'user',
      parts: [{ text: lines.join('\n') }],
    });
  }

  for (const { path, content } of embeds) {
    // CommonMark-safe fence: use a backtick run that is one longer than
    // the longest run already in the content. Markdown/CLAUDE.md/README
    // files frequently contain ``` themselves; a fixed 3-backtick fence
    // closes prematurely and leaks the remainder as unfenced text.
    const fence = '`'.repeat(longestBacktickRun(content) + 1);
    const safeFence = fence.length >= 3 ? fence : '```';
    blocks.push({
      role: 'user',
      parts: [
        {
          text:
            `Recently accessed file (full current content embedded):\n\n` +
            `## ${sanitizePathForDisplay(path)}\n\n` +
            safeFence +
            '\n' +
            content +
            '\n' +
            safeFence,
        },
      ],
    });
  }

  return blocks;
}

/**
 * Compose the image-restoration block: a single user Content whose first
 * part is a text header listing each image's source (turn index + tool
 * call + args), followed by the inlineData parts in chronological order.
 *
 * Returns null if there are no images so callers can skip it cleanly.
 */
export function buildImageRestorationBlock(
  images: ExtractedImage[],
): Content | null {
  if (images.length === 0) return null;

  const lines = [
    'Recent visual snapshots preserved from before context was compacted (most recent last). Each image corresponds to a tool result or user-pasted image earlier in the conversation:',
    '',
  ];
  for (const img of images) {
    if (img.sourceToolName) {
      const argsStr = JSON.stringify(img.sourceToolArgs ?? {});
      lines.push(
        `- turn ${img.turnIndex}: ${img.sourceToolName} args=${argsStr}`,
      );
    } else {
      lines.push(`- turn ${img.turnIndex}: user-provided image`);
    }
  }

  return {
    role: 'user',
    parts: [{ text: lines.join('\n') }, ...images.map((img) => img.part)],
  };
}

/**
 * Assemble the complete post-compact history from the pre-compact
 * `history` and the summary text the side-query model produced.
 *
 * Output ordering:
 *   1. Summary as a user message (the side-query output)
 *   2. Synthetic model ack ("Got it. Thanks for the additional context.")
 *   3. File reference block (path-only list of large files), if any
 *   4. Per-embedded-file user message with full content
 *   5. Image restoration block, if any
 *
 * The ack message keeps role alternation correct: the next API call will
 * naturally append the model's continuation response.
 */
/**
 * Trailer appended to the post-compact summary message. Mirrors claude-code's
 * "Resume directly" guidance for the resuming agent: it must NOT acknowledge
 * the summary, re-greet, or recap — it picks up from where the prior turn
 * left off based on the summary.
 *
 * Lives in the wrapper (not in the compression system prompt) so the summary
 * model does not have to re-generate this text every compaction (saves
 * output tokens, prevents wording drift).
 */
const RESUME_TRAILER =
  'Resume the prior task using the summary above. Continue from the last in-flight step; do not acknowledge the summary, do not re-introduce, do not greet the user again.';

/**
 * Strip the model's drafting scratchpad before the summary becomes the new
 * post-compact context. The compression prompt instructs the summary model
 * to wrap its chain-of-thought reasoning in an `<analysis>...</analysis>`
 * block, which is purely for the model's own benefit; keeping it in history
 * wastes tokens and degrades signal-to-noise for the resuming agent.
 *
 * Defensive design: if the strip removes everything (model produced ONLY an
 * analysis block with no summary content), fall back to the raw summary so
 * the caller sees something rather than an empty string — the inflation
 * guard upstream will still NOOP this round, but we don't want to silently
 * lose the entire model response.
 */
/**
 * Strip `<analysis>...</analysis>` chain-of-thought blocks from raw
 * summary text. Exposed separately from `postProcessSummary` so the
 * PostCompact hook event can receive the same stripped text that
 * enters history — without the resume trailer, which is wrapper
 * decoration meant for the next agent turn only (Finding 8a).
 *
 * NOTE on the regex:
 *  - `[\s\S]*?` (non-greedy) handles newlines inside the block AND
 *    stops at the first `</analysis>` — so multiple non-overlapping
 *    blocks each get stripped via the `/g` flag.
 *  - It matches the exact tag `<analysis>` only. If the prompt ever
 *    evolves to use attributes (e.g. `<analysis type="...">`) or
 *    nested `<analysis>` tags, this pattern will leak content. The
 *    compression prompt is under our control, so we keep the pattern
 *    strict rather than over-engineering.
 *  - The unclosed-tag fallback (`<analysis>[\s\S]*$`) catches the case
 *    where the model started an `<analysis>` block and ran out of
 *    output tokens before closing it. Without this, the closed-tag
 *    regex above misses and the entire scratchpad leaks into history
 *    via the fallback path in `postProcessSummary`.
 */
export function stripAnalysisBlock(rawSummary: string): string {
  // First pass: strip well-formed `<analysis>...</analysis>` blocks
  // (handles multiple via `/g`, newlines via `[\s\S]`).
  let result = rawSummary.replace(/<analysis>[\s\S]*?<\/analysis>\s*/g, '');
  // Second pass: strip any remaining unclosed `<analysis>` tag (the
  // model ran out of output tokens before closing). Uses an
  // end-of-string anchor since there's no closing tag to stop at.
  result = result.replace(/<analysis>[\s\S]*$/g, '');
  return result.trim();
}

export function postProcessSummary(rawSummary: string): string {
  const stripped = stripAnalysisBlock(rawSummary);
  // Defensive sentinel only. Callers gate on `isSummaryEmpty`, which now
  // checks the STRIPPED summary — so a response that strips to nothing is
  // treated as an empty summary upstream (COMPRESSION_FAILED_EMPTY_SUMMARY)
  // and never reaches here. The inflation guard does NOT catch this case
  // (a tiny `[Summary unavailable]` is smaller than the original, so the
  // guard wouldn't fire) — the upstream emptiness check is what prevents it.
  const body = stripped.length > 0 ? stripped : '[Summary unavailable]';
  return `${body}\n\n${RESUME_TRAILER}`;
}

/**
 * Minimal projection of a background subagent task carried into post-compact
 * attachments. Decoupled from the registry's `AgentTask` so the attachment
 * layer does not import the registry types and so tests can build cases
 * inline.
 */
export interface SubagentSnapshot {
  id: string;
  description: string;
  status: 'running' | 'paused';
  /** ms epoch when the task was registered. Used for stable ordering. */
  startTime: number;
}

export interface ComposePostCompactOptions {
  /**
   * Workspace root. When set, file paths from history that resolve
   * outside this root are silently skipped (Finding 4). Without this,
   * an adversarial model that issued `read_file('/etc/passwd')` —
   * even one denied by the permission system — would have its path
   * extracted and re-read off disk into the next prompt.
   */
  workspaceRoot?: string;
  /**
   * Cancels in-progress file reads (Finding 5). Propagated to
   * `buildFileRestorationBlocks` → `readFileSizeAdaptive` →
   * `readFile(path, { signal })`.
   */
  signal?: AbortSignal;
  /**
   * Max recent files to restore. Defaults to
   * `POST_COMPACT_MAX_FILES_TO_RESTORE`. Configurable via
   * `chatCompression.maxRecentFilesToRetain` (env
   * `QWEN_COMPACT_MAX_RECENT_FILES`).
   */
  maxFiles?: number;
  /**
   * Max recent images to restore. Defaults to
   * `POST_COMPACT_MAX_IMAGES_TO_RESTORE`. Configurable via
   * `chatCompression.maxRecentImagesToRetain` (env
   * `QWEN_COMPACT_MAX_RECENT_IMAGES`).
   */
  maxImages?: number;
  /**
   * When `true`, prepend a `<plan-mode-active>` reminder block before the
   * file/image attachments so the post-compact agent does not forget that
   * destructive tools remain gated. Sourced from `config.getApprovalMode()
   * === ApprovalMode.PLAN` at the call site. The summary itself may
   * mention plan mode but cannot be trusted to — the reminder is a
   * structural guarantee.
   */
  planModeActive?: boolean;
  /**
   * Snapshot of background subagent tasks (running or paused) at
   * compaction time. Rendered as a `<background-tasks>` reminder block.
   * Empty array or `undefined` renders no block. Terminal-state tasks
   * (completed/failed/cancelled) should already be filtered out by the
   * caller — they have already emitted their notification XML and need
   * no reminder.
   */
  runningSubagents?: SubagentSnapshot[];
}

/**
 * Trailing `model+functionCall` content from the pre-compact history,
 * to be preserved in the post-compact output so a pending
 * `functionResponse` (sitting in `sendMessageStream`'s
 * `pendingUserMessage` waiting to be pushed) has a matching call
 * (Finding 3). Returns `undefined` if the last history entry is not
 * a model turn with a functionCall part.
 */
function trailingFunctionCallContent(history: Content[]): Content | undefined {
  const last = history[history.length - 1];
  if (!last || last.role !== 'model') return undefined;
  if (!last.parts?.some((p) => !!p.functionCall)) return undefined;
  return last;
}

/**
 * Resolve and validate a file path against an optional workspace
 * root. Returns `true` if the file path lies under `workspaceRoot`
 * (or if no root was supplied — caller chose not to enforce). Used
 * to skip out-of-workspace paths that a model emitted via a denied
 * tool call (Finding 4).
 */
function isInsideWorkspace(filePath: string, workspaceRoot?: string): boolean {
  if (!workspaceRoot) return true;
  // Resolve symlinks (not just lexical normalization) so a symlink that
  // lives INSIDE the workspace but points OUTSIDE — e.g.
  // `workspace/.env -> ~/.ssh/id_rsa` — cannot smuggle a sensitive file
  // past the boundary and into the post-compact history sent to the
  // provider. Mirrors WorkspaceContext.isPathWithinWorkspace's realpath
  // handling.
  const resolvedFile = safeRealpath(filePath);
  const resolvedRoot = safeRealpath(workspaceRoot);
  // Append a trailing separator so a sibling path that shares a prefix
  // (e.g. workspace=/foo/bar, file=/foo/bar2/x.ts) is correctly
  // classified as outside.
  const rootWithSep = resolvedRoot.endsWith(pathSep)
    ? resolvedRoot
    : resolvedRoot + pathSep;
  return resolvedFile === resolvedRoot || resolvedFile.startsWith(rootWithSep);
}

/**
 * realpathSync that falls back to lexical resolution when the path does
 * not exist (realpathSync throws ENOENT). A non-existent path can't leak
 * content anyway — readFileSizeAdaptive returns 'missing' for it — so the
 * lexical fallback only affects the boundary classification, not safety.
 */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolvePath(p);
  }
}

const PLAN_MODE_REMINDER_TEXT =
  '<plan-mode-active>\n' +
  'You are currently in PLAN mode. You may research, read files, and ' +
  'propose plans, but you may not execute modification tools (write_file, ' +
  'edit, shell mutations, etc.) until the user exits plan mode. The summary ' +
  'above may not reflect this constraint — honor plan mode regardless.\n' +
  '</plan-mode-active>';

/** Cap per-task description text in the snapshot block. Prevents a
 *  pathologically long subagent description from inflating the post-compact
 *  history. 200 chars keeps the snapshot useful as a pointer without making
 *  it a full progress log. */
const MAX_SUBAGENT_DESC_CHARS = 200;

/** Cap on the number of subagent rows the snapshot lists. Defends against
 *  pathological sessions with hundreds of backgrounded agents that never
 *  completed — without this, a malformed registry could produce a multi-KB
 *  attachment block that consumes the post-compact prompt budget. Newest
 *  agents (highest startTime) are kept; older ones are dropped with a
 *  trailing "and N more" line so the model knows the snapshot is partial. */
const MAX_SUBAGENT_SNAPSHOT_COUNT = 30;

function buildPlanModeReminderPart(): Part {
  return { text: PLAN_MODE_REMINDER_TEXT };
}

/**
 * Escape the three XML-significant characters in subagent descriptions
 * before splicing them inside our `<background-tasks>` wrapper. Without
 * this, a description containing `</background-tasks>` could close the
 * wrapper tag and inject arbitrary structure into the model's view.
 */
function escapeForXmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Collapse interior whitespace (newlines, tabs, carriage returns) to single
 * spaces before the description goes into a single bullet line. A raw `\n`
 * inside `s.description` would otherwise split the bullet across multiple
 * lines, producing "- [running] id: line1\nline2\n- [running] next: …"
 * which the model reads as a malformed list (and could even read `line2`
 * as a sibling row). Mirrors `sanitizePathForDisplay` further up in this
 * file.
 */
function flattenWhitespaceForBullet(text: string): string {
  return text.replace(/[\r\n\t]+/g, ' ');
}

function buildSubagentSnapshotPart(snaps: SubagentSnapshot[]): Part | null {
  if (snaps.length === 0) return null;
  const sorted = [...snaps].sort((a, b) => a.startTime - b.startTime);
  // Keep the NEWEST rows (highest startTime). When over the cap, the model
  // is most likely interacting with recent tasks; older long-runners are
  // surfaced via the trailing summary line so nothing silently disappears.
  const overflow = Math.max(0, sorted.length - MAX_SUBAGENT_SNAPSHOT_COUNT);
  const shown = overflow > 0 ? sorted.slice(overflow) : sorted;
  const lines = shown.map((s) => {
    // Order: flatten whitespace FIRST, then truncate. Otherwise a 200-char
    // slice that lands inside a `\n` keeps the newline in the bullet.
    const flattened = flattenWhitespaceForBullet(s.description);
    const truncated =
      flattened.length > MAX_SUBAGENT_DESC_CHARS
        ? flattened.slice(0, MAX_SUBAGENT_DESC_CHARS) + '…'
        : flattened;
    return `- [${s.status}] ${s.id}: ${escapeForXmlText(truncated)}`;
  });
  if (overflow > 0) {
    lines.push(
      `- (… and ${overflow} older task${overflow === 1 ? '' : 's'} not shown)`,
    );
  }
  return {
    text:
      '<background-tasks>\n' +
      'The following background subagent tasks were active at compaction. ' +
      'The summary above does not include their per-task state. Use ' +
      '`task_stop` / `send_message` to interact; do not assume they ' +
      'completed.\n' +
      lines.join('\n') +
      '\n</background-tasks>',
  };
}

export async function composePostCompactHistory(
  history: Content[],
  summary: string,
  options: ComposePostCompactOptions = {},
): Promise<Content[]> {
  const {
    workspaceRoot,
    signal,
    maxFiles = POST_COMPACT_MAX_FILES_TO_RESTORE,
    maxImages = POST_COMPACT_MAX_IMAGES_TO_RESTORE,
    planModeActive,
    runningSubagents,
  } = options;

  // Workspace-boundary filter on the extracted file paths (Finding 4).
  const filePaths = extractRecentFilePaths(history, maxFiles).filter((p) =>
    isInsideWorkspace(p, workspaceRoot),
  );
  const fileBlocks = await buildFileRestorationBlocks(filePaths, signal);

  const images = extractRecentImages(history, maxImages);
  const imageBlock = buildImageRestorationBlock(images);

  // Merge every file restoration block AND the image block into a
  // single user Content (Finding 2). Pushing them as separate user
  // Contents produces consecutive same-role entries, which
  // geminiChat.test.ts:6289 enforces against and which Gemini
  // providers reject as 400 "consecutive same-role content".
  //
  // Order within the merged user Content:
  //   1. plan-mode reminder (if active)        — most behaviourally critical
  //   2. background subagent snapshot          — informs next-turn dispatch
  //   3. file restoration blocks               — model-readable file contents
  //   4. image restoration block               — recent screenshots
  // Reminder text comes first so a token-conservative model that skims the
  // attachment still sees the plan-mode constraint and task pointers before
  // it gets to file bodies.
  const postAckParts: Part[] = [];
  if (planModeActive) {
    postAckParts.push(buildPlanModeReminderPart());
  }
  if (runningSubagents && runningSubagents.length > 0) {
    const snap = buildSubagentSnapshotPart(runningSubagents);
    if (snap) postAckParts.push(snap);
  }
  for (const block of fileBlocks) {
    for (const part of block.parts ?? []) postAckParts.push(part);
  }
  if (imageBlock) {
    for (const part of imageBlock.parts ?? []) postAckParts.push(part);
  }

  // Preserve trailing model+functionCall so a pending functionResponse
  // has a matching call (Finding 3). Place it AFTER any merged
  // attachments so role alternation holds:
  //  - with attachments:  [user(sum), model(ack), user(attach), model(fc)]
  //  - without:           [user(sum), model(ack + fc)] — fc lands in
  //                       the ack's own model Content to avoid the
  //                       model→model adjacency that would otherwise
  //                       arise from a separate appended entry.
  const trailingFc = trailingFunctionCallContent(history);
  const ackParts: Part[] = [
    { text: 'Got it. Thanks for the additional context!' },
  ];

  const out: Content[] = [
    { role: 'user', parts: [{ text: postProcessSummary(summary) }] },
  ];

  if (postAckParts.length > 0) {
    out.push({ role: 'model', parts: ackParts });
    out.push({ role: 'user', parts: postAckParts });
    if (trailingFc) out.push(trailingFc);
  } else if (trailingFc) {
    // Fold the trailing functionCall into the ack's own Content so we don't
    // produce model→model adjacency. Intentionally keep ONLY the
    // functionCall parts: the trailing turn's text was already captured in
    // the summary, and merging it into the ack would muddy both. (The
    // with-attachments branch above keeps trailingFc as its own model turn,
    // so text survives there — the asymmetry is deliberate, not a bug.)
    const fcParts = (trailingFc.parts ?? []).filter((p) => !!p.functionCall);
    out.push({ role: 'model', parts: [...ackParts, ...fcParts] });
  } else {
    out.push({ role: 'model', parts: ackParts });
  }

  return out;
}

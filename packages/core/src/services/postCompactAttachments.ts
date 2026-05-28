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
import { readFile } from 'node:fs/promises';
import { CHARS_PER_TOKEN } from './tokenEstimation.js';

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
 * Walk the history newest-first, collect the most recently touched file
 * paths, deduplicated. Older mentions of the same path are dropped in
 * favor of the most recent one.
 */
export function extractRecentFilePaths(
  history: Content[],
  maxFiles: number,
): string[] {
  if (maxFiles <= 0) return [];

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
 * Walk the history newest-first, collect up to `maxImages` inlineData
 * parts whose mimeType starts with "image/", and pair each one with the
 * preceding model+functionCall (if any) as source-tool metadata.
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
    // Iterate parts in REVERSE within a single content so when multiple
    // inlineData parts share one content (e.g., one tool result returning
    // several images, or a user paste with several images), "most recent"
    // matches part order — last part wins. Symmetric with the
    // file-extractor fix that was discovered via real-session E2E.
    const parts = content.parts ?? [];
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j];
      if (!part.inlineData?.mimeType?.startsWith('image/')) continue;

      // Look backward for the most recent model+functionCall to attribute
      // this image. Only count a call as the source if it sits at i-1
      // (the typical (model+fc, user+fr) pair shape).
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

      collected.unshift({
        part,
        turnIndex: i,
        sourceToolName,
        sourceToolArgs,
      });
      if (collected.length >= maxImages) break outer;
    }
  }

  return collected;
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
): Promise<FileEmbedResult> {
  let buffer: Buffer;
  try {
    buffer = await readFile(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
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
  const maxChars = maxTokens * CHARS_PER_TOKEN;
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
): Promise<Content[]> {
  const references: string[] = [];
  const embeds: Array<{ path: string; content: string }> = [];

  let usedChars = 0;
  const budgetChars = POST_COMPACT_TOKEN_BUDGET * CHARS_PER_TOKEN;

  for (const filePath of filePaths) {
    const result = await readFileSizeAdaptive(
      filePath,
      POST_COMPACT_MAX_TOKENS_PER_FILE,
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
export async function composePostCompactHistory(
  history: Content[],
  summary: string,
): Promise<Content[]> {
  const filePaths = extractRecentFilePaths(
    history,
    POST_COMPACT_MAX_FILES_TO_RESTORE,
  );
  const fileBlocks = await buildFileRestorationBlocks(filePaths);

  const images = extractRecentImages(
    history,
    POST_COMPACT_MAX_IMAGES_TO_RESTORE,
  );
  const imageBlock = buildImageRestorationBlock(images);

  const out: Content[] = [
    { role: 'user', parts: [{ text: summary }] },
    {
      role: 'model',
      parts: [{ text: 'Got it. Thanks for the additional context!' }],
    },
    ...fileBlocks,
  ];
  if (imageBlock) out.push(imageBlock);

  return out;
}

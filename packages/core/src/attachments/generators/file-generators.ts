/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview File-related attachment generators.
 *
 * Generators:
 *   - processAtMentionedFiles(): Parse @path mentions from user input
 *   - generateFileAttachment(): Decision tree for file→Attachment mapping
 *   - getChangedFiles(): Detect externally-modified files via readFileState LRU
 */

import { FileAttachment } from '../models/file-attachments.js';
import { AlreadyReadFileAttachment } from '../models/file-attachments.js';
import { InvalidImageFileAttachment } from '../models/file-attachments.js';
import { CompactFileReferenceAttachment } from '../models/file-attachments.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { expandTilde } from '../../utils/expandTilde.js';
import { parseAtMentions } from '../at-mentions.js';
import type { Dirent, Stats } from 'node:fs';
import { makeRelative } from '../../utils/paths.js';
import { getDiffContextSnippet } from '../../tools/diff-utils.js';
import {
  IMAGE_EXTENSIONS,
  MaxFileReadTokenExceededError,
  readTextFileWithLimits,
  validateContentTokens,
} from '../../tools/read-file.js';
import { isFileReadDenied } from '../../tools/filesystem-permissions/filesystem.js';
import { pathPermissionContextOf } from '../path-permission.js';
import { runLogger } from '../../utils/runLogger.js';
import {
  ImageResizeError,
  maybeResizeAndDownsampleImageBuffer,
  readImageWithMediaLimits,
} from '../../utils/imageReader.js';
import { extractPDFPages, getPDFPageCount } from '../../utils/pdf.js';
import {
  API_MAX_MEDIA_PER_REQUEST,
  DEFAULT_MAX_LINES_TEXT_FILE,
  MAX_OUTPUT_SIZE,
  MAX_READ_TOKENS,
  PDF_AT_MENTION_INLINE_THRESHOLD,
} from '../../utils/constants.js';
import { mapWithConcurrency } from '../../utils/generators.js';
import {
  FileTooLargeError,
  readFileInRange,
} from '../../utils/readFileInRange.js';
import { BINARY_EXTENSIONS } from '../../utils/ignorePatterns.js';
import type { FileState } from '../../utils/fileStateCache.js';
import type { ModelImageBlock } from '../../provider/modelStreamRequest.js';
import {
  type AttachmentToolUseContext,
  DirectoryAttachment,
  EditedTextFileAttachment,
  EditedImageFileAttachment,
  ImageFileAttachment,
  type Attachment,
  PDFFileAttachment,
  PDFReferenceAttachment,
} from '../types.js';
import { prepareImageBlocks } from '../../hooks/imagePrepare.js';
import {
  CHANGED_FILE_SNIPPET_MAX_BYTES,
  CHANGED_FILES_TOTAL_MAX_BYTES,
  truncateChangedFileSnippet,
} from '../changed-file-limits.js';

/**
 * PDF file extension (case-insensitive).
 */
const PDF_EXTENSION = 'pdf';

/**
 * SVG is text-like even though it appears in the shared media extension list.
 */
const SVG_EXTENSION = 'svg';

/**
 * Maximum number of directory entries to include in a DirectoryAttachment.
 * Entries beyond this limit are truncated with a summary line.
 */
const MAX_DIR_ENTRIES = 1000;

/** Max concurrent fs.lstat calls when building a directory listing. */
const DIR_STAT_CONCURRENCY = 16;

/**
 * Placeholder for permission bits in ls-style output.
 * We intentionally skip reading mode bits to avoid extra syscalls.
 */
const UNKNOWN_PERMISSIONS = '?????????';

/** Month abbreviations for ls-style mtime formatting. */
const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

interface MentionedFile {
  filename: string;
  offset?: number;
  limit?: number;
}

function parseMentionedFiles(
  input: string,
  cwd: string,
  agentNames: ReadonlySet<string> = new Set(),
): MentionedFile[] {
  return parseAtMentions(input).flatMap(({ value: rawValue, quoted }) => {
    const value = quoted
      ? rawValue
      : rawValue.replace(/[.,;:!?)}\]。！？、]+$/u, '');
    // Keep the existing bare @AgentName syntax. Quoting or ./ selects a file.
    if (!quoted && agentNames.has(value)) return [];
    const range = /#L(\d+)(?:-L?(\d+))?$/.exec(value);
    let lineRange: { offset: number; limit: number } | undefined;
    if (range) {
      const offset = Number(range[1]);
      const end = Number(range[2] ?? range[1]);
      if (
        !Number.isSafeInteger(offset) ||
        offset < 1 ||
        !Number.isSafeInteger(end) ||
        end < offset
      )
        return [];
      lineRange = { offset, limit: end - offset + 1 };
    }
    const rawPath = range ? value.slice(0, range.index) : value;
    if (!rawPath) return [];
    const expanded =
      rawPath === '~' || rawPath.startsWith('~/')
        ? expandTilde(rawPath)
        : rawPath;
    return [
      {
        filename: path.resolve(cwd, expanded),
        ...lineRange,
      },
    ];
  });
}

/** Resolve exact paths only. Existence is checked when generating attachments. */
export function parseAtMentionedPaths(input: string, cwd: string): string[] {
  return parseMentionedFiles(input, cwd).map(({ filename }) => filename);
}

/**
 * Generate file attachments for @-mentioned files in user input.
 *
 * Layer 1 generator — runs first, before parallel generators, because
 * @file mentions update readFileState which affects Layer 2 dedup logic.
 */
export async function processAtMentionedFiles(
  input: string,
  ctx: AttachmentToolUseContext,
  agentNames?: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<Attachment[]> {
  const paths = parseMentionedFiles(input, ctx.cwd, agentNames);
  if (paths.length === 0) return [];

  const pathCtx = pathPermissionContextOf(ctx);
  const seen = new Set<string>();
  const results: Attachment[] = [];

  for (const mention of paths) {
    signal?.throwIfAborted();
    const filePath = mention.filename;
    const key = JSON.stringify(mention);
    if (seen.has(key)) continue;
    seen.add(key);

    // Honor user-configured read-deny rules in the attachment预读 channel.
    // Without this guard the channel short-circuits the permission pipeline
    // and any `Read(.env)` deny configured by the user gets silently bypassed.
    if (pathCtx && isFileReadDenied(filePath, pathCtx, ctx.cwd)) {
      runLogger.log(
        `[attachment] Skipped @-mention "${filePath}" — blocked by Read deny rule`,
      );
      continue;
    }

    try {
      const attachment = await generateFileAttachment(
        filePath,
        'at-mention',
        ctx,
        mention.offset !== undefined
          ? { offset: mention.offset, limit: mention.limit }
          : undefined,
      );
      if (attachment) results.push(attachment);
    } catch (error) {
      signal?.throwIfAborted();
      runLogger.warn(
        `[attachment] Failed to read @-mention "${filePath}"`,
        error,
      );
    }
  }

  // Enforce per-request image count limit.
  let imageCount = 0;
  return results.filter((a) => {
    if (a.type === 'image_file') {
      imageCount++;
      return imageCount <= API_MAX_MEDIA_PER_REQUEST;
    }
    return true;
  });
}

/**
 * Write a FileState to both the attachment cache and the session tool cache,
 * so that Edit/Write tools recognise files read via attachment as already-read.
 */
function setFileState(
  ctx: AttachmentToolUseContext,
  filename: string,
  content: string,
  timestamp: number,
  isPartialView = false,
  range?: { offset: number; limit?: number },
): void {
  const state = {
    content,
    timestamp,
    offset: range?.offset,
    limit: range?.limit,
    ...(isPartialView ? { isPartialView: true } : {}),
  };
  ctx.readFileState.set(filename, state);
  ctx.fileReadState.set(filename, state);
}

/**
 * Estimate PDF page count from file size when pdftoppm is unavailable.
 * Heuristic: ~100 KB per page.
 */
function estimatePDFPageCount(fileSize: number): number {
  return Math.ceil(fileSize / (100 * 1024));
}

function hasBinaryExtension(ext: string): boolean {
  if (!ext) return false;
  if (IMAGE_EXTENSIONS.has(ext)) return false;
  if (ext === PDF_EXTENSION || ext === SVG_EXTENSION) return false;
  return BINARY_EXTENSIONS.includes(`.${ext}`);
}

async function tryGetPDFReference(
  filename: string,
  displayPath: string,
  stats: Stats,
): Promise<PDFReferenceAttachment | null> {
  try {
    const pageCount = await getPDFPageCount(filename);
    const effectivePageCount = pageCount ?? estimatePDFPageCount(stats.size);

    if (effectivePageCount > PDF_AT_MENTION_INLINE_THRESHOLD) {
      return new PDFReferenceAttachment({
        type: 'pdf_reference',
        filename,
        pageCount: effectivePageCount,
        fileSize: stats.size,
        displayPath,
      });
    }
  } catch {
    // Fall through to normal PDF reading behavior.
  }

  return null;
}

async function generateInlinePDFAttachment(
  filename: string,
  displayPath: string,
  stats: Stats,
  ctx: AttachmentToolUseContext,
): Promise<PDFFileAttachment | null> {
  const extractResult = await extractPDFPages(filename);
  if (!extractResult.success) return null;

  const outputDir = extractResult.data.file.outputDir;
  try {
    const entries = await fs.readdir(outputDir);
    const imageFiles = entries.filter((f) => f.endsWith('.jpg')).sort();
    const pages = await Promise.all(
      imageFiles.map(async (entry) => {
        const imagePath = path.join(outputDir, entry);
        const imageBuffer = await fs.readFile(imagePath);
        const resized = await maybeResizeAndDownsampleImageBuffer(
          imageBuffer,
          imageBuffer.length,
          'jpeg',
        );
        return {
          base64: resized.buffer.toString('base64'),
          mediaType: `image/${resized.mediaType}`,
        };
      }),
    );
    const pageBlocks: ModelImageBlock[] = pages.map((page) => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        mediaType: page.mediaType,
        data: page.base64,
      },
    }));
    const uploadedPageBlocks = await prepareImageBlocks(pageBlocks, { config: ctx.config });
    const uploadedPages = pages.map((page, index) => {
      const block = uploadedPageBlocks[index];
      if (block?.type === 'image' && block.source.type === 'url') {
        return {
          url: block.source.url,
          mediaType: page.mediaType,
        };
      }
      return page;
    });

    return new PDFFileAttachment({
      type: 'pdf_file',
      filename,
      pageCount: pages.length,
      fileSize: stats.size,
      displayPath,
      pages: uploadedPages,
    });
  } finally {
    // Clean up the temporary directory created by extractPDFPages.
    await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function readTextAttachment(
  filename: string,
  displayPath: string,
  ext: string,
  mtime: number,
  ctx: AttachmentToolUseContext,
  options?: { maxLines?: number; offset?: number },
): Promise<Attachment> {
  const range =
    options?.offset !== undefined
      ? { offset: options.offset, limit: options.maxLines }
      : undefined;
  const { content, mtimeMs } = await readFileInRange(
    filename,
    options?.offset !== undefined ? options.offset - 1 : 0,
    options?.maxLines,
    options?.maxLines ? undefined : MAX_OUTPUT_SIZE,
  );
  await validateContentTokens(content, ext, MAX_READ_TOKENS);

  setFileState(
    ctx,
    filename,
    content,
    Math.floor(mtimeMs) || mtime,
    range !== undefined || options?.maxLines !== undefined,
    range,
  );
  return new FileAttachment({
    type: 'file',
    filename,
    content,
    truncated: !range && options?.maxLines !== undefined ? true : undefined,
    ...range,
    displayPath,
    mtime: Math.floor(mtimeMs) || mtime,
  });
}

/**
 * Decision tree for generating a file attachment from a file path.
 *
 * Priority order:
 *   1. File already in context + mtime unchanged → AlreadyReadFileAttachment
 *   2. @mention file too large + non-PDF → null
 *   3. Large PDF → PDFReferenceAttachment
 *   4. Image file → ImageFileAttachment
 *   5. Compact file too large → CompactFileReferenceAttachment
 *   6. Text/token overflow → first DEFAULT_MAX_LINES_TEXT_FILE lines
 *   7. Read error → null (silently skip)
 *
 * Uses a single stat call (before read) to avoid a TOCTOU race between
 * readFile and stat.
 *
 * @param filename - Absolute file path
 * @param mode - 'at-mention' or 'compact' (affects fallback behavior for large files)
 * @param ctx - Tool use context with readFileState
 */
export async function generateFileAttachment(
  filename: string,
  mode: 'at-mention' | 'compact',
  ctx: AttachmentToolUseContext,
  range?: { offset: number; limit?: number },
): Promise<Attachment | null> {
  // Honor user-configured read-deny rules at the entry of generic file
  // attachment generation. Ensures no attachment subtype bypasses an
  // explicit `Read deny` rule configured by the user.
  const pathCtx = pathPermissionContextOf(ctx);
  if (pathCtx && isFileReadDenied(filename, pathCtx, ctx.cwd)) {
    return null;
  }

  const displayPath = makeRelative(filename, ctx.cwd);
  const ext = path.extname(filename).toLowerCase().slice(1);

  // Single stat call for both staleness check and size/type checks.
  let stats: Stats;
  try {
    stats = await fs.stat(filename);
  } catch {
    return null;
  }

  if (stats.isDirectory()) {
    return generateDirectoryAttachment(filename, displayPath);
  }

  const mtime = Math.floor(stats.mtimeMs);
  const existing = ctx.readFileState.get(filename);
  const toolState = ctx.fileReadState.get(filename);

  // 1. File already in context and unchanged — don't resend.
  if (
    existing &&
    !toolState?.isPartialView &&
    !toolState?.contentNotInModelContext &&
    !existing.contentNotInModelContext &&
    !existing.isPartialView &&
    mtime <= existing.timestamp
  ) {
    return new AlreadyReadFileAttachment({
      type: 'already_read_file',
      filename,
      content: existing.content,
      displayPath,
      mtime: existing.timestamp,
    });
  }

  if (ext === PDF_EXTENSION) {
    if (mode === 'at-mention') {
      const pdfReference = await tryGetPDFReference(
        filename,
        displayPath,
        stats,
      );
      if (pdfReference) return pdfReference;
      return generateInlinePDFAttachment(filename, displayPath, stats, ctx);
    }

    return new PDFReferenceAttachment({
      type: 'pdf_reference',
      filename,
      pageCount:
        (await getPDFPageCount(filename)) ?? estimatePDFPageCount(stats.size),
      fileSize: stats.size,
      displayPath,
    });
  }

  // Image file — read as base64 and send as image block.
  // Only normalize to API/media limits; do not apply text token-budget compression.
  if (IMAGE_EXTENSIONS.has(ext)) {
    try {
      const imageResult = await readImageWithMediaLimits(filename);
      const [uploadedBlock] = await prepareImageBlocks<ModelImageBlock>([{
        type: 'image',
        source: {
          type: 'base64',
          mediaType: imageResult.mediaType,
          data: imageResult.base64,
        },
      }], { config: ctx.config });
      const imageAttachment: ImageFileAttachment = new ImageFileAttachment({
        type: 'image_file',
        filename,
        ...(uploadedBlock.source.type === 'url'
          ? { url: uploadedBlock.source.url }
          : { base64: uploadedBlock.source.data }),
        mediaType: imageResult.mediaType,
        displayPath,
        originalSize: imageResult.originalSize,
        mtime,
        dimensions: imageResult.dimensions,
      });
      // Track in readFileState for change detection (store empty string as sentinel).
      setFileState(ctx, filename, '', mtime);
      return imageAttachment;
    } catch (error) {
      if (error instanceof ImageResizeError) {
        return new InvalidImageFileAttachment({
          type: 'invalid_image_file',
          filename,
          displayPath,
          reason: error.message,
        });
      }
      return null;
    }
  }

  if (hasBinaryExtension(ext)) {
    return null;
  }

  // Gate large text files for @mentions — PDFs and images already returned above
  // via their own size-aware handlers.
  if (mode === 'at-mention' && !range && stats.size > MAX_OUTPUT_SIZE) {
    return null;
  }

  if (mode === 'compact' && stats.size > MAX_OUTPUT_SIZE) {
    return new CompactFileReferenceAttachment({
      type: 'compact_file_reference',
      filename,
      displayPath,
    });
  }

  try {
    return await readTextAttachment(
      filename,
      displayPath,
      ext,
      mtime,
      ctx,
      range ? { offset: range.offset, maxLines: range.limit } : undefined,
    );
  } catch (error) {
    if (range) return null;
    if (
      error instanceof FileTooLargeError ||
      error instanceof MaxFileReadTokenExceededError
    ) {
      if (mode === 'compact') {
        return new CompactFileReferenceAttachment({
          type: 'compact_file_reference',
          filename,
          displayPath,
        });
      }
      try {
        return await readTextAttachment(
          filename,
          displayPath,
          ext,
          mtime,
          ctx,
          {
            maxLines: DEFAULT_MAX_LINES_TEXT_FILE,
          },
        );
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Generate a DirectoryAttachment for a directory @mention.
 *
 * Reads directory entries, formats them as `ls -la`-style output, and
 * truncates at MAX_DIR_ENTRIES. Uses lstat (not stat) so symlink metadata
 * matches the displayed type character.
 */
async function generateDirectoryAttachment(
  dirPath: string,
  displayPath: string,
): Promise<DirectoryAttachment | null> {
  const entries = await fs
    .readdir(dirPath, { withFileTypes: true })
    .catch(() => null);
  if (entries === null) return null;

  // Directories first, then alphabetically within each group.
  entries.sort((a, b) => {
    const aIsDir = a.isDirectory() ? 0 : 1;
    const bIsDir = b.isDirectory() ? 0 : 1;
    if (aIsDir !== bIsDir) return aIsDir - bIsDir;
    return a.name.localeCompare(b.name);
  });

  const truncated = entries.length > MAX_DIR_ENTRIES;
  const visibleEntries = truncated
    ? entries.slice(0, MAX_DIR_ENTRIES)
    : entries;

  // lstat so symlink metadata matches the displayed type character.
  const entryLines = await mapWithConcurrency(
    visibleEntries,
    DIR_STAT_CONCURRENCY,
    async (entry: Dirent): Promise<string> => {
      const entryPath = path.join(dirPath, entry.name);
      const isDir = entry.isDirectory();
      const isLink = entry.isSymbolicLink();
      const suffix = isDir ? '/' : isLink ? '@' : '';
      const typeChar = isDir ? 'd' : isLink ? 'l' : '-';
      const { sizeStr, mtimeStr } = await fs
        .lstat(entryPath)
        .then((st) => ({
          sizeStr: String(st.size),
          mtimeStr: formatLsDate(st.mtimeMs),
        }))
        .catch(() => ({ sizeStr: '?', mtimeStr: '?' })); // broken symlink or race
      return `${typeChar}${UNKNOWN_PERMISSIONS} 1 - - ${sizeStr.padStart(8)} ${mtimeStr} ${entry.name}${suffix}`;
    },
  );

  const lines = [`total ${entries.length}`, ...entryLines];
  if (truncated) {
    lines.push(
      `... (${entries.length - MAX_DIR_ENTRIES} more entries not shown)`,
    );
  }

  return new DirectoryAttachment({
    type: 'directory',
    path: dirPath,
    content: lines.join('\n'),
    displayPath,
  });
}

/** Format a millisecond timestamp as "MMM DD HH:MM" (ls-style local time). */
function formatLsDate(ms: number): string {
  const d = new Date(ms);
  const month = MONTH_NAMES[d.getMonth()] ?? '???';
  const day = String(d.getDate()).padStart(2, ' ');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${month} ${day} ${hh}:${mm}`;
}

/**
 * Detect files that were modified externally after being read into context.
 *
 * Runs all file checks in parallel. Returns EditedTextFileAttachment for
 * changed text files and EditedImageFileAttachment for changed image files.
 *
 * Rules:
 *   - offset or limit !== undefined → skip (paginated reads, no change detection)
 *   - mtime <= fileState.timestamp → skip (unchanged)
 *   - text file with empty diff → skip (touch but no content change)
 *   - text file with diff → EditedTextFileAttachment
 *   - image file → EditedImageFileAttachment (re-read)
 *   - size/token overflow → retain baseline and announce the omitted change
 *   - other read errors → remove stale entry from readFileState
 */
export async function getChangedFiles(
  ctx: AttachmentToolUseContext,
): Promise<Array<EditedTextFileAttachment | EditedImageFileAttachment>> {
  const entries = [...ctx.readFileState.entries()].filter(
    ([, fileState]) =>
      fileState.offset === undefined && fileState.limit === undefined,
  );

  const results = await Promise.all(
    entries.map(([filePath, fileState]) =>
      checkFileForChanges(filePath, fileState, ctx),
    ),
  );

  const attachments = results.filter(
    (r): r is EditedTextFileAttachment | EditedImageFileAttachment =>
      r !== null,
  );
  let remaining = CHANGED_FILES_TOTAL_MAX_BYTES;
  for (const attachment of attachments) {
    if (attachment.type !== 'edited_text_file') continue;
    const clipped = truncateChangedFileSnippet(
      attachment.snippet,
      Math.min(CHANGED_FILE_SNIPPET_MAX_BYTES, remaining),
    );
    if (clipped.truncated) {
      attachment.truncationReason =
        remaining < CHANGED_FILE_SNIPPET_MAX_BYTES ? 'budget' : 'file';
    }
    attachment.snippet = clipped.content;
    remaining -= Buffer.byteLength(clipped.content);
  }
  return attachments;
}

async function checkFileForChanges(
  filePath: string,
  fileState: FileState,
  ctx: AttachmentToolUseContext,
): Promise<EditedTextFileAttachment | EditedImageFileAttachment | null> {
  // Honor user-configured read-deny rules before re-reading changed files.
  // Without this, a deny rule like Read(/.env) is bypassed when .env changes
  // and the change-detection pipeline re-reads it into context.
  const pathCtx = pathPermissionContextOf(ctx);
  if (pathCtx && isFileReadDenied(filePath, pathCtx, ctx.cwd)) {
    return null;
  }

  let stats: { mtimeMs: number };
  try {
    stats = await fs.stat(filePath);
  } catch {
    if (fileState.retainIfMissing) {
      // Some injected entrypoint files, such as auto-memory MEMORY.md, may not
      // exist at startup. Keep watching so their first creation is detected.
      return null;
    }
    ctx.readFileState.delete(filePath);
    return null;
  }

  const newMtime = Math.floor(stats.mtimeMs);
  if (
    newMtime <= fileState.timestamp ||
    newMtime === fileState.changeNoticeMtime
  ) {
    return null;
  }

  const ext = path.extname(filePath).toLowerCase().slice(1);

  if (IMAGE_EXTENSIONS.has(ext)) {
    try {
      const content = await fs.readFile(filePath, 'base64');
      setFileState(ctx, filePath, content, newMtime);
      return new EditedImageFileAttachment({
        type: 'edited_image_file',
        filename: filePath,
        content,
        mtime: newMtime,
      });
    } catch {
      ctx.readFileState.delete(filePath);
      return null;
    }
  } else {
    try {
      const { content: newContent, mtimeMs } = await readTextFileWithLimits(
        filePath,
        ext,
        { wholeFile: true },
      );
      if (newContent === fileState.content) return null;
      const snippet = getDiffContextSnippet(fileState.content, newContent);
      const readMtime = Math.floor(mtimeMs);
      setFileState(ctx, filePath, newContent, readMtime);
      markChangedContentUnseen(ctx, filePath);

      if (snippet.trim().length === 0) return null;

      return new EditedTextFileAttachment({
        type: 'edited_text_file',
        filename: filePath,
        snippet,
        content: newContent,
        mtime: readMtime,
      });
    } catch (error) {
      if (
        error instanceof FileTooLargeError ||
        error instanceof MaxFileReadTokenExceededError
      ) {
        // Keep the last complete diff baseline; a failed read is not a deletion
        // or a new complete view. Notify once for this on-disk version.
        ctx.readFileState.set(filePath, {
          ...fileState,
          changeNoticeMtime: newMtime,
          contentNotInModelContext: true,
        });
        markChangedContentUnseen(ctx, filePath);
        return new EditedTextFileAttachment({
          type: 'edited_text_file',
          filename: filePath,
          snippet: '',
          truncationReason: 'read_limit',
        });
      }
      ctx.readFileState.delete(filePath);
      return null;
    }
  }
}

/** A diff/notice does not deliver a complete Read result to the model. */
function markChangedContentUnseen(
  ctx: AttachmentToolUseContext,
  filePath: string,
): void {
  for (const cache of [ctx.readFileState, ctx.fileReadState]) {
    const baseline = cache.get(filePath);
    if (baseline)
      cache.set(filePath, { ...baseline, contentNotInModelContext: true });
  }
}

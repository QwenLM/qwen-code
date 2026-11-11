/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  trackFileStateResult,
  createFileStateCacheWithSizeLimit,
  type FileStateCache,
} from '../utils/fileStateCache.js';
import {
  runReadFileExecution,
  readFileStage,
  ReadFileTimeoutError,
} from '../utils/readFileExecution.js';
import path from 'node:path';
import fs from 'node:fs';
import {
  resolveReadPartialGate,
} from '../config-service/features/readPartial.js';




import { makeRelative, shortenPath, expandPath } from '../utils/paths.js';
import {
  inferEntrySurface,
  isLocalCliHost,
} from '../utils/entry-surface.js';
import { getSessionCwd } from '../utils/Shell.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolLocation,
  type FileReadResult,
  type ToolResult,
} from './tools.js';
import type { ToolUseContext } from './tool-types.js';
import { readContract } from '../codemode/contracts.js';
import { ToolErrorType } from './tool-error.js';

import type { PartListUnion, PartUnion } from '@google/genai';
import type { Config } from '../config/config.js';



import {
  READ_FILE_TOOL_NAME,
  READ_FILE_DISPLAY_NAME,
  GREP_TOOL_NAME,
} from './tool-names.js';
import { CORE_TOOL_SET } from './definitions/coreTools.js';
import { BINARY_EXTENSIONS } from '../utils/ignorePatterns.js';
import {
  findSimilarFile,
  suggestPathUnderCwd,
  getAlternateScreenshotPath,
  FILE_NOT_FOUND_CWD_NOTE,
} from '../utils/fileSuggestions.js';
import {
  readImageWithMediaLimits,
  maybeResizeAndDownsampleImageBuffer,
} from '../utils/imageReader.js';
import { addLineNumbers } from '../utils/lineNumbers.js';
import {
  readFileInRange,
  FileTooLargeError,
} from '../utils/readFileInRange.js';
import { notTextReadNote } from '../utils/fileWriteUtils.js';
import {
  DEFAULT_MAX_LINES_TEXT_FILE,
  MAX_OUTPUT_SIZE,
  MAX_READ_TOKENS,
  PDF_MAX_PAGES_PER_READ,
  PDF_AT_MENTION_INLINE_THRESHOLD,
} from '../utils/constants.js';
import { isNodeError } from '../utils/errors.js';
import {
  readNotebook,
  cellContentToText,
  cellOutputToText,
  getNotebookImageParts,
} from '../utils/notebook.js';
import { parsePDFPageRange } from '../utils/pdfUtils.js';
import { getPDFPageCount, extractPDFPages } from '../utils/pdf.js';
import {
  activateConditionalSkillsForPath,
  discoverJitContext,
} from './jit-context.js';
import { isAutoMemoryFile } from '../memory/structured-memory-store.js';
import { memoryFreshnessNote } from '../memory/memory-age.js';
import { isVisionSupportedModel } from '../config/models.js';
import { resolvePromptBundleForModel } from '../prompts/bundle-resolver.js';
import { getReadFileDescription } from './definitions/tool-prompts/read-file.js';

function readFileErrorToolUseResult(errorType: ToolErrorType): {
  errorType: ToolErrorType;
} {
  return { errorType };
}

function textReadToolUseResult(
  filePath: string,
  content: string,
  numLines: number,
  startLine: number,
  totalLines: number,
): FileReadResult {
  return {
    type: 'text',
    file: {
      filePath,
      content,
      numLines,
      startLine,
      totalLines,
    },
  };
}

async function getFileMtimeMs(filePath: string): Promise<number | undefined> {
  try {
    const stats = await readFileStage('stat', () => fs.promises.stat(filePath));
    return Math.floor(stats.mtimeMs);
  } catch {
    // Let the normal read path report file access errors.
    return undefined;
  }
}

/**
 * Device files that would hang the process: infinite output or blocking input.
 * Checked by path only (no I/O).
 */
const BLOCKED_DEVICE_PATHS = new Set([
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/full',
  '/dev/stdin',
  '/dev/tty',
  '/dev/console',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/fd/0',
  '/dev/fd/1',
  '/dev/fd/2',
]);

function isBlockedDevicePath(filePath: string): boolean {
  if (BLOCKED_DEVICE_PATHS.has(filePath)) return true;
  if (
    filePath.startsWith('/proc/') &&
    (filePath.endsWith('/fd/0') ||
      filePath.endsWith('/fd/1') ||
      filePath.endsWith('/fd/2'))
  ) {
    return true;
  }
  return false;
}

/** Image extensions handled natively by this tool (and the attachment pipeline). */
export const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

/**
 * Check if a file has a known binary extension (excluding images/PDF/SVG
 * which this tool handles natively).
 */
function hasBinaryExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (!ext) return false;
  if (IMAGE_EXTENSIONS.has(ext.slice(1))) return false;
  if (ext === '.pdf' || ext === '.svg') return false;
  return BINARY_EXTENSIONS.includes(ext);
}

/** Token estimation error. */
export class MaxFileReadTokenExceededError extends Error {
  constructor(
    public tokenCount: number,
    public maxTokens: number,
  ) {
    super(
      `File content (${tokenCount} tokens) exceeds maximum allowed tokens (${maxTokens}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
    );
    this.name = 'MaxFileReadTokenExceededError';
  }
}

/**
 * Rough token count estimation. Characters / 4 is a reasonable heuristic
 * for most text content.
 */
function roughTokenEstimate(content: string): number {
  return Math.ceil(content.length / 4);
}

const READ_TOKEN_TRUNCATION_MARGIN = 0.85;

/**
 * Trim text to complete lines below the token budget. The margin leaves room
 * for line numbers and the PARTIAL-view continuation note added to the result.
 */
function truncateToTokenBudget(
  content: string,
  maxTokens: number,
): { content: string; lineCount: number } | null {
  if (roughTokenEstimate(content) <= maxTokens) return null;

  const maxChars = Math.floor(maxTokens * 4 * READ_TOKEN_TRUNCATION_MARGIN);
  const lines = content.split('\n');
  const selectedLines: string[] = [];
  let selectedChars = 0;

  for (const line of lines) {
    const separatorLength = selectedLines.length === 0 ? 0 : 1;
    if (selectedChars + separatorLength + line.length > maxChars) break;
    selectedLines.push(line);
    selectedChars += separatorLength + line.length;
  }

  return selectedLines.length > 0
    ? {
        content: selectedLines.join('\n'),
        lineCount: selectedLines.length,
      }
    : null;
}

/**
 * Validate that the content doesn't exceed the token budget.
 * Uses a rough heuristic estimate. If the estimate is within a safe margin
 * (<=25% of max), it's accepted without further checks.
 *
 * @param content - The text content to validate
 * @param ext - File extension (for future per-filetype estimation)
 * @param maxTokens - Maximum allowed token count
 *
 * TODO: integrate per-filetype estimation via roughTokenCountEstimationForFileType
 * TODO: integrate precise token counting via API when available
 */
export async function validateContentTokens(
  content: string,
  _ext: string,
  maxTokens: number,
): Promise<void> {
  const estimate = roughTokenEstimate(content);
  if (estimate <= maxTokens / 4) return;
  if (estimate > maxTokens) {
    throw new MaxFileReadTokenExceededError(estimate, maxTokens);
  }
}

/** Shared bounded text read. Whole-file consumers must never diff a partial page. */
export async function readTextFileWithLimits(
  filePath: string,
  ext: string,
  options: {
    offset?: number;
    limit?: number;
    signal?: AbortSignal;
    wholeFile?: boolean;
    maxTokens?: number;
    allowAutoPartial?: boolean;
  } = {},
) {
  const { signal } = options;
  const maxTokens =
    options.maxTokens !== undefined && Number.isFinite(options.maxTokens) && options.maxTokens > 0
      ? Math.min(options.maxTokens, MAX_READ_TOKENS)
      : MAX_READ_TOKENS;
  const limit = options.wholeFile ? undefined : options.limit;
  const allowAutoPartial =
    options.allowAutoPartial === true && !options.wholeFile;
  const rangeResult = await readFileInRange(
    filePath,
    options.wholeFile ? 0 : Math.max(options.offset ?? 1, 1) - 1,
    options.wholeFile ? undefined : (limit ?? DEFAULT_MAX_LINES_TEXT_FILE),
    limit === undefined ? MAX_OUTPUT_SIZE : undefined,
    signal,
    !options.wholeFile && limit === undefined
      ? { truncateOnByteLimit: true }
      : undefined,
  );
  let { content, lineCount } = rangeResult;
  const { totalBytes, truncatedByBytes } = rangeResult;
  const originalTokens = roughTokenEstimate(content);
  const retainedBytesBeforeTokens = Buffer.byteLength(content);
  if (truncatedByBytes && (!allowAutoPartial || lineCount === 0)) {
    throw new FileTooLargeError(totalBytes, MAX_OUTPUT_SIZE);
  }
  let truncatedByTokens = false;
  try {
    await readFileStage('content_processing', () =>
      validateContentTokens(content, ext, maxTokens),
    );
  } catch (error) {
    if (
      !allowAutoPartial ||
      !(error instanceof MaxFileReadTokenExceededError)
    ) {
      throw error;
    }
    const truncated = truncateToTokenBudget(content, maxTokens);
    if (!truncated) throw error;
    content = truncated.content;
    lineCount = truncated.lineCount;
    truncatedByTokens = true;
  }
  return {
    ...rangeResult,
    content,
    lineCount,
    originalTokens,
    retainedBytesBeforeTokens,
    truncatedByTokens,
    isAutoPartial: Boolean(truncatedByBytes || truncatedByTokens),
  };
}

/**
 * Parameters for the ReadFile tool.
 */
export interface ReadFileToolParams {
  /** The path to the file to read. */
  file_path: string;
  /** The line number to start reading from (1-based, optional). */
  offset?: number;
  /** The maximum number of text lines to read (defaults to 2000). */
  limit?: number;
  /** Page range for PDF files (e.g., "1-5", "3", "10-20"). */
  pages?: string;
}

export class ReadFileToolInvocation extends BaseToolInvocation<
  ReadFileToolParams,
  ToolResult
> {
  private readonly resolvedPath: string;
  private readonly cwd: string;
  private maxReadTokens = MAX_READ_TOKENS;
  private defaultLineLimit: number | undefined = DEFAULT_MAX_LINES_TEXT_FILE;
  protected readonly readFileStage = readFileStage;
  /** A CodeMode host delivers the image itself, so the result must carry base64. */
  protected hostImageRead = false;
  constructor(
    protected readonly config: Config,
    params: ReadFileToolParams,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(params, _toolName, _toolDisplayName);
    this.cwd = getSessionCwd(this.config);
    this.resolvedPath = expandPath(
      this.params.file_path,
      this.cwd,
    );
    // Permission checks and hooks receive this same input object. Pin their
    // target to the path this invocation will actually read.
    this.params.file_path = this.resolvedPath;
  }

  getDescription(): string {
    const relativePath = makeRelative(
      this.resolvedPath,
      this.config.getTargetDir(),
    );
    return shortenPath(relativePath);
  }

  override toolLocations(): ToolLocation[] {
    return [
      {
        path: this.resolvedPath,
        line: this.params.offset,
      },
    ];
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    this.maxReadTokens = MAX_READ_TOKENS;
    this.defaultLineLimit = DEFAULT_MAX_LINES_TEXT_FILE;
    return this.executeBounded(signal);
  }

  override async executeWithContext(ctx: ToolUseContext): Promise<ToolResult> {
    this.defaultLineLimit =
      ctx.fileReadingLimits?.wholeFile === true
        ? undefined
        : DEFAULT_MAX_LINES_TEXT_FILE;
    const maxTokens = ctx.fileReadingLimits?.maxTokens;
    this.maxReadTokens =
      maxTokens !== undefined && Number.isFinite(maxTokens) && maxTokens > 0
        ? Math.min(maxTokens, MAX_READ_TOKENS)
        : MAX_READ_TOKENS;
    this.hostImageRead = ctx.hostImageRead === true;
    const ext = path.extname(this.resolvedPath).toLowerCase().slice(1);
    if (
      ctx.resultConsumption === 'programmatic' &&
      ((IMAGE_EXTENSIONS.has(ext) && !this.hostImageRead) ||
        ext === 'pdf' ||
        ext === 'ipynb')
    ) {
      const message = 'Programmatic Read supports text files only';
      return {
        llmContent: message,
        returnDisplay: message,
        error: { message, type: ToolErrorType.READ_CONTENT_FAILURE },
      };
    }
    return this.executeBounded(
      ctx.signal,
      ctx.modelKey,
      ctx.fileReadState ?? this.config.fileReadState,
      !ctx.agentId && !ctx.internalExecutionOwner,
      (ctx.invocationOrigin ?? 'model') === 'model' &&
        ctx.resultConsumption !== 'programmatic' &&
        ctx.dedupUnchangedReads !== false,
      ctx.modelEntry,
    );
  }

  private async executeBounded(
    signal: AbortSignal,
    modelKey = this.config.getModel?.(),
    fileReadState = this.config.fileReadState,
    mainAgent = false,
    dedupUnchangedReads = false,
    modelEntry?: import('../provider/model/model.js').Model,
  ): Promise<ToolResult> {
    // Partial reads are only auto-truncated for local TUI model-facing reads.
    const allowAutoPartialRead = resolveReadPartialGate(
      mainAgent &&
        inferEntrySurface(this.config) === 'tui' &&
        isLocalCliHost(),
    ).enabled;
    let result: ToolResult;
    try {
      result = await runReadFileExecution(
        signal,
        async (readSignal) => {
          activateConditionalSkillsForPath(this.config, this.resolvedPath);
          // 本次读取先暂存；发现和取消检查结束后才更新会话缓存。
          const pendingState = createFileStateCacheWithSizeLimit(
            1,
            fileReadState.maxSize,
          );
          const result = await this._executeInternal(
            readSignal,
            modelKey,
            pendingState,
            allowAutoPartialRead,
            dedupUnchangedReads ? fileReadState : undefined,
            modelEntry,
          );
          readSignal.throwIfAborted();
          if (result.error) return result;
          await readFileStage('context_discovery', () =>
            discoverJitContext(this.config, this.resolvedPath, readSignal),
          );
          readSignal.throwIfAborted();
          for (const [filePath, state] of pendingState.entries())
            fileReadState.set(filePath, state);
          return trackFileStateResult(result, fileReadState, this.resolvedPath);
        },
        this.config.getSessionId?.(),
      );
    } catch (error) {
      if (!(error instanceof ReadFileTimeoutError)) throw error;
      result = {
        llmContent: error.message,
        returnDisplay: error.message,
        error: {
          message: error.message,
          type: ToolErrorType.READ_CONTENT_FAILURE,
        },
        toolUseResult: readFileErrorToolUseResult(
          ToolErrorType.READ_CONTENT_FAILURE,
        ),
      };
    }
    return result;
  }

  private async _executeInternal(
    signal: AbortSignal,
    modelKey = this.config.getModel?.(),
    fileReadState = this.config.fileReadState,
    allowAutoPartialRead = false,
    previousReadState?: FileStateCache,
    modelEntry?: import('../provider/model/model.js').Model,
  ): Promise<ToolResult> {
    const { offset = 1, limit, pages } = this.params;
    const fullFilePath = this.resolvedPath;

    // --- Dispatch by file type ---
    const ext = path.extname(fullFilePath).toLowerCase().slice(1);

    try {
      // --- Notebook (.ipynb) ---
      if (ext === 'ipynb') {
        try {
          const cells = await readFileStage('read_file', () =>
            readNotebook(fullFilePath),
          );
          const cellsJson = JSON.stringify(cells);

          const cellsJsonBytes = Buffer.byteLength(cellsJson);
          if (cellsJsonBytes > MAX_OUTPUT_SIZE) {
            const msg =
              `Notebook content (${cellsJsonBytes} bytes) exceeds maximum allowed size (${MAX_OUTPUT_SIZE} bytes). ` +
              `Use the available shell tool with jq to read specific portions:\n` +
              `  cat "${this.params.file_path}" | jq '.cells[:20]' # First 20 cells\n` +
              `  cat "${this.params.file_path}" | jq '.cells[100:120]' # Cells 100-120\n` +
              `  cat "${this.params.file_path}" | jq '.cells | length' # Count total cells\n` +
              `  cat "${this.params.file_path}" | jq '.cells[] | select(.cell_type=="code") | .source' # All code sources`;
            return {
              llmContent: msg,
              returnDisplay: 'Notebook too large.',
              error: { message: msg, type: ToolErrorType.FILE_TOO_LARGE },
            };
          }

          await readFileStage('content_processing', () =>
            validateContentTokens(cellsJson, ext, this.maxReadTokens),
          );

          // Update file state cache — notebooks are always read in full,
          // so record offset/limit as undefined regardless of what was requested.
          const stats = await readFileStage('stat', () =>
            fs.promises.stat(fullFilePath),
          );
          fileReadState.set(fullFilePath, {
            content: cellsJson,
            timestamp: Math.floor(stats.mtimeMs),
            offset: undefined,
            limit: undefined,
          });

          // Build output parts: text cells + image parts interleaved
          const parts: PartUnion[] = [];
          for (const cell of cells) {
            // Cell content as text
            const cellText = cellContentToText(cell);
            if (parts.length > 0) {
              const prev = parts[parts.length - 1];
              if (prev && typeof prev === 'object' && 'text' in prev) {
                prev.text += '\n' + cellText;
              } else {
                parts.push({ text: cellText });
              }
            } else {
              parts.push({ text: cellText });
            }

            // Cell outputs: text and images
            if (cell.outputs) {
              for (const output of cell.outputs) {
                const outputText = cellOutputToText(output);
                if (outputText) {
                  const prev = parts[parts.length - 1];
                  if (prev && typeof prev === 'object' && 'text' in prev) {
                    prev.text += outputText;
                  } else {
                    parts.push({ text: outputText });
                  }
                }
              }
              // Append images after text outputs
              const images = getNotebookImageParts(cell);
              for (const img of images) {
                parts.push({
                  inlineData: {
                    data: img.image_data,
                    mimeType: img.media_type,
                  },
                });
              }
            }
          }

          if (offset > 1 || limit !== undefined) {
            parts.unshift({
              text: `Note: offset and limit parameters are not supported for Jupyter notebooks. The entire notebook (${cells.length} cells) has been returned. Use cell IDs shown in the output to reference specific cells.\n\n`,
            });
          }

          const llmContent: PartListUnion =
            parts.length === 1 ? parts[0] : parts;

          return {
            llmContent,
            returnDisplay: `Read notebook (${cells.length} cells)`,
            toolUseResult: {
              type: 'notebook',
              file: {
                filePath: makeRelative(
                  fullFilePath,
                  this.config.getTargetDir(),
                ),
                cells,
              },
            } satisfies FileReadResult,
          };
        } catch (e) {
          if (isNodeError(e) && e.code === 'ENOENT') {
            throw e; // Let outer ENOENT handler provide "Did you mean?" suggestions
          }
          if (e instanceof MaxFileReadTokenExceededError) {
            return {
              llmContent: e.message,
              returnDisplay: 'Notebook too large.',
              error: { message: e.message, type: ToolErrorType.FILE_TOO_LARGE },
            };
          }
          const msg = e instanceof Error ? e.message : String(e);
          return {
            llmContent: msg,
            returnDisplay: msg,
            error: { message: msg, type: ToolErrorType.READ_CONTENT_FAILURE },
          };
        }
      }

      // Image: normalize only for API/media limits, not the text read token budget.
      if (IMAGE_EXTENSIONS.has(ext)) {
        const visionGate = await this.visionGateOrNull(
          'read',
          ext,
          modelKey,
          modelEntry,
        );
        if (visionGate) return visionGate;
        try {
          return await readFileStage('content_processing', () =>
            this.readImageFile(fullFilePath, modelKey, signal),
          );
        } catch (e) {
          if (isNodeError(e) && e.code === 'ENOENT') {
            throw e;
          }
          const msg = e instanceof Error ? e.message : String(e);
          return {
            llmContent: msg,
            returnDisplay: msg,
            error: { message: msg, type: ToolErrorType.READ_CONTENT_FAILURE },
          };
        }
      }

      // PDF: all PDFs go through page extraction (pdftoppm → JPEG images).
      //
      // NOTE: Native PDF reading via application/pdf inlineData is disabled.
      // model API's functionResponse does not reliably handle PDF document
      // blocks — inlineData becomes a detached sibling part and the model only
      // sees "Binary content provided" instead of the actual content.
      // All PDF reads use pdftoppm to convert pages to JPEG images.
      //
      // TODO: Re-enable native PDF path when model API supports PDF in
      // functionResponse. See isPDFSupported() in pdfUtils.ts.
      if (ext === 'pdf') {
        const visionGate = await this.visionGateOrNull(
          'read',
          'pdf',
          modelKey,
          modelEntry,
        );
        if (visionGate) return visionGate;
        try {
          // If pages parameter is provided, extract specific pages as images
          if (pages) {
            const parsedRange = parsePDFPageRange(pages);
            const extractResult = await readFileStage(
              'content_processing',
              () => extractPDFPages(fullFilePath, parsedRange ?? undefined),
            );
            if (!extractResult.success) {
              const msg = extractResult.error.message;
              return {
                llmContent: msg,
                returnDisplay: msg,
                error: {
                  message: msg,
                  type: ToolErrorType.READ_CONTENT_FAILURE,
                },
              };
            }

            // Read extracted JPEG images, resize, and build inline data parts
            const entries = await readFileStage('read_file', () =>
              fs.promises.readdir(extractResult.data.file.outputDir),
            );
            const imageFiles = entries.filter((f) => f.endsWith('.jpg')).sort();
            const imageParts: PartUnion[] = await Promise.all(
              imageFiles.map(async (f) => {
                const imgPath = path.join(extractResult.data.file.outputDir, f);
                const imgBuffer = await readFileStage('read_file', () =>
                  fs.promises.readFile(imgPath),
                );
                const resized = await readFileStage('content_processing', () =>
                  maybeResizeAndDownsampleImageBuffer(
                    imgBuffer,
                    imgBuffer.length,
                    'jpeg',
                  ),
                );
                return {
                  inlineData: {
                    data: resized.buffer.toString('base64'),
                    mimeType: `image/${resized.mediaType}`,
                  },
                };
              }),
            );

            const pdfRelativePath = makeRelative(
              fullFilePath,
              this.config.getTargetDir(),
            );
            const pdfStats = await readFileStage('stat', () =>
              fs.promises.stat(fullFilePath),
            );
            const llmContent: PartListUnion =
              imageParts.length > 0
                ? imageParts
                : `PDF pages ${pages} from ${pdfRelativePath} did not produce page images.`;

            return {
              llmContent,
              returnDisplay: `Read PDF pages ${pages} (${imageFiles.length} pages)`,
              toolUseResult: {
                type: 'parts',
                file: {
                  filePath: pdfRelativePath,
                  originalSize: pdfStats.size,
                  count: imageFiles.length,
                  outputDir: extractResult.data.file.outputDir,
                },
              } satisfies FileReadResult,
            };
          }

          // No pages parameter: check page count threshold
          const pageCount = await readFileStage('content_processing', () =>
            getPDFPageCount(fullFilePath),
          );
          if (
            pageCount !== null &&
            pageCount > PDF_AT_MENTION_INLINE_THRESHOLD
          ) {
            const msg =
              `This PDF has ${pageCount} pages, which is too many to read at once. ` +
              `Use the pages parameter to read specific page ranges (e.g., pages: "1-5"). ` +
              `Maximum ${PDF_MAX_PAGES_PER_READ} pages per request.`;
            return {
              llmContent: msg,
              returnDisplay: 'PDF too large.',
              error: { message: msg, type: ToolErrorType.FILE_TOO_LARGE },
            };
          }

          // Extract all pages as JPEG images via pdftoppm.
          // The original conditional logic is:
          //   shouldExtractPages = !isPDFSupported() || stats.size > <inline size threshold>
          // Currently isPDFSupported() always returns false, so all PDFs
          // go through extraction. When native PDF is re-enabled, restore
          // the conditional logic here.
          const extractResult = await readFileStage('content_processing', () =>
            extractPDFPages(fullFilePath),
          );
          if (extractResult.success) {
            const entries = await readFileStage('read_file', () =>
              fs.promises.readdir(extractResult.data.file.outputDir),
            );
            const imageFiles = entries.filter((f) => f.endsWith('.jpg')).sort();
            const extractedImageParts: PartUnion[] = await Promise.all(
              imageFiles.map(async (f) => {
                const imgPath = path.join(extractResult.data.file.outputDir, f);
                const imgBuffer = await readFileStage('read_file', () =>
                  fs.promises.readFile(imgPath),
                );
                const resized = await readFileStage('content_processing', () =>
                  maybeResizeAndDownsampleImageBuffer(
                    imgBuffer,
                    imgBuffer.length,
                    'jpeg',
                  ),
                );
                return {
                  inlineData: {
                    data: resized.buffer.toString('base64'),
                    mimeType: `image/${resized.mediaType}`,
                  },
                };
              }),
            );
            const pdfStats = await readFileStage('stat', () =>
              fs.promises.stat(fullFilePath),
            );
            const extractRelativePath = makeRelative(
              fullFilePath,
              this.config.getTargetDir(),
            );
            const llmContent: PartListUnion =
              extractedImageParts.length > 0
                ? extractedImageParts
                : `PDF ${extractRelativePath} (${Math.round(pdfStats.size / 1024)}KB) did not produce page images.`;

            return {
              llmContent,
              returnDisplay: `Read PDF as images (${imageFiles.length} pages, ${Math.round(pdfStats.size / 1024)}KB)`,
              toolUseResult: {
                type: 'parts',
                file: {
                  filePath: extractRelativePath,
                  originalSize: pdfStats.size,
                  count: imageFiles.length,
                  outputDir: extractResult.data.file.outputDir,
                },
              } satisfies FileReadResult,
            };
          }

          // Extraction failed (e.g. poppler-utils not installed).
          const msg =
            'Reading full PDFs is not supported with the current configuration. ' +
            `Use the pages parameter to read specific page ranges (e.g., pages: "1-5", maximum ${PDF_MAX_PAGES_PER_READ} pages per request). ` +
            'Page extraction requires poppler-utils: install with `brew install poppler` on macOS or `apt-get install poppler-utils` on Debian/Ubuntu.';
          return {
            llmContent: msg,
            returnDisplay: 'PDF extraction failed.',
            error: { message: msg, type: ToolErrorType.READ_CONTENT_FAILURE },
          };
        } catch (e) {
          if (isNodeError(e) && e.code === 'ENOENT') {
            throw e;
          }
          const msg = e instanceof Error ? e.message : String(e);
          return {
            llmContent: msg,
            returnDisplay: msg,
            error: { message: msg, type: ToolErrorType.READ_CONTENT_FAILURE },
          };
        }
      }

      // --- Text file (and other types via processSingleFileContent) ---
      try {
        return await this.readTextFile(
          fullFilePath,
          offset,
          limit,
          ext,
          signal,
          fileReadState,
          allowAutoPartialRead,
          previousReadState,
        );
      } catch (error) {
        // File size / token limit exceeded
        if (
          error instanceof FileTooLargeError ||
          error instanceof MaxFileReadTokenExceededError
        ) {
          return {
            llmContent: error.message,
            returnDisplay: 'File too large.',
            error: {
              message: error.message,
              type: ToolErrorType.FILE_TOO_LARGE,
            },
          };
        }

        if (isNodeError(error) && error.code === 'ENOENT') {
          throw error;
        }

        const msg = error instanceof Error ? error.message : String(error);
        return {
          llmContent: msg,
          returnDisplay: msg,
          error: { message: msg, type: ToolErrorType.READ_CONTENT_FAILURE },
        };
      }
    } catch (error) {
      signal.throwIfAborted();
      // Handle ENOENT with file suggestions for all file types
      if (isNodeError(error) && error.code === 'ENOENT') {
        // Try alternate macOS screenshot path (thin space vs regular space before AM/PM).
        // Screenshots are always .png, so retry through the image path.
        const altPath = getAlternateScreenshotPath(fullFilePath);
        if (altPath) {
          try {
            if (IMAGE_EXTENSIONS.has(ext)) {
              const visionGate = await this.visionGateOrNull(
                'read',
                ext,
                modelKey,
                modelEntry,
              );
              if (visionGate) return visionGate;
              return await readFileStage('content_processing', () =>
                this.readImageFile(altPath, modelKey, signal),
              );
            } else {
              return await this.readTextFile(
                altPath,
                offset,
                limit,
                ext,
                signal,
                fileReadState,
                allowAutoPartialRead,
              );
            }
          } catch (altError) {
            if (!(isNodeError(altError) && altError.code === 'ENOENT')) {
              throw altError;
            }
            // Alt path also missing — fall through to friendly error
          }
        }

        const similarFile = findSimilarFile(fullFilePath);
        const cwdSuggestion = await readFileStage('path_suggestion', () =>
          suggestPathUnderCwd(fullFilePath, this.cwd),
        );
        let message = `File does not exist. ${FILE_NOT_FOUND_CWD_NOTE} ${this.cwd}.`;
        if (cwdSuggestion) {
          message += ` Did you mean ${cwdSuggestion}?`;
        } else if (similarFile) {
          message += ` Did you mean ${similarFile}?`;
        }
        return {
          llmContent: message,
          returnDisplay: 'File not found.',
          toolUseResult: readFileErrorToolUseResult(
            ToolErrorType.FILE_NOT_FOUND,
          ),
          error: { message, type: ToolErrorType.FILE_NOT_FOUND },
        };
      }

      const msg = error instanceof Error ? error.message : String(error);
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg, type: ToolErrorType.READ_CONTENT_FAILURE },
      };
    }
  }

  /**
   * Returns an informational `ToolResult` (not an error) when the active
   * model lacks the `is_vl` capability, or `null` when the read may proceed.
   * Centralised so both the primary image branch and the screenshot retry
   * path share identical messaging.
   *
   * The result is intentionally NOT marked as a tool error: the agent
   * receives a normal informational reply describing why the image could not
   * be ingested, so it can choose an alternative approach (e.g. ask the user
   * for a description, or suggest switching to a vision-capable model)
   * instead of surfacing a hard failure.
   *
   * @param mode 'read' for FileRead-direct image paths.
   * @param ext The image extension (without leading dot), e.g. 'png'.
   */
  private async visionGateOrNull(
    _mode: 'read',
    ext: string,
    currentModel: string | undefined,
    modelEntry?: import('../provider/model/model.js').Model,
  ): Promise<ToolResult | null> {
    if (
      currentModel === undefined &&
      modelEntry === undefined &&
      !this.hostImageRead
    )
      return null;
    const model =
      modelEntry ??
      (this.hostImageRead || currentModel === undefined
        ? undefined
        : await this.config.getModelProviderManager().getModel(currentModel));
    if (isVisionSupportedModel(model)) return null;
    const msg =
      ext === 'pdf'
        ? `This file is a PDF document. The current model does not support processing PDF page images. ` +
          `You can suggest the user switch to a vision-capable model, or try extracting text content using other tools.`
        : `This file is an image (${ext}). The current model does not support reading image files. ` +
          `You can describe what you need from this image, and the user can switch to a vision-capable model, ` +
          `or you can suggest an alternative approach.`;
    return {
      llmContent: msg,
      returnDisplay: msg,
    };
  }

  /**
   * Read an image file and return a ToolResult with inline image data.
   * @param filePath - The actual path to read from disk
   */
  protected async readImageFile(
    filePath: string,
    _modelKey: string | undefined,
    _signal: AbortSignal,
  ): Promise<ToolResult> {
    const imageResult = await readFileStage('read_file', () =>
      readImageWithMediaLimits(filePath),
    );
    const sizeKB = Math.round(imageResult.originalSize / 1024);
    const imageParts: PartUnion[] = [
      {
        inlineData: {
          data: imageResult.base64,
          mimeType: imageResult.mediaType,
        },
      },
    ];
    return {
      llmContent: imageParts,
      returnDisplay: `Read image (${sizeKB}KB)`,
      toolUseResult: {
        type: 'image',
        file: {
          base64: imageResult.base64,
          type: imageResult.mediaType,
          originalSize: imageResult.originalSize,
          ...(imageResult.dimensions && { dimensions: imageResult.dimensions }),
        },
      } satisfies FileReadResult,
    };
  }

  /**
   * Core text file reading path using readFileInRange.
   */
  private async readTextFile(
    filePath: string,
    offset: number,
    limit: number | undefined,
    ext: string,
    signal?: AbortSignal,
    fileReadState = this.config.fileReadState,
    allowAutoPartialRead = false,
    previousReadState?: FileStateCache,
  ): Promise<ToolResult> {
    const startLine = Math.max(offset, 1);
    const effectiveLimit = limit ?? this.defaultLineLimit;
    const previousRead = previousReadState?.get(filePath);
    if (
      previousRead?.readMtimeMs !== undefined &&
      previousRead.offset === startLine &&
      (previousRead.limit ?? DEFAULT_MAX_LINES_TEXT_FILE) === effectiveLimit &&
      !previousRead.isPartialView &&
      !previousRead.contentNotInModelContext &&
      (await getFileMtimeMs(filePath)) === previousRead.readMtimeMs
    ) {
      signal?.throwIfAborted();
      return {
        llmContent:
          'Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.',
        returnDisplay: 'File unchanged since last Read',
        toolUseResult: {
          type: 'file_unchanged',
          file: { filePath },
        } satisfies FileReadResult,
      };
    }
    const lineOffset = startLine - 1;
    const allowAutoPartial =
      allowAutoPartialRead && startLine === 1 && limit === undefined;

    const {
      content,
      lineCount,
      totalLines,
      mtimeMs,
      truncatedByBytes,
      truncatedByTokens,
      notText,
      isAutoPartial,
    } = await readTextFileWithLimits(filePath, ext, {
      offset: startLine,
      limit,
      wholeFile: this.defaultLineLimit === undefined,
      maxTokens: this.maxReadTokens,
      signal,
      allowAutoPartial,
    });
    const defaultPageTruncated =
      limit === undefined && lineOffset + lineCount < totalLines;
    const isPartialView = isAutoPartial || defaultPageTruncated;

    // Keep a completed default read unbounded in the baseline even after its
    // body is compacted; an implicit page must never look like a full read.
    const fileStateCache = fileReadState;
    fileStateCache.set(filePath, {
      content,
      timestamp: Math.floor(mtimeMs),
      offset: startLine,
      limit: isPartialView ? lineCount : limit,
      ...(previousReadState &&
        !notText && { readMtimeMs: Math.floor(mtimeMs) }),
      ...(isPartialView && { isPartialView: true }),
    });

    // Build output
    let llmContent: PartListUnion;

    if (totalLines <= 1 && content === '') {
      // Empty file
      llmContent =
        '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>';
    } else if (lineCount === 0 && lineOffset >= totalLines) {
      // Offset beyond file end
      llmContent = `<system-reminder>Warning: the file exists but is shorter than the provided offset (${offset}). The file has ${totalLines} lines.</system-reminder>`;
    } else {
      // Normal content: add line numbers
      llmContent = addLineNumbers({
        content,
        startLine,
      });

      if (isAutoPartial) {
        const reason =
          truncatedByBytes && truncatedByTokens
            ? 'file-size and token budgets'
            : truncatedByBytes
              ? 'file-size budget'
              : 'token budget';
        const nextOffset = startLine + lineCount;
        llmContent +=
          `\n\n<system-reminder>PARTIAL view: showing lines ${startLine}-${nextOffset - 1} of ${totalLines} because the default read range exceeded the ${reason}. ` +
          `Call ${READ_FILE_TOOL_NAME} with offset=${nextOffset} limit=${lineCount} for the next page, or ${GREP_TOOL_NAME} to find a specific section. ` +
          `Do NOT answer from this page alone if the answer may be further in the file.</system-reminder>`;
      } else if (defaultPageTruncated) {
        llmContent +=
          `\n\n<system-reminder>Showing lines ${startLine}-${startLine + lineCount - 1} of ${totalLines} using the default ${DEFAULT_MAX_LINES_TEXT_FILE}-line limit. ` +
          `Call ${READ_FILE_TOOL_NAME} with offset=${startLine + lineCount} limit=${lineCount} for the next page, or ${GREP_TOOL_NAME} to find a specific section. ` +
          `Do NOT answer from this page alone if the answer may be further in the file.</system-reminder>`;
      }
    }

    if (notText) {
      llmContent += `\n\n${notTextReadNote(notText)}`;
    }

    // Auto-memory staleness prefix: when reading a memory file >1 day old,
    // prepend a <system-reminder> warning. Memories are point-in-time
    // observations and stale file:line citations get asserted as fact
    // otherwise. Fresh memories (≤1 day) return an empty string here.
    if (
      typeof llmContent === 'string' &&
      this.config.isAutoMemoryEnabled() &&
      isAutoMemoryFile(filePath, this.config)
    ) {
      const prefix = memoryFreshnessNote(mtimeMs);
      if (prefix) {
        llmContent = prefix + llmContent;
      }
    }

    const returnDisplay =
      lineOffset > 0 || lineOffset + lineCount < totalLines
        ? `Read lines ${startLine}-${startLine + lineCount - 1} of ${totalLines}`
        : '';

    return {
      llmContent,
      returnDisplay,
      toolUseResult: textReadToolUseResult(
        makeRelative(filePath, this.config.getTargetDir()),
        content,
        lineCount,
        startLine,
        totalLines,
      ),
    };
  }
}

/**
 * Implementation of the ReadFile tool logic.
 */
export class ReadFileTool extends BaseDeclarativeTool<
  ReadFileToolParams,
  ToolResult
> {
  static readonly Name = READ_FILE_TOOL_NAME;
  override get programmatic() {
    return readContract;
  }

  override get maxResultSizeChars(): number {
    return Infinity;
  }

  constructor(protected readonly config?: Config) {
    super(
      ReadFileTool.Name,
      READ_FILE_DISPLAY_NAME,
      CORE_TOOL_SET.Read.description!,
      Kind.Read,
      CORE_TOOL_SET.Read.parametersJsonSchema,
      true,
      false,
    );
  }

  override getSchema(modelId?: string) {
    return {
      ...CORE_TOOL_SET.Read,
      description: getReadFileDescription(resolvePromptBundleForModel(modelId)),
    };
  }

  protected override validateToolParamValues(
    params: ReadFileToolParams,
  ): string | null {
    const filePath = params.file_path.trim();
    if (filePath === '') {
      return "The 'file_path' parameter must be non-empty.";
    }

    const resolvedPath = expandPath(filePath, getSessionCwd(this.config));

    // Must run before validatePathAccess: a device path that hangs the process
    // would produce a misleading workspace-validation error instead of this one.
    if (isBlockedDevicePath(resolvedPath)) {
      return `Cannot read '${filePath}': this device file would block or produce infinite output.`;
    }

    // Binary extension pre-check (no I/O, string-only)
    if (hasBinaryExtension(resolvedPath)) {
      const ext = path.extname(resolvedPath).toLowerCase();
      return `This tool cannot read binary files. The file appears to be a binary ${ext} file. Please use appropriate tools for binary file analysis.`;
    }

    if (params.offset !== undefined && params.offset < 0) {
      return 'offset must be a non-negative integer';
    }
    if (params.limit !== undefined && params.limit < 1) {
      return 'limit must be a positive integer';
    }

    const pages = params.pages?.trim();

    // pages parameter validation: only applicable to PDF files
    if (pages) {
      const ext = path.extname(resolvedPath).toLowerCase().slice(1);
      if (ext !== 'pdf') {
        return 'The pages parameter is only applicable to PDF files.';
      }
      const parsedRange = parsePDFPageRange(pages);
      if (!parsedRange) {
        return `Invalid pages parameter: "${pages}". Use formats like "5", "1-10", or "3-".`;
      }
      if (
        parsedRange.lastPage !== Infinity &&
        parsedRange.lastPage - parsedRange.firstPage + 1 >
          PDF_MAX_PAGES_PER_READ
      ) {
        return `Page range exceeds maximum of ${PDF_MAX_PAGES_PER_READ} pages per request.`;
      }
    }

    return null;
  }

  protected bindToConfig(config: Config): ReadFileTool {
    return new ReadFileTool(config);
  }

  override build(
    params: ReadFileToolParams,
    context?: ToolUseContext,
  ): ToolInvocation<ReadFileToolParams, ToolResult> {
    if (context?.config) return this.bindToConfig(context.config).build(params);
    return super.build(params, context);
  }

  protected createInvocation(
    params: ReadFileToolParams,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<ReadFileToolParams, ToolResult> {
    if (!this.config) {
      return new ContextReadFileInvocation(
        params,
        this,
        _toolName,
        _toolDisplayName,
      );
    }
    return new ReadFileToolInvocation(
      this.config,
      params,
      _toolName,
      _toolDisplayName,
    );
  }

  override isConcurrencySafe(_input?: ReadFileToolParams): boolean {
    return true;
  }

  // === Permission Pipeline methods ===
}

/** A shared declaration binds its file operations only to the invoking session. */
class ContextReadFileInvocation extends BaseToolInvocation<
  ReadFileToolParams,
  ToolResult
> {
  constructor(
    params: ReadFileToolParams,
    private readonly tool: ReadFileTool,
    name?: string,
    displayName?: string,
  ) {
    super(params, name, displayName);
  }

  getDescription(): string {
    return shortenPath(this.params.file_path);
  }

  override toolLocations(): ToolLocation[] {
    return [{ path: this.params.file_path, line: this.params.offset }];
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    throw new Error('Read requires a tool context with a session config');
  }

  override executeWithContext(ctx: ToolUseContext): Promise<ToolResult> {
    if (!ctx.config) return this.execute(ctx.signal);
    return this.tool.build(this.params, ctx).executeWithContext!(ctx);
  }
}

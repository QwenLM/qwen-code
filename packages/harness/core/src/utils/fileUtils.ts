/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import type { PartUnion } from '@google/genai';
import mime from 'mime/lite';
import type { FileSystemService } from '../services/fileSystemService.js';
import { ToolErrorType } from '../tools/tool-error.js';
import { BINARY_EXTENSIONS } from './ignorePatterns.js';
import { createRequire as createModuleRequire } from 'node:module';
import { runLogger } from './runLogger.js';
import {
  DEFAULT_MAX_LINES_TEXT_FILE,
  MAX_LINE_LENGTH_TEXT_FILE,
  MAX_OUTPUT_SIZE,
} from './constants.js';
import { readFileInRange, FileTooLargeError } from './readFileInRange.js';
import { addLineNumbers } from './lineNumbers.js';

const requireModule = createModuleRequire(import.meta.url);

export async function readWasmBinaryFromDisk(
  specifier: string,
): Promise<Uint8Array> {
  const resolvedPath = requireModule.resolve(specifier);
  const buffer = await fsPromises.readFile(resolvedPath);
  return new Uint8Array(buffer);
}

export async function loadWasmBinary(
  dynamicImport: () => Promise<{ default: Uint8Array }>,
  fallbackSpecifier: string,
): Promise<Uint8Array> {
  try {
    const module = await dynamicImport();
    if (module?.default instanceof Uint8Array) {
      return module.default;
    }
  } catch (error) {
    try {
      return await readWasmBinaryFromDisk(fallbackSpecifier);
    } catch {
      throw error;
    }
  }

  try {
    return await readWasmBinaryFromDisk(fallbackSpecifier);
  } catch (error) {
    throw new Error('WASM binary module did not provide a Uint8Array export', {
      cause: error,
    });
  }
}

// Default values for encoding and separator format
export const DEFAULT_ENCODING: BufferEncoding = 'utf-8';

// --- Unicode BOM detection & decoding helpers --------------------------------

type UnicodeEncoding = 'utf8' | 'utf16le' | 'utf16be' | 'utf32le' | 'utf32be';

interface BOMInfo {
  encoding: UnicodeEncoding;
  bomLength: number;
}

/**
 * Detect a Unicode BOM (Byte Order Mark) if present.
 * Reads up to the first 4 bytes and returns encoding + BOM length, else null.
 */
export function detectBOM(buf: Buffer): BOMInfo | null {
  if (buf.length >= 4) {
    // UTF-32 LE: FF FE 00 00
    if (
      buf[0] === 0xff &&
      buf[1] === 0xfe &&
      buf[2] === 0x00 &&
      buf[3] === 0x00
    ) {
      return { encoding: 'utf32le', bomLength: 4 };
    }
    // UTF-32 BE: 00 00 FE FF
    if (
      buf[0] === 0x00 &&
      buf[1] === 0x00 &&
      buf[2] === 0xfe &&
      buf[3] === 0xff
    ) {
      return { encoding: 'utf32be', bomLength: 4 };
    }
  }
  if (buf.length >= 3) {
    // UTF-8: EF BB BF
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      return { encoding: 'utf8', bomLength: 3 };
    }
  }
  if (buf.length >= 2) {
    // UTF-16 LE: FF FE  (but not UTF-32 LE already matched above)
    if (
      buf[0] === 0xff &&
      buf[1] === 0xfe &&
      (buf.length < 4 || buf[2] !== 0x00 || buf[3] !== 0x00)
    ) {
      return { encoding: 'utf16le', bomLength: 2 };
    }
    // UTF-16 BE: FE FF
    if (buf[0] === 0xfe && buf[1] === 0xff) {
      return { encoding: 'utf16be', bomLength: 2 };
    }
  }
  return null;
}

/**
 * Convert a UTF-16 BE buffer to a JS string by swapping to LE then using Node's decoder.
 * (Node has 'utf16le' but not 'utf16be'.)
 */
function decodeUTF16BE(buf: Buffer): string {
  if (buf.length === 0) return '';
  const swapped = Buffer.from(buf); // swap16 mutates in place, so copy
  swapped.swap16();
  return swapped.toString('utf16le');
}

/**
 * Decode a UTF-32 buffer (LE or BE) into a JS string.
 * Invalid code points are replaced with U+FFFD, partial trailing bytes are ignored.
 */
function decodeUTF32(buf: Buffer, littleEndian: boolean): string {
  if (buf.length < 4) return '';
  const usable = buf.length - (buf.length % 4);
  let out = '';
  for (let i = 0; i < usable; i += 4) {
    const cp = littleEndian
      ? (buf[i] |
          (buf[i + 1] << 8) |
          (buf[i + 2] << 16) |
          (buf[i + 3] << 24)) >>>
        0
      : (buf[i + 3] |
          (buf[i + 2] << 8) |
          (buf[i + 1] << 16) |
          (buf[i] << 24)) >>>
        0;
    // Valid planes: 0x0000..0x10FFFF excluding surrogates
    if (cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) {
      out += String.fromCodePoint(cp);
    } else {
      out += '\uFFFD';
    }
  }
  return out;
}

/**
 * Read a file as text, honoring BOM encodings (UTF‑8/16/32) and stripping the BOM.
 * Falls back to utf8 when no BOM is present.
 */
export async function readFileWithEncoding(filePath: string): Promise<string> {
  // Read the file once; detect BOM and decode from the single buffer.
  const full = await fs.promises.readFile(filePath);
  if (full.length === 0) return '';

  const bom = detectBOM(full);
  if (!bom) {
    // No BOM → treat as UTF‑8
    return full.toString('utf8');
  }

  // Strip BOM and decode per encoding
  const content = full.subarray(bom.bomLength);
  switch (bom.encoding) {
    case 'utf8':
      return content.toString('utf8');
    case 'utf16le':
      return content.toString('utf16le');
    case 'utf16be':
      return decodeUTF16BE(content);
    case 'utf32le':
      return decodeUTF32(content, true);
    case 'utf32be':
      return decodeUTF32(content, false);
    default:
      // Defensive fallback; should be unreachable
      return content.toString('utf8');
  }
}

/**
 * Looks up the specific MIME type for a file path.
 * @param filePath Path to the file.
 * @returns The specific MIME type string (e.g., 'text/python', 'application/javascript') or undefined if not found or ambiguous.
 */
export function getSpecificMimeType(filePath: string): string | undefined {
  const lookedUpMime = mime.getType(filePath);
  return typeof lookedUpMime === 'string' ? lookedUpMime : undefined;
}

/**
 * Checks if a path is within a given root directory.
 * @param pathToCheck The absolute path to check.
 * @param rootDirectory The absolute root directory.
 * @returns True if the path is within the root directory, false otherwise.
 */
export function isWithinRoot(
  pathToCheck: string,
  rootDirectory: string,
): boolean {
  let normalizedPathToCheck = path.resolve(pathToCheck);
  let normalizedRootDirectory = path.resolve(rootDirectory);

  // Windows and macOS filesystems are case-insensitive.
  if (process.platform === 'win32' || process.platform === 'darwin') {
    normalizedPathToCheck = normalizedPathToCheck.toLowerCase();
    normalizedRootDirectory = normalizedRootDirectory.toLowerCase();
  }

  // Ensure the rootDirectory path ends with a separator for correct startsWith comparison,
  // unless it's the root path itself (e.g., '/' or 'C:\').
  const rootWithSeparator =
    normalizedRootDirectory === path.sep ||
    normalizedRootDirectory.endsWith(path.sep)
      ? normalizedRootDirectory
      : normalizedRootDirectory + path.sep;

  return (
    normalizedPathToCheck === normalizedRootDirectory ||
    normalizedPathToCheck.startsWith(rootWithSeparator)
  );
}

/**
 * Safely resolves a path to its real path if it exists, otherwise returns the absolute resolved path.
 */
export function getRealPath(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

/**
 * Checks if a file's content is empty or contains only whitespace.
 * Efficiently checks file size first, and only samples the beginning of the file.
 * Honors Unicode BOM encodings.
 */
export async function isEmpty(filePath: string): Promise<boolean> {
  try {
    const stats = await fsPromises.stat(filePath);
    if (stats.size === 0) return true;

    // Sample up to 1KB to check for non-whitespace content.
    // If a file is larger than 1KB and contains only whitespace,
    // it's an extreme edge case we can afford to read slightly more of if needed,
    // but for most valid plans/files, this is sufficient.
    const fd = await fsPromises.open(filePath, 'r');
    try {
      const { buffer } = await fd.read({
        buffer: Buffer.alloc(Math.min(1024, stats.size)),
        offset: 0,
        length: Math.min(1024, stats.size),
        position: 0,
      });

      const bom = detectBOM(buffer);
      const content = bom
        ? buffer.subarray(bom.bomLength).toString('utf8')
        : buffer.toString('utf8');

      return content.trim().length === 0;
    } finally {
      await fd.close();
    }
  } catch {
    // If file is unreadable, we treat it as empty/invalid for validation purposes
    return true;
  }
}

/**
 * Heuristic: determine if a file is likely binary.
 * Now BOM-aware: if a Unicode BOM is detected, we treat it as text.
 * For non-BOM files, retain the existing null-byte and non-printable ratio checks.
 */
export async function isBinaryFile(filePath: string): Promise<boolean> {
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(filePath, 'r');
    const stats = await fh.stat();
    const fileSize = stats.size;
    if (fileSize === 0) return false; // empty is not binary

    // Sample up to 4KB from the head (previous behavior)
    const sampleSize = Math.min(4096, fileSize);
    const buf = Buffer.alloc(sampleSize);
    const { bytesRead } = await fh.read(buf, 0, sampleSize, 0);
    if (bytesRead === 0) return false;

    // BOM → text (avoid false positives for UTF‑16/32 with nulls)
    const bom = detectBOM(buf.subarray(0, Math.min(4, bytesRead)));
    if (bom) return false;

    let nonPrintableCount = 0;
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true; // strong indicator of binary when no BOM
      if (buf[i] < 9 || (buf[i] > 13 && buf[i] < 32)) {
        nonPrintableCount++;
      }
    }
    // If >30% non-printable characters, consider it binary
    return nonPrintableCount / bytesRead > 0.3;
  } catch (error) {
    runLogger.warn(
      `Failed to check if file is binary: ${filePath}`,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  } finally {
    if (fh) {
      try {
        await fh.close();
      } catch (closeError) {
        runLogger.warn(
          `Failed to close file handle for: ${filePath}`,
          closeError instanceof Error ? closeError.message : String(closeError),
        );
      }
    }
  }
}

/**
 * Detects the type of file based on extension and content.
 * @param filePath Path to the file.
 * @returns Promise that resolves to 'text', 'image', 'pdf', 'audio', 'video', 'binary' or 'svg'.
 */
export async function detectFileType(
  filePath: string,
): Promise<'text' | 'image' | 'pdf' | 'audio' | 'video' | 'binary' | 'svg'> {
  const ext = path.extname(filePath).toLowerCase();

  // The mimetype for various TypeScript extensions (ts, mts, cts, tsx) can be
  // MPEG transport stream (a video format), but we want to assume these are
  // TypeScript files instead.
  if (['.ts', '.mts', '.cts'].includes(ext)) {
    return 'text';
  }

  if (ext === '.svg') {
    return 'svg';
  }

  const lookedUpMimeType = mime.getType(filePath); // Returns null if not found, or the mime type string
  if (lookedUpMimeType) {
    if (lookedUpMimeType.startsWith('image/')) {
      return 'image';
    }
    // Verify audio/video with content check to avoid MIME misidentification (#16888)
    if (
      lookedUpMimeType.startsWith('audio/') ||
      lookedUpMimeType.startsWith('video/')
    ) {
      if (!(await isBinaryFile(filePath))) {
        return 'text';
      }
      return lookedUpMimeType.startsWith('audio/') ? 'audio' : 'video';
    }
    if (lookedUpMimeType === 'application/pdf') {
      return 'pdf';
    }
  }

  // Stricter binary check for common non-text extensions before content check
  // These are often not well-covered by mime-types or might be misidentified.
  if (BINARY_EXTENSIONS.includes(ext)) {
    return 'binary';
  }

  // Fall back to content-based check if mime type wasn't conclusive for image/pdf
  // and it's not a known binary extension.
  if (await isBinaryFile(filePath)) {
    return 'binary';
  }

  return 'text';
}

export interface ProcessedFileReadResult {
  llmContent: PartUnion; // string for text, Part for image/pdf/unreadable binary
  returnDisplay: string;
  error?: string;
  errorType?: ToolErrorType;
  isTruncated?: boolean;
  originalLineCount?: number;
  linesShown?: [number, number]; // [startLine, endLine] 1-based
  /** File modification time in ms (for cache integration). */
  mtimeMs?: number;
}

/**
 * Reads and processes a single file, handling text, images, and PDFs.
 *
 * For the Read tool path, offset/limit semantics apply:
 * - offset: 1-based start line (default: 1)
 * - limit: number of lines to read (default: DEFAULT_MAX_LINES_TEXT_FILE)
 *
 * For backward compatibility (read-many-files, pathReader), omitting both
 * offset and limit reads the first DEFAULT_MAX_LINES_TEXT_FILE lines.
 */
export async function processSingleFileContent(
  filePath: string,
  rootDirectory: string,
  _fileSystemService: FileSystemService,
  offset?: number,
  limit?: number,
): Promise<ProcessedFileReadResult> {
  try {
    if (!fs.existsSync(filePath)) {
      return {
        llmContent:
          'Could not read file because no file was found at the specified path.',
        returnDisplay: 'File not found.',
        error: `File not found: ${filePath}`,
        errorType: ToolErrorType.FILE_NOT_FOUND,
      };
    }
    const stats = await fs.promises.stat(filePath);
    if (stats.isDirectory()) {
      return {
        llmContent: `EISDIR: illegal operation on a directory, read '${filePath}'`,
        returnDisplay: 'Path is a directory.',
        error: `Path is a directory, not a file: ${filePath}`,
        errorType: ToolErrorType.TARGET_IS_DIRECTORY,
      };
    }

    const fileType = await detectFileType(filePath);
    const relativePathForDisplay = path
      .relative(rootDirectory, filePath)
      .replace(/\\/g, '/');

    switch (fileType) {
      case 'binary': {
        const ext = path.extname(filePath).toLowerCase();
        return {
          llmContent: `This tool cannot read binary files. The file appears to be a binary ${ext} file.`,
          returnDisplay: `Skipped binary file: ${relativePathForDisplay}`,
        };
      }
      case 'svg': {
        const SVG_MAX_SIZE_BYTES = 1 * 1024 * 1024;
        if (stats.size > SVG_MAX_SIZE_BYTES) {
          return {
            llmContent: `Cannot display content of SVG file larger than 1MB: ${relativePathForDisplay}`,
            returnDisplay: `Skipped large SVG file (>1MB): ${relativePathForDisplay}`,
          };
        }
        const content = await readFileWithEncoding(filePath);
        return {
          llmContent: content,
          returnDisplay: `Read SVG as text: ${relativePathForDisplay}`,
        };
      }
      case 'text': {
        // Convert offset/limit to 0-based offset + maxLines for readFileInRange
        const lineOffset =
          offset === undefined || offset === 0 ? 0 : offset - 1;
        const maxLines = limit ?? DEFAULT_MAX_LINES_TEXT_FILE;

        // Only apply maxSizeBytes when no explicit range is specified
        const maxSizeBytes =
          offset === undefined && limit === undefined
            ? MAX_OUTPUT_SIZE
            : undefined;

        let result;
        try {
          result = await readFileInRange(
            filePath,
            lineOffset,
            maxLines,
            maxSizeBytes,
          );
        } catch (e) {
          if (e instanceof FileTooLargeError) {
            return {
              llmContent: e.message,
              returnDisplay: e.message,
              error: e.message,
              errorType: ToolErrorType.FILE_TOO_LARGE,
            };
          }
          throw e;
        }

        const { content, lineCount, totalLines, mtimeMs } = result;
        const startLine = offset ?? 1;

        // Handle empty file
        if (totalLines <= 1 && content === '') {
          return {
            llmContent:
              '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>',
            returnDisplay: '',
            originalLineCount: 0,
            mtimeMs,
          };
        }

        // Handle offset beyond file end
        if (lineCount === 0 && lineOffset >= totalLines) {
          return {
            llmContent: `<system-reminder>Warning: the file exists but is shorter than the provided offset (${startLine}). The file has ${totalLines} lines.</system-reminder>`,
            returnDisplay: '',
            originalLineCount: totalLines,
            mtimeMs,
          };
        }

        // Truncate long lines
        let linesWereTruncatedInLength = false;
        const lines = content.split('\n');
        const formattedLines = lines.map((line) => {
          if (line.length > MAX_LINE_LENGTH_TEXT_FILE) {
            linesWereTruncatedInLength = true;
            return (
              line.substring(0, MAX_LINE_LENGTH_TEXT_FILE) + '...(truncated)'
            );
          }
          return line;
        });

        const processedContent = formattedLines.join('\n');

        // Add line numbers
        const numberedContent = addLineNumbers({
          content: processedContent,
          startLine,
        });

        const isTruncated =
          lineOffset > 0 ||
          lineOffset + lineCount < totalLines ||
          linesWereTruncatedInLength;

        // Build display string
        let returnDisplay = '';
        if (lineOffset > 0 || lineOffset + lineCount < totalLines) {
          returnDisplay = `Read lines ${startLine}-${startLine + lineCount - 1} of ${totalLines} from ${relativePathForDisplay}`;
          if (linesWereTruncatedInLength) {
            returnDisplay += ' (some lines were shortened)';
          }
        } else if (linesWereTruncatedInLength) {
          returnDisplay = `Read all ${totalLines} lines from ${relativePathForDisplay} (some lines were shortened)`;
        }

        return {
          llmContent: numberedContent,
          returnDisplay,
          isTruncated,
          originalLineCount: totalLines,
          linesShown: [startLine, startLine + lineCount - 1],
          mtimeMs,
        };
      }
      case 'image':
      case 'pdf':
      case 'audio':
      case 'video': {
        const contentBuffer = await fs.promises.readFile(filePath);
        const base64Data = contentBuffer.toString('base64');
        return {
          llmContent: {
            inlineData: {
              data: base64Data,
              mimeType: mime.getType(filePath) || 'application/octet-stream',
            },
          },
          returnDisplay: `Read ${fileType} file: ${relativePathForDisplay}`,
        };
      }
      default: {
        const exhaustiveCheck: never = fileType;
        return {
          llmContent: `Unhandled file type: ${exhaustiveCheck}`,
          returnDisplay: `Skipped unhandled file type: ${relativePathForDisplay}`,
          error: `Unhandled file type for ${filePath}`,
        };
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const displayPath = path
      .relative(rootDirectory, filePath)
      .replace(/\\/g, '/');
    return {
      llmContent: `Error reading file ${displayPath}: ${errorMessage}`,
      returnDisplay: `Error reading file ${displayPath}: ${errorMessage}`,
      error: `Error reading file ${filePath}: ${errorMessage}`,
      errorType: ToolErrorType.READ_CONTENT_FAILURE,
    };
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsPromises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sanitizes a string for use as a filename part by removing path traversal
 * characters and other non-alphanumeric characters.
 */
export function sanitizeFilenamePart(part: string): string {
  return part.replace(/[^a-zA-Z0-9_-]/g, '_');
}

interface ToolOutputSlices {
  headChars: number;
  tailChars: number;
  head: string;
  tail: string;
  omittedChars: number;
}

function sliceToolOutput(contentStr: string, maxChars: number): ToolOutputSlices {
  const headChars = Math.floor(maxChars * 0.2);
  const tailChars = maxChars - headChars;

  return {
    headChars,
    tailChars,
    head: contentStr.slice(0, headChars),
    tail: contentStr.slice(-tailChars),
    omittedChars: contentStr.length - headChars - tailChars,
  };
}

/**
 * Formats a truncated message for tool output.
 * Shows the first 20% and last 80% of the allowed characters with a marker in between.
 */
export function formatTruncatedToolOutput(
  contentStr: string,
  outputFile: string,
  maxChars: number,
): string {
  if (contentStr.length <= maxChars) return contentStr;

  const { headChars, tailChars, head, tail, omittedChars } = sliceToolOutput(
    contentStr,
    maxChars,
  );

  return `Output too large. Showing first ${headChars.toLocaleString()} and last ${tailChars.toLocaleString()} characters. For full output see: ${outputFile}
${head}

... [${omittedChars.toLocaleString()} characters omitted] ...

${tail}`;
}

/**
 * Formats an oversized tool output whose full content could not be persisted.
 * Keeps the head/tail preview within the character budget and tells the model
 * that the omitted content is not available locally.
 */
export function formatUnpersistedToolOutput(
  contentStr: string,
  maxChars: number,
  reason?: unknown,
): string {
  if (contentStr.length <= maxChars) return contentStr;

  const reasonText =
    reason instanceof Error ? reason.message : reason ? String(reason) : '';
  const reasonSuffix = reasonText
    ? `: ${reasonText.replace(/\s+/g, ' ').trim().slice(0, 200)}`
    : '';

  const size = formatFileSize(Buffer.byteLength(contentStr, 'utf-8'));
  let bodyBudget = maxChars;
  while (bodyBudget > 0) {
    const { headChars, tailChars, head, tail, omittedChars } = sliceToolOutput(
      contentStr,
      bodyBudget,
    );
    const formatted = `Output too large (${size}) and the full output could not be saved locally${reasonSuffix}. Showing first ${headChars.toLocaleString()} and last ${tailChars.toLocaleString()} characters; omitted content cannot be read locally.
${head}

... [${omittedChars.toLocaleString()} characters omitted] ...

${tail}`;
    if (formatted.length <= maxChars) return formatted;
    // Recompute the slices after reserving space for the notice, error and
    // omission marker. A digit-boundary change may require another iteration.
    bodyBudget -= formatted.length - maxChars;
  }
  return '[Output truncated; full output could not be saved locally.]'.slice(
    0,
    maxChars,
  );
}

/**
 * Saves tool output to a temporary file for later retrieval.
 */
export const TOOL_OUTPUTS_DIR = 'tool-outputs';

export async function saveTruncatedToolOutput(
  content: string,
  toolName: string,
  id: string | number, // Accept string (callId) or number (truncationId)
  projectTempDir: string,
  sessionId?: string,
): Promise<{ outputFile: string }> {
  const safeToolName = sanitizeFilenamePart(toolName).toLowerCase();
  const safeId = sanitizeFilenamePart(id.toString()).toLowerCase();
  const fileName = safeId.startsWith(safeToolName)
    ? `${safeId}.txt`
    : `${safeToolName}_${safeId}.txt`;

  let toolOutputDir = path.join(projectTempDir, TOOL_OUTPUTS_DIR);
  if (sessionId) {
    const safeSessionId = sanitizeFilenamePart(sessionId);
    toolOutputDir = path.join(toolOutputDir, `session-${safeSessionId}`);
  }
  const outputFile = path.join(toolOutputDir, fileName);

  await fsPromises.mkdir(toolOutputDir, { recursive: true });
  await fsPromises.writeFile(outputFile, content);

  return { outputFile };
}

/**
 * Default maximum result size in characters for per-tool truncation.
 * Individual tools can declare their own maxResultSizeChars to override.
 */
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000;

/**
 * Maximum preview size in characters when persisting large tool output.
 * The model receives this preview plus a file path to read the full content.
 */
const PREVIEW_SIZE_CHARS = 2000;

const PERSISTED_OUTPUT_TAG = '<persisted-output>';
const PERSISTED_OUTPUT_CLOSING_TAG = '</persisted-output>';

/**
 * Formats a byte count as a human-readable size string (e.g., "245.2 KB").
 */
export function formatFileSize(sizeInBytes: number): string {
  const kb = sizeInBytes / 1024;
  if (kb < 1) {
    return `${sizeInBytes} bytes`;
  }
  if (kb < 1024) {
    return `${kb.toFixed(1).replace(/\.0$/, '')} KB`;
  }
  const mb = kb / 1024;
  if (mb < 1024) {
    return `${mb.toFixed(1).replace(/\.0$/, '')} MB`;
  }
  const gb = mb / 1024;
  return `${gb.toFixed(1).replace(/\.0$/, '')} GB`;
}

/**
 * Generates a preview of content, cutting at a newline boundary when possible.
 */
export function generatePreview(
  content: string,
  maxChars: number = PREVIEW_SIZE_CHARS,
): { preview: string; hasMore: boolean } {
  if (content.length <= maxChars) {
    return { preview: content, hasMore: false };
  }
  const raw = content.slice(0, maxChars);
  // Try to cut at the last newline within the preview window,
  // but only if it's past the 50% mark to avoid too-short previews.
  const lastNewline = raw.lastIndexOf('\n');
  const cutPoint =
    lastNewline > Math.floor(maxChars * 0.5) ? lastNewline : maxChars;
  return { preview: content.slice(0, cutPoint), hasMore: true };
}

/**
 * Builds the persisted output message for oversized tool results.
 * - Wrapped in <persisted-output> tags
 * - Shows human-readable size
 * - 2KB preview cut at newline boundary
 * - File path for read_file access
 */
export function buildPersistedOutputMessage(
  content: string,
  outputFile: string,
): string {
  const { preview, hasMore } = generatePreview(content);
  const sizeBytes = Buffer.byteLength(content, 'utf-8');
  const size = formatFileSize(sizeBytes);
  const previewSize = formatFileSize(PREVIEW_SIZE_CHARS);

  return (
    `${PERSISTED_OUTPUT_TAG}\n` +
    `Output too large (${size}). Full output saved to: ${outputFile}\n\n` +
    `Preview (first ${previewSize}):\n` +
    `${preview}` +
    (hasMore ? '\n...\n' : '\n') +
    PERSISTED_OUTPUT_CLOSING_TAG
  );
}

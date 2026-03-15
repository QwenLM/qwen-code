/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { PartUnion } from '@google/genai';
import mime from 'mime/lite';
import {
  iconvDecode,
  iconvEncodingExists,
  isUtf8CompatibleEncoding,
} from './iconvHelper.js';
import { ToolErrorType } from '../tools/tool-error.js';
import { BINARY_EXTENSIONS } from './ignorePatterns.js';
import type { Config } from '../config/config.js';
import { createDebugLogger } from './debugLogger.js';
import type { InputModalities } from '../core/contentGenerator.js';
import { detectEncodingFromBuffer } from './systemEncoding.js';

const debugLogger = createDebugLogger('FILE_UTILS');

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
 * Check whether a buffer is valid UTF-8 by attempting a strict decode.
 * If any invalid byte sequence is encountered, TextDecoder with `fatal: true` throws.
 */
function isValidUtf8(buffer: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

/**
 * Result of reading a file with encoding detection.
 */
export interface FileReadResult {
  /** Decoded text content of the file (BOM stripped if present). */
  content: string;
  /** Detected encoding name (e.g. 'utf-8', 'gb18030', 'utf-16le'). */
  encoding: string;
  /**
   * Whether the file had a Unicode BOM (UTF-8, UTF-16 LE/BE, or UTF-32 LE/BE).
   * When true, the same BOM should be re-written on save to preserve the file's
   * original byte-order mark.
   */
  bom: boolean;
}

/**
 * Internal helper: decode a buffer given a BOMInfo.
 * Returns the decoded string for each supported BOM encoding.
 */
function decodeBOMBuffer(buf: Buffer, bomInfo: BOMInfo): string {
  const content = buf.subarray(bomInfo.bomLength);
  switch (bomInfo.encoding) {
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
 * Map a BOMInfo encoding to a canonical encoding name string.
 */
function bomEncodingToName(bomEncoding: UnicodeEncoding): string {
  switch (bomEncoding) {
    case 'utf8':
      return 'utf-8';
    case 'utf16le':
      return 'utf-16le';
    case 'utf16be':
      return 'utf-16be';
    case 'utf32le':
      return 'utf-32le';
    case 'utf32be':
      return 'utf-32be';
    default:
      return 'utf-8';
  }
}

/**
 * Read a file as text, honoring BOM encodings (UTF‑8/16/32) and stripping the BOM.
 * For files without BOM, validates UTF-8 first. If invalid UTF-8, uses chardet
 * to detect encoding (e.g. GBK, Big5, Shift_JIS) and iconv-lite to decode.
 * Falls back to utf8 when detection fails.
 *
 * Returns both the decoded content and the detected encoding/BOM information
 * in a single I/O pass, avoiding redundant file reads.
 */
export async function readFileWithEncodingInfo(
  filePath: string,
): Promise<FileReadResult> {
  // Read the file once; detect BOM and decode from the single buffer.
  const full = await fs.promises.readFile(filePath);
  if (full.length === 0) return { content: '', encoding: 'utf-8', bom: false };

  const bomInfo = detectBOM(full);
  if (bomInfo) {
    return {
      content: decodeBOMBuffer(full, bomInfo),
      encoding: bomEncodingToName(bomInfo.encoding),
      // Mark bom: true for all Unicode BOM variants (UTF-8/16/32) so that
      // the BOM is re-written on save and the file's original format is preserved.
      bom: true,
    };
  }

  // No BOM — check if it's valid UTF-8 first (fast path for the common case)
  if (isValidUtf8(full)) {
    return { content: full.toString('utf8'), encoding: 'utf-8', bom: false };
  }

  // Not valid UTF-8 — try chardet-based encoding detection
  const detected = detectEncodingFromBuffer(full);
  if (detected && !isUtf8CompatibleEncoding(detected)) {
    try {
      if (iconvEncodingExists(detected)) {
        return {
          content: iconvDecode(full, detected),
          encoding: detected,
          bom: false,
        };
      }
    } catch (e) {
      debugLogger.warn(
        `Failed to decode file ${filePath} as ${detected}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Final fallback: UTF-8 with replacement characters
  return { content: full.toString('utf8'), encoding: 'utf-8', bom: false };
}

/**
 * Read a file as text, honoring BOM encodings (UTF‑8/16/32) and stripping the BOM.
 * For files without BOM, validates UTF-8 first. If invalid UTF-8, uses chardet
 * to detect encoding (e.g. GBK, Big5, Shift_JIS) and iconv-lite to decode.
 * Falls back to utf8 when detection fails.
 */
export async function readFileWithEncoding(filePath: string): Promise<string> {
  const result = await readFileWithEncodingInfo(filePath);
  return result.content;
}

export async function countFileLines(filePath: string): Promise<number> {
  const result = await readFileWithEncodingInfo(filePath);
  return result.content.split('\n').length;
}

export async function readFileWithLineAndLimit(params: {
  path: string;
  limit: number;
  line?: number;
}): Promise<{
  content: string;
  bom?: boolean;
  encoding?: string;
  originalLineCount: number;
}> {
  const { path: filePath, limit, line } = params;
  const { content, encoding, bom } = await readFileWithEncodingInfo(filePath);
  const lines = content.split('\n');
  const originalLineCount = lines.length;
  const startLine = line || 0;
  // Ensure endLine does not exceed originalLineCount
  const endLine = Math.min(startLine + limit, originalLineCount);
  // Ensure selectedLines doesn't try to slice beyond array bounds if startLine is too high
  const actualStartLine = Math.min(startLine, originalLineCount);
  const selectedLines = lines.slice(actualStartLine, endLine);

  return {
    content: selectedLines.join('\n'),
    bom,
    encoding,
    originalLineCount,
  };
}

/**
 * Detect the encoding of a file by reading a sample from its beginning.
 * Returns the encoding name (e.g. 'utf-8', 'gbk', 'shift_jis').
 * Uses BOM detection first, then UTF-8 validation, then chardet as fallback.
 */
export async function detectFileEncoding(filePath: string): Promise<string> {
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(filePath, 'r');
    const stats = await fh.stat();
    if (stats.size === 0) return 'utf-8';

    // Read a sample (up to 8KB) for detection
    const sampleSize = Math.min(8192, stats.size);
    const buf = Buffer.alloc(sampleSize);
    const { bytesRead } = await fh.read(buf, 0, sampleSize, 0);
    if (bytesRead === 0) return 'utf-8';
    const sample = buf.subarray(0, bytesRead);

    // 1. Check for BOM
    const bom = detectBOM(sample);
    if (bom) {
      switch (bom.encoding) {
        case 'utf8':
          return 'utf-8';
        case 'utf16le':
          return 'utf-16le';
        case 'utf16be':
          return 'utf-16be';
        case 'utf32le':
          return 'utf-32le';
        case 'utf32be':
          return 'utf-32be';
        default:
          return 'utf-8';
      }
    }

    // 2. Validate UTF-8
    if (isValidUtf8(sample)) return 'utf-8';

    // 3. Use chardet for detection
    const detected = detectEncodingFromBuffer(sample);
    if (detected && !isUtf8CompatibleEncoding(detected)) {
      return detected;
    }

    return 'utf-8';
  } catch {
    // If file can't be read, default to UTF-8
    return 'utf-8';
  } finally {
    if (fh) {
      try {
        await fh.close();
      } catch {
        // Ignore close errors
      }
    }
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
  const normalizedPathToCheck = path.resolve(pathToCheck);
  const normalizedRootDirectory = path.resolve(rootDirectory);

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
    debugLogger.warn(
      `Failed to check if file is binary: ${filePath}`,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  } finally {
    if (fh) {
      try {
        await fh.close();
      } catch (closeError) {
        debugLogger.warn(
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
    if (lookedUpMimeType.startsWith('audio/')) {
      return 'audio';
    }
    if (lookedUpMimeType.startsWith('video/')) {
      return 'video';
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
  error?: string; // Optional error message for the LLM if file processing failed
  errorType?: ToolErrorType; // Structured error type
  originalLineCount?: number; // For text files, the total number of lines in the original file
  isTruncated?: boolean; // For text files, indicates if content was truncated
  linesShown?: [number, number]; // For text files [startLine, endLine] (1-based for display)
}

/**
 * For media file types, returns the corresponding modality key.
 * Returns undefined for non-media types (text, binary, svg) which are always supported.
 */
function mediaModalityKey(
  fileType: 'image' | 'pdf' | 'audio' | 'video' | 'text' | 'binary' | 'svg',
): keyof InputModalities | undefined {
  if (
    fileType === 'image' ||
    fileType === 'pdf' ||
    fileType === 'audio' ||
    fileType === 'video'
  ) {
    return fileType;
  }
  return undefined;
}

/**
 * Build the same unsupported-modality message used by the converter,
 * so the LLM sees a consistent hint regardless of where the check fires.
 */
function unsupportedModalityMessage(
  modality: string,
  displayName: string,
): string {
  let hint: string;
  if (modality === 'pdf') {
    hint =
      'This model does not support PDF input directly. The read_file tool cannot extract PDF content either. To extract text from the PDF file, try using skills if applicable, or guide user to install pdf skill by running this slash command:\n/extensions install https://github.com/anthropics/skills:document-skills';
  } else {
    hint = `This model does not support ${modality} input. The read_file tool cannot process this type of file either. To handle this file, try using skills if applicable, or any tools installed at system wide, or let the user know you cannot process this type of file.`;
  }
  return `[Unsupported ${modality} file: "${displayName}". ${hint}]`;
}

/**
 * Reads and processes a single file, handling text, images, and PDFs.
 * @param filePath Absolute path to the file.
 * @param config Config instance for truncation settings.
 * @param offset Optional offset for text files (0-based line number).
 * @param limit Optional limit for text files (number of lines to read).
 * @returns ProcessedFileReadResult object.
 */
export async function processSingleFileContent(
  filePath: string,
  config: Config,
  offset?: number,
  limit?: number,
): Promise<ProcessedFileReadResult> {
  const rootDirectory = config.getTargetDir();
  try {
    if (!fs.existsSync(filePath)) {
      // Sync check is acceptable before async read
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
        llmContent:
          'Could not read file because the provided path is a directory, not a file.',
        returnDisplay: 'Path is a directory.',
        error: `Path is a directory, not a file: ${filePath}`,
        errorType: ToolErrorType.TARGET_IS_DIRECTORY,
      };
    }

    const fileSizeInMB = stats.size / (1024 * 1024);
    // Use 9.9MB instead of 10MB to leave margin for encoding overhead (#1880)
    if (fileSizeInMB > 9.9) {
      return {
        llmContent: 'File size exceeds the 10MB limit.',
        returnDisplay: 'File size exceeds the 10MB limit.',
        error: `File size exceeds the 10MB limit: ${filePath} (${fileSizeInMB.toFixed(2)}MB)`,
        errorType: ToolErrorType.FILE_TOO_LARGE,
      };
    }

    const fileType = await detectFileType(filePath);
    const relativePathForDisplay = path
      .relative(rootDirectory, filePath)
      .replace(/\\/g, '/');

    const displayName = path.basename(filePath);

    // Check modality support for media files using the resolved config
    // (same source of truth the converter uses at API-call time).
    const modality = mediaModalityKey(fileType);
    if (modality) {
      const modalities: InputModalities =
        config.getContentGeneratorConfig()?.modalities ?? {};
      if (!modalities[modality]) {
        const message = unsupportedModalityMessage(modality, displayName);
        debugLogger.warn(
          `Model '${config.getModel()}' does not support ${modality} input. ` +
            `Skipping file: ${relativePathForDisplay}`,
        );
        return {
          llmContent: message,
          returnDisplay: `Skipped ${fileType} file: ${relativePathForDisplay} (model doesn't support ${modality} input)`,
          error: message,
        };
      }
    }

    switch (fileType) {
      case 'binary': {
        return {
          llmContent: `Cannot display content of binary file: ${relativePathForDisplay}`,
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
        // Use BOM-aware reader to avoid leaving a BOM character in content and to support UTF-16/32 transparently
        const { content, _meta } = await config
          .getFileSystemService()
          .readTextFile({
            path: filePath,
            limit: limit ?? config.getTruncateToolOutputLines(),
            line: offset,
          });
        const originalLineCount =
          _meta?.originalLineCount ?? (await countFileLines(filePath));
        const selectedLines = content.split('\n').map((line) => line.trimEnd());
        const startLine = offset || 0;
        const configCharLimit = config.getTruncateToolOutputThreshold();

        // Apply character limit truncation
        let llmContent = '';
        let contentLengthTruncated = false;
        let linesIncluded = 0;

        if (Number.isFinite(configCharLimit)) {
          const formattedLines: string[] = [];
          let currentLength = 0;

          for (const line of selectedLines) {
            const sep = linesIncluded > 0 ? 1 : 0; // newline separator
            linesIncluded++;

            const projectedLength = currentLength + line.length + sep;
            if (projectedLength <= configCharLimit) {
              formattedLines.push(line);
              currentLength = projectedLength;
            } else {
              // Truncate the current line to fit
              const remaining = Math.max(
                configCharLimit - currentLength - sep,
                10,
              );
              formattedLines.push(
                line.substring(0, remaining) + '... [truncated]',
              );
              contentLengthTruncated = true;
              break;
            }
          }

          llmContent = formattedLines.join('\n');
        } else {
          // No character limit, use all selected lines
          llmContent = selectedLines.join('\n');
          linesIncluded = selectedLines.length;
        }

        const actualEndLine = startLine + linesIncluded;
        const contentRangeTruncated =
          startLine > 0 || actualEndLine < originalLineCount;
        const isTruncated = contentRangeTruncated || contentLengthTruncated;

        // By default, return nothing to streamline the common case of a successful read_file.
        let returnDisplay = '';
        if (isTruncated) {
          returnDisplay = `Read lines ${
            startLine + 1
          }-${actualEndLine} of ${originalLineCount} from ${relativePathForDisplay}`;
          if (contentLengthTruncated) {
            returnDisplay += ' (truncated)';
          }
        }

        return {
          llmContent,
          returnDisplay,
          isTruncated,
          originalLineCount,
          linesShown: [startLine + 1, actualEndLine],
        };
      }
      case 'image':
      case 'audio':
      case 'video':
      case 'pdf': {
        const contentBuffer = await fs.promises.readFile(filePath);
        const base64Data = contentBuffer.toString('base64');
        const base64SizeInMB = base64Data.length / (1024 * 1024);
        // Use 9.9MB instead of 10MB to leave margin for small overhead (#1880)
        if (base64SizeInMB > 9.9) {
          return {
            llmContent: `File exceeds the 10MB data URI limit after base64 encoding (${base64SizeInMB.toFixed(2)}MB encoded).`,
            returnDisplay: `File exceeds the 10MB data URI limit after base64 encoding.`,
            error: `File exceeds the 10MB data URI limit after base64 encoding: ${filePath} (${base64SizeInMB.toFixed(2)}MB encoded)`,
            errorType: ToolErrorType.FILE_TOO_LARGE,
          };
        }
        return {
          llmContent: {
            inlineData: {
              data: base64Data,
              mimeType: mime.getType(filePath) || 'application/octet-stream',
              displayName,
            },
          },
          returnDisplay: `Read ${fileType} file: ${relativePathForDisplay}`,
        };
      }
      default: {
        // Should not happen with current detectFileType logic
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
  } catch (_: unknown) {
    return false;
  }
}

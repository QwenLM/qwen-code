/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { withFileWriteFeedback } from './file-write-feedback.js';
import { editContract } from '../codemode/contracts.js';


import {
  FileWriteContentChangedError,
  withFileWriteLock,
  pinFileWriteTarget,
  resolveFileWritePath,
} from '../utils/fileWriteTarget.js';
import { fileReadPermission } from '../permissions/file-read.js';
import {
  isFullFileRead,
  normalizeFileStateContent,
  isSameFileContent,
  isFileContentInContext,
  readBaselineFor,
  type FileState,
  type FileStateCache,
} from '../utils/fileStateCache.js';
import * as fsPromises from 'node:fs/promises';
import fs from 'node:fs';
import * as path from 'node:path';
import * as Diff from 'diff';
import { formatFileSize } from '../utils/fileUtils.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type FileEditResult,
  type ToolInvocation,
  type ToolLocation,
  type ToolResult,
  type ToolResultDisplay,
} from './tools.js';
import { ToolErrorType } from './tool-error.js';
import {
  displayPathForWorkspace,
  shortenPath,
  expandPath,
} from '../utils/paths.js';
import { isNodeError } from '../utils/errors.js';
import type { Config } from '../config/config.js';
import type { ToolUseContext } from './tool-types.js';
import { validateAutoMemoryWriteScope } from '../memory/structured-memory-store.js';
import { resolvePlanModeWritePath } from './plan-mode-memory-write.js';
import { getSessionCwd } from '../utils/Shell.js';

import { DEFAULT_DIFF_OPTIONS, getDiffStat } from './diffOptions.js';
import { getStructuredPatch } from './diff-utils.js';
import {
  type ModifiableDeclarativeTool,
  type ModifyContext,
} from './modifiable-tool.js';

import {
  EDIT_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  EDIT_DISPLAY_NAME,
} from './tool-names.js';
import { runLogger } from '../utils/runLogger.js';
import { CORE_TOOL_SET } from './definitions/coreTools.js';
import { activateConditionalSkillsForPath } from './jit-context.js';
import {
  FileNotTextError,
  notTextWriteRefusal,
  preserveBOM,
  readFileWithMetadata,
  writeTextContent,
  type LineEndingType,
  type NotTextReason,
} from '../utils/fileWriteUtils.js';
import { stripBOM } from '../utils/stripBom.js';
import {
  findSimilarFile,
  suggestPathUnderCwd,
  FILE_NOT_FOUND_CWD_NOTE,
} from '../utils/fileSuggestions.js';
import { resolvePromptBundleForModel } from '../prompts/bundle-resolver.js';
import { getReplaceDescription } from './definitions/tool-prompts/edit.js';

// ────────────────────────────────────────────────────────────────────────────
// File size limit (1 GiB)
// ────────────────────────────────────────────────────────────────────────────

// V8/Bun string length limit is ~2^30 characters (~1 billion). For typical
// ASCII/Latin-1 files, 1 byte on disk = 1 character, so 1 GiB in stat bytes
// ≈ 1 billion characters ≈ the runtime string limit.
const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024; // 1 GiB (stat bytes)

/** Matches a frontmatter `type:` line — used to gate the auto-memory scope
 *  guard so that body-only edits never trigger it. */
const TYPE_LINE_REGEX = /(^|\n)type:\s*\S/;

// ────────────────────────────────────────────────────────────────────────────
// Quote normalization
// ────────────────────────────────────────────────────────────────────────────

const LEFT_SINGLE_CURLY_QUOTE = '\u2018';
const RIGHT_SINGLE_CURLY_QUOTE = '\u2019';
const LEFT_DOUBLE_CURLY_QUOTE = '\u201C';
const RIGHT_DOUBLE_CURLY_QUOTE = '\u201D';

/**
 * Normalizes quotes in a string by converting curly quotes to straight quotes.
 */
function normalizeQuotes(str: string): string {
  return str
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"');
}

/**
 * Finds the actual string in the file content that matches the search string,
 * accounting for quote normalization.
 */
function findActualString(
  fileContent: string,
  searchString: string,
): string | null {
  // First try exact match
  if (fileContent.includes(searchString)) {
    return searchString;
  }

  // Try with normalized quotes
  const normalizedSearch = normalizeQuotes(searchString);
  const normalizedFile = normalizeQuotes(fileContent);

  const searchIndex = normalizedFile.indexOf(normalizedSearch);
  if (searchIndex !== -1) {
    return fileContent.substring(
      searchIndex,
      searchIndex + searchString.length,
    );
  }

  if (/\\u[0-9a-fA-F]{4}/.test(searchString)) {
    const decoded = decodeUnicodeEscapes(searchString);
    if (fileContent.includes(decoded)) return decoded;
  }
  if (/[\u0080-\uffff]/.test(searchString)) {
    const match = new RegExp(unicodeEscapePattern(searchString)).exec(
      fileContent,
    );
    if (match) return match[0];
  }
  return null;
}

/** Only Unicode escape representation changes; never whitespace/semantic matching. */
function decodeUnicodeEscapes(text: string): string {
  return text.replace(/(\\\\)|\\u([0-9a-fA-F]{4})/g, (match, doubled, hex) =>
    doubled ? match : String.fromCharCode(parseInt(hex, 16)),
  );
}
function unicodeEscapePattern(text: string): string {
  return text
    .split('')
    .map((char) =>
      char.charCodeAt(0) >= 128
        ? '\\\\u' +
          char
            .charCodeAt(0)
            .toString(16)
            .padStart(4, '0')
            .replace(/[a-f]/g, (c) => `[${c}${c.toUpperCase()}]`)
        : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('');
}
function preserveUnicodeStyle(
  oldText: string,
  actualText: string,
  newText: string,
): string {
  if (oldText === actualText) return newText;
  if (
    /\\u[0-9a-fA-F]{4}/.test(oldText) &&
    decodeUnicodeEscapes(oldText) === actualText
  )
    return decodeUnicodeEscapes(newText);
  if (
    /[\u0080-\uffff]/.test(oldText) &&
    decodeUnicodeEscapes(actualText) === oldText
  ) {
    const escapes = actualText.match(/\\u[0-9a-fA-F]{4}/g) ?? [];
    const byChar = new Map(
      escapes.map((escape) => [decodeUnicodeEscapes(escape), escape]),
    );
    const digits = escapes.join('').replace(/\\u/g, '');
    const upper =
      (digits.match(/[A-F]/g)?.length ?? 0) >
      (digits.match(/[a-f]/g)?.length ?? 0);
    return newText
      .split('')
      .map((char) => {
        if (char.charCodeAt(0) < 128) return char;
        const hex = char.charCodeAt(0).toString(16).padStart(4, '0');
        return byChar.get(char) ?? '\\u' + (upper ? hex.toUpperCase() : hex);
      })
      .join('');
  }
  return newText;
}

function isOpeningContext(chars: string[], index: number): boolean {
  if (index === 0) {
    return true;
  }
  const prev = chars[index - 1];
  return (
    prev === ' ' ||
    prev === '\t' ||
    prev === '\n' ||
    prev === '\r' ||
    prev === '(' ||
    prev === '[' ||
    prev === '{' ||
    prev === '\u2014' || // em dash
    prev === '\u2013' // en dash
  );
}

function applyCurlyDoubleQuotes(str: string): string {
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  const chars = [...str];
  const result: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '"') {
      result.push(
        isOpeningContext(chars, i)
          ? LEFT_DOUBLE_CURLY_QUOTE
          : RIGHT_DOUBLE_CURLY_QUOTE,
      );
    } else {
      result.push(chars[i]);
    }
  }
  return result.join('');
}

function applyCurlySingleQuotes(str: string): string {
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  const chars = [...str];
  const result: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "'") {
      const prev = i > 0 ? chars[i - 1] : undefined;
      const next = i < chars.length - 1 ? chars[i + 1] : undefined;
      const prevIsLetter = prev !== undefined && /\p{L}/u.test(prev);
      const nextIsLetter = next !== undefined && /\p{L}/u.test(next);
      if (prevIsLetter && nextIsLetter) {
        result.push(RIGHT_SINGLE_CURLY_QUOTE);
      } else {
        result.push(
          isOpeningContext(chars, i)
            ? LEFT_SINGLE_CURLY_QUOTE
            : RIGHT_SINGLE_CURLY_QUOTE,
        );
      }
    } else {
      result.push(chars[i]);
    }
  }
  return result.join('');
}

/**
 * When old_string matched via quote normalization, apply the same curly
 * quote style to new_string so the edit preserves the file's typography.
 */
function preserveQuoteStyle(
  oldString: string,
  actualOldString: string,
  newString: string,
): string {
  if (oldString === actualOldString) {
    return newString;
  }

  const hasDoubleQuotes =
    actualOldString.includes(LEFT_DOUBLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_DOUBLE_CURLY_QUOTE);
  const hasSingleQuotes =
    actualOldString.includes(LEFT_SINGLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_SINGLE_CURLY_QUOTE);

  if (!hasDoubleQuotes && !hasSingleQuotes) {
    return newString;
  }

  let result = newString;
  if (hasDoubleQuotes) {
    result = applyCurlyDoubleQuotes(result);
  }
  if (hasSingleQuotes) {
    result = applyCurlySingleQuotes(result);
  }
  return result;
}

// ────────────────────────────────────────────────────────────────────────────
// applyEditToFile (replacement with () => replace callback)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Apply an edit to file content.
 * Uses () => replace callback to avoid $ interpretation issues.
 */
export function applyEditToFile(
  originalContent: string,
  oldString: string,
  newString: string,
  replaceAll: boolean = false,
): string {
  const f = replaceAll
    ? (content: string, search: string, replace: string) =>
        content.replaceAll(search, () => replace)
    : (content: string, search: string, replace: string) =>
        content.replace(search, () => replace);

  if (newString !== '') {
    return f(originalContent, oldString, newString);
  }

  const stripTrailingNewline =
    !oldString.endsWith('\n') && originalContent.includes(oldString + '\n');

  return stripTrailingNewline
    ? f(originalContent, oldString + '\n', newString)
    : f(originalContent, oldString, newString);
}

// ────────────────────────────────────────────────────────────────────────────
// Replacement calculation (exact match only + quote normalization)
// ────────────────────────────────────────────────────────────────────────────

interface ReplacementContext {
  params: EditToolParams;
  currentContent: string;
  abortSignal: AbortSignal;
}

interface ReplacementResult {
  newContent: string;
  occurrences: number;
  finalOldString: string;
  finalNewString: string;
}

export function applyReplacement(
  currentContent: string | null,
  oldString: string,
  newString: string,
  isNewFile: boolean,
): string {
  if (isNewFile) {
    return newString;
  }
  if (currentContent === null) {
    return oldString === '' ? newString : '';
  }
  if (oldString === '' && !isNewFile) {
    return currentContent;
  }

  // Use replacement pattern with () => callback
  return currentContent.replace(oldString, () => newString);
}

export async function calculateReplacement(
  _config: Config,
  context: ReplacementContext,
): Promise<ReplacementResult> {
  const { currentContent, params } = context;
  const { old_string, new_string } = params;
  const normalizedSearch = old_string.replace(/\r\n/g, '\n');
  const normalizedReplace = new_string.replace(/\r\n/g, '\n');

  if (normalizedSearch === '') {
    return {
      newContent: currentContent,
      occurrences: 0,
      finalOldString: normalizedSearch,
      finalNewString: normalizedReplace,
    };
  }

  // Use findActualString (exact + quote normalization)
  const actualOldString = findActualString(currentContent, normalizedSearch);
  if (!actualOldString) {
    return {
      newContent: currentContent,
      occurrences: 0,
      finalOldString: normalizedSearch,
      finalNewString: normalizedReplace,
    };
  }

  const occurrences = currentContent.split(actualOldString).length - 1;

  if (!params.allow_multiple && occurrences > 1) {
    return {
      newContent: currentContent,
      occurrences,
      finalOldString: actualOldString,
      finalNewString: normalizedReplace,
    };
  }

  // Preserve curly quotes in new_string
  const actualNewString = preserveQuoteStyle(
    normalizedSearch,
    actualOldString,
    normalizedReplace,
  );

  const newContent = applyEditToFile(
    currentContent,
    actualOldString,
    actualNewString,
    params.allow_multiple ?? false,
  );

  return {
    newContent,
    occurrences,
    finalOldString: actualOldString,
    finalNewString: actualNewString,
  };
}

export function getErrorReplaceResult(
  params: EditToolParams,
  occurrences: number,
  finalOldString: string,
  finalNewString: string,
) {
  let error: { display: string; raw: string; type: ToolErrorType } | undefined =
    undefined;
  if (occurrences === 0) {
    error = {
      display: `Failed to edit, could not find the string to replace.`,
      raw: `Failed to edit, 0 occurrences found for old_string in ${params.file_path}. Ensure you're not escaping content incorrectly and check whitespace, indentation, and context. Use ${READ_FILE_TOOL_NAME} tool to verify.`,
      type: ToolErrorType.EDIT_NO_OCCURRENCE_FOUND,
    };
  } else if (!params.allow_multiple && occurrences !== 1) {
    error = {
      display: `Failed to edit, expected 1 occurrence but found ${occurrences}.`,
      raw: `Failed to edit, Expected 1 occurrence but found ${occurrences} for old_string in file: ${params.file_path}. If you intended to replace multiple occurrences, set 'allow_multiple' to true.`,
      type: ToolErrorType.EDIT_EXPECTED_OCCURRENCE_MISMATCH,
    };
  } else if (finalOldString === finalNewString) {
    error = {
      display: `No changes to apply. The old_string and new_string are identical.`,
      raw: `No changes to apply. The old_string and new_string are identical in file: ${params.file_path}`,
      type: ToolErrorType.EDIT_NO_CHANGE,
    };
  }
  return error;
}

/**
 * Parameters for the Edit tool
 */
export interface EditToolParams {
  file_path: string;
  old_string: string;
  new_string: string;
  allow_multiple?: boolean;
  modified_by_user?: boolean;
  ai_proposed_content?: string;
}

export function isEditToolParams(args: unknown): args is EditToolParams {
  if (typeof args !== 'object' || args === null) {
    return false;
  }
  return (
    'file_path' in args &&
    typeof args.file_path === 'string' &&
    'old_string' in args &&
    typeof args.old_string === 'string' &&
    'new_string' in args &&
    typeof args.new_string === 'string'
  );
}

interface CalculatedEdit {
  staleRecovered?: boolean;
  currentContent: string | null;
  newContent: string;
  occurrences: number;
  error?: { display: string; raw: string; type: ToolErrorType; guardReason?: string };
  isNewFile: boolean;
  encoding: BufferEncoding;
  lineEndings: LineEndingType;
}

// ────────────────────────────────────────────────────────────────────────────
// Sync file reader for edit
// ────────────────────────────────────────────────────────────────────────────

function readFileForEdit(absoluteFilePath: string): {
  content: string;
  fileExists: boolean;
  encoding: BufferEncoding;
  lineEndings: LineEndingType;
  notText?: NotTextReason;
} {
  try {
    const meta = readFileWithMetadata(absoluteFilePath);
    return {
      content: meta.content,
      fileExists: true,
      encoding: meta.encoding,
      lineEndings: meta.lineEndings,
      notText: meta.notText,
    };
  } catch (e) {
    if (isNodeError(e) && e.code === 'ENOENT') {
      return {
        content: '',
        fileExists: false,
        encoding: 'utf8',
        lineEndings: 'LF',
      };
    }
    throw e;
  }
}

class EditToolInvocation
  extends BaseToolInvocation<EditToolParams, ToolResult>
  implements ToolInvocation<EditToolParams, ToolResult>
{
  private readonly resolvedPath: string;
  private readonly cwd: string;

  constructor(
    private readonly config: Config,
    params: EditToolParams,
    toolName?: string,
    displayName?: string,
  ) {
    super(params, toolName, displayName);
    this.cwd = getSessionCwd(this.config);
    this.resolvedPath = resolvePlanModeWritePath(
      this.config,
      this.params.file_path,
      () => expandPath(this.params.file_path, this.cwd),
    );
    // Keep permission checks, hooks and execution on the same pinned target.
    this.params.file_path = this.resolvedPath;
  }

  override toolLocations(): ToolLocation[] {
    return [{ path: this.resolvedPath }];
  }

  private editErrorResult(error: NonNullable<CalculatedEdit['error']>, _editData?: CalculatedEdit): ToolResult {
    return {
      llmContent: error.raw,
      returnDisplay: `Error: ${error.display}`,
      error: {
        message: error.raw,
        type: error.type,
      },
    };
  }

  private editPreparationFailure(error: unknown): ToolResult {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      llmContent: `Error preparing edit: ${errorMsg}`,
      returnDisplay: `Error preparing edit: ${errorMsg}`,
      error: {
        message: errorMsg,
        type: ToolErrorType.EDIT_PREPARATION_FAILURE,
      },
    };
  }

  /**
   * Reject edits with invalid runtime preconditions before write permission is
   * requested. calculateEdit() is intentionally run again during execution so
   * files changed while waiting for permission are still rejected safely.
   */
  async validateBeforePermission(
    ctx: ToolUseContext,
  ): Promise<ToolResult | undefined> {
    try {
      const editData = await this.calculateEdit(
        this.params,
        ctx.fileReadState ?? this.config.fileReadState,
        ctx,
      );
      return editData.error ? this.editErrorResult(editData.error, editData) : undefined;
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      return this.editPreparationFailure(error);
    }
  }

  /**
   * Calculates the potential outcome of an edit operation.
   * Sync read, staleness check via readFileState, quote normalization,
   * no LLM self-correction, no fuzzy/flex/regex matching.
   */
  private async calculateEdit(
    params: EditToolParams,
    fileReadState: FileStateCache = this.config.fileReadState,
    ctx?: ToolUseContext,
  ): Promise<CalculatedEdit> {
    const readPermission = await fileReadPermission(
      {
        signal: ctx?.signal ?? new AbortController().signal,
        ...ctx,
        config: this.config,
      },
      this.resolvedPath,
    );
    if (readPermission.denied) {
      throw new Error('Read permission denied for this file.');
    }
    // File size limit check before reading
    try {
      const stat = fs.statSync(this.resolvedPath);
      if (stat.size > MAX_EDIT_FILE_SIZE) {
        return {
          currentContent: null,
          newContent: '',
          occurrences: 0,
          isNewFile: false,
          error: {
            display: `File is too large to edit (${formatFileSize(stat.size)}).`,
            raw: `File is too large to edit (${formatFileSize(stat.size)}). Maximum editable file size is ${formatFileSize(MAX_EDIT_FILE_SIZE)}.`,
            type: ToolErrorType.FILE_NOT_FOUND, // reuse closest type
          },
          encoding: 'utf8',
          lineEndings: 'LF',
        };
      }
    } catch (e) {
      if (!isNodeError(e) || e.code !== 'ENOENT') {
        // ENOENT is fine — file doesn't exist yet; other errors propagate
        if (isNodeError(e)) throw e;
      }
    }

    // Sync read
    const {
      content: originalFileContents,
      fileExists,
      encoding,
      lineEndings,
      notText,
    } = readFileForEdit(this.resolvedPath);

    if (notText) {
      const refusal = notTextWriteRefusal(notText);
      return {
        currentContent: originalFileContents,
        newContent: originalFileContents,
        occurrences: 0,
        isNewFile: false,
        error: {
          display: refusal,
          raw: refusal,
          type: ToolErrorType.FILE_NOT_TEXT,
        },
        encoding,
        lineEndings,
      };
    }

    if (!fileExists) {
      // File not found — suggest similar file
      if (params.old_string !== '') {
        const similarFile = findSimilarFile(this.resolvedPath);
        const cwdSuggestion = await suggestPathUnderCwd(
          this.resolvedPath,
          this.cwd,
        );
        let message = `File does not exist. ${FILE_NOT_FOUND_CWD_NOTE} ${this.cwd}.`;
        if (cwdSuggestion) {
          message += ` Did you mean ${cwdSuggestion}?`;
        } else if (similarFile) {
          message += ` Did you mean ${similarFile}?`;
        }
        return {
          currentContent: null,
          newContent: '',
          occurrences: 0,
          isNewFile: false,
          error: {
            display: `File not found. Cannot apply edit. Use an empty old_string to create a new file.`,
            raw: message,
            type: ToolErrorType.FILE_NOT_FOUND,
          },
          encoding,
          lineEndings,
        };
      }
      // Empty old_string on nonexistent file → new file creation
      return {
        currentContent: null,
        newContent: params.new_string,
        occurrences: 1,
        isNewFile: true,
        error: undefined,
        encoding,
        lineEndings,
      };
    }

    // Empty old_string on existing file — only reject if file has content
    if (params.old_string === '') {
      if (originalFileContents.trim() !== '') {
        return {
          currentContent: originalFileContents,
          newContent: originalFileContents,
          occurrences: 0,
          isNewFile: false,
          error: {
            display: `Failed to edit. Attempted to create a file that already exists.`,
            raw: `File already exists, cannot create: ${this.resolvedPath}`,
            type: ToolErrorType.ATTEMPT_TO_CREATE_EXISTING_FILE,
          },
          encoding,
          lineEndings,
        };
      }
      // Empty file with empty old_string is valid — replacing empty with content
      return {
        currentContent: originalFileContents,
        newContent: preserveBOM(originalFileContents, params.new_string),
        occurrences: 1,
        isNewFile: false,
        error: undefined,
        encoding,
        lineEndings,
      };
    }

    // Staleness check via readFileState
    if (fileExists) {
      const fileStateCache = fileReadState;
      const lastRead = readBaselineFor(
        fileStateCache.get(this.resolvedPath),
        ctx?.resultConsumption,
      );
      if (
        (!lastRead || lastRead.isPartialView) &&
        !readPermission.autoAllowed
      ) {
        return {
          currentContent: originalFileContents,
          newContent: originalFileContents,
          occurrences: 0,
          isNewFile: false,
          error: {
            display: `File has not been read yet. Read it first before editing.`,
            raw: `File has not been read yet. Read it first before writing to it.`,
            type: ToolErrorType.FILE_UNEXPECTEDLY_MODIFIED,
            guardReason: 'read_required',
          },
          encoding,
          lineEndings,
        };
      }

      if (lastRead)
        try {
          const lastWriteTime = Math.floor(
            fs.statSync(this.resolvedPath).mtimeMs,
          );
          if (lastWriteTime > lastRead.timestamp) {
            const isFullRead = isFullFileRead(lastRead);
            if (
              (!isFullRead ||
                !isSameFileContent(lastRead, originalFileContents)) &&
              !readPermission.autoAllowed
            ) {
              return {
                currentContent: originalFileContents,
                newContent: originalFileContents,
                occurrences: 0,
                isNewFile: false,
                error: {
                  display: `File has been modified since last read. Read it again before editing.`,
                  raw: `File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.`,
                  type: ToolErrorType.FILE_UNEXPECTEDLY_MODIFIED,
                  guardReason: 'stale_read',
                },
                encoding,
                lineEndings,
              };
            }
          }
        } catch {
          // stat failure is non-fatal for staleness check
        }
    }

    // findActualString (exact + quote normalization)
    const actualOldString =
      findActualString(originalFileContents, params.old_string) ||
      params.old_string;

    const occurrences = originalFileContents.split(actualOldString).length - 1;

    if (occurrences === 0) {
      return {
        currentContent: originalFileContents,
        newContent: originalFileContents,
        occurrences: 0,
        isNewFile: false,
        error: {
          display: `Failed to edit, could not find the string to replace.`,
          raw: `Failed to edit, 0 occurrences found for old_string in ${this.resolvedPath}. Ensure you're not escaping content incorrectly and check whitespace, indentation, and context. Use ${READ_FILE_TOOL_NAME} tool to verify.`,
          type: ToolErrorType.EDIT_NO_OCCURRENCE_FOUND,
        },
        encoding,
        lineEndings,
      };
    }

    if (!params.allow_multiple && occurrences > 1) {
      return {
        currentContent: originalFileContents,
        newContent: originalFileContents,
        occurrences,
        isNewFile: false,
        error: {
          display: `Failed to edit, expected 1 occurrence but found ${occurrences}.`,
          raw: `Failed to edit, Expected 1 occurrence but found ${occurrences} for old_string in file: ${this.resolvedPath}. If you intended to replace multiple occurrences, set 'allow_multiple' to true.`,
          type: ToolErrorType.EDIT_EXPECTED_OCCURRENCE_MISMATCH,
        },
        encoding,
        lineEndings,
      };
    }

    // Preserve curly quotes in new_string
    const actualNewString = preserveUnicodeStyle(
      params.old_string,
      actualOldString,
      preserveQuoteStyle(params.old_string, actualOldString, params.new_string),
    );

    if (actualOldString === actualNewString) {
      return {
        currentContent: originalFileContents,
        newContent: originalFileContents,
        occurrences,
        isNewFile: false,
        error: {
          display: `No changes to apply. The old_string and new_string are identical.`,
          raw: `No changes to apply. The old_string and new_string are identical in file: ${this.resolvedPath}`,
          type: ToolErrorType.EDIT_NO_CHANGE,
        },
        encoding,
        lineEndings,
      };
    }

    // Apply the edit using applyEditToFile
    const newContent = preserveBOM(originalFileContents, applyEditToFile(
      originalFileContents,
      actualOldString,
      actualNewString,
      params.allow_multiple ?? false,
    ));

    // Layer-two scope guard, but only when the edit actually touches a
    // frontmatter `type:` line (editing the body must not trigger it). When it
    // does, validate the resulting content against the file's memory root.
    if (
      TYPE_LINE_REGEX.test(actualOldString) ||
      TYPE_LINE_REGEX.test(actualNewString)
    ) {
      const scopeError = validateAutoMemoryWriteScope(
        this.resolvedPath,
        stripBOM(newContent),
        this.config,
      );
      if (scopeError) {
        return {
          currentContent: originalFileContents,
          newContent: originalFileContents,
          occurrences,
          isNewFile: false,
          error: {
            display: `Memory written to the wrong scope directory.`,
            raw: scopeError,
            type: ToolErrorType.EDIT_NO_CHANGE,
          },
          encoding,
          lineEndings,
        };
      }
    }

    return {
      currentContent: originalFileContents,
      newContent,
      occurrences,
      isNewFile: false,
      error: undefined,
      encoding,
      lineEndings,
    };
  }

  getDescription(): string {
    return shortenPath(
      displayPathForWorkspace(this.resolvedPath, this.config.getTargetDir()),
    );
  }

  /**
   * Executes the edit operation.
   * Sync read, quote normalization, writeTextContent with
   * encoding/line-ending preservation, readFileState update.
   */
  async execute(signal: AbortSignal): Promise<ToolResult> {
    activateConditionalSkillsForPath(this.config, this.resolvedPath);
    const result = await this._executeInternal(signal);
    return result;
  }

  override async executeWithContext(ctx: ToolUseContext): Promise<ToolResult> {
    activateConditionalSkillsForPath(this.config, this.resolvedPath);
    return this._executeInternal(ctx.signal, ctx);
  }

  private async _executeInternal(
    signal: AbortSignal,
    ctx?: ToolUseContext,
  ): Promise<ToolResult> {
    const fileReadState = ctx?.fileReadState ?? this.config.fileReadState;
    let editData: CalculatedEdit;
    try {
      editData = await this.calculateEdit(this.params, fileReadState, ctx);
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      return this.editPreparationFailure(error);
    }

    if (editData.error) {
      return this.editErrorResult(editData.error, editData);
    }

    // Block edits that would break a previously-valid settings file.
    if (editData.currentContent !== null) {
      const afterError = this.config.validateSettingsContent(
        this.resolvedPath,
        editData.newContent,
      );
      if (
        afterError &&
        !this.config.validateSettingsContent(
          this.resolvedPath,
          editData.currentContent,
        )
      ) {
        return {
          llmContent: `Settings validation failed:\n${afterError}`,
          returnDisplay: `Error: Settings validation failed.`,
          error: {
            message: afterError,
            type: ToolErrorType.SETTINGS_VALIDATION_FAILED,
          },
        };
      }
    }

    try {
      const expectedPath = resolveFileWritePath(this.resolvedPath);
      if (ctx?.fileHistory && ctx.messageId) {
        await ctx.fileHistory.trackEdit(this.resolvedPath, ctx.messageId);
      }

      let writtenState: FileState | undefined;
      const writeError = await withFileWriteLock(
        this.resolvedPath,
        signal,
        async () => {
          const target = pinFileWriteTarget(this.resolvedPath, expectedPath);
          const previous = fileReadState.get(this.resolvedPath);
          editData = await this.calculateEdit(this.params, fileReadState, ctx);
          if (editData.error) return editData.error;
          const afterError = this.config.validateSettingsContent(
            this.resolvedPath,
            editData.newContent,
          );
          if (
            afterError &&
            (editData.currentContent === null ||
              !this.config.validateSettingsContent(
                this.resolvedPath,
                editData.currentContent,
              ))
          )
            throw new Error(afterError);
          editData.staleRecovered =
            !editData.isNewFile &&
            !!previous &&
            Math.floor(fs.statSync(this.resolvedPath).mtimeMs) >
              previous.timestamp &&
            !isSameFileContent(previous, editData.currentContent ?? '');
          // Ensure parent directory exists
          await this.ensureParentDirectoriesExistAsync(this.resolvedPath);

          // Write using writeTextContent with encoding + line ending preservation
          await writeTextContent(
            target.ioPath,
            editData.newContent,
            editData.encoding,
            editData.lineEndings,
            () => {
              signal.throwIfAborted();
              target.recheckBeforeWrite();
              const beforeWrite = readFileForEdit(this.resolvedPath);
              if (beforeWrite.notText)
                throw new FileNotTextError(beforeWrite.notText);
              if (
                beforeWrite.fileExists !== (editData.currentContent !== null) ||
                (beforeWrite.fileExists &&
                  beforeWrite.content !== editData.currentContent)
              )
                throw new FileWriteContentChangedError(
                  'File changed while preparing the edit. Read it again before editing.',
                );
            },
          );

          // Update readFileState after write
          try {
            const postWriteStat = await fsPromises.stat(this.resolvedPath);
            const fileStateCache = fileReadState;
            fileStateCache.set(this.resolvedPath, {
              content: normalizeFileStateContent(editData.newContent),
              contentNotInModelContext:
                this.params.modified_by_user === true ||
                ctx?.inputModifiedByHook === true ||
                (!editData.isNewFile &&
                  (!isFileContentInContext(previous) ||
                    editData.staleRecovered)),
              timestamp: Math.floor(postWriteStat.mtimeMs),
              offset: undefined,
              limit: undefined,
            });
            writtenState = fileReadState.get(this.resolvedPath);
          } catch {
            fileReadState.delete(this.resolvedPath);
            // Non-fatal: stat after write may fail
          }

          return undefined;
        },
      );

      if (writeError) return { ...this.editErrorResult(writeError, editData), returnDisplay: writeError.display };
      // Fire FileChanged hook (fire-and-forget, observability only)
      void this.config
        .getHookSystem()
        ?.fireFileChangedEvent(
          this.resolvedPath,
          editData.isNewFile ? 'add' : 'change',
        )
        .catch((err) => runLogger.debug(`FileChanged hook error: ${err}`));
      let displayResult: ToolResultDisplay;
      let proposedContent = editData.newContent;
      if (editData.isNewFile) {
        displayResult = `Created ${shortenPath(displayPathForWorkspace(this.resolvedPath, this.config.getTargetDir()))}`;

        // For new files: if modified_by_user with ai_proposed_content, track
        // the AI's original proposal rather than the user-modified content.
        proposedContent =
          this.params.modified_by_user &&
          this.params.ai_proposed_content !== undefined
            ? this.params.ai_proposed_content
            : editData.newContent;
      } else {
        const fileName = path.basename(this.resolvedPath);
        const fileDiff = Diff.createPatch(
          fileName,
          editData.currentContent ?? '',
          editData.newContent,
          'Current',
          'Proposed',
          DEFAULT_DIFF_OPTIONS,
        );

        let fullAiProposedContent = proposedContent;
        if (
          this.params.modified_by_user &&
          this.params.ai_proposed_content !== undefined
        ) {
          try {
            const aiReplacement = await calculateReplacement(this.config, {
              params: {
                ...this.params,
                new_string: this.params.ai_proposed_content,
              },
              currentContent: editData.currentContent ?? '',
              abortSignal: signal,
            });
            fullAiProposedContent = aiReplacement.newContent;
          } catch (error) {
            const errorMsg =
              error instanceof Error ? error.message : String(error);
            runLogger.log(`AI replacement fallback: ${errorMsg}`);
            fullAiProposedContent = editData.newContent;
          }
        }

        proposedContent = fullAiProposedContent;

        const diffStat = getDiffStat(
          fileName,
          editData.currentContent ?? '',
          fullAiProposedContent,
          editData.newContent,
        );
        displayResult = {
          fileDiff,
          fileName,
          filePath: this.resolvedPath,
          originalContent: editData.currentContent,
          newContent: editData.newContent,
          diffStat,
          isNewFile: editData.isNewFile,
        };
      }

      const llmSuccessMessageParts = [
        editData.isNewFile
          ? `Created new file: ${this.resolvedPath} with provided content.`
          : `Successfully modified file: ${this.resolvedPath} (${editData.occurrences} replacements).`,
      ];

      if (this.params.modified_by_user) {
        llmSuccessMessageParts.push(
          'The user modified your proposed changes. Read the affected code before relying on its contents.',
        );
      }
      if (ctx?.inputModifiedByHook) {
        llmSuccessMessageParts.push(
          'A hook modified the edit parameters. Read the affected code before relying on its contents.',
        );
      }

      if (editData.staleRecovered)
        llmSuccessMessageParts.push(
          'The file changed since your last read. Your edit was applied to the current contents; read it before relying on surrounding changes you have not seen.',
        );
      const llmContent = llmSuccessMessageParts.join(' ');
      const originalFile = editData.currentContent ?? '';
      const toolUseResult: FileEditResult = {
        filePath: this.resolvedPath,
        oldString: this.params.old_string,
        newString: this.params.new_string,
        originalFile,
        structuredPatch: getStructuredPatch(
          path.basename(this.resolvedPath),
          originalFile,
          editData.newContent,
        ),
        userModified: this.params.modified_by_user ?? false,
        replaceAll: this.params.allow_multiple ?? false,
      };

      return withFileWriteFeedback(
        {
          llmContent,
          returnDisplay: displayResult,
          toolUseResult,
          fileWrite: {
            filePath: this.resolvedPath,
            workspacePath: this.config.getTargetDir(),
            originalContent: originalFile,
            proposedContent,
            writtenContent: editData.newContent,
          },
        },
        fileReadState,
        this.resolvedPath,
        writtenState,
      );
    } catch (error) {
      if (signal.aborted) throw error;
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        llmContent: error instanceof FileNotTextError
          ? errorMsg
          : `Error executing edit: ${errorMsg}`,
        returnDisplay: `Error writing file: ${errorMsg}`,
        error: {
          message: errorMsg,
          type:
            error instanceof FileWriteContentChangedError
              ? ToolErrorType.FILE_UNEXPECTEDLY_MODIFIED
              : error instanceof FileNotTextError
                ? ToolErrorType.FILE_NOT_TEXT
                : ToolErrorType.FILE_WRITE_FAILURE,
        },
      };
    }
  }

  private async ensureParentDirectoriesExistAsync(
    filePath: string,
  ): Promise<void> {
    const dirName = path.dirname(filePath);
    try {
      await fsPromises.access(dirName);
    } catch {
      await fsPromises.mkdir(dirName, { recursive: true });
    }
  }
}

/**
 * Implementation of the Edit tool logic
 */
export class EditTool
  extends BaseDeclarativeTool<EditToolParams, ToolResult>
  implements ModifiableDeclarativeTool<EditToolParams>
{
  static readonly Name = EDIT_TOOL_NAME;
  override get programmatic() {
    return editContract;
  }

  constructor(private readonly config: Config) {
    super(
      EditTool.Name,
      EDIT_DISPLAY_NAME,
      CORE_TOOL_SET.Edit.description!,
      Kind.Edit,
      CORE_TOOL_SET.Edit.parametersJsonSchema,
      true, // isOutputMarkdown
      false, // canUpdateOutput
    );
  }

  override getSchema(modelId?: string) {
    return {
      ...CORE_TOOL_SET.Edit,
      description: getReplaceDescription(
        false,
        resolvePromptBundleForModel(modelId),
      ),
    };
  }

  /**
   * Validation: same-string check (before file read), path access check.
   * Staleness/readFileState/findActualString/uniqueness checks are done
   * in calculateEdit() before permission and again during execution.
   */
  protected override validateToolParamValues(
    params: EditToolParams,
  ): string | null {
    if (!params.file_path) {
      return "The 'file_path' parameter must be non-empty.";
    }

    // old_string === new_string check BEFORE file read
    if (params.old_string === params.new_string) {
      return 'No changes to make: old_string and new_string are exactly the same.';
    }

    const resolvedPath = resolvePlanModeWritePath(
      this.config,
      params.file_path,
      () => expandPath(params.file_path, getSessionCwd(this.config)),
    );

    // .ipynb files should use NotebookEditTool
    if (path.extname(resolvedPath) === '.ipynb') {
      return 'File must be a Jupyter notebook (.ipynb file). Use the NotebookEdit tool to edit notebook files.';
    }

    return null;
  }

  protected createInvocation(
    params: EditToolParams,
  ): ToolInvocation<EditToolParams, ToolResult> {
    return new EditToolInvocation(
      this.config,
      params,
      this.name,
      this.displayName,
    );
  }

  override isConcurrencySafe(_input?: EditToolParams): boolean {
    return false;
  }

  override isDestructive(_input?: EditToolParams): boolean {
    return true;
  }

  // === Permission Pipeline methods ===

  getModifyContext(_: AbortSignal): ModifyContext<EditToolParams> {
    return {
      getFilePath: (params: EditToolParams) => params.file_path,
      getCurrentContent: async (params: EditToolParams): Promise<string> => {
        try {
          return await this.config
            .getFileSystemService()
            .readTextFile(params.file_path);
        } catch (err) {
          if (!isNodeError(err) || err.code !== 'ENOENT') throw err;
          return '';
        }
      },
      getProposedContent: async (params: EditToolParams): Promise<string> => {
        try {
          const currentContent = await this.config
            .getFileSystemService()
            .readTextFile(params.file_path);
          return applyReplacement(
            currentContent,
            params.old_string,
            params.new_string,
            params.old_string === '' && currentContent === '',
          );
        } catch (err) {
          if (!isNodeError(err) || err.code !== 'ENOENT') throw err;
          return '';
        }
      },
      createUpdatedParams: (
        oldContent: string,
        modifiedProposedContent: string,
        originalParams: EditToolParams,
      ): EditToolParams => {
        const content = originalParams.new_string;
        return {
          ...originalParams,
          ai_proposed_content: content,
          old_string: oldContent,
          new_string: modifiedProposedContent,
          modified_by_user: true,
        };
      },
    };
  }
}

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as Diff from 'diff';
import type {
  ToolCallConfirmationDetails,
  ToolEditConfirmationDetails,
  ToolInvocation,
  ToolLocation,
  ToolResult,
} from './tools.js';
import { BaseDeclarativeTool, Kind, ToolConfirmationOutcome } from './tools.js';
import { ToolErrorType } from './tool-error.js';
import { makeRelative, shortenPath } from '../utils/paths.js';
import { isNodeError } from '../utils/errors.js';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import { FileEncoding } from '../services/fileSystemService.js';
import { DEFAULT_DIFF_OPTIONS, getDiffStat } from './diffOptions.js';
import { ReadFileTool } from './read-file.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import { logFileOperation } from '../telemetry/loggers.js';
import { FileOperationEvent } from '../telemetry/types.js';
import { FileOperation } from '../telemetry/metrics.js';
import {
  getSpecificMimeType,
  fileExists as isFilefileExists,
} from '../utils/fileUtils.js';
import { getLanguageFromFilePath } from '../utils/language-detection.js';
import type {
  ModifiableDeclarativeTool,
  ModifyContext,
} from './modifiable-tool.js';
import { IdeClient } from '../ide/ide-client.js';
import { safeLiteralReplace } from '../utils/textUtils.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { extractEditSnippet } from '../utils/editHelper.js';
import levenshtein from 'fast-levenshtein';

const debugLogger = createDebugLogger('EDIT');

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
    // Should not happen if not a new file, but defensively return empty or newString if oldString is also empty
    return oldString === '' ? newString : '';
  }
  // If oldString is empty and it's not a new file, do not modify the content.
  if (oldString === '' && !isNewFile) {
    return currentContent;
  }

  // Use intelligent replacement that handles $ sequences safely
  return safeLiteralReplace(currentContent, oldString, newString);
}

// ---------------------------------------------------------------------------
// Multi-strategy replacement pipeline (ported from gemini-edit)
// ---------------------------------------------------------------------------

const ENABLE_FUZZY_MATCH_RECOVERY = true;
const FUZZY_MATCH_THRESHOLD = 0.1; // Allow up to 10% weighted difference
const WHITESPACE_PENALTY_FACTOR = 0.1; // Whitespace differences cost 10% of a character difference

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
  strategy?: 'exact' | 'flexible' | 'regex' | 'fuzzy';
  matchRanges?: Array<{ start: number; end: number }>;
}

function restoreTrailingNewline(
  originalContent: string,
  modifiedContent: string,
): string {
  const hadTrailingNewline = originalContent.endsWith('\n');
  if (hadTrailingNewline && !modifiedContent.endsWith('\n')) {
    return modifiedContent + '\n';
  } else if (!hadTrailingNewline && modifiedContent.endsWith('\n')) {
    return modifiedContent.replace(/\n$/, '');
  }
  return modifiedContent;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripWhitespace(str: string): string {
  return str.replace(/\s/g, '');
}

/**
 * Applies the target indentation to the lines, while preserving relative indentation.
 */
function applyIndentation(
  lines: string[],
  targetIndentation: string,
): string[] {
  if (lines.length === 0) return [];

  const referenceLine = lines[0];
  const refIndentMatch = referenceLine.match(/^([ \t]*)/);
  const refIndent = refIndentMatch ? refIndentMatch[1] : '';

  return lines.map((line) => {
    if (line.trim() === '') {
      return '';
    }
    if (line.startsWith(refIndent)) {
      return targetIndentation + line.slice(refIndent.length);
    }
    return targetIndentation + line.trimStart();
  });
}

async function calculateExactReplacement(
  context: ReplacementContext,
): Promise<ReplacementResult | null> {
  const { currentContent, params } = context;
  const { old_string, new_string } = params;

  const normalizedSearch = old_string.replace(/\r\n/g, '\n');
  const normalizedReplace = new_string.replace(/\r\n/g, '\n');

  const exactOccurrences = currentContent.split(normalizedSearch).length - 1;

  if (!params.replace_all && exactOccurrences > 1) {
    return {
      newContent: currentContent,
      occurrences: exactOccurrences,
      finalOldString: normalizedSearch,
      finalNewString: normalizedReplace,
    };
  }

  if (exactOccurrences > 0) {
    let modifiedCode = safeLiteralReplace(
      currentContent,
      normalizedSearch,
      normalizedReplace,
    );
    modifiedCode = restoreTrailingNewline(currentContent, modifiedCode);
    return {
      newContent: modifiedCode,
      occurrences: exactOccurrences,
      finalOldString: normalizedSearch,
      finalNewString: normalizedReplace,
    };
  }

  return null;
}

async function calculateFlexibleReplacement(
  context: ReplacementContext,
): Promise<ReplacementResult | null> {
  const { currentContent, params } = context;
  const { old_string, new_string } = params;

  const normalizedSearch = old_string.replace(/\r\n/g, '\n');
  const normalizedReplace = new_string.replace(/\r\n/g, '\n');

  const sourceLines = currentContent.match(/.*(?:\n|$)/g)?.slice(0, -1) ?? [];
  const searchLinesStripped = normalizedSearch
    .split('\n')
    .map((line: string) => line.trim());
  const replaceLines = normalizedReplace.split('\n');

  let flexibleOccurrences = 0;
  let i = 0;
  while (i <= sourceLines.length - searchLinesStripped.length) {
    const window = sourceLines.slice(i, i + searchLinesStripped.length);
    const windowStripped = window.map((line: string) => line.trim());
    const isMatch = windowStripped.every(
      (line: string, index: number) => line === searchLinesStripped[index],
    );

    if (isMatch) {
      flexibleOccurrences++;
      const firstLineInMatch = window[0];
      const indentationMatch = firstLineInMatch.match(/^([ \t]*)/);
      const indentation = indentationMatch ? indentationMatch[1] : '';
      const newBlockWithIndent = applyIndentation(replaceLines, indentation);
      sourceLines.splice(
        i,
        searchLinesStripped.length,
        newBlockWithIndent.join('\n'),
      );
      i += replaceLines.length;
    } else {
      i++;
    }
  }

  if (flexibleOccurrences > 0) {
    let modifiedCode = sourceLines.join('');
    modifiedCode = restoreTrailingNewline(currentContent, modifiedCode);
    return {
      newContent: modifiedCode,
      occurrences: flexibleOccurrences,
      finalOldString: normalizedSearch,
      finalNewString: normalizedReplace,
    };
  }

  return null;
}

async function calculateRegexReplacement(
  context: ReplacementContext,
): Promise<ReplacementResult | null> {
  const { currentContent, params } = context;
  const { old_string, new_string } = params;

  const normalizedSearch = old_string.replace(/\r\n/g, '\n');
  const normalizedReplace = new_string.replace(/\r\n/g, '\n');

  const delimiters = ['(', ')', ':', '[', ']', '{', '}', '>', '<', '='];

  let processedString = normalizedSearch;
  for (const delim of delimiters) {
    processedString = processedString.split(delim).join(` ${delim} `);
  }

  const tokens = processedString.split(/\s+/).filter(Boolean);

  if (tokens.length === 0) {
    return null;
  }

  const escapedTokens = tokens.map(escapeRegex);
  const pattern = escapedTokens.join('\\s*');
  const finalPattern = `^([ \t]*)${pattern}`;

  const globalRegex = new RegExp(finalPattern, 'gm');
  const matches = currentContent.match(globalRegex);

  if (!matches) {
    return null;
  }

  const occurrences = matches.length;
  const newLines = normalizedReplace.split('\n');

  const replaceRegex = new RegExp(
    finalPattern,
    params.replace_all ? 'gm' : 'm',
  );

  const modifiedCode = currentContent.replace(
    replaceRegex,
    (_match, indentation) =>
      applyIndentation(newLines, indentation || '').join('\n'),
  );

  return {
    newContent: restoreTrailingNewline(currentContent, modifiedCode),
    occurrences,
    finalOldString: normalizedSearch,
    finalNewString: normalizedReplace,
  };
}

async function calculateFuzzyReplacement(
  config: Config,
  context: ReplacementContext,
): Promise<ReplacementResult | null> {
  const { currentContent, params } = context;
  const { old_string, new_string } = params;

  if (old_string.length < 10) {
    return null;
  }

  const normalizedCode = currentContent.replace(/\r\n/g, '\n');
  const normalizedSearch = old_string.replace(/\r\n/g, '\n');
  const normalizedReplace = new_string.replace(/\r\n/g, '\n');

  const sourceLines = normalizedCode.match(/.*(?:\n|$)/g)?.slice(0, -1) ?? [];
  const searchLines = normalizedSearch
    .match(/.*(?:\n|$)/g)
    ?.slice(0, -1)
    .map((l) => l.trimEnd());

  if (sourceLines.length * Math.pow(old_string.length, 2) > 400_000_000) {
    return null;
  }

  if (!searchLines || searchLines.length === 0) {
    return null;
  }

  const N = searchLines.length;
  const candidates: Array<{ index: number; score: number }> = [];
  const searchBlock = searchLines.join('\n');

  for (let i = 0; i <= sourceLines.length - N; i++) {
    const windowLines = sourceLines.slice(i, i + N);
    const windowText = windowLines.map((l) => l.trimEnd()).join('\n');

    const lengthDiff = Math.abs(windowText.length - searchBlock.length);
    if (
      lengthDiff / searchBlock.length >
      FUZZY_MATCH_THRESHOLD / WHITESPACE_PENALTY_FACTOR
    ) {
      continue;
    }

    const d_raw = levenshtein.get(windowText, searchBlock);
    const d_norm = levenshtein.get(
      stripWhitespace(windowText),
      stripWhitespace(searchBlock),
    );

    const weightedDist = d_norm + (d_raw - d_norm) * WHITESPACE_PENALTY_FACTOR;
    const score = weightedDist / searchBlock.length;

    if (score <= FUZZY_MATCH_THRESHOLD) {
      candidates.push({ index: i, score });
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => a.score - b.score || a.index - b.index);

  const selectedMatches: Array<{ index: number; score: number }> = [];
  for (const candidate of candidates) {
    const overlaps = selectedMatches.some(
      (m) => Math.abs(m.index - candidate.index) < N,
    );
    if (!overlaps) {
      selectedMatches.push(candidate);
    }
  }

  if (selectedMatches.length > 0) {
    const matchRanges = selectedMatches
      .map((m) => ({ start: m.index + 1, end: m.index + N }))
      .sort((a, b) => a.start - b.start);

    selectedMatches.sort((a, b) => b.index - a.index);

    const newLines = normalizedReplace.split('\n');

    for (const match of selectedMatches) {
      const firstLineMatch = sourceLines[match.index];
      const indentationMatch = firstLineMatch.match(/^([ \t]*)/);
      const indentation = indentationMatch ? indentationMatch[1] : '';

      const indentedReplaceLines = applyIndentation(newLines, indentation);

      let replacementText = indentedReplaceLines.join('\n');
      if (sourceLines[match.index + N - 1].endsWith('\n')) {
        replacementText += '\n';
      }

      sourceLines.splice(match.index, N, replacementText);
    }

    let modifiedCode = sourceLines.join('');
    modifiedCode = restoreTrailingNewline(currentContent, modifiedCode);

    return {
      newContent: modifiedCode,
      occurrences: selectedMatches.length,
      finalOldString: normalizedSearch,
      finalNewString: normalizedReplace,
      strategy: 'fuzzy',
      matchRanges,
    };
  }

  return null;
}

export async function calculateReplacement(
  config: Config,
  context: ReplacementContext,
): Promise<ReplacementResult> {
  const { params } = context;
  const normalizedSearch = params.old_string.replace(/\r\n/g, '\n');
  const normalizedReplace = params.new_string.replace(/\r\n/g, '\n');

  if (normalizedSearch === '') {
    return {
      newContent: context.currentContent,
      occurrences: 0,
      finalOldString: normalizedSearch,
      finalNewString: normalizedReplace,
    };
  }

  const exactResult = await calculateExactReplacement(context);
  if (exactResult) {
    return exactResult;
  }

  const flexibleResult = await calculateFlexibleReplacement(context);
  if (flexibleResult) {
    return flexibleResult;
  }

  const regexResult = await calculateRegexReplacement(context);
  if (regexResult) {
    return regexResult;
  }

  let fuzzyResult;
  if (
    ENABLE_FUZZY_MATCH_RECOVERY &&
    (fuzzyResult = await calculateFuzzyReplacement(config, context))
  ) {
    return fuzzyResult;
  }

  return {
    newContent: context.currentContent,
    occurrences: 0,
    finalOldString: normalizedSearch,
    finalNewString: normalizedReplace,
  };
}

function getFuzzyMatchFeedback(
  strategy?: string,
  matchRanges?: Array<{ start: number; end: number }>,
): string | null {
  if (strategy === 'fuzzy' && matchRanges && matchRanges.length > 0) {
    const ranges = matchRanges
      .map((r) => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`))
      .join(', ');
    return `Applied fuzzy match at line${matchRanges.length > 1 ? 's' : ''} ${ranges}.`;
  }
  return null;
}

/**
 * Parameters for the Edit tool
 */
export interface EditToolParams {
  /**
   * The absolute path to the file to modify
   */
  file_path: string;

  /**
   * The text to replace
   */
  old_string: string;

  /**
   * The text to replace it with
   */
  new_string: string;

  /**
   * Replace every occurrence of old_string instead of requiring a unique match.
   */
  replace_all?: boolean;

  /**
   * The instruction describing what the edit should achieve (used for self-correction).
   */
  instruction?: string;

  /**
   * Whether the edit was modified manually by the user.
   */
  modified_by_user?: boolean;

  /**
   * Initially proposed content.
   */
  ai_proposed_content?: string;
}

interface CalculatedEdit {
  currentContent: string | null;
  newContent: string;
  occurrences: number;
  error?: { display: string; raw: string; type: ToolErrorType };
  isNewFile: boolean;
  /** Detected encoding of the existing file (e.g. 'utf-8', 'gbk') */
  encoding: string;
  /** Whether the existing file has a UTF-8 BOM */
  bom: boolean;
  /** Which replacement strategy was used */
  strategy?: 'exact' | 'flexible' | 'regex' | 'fuzzy';
  /** Line ranges that were matched (populated for fuzzy strategy) */
  matchRanges?: Array<{ start: number; end: number }>;
}

class EditToolInvocation implements ToolInvocation<EditToolParams, ToolResult> {
  constructor(
    private readonly config: Config,
    public params: EditToolParams,
  ) {}

  toolLocations(): ToolLocation[] {
    return [{ path: this.params.file_path }];
  }

  /**
   * Calculates the potential outcome of an edit operation.
   * @param params Parameters for the edit operation
   * @returns An object describing the potential edit outcome
   * @throws File system errors if reading the file fails unexpectedly (e.g., permissions)
   */
  private async calculateEdit(
    params: EditToolParams,
    abortSignal: AbortSignal,
  ): Promise<CalculatedEdit> {
    const replaceAll = params.replace_all ?? false;
    let currentContent: string | null = null;
    let fileExists = await isFilefileExists(params.file_path);
    let isNewFile = false;
    let error:
      | { display: string; raw: string; type: ToolErrorType }
      | undefined = undefined;
    let useBOM = false;
    let detectedEncoding = 'utf-8';

    if (fileExists) {
      try {
        const fileInfo = await this.config
          .getFileSystemService()
          .readTextFile({ path: params.file_path });
        // Handle null content as a read failure
        if (fileInfo.content === null) {
          error = {
            display: `Failed to read content of file.`,
            raw: `Failed to read content of existing file: ${params.file_path}`,
            type: ToolErrorType.READ_CONTENT_FAILURE,
          };
        } else {
          if (fileInfo._meta?.bom !== undefined) {
            useBOM = fileInfo._meta.bom;
          } else {
            useBOM =
              fileInfo.content.length > 0 &&
              fileInfo.content.codePointAt(0) === 0xfeff;
          }
          detectedEncoding = fileInfo._meta?.encoding || 'utf-8';
          // Normalize line endings to LF for consistent processing.
          currentContent = fileInfo.content.replace(/\r\n/g, '\n');
          fileExists = true;
        }
      } catch (err: unknown) {
        if (!isNodeError(err) || err.code !== 'ENOENT') {
          throw err;
        }
        fileExists = false;
      }
    }

    // If we already have an error from reading, return early
    if (error) {
      const newContent = !error
        ? isNewFile
          ? params.new_string
          : (currentContent ?? '')
        : (currentContent ?? '');
      return {
        currentContent,
        newContent,
        occurrences: isNewFile ? 1 : 0,
        error,
        isNewFile,
        bom: useBOM,
        encoding: detectedEncoding,
      };
    }

    if (params.old_string === '' && !fileExists) {
      // Creating a new file
      isNewFile = true;
    } else if (!fileExists) {
      error = {
        display: `File not found. Cannot apply edit. Use an empty old_string to create a new file.`,
        raw: `File not found: ${params.file_path}`,
        type: ToolErrorType.FILE_NOT_FOUND,
      };
    } else if (params.old_string === '') {
      error = {
        display: `Failed to edit. Attempted to create a file that already exists.`,
        raw: `File already exists, cannot create: ${params.file_path}`,
        type: ToolErrorType.ATTEMPT_TO_CREATE_EXISTING_FILE,
      };
    } else if (currentContent !== null) {
      // Run the multi-strategy replacement pipeline
      const replacementResult = await calculateReplacement(this.config, {
        params: { ...params, replace_all: replaceAll },
        currentContent,
        abortSignal,
      });

      const { occurrences, finalOldString, finalNewString, newContent } =
        replacementResult;

      if (occurrences === 0) {
        error = {
          display: `Failed to edit, could not find the string to replace.`,
          raw: `Failed to edit, 0 occurrences found for old_string in ${params.file_path}. No edits made. The exact text in old_string was not found. Ensure you're not escaping content incorrectly and check whitespace, indentation, and context. Use ${ReadFileTool.Name} tool to verify.`,
          type: ToolErrorType.EDIT_NO_OCCURRENCE_FOUND,
        };
      } else if (!replaceAll && occurrences > 1) {
        error = {
          display: `Failed to edit because the text matches multiple locations. Provide more context or set replace_all to true.`,
          raw: `Failed to edit. Found ${occurrences} occurrences for old_string in ${params.file_path} but replace_all was not enabled.`,
          type: ToolErrorType.EDIT_EXPECTED_OCCURRENCE_MISMATCH,
        };
      } else if (finalOldString === finalNewString) {
        error = {
          display: `No changes to apply. The old_string and new_string are identical.`,
          raw: `No changes to apply. The old_string and new_string are identical in file: ${params.file_path}`,
          type: ToolErrorType.EDIT_NO_CHANGE,
        };
      } else if (newContent === currentContent) {
        error = {
          display:
            'No changes to apply. The new content is identical to the current content.',
          raw: `No changes to apply. The new content is identical to the current content in file: ${params.file_path}`,
          type: ToolErrorType.EDIT_NO_CHANGE,
        };
      }

      if (!error) {
        return {
          currentContent,
          newContent,
          occurrences,
          error: undefined,
          isNewFile: false,
          bom: useBOM,
          encoding: detectedEncoding,
          strategy: replacementResult.strategy,
          matchRanges: replacementResult.matchRanges,
        };
      }

      return {
        currentContent,
        newContent: currentContent,
        occurrences,
        error,
        isNewFile: false,
        bom: useBOM,
        encoding: detectedEncoding,
      };
    } else {
      error = {
        display: `Failed to read content of file.`,
        raw: `Failed to read content of existing file: ${params.file_path}`,
        type: ToolErrorType.READ_CONTENT_FAILURE,
      };
    }

    const newContent = !error
      ? isNewFile
        ? params.new_string
        : (currentContent ?? '')
      : (currentContent ?? '');

    return {
      currentContent,
      newContent,
      occurrences: isNewFile ? 1 : 0,
      error,
      isNewFile,
      bom: useBOM,
      encoding: detectedEncoding,
    };
  }

  /**
   * Handles the confirmation prompt for the Edit tool in the CLI.
   * It needs to calculate the diff to show the user.
   */
  async shouldConfirmExecute(
    abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    const mode = this.config.getApprovalMode();
    if (mode === ApprovalMode.AUTO_EDIT || mode === ApprovalMode.YOLO) {
      return false;
    }

    let editData: CalculatedEdit;
    try {
      editData = await this.calculateEdit(this.params, abortSignal);
    } catch (error) {
      if (abortSignal.aborted) {
        throw error;
      }
      const errorMsg = error instanceof Error ? error.message : String(error);
      debugLogger.warn(`Error preparing edit: ${errorMsg}`);
      return false;
    }

    if (editData.error) {
      debugLogger.warn(`Error: ${editData.error.display}`);
      return false;
    }

    const fileName = path.basename(this.params.file_path);
    const fileDiff = Diff.createPatch(
      fileName,
      editData.currentContent ?? '',
      editData.newContent,
      'Current',
      'Proposed',
      DEFAULT_DIFF_OPTIONS,
    );
    const ideClient = await IdeClient.getInstance();
    const ideConfirmation =
      this.config.getIdeMode() && ideClient.isDiffingEnabled()
        ? ideClient.openDiff(this.params.file_path, editData.newContent)
        : undefined;

    const confirmationDetails: ToolEditConfirmationDetails = {
      type: 'edit',
      title: `Confirm Edit: ${shortenPath(makeRelative(this.params.file_path, this.config.getTargetDir()))}`,
      fileName,
      filePath: this.params.file_path,
      fileDiff,
      originalContent: editData.currentContent,
      newContent: editData.newContent,
      onConfirm: async (outcome: ToolConfirmationOutcome) => {
        if (outcome === ToolConfirmationOutcome.ProceedAlways) {
          this.config.setApprovalMode(ApprovalMode.AUTO_EDIT);
        }

        if (ideConfirmation) {
          const result = await ideConfirmation;
          if (result.status === 'accepted' && result.content) {
            // TODO(chrstn): See https://github.com/google-gemini/gemini-cli/pull/5618#discussion_r2255413084
            // for info on a possible race condition where the file is modified on disk while being edited.
            this.params.old_string = editData.currentContent ?? '';
            this.params.new_string = result.content;
          }
        }
      },
      ideConfirmation,
    };
    return confirmationDetails;
  }

  getDescription(): string {
    const relativePath = makeRelative(
      this.params.file_path,
      this.config.getTargetDir(),
    );
    if (this.params.old_string === '') {
      return `Create ${shortenPath(relativePath)}`;
    }

    const oldStringSnippet =
      this.params.old_string.split('\n')[0].substring(0, 30) +
      (this.params.old_string.length > 30 ? '...' : '');
    const newStringSnippet =
      this.params.new_string.split('\n')[0].substring(0, 30) +
      (this.params.new_string.length > 30 ? '...' : '');

    if (this.params.old_string === this.params.new_string) {
      return `No file changes to ${shortenPath(relativePath)}`;
    }
    return `${shortenPath(relativePath)}: ${oldStringSnippet} => ${newStringSnippet}`;
  }

  /**
   * Executes the edit operation with the given parameters.
   * @param params Parameters for the edit operation
   * @returns Result of the edit operation
   */
  async execute(signal: AbortSignal): Promise<ToolResult> {
    let editData: CalculatedEdit;
    try {
      editData = await this.calculateEdit(this.params, signal);
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
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

    if (editData.error) {
      return {
        llmContent: editData.error.raw,
        returnDisplay: `Error: ${editData.error.display}`,
        error: {
          message: editData.error.raw,
          type: editData.error.type,
        },
      };
    }

    try {
      this.ensureParentDirectoriesExist(this.params.file_path);

      // For new files, apply default file encoding setting
      // For existing files, preserve the original encoding (BOM and charset)
      if (editData.isNewFile) {
        const useBOM =
          this.config.getDefaultFileEncoding() === FileEncoding.UTF8_BOM;
        await this.config.getFileSystemService().writeTextFile({
          path: this.params.file_path,
          content: editData.newContent,
          _meta: {
            bom: useBOM,
          },
        });
      } else {
        await this.config.getFileSystemService().writeTextFile({
          path: this.params.file_path,
          content: editData.newContent,
          _meta: {
            bom: editData.bom,
            encoding: editData.encoding,
          },
        });
      }

      const fileName = path.basename(this.params.file_path);
      const originallyProposedContent =
        this.params.ai_proposed_content || editData.newContent;
      const diffStat = getDiffStat(
        fileName,
        editData.currentContent ?? '',
        originallyProposedContent,
        editData.newContent,
      );

      const fileDiff = Diff.createPatch(
        fileName,
        editData.currentContent ?? '', // Should not be null here if not isNewFile
        editData.newContent,
        'Current',
        'Proposed',
        DEFAULT_DIFF_OPTIONS,
      );
      const displayResult = {
        fileDiff,
        fileName,
        originalContent: editData.currentContent,
        newContent: editData.newContent,
        diffStat,
      };

      // Log file operation for telemetry (without diff_stat to avoid double-counting)
      const mimetype = getSpecificMimeType(this.params.file_path);
      const programmingLanguage = getLanguageFromFilePath(
        this.params.file_path,
      );
      const extension = path.extname(this.params.file_path);
      const operation = editData.isNewFile
        ? FileOperation.CREATE
        : FileOperation.UPDATE;

      logFileOperation(
        this.config,
        new FileOperationEvent(
          EditTool.Name,
          operation,
          editData.newContent.split('\n').length,
          mimetype,
          extension,
          programmingLanguage,
        ),
      );

      const llmSuccessMessageParts = [
        editData.isNewFile
          ? `Created new file: ${this.params.file_path} with provided content.`
          : `The file: ${this.params.file_path} has been updated.`,
      ];

      const snippetResult = extractEditSnippet(
        editData.currentContent,
        editData.newContent,
      );
      if (snippetResult) {
        const snippetText = `Showing lines ${snippetResult.startLine}-${snippetResult.endLine} of ${snippetResult.totalLines} from the edited file:\n\n---\n\n${snippetResult.content}`;
        llmSuccessMessageParts.push(snippetText);
      }

      const fuzzyFeedback = getFuzzyMatchFeedback(
        editData.strategy,
        editData.matchRanges,
      );
      if (fuzzyFeedback) {
        llmSuccessMessageParts.push(fuzzyFeedback);
      }

      if (this.params.modified_by_user) {
        llmSuccessMessageParts.push(
          `User modified the \`new_string\` content to be: ${this.params.new_string}.`,
        );
      }

      return {
        llmContent: llmSuccessMessageParts.join(' '),
        returnDisplay: displayResult,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Error executing edit: ${errorMsg}`,
        returnDisplay: `Error writing file: ${errorMsg}`,
        error: {
          message: errorMsg,
          type: ToolErrorType.FILE_WRITE_FAILURE,
        },
      };
    }
  }

  /**
   * Creates parent directories if they don't exist
   */
  private ensureParentDirectoriesExist(filePath: string): void {
    const dirName = path.dirname(filePath);
    if (!fs.existsSync(dirName)) {
      fs.mkdirSync(dirName, { recursive: true });
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
  static readonly Name = ToolNames.EDIT;
  constructor(private readonly config: Config) {
    super(
      EditTool.Name,
      ToolDisplayNames.EDIT,
      `Replaces text within a file. By default, replaces a single occurrence. Set \`replace_all\` to true when you intend to modify every instance of \`old_string\`. This tool requires providing significant context around the change to ensure precise targeting. Always use the ${ReadFileTool.Name} tool to examine the file's current content before attempting a text replacement.

      The user has the ability to modify the \`new_string\` content. If modified, this will be stated in the response.

Expectation for required parameters:
1. \`file_path\` MUST be an absolute path; otherwise an error will be thrown.
2. \`old_string\` MUST be the exact literal text to replace (including all whitespace, indentation, newlines, and surrounding code etc.).
3. \`new_string\` MUST be the exact literal text to replace \`old_string\` with (also including all whitespace, indentation, newlines, and surrounding code etc.). Ensure the resulting code is correct and idiomatic.
4. NEVER escape \`old_string\` or \`new_string\`, that would break the exact literal text requirement.
**Important:** If ANY of the above are not satisfied, the tool will fail. CRITICAL for \`old_string\`: Must uniquely identify the single instance to change. Include at least 3 lines of context BEFORE and AFTER the target text, matching whitespace and indentation precisely. If this string matches multiple locations, or does not match exactly, the tool will fail.
**Multiple replacements:** Set \`replace_all\` to true when you want to replace every occurrence that matches \`old_string\`.`,
      Kind.Edit,
      {
        properties: {
          file_path: {
            description:
              "The absolute path to the file to modify. Must start with '/'.",
            type: 'string',
          },
          old_string: {
            description:
              'The exact literal text to replace, preferably unescaped. For single replacements (default), include at least 3 lines of context BEFORE and AFTER the target text, matching whitespace and indentation precisely. If this string is not the exact literal text (i.e. you escaped it) or does not match exactly, the tool will fail.',
            type: 'string',
          },
          new_string: {
            description:
              'The exact literal text to replace `old_string` with, preferably unescaped. Provide the EXACT text. Ensure the resulting code is correct and idiomatic.',
            type: 'string',
          },
          replace_all: {
            type: 'boolean',
            description:
              'Replace all occurrences of old_string (default false).',
          },
        },
        required: ['file_path', 'old_string', 'new_string'],
        type: 'object',
      },
    );
  }

  /**
   * Validates the parameters for the Edit tool
   * @param params Parameters to validate
   * @returns Error message string or null if valid
   */
  protected override validateToolParamValues(
    params: EditToolParams,
  ): string | null {
    if (!params.file_path) {
      return "The 'file_path' parameter must be non-empty.";
    }

    if (!path.isAbsolute(params.file_path)) {
      return `File path must be absolute: ${params.file_path}`;
    }

    const workspaceContext = this.config.getWorkspaceContext();
    if (!workspaceContext.isPathWithinWorkspace(params.file_path)) {
      const directories = workspaceContext.getDirectories();
      return `File path must be within one of the workspace directories: ${directories.join(', ')}`;
    }

    return null;
  }

  protected createInvocation(
    params: EditToolParams,
  ): ToolInvocation<EditToolParams, ToolResult> {
    return new EditToolInvocation(this.config, params);
  }

  getModifyContext(_: AbortSignal): ModifyContext<EditToolParams> {
    return {
      getFilePath: (params: EditToolParams) => params.file_path,
      getCurrentContent: async (params: EditToolParams): Promise<string> => {
        const fileExists = await isFilefileExists(params.file_path);
        if (fileExists) {
          try {
            const { content } = await this.config
              .getFileSystemService()
              .readTextFile({ path: params.file_path });
            return content;
          } catch (err) {
            if (!isNodeError(err) || err.code !== 'ENOENT') throw err;
            return '';
          }
        } else {
          return '';
        }
      },
      getProposedContent: async (params: EditToolParams): Promise<string> => {
        if (fs.existsSync(params.file_path)) {
          try {
            const { content: currentContent } = await this.config
              .getFileSystemService()
              .readTextFile({ path: params.file_path });
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
        } else {
          return '';
        }
      },
      createUpdatedParams: (
        oldContent: string,
        modifiedProposedContent: string,
        originalParams: EditToolParams,
      ): EditToolParams => ({
        ...originalParams,
        ai_proposed_content: oldContent,
        old_string: oldContent,
        new_string: modifiedProposedContent,
        modified_by_user: true,
      }),
    };
  }
}

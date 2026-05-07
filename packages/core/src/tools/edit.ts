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
import type { PermissionDecision } from '../permissions/types.js';
import { BaseDeclarativeTool, Kind, ToolConfirmationOutcome } from './tools.js';
import { ToolErrorType } from './tool-error.js';
import { makeRelative, shortenPath, unescapePath } from '../utils/paths.js';
import { isNodeError } from '../utils/errors.js';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import { isAutoMemPath } from '../memory/paths.js';
import {
  FileEncoding,
  needsUtf8Bom,
  detectLineEnding,
} from '../services/fileSystemService.js';
import type { LineEnding } from '../services/fileSystemService.js';
import { DEFAULT_DIFF_OPTIONS, getDiffStat } from './diffOptions.js';
import { checkPriorRead, StructuredToolError } from './priorReadEnforcement.js';
import { ReadFileTool } from './read-file.js';
import { createDebugLogger } from '../utils/debugLogger.js';
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
import { safeLiteralReplace } from '../utils/textUtils.js';
import {
  countOccurrences,
  extractEditSnippet,
  maybeAugmentOldStringForDeletion,
  normalizeEditStrings,
} from '../utils/editHelper.js';

const debugLogger = createDebugLogger('EDIT_PRIOR_READ');

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
  /** Original line ending style of the existing file */
  lineEnding: LineEnding;
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
  private async calculateEdit(params: EditToolParams): Promise<CalculatedEdit> {
    const replaceAll = params.replace_all ?? false;
    let currentContent: string | null = null;
    let fileExists = await isFilefileExists(params.file_path);
    let isNewFile = false;
    let finalNewString = params.new_string;
    let finalOldString = params.old_string;
    let occurrences = 0;
    let error:
      | { display: string; raw: string; type: ToolErrorType }
      | undefined = undefined;
    let useBOM = false;
    let detectedEncoding = 'utf-8';
    let detectedLineEnding: LineEnding = 'lf';
    // Prior-read enforcement runs before any content is read so that
    // the read pipeline below (and the content-derived error codes
    // it can produce — NO_OCCURRENCE_FOUND, EXPECTED_OCCURRENCE_MISMATCH,
    // NO_CHANGE) cannot be used as a read-less content oracle on a
    // file the model has never legitimately Read.
    //
    // Run unconditionally (not gated on `fileExists`): checkPriorRead
    // re-stats so a file that sprang into existence between
    // isFilefileExists() and here — the same TOCTOU window WriteFile
    // had — is now caught. ENOENT (genuinely absent) returns ok:true
    // and falls through to the new-file path; an existing file that
    // appeared in the race window is rejected as unread.
    if (!this.config.getFileReadCacheDisabled()) {
      const decision = await checkPriorRead(
        this.config.getFileReadCache(),
        params.file_path,
        'editing',
      );
      if (!decision.ok) {
        return {
          currentContent: null,
          newContent: '',
          occurrences: 0,
          error: {
            display: decision.displayMessage,
            raw: decision.rawMessage,
            type: decision.type,
          },
          isNewFile: false,
          encoding: 'utf-8',
          bom: false,
          lineEnding: 'lf',
        };
      }
    }
    if (fileExists) {
      try {
        const fileInfo = await this.config
          .getFileSystemService()
          .readTextFile({ path: params.file_path });
        if (fileInfo._meta?.bom !== undefined) {
          useBOM = fileInfo._meta.bom;
        } else {
          useBOM =
            fileInfo.content.length > 0 &&
            fileInfo.content.codePointAt(0) === 0xfeff;
        }
        detectedEncoding = fileInfo._meta?.encoding || 'utf-8';
        // Detect original line ending style before normalizing
        detectedLineEnding = detectLineEnding(fileInfo.content);
        // Normalize line endings to LF for consistent processing.
        currentContent = fileInfo.content.replace(/\r\n/g, '\n');
        fileExists = true;
        // Encoding and BOM are returned from the same I/O pass, avoiding redundant reads.
      } catch (err: unknown) {
        if (!isNodeError(err) || err.code !== 'ENOENT') {
          // Rethrow unexpected FS errors (permissions, etc.)
          throw err;
        }
        fileExists = false;
      }
    }

    // Post-read freshness re-check. The pre-read checkPriorRead above
    // and readTextFile are two separate syscalls; if the file is
    // modified between them, currentContent reflects post-write bytes
    // the model never saw and any edit applied to it would still be
    // a stale-write. Re-running checkPriorRead here closes the TOCTOU
    // window: a stale state now (mtime/size drifted) means we read
    // bytes the cache no longer trusts, and we reject before
    // returning a CalculatedEdit that the call sites would honour.
    if (fileExists && !this.config.getFileReadCacheDisabled()) {
      const postDecision = await checkPriorRead(
        this.config.getFileReadCache(),
        params.file_path,
        'editing',
        { expectExisting: true },
      );
      if (!postDecision.ok) {
        // Forensic trail for post-read TOCTOU rejections. These are
        // rare ("file changed between stat and read") and the model
        // self-heals by re-reading, so without a debug record an
        // operator investigating "why did this Edit fail once?" has
        // nothing to grep.
        debugLogger.warn('post-read TOCTOU rejection', {
          path: params.file_path,
          reason: postDecision.type,
        });
        return {
          currentContent: null,
          newContent: '',
          occurrences: 0,
          error: {
            display: postDecision.displayMessage,
            raw: postDecision.rawMessage,
            type: postDecision.type,
          },
          isNewFile: false,
          encoding: 'utf-8',
          bom: false,
          lineEnding: 'lf',
        };
      }
    }

    const normalizedStrings = normalizeEditStrings(
      currentContent,
      finalOldString,
      finalNewString,
    );
    finalOldString = normalizedStrings.oldString;
    finalNewString = normalizedStrings.newString;

    if (finalOldString === '' && !fileExists) {
      // Creating a new file
      isNewFile = true;
    } else if (!fileExists) {
      // Trying to edit a nonexistent file (and old_string is not empty)
      error = {
        display: `File not found. Cannot apply edit. Use an empty old_string to create a new file.`,
        raw: `File not found: ${params.file_path}`,
        type: ToolErrorType.FILE_NOT_FOUND,
      };
    } else if (currentContent !== null) {
      finalOldString = maybeAugmentOldStringForDeletion(
        currentContent,
        finalOldString,
        finalNewString,
      );

      occurrences = countOccurrences(currentContent, finalOldString);
      if (params.old_string === '') {
        // Error: Trying to create a file that already exists
        error = {
          display: `Failed to edit. Attempted to create a file that already exists.`,
          raw: `File already exists, cannot create: ${params.file_path}`,
          type: ToolErrorType.ATTEMPT_TO_CREATE_EXISTING_FILE,
        };
      } else if (occurrences === 0) {
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
      }
    } else {
      // Should not happen if fileExists and no exception was thrown, but defensively:
      error = {
        display: `Failed to read content of file.`,
        raw: `Failed to read content of existing file: ${params.file_path}`,
        type: ToolErrorType.READ_CONTENT_FAILURE,
      };
    }

    const newContent = !error
      ? applyReplacement(
          currentContent,
          finalOldString,
          finalNewString,
          isNewFile,
        )
      : (currentContent ?? '');

    if (!error && fileExists && currentContent === newContent) {
      error = {
        display:
          'No changes to apply. The new content is identical to the current content.',
        raw: `No changes to apply. The new content is identical to the current content in file: ${params.file_path}`,
        type: ToolErrorType.EDIT_NO_CHANGE,
      };
    }

    return {
      currentContent,
      newContent,
      occurrences,
      error,
      isNewFile,
      bom: useBOM,
      encoding: detectedEncoding,
      lineEnding: detectedLineEnding,
    };
  }

  /**
   * Edit operations always need user confirmation, except for managed
   * auto-memory files which are written autonomously by the model.
   */
  async getDefaultPermission(): Promise<PermissionDecision> {
    const projectRoot = this.config.getProjectRoot();
    if (isAutoMemPath(path.resolve(this.params.file_path), projectRoot)) {
      return 'allow';
    }
    return 'ask';
  }

  /**
   * Constructs the edit diff confirmation details.
   */
  async getConfirmationDetails(
    abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails> {
    let editData: CalculatedEdit;
    try {
      editData = await this.calculateEdit(this.params);
    } catch (error) {
      if (abortSignal.aborted) {
        throw error;
      }
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Error preparing edit: ${errorMsg}`);
    }

    if (editData.error) {
      // Use the full `raw` message, not the short `display` form:
      // the scheduler propagates `error.message` straight into the
      // model-facing tool response. `raw` carries the remediation
      // detail (file path, stale-vs-unread distinction, "without
      // offset / limit / pages" hint) that `execute()` already
      // surfaces — confirmation-required flows should not lose it.
      throw new StructuredToolError(editData.error.raw, editData.error.type);
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
      },
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
      editData = await this.calculateEdit(this.params);
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
      // Final pre-write freshness check. calculateEdit() ran a
      // post-read check, but execute() can be called arbitrarily
      // long after that (user approval, modify-and-confirm, etc.).
      // Between the post-read check and the writeTextFile below,
      // an external mutation could land and be silently overwritten.
      // This last guard tightens the window from "post-read →
      // writeTextFile (unbounded)" to "stat → writeTextFile (two
      // adjacent syscalls)".
      //
      // It does NOT eliminate the race. A concurrent writer that
      // lands between this stat and the writeTextFile call below
      // can still be clobbered — that residual is an OS-level
      // limitation of the stat-then-write pattern, and the only
      // way to close it is an atomic write (write to a temp file,
      // then rename) or a content-hash post-check that re-reads
      // the bytes after the write. Both are deferred to a follow-up
      // PR; operators who care about strict overwrite-protection
      // should set `fileReadCacheDisabled: true` and rely on
      // application-level locking.
      //
      // Run unconditionally (not gated on `editData.isNewFile`):
      // `isNewFile` was decided back in calculateEdit, but a file
      // could be created in the gap between then and now and a
      // confirmation-pending Edit would otherwise clobber it
      // without enforcement. ENOENT inside checkPriorRead returns
      // ok:true so genuine new-file creation is unaffected.
      if (!this.config.getFileReadCacheDisabled()) {
        const writeDecision = await checkPriorRead(
          this.config.getFileReadCache(),
          this.params.file_path,
          'editing',
          // For an in-place edit (`!isNewFile`), the file existed at
          // read time and must still exist now — an ENOENT here
          // means the original target disappeared and we should
          // reject rather than fall through to a new-file write
          // that would silently re-create a file from stale bytes.
          // For genuine new-file creation, ENOENT is the expected
          // pre-write state (ok:true → writeTextFile creates).
          { expectExisting: !editData.isNewFile },
        );
        if (!writeDecision.ok) {
          debugLogger.warn('pre-write TOCTOU rejection', {
            path: this.params.file_path,
            reason: writeDecision.type,
          });
          return {
            llmContent: writeDecision.rawMessage,
            returnDisplay: `Error: ${writeDecision.displayMessage}`,
            error: {
              message: writeDecision.rawMessage,
              type: writeDecision.type,
            },
          };
        }
      }

      // Create parent directories AFTER the pre-write enforcement
      // check passes. Doing it before would leak intermediate
      // directories on the failure path — a real (if minor) FS
      // litter that the previous order created on every rejected
      // edit.
      this.ensureParentDirectoriesExist(this.params.file_path);

      // For new files, apply default file encoding setting
      // For existing files, preserve the original encoding (BOM and charset)
      if (editData.isNewFile) {
        const userEncoding = this.config.getDefaultFileEncoding();
        let useBOM = false;
        if (userEncoding === FileEncoding.UTF8_BOM) {
          useBOM = true;
        } else if (userEncoding === undefined) {
          // No explicit setting: auto-detect (e.g. .ps1 on non-UTF-8 Windows)
          useBOM = needsUtf8Bom(this.params.file_path);
        }
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
            lineEnding: editData.lineEnding,
          },
        });
      }

      // Mark the cache entry written, capturing the post-write stats
      // so a follow-up Read sees `lastReadAt < lastWriteAt` and falls
      // through to the full pipeline instead of returning the
      // pre-edit placeholder. Best-effort: a stat failure here does
      // not undo the successful write — the next Read will simply
      // re-stat and treat the cache entry as stale.
      try {
        const postWriteStats = fs.statSync(this.params.file_path);
        this.config
          .getFileReadCache()
          .recordWrite(this.params.file_path, postWriteStats);
      } catch {
        // Non-fatal: leaving a stale entry is preferable to failing
        // the user-visible Edit on a transient stat failure. The
        // entry's mtime/size still does not match the on-disk bytes
        // post-write, so the next ReadFile will report stale and
        // refresh the entry.
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
    // Normalize shell-escaped paths (e.g. "my\ file.txt" → "my file.txt")
    // that may reach the LLM via at-completion or manual typing.
    params.file_path = unescapePath(params.file_path.trim());

    if (!params.file_path) {
      return "The 'file_path' parameter must be non-empty.";
    }

    if (!path.isAbsolute(params.file_path)) {
      return `File path must be absolute: ${params.file_path}`;
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

/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { writeContract } from '../codemode/contracts.js';
import {
  isFullFileRead,
  normalizeFileStateContent,
  isSameFileContent,
  readBaselineFor,
  type FileState,
} from '../utils/fileStateCache.js';
import { withFileWriteFeedback } from './file-write-feedback.js';
import {
  FileWriteContentChangedError,
  withFileWriteLock,
  pinFileWriteTarget,
  resolveFileWritePath,
} from '../utils/fileWriteTarget.js';
import { fileReadPermission } from '../permissions/file-read.js';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import * as Diff from 'diff';


import { WRITE_FILE_TOOL_NAME, WRITE_FILE_DISPLAY_NAME } from './tool-names.js';
import { getStructuredPatch } from './diff-utils.js';
import type { Config } from '../config/config.js';
import type { ToolUseContext } from './tool-types.js';

import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type FileDiff,
  type FileWriteResult,
  type ToolInvocation,
  type ToolLocation,
  type ToolResult,
} from './tools.js';
import { ToolErrorType } from './tool-error.js';
import { createToolParameterDiagnosticData } from './tool-parameter-diagnostics.js';
import { makeRelative, shortenPath } from '../utils/paths.js';
import { isFsTouchUnsafePath } from '../utils/pathShape.js';
import { isNodeError } from '../utils/errors.js';
import { DEFAULT_DIFF_OPTIONS, getDiffStat } from './diffOptions.js';
import type {
  ModifiableDeclarativeTool,
  ModifyContext,
} from './modifiable-tool.js';
import { CORE_TOOL_SET } from './definitions/coreTools.js';
import { runLogger } from '../utils/runLogger.js';
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
import { validateAutoMemoryWriteScope } from '../memory/structured-memory-store.js';
import { resolvePlanModeWritePath } from './plan-mode-memory-write.js';
import { resolvePromptBundleForModel } from '../prompts/bundle-resolver.js';
import { getWriteFileDescription } from './definitions/tool-prompts/write-file.js';

/**
 * Parameters for the WriteFile tool
 */
export interface WriteFileToolParams {
  /**
   * The absolute path to the file to write to
   */
  file_path: string;

  /**
   * The content to write to the file
   */
  content: string;

  /**
   * Whether the proposed content was modified by the user.
   */
  modified_by_user?: boolean;

  /**
   * Initially proposed content.
   */
  ai_proposed_content?: string;
}


/**
 * Error message used when a file was modified between validation and execution.
 */
export const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  'File has been modified since it was last read. Read it again before attempting to write it.';

/**
 * Reads the original content of a file for diff display purposes.
 * Also detects encoding and line endings for preservation during write.
 * No LLM content correction — the model's output is written as-is.
 */
async function readOriginalContent(
  _config: Config,
  filePath: string,
): Promise<{
  originalContent: string;
  fileExists: boolean;
  encoding: BufferEncoding;
  lineEndings: LineEndingType;
  notText?: NotTextReason;
  error?: { message: string; code?: string };
}> {
  try {
    // Use readFileWithMetadata to detect encoding and line endings
    // while reading the file content. This resolves symlinks automatically.
    const meta = readFileWithMetadata(filePath);
    return {
      originalContent: meta.content,
      fileExists: true,
      encoding: meta.encoding,
      lineEndings: meta.lineEndings,
      notText: meta.notText,
    };
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return {
        originalContent: '',
        fileExists: false,
        encoding: 'utf8',
        lineEndings: 'LF',
      };
    }
    // File exists but could not be read (permissions, etc.)
    return {
      originalContent: '',
      fileExists: true,
      encoding: 'utf8',
      lineEndings: 'LF',
      error: {
        message: isNodeError(err) ? err.message : String(err),
        code: isNodeError(err) ? err.code : undefined,
      },
    };
  }
}

interface PreparedWrite {
  originalContent: string;
  fileExists: boolean;
  isNewFile: boolean;
  encoding: BufferEncoding;
  lineEndings: LineEndingType;
}

type WritePreparationResult =
  | { prepared: PreparedWrite; error?: never }
  | { prepared?: never; error: ToolResult };

class WriteFileToolInvocation extends BaseToolInvocation<
  WriteFileToolParams,
  ToolResult
> {
  private readonly resolvedPath: string;

  constructor(
    private readonly config: Config,
    params: WriteFileToolParams,
    toolName?: string,
    displayName?: string,
  ) {
    super(params, toolName, displayName);

    this.resolvedPath = resolvePlanModeWritePath(
      this.config,
      this.params.file_path,
    );
    // Keep permission checks, hooks and execution on the same pinned target.
    this.params.file_path = this.resolvedPath;
  }

  override toolLocations(): ToolLocation[] {
    return [{ path: this.resolvedPath }];
  }

  override getDescription(): string {
    const relativePath = makeRelative(
      this.resolvedPath,
      this.config.getTargetDir(),
    );
    return shortenPath(relativePath);
  }

  /**
   * Performs the non-mutating checks required before a write can proceed.
   * This is called both before permission confirmation and again while the
   * write is being executed so mutable file state is never trusted across the
   * confirmation boundary.
   */
  private async prepareWrite(
    ctx?: ToolUseContext,
  ): Promise<WritePreparationResult> {
    const permission = await fileReadPermission(
      {
        signal: ctx?.signal ?? new AbortController().signal,
        ...ctx,
        config: this.config,
      },
      this.resolvedPath,
    );
    if (permission.denied) {
      const message = 'Read permission denied for this file.';
      return {
        error: {
          llmContent: message,
          returnDisplay: message,
          error: { message, type: ToolErrorType.FILE_WRITE_FAILURE },
        },
      };
    }

    const { content } = this.params;
    const fileReadState = ctx?.fileReadState ?? this.config.fileReadState;
    const result = await readOriginalContent(this.config, this.resolvedPath);

    if (result.error) {
      const errDetails = result.error;
      const errorMsg = errDetails.code
        ? `Error checking existing file '${this.resolvedPath}': ${errDetails.message} (${errDetails.code})`
        : `Error checking existing file: ${errDetails.message}`;
      return {
        error: {
          llmContent: errorMsg,
          returnDisplay: errorMsg,
          error: {
            message: errorMsg,
            type: ToolErrorType.FILE_WRITE_FAILURE,
          },
        },
      };
    }

    if (result.notText) {
      const message = notTextWriteRefusal(result.notText);
      return {
        error: {
          llmContent: message,
          returnDisplay: message,
          error: { message, type: ToolErrorType.FILE_NOT_TEXT },
        },
      };
    }

    const { originalContent, fileExists, encoding, lineEndings } = result;
    const isNewFile = !fileExists;

    // A full matching baseline can tolerate an mtime-only change.
    if (fileExists) {
      try {
        const lastWriteTime = Math.floor(
          fs.statSync(this.resolvedPath).mtimeMs,
        );
        const lastRead = readBaselineFor(
          fileReadState.get(this.resolvedPath),
          ctx?.resultConsumption,
        );
        if (
          !lastRead ||
          lastRead.isPartialView ||
          lastWriteTime > lastRead.timestamp
        ) {
          const isFullRead = lastRead && isFullFileRead(lastRead);
          // originalContent is CRLF-normalized (readFileWithMetadata returns LF
          // form), which matches readFileState's normalized form.
          if (
            (!isFullRead || !isSameFileContent(lastRead, originalContent)) &&
            !(
              !lastRead &&
              permission.autoAllowed &&
              path.extname(this.resolvedPath).toLowerCase() !== '.ipynb'
            )
          ) {
            const unread = !lastRead || lastRead.isPartialView;
            const message = unread
              ? 'File has not been read yet. Read it first before writing to it.'
              : FILE_UNEXPECTEDLY_MODIFIED_ERROR;
            return {
              error: {
                llmContent: message,
                returnDisplay: message,
                error: {
                  message,
                  type: unread
                    ? ToolErrorType.FILE_WRITE_FAILURE
                    : ToolErrorType.FILE_UNEXPECTEDLY_MODIFIED,
                },
              },
            };
          }
        }
      } catch (error) {
        const message = `Cannot verify file before writing: ${error}`;
        return {
          error: {
            llmContent: message,
            returnDisplay: message,
            error: { message, type: ToolErrorType.FILE_WRITE_FAILURE },
          },
        };
      }
    }

    // For existing files, only block invalid settings if the original was
    // valid, so Write can still be used to repair an already-invalid file.
    const afterError = this.config.validateSettingsContent(
      this.resolvedPath,
      content,
    );
    if (
      afterError &&
      (isNewFile ||
        !this.config.validateSettingsContent(
          this.resolvedPath,
          originalContent,
        ))
    ) {
      return {
        error: {
          llmContent: `Settings validation failed:\n${afterError}`,
          returnDisplay: `Error: Settings validation failed.`,
          error: {
            message: afterError,
            type: ToolErrorType.SETTINGS_VALIDATION_FAILED,
          },
        },
      };
    }

    const scopeError = validateAutoMemoryWriteScope(
      this.resolvedPath,
      content,
      this.config,
    );
    if (scopeError) {
      return {
        error: {
          llmContent: scopeError,
          returnDisplay: `Error: Memory written to the wrong scope directory.`,
          error: {
            message: scopeError,
            type: ToolErrorType.FILE_WRITE_FAILURE,
          },
        },
      };
    }

    return {
      prepared: {
        originalContent,
        fileExists,
        isNewFile,
        encoding,
        lineEndings,
      },
    };
  }

  async validateBeforePermission(
    ctx: ToolUseContext,
  ): Promise<ToolResult | undefined> {
    const result = await this.prepareWrite(ctx);
    return result.error;
  }

  /**
   * Execute logic:
   * 1. Validate path access
   * 2. Second staleness check (close the race window between validation and execution)
   * 3. Read original file content with metadata (encoding, line endings)
   * 4. Ensure parent directory exists
   * 5. Write content via atomic write, preserving encoding and line endings
   * 6. Return structured result for UI (FileDiff) and simple message for LLM
   */
  async execute(abortSignal: AbortSignal): Promise<ToolResult> {
    activateConditionalSkillsForPath(this.config, this.resolvedPath);
    const result = await this._executeInternal({
      signal: abortSignal,
      fileReadState: this.config.fileReadState,
    });
    return result;
  }

  override async executeWithContext(ctx: ToolUseContext): Promise<ToolResult> {
    activateConditionalSkillsForPath(this.config, this.resolvedPath);
    return this._executeInternal(ctx);
  }

  private async _executeInternal(
    ctx?: ToolUseContext,
    target?: ReturnType<typeof pinFileWriteTarget>,
  ): Promise<ToolResult> {
    const preparation = await this.prepareWrite(ctx);
    if (preparation.error) return preparation.error;

    const expectedPath = resolveFileWritePath(this.resolvedPath);
    const { modified_by_user } = this.params;
    const fileReadState = ctx?.fileReadState ?? this.config.fileReadState;
    const { originalContent, fileExists, isNewFile, encoding, lineEndings } =
      preparation.prepared;
    const content = preserveBOM(originalContent, this.params.content);

    try {
      if (!target) {
        if (ctx?.fileHistory && ctx.messageId)
          await ctx.fileHistory.trackEdit(this.resolvedPath, ctx.messageId);
        return await withFileWriteLock(this.resolvedPath, ctx?.signal, () =>
          this._executeInternal(
            ctx,
            pinFileWriteTarget(this.resolvedPath, expectedPath),
          ),
        );
      }

      // Ensure the parent exists while holding the write queue.
      const dirName = path.dirname(this.resolvedPath);
      try {
        await fsPromises.access(dirName);
      } catch {
        await fsPromises.mkdir(dirName, { recursive: true });
      }

      // Write content via atomic write (temp file + rename), preserving the
      // original file's encoding and line endings for existing files.
      // For new files, use utf8 encoding with LF line endings.
      await writeTextContent(
        target.ioPath,
        content,
        isNewFile ? 'utf8' : encoding,
        isNewFile ? 'LF' : lineEndings,
        () => {
          ctx?.signal.throwIfAborted();
          target.recheckBeforeWrite();
          if (!fileExists) return;
          const beforeWrite = readFileWithMetadata(this.resolvedPath);
          if (beforeWrite.notText)
            throw new FileNotTextError(beforeWrite.notText);
          if (beforeWrite.content !== originalContent)
            throw new FileWriteContentChangedError(
              FILE_UNEXPECTEDLY_MODIFIED_ERROR,
            );
        },
      );

      // Update file state cache to invalidate stale writes.
      // After writing, record the new content and timestamp so that subsequent
      // write/edit tools can detect if the file was modified externally.
      let writtenState: FileState | undefined;
      try {
        const postWriteStat = await fsPromises.stat(this.resolvedPath);
        const fileStateCache = fileReadState;
        fileStateCache.set(this.resolvedPath, {
          content: normalizeFileStateContent(content),
          contentNotInModelContext:
            modified_by_user === true || ctx?.inputModifiedByHook === true,
          timestamp: Math.floor(postWriteStat.mtimeMs),
          offset: undefined,
          limit: undefined,
        });
        writtenState = fileReadState.get(this.resolvedPath);
      } catch {
        fileReadState.delete(this.resolvedPath);
        // Non-fatal: if we can't update the cache, subsequent writes may
        // require an extra read but the write itself succeeded.
      }

      // Fire FileChanged hook (fire-and-forget, observability only)
      void this.config
        .getHookSystem()
        ?.fireFileChangedEvent(this.resolvedPath, isNewFile ? 'add' : 'change')
        .catch((err) => runLogger.debug(`FileChanged hook error: ${err}`));
      // Generate diff for display result
      const fileName = path.basename(this.resolvedPath);
      const fileDiff = Diff.createPatch(
        fileName,
        isNewFile ? '' : originalContent,
        content,
        'Original',
        'Written',
        DEFAULT_DIFF_OPTIONS,
      );

      const diffStat = getDiffStat(
        fileName,
        isNewFile ? '' : originalContent,
        content,
        content,
      );

      // LLM receives a simple success message, not a diff snippet.
      let llmContent: string;
      if (isNewFile) {
        llmContent = `File created successfully at: ${this.resolvedPath}`;
      } else {
        llmContent = `The file ${this.resolvedPath} has been updated successfully.`;
      }

      // If user modified content, append that info
      if (modified_by_user) {
        llmContent += ` User modified the \`content\` to be: ${content}`;
      }
      if (ctx?.inputModifiedByHook) {
        llmContent +=
          ' A hook modified the write parameters. Read the affected code before relying on its contents.';
      }

      const displayResult: FileDiff = {
        fileDiff,
        fileName,
        filePath: this.resolvedPath,
        originalContent: isNewFile ? null : originalContent,
        newContent: content,
        diffStat,
        isNewFile,
      };
      const toolUseResult: FileWriteResult = {
        type: isNewFile ? 'create' : 'update',
        filePath: this.resolvedPath,
        content,
        structuredPatch: isNewFile
          ? []
          : getStructuredPatch(fileName, originalContent, content, 'Written'),
        originalFile: isNewFile ? null : originalContent,
      };

      return withFileWriteFeedback(
        {
          llmContent,
          returnDisplay: displayResult,
          toolUseResult,
          fileWrite: {
            filePath: this.resolvedPath,
            workspacePath: this.config.getTargetDir(),
            originalContent: isNewFile ? '' : originalContent,
            proposedContent:
              this.params.modified_by_user &&
              this.params.ai_proposed_content !== undefined
                ? this.params.ai_proposed_content
                : content,
            writtenContent: content,
          },
        },
        fileReadState,
        this.resolvedPath,
        writtenState,
      );
    } catch (error) {
      if (ctx?.signal.aborted) throw error;
      let errorMsg: string;
      let errorType =
        error instanceof FileWriteContentChangedError
          ? ToolErrorType.FILE_UNEXPECTEDLY_MODIFIED
          : ToolErrorType.FILE_WRITE_FAILURE;

      if (error instanceof FileNotTextError) {
        errorMsg = error.message;
        errorType = ToolErrorType.FILE_NOT_TEXT;
      } else if (isNodeError(error)) {
        errorMsg = `Error writing to file '${this.resolvedPath}': ${error.message} (${error.code})`;

        if (error.code === 'EACCES') {
          errorMsg = `Permission denied writing to file: ${this.resolvedPath} (${error.code})`;
          errorType = ToolErrorType.PERMISSION_DENIED;
        } else if (error.code === 'ENOSPC') {
          errorMsg = `No space left on device: ${this.resolvedPath} (${error.code})`;
          errorType = ToolErrorType.NO_SPACE_LEFT;
        } else if (error.code === 'EISDIR') {
          errorMsg = `Target is a directory, not a file: ${this.resolvedPath} (${error.code})`;
          errorType = ToolErrorType.TARGET_IS_DIRECTORY;
        }
      } else if (error instanceof Error) {
        errorMsg = `Error writing to file: ${error.message}`;
      } else {
        errorMsg = `Error writing to file: ${String(error)}`;
      }

      return {
        llmContent: errorMsg,
        returnDisplay: errorMsg,
        error: {
          message: errorMsg,
          type: errorType,
        },
      };
    }
  }
}

/**
 * Implementation of the WriteFile tool logic
 */
export class WriteFileTool
  extends BaseDeclarativeTool<WriteFileToolParams, ToolResult>
  implements ModifiableDeclarativeTool<WriteFileToolParams>
{
  static readonly Name = WRITE_FILE_TOOL_NAME;
  override get programmatic() {
    return writeContract;
  }

  constructor(private readonly config: Config) {
    super(
      WriteFileTool.Name,
      WRITE_FILE_DISPLAY_NAME,
      CORE_TOOL_SET.Write.description!,
      Kind.Edit,
      CORE_TOOL_SET.Write.parametersJsonSchema,
      true,
      false,
    );
  }

  override getSchema(modelId?: string) {
    return {
      ...CORE_TOOL_SET.Write,
      description: getWriteFileDescription(
        false,
        resolvePromptBundleForModel(modelId),
      ),
    };
  }

  override validateToolParams(params: WriteFileToolParams): string | null {
    if (params.content !== undefined && typeof params.content !== 'string') {
      return 'params/content must be string';
    }

    return super.validateToolParams(params);
  }

  /**
   * Validates file_path presence and detects directory collisions.
   * Runtime read-state checks run before permission and again during execution.
   */
  protected override validateToolParamValues(
    params: WriteFileToolParams,
  ): string | null {
    const filePath = params.file_path;

    if (!filePath) {
      return `Missing or empty "file_path"`;
    }

    const resolvedPath = resolvePlanModeWritePath(this.config, filePath);

    // SECURITY: not a verdict — an fs-touch avoidance. The checks below call
    // existsSync/statSync, which on a network path performs the SMB/NTLM
    // handshake, and this runs before the permission layer has decided
    // anything. The permission layer denies network writes outright.
    if (isFsTouchUnsafePath(filePath) || isFsTouchUnsafePath(resolvedPath)) {
      return null;
    }

    try {
      if (fs.existsSync(resolvedPath)) {
        const stats = fs.lstatSync(resolvedPath);
        if (stats.isDirectory()) {
          return `Path is a directory, not a file: ${resolvedPath}`;
        }
      }
    } catch (statError: unknown) {
      return `Error accessing path properties for validation: ${resolvedPath}. Reason: ${
        statError instanceof Error ? statError.message : String(statError)
      }`;
    }

    return null;
  }

  protected override createCustomParameterValidationDiagnostic(
    params: WriteFileToolParams,
    validationError: string,
  ) {
    let constraintCategory: string | undefined;
    if (validationError === 'Missing or empty "file_path"') {
      constraintCategory = 'presence';
    } else if (validationError.startsWith('Path is a directory, not a file:')) {
      constraintCategory = 'path_kind';
    } else if (
      validationError.startsWith(
        'Error accessing path properties for validation:',
      )
    ) {
      constraintCategory = 'path_access';
    }

    if (constraintCategory) {
      return createToolParameterDiagnosticData('file_precondition', {
        validation_source: 'custom',
        parameter_path: 'params.file_path',
        constraint_category: constraintCategory,
        quality: 'precise',
        validation_phase: 'build',
      });
    }
    return super.createCustomParameterValidationDiagnostic(
      params,
      validationError,
    );
  }

  protected createInvocation(
    params: WriteFileToolParams,
  ): ToolInvocation<WriteFileToolParams, ToolResult> {
    return new WriteFileToolInvocation(
      this.config,
      params,
      this.name,
      this.displayName,
    );
  }

  override isConcurrencySafe(_input?: WriteFileToolParams): boolean {
    return false;
  }

  override isDestructive(_input?: WriteFileToolParams): boolean {
    return true;
  }

  // === Permission Pipeline methods ===

  /**
   * No LLM content correction. Proposed content is the raw
   * model output; current content is read directly from disk.
   */
  getModifyContext(
    _abortSignal: AbortSignal,
  ): ModifyContext<WriteFileToolParams> {
    return {
      getFilePath: (params: WriteFileToolParams) => params.file_path,
      getCurrentContent: async (params: WriteFileToolParams) => {
        const result = await readOriginalContent(this.config, params.file_path);
        return result.originalContent;
      },
      getProposedContent: async (params: WriteFileToolParams) =>
        // No LLM correction, return raw content as-is
        params.content,
      createUpdatedParams: (
        _oldContent: string,
        modifiedProposedContent: string,
        originalParams: WriteFileToolParams,
      ) => {
        const content = originalParams.content;
        return {
          ...originalParams,
          ai_proposed_content: content,
          content: modifiedProposedContent,
          modified_by_user: true,
        };
      },
    };
  }
}

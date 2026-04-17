/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import * as Diff from 'diff';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import { isAutoMemPath } from '../memory/paths.js';
import type {
  FileDiff,
  ToolCallConfirmationDetails,
  ToolEditConfirmationDetails,
  ToolInvocation,
  ToolLocation,
  ToolResult,
} from './tools.js';
import type { PermissionDecision } from '../permissions/types.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  ToolConfirmationOutcome,
} from './tools.js';
import { ToolErrorType } from './tool-error.js';
import {
  FileEncoding,
  needsUtf8Bom,
  detectLineEnding,
} from '../services/fileSystemService.js';
import type { LineEnding } from '../services/fileSystemService.js';
import { makeRelative, shortenPath } from '../utils/paths.js';
import { getErrorMessage, isNodeError } from '../utils/errors.js';
import { DEFAULT_DIFF_OPTIONS, getDiffStat } from './diffOptions.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type {
  ModifiableDeclarativeTool,
  ModifyContext,
} from './modifiable-tool.js';
import { logFileOperation } from '../telemetry/loggers.js';
import { FileOperationEvent } from '../telemetry/types.js';
import { FileOperation } from '../telemetry/metrics.js';
import {
  getSpecificMimeType,
  fileExists as isFilefileExists,
} from '../utils/fileUtils.js';
import { getLanguageFromFilePath } from '../utils/language-detection.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('WRITE_FILE');

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

class WriteFileToolInvocation extends BaseToolInvocation<
  WriteFileToolParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: WriteFileToolParams,
  ) {
    super(params);
  }

  override toolLocations(): ToolLocation[] {
    return [{ path: this.params.file_path }];
  }

  override getDescription(): string {
    const relativePath = makeRelative(
      this.params.file_path,
      this.config.getTargetDir(),
    );
    return `Writing to ${shortenPath(relativePath)}`;
  }

  /**
   * Write operations always need user confirmation, except for managed
   * auto-memory files which are written autonomously by the model.
   */
  override async getDefaultPermission(): Promise<PermissionDecision> {
    const projectRoot = this.config.getProjectRoot();
    if (isAutoMemPath(path.resolve(this.params.file_path), projectRoot)) {
      return 'allow';
    }
    return 'ask';
  }

  /**
   * Constructs the write-file diff confirmation details.
   */
  override async getConfirmationDetails(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails> {
    let originalContent = '';
    const fileExists = await isFilefileExists(this.params.file_path);
    if (fileExists) {
      try {
        const { content } = await this.config
          .getFileSystemService()
          .readTextFile({ path: this.params.file_path });
        originalContent = content;
      } catch (err) {
        throw new Error(
          `Error reading existing file for confirmation: ${getErrorMessage(err)}`,
        );
      }
    }

    const relativePath = makeRelative(
      this.params.file_path,
      this.config.getTargetDir(),
    );
    const fileName = path.basename(this.params.file_path);

    const fileDiff = Diff.createPatch(
      fileName,
      originalContent, // Original content (empty if new file or unreadable)
      this.params.content, // Content after potential correction
      'Current',
      'Proposed',
      DEFAULT_DIFF_OPTIONS,
    );

    const confirmationDetails: ToolEditConfirmationDetails = {
      type: 'edit',
      title: `Confirm Write: ${shortenPath(relativePath)}`,
      fileName,
      filePath: this.params.file_path,
      fileDiff,
      originalContent,
      newContent: this.params.content,
      onConfirm: async (outcome: ToolConfirmationOutcome) => {
        if (outcome === ToolConfirmationOutcome.ProceedAlways) {
          this.config.setApprovalMode(ApprovalMode.AUTO_EDIT);
        }
      },
    };
    return confirmationDetails;
  }

  async execute(_abortSignal: AbortSignal): Promise<ToolResult> {
    const { file_path, content, ai_proposed_content, modified_by_user } =
      this.params;

    let fileExists = await isFilefileExists(file_path);
    let originalContent = '';
    let useBOM = false;
    let detectedEncoding: string | undefined;
    let detectedLineEnding: LineEnding | undefined;
    const dirName = path.dirname(file_path);
    if (fileExists) {
      try {
        const fileInfo = await this.config
          .getFileSystemService()
          .readTextFile({ path: file_path });
        if (fileInfo._meta?.bom !== undefined) {
          useBOM = fileInfo._meta.bom;
        } else {
          useBOM =
            fileInfo.content.length > 0 &&
            fileInfo.content.codePointAt(0) === 0xfeff;
        }
        detectedEncoding = fileInfo._meta?.encoding || 'utf-8';
        detectedLineEnding = detectLineEnding(fileInfo.content);
        originalContent = fileInfo.content;
        fileExists = true; // File exists and was read
      } catch (err) {
        if (isNodeError(err) && err.code === 'ENOENT') {
          fileExists = false;
        } else {
          const error = {
            message: getErrorMessage(err),
            code: isNodeError(err) ? err.code : undefined,
          };
          const errorMsg = error.code
            ? `Error checking existing file '${file_path}': ${error.message} (${error.code})`
            : `Error checking existing file: ${error.message}`;
          return {
            llmContent: errorMsg,
            returnDisplay: errorMsg,
            error: {
              message: errorMsg,
              type: ToolErrorType.FILE_WRITE_FAILURE,
            },
          };
        }
      }
    }

    if (!fileExists) {
      fs.mkdirSync(dirName, { recursive: true });
      const userEncoding = this.config.getDefaultFileEncoding();
      if (userEncoding === FileEncoding.UTF8_BOM) {
        // User explicitly configured UTF-8 BOM for all new files
        useBOM = true;
      } else if (userEncoding === undefined) {
        // No explicit setting: auto-detect based on platform/extension.
        // e.g. .ps1 on Windows with a non-UTF-8 code page needs BOM so
        // PowerShell 5.1 reads the file as UTF-8 instead of the system ANSI page
        useBOM = needsUtf8Bom(file_path);
      }
      // else: user explicitly set 'utf-8' (no BOM) — respect it
      detectedEncoding = undefined;
    }

    try {
      await this.config.getFileSystemService().writeTextFile({
        path: file_path,
        content,
        _meta: {
          bom: useBOM,
          encoding: detectedEncoding,
          lineEnding: detectedLineEnding,
        },
      });

      // Generate diff for display result
      const fileName = path.basename(file_path);
      // If there was a readError, originalContent in correctedContentResult is '',
      // but for the diff, we want to show the original content as it was before the write if possible.
      // However, if it was unreadable, currentContentForDiff will be empty.
      const currentContentForDiff = originalContent;

      const fileDiff = Diff.createPatch(
        fileName,
        currentContentForDiff,
        content,
        'Original',
        'Written',
        DEFAULT_DIFF_OPTIONS,
      );

      const originallyProposedContent = ai_proposed_content || content;
      const diffStat = getDiffStat(
        fileName,
        currentContentForDiff,
        originallyProposedContent,
        content,
      );

      const llmSuccessMessageParts = [
        !fileExists
          ? `Successfully created and wrote to new file: ${file_path}.`
          : `Successfully overwrote file: ${file_path}.`,
      ];
      if (modified_by_user) {
        llmSuccessMessageParts.push(
          `User modified the \`content\` to be: ${content}`,
        );
      }

      // Log file operation for telemetry (without diff_stat to avoid double-counting)
      const mimetype = getSpecificMimeType(file_path);
      const programmingLanguage = getLanguageFromFilePath(file_path);
      const extension = path.extname(file_path);
      const operation = !fileExists
        ? FileOperation.CREATE
        : FileOperation.UPDATE;

      const lineCount = content.split('\n').length;
      logFileOperation(
        this.config,
        new FileOperationEvent(
          WriteFileTool.Name,
          operation,
          lineCount,
          mimetype,
          extension,
          programmingLanguage,
        ),
      );

      const displayResult: FileDiff = {
        fileDiff,
        fileName,
        originalContent,
        newContent: content,
        diffStat,
      };

      return {
        llmContent: llmSuccessMessageParts.join(' '),
        returnDisplay: displayResult,
      };
    } catch (error) {
      // Capture detailed error information for debugging
      let errorMsg: string;
      let errorType = ToolErrorType.FILE_WRITE_FAILURE;

      if (isNodeError(error)) {
        // Handle specific Node.js errors with their error codes
        errorMsg = `Error writing to file '${file_path}': ${error.message} (${error.code})`;

        // Log specific error types for better debugging
        if (error.code === 'EACCES') {
          errorMsg = `Permission denied writing to file: ${file_path} (${error.code})`;
          errorType = ToolErrorType.PERMISSION_DENIED;
        } else if (error.code === 'ENOSPC') {
          errorMsg = `No space left on device: ${file_path} (${error.code})`;
          errorType = ToolErrorType.NO_SPACE_LEFT;
        } else if (error.code === 'EISDIR') {
          errorMsg = `Target is a directory, not a file: ${file_path} (${error.code})`;
          errorType = ToolErrorType.TARGET_IS_DIRECTORY;
        }

        // Include stack trace in debug mode for better troubleshooting
        if (this.config.getDebugMode() && error.stack) {
          debugLogger.debug('Write file error stack:', error.stack);
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
  static readonly Name: string = ToolNames.WRITE_FILE;

  constructor(private readonly config: Config) {
    super(
      WriteFileTool.Name,
      ToolDisplayNames.WRITE_FILE,
      `Writes content to a specified file in the local filesystem.

      The user has the ability to modify \`content\`. If modified, this will be stated in the response.`,
      Kind.Edit,
      {
        properties: {
          file_path: {
            description:
              "The absolute path to the file to write to (e.g., '/home/user/project/file.txt'). Relative paths are not supported.",
            type: 'string',
          },
          content: {
            description: 'The content to write to the file.',
            type: 'string',
          },
        },
        required: ['file_path', 'content'],
        type: 'object',
      },
    );
  }

  protected override validateToolParamValues(
    params: WriteFileToolParams,
  ): string | null {
    const filePath = params.file_path;

    if (!filePath) {
      return `Missing or empty "file_path"`;
    }

    if (!path.isAbsolute(filePath)) {
      return `File path must be absolute: ${filePath}`;
    }

    try {
      if (fs.existsSync(filePath)) {
        const stats = fs.lstatSync(filePath);
        if (stats.isDirectory()) {
          return `Path is a directory, not a file: ${filePath}`;
        }
      }
    } catch (statError: unknown) {
      return `Error accessing path properties for validation: ${filePath}. Reason: ${
        statError instanceof Error ? statError.message : String(statError)
      }`;
    }

    return null;
  }

  protected createInvocation(
    params: WriteFileToolParams,
  ): ToolInvocation<WriteFileToolParams, ToolResult> {
    return new WriteFileToolInvocation(this.config, params);
  }

  getModifyContext(
    _abortSignal: AbortSignal,
  ): ModifyContext<WriteFileToolParams> {
    return {
      getFilePath: (params: WriteFileToolParams) => params.file_path,
      getCurrentContent: async (params: WriteFileToolParams) => {
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
      getProposedContent: async (params: WriteFileToolParams) => params.content,
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

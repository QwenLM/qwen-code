/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { makeRelative, shortenPath } from '../utils/paths.js';
import type { ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import { ToolErrorType } from './tool-error.js';
import type { Config } from '../config/config.js';
import { FileOperation } from '../telemetry/metrics.js';
import { getProgrammingLanguage } from '../telemetry/telemetry-utils.js';
import { logFileOperation } from '../telemetry/loggers.js';
import { FileOperationEvent } from '../telemetry/types.js';

/**
 * Parameters for the PDF reader tool
 */
export interface PDFReaderToolParams {
  /**
   * The absolute path to the PDF file to read
   */
  file_path: string;
}

/**
 * Implementation of the PDF reader tool
 */
class PDFReaderToolInvocation extends BaseToolInvocation<
  PDFReaderToolParams,
  ToolResult
> {
  constructor(
    private config: Config,
    params: PDFReaderToolParams,
  ) {
    super(params);
  }

  getDescription(): string {
    const relativePath = makeRelative(
      this.params.file_path,
      this.config.getTargetDir(),
    );
    return `PDF Reader: ${shortenPath(relativePath)}`;
  }

  async execute(): Promise<ToolResult> {
    // Validate the file path
    if (!this.params.file_path || this.params.file_path.trim() === '') {
      return {
        llmContent:
          'Error: file_path parameter is required and cannot be empty.',
        returnDisplay:
          'Error: file_path parameter is required and cannot be empty.',
        error: {
          message: 'file_path parameter is required and cannot be empty',
          type: ToolErrorType.INVALID_TOOL_PARAMS,
        },
      };
    }

    const filePath = path.resolve(this.params.file_path);

    // Verify the file is within workspace
    const workspaceContext = this.config.getWorkspaceContext();
    const projectTempDir = this.config.storage.getProjectTempDir();
    const resolvedProjectTempDir = path.resolve(projectTempDir);
    const isWithinTempDir =
      filePath.startsWith(resolvedProjectTempDir + path.sep) ||
      filePath === resolvedProjectTempDir;

    if (!workspaceContext.isPathWithinWorkspace(filePath) && !isWithinTempDir) {
      const directories = workspaceContext.getDirectories();
      return {
        llmContent: `Error: File path must be within one of the workspace directories: ${directories.join(', ')} or within the project temp directory: ${projectTempDir}`,
        returnDisplay: `Error: File path must be within one of the workspace directories: ${directories.join(', ')} or within the project temp directory: ${projectTempDir}`,
        error: {
          message: 'File path is not within allowed directories',
          type: ToolErrorType.PATH_NOT_IN_WORKSPACE,
        },
      };
    }

    try {
      // Check if file exists
      await fs.access(filePath);

      // Check if it's actually a PDF file
      const fileBuffer = await fs.readFile(filePath);
      const fileHeader = fileBuffer.slice(0, 4).toString();
      if (fileHeader !== '%PDF') {
        return {
          llmContent: 'Error: The specified file is not a valid PDF file.',
          returnDisplay: 'Error: The specified file is not a valid PDF file.',
          error: {
            message: 'The specified file is not a valid PDF file',
            type: ToolErrorType.READ_CONTENT_FAILURE,
          },
        };
      }

      // Import pdf-parse dynamically to avoid adding it as a dependency if it's not available
      let pdfParse: typeof import('pdf-parse');
      try {
        pdfParse = await import('pdf-parse');
      } catch (_error) {
        return {
          llmContent:
            'Error: pdf-parse library is not available. PDF Reader tool requires pdf-parse to be installed as a dependency.',
          returnDisplay:
            'Error: pdf-parse library is not available. PDF Reader tool requires pdf-parse to be installed as a dependency.',
          error: {
            message: 'pdf-parse library is not available',
            type: ToolErrorType.EXECUTION_FAILED,
          },
        };
      }

      // Parse the PDF
      const pdfData = await pdfParse.default(fileBuffer);
      const text = pdfData.text;

      // Log file operation
      const lines = text.split('\n').length;
      logFileOperation(
        this.config,
        new FileOperationEvent(
          PDFReaderTool.Name,
          FileOperation.READ,
          lines,
          'application/pdf',
          path.extname(filePath),
          getProgrammingLanguage({
            absolute_path: filePath,
          }),
        ),
      );

      // Return the extracted text content
      return {
        llmContent: text,
        returnDisplay: `Successfully read PDF file: ${path.basename(filePath)}. Extracted ${text.length} characters.`,
      };
    } catch (error: unknown) {
      console.error('PDF Reader Tool Error:', error);
      let errorMessage = 'Error reading PDF file';
      if (error instanceof Error && error.message) {
        errorMessage += `: ${error.message}`;
      }

      return {
        llmContent: `Error: ${errorMessage}`,
        returnDisplay: `Error reading PDF file: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: ToolErrorType.READ_CONTENT_FAILURE,
        },
      };
    }
  }
}

/**
 * PDF reader tool that extracts text from PDF files
 */
export class PDFReaderTool extends BaseDeclarativeTool<
  PDFReaderToolParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.PDF_READER;

  constructor(private config: Config) {
    super(
      PDFReaderTool.Name,
      ToolDisplayNames.PDF_READER,
      'Extracts and returns the text content from a specified PDF file. This tool provides direct access to the textual content of PDF documents, making it ideal for processing and analyzing PDF-based information.',
      Kind.Read,
      {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description:
              "The absolute path to the PDF file to read (e.g., '/home/user/document.pdf'). Relative paths are not supported. You must provide an absolute path.",
          },
        },
        required: ['file_path'],
        additionalProperties: false,
      },
    );
  }

  protected override validateToolParamValues(
    params: PDFReaderToolParams,
  ): string | null {
    if (!params.file_path) {
      return 'Parameter "file_path" is required.';
    }

    if (
      typeof params.file_path !== 'string' ||
      params.file_path.trim() === ''
    ) {
      return 'Parameter "file_path" must be a non-empty string.';
    }

    if (!path.isAbsolute(params.file_path)) {
      return `File path must be absolute, but was relative: ${params.file_path}. You must provide an absolute path.`;
    }

    if (!params.file_path.toLowerCase().endsWith('.pdf')) {
      return `File path must be a PDF file, but was: ${params.file_path}.`;
    }

    const workspaceContext = this.config.getWorkspaceContext();
    const projectTempDir = this.config.storage.getProjectTempDir();
    const resolvedFilePath = path.resolve(params.file_path);
    const resolvedProjectTempDir = path.resolve(projectTempDir);
    const isWithinTempDir =
      resolvedFilePath.startsWith(resolvedProjectTempDir + path.sep) ||
      resolvedFilePath === resolvedProjectTempDir;

    if (
      !workspaceContext.isPathWithinWorkspace(params.file_path) &&
      !isWithinTempDir
    ) {
      const directories = workspaceContext.getDirectories();
      return `File path must be within one of the workspace directories: ${directories.join(', ')} or within the project temp directory: ${projectTempDir}`;
    }

    const fileService = this.config.getFileService();
    if (fileService.shouldQwenIgnoreFile(params.file_path)) {
      return `File path '${params.file_path}' is ignored by .qwenignore pattern(s).`;
    }

    return null;
  }

  protected createInvocation(
    params: PDFReaderToolParams,
  ): PDFReaderToolInvocation {
    return new PDFReaderToolInvocation(this.config, params);
  }
}

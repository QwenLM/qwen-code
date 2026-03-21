/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';
import { getErrorMessage } from '../utils/errors.js';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { glob, escape } from 'glob';
import {
  detectFileType,
  processSingleFileContent,
  DEFAULT_ENCODING,
  getSpecificMimeType,
  type ProcessedFileReadResult,
} from '../utils/fileUtils.js';
import type { PartListUnion } from '@google/genai';
import {
  type Config,
  DEFAULT_FILE_FILTERING_OPTIONS,
} from '../config/config.js';
import { FileOperation } from '../telemetry/metrics.js';
import { getProgrammingLanguage } from '../telemetry/telemetry-utils.js';
import { logFileOperation } from '../telemetry/loggers.js';
import { FileOperationEvent } from '../telemetry/types.js';
import { ToolErrorType } from './tool-error.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';

const REFERENCE_CONTENT_END = '--- End of content ---';

export interface ReadManyFilesParams {
  include: string[];
  exclude?: string[];
  recursive?: boolean;
  useDefaultExcludes?: boolean;
  file_filtering_options?: {
    respect_git_ignore?: boolean;
    respect_qwen_ignore?: boolean;
  };
}

type FileProcessingResult =
  | {
      success: true;
      filePath: string;
      relativePathForDisplay: string;
      fileReadResult: ProcessedFileReadResult;
      reason?: undefined;
    }
  | {
      success: false;
      filePath: string;
      relativePathForDisplay: string;
      fileReadResult?: undefined;
      reason: string;
    };

function getDefaultExcludes(config?: Config): string[] {
  return config?.getFileExclusions().getReadManyFilesExcludes() ?? [];
}

const DEFAULT_OUTPUT_SEPARATOR_FORMAT = '--- {filePath} ---';
const DEFAULT_OUTPUT_TERMINATOR = `\n${REFERENCE_CONTENT_END}`;

class ReadManyFilesToolInvocation extends BaseToolInvocation<
  ReadManyFilesParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: ReadManyFilesParams,
  ) {
    super(params);
  }

  getDescription(): string {
    const pathDesc = `using patterns: ${this.params.include.join('`, `')} (within target directory: ${this.config.getTargetDir()}) `;
    const paramExcludes = this.params.exclude || [];
    const paramUseDefaultExcludes = this.params.useDefaultExcludes !== false;
    const finalExclusionPatterns: string[] = paramUseDefaultExcludes
      ? [...getDefaultExcludes(this.config), ...paramExcludes]
      : [...paramExcludes];

    const excludeDesc = `Excluding: ${
      finalExclusionPatterns.length > 0
        ? `patterns like ${finalExclusionPatterns
            .slice(0, 2)
            .join('`, `')}${finalExclusionPatterns.length > 2 ? '...' : ''}`
        : 'none specified'
    }`;

    return `Will attempt to read and concatenate files ${pathDesc}. ${excludeDesc}. File encoding: ${DEFAULT_ENCODING}. Separator: "${DEFAULT_OUTPUT_SEPARATOR_FORMAT.replace('{filePath}', 'path/to/file.ext')}".`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const { include, exclude = [], useDefaultExcludes = true } = this.params;

    const filesToConsider = new Set<string>();
    const skippedFiles: Array<{ path: string; reason: string }> = [];
    const processedFilesRelativePaths: string[] = [];
    const contentParts: PartListUnion = [];

    const effectiveExcludes = useDefaultExcludes
      ? [...getDefaultExcludes(this.config), ...exclude]
      : [...exclude];

    try {
      const allEntries = new Set<string>();
      const workspaceDirs = this.config.getWorkspaceContext().getDirectories();

      for (const dir of workspaceDirs) {
        const processedPatterns = [];
        for (const p of include) {
          const normalizedP = p.replace(/\\/g, '/');
          const fullPath = path.join(dir, normalizedP);
          let exists = false;
          try {
            await fsPromises.access(fullPath);
            exists = true;
          } catch {
            exists = false;
          }

          if (exists) {
            processedPatterns.push(escape(normalizedP));
          } else {
            processedPatterns.push(normalizedP);
          }
        }

        const entriesInDir = await glob(processedPatterns, {
          cwd: dir,
          ignore: effectiveExcludes,
          nodir: true,
          dot: true,
          absolute: true,
          nocase: true,
          signal,
        });
        for (const entry of entriesInDir) {
          allEntries.add(entry);
        }
      }
      const relativeEntries = Array.from(allEntries).map((p) =>
        path.relative(this.config.getTargetDir(), p),
      );

      const fileDiscovery = this.config.getFileService();

      const filterReport = fileDiscovery.filterFilesWithReport(
        relativeEntries,
        {
          respectGitIgnore:
            this.params.file_filtering_options?.respect_git_ignore ??
            this.config.getFileFilteringOptions().respectGitIgnore ??
            DEFAULT_FILE_FILTERING_OPTIONS.respectGitIgnore,
          respectQwenIgnore:
            this.params.file_filtering_options?.respect_qwen_ignore ??
            this.config.getFileFilteringOptions().respectQwenIgnore ??
            DEFAULT_FILE_FILTERING_OPTIONS.respectQwenIgnore,
        },
      );
      const { filteredPaths } = filterReport;
      const ignoredCount =
        filterReport.gitIgnoredCount + filterReport.qwenIgnoredCount;

      for (const relativePath of filteredPaths) {
        const fullPath = path.resolve(this.config.getTargetDir(), relativePath);
        const workspaceContext = this.config.getWorkspaceContext();
        if (!workspaceContext.isPathWithinWorkspace(fullPath)) {
          skippedFiles.push({
            path: fullPath,
            reason: 'Security: Path not in workspace',
          });
          continue;
        }
        filesToConsider.add(fullPath);
      }

      if (ignoredCount > 0) {
        skippedFiles.push({
          path: `${ignoredCount} file(s)`,
          reason: 'ignored by project ignore files',
        });
      }
    } catch (error) {
      const errorMessage = `Error during file search: ${getErrorMessage(error)}`;
      return {
        llmContent: errorMessage,
        returnDisplay: `## File Search Error\n\nAn error occurred while searching for files:\n\`\`\`\n${getErrorMessage(error)}\n\`\`\``,
        error: {
          message: errorMessage,
          type: ToolErrorType.READ_MANY_FILES_SEARCH_ERROR,
        },
      };
    }

    const sortedFiles = Array.from(filesToConsider).sort();

    const fileProcessingPromises = sortedFiles.map(
      async (filePath): Promise<FileProcessingResult> => {
        try {
          const relativePathForDisplay = path
            .relative(this.config.getTargetDir(), filePath)
            .replace(/\\/g, '/');

          const fileType = await detectFileType(filePath);

          if (
            fileType === 'image' ||
            fileType === 'pdf' ||
            fileType === 'audio'
          ) {
            const fileExtension = path.extname(filePath).toLowerCase();
            const fileNameWithoutExtension = path.basename(
              filePath,
              fileExtension,
            );
            const requestedExplicitly = include.some(
              (pattern: string) =>
                pattern.toLowerCase().includes(fileExtension) ||
                pattern.includes(fileNameWithoutExtension),
            );

            if (!requestedExplicitly) {
              return {
                success: false,
                filePath,
                relativePathForDisplay,
                reason:
                  'asset file (image/pdf/audio) was not explicitly requested by name or extension',
              };
            }
          }

          const fileReadResult = await processSingleFileContent(
            filePath,
            this.config,
          );

          if (fileReadResult.error) {
            return {
              success: false,
              filePath,
              relativePathForDisplay,
              reason: `Read error: ${fileReadResult.error}`,
            };
          }

          return {
            success: true,
            filePath,
            relativePathForDisplay,
            fileReadResult,
          };
        } catch (error) {
          const relativePathForDisplay = path
            .relative(this.config.getTargetDir(), filePath)
            .replace(/\\/g, '/');

          return {
            success: false,
            filePath,
            relativePathForDisplay,
            reason: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    );

    const results = await Promise.allSettled(fileProcessingPromises);

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const fileResult = result.value;

        if (!fileResult.success) {
          skippedFiles.push({
            path: fileResult.relativePathForDisplay,
            reason: fileResult.reason,
          });
        } else {
          const { filePath, relativePathForDisplay, fileReadResult } =
            fileResult;

          if (typeof fileReadResult.llmContent === 'string') {
            const separator = DEFAULT_OUTPUT_SEPARATOR_FORMAT.replace(
              '{filePath}',
              filePath,
            );
            let fileContentForLlm = '';
            if (fileReadResult.isTruncated) {
              fileContentForLlm += `[WARNING: This file was truncated. To view the full content, use the 'read_file' tool on this specific file.]\n\n`;
            }
            fileContentForLlm += fileReadResult.llmContent;
            contentParts.push(`${separator}\n\n${fileContentForLlm}\n\n`);
          } else {
            contentParts.push(fileReadResult.llmContent);
          }

          processedFilesRelativePaths.push(relativePathForDisplay);

          const lines =
            typeof fileReadResult.llmContent === 'string'
              ? fileReadResult.llmContent.split('\n').length
              : undefined;
          const mimetype = getSpecificMimeType(filePath);
          const programming_language = getProgrammingLanguage({
            file_path: filePath,
          });
          logFileOperation(
            this.config,
            new FileOperationEvent(
              ToolNames.READ_MANY_FILES,
              FileOperation.READ,
              lines,
              mimetype,
              path.extname(filePath),
              programming_language,
            ),
          );
        }
      } else {
        skippedFiles.push({
          path: 'unknown',
          reason: `Unexpected error: ${result.reason}`,
        });
      }
    }

    let displayMessage = `### ReadManyFiles Result (Target Dir: \`${this.config.getTargetDir()}\`)\n\n`;
    if (processedFilesRelativePaths.length > 0) {
      displayMessage += `Successfully read and concatenated content from **${processedFilesRelativePaths.length} file(s)**.\n`;
      if (processedFilesRelativePaths.length <= 10) {
        displayMessage += `\n**Processed Files:**\n`;
        processedFilesRelativePaths.forEach(
          (p) => (displayMessage += `- \`${p}\`\n`),
        );
      } else {
        displayMessage += `\n**Processed Files (first 10 shown):**\n`;
        processedFilesRelativePaths
          .slice(0, 10)
          .forEach((p) => (displayMessage += `- \`${p}\`\n`));
        displayMessage += `- ...and ${processedFilesRelativePaths.length - 10} more.\n`;
      }
    }

    if (skippedFiles.length > 0) {
      if (processedFilesRelativePaths.length === 0) {
        displayMessage += `No files were read and concatenated based on the criteria.\n`;
      }
      if (skippedFiles.length <= 5) {
        displayMessage += `\n**Skipped ${skippedFiles.length} item(s):**\n`;
      } else {
        displayMessage += `\n**Skipped ${skippedFiles.length} item(s) (first 5 shown):**\n`;
      }
      skippedFiles
        .slice(0, 5)
        .forEach(
          (f) => (displayMessage += `- \`${f.path}\` (Reason: ${f.reason})\n`),
        );
      if (skippedFiles.length > 5) {
        displayMessage += `- ...and ${skippedFiles.length - 5} more.\n`;
      }
    } else if (
      processedFilesRelativePaths.length === 0 &&
      skippedFiles.length === 0
    ) {
      displayMessage += `No files were read and concatenated based on the criteria.\n`;
    }

    if (contentParts.length > 0) {
      contentParts.push(DEFAULT_OUTPUT_TERMINATOR);
    } else {
      contentParts.push(
        'No files matching the criteria were found or all were skipped.',
      );
    }
    return {
      llmContent: contentParts,
      returnDisplay: displayMessage.trim(),
    };
  }
}

export class ReadManyFilesTool extends BaseDeclarativeTool<
  ReadManyFilesParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.READ_MANY_FILES;

  constructor(private config: Config) {
    super(
      ReadManyFilesTool.Name,
      ToolDisplayNames.READ_MANY_FILES,
      `Finds and reads the content of multiple files matching glob patterns within the workspace. Files are concatenated with separators. Supports include/exclude glob patterns, respects .gitignore and .qwenignore. Use for batch file reading instead of multiple read_file calls. For asset files (images, PDFs, audio), they must be explicitly requested by name or extension in the include patterns.`,
      Kind.Read,
      {
        properties: {
          include: {
            description:
              'Array of glob patterns or file paths to include. Example: ["*.ts", "src/**/*.md", "specific-file.txt"]',
            type: 'array',
            items: { type: 'string', minLength: 1 },
            minItems: 1,
          },
          exclude: {
            description:
              'Optional. Array of glob patterns for files/directories to exclude. Example: ["*.log", "dist/**"]',
            type: 'array',
            items: { type: 'string' },
          },
          useDefaultExcludes: {
            description:
              'Optional. Whether to apply default exclusion patterns (node_modules, .git, etc.). Defaults to true.',
            type: 'boolean',
          },
        },
        required: ['include'],
        type: 'object',
      },
    );
  }

  protected createInvocation(
    params: ReadManyFilesParams,
  ): ToolInvocation<ReadManyFilesParams, ToolResult> {
    return new ReadManyFilesToolInvocation(this.config, params);
  }
}

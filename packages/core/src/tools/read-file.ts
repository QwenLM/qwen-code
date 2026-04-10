/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { makeRelative, shortenPath } from '../utils/paths.js';
import type { ToolInvocation, ToolLocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';

import type { PartUnion } from '@google/genai';
import type { PermissionDecision } from '../permissions/types.js';
import {
  processSingleFileContent,
  getSpecificMimeType,
} from '../utils/fileUtils.js';
import type { Config } from '../config/config.js';
import { FileOperation } from '../telemetry/metrics.js';
import { getProgrammingLanguage } from '../telemetry/telemetry-utils.js';
import { logFileOperation } from '../telemetry/loggers.js';
import { FileOperationEvent } from '../telemetry/types.js';
import { isSubpaths, isSubpath } from '../utils/paths.js';
import { Storage } from '../config/storage.js';
import { isAutoMemPath } from '../memory/paths.js';
import { memoryFreshnessNote } from '../memory/memoryAge.js';

/**
 * Parameters for the ReadFile tool
 */
export interface ReadFileToolParams {
  /**
   * The absolute path to the file to read
   */
  file_path: string;

  /**
   * The line number to start reading from (optional)
   */
  offset?: number;

  /**
   * The number of lines to read (optional)
   */
  limit?: number;
}

class ReadFileToolInvocation extends BaseToolInvocation<
  ReadFileToolParams,
  ToolResult
> {
  constructor(
    private config: Config,
    params: ReadFileToolParams,
  ) {
    super(params);
  }

  getDescription(): string {
    const relativePath = makeRelative(
      this.params.file_path,
      this.config.getTargetDir(),
    );
    const shortPath = shortenPath(relativePath);

    const { offset, limit } = this.params;
    if (offset !== undefined && limit !== undefined) {
      return `${shortPath} (lines ${offset + 1}-${offset + limit})`;
    } else if (offset !== undefined) {
      return `${shortPath} (from line ${offset + 1})`;
    } else if (limit !== undefined) {
      return `${shortPath} (first ${limit} lines)`;
    }

    return shortPath;
  }

  override toolLocations(): ToolLocation[] {
    return [{ path: this.params.file_path, line: this.params.offset }];
  }

  /**
   * Returns 'ask' for paths outside the workspace/temp/userSkills directories,
   * so that external file reads require user confirmation.
   */
  override async getDefaultPermission(): Promise<PermissionDecision> {
    const filePath = path.resolve(this.params.file_path);
    const workspaceContext = this.config.getWorkspaceContext();
    const globalTempDir = Storage.getGlobalTempDir();
    const projectTempDir = this.config.storage.getProjectTempDir();
    const userSkillsDirs = this.config.storage.getUserSkillsDirs();
    const userExtensionsDir = Storage.getUserExtensionsDir();
    const osTempDir = os.tmpdir();

    // Auto-allow reads of files within the managed auto-memory root for this
    // project only — using the narrower isAutoMemPath check instead of the
    // broad getMemoryBaseDir() to avoid exposing sensitive ~/.qwen files such
    // as settings.json or OAuth credentials.
    if (
      workspaceContext.isPathWithinWorkspace(filePath) ||
      isSubpath(projectTempDir, filePath) ||
      isSubpath(globalTempDir, filePath) ||
      isSubpath(osTempDir, filePath) ||
      isSubpaths(userSkillsDirs, filePath) ||
      isSubpath(userExtensionsDir, filePath) ||
      isAutoMemPath(filePath, this.config.getTargetDir())
    ) {
      return 'allow';
    }
    return 'ask';
  }

  async execute(): Promise<ToolResult> {
    const result = await processSingleFileContent(
      this.params.file_path,
      this.config,
      this.params.offset,
      this.params.limit,
    );

    if (result.error) {
      return {
        llmContent: result.llmContent,
        returnDisplay: result.returnDisplay || 'Error reading file',
        error: {
          message: result.error,
          type: result.errorType,
        },
      };
    }

    let llmContent: PartUnion;
    if (result.isTruncated) {
      const [start, end] = result.linesShown!;
      const total = result.originalLineCount!;
      llmContent = `Showing lines ${start}-${end} of ${total} total lines.\n\n---\n\n${result.llmContent}`;
    } else {
      llmContent = result.llmContent || '';
    }

    // For memory files, prepend a per-file staleness caveat so the model knows
    // the content is a point-in-time snapshot and may be stale.
    const projectRoot = this.config.getTargetDir();
    if (
      typeof llmContent === 'string' &&
      isAutoMemPath(path.resolve(this.params.file_path), projectRoot)
    ) {
      // Only compute mtime when we actually need the note (avoids extra stat on
      // every non-memory file read).
      try {
        const stat = await fs.stat(path.resolve(this.params.file_path));
        const note = memoryFreshnessNote(stat.mtimeMs);
        if (note) {
          llmContent = note + llmContent;
        }
      } catch {
        // Best-effort — if stat fails, omit the note silently.
      }
    }

    const lines =
      typeof result.llmContent === 'string'
        ? result.llmContent.split('\n').length
        : undefined;
    const mimetype = getSpecificMimeType(this.params.file_path);
    const programming_language = getProgrammingLanguage({
      file_path: this.params.file_path,
    });
    logFileOperation(
      this.config,
      new FileOperationEvent(
        ReadFileTool.Name,
        FileOperation.READ,
        lines,
        mimetype,
        path.extname(this.params.file_path),
        programming_language,
      ),
    );

    return {
      llmContent,
      returnDisplay: result.returnDisplay || '',
    };
  }
}

/**
 * Implementation of the ReadFile tool logic
 */
export class ReadFileTool extends BaseDeclarativeTool<
  ReadFileToolParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.READ_FILE;

  constructor(private config: Config) {
    super(
      ReadFileTool.Name,
      ToolDisplayNames.READ_FILE,
      `Reads and returns the content of a specified file. If the file is large, the content will be truncated. The tool's response will clearly indicate if truncation has occurred and will provide details on how to read more of the file using the 'offset' and 'limit' parameters. Handles text, images (PNG, JPG, GIF, WEBP, SVG, BMP), and PDF files. For text files, it can read specific line ranges.`,
      Kind.Read,
      {
        properties: {
          file_path: {
            description:
              "The absolute path to the file to read (e.g., '/home/user/project/file.txt'). Relative paths are not supported. You must provide an absolute path.",
            type: 'string',
          },
          offset: {
            description:
              "Optional: For text files, the 0-based line number to start reading from. Requires 'limit' to be set. Use for paginating through large files.",
            type: 'number',
          },
          limit: {
            description:
              "Optional: For text files, maximum number of lines to read. Use with 'offset' to paginate through large files. If omitted, reads the entire file (if feasible, up to a default limit).",
            type: 'number',
          },
        },
        required: ['file_path'],
        type: 'object',
      },
    );
  }

  protected override validateToolParamValues(
    params: ReadFileToolParams,
  ): string | null {
    const filePath = params.file_path;
    if (params.file_path.trim() === '') {
      return "The 'file_path' parameter must be non-empty.";
    }

    if (!path.isAbsolute(filePath)) {
      return `File path must be absolute, but was relative: ${filePath}. You must provide an absolute path.`;
    }

    if (params.offset !== undefined && params.offset < 0) {
      return 'Offset must be a non-negative number';
    }
    if (params.limit !== undefined && params.limit <= 0) {
      return 'Limit must be a positive number';
    }

    const fileService = this.config.getFileService();
    if (fileService.shouldQwenIgnoreFile(params.file_path)) {
      return `File path '${filePath}' is ignored by .qwenignore pattern(s).`;
    }

    return null;
  }

  protected createInvocation(
    params: ReadFileToolParams,
  ): ToolInvocation<ReadFileToolParams, ToolResult> {
    return new ReadFileToolInvocation(this.config, params);
  }
}

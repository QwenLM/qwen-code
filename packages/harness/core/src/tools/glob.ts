/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { stat } from 'node:fs/promises';
import nodePath from 'node:path';
import { Kind, type GlobResult, type ToolResult } from './tools.js';
import { globContract } from '../codemode/contracts.js';
import { shortenPath, makeRelative } from '../utils/paths.js';
import type { Config } from '../config/config.js';
import { resolveSearchRoot } from '../utils/searchPaths.js';
import { getCwd } from '../utils/Shell.js';
import { ToolErrorType } from './tool-error.js';
import { GLOB_TOOL_NAME, GLOB_DISPLAY_NAME } from './tool-names.js';
import { getErrorMessage, isNodeError } from '../utils/errors.js';
import { runLogger } from '../utils/runLogger.js';
import { CORE_TOOL_SET } from './definitions/coreTools.js';
import { glob as globSearch } from '../utils/glob.js';
import { defineDeclarativeTool } from './define-tool.js';
import type { ToolUseContext } from './tool-types.js';
import { createReadDenyResultFilter } from './filesystem-permissions/filesystem.js';
import { confirmManagedSearchRead } from './filesystem-permissions/search-permissions.js';
import { DEFAULT_GLOB_RESULT_LIMIT } from './search-result-limits.js';

/**
 * Parameters for the GlobTool.
 */
export interface GlobToolParams {
  /**
   * The glob pattern to match files against
   */
  pattern: string;

  /**
   * The directory to search in. If not specified, the current working directory will be searched.
   */
  path?: string;
}

/** Resolve the search root without modifying the model input. */
export function globGetPath(params: GlobToolParams): string {
  return resolveSearchRoot(params.path, getCwd(), params.pattern);
}

async function executeGlob(
  params: GlobToolParams,
  ctx: ToolUseContext,
  config: Config,
): Promise<ToolResult> {
  try {
    const startTime = Date.now();

    const searchDirectory = globGetPath(params);
    // Directory probes belong after permission approval, never in build/validation.
    ctx.signal.throwIfAborted();
    const directory = await stat(searchDirectory).catch((error: unknown) => {
      if (
        isNodeError(error) &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      ) {
        throw new Error(`Search path does not exist: ${searchDirectory}`);
      }
      throw error;
    });
    if (!directory.isDirectory()) {
      throw new Error(`Search path is not a directory: ${searchDirectory}`);
    }
    ctx.signal.throwIfAborted();
    const ignorePatterns = config.getCustomExcludes?.() ?? [];

    // Hide files a direct Read would deny. This is result filtering, not a
    // permission verdict: the directory-level search itself stays allowed.
    // The filter runs inside the collector, before offset/limit slicing, so
    // denied files do not consume the visible result quota.
    const denyResultFilter = createReadDenyResultFilter(
      config.permission && {
        rules: config.permission.getRules(),
        additionalDirectories: config.permission.getAdditionalDirectories(),
        globalRules:
          config.permission.getManagedRules(),
      },
      config.getTargetDir(),
    );

    const {
      files: allFiles,
      truncated,
      totalMatches,
      countIsComplete = true,
    } = await globSearch(
      params.pattern,
      searchDirectory,
      { limit: DEFAULT_GLOB_RESULT_LIMIT, offset: 0 },
      ctx.signal,
      ignorePatterns,
      denyResultFilter,
    );

    const denied = await confirmManagedSearchRead(
      allFiles,
      GLOB_TOOL_NAME,
      params as unknown as Record<string, unknown>,
      ctx,
      config,
    );
    if (denied) return denied;

    if (allFiles.length === 0) {
      const toolUseResult: GlobResult = {
        durationMs: Date.now() - startTime,
        numFiles: 0,
        filenames: [],
        truncated,
        totalMatches,
        countIsComplete,
      };
      return {
        llmContent: 'No files found',
        returnDisplay: toolUseResult,
        toolUseResult,
      };
    }

    // Convert absolute paths to relative paths for display
    const relativePaths = allFiles.map((absolutePath) =>
      nodePath.relative(config.getTargetDir(), absolutePath),
    );

    const fileCount = relativePaths.length;
    const fileListDescription = relativePaths.join('\n');

    let resultContent = fileListDescription;
    if (truncated) {
      const remaining = totalMatches - fileCount;
      resultContent += countIsComplete
        ? `\n(Showing ${fileCount} of ${totalMatches} matching files; ${remaining} more are not listed. Narrow the pattern or path to see the rest.)`
        : `\n(Showing the first ${fileCount} files; the search returned incomplete results. Narrow the pattern or path to see the rest.)`;
    }

    const toolUseResult: GlobResult = {
      durationMs: Date.now() - startTime,
      numFiles: fileCount,
      filenames: relativePaths,
      truncated,
      totalMatches,
      countIsComplete,
    };

    return {
      llmContent: resultContent,
      returnDisplay: toolUseResult,
      toolUseResult,
    };
  } catch (error) {
    runLogger.warn(`GlobLogic execute Error`, error);
    const errorMessage = getErrorMessage(error);
    const rawError = `Error during glob search operation: ${errorMessage}`;
    return {
      llmContent: rawError,
      returnDisplay: `Error: An unexpected error occurred.`,
      error: {
        message: rawError,
        type: ToolErrorType.GLOB_EXECUTION_ERROR,
      },
    };
  }
}

/**
 * Implementation of the Glob tool logic using defineDeclarativeTool.
 */
export const GlobTool = defineDeclarativeTool<GlobToolParams, ToolResult, Config>({
  name: GLOB_TOOL_NAME,
  displayName: GLOB_DISPLAY_NAME,
  description: CORE_TOOL_SET.Glob.description!,
  kind: Kind.Search,
  programmatic: globContract,
  parameterSchema: CORE_TOOL_SET.Glob.parametersJsonSchema,

  isConcurrencySafe: () => true,

  validateParams: (params: GlobToolParams): string | null => {
    if (params.pattern?.includes('\0') || params.path?.includes('\0'))
      return 'Search parameters cannot contain null bytes.';
    if (params.path !== undefined && typeof params.path !== 'string') {
      return 'params/path must be string';
    }

    if (
      !params.pattern ||
      typeof params.pattern !== 'string' ||
      params.pattern.trim() === ''
    ) {
      return "The 'pattern' parameter cannot be empty.";
    }

    return null;
  },

  execute: executeGlob,

  getDescription: (params: GlobToolParams, config: Config): string => {
    const searchDir = globGetPath(params);
    const scope =
      searchDir === config.getTargetDir()
        ? './'
        : shortenPath(makeRelative(searchDir, config.getTargetDir()));
    return `'${params.pattern}' within ${scope}`;
  },
});

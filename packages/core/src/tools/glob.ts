/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { resolveBundleDir } from '../utils/bundlePaths.js';
import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import {
  resolveAndValidatePath,
  formatDisplayPath,
  resolvePath,
  isSubpath,
  unescapePath,
} from '../utils/paths.js';
import { getMemoryBaseDir } from '../memory/paths.js';
import { type Config } from '../config/config.js';
import type { PermissionDecision } from '../permissions/types.js';
import {
  DEFAULT_FILE_FILTERING_OPTIONS,
  type FileFilteringOptions,
} from '../utils/file-filtering-options.js';
import { ToolErrorType } from './tool-error.js';
import { getErrorMessage } from '../utils/errors.js';
import type { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  searchGlobDirectory,
  type GlobDirectorySearch,
  type GlobDirectoryReply,
  type GlobPath,
} from './glob-search.js';
export type { GlobPath } from './glob-search.js';

const debugLogger = createDebugLogger('GLOB');

const MAX_FILE_COUNT = 100;
const MAX_GLOB_COLLECTED_ENTRIES = MAX_FILE_COUNT * 10;
const normalizePathForComparison = (p: string) =>
  process.platform === 'win32' || process.platform === 'darwin'
    ? p.toLowerCase()
    : p;

/**
 * Sorts file entries based on recency and then alphabetically.
 * Recent files (modified within recencyThresholdMs) are listed first, newest to oldest.
 * Older files are listed after recent ones, sorted alphabetically by path.
 */
export function sortFileEntries(
  entries: GlobPath[],
  nowTimestamp: number,
  recencyThresholdMs: number,
): GlobPath[] {
  const sortedEntries = [...entries];
  sortedEntries.sort((a, b) => {
    const mtimeA = a.mtimeMs ?? 0;
    const mtimeB = b.mtimeMs ?? 0;
    const aIsRecent = nowTimestamp - mtimeA < recencyThresholdMs;
    const bIsRecent = nowTimestamp - mtimeB < recencyThresholdMs;

    if (aIsRecent && bIsRecent) {
      return mtimeB - mtimeA;
    } else if (aIsRecent) {
      return -1;
    } else if (bIsRecent) {
      return 1;
    } else {
      return a.fullpath().localeCompare(b.fullpath());
    }
  });
  return sortedEntries;
}

/**
 * Parameters for the GlobTool
 */
export interface GlobToolParams {
  /**
   * The glob pattern to match files against
   */
  pattern: string;

  /**
   * The directory to search in (optional, defaults to current directory)
   */
  path?: string;
}

export interface GlobToolOptions {
  /**
   * A directory the search never leaves: the walk neither enters
   * nor reports anything whose real location is outside it, whatever the
   * pattern's grammar spells. Managed Sessions set it; the ordinary CLI
   * keeps external globs, which ask for permission instead.
   */
  containmentRoot?: string;
  /** Runs each search in a terminable worker; ordinary CLI callers omit it. */
  executionTimeoutMs?: number;
}

class GlobToolInvocation extends BaseToolInvocation<
  GlobToolParams,
  ToolResult
> {
  private fileService: FileDiscoveryService;

  constructor(
    private config: Config,
    params: GlobToolParams,
    private readonly containmentRoot?: string,
    private readonly executionTimeoutMs?: number,
  ) {
    super(params);
    this.fileService = config.getFileService();
  }

  getDescription(): string {
    let description = `'${this.params.pattern}'`;
    if (this.params.path) {
      const displayPath = formatDisplayPath(
        this.params.path,
        this.config.getTargetDir(),
      );
      description += ` in ${displayPath}`;
    }

    return description;
  }

  /**
   * Returns 'ask' for paths outside the workspace, so that external glob
   * searches require user confirmation.
   */
  override async getDefaultPermission(): Promise<PermissionDecision> {
    if (!this.params.path) {
      return 'allow'; // Default workspace directory
    }
    const workspaceContext = this.config.getWorkspaceContext();
    const resolvedPath = resolvePath(
      this.config.getTargetDir(),
      this.params.path,
    );
    if (
      workspaceContext.isPathWithinWorkspace(resolvedPath) ||
      isSubpath(getMemoryBaseDir(), resolvedPath)
    ) {
      return 'allow';
    }
    return 'ask';
  }

  private async globInDirectory(
    searchDir: string,
    pattern: string,
    signal: AbortSignal,
    entryLimit: number,
  ): Promise<{ entries: GlobPath[]; hitLimit: boolean }> {
    const options: GlobDirectorySearch = {
      searchDir,
      pattern,
      entryLimit,
      projectRoot: this.config.getTargetDir(),
      fileFilteringOptions: this.getFileFilteringOptions(),
      containmentRoot: this.containmentRoot,
    };
    const timeoutMs = this.executionTimeoutMs;
    if (timeoutMs === undefined) {
      return searchGlobDirectory(options, this.fileService, signal);
    }

    signal.throwIfAborted();
    // A timer on the matching thread cannot interrupt a backtracking regexp.
    const workerFile = path.join(
      resolveBundleDir(import.meta.url),
      'glob-search-worker.js',
    );
    // tsx must register its loader inside a worker running source files.
    const workerEntry =
      import.meta.url.endsWith('.ts') && !existsSync(workerFile)
        ? new URL(
            `data:text/javascript,${encodeURIComponent(
              `import { register } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}; register(); await import(${JSON.stringify(new URL('./glob-search-worker.ts', import.meta.url).href)});`,
            )}`,
          )
        : workerFile;
    const worker = new Worker(workerEntry, { workerData: options });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    try {
      return await new Promise<{ entries: GlobPath[]; hitLimit: boolean }>(
        (resolve, reject) => {
          onAbort = () => reject(signal.reason);
          worker.once('message', (reply: GlobDirectoryReply) =>
            resolve({
              entries: reply.entries.map((entry) => ({
                fullpath: () => entry.path,
                mtimeMs: entry.mtimeMs,
              })),
              hitLimit: reply.hitLimit,
            }),
          );
          worker.once('error', () =>
            reject(new Error('Glob search worker failed.')),
          );
          worker.once('exit', () =>
            reject(new Error('Glob search worker exited before a result.')),
          );
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `Glob search exceeded ${timeoutMs / 1000} seconds. Narrow the pattern or path and retry.`,
                ),
              ),
            timeoutMs,
          );
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        },
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      await worker.terminate();
    }
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    try {
      // Determine which directories to search
      const searchDirs: string[] = [];
      let searchLocationDescription: string;

      if (this.params.path) {
        // User specified a path — search only that directory
        const searchDirAbs = resolveAndValidatePath(
          this.config,
          this.params.path,
          { allowExternalPaths: true },
        );
        searchDirs.push(searchDirAbs);
        searchLocationDescription = `within ${searchDirAbs}`;
      } else {
        // No path specified — search all workspace directories
        const workspaceDirs = this.config
          .getWorkspaceContext()
          .getDirectories();
        searchDirs.push(...workspaceDirs);
        searchLocationDescription =
          workspaceDirs.length > 1
            ? `across ${workspaceDirs.length} workspace directories`
            : `in the workspace directory`;
      }

      // Collect entries from all search directories
      const pattern = this.params.pattern;
      const allFilteredEntries: GlobPath[] = [];
      const seenPaths = new Set<string>();
      let hitCollectionLimit = false;

      for (const searchDir of searchDirs) {
        const remainingEntries =
          MAX_GLOB_COLLECTED_ENTRIES - allFilteredEntries.length;
        if (remainingEntries <= 0) {
          hitCollectionLimit = true;
          break;
        }
        const { entries, hitLimit } = await this.globInDirectory(
          searchDir,
          pattern,
          signal,
          remainingEntries,
        );
        hitCollectionLimit ||= hitLimit;
        for (const entry of entries) {
          // Deduplicate entries that might appear in overlapping directories
          const normalized = normalizePathForComparison(entry.fullpath());
          if (!seenPaths.has(normalized)) {
            seenPaths.add(normalized);
            allFilteredEntries.push(entry);
          }
        }
      }

      const filteredEntries = allFilteredEntries;

      if (!filteredEntries || filteredEntries.length === 0) {
        return {
          llmContent: `No files found matching pattern "${this.params.pattern}" ${searchLocationDescription}`,
          returnDisplay: `No files found`,
        };
      }

      // Set filtering such that we first show the most recent files
      const oneDayInMs = 24 * 60 * 60 * 1000;
      const nowTimestamp = new Date().getTime();

      // Sort the filtered entries using the new helper function
      const sortedEntries = sortFileEntries(
        filteredEntries,
        nowTimestamp,
        oneDayInMs,
      );

      const totalFileCount = sortedEntries.length;
      const fileLimit = Math.min(
        MAX_FILE_COUNT,
        this.config.getTruncateToolOutputLines(),
      );
      const truncated = hitCollectionLimit || totalFileCount > fileLimit;

      // Limit to fileLimit if needed
      const entriesToShow = truncated
        ? sortedEntries.slice(0, fileLimit)
        : sortedEntries;

      const sortedAbsolutePaths = entriesToShow.map((entry) =>
        entry.fullpath(),
      );
      const fileListDescription = sortedAbsolutePaths.join('\n');

      let resultMessage = hitCollectionLimit
        ? `Found at least ${totalFileCount} file(s) matching "${this.params.pattern}" ${searchLocationDescription}`
        : `Found ${totalFileCount} file(s) matching "${this.params.pattern}" ${searchLocationDescription}`;
      resultMessage += `, sorted by modification time (newest first):\n---\n${fileListDescription}`;

      // Add truncation notice if needed
      if (hitCollectionLimit) {
        resultMessage += `\n---\n[Results truncated after scanning ${totalFileCount} matching files. Narrow the pattern or path.]`;
      } else if (truncated) {
        const omittedFiles = totalFileCount - fileLimit;
        const fileTerm = omittedFiles === 1 ? 'file' : 'files';
        resultMessage += `\n---\n[${omittedFiles} ${fileTerm} truncated] ...`;
      }

      return {
        llmContent: resultMessage,
        returnDisplay: `${hitCollectionLimit ? 'Found at least' : 'Found'} ${totalFileCount} matching file(s)${truncated ? ' (truncated)' : ''}`,
        resultFilePaths: sortedAbsolutePaths,
        // The certified count covers the collected set, not the display
        // slice — containment consumers must check this, never the slice.
        collectedFilePaths: sortedEntries.map((entry) => entry.fullpath()),
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      debugLogger.error(`GlobLogic execute Error: ${errorMessage}`, error);
      const rawError = `Error during glob search operation: ${errorMessage}`;
      return {
        llmContent: rawError,
        returnDisplay: `Error: ${errorMessage || 'An unexpected error occurred.'}`,
        error: {
          message: rawError,
          type: ToolErrorType.GLOB_EXECUTION_ERROR,
        },
      };
    }
  }

  private getFileFilteringOptions(): FileFilteringOptions {
    const options = this.config.getFileFilteringOptions?.();
    return {
      respectGitIgnore:
        options?.respectGitIgnore ??
        DEFAULT_FILE_FILTERING_OPTIONS.respectGitIgnore,
      respectQwenIgnore:
        options?.respectQwenIgnore ??
        DEFAULT_FILE_FILTERING_OPTIONS.respectQwenIgnore,
      customIgnoreFiles:
        options?.customIgnoreFiles ??
        DEFAULT_FILE_FILTERING_OPTIONS.customIgnoreFiles,
    };
  }
}

/**
 * Implementation of the Glob tool logic
 */
export class GlobTool extends BaseDeclarativeTool<GlobToolParams, ToolResult> {
  static readonly Name = ToolNames.GLOB;

  constructor(
    private config: Config,
    private readonly options: GlobToolOptions = {},
  ) {
    super(
      GlobTool.Name,
      ToolDisplayNames.GLOB,
      'Fast file pattern matching tool that works with any codebase size\n- Supports glob patterns like "**/*.js" or "src/**/*.ts"\n- Returns matching file paths sorted by modification time\n- Use this tool when you need to find files by name patterns',
      Kind.Search,
      {
        properties: {
          pattern: {
            description: 'The glob pattern to match files against',
            type: 'string',
          },
          path: {
            description:
              'The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.',
            type: 'string',
          },
        },
        required: ['pattern'],
        type: 'object',
      },
    );
  }

  /**
   * Validates the parameters for the tool.
   */
  protected override validateToolParamValues(
    params: GlobToolParams,
  ): string | null {
    if (
      !params.pattern ||
      typeof params.pattern !== 'string' ||
      params.pattern.trim() === ''
    ) {
      return "The 'pattern' parameter cannot be empty.";
    }

    // Only validate path if one is provided
    if (params.path) {
      params.path = unescapePath(params.path.trim());
      try {
        resolveAndValidatePath(this.config, params.path, {
          allowExternalPaths: true,
        });
      } catch (error) {
        return getErrorMessage(error);
      }
    }

    return null;
  }

  protected createInvocation(
    params: GlobToolParams,
  ): ToolInvocation<GlobToolParams, ToolResult> {
    return new GlobToolInvocation(
      this.config,
      params,
      this.options.containmentRoot,
      this.options.executionTimeoutMs,
    );
  }
}

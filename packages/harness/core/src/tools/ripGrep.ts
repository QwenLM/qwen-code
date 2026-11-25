/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { Kind, type GrepResult, type ToolResult } from './tools.js';
import { grepContract } from '../codemode/contracts.js';
import { ToolErrorType } from './tool-error.js';
import { makeRelative, shortenPath } from '../utils/paths.js';
import { isFsTouchUnsafePath } from '../utils/pathShape.js';
import { getErrorMessage, isNodeError } from '../utils/errors.js';
import type { Config } from '../config/config.js';
import { resolveSearchRoot } from '../utils/searchPaths.js';
import { getCwd } from '../utils/Shell.js';
import {
  permissionRuleValueFromString,
  toolNameMatchesRule,
} from '../permissions/manager/decision/index.js';
import {
  GREP_TOOL_NAME,
  GREP_DISPLAY_NAME,
  READ_FILE_TOOL_NAME,
} from './tool-names.js';
import { runLogger } from '../utils/runLogger.js';
import { CORE_TOOL_SET } from './definitions/coreTools.js';
import { ripGrep, RipgrepTimeoutError } from '../utils/ripgrep.js';
import { defineDeclarativeTool } from './define-tool.js';
import type { ToolUseContext } from './tool-types.js';
import { createReadDenyResultFilter } from './filesystem-permissions/filesystem.js';
import { confirmManagedSearchRead } from './filesystem-permissions/search-permissions.js';
import { safeJsonStringify } from '../utils/safeJsonStringify.js';
import {
  decodeSearchContent,
  decodeSearchCounts,
  decodeSearchPaths,
} from '../utils/searchOutput.js';
import { truncateString } from '../utils/textUtils.js';
import { DEFAULT_GREP_HEAD_LIMIT } from './search-result-limits.js';

// VCS directories to exclude from searches
const VCS_DIRECTORIES_TO_EXCLUDE = [
  '.git',
  '.svn',
  '.hg',
  '.bzr',
  '.jj',
  '.sl',
];

const GREP_STRUCTURED_RESULT_MAX_CHARS = 20_000;
const GREP_STRUCTURED_RESULT_TARGET_CHARS =
  GREP_STRUCTURED_RESULT_MAX_CHARS - 512;

function grepToolResult(
  llmContent: string,
  toolUseResult: GrepResult,
): ToolResult {
  toolUseResult = {
    ...toolUseResult,
    truncated: Boolean(
      toolUseResult.appliedLimit || toolUseResult.appliedOffset,
    ),
  };
  return {
    llmContent,
    returnDisplay: toolUseResult,
    toolUseResult: boundGrepToolUseResult(toolUseResult),
  };
}

function boundGrepToolUseResult(result: GrepResult): GrepResult {
  if (safeJsonStringify(result).length <= GREP_STRUCTURED_RESULT_MAX_CHARS) {
    return result;
  }

  const originalContent = result.content;
  const boundedContent =
    originalContent === undefined
      ? undefined
      : truncateString(
          originalContent,
          Math.floor(GREP_STRUCTURED_RESULT_MAX_CHARS / 2),
        );
  let bounded: GrepResult = {
    ...result,
    truncated: true,
    ...(boundedContent !== undefined && { content: boundedContent }),
    filenames: [...result.filenames],
  };
  if (
    safeJsonStringify(bounded).length <= GREP_STRUCTURED_RESULT_TARGET_CHARS
  ) {
    return bounded;
  }

  let filenameCount = bounded.filenames.length;
  let contentLimit =
    bounded.content && bounded.content !== originalContent
      ? Math.floor(GREP_STRUCTURED_RESULT_MAX_CHARS / 2)
      : undefined;

  while (filenameCount > 0 || contentLimit !== undefined) {
    if (filenameCount > 0) {
      filenameCount = Math.floor(filenameCount / 2);
    } else if (contentLimit !== undefined) {
      contentLimit = Math.floor(contentLimit / 2);
      if (contentLimit <= 0) {
        contentLimit = 0;
      }
    }

    bounded = {
      ...result,
      truncated: true,
      ...(originalContent !== undefined && {
        content:
          contentLimit === undefined
            ? boundedContent
            : truncateString(originalContent, contentLimit),
      }),
      filenames: result.filenames.slice(0, filenameCount),
    };
    if (
      safeJsonStringify(bounded).length <= GREP_STRUCTURED_RESULT_TARGET_CHARS
    ) {
      return bounded;
    }

    if (contentLimit === 0) {
      contentLimit = undefined;
    }
  }

  bounded = {
    ...result,
    truncated: true,
    ...(result.content !== undefined && { content: '' }),
    filenames: [],
  };
  return bounded;
}

/**
 * Parameters for the GrepTool.
 */
export interface RipGrepToolParams {
  /**
   * The regular expression pattern to search for in file contents
   */
  pattern: string;

  /**
   * File or directory to search in (rg PATH). Defaults to the current working directory.
   */
  path?: string;

  /**
   * Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob
   */
  glob?: string;

  /**
   * Output mode: "content" shows matching lines, "files_with_matches" shows file paths,
   * "count" shows match counts. Defaults to "files_with_matches".
   */
  output_mode?: 'content' | 'files_with_matches' | 'count';

  /**
   * Number of lines to show before each match (rg -B).
   * Requires output_mode: "content", ignored otherwise.
   */
  '-B'?: number;

  /**
   * Number of lines to show after each match (rg -A).
   * Requires output_mode: "content", ignored otherwise.
   */
  '-A'?: number;

  /**
   * Alias for context.
   */
  '-C'?: number;

  /**
   * Number of lines to show before and after each match (rg -C).
   * Requires output_mode: "content", ignored otherwise.
   */
  context?: number;

  /**
   * Show line numbers in output (rg -n).
   * Requires output_mode: "content", ignored otherwise. Defaults to true.
   */
  '-n'?: boolean;

  /**
   * Case insensitive search (rg -i)
   */
  '-i'?: boolean;

  /**
   * File type to search (rg --type). Common types: js, py, rust, go, java, etc.
   */
  type?: string;

  /**
   * Limit output to first N lines/entries.
   * Defaults to 250 when unspecified. Pass 0 for unlimited.
   */
  head_limit?: number;

  /**
   * Skip first N lines/entries before applying head_limit. Defaults to 0.
   */
  offset?: number;

  /**
   * Enable multiline mode where . matches newlines and patterns can span lines
   * (rg -U --multiline-dotall). Default: false.
   */
  multiline?: boolean;
  '-o'?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function applyHeadLimit<T>(
  items: T[],
  limit: number | undefined,
  offset: number = 0,
): { items: T[]; appliedLimit: number | undefined } {
  if (limit === 0)
    return { items: items.slice(offset), appliedLimit: undefined };
  const effectiveLimit = limit ?? DEFAULT_GREP_HEAD_LIMIT;
  const sliced = items.slice(offset, offset + effectiveLimit);
  const wasTruncated = items.length - offset > effectiveLimit;
  return {
    items: sliced,
    appliedLimit: wasTruncated ? effectiveLimit : undefined,
  };
}

function formatLimitInfo(
  appliedLimit: number | undefined,
  appliedOffset: number | undefined,
): string {
  const parts: string[] = [];
  if (appliedLimit !== undefined) parts.push(`limit: ${appliedLimit}`);
  if (appliedOffset) parts.push(`offset: ${appliedOffset}`);
  return parts.join(', ');
}

function toRelativePath(absPath: string, basePath: string): string {
  return path.relative(basePath, absPath);
}

// ---------------------------------------------------------------------------
// Result processors (extracted from GrepToolInvocation private methods)
// ---------------------------------------------------------------------------

/**
 * Process results for files_with_matches mode (default).
 * Uses Promise.allSettled for concurrent stat to sort by mtime.
 */
async function processFilesWithMatchesResults(
  results: string[],
  searchDirAbs: string,
  searchDirDisplay: string,
  headLimit: number | undefined,
  offset: number,
): Promise<ToolResult> {
  if (results.length === 0) {
    return grepToolResult('No files found', {
      mode: 'files_with_matches',
      filenames: [],
      numFiles: 0,
    });
  }

  // Convert to absolute paths
  const absPaths = results.map((resultPath) =>
    path.isAbsolute(resultPath)
      ? resultPath
      : path.resolve(searchDirAbs, resultPath),
  );

  // A single ENOENT (file deleted between ripgrep scan and stat) won't reject the whole batch
  const statResults = await Promise.allSettled(
    absPaths.map((p) => fsPromises.stat(p)),
  );

  const filesWithMtime = absPaths.map((absPath, i) => {
    const result = statResults[i];
    return {
      path: absPath,
      mtime: result.status === 'fulfilled' ? (result.value.mtimeMs ?? 0) : 0,
    };
  });

  // Sort by mtime descending (most recent first)
  filesWithMtime.sort(
    (a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path),
  );

  const { items: limitedFiles, appliedLimit } = applyHeadLimit(
    filesWithMtime,
    headLimit,
    offset,
  );

  const relativePaths = limitedFiles.map((f) =>
    toRelativePath(f.path, searchDirDisplay),
  );

  const limitInfo = formatLimitInfo(
    appliedLimit,
    offset > 0 ? offset : undefined,
  );

  const llmContent =
    relativePaths.length === 0
      ? `No entries at this offset. [Showing results with pagination = ${limitInfo}]`
      : `Found ${relativePaths.length} file${relativePaths.length === 1 ? '' : 's'}${limitInfo ? ` ${limitInfo}` : ''}\n${relativePaths.join('\n')}`;

  return grepToolResult(llmContent.trim(), {
    mode: 'files_with_matches',
    filenames: relativePaths,
    numFiles: relativePaths.length,
    totalFiles: filesWithMtime.length,
    ...(appliedLimit !== undefined && { appliedLimit }),
    ...(offset > 0 && { appliedOffset: offset }),
  });
}

/**
 * Process results for content mode (raw relativized lines).
 */
function processContentResults(
  results: string[],
  searchDirAbs: string,
  searchDirDisplay: string,
  headLimit: number | undefined,
  offset: number,
  isDirectory: boolean,
  showLineNumbers: boolean,
): ToolResult {
  if (results.length === 0) {
    return grepToolResult('No matches found', {
      mode: 'content',
      numFiles: 0,
      filenames: [],
      content: '',
      numLines: 0,
    });
  }

  // Apply head_limit first — relativize is per-line work, so
  // avoid processing lines that will be discarded.
  const { items: limitedResults, appliedLimit } = applyHeadLimit(
    results,
    headLimit,
    offset,
  );

  const finalLines = limitedResults.map((line) => {
    const separator = line.indexOf('\0');
    if (separator < 0) return line;
    const file = line.slice(0, separator);
    const rendered = line.slice(separator + 1);
    const number = /^(\d+)([:-])/.exec(rendered);
    const value =
      !showLineNumbers && number ? rendered.slice(number[0].length) : rendered;
    return isDirectory
      ? toRelativePath(
          path.isAbsolute(file) ? file : path.resolve(searchDirAbs, file),
          searchDirDisplay,
        ) +
          (number?.[2] ?? ':') +
          value
      : value;
  });

  const content = finalLines.join('\n');
  const limitInfo = formatLimitInfo(
    appliedLimit,
    offset > 0 ? offset : undefined,
  );

  const displayContent = content || 'No entries at this offset';
  const finalContent = limitInfo
    ? `${displayContent}\n\n[Showing results with pagination = ${limitInfo}]`
    : displayContent;

  return grepToolResult(finalContent, {
    mode: 'content',
    numFiles: 0,
    filenames: [],
    content,
    numLines: finalLines.length,
    totalLines: results.length,
    ...(appliedLimit !== undefined && { appliedLimit }),
    ...(offset > 0 && { appliedOffset: offset }),
  });
}

/**
 * Process results for count mode (-c flag, parse path:count format).
 */
function processCountResults(
  results: string[],
  searchDirAbs: string,
  headLimit: number | undefined,
  offset: number,
): ToolResult {
  if (results.length === 0) {
    return grepToolResult('No matches found', {
      mode: 'count',
      numFiles: 0,
      filenames: [],
      content: '',
      numMatches: 0,
    });
  }

  // Apply head_limit first to avoid relativizing entries that will be discarded
  const { items: limitedResults, appliedLimit } = applyHeadLimit(
    results,
    headLimit,
    offset,
  );

  const finalCountLines = limitedResults.map((line) => {
    // Lines have format: /absolute/path:count
    const colonIndex = line.lastIndexOf(':');
    if (colonIndex > 0) {
      const filePath = line.substring(0, colonIndex);
      const count = line.substring(colonIndex);
      if (path.isAbsolute(filePath)) {
        return toRelativePath(filePath, searchDirAbs) + count;
      }
    }
    return line;
  });

  let totalMatches = 0;
  let fileCount = 0;
  for (const line of results) {
    const colonIndex = line.lastIndexOf(':');
    if (colonIndex > 0) {
      const countStr = line.substring(colonIndex + 1);
      const count = parseInt(countStr, 10);
      if (!isNaN(count)) {
        totalMatches += count;
        fileCount += 1;
      }
    }
  }

  const rawContent = finalCountLines.join('\n');
  const limitInfo = formatLimitInfo(
    appliedLimit,
    offset > 0 ? offset : undefined,
  );
  const summary = `\n\nFound ${totalMatches} total ${totalMatches === 1 ? 'occurrence' : 'occurrences'} across ${fileCount} ${fileCount === 1 ? 'file' : 'files'}.${limitInfo ? ` with pagination = ${limitInfo}` : ''}`;

  return grepToolResult((rawContent || 'No entries at this offset') + summary, {
    mode: 'count',
    numFiles: fileCount,
    filenames: [],
    content: rawContent,
    numMatches: totalMatches,
    ...(appliedLimit !== undefined && { appliedLimit }),
    ...(offset > 0 && { appliedOffset: offset }),
  });
}

// ---------------------------------------------------------------------------
// Read-deny result filtering
// ---------------------------------------------------------------------------

/**
 * Drops result entries whose file is hit by a Read deny rule.
 *
 * Path extraction mirrors each mode's result processor (files_with_matches:
 * the whole line; content: prefix before the first colon; count: prefix
 * before the last colon), so an entry is filtered exactly when the tool
 * already treats that prefix as the entry's file path. Lines whose path
 * cannot be determined pass through untouched.
 */
function filterDeniedGrepResults(
  results: string[],
  outputMode: 'content' | 'files_with_matches' | 'count',
  searchDirAbs: string,
  isDenied: (absolutePath: string) => boolean,
): string[] {
  const entryPath = (line: string): string | null => {
    if (outputMode === 'files_with_matches') {
      return path.isAbsolute(line) ? line : path.resolve(searchDirAbs, line);
    }
    const colonIndex =
      outputMode === 'count' ? line.lastIndexOf(':') : line.indexOf('\0');
    if (colonIndex <= 0) return null;
    const filePath = line.substring(0, colonIndex);
    return path.isAbsolute(filePath)
      ? filePath
      : path.resolve(searchDirAbs, filePath);
  };

  return results.filter((line) => {
    const filePath = entryPath(line);
    return filePath === null || !isDenied(filePath);
  });
}

// ---------------------------------------------------------------------------
// Core execute function
// ---------------------------------------------------------------------------

/** Resolve the search root without modifying the model input. */
export function grepGetPath(params: RipGrepToolParams): string {
  return resolveSearchRoot(params.path, getCwd());
}

async function executeGrep(
  params: RipGrepToolParams,
  ctx: ToolUseContext,
  config: Config,
): Promise<ToolResult> {
  try {
    // Resolve once for this execution using the same root policy as permission checks.
    const searchDirAbs = grepGetPath(params);
    let isDirectory: boolean | undefined;

    // Check existence and type asynchronously.
    // SECURITY: skipped for network and device shapes — stat on those can block
    // on an SMB timeout, and ripgrep reports an unusable path on its own.
    if (!isFsTouchUnsafePath(searchDirAbs)) {
      try {
        const stats = await fsPromises.stat(searchDirAbs);
        isDirectory = stats.isDirectory();
        if (!stats.isDirectory() && !stats.isFile()) {
          return {
            llmContent: `Path is not a valid directory or file: ${searchDirAbs}`,
            returnDisplay: 'Error: Path is not a valid directory or file.',
            error: {
              message: `Path is not a valid directory or file: ${searchDirAbs}`,
              type: ToolErrorType.GREP_EXECUTION_ERROR,
            },
          };
        }
      } catch (error: unknown) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          return {
            llmContent: `Path does not exist: ${searchDirAbs}`,
            returnDisplay: 'Error: Path does not exist.',
            error: {
              message: `Path does not exist: ${searchDirAbs}`,
              type: ToolErrorType.FILE_NOT_FOUND,
            },
          };
        }
        return {
          llmContent: `Failed to access path stats for ${searchDirAbs}: ${getErrorMessage(error)}`,
          returnDisplay: 'Error: Failed to access path.',
          error: {
            message: `Failed to access path stats for ${searchDirAbs}: ${getErrorMessage(error)}`,
            type: ToolErrorType.GREP_EXECUTION_ERROR,
          },
        };
      }
    }

    const searchDirDisplay = config.getTargetDir();

    const outputMode = params.output_mode || 'files_with_matches';
    const headLimit = params.head_limit;
    const offset = params.offset ?? 0;

    if (config.getDebugMode()) {
      runLogger.log(
        `[GrepTool] output_mode: ${outputMode}, head_limit: ${headLimit ?? DEFAULT_GREP_HEAD_LIMIT}, offset: ${offset}`,
      );
    }

    // Build ripgrep arguments
    const args = ['--hidden'];
    const readListArgs = ['--files', '--hidden', '--null'];

    for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) {
      args.push('--glob', `!${dir}`);
      readListArgs.push('--glob', `!${dir}`);
    }

    args.push('--max-columns', '500');

    if (params.multiline) {
      args.push('-U', '--multiline-dotall');
    }

    if (params['-i']) {
      args.push('-i');
    }

    if (outputMode === 'files_with_matches') {
      args.push('-l');
    } else if (outputMode === 'count') {
      args.push('-c', '-H');
    }

    if (params['-o'] && outputMode === 'content') args.push('-o');

    const showLineNumbers = params['-n'] !== false;
    args.push(outputMode === 'content' ? '--json' : '--null');
    if (outputMode === 'content') {
      args.push('-n');
    }

    if (outputMode === 'content') {
      if (params.context !== undefined) {
        args.push('-C', params.context.toString());
      } else if (params['-C'] !== undefined) {
        args.push('-C', params['-C'].toString());
      } else {
        if (params['-B'] !== undefined) {
          args.push('-B', params['-B'].toString());
        }
        if (params['-A'] !== undefined) {
          args.push('-A', params['-A'].toString());
        }
      }
    }

    if (params.pattern.startsWith('-')) {
      args.push('-e', params.pattern);
    } else {
      args.push(params.pattern);
    }

    if (params.type) {
      args.push('--type', params.type);
      readListArgs.push('--type', params.type);
    }

    if (params.glob) {
      const globPatterns: string[] = [];
      const rawPatterns = params.glob.split(/\s+/);

      for (const rawPattern of rawPatterns) {
        if (rawPattern.includes('{') && rawPattern.includes('}')) {
          globPatterns.push(rawPattern);
        } else {
          globPatterns.push(...rawPattern.split(',').filter(Boolean));
        }
      }

      for (const globPattern of globPatterns.filter(Boolean)) {
        args.push('--glob', globPattern);
        readListArgs.push('--glob', globPattern);
      }
    }

    const ignorePatterns = config.getCustomExcludes?.() ?? [];
    for (const ignorePattern of ignorePatterns) {
      const rgIgnorePattern = ignorePattern.startsWith('/')
        ? `!${ignorePattern}`
        : `!**/${ignorePattern}`;
      args.push('--glob', rgIgnorePattern);
      readListArgs.push('--glob', rgIgnorePattern);
    }

    // A literal file name may start with '-', so terminate option parsing.
    args.push('--');

    // Network/device targets have unknown type: pass them intact to ripgrep
    // rather than assuming a directory and using a possible file as cwd.
    const executionCwd =
      isDirectory === undefined
        ? getCwd()
        : isDirectory
          ? searchDirAbs
          : path.dirname(searchDirAbs);
    const searchTarget =
      isDirectory === undefined
        ? searchDirAbs
        : isDirectory
          ? '.'
          : path.basename(searchDirAbs);

    const permission = (ctx.agentLoopContext ?? config).permission;
    const readAsk = permission?.getManagedRules()?.ask.some((rule) =>
        toolNameMatchesRule(
          READ_FILE_TOOL_NAME,
          permissionRuleValueFromString(rule).toolName,
        ),
      );
    if (readAsk && permission) {
      // List names using the same type/glob/exclusion filters. Confirm the
      // protected candidates before ripgrep reads any content.
      let complete = true;
      const candidates =
        isDirectory === false
          ? [searchDirAbs]
          : decodeSearchPaths(
              await ripGrep([...readListArgs, '--'], searchTarget, ctx.signal, {
                cwd: executionCwd,
                outputDelimiter: '\0',
                rejectOnInputError: true,
                onPartialResults: () => {
                  complete = false;
                },
              }),
            ).map((file) =>
              isFsTouchUnsafePath(file)
                ? file
                : path.resolve(executionCwd, file),
            );
      if (!complete) {
        const message =
          'The search file list is incomplete, so protected reads cannot be authorized. Please retry.';
        return {
          llmContent: message,
          returnDisplay: message,
          error: { type: ToolErrorType.PERMISSION_DENIED, message },
        };
      }
      const deniedFile = createReadDenyResultFilter(
        {
          rules: permission.getRules(),
          additionalDirectories: permission.getAdditionalDirectories(),
          globalRules:
            permission.getManagedRules(),
        },
        config.getTargetDir(),
      );
      const readable = deniedFile
        ? candidates.filter((file) => !deniedFile(file))
        : candidates;
      const denied = await confirmManagedSearchRead(
        readable,
        GREP_TOOL_NAME,
        params as unknown as Record<string, unknown>,
        ctx,
        config,
      );
      if (denied) return denied;
    }

    // Execute ripgrep
    let results: string[];
    try {
      results = await ripGrep(
        args,
        searchTarget,
        ctx.signal,
        {
          rejectOnInputError: true,
          outputDelimiter: outputMode === 'files_with_matches' ? '\0' : '\n',
          cwd: executionCwd,
        },
      );
    } catch (error) {
      if (error instanceof RipgrepTimeoutError) {
        return {
          llmContent: `Search timed out. ${error.message}`,
          returnDisplay: 'Error: Search timed out.',
          error: {
            message: `Search timed out. ${error.message}`,
            type: ToolErrorType.GREP_EXECUTION_ERROR,
          },
        };
      }
      throw error;
    }

    results =
      outputMode === 'content'
        ? decodeSearchContent(results, {
            context: [
              params.context,
              params['-C'],
              params['-A'],
              params['-B'],
            ].some((value) => value !== undefined && value > 0),
            onlyMatching: params['-o'] === true,
          })
        : outputMode === 'count'
          ? decodeSearchCounts(results)
          : decodeSearchPaths(results);

    results = results.map((entry) => {
      if (outputMode === 'content' && entry === '--') return entry;
      const separator =
        outputMode === 'content'
          ? entry.indexOf('\0')
          : outputMode === 'count'
            ? entry.lastIndexOf(':')
            : entry.length;
      if (separator < 0) return entry;
      const file = entry.slice(0, separator);
      // Do not collapse a UNC spelling into a local path on POSIX hosts.
      const absoluteFile = isFsTouchUnsafePath(file)
        ? file
        : path.resolve(executionCwd, file);
      return absoluteFile + entry.slice(separator);
    });

    // Hide entries a direct Read would deny. This is result filtering, not a
    // permission verdict: the search itself stays allowed. Runs before the
    // per-mode processors so denied entries don't consume the head_limit /
    // offset quota. Only deny rules apply — ask rules are interactive
    // decisions and must not silently shrink search results.
    const denyResultFilter = createReadDenyResultFilter(
      config.permission && {
        rules: config.permission.getRules(),
        additionalDirectories: config.permission.getAdditionalDirectories(),
        globalRules:
          config.permission.getManagedRules(),
      },
      config.getTargetDir(),
    );
    if (denyResultFilter) {
      results = filterDeniedGrepResults(
        results,
        outputMode,
        searchDirAbs,
        denyResultFilter,
      );
      results = results.filter(
        (line, index) =>
          line !== '--' ||
          (index > 0 &&
            index < results.length - 1 &&
            results[index - 1] !== '--'),
      );
    }

    // Process results by output mode
    if (outputMode === 'content') {
      return processContentResults(
        results,
        searchDirAbs,
        searchDirDisplay,
        headLimit,
        offset,
        isDirectory !== false,
        showLineNumbers,
      );
    } else if (outputMode === 'count') {
      return processCountResults(results, searchDirDisplay, headLimit, offset);
    } else {
      return await processFilesWithMatchesResults(
        results,
        searchDirAbs,
        searchDirDisplay,
        headLimit,
        offset,
      );
    }
  } catch (error) {
    runLogger.warn(`Error during GrepLogic execution: ${error}`);
    const errorMessage = getErrorMessage(error);
    return {
      llmContent: `Error during grep search operation: ${errorMessage}`,
      returnDisplay: `Error: ${errorMessage}`,
      error: {
        message: `Error during grep search operation: ${errorMessage}`,
        type: ToolErrorType.GREP_EXECUTION_ERROR,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

/**
 * Implementation of the Grep tool logic using defineDeclarativeTool.
 */
export const RipGrepTool = defineDeclarativeTool<
  RipGrepToolParams,
  ToolResult,
  Config
>({
  name: GREP_TOOL_NAME,
  displayName: GREP_DISPLAY_NAME,
  description: CORE_TOOL_SET.GrepRipgrep.description!,
  kind: Kind.Search,
  programmatic: grepContract,
  parameterSchema: CORE_TOOL_SET.GrepRipgrep.parametersJsonSchema,
  maxResultSizeChars: 20_000,

  isConcurrencySafe: () => true,

  validateParams: (
    params: RipGrepToolParams,
    _config: Config,
  ): string | null => {
    for (const [name, value] of Object.entries(params)) {
      if (typeof value === 'string' && value.includes('\0')) {
        return `${name} cannot contain null bytes.`;
      }
    }
    for (const name of ['head_limit', 'offset'] as const) {
      const value = params[name];
      if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
        return `${name} must be a whole number of 0 or more.${name === 'head_limit' ? ' Pass 0 for unlimited.' : ''}`;
      }
    }

    return null;
  },

  execute: executeGrep,

  getDescription: (params: RipGrepToolParams, config: Config): string => {
    let description = `'${params.pattern}'`;
    if (params.glob) {
      description += ` in ${params.glob}`;
    }
    const resolvedPath = grepGetPath(params);
    if (resolvedPath === config.getTargetDir()) {
      description += ` within ./`;
    } else {
      const relativePath = makeRelative(resolvedPath, config.getTargetDir());
      description += ` within ${shortenPath(relativePath)}`;
    }
    return description;
  },
});

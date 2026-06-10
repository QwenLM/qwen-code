/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames } from './tool-names.js';
import { resolveAndValidatePath, unescapePath } from '../utils/paths.js';
import { getErrorMessage } from '../utils/errors.js';
import type { Config } from '../config/config.js';
import { runRipgrep } from '../utils/ripgrepUtils.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import type { FileFilteringOptions } from '../config/constants.js';
import { DEFAULT_FILE_FILTERING_OPTIONS } from '../config/constants.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import type { PermissionDecision } from '../permissions/types.js';
import {
  getQwenIgnoreFileNames,
  QwenIgnoreParser,
} from '../utils/qwenIgnoreParser.js';

const debugLogger = createDebugLogger('RIPGREP');
const RIPGREP_FIELD_SEPARATOR = '';

interface RipgrepJsonMatch {
  type: 'match';
  data: {
    path: { text?: string; bytes?: string };
    lines?: { text?: string };
    line_number: number;
  };
}

interface RipgrepMatchLine {
  rawLine: string;
  filePath: string;
  key: string;
}

function isRipgrepJsonMatch(value: unknown): value is RipgrepJsonMatch {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as {
    type?: unknown;
    data?: {
      path?: { text?: unknown; bytes?: unknown };
      lines?: { text?: unknown };
      line_number?: unknown;
    };
  };
  return (
    candidate.type === 'match' &&
    (typeof candidate.data?.path?.text === 'string' ||
      typeof candidate.data?.path?.bytes === 'string') &&
    typeof candidate.data?.line_number === 'number'
  );
}

function getRipgrepJsonPath(match: RipgrepJsonMatch): string | undefined {
  if (match.data.path.text !== undefined) {
    return match.data.path.text;
  }
  if (match.data.path.bytes !== undefined) {
    return Buffer.from(match.data.path.bytes, 'base64').toString('utf8');
  }
  return undefined;
}

/**
 * Per-process cache for AI ignore-file discovery. The same directories show
 * up across many Grep invocations in a typical session — without caching,
 * each invocation pays 2-3 sync syscalls per searchPath. Bounded so a
 * pathologically long session can't grow without limit.
 *
 * `dirIsDir`: resolved searchPath -> boolean (is the path itself a directory?)
 * `qwenIgnore`: dir → string[] (cached supported ignore-file paths)
 *
 * **Known staleness window:** an ignore file created mid-session, or a
 * searchPath whose type flips (dir→file or vice versa), will not be
 * picked up until the entry rotates out of the FIFO (256 entries). Users
 * rarely add ignore files mid-session; a process restart resets the cache.
 */
const dirIsDirCache = new Map<string, boolean>();
const qwenIgnoreCache = new Map<string, readonly string[]>();
const RIPGREP_CACHE_MAX = 256;
function trimCache<K, V>(m: Map<K, V>): void {
  if (m.size <= RIPGREP_CACHE_MAX) return;
  const oldest = m.keys().next().value;
  if (oldest !== undefined) m.delete(oldest as K);
}

function toAbsoluteResultPath(filePath: string, searchPaths: string[]): string {
  if (path.isAbsolute(filePath) || path.win32.isAbsolute(filePath)) {
    return filePath;
  }
  for (const searchPath of searchPaths) {
    const candidate = path.resolve(searchPath, filePath);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.resolve(searchPaths[0], filePath);
}

function removeNegatedIgnorePatterns(content: string): string {
  return content
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('!'))
    .join('\n');
}

function prepareRipgrepIgnoreFile(
  ignoreFilePath: string,
  sanitizedIgnoreFiles: string[],
): string | null {
  if (path.basename(ignoreFilePath) === '.qwenignore') {
    return ignoreFilePath;
  }

  let content: string;
  try {
    content = fs.readFileSync(ignoreFilePath, 'utf8');
  } catch (error) {
    debugLogger.debug('Failed to read ignore file for ripgrep:', error);
    return null;
  }

  const sanitizedContent = removeNegatedIgnorePatterns(content);
  if (sanitizedContent === content) {
    return ignoreFilePath;
  }

  const tempDir =
    sanitizedIgnoreFiles[0] ??
    fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-rg-ignore-'));
  if (sanitizedIgnoreFiles.length === 0) {
    sanitizedIgnoreFiles.push(tempDir);
  }

  const sanitizedPath = path.join(
    tempDir,
    `${sanitizedIgnoreFiles.length}-${path.basename(ignoreFilePath)}`,
  );
  fs.writeFileSync(sanitizedPath, sanitizedContent, 'utf8');
  sanitizedIgnoreFiles.push(sanitizedPath);
  return sanitizedPath;
}

/**
 * Test-only: clear ripGrep's module-level discovery caches between cases.
 */
export function _resetRipGrepCachesForTest(): void {
  dirIsDirCache.clear();
  qwenIgnoreCache.clear();
}

/**
 * Parameters for the GrepTool (Simplified)
 */
export interface RipGrepToolParams {
  /**
   * The regular expression pattern to search for in file contents
   */
  pattern: string;

  /**
   * The directory to search in (optional, defaults to current directory relative to root)
   */
  path?: string;

  /**
   * Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}")
   */
  glob?: string;

  /**
   * Maximum number of matching lines to return (optional, shows all if not specified)
   */
  limit?: number;
}

class GrepToolInvocation extends BaseToolInvocation<
  RipGrepToolParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: RipGrepToolParams,
  ) {
    super(params);
  }

  /**
   * Returns 'ask' for paths outside the workspace, so that external grep
   * searches require user confirmation.
   */
  override async getDefaultPermission(): Promise<PermissionDecision> {
    if (!this.params.path) {
      return 'allow'; // Default workspace directory
    }
    const workspaceContext = this.config.getWorkspaceContext();
    const resolvedPath = path.resolve(
      this.config.getTargetDir(),
      this.params.path,
    );
    if (workspaceContext.isPathWithinWorkspace(resolvedPath)) {
      return 'allow';
    }
    return 'ask';
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    try {
      // Determine which paths to search
      const searchPaths: string[] = [];
      let searchDirDisplay: string;

      if (this.params.path) {
        // User specified a path — search only that path
        const searchDirAbs = resolveAndValidatePath(
          this.config,
          this.params.path,
          { allowFiles: true, allowExternalPaths: true },
        );
        searchPaths.push(searchDirAbs);
        searchDirDisplay = this.params.path;
      } else {
        // No path specified — search all workspace directories
        const workspaceDirs = this.config
          .getWorkspaceContext()
          .getDirectories();
        searchPaths.push(...workspaceDirs);
        searchDirDisplay = '.';
      }

      // Get raw ripgrep output
      const { stdout: rawOutput, truncated: truncatedBySystemLimit } =
        await this.performRipgrepSearch({
          pattern: this.params.pattern,
          paths: searchPaths,
          glob: this.params.glob,
          signal,
        });

      // Build search description
      const searchLocationDescription = this.params.path
        ? `in path "${searchDirDisplay}"`
        : searchPaths.length > 1
          ? `across ${searchPaths.length} workspace directories`
          : `in the workspace directory`;

      const filterDescription = this.params.glob
        ? ` (filter: "${this.params.glob}")`
        : '';

      // Check if we have any matches
      if (!rawOutput.trim()) {
        const noMatchMsg = `No matches found for pattern "${this.params.pattern}" ${searchLocationDescription}${filterDescription}.`;
        return { llmContent: noMatchMsg, returnDisplay: `No matches found` };
      }

      let allLines = rawOutput
        .split('\n')
        .filter((line) => line.trim())
        .flatMap((line): RipgrepMatchLine[] => {
          if (line.startsWith('{')) {
            if (!line.startsWith('{"type":"match"')) return [];
            try {
              const parsed = JSON.parse(line) as unknown;
              if (!isRipgrepJsonMatch(parsed)) return [];
              const filePath = getRipgrepJsonPath(parsed);
              if (filePath === undefined) return [];
              const lineNumber = String(parsed.data.line_number);
              const content = parsed.data.lines?.text ?? '';
              return [
                {
                  rawLine: `${filePath}:${lineNumber}:${content.replace(/\r?\n$/, '')}`,
                  filePath,
                  key: `${filePath}:${lineNumber}`,
                },
              ];
            } catch {
              return [];
            }
          }

          const fields = line.split(RIPGREP_FIELD_SEPARATOR);
          if (fields.length === 1) {
            const firstColon = line.indexOf(':');
            const secondColon =
              firstColon === -1 ? -1 : line.indexOf(':', firstColon + 1);
            if (firstColon === -1 || secondColon === -1) return [];
            const filePath = line.substring(0, firstColon);
            const lineNumber = line.substring(firstColon + 1, secondColon);
            if (!/^[0-9]+$/.test(lineNumber)) return [];
            return [
              {
                rawLine: line,
                filePath,
                key: `${filePath}:${lineNumber}`,
              },
            ];
          }
          if (fields.length !== 3) return [];
          const [filePath, lineNumber, content] = fields;
          return [
            {
              rawLine: `${filePath}:${lineNumber}:${content}`,
              filePath,
              key: `${filePath}:${lineNumber}`,
            },
          ];
        });

      const filteringOptions = this.getFileFilteringOptions();
      if (filteringOptions.respectQwenIgnore) {
        allLines = this.filterQwenIgnoredMatches(
          allLines,
          searchPaths,
          filteringOptions.customIgnoreFiles,
        );
      }

      // Deduplicate lines from potentially overlapping workspace directories.
      // ripgrep reports the same file twice when given paths like /a and /a/sub.
      if (searchPaths.length > 1) {
        const seen = new Set<string>();
        allLines = allLines.filter((line) => {
          if (seen.has(line.key)) return false;
          seen.add(line.key);
          return true;
        });
      }

      const totalMatches = allLines.length;
      if (totalMatches === 0) {
        const noMatchMsg = `No matches found for pattern "${this.params.pattern}" ${searchLocationDescription}${filterDescription}.`;
        return { llmContent: noMatchMsg, returnDisplay: `No matches found` };
      }
      const matchTerm = totalMatches === 1 ? 'match' : 'matches';

      // Build header early to calculate available space
      const header = `Found ${totalMatches} ${matchTerm} for pattern "${this.params.pattern}" ${searchLocationDescription}${filterDescription}:\n---\n`;

      const charLimit = this.config.getTruncateToolOutputThreshold();
      const lineLimit = Math.min(
        this.config.getTruncateToolOutputLines(),
        this.params.limit ?? Number.POSITIVE_INFINITY,
      );

      // Apply line limit first (if specified)
      let truncatedByLineLimit = false;
      let linesToInclude = allLines;
      if (allLines.length > lineLimit) {
        linesToInclude = allLines.slice(0, lineLimit);
        truncatedByLineLimit = true;
      }

      // Build output and track how many lines we include, respecting character limit
      let grepOutput = '';
      let truncatedByCharLimit = false;
      let includedLines = 0;
      const visibleLines: RipgrepMatchLine[] = [];
      if (Number.isFinite(charLimit)) {
        const parts: string[] = [];
        let currentLength = 0;

        for (const line of linesToInclude) {
          const sep = includedLines > 0 ? 1 : 0;
          const projectedLength = currentLength + line.rawLine.length + sep;
          if (projectedLength <= charLimit) {
            parts.push(line.rawLine);
            visibleLines.push(line);
            includedLines++;
            currentLength = projectedLength;
          } else {
            const remaining = Math.max(charLimit - currentLength - sep, 10);
            const partialLine = line.rawLine.slice(0, remaining);
            parts.push(partialLine + '...');
            visibleLines.push(line);
            truncatedByCharLimit = true;
            break;
          }
        }

        grepOutput = parts.join('\n');
      } else {
        grepOutput = linesToInclude.map((line) => line.rawLine).join('\n');
        visibleLines.push(...linesToInclude);
        includedLines = linesToInclude.length;
      }

      // Build result
      let llmContent = header + grepOutput;

      // Add truncation notice if needed
      if (
        truncatedByLineLimit ||
        truncatedByCharLimit ||
        truncatedBySystemLimit
      ) {
        const omittedMatches = totalMatches - includedLines;
        llmContent += `\n---\n[${omittedMatches} ${omittedMatches === 1 ? 'line' : 'lines'} truncated] ...`;
      }

      // Build display message (show real count, not truncated)
      let displayMessage = `Found ${totalMatches} ${matchTerm}`;
      if (
        truncatedByLineLimit ||
        truncatedByCharLimit ||
        truncatedBySystemLimit
      ) {
        displayMessage += ` (truncated)`;
      }

      const resultFilePaths = Array.from(
        new Set(
          visibleLines.map((line) =>
            toAbsoluteResultPath(line.filePath, searchPaths),
          ),
        ),
      );

      return {
        llmContent: llmContent.trim(),
        returnDisplay: displayMessage,
        resultFilePaths,
      };
    } catch (error) {
      debugLogger.error('Error during ripgrep search operation:', error);
      const errorMessage = getErrorMessage(error);
      return {
        llmContent: `Error during grep search operation: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
      };
    }
  }

  private filterQwenIgnoredMatches(
    lines: RipgrepMatchLine[],
    searchPaths: string[],
    customIgnoreFiles?: string[],
  ): RipgrepMatchLine[] {
    const parsers = new Map<string, QwenIgnoreParser>();

    return lines.filter((line) => {
      const absolutePath = toAbsoluteResultPath(line.filePath, searchPaths);
      const ignoreRoot = this.getIgnoreRootForSearchPath(absolutePath);
      let parser = parsers.get(ignoreRoot);
      if (parser === undefined) {
        parser = new QwenIgnoreParser(ignoreRoot, customIgnoreFiles);
        parsers.set(ignoreRoot, parser);
      }

      return !parser.isIgnored(absolutePath);
    });
  }

  private async performRipgrepSearch(options: {
    pattern: string;
    paths: string[]; // Can be files or directories
    glob?: string;
    signal: AbortSignal;
  }): Promise<{ stdout: string; truncated: boolean }> {
    const { pattern, paths, glob } = options;
    const sanitizedIgnoreFiles: string[] = [];

    const rgArgs: string[] = [
      '--json',
      '--no-messages',
      '--path-separator',
      '/',
      '--ignore-case',
      '--regexp',
      pattern,
    ];

    // Add file exclusions from .gitignore and AI-specific ignore files
    const filteringOptions = this.getFileFilteringOptions();
    if (!filteringOptions.respectGitIgnore) {
      rgArgs.push('--no-ignore-vcs');
    }

    if (filteringOptions.respectQwenIgnore) {
      // Load ignore files from each workspace directory, not just the primary one.
      const seenIgnoreFiles = new Set<string>();
      const ignoreFileNames = getQwenIgnoreFileNames(
        filteringOptions.customIgnoreFiles,
      );
      for (const searchPath of paths) {
        const ignoreRoot = this.getIgnoreRootForSearchPath(searchPath);
        const cacheKey = [ignoreRoot, ...ignoreFileNames].join('\0');
        let qwenIgnorePaths = qwenIgnoreCache.get(cacheKey);
        if (qwenIgnorePaths === undefined) {
          qwenIgnorePaths = ignoreFileNames
            .map((ignoreFileName) => path.join(ignoreRoot, ignoreFileName))
            .filter((candidate) => fs.existsSync(candidate));
          qwenIgnoreCache.set(cacheKey, qwenIgnorePaths);
          trimCache(qwenIgnoreCache);
        }
        for (const qwenIgnorePath of qwenIgnorePaths) {
          if (!seenIgnoreFiles.has(qwenIgnorePath)) {
            const ripgrepIgnorePath = prepareRipgrepIgnoreFile(
              qwenIgnorePath,
              sanitizedIgnoreFiles,
            );
            if (ripgrepIgnorePath !== null) {
              rgArgs.push('--ignore-file', ripgrepIgnorePath);
            }
            seenIgnoreFiles.add(qwenIgnorePath);
          }
        }
      }
    }

    // Add glob pattern if provided
    if (glob) {
      rgArgs.push('--glob', glob);
    }

    rgArgs.push('--threads', '4');
    // Pass all search paths to ripgrep (it supports multiple paths natively)
    rgArgs.push(...paths);

    try {
      const result = await runRipgrep(rgArgs, options.signal);
      if (result.error && !result.stdout) {
        throw result.error;
      }

      return { stdout: result.stdout, truncated: result.truncated };
    } finally {
      if (sanitizedIgnoreFiles.length > 0) {
        fs.rmSync(sanitizedIgnoreFiles[0], { recursive: true, force: true });
      }
    }
  }

  private getIgnoreRootForSearchPath(searchPath: string): string {
    const resolvedSearchPath = path.resolve(searchPath);
    for (const workspaceDir of this.config
      .getWorkspaceContext()
      .getDirectories()) {
      const resolvedWorkspaceDir = path.resolve(workspaceDir);
      const relative = path.relative(resolvedWorkspaceDir, resolvedSearchPath);
      if (
        relative === '' ||
        (relative !== '..' &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative))
      ) {
        return resolvedWorkspaceDir;
      }
    }

    let isDir = dirIsDirCache.get(resolvedSearchPath);
    if (isDir === undefined) {
      try {
        isDir = fs.statSync(resolvedSearchPath).isDirectory();
      } catch {
        isDir = false;
      }
      dirIsDirCache.set(resolvedSearchPath, isDir);
      trimCache(dirIsDirCache);
    }
    return isDir ? resolvedSearchPath : path.dirname(resolvedSearchPath);
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

  /**
   * Gets a description of the grep operation
   * @returns A string describing the grep
   */
  getDescription(): string {
    let description = `'${this.params.pattern}'`;
    if (this.params.path) {
      description += ` in path '${this.params.path}'`;
    }
    if (this.params.glob) {
      description += ` (filter: '${this.params.glob}')`;
    }

    return description;
  }
}

/**
 * Implementation of the Grep tool logic
 */
export class RipGrepTool extends BaseDeclarativeTool<
  RipGrepToolParams,
  ToolResult
> {
  static readonly Name = ToolNames.GREP;

  constructor(private readonly config: Config) {
    super(
      RipGrepTool.Name,
      'Grep',
      'A powerful search tool built on ripgrep\n\n  Usage:\n  - ALWAYS use Grep for search tasks. NEVER invoke `grep` or `rg` as a Bash command. The Grep tool has been optimized for correct permissions and access.\n  - Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")\n  - Filter files with glob parameter (e.g., "*.js", "**/*.tsx")\n  - Use Agent tool for open-ended searches requiring multiple rounds\n  - Pattern syntax: Uses ripgrep (not grep) - special regex characters need escaping (use `interface\\{\\}` to find `interface{}` in Go code)\n',
      Kind.Search,
      {
        properties: {
          pattern: {
            type: 'string',
            description:
              'The regular expression pattern to search for in file contents',
          },
          glob: {
            type: 'string',
            description:
              'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob',
          },
          path: {
            type: 'string',
            description:
              'File or directory to search in (rg PATH). Defaults to current working directory.',
          },
          limit: {
            type: 'number',
            description:
              'Limit output to first N lines/entries. Optional - shows all matches if not specified.',
          },
        },
        required: ['pattern'],
        type: 'object',
      },
    );
  }

  /**
   * Validates the parameters for the tool
   * @param params Parameters to validate
   * @returns An error message string if invalid, null otherwise
   */
  protected override validateToolParamValues(
    params: RipGrepToolParams,
  ): string | null {
    const errors = SchemaValidator.validate(
      this.schema.parametersJsonSchema,
      params,
    );
    if (errors) {
      return errors;
    }

    // Validate pattern is a valid regex
    try {
      new RegExp(params.pattern);
    } catch (error) {
      return `Invalid regular expression pattern: ${params.pattern}. Error: ${getErrorMessage(error)}`;
    }

    // Only validate path if one is provided
    if (params.path) {
      params.path = unescapePath(params.path.trim());
      try {
        resolveAndValidatePath(this.config, params.path, {
          allowFiles: true,
          allowExternalPaths: true,
        });
      } catch (error) {
        return getErrorMessage(error);
      }
    }

    return null; // Parameters are valid
  }

  protected createInvocation(
    params: RipGrepToolParams,
  ): ToolInvocation<RipGrepToolParams, ToolResult> {
    return new GrepToolInvocation(this.config, params);
  }
}

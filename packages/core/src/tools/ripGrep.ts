/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames } from './tool-names.js';
import { resolveAndValidatePath } from '../utils/paths.js';
import { getErrorMessage } from '../utils/errors.js';
import type { Config } from '../config/config.js';
import { runRipgrep } from '../utils/ripgrepUtils.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import type { FileFilteringOptions } from '../config/constants.js';
import { DEFAULT_FILE_FILTERING_OPTIONS } from '../config/constants.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import type { PermissionDecision } from '../permissions/types.js';

const debugLogger = createDebugLogger('RIPGREP');

/**
 * Per-process cache for `.qwenignore` discovery. The same directories show
 * up across many Grep invocations in a typical session — without caching,
 * each invocation pays 2-3 sync syscalls per searchPath. Bounded so a
 * pathologically long session can't grow without limit.
 *
 * `dirIsDir`: searchPath → boolean (is the path itself a directory?)
 * `qwenIgnore`: dir → string | null (cached `.qwenignore` path or null)
 *
 * **Known staleness window:** a `.qwenignore` created mid-session, or a
 * searchPath whose type flips (dir→file or vice versa), will not be
 * picked up until the entry rotates out of the FIFO (256 entries). Users
 * rarely add ignore files mid-session; a process restart resets the cache.
 */
const dirIsDirCache = new Map<string, boolean>();
const qwenIgnoreCache = new Map<string, string | null>();
const RIPGREP_CACHE_MAX = 256;
function trimCache<K, V>(m: Map<K, V>): void {
  if (m.size <= RIPGREP_CACHE_MAX) return;
  const oldest = m.keys().next().value;
  if (oldest !== undefined) m.delete(oldest as K);
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
      const rawOutput = await this.performRipgrepSearch({
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

      // Split into lines and count total matches
      let allLines = rawOutput.split('\n').filter((line) => line.trim());

      // Deduplicate lines from potentially overlapping workspace directories.
      // ripgrep reports the same file twice when given paths like /a and /a/sub.
      if (searchPaths.length > 1) {
        const seen = new Set<string>();
        allLines = allLines.filter((line) => {
          // ripgrep output format: filepath:linenum:content
          const firstColon = line.indexOf(':');
          if (firstColon !== -1) {
            const secondColon = line.indexOf(':', firstColon + 1);
            if (secondColon !== -1) {
              const key = line.substring(0, secondColon);
              if (seen.has(key)) return false;
              seen.add(key);
            }
          }
          return true;
        });
      }

      const totalMatches = allLines.length;
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
      if (Number.isFinite(charLimit)) {
        const parts: string[] = [];
        let currentLength = 0;

        for (const line of linesToInclude) {
          const sep = includedLines > 0 ? 1 : 0;
          includedLines++;

          const projectedLength = currentLength + line.length + sep;
          if (projectedLength <= charLimit) {
            parts.push(line);
            currentLength = projectedLength;
          } else {
            const remaining = Math.max(charLimit - currentLength - sep, 10);
            parts.push(line.slice(0, remaining) + '...');
            truncatedByCharLimit = true;
            break;
          }
        }

        grepOutput = parts.join('\n');
      } else {
        grepOutput = linesToInclude.join('\n');
        includedLines = linesToInclude.length;
      }

      // Build result
      let llmContent = header + grepOutput;

      // Add truncation notice if needed
      if (truncatedByLineLimit || truncatedByCharLimit) {
        const omittedMatches = totalMatches - includedLines;
        llmContent += `\n---\n[${omittedMatches} ${omittedMatches === 1 ? 'line' : 'lines'} truncated] ...`;
      }

      // Build display message (show real count, not truncated)
      let displayMessage = `Found ${totalMatches} ${matchTerm}`;
      if (truncatedByLineLimit || truncatedByCharLimit) {
        displayMessage += ` (truncated)`;
      }

      return {
        llmContent: llmContent.trim(),
        returnDisplay: displayMessage,
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

  private async performRipgrepSearch(options: {
    pattern: string;
    paths: string[]; // Can be files or directories
    glob?: string;
    signal: AbortSignal;
  }): Promise<string> {
    const { pattern, paths, glob } = options;

    const rgArgs: string[] = [
      '--line-number',
      '--no-heading',
      '--with-filename',
      '--ignore-case',
      '--regexp',
      pattern,
    ];

    // Add file exclusions from .gitignore and .qwenignore
    const filteringOptions = this.getFileFilteringOptions();
    if (!filteringOptions.respectGitIgnore) {
      rgArgs.push('--no-ignore-vcs');
    }

    if (filteringOptions.respectQwenIgnore) {
      // Load .qwenignore from each workspace directory, not just the primary one
      const seenIgnoreFiles = new Set<string>();
      for (const searchPath of paths) {
        let isDir = dirIsDirCache.get(searchPath);
        if (isDir === undefined) {
          try {
            isDir = fs.statSync(searchPath).isDirectory();
          } catch {
            isDir = false;
          }
          dirIsDirCache.set(searchPath, isDir);
          trimCache(dirIsDirCache);
        }
        const dir = isDir ? searchPath : path.dirname(searchPath);
        let qwenIgnorePath = qwenIgnoreCache.get(dir);
        if (qwenIgnorePath === undefined) {
          const candidate = path.join(dir, '.qwenignore');
          qwenIgnorePath = fs.existsSync(candidate) ? candidate : null;
          qwenIgnoreCache.set(dir, qwenIgnorePath);
          trimCache(qwenIgnoreCache);
        }
        if (qwenIgnorePath && !seenIgnoreFiles.has(qwenIgnorePath)) {
          rgArgs.push('--ignore-file', qwenIgnorePath);
          seenIgnoreFiles.add(qwenIgnorePath);
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

    const result = await runRipgrep(rgArgs, options.signal);
    if (result.error && !result.stdout) {
      throw result.error;
    }

    return result.stdout;
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

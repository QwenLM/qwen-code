/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { EOL } from 'node:os';
import { spawn } from 'node:child_process';
import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames } from './tool-names.js';
import { makeRelative, shortenPath } from '../utils/paths.js';
import { getErrorMessage, isNodeError } from '../utils/errors.js';
import type { Config } from '../config/config.js';
import { ensureRipgrepPath } from '../utils/ripgrepUtils.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import type { FileFilteringOptions } from '../config/constants.js';
import { DEFAULT_FILE_FILTERING_OPTIONS } from '../config/constants.js';

const MAX_LLM_CONTENT_LENGTH = 20_000;

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
   * Checks if a path is within the root directory and resolves it.
   * @param relativePath Path relative to the root directory (or undefined for root).
   * @returns The absolute path to search within.
   * @throws {Error} If path is outside root, doesn't exist, or isn't a directory.
   */
  private resolveAndValidatePath(relativePath?: string): string {
    const targetDir = this.config.getTargetDir();
    const targetPath = relativePath
      ? path.resolve(targetDir, relativePath)
      : targetDir;

    const workspaceContext = this.config.getWorkspaceContext();
    if (!workspaceContext.isPathWithinWorkspace(targetPath)) {
      const directories = workspaceContext.getDirectories();
      throw new Error(
        `Path validation failed: Attempted path "${relativePath}" resolves outside the allowed workspace directories: ${directories.join(', ')}`,
      );
    }

    return this.ensureDirectory(targetPath);
  }

  private ensureDirectory(targetPath: string): string {
    try {
      const stats = fs.statSync(targetPath);
      if (!stats.isDirectory()) {
        throw new Error(`Path is not a directory: ${targetPath}`);
      }
    } catch (error: unknown) {
      if (isNodeError(error) && error.code !== 'ENOENT') {
        throw new Error(`Path does not exist: ${targetPath}`);
      }
      throw new Error(
        `Failed to access path stats for ${targetPath}: ${error}`,
      );
    }

    return targetPath;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    try {
      const searchDirAbs = this.resolveAndValidatePath(this.params.path);
      const searchDirDisplay = this.params.path || '.';

      // Get raw ripgrep output
      const rawOutput = await this.performRipgrepSearch({
        pattern: this.params.pattern,
        path: searchDirAbs,
        glob: this.params.glob,
        signal,
      });

      // Build search description
      const searchLocationDescription = this.params.path
        ? `in path "${searchDirDisplay}"`
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
      const allLines = rawOutput.split(EOL).filter((line) => line.trim());
      const totalMatches = allLines.length;
      const matchTerm = totalMatches === 1 ? 'match' : 'matches';

      // Build header early to calculate available space
      const header = `Found ${totalMatches} ${matchTerm} for pattern "${this.params.pattern}" ${searchLocationDescription}${filterDescription}:\n---\n`;
      const maxTruncationNoticeLength = 100; // "[... N more matches truncated]"
      const maxGrepOutputLength =
        MAX_LLM_CONTENT_LENGTH - header.length - maxTruncationNoticeLength;

      // Apply line limit first (if specified)
      let truncatedByLineLimit = false;
      let linesToInclude = allLines;
      if (
        this.params.limit !== undefined &&
        allLines.length > this.params.limit
      ) {
        linesToInclude = allLines.slice(0, this.params.limit);
        truncatedByLineLimit = true;
      }

      // Join lines back into grep output
      let grepOutput = linesToInclude.join(EOL);

      // Apply character limit as safety net
      let truncatedByCharLimit = false;
      if (grepOutput.length > maxGrepOutputLength) {
        grepOutput = grepOutput.slice(0, maxGrepOutputLength) + '...';
        truncatedByCharLimit = true;
      }

      // Count how many lines we actually included after character truncation
      const finalLines = grepOutput.split(EOL).filter((line) => line.trim());
      const includedLines = finalLines.length;

      // Build result
      let llmContent = header + grepOutput;

      // Add truncation notice if needed
      if (truncatedByLineLimit || truncatedByCharLimit) {
        const omittedMatches = totalMatches - includedLines;
        llmContent += ` [${omittedMatches} ${omittedMatches === 1 ? 'line' : 'lines'} truncated] ...`;
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
      console.error(`Error during GrepLogic execution: ${error}`);
      const errorMessage = getErrorMessage(error);
      return {
        llmContent: `Error during grep search operation: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
      };
    }
  }

  private async performRipgrepSearch(options: {
    pattern: string;
    path: string;
    glob?: string;
    signal: AbortSignal;
  }): Promise<string> {
    const { pattern, path: absolutePath, glob } = options;

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
      const qwenIgnorePath = path.join(
        this.config.getTargetDir(),
        '.qwenignore',
      );
      if (fs.existsSync(qwenIgnorePath)) {
        rgArgs.push('--ignore-file', qwenIgnorePath);
      }
    }

    // Add glob pattern if provided
    if (glob) {
      rgArgs.push('--glob', glob);
    }

    rgArgs.push('--threads', '4');
    rgArgs.push(absolutePath);

    try {
      const rgPath = this.config.getUseBuiltinRipgrep()
        ? await ensureRipgrepPath()
        : 'rg';
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(rgPath, rgArgs, {
          windowsHide: true,
        });

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];

        const cleanup = () => {
          if (options.signal.aborted) {
            child.kill();
          }
        };

        options.signal.addEventListener('abort', cleanup, { once: true });

        child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
        child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

        child.on('error', (err) => {
          options.signal.removeEventListener('abort', cleanup);
          reject(new Error(`Failed to start ripgrep: ${err.message}.`));
        });

        child.on('close', (code) => {
          options.signal.removeEventListener('abort', cleanup);
          const stdoutData = Buffer.concat(stdoutChunks).toString('utf8');
          const stderrData = Buffer.concat(stderrChunks).toString('utf8');

          if (code === 0) {
            resolve(stdoutData);
          } else if (code === 1) {
            resolve(''); // No matches found
          } else {
            reject(
              new Error(`ripgrep exited with code ${code}: ${stderrData}`),
            );
          }
        });
      });

      return output;
    } catch (error: unknown) {
      console.error(`GrepLogic: ripgrep failed: ${getErrorMessage(error)}`);
      throw error;
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
    };
  }

  /**
   * Gets a description of the grep operation
   * @returns A string describing the grep
   */
  getDescription(): string {
    let description = `'${this.params.pattern}'`;
    if (this.params.glob) {
      description += ` in ${this.params.glob}`;
    }
    if (this.params.path) {
      const resolvedPath = path.resolve(
        this.config.getTargetDir(),
        this.params.path,
      );
      if (
        resolvedPath === this.config.getTargetDir() ||
        this.params.path === '.'
      ) {
        description += ` within ./`;
      } else {
        const relativePath = makeRelative(
          resolvedPath,
          this.config.getTargetDir(),
        );
        description += ` within ${shortenPath(relativePath)}`;
      }
    } else {
      // When no path is specified, indicate searching all workspace directories
      const workspaceContext = this.config.getWorkspaceContext();
      const directories = workspaceContext.getDirectories();
      if (directories.length > 1) {
        description += ` across all workspace directories`;
      }
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
      'A powerful search tool built on ripgrep\n\n  Usage:\n  - ALWAYS use Grep for search tasks. NEVER invoke `grep` or `rg` as a Bash command. The Grep tool has been optimized for correct permissions and access.\n  - Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")\n  - Filter files with glob parameter (e.g., "*.js", "**/*.tsx")\n  - Use Task tool for open-ended searches requiring multiple rounds\n  - Pattern syntax: Uses ripgrep (not grep) - special regex characters need escaping (use `interface\\{\\}` to find `interface{}` in Go code)\n',
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
   * Checks if a path is within the root directory and resolves it.
   * @param relativePath Path relative to the root directory (or undefined for root).
   * @returns The absolute path to search within.
   * @throws {Error} If path is outside root, doesn't exist, or isn't a directory.
   */
  private resolveAndValidatePath(relativePath?: string): string {
    // If no path specified, search within the workspace root directory
    if (!relativePath) {
      return this.config.getTargetDir();
    }

    const targetPath = path.resolve(this.config.getTargetDir(), relativePath);

    // Security Check: Ensure the resolved path is within workspace boundaries
    const workspaceContext = this.config.getWorkspaceContext();
    if (!workspaceContext.isPathWithinWorkspace(targetPath)) {
      const directories = workspaceContext.getDirectories();
      throw new Error(
        `Path validation failed: Attempted path "${relativePath}" resolves outside the allowed workspace directories: ${directories.join(', ')}`,
      );
    }

    // Check existence and type after resolving
    try {
      const stats = fs.statSync(targetPath);
      if (!stats.isDirectory()) {
        throw new Error(`Path is not a directory: ${targetPath}`);
      }
    } catch (error: unknown) {
      if (isNodeError(error) && error.code !== 'ENOENT') {
        throw new Error(`Path does not exist: ${targetPath}`);
      }
      throw new Error(
        `Failed to access path stats for ${targetPath}: ${error}`,
      );
    }

    return targetPath;
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
        this.resolveAndValidatePath(params.path);
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

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  ToolInvocation,
  ToolResult,
  Kind,
} from './tools.js';
import { Config } from '../config/config.js';
import { getErrorMessage, isNodeError } from '../utils/errors.js';
import { isGitRepository, findGitRoot } from '../utils/gitUtils.js';

// --- Interfaces ---

/**
 * Parameters for the GitSearchTool
 */
export interface GitSearchToolParams {
  /**
   * The search query - can be a commit message pattern, function name, or keyword
   */
  query: string;

  /**
   * The type of git search to perform
   */
  searchType: 'commit-message' | 'code-change' | 'file-history' | 'blame';

  /**
   * The directory to search in (optional, defaults to current directory)
   */
  path?: string;

  /**
   * Maximum number of results to return (optional, defaults to 20)
   */
  maxResults?: number;
}

class GitSearchToolInvocation extends BaseToolInvocation<
  GitSearchToolParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: GitSearchToolParams,
  ) {
    super(params);
  }

  /**
   * Checks if a path is within the root directory and resolves it.
   * @param relativePath Path relative to the root directory (or undefined for root).
   * @returns The absolute path if valid and exists, or null if no path specified.
   * @throws {Error} If path is outside root, doesn't exist, or isn't a directory.
   */
  private resolveAndValidatePath(relativePath?: string): string | null {
    // If no path specified, return null to indicate searching in current directory
    if (!relativePath) {
      return null;
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

  async execute(signal: AbortSignal): Promise<ToolResult> {
    try {
      const searchDirAbs =
        this.resolveAndValidatePath(this.params.path) ||
        this.config.getTargetDir();

      // Check if directory is a git repository
      if (!isGitRepository(searchDirAbs)) {
        return {
          llmContent: `Error: Directory "${searchDirAbs}" is not a git repository.`,
          returnDisplay: `Error: Not a git repository`,
        };
      }

      // Find the git root
      const gitRoot = findGitRoot(searchDirAbs);
      if (!gitRoot) {
        return {
          llmContent: `Error: Could not find git repository root for "${searchDirAbs}".`,
          returnDisplay: `Error: Git root not found`,
        };
      }

      let results: string;
      let displayText: string;

      switch (this.params.searchType) {
        case 'commit-message':
          ({ results, displayText } = await this.searchCommitMessages(
            this.params.query,
            gitRoot,
            this.params.maxResults,
            signal,
          ));
          break;
        case 'code-change':
          ({ results, displayText } = await this.searchCodeChanges(
            this.params.query,
            gitRoot,
            this.params.maxResults,
            signal,
          ));
          break;
        case 'file-history':
          ({ results, displayText } = await this.searchFileHistory(
            this.params.query,
            gitRoot,
            this.params.maxResults,
            signal,
          ));
          break;
        case 'blame':
          ({ results, displayText } = await this.searchBlame(
            this.params.query,
            gitRoot,
            signal,
          ));
          break;
        default:
          return {
            llmContent: `Error: Unknown search type "${this.params.searchType}".`,
            returnDisplay: `Error: Unknown search type`,
          };
      }

      return {
        llmContent: results,
        returnDisplay: displayText,
      };
    } catch (error) {
      console.error(`Error during GitSearchTool execution: ${error}`);
      const errorMessage = getErrorMessage(error);
      return {
        llmContent: `Error during git search operation: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
      };
    }
  }

  /**
   * Gets a description of the git search operation
   * @returns A string describing the git search
   */
  getDescription(): string {
    let description = `'${this.params.query}'`;
    if (this.params.path) {
      description += ` in ${this.params.path}`;
    }
    description += ` (${this.params.searchType})`;
    return description;
  }

  /**
   * Searches for commits with messages matching the query
   */
  private async searchCommitMessages(
    query: string,
    gitRoot: string,
    maxResults: number = 20,
    signal: AbortSignal,
  ): Promise<{ results: string; displayText: string }> {
    const gitArgs = [
      'log',
      '--grep',
      query,
      '--oneline',
      `--max-count=${maxResults}`,
    ];

    try {
      const output = await this.executeGitCommand(gitArgs, gitRoot, signal);
      const lines = output
        .trim()
        .split('\n')
        .filter((line) => line.trim() !== '');

      if (lines.length === 0) {
        return {
          results: `No commits found with message containing "${query}".`,
          displayText: `No commits found`,
        };
      }

      const header = `Found ${lines.length} commit(s) with message containing "${query}":\n---\n`;
      const formattedResults = lines
        .map((line) => `Commit: ${line}`)
        .join('\n');
      const footer =
        '\n---\n\nUse "git show <commit-hash>" to see details of a specific commit.';

      return {
        results: header + formattedResults + footer,
        displayText: `Found ${lines.length} commit(s)`,
      };
    } catch (error) {
      throw new Error(
        `Failed to search commit messages: ${getErrorMessage(error)}`,
      );
    }
  }

  /**
   * Searches for commits that added or removed code matching the query
   */
  private async searchCodeChanges(
    query: string,
    gitRoot: string,
    maxResults: number = 20,
    signal: AbortSignal,
  ): Promise<{ results: string; displayText: string }> {
    const gitArgs = [
      'log',
      '-S',
      query,
      '--oneline',
      `--max-count=${maxResults}`,
    ];

    try {
      const output = await this.executeGitCommand(gitArgs, gitRoot, signal);
      const lines = output
        .trim()
        .split('\n')
        .filter((line) => line.trim() !== '');

      if (lines.length === 0) {
        return {
          results: `No commits found that added or removed code containing "${query}".`,
          displayText: `No commits found`,
        };
      }

      const header = `Found ${lines.length} commit(s) that added or removed code containing "${query}":\n---\n`;
      const formattedResults = lines
        .map((line) => `Commit: ${line}`)
        .join('\n');
      const footer =
        '\n---\n\nUse "git show <commit-hash>" to see details of a specific commit.';

      return {
        results: header + formattedResults + footer,
        displayText: `Found ${lines.length} commit(s)`,
      };
    } catch (error) {
      throw new Error(
        `Failed to search code changes: ${getErrorMessage(error)}`,
      );
    }
  }

  /**
   * Searches for the history of a specific file
   */
  private async searchFileHistory(
    filePath: string,
    gitRoot: string,
    maxResults: number = 20,
    signal: AbortSignal,
  ): Promise<{ results: string; displayText: string }> {
    const gitArgs = [
      'log',
      '--oneline',
      `--max-count=${maxResults}`,
      '--follow',
      '--',
      filePath,
    ];

    try {
      const output = await this.executeGitCommand(gitArgs, gitRoot, signal);
      const lines = output
        .trim()
        .split('\n')
        .filter((line) => line.trim() !== '');

      if (lines.length === 0) {
        return {
          results: `No history found for file "${filePath}".`,
          displayText: `No history found`,
        };
      }

      const header = `Found ${lines.length} commit(s) affecting file "${filePath}":\n---\n`;
      const formattedResults = lines
        .map((line) => `Commit: ${line}`)
        .join('\n');
      const footer =
        '\n---\n\nUse "git show <commit-hash>" to see details of a specific commit.';

      return {
        results: header + formattedResults + footer,
        displayText: `Found ${lines.length} commit(s)`,
      };
    } catch (error) {
      throw new Error(
        `Failed to search file history: ${getErrorMessage(error)}`,
      );
    }
  }

  /**
   * Shows blame information for lines in a file matching the query
   */
  private async searchBlame(
    filePath: string,
    gitRoot: string,
    signal: AbortSignal,
  ): Promise<{ results: string; displayText: string }> {
    const gitArgs = ['blame', '--', filePath];

    try {
      const output = await this.executeGitCommand(gitArgs, gitRoot, signal);
      const lines = output
        .trim()
        .split('\n')
        .filter((line) => line.trim() !== '');

      if (lines.length === 0) {
        return {
          results: `No blame information found for file "${filePath}".`,
          displayText: `No blame information found`,
        };
      }

      const header = `Blame information for file "${filePath}":\n---\n`;
      const formattedResults = lines.join('\n');
      const footer = '\n---';

      return {
        results: header + formattedResults + footer,
        displayText: `Blame information for ${filePath}`,
      };
    } catch (error) {
      throw new Error(
        `Failed to get blame information: ${getErrorMessage(error)}`,
      );
    }
  }

  /**
   * Executes a git command and returns its output
   */
  private async executeGitCommand(
    args: string[],
    cwd: string,
    signal: AbortSignal,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, {
        cwd,
        windowsHide: true,
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

      child.on('error', (err) =>
        reject(new Error(`Failed to start git: ${err.message}`)),
      );

      child.on('close', (code) => {
        const stdoutData = Buffer.concat(stdoutChunks).toString('utf8');
        const stderrData = Buffer.concat(stderrChunks).toString('utf8');

        if (code === 0) {
          resolve(stdoutData);
        } else if (code === 1) {
          resolve(''); // No matches
        } else {
          reject(
            new Error(`git ${args[0]} exited with code ${code}: ${stderrData}`),
          );
        }
      });

      // Handle abort signal
      const onAbort = () => {
        child.kill();
        reject(new Error('Git command was aborted'));
      };

      signal.addEventListener('abort', onAbort);

      child.on('close', () => {
        signal.removeEventListener('abort', onAbort);
      });
    });
  }
}

/**
 * Implementation of the Git Search tool
 */
export class GitSearchTool extends BaseDeclarativeTool<
  GitSearchToolParams,
  ToolResult
> {
  static readonly Name = 'git_search';

  constructor(private readonly config: Config) {
    super(
      GitSearchTool.Name,
      'GitSearch',
      'Searches a git repository for commits, code changes, file history, or blame information.',
      Kind.Search,
      {
        properties: {
          query: {
            description:
              'The search query - can be a commit message pattern, function name, keyword, or file path.',
            type: 'string',
          },
          searchType: {
            description:
              'The type of git search to perform: commit-message, code-change, file-history, or blame.',
            type: 'string',
            enum: ['commit-message', 'code-change', 'file-history', 'blame'],
          },
          path: {
            description:
              'Optional: The path to the directory to search within. If omitted, searches the current working directory.',
            type: 'string',
          },
          maxResults: {
            description:
              'Optional: Maximum number of results to return (default: 20, max: 100).',
            type: 'number',
            minimum: 1,
            maximum: 100,
          },
        },
        required: ['query', 'searchType'],
        type: 'object',
      },
    );
  }

  /**
   * Checks if a path is within the root directory and resolves it.
   * @param relativePath Path relative to the root directory (or undefined for root).
   * @returns The absolute path if valid and exists, or null if no path specified.
   * @throws {Error} If path is outside root, doesn't exist, or isn't a directory.
   */
  private resolveAndValidatePath(relativePath?: string): string | null {
    // If no path specified, return null to indicate searching in current directory
    if (!relativePath) {
      return null;
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
    params: GitSearchToolParams,
  ): string | null {
    // Validate maxResults if provided
    if (params.maxResults !== undefined) {
      if (
        !Number.isInteger(params.maxResults) ||
        params.maxResults < 1 ||
        params.maxResults > 100
      ) {
        return `maxResults must be an integer between 1 and 100, got: ${params.maxResults}`;
      }
    }

    // Only validate path if one is provided
    if (params.path) {
      try {
        this.resolveAndValidatePath(params.path);
      } catch (error) {
        return getErrorMessage(error);
      }
    }

    // Validate searchType
    const validTypes = [
      'commit-message',
      'code-change',
      'file-history',
      'blame',
    ];
    if (!validTypes.includes(params.searchType)) {
      return `searchType must be one of: ${validTypes.join(', ')}, got: ${params.searchType}`;
    }

    return null; // Parameters are valid
  }

  protected createInvocation(
    params: GitSearchToolParams,
  ): ToolInvocation<GitSearchToolParams, ToolResult> {
    return new GitSearchToolInvocation(this.config, params);
  }
}

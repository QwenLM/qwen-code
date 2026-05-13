/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import type { Config } from '../config/config.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';
import { GitWorktreeService } from '../services/gitWorktreeService.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('ENTER_WORKTREE');

export interface EnterWorktreeParams {
  /**
   * Optional name (slug) for the worktree. Allowed characters:
   * letters, digits, dot, underscore, hyphen. Maximum 64 characters.
   * If omitted, an auto-generated `{adj}-{noun}-{4hex}` slug is used.
   */
  name?: string;
}

const enterWorktreeDescription = `Creates an isolated git worktree at \`<projectRoot>/.qwen/worktrees/<slug>\` and returns its absolute path so subsequent file edits, shell commands, and other tools can operate inside it.

## When to Use

Only invoke this tool when the user **explicitly asks for a worktree** — e.g. "start a worktree", "use a worktree", "work in a worktree", "create a worktree".

## When NOT to Use

Do NOT call this tool when the user simply asks to fix a bug, implement a feature, create a branch, or check out code — those tasks belong to the regular working directory unless the user specifically mentions worktrees.

## Behavior

- Requires the current project to be a git repository.
- Creates a new branch \`worktree-<slug>\` based on the current branch.
- Returns the absolute \`worktreePath\`. From that point on, route every file path you create or edit through this directory; absolute paths are recommended.
- The worktree persists across the session until \`exit_worktree\` is invoked.
`;

interface EnterWorktreeOutput {
  worktreePath: string;
  worktreeBranch: string;
  message: string;
}

class EnterWorktreeInvocation extends BaseToolInvocation<
  EnterWorktreeParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: EnterWorktreeParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return this.params.name
      ? `Enter worktree "${this.params.name}"`
      : 'Enter a new worktree';
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const cwd = this.config.getTargetDir();

    // First-pass service rooted at cwd, only to find the repo top-level.
    // We can't use cwd as the worktree anchor because launching from a
    // monorepo subdirectory would scatter `.qwen/worktrees/` under each
    // package's directory, and the startup sweep at `Config.initialize`
    // would never find them.
    const probe = new GitWorktreeService(cwd);

    const gitCheck = await probe.checkGitAvailable();
    if (!gitCheck.available) {
      const reason = gitCheck.error ?? 'Git is not available.';
      debugLogger.warn(`enter_worktree: ${reason}`);
      return errorResult(reason);
    }

    const isRepo = await probe.isGitRepository();
    if (!isRepo) {
      const reason = `Cannot create a worktree: ${cwd} is not a git repository. Initialize the repo with \`git init\` first.`;
      debugLogger.warn(`enter_worktree: ${reason}`);
      return errorResult(reason);
    }

    // Resolve to the repo's top-level so worktrees always live under
    // `<repoRoot>/.qwen/worktrees/`, regardless of which subdirectory
    // the user invoked the tool from.
    const projectRoot = (await probe.getRepoTopLevel()) ?? cwd;
    const service =
      projectRoot === cwd ? probe : new GitWorktreeService(projectRoot);

    // Treat an empty `name` ('') the same as undefined — some models pass
    // `{ name: '' }` when the schema marks `name` as optional, expecting
    // the auto-generated slug. Without this, validation would reject the
    // empty string before reaching the auto-slug path.
    const requested =
      this.params.name && this.params.name.length > 0
        ? this.params.name
        : undefined;
    const slug = requested ?? GitWorktreeService.generateAutoSlug();
    const validation = GitWorktreeService.validateUserWorktreeSlug(slug);
    if (validation) {
      debugLogger.warn(`enter_worktree: invalid slug ${slug}: ${validation}`);
      return errorResult(validation);
    }

    const result = await service.createUserWorktree(slug);
    if (!result.success || !result.worktree) {
      const reason = result.error ?? 'Failed to create worktree.';
      debugLogger.warn(`enter_worktree: createUserWorktree failed: ${reason}`);
      return errorResult(reason);
    }

    const output: EnterWorktreeOutput = {
      worktreePath: result.worktree.path,
      worktreeBranch: result.worktree.branch,
      message:
        `Created worktree "${slug}" at ${result.worktree.path} on branch ${result.worktree.branch}. ` +
        `Use this absolute path for all subsequent file operations until you call ${ToolNames.EXIT_WORKTREE}.`,
    };

    debugLogger.debug(
      `Created user worktree: ${output.worktreePath} (branch=${output.worktreeBranch})`,
    );

    return {
      llmContent: JSON.stringify(output),
      returnDisplay:
        `Worktree **${slug}** created on branch \`${result.worktree.branch}\`\n` +
        `\`${result.worktree.path}\``,
    };
  }
}

function errorResult(message: string): ToolResult {
  return {
    llmContent: `Error: ${message}`,
    returnDisplay: `Error: ${message}`,
    error: { message },
  };
}

export class EnterWorktreeTool extends BaseDeclarativeTool<
  EnterWorktreeParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.ENTER_WORKTREE;

  constructor(private readonly config: Config) {
    super(
      EnterWorktreeTool.Name,
      ToolDisplayNames.ENTER_WORKTREE,
      enterWorktreeDescription,
      Kind.Other,
      {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              'Optional slug (letters, digits, dot, underscore, hyphen; max 64 chars). Auto-generated when omitted.',
          },
        },
        additionalProperties: false,
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
      true, // isOutputMarkdown
      false, // canUpdateOutput
      true, // shouldDefer — only invoked when the user explicitly asks for a worktree
      false, // alwaysLoad
      'worktree git isolated branch new',
    );
  }

  override validateToolParams(params: EnterWorktreeParams): string | null {
    if (params.name !== undefined) {
      if (typeof params.name !== 'string') {
        return 'Parameter "name" must be a string.';
      }
      // Empty string is treated as "not provided" — `execute` falls back
      // to an auto-generated slug. Skip slug-format validation here so
      // the auto-slug path is reachable.
      if (params.name.length === 0) {
        return null;
      }
      const error = GitWorktreeService.validateUserWorktreeSlug(params.name);
      if (error) return error;
    }
    return null;
  }

  protected createInvocation(params: EnterWorktreeParams) {
    return new EnterWorktreeInvocation(this.config, params);
  }
}

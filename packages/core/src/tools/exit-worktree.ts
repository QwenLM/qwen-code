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
import * as fs from 'node:fs/promises';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('EXIT_WORKTREE');

export interface ExitWorktreeParams {
  /**
   * The name (slug) of the worktree to exit, as provided to or returned
   * by `enter_worktree`.
   */
  name: string;
  /**
   * What to do with the worktree:
   * - `'keep'` — leave the worktree directory and branch intact for later use.
   * - `'remove'` — delete the worktree directory and branch.
   */
  action: 'keep' | 'remove';
  /**
   * When `action='remove'`, must be `true` to delete a worktree that has
   * uncommitted changes (tracked or untracked).
   */
  discard_changes?: boolean;
}

const exitWorktreeDescription = `Exits a worktree previously created by ${ToolNames.ENTER_WORKTREE}.

## Behavior

- \`action='keep'\` — preserves the worktree directory and branch on disk so it can be revisited later. Use when work is in progress and the user might come back to it.
- \`action='remove'\` — deletes the worktree directory and branch. **Refuses to run** if the worktree contains uncommitted changes (tracked or untracked) unless \`discard_changes: true\` is set. Use when the work is committed (or intentionally being discarded).

## When to Use

Only invoke this tool when the user explicitly asks to leave or clean up a worktree (e.g. "exit the worktree", "remove that worktree", "we're done with the worktree"). Always pass the same \`name\` that was used with \`${ToolNames.ENTER_WORKTREE}\`.
`;

interface ExitWorktreeOutput {
  action: 'keep' | 'remove';
  worktreePath: string;
  worktreeBranch: string;
  message: string;
}

class ExitWorktreeInvocation extends BaseToolInvocation<
  ExitWorktreeParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: ExitWorktreeParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return this.params.action === 'remove'
      ? `Remove worktree "${this.params.name}"`
      : `Keep worktree "${this.params.name}"`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const projectRoot = this.config.getTargetDir();
    const service = new GitWorktreeService(projectRoot);

    const worktreePath = service.getUserWorktreePath(this.params.name);
    const branch = `worktree-${this.params.name}`;

    // Confirm the worktree directory actually exists before doing anything.
    let exists = false;
    try {
      const stat = await fs.stat(worktreePath);
      exists = stat.isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) {
      return errorResult(
        `Worktree "${this.params.name}" not found at ${worktreePath}.`,
      );
    }

    if (this.params.action === 'keep') {
      const output: ExitWorktreeOutput = {
        action: 'keep',
        worktreePath,
        worktreeBranch: branch,
        message:
          `Kept worktree "${this.params.name}" at ${worktreePath}. ` +
          `Resume work there by referencing this path in subsequent tool calls.`,
      };
      return {
        llmContent: JSON.stringify(output),
        returnDisplay: `Kept worktree **${this.params.name}** at \`${worktreePath}\``,
      };
    }

    // action === 'remove'
    if (!this.params.discard_changes) {
      const counts = await service.countWorktreeChanges(worktreePath);
      if (counts === null) {
        return errorResult(
          `Cannot inspect worktree "${this.params.name}" to verify it has no changes. ` +
            `Pass \`discard_changes: true\` to remove anyway.`,
        );
      }
      const total = counts.tracked + counts.untracked;
      if (total > 0) {
        return errorResult(
          `Refusing to remove worktree "${this.params.name}" — it has ` +
            `${counts.tracked} tracked change(s) and ${counts.untracked} untracked file(s). ` +
            `Commit or stash first, or call again with \`discard_changes: true\`.`,
        );
      }
    }

    const result = await service.removeUserWorktree(this.params.name, {
      deleteBranch: true,
    });
    if (!result.success) {
      return errorResult(result.error ?? 'Failed to remove worktree.');
    }

    debugLogger.debug(
      `Removed user worktree: ${worktreePath} (branch=${branch})`,
    );

    const output: ExitWorktreeOutput = {
      action: 'remove',
      worktreePath,
      worktreeBranch: branch,
      message: `Removed worktree "${this.params.name}" and deleted branch ${branch}.`,
    };
    return {
      llmContent: JSON.stringify(output),
      returnDisplay: `Removed worktree **${this.params.name}** (branch \`${branch}\`)`,
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

export class ExitWorktreeTool extends BaseDeclarativeTool<
  ExitWorktreeParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.EXIT_WORKTREE;

  constructor(private readonly config: Config) {
    super(
      ExitWorktreeTool.Name,
      ToolDisplayNames.EXIT_WORKTREE,
      exitWorktreeDescription,
      Kind.Other,
      {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              'Slug of the worktree to exit (must match the name used in enter_worktree).',
          },
          action: {
            type: 'string',
            enum: ['keep', 'remove'],
            description:
              '"keep" preserves the worktree on disk; "remove" deletes it and its branch.',
          },
          discard_changes: {
            type: 'boolean',
            description:
              'When action="remove", must be true to delete a worktree with uncommitted changes.',
          },
        },
        required: ['name', 'action'],
        additionalProperties: false,
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
      true, // isOutputMarkdown
      false, // canUpdateOutput
    );
  }

  override validateToolParams(params: ExitWorktreeParams): string | null {
    if (typeof params.name !== 'string' || params.name.trim() === '') {
      return 'Parameter "name" must be a non-empty string.';
    }
    const slugError = GitWorktreeService.validateUserWorktreeSlug(params.name);
    if (slugError) return slugError;

    if (params.action !== 'keep' && params.action !== 'remove') {
      return 'Parameter "action" must be either "keep" or "remove".';
    }
    if (
      params.discard_changes !== undefined &&
      typeof params.discard_changes !== 'boolean'
    ) {
      return 'Parameter "discard_changes" must be a boolean.';
    }
    return null;
  }

  protected createInvocation(params: ExitWorktreeParams) {
    return new ExitWorktreeInvocation(this.config, params);
  }
}

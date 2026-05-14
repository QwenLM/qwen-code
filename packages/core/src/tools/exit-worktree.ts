/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ToolCallConfirmationDetails,
  ToolConfirmationPayload,
  ToolExecuteConfirmationDetails,
  ToolResult,

  ToolConfirmationOutcome} from './tools.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind
} from './tools.js';
import type { Config } from '../config/config.js';
import type { PermissionDecision } from '../permissions/types.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';
import {
  GitWorktreeService,
  readWorktreeSessionMarker,
  worktreeBranchForSlug,
} from '../services/gitWorktreeService.js';
import * as fs from 'node:fs/promises';
import { isNodeError } from '../utils/errors.js';
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

  /**
   * `action: 'remove'` deletes a worktree directory and (when safe) its
   * branch. Other destructive tools (`edit`, `write_file`,
   * `run_shell_command`) prompt by default; this tool should too. The
   * `keep` action is non-destructive (it only restores the original
   * working directory) and falls back to the framework default.
   */
  override async getDefaultPermission(): Promise<PermissionDecision> {
    return this.params.action === 'remove' ? 'ask' : 'allow';
  }

  /**
   * Override the framework's default `type: 'info'` confirmation for
   * `action: 'remove'` so it is NOT silently auto-approved in
   * `AUTO_EDIT` mode.
   *
   * Background: `permissionFlow.ts:isAutoEditApproved` auto-approves
   * any tool whose `confirmationDetails.type` is `'edit'` or `'info'`
   * when the session is in `AUTO_EDIT`. The base `BaseToolInvocation`
   * returns `type: 'info'` by default, which means a `getDefaultPermission`
   * of `'ask'` still gets bypassed in AUTO_EDIT — the data-loss path
   * we explicitly closed for `DEFAULT` mode. Returning `type: 'exec'`
   * (the same bucket `run_shell_command` lives in) keeps the
   * confirmation prompt for AUTO_EDIT users too. `keep` falls through
   * to the base info-type since it is non-destructive.
   */
  override async getConfirmationDetails(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails> {
    if (this.params.action !== 'remove') {
      return super.getConfirmationDetails(_abortSignal);
    }
    const projectRoot = this.config.getTargetDir();
    const wtService = new GitWorktreeService(projectRoot);
    const worktreePath = wtService.getUserWorktreePath(this.params.name);
    const branch = worktreeBranchForSlug(this.params.name);
    const command =
      `git worktree remove ${worktreePath}` + ` && git branch -d ${branch}`;
    const details: ToolExecuteConfirmationDetails = {
      type: 'exec',
      title: `Remove worktree "${this.params.name}"`,
      command,
      rootCommand: 'git',
      onConfirm: async (
        _outcome: ToolConfirmationOutcome,
        _payload?: ToolConfirmationPayload,
      ) => {
        // No-op: persistence handled by coreToolScheduler via PM rules.
      },
    };
    return details;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    // Mirror `enter_worktree`: anchor at the repo top-level so we look
    // for the worktree under the same directory it was created in.
    // Otherwise launching `qwen` from a subdirectory of a monorepo would
    // make exit_worktree look at `<subdir>/.qwen/worktrees/<slug>`,
    // which never exists, and every call would return "Worktree not
    // found" even when the worktree is alive.
    const cwd = this.config.getTargetDir();
    const probe = new GitWorktreeService(cwd);
    const projectRoot = (await probe.getRepoTopLevel()) ?? cwd;
    const service =
      projectRoot === cwd ? probe : new GitWorktreeService(projectRoot);

    const worktreePath = service.getUserWorktreePath(this.params.name);
    const branch = worktreeBranchForSlug(this.params.name);

    // Confirm the worktree directory actually exists before doing anything.
    // Distinguish ENOENT ("not found", legitimate) from any other I/O
    // failure (permission, EIO, ENOTDIR) — the previous bare `catch`
    // collapsed all of them into "Worktree not found" with no log,
    // making it impossible to diagnose a real filesystem problem.
    let exists = false;
    try {
      const stat = await fs.stat(worktreePath);
      exists = stat.isDirectory();
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        exists = false;
      } else {
        debugLogger.warn(
          `exit_worktree: cannot stat ${worktreePath}: ${error}`,
        );
        return errorResult(
          `Cannot access worktree at ${worktreePath} (${error instanceof Error ? error.message : String(error)}).`,
        );
      }
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

    // action === 'remove' — three independent guards:
    //
    // 0. Session ownership: refuse to drop a worktree that was created
    //    by a different session. Without this, a prompt injection (or
    //    just a confused model) in session A could enumerate
    //    `.qwen/worktrees/` and call `exit_worktree` with a name
    //    belonging to session B, destroying its work. Worktrees
    //    created before this guard existed lack the marker; we treat
    //    those as "owner unknown" and allow removal (matches prior
    //    behaviour) but log so operators can see when the guard is
    //    bypassed.
    const owner = await readWorktreeSessionMarker(worktreePath);
    const currentSessionId = this.config.getSessionId();
    if (owner !== null && owner !== currentSessionId) {
      return errorResult(
        `Refusing to remove worktree "${this.params.name}" — it was ` +
          `created by a different session (owner=${owner}). Resume the ` +
          `owning session to drop it, or remove it manually with ` +
          `\`git worktree remove ${worktreePath}\`.`,
      );
    }
    if (owner === null) {
      debugLogger.warn(
        `exit_worktree: worktree ${worktreePath} has no session marker; ` +
          `allowing removal from session ${currentSessionId}`,
      );
    }

    // 1. Uncommitted edits (working tree dirty). Bypassed by
    //    `discard_changes: true`.
    // 2. Commits on the worktree branch that no other local branch or
    //    remote ref points at. Deleting the branch would lose them, so
    //    we refuse unconditionally — the user must merge, push, or
    //    rename the branch elsewhere first. There is no "discard
    //    commits" flag because losing committed work is rarely what the
    //    user means by "remove worktree".
    if (!this.params.discard_changes) {
      const counts = await service.countWorktreeChanges(worktreePath);
      if (counts === null) {
        // Inspecting the worktree itself failed — most likely a corrupt
        // git index, a permission problem, or the worktree dir was
        // mutated under us. Refuse rather than suggesting
        // `discard_changes: true`, which would tell the user to bypass
        // a safety check whose precondition is unknown. The user should
        // diagnose the underlying repo problem first.
        return errorResult(
          `Cannot inspect worktree "${this.params.name}" — git status failed against ${worktreePath}. ` +
            `Check filesystem permissions and repository integrity, then call ${ToolNames.EXIT_WORKTREE} again.`,
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

    let hasUnmerged = true;
    try {
      hasUnmerged = await service.hasUnmergedWorktreeCommits(this.params.name);
    } catch (error) {
      // Service-level helper logs its own failures, but the caller
      // context is what an operator would grep for ("why did
      // exit_worktree refuse?"). Add a second log here so the chain
      // (caller → reason it asked → underlying git error) is intact.
      debugLogger.warn(
        `exit_worktree: hasUnmergedWorktreeCommits failed for ${branch}: ${error}`,
      );
    }
    if (hasUnmerged) {
      return errorResult(
        `Refusing to remove worktree "${this.params.name}" — its branch ` +
          `\`${branch}\` has commits that no other branch or remote ref ` +
          `points at, and deleting the branch would lose them. Merge, ` +
          `push, or rename the branch first, then call ${ToolNames.EXIT_WORKTREE} again.`,
      );
    }

    const result = await service.removeUserWorktree(this.params.name, {
      deleteBranch: true,
    });
    if (!result.success) {
      return errorResult(result.error ?? 'Failed to remove worktree.');
    }
    if (result.branchPreserved) {
      // Status check passed and unmerged check passed, but the safe
      // delete still refused — most likely a race where new commits
      // landed between the checks. Be loud rather than force-deleting.
      const output: ExitWorktreeOutput = {
        action: 'remove',
        worktreePath,
        worktreeBranch: branch,
        message:
          `Removed worktree directory "${this.params.name}" but kept branch ${branch} ` +
          `(git refused a safe delete at the last moment — possibly a race with another ` +
          `process). Recover with \`git branch -D ${branch}\` if you really want to discard it.`,
      };
      return {
        llmContent: JSON.stringify(output),
        returnDisplay: `Removed worktree directory **${this.params.name}**, branch \`${branch}\` preserved`,
      };
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
      true, // shouldDefer — only invoked when the user explicitly asks to leave a worktree
      false, // alwaysLoad
      'worktree exit leave remove keep cleanup',
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

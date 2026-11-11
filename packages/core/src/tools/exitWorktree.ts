/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { MODEL_ONLY_HINTS } from '../codemode/types.js';
import type { Config } from '../config/config.js';
import {
  executeWorktreeRemoveHookWithStatus,
} from '../services/worktreeService.js';
import {
  worktreeSessionService,
  type WorktreeSessionContext,
  type WorktreeSessionService,
} from '../services/worktreeSessionService.js';
import { runLogger } from '../utils/runLogger.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolResult,
} from './tools.js';
import { EXIT_WORKTREE_TOOL_NAME } from './tool-names.js';
import { ToolErrorType } from './tool-error.js';

export interface ExitWorktreeParams {
  /** “keep” 保留 Worktree；“remove” 删除 Worktree。 */
  action: 'keep' | 'remove';
  /** Worktree 有变更时，删除操作必须显式确认。 */
  discard_changes?: boolean;
}

class ExitWorktreeInvocation extends BaseToolInvocation<
  ExitWorktreeParams,
  ToolResult
> {
  constructor(
    params: ExitWorktreeParams,
    toolName: string,
    toolDisplayName: string,
    private config: Config,
    private sessionService: WorktreeSessionService,
  ) {
    super(params, toolName, toolDisplayName);
  }

  getDescription(): string {
    return this.params.action === 'remove'
      ? 'Removing worktree'
      : 'Exiting worktree (keeping)';
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const settings = this.config.getWorktreeSettings();
    if (!settings) {
      return {
        llmContent:
          'No active worktree session to exit. This tool only operates on worktrees ' +
          'created by EnterWorktree or --worktree in the current session.',
        returnDisplay: 'No active worktree session.',
      };
    }

    if (!settings.originalCwd) {
      return {
        llmContent:
          'No restorable worktree session is active. The current worktree does not ' +
          'record the directory used before entering it, so ExitWorktree will not ' +
          'guess a destination or change session state.',
        returnDisplay: 'No restorable worktree session.',
      };
    }

    if (
      this.params.action === 'remove' &&
      (settings.lifecycle !== 'owner' ||
        settings.sessionId !== this.config.getSessionId())
    ) {
      return {
        llmContent:
          `This session does not own the worktree at ${settings.path}, ` +
          'so ExitWorktree will not remove it. Use action "keep" to return to ' +
          `${settings.originalCwd}, then remove it manually if appropriate.`,
        returnDisplay: 'Attached worktree cannot be removed.',
      };
    }

    const context = this.createContext();
    if (this.params.action === 'remove' && !this.params.discard_changes) {
      try {
        const inspection = await this.sessionService.finalize(context, {
          action: 'inspect',
        });
        if (inspection.action !== 'inspect') {
          throw new Error('Worktree inspection returned an invalid result.');
        }
        if (inspection.changedFiles === null || inspection.commits === null) {
          return this.unverifiedRemovalResult(settings.path);
        }
        if (inspection.changedFiles > 0 || inspection.commits > 0) {
          const parts: string[] = [];
          if (inspection.changedFiles > 0) {
            parts.push(`${inspection.changedFiles} uncommitted file(s)`);
          }
          if (inspection.commits > 0) {
            parts.push(`${inspection.commits} unpushed commit(s)`);
          }
          return {
            llmContent:
              `Worktree at ${settings.path} has ${parts.join(' and ')}. ` +
              'Removing will discard this work permanently. ' +
              'Re-invoke with discard_changes: true to proceed — or use action: "keep" to preserve the worktree.',
            returnDisplay: `Worktree has changes (${parts.join(', ')}). Refusing to remove.`,
          };
        }
      } catch {
        return this.unverifiedRemovalResult(settings.path);
      }
    }

    try {
      const result = await this.sessionService.leave(
        context,
        this.params.action === 'keep'
          ? { action: 'keep' }
          : {
              action: 'remove',
              force: this.params.discard_changes === true,
            },
      );
      if (result.cleanup?.status === 'partial') {
        const cleanupMessage = result.cleanup.message
          ? ` ${result.cleanup.message}`
          : '';
        const message =
          result.action === 'keep'
            ? `Exited worktree. Your work is preserved at ${result.worktreePath}` +
              `${settings.worktreeBranch ? ` on branch ${settings.worktreeBranch}` : ''}. ` +
              `Cleanup incomplete; the checkout may require attention.${cleanupMessage} ` +
              `Session is now back in ${result.originalCwd}.`
            : `Exited worktree. Cleanup incomplete; the checkout may remain at ${result.worktreePath}.` +
              `${cleanupMessage} Session is now back in ${result.originalCwd}.`;
        runLogger.warn(message);
        return {
          llmContent: message,
          returnDisplay: `Worktree cleanup incomplete at ${result.worktreePath}`,
          toolUseResult: {
            action: result.action,
            originalCwd: result.originalCwd,
            worktreePath: result.worktreePath,
            worktreeBranch: settings.worktreeBranch,
            cleanup: result.cleanup,
            message,
          },
        };
      }

      if (result.action === 'keep') {
        runLogger.debug(`Worktree preserved at: ${result.worktreePath}`);
        const message =
          `Exited worktree. Your work is preserved at ${result.worktreePath}` +
          `${settings.worktreeBranch ? ` on branch ${settings.worktreeBranch}` : ''}. ` +
          `Session is now back in ${result.originalCwd}.`;
        return {
          llmContent: message,
          returnDisplay: `Worktree preserved at ${result.worktreePath}`,
          toolUseResult: {
            action: 'keep',
            originalCwd: result.originalCwd,
            worktreePath: result.worktreePath,
            worktreeBranch: settings.worktreeBranch,
            message,
          },
        };
      }

      runLogger.debug(`Removed worktree at: ${result.worktreePath}`);
      const message =
        `Exited and removed worktree at ${result.worktreePath}. ` +
        `Session is now back in ${result.originalCwd}.`;
      return {
        llmContent: message,
        returnDisplay: `Worktree removed at ${result.worktreePath}`,
        toolUseResult: {
          action: 'remove',
          originalCwd: result.originalCwd,
          worktreePath: result.worktreePath,
          worktreeBranch: settings.worktreeBranch,
          message,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const action = this.params.action === 'remove' ? 'remove' : 'exit';
      const message =
        `Failed to ${action} worktree at ${settings.path}: ${errorMessage}. ` +
        'The session remains in the worktree so it can be inspected or retried.';
      runLogger.warn(message);
      return {
        llmContent: message,
        returnDisplay: `Failed to ${action} worktree: ${errorMessage}`,
        error: {
          message,
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }
  }

  private createContext(): WorktreeSessionContext {
    const hookSystem = this.config.getHookSystem();
    return {
      config: this.config,
      sessionId: this.config.getSessionId(),
      phase: 'runtime',
      recordWorktreeState: (...args) =>
        this.config.recordWorktreeState(...args),
      removeHookAdapter: hookSystem
        ? {
            executeWorktreeRemoveHook: (worktreePath) =>
              executeWorktreeRemoveHookWithStatus(hookSystem, worktreePath),
          }
        : undefined,
    };
  }

  private unverifiedRemovalResult(worktreePath: string): ToolResult {
    return {
      llmContent:
        `Could not verify worktree state at ${worktreePath}. ` +
        'Refusing to remove without explicit confirmation. ' +
        'Re-invoke with discard_changes: true to proceed — or use action: "keep" to preserve the worktree.',
      returnDisplay: 'Could not verify worktree state.',
    };
  }
}

export class ExitWorktreeTool extends BaseDeclarativeTool<
  ExitWorktreeParams,
  ToolResult
> {
  override get exposureHints() {
    return MODEL_ONLY_HINTS;
  }
  static readonly Name = EXIT_WORKTREE_TOOL_NAME;

  constructor(
    private config: Config,
    private sessionService: WorktreeSessionService = worktreeSessionService,
  ) {
    super(
      ExitWorktreeTool.Name,
      'Exit Worktree',
      'Exits a worktree session created by EnterWorktree or --worktree and restores the original working directory. ' +
        'Use action "keep" to leave the worktree on disk, or "remove" to delete it. ' +
        'When removing, set discard_changes to true if the worktree has uncommitted changes.',
      Kind.SwitchMode,
      {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['keep', 'remove'],
            description:
              '"keep" leaves the worktree and branch on disk; "remove" deletes both.',
          },
          discard_changes: {
            type: 'boolean',
            description:
              'Required true when action is "remove" and the worktree has uncommitted ' +
              'files or unmerged commits. The tool will refuse and list them otherwise.',
          },
        },
        required: ['action'],
      },
    );
  }

  override isDestructive(input?: ExitWorktreeParams): boolean {
    return input?.action === 'remove';
  }

  protected override validateToolParamValues(
    params: ExitWorktreeParams,
  ): string | null {
    if (
      !params.action ||
      (params.action !== 'keep' && params.action !== 'remove')
    ) {
      return 'Action must be either "keep" or "remove".';
    }
    return null;
  }

  protected createInvocation(
    params: ExitWorktreeParams,
    toolName: string,
    toolDisplayName: string,
  ): ExitWorktreeInvocation {
    return new ExitWorktreeInvocation(
      params,
      toolName,
      toolDisplayName,
      this.config,
      this.sessionService,
    );
  }
}

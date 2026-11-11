/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { MODEL_ONLY_HINTS } from '../codemode/types.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  type ToolResult,
  Kind,
} from './tools.js';
import type { Config } from '../config/config.js';
import { ENTER_WORKTREE_TOOL_NAME } from './tool-names.js';
import { runLogger } from '../utils/runLogger.js';
import { validateWorktreeSlug } from '../services/worktreeService.js';
import { ToolErrorType } from './tool-error.js';

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

export interface EnterWorktreeParams {
  /** Optional name for the worktree. Must pass validateWorktreeSlug. */
  name?: string;
  /** Existing registered Git worktree to enter instead of creating one. */
  path?: string;
}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

class EnterWorktreeInvocation extends BaseToolInvocation<
  EnterWorktreeParams,
  ToolResult
> {
  constructor(
    params: EnterWorktreeParams,
    toolName: string,
    toolDisplayName: string,
    private config: Config,
  ) {
    super(params, toolName, toolDisplayName);
  }

  getDescription(): string {
    if (this.params.path) {
      return `Entering worktree: ${this.params.path}`;
    }
    return this.params.name
      ? `Creating worktree: ${this.params.name}`
      : 'Creating worktree';
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    // Check if already in a worktree session
    const activeWorktreeSettings = this.config.getWorktreeSettings();
    if (activeWorktreeSettings && !this.params.path) {
      return {
        llmContent:
          'Already in a worktree session. Pass path to switch into another existing worktree, or use ExitWorktree to leave first.',
        returnDisplay: 'Already in a worktree session.',
      };
    }

    // Generate a slug if no name provided
    let slug = this.params.name?.trim();
    if (!slug && !this.params.path) {
      const adjectives = ['swift', 'bright', 'calm', 'keen', 'bold'];
      const nouns = ['fox', 'owl', 'elm', 'oak', 'ray'];
      const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
      const noun = nouns[Math.floor(Math.random() * nouns.length)];
      const suffix = Math.random().toString(36).slice(2, 6);
      slug = `${adj}-${noun}-${suffix}`;
    }

    // Validate the slug
    try {
      if (slug) validateWorktreeSlug(slug);
    } catch (e: unknown) {
      return {
        llmContent: `Invalid worktree name: ${(e as Error).message}`,
        returnDisplay: `Error: ${(e as Error).message}`,
        error: {
          message: (e as Error).message,
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }

    try {
      const settings = await this.config.enterWorktree(
        this.params.path
          ? {
              kind: 'attach',
              path: this.params.path,
            }
          : {
              kind: 'create',
              name: slug!,
            },
      );

      const branchInfo = settings.worktreeBranch
        ? ` on branch ${settings.worktreeBranch}`
        : '';
      const hookNote = settings.hookBased ? ' (hook-based)' : '';
      const existedNote =
        !settings.enteredExisting && !settings.created
          ? ' (resumed existing worktree)'
          : '';
      const attachedNote =
        settings.lifecycle === 'owner'
          ? undefined
          : settings.enteredExisting
            ? 'This session entered an existing worktree and will never remove it.'
            : 'Lifecycle ownership could not be verified, so this session is attached and will never remove the worktree.';
      const exitGuidance =
        settings.lifecycle === 'owner'
          ? 'Use ExitWorktree to leave mid-session, or exit the session to choose whether to keep or remove it.'
          : 'Use ExitWorktree with action "keep" to return to the original directory, or exit the CLI normally to leave the worktree untouched.';
      const previousWorktreeNote = activeWorktreeSettings
        ? ` The previous worktree is preserved at ${activeWorktreeSettings.path}.`
        : '';
      const entryWarning = settings.entryWarning
        ? `\n\nWarning: ${settings.entryWarning}`
        : '';

      const action = settings.enteredExisting ? 'Entered' : 'Created';
      const message =
        `${action} worktree at ${settings.path}${branchInfo}${hookNote}${existedNote}.\n\n` +
        `The session is now working in the worktree. ` +
        `${attachedNote ? `${attachedNote} ` : ''}${exitGuidance}${previousWorktreeNote}` +
        entryWarning;
      return {
        llmContent: message,
        returnDisplay: `Worktree ${settings.enteredExisting ? 'entered' : 'created'} at ${settings.path}${branchInfo}`,
        toolUseResult: {
          worktreePath: settings.path,
          worktreeBranch: settings.worktreeBranch,
          message,
        },
      };
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      runLogger.warn(`Failed to create or enter worktree: ${errorMessage}`);
      return {
        llmContent: `Error creating or entering worktree: ${errorMessage}`,
        returnDisplay: 'Error creating or entering worktree.',
        error: {
          message: errorMessage,
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Tool class
// ---------------------------------------------------------------------------

export class EnterWorktreeTool extends BaseDeclarativeTool<
  EnterWorktreeParams,
  ToolResult
> {
  override get exposureHints() {
    return MODEL_ONLY_HINTS;
  }
  static readonly Name = ENTER_WORKTREE_TOOL_NAME;

  constructor(private config: Config) {
    super(
      EnterWorktreeTool.Name,
      'Enter Worktree',
      'Creates an isolated git worktree, or enters an existing registered worktree, and switches the session into it. ' +
        'Use this to work on changes in isolation without affecting the main working directory.',
      Kind.SwitchMode,
      {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              'Optional name for the worktree. Each "/"-separated segment may contain only ' +
              'letters, digits, dots, underscores, and dashes; max 64 chars total. ' +
              'A random name is generated if not provided.',
          },
          path: {
            type: 'string',
            description:
              'Path to an existing registered Git worktree to enter instead of creating a new one. ' +
              'Mutually exclusive with name.',
          },
        },
      },
    );
  }

  protected override validateToolParamValues(
    params: EnterWorktreeParams,
  ): string | null {
    if (params.name !== undefined && params.path !== undefined) {
      return 'Provide at most one of name or path, not both.';
    }
    if (params.path !== undefined && params.path.trim().length === 0) {
      return 'Worktree path must not be empty.';
    }
    if (params.name) {
      try {
        validateWorktreeSlug(params.name);
      } catch (e: unknown) {
        return (e as Error).message;
      }
    }
    return null;
  }

  protected createInvocation(
    params: EnterWorktreeParams,
    toolName: string,
    toolDisplayName: string,
  ): EnterWorktreeInvocation {
    return new EnterWorktreeInvocation(
      params,
      toolName,
      toolDisplayName,
      this.config,
    );
  }
}

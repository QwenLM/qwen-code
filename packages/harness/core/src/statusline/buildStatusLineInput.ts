/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PermissionMode } from '../permissions/manager/decision/index.js';
import type { StatusLineCommandInput } from './types.js';

/**
 * Parameters needed to assemble a StatusLineCommandInput.
 * This keeps the function independent of any specific UI framework.
 */
export interface BuildStatusLineInputParams {
  sessionId: string;
  sessionName?: string;
  cwd: string;
  transcriptPath?: string;
  permissionMode?: PermissionMode;
  projectDir: string;
  /** Accepts the readonly array returned by `WorkspaceContext.getDirectories()`. */
  addedDirs?: readonly string[];
  modelId: string;
  modelDisplayName: string;
  version?: string;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  contextWindowSize?: number;
  usedPercentage?: number | null;
  remainingPercentage?: number | null;
  vimMode?: string;
  agentName?: string;
  worktree?: StatusLineCommandInput['worktree'];
}

/**
 * Assembles the rich JSON object that gets piped to the user's statusline command on stdin.
 */
export function buildStatusLineInput(
  params: BuildStatusLineInputParams,
): StatusLineCommandInput {
  const input: StatusLineCommandInput = {
    session_id: params.sessionId,
    ...(params.sessionName && { session_name: params.sessionName }),
    cwd: params.cwd,
    ...(params.transcriptPath && { transcript_path: params.transcriptPath }),
    ...(params.permissionMode && { permission_mode: params.permissionMode }),
    model: {
      id: params.modelId,
      display_name: params.modelDisplayName,
    },
    workspace: {
      current_dir: params.cwd,
      project_dir: params.projectDir,
      ...(params.addedDirs &&
        params.addedDirs.length > 0 && { added_dirs: [...params.addedDirs] }),
    },
    ...(params.version && { version: params.version }),
  };

  // Cost / diff stats
  if (
    params.totalLinesAdded !== undefined ||
    params.totalLinesRemoved !== undefined
  ) {
    input.cost = {
      total_lines_added: params.totalLinesAdded ?? 0,
      total_lines_removed: params.totalLinesRemoved ?? 0,
    };
  }

  // Context window
  if (params.contextWindowSize !== undefined) {
    input.context_window = {
      total_input_tokens: params.totalInputTokens,
      total_output_tokens: params.totalOutputTokens,
      context_window_size: params.contextWindowSize,
      used_percentage: params.usedPercentage ?? null,
      remaining_percentage: params.remainingPercentage ?? null,
    };
  }

  // Vim mode
  if (params.vimMode) {
    input.vim = { mode: params.vimMode };
  }

  // Agent
  if (params.agentName) {
    input.agent = { name: params.agentName };
  }

  // Worktree
  if (params.worktree) {
    input.worktree = params.worktree;
  }

  return input;
}

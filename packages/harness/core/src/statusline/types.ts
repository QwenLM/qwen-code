/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PermissionMode } from '../permissions/manager/decision/index.js';

/**
 * StatusLine settings as stored in settings.json.
 *
 * Example:
 * ```json
 * {
 *   "statusLine": {
 *     "type": "command",
 *     "command": "/home/alice/abc/statusline.sh",
 *     "padding": 2
 *   }
 * }
 * ```
 * Here `/home/alice/abc` is an example resolved user config root.
 */
export interface StatusLineConfig {
  type: 'command';
  command: string;
  padding?: number;
}

/**
 * The rich JSON object piped to the statusline command's stdin.
 *
 * Every optional field is omitted entirely when its source has no value —
 * never emitted as an empty string, zero, or null placeholder. Scripts can
 * therefore rely on `// empty` style jq fallbacks.
 *
 * The field list documented to the `statusline-setup` agent
 * (`../agents/builtin/statusline-setup-agent.ts`) must stay in sync with what
 * `buildStatusLineInput` actually produces; a contract test enforces both
 * directions.
 */
export interface StatusLineCommandInput {
  session_id: string;
  session_name?: string;
  cwd: string;
  /** Absolute path to this session's transcript JSONL file. */
  transcript_path?: string;
  /** Active permission mode, e.g. 'default' | 'plan' | 'acceptEdits'. */
  permission_mode?: PermissionMode;
  model: {
    id: string;
    display_name: string;
  };
  workspace: {
    current_dir: string;
    project_dir: string;
    added_dirs?: string[];
  };
  version?: string;
  cost?: {
    total_lines_added?: number;
    total_lines_removed?: number;
  };
  context_window?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    context_window_size?: number;
    used_percentage?: number | null;
    remaining_percentage?: number | null;
  };
  vim?: {
    mode: string;
  };
  agent?: {
    name: string;
  };
  /**
   * Worktree session details. Only `name` and `path` are guaranteed — the
   * other three come from optional fields on the session's worktree settings
   * and are omitted rather than emitted as empty strings when unrecorded.
   */
  worktree?: {
    name: string;
    path: string;
    branch?: string;
    original_cwd?: string;
    original_branch?: string;
  };
}

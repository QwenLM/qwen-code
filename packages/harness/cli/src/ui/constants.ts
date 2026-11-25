/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const SHELL_COMMAND_NAME = 'Shell Command';

export const SHELL_NAME = 'Shell';

// Limit assistant messages to a very high number of lines to mitigate performance
// issues in the worst case if we somehow get an enormous response from the model.
// This threshold is arbitrary but should be high enough to never impact normal
// usage.
export const MAX_MODEL_MESSAGE_LINES = 65536;

// Main-screen scrollback is a render window, not the source of truth for
// session history. Bound raw normalization work before applying the smaller
// renderable window; neither window mutates the history/session source.
export const MAX_MAIN_SCREEN_RAW_HISTORY_ITEMS = 400;
export const MAX_MAIN_SCREEN_HISTORY_ITEMS = 200;
export const MAIN_SCREEN_HISTORY_WINDOW_STEP = 50;
export const MAX_MAIN_SCREEN_HISTORY_ITEM_HEIGHT = 80;
export const MAX_MAIN_SCREEN_MODEL_MESSAGE_LINES = 200;



// Maximum number of MCP resources to display per server before truncating
export const MAX_MCP_RESOURCES_TO_SHOW = 10;

export const WARNING_PROMPT_DURATION_MS = 3000;
export const QUEUE_ERROR_DISPLAY_DURATION_MS = 3000;
export const EXPAND_HINT_DURATION_MS = 5000;

export const DEFAULT_BACKGROUND_OPACITY = 0.16;
export const DEFAULT_INPUT_BACKGROUND_OPACITY = 0.24;
export const DEFAULT_SELECTION_OPACITY = 0.2;
export const DEFAULT_BORDER_OPACITY = 0.4;

export const LRU_BUFFER_PERF_CACHE_LIMIT = 20000;

// Max lines to show for active shell output when not focused
export const ACTIVE_SHELL_MAX_LINES = 10;

// Max lines to preserve in history for completed shell commands
export const COMPLETED_SHELL_MAX_LINES = 8;

// Max lines to show for subagent results before collapsing
export const SUBAGENT_MAX_LINES = 8;

// Compact shell output: max visible output lines in default (non-expanded) view.
// Mirrors the CLI's MAX_LINES_TO_SHOW = 3 philosophy. ctrl+o to see full output.
export const SHELL_COMPACT_MAX_LINES_EXECUTING = 5;
export const SHELL_COMPACT_MAX_LINES_COMPLETED = 3;
// Four completed lines remain intact; five or more use the three-line preview.
export const SHELL_COMPACT_FOLD_THRESHOLD_COMPLETED = 4;

/** Minimum terminal width required to show the full context used label */
export const MIN_TERMINAL_WIDTH_FOR_FULL_LABEL = 100;

/** Max lines to show for a compact tool subview (e.g. diff) */
export const COMPACT_TOOL_SUBVIEW_MAX_LINES = 15;

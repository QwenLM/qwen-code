/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unified semantic indentation constants for message layout.
 *
 * Visual alignment rules:
 * - FEED_LEFT_OFFSET (1): Top-level feed glyphs/rails sit off the hard edge
 * - TOOL_HEADER (1): Tool status marker aligns with feed rails
 * - TOOL_CONTENT (3): Tool result connector is nested two columns below header
 * - TOOL_PAYLOAD (5): Tool result body/payload sits after the connector rail
 */
export const INDENT = {
  /** Shared top-level feed inset for visual rails and status markers. */
  FEED_LEFT_OFFSET: 1,
  /** Tool header indent — top-level status marker aligns with feed rails */
  TOOL_HEADER: 1,
  /** Tool result connector rail indent */
  TOOL_CONTENT: 3,
  /** Tool payload/body indent after a two-column rail marker */
  TOOL_PAYLOAD: 5,
  /** ToolGroup right padding */
  TOOL_GROUP_PADDING_RIGHT: 2,
  /** Standard prefix width for "▪ ", "> ", "✕ " */
  PREFIX_WIDTH_STANDARD: 2,
  /** Status indicator width from ToolShared */
  STATUS_INDICATOR_WIDTH: 2,
} as const;

// ---------------------------------------------------------------------------
// Spacing Category
// ---------------------------------------------------------------------------

/**
 * Every history item type maps to exactly one SpacingCategory.
 * MessageSlot uses this to determine inter-message gap.
 */
export type SpacingCategory =
  | 'user-input' // UserMessage, UserShellMessage, HintMessage
  | 'model-output' // AssistantMessage, AssistantMessageContent
  | 'thinking' // ThinkingMessage
  | 'tool-group' // ToolGroupMessage
  | 'system-notice' // InfoMessage, WarningMessage, ErrorMessage, CompressionMessage
  | 'structural' // about, help, stats, model, quit, lists, etc.
  | 'topic'; // TopicMessage (when rendered at top level)

/**
 * Map a HistoryItem.type string to its SpacingCategory.
 */
export function getSpacingCategory(itemType: string): SpacingCategory {
  switch (itemType) {
    case 'user':
    case 'user_shell':
    case 'hint':
      return 'user-input';

    case 'gemini':
    case 'gemini_content':
    case 'custom_content':
      return 'model-output';

    case 'thinking':
      return 'thinking';

    case 'tool_group':
      return 'tool-group';

    case 'info':
    case 'warning':
    case 'error':
    case 'compression':
    case 'model_queue':
      return 'system-notice';

    case 'about':
    case 'help':
    case 'stats':
    case 'model_stats':
    case 'tool_stats':
    case 'model':
    case 'quit':
    case 'subagent':
      return 'structural';

    default:
      return 'structural';
  }
}

/**
 * Spacing rules table — single source of truth for inter-message gaps.
 *
 * Returns the marginTop value (in lines) for a message of `current` category
 * when preceded by a message of `prev` category.
 */
export function getSpacingGap(
  prev: SpacingCategory | undefined,
  current: SpacingCategory,
): number {
  // First message — one line gap after banner
  if (prev === undefined) {
    return 1;
  }

  // Thinking is a prelude to the next model action. Attach it directly to the
  // following assistant text or tool group while keeping all other visible
  // top-level feed blocks on the normal one-line rhythm.
  if (
    prev === 'thinking' &&
    (current === 'model-output' || current === 'tool-group')
  ) {
    return 0;
  }

  // Visible top-level feed blocks keep a consistent one-line rhythm. Internal
  // component rows (tool result connectors, thinking rails, borders) own their
  // own compact spacing and do not go through MessageSlot.
  return 1;
}

// ---------------------------------------------------------------------------
// FoldLevel (Phase 7 prep — defined here for type reference)
// ---------------------------------------------------------------------------

/**
 * Fold state for ToolGroup rendering.
 *
 * Fold levels:
 *   GroupCollapsed    → Entire ToolGroup displays as one summary line
 *   GroupExpandedToolCollapsed → Display tool header list (no output)
 *   FullyExpanded    → Display full tool output
 */
export enum FoldLevel {
  /** Entire ToolGroup collapsed to one summary line */
  GroupCollapsed = 0,
  /** Group expanded, but internal tools are collapsed (headers only) */
  GroupExpandedToolCollapsed = 1,
  /** Group expanded, and internal tools also expanded (full output) */
  FullyExpanded = 2,
}

// ---------------------------------------------------------------------------
// Fold Cycle Configuration
// ---------------------------------------------------------------------------

/**
 * Controls whether Ctrl+O cycles through 2 or 3 fold levels.
 *
 * - `'2-level'`: Cycles between FullyExpanded ↔ GroupExpandedToolCollapsed.
 *    This is the simpler mode — tools are either shown with headers-only
 *    or fully expanded. GroupCollapsed (single summary line) is not reachable
 *    via Ctrl+O, but can still be set programmatically per-group.
 *
 * - `'3-level'`: Cycles through FullyExpanded → GroupCollapsed →
 *    GroupExpandedToolCollapsed → FullyExpanded. This gives users access to
 *    the fully collapsed summary-line view via Ctrl+O.
 *
 * Change this value to switch the global Ctrl+O behavior.
 */
export type FoldCycleMode = '2-level' | '3-level';

/**
 * Active fold cycle mode for Ctrl+O.
 * Set to '2-level' for simple expand/collapse, or '3-level' for full tri-state cycling.
 */
export const FOLD_CYCLE_MODE: FoldCycleMode = '2-level';

/**
 * Compute the next fold level based on the configured cycle mode.
 *
 * 2-level: FullyExpanded(2) ↔ GroupExpandedToolCollapsed(1)
 * 3-level: FullyExpanded(2) → GroupCollapsed(0) → GroupExpandedToolCollapsed(1) → FullyExpanded(2)
 */
export function getNextFoldLevel(
  current: FoldLevel,
  mode: FoldCycleMode = FOLD_CYCLE_MODE,
): FoldLevel {
  if (mode === '2-level') {
    return current === FoldLevel.FullyExpanded
      ? FoldLevel.GroupExpandedToolCollapsed
      : FoldLevel.FullyExpanded;
  }
  // 3-level cycle
  switch (current) {
    case FoldLevel.FullyExpanded:
      return FoldLevel.GroupCollapsed;
    case FoldLevel.GroupCollapsed:
      return FoldLevel.GroupExpandedToolCollapsed;
    case FoldLevel.GroupExpandedToolCollapsed:
      return FoldLevel.FullyExpanded;
    default:
      return FoldLevel.FullyExpanded;
  }
}

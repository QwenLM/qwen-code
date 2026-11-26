/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { CoreToolCallStatus } from '@qwen-code/core';
import { isShellTool } from '../components/messages/ToolShared.js';
import { theme } from '../semantic-colors.js';
import type {
  HistoryItem,
  HistoryItemWithoutId,
  HistoryItemToolGroup,
  IndividualToolCallDisplay,
} from '../types.js';
import type { TrackedToolCall } from '../hooks/useToolScheduler.js';
import { isUnicodeSupported } from './terminalUtils.js';

// ---------------------------------------------------------------------------
// Semantic border styles (Phase 9)
// ---------------------------------------------------------------------------

/**
 * Semantic border style categories.
 *
 * Instead of hardcoding 'round', 'single', etc. throughout the codebase,
 * components should use these semantic names so the visual language can be
 * changed in one place.
 */
export type SemanticBorderStyle =
  | 'dialog' // Modal dialogs, confirmation prompts, consent screens
  | 'panel' // Non-modal panels, list views, section headers
  | 'emphasis' // Diff blocks, highlighted content requiring attention
  | 'focused' // Active/focused elements (rare, typically dynamic)
  | 'tool' // Tool result containers, dense tool messages
  | 'input'; // Input prompts, search boxes

/**
 * Ink-compatible border style names from cli-boxes.
 */
type InkBorderStyle =
  | 'single'
  | 'double'
  | 'round'
  | 'bold'
  | 'singleDouble'
  | 'doubleSingle'
  | 'classic'
  | 'arrow';

/**
 * Map semantic border names to Ink border style strings.
 * Centralizes the visual language for easy theme-wide updates.
 *
 * When the terminal does not support Unicode box-drawing characters
 * (e.g. legacy Windows CMD / conhost with CP437), we degrade gracefully:
 *   • 'round' → 'classic'   (╭╮╰╯ → +--+)
 *   • 'bold'  → 'classic'   (┏┓┗┛┃━ → +|-)
 *   • Others remain unchanged because 'single' (│─┌┐└┘) and 'double'
 *     (║═╔╗╚╝) use characters in CP437 and render correctly.
 */
const UNICODE_BORDER_STYLE_MAP: Record<SemanticBorderStyle, InkBorderStyle> = {
  dialog: 'round',
  panel: 'single',
  emphasis: 'double',
  focused: 'bold',
  tool: 'round',
  input: 'round',
};

const ASCII_BORDER_STYLE_MAP: Record<SemanticBorderStyle, InkBorderStyle> = {
  dialog: 'classic',
  panel: 'single',
  emphasis: 'double',
  focused: 'classic',
  tool: 'classic',
  input: 'classic',
};

/**
 * Get the Ink border style string for a semantic category.
 * Automatically selects Unicode or ASCII-safe border styles based on
 * terminal capability detection.
 *
 * Usage:
 *   <Box borderStyle={getBorderStyle('dialog')}>
 */
export function getBorderStyle(semantic: SemanticBorderStyle): InkBorderStyle {
  const map = isUnicodeSupported()
    ? UNICODE_BORDER_STYLE_MAP
    : ASCII_BORDER_STYLE_MAP;
  return map[semantic];
}

function isTrackedToolCall(
  tool: IndividualToolCallDisplay | TrackedToolCall,
): tool is TrackedToolCall {
  return 'request' in tool;
}

/**
 * Calculates the border color and dimming state for a tool group message.
 */
export function getToolGroupBorderAppearance(
  item:
    | HistoryItem
    | HistoryItemWithoutId
    | { type: 'tool_group'; tools: TrackedToolCall[] },
  activeShellId: number | null | undefined,
  allPendingItems: HistoryItemWithoutId[] = [],
): { borderColor: string; borderDimColor: boolean } {
  if (item.type !== 'tool_group') {
    return { borderColor: '', borderDimColor: false };
  }

  // If this item has no tools, it's a closing slice for the current batch.
  // We need to look at the last pending item to determine the batch's appearance.
  const toolsToInspect: Array<IndividualToolCallDisplay | TrackedToolCall> =
    item.tools.length > 0
      ? item.tools
      : allPendingItems
          .filter(
            (i): i is HistoryItemToolGroup =>
              i !== null &&
              i !== undefined &&
              i.type === 'tool_group' &&
              i.tools.length > 0,
          )
          .slice(-1)
          .flatMap((i) => i.tools);

  const hasPending = toolsToInspect.some((t) => {
    if (isTrackedToolCall(t)) {
      return (
        t.status !== 'success' &&
        t.status !== 'error' &&
        t.status !== 'cancelled'
      );
    } else {
      return (
        t.status !== CoreToolCallStatus.Success &&
        t.status !== CoreToolCallStatus.Error &&
        t.status !== CoreToolCallStatus.Cancelled
      );
    }
  });

  const isShellCommand = toolsToInspect.some((t) => {
    if (isTrackedToolCall(t)) {
      return isShellTool(t.request.name);
    } else {
      return isShellTool(t.name);
    }
  });

  // If we have an active shell that isn't a background shell, then the current
  // pending batch is definitely a shell batch.
  const isCurrentlyInShellTurn = !!activeShellId;

  const isShell =
    isShellCommand || (item.tools.length === 0 && isCurrentlyInShellTurn);
  const isPending =
    hasPending || (item.tools.length === 0 && isCurrentlyInShellTurn);

  const borderColor =
    isShell && isPending
      ? theme.ui.active
      : isPending
        ? theme.status.warning
        : theme.border.default;

  const borderDimColor = isPending;

  return { borderColor, borderDimColor };
}

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Merge consecutive tool_group history items for compact mode display.
 *
 * In compact mode, consecutive tool calls across multiple LLM turns each produce
 * separate HistoryItemToolGroup items. This utility merges them into single groups
 * for display, preserving force-expand conditions for authorization/error/shell focus.
 */

import type { HistoryItem, IndividualToolCallDisplay } from '../types.js';
import { ToolCallStatus } from '../types.js';
import type { AgentResultDisplay } from '@qwen-code/qwen-code-core';

/**
 * Check if a tool's resultDisplay indicates a subagent with pending confirmation.
 * Matches the logic in ToolGroupMessage.tsx:21-31.
 */
function isAgentWithPendingConfirmation(
  rd: IndividualToolCallDisplay['resultDisplay'],
): boolean {
  return (
    typeof rd === 'object' &&
    rd !== null &&
    (rd as AgentResultDisplay).type === 'task_execution' &&
    (rd as AgentResultDisplay).pendingConfirmation !== undefined
  );
}

/**
 * Check if a tool_group history item should be excluded from merging due to force-expand conditions.
 * These conditions match ToolGroupMessage.tsx:105-112 showCompact logic.
 * Exported so MainContent can determine which callIds get their label
 * "absorbed" by the compact tool_group header vs which need the standalone
 * `● <label>` line rendered (force-expanded groups never go through the
 * compact path, so their label would otherwise be invisible).
 */
export function isForceExpandGroup(
  item: HistoryItem,
  embeddedShellFocused: boolean,
  activeShellPtyId: number | undefined,
): boolean {
  if (item.type !== 'tool_group') {
    return false;
  }

  // User-initiated groups stay distinct as visual boundaries
  if (item.isUserInitiated) {
    return true;
  }

  const tools = item.tools;

  // Authorization prompts must show
  if (tools.some((t) => t.status === ToolCallStatus.Confirming)) {
    return true;
  }

  // Errors must be visible
  if (tools.some((t) => t.status === ToolCallStatus.Error)) {
    return true;
  }

  // Subagent pending confirmations must show
  if (tools.some((t) => isAgentWithPendingConfirmation(t.resultDisplay))) {
    return true;
  }

  // Terminal subagent tool calls must show — the inline
  // `SubagentScrollbackSummary` is the persistent record of the
  // run's outcome (LiveAgentPanel evicts terminal rows after its
  // visibility window). If the group merged into a compact batch,
  // the summary would never render and the user would lose the
  // committed audit trail. Mirrors the `hasTerminalSubagent`
  // predicate in `ToolGroupMessage.showCompact`.
  if (
    tools.some((t) => {
      const rd = t.resultDisplay;
      if (
        !rd ||
        typeof rd !== 'object' ||
        !('type' in rd) ||
        (rd as { type?: string }).type !== 'task_execution'
      ) {
        return false;
      }
      const status = (rd as { status?: string }).status;
      return (
        status === 'completed' || status === 'failed' || status === 'cancelled'
      );
    })
  ) {
    return true;
  }

  // Active focused shell must be visible
  if (
    embeddedShellFocused &&
    activeShellPtyId !== undefined &&
    tools.some(
      (t) =>
        t.ptyId === activeShellPtyId && t.status === ToolCallStatus.Executing,
    )
  ) {
    return true;
  }

  return false;
}

/**
 * Check if an item is hidden in compact mode (so it shouldn't break tool_group adjacency).
 * This mirrors HistoryItemDisplay.tsx which hides:
 *  - `gemini_thought` / `gemini_thought_content` (thinking — hidden when compactMode is true),
 *  - `tool_use_summary` (consumed upstream to decorate the adjacent tool_group's label;
 *    never rendered standalone so it must not break adjacency between two batches).
 */
function isHiddenInCompactMode(item: HistoryItem): boolean {
  return (
    item.type === 'gemini_thought' ||
    item.type === 'gemini_thought_content' ||
    item.type === 'tool_use_summary'
  );
}

/**
 * Merge consecutive tool_group history items for compact mode display.
 *
 * Tool_groups separated only by items hidden in compact mode (`gemini_thought`,
 * `gemini_thought_content`) are considered "consecutive" because the user
 * doesn't see anything between them visually. Hidden items between merged
 * tool_groups are dropped from the result (they would render as nothing
 * anyway in compact mode).
 *
 * @param items - History items array
 * @param embeddedShellFocused - Whether embedded shell is focused
 * @param activeShellPtyId - PTY ID of the active shell (if any)
 * @param absorbedCallIds - Set of tool callIds whose summary label is consumed
 *   by a compact-mode tool_group header (i.e., the corresponding tool_group is
 *   NOT force-expanded). Summaries for these callIds are dropped from the
 *   merged result so MainContent's refreshStatic heuristic fires and the
 *   tool_group re-renders with its label. Summaries for force-expanded groups
 *   pass through unchanged so HistoryItemDisplay can render them as standalone
 *   `● <label>` lines (the compact path doesn't consume their label).
 * @returns New array with merged tool_groups (does not mutate input)
 */
export function mergeCompactToolGroups(
  items: HistoryItem[],
  embeddedShellFocused: boolean = false,
  activeShellPtyId: number | undefined = undefined,
  absorbedCallIds: ReadonlySet<string> = new Set(),
): HistoryItem[] {
  const result: HistoryItem[] = [];
  let i = 0;

  while (i < items.length) {
    const item = items[i];

    // Drop `tool_use_summary` items whose preceding callIds are *all* absorbed
    // by a compact tool_group header. Those headers will display the label
    // directly (via the `compactLabel` lookup in MainContent), so keeping the
    // standalone summary in the merged result would either double-display the
    // label (if HistoryItemDisplay rendered both) or, more importantly, would
    // bump mergedHistory.length lock-step with history.length and prevent
    // refreshStatic from firing — Ink's <Static> would never repaint the
    // committed tool_group with the new label.
    //
    // Summaries with at least one non-absorbed preceding callId — e.g., when
    // the corresponding tool_group is force-expanded (errors / confirming /
    // user-initiated / focused shell) and renders through the full
    // ToolGroupMessage path that does not consume `compactLabel` — must
    // survive in the merged result so HistoryItemDisplay can render them as
    // standalone `● <label>` lines.
    if (item.type === 'tool_use_summary') {
      const allAbsorbed =
        item.precedingToolUseIds.length > 0 &&
        item.precedingToolUseIds.every((id) => absorbedCallIds.has(id));
      if (allAbsorbed) {
        i++;
        continue;
      }
      result.push(item);
      i++;
      continue;
    }

    // Pass through non-mergeable items unchanged
    if (
      item.type !== 'tool_group' ||
      isForceExpandGroup(item, embeddedShellFocused, activeShellPtyId)
    ) {
      result.push(item);
      i++;
      continue;
    }

    // item is a mergeable tool_group. Look ahead for more mergeable
    // tool_groups, allowing hidden-in-compact-mode items between them.
    const mergeableGroups: HistoryItem[] = [item];
    let lastMergedIdx = i;
    let j = i + 1;

    while (j < items.length) {
      const next = items[j];

      if (isHiddenInCompactMode(next)) {
        // Skip past hidden item, keep looking for next tool_group
        j++;
        continue;
      }

      if (
        next.type === 'tool_group' &&
        !isForceExpandGroup(next, embeddedShellFocused, activeShellPtyId)
      ) {
        mergeableGroups.push(next);
        lastMergedIdx = j;
        j++;
        continue;
      }

      // Visible non-mergeable item — streak broken
      break;
    }

    // If only one group found, no merge needed
    if (mergeableGroups.length === 1) {
      result.push(item);
      i++;
      continue;
    }

    // Merge: concatenate tools, reuse first group's id for React key stability
    const mergedTools = mergeableGroups.flatMap((g) =>
      g.type === 'tool_group' ? g.tools : [],
    );
    const mergedGroup: HistoryItem = {
      type: 'tool_group',
      tools: mergedTools,
      id: mergeableGroups[0].id,
    };

    result.push(mergedGroup);
    // Continue right after the last merged tool_group. Hidden items between
    // merged groups are dropped (they'd render as nothing in compact mode);
    // hidden items AFTER the last merged group will be picked up by the next
    // iteration since we resume at lastMergedIdx + 1.
    i = lastMergedIdx + 1;
  }

  return result;
}

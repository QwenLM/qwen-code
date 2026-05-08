/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { useMemo, useRef } from 'react';
import type { IndividualToolCallDisplay } from '../../types.js';
import { ToolCallStatus } from '../../types.js';
import { ToolMessage } from './ToolMessage.js';
import { ToolConfirmationMessage } from './ToolConfirmationMessage.js';
import { CompactToolGroupDisplay } from './CompactToolGroupDisplay.js';
import { theme } from '../../semantic-colors.js';
import { SHELL_COMMAND_NAME, SHELL_NAME } from '../../constants.js';
import { useConfig } from '../../contexts/ConfigContext.js';
import { useCompactMode } from '../../contexts/CompactModeContext.js';
import type { AgentResultDisplay } from '@qwen-code/qwen-code-core';

function isAgentWithPendingConfirmation(
  rd: IndividualToolCallDisplay['resultDisplay'],
): rd is AgentResultDisplay {
  return (
    typeof rd === 'object' &&
    rd !== null &&
    'type' in rd &&
    (rd as AgentResultDisplay).type === 'task_execution' &&
    (rd as AgentResultDisplay).pendingConfirmation !== undefined
  );
}

function isRunningAgent(
  rd: IndividualToolCallDisplay['resultDisplay'],
): rd is AgentResultDisplay {
  return (
    typeof rd === 'object' &&
    rd !== null &&
    'type' in rd &&
    (rd as AgentResultDisplay).type === 'task_execution' &&
    (rd as AgentResultDisplay).status === 'running'
  );
}

/**
 * Predicate: tool entry whose `resultDisplay` is an `AgentResultDisplay`
 * (i.e. a `task_execution` subagent invocation), regardless of status.
 */
function isSubagentToolEntry(tool: IndividualToolCallDisplay): boolean {
  const rd = tool.resultDisplay;
  return (
    typeof rd === 'object' &&
    rd !== null &&
    'type' in rd &&
    (rd as AgentResultDisplay).type === 'task_execution'
  );
}

/**
 * Predicate: subagent tool entry whose live UI is owned by
 * `LiveAgentPanel`. Only running / background entries should be
 * hidden during the live phase — terminal entries (the subagent
 * already finished while the parent turn is still running) are NOT
 * panel-owned: the panel snapshot drops them on
 * `unregisterForeground`'s post-delete emit, so the inline path
 * needs to render `SubagentScrollbackSummary` immediately so the
 * user keeps a record of the run instead of seeing nothing.
 *
 * Note: `AgentResultDisplay.status` does NOT carry `'paused'` — that
 * status lives on the registry-side `BackgroundTaskStatus` and is
 * surfaced through the panel directly, never through a tool-result
 * `task_execution` payload. So this predicate has no `paused` arm.
 */
function isPanelOwnedSubagentTool(tool: IndividualToolCallDisplay): boolean {
  if (!isSubagentToolEntry(tool)) return false;
  const status = (tool.resultDisplay as AgentResultDisplay).status;
  return status === 'running' || status === 'background';
}

/**
 * Predicate: tool entry whose subagent has reached a terminal state
 * (`completed` / `failed` / `cancelled`). Used to force-expand the
 * group + force the inner ToolMessage to render its result block in
 * compact mode, so `SubagentScrollbackSummary` actually lands.
 */
function isTerminalSubagentTool(tool: IndividualToolCallDisplay): boolean {
  if (!isSubagentToolEntry(tool)) return false;
  const status = (tool.resultDisplay as AgentResultDisplay).status;
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled'
  );
}

interface ToolGroupMessageProps {
  groupId: number;
  toolCalls: IndividualToolCallDisplay[];
  availableTerminalHeight?: number;
  contentWidth: number;
  isFocused?: boolean;
  /**
   * True when this tool group is being rendered live (in
   * `pendingHistoryItems`). False once it commits to Ink's `<Static>`.
   *
   * Read by the group body to:
   *   1. Build `inlineToolCalls` — drop panel-owned subagent entries
   *      (running / background `task_execution` without pending
   *      approval) so LiveAgentPanel below the composer is the single
   *      source of truth for in-flight subagents. Mixed groups still
   *      render their non-subagent siblings; pure-panel-owned groups
   *      collapse to nothing and the whole bordered container is
   *      hidden. Terminal subagents (completed / failed / cancelled)
   *      pass through because `unregisterForeground`'s post-delete
   *      emit already drops them from the panel snapshot, and the
   *      inline path must render `SubagentScrollbackSummary`
   *      immediately so the user keeps a record of the run.
   *   2. Force-expand a compact group when committed AND carrying a
   *      terminal subagent, so `SubagentScrollbackSummary` actually
   *      lands in the persistent record (CompactToolGroupDisplay is
   *      otherwise unaware of `task_execution` results).
   *   3. Forward to `ToolMessage` for parity with sibling renderers
   *      and possible future gating; the prop is currently inert at
   *      that layer (the live-phase filter at #1 already prevents
   *      panel-owned entries from reaching the renderer, and the
   *      terminal scrollback summary fires in BOTH live and committed
   *      phases to bridge `unregisterForeground` → parent commit).
   */
  isPending?: boolean;
  activeShellPtyId?: number | null;
  embeddedShellFocused?: boolean;
  onShellInputSubmit?: (input: string) => void;
  /** Pre-computed count of write ops to managed-auto-memory files. */
  memoryWriteCount?: number;
  /** Pre-computed count of read ops from managed-auto-memory files. */
  memoryReadCount?: number;
  isUserInitiated?: boolean;
  /**
   * Short LLM-generated label for this batch. Used in compact mode in place
   * of the "active tool name × count" line. Undefined when summary
   * generation is disabled, still in-flight, or failed.
   */
  compactLabel?: string;
}

// Main component renders the border and maps the tools using ToolMessage
export const ToolGroupMessage: React.FC<ToolGroupMessageProps> = ({
  toolCalls,
  availableTerminalHeight,
  contentWidth,
  isFocused = true,
  isPending = false,
  activeShellPtyId,
  embeddedShellFocused,
  memoryWriteCount,
  memoryReadCount,
  isUserInitiated,
  compactLabel,
}) => {
  const config = useConfig();
  const { compactMode } = useCompactMode();

  const hasConfirmingTool = toolCalls.some(
    (t) => t.status === ToolCallStatus.Confirming,
  );
  const hasErrorTool = toolCalls.some((t) => t.status === ToolCallStatus.Error);
  const isEmbeddedShellFocused =
    embeddedShellFocused &&
    toolCalls.some(
      (t) =>
        t.ptyId === activeShellPtyId && t.status === ToolCallStatus.Executing,
    );

  // useMemo must be called unconditionally (Rules of Hooks) — before any early return
  // only prompt for tool approval on the first 'confirming' tool in the list
  // note, after the CTA, this automatically moves over to the next 'confirming' tool
  const toolAwaitingApproval = useMemo(
    () => toolCalls.find((tc) => tc.status === ToolCallStatus.Confirming),
    [toolCalls],
  );

  // Detect if this is a "memory-only" group (all tool calls are memory ops)
  const isMemoryOnlyGroup = useMemo(
    () => toolCalls.length > 0 && toolCalls.every((t) => t.isMemoryOp != null),
    [toolCalls],
  );

  const allComplete = useMemo(
    () =>
      toolCalls.every(
        (t) =>
          t.status === ToolCallStatus.Success ||
          t.status === ToolCallStatus.Error,
      ),
    [toolCalls],
  );

  // Live-phase panel-ownership filter applied ONCE so every downstream
  // decision (compact summary, sizing, render map) sees the same list.
  // Without this, mixed live groups (running subagent + sibling tool)
  // could leak the panel-owned subagent into `CompactToolGroupDisplay`'s
  // count / active-tool selection, reintroducing the duplicate UI the
  // LiveAgentPanel hand-off was designed to prevent. Pending-approval
  // subagents pass through (the inline banner / queued marker is the
  // only surface that lets users answer the prompt).
  const inlineToolCalls = useMemo(
    () =>
      isPending
        ? toolCalls.filter(
            (tool) =>
              !isPanelOwnedSubagentTool(tool) ||
              isAgentWithPendingConfirmation(tool.resultDisplay),
          )
        : toolCalls,
    [isPending, toolCalls],
  );

  // Determine which subagent tools currently have a pending confirmation.
  // Must be called unconditionally (Rules of Hooks) — before any early return.
  const subagentsAwaitingApproval = useMemo(
    () =>
      toolCalls.filter((tc) =>
        isAgentWithPendingConfirmation(tc.resultDisplay),
      ),
    [toolCalls],
  );

  // "First-come, first-served" focus lock: once a subagent's confirmation
  // appears, it keeps keyboard focus until the user resolves it. Only then
  // does focus move to the next pending subagent. This prevents the jarring
  // experience of focus jumping away while the user is mid-selection.
  const focusedSubagentRef = useRef<string | null>(null);

  const stillPending = subagentsAwaitingApproval.some(
    (tc) => tc.callId === focusedSubagentRef.current,
  );
  if (!stillPending) {
    // Release stale lock and promote the next pending subagent (if any).
    focusedSubagentRef.current = subagentsAwaitingApproval[0]?.callId ?? null;
  }

  const focusedSubagentCallId = focusedSubagentRef.current;
  // When no subagent has a pending confirmation, fall back to the *first*
  // running subagent for keyboard focus. "First" (array order) is the
  // oldest — the one most likely to be the focal subagent. The legacy
  // Ctrl+E / Ctrl+F display shortcuts retired with the inline frame, so
  // the fallback is now mostly inert; it stays here so a future
  // re-introduction of inline keyboard surfaces has a focus target.
  // Note: during the live phase running subagent entries are filtered
  // out of `inlineToolCalls` (LiveAgentPanel owns those rows), so this
  // id can point at a tool that won't be rendered. That's harmless —
  // `isSubagentFocused` is only consumed inside the `inlineToolCalls`
  // map iteration; the hidden entry is never iterated, so no focus
  // prop ever reaches a missing DOM node.
  const runningSubagentCallId = useMemo(
    () =>
      toolCalls.find((tc) => isRunningAgent(tc.resultDisplay))?.callId ?? null,
    [toolCalls],
  );
  // Pending confirmation takes strict priority over running fallback.
  const keyboardFocusedSubagentCallId =
    focusedSubagentCallId ?? runningSubagentCallId;

  // Hide the entire group when the live-phase filter leaves nothing
  // inline to render — i.e. a pure-running-subagent batch with no
  // pending approval. LiveAgentPanel below the composer is the
  // single source of truth for those rows; an empty bordered
  // container floating above the panel would just be a duplicate
  // chrome line. Terminal subagents (completed / failed / cancelled)
  // pass through `inlineToolCalls` because `unregisterForeground`'s
  // post-delete emit already dropped them from the panel snapshot,
  // and the inline path must render `SubagentScrollbackSummary`
  // immediately so the user keeps a record of the run.
  // (Gate on `isPending` so a degenerate empty `toolCalls=[]` in the
  // committed phase still falls through to the legacy empty-border
  // snapshot — the suppression is specifically about live-phase
  // panel ownership, not about hiding empty inputs in general.)
  if (isPending && inlineToolCalls.length === 0) {
    return null;
  }

  // Compact mode: entire group → single line summary
  // Force-expand when: user must interact (Confirming or subagent pending
  // confirmation), tool errored, shell is focused, or user-initiated.
  // Also force-expand when this group carries a terminal subagent —
  // `CompactToolGroupDisplay` doesn't know about `task_execution`
  // results, so the compact path would skip `SubagentScrollbackSummary`
  // entirely. Applies in BOTH live and committed phases:
  //   - committed phase: the summary is the persistent audit trail.
  //   - live phase: `unregisterForeground`'s post-delete emit has
  //     already evicted the panel snapshot row by the time a foreground
  //     subagent reaches a terminal status, so the inline summary is
  //     the only surface that carries the run's outcome until the
  //     parent commits. Mirrors the renderer-side decision in
  //     `SubagentExecutionRenderer` (terminal summary fires regardless
  //     of `isPending`) and the preprocessor in
  //     `mergeCompactToolGroups.isForceExpandGroup` (no `isPending`
  //     gate either).
  const hasSubagentPendingConfirmation = subagentsAwaitingApproval.length > 0;
  const hasTerminalSubagent = inlineToolCalls.some(isTerminalSubagentTool);
  const showCompact =
    compactMode &&
    !hasConfirmingTool &&
    !hasSubagentPendingConfirmation &&
    !hasErrorTool &&
    !isEmbeddedShellFocused &&
    !isUserInitiated &&
    !hasTerminalSubagent;

  if (showCompact) {
    return (
      <CompactToolGroupDisplay
        toolCalls={inlineToolCalls}
        contentWidth={contentWidth}
        compactLabel={compactLabel}
      />
    );
  }

  // Full expanded view
  const hasPending = !inlineToolCalls.every(
    (t) => t.status === ToolCallStatus.Success,
  );
  const isShellCommand = inlineToolCalls.some(
    (t) => t.name === SHELL_COMMAND_NAME || t.name === SHELL_NAME,
  );
  const borderColor =
    isShellCommand || isEmbeddedShellFocused
      ? theme.ui.symbol
      : hasPending
        ? theme.status.warning
        : theme.border.default;

  const staticHeight = /* border */ 2 + /* marginBottom */ 1;
  // account for border (2 chars) and padding (2 chars)
  const innerWidth = contentWidth - 4;

  let countToolCallsWithResults = 0;
  for (const tool of inlineToolCalls) {
    if (tool.resultDisplay !== undefined && tool.resultDisplay !== '') {
      countToolCallsWithResults++;
    }
  }
  const countOneLineToolCalls =
    inlineToolCalls.length - countToolCallsWithResults;
  const availableTerminalHeightPerToolMessage = availableTerminalHeight
    ? Math.max(
        Math.floor(
          (availableTerminalHeight - staticHeight - countOneLineToolCalls) /
            Math.max(1, countToolCallsWithResults),
        ),
        1,
      )
    : undefined;

  // For completed memory-only groups, show a compact summary instead of individual tool calls
  if (isMemoryOnlyGroup && allComplete) {
    const readCount = memoryReadCount ?? 0;
    const writeCount = memoryWriteCount ?? 0;
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        width={contentWidth}
        borderColor={theme.border.default}
      >
        {readCount > 0 && (
          <Box paddingLeft={1}>
            <Text dimColor>
              {'● '}
              Recalled {readCount} {readCount === 1 ? 'memory' : 'memories'}
            </Text>
          </Box>
        )}
        {writeCount > 0 && (
          <Box paddingLeft={1}>
            <Text dimColor>
              {'● '}
              Wrote {writeCount} {writeCount === 1 ? 'memory' : 'memories'}
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      /*
        This width constraint is highly important and protects us from an Ink rendering bug.
        Since the ToolGroup can typically change rendering states frequently, it can cause
        Ink to render the border of the box incorrectly and span multiple lines and even
        cause tearing.
      */
      width={contentWidth}
      borderDimColor={
        hasPending && (!isShellCommand || !isEmbeddedShellFocused)
      }
      borderColor={borderColor}
      gap={1}
    >
      {/* Memory badge for mixed groups (some memory ops + other ops) */}
      {!isMemoryOnlyGroup &&
        ((memoryWriteCount ?? 0) > 0 || (memoryReadCount ?? 0) > 0) &&
        (() => {
          const parts: string[] = [];
          if ((memoryReadCount ?? 0) > 0) {
            const n = memoryReadCount!;
            parts.push(`Recalled ${n} ${n === 1 ? 'memory' : 'memories'}`);
          }
          if ((memoryWriteCount ?? 0) > 0) {
            const n = memoryWriteCount!;
            parts.push(`Wrote ${n} ${n === 1 ? 'memory' : 'memories'}`);
          }
          return (
            <Box paddingLeft={1}>
              <Text dimColor>● {parts.join(', ')}</Text>
            </Box>
          );
        })()}
      {inlineToolCalls.map((tool) => {
        // `inlineToolCalls` already excludes panel-owned subagent
        // entries during the live phase (LiveAgentPanel owns those
        // rows). Terminal subagents and pending-approval subagents
        // pass through the filter and render inline so the
        // scrollback summary / approval banner lands.
        const isConfirming = toolAwaitingApproval?.callId === tool.callId;
        // A subagent's inline approval prompt should only receive keyboard
        // focus when (1) there is no direct tool-level confirmation active
        // and (2) this tool currently holds the subagent keyboard focus.
        // Pending confirmations keep the first-come focus lock so users
        // answer one approval at a time; LiveAgentPanel + BackgroundTasksDialog
        // own all live progress / drill-down (the legacy Ctrl+E / Ctrl+F
        // shortcuts on the inline AgentExecutionDisplay frame were retired
        // alongside the frame itself).
        const isSubagentFocused =
          isFocused &&
          !toolAwaitingApproval &&
          keyboardFocusedSubagentCallId === tool.callId;
        return (
          <Box key={tool.callId} flexDirection="column" minHeight={1}>
            <Box flexDirection="row" alignItems="center">
              <ToolMessage
                {...tool}
                availableTerminalHeight={availableTerminalHeightPerToolMessage}
                contentWidth={innerWidth}
                emphasis={
                  isConfirming
                    ? 'high'
                    : toolAwaitingApproval
                      ? 'low'
                      : 'medium'
                }
                activeShellPtyId={activeShellPtyId}
                embeddedShellFocused={embeddedShellFocused}
                config={config}
                forceShowResult={
                  isUserInitiated ||
                  tool.status === ToolCallStatus.Confirming ||
                  tool.status === ToolCallStatus.Error ||
                  isAgentWithPendingConfirmation(tool.resultDisplay) ||
                  // Terminal subagents need their result block to render
                  // even in compact mode — that's where
                  // `SubagentScrollbackSummary` lands. ToolMessage's
                  // compact-mode gate
                  // (`!compactMode || forceShowResult ? renderer : 'none'`)
                  // would otherwise drop the result block, leaving the
                  // committed audit trail empty for compact-mode users.
                  isTerminalSubagentTool(tool)
                }
                isFocused={isSubagentFocused}
                isPending={isPending}
              />
            </Box>
            {tool.status === ToolCallStatus.Confirming &&
              isConfirming &&
              tool.confirmationDetails && (
                <ToolConfirmationMessage
                  confirmationDetails={tool.confirmationDetails}
                  config={config}
                  isFocused={isFocused}
                  availableTerminalHeight={
                    availableTerminalHeightPerToolMessage
                  }
                  contentWidth={innerWidth}
                />
              )}
          </Box>
        );
      })}
    </Box>
  );
};

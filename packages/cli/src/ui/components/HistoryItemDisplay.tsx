/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo, useRef, useCallback } from 'react';
import type { DOMElement } from 'ink';
import {
  escapeAnsiCtrlCodes,
  sanitizeSensitiveText,
} from '../utils/textUtils.js';
import type { HistoryItem } from '../types.js';
import {
  UserMessage,
  UserShellMessage,
  AssistantMessage,
  AssistantMessageContent,
  ThinkMessage,
  ThinkMessageContent,
} from './messages/ConversationMessages.js';
import { ToolGroupMessage } from './messages/ToolGroupMessage.js';
import { CompressionMessage } from './messages/CompressionMessage.js';
import { SummaryMessage } from './messages/SummaryMessage.js';
import {
  InfoMessage,
  WarningMessage,
  ErrorMessage,
  RetryCountdownMessage,
  SuccessMessage,
  AwayRecapMessage,
} from './messages/StatusMessages.js';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import {
  MarkdownDisplay,
  type MarkdownSourceCopyIndexOffsets,
} from '../utils/MarkdownDisplay.js';
import { AboutBox } from './AboutBox.js';
import { StatsDisplay } from './StatsDisplay.js';
import { ModelStatsDisplay } from './ModelStatsDisplay.js';
import { ToolStatsDisplay } from './ToolStatsDisplay.js';
import { SessionSummaryDisplay } from './SessionSummaryDisplay.js';
import { Help } from './Help.js';
import type { SlashCommand } from '../commands/types.js';
import { ExtensionsList } from './views/ExtensionsList.js';
import { getMCPServerStatus } from '@qwen-code/qwen-code-core';
import { SkillsList } from './views/SkillsList.js';
import { ToolsList } from './views/ToolsList.js';
import { McpStatus } from './views/McpStatus.js';
import { ContextUsage } from './views/ContextUsage.js';
import { DoctorReport } from './views/DoctorReport.js';
import { ArenaAgentCard, ArenaSessionCard } from './arena/ArenaCards.js';
import { InsightProgressMessage } from './messages/InsightProgressMessage.js';
import { BtwMessage } from './messages/BtwMessage.js';
import { MemorySavedMessage } from './messages/MemorySavedMessage.js';
import { DiffStatsDisplay } from './messages/DiffStatsDisplay.js';
import { GoalStatusMessage } from './messages/GoalStatusMessage.js';
import { useCompactMode } from '../contexts/CompactModeContext.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { useThoughtExpanded } from '../contexts/ThoughtExpandedContext.js';
import { useThinkingViewer } from '../contexts/ThinkingViewerContext.js';
import { useMouseEvents } from '../hooks/useMouseEvents.js';
import type { MouseEvent } from '../utils/mouse.js';
import { measureElementPosition } from '../utils/measure-element-position.js';

interface HistoryItemDisplayProps {
  item: HistoryItem;
  availableTerminalHeight?: number;
  terminalWidth: number;
  mainAreaWidth?: number;
  isPending: boolean;
  isFocused?: boolean;
  commands?: readonly SlashCommand[];
  activeShellPtyId?: number | null;
  embeddedShellFocused?: boolean;
  availableTerminalHeightGemini?: number;
  /**
   * When the item is a `tool_group`, an optional short LLM-generated label
   * summarizing the batch. Replaces the generic "Tool × N" line in compact
   * mode. Computed by the parent from `tool_use_summary` history items.
   */
  compactLabel?: string;
  /**
   * When the item is a `tool_use_summary`, true if a sibling tool_group has
   * absorbed this label via its compact-mode header. The standalone `● <label>`
   * line is suppressed in that case. False for force-expanded groups in
   * compact mode (they render through the full ToolGroupMessage path and
   * don't consume compactLabel, so the standalone line is the label's only
   * path to the screen) and for all tool_use_summary items in full mode.
   */
  summaryAbsorbed?: boolean;
  sourceCopyIndexOffsets?: MarkdownSourceCopyIndexOffsets;
  /** Force thinking blocks expanded (e.g. in SessionPreview). */
  thoughtExpanded?: boolean;
  /** Aggregated text from this thought + its continuation items. */
  thinkingFullText?: string;
}

/**
 * Wraps ThinkMessage with mouse click-to-open handling.
 * Extracted so that non-thought HistoryItemDisplay instances
 * don't pay the useMouseEvents/useRef/useCallback hook cost.
 */
const ClickableThinkMessage: React.FC<{
  text: string;
  viewerText: string;
  isPending: boolean;
  expanded: boolean;
  availableTerminalHeight?: number;
  contentWidth: number;
  durationMs?: number;
}> = ({
  text,
  viewerText,
  isPending,
  expanded,
  availableTerminalHeight,
  contentWidth,
  durationMs,
}) => {
  const ref = useRef<DOMElement>(null);
  const { openThinkingViewer } = useThinkingViewer();
  const isActive = !isPending && !expanded;
  const sanitizedViewerText = useMemo(
    () => escapeAnsiCtrlCodes(viewerText),
    [viewerText],
  );

  useMouseEvents(
    useCallback(
      (event: MouseEvent) => {
        if (event.name !== 'left-press' || !ref.current) return;
        const metrics = measureElementPosition(ref.current);
        const col = event.col - 1;
        const row = event.row - 1;
        if (
          col >= metrics.x &&
          col < metrics.x + metrics.width &&
          row >= metrics.y &&
          row < metrics.y + metrics.height
        ) {
          openThinkingViewer({ text: sanitizedViewerText, durationMs });
        }
      },
      [openThinkingViewer, sanitizedViewerText, durationMs],
    ),
    { isActive },
  );

  return (
    <Box ref={isActive ? ref : undefined}>
      <ThinkMessage
        text={text}
        isPending={isPending}
        expanded={expanded}
        availableTerminalHeight={availableTerminalHeight}
        contentWidth={contentWidth}
        durationMs={durationMs}
      />
    </Box>
  );
};

function getHistoryItemMarginTop(item: HistoryItem): number {
  switch (item.type) {
    case 'gemini':
    case 'gemini_thought':
      return 1;
    case 'gemini_content':
    case 'gemini_thought_content':
    case 'info':
    case 'success':
    case 'warning':
    case 'error':
    case 'retry_countdown':
    case 'memory_saved':
    case 'tool_group':
    case 'tool_use_summary':
    case 'notification':
    case 'compression':
    case 'summary':
    case 'insight_progress':
    case 'btw':
    case 'away_recap':
    case 'user':
    case 'user_prompt_submit_blocked':
    case 'stop_hook_loop':
    case 'stop_hook_system_message':
    case 'goal_status':
      return 0;
    default:
      return 1;
  }
}

const HistoryItemDisplayComponent: React.FC<HistoryItemDisplayProps> = ({
  item,
  availableTerminalHeight,
  terminalWidth,
  mainAreaWidth,
  isPending,
  commands,
  isFocused = true,
  activeShellPtyId,
  embeddedShellFocused,
  availableTerminalHeightGemini,
  compactLabel,
  summaryAbsorbed = false,
  sourceCopyIndexOffsets,
  thoughtExpanded,
  thinkingFullText,
}) => {
  const marginTop = getHistoryItemMarginTop(item);

  const { compactMode } = useCompactMode();
  const contextThoughtExpanded = useThoughtExpanded();
  const resolvedThoughtExpanded = thoughtExpanded ?? contextThoughtExpanded;
  const settings = useSettings();
  const showTimestamps = settings.merged.output?.showTimestamps === true;

  const itemForDisplay = useMemo(() => escapeAnsiCtrlCodes(item), [item]);
  const contentWidth = terminalWidth - 4;
  const boxWidth = mainAreaWidth || contentWidth;

  return (
    <Box
      flexDirection="column"
      key={itemForDisplay.id}
      marginTop={marginTop}
      marginLeft={2}
      marginRight={2}
    >
      {/* Render standard message types */}
      {itemForDisplay.type === 'user' && (
        <UserMessage text={itemForDisplay.text} width={contentWidth} />
      )}
      {itemForDisplay.type === 'notification' && (
        <InfoMessage text={itemForDisplay.text} />
      )}
      {itemForDisplay.type === 'user_shell' && (
        <UserShellMessage text={itemForDisplay.text} />
      )}
      {itemForDisplay.type === 'gemini' && (
        <>
          {showTimestamps && itemForDisplay.timestamp != null && (
            <Text dimColor>
              [
              {new Date(itemForDisplay.timestamp).toLocaleTimeString('en-US', {
                hour12: false,
              })}
              ]
            </Text>
          )}
          <AssistantMessage
            text={itemForDisplay.text}
            isPending={isPending}
            availableTerminalHeight={
              availableTerminalHeightGemini ?? availableTerminalHeight
            }
            contentWidth={contentWidth}
            sourceCopyIndexOffsets={sourceCopyIndexOffsets}
          />
        </>
      )}
      {itemForDisplay.type === 'gemini_content' && (
        <AssistantMessageContent
          text={itemForDisplay.text}
          isPending={isPending}
          availableTerminalHeight={
            availableTerminalHeightGemini ?? availableTerminalHeight
          }
          contentWidth={contentWidth}
          sourceCopyIndexOffsets={sourceCopyIndexOffsets}
        />
      )}
      {itemForDisplay.type === 'gemini_thought' && (
        <ClickableThinkMessage
          text={itemForDisplay.text.trimEnd()}
          viewerText={(thinkingFullText || itemForDisplay.text).trimEnd()}
          isPending={isPending}
          expanded={resolvedThoughtExpanded}
          availableTerminalHeight={
            availableTerminalHeightGemini ?? availableTerminalHeight
          }
          contentWidth={contentWidth}
          durationMs={itemForDisplay.durationMs}
        />
      )}
      {itemForDisplay.type === 'gemini_thought_content' && (
        <ThinkMessageContent
          text={itemForDisplay.text.trimEnd()}
          isPending={isPending}
          expanded={resolvedThoughtExpanded}
          availableTerminalHeight={
            availableTerminalHeightGemini ?? availableTerminalHeight
          }
          contentWidth={contentWidth}
        />
      )}
      {itemForDisplay.type === 'info' && (
        <InfoMessage
          text={itemForDisplay.text}
          linkUrl={itemForDisplay.linkUrl}
          linkText={itemForDisplay.linkText}
        />
      )}
      {itemForDisplay.type === 'success' && (
        <SuccessMessage text={itemForDisplay.text} />
      )}
      {itemForDisplay.type === 'warning' && (
        <WarningMessage text={itemForDisplay.text} />
      )}
      {itemForDisplay.type === 'error' && (
        <ErrorMessage text={itemForDisplay.text} hint={itemForDisplay.hint} />
      )}
      {itemForDisplay.type === 'retry_countdown' && (
        <RetryCountdownMessage text={itemForDisplay.text} />
      )}
      {itemForDisplay.type === 'about' && (
        <AboutBox {...itemForDisplay.systemInfo} width={boxWidth} />
      )}
      {itemForDisplay.type === 'help' && commands && (
        <Help commands={commands} width={boxWidth} />
      )}
      {itemForDisplay.type === 'stats' && (
        <StatsDisplay duration={itemForDisplay.duration} width={boxWidth} />
      )}
      {itemForDisplay.type === 'diff_stats' && (
        <DiffStatsDisplay model={itemForDisplay.model} />
      )}
      {itemForDisplay.type === 'model_stats' && (
        <ModelStatsDisplay width={boxWidth} />
      )}
      {itemForDisplay.type === 'tool_stats' && (
        <ToolStatsDisplay width={boxWidth} />
      )}
      {itemForDisplay.type === 'quit' && (
        <SessionSummaryDisplay
          duration={itemForDisplay.duration}
          width={boxWidth}
        />
      )}
      {itemForDisplay.type === 'tool_group' && (
        <ToolGroupMessage
          toolCalls={itemForDisplay.tools}
          groupId={itemForDisplay.id}
          availableTerminalHeight={availableTerminalHeight}
          contentWidth={contentWidth}
          isFocused={isFocused}
          isPending={isPending}
          activeShellPtyId={activeShellPtyId}
          embeddedShellFocused={embeddedShellFocused}
          memoryWriteCount={itemForDisplay.memoryWriteCount}
          memoryReadCount={itemForDisplay.memoryReadCount}
          isUserInitiated={itemForDisplay.isUserInitiated}
          compactLabel={compactLabel}
        />
      )}
      {/*
        `tool_use_summary` as a standalone inline item.

        In full mode (`compactMode=false`), the label arrives via the fast-model
        call AFTER the tool_group has been committed to Ink's append-only
        <Static>, so we cannot update the tool_group's header retroactively.
        Rendering a standalone `● <label>` line appends cleanly.

        In compact mode, the label is normally absorbed into the merged
        tool_group's header (via `compactLabel` prop to CompactToolGroupDisplay),
        and `summaryAbsorbed=true` is set so this block does nothing. But when
        the sibling tool_group is force-expanded (errors, confirmations,
        user-initiated, focused shell), the full-expand path ignores
        `compactLabel`, and `MainContent` leaves `summaryAbsorbed=false` —
        the standalone line below is then the label's only route to the UI,
        which is exactly the case where a summary is most diagnostically
        useful ("Fixed NPE in UserService" on an errored batch).
      */}
      {itemForDisplay.type === 'tool_use_summary' &&
        (!compactMode || !summaryAbsorbed) && (
          <Box paddingLeft={1}>
            <Text dimColor>● {itemForDisplay.summary}</Text>
          </Box>
        )}
      {itemForDisplay.type === 'compression' && (
        <CompressionMessage compression={itemForDisplay.compression} />
      )}
      {itemForDisplay.type === 'summary' && (
        <SummaryMessage summary={itemForDisplay.summary} />
      )}
      {itemForDisplay.type === 'extensions_list' && <ExtensionsList />}
      {itemForDisplay.type === 'tools_list' && (
        <ToolsList
          contentWidth={contentWidth}
          tools={itemForDisplay.tools}
          showDescriptions={itemForDisplay.showDescriptions}
        />
      )}
      {itemForDisplay.type === 'skills_list' && (
        <SkillsList skills={itemForDisplay.skills} />
      )}
      {itemForDisplay.type === 'mcp_status' && (
        <McpStatus {...itemForDisplay} serverStatus={getMCPServerStatus} />
      )}
      {itemForDisplay.type === 'context_usage' && (
        <ContextUsage
          modelName={itemForDisplay.modelName}
          totalTokens={itemForDisplay.totalTokens}
          contextWindowSize={itemForDisplay.contextWindowSize}
          breakdown={itemForDisplay.breakdown}
          builtinTools={itemForDisplay.builtinTools}
          mcpTools={itemForDisplay.mcpTools}
          memoryFiles={itemForDisplay.memoryFiles}
          skills={itemForDisplay.skills}
          isEstimated={itemForDisplay.isEstimated}
          showDetails={itemForDisplay.showDetails}
        />
      )}
      {itemForDisplay.type === 'doctor' && (
        <DoctorReport
          checks={itemForDisplay.checks}
          summary={itemForDisplay.summary}
          width={boxWidth}
        />
      )}
      {itemForDisplay.type === 'arena_agent_complete' && (
        <ArenaAgentCard agent={itemForDisplay.agent} width={boxWidth} />
      )}
      {itemForDisplay.type === 'arena_session_complete' && (
        <ArenaSessionCard
          sessionStatus={itemForDisplay.sessionStatus}
          task={itemForDisplay.task}
          totalDurationMs={itemForDisplay.totalDurationMs}
          agents={itemForDisplay.agents}
          width={boxWidth}
        />
      )}
      {itemForDisplay.type === 'insight_progress' && (
        <InsightProgressMessage progress={itemForDisplay.progress} />
      )}
      {itemForDisplay.type === 'btw' && itemForDisplay.btw && (
        <BtwMessage btw={itemForDisplay.btw} containerWidth={contentWidth} />
      )}
      {itemForDisplay.type === 'user_prompt_submit_blocked' && (
        <Box flexDirection="column">
          <Text color={theme.status.warning}>
            {`✕ UserPromptSubmit operation blocked by hook:\n${itemForDisplay.reason}\n\nOriginal prompt: ${sanitizeSensitiveText(itemForDisplay.originalPrompt)}`}
          </Text>
        </Box>
      )}
      {itemForDisplay.type === 'stop_hook_loop' && (
        <InfoMessage
          text={`Ran ${itemForDisplay.stopHookCount} stop hooks\n  ⎿  Stop hook error: ${itemForDisplay.reasons[itemForDisplay.reasons.length - 1]}`}
        />
      )}
      {itemForDisplay.type === 'stop_hook_system_message' && (
        <Box flexDirection="column">
          <Text color={theme.text.primary}> ⎿ Stop says:</Text>
          <Box marginLeft={4} flexDirection="column">
            <MarkdownDisplay
              text={itemForDisplay.message}
              isPending={false}
              contentWidth={contentWidth - 4}
            />
          </Box>
        </Box>
      )}
      {itemForDisplay.type === 'memory_saved' && (
        <MemorySavedMessage item={itemForDisplay} />
      )}
      {itemForDisplay.type === 'away_recap' && (
        <AwayRecapMessage text={itemForDisplay.text} />
      )}
      {itemForDisplay.type === 'goal_status' && (
        <GoalStatusMessage
          kind={itemForDisplay.kind}
          condition={itemForDisplay.condition}
          iterations={itemForDisplay.iterations}
          durationMs={itemForDisplay.durationMs}
          lastReason={itemForDisplay.lastReason}
        />
      )}
    </Box>
  );
};

// Export alias for backward compatibility
export { HistoryItemDisplayComponent as HistoryItemDisplay };

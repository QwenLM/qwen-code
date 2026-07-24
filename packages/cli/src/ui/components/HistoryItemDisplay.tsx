/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { memo, useMemo, useRef, useCallback } from 'react';
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
  VisionNoticeMessage,
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
import { SkillStatsDisplay } from './SkillStatsDisplay.js';
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
import { useSettings } from '../contexts/SettingsContext.js';
import { useVirtualViewport } from '../contexts/VirtualViewportContext.js';
import { useThoughtExpanded } from '../contexts/ThoughtExpandedContext.js';
import { useMouseEvents } from '../hooks/useMouseEvents.js';
import type { MouseEvent } from '../utils/mouse.js';
import {
  measureElementPosition,
  layoutRowForEvent,
} from '../utils/measure-element-position.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';

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
  sourceCopyIndexOffsets?: MarkdownSourceCopyIndexOffsets;
  /** Force thinking blocks expanded (e.g. in SessionPreview). */
  thoughtExpanded?: boolean;
  /**
   * Transcript full-detail mode (Ctrl+O). When true, collapse is lifted:
   * thinking blocks render expanded and tool groups force `forceExpandAll`
   * + `forceShowResult` (every tool with its full, untruncated result).
   * Default false (main view stays at the #5661 partition baseline).
   */
  fullDetail?: boolean;
  /**
   * Head id of the thought group this item belongs to (the `gemini_thought`
   * head id for both the head and its `gemini_thought_content` continuations).
   * Used to expand/collapse the whole group as a unit on click.
   */
  thoughtHeadId?: number;
}

/**
 * Wraps ThinkMessage with mouse click-to-open handling.
 * Extracted so that non-thought HistoryItemDisplay instances
 * don't pay the useMouseEvents/useRef/useCallback hook cost.
 */
const ClickableThinkMessage: React.FC<{
  text: string;
  isPending: boolean;
  expanded: boolean;
  availableTerminalHeight?: number;
  contentWidth: number;
  durationMs?: number;
  onToggle: () => void;
}> = ({
  text,
  isPending,
  expanded,
  availableTerminalHeight,
  contentWidth,
  durationMs,
  onToggle,
}) => {
  const ref = useRef<DOMElement>(null);
  const pressRef = useRef<{ col: number; row: number } | null>(null);
  const { rows: terminalHeight } = useTerminalSize();
  const settings = useSettings();
  const clickable = useVirtualViewport(settings.merged.ui?.useTerminalBuffer);
  const isActive = !isPending;

  useMouseEvents(
    useCallback(
      (event: MouseEvent) => {
        if (!ref.current) return;
        if (event.name === 'move') {
          if (
            pressRef.current &&
            (event.col !== pressRef.current.col ||
              event.row !== pressRef.current.row)
          ) {
            pressRef.current = null;
          }
          return;
        }
        if (event.name !== 'left-press' && event.name !== 'left-release') {
          pressRef.current = null;
          return;
        }
        const metrics = measureElementPosition(ref.current);
        const col = event.col - 1;
        const row = layoutRowForEvent(ref.current, event.row, terminalHeight);
        const isInside =
          col >= metrics.x &&
          col < metrics.x + metrics.width &&
          row >= metrics.y &&
          row < metrics.y + metrics.height;
        if (event.name === 'left-press') {
          pressRef.current = isInside
            ? { col: event.col, row: event.row }
            : null;
          return;
        }
        const press = pressRef.current;
        pressRef.current = null;
        if (isInside && press?.col === event.col && press.row === event.row) {
          onToggle();
        }
      },
      [onToggle, terminalHeight],
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
        clickable={clickable}
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
    case 'vision_notice':
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
  sourceCopyIndexOffsets,
  thoughtExpanded,
  fullDetail = false,
  thoughtHeadId,
}) => {
  const marginTop = getHistoryItemMarginTop(item);

  const {
    allExpanded,
    expandedHeadIds,
    toggle: toggleThought,
  } = useThoughtExpanded();
  // A thought spans the `gemini_thought` head plus its trailing
  // `gemini_thought_content` items; all of them key off the head id so one
  // click expands the whole group. Continuations receive the head id via
  // `thoughtHeadId`; the head itself falls back to its own id.
  const thoughtGroupHeadId = thoughtHeadId ?? item.id;
  // Ctrl+O full-detail forces every thought open; otherwise honor an explicit
  // `thoughtExpanded` prop, then the global Alt+T toggle / per-group click set.
  const resolvedThoughtExpanded =
    fullDetail ||
    (thoughtExpanded ??
      (allExpanded || expandedHeadIds.has(thoughtGroupHeadId)));
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
        <UserMessage text={itemForDisplay.text} />
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
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
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
          isPending={isPending}
          expanded={resolvedThoughtExpanded}
          availableTerminalHeight={
            availableTerminalHeightGemini ?? availableTerminalHeight
          }
          contentWidth={contentWidth}
          durationMs={itemForDisplay.durationMs}
          onToggle={() => toggleThought(thoughtGroupHeadId)}
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
      {itemForDisplay.type === 'vision_notice' && (
        <VisionNoticeMessage text={itemForDisplay.text} />
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
      {itemForDisplay.type === 'skill_stats' && (
        <SkillStatsDisplay width={boxWidth} />
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
          fullDetail={fullDetail}
        />
      )}
      {itemForDisplay.type === 'tool_use_summary' && (
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

// Memoized so the Ctrl+O transcript — which re-renders on every scroll tick —
// skips re-rendering frozen-snapshot items whose props are shallowly unchanged.
// The transcript hands stable `item` references (from the freeze snapshot), so
// the default shallow compare is effective. Harmless for the main view, whose
// items live in Ink's `<Static>` and render once anyway.
const HistoryItemDisplay = memo(HistoryItemDisplayComponent);
HistoryItemDisplay.displayName = 'HistoryItemDisplay';

export { HistoryItemDisplay };

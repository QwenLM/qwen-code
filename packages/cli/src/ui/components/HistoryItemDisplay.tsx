/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo } from 'react';
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
} from './messages/StatusMessages.js';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { MarkdownDisplay } from '../utils/MarkdownDisplay.js';
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
import { ArenaAgentCard, ArenaSessionCard } from './arena/ArenaCards.js';
import { InsightProgressMessage } from './messages/InsightProgressMessage.js';
import { BtwMessage } from './messages/BtwMessage.js';
import { useVerboseMode } from '../contexts/VerboseModeContext.js';

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
}) => {
  const marginTop =
    item.type === 'gemini_content' || item.type === 'gemini_thought_content'
      ? 0
      : 1;

  const { verboseMode } = useVerboseMode();
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
      {itemForDisplay.type === 'user_shell' && (
        <UserShellMessage text={itemForDisplay.text} />
      )}
      {itemForDisplay.type === 'gemini' && (
        <AssistantMessage
          text={itemForDisplay.text}
          isPending={isPending}
          availableTerminalHeight={
            availableTerminalHeightGemini ?? availableTerminalHeight
          }
          contentWidth={contentWidth}
        />
      )}
      {itemForDisplay.type === 'gemini_content' && (
        <AssistantMessageContent
          text={itemForDisplay.text}
          isPending={isPending}
          availableTerminalHeight={
            availableTerminalHeightGemini ?? availableTerminalHeight
          }
          contentWidth={contentWidth}
        />
      )}
      {verboseMode && itemForDisplay.type === 'gemini_thought' && (
        <ThinkMessage
          text={itemForDisplay.text}
          isPending={isPending}
          availableTerminalHeight={
            availableTerminalHeightGemini ?? availableTerminalHeight
          }
          contentWidth={contentWidth}
        />
      )}
      {verboseMode && itemForDisplay.type === 'gemini_thought_content' && (
        <ThinkMessageContent
          text={itemForDisplay.text}
          isPending={isPending}
          availableTerminalHeight={
            availableTerminalHeightGemini ?? availableTerminalHeight
          }
          contentWidth={contentWidth}
        />
      )}
      {itemForDisplay.type === 'info' && (
        <InfoMessage text={itemForDisplay.text} />
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
          activeShellPtyId={activeShellPtyId}
          embeddedShellFocused={embeddedShellFocused}
          isUserInitiated={itemForDisplay.isUserInitiated}
        />
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
    </Box>
  );
};

// Export alias for backward compatibility
export { HistoryItemDisplayComponent as HistoryItemDisplay };

/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useMemo } from 'react';
import { Text, Box } from 'ink';
import { escapeAnsiCtrlCodes } from '../utils/textUtils.js';
import type { HistoryItem } from '../types.js';
import { UserMessage } from './messages/UserMessage.js';
import { UserShellMessage } from './messages/UserShellMessage.js';
import { AssistantMessage } from './messages/AssistantMessage.js';
import { InfoMessage } from './messages/InfoMessage.js';
import { ErrorMessage } from './messages/ErrorMessage.js';
import {
  hasRenderableToolGroup,
  ToolGroupMessage,
} from './messages/ToolGroupMessage.js';
import { AssistantMessageContent } from './messages/AssistantMessageContent.js';
import { CompressionMessage } from './messages/CompressionMessage.js';
import { ModelQueueMessage } from './messages/ModelQueueMessage.js';
import { WarningMessage } from './messages/WarningMessage.js';
import { SubagentHistoryMessage } from './messages/SubagentHistoryMessage.js';
import { AboutBox } from './AboutBox.js';
import { StatsDisplay } from './StatsDisplay.js';
import { ModelStatsDisplay } from './ModelStatsDisplay.js';
import { ToolStatsDisplay } from './ToolStatsDisplay.js';
import { SessionSummaryDisplay } from './SessionSummaryDisplay.js';
import { Help } from './Help.js';
import { runLogger } from '@qwen-code/core';
import { ModelMessage } from './messages/ModelMessage.js';
import {
  ThinkingMessage,
  hasRenderableThought,
} from './messages/ThinkingMessage.js';
import { HintMessage } from './messages/HintMessage.js';
import { getInlineThinkingMode } from '../utils/inlineThinkingMode.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { MessageSlot } from './messages/MessageSlot.js';
import { INDENT, type SpacingCategory } from '../constants/messageLayout.js';
import { theme as semanticTheme } from '../semantic-colors.js';
import { OffscreenFreeze } from './OffscreenFreeze.js';
import { REFUSED_MODEL_TEXT_EXCLUDED_NOTICE } from '../constants/contextExclusion.js';

/**
 * Error boundary that catches render failures in individual history items
 * and replaces them with an inline warning instead of crashing the entire app.
 */
class HistoryItemErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    runLogger.warn(
      [
        `[HistoryItemDisplay] Render error caught by boundary: ${error.message}`,
        `component_stack=${errorInfo.componentStack || 'unavailable'}`,
        `error_stack=${error.stack ?? 'unavailable'}`,
      ].join('\n'),
    );
  }

  override render() {
    if (this.state.error) {
      return (
        <Box marginLeft={INDENT.FEED_LEFT_OFFSET}>
          <Text color={semanticTheme.status.warning}>
            ? Failed to render this message
          </Text>
        </Box>
      );
    }
    return this.props.children;
  }
}

export interface HistoryItemDisplayProps {
  item: HistoryItem;
  availableTerminalHeight?: number;
  terminalWidth: number;
  isPending: boolean;
  isStatic?: boolean;
  availableTerminalHeightAssistant?: number;
  isExpandable?: boolean;
  isFirstThinking?: boolean;
  isToolGroupBoundary?: boolean;
  suppressNarration?: boolean;
  category?: SpacingCategory;
  prevCategory?: SpacingCategory;
}

export function areHistoryItemPropsEqual(
  prev: HistoryItemDisplayProps,
  next: HistoryItemDisplayProps,
): boolean {
  if (prev.item.id !== next.item.id) return false;
  if (prev.terminalWidth !== next.terminalWidth) return false;
  if (prev.availableTerminalHeight !== next.availableTerminalHeight)
    return false;
  if (prev.isStatic !== next.isStatic) return false;
  if (prev.isStatic === true && next.isStatic === true) {
    return (
      prev.item === next.item &&
      prev.isPending === next.isPending &&
      prev.availableTerminalHeightAssistant ===
        next.availableTerminalHeightAssistant &&
      prev.isExpandable === next.isExpandable &&
      prev.isFirstThinking === next.isFirstThinking &&
      prev.isToolGroupBoundary === next.isToolGroupBoundary &&
      prev.suppressNarration === next.suppressNarration &&
      prev.category === next.category &&
      prev.prevCategory === next.prevCategory
    );
  }
  return false;
}

export const HistoryItemDisplay: React.FC<HistoryItemDisplayProps> = ({
  item,
  availableTerminalHeight,
  terminalWidth,
  isPending,
  availableTerminalHeightAssistant,
  isExpandable,
  isFirstThinking = false,
  isToolGroupBoundary = false,
  suppressNarration = false,
  category,
  prevCategory,
}) => {
  const settings = useSettings();
  const inlineThinkingMode = getInlineThinkingMode(settings);
  const itemForDisplay = useMemo(() => escapeAnsiCtrlCodes(item), [item]);

  // If there's a topic update in this turn, we suppress the regular narration
  // and thoughts as they are being "replaced" by the update_topic tool.
  if (
    suppressNarration &&
    (itemForDisplay.type === 'thinking' ||
      itemForDisplay.type === 'gemini' ||
      itemForDisplay.type === 'gemini_content')
  ) {
    return null;
  }

  if (
    (itemForDisplay.type === 'gemini' ||
      itemForDisplay.type === 'gemini_content') &&
    itemForDisplay.text.trim().length === 0
  ) {
    return null;
  }

  if (
    itemForDisplay.type === 'thinking' &&
    (inlineThinkingMode === 'off' ||
      !hasRenderableThought(itemForDisplay.thought))
  ) {
    return null;
  }

  if (
    itemForDisplay.type === 'tool_group' &&
    !hasRenderableToolGroup(itemForDisplay)
  ) {
    return null;
  }

  const content = (
    <>
      {/* Render standard message types */}
      {itemForDisplay.type === 'thinking' && inlineThinkingMode !== 'off' && (
        <ThinkingMessage
          thought={itemForDisplay.thought}
          terminalWidth={terminalWidth}
          isFirstThinking={isFirstThinking}
        />
      )}
      {itemForDisplay.type === 'hint' && (
        <HintMessage text={itemForDisplay.text} />
      )}
      {itemForDisplay.type === 'user' && (
        <UserMessage text={itemForDisplay.text} width={terminalWidth} />
      )}
      {itemForDisplay.type === 'user_shell' && (
        <UserShellMessage text={itemForDisplay.text} width={terminalWidth} />
      )}
      {itemForDisplay.type === 'gemini' && (
        <AssistantMessage
          text={itemForDisplay.text}
          isPending={isPending}
          availableTerminalHeight={
            availableTerminalHeightAssistant ?? availableTerminalHeight
          }
          terminalWidth={terminalWidth}
        />
      )}
      {itemForDisplay.type === 'gemini_content' && (
        <AssistantMessageContent
          text={itemForDisplay.text}
          isPending={isPending}
          availableTerminalHeight={
            availableTerminalHeightAssistant ?? availableTerminalHeight
          }
          terminalWidth={terminalWidth}
        />
      )}
      {itemForDisplay.type === 'custom_content' && (
        <Box
          flexDirection="column"
          width={terminalWidth}
          paddingLeft={INDENT.FEED_LEFT_OFFSET}
        >
          {itemForDisplay.content}
        </Box>
      )}
      {itemForDisplay.type === 'info' &&
        (itemForDisplay.customContent ?? (
          <InfoMessage
            text={itemForDisplay.text}
            links={itemForDisplay.links}
            secondaryText={itemForDisplay.secondaryText}
            source={itemForDisplay.source}
            icon={itemForDisplay.icon}
            color={itemForDisplay.color}
            activity={itemForDisplay.activity}
          />
        ))}
      {itemForDisplay.type === 'warning' && (
        <WarningMessage text={itemForDisplay.text} />
      )}
      {itemForDisplay.type === 'error' && (
        <ErrorMessage text={itemForDisplay.text} />
      )}
      {itemForDisplay.type === 'about' && (
        <AboutBox
          cliVersion={itemForDisplay.cliVersion}
          osVersion={itemForDisplay.osVersion}
          modelVersion={itemForDisplay.modelVersion}
        />
      )}
      {itemForDisplay.type === 'help' && <Help />}
      {itemForDisplay.type === 'stats' && (
        <StatsDisplay
          duration={itemForDisplay.duration}
          selectedAuthType={itemForDisplay.selectedAuthType}
          userEmail={itemForDisplay.userEmail}
        />
      )}
      {itemForDisplay.type === 'model_stats' && (
        <ModelStatsDisplay
          selectedAuthType={itemForDisplay.selectedAuthType}
          userEmail={itemForDisplay.userEmail}
          currentModel={itemForDisplay.currentModel}
        />
      )}
      {itemForDisplay.type === 'tool_stats' && <ToolStatsDisplay />}
      {itemForDisplay.type === 'model' && (
        <ModelMessage model={itemForDisplay.model} />
      )}
      {itemForDisplay.type === 'quit' && (
        <SessionSummaryDisplay duration={itemForDisplay.duration} />
      )}
      {itemForDisplay.type === 'tool_group' && (
        <ToolGroupMessage
          item={itemForDisplay}
          toolCalls={itemForDisplay.tools}
          availableTerminalHeight={availableTerminalHeight}
          terminalWidth={terminalWidth}
          borderTop={itemForDisplay.borderTop}
          borderBottom={itemForDisplay.borderBottom}
          isExpandable={isExpandable}
          isToolGroupBoundary={isToolGroupBoundary}
        />
      )}
      {itemForDisplay.type === 'subagent' && (
        <SubagentHistoryMessage
          item={itemForDisplay}
          terminalWidth={terminalWidth}
        />
      )}
      {itemForDisplay.type === 'compression' && (
        <CompressionMessage compression={itemForDisplay.compression} />
      )}
      {itemForDisplay.type === 'model_queue' && (
        <ModelQueueMessage
          modelQueue={itemForDisplay.modelQueue}
          terminalWidth={terminalWidth}
        />
      )}
      {itemForDisplay.excludedFromContext && (
        <Box
          paddingLeft={INDENT.FEED_LEFT_OFFSET + INDENT.PREFIX_WIDTH_STANDARD}
        >
          <Text wrap="wrap" color={semanticTheme.text.secondary}>
            {REFUSED_MODEL_TEXT_EXCLUDED_NOTICE}
          </Text>
        </Box>
      )}
    </>
  );

  return (
    <HistoryItemFrame
      terminalWidth={terminalWidth}
      category={category}
      prevCategory={prevCategory}
    >
      {content}
    </HistoryItemFrame>
  );
};

export function HistoryItemFrame({
  terminalWidth,
  category,
  prevCategory,
  children,
}: Pick<
  HistoryItemDisplayProps,
  'terminalWidth' | 'category' | 'prevCategory'
> & { children: ReactNode }) {
  return (
    <HistoryItemErrorBoundary>
      <OffscreenFreeze layoutKey={terminalWidth}>
        <MessageSlot
          category={category}
          prevCategory={prevCategory}
          terminalWidth={terminalWidth}
        >
          {children}
        </MessageSlot>
      </OffscreenFreeze>
    </HistoryItemErrorBoundary>
  );
}

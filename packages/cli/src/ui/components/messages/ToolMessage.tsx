/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { IndividualToolCallDisplay } from '../../types.js';
import { ToolCallStatus } from '../../types.js';
import { DiffRenderer } from './DiffRenderer.js';
import { MarkdownDisplay } from '../../utils/MarkdownDisplay.js';
import { AnsiOutputText, ShellStatsBar } from '../AnsiOutput.js';
import type { ShellStatsBarProps } from '../AnsiOutput.js';
import { MaxSizedBox } from '../shared/MaxSizedBox.js';
import { TodoDisplay } from '../TodoDisplay.js';
import type {
  TodoResultDisplay,
  AgentResultDisplay,
  PlanResultDisplay,
  AnsiOutput,
  AnsiOutputDisplay,
  Config,
  McpToolProgressData,
} from '@qwen-code/qwen-code-core';
import { AgentExecutionDisplay } from '../subagents/index.js';
import { PlanSummaryDisplay } from '../PlanSummaryDisplay.js';
import { ShellInputPrompt } from '../ShellInputPrompt.js';
import { SHELL_COMMAND_NAME, SHELL_NAME } from '../../constants.js';
import { theme } from '../../semantic-colors.js';
import { useSettings } from '../../contexts/SettingsContext.js';
import type { LoadedSettings } from '../../../config/settings.js';
import { useCompactMode } from '../../contexts/CompactModeContext.js';

import {
  ToolStatusIndicator,
  STATUS_INDICATOR_WIDTH,
} from '../shared/ToolStatusIndicator.js';
import { ToolElapsedTime } from '../shared/ToolElapsedTime.js';

const STATIC_HEIGHT = 1;
const RESERVED_LINE_COUNT = 5; // for tool name, status, padding etc.
const MIN_LINES_SHOWN = 2; // show at least this many lines
const DEFAULT_SHELL_OUTPUT_MAX_LINES = 5;

// Large threshold to ensure we don't cause performance issues for very large
// outputs that will get truncated further MaxSizedBox anyway.
const MAXIMUM_RESULT_DISPLAY_CHARACTERS = 1000000;
export type TextEmphasis = 'high' | 'medium' | 'low';

type DisplayRendererResult =
  | { type: 'none' }
  | { type: 'todo'; data: TodoResultDisplay }
  | { type: 'plan'; data: PlanResultDisplay }
  | { type: 'string'; data: string }
  | { type: 'diff'; data: { fileDiff: string; fileName: string } }
  | { type: 'task'; data: AgentResultDisplay }
  | { type: 'ansi'; data: AnsiOutput; stats?: ShellStatsBarProps };

/**
 * Custom hook to determine the type of result display and return appropriate rendering info
 */
const useResultDisplayRenderer = (
  resultDisplay: unknown,
): DisplayRendererResult =>
  React.useMemo(() => {
    if (!resultDisplay) {
      return { type: 'none' };
    }

    // Check for TodoResultDisplay
    if (
      typeof resultDisplay === 'object' &&
      resultDisplay !== null &&
      'type' in resultDisplay &&
      resultDisplay.type === 'todo_list'
    ) {
      return {
        type: 'todo',
        data: resultDisplay as TodoResultDisplay,
      };
    }

    if (
      typeof resultDisplay === 'object' &&
      resultDisplay !== null &&
      'type' in resultDisplay &&
      resultDisplay.type === 'plan_summary'
    ) {
      return {
        type: 'plan',
        data: resultDisplay as PlanResultDisplay,
      };
    }

    // Check for SubagentExecutionResultDisplay (for non-task tools)
    if (
      typeof resultDisplay === 'object' &&
      resultDisplay !== null &&
      'type' in resultDisplay &&
      resultDisplay.type === 'task_execution'
    ) {
      return {
        type: 'task',
        data: resultDisplay as AgentResultDisplay,
      };
    }

    // Check for FileDiff
    if (
      typeof resultDisplay === 'object' &&
      resultDisplay !== null &&
      'fileDiff' in resultDisplay
    ) {
      return {
        type: 'diff',
        data: resultDisplay as { fileDiff: string; fileName: string },
      };
    }

    // Check for McpToolProgressData
    if (
      typeof resultDisplay === 'object' &&
      resultDisplay !== null &&
      'type' in resultDisplay &&
      resultDisplay.type === 'mcp_tool_progress'
    ) {
      const progress = resultDisplay as McpToolProgressData;
      const msg = progress.message ?? `Progress: ${progress.progress}`;
      const totalStr = progress.total != null ? `/${progress.total}` : '';
      return {
        type: 'string',
        data: `⏳ [${progress.progress}${totalStr}] ${msg}`,
      };
    }

    // Check for AnsiOutput
    if (
      typeof resultDisplay === 'object' &&
      resultDisplay !== null &&
      'ansiOutput' in resultDisplay
    ) {
      const display = resultDisplay as AnsiOutputDisplay;
      return {
        type: 'ansi',
        data: display.ansiOutput,
        stats: {
          totalLines: display.totalLines,
          totalBytes: display.totalBytes,
          timeoutMs: display.timeoutMs,
        },
      };
    }

    // Default to string
    return {
      type: 'string',
      data: resultDisplay as string,
    };
  }, [resultDisplay]);

/**
 * Component to render todo list results
 */
const TodoResultRenderer: React.FC<{ data: TodoResultDisplay }> = ({
  data,
}) => <TodoDisplay todos={data.todos} />;

const PlanResultRenderer: React.FC<{
  data: PlanResultDisplay;
  availableHeight?: number;
  childWidth: number;
}> = ({ data, availableHeight, childWidth }) => (
  <PlanSummaryDisplay
    data={data}
    availableHeight={availableHeight}
    childWidth={childWidth}
  />
);

/**
 * Component to render subagent execution results
 */
const SubagentExecutionRenderer: React.FC<{
  data: AgentResultDisplay;
  availableHeight?: number;
  childWidth: number;
  config: Config;
  isFocused?: boolean;
  isWaitingForOtherApproval?: boolean;
}> = ({
  data,
  availableHeight,
  childWidth,
  config,
  isFocused,
  isWaitingForOtherApproval,
}) => (
  <AgentExecutionDisplay
    data={data}
    availableHeight={availableHeight}
    childWidth={childWidth}
    config={config}
    isFocused={isFocused}
    isWaitingForOtherApproval={isWaitingForOtherApproval}
  />
);

/**
 * Component to render string results (markdown or plain text)
 */
const StringResultRenderer: React.FC<{
  data: string;
  renderAsMarkdown: boolean;
  availableHeight?: number;
  childWidth: number;
}> = ({ data, renderAsMarkdown, availableHeight, childWidth }) => {
  let displayData = data;

  // Truncate if too long
  if (displayData.length > MAXIMUM_RESULT_DISPLAY_CHARACTERS) {
    displayData = '...' + displayData.slice(-MAXIMUM_RESULT_DISPLAY_CHARACTERS);
  }

  if (renderAsMarkdown) {
    return (
      <Box flexDirection="column">
        <MarkdownDisplay
          text={displayData}
          isPending={false}
          availableTerminalHeight={availableHeight}
          contentWidth={childWidth}
        />
      </Box>
    );
  }

  return (
    <MaxSizedBox maxHeight={availableHeight} maxWidth={childWidth}>
      <Box>
        <Text wrap="wrap" color={theme.text.primary}>
          {displayData}
        </Text>
      </Box>
    </MaxSizedBox>
  );
};

/**
 * Component to render diff results
 */
const DiffResultRenderer: React.FC<{
  data: { fileDiff: string; fileName: string };
  availableHeight?: number;
  childWidth: number;
  settings?: LoadedSettings;
}> = ({ data, availableHeight, childWidth, settings }) => (
  <DiffRenderer
    diffContent={data.fileDiff}
    filename={data.fileName}
    availableTerminalHeight={availableHeight}
    contentWidth={childWidth}
    settings={settings}
  />
);

export interface ToolMessageProps extends IndividualToolCallDisplay {
  availableTerminalHeight?: number;
  contentWidth: number;
  emphasis?: TextEmphasis;
  renderOutputAsMarkdown?: boolean;
  activeShellPtyId?: number | null;
  embeddedShellFocused?: boolean;
  config?: Config;
  forceShowResult?: boolean;
  /** Whether this tool's subagent confirmation prompt should respond to keyboard input. */
  isFocused?: boolean;
  /** Whether another subagent's approval currently holds the focus lock, blocking this one. */
  isWaitingForOtherApproval?: boolean;
}

export const ToolMessage: React.FC<ToolMessageProps> = ({
  name,
  description,
  resultDisplay,
  status,
  availableTerminalHeight,
  contentWidth,
  emphasis = 'medium',
  renderOutputAsMarkdown = true,
  activeShellPtyId,
  embeddedShellFocused,
  ptyId,
  config,
  forceShowResult,
  isFocused,
  isWaitingForOtherApproval,
  executionStartTime,
}) => {
  const settings = useSettings();
  const isThisShellFocused =
    (name === SHELL_COMMAND_NAME || name === SHELL_NAME) &&
    status === ToolCallStatus.Executing &&
    ptyId === activeShellPtyId &&
    embeddedShellFocused;

  const [lastUpdateTime, setLastUpdateTime] = React.useState<Date | null>(null);
  const [userHasFocused, setUserHasFocused] = React.useState(false);
  const [showFocusHint, setShowFocusHint] = React.useState(false);

  React.useEffect(() => {
    if (resultDisplay) {
      setLastUpdateTime(new Date());
    }
  }, [resultDisplay]);

  React.useEffect(() => {
    if (!lastUpdateTime) {
      return;
    }

    const timer = setTimeout(() => {
      setShowFocusHint(true);
    }, 5000);

    return () => clearTimeout(timer);
  }, [lastUpdateTime]);

  React.useEffect(() => {
    if (isThisShellFocused) {
      setUserHasFocused(true);
    }
  }, [isThisShellFocused]);

  const isThisShellFocusable =
    (name === SHELL_COMMAND_NAME || name === SHELL_NAME) &&
    status === ToolCallStatus.Executing &&
    config?.getShouldUseNodePtyShell();

  const shouldShowFocusHint =
    isThisShellFocusable && (showFocusHint || userHasFocused);

  const availableHeight = availableTerminalHeight
    ? Math.max(
        availableTerminalHeight - STATIC_HEIGHT - RESERVED_LINE_COUNT,
        MIN_LINES_SHOWN + 1, // enforce minimum lines shown
      )
    : undefined;
  // Cap inline shell output; ShellStatsBar surfaces hidden lines via `+N lines`.
  const shellOutputMaxLines =
    settings.merged.ui?.shellOutputMaxLines ?? DEFAULT_SHELL_OUTPUT_MAX_LINES;
  const ansiAvailableHeight =
    shellOutputMaxLines > 0 && !forceShowResult && !isThisShellFocused
      ? Math.min(availableHeight ?? shellOutputMaxLines, shellOutputMaxLines)
      : availableHeight;
  const innerWidth = contentWidth - STATUS_INDICATOR_WIDTH;

  // Long tool call response in MarkdownDisplay doesn't respect availableTerminalHeight properly,
  // we're forcing it to not render as markdown when the response is too long, it will fallback
  // to render as plain text, which is contained within the terminal using MaxSizedBox
  if (availableHeight) {
    renderOutputAsMarkdown = false;
  }

  // Use the custom hook to determine the display type
  const displayRenderer = useResultDisplayRenderer(resultDisplay);
  const { compactMode } = useCompactMode();
  const effectiveDisplayRenderer =
    !compactMode || forceShowResult
      ? displayRenderer
      : { type: 'none' as const };

  return (
    <Box paddingX={1} paddingY={0} flexDirection="column">
      <Box minHeight={1}>
        <ToolStatusIndicator status={status} name={name} />
        <ToolInfo
          name={name}
          status={status}
          description={description}
          emphasis={emphasis}
        />
        {shouldShowFocusHint && (
          <Box marginLeft={1} flexShrink={0}>
            <Text color={theme.text.accent}>
              {isThisShellFocused ? '(Focused)' : '(ctrl+f to focus)'}
            </Text>
          </Box>
        )}
        <ToolElapsedTime
          status={status}
          executionStartTime={executionStartTime}
        />
        {emphasis === 'high' && <TrailingIndicator />}
      </Box>
      {effectiveDisplayRenderer.type !== 'none' && (
        <Box paddingLeft={STATUS_INDICATOR_WIDTH} width="100%" marginTop={1}>
          <Box flexDirection="column">
            {effectiveDisplayRenderer.type === 'todo' && (
              <TodoResultRenderer data={effectiveDisplayRenderer.data} />
            )}
            {effectiveDisplayRenderer.type === 'plan' && (
              <PlanResultRenderer
                data={effectiveDisplayRenderer.data}
                availableHeight={availableHeight}
                childWidth={innerWidth}
              />
            )}
            {effectiveDisplayRenderer.type === 'task' && config && (
              <SubagentExecutionRenderer
                data={effectiveDisplayRenderer.data}
                availableHeight={availableHeight}
                childWidth={innerWidth}
                config={config}
                isFocused={isFocused}
                isWaitingForOtherApproval={isWaitingForOtherApproval}
              />
            )}
            {effectiveDisplayRenderer.type === 'diff' && (
              <DiffResultRenderer
                data={effectiveDisplayRenderer.data}
                availableHeight={availableHeight}
                childWidth={innerWidth}
                settings={settings}
              />
            )}
            {effectiveDisplayRenderer.type === 'ansi' && (
              <>
                <AnsiOutputText
                  data={effectiveDisplayRenderer.data}
                  availableTerminalHeight={ansiAvailableHeight}
                  maxWidth={innerWidth}
                />
                {effectiveDisplayRenderer.stats && (
                  <ShellStatsBar
                    {...effectiveDisplayRenderer.stats}
                    displayHeight={ansiAvailableHeight}
                  />
                )}
              </>
            )}
            {effectiveDisplayRenderer.type === 'string' && (
              <StringResultRenderer
                data={effectiveDisplayRenderer.data}
                renderAsMarkdown={renderOutputAsMarkdown}
                availableHeight={availableHeight}
                childWidth={innerWidth}
              />
            )}
          </Box>
        </Box>
      )}
      {isThisShellFocused && config && (
        <Box paddingLeft={STATUS_INDICATOR_WIDTH} marginTop={1}>
          <ShellInputPrompt
            activeShellPtyId={activeShellPtyId ?? null}
            focus={embeddedShellFocused}
          />
        </Box>
      )}
    </Box>
  );
};

type ToolInfo = {
  name: string;
  description: string;
  status: ToolCallStatus;
  emphasis: TextEmphasis;
};
const ToolInfo: React.FC<ToolInfo> = ({
  name,
  description,
  status,
  emphasis,
}) => {
  const nameColor = React.useMemo<string>(() => {
    switch (emphasis) {
      case 'high':
        return theme.text.primary;
      case 'medium':
        return theme.text.primary;
      case 'low':
        return theme.text.secondary;
      default: {
        const exhaustiveCheck: never = emphasis;
        return exhaustiveCheck;
      }
    }
  }, [emphasis]);
  return (
    <Box flexGrow={1}>
      <Text
        wrap="truncate-end"
        strikethrough={status === ToolCallStatus.Canceled}
      >
        <Text color={nameColor} bold>
          {name}
        </Text>{' '}
        <Text color={theme.text.secondary}>{description}</Text>
      </Text>
    </Box>
  );
};

const TrailingIndicator: React.FC = () => (
  <Text color={theme.text.primary} wrap="truncate">
    {' '}
    ←
  </Text>
);

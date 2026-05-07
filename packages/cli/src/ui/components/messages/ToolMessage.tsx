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
import { MaxSizedBox, MINIMUM_MAX_HEIGHT } from '../shared/MaxSizedBox.js';
import { TodoDisplay } from '../TodoDisplay.js';
import type {
  TodoResultDisplay,
  AgentResultDisplay,
  PlanResultDisplay,
  AnsiOutput,
  AnsiOutputDisplay,
  Config,
  McpToolProgressData,
  FileDiff,
} from '@qwen-code/qwen-code-core';
import { ToolConfirmationMessage } from './ToolConfirmationMessage.js';
import { PlanSummaryDisplay } from '../PlanSummaryDisplay.js';
import { ShellInputPrompt } from '../ShellInputPrompt.js';
import { SHELL_COMMAND_NAME, SHELL_NAME } from '../../constants.js';
import { formatDuration, formatTokenCount } from '../../utils/formatters.js';
import { theme } from '../../semantic-colors.js';
import { useSettings } from '../../contexts/SettingsContext.js';
import type { LoadedSettings } from '../../../config/settings.js';
import { useCompactMode } from '../../contexts/CompactModeContext.js';
import { getCachedStringWidth, toCodePoints } from '../../utils/textUtils.js';

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
type DiffResultDisplay = Pick<
  FileDiff,
  | 'fileDiff'
  | 'fileName'
  | 'truncatedForSession'
  | 'fileDiffLength'
  | 'fileDiffTruncated'
>;

function sliceTextForMaxHeight(
  text: string,
  maxHeight: number | undefined,
  maxWidth: number,
): { text: string; hiddenLinesCount: number } {
  if (maxHeight === undefined) {
    return { text, hiddenLinesCount: 0 };
  }

  const targetMaxHeight = Math.max(Math.round(maxHeight), MINIMUM_MAX_HEIGHT);
  const visibleContentHeight = targetMaxHeight - 1;
  const visualWidth = Math.max(1, Math.floor(maxWidth));
  const visibleLines: string[] = [];
  let visualLineCount = 0;
  let currentLine = '';
  let currentLineWidth = 0;

  const appendVisibleLine = (line: string) => {
    visualLineCount += 1;
    visibleLines.push(line);
    if (visibleLines.length > visibleContentHeight) {
      visibleLines.shift();
    }
  };

  const flushCurrentLine = () => {
    appendVisibleLine(currentLine);
    currentLine = '';
    currentLineWidth = 0;
  };

  for (const char of toCodePoints(text)) {
    if (char === '\n') {
      flushCurrentLine();
      continue;
    }

    const charWidth = Math.max(getCachedStringWidth(char), 1);
    if (currentLineWidth > 0 && currentLineWidth + charWidth > visualWidth) {
      flushCurrentLine();
    }

    currentLine += char;
    currentLineWidth += charWidth;
  }

  flushCurrentLine();

  if (visualLineCount <= targetMaxHeight) {
    return { text, hiddenLinesCount: 0 };
  }

  const hiddenLinesCount = visualLineCount - visibleContentHeight;
  return {
    text: visibleLines.join('\n'),
    hiddenLinesCount,
  };
}

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
        data: resultDisplay as DiffResultDisplay,
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
 * Component to render subagent execution results.
 *
 * The verbose inline frame has been retired. Three surfaces remain:
 *
 * - **Live phase (running)**: nothing inline — `LiveAgentPanel` (the
 *   always-on bottom roster) and `BackgroundTasksDialog` (Down-arrow
 *   detail view) own progress reporting.
 * - **Approval prompt (focus-locked)**: full inline approval banner so
 *   the user can answer without context-switching into the dialog;
 *   sibling subagents render a queued marker.
 * - **Committed phase (terminal — completed / failed / cancelled)**: a
 *   single-line scrollback summary so the conversation history retains
 *   a permanent record after the panel's 8s window expires and the
 *   dialog closes. Format: `<icon> <type>: <description> · N tools · Xs · Yk tokens`.
 */
const SubagentExecutionRenderer: React.FC<{
  data: AgentResultDisplay;
  availableHeight?: number;
  childWidth: number;
  config: Config;
  isFocused?: boolean;
}> = ({ data, availableHeight, childWidth, config, isFocused }) => {
  if (data.pendingConfirmation && isFocused) {
    const agentLabel = data.subagentName || 'agent';
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Box>
          <Text color={theme.text.secondary}>Approval requested by </Text>
          <Text bold color={theme.text.accent}>
            {agentLabel}
          </Text>
          <Text color={theme.text.secondary}>:</Text>
        </Box>
        <ToolConfirmationMessage
          confirmationDetails={data.pendingConfirmation}
          isFocused={isFocused}
          availableTerminalHeight={availableHeight}
          contentWidth={childWidth - 2}
          compactMode={true}
          config={config}
        />
      </Box>
    );
  }
  if (data.pendingConfirmation) {
    const agentLabel = data.subagentName || 'agent';
    return (
      <Box paddingLeft={1}>
        <Text color={theme.text.secondary} dimColor>
          ⏳ Queued approval:{' '}
        </Text>
        <Text dimColor>{agentLabel}</Text>
      </Box>
    );
  }
  // Terminal phase: render a single-line scrollback summary so the
  // conversation history keeps a permanent record after the panel's
  // 8s visibility window expires (LiveAgentPanel evicts terminal rows;
  // BackgroundTasksDialog only retains them while open). Skip
  // `running` / `background` since the panel + dialog cover those.
  if (
    data.status === 'completed' ||
    data.status === 'failed' ||
    data.status === 'cancelled'
  ) {
    return <SubagentScrollbackSummary data={data} />;
  }
  return null;
};

/**
 * One-line summary that lands in scrollback when a subagent reaches a
 * terminal state. The verbose 15-row frame is retired (it caused
 * scrollback flicker); this single line preserves the persistent
 * record without re-introducing the flicker.
 *
 *   ✔ researcher: investigate import order · 5 tools · 12s · 2.4k tokens
 */
const SubagentScrollbackSummary: React.FC<{
  data: AgentResultDisplay;
}> = ({ data }) => {
  const { glyph, color } = (() => {
    switch (data.status) {
      case 'completed':
        return { glyph: '✔', color: theme.status.success };
      case 'failed':
        return { glyph: '✖', color: theme.status.error };
      case 'cancelled':
        return { glyph: '✖', color: theme.status.warning };
      default:
        return { glyph: '·', color: theme.text.secondary };
    }
  })();
  const stats = data.executionSummary;
  const parts: string[] = [];
  if (stats?.totalToolCalls !== undefined) {
    parts.push(
      `${stats.totalToolCalls} tool${stats.totalToolCalls === 1 ? '' : 's'}`,
    );
  }
  if (stats?.totalDurationMs !== undefined) {
    parts.push(
      formatDuration(stats.totalDurationMs, { hideTrailingZeros: true }),
    );
  }
  if (stats?.totalTokens && stats.totalTokens > 0) {
    parts.push(`${formatTokenCount(stats.totalTokens)} tokens`);
  }
  const tail = parts.length > 0 ? ` · ${parts.join(' · ')}` : '';
  const typePrefix = data.subagentName ? `${data.subagentName}: ` : '';
  const reason =
    data.status !== 'completed' && data.terminateReason
      ? ` · ${data.terminateReason}`
      : '';
  return (
    <Box paddingLeft={1}>
      <Text wrap="truncate-end">
        <Text color={color}>{`${glyph} `}</Text>
        <Text bold>{typePrefix}</Text>
        <Text color={theme.text.secondary}>{data.taskDescription}</Text>
        <Text color={theme.text.secondary}>{tail}</Text>
        <Text color={theme.text.secondary}>{reason}</Text>
      </Text>
    </Box>
  );
};

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

  const sliced = sliceTextForMaxHeight(
    displayData,
    availableHeight,
    childWidth,
  );

  return (
    <MaxSizedBox
      maxHeight={availableHeight}
      maxWidth={childWidth}
      additionalHiddenLinesCount={sliced.hiddenLinesCount}
    >
      <Box>
        <Text wrap="wrap" color={theme.text.primary}>
          {sliced.text}
        </Text>
      </Box>
    </MaxSizedBox>
  );
};

/**
 * Component to render diff results
 */
const DiffResultRenderer: React.FC<{
  data: DiffResultDisplay;
  availableHeight?: number;
  childWidth: number;
  settings?: LoadedSettings;
}> = ({ data, availableHeight, childWidth, settings }) => {
  const diffHeight =
    data.truncatedForSession && availableHeight !== undefined
      ? Math.max(1, availableHeight - 1)
      : availableHeight;

  return (
    <Box flexDirection="column">
      {data.truncatedForSession && (
        <Text color={theme.status.warning} wrap="wrap">
          {data.fileDiffTruncated
            ? 'Saved session preview only; full diff omitted from JSONL'
            : 'Saved session preview only; full file contents truncated in JSONL'}
          {data.fileDiffTruncated && typeof data.fileDiffLength === 'number'
            ? ` (${data.fileDiffLength} chars).`
            : '.'}
        </Text>
      )}
      <DiffRenderer
        diffContent={data.fileDiff}
        filename={data.fileName}
        availableTerminalHeight={diffHeight}
        contentWidth={childWidth}
        settings={settings}
      />
    </Box>
  );
};

export interface ToolMessageProps extends IndividualToolCallDisplay {
  availableTerminalHeight?: number;
  contentWidth: number;
  emphasis?: TextEmphasis;
  renderOutputAsMarkdown?: boolean;
  activeShellPtyId?: number | null;
  embeddedShellFocused?: boolean;
  config?: Config;
  forceShowResult?: boolean;
  /**
   * Whether this subagent owns keyboard input for the inline approval
   * surface — when true the focus-holder banner renders and the
   * underlying ToolConfirmationMessage receives keystrokes; when false
   * sibling subagents render a dim "Queued approval" marker instead.
   */
  isFocused?: boolean;
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

  // Shell tools surface their configured timeout via AnsiOutputDisplay as
  // soon as streaming starts. Feed it into ToolElapsedTime so the budget is
  // shown inline (`(elapsed · timeout N)`) instead of in a separate stats
  // row.
  const shellTimeoutMs = React.useMemo(() => {
    if (
      typeof resultDisplay === 'object' &&
      resultDisplay !== null &&
      'ansiOutput' in resultDisplay
    ) {
      return (resultDisplay as AnsiOutputDisplay).timeoutMs;
    }
    return undefined;
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
  // Cap inline shell output. Applies to both the streaming ANSI display and
  // the completed string display (shell.ts emits the final result as a plain
  // string via `returnDisplayMessage = result.output`). ShellStatsBar surfaces
  // hidden lines via `+N lines` for ANSI; MaxSizedBox handles overflow for string.
  const isShellTool = name === SHELL_COMMAND_NAME || name === SHELL_NAME;
  const rawShellCap =
    settings.merged.ui?.shellOutputMaxLines ?? DEFAULT_SHELL_OUTPUT_MAX_LINES;
  // Defensive: clamp non-negative integers; treat negatives / NaN / fractions
  // as the user's clear intent (0 = disable, otherwise floor to whole rows).
  const shellOutputMaxLines = Math.max(0, Math.floor(rawShellCap || 0));
  const isCappingShell =
    isShellTool &&
    shellOutputMaxLines > 0 &&
    !forceShowResult &&
    !isThisShellFocused;
  const shellCapHeight = isCappingShell
    ? Math.min(availableHeight ?? shellOutputMaxLines, shellOutputMaxLines)
    : availableHeight;
  // String path: MaxSizedBox reserves one row for its overflow banner when
  // content overflows (see MaxSizedBox.tsx visibleContentHeight = max - 1),
  // so passing the bare cap shows N-1 content rows. ANSI pre-slices to N
  // (no MaxSizedBox overflow) and renders N rows + the ShellStatsBar line.
  // +1 keeps the two paths visually symmetric at N visible content rows.
  const shellStringCapHeight =
    isCappingShell && shellCapHeight !== undefined
      ? shellCapHeight + 1
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
          timeoutMs={shellTimeoutMs}
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
                  availableTerminalHeight={shellCapHeight}
                  maxWidth={innerWidth}
                />
                {effectiveDisplayRenderer.stats && (
                  <ShellStatsBar
                    {...effectiveDisplayRenderer.stats}
                    displayHeight={shellCapHeight}
                  />
                )}
              </>
            )}
            {effectiveDisplayRenderer.type === 'string' && (
              <StringResultRenderer
                data={effectiveDisplayRenderer.data}
                renderAsMarkdown={renderOutputAsMarkdown}
                availableHeight={shellStringCapHeight}
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

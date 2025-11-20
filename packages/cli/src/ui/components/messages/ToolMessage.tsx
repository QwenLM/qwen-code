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
import { AnsiOutputText } from '../AnsiOutput.js';
import { GeminiRespondingSpinner } from '../GeminiRespondingSpinner.js';
import { MaxSizedBox } from '../shared/MaxSizedBox.js';
import { TodoDisplay } from '../TodoDisplay.js';
import type {
  TodoResultDisplay,
  TaskResultDisplay,
  PlanResultDisplay,
  AnsiOutput,
  Config,
} from '@qwen-code/qwen-code-core';
import { AgentExecutionDisplay } from '../subagents/index.js';
import { PlanSummaryDisplay } from '../PlanSummaryDisplay.js';
import { ShellInputPrompt } from '../ShellInputPrompt.js';
import {
  SHELL_COMMAND_NAME,
  SHELL_NAME,
  TOOL_STATUS,
} from '../../constants.js';
import { theme } from '../../semantic-colors.js';

const STATIC_HEIGHT = 1;
const RESERVED_LINE_COUNT = 5; // for tool name, status, padding etc.
const STATUS_INDICATOR_WIDTH = 3;
const MIN_LINES_SHOWN = 2; // show at least this many lines

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
  | { type: 'task'; data: TaskResultDisplay }
  | { type: 'ansi'; data: AnsiOutput };

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
        data: resultDisplay as TaskResultDisplay,
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

    // Check for AnsiOutput
    if (
      typeof resultDisplay === 'object' &&
      resultDisplay !== null &&
      'ansiOutput' in resultDisplay
    ) {
      return { type: 'ansi', data: resultDisplay.ansiOutput as AnsiOutput };
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
  data: TaskResultDisplay;
  availableHeight?: number;
  childWidth: number;
  config: Config;
}> = ({ data, availableHeight, childWidth, config }) => (
  <AgentExecutionDisplay
    data={data}
    availableHeight={availableHeight}
    childWidth={childWidth}
    config={config}
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
          terminalWidth={childWidth}
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
}> = ({ data, availableHeight, childWidth }) => (
  <DiffRenderer
    diffContent={data.fileDiff}
    filename={data.fileName}
    availableTerminalHeight={availableHeight}
    terminalWidth={childWidth}
  />
);

export interface ToolMessageProps extends IndividualToolCallDisplay {
  availableTerminalHeight?: number;
  terminalWidth: number;
  emphasis?: TextEmphasis;
  renderOutputAsMarkdown?: boolean;
  activeShellPtyId?: number | null;
  embeddedShellFocused?: boolean;
  config?: Config;
}

export const ToolMessage: React.FC<ToolMessageProps> = ({
  name,
  description,
  resultDisplay,
  status,
  availableTerminalHeight,
  terminalWidth,
  emphasis = 'medium',
  renderOutputAsMarkdown = true,
  activeShellPtyId,
  embeddedShellFocused,
  ptyId,
  config,
}) => {
  const isThisShellFocused =
    (name === SHELL_COMMAND_NAME || name === 'Shell') &&
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
    (name === SHELL_COMMAND_NAME || name === 'Shell') &&
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

  // Long tool call response in MarkdownDisplay doesn't respect availableTerminalHeight properly,
  // we're forcing it to not render as markdown when the response is too long, it will fallback
  // to render as plain text, which is contained within the terminal using MaxSizedBox
  if (availableHeight) {
    renderOutputAsMarkdown = false;
  }

  const childWidth = terminalWidth - 3; // account for padding.

  // Use the custom hook to determine the display type
  const displayRenderer = useResultDisplayRenderer(resultDisplay);

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
        {emphasis === 'high' && <TrailingIndicator />}
      </Box>
      {displayRenderer.type !== 'none' && (
        <Box paddingLeft={STATUS_INDICATOR_WIDTH} width="100%" marginTop={1}>
          <Box flexDirection="column">
            {displayRenderer.type === 'todo' && (
              <TodoResultRenderer data={displayRenderer.data} />
            )}
            {displayRenderer.type === 'plan' && (
              <PlanResultRenderer
                data={displayRenderer.data}
                availableHeight={availableHeight}
                childWidth={childWidth}
              />
            )}
            {displayRenderer.type === 'task' && config && (
              <SubagentExecutionRenderer
                data={displayRenderer.data}
                availableHeight={availableHeight}
                childWidth={childWidth}
                config={config}
              />
            )}
            {displayRenderer.type === 'diff' && (
              <DiffResultRenderer
                data={displayRenderer.data}
                availableHeight={availableHeight}
                childWidth={childWidth}
              />
            )}
            {displayRenderer.type === 'ansi' && (
              <AnsiOutputText
                data={displayRenderer.data}
                availableTerminalHeight={availableHeight}
              />
            )}
            {displayRenderer.type === 'string' && (
              <StringResultRenderer
                data={displayRenderer.data}
                renderAsMarkdown={renderOutputAsMarkdown}
                availableHeight={availableHeight}
                childWidth={childWidth}
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

type ToolStatusIndicatorProps = {
  status: ToolCallStatus;
  name: string;
};

const ToolStatusIndicator: React.FC<ToolStatusIndicatorProps> = ({
  status,
  name,
}) => {
  const isShell = name === SHELL_COMMAND_NAME || name === SHELL_NAME;
  const statusColor = isShell ? theme.ui.symbol : theme.status.warning;

  return (
    <Box minWidth={STATUS_INDICATOR_WIDTH}>
      {status === ToolCallStatus.Pending && (
        <Text color={theme.status.success}>{TOOL_STATUS.PENDING}</Text>
      )}
      {status === ToolCallStatus.Executing && (
        <GeminiRespondingSpinner
          spinnerType="toggle"
          nonRespondingDisplay={TOOL_STATUS.EXECUTING}
        />
      )}
      {status === ToolCallStatus.Success && (
        <Text color={theme.status.success} aria-label={'Success:'}>
          {TOOL_STATUS.SUCCESS}
        </Text>
      )}
      {status === ToolCallStatus.Confirming && (
        <Text color={statusColor} aria-label={'Confirming:'}>
          {TOOL_STATUS.CONFIRMING}
        </Text>
      )}
      {status === ToolCallStatus.Canceled && (
        <Text color={statusColor} aria-label={'Canceled:'} bold>
          {TOOL_STATUS.CANCELED}
        </Text>
      )}
      {status === ToolCallStatus.Error && (
        <Text color={theme.status.error} aria-label={'Error:'} bold>
          {TOOL_STATUS.ERROR}
        </Text>
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
    <Box>
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

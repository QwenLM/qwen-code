/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box, Text } from 'ink';
import { IndividualToolCallDisplay, ToolCallStatus } from '../../types.js';
import { DiffRenderer } from './DiffRenderer.js';
import { Colors } from '../../colors.js';
import { MarkdownDisplay } from '../../utils/MarkdownDisplay.js';
import { GeminiRespondingSpinner } from '../GeminiRespondingSpinner.js';
import { MaxSizedBox } from '../shared/MaxSizedBox.js';
import { TodoDisplay } from '../TodoDisplay.js';
import { TodoResultDisplay } from '@qwen-code/qwen-code-core';

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
  | { type: 'string'; data: string }
  | { type: 'diff'; data: { fileDiff: string; fileName: string } };

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
        <Text wrap="wrap">{displayData}</Text>
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
}) => {
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
        <ToolStatusIndicator status={status} />
        <ToolInfo
          name={name}
          status={status}
          description={description}
          emphasis={emphasis}
        />
        {emphasis === 'high' && <TrailingIndicator />}
      </Box>
      {displayRenderer.type !== 'none' && (
        <Box paddingLeft={STATUS_INDICATOR_WIDTH} width="100%" marginTop={1}>
          <Box flexDirection="column">
            {displayRenderer.type === 'todo' && (
              <TodoResultRenderer data={displayRenderer.data} />
            )}
            {displayRenderer.type === 'string' && (
              <StringResultRenderer
                data={displayRenderer.data}
                renderAsMarkdown={renderOutputAsMarkdown}
                availableHeight={availableHeight}
                childWidth={childWidth}
              />
            )}
            {displayRenderer.type === 'diff' && (
              <DiffResultRenderer
                data={displayRenderer.data}
                availableHeight={availableHeight}
                childWidth={childWidth}
              />
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
};

type ToolStatusIndicatorProps = {
  status: ToolCallStatus;
};

const ToolStatusIndicator: React.FC<ToolStatusIndicatorProps> = ({
  status,
}) => (
  <Box minWidth={STATUS_INDICATOR_WIDTH}>
    {status === ToolCallStatus.Pending && (
      <Text color={Colors.AccentGreen}>o</Text>
    )}
    {status === ToolCallStatus.Executing && (
      <GeminiRespondingSpinner
        spinnerType="toggle"
        nonRespondingDisplay={'⊷'}
      />
    )}
    {status === ToolCallStatus.Success && (
      <Text color={Colors.AccentGreen}>✔</Text>
    )}
    {status === ToolCallStatus.Confirming && (
      <Text color={Colors.AccentYellow}>?</Text>
    )}
    {status === ToolCallStatus.Canceled && (
      <Text color={Colors.AccentYellow} bold>
        -
      </Text>
    )}
    {status === ToolCallStatus.Error && (
      <Text color={Colors.AccentRed} bold>
        x
      </Text>
    )}
  </Box>
);

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
        return Colors.Foreground;
      case 'medium':
        return Colors.Foreground;
      case 'low':
        return Colors.Gray;
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
        <Text color={Colors.Gray}>{description}</Text>
      </Text>
    </Box>
  );
};

const TrailingIndicator: React.FC = () => (
  <Text color={Colors.Foreground} wrap="truncate">
    {' '}
    ←
  </Text>
);

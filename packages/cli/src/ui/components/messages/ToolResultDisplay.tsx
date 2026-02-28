/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box, Text } from 'ink';
import { DiffRenderer } from './DiffRenderer.js';
import { MarkdownDisplay } from '../../utils/MarkdownDisplay.js';
import { AnsiOutputText } from '../AnsiOutput.js';
import { MaxSizedBox } from '../shared/MaxSizedBox.js';
import { theme } from '../../semantic-colors.js';
import type {
  TodoResultDisplay,
  TaskResultDisplay,
  PlanResultDisplay,
  AnsiOutput,
  Config,
  McpToolProgressData,
} from '@qwen-code/qwen-code-core';
import { AgentExecutionDisplay } from '../subagents/index.js';
import { PlanSummaryDisplay } from '../PlanSummaryDisplay.js';
import { TodoDisplay } from '../TodoDisplay.js';
import { tryParseJSON } from '../../utils/jsonoutput.js';

const MAXIMUM_RESULT_DISPLAY_CHARACTERS = 1000000;

type DisplayRendererResult =
  | { type: 'none' }
  | { type: 'todo'; data: TodoResultDisplay }
  | { type: 'plan'; data: PlanResultDisplay }
  | { type: 'string'; data: string }
  | { type: 'diff'; data: { fileDiff: string; fileName: string } }
  | { type: 'task'; data: TaskResultDisplay }
  | { type: 'ansi'; data: AnsiOutput };

const useResultDisplayRenderer = (
  resultDisplay: unknown,
): DisplayRendererResult =>
  React.useMemo(() => {
    if (!resultDisplay) {
      return { type: 'none' };
    }

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
        data: `[${progress.progress}${totalStr}] ${msg}`,
      };
    }

    if (
      typeof resultDisplay === 'object' &&
      resultDisplay !== null &&
      'ansiOutput' in resultDisplay
    ) {
      return { type: 'ansi', data: resultDisplay.ansiOutput as AnsiOutput };
    }

    return {
      type: 'string',
      data: resultDisplay as string,
    };
  }, [resultDisplay]);

interface TodoResultRendererProps {
  data: TodoResultDisplay;
}

const TodoResultRenderer: React.FC<TodoResultRendererProps> = ({ data }) => (
  <TodoDisplay todos={data.todos} />
);

interface PlanResultRendererProps {
  data: PlanResultDisplay;
  availableHeight?: number;
  childWidth: number;
}

const PlanResultRenderer: React.FC<PlanResultRendererProps> = ({
  data,
  availableHeight,
  childWidth,
}) => (
  <PlanSummaryDisplay
    data={data}
    availableHeight={availableHeight}
    childWidth={childWidth}
  />
);

interface SubagentExecutionRendererProps {
  data: TaskResultDisplay;
  availableHeight?: number;
  childWidth: number;
  config: Config;
}

const SubagentExecutionRenderer: React.FC<SubagentExecutionRendererProps> = ({
  data,
  availableHeight,
  childWidth,
  config,
}) => (
  <AgentExecutionDisplay
    data={data}
    availableHeight={availableHeight}
    childWidth={childWidth}
    config={config}
  />
);

interface StringResultRendererProps {
  data: string;
  renderAsMarkdown: boolean;
  availableHeight?: number;
  childWidth: number;
}

const StringResultRenderer: React.FC<StringResultRendererProps> = ({
  data,
  renderAsMarkdown,
  availableHeight,
  childWidth,
}) => {
  let displayData = data;

  if (displayData.length > MAXIMUM_RESULT_DISPLAY_CHARACTERS) {
    displayData = '...' + displayData.slice(-MAXIMUM_RESULT_DISPLAY_CHARACTERS);
  }

  const prettyJSON = tryParseJSON(displayData);
  const formattedJSON = prettyJSON ? JSON.stringify(prettyJSON, null, 2) : null;

  if (formattedJSON) {
    return (
      <MaxSizedBox maxHeight={availableHeight} maxWidth={childWidth}>
        <Box>
          <Text wrap="wrap" color={theme.text.primary}>
            {formattedJSON}
          </Text>
        </Box>
      </MaxSizedBox>
    );
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

interface DiffResultRendererProps {
  data: { fileDiff: string; fileName: string };
  availableHeight?: number;
  childWidth: number;
}

const DiffResultRenderer: React.FC<DiffResultRendererProps> = ({
  data,
  availableHeight,
  childWidth,
}) => (
  <DiffRenderer
    diffContent={data.fileDiff}
    filename={data.fileName}
    availableTerminalHeight={availableHeight}
    contentWidth={childWidth}
  />
);

export interface ToolResultDisplayProps {
  resultDisplay: unknown;
  availableTerminalHeight?: number;
  terminalWidth: number;
  renderOutputAsMarkdown?: boolean;
  hasFocus?: boolean;
  config?: Config;
}

const STATIC_HEIGHT = 1;
const RESERVED_LINE_COUNT = 5;
const MIN_LINES_SHOWN = 2;

export const ToolResultDisplay: React.FC<ToolResultDisplayProps> = ({
  resultDisplay,
  availableTerminalHeight,
  terminalWidth,
  renderOutputAsMarkdown = true,
  hasFocus: _hasFocus = false,
  config,
}) => {
  const displayRenderer = useResultDisplayRenderer(resultDisplay);

  const availableHeight = availableTerminalHeight
    ? Math.max(
        availableTerminalHeight - STATIC_HEIGHT - RESERVED_LINE_COUNT,
        MIN_LINES_SHOWN + 1,
      )
    : undefined;

  const combinedPaddingAndBorderWidth = 4;
  const childWidth = terminalWidth - combinedPaddingAndBorderWidth;

  if (displayRenderer.type === 'none') {
    return null;
  }

  if (displayRenderer.type === 'todo') {
    return <TodoResultRenderer data={displayRenderer.data} />;
  }

  if (displayRenderer.type === 'plan') {
    return (
      <PlanResultRenderer
        data={displayRenderer.data}
        availableHeight={availableHeight}
        childWidth={childWidth}
      />
    );
  }

  if (displayRenderer.type === 'task') {
    if (config) {
      return (
        <SubagentExecutionRenderer
          data={displayRenderer.data}
          availableHeight={availableHeight}
          childWidth={childWidth}
          config={config}
        />
      );
    }
    return null;
  }

  if (displayRenderer.type === 'diff') {
    return (
      <DiffResultRenderer
        data={displayRenderer.data}
        availableHeight={availableHeight}
        childWidth={childWidth}
      />
    );
  }

  if (displayRenderer.type === 'ansi') {
    return (
      <AnsiOutputText
        data={displayRenderer.data}
        availableTerminalHeight={availableHeight}
      />
    );
  }

  return (
    <StringResultRenderer
      data={displayRenderer.data}
      renderAsMarkdown={renderOutputAsMarkdown}
      availableHeight={availableHeight}
      childWidth={childWidth}
    />
  );
};

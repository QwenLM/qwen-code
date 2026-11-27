/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { DiffRenderer } from './DiffRenderer.js';
import { MarkdownDisplay } from '../../utils/MarkdownDisplay.js';
import { SlicingMaxSizedBox } from '../shared/SlicingMaxSizedBox.js';
import { theme } from '../../semantic-colors.js';
import {
  type GlobResult,
  type GrepResult,
  isGlobResult,
  isGrepResult,
  isSubagentProgress,
  isStructuredToolResult,
  isCronResult,
  isCodeModeDisplay,
} from '@qwen-code/core';
import { useUIState } from '../../contexts/UIStateContext.js';
import { tryParseJSON } from '../../../utils/jsonoutput.js';
import { useAlternateBuffer } from '../../hooks/useAlternateBuffer.js';
import { Scrollable } from '../shared/Scrollable.js';
import { calculateToolContentMaxLines } from '../../utils/toolLayoutUtils.js';
import { SubagentProgressDisplay } from './SubagentProgressDisplay.js';
import { CronResultDisplay } from './CronResultDisplay.js';
import { CodeModeDisplayView } from './CodeModeDisplay.js';
import { isTodoList } from '../../types.js';

export interface ToolResultDisplayProps {
  resultDisplay: string | object | undefined;
  availableTerminalHeight?: number;
  terminalWidth: number;
  renderOutputAsMarkdown?: boolean;
  maxLines?: number;
  hasFocus?: boolean;
  overflowDirection?: 'top' | 'bottom';
}

interface FileDiffResult {
  fileDiff: string;
  fileName: string;
  isNewFile?: boolean;
}

function formatTodoSummary(todos: unknown[]): string {
  const count = todos.length;
  if (count === 0) return 'Todo list cleared';
  return `Updated ${count} ${pluralize(count, 'todo', 'todos')}`;
}

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

function formatLimitSuffix(result: {
  appliedLimit?: number;
  appliedOffset?: number;
}): string {
  const parts: string[] = [];
  if (result.appliedLimit !== undefined) {
    parts.push(`limit: ${result.appliedLimit}`);
  }
  if (result.appliedOffset !== undefined && result.appliedOffset > 0) {
    parts.push(`offset: ${result.appliedOffset}`);
  }
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

function getGrepSummary(result: GrepResult): string {
  if (typeof result.summary === 'string') {
    return result.summary;
  }

  const mode =
    result.mode ??
    (result.matches && result.matches.length > 0 ? 'content' : undefined);

  if (mode === 'content') {
    const count =
      result.numMatches ?? result.matches?.length ?? result.numLines ?? 0;
    if (count === 0) {
      return 'No matches found';
    }
    return `Found ${count} ${pluralize(count, 'match', 'matches')}${formatLimitSuffix(result)}`;
  }

  if (mode === 'count') {
    const matches = result.numMatches ?? 0;
    const files = result.numFiles ?? 0;
    if (matches === 0) {
      return 'No matches found';
    }
    return `Found ${matches} occurrences across ${files} ${pluralize(files, 'file', 'files')}${formatLimitSuffix(result)}`;
  }

  const count = result.numFiles ?? result.filenames?.length ?? 0;
  if (count === 0) {
    return 'No matches found';
  }
  return `Found ${count} ${pluralize(count, 'file', 'files')}${formatLimitSuffix(result)}`;
}

function getGlobSummary(result: GlobResult): string {
  if (result.numFiles === 0) {
    return 'No files found';
  }
  return `Found ${result.numFiles} matching file(s)`;
}

export const ToolResultDisplay: React.FC<ToolResultDisplayProps> = ({
  resultDisplay,
  availableTerminalHeight,
  terminalWidth,
  renderOutputAsMarkdown = true,
  maxLines,
  hasFocus = false,
  overflowDirection = 'top',
}) => {
  const { renderMarkdown, constrainHeight } = useUIState();
  const isAlternateBuffer = useAlternateBuffer();

  const availableHeight = calculateToolContentMaxLines({
    availableTerminalHeight,
    isAlternateBuffer,
    maxLinesLimit: maxLines,
  });

  const combinedPaddingAndBorderWidth = 4;
  const childWidth = terminalWidth - combinedPaddingAndBorderWidth;

  if (!resultDisplay) return null;

  if (isTodoList(resultDisplay)) {
    return (
      <Text wrap="wrap" color={theme.status.success}>
        {formatTodoSummary(resultDisplay.todos)}
      </Text>
    );
  }

  // Child rows compact themselves; the single-tool line cap would hide later calls.
  if (isCodeModeDisplay(resultDisplay)) {
    return (
      <CodeModeDisplayView display={resultDisplay} terminalWidth={childWidth} />
    );
  }

  const renderContent = (contentData: string | object | undefined) => {
    // Check if string content is valid JSON and pretty-print it
    const prettyJSON =
      typeof contentData === 'string' ? tryParseJSON(contentData) : null;
    const formattedJSON = prettyJSON
      ? JSON.stringify(prettyJSON, null, 2)
      : null;

    let content: React.ReactNode;

    if (formattedJSON) {
      // Render pretty-printed JSON
      content = (
        <Text wrap="wrap" color={theme.text.primary}>
          {formattedJSON}
        </Text>
      );
    } else if (isSubagentProgress(contentData)) {
      content = (
        <SubagentProgressDisplay
          progress={contentData}
          terminalWidth={childWidth}
          renderToolResult={(tool) => (
            <ToolResultDisplay
              resultDisplay={tool.resultDisplay}
              availableTerminalHeight={availableTerminalHeight}
              terminalWidth={childWidth}
              renderOutputAsMarkdown={tool.renderOutputAsMarkdown}
              maxLines={maxLines}
              hasFocus={hasFocus}
              overflowDirection={overflowDirection}
            />
          )}
        />
      );
    } else if (isCronResult(contentData)) {
      content = <CronResultDisplay result={contentData} />;
    } else if (isGlobResult(contentData)) {
      content = (
        <Text wrap="wrap" color={theme.text.primary}>
          {getGlobSummary(contentData)}
        </Text>
      );
    } else if (isGrepResult(contentData)) {
      content = (
        <Text wrap="wrap" color={theme.text.primary}>
          {getGrepSummary(contentData)}
        </Text>
      );
    } else if (typeof contentData === 'string' && renderOutputAsMarkdown) {
      content = (
        <MarkdownDisplay
          text={contentData}
          terminalWidth={childWidth}
          renderMarkdown={renderMarkdown}
          isPending={false}
        />
      );
    } else if (typeof contentData === 'string' && !renderOutputAsMarkdown) {
      content = (
        <Text wrap="wrap" color={theme.text.primary}>
          {contentData}
        </Text>
      );
    } else if (isStructuredToolResult(contentData)) {
      if (renderOutputAsMarkdown) {
        content = (
          <MarkdownDisplay
            text={contentData.summary}
            terminalWidth={childWidth}
            renderMarkdown={renderMarkdown}
            isPending={false}
          />
        );
      } else {
        content = (
          <Text wrap="wrap" color={theme.text.primary}>
            {contentData.summary}
          </Text>
        );
      }
    } else if (
      typeof contentData === 'object' &&
      contentData !== null &&
      'fileDiff' in contentData
    ) {
      content = (
        <DiffRenderer
          diffContent={(contentData as FileDiffResult).fileDiff}
          filePath={(contentData as FileDiffResult).fileName}
          terminalWidth={childWidth}
          isNewFile={(contentData as FileDiffResult).isNewFile}
        />
      );
    } else if (typeof contentData === 'object' && contentData !== null) {
      // Render as JSON for other non-null objects
      content = (
        <Text wrap="wrap" color={theme.text.primary}>
          {JSON.stringify(contentData, null, 2)}
        </Text>
      );
    } else {
      content = null;
    }

    // Final render based on session mode
    if (isAlternateBuffer && constrainHeight) {
      // Use maxLines if provided, otherwise fall back to the calculated available height
      const effectiveMaxHeight = maxLines ?? availableHeight;

      return (
        <Scrollable
          width={childWidth}
          maxHeight={effectiveMaxHeight}
          hasFocus={hasFocus} // Allow scrolling via keyboard (Shift+Up/Down)
          scrollToBottom={true}
          reportOverflow={true}
        >
          {content}
        </Scrollable>
      );
    }

    return content;
  };

  // In an unconstrained view, including the detailed transcript, render all
  // content without height limits, scrollbars, or truncation.
  if (!constrainHeight) {
    // For non-array content in expanded mode, render without truncation
    return (
      <Box width={childWidth} flexDirection="column">
        {renderContent(resultDisplay)}
      </Box>
    );
  }

  // ASB Mode Handling (Interactive/Fullscreen)
  if (isAlternateBuffer) {
    // Standard path for strings/diffs in ASB
    return (
      <Box width={childWidth} flexDirection="column">
        {renderContent(resultDisplay)}
      </Box>
    );
  }

  // Standard Mode Handling (History/Scrollback)
  // We use SlicingMaxSizedBox which includes MaxSizedBox for precision truncation + hidden labels
  return (
    <Box width={childWidth} flexDirection="column">
      <SlicingMaxSizedBox
        data={resultDisplay}
        maxLines={maxLines}
        isAlternateBuffer={isAlternateBuffer}
        maxHeight={availableHeight}
        maxWidth={childWidth}
        overflowDirection={overflowDirection}
      >
        {(truncatedResultDisplay) => renderContent(truncatedResultDisplay)}
      </SlicingMaxSizedBox>
    </Box>
  );
};

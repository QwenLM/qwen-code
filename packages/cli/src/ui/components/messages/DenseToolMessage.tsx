/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo } from 'react';
import { Box, Text } from 'ink';
import {
  CoreToolCallStatus,
  type FileDiff,
  type GlobResult,
  type GrepResult,
  isFileDiff,
  isGlobResult,
  hasSummary,
  isGrepResult,
} from '@qwen-code/core';
import { formatCommand } from '../../key/keybindingUtils.js';
import { Command } from '../../key/keyBindings.js';
import {
  type IndividualToolCallDisplay,
  type ToolResultDisplay,
  isTodoList,
} from '../../types.js';
import { useAlternateBuffer } from '../../hooks/useAlternateBuffer.js';
import { ToolStatusIndicator } from './ToolShared.js';
import { theme } from '../../semantic-colors.js';
import {
  DiffRenderer,
  renderDiffToLines,
  getColorDiffThemeName,
} from './DiffRenderer.js';
import { ScrollableList } from '../shared/ScrollableList.js';
import { COMPACT_TOOL_SUBVIEW_MAX_LINES } from '../../constants.js';
import { useToolActions } from '../../contexts/ToolActionsContext.js';
import { ToolContainer } from './ToolContainer.js';
import { INDENT, FoldLevel } from '../../constants/messageLayout.js';
import { getBorderStyle } from '../../utils/borderStyles.js';

const PAYLOAD_BORDER_CHROME_WIDTH = 4; // paddingX=1 (2 cols) + borders (2 cols)
const PAYLOAD_SCROLL_GUTTER = 4;
const PAYLOAD_MAX_WIDTH = 120 + PAYLOAD_SCROLL_GUTTER;
const ERROR_SUMMARY_MAX_LENGTH = 60;
const COMPACT_RESULT_ITEM_LIMIT = 10;
const EXPAND_HINT_KEY = formatCommand(Command.SHOW_MORE_LINES);

interface DenseToolMessageProps extends IndividualToolCallDisplay {
  terminalWidth: number;
  foldLevel?: FoldLevel;
}

interface ViewParts {
  // brief description of action
  description?: React.ReactNode;
  // result summary or status text
  summary?: React.ReactNode;
  // detailed output, e.g. diff or command output
  payload?: React.ReactNode;
  isTruncated?: boolean;
}

interface PayloadResult {
  summary: string;
  payload: string;
}

const hasPayload = (res: unknown): res is PayloadResult => {
  if (!hasSummary(res)) return false;
  if (!('payload' in res)) return false;

  const value = (res as { payload?: unknown }).payload;
  return typeof value === 'string';
};

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

function legacyGrepSummary(result: GrepResult): string | undefined {
  return result.summary;
}

function getGrepSummary(result: GrepResult): string {
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

  if (mode === 'files_with_matches') {
    const count = result.numFiles ?? result.filenames?.length ?? 0;
    if (count === 0) {
      return 'No matches found';
    }
    return `Found ${count} ${pluralize(count, 'file', 'files')}${formatLimitSuffix(result)}`;
  }

  return legacyGrepSummary(result) ?? 'Found grep results';
}

function getGrepPayloadItems(result: GrepResult): string[] {
  if (result.mode === 'files_with_matches') {
    return result.filenames ?? [];
  }

  if (result.mode === 'count') {
    return result.content ? result.content.split('\n') : [];
  }

  if (result.matches && result.matches.length > 0) {
    return result.matches.map(
      (m) => `${m.filePath}:${m.lineNumber}: ${m.line.trim()}`,
    );
  }

  return result.content ? result.content.split('\n') : [];
}

function getGlobSummary(result: GlobResult): string {
  if (result.numFiles === 0) {
    return 'No files found';
  }
  return `Found ${result.numFiles} matching file(s)`;
}

function getGlobPayloadItems(result: GlobResult): string[] {
  return [
    ...result.filenames,
    ...(result.truncated
      ? [
          '(Results are truncated. Consider using a more specific path or pattern.)',
        ]
      : []),
  ];
}

function truncateSingleLine(text: string, maxWidth: number): string {
  const width = Math.max(1, maxWidth);
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(0, width - 1))}…`;
}

const RenderItemsList: React.FC<{
  items?: string[];
  showAll?: boolean;
}> = ({ items, showAll = false }) => {
  if (!items || items.length === 0) return null;
  const visibleItems = showAll
    ? items
    : items.slice(0, COMPACT_RESULT_ITEM_LIMIT);
  const hiddenItemCount = items.length - visibleItems.length;

  return (
    <Box flexDirection="column">
      {visibleItems.map((item, i) => (
        <Text key={i} color={theme.text.response}>
          {item}
        </Text>
      ))}
      {hiddenItemCount > 0 && (
        <Text color={theme.border.default}>
          ... and {hiddenItemCount} more
        </Text>
      )}
    </Box>
  );
};

function buildFileDiffViewParts(
  diff: FileDiff,
  status: CoreToolCallStatus,
  resultDisplay: ToolResultDisplay | undefined,
  terminalWidth: number,
  isClickable: boolean,
): ViewParts {
  const added =
    (diff.diffStat?.model_added_lines ?? 0) +
    (diff.diffStat?.user_added_lines ?? 0);
  const removed =
    (diff.diffStat?.model_removed_lines ?? 0) +
    (diff.diffStat?.user_removed_lines ?? 0);

  const isAcceptedOrConfirming =
    status === CoreToolCallStatus.Success ||
    status === CoreToolCallStatus.Executing ||
    status === CoreToolCallStatus.AwaitingApproval;

  const addColor = isAcceptedOrConfirming
    ? theme.status.success
    : theme.border.default;
  const removeColor = isAcceptedOrConfirming
    ? theme.status.error
    : theme.border.default;

  // Always show diff stats if available, using neutral colors for rejected
  const showDiffStat = !!diff.diffStat;

  const description = (
    <Box flexDirection="row">
      <Text color={theme.text.response} wrap="truncate-end">
        {diff.fileName}
      </Text>
    </Box>
  );
  let resultSummary = '';
  let resultColor = theme.text.secondary;

  if (status === CoreToolCallStatus.AwaitingApproval) {
    resultSummary = 'Confirming';
  } else if (
    status === CoreToolCallStatus.Success ||
    status === CoreToolCallStatus.Executing
  ) {
    resultSummary = 'Accepted';
    resultColor = theme.status.success;
  } else if (status === CoreToolCallStatus.Cancelled) {
    resultSummary = 'Rejected';
    resultColor = theme.status.error;
  } else if (status === CoreToolCallStatus.Error) {
    resultSummary =
      typeof resultDisplay === 'string' ? resultDisplay : 'Failed';
    resultColor = theme.status.error;
  }

  const summary = (
    <Box flexDirection="row">
      {resultSummary && (
        <Text color={resultColor} wrap="truncate-end">
          <Text underline={isClickable}>
            {resultSummary.replace(/\n/g, ' ')}
          </Text>
        </Text>
      )}
      <Box marginLeft={resultSummary ? 1 : 0}>
        <Text color={theme.text.response} wrap="truncate-end">
          {diff.fileName}
        </Text>
      </Box>
      {showDiffStat && (
        <Box marginLeft={1} marginRight={2}>
          <Text color={theme.border.default}>
            {'('}
            <Text color={addColor}>+{added}</Text>
            {', '}
            <Text color={removeColor}>-{removed}</Text>
            {')'}
          </Text>
        </Box>
      )}
    </Box>
  );

  const payload = (
    <DiffRenderer
      diffContent={diff.fileDiff}
      filePath={diff.fileName}
      terminalWidth={terminalWidth - INDENT.TOOL_PAYLOAD}
      disableColor={status === CoreToolCallStatus.Cancelled}
      isNewFile={diff.isNewFile}
    />
  );

  return { description, summary, payload };
}

function getGenericSuccessData(
  resultDisplay: unknown,
  originalDescription?: string,
  terminalWidth?: number,
  showAllPayloadItems = false,
): ViewParts {
  let summary: React.ReactNode;
  let payload: React.ReactNode;

  const description = originalDescription ? (
    <Text color={theme.text.response} wrap="truncate-end">
      {originalDescription}
    </Text>
  ) : undefined;

  if (typeof resultDisplay === 'string') {
    const flattened = resultDisplay.replace(/\n/g, ' ').trim();
    const displayText =
      terminalWidth === undefined
        ? flattened
        : truncateSingleLine(flattened, terminalWidth - INDENT.TOOL_PAYLOAD);
    summary = (
      <Text color={theme.status.success} wrap="truncate-end">
        {displayText}
      </Text>
    );
  } else if (isGlobResult(resultDisplay)) {
    summary = (
      <Text color={theme.status.success}>{getGlobSummary(resultDisplay)}</Text>
    );
    const items = getGlobPayloadItems(resultDisplay);
    if (items.length > 0) {
      payload = (
        <Box flexDirection="column">
          <RenderItemsList items={items} showAll={showAllPayloadItems} />
        </Box>
      );
    }
  } else if (isGrepResult(resultDisplay)) {
    summary = (
      <Text color={theme.status.success}>{getGrepSummary(resultDisplay)}</Text>
    );
    const items =
      resultDisplay.mode === 'content'
        ? getGrepPayloadItems(resultDisplay)
        : [];
    if (items.length > 0) {
      payload = (
        <Box flexDirection="column">
          <RenderItemsList items={items} showAll={showAllPayloadItems} />
        </Box>
      );
    }
  } else if (isTodoList(resultDisplay)) {
    summary = (
      <Text color={theme.status.success} wrap="wrap">
        Todos updated
      </Text>
    );
  } else if (hasPayload(resultDisplay)) {
    summary = <Text color={theme.status.success}>{resultDisplay.summary}</Text>;
    payload = (
      <Box>
        <Text color={theme.text.response}>{resultDisplay.payload}</Text>
      </Box>
    );
  } else {
    summary = (
      <Text color={theme.status.success} wrap="wrap">
        Returned (possible empty result)
      </Text>
    );
  }

  return { description, summary, payload };
}

export const DenseToolMessage: React.FC<DenseToolMessageProps> = (props) => {
  const {
    callId,
    name,
    status,
    resultDisplay,
    confirmationDetails,
    outputFile,
    terminalWidth,
    foldLevel,
    description: originalDescription,
  } = props;

  const isFullyExpanded =
    foldLevel === undefined || foldLevel === FoldLevel.FullyExpanded;

  const isAlternateBuffer = useAlternateBuffer();
  const { isExpanded: isExpandedInContext } = useToolActions();
  const isExpanded = isExpandedInContext?.(callId) ?? false;

  // Unified File Data Extraction (Safely bridge resultDisplay and confirmationDetails)
  const diff = useMemo((): FileDiff | undefined => {
    if (isFileDiff(resultDisplay)) return resultDisplay;
    if (confirmationDetails?.type === 'edit') {
      const details = confirmationDetails;
      return {
        fileName: details.fileName,
        fileDiff: details.fileDiff,
        filePath: details.filePath,
        originalContent: details.originalContent,
        newContent: details.newContent,
        diffStat: details.diffStat,
      };
    }
    return undefined;
  }, [resultDisplay, confirmationDetails]);

  // State-to-View Coordination
  const viewParts = useMemo((): ViewParts => {
    if (diff) {
      return buildFileDiffViewParts(
        diff,
        status,
        resultDisplay,
        terminalWidth,
        isAlternateBuffer,
      );
    }
    if (isGrepResult(resultDisplay)) {
      return getGenericSuccessData(
        resultDisplay,
        originalDescription,
        terminalWidth,
        isFullyExpanded,
      );
    }

    if (status === CoreToolCallStatus.Success && resultDisplay) {
      return getGenericSuccessData(
        resultDisplay,
        originalDescription,
        terminalWidth,
        isFullyExpanded,
      );
    }
    if (
      (status === CoreToolCallStatus.Error ||
        status === CoreToolCallStatus.Cancelled) &&
      typeof resultDisplay === 'string'
    ) {
      const text = resultDisplay.replace(/\n/g, ' ');
      // When fully expanded, show complete error text in summary (no payload needed).
      // When collapsed, truncate long text in summary and put full text in payload.
      const isLong = text.length > ERROR_SUMMARY_MAX_LENGTH;
      const showFull = isFullyExpanded || !isLong;
      const displayText = showFull
        ? text
        : text.slice(0, ERROR_SUMMARY_MAX_LENGTH) + '...';
      const errorSummary = (
        <Text
          color={theme.status.error}
          wrap={showFull ? 'wrap' : 'truncate-end'}
        >
          {displayText}
        </Text>
      );
      const descriptionText = originalDescription ? (
        <Text color={theme.text.response} wrap="truncate-end">
          {originalDescription}
        </Text>
      ) : undefined;
      return {
        description: descriptionText,
        summary: errorSummary,
        isTruncated: isLong && !isFullyExpanded,
      };
    }

    const descriptionText = originalDescription ? (
      <Text color={theme.text.response} wrap="truncate-end">
        {originalDescription}
      </Text>
    ) : undefined;
    return {
      description: descriptionText,
      summary: undefined,
      payload: undefined,
    };
  }, [
    diff,
    status,
    resultDisplay,
    terminalWidth,
    originalDescription,
    isAlternateBuffer,
    isFullyExpanded,
  ]);

  const { summary } = viewParts;
  const hasExpandablePayload = !!viewParts.payload && !diff;

  const colorDiffTheme = getColorDiffThemeName();

  const diffLines = useMemo(() => {
    if (!diff || !isExpanded || !isAlternateBuffer) return [];

    return renderDiffToLines({
      diffContent: diff.fileDiff,
      filePath: diff.filePath ?? diff.fileName,
      colorDiffTheme,
      terminalWidth: terminalWidth - INDENT.TOOL_PAYLOAD,
      disableColor: status === CoreToolCallStatus.Cancelled,
      isNewFile: diff.isNewFile,
    });
  }, [
    diff,
    isExpanded,
    isAlternateBuffer,
    terminalWidth,
    status,
    colorDiffTheme,
  ]);

  const hasNonDiffPayload = !!viewParts.payload;
  // Whether the payload area is eligible to render — actual visibility
  // further depends on isExpanded/diffLines for the diff-in-ASB path.
  const isPayloadEligible =
    !!diff || (hasNonDiffPayload && isFullyExpanded) || !!outputFile;

  const keyExtractor = (_item: React.ReactNode, index: number) =>
    `diff-line-${index}`;
  const renderItem = ({ item }: { item: React.ReactNode }) => (
    <Box minHeight={1}>{item}</Box>
  );

  // Show expand hint when there's expandable content and it's collapsed.
  const hasCollapsedDiffPayload =
    !!diff &&
    !isFullyExpanded &&
    (isAlternateBuffer ? !isExpanded : true);
  const expandHint =
    ((hasExpandablePayload || viewParts.isTruncated) && !isFullyExpanded) ||
    hasCollapsedDiffPayload ? (
      <Text color={theme.border.default}>
        {' '}
        ({EXPAND_HINT_KEY} to expand)
      </Text>
    ) : undefined;

  const headerRow = (
    <Box flexDirection="row">
      <ToolStatusIndicator status={status} />
      <Text wrap="wrap">
        <Text color={theme.text.primary} bold>
          {name}
        </Text>
        {originalDescription ? (
          <Text color={theme.text.response}>({originalDescription})</Text>
        ) : null}
      </Text>
    </Box>
  );

  const summaryRow = summary ? (
    diff ? (
      // Diff summary contains <Box> components, so wrap in <Box> instead of <Text>
      <Box flexDirection="row">
        {summary}
        {expandHint}
      </Box>
    ) : (
      <Text wrap="wrap">
        {summary}
        {expandHint}
      </Text>
    )
  ) : undefined;

  const showDiffScrollable =
    isPayloadEligible &&
    isAlternateBuffer &&
    isExpanded &&
    diffLines.length > 0;
  const showPayloadFallback =
    isPayloadEligible &&
    !showDiffScrollable &&
    !!viewParts.payload &&
    (!diff || (!isAlternateBuffer && isFullyExpanded));
  const showOutputFile = isPayloadEligible && !!outputFile;

  const payloadSection = (
    <>
      {showDiffScrollable && (
        <Box
          marginTop={1}
          marginBottom={1}
          paddingX={1}
          flexDirection="column"
          height={
            Math.min(diffLines.length, COMPACT_TOOL_SUBVIEW_MAX_LINES) + 2
          }
          maxHeight={COMPACT_TOOL_SUBVIEW_MAX_LINES + 2}
          borderStyle={getBorderStyle('tool')}
          borderColor={theme.border.default}
          borderDimColor={true}
          maxWidth={Math.min(
            PAYLOAD_MAX_WIDTH,
            terminalWidth - INDENT.TOOL_PAYLOAD,
          )}
        >
          <ScrollableList
            data={diffLines}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            estimatedItemHeight={() => 1}
            hasFocus={false}
            width={Math.min(
              PAYLOAD_MAX_WIDTH,
              terminalWidth -
                INDENT.TOOL_PAYLOAD -
                PAYLOAD_BORDER_CHROME_WIDTH -
                PAYLOAD_SCROLL_GUTTER,
            )}
          />
        </Box>
      )}

      {showPayloadFallback && (
        <Box marginTop={1} marginBottom={1}>
          {viewParts.payload}
        </Box>
      )}

      {showOutputFile && (
        <Box marginTop={1} marginBottom={1}>
          <Text color={theme.border.default}>
            (Output saved to:{' '}
            <Text color={theme.text.response}>{outputFile}</Text>)
          </Text>
        </Box>
      )}
    </>
  );

  const hasPayloadContent =
    showDiffScrollable || showPayloadFallback || showOutputFile;

  return (
    <ToolContainer
      header={headerRow}
      payload={hasPayloadContent ? payloadSection : undefined}
      terminalWidth={terminalWidth}
    >
      {summaryRow ?? null}
    </ToolContainer>
  );
};

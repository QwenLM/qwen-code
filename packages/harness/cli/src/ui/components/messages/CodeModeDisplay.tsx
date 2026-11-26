/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import {
  CoreToolCallStatus,
  isFailedScriptStatus,
  type CodeModeChildDisplay,
  type CodeModeDisplay,
} from '@qwen-code/core';
import { DenseToolMessage } from './DenseToolMessage.js';
import { ToolResultDisplay } from './ToolResultDisplay.js';
import { FoldLevel } from '../../constants/messageLayout.js';
import { projectToolCallDisplay } from '../../utils/toolDisplayProjection.js';
import { theme } from '../../semantic-colors.js';
import { TOOL_OUTPUT_COMPACT_MAX_LINES } from '../../utils/toolLayoutUtils.js';
import type { IndividualToolCallDisplay } from '../../types.js';
import { useI18nService } from '../../i18n/index.js';
import { sanitizeForDisplay } from '../../utils/textUtils.js';

interface CodeModeDisplayViewProps {
  display: CodeModeDisplay;
  terminalWidth: number;
  foldLevel?: FoldLevel;
  live?: boolean;
}

const isFailed = (status: CoreToolCallStatus) =>
  status === CoreToolCallStatus.Error ||
  status === CoreToolCallStatus.Cancelled;

// The hidden-lines label takes one of the maxLines rows.
const COLLAPSED_OUTPUT_LINES = TOOL_OUTPUT_COMPACT_MAX_LINES + 1;

function projectChild(
  child: CodeModeChildDisplay,
  live: boolean,
): IndividualToolCallDisplay {
  const tool = projectToolCallDisplay({
    toolUse: { id: child.callId, name: child.name, input: child.args },
    runtime: {
      // Historical poll receipts retain their state without running animations.
      status:
        !live && child.status === CoreToolCallStatus.Executing
          ? CoreToolCallStatus.Scheduled
          : child.status,
    },
  });
  return {
    ...tool,
    description: [
      tool.description,
      child.argsTruncated ? '[arguments truncated]' : undefined,
      child.notice ? `(${child.notice})` : undefined,
    ]
      .filter(Boolean)
      .join(' '),
    // Only failed calls carry an error, and it explains them better than their display.
    resultDisplay: child.error ?? child.resultDisplay,
  };
}

/** Script child calls as compact tool rows; failures start expanded. */
export const CodeModeDisplayView: React.FC<CodeModeDisplayViewProps> = ({
  display,
  terminalWidth,
  foldLevel = FoldLevel.GroupExpandedToolCollapsed,
  live = false,
}) => {
  const { get: t } = useI18nService();
  const scriptFailed =
    display.status !== undefined && isFailedScriptStatus(display.status);
  const outputExpanded = scriptFailed || foldLevel === FoldLevel.FullyExpanded;
  const search =
    foldLevel === FoldLevel.FullyExpanded ? display.toolSearch : undefined;
  return (
    <Box flexDirection="column">
      {display.children.map((child) => {
        const tool = projectChild(child, live);
        return (
          <DenseToolMessage
            key={tool.callId}
            {...tool}
            terminalWidth={terminalWidth}
            foldLevel={
              isFailed(tool.status) ? FoldLevel.FullyExpanded : foldLevel
            }
          />
        );
      })}
      {search && search.count > 0 && (
        <Box flexDirection="column">
          <Text color={theme.text.secondary}>
            {t('status.codeMode.candidates')}
          </Text>
          {search.matches.map((match) => (
            <Text key={match.name}>
              {sanitizeForDisplay(match.name)} {sanitizeForDisplay(match.input)}
              {match.about && (
                <Text color={theme.text.secondary}> · {sanitizeForDisplay(match.about)}</Text>
              )}
            </Text>
          ))}
          {search.matches.length < search.count && (
            <Text color={theme.text.secondary}>
              {t('status.codeMode.omitted', { count: search.count - search.matches.length })}
            </Text>
          )}
        </Box>
      )}
      {display.summary ? (
        <Box
          flexDirection="column"
          marginTop={display.children.length > 0 ? 1 : 0}
        >
          <Text color={theme.text.secondary}>{t('status.codeMode.output')}</Text>
          <ToolResultDisplay
            resultDisplay={display.summary}
            terminalWidth={terminalWidth}
            renderOutputAsMarkdown={false}
            maxLines={outputExpanded ? undefined : COLLAPSED_OUTPUT_LINES}
            overflowDirection="bottom"
          />
        </Box>
      ) : null}
    </Box>
  );
};

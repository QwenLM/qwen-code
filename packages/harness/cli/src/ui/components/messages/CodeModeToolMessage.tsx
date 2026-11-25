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
  isCodeModeDisplay,
  type CodeModeDisplay,
} from '@qwen-code/core';
import type { ToolMessageProps } from './ToolMessage.js';
import { ToolContainer } from './ToolContainer.js';
import { ToolInfo, ToolStatusIndicator } from './ToolShared.js';
import { ToolResultDisplay } from './ToolResultDisplay.js';
import { CodeModeDisplayView } from './CodeModeDisplay.js';
import { FoldLevel } from '../../constants/messageLayout.js';
import { theme } from '../../semantic-colors.js';
import { Command } from '../../key/keyBindings.js';
import { formatCommand } from '../../key/keybindingUtils.js';
import { useSettings } from '../../contexts/SettingsContext.js';
import { useThemeRevision } from '../../hooks/useThemeRevision.js';
import { colorizeCode } from '../../utils/CodeColorizer.js';
import { stripUnsafeCharacters } from '../../utils/textUtils.js';
import { useI18nService, type UiMessageKey } from '../../i18n/index.js';

const SCRIPT_LABELS = {
  running: 'status.codeMode.stillRunning',
  completed: 'status.codeMode.completed',
  error: 'status.codeMode.failed',
  incomplete: 'status.codeMode.incomplete',
  cancelled: 'status.codeMode.cancelled',
  timeout: 'status.codeMode.timeout',
  limit: 'status.codeMode.limit',
} satisfies Record<NonNullable<CodeModeDisplay['status']>, UiMessageKey>;

const TOOL_LABELS: Record<CoreToolCallStatus, UiMessageKey> = {
  [CoreToolCallStatus.Scheduled]: 'status.codeMode.queued',
  [CoreToolCallStatus.Validating]: 'status.codeMode.preparing',
  [CoreToolCallStatus.AwaitingApproval]: 'status.codeMode.approval',
  [CoreToolCallStatus.Executing]: 'status.codeMode.running',
  [CoreToolCallStatus.Success]: SCRIPT_LABELS.completed,
  [CoreToolCallStatus.Error]: SCRIPT_LABELS.error,
  [CoreToolCallStatus.Cancelled]: SCRIPT_LABELS.cancelled,
};

/** Keep the tool-response lifecycle distinct from a yielded script's state. */
export const CodeModeToolMessage: React.FC<
  ToolMessageProps & { foldLevel: FoldLevel }
> = ({
  name,
  args,
  description,
  resultDisplay,
  status,
  terminalWidth,
  emphasis = 'medium',
  isFirst,
  borderColor,
  borderDimColor,
  foldLevel,
}) => {
  const { get: t } = useI18nService();
  const display = isCodeModeDisplay(resultDisplay) ? resultDisplay : undefined;
  const scriptStatus = display?.status;
  const yielded = status === CoreToolCallStatus.Success && scriptStatus === 'running';
  // A yielded response is a historical receipt: use a neutral, static marker,
  // not a success marker or an animation that survives later wait completion.
  const indicatorStatus = yielded
    ? CoreToolCallStatus.Scheduled
    : scriptStatus === 'cancelled'
      ? CoreToolCallStatus.Cancelled
      : status;
  const label =
    scriptStatus && (scriptStatus !== 'running' || yielded)
      ? SCRIPT_LABELS[scriptStatus]
      : TOOL_LABELS[status];
  const shown = display?.children.length;
  const count = display?.totalCalls ?? shown;
  const search = display?.toolSearch;
  const headerParts = [description];
  if (search) {
    headerParts.push(
      search.count === 0
        ? t('status.codeMode.noMatches')
        : t(
            search.count === 1
              ? 'status.codeMode.matches.one'
              : 'status.codeMode.matches.many',
            { count: search.count },
          ),
    );
  } else {
    headerParts.push(t(label));
    if (count !== undefined) {
      headerParts.push(
        t(
          count === 1
            ? 'status.codeMode.calls.one'
            : 'status.codeMode.calls.many',
          { count },
        ),
      );
    }
    if (shown !== undefined && shown !== count) {
      headerParts.push(t('status.codeMode.updated', { count: shown }));
    }
  }
  const source = typeof args?.['code'] === 'string' ? args['code'] : undefined;
  const expanded = foldLevel === FoldLevel.FullyExpanded;
  const settings = useSettings();
  const themeRevision = useThemeRevision();
  // Live child updates re-render this message; re-highlighting the script each time is wasted.
  const highlighted = useMemo(() => {
    // Highlighted nodes capture colors from the current theme.
    void themeRevision;
    return source && expanded
      ? colorizeCode({
          code: stripUnsafeCharacters(source),
          language: 'javascript',
          maxWidth: terminalWidth - 4,
          settings,
          hideLineNumbers: true,
        })
      : undefined;
  }, [source, expanded, terminalWidth, settings, themeRevision]);

  return (
    <ToolContainer
      terminalWidth={terminalWidth}
      sticky
      stickyProps={{ isFirst, borderColor, borderDimColor }}
      header={
        <>
          <ToolStatusIndicator status={indicatorStatus} />
          <ToolInfo
            name={name}
            status={indicatorStatus}
            description={`· ${headerParts.filter(Boolean).join(' · ')}`}
            emphasis={emphasis}
          />
        </>
      }
    >
      {(resultDisplay || source) && (!search || expanded) ? (
        <Box flexDirection="column">
          {display ? (
            <CodeModeDisplayView
              display={display}
              terminalWidth={terminalWidth - 4}
              foldLevel={foldLevel}
              live={status === CoreToolCallStatus.Executing}
            />
          ) : resultDisplay ? (
            <ToolResultDisplay resultDisplay={resultDisplay} terminalWidth={terminalWidth} />
          ) : null}
          {source ? (
            expanded ? (
              <Box flexDirection="column" marginTop={resultDisplay ? 1 : 0}>
                <Text color={theme.text.secondary}>JavaScript</Text>
                {highlighted}
              </Box>
            ) : (
              <Text color={theme.text.secondary}>
                {t('status.codeMode.expand', { shortcut: formatCommand(Command.SHOW_MORE_LINES) })}
              </Text>
            )
          ) : null}
        </Box>
      ) : null}
    </ToolContainer>
  );
};

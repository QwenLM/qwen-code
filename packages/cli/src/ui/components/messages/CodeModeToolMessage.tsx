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
import { colorizeCode } from '../../utils/CodeColorizer.js';
import { stripUnsafeCharacters } from '../../utils/textUtils.js';

const SCRIPT_LABELS = {
  running: 'Script still running',
  completed: 'Completed',
  error: 'Failed',
  incomplete: 'Incomplete',
  cancelled: 'Cancelled',
  timeout: 'Timed out',
  limit: 'Limit reached',
} satisfies Record<NonNullable<CodeModeDisplay['status']>, string>;

const TOOL_LABELS: Record<CoreToolCallStatus, string> = {
  [CoreToolCallStatus.Scheduled]: 'Queued',
  [CoreToolCallStatus.Validating]: 'Preparing',
  [CoreToolCallStatus.AwaitingApproval]: 'Awaiting approval',
  [CoreToolCallStatus.Executing]: 'Running',
  [CoreToolCallStatus.Success]: 'Completed',
  [CoreToolCallStatus.Error]: 'Failed',
  [CoreToolCallStatus.Cancelled]: 'Cancelled',
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
  const headerDescription = [
    description,
    label,
    count === undefined ? undefined : `${count} tool call${count === 1 ? '' : 's'}`,
    shown === count ? undefined : `${shown} updated`,
  ]
    .filter(Boolean)
    .join(' · ');
  const source = typeof args?.['code'] === 'string' ? args['code'] : undefined;
  const expanded = foldLevel === FoldLevel.FullyExpanded;
  const settings = useSettings();
  // Live child updates re-render this message; re-highlighting the script each time is wasted.
  const highlighted = useMemo(
    () =>
      source && expanded
        ? colorizeCode({
            code: stripUnsafeCharacters(source),
            language: 'javascript',
            maxWidth: terminalWidth - 4,
            settings,
            hideLineNumbers: true,
          })
        : undefined,
    [source, expanded, terminalWidth, settings],
  );

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
            description={`· ${headerDescription}`}
            emphasis={emphasis}
          />
        </>
      }
    >
      {resultDisplay || source ? (
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
                {formatCommand(Command.SHOW_MORE_LINES)} to expand script
              </Text>
            )
          ) : null}
        </Box>
      ) : null}
    </ToolContainer>
  );
};

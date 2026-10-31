/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import type { RadioSelectItem } from './shared/RadioButtonSelect.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { theme } from '../semantic-colors.js';

export type LoopDetectionConfirmationResult = {
  userSelection: 'disable' | 'keep';
};

interface LoopDetectionConfirmationProps {
  cause?: string;
  onComplete: (result: LoopDetectionConfirmationResult) => void;
}

export function LoopDetectionConfirmation({
  cause,
  onComplete,
}: LoopDetectionConfirmationProps) {
  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onComplete({
          userSelection: 'keep',
        });
      }
    },
    { isActive: true },
  );

  // The cause is shared with the headless text, which marks setting names as
  // code; quote them like the note below.
  const quotedCause = cause?.replace(/`([^`]+)`/g, '"$1"');

  const OPTIONS: Array<RadioSelectItem<LoopDetectionConfirmationResult>> = [
    {
      label: 'Keep loop detection enabled (esc)',
      value: {
        userSelection: 'keep',
      },
      key: 'Keep loop detection enabled (esc)',
    },
    {
      label: 'Disable loop detection for this session',
      value: {
        userSelection: 'disable',
      },
      key: 'Disable loop detection for this session',
    },
  ];

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.status.warning}
      width="100%"
      marginLeft={1}
    >
      <Box paddingX={1} paddingY={0} flexDirection="column">
        <Box minHeight={1}>
          <Box minWidth={3}>
            <Text color={theme.status.warning} aria-label="Loop detected:">
              ?
            </Text>
          </Box>
          <Box>
            <Text wrap="truncate-end">
              <Text color={theme.text.primary} bold>
                A potential loop was detected
              </Text>{' '}
            </Text>
          </Box>
        </Box>
        <Box width="100%" marginTop={1}>
          <Box flexDirection="column">
            {quotedCause && (
              <Text color={theme.text.primary}>Cause: {quotedCause}.</Text>
            )}
            <Text color={theme.text.secondary}>
              This can happen due to repetitive tool calls or other model
              behavior. Do you want to keep loop detection enabled or disable it
              for this session?
            </Text>
            <Box marginTop={1}>
              <RadioButtonSelect items={OPTIONS} onSelect={onComplete} />
            </Box>
            <Box marginTop={1}>
              <Text color={theme.text.secondary}>
                Note: Setting &quot;model.loopProtection&quot; in your
                settings.json to &quot;warn&quot; reminds the model instead of
                stopping, and &quot;off&quot; turns loop protection off, for
                future sessions. &quot;model.skipLoopDetection&quot; disables
                only the heuristic loop checks. The tool-call budget is tunable
                via &quot;model.maxToolCallsPerTurn&quot; (0 disables it).
                Disabling for this session above suppresses everything.
              </Text>
            </Box>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

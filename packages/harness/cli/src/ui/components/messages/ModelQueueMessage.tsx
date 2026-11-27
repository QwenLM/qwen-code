/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import type { ModelQueueProps } from '../../types.js';
import { theme } from '../../semantic-colors.js';
import {
  formatEstimatedQueueWait,
  getModelQueueBarWidth,
} from '../../utils/modelQueueDisplay.js';
import { CliSpinner } from '../CliSpinner.js';
import { ProgressBar } from '../ProgressBar.js';
import { PrefixedMessage } from './PrefixedMessage.js';
import { INDENT } from '../../constants/messageLayout.js';

export interface ModelQueueMessageProps {
  modelQueue: ModelQueueProps;
  terminalWidth: number;
}

function buildDetails(modelQueue: ModelQueueProps): string {
  const details: string[] = [];
  if (modelQueue.status === 'queued') {
    const estimatedWait = formatEstimatedQueueWait(modelQueue.waitTimeMs);
    if (estimatedWait) details.push(estimatedWait);
  }
  return details.join(', ');
}

export function ModelQueueMessage({
  modelQueue,
  terminalWidth,
}: ModelQueueMessageProps): React.JSX.Element {
  const isReady = modelQueue.status === 'ready';
  const title = isReady
    ? 'Model is available, continuing request'
    : 'Model request queued';
  const details = buildDetails(modelQueue);
  const prefixNode = isReady ? (
    <Text color={theme.status.success}>✓</Text>
  ) : (
    <CliSpinner type="dots" />
  );
  return (
    <PrefixedMessage
      prefix={prefixNode}
      prefixWidth={INDENT.PREFIX_WIDTH_STANDARD}
    >
      <Box flexDirection="column">
        <Text
          color={
            isReady
              ? theme.status.success
              : theme.text.accent
          }
        >
          {title}
        </Text>
        {!isReady && (
          <ProgressBar
            value={modelQueue.progress}
            width={getModelQueueBarWidth(terminalWidth, 32)}
            label="moving"
            activeColor={theme.text.accent}
            inactiveColor={theme.ui.dark}
            activeChar="█"
            inactiveChar="░"
          />
        )}
        {details && (
          <Text color={theme.text.secondary}>{details}</Text>
        )}
      </Box>
    </PrefixedMessage>
  );
}

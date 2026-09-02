/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useRef } from 'react';
import { Box, Text } from 'ink';
import { t } from '../../i18n/index.js';

const MAX_DISPLAYED_QUEUED_MESSAGES = 3;
const NUM_TIMES_QUEUE_HINT_SHOWN = 3;

export interface QueuedMessageDisplayProps {
  messageQueue: readonly string[];
  showHint?: boolean;
}

export const QueuedMessageDisplay = ({
  messageQueue,
  showHint: hintEnabled = true,
}: QueuedMessageDisplayProps) => {
  // Track how many times the edit hint has been shown (per session).
  // Once the user has seen it enough times, hide it.
  const hintSeenCountRef = useRef(0);
  const wasEmptyRef = useRef(true);

  if (messageQueue.length === 0) {
    wasEmptyRef.current = true;
    return null;
  }

  // Increment counter only on queue transition from empty → non-empty
  // (not on every re-render while queue stays non-empty).
  if (wasEmptyRef.current) {
    hintSeenCountRef.current++;
    wasEmptyRef.current = false;
  }

  const shouldShowHint = hintSeenCountRef.current <= NUM_TIMES_QUEUE_HINT_SHOWN;

  return (
    <Box flexDirection="column" marginTop={1}>
      {messageQueue
        .slice(0, MAX_DISPLAYED_QUEUED_MESSAGES)
        .map((message, index) => {
          const preview = message.replace(/\s+/g, ' ');

          return (
            <Box key={index} paddingLeft={2} width="100%">
              <Text dimColor wrap="truncate">
                {preview}
              </Text>
            </Box>
          );
        })}
      {messageQueue.length > MAX_DISPLAYED_QUEUED_MESSAGES && (
        <Box paddingLeft={2}>
          <Text dimColor>
            ... (+
            {messageQueue.length - MAX_DISPLAYED_QUEUED_MESSAGES} more)
          </Text>
        </Box>
      )}
      {hintEnabled && shouldShowHint && (
        <Box paddingLeft={2}>
          <Text dimColor italic>
            {t('Ctrl+Q to queue · ↑ to edit queued messages')}
          </Text>
        </Box>
      )}
    </Box>
  );
};

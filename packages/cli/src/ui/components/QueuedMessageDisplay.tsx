/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';

const MAX_DISPLAYED_QUEUED_MESSAGES = 3;

export interface QueuedMessageDisplayProps {
  messageQueue: readonly string[];
}

export const QueuedMessageDisplay = ({
  messageQueue,
}: QueuedMessageDisplayProps) => {
  if (messageQueue.length === 0) {
    return null;
  }

  const count = messageQueue.length;
  const label = count === 1 ? '1 message queued' : `${count} messages queued`;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box paddingLeft={2}>
        <Text color="yellow" bold>
          {label}
        </Text>
        <Text dimColor> — will be seen at next tool call</Text>
      </Box>
      {messageQueue
        .slice(0, MAX_DISPLAYED_QUEUED_MESSAGES)
        .map((message, index) => {
          const preview = message.replace(/\s+/g, ' ');

          return (
            <Box key={index} paddingLeft={4} width="100%">
              <Text dimColor wrap="truncate">
                {index + 1}. {preview}
              </Text>
            </Box>
          );
        })}
      {count > MAX_DISPLAYED_QUEUED_MESSAGES && (
        <Box paddingLeft={4}>
          <Text dimColor>
            ... (+{count - MAX_DISPLAYED_QUEUED_MESSAGES} more)
          </Text>
        </Box>
      )}
    </Box>
  );
};

/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box } from 'ink';
import type { Config } from '@qwen-code/core';
import { QueuedMessageDisplay } from './QueuedMessageDisplay.js';
import { StashedPromptNotice } from './StashedPromptNotice.js';
import { TodoTray } from './messages/Todo.js';

interface ComposerActivityTrayProps {
  config: Config;
  messageQueue: string[];
  sendNowHint?: string;
  showUiDetails: boolean;
  hasStash: boolean;
}

/**
 * Composer-owned work horizon. Sections retain their own interaction and
 * lifecycle semantics while sharing one stable location above StatusRow.
 */
export const ComposerActivityTray: React.FC<ComposerActivityTrayProps> = ({
  config,
  messageQueue,
  sendNowHint,
  showUiDetails,
  hasStash,
}) => (
  <Box width="100%" flexDirection="column" flexGrow={0} flexShrink={0}>
    {showUiDetails && (
      <QueuedMessageDisplay
        messageQueue={messageQueue}
        sendNowHint={sendNowHint}
      />
    )}
    {showUiDetails && <StashedPromptNotice hasStash={hasStash} />}
    {showUiDetails && <TodoTray config={config} />}
  </Box>
);

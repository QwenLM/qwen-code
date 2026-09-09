/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { MAX_CHANNEL_CONTROL_WORKSPACES } from '@qwen-code/acp-bridge/channelControlTimeouts';

export class ChannelControlWorkspaceLimitError extends Error {
  readonly code = 'channel_control_workspace_limit_reached';

  constructor() {
    super(
      `Channel control supports at most ${MAX_CHANNEL_CONTROL_WORKSPACES} workspace owners, ` +
        'including retained recovery owners. Stop channels on an existing owner before enabling a new owner.',
    );
    this.name = 'ChannelControlWorkspaceLimitError';
  }
}

export function assertChannelControlWorkspaceCapacity(
  workspaceCwds: Iterable<string>,
): void {
  if (new Set(workspaceCwds).size > MAX_CHANNEL_CONTROL_WORKSPACES) {
    throw new ChannelControlWorkspaceLimitError();
  }
}

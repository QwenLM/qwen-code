/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { MAX_CHANNEL_CONTROL_WORKSPACES } from '@qwen-code/acp-bridge/channelControlTimeouts';

export class ChannelControlWorkspaceLimitError extends Error {
  readonly code = 'channel_control_workspace_limit_reached';

  constructor() {
    // Some call sites bound only the requested owner set, and the boot check
    // runs before any worker exists — so this message must not assert that
    // retained owners were counted, nor that stopping a worker can help.
    super(
      `Channel control supports at most ${MAX_CHANNEL_CONTROL_WORKSPACES} workspace owners; ` +
        'a transition also counts owners retained for recovery. Narrow the channel ' +
        'selection or reduce the number of channel-owning workspaces; for a runtime ' +
        'transition at capacity, successfully stop the channels on an existing owner ' +
        'before enabling a new one.',
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

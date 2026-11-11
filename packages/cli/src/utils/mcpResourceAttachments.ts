/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  MCPServerStatus,
  type AttachmentExternalContext,
  type Config,
} from '@qwen-code/core';

/** Called explicitly by hosts that support user-authored @server:uri mentions. */
export function createMcpResourceAttachmentSource(
  config: Config,
): NonNullable<AttachmentExternalContext['mcpResources']> {
  const manager = () => config.getMcpClientManager();
  return {
    findResource: (identifier) => manager()?.findResourceByUri(identifier),
    canUseServer: (serverName) =>
      config.getMcpClientManager()?.canUseMcpServer(serverName) ?? true,
    readResource: async (serverName, uri, signal) => {
      const client = manager()?.getClient(serverName);
      if (client?.getStatus() !== MCPServerStatus.CONNECTED) return undefined;
      return client.readResource(uri, { signal });
    },
  };
}

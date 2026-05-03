/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * useMCPHealth — subscribes to MCP server status changes from
 * `mcp-client`'s module-level listener API and re-renders consumers
 * with up-to-date counts. The Footer MCP health pill is the primary
 * consumer; the hook intentionally exposes raw counts (not just a
 * formatted label) so future surfaces (boot screen, tooltips) can
 * derive their own presentation.
 */

import { useEffect, useState } from 'react';
import {
  MCPServerStatus,
  addMCPStatusChangeListener,
  removeMCPStatusChangeListener,
  getAllMCPServerStatuses,
} from '@qwen-code/qwen-code-core';

export interface MCPHealthSnapshot {
  /** Total servers tracked by the registry (configured + discovered). */
  totalCount: number;
  /** Servers currently in `DISCONNECTED` — usually means failed connect / lost link. */
  disconnectedCount: number;
  /** Servers in mid-handshake. Often transient during boot or reconnect. */
  connectingCount: number;
  /** Servers currently `CONNECTED`. */
  connectedCount: number;
}

export function useMCPHealth(): MCPHealthSnapshot {
  const [servers, setServers] = useState<Map<string, MCPServerStatus>>(
    () => new Map(getAllMCPServerStatuses()),
  );

  useEffect(() => {
    const listener = (name: string, status: MCPServerStatus) => {
      setServers((prev) => {
        const next = new Map(prev);
        next.set(name, status);
        return next;
      });
    };
    addMCPStatusChangeListener(listener);
    // Resync once on mount in case the registry transitioned between
    // the initial snapshot capture and listener attachment.
    setServers(new Map(getAllMCPServerStatuses()));
    return () => removeMCPStatusChangeListener(listener);
  }, []);

  let disconnectedCount = 0;
  let connectingCount = 0;
  let connectedCount = 0;
  for (const status of servers.values()) {
    if (status === MCPServerStatus.DISCONNECTED) disconnectedCount++;
    else if (status === MCPServerStatus.CONNECTING) connectingCount++;
    else if (status === MCPServerStatus.CONNECTED) connectedCount++;
  }

  return {
    totalCount: servers.size,
    disconnectedCount,
    connectingCount,
    connectedCount,
  };
}

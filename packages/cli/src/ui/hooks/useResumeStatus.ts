/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { I18nService } from '@qwen-code/core';

import { useEffect, useState } from 'react';
import {
  CoreEvent,
  coreEvents,
  type McpClient,
  MCPServerStatus,
} from '@qwen-code/core';
import { useI18nService } from '../i18n/index.js';

const MAX_DISPLAYED_WAITING_SERVERS = 3;

interface McpConnectionSnapshot {
  connected: number;
  total: number;
  connecting: string[];
}

function snapshotMcpConnection(
  clients: Map<string, McpClient>,
): McpConnectionSnapshot {
  let connected = 0;
  const connecting: string[] = [];

  for (const [name, client] of clients.entries()) {
    if (client.getStatus() === MCPServerStatus.CONNECTED) {
      connected += 1;
    } else {
      connecting.push(name);
    }
  }

  return { connected, total: clients.size, connecting };
}

function formatMcpConnectionStatus(
  snapshot: McpConnectionSnapshot,
  t: I18nService['get'],
): string {
  const progress = t('status.mcp.connecting', {
    connected: snapshot.connected,
    total: snapshot.total,
  });
  if (snapshot.connecting.length === 0) {
    return progress;
  }

  const displayedServers = snapshot.connecting
    .slice(0, MAX_DISPLAYED_WAITING_SERVERS)
    .join(', ');
  const remaining = snapshot.connecting.length - MAX_DISPLAYED_WAITING_SERVERS;
  const suffix =
    remaining > 0 ? t('status.mcp.more', { count: remaining }) : '';
  return t('status.mcp.waiting', {
    progress,
    servers: displayedServers,
    suffix,
  });
}

/**
 * Projects resume-time MCP initialization into the foreground status lane.
 * The event subscription only exists while a session is actively resuming.
 */
export function useResumeStatus(active: boolean): string {
  const i18n = useI18nService();
  const [mcpSnapshot, setMcpSnapshot] = useState<McpConnectionSnapshot | null>(
    null,
  );

  useEffect(() => {
    setMcpSnapshot(null);
    if (!active) {
      return;
    }

    const onChange = (payload?: { clients?: Map<string, McpClient> }) => {
      const clients = payload?.clients;
      setMcpSnapshot(
        clients && clients.size > 0 ? snapshotMcpConnection(clients) : null,
      );
    };

    coreEvents.on(CoreEvent.McpClientUpdate, onChange);
    return () => {
      coreEvents.off(CoreEvent.McpClientUpdate, onChange);
    };
  }, [active]);

  const resumeStatus = i18n.get('status.resume.session');
  return mcpSnapshot
    ? i18n.get('status.resume.withMcp', {
        resume: resumeStatus,
        status: formatMcpConnectionStatus(mcpSnapshot, i18n.get),
      })
    : resumeStatus;
}

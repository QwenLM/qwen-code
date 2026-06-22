/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { appEvents } from '../../utils/events.js';
import { type McpClient, MCPServerStatus } from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';

// Tracks MCP connection progress. Returns the current status string while
// config is initializing, or `null` once complete so callers can fall
// through to their default content.
export function useConfigInitMessage(
  isConfigInitialized: boolean,
): string | null {
  const [message, setMessage] = useState<string>(() => t('Initializing...'));

  useEffect(() => {
    if (isConfigInitialized) {
      return;
    }

    const onChange = (clients?: Map<string, McpClient>) => {
      if (!clients || clients.size === 0) {
        setMessage(t('Initializing...'));
        return;
      }
      let connected = 0;
      for (const client of clients.values()) {
        if (client.getStatus() === MCPServerStatus.CONNECTED) {
          connected++;
        }
      }
      setMessage(
        t('Connecting to MCP servers... ({{connected}}/{{total}})', {
          connected: String(connected),
          total: String(clients.size),
        }),
      );
    };

    appEvents.on('mcp-client-update', onChange);
    return () => {
      appEvents.off('mcp-client-update', onChange);
    };
  }, [isConfigInitialized]);

  // Gating on isConfigInitialized (rather than clearing state from the effect)
  // ensures the first render that flips to initialized returns null without
  // a transient frame still showing the old message.
  return isConfigInitialized ? null : message;
}

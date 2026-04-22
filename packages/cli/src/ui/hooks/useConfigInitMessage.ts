/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { appEvents } from '../../utils/events.js';
import { type McpClient, MCPServerStatus } from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';

/**
 * Returns a human-readable initialization status message while config is
 * being initialized (MCP servers connecting, etc.). Returns `null` once
 * initialization is complete so the caller can fall through to its
 * default content.
 *
 * Rendered inline (e.g. in the Footer's left-bottom status slot) instead
 * of as a standalone component, so the live area's height stays constant
 * across the init → ready transition and no residual blank rows remain
 * in the terminal scrollback.
 */
export function useConfigInitMessage(
  isConfigInitialized: boolean,
): string | null {
  const [message, setMessage] = useState<string | null>(
    isConfigInitialized ? null : t('Initializing...'),
  );

  useEffect(() => {
    if (isConfigInitialized) {
      setMessage(null);
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

  return message;
}

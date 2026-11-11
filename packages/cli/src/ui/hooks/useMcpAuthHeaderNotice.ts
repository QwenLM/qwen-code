/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { runLogger, type Config } from '@qwen-code/core';

export function buildMcpAuthNotice(serverCount: number): string | null {
  if (serverCount <= 0) return null;
  return serverCount === 1
    ? '1 MCP server needs authentication · run /mcp'
    : `${serverCount} MCP servers need authentication · run /mcp`;
}

export function shouldEnableMcpAuthHeaderNotice(
  isConfigInitialized: boolean,
  hasSessionBinding: boolean,
): boolean {
  return isConfigInitialized && !hasSessionBinding;
}

/**
 * Keeps the first notice hidden until the complete configured + plugin MCP
 * initialization batch settles. After that one-time gate opens, the text stays
 * reactive to the count supplied by useMcpStatus.
 */
export function useMcpAuthHeaderNotice(
  config: Config,
  enabled: boolean,
  serverCount: number,
): string | null {
  const [settledConfig, setSettledConfig] = useState<Config | null>(null);

  useEffect(() => {
    // AppContainer renders before Config.initialize() creates the initial MCP
    // promise. The enabled flag opens only after config initialization.
    if (!enabled) return;

    let cancelled = false;

    const waitForInitialMcpBatch = async () => {
      try {
        await config.waitForMcpInit();
      } catch (error) {
        if (!cancelled) {
          runLogger.warn(
            '[MCP] Failed to initialize the authentication notice:',
            error instanceof Error ? error.message : String(error),
          );
        }
        return;
      }

      if (!cancelled) {
        setSettledConfig(config);
      }
    };

    void waitForInitialMcpBatch();
    return () => {
      cancelled = true;
    };
  }, [config, enabled]);

  if (!enabled || settledConfig !== config) return null;
  return buildMcpAuthNotice(serverCount);
}

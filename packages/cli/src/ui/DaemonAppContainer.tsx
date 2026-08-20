/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Daemon-client entry for the TUI (terminal↔mobile handoff). Attaches to an
 * already-running `qwen serve` daemon and renders the SAME rich `<AppContainer>`
 * shell, but driven by `useDaemonStreamAdapter` instead of the in-process
 * `useGeminiStream` (B-prime). The normal `qwen` path is untouched.
 *
 * The render is gated on attach: `useDaemonStream` needs `driver.clientId` set
 * at mount, so we hold a placeholder until `createOrAttach` resolves.
 */
import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { DaemonClient, DaemonSessionClient } from '@qwen-code/sdk';
import { AppContainer } from './AppContainer.js';
import { DaemonStreamContext } from './hooks/daemon/DaemonStreamContext.js';
import { useDaemonStreamAdapter } from './hooks/daemon/useDaemonStreamAdapter.js';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../config/settings.js';
import type { ExtensionRefreshState } from '../config/extension-refresh-state.js';
import type { InitializationResult } from '../core/initializer.js';

export interface DaemonAppContainerProps {
  config: Config;
  settings: LoadedSettings;
  startupWarnings?: string[];
  version: string;
  initializationResult: InitializationResult;
  initialUseVirtualViewport?: boolean;
  extensionRefreshState?: ExtensionRefreshState;
  repaintViewport?: () => void;
  daemonUrl: string;
  daemonToken: string;
}

export const DaemonAppContainer = (props: DaemonAppContainerProps) => {
  const { daemonUrl, daemonToken, ...appProps } = props;
  const [driver, setDriver] = useState<DaemonSessionClient | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const client = new DaemonClient({
          baseUrl: daemonUrl,
          token: daemonToken,
        });
        // Omit workspaceCwd → attach to the daemon's bound workspace session.
        const session = await DaemonSessionClient.createOrAttach(client, {});
        if (!cancelled) setDriver(session);
      } catch (e) {
        if (!cancelled) setError((e as Error)?.message ?? String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [daemonUrl, daemonToken]);

  if (error) {
    return (
      <Box flexDirection="column" marginX={1}>
        <Text color="red">Failed to attach to daemon at {daemonUrl}:</Text>
        <Text color="red">{error}</Text>
      </Box>
    );
  }

  if (!driver) {
    return (
      <Box marginX={1}>
        <Text>Attaching to daemon at {daemonUrl}…</Text>
      </Box>
    );
  }

  return (
    <DaemonStreamContext.Provider value={driver}>
      <AppContainer {...appProps} useStream={useDaemonStreamAdapter} />
    </DaemonStreamContext.Provider>
  );
};

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useState } from 'react';
import { render, Box, useApp } from 'ink';
import {
  SessionService,
  type Config,
  type SessionListItem,
} from '@qwen-code/qwen-code-core';
import { KeypressProvider } from '../../contexts/KeypressContext.js';
import { ConfigContext } from '../../contexts/ConfigContext.js';
import { SettingsContext } from '../../contexts/SettingsContext.js';
import type { LoadedSettings } from '../../../config/settings.js';
import { FleetView } from './FleetView.js';
import type {
  FleetSessionEntry,
  FleetSessionStatus,
} from '../../contexts/FleetViewContext.js';
import { TerminalOutputProvider } from '../../contexts/TerminalOutputContext.js';

const STUB_CONFIG = {
  getShouldUseNodePtyShell: () => false,
  getIdeMode: () => false,
  isTrustedFolder: () => false,
  getToolRegistry: () => ({ getTool: () => undefined }),
  getContentGenerator: () => ({ useSummarizedThinking: () => false }),
} as unknown as Config;

const STUB_SETTINGS = {
  merged: { ui: {} },
} as unknown as LoadedSettings;

function toFleetEntry(item: SessionListItem): FleetSessionEntry {
  const displayName =
    item.customTitle ||
    (item.prompt
      ? item.prompt.length > 60
        ? item.prompt.slice(0, 57) + '...'
        : item.prompt
      : item.sessionId.slice(0, 8));
  return {
    ...item,
    status: 'idle' as FleetSessionStatus,
    displayName,
  };
}

interface StandaloneFleetViewScreenProps {
  sessionService: SessionService;
  workspaceCwd: string;
  onSelect: (sessionId: string) => void;
  onCancel: () => void;
}

function StandaloneFleetViewScreen({
  sessionService,
  workspaceCwd,
  onSelect,
  onCancel,
}: StandaloneFleetViewScreenProps): React.JSX.Element {
  const { exit } = useApp();
  const [isExiting, setIsExiting] = useState(false);
  const [sessions, setSessions] = useState<FleetSessionEntry[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [groupMode, setGroupMode] = useState<'state' | 'directory'>('state');

  const fetchSessions = useCallback(async () => {
    try {
      setLoading(true);
      const result = await sessionService.listSessions({ size: 100 });
      setSessions(result.items.map(toFleetEntry));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [sessionService]);

  // Initial fetch
  useEffect(() => {
    void fetchSessions();
  }, [fetchSessions]);

  const handleExit = useCallback(() => {
    setIsExiting(true);
    onCancel();
    exit();
  }, [exit, onCancel]);

  if (isExiting) {
    return <Box />;
  }

  return (
    <ConfigContext.Provider value={STUB_CONFIG}>
      <SettingsContext.Provider value={STUB_SETTINGS}>
        <FleetView
          sessions={sessions}
          selectedIndex={selectedIndex}
          loading={loading}
          error={error}
          groupMode={groupMode}
          onSelect={setSelectedIndex}
          onAttach={(sessionId) => {
            onSelect(sessionId);
            setIsExiting(true);
            exit();
          }}
          onClose={handleExit}
          onDelete={(sessionId) => {
            void sessionService.removeSession(sessionId).then(() => {
              void fetchSessions();
            });
          }}
          onCreateNew={handleExit}
          onCycleGroupMode={() =>
            setGroupMode((prev) => (prev === 'state' ? 'directory' : 'state'))
          }
          workspaceCwd={workspaceCwd}
          sessionService={sessionService}
          onRefresh={() => void fetchSessions()}
        />
      </SettingsContext.Provider>
    </ConfigContext.Provider>
  );
}

export async function showStandaloneFleetView(
  cwd: string,
): Promise<string | null> {
  const sessionService = new SessionService(cwd);

  return new Promise<string | null>((resolve) => {
    let selectedId: string | null = null;

    const instance = render(
      <TerminalOutputProvider value={(data) => process.stdout.write(data)}>
        <KeypressProvider kittyProtocolEnabled={false}>
          <StandaloneFleetViewScreen
            sessionService={sessionService}
            workspaceCwd={cwd}
            onSelect={(id) => {
              selectedId = id;
            }}
            onCancel={() => {
              selectedId = null;
            }}
          />
        </KeypressProvider>
      </TerminalOutputProvider>,
    );

    instance.waitUntilExit().then(
      () => resolve(selectedId),
      () => resolve(null),
    );
  });
}

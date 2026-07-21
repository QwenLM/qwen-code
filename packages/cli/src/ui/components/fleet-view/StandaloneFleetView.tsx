/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useState } from 'react';
import { render, Box, useApp } from 'ink';
import { SessionService } from '@qwen-code/qwen-code-core';
import { KeypressProvider } from '../../contexts/KeypressContext.js';
import { FleetView } from './FleetView.js';
import {
  toFleetEntry,
  type FleetSessionEntry,
} from '../../contexts/FleetViewContext.js';
import { TerminalOutputProvider } from '../../contexts/TerminalOutputContext.js';
import { SESSION_LIST_SIZE } from '../../hooks/use-fleet-view-sessions.js';

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
      const result = await sessionService.listSessions({
        size: SESSION_LIST_SIZE,
      });
      setSessions(result.items.map((item) => toFleetEntry(item, null)));
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
        void sessionService
          .removeSession(sessionId)
          .then(() => {
            void fetchSessions();
          })
          .catch(() => {
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
  );
}

export async function showStandaloneFleetView(
  cwd: string,
): Promise<string | null> {
  const sessionService = new SessionService(cwd);

  return new Promise<string | null>((resolve) => {
    let selectedId: string | null = null;

    const { unmount, waitUntilExit } = render(
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
      { exitOnCtrlC: false },
    );

    waitUntilExit().then(
      () => {
        unmount();
        resolve(selectedId);
      },
      () => {
        unmount();
        resolve(null);
      },
    );
  });
}

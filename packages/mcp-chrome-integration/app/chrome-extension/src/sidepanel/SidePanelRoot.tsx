/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Side panel root + daemon connection gate (issue #5626).
 *
 * On mount it probes the local `qwen serve` daemon's `/health` endpoint. When
 * the daemon is reachable it mounts the `<DaemonSessionProvider>` (which owns
 * connect / session-create / SSE / reconnect) around the chat `<App>`. When it
 * is not reachable it shows a short "run `qwen serve`" hint with a Retry button
 * instead of a broken chat.
 */

import type { FC } from 'react';
import { useEffect, useRef, useState } from 'react';
import { DaemonSessionProvider } from '@qwen-code/webui/daemon-react-sdk';
import { App } from './App.js';
import { getDaemonConfig, type DaemonConfig } from '../daemon/config.js';
import { checkDaemonHealth } from '../daemon/discovery.js';

type GateState =
  | { phase: 'checking' }
  | { phase: 'ready'; config: DaemonConfig }
  | { phase: 'unreachable'; config: DaemonConfig; error: string };

export const SidePanelRoot: FC = () => {
  const [state, setState] = useState<GateState>({ phase: 'checking' });
  // Bumped by Retry to re-run the health probe effect.
  const [probeNonce, setProbeNonce] = useState(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    setState({ phase: 'checking' });
    void (async () => {
      const config = await getDaemonConfig();
      const health = await checkDaemonHealth(config);
      if (!mountedRef.current) return;
      if (health.reachable) {
        setState({ phase: 'ready', config });
      } else {
        setState({ phase: 'unreachable', config, error: health.error });
      }
    })();
    return () => {
      mountedRef.current = false;
    };
  }, [probeNonce]);

  const probe = () => setProbeNonce((n) => n + 1);

  if (state.phase === 'ready') {
    return (
      <DaemonSessionProvider
        baseUrl={state.config.baseUrl}
        token={state.config.token}
        autoConnect
        autoReconnect
      >
        <App />
      </DaemonSessionProvider>
    );
  }

  return (
    <DaemonGate
      phase={state.phase}
      baseUrl={state.phase === 'checking' ? undefined : state.config.baseUrl}
      error={state.phase === 'unreachable' ? state.error : undefined}
      onRetry={probe}
    />
  );
};

interface DaemonGateProps {
  phase: 'checking' | 'unreachable';
  baseUrl?: string;
  error?: string;
  onRetry: () => void;
}

/** Connection placeholder shown while probing or when the daemon is down. */
const DaemonGate: FC<DaemonGateProps> = ({
  phase,
  baseUrl,
  error,
  onRetry,
}) => {
  return (
    <div className="flex flex-col h-screen bg-[#1e1e1e] text-white">
      <div className="flex items-center justify-between p-3 border-b border-gray-700">
        <h1 className="text-sm font-medium">Qwen Code</h1>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-gray-500" />
          <span className="text-xs text-gray-400">
            {phase === 'checking' ? 'Connecting…' : 'Disconnected'}
          </span>
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center p-6">
        {phase === 'checking' ? (
          <div className="flex flex-col items-center gap-3 text-gray-400">
            <div className="w-5 h-5 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm">Looking for the qwen serve daemon…</span>
          </div>
        ) : (
          <div className="max-w-sm w-full text-center space-y-4">
            <div className="text-sm font-medium text-gray-200">
              Can&apos;t reach the qwen serve daemon
            </div>
            <p className="text-xs text-gray-400 leading-relaxed">
              Start it from a terminal, then retry:
            </p>
            <pre className="text-left text-xs bg-[#2a2d2e] border border-gray-700 rounded p-2 overflow-x-auto">
              <code>qwen serve</code>
            </pre>
            {baseUrl && (
              <p className="text-[11px] text-gray-500 break-all">
                Looking at {baseUrl}
              </p>
            )}
            {error && (
              <p className="text-[11px] text-gray-600 break-words">{error}</p>
            )}
            <button
              onClick={onRetry}
              className="w-full py-2 px-4 bg-indigo-600 hover:bg-indigo-700 rounded text-white text-sm font-medium transition-colors"
            >
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

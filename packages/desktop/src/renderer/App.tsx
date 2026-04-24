/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useState } from 'react';
import {
  loadDesktopStatus,
  type DesktopConnectionStatus,
} from './api/client.js';

type LoadState =
  | { state: 'loading' }
  | { state: 'ready'; status: DesktopConnectionStatus }
  | { state: 'error'; message: string };

export function App() {
  const [loadState, setLoadState] = useState<LoadState>({ state: 'loading' });

  useEffect(() => {
    let disposed = false;

    const load = async () => {
      try {
        const status = await loadDesktopStatus();
        if (!disposed) {
          setLoadState({ state: 'ready', status });
        }
      } catch (error) {
        if (!disposed) {
          setLoadState({
            state: 'error',
            message:
              error instanceof Error
                ? error.message
                : 'Unable to reach desktop service.',
          });
        }
      }
    };

    void load();

    return () => {
      disposed = true;
    };
  }, []);

  const statusLabel = useMemo(() => {
    if (loadState.state === 'ready') {
      return 'Connected';
    }

    if (loadState.state === 'error') {
      return 'Offline';
    }

    return 'Starting';
  }, [loadState]);

  return (
    <main className="desktop-shell">
      <aside className="sidebar" aria-label="Sessions">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            Q
          </div>
          <div>
            <h1>Qwen Code</h1>
            <p>Desktop</p>
          </div>
        </div>

        <section className="sidebar-section">
          <h2>Workspace</h2>
          <div className="empty-row">No folder selected</div>
        </section>

        <section className="sidebar-section sidebar-section-fill">
          <h2>Sessions</h2>
          <div className="empty-row">No sessions</div>
        </section>
      </aside>

      <section className="workbench" aria-label="Workbench">
        <header className="topbar">
          <div>
            <p className="eyebrow">Local service</p>
            <h2>{statusLabel}</h2>
          </div>
          <StatusPill state={loadState.state} />
        </header>

        <div className="workspace-grid">
          <section className="panel panel-main">
            <div className="panel-header">
              <h3>Conversation</h3>
              <span>Idle</span>
            </div>
            <div className="conversation-empty">No session selected</div>
          </section>

          <section className="panel panel-side">
            <div className="panel-header">
              <h3>Runtime</h3>
            </div>
            <RuntimeDetails loadState={loadState} />
          </section>
        </div>
      </section>
    </main>
  );
}

function StatusPill({ state }: { state: LoadState['state'] }) {
  return <span className={`status-pill status-pill-${state}`}>{state}</span>;
}

function RuntimeDetails({ loadState }: { loadState: LoadState }) {
  if (loadState.state === 'loading') {
    return <div className="runtime-row muted">Checking service</div>;
  }

  if (loadState.state === 'error') {
    return <div className="runtime-row error-text">{loadState.message}</div>;
  }

  return (
    <dl className="runtime-details">
      <div>
        <dt>Server</dt>
        <dd>{loadState.status.serverUrl}</dd>
      </div>
      <div>
        <dt>Desktop</dt>
        <dd>{loadState.status.runtime.desktop.version}</dd>
      </div>
      <div>
        <dt>Platform</dt>
        <dd>
          {loadState.status.runtime.platform.type}-
          {loadState.status.runtime.platform.arch}
        </dd>
      </div>
      <div>
        <dt>Node</dt>
        <dd>{loadState.status.runtime.desktop.nodeVersion}</dd>
      </div>
      <div>
        <dt>ACP</dt>
        <dd>
          {loadState.status.runtime.cli.acpReady ? 'Ready' : 'Not started'}
        </dd>
      </div>
      <div>
        <dt>Health</dt>
        <dd>{loadState.status.health.uptimeMs} ms</dd>
      </div>
    </dl>
  );
}

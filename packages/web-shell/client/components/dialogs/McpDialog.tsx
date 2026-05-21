import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DaemonMcpRestartResult,
  DaemonWorkspaceMcpServerStatus,
  DaemonWorkspaceMcpStatus,
} from '@qwen-code/sdk/daemon';

interface McpDialogProps {
  loadStatus: () => Promise<DaemonWorkspaceMcpStatus>;
  restartServer: (serverName: string) => Promise<DaemonMcpRestartResult>;
  onClose: () => void;
}

function statusLabel(server: DaemonWorkspaceMcpServerStatus): string {
  if (server.disabled) {
    return server.disabledReason
      ? `disabled:${server.disabledReason}`
      : 'disabled';
  }
  return server.mcpStatus || 'unknown';
}

export function McpDialog({
  loadStatus,
  restartServer,
  onClose,
}: McpDialogProps) {
  const [status, setStatus] = useState<DaemonWorkspaceMcpStatus | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busyServer, setBusyServer] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const servers = status?.servers ?? [];
  const selected = servers[selectedIdx];

  const reload = useCallback(() => {
    setLoading(true);
    loadStatus()
      .then((next) => {
        setStatus(next);
        setMessage(null);
      })
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setLoading(false));
  }, [loadStatus]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (selectedIdx >= servers.length && servers.length > 0) {
      setSelectedIdx(servers.length - 1);
    }
  }, [selectedIdx, servers.length]);

  useEffect(() => {
    const el = listRef.current?.children[selectedIdx] as
      | HTMLElement
      | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  const budgetText = useMemo(() => {
    if (!status) return '';
    if (status.clientBudget === undefined)
      return `${status.clientCount ?? 0} clients`;
    return `${status.clientCount ?? 0}/${status.clientBudget} clients · ${status.budgetMode ?? 'off'}`;
  }, [status]);

  const handleRestart = useCallback(
    (serverName: string) => {
      setBusyServer(serverName);
      setMessage(null);
      restartServer(serverName)
        .then((result) => {
          if (result.restarted) {
            setMessage(
              `Restarted ${result.serverName} in ${result.durationMs}ms`,
            );
          } else {
            setMessage(`Skipped ${result.serverName}: ${result.reason}`);
          }
          reload();
        })
        .catch((error: unknown) => {
          setMessage(error instanceof Error ? error.message : String(error));
        })
        .finally(() => setBusyServer(null));
    },
    [reload, restartServer],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, Math.max(servers.length - 1, 0)));
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'r') {
        e.preventDefault();
        if (selected) handleRestart(selected.name);
      }
    };
    const timer = setTimeout(
      () => window.addEventListener('keydown', handler),
      50,
    );
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', handler);
    };
  }, [handleRestart, onClose, selected, servers.length]);

  return (
    <div className="resume-picker">
      <div className="resume-picker-header">
        <span className="resume-picker-title">MCP Servers</span>
        <span className="resume-picker-count">{budgetText}</span>
      </div>

      <div className="resume-picker-search">
        <span className="resume-picker-search-hint">
          {message ||
            (loading ? 'Loading MCP status...' : `${servers.length} servers`)}
        </span>
      </div>

      <div className="resume-picker-sep" />

      <div className="resume-picker-list" ref={listRef}>
        {!loading && servers.length === 0 && (
          <div className="resume-picker-empty">No MCP servers configured.</div>
        )}
        {servers.map((server, i) => (
          <div
            key={server.name}
            className={`resume-picker-item ${i === selectedIdx ? 'selected' : ''}`}
            onMouseEnter={() => setSelectedIdx(i)}
          >
            <div className="resume-picker-item-row">
              <span className="resume-picker-item-prefix">
                {i === selectedIdx ? '›' : ' '}
              </span>
              <span className="resume-picker-item-title">{server.name}</span>
              <span className="resume-picker-item-badge">
                {statusLabel(server)}
              </span>
            </div>
            <div className="resume-picker-item-meta">
              {server.transport}
              {server.extensionName ? ` · ${server.extensionName}` : ''}
              {server.description ? ` · ${server.description}` : ''}
            </div>
            {i === selectedIdx && (
              <button
                className="dialog-inline-button"
                disabled={busyServer === server.name || server.disabled}
                onClick={() => handleRestart(server.name)}
              >
                {busyServer === server.name ? 'Restarting...' : 'Restart'}
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="resume-picker-sep" />

      <div className="resume-picker-footer">
        ↑↓ to navigate · r to restart · Esc to close
      </div>
    </div>
  );
}

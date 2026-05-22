import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DaemonWorkspaceToolStatus,
  DaemonWorkspaceToolsStatus,
} from '@qwen-code/sdk/daemon';
import { useDelayedGlobalKeyDown } from '../../hooks/useDelayedGlobalKeyDown';

interface ToolsDialogProps {
  showDescriptions: boolean;
  loadStatus: () => Promise<DaemonWorkspaceToolsStatus>;
  setToolEnabled: (toolName: string, enabled: boolean) => Promise<unknown>;
  onClose: () => void;
}

function toolLabel(tool: DaemonWorkspaceToolStatus): string {
  return tool.displayName || tool.name;
}

export function ToolsDialog({
  showDescriptions,
  loadStatus,
  setToolEnabled,
  onClose,
}: ToolsDialogProps) {
  const [status, setStatus] = useState<DaemonWorkspaceToolsStatus | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busyTool, setBusyTool] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const tools = useMemo(() => status?.tools ?? [], [status?.tools]);
  const selected = tools[selectedIdx];

  const reload = useCallback(() => {
    setLoading(true);
    loadStatus()
      .then((next) => {
        setStatus(next);
        setMessage(next.errors?.[0]?.error ?? null);
      })
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setLoading(false));
  }, [loadStatus]);

  const handleToggle = useCallback(
    (tool: DaemonWorkspaceToolStatus) => {
      setBusyTool(tool.name);
      setMessage(null);
      setToolEnabled(tool.name, !tool.enabled)
        .then(() => reload())
        .catch((error: unknown) => {
          setMessage(error instanceof Error ? error.message : String(error));
        })
        .finally(() => setBusyTool(null));
    },
    [reload, setToolEnabled],
  );

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (selectedIdx >= tools.length && tools.length > 0) {
      setSelectedIdx(tools.length - 1);
    }
  }, [selectedIdx, tools.length]);

  useEffect(() => {
    const el = listRef.current?.children[selectedIdx] as
      | HTMLElement
      | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  useDelayedGlobalKeyDown(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, Math.max(tools.length - 1, 0)));
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'r') {
        e.preventDefault();
        reload();
        return;
      }
      if (e.key === 't' && selected) {
        e.preventDefault();
        handleToggle(selected);
      }
    },
    [handleToggle, onClose, reload, selected, tools.length],
  );

  const summary = useMemo(() => {
    if (!status) return '';
    const enabled = tools.filter((tool) => tool.enabled).length;
    return `${enabled}/${tools.length} enabled`;
  }, [status, tools]);

  return (
    <div className="resume-picker">
      <div className="resume-picker-header">
        <span className="resume-picker-title">Tools</span>
        <span className="resume-picker-count">{summary}</span>
      </div>

      <div className="resume-picker-search">
        <span className="resume-picker-search-hint">
          {message || (loading ? 'Loading tools...' : `${tools.length} tools`)}
        </span>
      </div>

      <div className="resume-picker-sep" />

      <div className="resume-picker-list" ref={listRef}>
        {!loading && tools.length === 0 && (
          <div className="resume-picker-empty">
            No built-in tools available. Open a session first.
          </div>
        )}
        {tools.map((tool, i) => (
          <div
            key={tool.name}
            className={`resume-picker-item ${i === selectedIdx ? 'selected' : ''}`}
            onMouseEnter={() => setSelectedIdx(i)}
          >
            <div className="resume-picker-item-row">
              <span className="resume-picker-item-prefix">
                {i === selectedIdx ? '›' : ' '}
              </span>
              <span className="resume-picker-item-title">
                {toolLabel(tool)}
              </span>
              <span className="resume-picker-item-badge">
                {tool.enabled ? 'enabled' : 'disabled'}
              </span>
            </div>
            {tool.displayName && tool.displayName !== tool.name && (
              <div className="resume-picker-item-meta">{tool.name}</div>
            )}
            {showDescriptions && tool.description && (
              <div className="dialog-detail">
                <div className="dialog-detail-body">{tool.description}</div>
              </div>
            )}
            {i === selectedIdx && (
              <button
                className="dialog-inline-button"
                disabled={busyTool === tool.name}
                onClick={() => handleToggle(tool)}
              >
                {busyTool === tool.name
                  ? 'Updating...'
                  : tool.enabled
                    ? 'Disable'
                    : 'Enable'}
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="resume-picker-sep" />

      <div className="resume-picker-footer">
        {selected
          ? `t to toggle ${toolLabel(selected)} · r to refresh · Esc to close`
          : 'r to refresh · Esc to close'}
      </div>
    </div>
  );
}

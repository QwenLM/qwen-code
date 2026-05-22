import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DaemonMcpRestartResult,
  DaemonWorkspaceMcpServerStatus,
  DaemonWorkspaceMcpStatus,
  DaemonWorkspaceMcpToolStatus,
  DaemonWorkspaceMcpToolsStatus,
} from '@qwen-code/sdk/daemon';
import { useDelayedGlobalKeyDown } from '../../hooks/useDelayedGlobalKeyDown';

interface McpDialogProps {
  loadStatus: () => Promise<DaemonWorkspaceMcpStatus>;
  loadTools: (serverName: string) => Promise<DaemonWorkspaceMcpToolsStatus>;
  restartServer: (serverName: string) => Promise<DaemonMcpRestartResult>;
  onClose: () => void;
}

type McpView = 'servers' | 'server' | 'tools' | 'tool';

interface ServerAction {
  label: string;
  hint?: string;
  disabled?: boolean;
  run: () => void;
}

function statusLabel(server: DaemonWorkspaceMcpServerStatus): string {
  if (server.disabled) {
    return server.disabledReason
      ? `disabled:${server.disabledReason}`
      : 'disabled';
  }
  return server.mcpStatus || 'unknown';
}

function sourceLabel(server: DaemonWorkspaceMcpServerStatus): string {
  return server.extensionName
    ? `Extension: ${server.extensionName}`
    : 'Settings';
}

function schemaSummary(schema: Record<string, unknown> | undefined): string[] {
  if (!schema) return ['No input schema.'];
  const lines: string[] = [];
  const properties =
    schema.properties &&
    typeof schema.properties === 'object' &&
    !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : undefined;
  const required = Array.isArray(schema.required)
    ? new Set(
        schema.required.filter(
          (item): item is string => typeof item === 'string',
        ),
      )
    : new Set<string>();

  if (!properties || Object.keys(properties).length === 0) {
    return [JSON.stringify(schema, null, 2)];
  }

  for (const [name, value] of Object.entries(properties)) {
    const shape =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const type = typeof shape.type === 'string' ? shape.type : 'value';
    const desc =
      typeof shape.description === 'string' && shape.description.length > 0
        ? ` - ${shape.description}`
        : '';
    lines.push(`${required.has(name) ? '*' : ' '} ${name}: ${type}${desc}`);
  }
  return lines;
}

export function McpDialog({
  loadStatus,
  loadTools,
  restartServer,
  onClose,
}: McpDialogProps) {
  const [status, setStatus] = useState<DaemonWorkspaceMcpStatus | null>(null);
  const [toolsByServer, setToolsByServer] = useState<
    Record<string, DaemonWorkspaceMcpToolsStatus>
  >({});
  const [view, setView] = useState<McpView>('servers');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [actionIdx, setActionIdx] = useState(0);
  const [toolIdx, setToolIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingTools, setLoadingTools] = useState<string | null>(null);
  const [busyServer, setBusyServer] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const servers = status?.servers ?? [];
  const selected = servers[selectedIdx];
  const selectedTools = selected
    ? (toolsByServer[selected.name]?.tools ?? [])
    : [];
  const selectedTool = selectedTools[toolIdx];

  const loadServerTools = useCallback(
    (serverName: string) => {
      setLoadingTools(serverName);
      loadTools(serverName)
        .then((next) => {
          setToolsByServer((cur) => ({ ...cur, [serverName]: next }));
          setMessage(next.errors?.[0]?.error ?? null);
        })
        .catch((error: unknown) => {
          setMessage(error instanceof Error ? error.message : String(error));
        })
        .finally(() => setLoadingTools(null));
    },
    [loadTools],
  );

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
    const activeIndex =
      view === 'server' ? actionIdx : view === 'tools' ? toolIdx : selectedIdx;
    const el = listRef.current?.children[activeIndex] as
      | HTMLElement
      | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [actionIdx, selectedIdx, toolIdx, view]);

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
          loadServerTools(serverName);
        })
        .catch((error: unknown) => {
          setMessage(error instanceof Error ? error.message : String(error));
        })
        .finally(() => setBusyServer(null));
    },
    [loadServerTools, reload, restartServer],
  );

  const openServer = useCallback(
    (server: DaemonWorkspaceMcpServerStatus) => {
      setView('server');
      setActionIdx(0);
      if (!toolsByServer[server.name]) {
        loadServerTools(server.name);
      }
    },
    [loadServerTools, toolsByServer],
  );

  const actions: ServerAction[] = useMemo(() => {
    if (!selected) return [];
    const toolStatus = toolsByServer[selected.name];
    const toolCount = toolStatus?.tools.length ?? 0;
    return [
      {
        label: 'View tools',
        hint:
          loadingTools === selected.name
            ? 'Loading...'
            : toolStatus
              ? `${toolCount} tools`
              : 'Load tool list',
        run: () => {
          setView('tools');
          setToolIdx(0);
          if (!toolStatus) loadServerTools(selected.name);
        },
      },
      {
        label: selected.disabled ? 'Enable' : 'Disable',
        hint: 'Not exposed by daemon yet',
        disabled: true,
        run: () =>
          setMessage('Daemon serve does not expose MCP enable/disable yet.'),
      },
      {
        label: 'Authenticate',
        hint: 'Not exposed by daemon yet',
        disabled: true,
        run: () =>
          setMessage('Daemon serve does not expose MCP authentication yet.'),
      },
      {
        label: selected.disabled ? 'Reconnect' : 'Restart',
        hint: selected.disabled ? 'Disabled server' : undefined,
        disabled: selected.disabled || busyServer === selected.name,
        run: () => handleRestart(selected.name),
      },
    ];
  }, [
    busyServer,
    handleRestart,
    loadServerTools,
    loadingTools,
    selected,
    toolsByServer,
  ]);

  useEffect(() => {
    if (actionIdx >= actions.length && actions.length > 0) {
      setActionIdx(actions.length - 1);
    }
  }, [actionIdx, actions.length]);

  useEffect(() => {
    if (toolIdx >= selectedTools.length && selectedTools.length > 0) {
      setToolIdx(selectedTools.length - 1);
    }
  }, [selectedTools.length, toolIdx]);

  useDelayedGlobalKeyDown(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (view === 'tool') setView('tools');
        else if (view === 'tools') setView('server');
        else if (view === 'server') setView('servers');
        else onClose();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        if (view === 'server') {
          setActionIdx((i) => Math.min(i + 1, Math.max(actions.length - 1, 0)));
        } else if (view === 'tools') {
          setToolIdx((i) =>
            Math.min(i + 1, Math.max(selectedTools.length - 1, 0)),
          );
        } else if (view === 'servers') {
          setSelectedIdx((i) =>
            Math.min(i + 1, Math.max(servers.length - 1, 0)),
          );
        }
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        if (view === 'server') setActionIdx((i) => Math.max(i - 1, 0));
        else if (view === 'tools') setToolIdx((i) => Math.max(i - 1, 0));
        else if (view === 'servers') setSelectedIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (view === 'servers' && selected) {
          openServer(selected);
        } else if (view === 'server') {
          actions[actionIdx]?.run();
        } else if (view === 'tools' && selectedTool) {
          setView('tool');
        }
        return;
      }
      if (e.key === 'r') {
        e.preventDefault();
        if (view === 'servers') reload();
        else if (selected && view === 'server') handleRestart(selected.name);
      }
    },
    [
      actionIdx,
      actions,
      handleRestart,
      onClose,
      openServer,
      reload,
      selected,
      selectedTool,
      selectedTools.length,
      servers.length,
      view,
    ],
  );

  return (
    <div className="resume-picker">
      <div className="resume-picker-header">
        <span className="resume-picker-title">
          {view === 'servers'
            ? 'MCP Servers'
            : view === 'tools'
              ? `${selected?.name ?? 'MCP'} Tools`
              : view === 'tool'
                ? selectedTool?.name
                : selected?.name}
        </span>
        <span className="resume-picker-count">{budgetText}</span>
      </div>

      <div className="resume-picker-search">
        <span className="resume-picker-search-hint">
          {message ||
            (loading
              ? 'Loading MCP status...'
              : view === 'servers'
                ? `${servers.length} servers`
                : loadingTools === selected?.name
                  ? 'Loading tools...'
                  : 'Enter to select')}
        </span>
      </div>

      <div className="resume-picker-sep" />

      {view === 'servers' && (
        <div className="resume-picker-list" ref={listRef}>
          {!loading && servers.length === 0 && (
            <div className="resume-picker-empty">
              No MCP servers configured.
            </div>
          )}
          {servers.map((server, i) => (
            <div
              key={server.name}
              className={`resume-picker-item ${i === selectedIdx ? 'selected' : ''}`}
              onClick={() => openServer(server)}
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
            </div>
          ))}
        </div>
      )}

      {view === 'server' && selected && (
        <div className="resume-picker-list" ref={listRef}>
          <div className="dialog-detail">
            <div>Status: {statusLabel(selected)}</div>
            <div>Source: {sourceLabel(selected)}</div>
            <div>Transport: {selected.transport}</div>
            <div>
              Tools:{' '}
              {loadingTools === selected.name
                ? 'loading'
                : `${toolsByServer[selected.name]?.tools.length ?? 0} tools`}
            </div>
            {selected.description && <div>{selected.description}</div>}
          </div>
          {actions.map((action, i) => (
            <div
              key={action.label}
              className={`resume-picker-item ${i === actionIdx ? 'selected' : ''} ${action.disabled ? 'disabled' : ''}`}
              onClick={() => {
                if (!action.disabled) action.run();
              }}
              onMouseEnter={() => setActionIdx(i)}
            >
              <span className="resume-picker-item-prefix">
                {i === actionIdx ? '›' : ' '}
              </span>
              <span className="resume-picker-item-title">{action.label}</span>
              {action.hint && (
                <span className="resume-picker-item-badge">{action.hint}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {view === 'tools' && selected && (
        <div className="resume-picker-list" ref={listRef}>
          {!loadingTools && selectedTools.length === 0 && (
            <div className="resume-picker-empty">No tools discovered.</div>
          )}
          {selectedTools.map((tool, i) => (
            <div
              key={tool.name}
              className={`resume-picker-item ${i === toolIdx ? 'selected' : ''}`}
              onClick={() => setView('tool')}
              onMouseEnter={() => setToolIdx(i)}
            >
              <div className="resume-picker-item-row">
                <span className="resume-picker-item-prefix">
                  {i === toolIdx ? '›' : ' '}
                </span>
                <span className="resume-picker-item-title">{tool.name}</span>
                <span className="resume-picker-item-badge">
                  {tool.isValid ? 'valid' : 'invalid'}
                </span>
              </div>
              <div className="resume-picker-item-meta">
                {tool.description || tool.invalidReason || 'No description'}
              </div>
            </div>
          ))}
        </div>
      )}

      {view === 'tool' && selectedTool && <ToolDetail tool={selectedTool} />}

      <div className="resume-picker-sep" />

      <div className="resume-picker-footer">
        {view === 'servers'
          ? '↑↓ navigate · Enter details · r refresh · Esc close'
          : '↑↓ navigate · Enter select · Esc back'}
      </div>
    </div>
  );
}

function ToolDetail({ tool }: { tool: DaemonWorkspaceMcpToolStatus }) {
  return (
    <div className="resume-picker-list">
      <div className="dialog-detail">
        <div>Name: {tool.name}</div>
        {tool.serverToolName && <div>Server tool: {tool.serverToolName}</div>}
        <div>
          Status: {tool.isValid ? 'valid' : tool.invalidReason || 'invalid'}
        </div>
        {tool.description && <div>Description: {tool.description}</div>}
      </div>
      <div className="dialog-detail">
        <div>Input schema</div>
        {schemaSummary(tool.schema).map((line, i) => (
          <div key={`${tool.name}-schema-${i}`}>{line}</div>
        ))}
      </div>
      {tool.annotations && (
        <div className="dialog-detail">
          <div>Annotations</div>
          <pre>{JSON.stringify(tool.annotations, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

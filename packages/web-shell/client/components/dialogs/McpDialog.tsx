import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dp } from './dialogStyles';
import type {
  DaemonMcpRestartResult,
  DaemonWorkspaceMcpServerStatus,
  DaemonWorkspaceMcpStatus,
} from '@qwen-code/sdk/daemon';
import { useDelayedGlobalKeyDown } from '../../hooks/useDelayedGlobalKeyDown';
import { useI18n } from '../../i18n';
import type {
  WebShellMcpToolStatus,
  WebShellMcpToolsStatus,
} from '../../hooks/useDaemonSession';

interface McpDialogProps {
  loadStatus: () => Promise<DaemonWorkspaceMcpStatus>;
  loadTools: (serverName: string) => Promise<WebShellMcpToolsStatus>;
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

function sourceLabel(
  server: DaemonWorkspaceMcpServerStatus,
  t: ReturnType<typeof useI18n>['t'],
): string {
  return server.extensionName
    ? t('mcp.extension', { name: server.extensionName })
    : t('mcp.settings');
}

function schemaSummary(
  schema: Record<string, unknown> | undefined,
  t: ReturnType<typeof useI18n>['t'],
): string[] {
  if (!schema) return [t('mcp.noSchema')];
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
  const { t } = useI18n();
  const [status, setStatus] = useState<DaemonWorkspaceMcpStatus | null>(null);
  const [toolsByServer, setToolsByServer] = useState<
    Record<string, WebShellMcpToolsStatus>
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
      return t('common.clients', { count: status.clientCount ?? 0 });
    return t('mcp.clientBudget', {
      count: status.clientCount ?? 0,
      budget: status.clientBudget,
      mode: status.budgetMode ?? 'off',
    });
  }, [status, t]);

  const handleRestart = useCallback(
    (serverName: string) => {
      setBusyServer(serverName);
      setMessage(null);
      restartServer(serverName)
        .then((result) => {
          if (result.restarted) {
            setMessage(
              t('mcp.restarted', {
                name: result.serverName,
                duration: result.durationMs,
              }),
            );
          } else {
            setMessage(
              t('mcp.restartSkipped', {
                name: result.serverName,
                reason: result.reason ?? '',
              }),
            );
          }
          reload();
          loadServerTools(serverName);
        })
        .catch((error: unknown) => {
          setMessage(error instanceof Error ? error.message : String(error));
        })
        .finally(() => setBusyServer(null));
    },
    [loadServerTools, reload, restartServer, t],
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
        label: t('mcp.action.tools'),
        hint:
          loadingTools === selected.name
            ? t('common.loading')
            : toolStatus
              ? `${toolCount} ${t('mcp.tools')}`
              : t('mcp.action.toolsHint'),
        run: () => {
          setView('tools');
          setToolIdx(0);
          if (!toolStatus) loadServerTools(selected.name);
        },
      },
      {
        label: selected.disabled
          ? t('tools.update.enable')
          : t('tools.update.disable'),
        hint: t('mcp.action.authHint'),
        disabled: true,
        run: () => setMessage(t('mcp.action.enableMessage')),
      },
      {
        label: t('mcp.action.auth'),
        hint: t('mcp.action.authHint'),
        disabled: true,
        run: () => setMessage(t('mcp.action.authMessage')),
      },
      {
        label: selected.disabled
          ? t('mcp.action.reconnect')
          : t('mcp.action.restart'),
        hint: selected.disabled ? t('mcp.action.authHint') : undefined,
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
    t,
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
        else if (selected && view === 'server' && busyServer !== selected.name)
          handleRestart(selected.name);
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
    <div className={dp('resume-picker')}>
      <div className={dp('resume-picker-header')}>
        <span className={dp('resume-picker-title')}>
          {view === 'servers'
            ? t('mcp.title')
            : view === 'tools'
              ? `${selected?.name ?? 'MCP'} ${t('mcp.tools')}`
              : view === 'tool'
                ? selectedTool?.name
                : selected?.name}
        </span>
        <span className={dp('resume-picker-count')}>{budgetText}</span>
      </div>

      <div className={dp('resume-picker-search')}>
        <span className={dp('resume-picker-search-hint')}>
          {message ||
            (loading
              ? t('mcp.loadingStatus')
              : view === 'servers'
                ? t('mcp.servers', { count: servers.length })
                : loadingTools === selected?.name
                  ? t('mcp.loadingTools')
                  : t('common.enterSelect'))}
        </span>
      </div>

      <div className={dp('resume-picker-sep')} />

      {view === 'servers' && (
        <div className={dp('resume-picker-list')} ref={listRef}>
          {!loading && servers.length === 0 && (
            <div className={dp('resume-picker-empty')}>{t('mcp.empty')}</div>
          )}
          {servers.map((server, i) => (
            <div
              key={server.name}
              className={dp(
                'resume-picker-item',
                i === selectedIdx ? 'selected' : undefined,
              )}
              onClick={() => openServer(server)}
              onMouseEnter={() => setSelectedIdx(i)}
            >
              <div className={dp('resume-picker-item-row')}>
                <span className={dp('resume-picker-item-prefix')}>
                  {i === selectedIdx ? '›' : ' '}
                </span>
                <span className={dp('resume-picker-item-title')}>
                  {server.name}
                </span>
                <span className={dp('resume-picker-item-badge')}>
                  {statusLabel(server)}
                </span>
              </div>
              <div className={dp('resume-picker-item-meta')}>
                {server.transport}
                {server.extensionName ? ` · ${server.extensionName}` : ''}
                {server.description ? ` · ${server.description}` : ''}
              </div>
            </div>
          ))}
        </div>
      )}

      {view === 'server' && selected && (
        <div className={dp('resume-picker-list')} ref={listRef}>
          <div className={dp('dialog-detail')}>
            <div>
              {t('mcp.status')}: {statusLabel(selected)}
            </div>
            <div>
              {t('mcp.source')}: {sourceLabel(selected, t)}
            </div>
            <div>
              {t('mcp.transport')}: {selected.transport}
            </div>
            <div>
              {t('mcp.tools')}:{' '}
              {loadingTools === selected.name
                ? t('common.loading')
                : `${toolsByServer[selected.name]?.tools.length ?? 0} ${t('mcp.tools')}`}
            </div>
            {selected.description && <div>{selected.description}</div>}
          </div>
          {actions.map((action, i) => (
            <div
              key={action.label}
              className={dp(
                'resume-picker-item',
                i === actionIdx ? 'selected' : undefined,
                action.disabled ? 'disabled' : undefined,
              )}
              onClick={() => {
                if (!action.disabled) action.run();
              }}
              onMouseEnter={() => setActionIdx(i)}
            >
              <span className={dp('resume-picker-item-prefix')}>
                {i === actionIdx ? '›' : ' '}
              </span>
              <span className={dp('resume-picker-item-title')}>
                {action.label}
              </span>
              {action.hint && (
                <span className={dp('resume-picker-item-badge')}>
                  {action.hint}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {view === 'tools' && selected && (
        <div className={dp('resume-picker-list')} ref={listRef}>
          {!loadingTools && selectedTools.length === 0 && (
            <div className={dp('resume-picker-empty')}>
              {t('mcp.emptyTools')}
            </div>
          )}
          {selectedTools.map((tool, i) => (
            <div
              key={tool.name}
              className={dp(
                'resume-picker-item',
                i === toolIdx ? 'selected' : undefined,
              )}
              onClick={() => setView('tool')}
              onMouseEnter={() => setToolIdx(i)}
            >
              <div className={dp('resume-picker-item-row')}>
                <span className={dp('resume-picker-item-prefix')}>
                  {i === toolIdx ? '›' : ' '}
                </span>
                <span className={dp('resume-picker-item-title')}>
                  {tool.name}
                </span>
                <span className={dp('resume-picker-item-badge')}>
                  {tool.isValid ? t('common.valid') : t('common.invalid')}
                </span>
              </div>
              <div className={dp('resume-picker-item-meta')}>
                {tool.description ||
                  tool.invalidReason ||
                  t('mcp.noDescription')}
              </div>
            </div>
          ))}
        </div>
      )}

      {view === 'tool' && selectedTool && <ToolDetail tool={selectedTool} />}

      <div className={dp('resume-picker-sep')} />

      <div className={dp('resume-picker-footer')}>
        {view === 'servers'
          ? t('dialog.footer.mcpServers')
          : t('dialog.footer.mcpSelect')}
      </div>
    </div>
  );
}

function ToolDetail({ tool }: { tool: WebShellMcpToolStatus }) {
  const { t } = useI18n();
  return (
    <div className={dp('resume-picker-list')}>
      <div className={dp('dialog-detail')}>
        <div>
          {t('mcp.name')}: {tool.name}
        </div>
        {tool.serverToolName && (
          <div>
            {t('mcp.serverTool')}: {tool.serverToolName}
          </div>
        )}
        <div>
          {t('mcp.status')}:{' '}
          {tool.isValid
            ? t('common.valid')
            : tool.invalidReason || t('common.invalid')}
        </div>
        {tool.description && (
          <div>
            {t('mcp.description')}: {tool.description}
          </div>
        )}
      </div>
      <div className={dp('dialog-detail')}>
        <div>{t('mcp.inputSchema')}</div>
        {schemaSummary(tool.schema, t).map((line, i) => (
          <div key={`${tool.name}-schema-${i}`}>{line}</div>
        ))}
      </div>
      {tool.annotations && (
        <div className={dp('dialog-detail')}>
          <div>{t('mcp.annotations')}</div>
          <pre>{JSON.stringify(tool.annotations, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DaemonWorkspaceActions,
  DaemonWorkspaceMcpServerStatus,
  DaemonWorkspaceMcpToolStatus,
  DaemonWorkspaceMcpToolsStatus,
} from '@qwen-code/webui/daemon-react-sdk';
import { useMcp } from '@qwen-code/webui/daemon-react-sdk';
import { useDelayedGlobalKeyDown } from '../../hooks/useDelayedGlobalKeyDown';
import { useI18n } from '../../i18n';
import { createSentinelSerializer } from '../../utils/sentinelMessage';
import styles from './McpStatusMessage.module.css';
const ACTIVE_EVENT = 'web-shell:mcp-panel-active';
const VISIBLE_TOOLS_COUNT = 10;

type DaemonWorkspaceMcpStatus = Awaited<
  ReturnType<DaemonWorkspaceActions['loadMcpStatus']>
>;

type McpPanelStep = 'servers' | 'server' | 'oauth' | 'tools' | 'tool';

type McpServerAction = {
  id:
    | 'view-tools'
    | 'reconnect'
    | 'enable'
    | 'disable'
    | 'authenticate'
    | 'clear-auth';
  label: string;
  disabled?: boolean;
};

type McpPanelActiveEvent = CustomEvent<{ id: string; active: boolean }>;

interface SerializedMcpStatusMessage {
  status: DaemonWorkspaceMcpStatus;
  toolsByServer: Record<string, DaemonWorkspaceMcpToolsStatus>;
  showDescriptions: boolean;
  showSchema: boolean;
  showTips: boolean;
}

const {
  serialize: serializeMcpStatusMessage,
  parse: parseRawMcpStatusMessage,
} = createSentinelSerializer<SerializedMcpStatusMessage>(
  'web-shell:mcp-status:v1:',
);

function parseMcpStatusMessage(
  content: string,
): SerializedMcpStatusMessage | null {
  const parsed = parseRawMcpStatusMessage(content);
  if (!parsed || !parsed.status) return null;
  return parsed;
}

export { serializeMcpStatusMessage, parseMcpStatusMessage };

function statusDisplay(
  server: DaemonWorkspaceMcpServerStatus,
  t: ReturnType<typeof useI18n>['t'],
): { icon: string; text: string; className: string } {
  if (server.disabled) {
    return {
      icon: '✗',
      text: t('mcp.status.disabled'),
      className: styles.error,
    };
  }
  switch (server.mcpStatus) {
    case 'connected':
      return {
        icon: '✓',
        text: t('mcp.status.connected'),
        className: styles.success,
      };
    case 'connecting':
      return {
        icon: '🔄',
        text: t('mcp.status.starting'),
        className: styles.warning,
      };
    case 'disconnected':
    default:
      return {
        icon: '🔴',
        text: t('mcp.status.disconnectedTitle'),
        className: styles.error,
      };
  }
}

function schemaObject(
  tool: DaemonWorkspaceMcpToolStatus,
): Record<string, unknown> | null {
  const schema = tool.schema as
    | {
        parametersJsonSchema?: unknown;
        parameters?: unknown;
      }
    | undefined;
  const content = schema?.parametersJsonSchema ?? schema?.parameters ?? schema;
  return content && typeof content === 'object'
    ? (content as Record<string, unknown>)
    : null;
}

function schemaContent(tool: DaemonWorkspaceMcpToolStatus): string {
  const schema = schemaObject(tool);
  return schema ? JSON.stringify(schema, null, 2) : '';
}

function serverGroupLabel(
  server: DaemonWorkspaceMcpServerStatus,
  t: ReturnType<typeof useI18n>['t'],
): string {
  return server.extensionName ? t('mcp.extensionMcp') : t('mcp.userMcp');
}

function sourceLabel(
  server: DaemonWorkspaceMcpServerStatus,
  t: ReturnType<typeof useI18n>['t'],
): string {
  if (server.source === 'project') return t('mcp.source.project');
  if (server.source === 'extension' || server.extensionName) {
    return t('mcp.source.extension');
  }
  return t('mcp.source.user');
}

function formatServerCommand(
  server: DaemonWorkspaceMcpServerStatus,
  t: ReturnType<typeof useI18n>['t'],
): string {
  const config = server.config;
  if (config?.httpUrl) return `${config.httpUrl} (http)`;
  if (config?.url) return `${config.url} (sse)`;
  if (config?.command) {
    const args = config.args?.join(' ') ?? '';
    return `${config.command} ${args} (stdio)`.trim();
  }
  return server.transport ? `(${server.transport})` : t('mcp.status.unknown');
}

function toolAnnotationText(
  tool: DaemonWorkspaceMcpToolStatus,
  t: ReturnType<typeof useI18n>['t'],
): string {
  const annotations = tool.annotations ?? {};
  const labels: string[] = [];
  if (annotations['destructiveHint'])
    labels.push(t('mcp.annotation.destructive'));
  if (annotations['readOnlyHint']) labels.push(t('mcp.annotation.readOnly'));
  if (annotations['openWorldHint']) labels.push(t('mcp.annotation.openWorld'));
  if (annotations['idempotentHint'])
    labels.push(t('mcp.annotation.idempotent'));
  return labels.join(', ');
}

function dispatchActive(id: string, active: boolean): void {
  window.dispatchEvent(
    new CustomEvent(ACTIVE_EVENT, { detail: { id, active } }),
  );
}

function extractErrorDetail(err: unknown): string {
  if (err && typeof err === 'object') {
    const body = (err as { body?: unknown }).body;
    if (body && typeof body === 'object') {
      const data = (body as { data?: unknown }).data;
      if (data && typeof data === 'object') {
        const details = (data as { details?: unknown }).details;
        if (typeof details === 'string' && details) return details;
      }
      const error = (body as { error?: unknown }).error;
      if (typeof error === 'string' && error) return error;
    }
    if (err instanceof Error && err.message) return err.message;
  }
  return String(err);
}

function oauthAuthMessage(
  serverName: string,
  t: ReturnType<typeof useI18n>['t'],
  detail?: string,
): string {
  return [
    `${t('mcp.oauth.server')}: ${serverName}`,
    '',
    t('mcp.oauth.starting', { name: serverName }),
    ...(detail ? ['', detail] : []),
  ].join('\n');
}

function requiredMarker(required: boolean, t: ReturnType<typeof useI18n>['t']) {
  return required ? t('mcp.required') : '';
}

function schemaSummary(
  tool: DaemonWorkspaceMcpToolStatus,
  t: ReturnType<typeof useI18n>['t'],
) {
  const schema = schemaObject(tool);
  const properties = schema?.['properties'];
  const required = Array.isArray(schema?.['required'])
    ? new Set(
        schema['required'].filter(
          (name): name is string => typeof name === 'string',
        ),
      )
    : new Set<string>();

  if (!properties || typeof properties !== 'object') {
    const raw = schemaContent(tool);
    return raw ? <pre className={styles.schema}>{raw}</pre> : null;
  }

  const entries = Object.entries(properties as Record<string, unknown>);
  if (entries.length === 0) return null;

  return (
    <div className={styles.parameters}>
      <div className={styles.sectionTitle}>{t('mcp.parameters')}</div>
      {entries.map(([name, param]) => {
        const details =
          param && typeof param === 'object'
            ? (param as Record<string, unknown>)
            : {};
        const type =
          typeof details['type'] === 'string' ? details['type'] : 'any';
        const description =
          typeof details['description'] === 'string'
            ? details['description']
            : '';
        return (
          <div key={name} className={styles.parameterRow}>
            {`• ${name}${requiredMarker(required.has(name), t)}: ${type}${
              description ? ` - ${description}` : ''
            }`}
          </div>
        );
      })}
    </div>
  );
}

export function McpStatusMessage({
  message,
}: {
  message: SerializedMcpStatusMessage;
}) {
  const { t } = useI18n();
  const mcp = useMcp({ autoLoad: false });
  const [localStatus, setLocalStatus] = useState(message.status);
  const [localToolsByServer, setLocalToolsByServer] = useState(
    message.toolsByServer,
  );
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const panelIdRef = useRef(`mcp-${Math.random().toString(36).slice(2)}`);
  const [isOpen, setIsOpen] = useState(true);
  const [step, setStep] = useState<McpPanelStep>('servers');
  const [selectedServerIndex, setSelectedServerIndex] = useState(0);
  const [selectedServerActionIndex, setSelectedServerActionIndex] = useState(0);
  const [selectedToolIndex, setSelectedToolIndex] = useState(0);
  const servers = useMemo(
    () => localStatus.servers ?? [],
    [localStatus.servers],
  );
  const selectedServer = servers[selectedServerIndex] ?? null;
  const selectedTools = useMemo(
    () =>
      selectedServer
        ? (localToolsByServer[selectedServer.name]?.tools ?? [])
        : [],
    [selectedServer, localToolsByServer],
  );
  const selectedTool = selectedTools[selectedToolIndex] ?? null;
  const toolScrollOffset = useMemo(() => {
    if (selectedTools.length <= VISIBLE_TOOLS_COUNT) return 0;
    if (selectedToolIndex < VISIBLE_TOOLS_COUNT - 1) return 0;
    return Math.min(
      selectedToolIndex - VISIBLE_TOOLS_COUNT + 1,
      selectedTools.length - VISIBLE_TOOLS_COUNT,
    );
  }, [selectedToolIndex, selectedTools.length]);
  const visibleTools = useMemo(
    () =>
      selectedTools.slice(
        toolScrollOffset,
        toolScrollOffset + VISIBLE_TOOLS_COUNT,
      ),
    [selectedTools, toolScrollOffset],
  );
  const connectingCount = servers.filter(
    (server) => !server.disabled && server.mcpStatus === 'connecting',
  ).length;

  const groupedServers = useMemo(() => {
    const groups: Array<{
      label: string;
      servers: DaemonWorkspaceMcpServerStatus[];
    }> = [];
    for (const server of servers) {
      const label = serverGroupLabel(server, t);
      const group = groups.find((candidate) => candidate.label === label);
      if (group) {
        group.servers.push(server);
      } else {
        groups.push({ label, servers: [server] });
      }
    }
    return groups;
  }, [servers, t]);

  const serverNameWidth = useMemo(() => {
    if (servers.length === 0) return 20;
    return Math.min(
      Math.max(...servers.map((server) => server.name.length)) + 2,
      35,
    );
  }, [servers]);

  const toolNameWidth = useMemo(() => {
    if (selectedTools.length === 0) return 30;
    return Math.min(
      Math.max(...selectedTools.map((tool) => tool.name.length)) + 2,
      50,
    );
  }, [selectedTools]);

  const serverActions = useMemo<McpServerAction[]>(() => {
    if (!selectedServer) return [];
    const actions: McpServerAction[] = [];
    if (!selectedServer.disabled && selectedTools.length > 0) {
      actions.push({ id: 'view-tools', label: t('mcp.action.tools') });
    }
    if (
      !selectedServer.disabled &&
      selectedServer.mcpStatus === 'disconnected'
    ) {
      actions.push({ id: 'reconnect', label: t('mcp.action.reconnect') });
    }
    actions.push({
      id: selectedServer.disabled ? 'enable' : 'disable',
      label: selectedServer.disabled
        ? t('mcp.action.enable')
        : t('mcp.action.disable'),
    });
    if (!selectedServer.disabled) {
      actions.push({
        id: 'authenticate',
        label: selectedServer.hasOAuthTokens
          ? t('mcp.action.reauth')
          : t('mcp.action.auth'),
      });
      if (selectedServer.hasOAuthTokens) {
        actions.push({
          id: 'clear-auth',
          label: t('mcp.action.clearAuth'),
        });
      }
    }
    return actions;
  }, [selectedServer, selectedTools.length, t]);

  const reloadSelectedServer = useCallback(async () => {
    const nextStatus = await mcp.reload();
    if (nextStatus) {
      setLocalStatus(nextStatus);
      const nextServer =
        nextStatus.servers?.find(
          (server) => server.name === selectedServer?.name,
        ) ?? null;
      if (nextServer) {
        const nextTools = await mcp.loadTools(nextServer.name);
        setLocalToolsByServer((current) => ({
          ...current,
          [nextServer.name]: nextTools,
        }));
      }
    }
  }, [mcp, selectedServer?.name]);

  const runServerAction = useCallback(
    async (action: McpServerAction) => {
      if (!selectedServer || action.disabled || busy) return;
      if (action.id === 'view-tools') {
        setStep('tools');
        setSelectedToolIndex(0);
        setActionMessage(null);
        return;
      }
      setBusy(true);
      if (action.id === 'authenticate') {
        setStep('oauth');
      }
      setActionMessage(
        action.id === 'authenticate'
          ? oauthAuthMessage(selectedServer.name, t)
          : t('mcp.action.running', { action: action.label }),
      );
      try {
        let nextActionMessage: string | null = null;
        if (action.id === 'reconnect') {
          await mcp.restartServer(selectedServer.name);
        } else {
          const result = await mcp.manageServer(selectedServer.name, action.id);
          const details = [
            ...(result.messages ?? []),
            ...(result.authUrl ? [result.authUrl] : []),
          ].join('\n');
          if (details) {
            nextActionMessage =
              action.id === 'authenticate'
                ? oauthAuthMessage(selectedServer.name, t, details)
                : details;
          }
        }
        await reloadSelectedServer();
        setActionMessage(
          nextActionMessage ?? t('mcp.action.done', { action: action.label }),
        );
      } catch (err) {
        setActionMessage(
          action.id === 'authenticate'
            ? oauthAuthMessage(selectedServer.name, t, extractErrorDetail(err))
            : t('mcp.action.failed', { error: extractErrorDetail(err) }),
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, mcp, reloadSelectedServer, selectedServer, t],
  );

  useEffect(() => {
    const id = panelIdRef.current;
    dispatchActive(id, isOpen);
    return () => dispatchActive(id, false);
  }, [isOpen]);

  useEffect(() => {
    const onActiveChange = (event: Event) => {
      const detail = (event as McpPanelActiveEvent).detail;
      if (detail?.active && detail.id && detail.id !== panelIdRef.current) {
        setIsOpen(false);
      }
    };
    window.addEventListener(ACTIVE_EVENT, onActiveChange);
    return () => window.removeEventListener(ACTIVE_EVENT, onActiveChange);
  }, []);

  useDelayedGlobalKeyDown(
    (event: KeyboardEvent) => {
      if (!isOpen) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (step === 'servers') {
          setIsOpen(false);
        } else if (step === 'server') {
          setStep('servers');
          setSelectedServerActionIndex(0);
          setActionMessage(null);
        } else if (step === 'oauth') {
          setStep('server');
          setActionMessage(null);
        } else if (step === 'tools') {
          setStep('server');
          setSelectedToolIndex(0);
        } else {
          setStep('tools');
        }
        return;
      }

      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        event.stopPropagation();
        const delta = event.key === 'ArrowUp' ? -1 : 1;
        if (step === 'servers') {
          setSelectedServerIndex((current) =>
            Math.min(Math.max(current + delta, 0), servers.length - 1),
          );
          setSelectedServerActionIndex(0);
        } else if (step === 'server') {
          setSelectedServerActionIndex((current) =>
            Math.min(Math.max(current + delta, 0), serverActions.length - 1),
          );
        } else if (step === 'tools') {
          setSelectedToolIndex((current) =>
            Math.min(Math.max(current + delta, 0), selectedTools.length - 1),
          );
        }
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        if (step === 'servers' && servers.length > 0) {
          setStep('server');
          setSelectedServerActionIndex(0);
        } else if (step === 'server' && serverActions.length > 0) {
          const action = serverActions[selectedServerActionIndex];
          if (action) {
            void runServerAction(action);
          }
        } else if (step === 'tools' && selectedTools.length > 0) {
          setStep('tool');
        }
      }
    },
    [
      isOpen,
      selectedServerActionIndex,
      selectedTools.length,
      serverActions,
      runServerAction,
      servers.length,
      step,
    ],
  );

  if (!isOpen) return null;

  if (servers.length === 0) {
    return (
      <div className={styles.panel} data-keyboard-scope>
        <div className={styles.header}>
          <div className={styles.title}>{t('mcp.manageServers')}</div>
          <div className={styles.secondary}>
            {t('mcp.servers', { count: 0 })}
          </div>
        </div>
        <div className={styles.secondary}>{t('mcp.empty')}</div>
        <div className={styles.shortcuts}>{t('mcp.shortcut.close')}</div>
      </div>
    );
  }

  const title =
    step === 'servers'
      ? t('mcp.manageServers')
      : step === 'server'
        ? (selectedServer?.name ?? t('mcp.manageServers'))
        : step === 'oauth'
          ? t('mcp.oauth.title')
          : step === 'tools'
            ? t('mcp.toolsForServer', {
                name: selectedServer?.name ?? 'Server',
              })
            : (selectedTool?.name ?? t('mcp.toolDetail'));

  const subtitle =
    step === 'servers'
      ? t('mcp.servers', { count: servers.length })
      : step === 'server'
        ? ''
        : step === 'oauth'
          ? ''
          : step === 'tools'
            ? t(
                selectedTools.length === 1 ? 'mcp.toolCount' : 'mcp.toolsCount',
                {
                  count: selectedTools.length,
                },
              )
            : (selectedTool?.serverToolName ?? selectedServer?.name ?? '');

  return (
    <div className={styles.panel} data-keyboard-scope>
      {connectingCount > 0 && (
        <div>
          <div className={styles.startup}>
            {t('mcp.starting', { count: connectingCount })}
          </div>
          <div className={styles.note}>{t('mcp.startingNote')}</div>
        </div>
      )}

      <div className={styles.header}>
        <div className={styles.title}>{title}</div>
        {subtitle && <div className={styles.secondary}>{subtitle}</div>}
      </div>

      {step === 'servers' && (
        <div className={styles.list}>
          {groupedServers.map((group) => {
            let offset = 0;
            for (const previous of groupedServers) {
              if (previous === group) break;
              offset += previous.servers.length;
            }
            return (
              <div key={group.label} className={styles.group}>
                <div className={styles.groupTitle}>{group.label}</div>
                {group.servers.map((server, index) => {
                  const globalIndex = offset + index;
                  const selected = globalIndex === selectedServerIndex;
                  const display = statusDisplay(server, t);
                  return (
                    <div
                      key={server.name}
                      className={
                        selected
                          ? `${styles.row} ${styles.selected}`
                          : styles.row
                      }
                      onClick={() => {
                        setSelectedServerIndex(globalIndex);
                        setStep('server');
                        setSelectedServerActionIndex(0);
                      }}
                      onMouseEnter={() => setSelectedServerIndex(globalIndex)}
                    >
                      <span className={styles.pointer}>
                        {selected ? '❯' : ''}
                      </span>
                      <span
                        className={styles.nameCell}
                        style={{ width: `${serverNameWidth}ch` }}
                      >
                        {server.name}
                      </span>
                      <span className={styles.separator}>·</span>
                      <span className={display.className}>
                        {display.icon} {display.text}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {step === 'server' && selectedServer && (
        <div className={styles.detail}>
          <div className={styles.serverFields}>
            <div className={styles.serverField}>
              <span className={styles.serverFieldLabel}>
                {t('mcp.status')}:
              </span>
              <span className={statusDisplay(selectedServer, t).className}>
                {statusDisplay(selectedServer, t).icon}{' '}
                {statusDisplay(selectedServer, t).text}
              </span>
            </div>
            <div className={styles.serverField}>
              <span className={styles.serverFieldLabel}>
                {t('mcp.source')}:
              </span>
              <span>{sourceLabel(selectedServer, t)}</span>
            </div>
            <div className={styles.serverField}>
              <span className={styles.serverFieldLabel}>
                {t('mcp.command')}:
              </span>
              <span className={styles.truncate}>
                {formatServerCommand(selectedServer, t)}
              </span>
            </div>
            {selectedServer.config?.cwd && (
              <div className={styles.serverField}>
                <span className={styles.serverFieldLabel}>
                  {t('mcp.workingDirectory')}:
                </span>
                <span className={styles.truncate}>
                  {selectedServer.config.cwd}
                </span>
              </div>
            )}
            {!selectedServer.disabled && (
              <div className={styles.serverField}>
                <span className={styles.serverFieldLabel}>
                  {t('mcp.tools')}:
                </span>
                <span>
                  {t(
                    selectedTools.length === 1
                      ? 'mcp.toolCount'
                      : 'mcp.toolsCount',
                    { count: selectedTools.length },
                  )}
                </span>
              </div>
            )}
          </div>
          <div className={styles.list}>
            {serverActions.map((action, index) => {
              const selected = index === selectedServerActionIndex;
              const className = [
                styles.row,
                selected ? styles.selected : '',
                action.disabled ? styles.disabled : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <div
                  key={action.id}
                  className={className}
                  onClick={() => {
                    setSelectedServerActionIndex(index);
                    void runServerAction(action);
                  }}
                >
                  <span className={styles.pointer}>{selected ? '❯' : ''}</span>
                  <span>{action.label}</span>
                </div>
              );
            })}
          </div>
          {actionMessage && (
            <pre className={styles.actionMessage}>{actionMessage}</pre>
          )}
        </div>
      )}

      {step === 'oauth' && (
        <div className={styles.oauthPage}>
          <pre className={styles.actionMessage}>
            {actionMessage ??
              (selectedServer
                ? oauthAuthMessage(selectedServer.name, t)
                : t('mcp.status.unknown'))}
          </pre>
        </div>
      )}

      {step === 'tools' && (
        <div className={styles.list}>
          {selectedTools.length === 0 ? (
            <div className={styles.secondary}>{t('mcp.emptyTools')}</div>
          ) : (
            visibleTools.map((tool, index) => {
              const actualIndex = toolScrollOffset + index;
              const selected = actualIndex === selectedToolIndex;
              const annotations = toolAnnotationText(tool, t);
              return (
                <div
                  key={tool.name}
                  className={
                    selected ? `${styles.row} ${styles.selected}` : styles.row
                  }
                  onClick={() => {
                    setSelectedToolIndex(actualIndex);
                    setStep('tool');
                  }}
                  onMouseEnter={() => setSelectedToolIndex(actualIndex)}
                >
                  <span className={styles.pointer}>{selected ? '❯' : ''}</span>
                  <span
                    className={styles.nameCell}
                    style={{ width: `${toolNameWidth}ch` }}
                  >
                    {tool.name}
                  </span>
                  {!tool.isValid ? (
                    <span className={styles.warning}>
                      {t('mcp.invalidReason', {
                        reason: tool.invalidReason || t('mcp.status.unknown'),
                      })}
                    </span>
                  ) : annotations ? (
                    <span className={styles.secondary}>{annotations}</span>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      )}

      {step === 'tools' && selectedTools.length > VISIBLE_TOOLS_COUNT && (
        <div className={styles.scrollHint}>
          {toolScrollOffset > 0 ? '↑ ' : '  '}
          {t('mcp.scrollPosition', {
            current: selectedToolIndex + 1,
            total: selectedTools.length,
          })}
          {toolScrollOffset + VISIBLE_TOOLS_COUNT < selectedTools.length
            ? ' ↓'
            : ''}
        </div>
      )}

      {step === 'tool' && selectedTool && (
        <div className={styles.detail}>
          {!selectedTool.isValid && (
            <div className={styles.invalidBlock}>
              <div className={styles.sectionTitle}>
                {t('mcp.invalidToolWarning')}
              </div>
              <div>
                {t('mcp.invalidReasonLabel')}{' '}
                {selectedTool.invalidReason || t('mcp.status.unknown')}
              </div>
              <div className={styles.secondary}>{t('mcp.invalidToolHelp')}</div>
            </div>
          )}
          {selectedTool.description && (
            <div className={styles.detailBlock}>
              <div className={styles.sectionTitle}>{t('mcp.description')}</div>
              <div className={styles.description}>
                {selectedTool.description.trim()}
              </div>
            </div>
          )}
          {toolAnnotationText(selectedTool, t) && (
            <div className={styles.detailBlock}>
              <span className={styles.sectionTitle}>
                {t('mcp.annotations')}
              </span>{' '}
              <span>{toolAnnotationText(selectedTool, t)}</span>
            </div>
          )}
          {schemaSummary(selectedTool, t)}
        </div>
      )}

      <div className={styles.shortcuts}>
        {step === 'servers'
          ? t('mcp.shortcut.selectClose')
          : step === 'server' || step === 'tools'
            ? t('mcp.shortcut.selectBack')
            : t('mcp.shortcut.back')}
      </div>
    </div>
  );
}

export { ACTIVE_EVENT as MCP_STATUS_ACTIVE_EVENT };

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  DaemonWorkspaceActions,
  DaemonWorkspaceMcpServerStatus,
  DaemonWorkspaceMcpToolStatus,
  DaemonWorkspaceMcpToolsStatus,
} from '@qwen-code/webui/daemon-react-sdk';
import { useMcp } from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { trimDialogLabel } from '../../utils/dialogLabels';
import type { SerializedMcpStatusMessage } from '../messages/McpStatusMessage';
import styles from './McpDialog.module.css';

type DaemonWorkspaceMcpStatus = Awaited<
  ReturnType<DaemonWorkspaceActions['loadMcpStatus']>
>;

type McpServerAction = {
  id: 'reconnect' | 'enable' | 'disable' | 'authenticate' | 'clear-auth';
  label: string;
};

type T = ReturnType<typeof useI18n>['t'];

interface McpDialogProps {
  message: SerializedMcpStatusMessage;
  onClose: () => void;
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

function statusDisplay(
  server: DaemonWorkspaceMcpServerStatus,
  t: T,
): { text: string; className: string } {
  if (server.disabled) {
    return { text: t('mcp.status.disabled'), className: styles.error };
  }
  switch (server.mcpStatus) {
    case 'connected':
      return { text: t('mcp.status.connected'), className: styles.success };
    case 'connecting':
      return { text: t('mcp.status.starting'), className: styles.warning };
    case 'disconnected':
    default:
      return {
        text: t('mcp.status.disconnectedTitle'),
        className: styles.error,
      };
  }
}

function serverGroupLabel(
  server: DaemonWorkspaceMcpServerStatus,
  t: T,
): string {
  return server.extensionName ? t('mcp.extensionMcp') : t('mcp.userMcp');
}

function oauthAuthMessage(serverName: string, t: T, detail?: string): string {
  return [
    `${t('mcp.oauth.server')}: ${serverName}`,
    '',
    t('mcp.oauth.starting', { name: serverName }),
    ...(detail ? ['', detail] : []),
  ].join('\n');
}

function schemaObject(
  tool: DaemonWorkspaceMcpToolStatus,
): Record<string, unknown> | null {
  const schema = tool.schema as
    | { parametersJsonSchema?: unknown; parameters?: unknown }
    | undefined;
  const content = schema?.parametersJsonSchema ?? schema?.parameters ?? schema;
  return content && typeof content === 'object'
    ? (content as Record<string, unknown>)
    : null;
}

function toolAnnotationText(tool: DaemonWorkspaceMcpToolStatus, t: T): string {
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

function toolKey(serverName: string, toolName: string): string {
  return `${serverName}:${toolName}`;
}

const detailLabel = trimDialogLabel;

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`${styles.chevron} ${expanded ? styles.chevronExpanded : ''}`}
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path
        d="M6 4.5 9.5 8 6 11.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function serverActions(
  server: DaemonWorkspaceMcpServerStatus,
  t: T,
): McpServerAction[] {
  const actions: McpServerAction[] = [];
  if (!server.disabled && server.mcpStatus === 'disconnected') {
    actions.push({ id: 'reconnect', label: t('mcp.action.reconnect') });
  }
  actions.push({
    id: server.disabled ? 'enable' : 'disable',
    label: server.disabled ? t('mcp.action.enable') : t('mcp.action.disable'),
  });
  if (!server.disabled) {
    actions.push({
      id: 'authenticate',
      label: server.hasOAuthTokens
        ? t('mcp.action.reauth')
        : t('mcp.action.auth'),
    });
    if (server.hasOAuthTokens) {
      actions.push({ id: 'clear-auth', label: t('mcp.action.clearAuth') });
    }
  }
  return actions;
}

function SchemaSummary({
  tool,
  t,
}: {
  tool: DaemonWorkspaceMcpToolStatus;
  t: T;
}) {
  const schema = schemaObject(tool);
  if (!schema) return <div className={styles.muted}>{t('mcp.noSchema')}</div>;

  const properties = schema['properties'];
  const required = Array.isArray(schema['required'])
    ? new Set(
        schema['required'].filter(
          (name): name is string => typeof name === 'string',
        ),
      )
    : new Set<string>();

  if (!properties || typeof properties !== 'object') {
    return (
      <pre className={styles.schema}>{JSON.stringify(schema, null, 2)}</pre>
    );
  }

  const entries = Object.entries(properties as Record<string, unknown>);
  if (entries.length === 0) return null;

  return (
    <div className={styles.section}>
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
          <div key={name} className={styles.parameter}>
            {`- ${name}${required.has(name) ? t('mcp.required') : ''}: ${type}${
              description ? ` - ${description}` : ''
            }`}
          </div>
        );
      })}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.field}>
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>{value}</span>
    </div>
  );
}

function ToolDetail({ tool, t }: { tool: DaemonWorkspaceMcpToolStatus; t: T }) {
  const annotations = toolAnnotationText(tool, t);
  return (
    <div className={styles.toolDetail}>
      {!tool.isValid ? (
        <div className={styles.section}>
          <div className={`${styles.sectionTitle} ${styles.error}`}>
            {t('mcp.invalidToolWarning')}
          </div>
          <div className={styles.muted}>
            {detailLabel(t('mcp.invalidReasonLabel'))}{' '}
            {tool.invalidReason || t('mcp.status.unknown')}
          </div>
          <div className={styles.muted}>{t('mcp.invalidToolHelp')}</div>
        </div>
      ) : null}
      {tool.description ? (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>
            {detailLabel(t('mcp.description'))}
          </div>
          <div className={styles.description}>{tool.description.trim()}</div>
        </div>
      ) : (
        <div className={styles.muted}>{t('mcp.noDescription')}</div>
      )}
      {annotations ? (
        <Field label={detailLabel(t('mcp.annotations'))} value={annotations} />
      ) : null}
      <SchemaSummary tool={tool} t={t} />
    </div>
  );
}

export function McpDialog({ message }: McpDialogProps) {
  const { t } = useI18n();
  const mcp = useMcp({ autoLoad: false });
  const [status, setStatus] = useState<DaemonWorkspaceMcpStatus>(
    message.status,
  );
  const [toolsByServer, setToolsByServer] = useState<
    Record<string, DaemonWorkspaceMcpToolsStatus>
  >(message.toolsByServer);
  const servers = useMemo(() => status.servers ?? [], [status.servers]);
  const [expandedServers, setExpandedServers] = useState<Set<string>>(
    new Set(),
  );
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [actionMessage, setActionMessage] = useState<{
    serverName: string;
    text: string;
  } | null>(null);
  const [busyServer, setBusyServer] = useState<string | null>(null);

  useEffect(() => {
    setExpandedServers((current) => {
      const validNames = new Set(servers.map((server) => server.name));
      return new Set([...current].filter((name) => validNames.has(name)));
    });
  }, [servers]);

  const connectingCount = servers.filter(
    (server) => !server.disabled && server.mcpStatus === 'connecting',
  ).length;

  const groupedServers = useMemo(() => {
    const groups: Array<{
      label: string;
      items: Array<{
        server: DaemonWorkspaceMcpServerStatus;
        tools: DaemonWorkspaceMcpToolStatus[];
      }>;
    }> = [];
    for (const server of servers) {
      const label = serverGroupLabel(server, t);
      const item = {
        server,
        tools: toolsByServer[server.name]?.tools ?? [],
      };
      const group = groups.find((candidate) => candidate.label === label);
      if (group) group.items.push(item);
      else groups.push({ label, items: [item] });
    }
    return groups;
  }, [servers, t, toolsByServer]);

  const reloadServer = useCallback(
    async (serverName: string) => {
      const nextStatus = await mcp.reload();
      if (!nextStatus) return;
      setStatus(nextStatus);
      const nextServer = nextStatus.servers?.find(
        (server) => server.name === serverName,
      );
      if (!nextServer) return;
      const nextTools = await mcp.loadTools(nextServer.name);
      setToolsByServer((current) => ({
        ...current,
        [nextServer.name]: nextTools,
      }));
    },
    [mcp],
  );

  const runAction = useCallback(
    async (server: DaemonWorkspaceMcpServerStatus, action: McpServerAction) => {
      if (busyServer) return;
      setExpandedServers(new Set([server.name]));
      setBusyServer(server.name);
      setActionMessage({
        serverName: server.name,
        text:
          action.id === 'authenticate'
            ? oauthAuthMessage(server.name, t)
            : t('mcp.action.running', { action: action.label }),
      });
      try {
        let nextActionMessage: string | null = null;
        if (action.id === 'reconnect') {
          await mcp.restartServer(server.name);
        } else {
          const result = await mcp.manageServer(server.name, action.id);
          const details = [
            ...(result.messages ?? []),
            ...(result.authUrl ? [result.authUrl] : []),
          ].join('\n');
          if (details) {
            nextActionMessage =
              action.id === 'authenticate'
                ? oauthAuthMessage(server.name, t, details)
                : details;
          }
        }
        await reloadServer(server.name);
        setActionMessage({
          serverName: server.name,
          text:
            nextActionMessage ?? t('mcp.action.done', { action: action.label }),
        });
      } catch (err) {
        setActionMessage({
          serverName: server.name,
          text:
            action.id === 'authenticate'
              ? oauthAuthMessage(server.name, t, extractErrorDetail(err))
              : t('mcp.action.failed', { error: extractErrorDetail(err) }),
        });
      } finally {
        setBusyServer(null);
      }
    },
    [busyServer, mcp, reloadServer, t],
  );

  const toggleServer = useCallback((serverName: string) => {
    setExpandedServers((current) => {
      return current.has(serverName) ? new Set() : new Set([serverName]);
    });
    setExpandedTools(new Set());
  }, []);

  const toggleTool = useCallback((serverName: string, toolName: string) => {
    const key = toolKey(serverName, toolName);
    setExpandedTools((current) => {
      return current.has(key) ? new Set() : new Set([key]);
    });
  }, []);

  return (
    <div className={styles.layout} data-keyboard-scope>
      {connectingCount > 0 ? (
        <div className={styles.notice}>
          {t('mcp.starting', { count: connectingCount })}
          <div className={styles.muted}>{t('mcp.startingNote')}</div>
        </div>
      ) : null}

      {servers.length === 0 ? (
        <div className={styles.empty}>{t('mcp.empty')}</div>
      ) : (
        <div className={styles.list}>
          {groupedServers.map((group) => (
            <div key={group.label} className={styles.group}>
              {group.label !== t('mcp.extensionMcp') ? (
                <div className={styles.groupTitle}>{group.label}</div>
              ) : null}
              {group.items.map(({ server, tools }) => {
                const display = statusDisplay(server, t);
                const expanded = expandedServers.has(server.name);
                const actions = serverActions(server, t);
                const toolCount = toolsByServer[server.name]?.tools.length ?? 0;
                return (
                  <div key={server.name} className={styles.server}>
                    <div
                      className={`${styles.serverCard} ${
                        expanded ? styles.serverCardExpanded : ''
                      }`}
                    >
                      <button
                        type="button"
                        className={`${styles.row} ${styles.serverRow} ${
                          expanded ? styles.expandedRow : ''
                        }`}
                        onClick={() => toggleServer(server.name)}
                        aria-label={
                          expanded ? t('mcp.collapse') : t('mcp.expand')
                        }
                      >
                        <span className={styles.rowMain}>
                          <span className={styles.rowIcon} aria-hidden="true" />
                          <span
                            className={`${styles.name} ${styles.serverName}`}
                          >
                            {server.name}
                          </span>
                        </span>
                        <span
                          className={`${styles.status} ${display.className}`}
                        >
                          {display.text}
                        </span>
                        <span className={`${styles.badge} ${styles.toolCount}`}>
                          {t(
                            toolCount === 1
                              ? 'mcp.toolCount'
                              : 'mcp.toolsCount',
                            {
                              count: toolCount,
                            },
                          )}
                        </span>
                        <span className={styles.chevronCell} aria-hidden="true">
                          <ChevronIcon expanded={expanded} />
                        </span>
                      </button>

                      {expanded ? (
                        <div className={styles.serverDetail}>
                          {actions.length > 0 ? (
                            <div className={styles.serverDetailHeader}>
                              <div className={styles.serverActions}>
                                {actions.map((action) => (
                                  <button
                                    key={action.id}
                                    type="button"
                                    className={styles.button}
                                    onClick={() =>
                                      void runAction(server, action)
                                    }
                                    disabled={busyServer !== null}
                                  >
                                    {action.label}
                                  </button>
                                ))}
                              </div>
                            </div>
                          ) : null}
                          {actionMessage?.serverName === server.name ? (
                            <pre className={styles.message}>
                              {actionMessage.text}
                            </pre>
                          ) : null}
                          {tools.length === 0 ? (
                            <div className={styles.emptyTools}>
                              {t('mcp.emptyTools')}
                            </div>
                          ) : (
                            <div className={styles.tools}>
                              {tools.map((tool) => {
                                const key = toolKey(server.name, tool.name);
                                const toolExpanded = expandedTools.has(key);
                                return (
                                  <div key={tool.name} className={styles.tool}>
                                    <button
                                      type="button"
                                      className={`${styles.row} ${styles.toolRow} ${
                                        toolExpanded ? styles.expandedRow : ''
                                      } ${!tool.isValid ? styles.disabled : ''}`}
                                      onClick={() =>
                                        toggleTool(server.name, tool.name)
                                      }
                                    >
                                      <span
                                        className={styles.rowIcon}
                                        aria-hidden="true"
                                      />
                                      <span className={styles.name}>
                                        {tool.name}
                                      </span>
                                      <ChevronIcon expanded={toolExpanded} />
                                    </button>
                                    {toolExpanded ? (
                                      <ToolDetail tool={tool} t={t} />
                                    ) : null}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

import { useMemo, useState } from 'react';
import { useMcp } from '@qwen-code/webui/daemon-react-sdk';
import type {
  DaemonWorkspaceMcpServerStatus,
  DaemonWorkspaceMcpToolStatus,
} from '@qwen-code/webui/daemon-react-sdk';
import { errorMessage, ResourceState } from '../common/ResourceState';

type McpAction = 'enable' | 'disable' | 'authenticate' | 'clear-auth';

interface PendingAction {
  action: 'tools' | 'restart' | McpAction;
  serverName: string;
}

export function McpPanel() {
  const mcp = useMcp({ autoLoad: true });
  const [query, setQuery] = useState('');
  const [expandedServer, setExpandedServer] = useState<string>();
  const [pendingAction, setPendingAction] = useState<PendingAction>();
  const [toolsByServer, setToolsByServer] = useState<
    Record<string, DaemonWorkspaceMcpToolStatus[]>
  >({});
  const [actionError, setActionError] = useState<string>();
  const [actionMessage, setActionMessage] = useState<string>();

  const servers = useMemo(
    () => mcp.status?.servers ?? [],
    [mcp.status?.servers],
  );
  const filteredServers = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return servers;
    return servers.filter((server) =>
      `${server.name} ${server.description ?? ''} ${server.transport}`
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [query, servers]);

  async function loadTools(serverName: string) {
    setActionError(undefined);
    setActionMessage(undefined);
    setPendingAction({ serverName, action: 'tools' });
    try {
      const tools = await mcp.loadTools(serverName);
      setToolsByServer((prev) => ({ ...prev, [serverName]: tools.tools }));
      setActionMessage(`${serverName} tools loaded.`);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setPendingAction(undefined);
    }
  }

  async function restartServer(serverName: string) {
    setActionError(undefined);
    setActionMessage(undefined);
    setPendingAction({ serverName, action: 'restart' });
    try {
      await mcp.restartServer(serverName);
      await mcp.reload();
      setActionMessage(`${serverName} restarted.`);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setPendingAction(undefined);
    }
  }

  async function manageServer(serverName: string, action: McpAction) {
    setActionError(undefined);
    setActionMessage(undefined);
    setPendingAction({ serverName, action });
    try {
      const result = await mcp.manageServer(serverName, action);
      await mcp.reload();
      setActionMessage(
        result.authUrl
          ? `Open auth URL for ${serverName}: ${result.authUrl}`
          : result.messages?.join(' ') || `${serverName} ${action} completed.`,
      );
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setPendingAction(undefined);
    }
  }

  return (
    <div className="web-panel">
      <div className="web-panel-header">
        <div>
          <h2>MCP servers</h2>
          <p>
            {filteredServers.length} / {servers.length} configured server
            {servers.length === 1 ? '' : 's'}
          </p>
        </div>
        <button type="button" onClick={() => void mcp.reload()}>
          Refresh
        </button>
      </div>
      <div className="web-filter-bar">
        <input
          aria-label="Search MCP servers"
          name="mcp-search"
          placeholder="Search MCP servers"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {actionError ? <div className="web-error">{actionError}</div> : null}
      {actionMessage ? (
        <div className="web-action-result">{actionMessage}</div>
      ) : null}
      {mcp.status?.errors?.length ? (
        <div className="web-error">
          {mcp.status.errors
            .map((error) => error.error ?? error.kind)
            .join(' · ')}
        </div>
      ) : null}
      <ResourceState
        loading={mcp.loading}
        error={mcp.error}
        empty={filteredServers.length === 0}
        emptyText="No MCP servers match the current filters."
      >
        <div className="web-list">
          {filteredServers.map((server) => {
            const expanded = expandedServer === server.name;
            const pending = pendingAction?.serverName === server.name;
            const serverTools = toolsByServer[server.name];
            return (
              <article className="web-card" key={server.name}>
                <div className="web-card-main">
                  <h3>{server.name}</h3>
                  <p>{server.description ?? server.transport}</p>
                  <div className="web-meta">
                    <span>
                      {server.mcpStatus ?? server.status ?? 'unknown'}
                    </span>
                    <span>{server.disabled ? 'disabled' : 'enabled'}</span>
                    {server.source ? <span>{server.source}</span> : null}
                    {server.hasOAuthTokens ? <span>oauth</span> : null}
                  </div>
                  {expanded ? <ServerDetails server={server} /> : null}
                  {serverTools ? (
                    <ul className="compact-list">
                      {serverTools.map((tool) => (
                        <li key={tool.name} title={tool.description}>
                          {tool.name}
                          {!tool.isValid ? ' · invalid' : ''}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                <div className="web-card-actions">
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedServer(expanded ? undefined : server.name)
                    }
                  >
                    {expanded ? 'Hide details' : 'Details'}
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => void loadTools(server.name)}
                  >
                    {pendingActionLabel(pendingAction, server.name, 'tools') ??
                      'Tools'}
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => void restartServer(server.name)}
                  >
                    {pendingActionLabel(
                      pendingAction,
                      server.name,
                      'restart',
                    ) ?? 'Restart'}
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      void manageServer(
                        server.name,
                        server.disabled ? 'enable' : 'disable',
                      )
                    }
                  >
                    {pendingActionLabel(
                      pendingAction,
                      server.name,
                      server.disabled ? 'enable' : 'disable',
                    ) ?? (server.disabled ? 'Enable' : 'Disable')}
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      void manageServer(server.name, 'authenticate')
                    }
                  >
                    {pendingActionLabel(
                      pendingAction,
                      server.name,
                      'authenticate',
                    ) ?? 'Authenticate'}
                  </button>
                  {server.hasOAuthTokens ? (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        void manageServer(server.name, 'clear-auth')
                      }
                    >
                      {pendingActionLabel(
                        pendingAction,
                        server.name,
                        'clear-auth',
                      ) ?? 'Clear auth'}
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      </ResourceState>
    </div>
  );
}

function ServerDetails({ server }: { server: DaemonWorkspaceMcpServerStatus }) {
  return (
    <dl className="web-detail-grid">
      <div>
        <dt>Transport</dt>
        <dd>{server.transport}</dd>
      </div>
      <div>
        <dt>Status</dt>
        <dd>{server.mcpStatus ?? server.status ?? 'unknown'}</dd>
      </div>
      {server.disabledReason ? (
        <div>
          <dt>Disabled reason</dt>
          <dd>{server.disabledReason}</dd>
        </div>
      ) : null}
      {server.extensionName ? (
        <div>
          <dt>Extension</dt>
          <dd>{server.extensionName}</dd>
        </div>
      ) : null}
      {server.config?.command ? (
        <div>
          <dt>Command</dt>
          <dd>{server.config.command}</dd>
        </div>
      ) : null}
      {(server.config?.httpUrl ?? server.config?.url) ? (
        <div>
          <dt>URL</dt>
          <dd>{server.config.httpUrl ?? server.config.url}</dd>
        </div>
      ) : null}
      {server.error ? (
        <div>
          <dt>Error</dt>
          <dd>{server.error}</dd>
        </div>
      ) : null}
      {server.hint ? (
        <div>
          <dt>Hint</dt>
          <dd>{server.hint}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function pendingActionLabel(
  pendingAction: PendingAction | undefined,
  serverName: string,
  action: PendingAction['action'],
) {
  if (
    pendingAction?.serverName !== serverName ||
    pendingAction.action !== action
  ) {
    return undefined;
  }
  return 'Working';
}

import { useMemo, useState } from 'react';
import { useMcp } from '@qwen-code/webui/daemon-react-sdk';
import type {
  DaemonWorkspaceMcpServerStatus,
  DaemonWorkspaceMcpToolStatus,
} from '@qwen-code/webui/daemon-react-sdk';
import { errorMessage, ResourceState } from '../common/ResourceState';

type McpHook = ReturnType<typeof useMcp>;
type McpStatus = NonNullable<McpHook['status']>;
type McpStatusError = NonNullable<McpStatus['errors']>[number];
type McpToolsStatus = Awaited<ReturnType<McpHook['loadTools']>>;
type McpRestartResult = Awaited<ReturnType<McpHook['restartServer']>>;

type McpAction = 'enable' | 'disable' | 'authenticate' | 'clear-auth';
type ServerIssueTone = 'ok' | 'warning' | 'error' | 'muted';

interface PendingAction {
  action: 'tools' | 'restart' | McpAction;
  serverName: string;
}

interface ServerIssueView {
  tone: ServerIssueTone;
  title: string;
  detail?: string;
}

export function McpPanel() {
  const mcp = useMcp({ autoLoad: true });
  const [query, setQuery] = useState('');
  const [expandedServer, setExpandedServer] = useState<string>();
  const [pendingAction, setPendingAction] = useState<PendingAction>();
  const [toolsByServer, setToolsByServer] = useState<
    Record<string, McpToolsStatus>
  >({});
  const [actionError, setActionError] = useState<string>();
  const [actionMessage, setActionMessage] = useState<string>();
  const [actionUrl, setActionUrl] = useState<string>();

  const servers = useMemo(
    () => mcp.status?.servers ?? [],
    [mcp.status?.servers],
  );
  const filteredServers = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return servers;
    return servers.filter((server) =>
      matchesServerQuery(server, normalizedQuery),
    );
  }, [query, servers]);

  async function loadTools(serverName: string) {
    setActionError(undefined);
    setActionMessage(undefined);
    setActionUrl(undefined);
    setPendingAction({ serverName, action: 'tools' });
    try {
      const tools = await mcp.loadTools(serverName);
      const invalidCount = tools.tools.filter((tool) => !tool.isValid).length;
      setToolsByServer((prev) => ({ ...prev, [serverName]: tools }));
      setActionMessage(
        `${serverName} tools loaded: ${tools.tools.length} total, ${invalidCount} invalid.`,
      );
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setPendingAction(undefined);
    }
  }

  async function restartServer(serverName: string) {
    setActionError(undefined);
    setActionMessage(undefined);
    setActionUrl(undefined);
    setPendingAction({ serverName, action: 'restart' });
    try {
      const result = await mcp.restartServer(serverName);
      await mcp.reload();
      setActionMessage(formatRestartResult(serverName, result));
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setPendingAction(undefined);
    }
  }

  async function manageServer(serverName: string, action: McpAction) {
    setActionError(undefined);
    setActionMessage(undefined);
    setActionUrl(undefined);
    setPendingAction({ serverName, action });
    try {
      const result = await mcp.manageServer(serverName, action);
      await mcp.reload();
      setActionUrl(result.authUrl);
      setActionMessage(
        result.authUrl
          ? `Open auth URL for ${serverName}.`
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
      {mcp.status ? <McpDiagnosticsSummary status={mcp.status} /> : null}
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
        <div className="web-action-result">
          {actionMessage}
          {actionUrl ? (
            <a href={actionUrl} rel="noreferrer" target="_blank">
              Open OAuth URL
            </a>
          ) : null}
        </div>
      ) : null}
      <McpIssueList errors={mcp.status?.errors ?? []} title="MCP workspace" />
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
            const issue = getServerIssue(server, serverTools);
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
                    {server.errorKind ? <span>{server.errorKind}</span> : null}
                    {server.hasOAuthTokens ? <span>oauth</span> : null}
                  </div>
                  <ServerIssue issue={issue} />
                  {expanded ? <ServerDetails server={server} /> : null}
                  {serverTools ? (
                    <ToolsDiagnostics status={serverTools} />
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
                    ) ?? 'Reconnect'}
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

function McpDiagnosticsSummary({ status }: { status: McpStatus }) {
  const counts = getMcpStatusCounts(status);
  return (
    <div className="mcp-summary-grid">
      <SummaryCard
        label="Workspace"
        value={status.initialized ? 'Ready' : 'Pending'}
        detail={`${status.discoveryState ?? 'unknown'} · ${status.workspaceCwd}`}
        tone={status.initialized ? 'ok' : 'warning'}
      />
      <SummaryCard
        label="Servers"
        value={`${counts.connected}/${counts.total}`}
        detail={`${counts.connecting} connecting · ${counts.disconnected} disconnected · ${counts.disabled} disabled`}
        tone={
          counts.error > 0 ? 'error' : counts.disabled > 0 ? 'warning' : 'ok'
        }
      />
      <SummaryCard
        label="Client budget"
        value={formatBudgetValue(status)}
        detail={formatBudgetDetail(status)}
        tone={counts.budgetRisk ? 'error' : 'muted'}
      />
      <SummaryCard
        label="Issues"
        value={`${counts.issueCount}`}
        detail={`${counts.topLevelErrors} workspace · ${counts.serverIssues} server`}
        tone={counts.issueCount > 0 ? 'error' : 'ok'}
      />
    </div>
  );
}

function SummaryCard({
  detail,
  label,
  tone,
  value,
}: {
  detail: string;
  label: string;
  tone: ServerIssueTone;
  value: string;
}) {
  return (
    <div className={`mcp-summary-card mcp-issue-${tone}`}>
      <span>{label}</span>
      <strong title={value}>{value}</strong>
      <small title={detail}>{detail}</small>
    </div>
  );
}

function McpIssueList({
  errors,
  title,
}: {
  errors: readonly McpStatusError[];
  title: string;
}) {
  if (errors.length === 0) return null;
  return (
    <div className="mcp-issue-list" role="status">
      <strong>{title} issues</strong>
      {errors.map((error, index) => (
        <div
          className="mcp-issue mcp-issue-error"
          key={`${error.kind}-${index}`}
        >
          <span>{error.errorKind ?? error.kind}</span>
          <p>{error.error ?? error.status}</p>
          {error.hint ? <small>{error.hint}</small> : null}
        </div>
      ))}
    </div>
  );
}

function ServerIssue({ issue }: { issue: ServerIssueView }) {
  return (
    <div className={`mcp-issue mcp-issue-${issue.tone}`}>
      <span>{issue.title}</span>
      {issue.detail ? <p>{issue.detail}</p> : null}
    </div>
  );
}

function ServerDetails({ server }: { server: DaemonWorkspaceMcpServerStatus }) {
  const rawCommand = formatConfigCommand(server);
  return (
    <dl className="web-detail-grid">
      <DetailRow label="Transport" value={server.transport} />
      <DetailRow label="Runtime status" value={server.mcpStatus ?? 'unknown'} />
      <DetailRow label="Status cell" value={server.status ?? 'unknown'} />
      <DetailRow label="Source" value={server.source ?? 'unknown'} />
      <DetailRow
        label="OAuth tokens"
        value={server.hasOAuthTokens ? 'yes' : 'no'}
      />
      {server.errorKind ? (
        <DetailRow label="Error kind" value={server.errorKind} />
      ) : null}
      {server.disabledReason ? (
        <DetailRow label="Disabled reason" value={server.disabledReason} />
      ) : null}
      {server.extensionName ? (
        <DetailRow label="Extension" value={server.extensionName} />
      ) : null}
      {server.description ? (
        <DetailRow label="Description" value={server.description} />
      ) : null}
      {server.config?.cwd ? (
        <DetailRow label="CWD" value={server.config.cwd} />
      ) : null}
      {server.config?.command ? (
        <DetailRow label="Command" value={server.config.command} />
      ) : null}
      {server.config?.args?.length ? (
        <DetailRow label="Args" value={server.config.args.join(' ')} />
      ) : null}
      {server.config?.httpUrl ? (
        <DetailRow label="HTTP URL" value={server.config.httpUrl} />
      ) : null}
      {server.config?.url ? (
        <DetailRow label="URL" value={server.config.url} />
      ) : null}
      {rawCommand ? <DetailRow label="Raw command" value={rawCommand} /> : null}
      {!hasLaunchConfig(server) ? (
        <DetailRow label="Config" value="No launch config reported." />
      ) : null}
      {server.error ? <DetailRow label="Error" value={server.error} /> : null}
      {server.hint ? <DetailRow label="Hint" value={server.hint} /> : null}
    </dl>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  );
}

function ToolsDiagnostics({ status }: { status: McpToolsStatus }) {
  const invalidTools = status.tools.filter((tool) => !tool.isValid);
  return (
    <div className="mcp-tool-list">
      <div className="mcp-tool-summary">
        <strong>{status.tools.length} tools</strong>
        <span>{invalidTools.length} invalid</span>
        <span>{status.acpChannelLive ? 'ACP live' : 'ACP idle'}</span>
      </div>
      <McpIssueList
        errors={status.errors ?? []}
        title={`${status.serverName} tools`}
      />
      {status.tools.map((tool) => (
        <ToolDiagnostic key={tool.name} tool={tool} />
      ))}
    </div>
  );
}

function ToolDiagnostic({ tool }: { tool: DaemonWorkspaceMcpToolStatus }) {
  const metadata = getToolMetadata(tool);
  return (
    <div
      className={
        tool.isValid ? 'mcp-tool-item' : 'mcp-tool-item mcp-tool-invalid'
      }
    >
      <strong>{tool.name}</strong>
      {tool.serverToolName && tool.serverToolName !== tool.name ? (
        <span className="mcp-muted">server: {tool.serverToolName}</span>
      ) : null}
      {tool.description ? <p>{tool.description}</p> : null}
      {!tool.isValid ? (
        <small>{tool.invalidReason ?? 'Invalid tool definition'}</small>
      ) : null}
      {metadata ? <span className="mcp-muted">{metadata}</span> : null}
    </div>
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

function getMcpStatusCounts(status: McpStatus) {
  const connected = status.servers.filter(
    (server) => server.mcpStatus === 'connected' || server.status === 'ok',
  ).length;
  const connecting = status.servers.filter(
    (server) => server.mcpStatus === 'connecting',
  ).length;
  const disconnected = status.servers.filter(
    (server) => server.mcpStatus === 'disconnected',
  ).length;
  const disabled = status.servers.filter((server) => server.disabled).length;
  const serverIssues = status.servers.filter(hasServerIssue).length;
  const topLevelErrors = status.errors?.length ?? 0;
  const budgetRisk = Boolean(
    status.budgetMode !== 'off' &&
      status.clientBudget !== undefined &&
      status.clientCount !== undefined &&
      status.clientCount >= status.clientBudget,
  );
  return {
    total: status.servers.length,
    connected,
    connecting,
    disconnected,
    disabled,
    error: status.servers.filter((server) => server.status === 'error').length,
    serverIssues,
    topLevelErrors,
    issueCount: serverIssues + topLevelErrors,
    budgetRisk,
  };
}

function getServerIssue(
  server: DaemonWorkspaceMcpServerStatus,
  toolsStatus: McpToolsStatus | undefined,
): ServerIssueView {
  const invalidCount =
    toolsStatus?.tools.filter((tool) => !tool.isValid).length ?? 0;
  if (server.disabled) {
    return {
      tone: server.disabledReason === 'budget' ? 'error' : 'warning',
      title: 'Disabled',
      detail: server.disabledReason
        ? `Reason: ${server.disabledReason}`
        : 'Server is disabled.',
    };
  }
  if (server.error || server.errorKind) {
    return {
      tone: 'error',
      title: server.errorKind ?? 'Connection issue',
      detail: server.error ?? server.hint,
    };
  }
  if (server.mcpStatus === 'disconnected' || server.status === 'error') {
    return {
      tone: 'error',
      title: 'Disconnected',
      detail: server.hint ?? 'Server is not connected to the workspace.',
    };
  }
  if (!hasLaunchConfig(server)) {
    return {
      tone: 'warning',
      title: 'Missing launch config',
      detail: 'No command or URL was reported by the daemon.',
    };
  }
  if (invalidCount > 0) {
    return {
      tone: 'warning',
      title: `${invalidCount} invalid tool${invalidCount === 1 ? '' : 's'}`,
      detail: 'Open tools diagnostics for invalid definitions.',
    };
  }
  return {
    tone: 'ok',
    title: 'No issue reported',
    detail: server.hasOAuthTokens ? 'OAuth tokens present.' : undefined,
  };
}

function hasServerIssue(server: DaemonWorkspaceMcpServerStatus) {
  return Boolean(
    server.disabled ||
      server.status === 'error' ||
      server.mcpStatus === 'disconnected' ||
      server.error ||
      server.errorKind,
  );
}

function hasLaunchConfig(server: DaemonWorkspaceMcpServerStatus) {
  return Boolean(
    server.config?.command || server.config?.httpUrl || server.config?.url,
  );
}

function matchesServerQuery(
  server: DaemonWorkspaceMcpServerStatus,
  query: string,
) {
  return [
    server.name,
    server.description,
    server.transport,
    server.status,
    server.mcpStatus,
    server.source,
    server.hasOAuthTokens ? 'oauth' : undefined,
    server.disabled ? 'disabled' : 'enabled',
    server.extensionName,
    server.disabledReason,
    server.errorKind,
    server.error,
    server.hint,
    server.config?.command,
    server.config?.args?.join(' '),
    server.config?.httpUrl,
    server.config?.url,
    server.config?.cwd,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(query);
}

function formatRestartResult(serverName: string, result: McpRestartResult) {
  if ('entries' in result) {
    const restarted = result.entries.filter((entry) => entry.restarted).length;
    const skipped = result.entries.length - restarted;
    const reasons = result.entries
      .flatMap((entry) => (entry.reason ? [entry.reason] : []))
      .join(', ');
    return `${serverName} reconnect entries: ${restarted} restarted, ${skipped} skipped${reasons ? ` (${reasons})` : ''}.`;
  }
  if ('skipped' in result && result.skipped) {
    return `Reconnect skipped for ${serverName}: ${skipReasonLabel(result.reason)}.`;
  }
  if (result.restarted) {
    return `${serverName} reconnected in ${result.durationMs}ms.`;
  }
  return `${serverName} reconnect completed.`;
}

function skipReasonLabel(reason: string) {
  switch (reason) {
    case 'in_flight':
      return 'restart already in flight';
    case 'disabled':
      return 'server is disabled';
    case 'budget_would_exceed':
      return 'client budget would be exceeded';
    default:
      return reason;
  }
}

function formatBudgetValue(status: McpStatus) {
  if (status.clientCount === undefined) return 'n/a';
  if (status.clientBudget === undefined) return `${status.clientCount}`;
  return `${status.clientCount}/${status.clientBudget}`;
}

function formatBudgetDetail(status: McpStatus) {
  const mode = status.budgetMode ?? 'unknown';
  const refused =
    status.budgets?.reduce((total, budget) => total + budget.refusedCount, 0) ??
    0;
  return `${mode} mode · ${refused} refused`;
}

function formatConfigCommand(server: DaemonWorkspaceMcpServerStatus) {
  const command = server.config?.command;
  if (!command) return undefined;
  const args = server.config?.args?.join(' ');
  return args ? `${command} ${args}` : command;
}

function getToolMetadata(tool: DaemonWorkspaceMcpToolStatus) {
  const metadata: string[] = [];
  if (tool.schema) metadata.push('schema');
  const annotationCount = tool.annotations
    ? Object.keys(tool.annotations).length
    : 0;
  if (annotationCount > 0) {
    metadata.push(
      `${annotationCount} annotation${annotationCount === 1 ? '' : 's'}`,
    );
  }
  return metadata.join(' · ');
}

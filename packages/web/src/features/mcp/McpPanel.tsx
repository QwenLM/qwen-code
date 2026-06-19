import { useState } from 'react';
import { useMcp } from '@qwen-code/webui/daemon-react-sdk';
import type { DaemonWorkspaceMcpToolStatus } from '@qwen-code/webui/daemon-react-sdk';
import { errorMessage, ResourceState } from '../common/ResourceState';

export function McpPanel() {
  const mcp = useMcp({ autoLoad: true });
  const [toolsByServer, setToolsByServer] = useState<
    Record<string, DaemonWorkspaceMcpToolStatus[]>
  >({});
  const [actionError, setActionError] = useState<string>();

  async function loadTools(serverName: string) {
    setActionError(undefined);
    try {
      const tools = await mcp.loadTools(serverName);
      setToolsByServer((prev) => ({ ...prev, [serverName]: tools.tools }));
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  async function restartServer(serverName: string) {
    setActionError(undefined);
    try {
      await mcp.restartServer(serverName);
      await mcp.reload();
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  const servers = mcp.status?.servers ?? [];

  return (
    <div className="web-panel">
      <div className="web-panel-header">
        <div>
          <h2>MCP servers</h2>
          <p>
            {servers.length} configured server{servers.length === 1 ? '' : 's'}
          </p>
        </div>
        <button type="button" onClick={() => void mcp.reload()}>
          Refresh
        </button>
      </div>
      {actionError ? <div className="web-error">{actionError}</div> : null}
      <ResourceState
        loading={mcp.loading}
        error={mcp.error}
        empty={servers.length === 0}
        emptyText="No MCP servers reported by the daemon."
      >
        <div className="web-list">
          {servers.map((server) => (
            <article className="web-card" key={server.name}>
              <div className="web-card-main">
                <h3>{server.name}</h3>
                <p>{server.description ?? server.transport}</p>
                <div className="web-meta">
                  <span>{server.mcpStatus ?? 'unknown'}</span>
                  <span>{server.disabled ? 'disabled' : 'enabled'}</span>
                  {server.source ? <span>{server.source}</span> : null}
                </div>
                {toolsByServer[server.name] ? (
                  <ul className="compact-list">
                    {toolsByServer[server.name].map((tool) => (
                      <li key={tool.name}>{tool.name}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <div className="web-card-actions">
                <button
                  type="button"
                  onClick={() => void loadTools(server.name)}
                >
                  Tools
                </button>
                <button
                  type="button"
                  onClick={() => void restartServer(server.name)}
                >
                  Restart
                </button>
              </div>
            </article>
          ))}
        </div>
      </ResourceState>
    </div>
  );
}

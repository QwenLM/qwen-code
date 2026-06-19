import { useMemo, useState } from 'react';
import { useTools } from '@qwen-code/webui/daemon-react-sdk';
import { errorMessage, ResourceState } from '../common/ResourceState';

export function ToolsPanel() {
  const tools = useTools({ autoLoad: true });
  const [query, setQuery] = useState('');
  const [expandedTool, setExpandedTool] = useState<string>();
  const [pendingTool, setPendingTool] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [actionMessage, setActionMessage] = useState<string>();

  const filteredTools = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return tools.tools;
    return tools.tools.filter((tool) =>
      `${tool.name} ${tool.displayName ?? ''} ${tool.description ?? ''}`
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [query, tools.tools]);

  async function setEnabled(toolName: string, enabled: boolean) {
    setActionError(undefined);
    setActionMessage(undefined);
    setPendingTool(toolName);
    try {
      await tools.setEnabled(toolName, enabled);
      await tools.reload();
      setActionMessage(`${toolName} ${enabled ? 'enabled' : 'disabled'}.`);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setPendingTool(undefined);
    }
  }

  return (
    <div className="web-panel">
      <div className="web-panel-header">
        <div>
          <h2>Tools</h2>
          <p>
            {filteredTools.length} / {tools.tools.length} registered tool
            {tools.tools.length === 1 ? '' : 's'}
          </p>
        </div>
        <button type="button" onClick={() => void tools.reload()}>
          Refresh
        </button>
      </div>
      <div className="web-filter-bar">
        <input
          aria-label="Search tools"
          name="tool-search"
          placeholder="Search tools"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {actionError ? <div className="web-error">{actionError}</div> : null}
      {actionMessage ? (
        <div className="web-action-result">{actionMessage}</div>
      ) : null}
      <ResourceState
        loading={tools.loading}
        error={tools.error}
        empty={filteredTools.length === 0}
        emptyText="No tools match the current filters."
      >
        <div className="web-list">
          {filteredTools.map((tool) => {
            const pending = pendingTool === tool.name;
            const expanded = expandedTool === tool.name;
            return (
              <article className="web-card" key={tool.name}>
                <div className="web-card-main">
                  <h3>{tool.displayName ?? tool.name}</h3>
                  <p>{tool.description ?? tool.name}</p>
                  <div className="web-meta">
                    <span>{tool.enabled ? 'enabled' : 'disabled'}</span>
                    <span>{tool.name}</span>
                  </div>
                  {expanded ? (
                    <dl className="web-detail-grid">
                      <div>
                        <dt>Name</dt>
                        <dd>{tool.name}</dd>
                      </div>
                      <div>
                        <dt>Status</dt>
                        <dd>{tool.enabled ? 'Enabled' : 'Disabled'}</dd>
                      </div>
                    </dl>
                  ) : null}
                </div>
                <div className="web-card-actions">
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedTool(expanded ? undefined : tool.name)
                    }
                  >
                    {expanded ? 'Hide details' : 'Details'}
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => void setEnabled(tool.name, !tool.enabled)}
                  >
                    {pending ? 'Saving' : tool.enabled ? 'Disable' : 'Enable'}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </ResourceState>
    </div>
  );
}

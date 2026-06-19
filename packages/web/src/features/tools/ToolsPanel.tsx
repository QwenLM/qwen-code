import { useState } from 'react';
import { useTools } from '@qwen-code/webui/daemon-react-sdk';
import { errorMessage, ResourceState } from '../common/ResourceState';

export function ToolsPanel() {
  const tools = useTools({ autoLoad: true });
  const [actionError, setActionError] = useState<string>();

  async function setEnabled(toolName: string, enabled: boolean) {
    setActionError(undefined);
    try {
      await tools.setEnabled(toolName, enabled);
      await tools.reload();
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  return (
    <div className="web-panel">
      <div className="web-panel-header">
        <div>
          <h2>Tools</h2>
          <p>
            {tools.tools.length} registered tool
            {tools.tools.length === 1 ? '' : 's'}
          </p>
        </div>
        <button type="button" onClick={() => void tools.reload()}>
          Refresh
        </button>
      </div>
      {actionError ? <div className="web-error">{actionError}</div> : null}
      <ResourceState
        loading={tools.loading}
        error={tools.error}
        empty={tools.tools.length === 0}
        emptyText="No tools reported by the daemon."
      >
        <div className="web-list">
          {tools.tools.map((tool) => (
            <article className="web-card" key={tool.name}>
              <div className="web-card-main">
                <h3>{tool.displayName ?? tool.name}</h3>
                <p>{tool.description ?? tool.name}</p>
              </div>
              <div className="web-card-actions">
                <button
                  type="button"
                  onClick={() => void setEnabled(tool.name, !tool.enabled)}
                >
                  {tool.enabled ? 'Disable' : 'Enable'}
                </button>
              </div>
            </article>
          ))}
        </div>
      </ResourceState>
    </div>
  );
}

import { useState } from 'react';
import { useMemory } from '@qwen-code/webui/daemon-react-sdk';
import { errorMessage, ResourceState } from '../common/ResourceState';

export function MemoryPanel() {
  const memory = useMemory({ autoLoad: true });
  const [selectedPath, setSelectedPath] = useState<string>();
  const [content, setContent] = useState<string>();
  const [actionError, setActionError] = useState<string>();

  async function openFile(path: string) {
    setSelectedPath(path);
    setActionError(undefined);
    try {
      const file = await memory.readFile(path);
      setContent(file.content);
    } catch (error) {
      setContent(undefined);
      setActionError(errorMessage(error));
    }
  }

  return (
    <div className="web-panel files-panel">
      <div className="web-panel-header">
        <div>
          <h2>Memory</h2>
          <p>
            {memory.status?.fileCount ?? memory.files.length} file(s),{' '}
            {memory.status?.ruleCount ?? 0} rule(s)
          </p>
        </div>
        <button type="button" onClick={() => void memory.reload()}>
          Refresh
        </button>
      </div>
      {actionError ? <div className="web-error">{actionError}</div> : null}
      <ResourceState
        loading={memory.loading}
        error={memory.error}
        empty={memory.files.length === 0}
        emptyText="No memory files reported by the daemon."
      >
        <div className="files-grid">
          <div className="file-browser">
            {memory.files.map((file) => (
              <button
                key={`${file.scope}:${file.path}`}
                type="button"
                className={
                  file.path === selectedPath ? 'file-row active' : 'file-row'
                }
                onClick={() => void openFile(file.path)}
              >
                <span>{file.scope}</span>
                <strong>{file.path}</strong>
                <em>{file.bytes} bytes</em>
              </button>
            ))}
          </div>
          <div className="file-preview">
            {content === undefined ? (
              <div className="web-empty">Select a memory file to preview.</div>
            ) : (
              <>
                <h3>{selectedPath}</h3>
                <pre>{content}</pre>
              </>
            )}
          </div>
        </div>
      </ResourceState>
    </div>
  );
}

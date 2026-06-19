import { useState } from 'react';
import { useMemory } from '@qwen-code/webui/daemon-react-sdk';
import type { DaemonWorkspaceMemoryFile } from '@qwen-code/webui/daemon-react-sdk';
import { errorMessage, ResourceState } from '../common/ResourceState';

export function MemoryPanel() {
  const memory = useMemory({ autoLoad: true });
  const [selectedFile, setSelectedFile] = useState<DaemonWorkspaceMemoryFile>();
  const [content, setContent] = useState<string>();
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [actionMessage, setActionMessage] = useState<string>();
  const dirty = content !== undefined && draft !== content;

  async function openFile(file: DaemonWorkspaceMemoryFile) {
    if (dirty && !window.confirm('当前 memory 有未保存改动，确认切换？')) {
      return;
    }
    setSelectedFile(file);
    setActionError(undefined);
    setActionMessage(undefined);
    try {
      const result = await memory.readFile(file.path);
      setContent(result.content);
      setDraft(result.content);
    } catch (error) {
      setContent(undefined);
      setDraft('');
      setActionError(errorMessage(error));
    }
  }

  async function reloadFile() {
    if (!selectedFile) return;
    if (dirty && !window.confirm('放弃未保存改动并重新加载？')) return;
    await openFile(selectedFile);
  }

  async function saveFile() {
    if (!selectedFile || selectedFile.scope !== 'workspace') return;
    setSaving(true);
    setActionError(undefined);
    setActionMessage(undefined);
    try {
      const result = await memory.writeMemory({
        scope: selectedFile.scope,
        content: draft,
        mode: 'replace',
      });
      setContent(draft);
      await memory.reload();
      setActionMessage(
        result.changed === false
          ? 'Memory unchanged.'
          : `Saved ${result.filePath}.`,
      );
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setSaving(false);
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
            {dirty ? ' · unsaved changes' : ''}
          </p>
        </div>
        <button type="button" onClick={() => void memory.reload()}>
          Refresh
        </button>
      </div>
      {actionError ? <div className="web-error">{actionError}</div> : null}
      {actionMessage ? (
        <div className="web-action-result">{actionMessage}</div>
      ) : null}
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
                  file.path === selectedFile?.path
                    ? 'file-row active'
                    : 'file-row'
                }
                onClick={() => void openFile(file)}
              >
                <span>{file.scope}</span>
                <strong>{file.path}</strong>
                <em>{file.bytes} bytes</em>
              </button>
            ))}
          </div>
          <div className="file-preview">
            {!selectedFile || content === undefined ? (
              <div className="web-empty">Select a memory file to preview.</div>
            ) : (
              <>
                <div className="file-preview-header">
                  <div>
                    <h3>{selectedFile.path}</h3>
                    {selectedFile.scope === 'global' ? (
                      <p>Global memory is read-only in Web Cockpit.</p>
                    ) : null}
                  </div>
                  <div className="file-preview-actions">
                    <button type="button" onClick={() => void reloadFile()}>
                      Reload file
                    </button>
                    <button
                      type="button"
                      disabled={
                        selectedFile.scope !== 'workspace' || !dirty || saving
                      }
                      onClick={() => void saveFile()}
                    >
                      {saving ? 'Saving' : 'Save changes'}
                    </button>
                  </div>
                </div>
                <textarea
                  className="web-textarea memory-editor"
                  readOnly={selectedFile.scope !== 'workspace'}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                />
              </>
            )}
          </div>
        </div>
      </ResourceState>
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import type {
  DaemonContextFileScope,
  DaemonWorkspaceMemoryStatus,
  DaemonWriteMemoryRequest,
  DaemonWriteMemoryResult,
} from '@qwen-code/sdk/daemon';

interface MemoryDialogProps {
  loadStatus: () => Promise<DaemonWorkspaceMemoryStatus>;
  writeMemory: (
    req: DaemonWriteMemoryRequest,
  ) => Promise<DaemonWriteMemoryResult>;
  onClose: () => void;
}

export function MemoryDialog({
  loadStatus,
  writeMemory,
  onClose,
}: MemoryDialogProps) {
  const [status, setStatus] = useState<DaemonWorkspaceMemoryStatus | null>(
    null,
  );
  const [scope, setScope] = useState<DaemonContextFileScope>('workspace');
  const [mode, setMode] = useState<'append' | 'replace'>('append');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

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
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    const timer = setTimeout(
      () => window.addEventListener('keydown', handler),
      50,
    );
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', handler);
    };
  }, [onClose]);

  const handleSubmit = useCallback(() => {
    const text = content.trim();
    if (!text) {
      setMessage('Memory content is empty.');
      return;
    }
    setSaving(true);
    setMessage(null);
    writeMemory({ scope, mode, content: text })
      .then((result) => {
        setContent('');
        setMessage(
          `${result.mode} ${result.bytesWritten} bytes → ${result.filePath}`,
        );
        reload();
      })
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setSaving(false));
  }, [content, mode, reload, scope, writeMemory]);

  return (
    <div className="resume-picker">
      <div className="resume-picker-header">
        <span className="resume-picker-title">Memory</span>
        <span className="resume-picker-count">
          {status
            ? `${status.fileCount} files · ${status.totalBytes} bytes`
            : ''}
        </span>
      </div>

      <div className="resume-picker-search">
        <span className="resume-picker-search-hint">
          {message ||
            (loading
              ? 'Loading memory...'
              : 'Workspace and global QWEN.md files')}
        </span>
      </div>

      <div className="resume-picker-sep" />

      <div className="resume-picker-list">
        {!loading && status?.files.length === 0 && (
          <div className="resume-picker-empty">No memory files found.</div>
        )}
        {status?.files.map((file) => (
          <div
            key={`${file.scope}:${file.path}`}
            className="resume-picker-item"
          >
            <div className="resume-picker-item-row">
              <span className="resume-picker-item-prefix"> </span>
              <span className="resume-picker-item-title">{file.scope}</span>
              <span className="resume-picker-item-badge">
                {file.bytes} bytes
              </span>
            </div>
            <div className="resume-picker-item-meta">{file.path}</div>
          </div>
        ))}
      </div>

      <div className="resume-picker-sep" />

      <div className="dialog-form">
        <div className="dialog-form-row">
          <label>
            Scope
            <select
              value={scope}
              onChange={(e) =>
                setScope(e.target.value as DaemonContextFileScope)
              }
            >
              <option value="workspace">workspace</option>
              <option value="global">global</option>
            </select>
          </label>
          <label>
            Mode
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as 'append' | 'replace')}
            >
              <option value="append">append</option>
              <option value="replace">replace</option>
            </select>
          </label>
        </div>
        <textarea
          className="dialog-textarea"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Write memory content..."
        />
        <button
          className="dialog-primary-button"
          disabled={saving}
          onClick={handleSubmit}
        >
          {saving ? 'Saving...' : 'Save Memory'}
        </button>
      </div>

      <div className="resume-picker-sep" />

      <div className="resume-picker-footer">Esc to close</div>
    </div>
  );
}

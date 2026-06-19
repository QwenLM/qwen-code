import { useEffect, useMemo, useState } from 'react';
import { useFiles } from '@qwen-code/webui/daemon-react-sdk';
import type { DaemonDirectoryEntry } from '@qwen-code/webui/daemon-react-sdk';
import { errorMessage } from '../common/ResourceState';

type PreviewState =
  | { kind: 'idle' }
  | { kind: 'loading'; path: string }
  | { kind: 'text'; path: string; content: string; truncated: boolean }
  | { kind: 'data'; path: string; mimeType: string; dataUrl: string }
  | { kind: 'error'; path?: string; message: string };

export function FilesPanel() {
  const files = useFiles();
  const [currentPath, setCurrentPath] = useState('.');
  const [entries, setEntries] = useState<DaemonDirectoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [panelError, setPanelError] = useState<string>();
  const [preview, setPreview] = useState<PreviewState>({ kind: 'idle' });

  async function loadDirectory(path: string) {
    setLoading(true);
    setPanelError(undefined);
    try {
      const listing = await files.listDirectory(path);
      setCurrentPath(listing.path);
      setEntries(listing.entries);
    } catch (error) {
      setPanelError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadDirectory('.');
    // Run once when the daemon file actions become available.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const parentPath = useMemo(() => getParentPath(currentPath), [currentPath]);

  async function openEntry(entry: DaemonDirectoryEntry) {
    const entryPath = joinPath(currentPath, entry.name);
    if (entry.kind === 'directory') {
      await loadDirectory(entryPath);
      return;
    }
    await previewFile(entryPath);
  }

  async function previewFile(path: string) {
    setPreview({ kind: 'loading', path });
    try {
      const bytes = await files.readFileBytes(path, { maxBytes: 256 * 1024 });
      const mimeType = detectMimeType(path);
      if (mimeType.startsWith('image/') || mimeType === 'application/pdf') {
        setPreview({
          kind: 'data',
          path,
          mimeType,
          dataUrl: `data:${mimeType};base64,${bytes.contentBase64}`,
        });
        return;
      }
      setPreview({
        kind: 'text',
        path,
        content: decodeBase64(bytes.contentBase64),
        truncated: bytes.truncated,
      });
    } catch (error) {
      setPreview({ kind: 'error', path, message: errorMessage(error) });
    }
  }

  return (
    <div className="web-panel files-panel">
      <div className="web-panel-header">
        <div>
          <h2>Files</h2>
          <p>{currentPath}</p>
        </div>
        <div className="web-actions">
          <button type="button" onClick={() => void loadDirectory(currentPath)}>
            Refresh
          </button>
          <button
            type="button"
            disabled={!parentPath}
            onClick={() => parentPath && void loadDirectory(parentPath)}
          >
            Up
          </button>
        </div>
      </div>
      {panelError ? <div className="web-error">{panelError}</div> : null}
      <div className="files-grid">
        <div className="file-browser">
          {loading ? <div className="web-empty">Loading…</div> : null}
          {!loading && entries.length === 0 ? (
            <div className="web-empty">No entries.</div>
          ) : null}
          {!loading
            ? entries.map((entry) => (
                <button
                  key={`${entry.kind}:${entry.name}`}
                  type="button"
                  className="file-row"
                  onClick={() => void openEntry(entry)}
                >
                  <span>{entry.kind === 'directory' ? 'dir' : entry.kind}</span>
                  <strong>{entry.name}</strong>
                  {entry.ignored ? <em>ignored</em> : null}
                </button>
              ))
            : null}
        </div>
        <PreviewPane preview={preview} />
      </div>
    </div>
  );
}

function PreviewPane({ preview }: { preview: PreviewState }) {
  if (preview.kind === 'idle') {
    return (
      <div className="file-preview web-empty">Select a file to preview.</div>
    );
  }
  if (preview.kind === 'loading') {
    return (
      <div className="file-preview web-empty">Loading {preview.path}…</div>
    );
  }
  if (preview.kind === 'error') {
    return <div className="file-preview web-error">{preview.message}</div>;
  }
  if (preview.kind === 'data') {
    return (
      <div className="file-preview">
        <h3>{preview.path}</h3>
        {preview.mimeType === 'application/pdf' ? (
          <iframe title={preview.path} src={preview.dataUrl} />
        ) : (
          <img src={preview.dataUrl} alt={preview.path} />
        )}
      </div>
    );
  }
  return (
    <div className="file-preview">
      <h3>{preview.path}</h3>
      {preview.truncated ? <p>Preview truncated at 256 KiB.</p> : null}
      <pre>{preview.content}</pre>
    </div>
  );
}

function joinPath(parent: string, name: string): string {
  if (parent === '.' || parent === '') return name;
  return `${parent.replace(/\/$/, '')}/${name}`;
}

function getParentPath(path: string): string | undefined {
  if (path === '.' || path === '') return undefined;
  const idx = path.lastIndexOf('/');
  if (idx <= 0) return '.';
  return path.slice(0, idx);
}

function detectMimeType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  return 'text/plain;charset=utf-8';
}

function decodeBase64(input: string): string {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

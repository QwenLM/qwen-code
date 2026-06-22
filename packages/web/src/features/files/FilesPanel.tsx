import { useEffect, useMemo, useRef, useState } from 'react';
import { useFiles } from '@qwen-code/webui/daemon-react-sdk';
import type {
  DaemonDirectoryEntry,
  DaemonFileStat,
} from '@qwen-code/webui/daemon-react-sdk';
import { errorMessage } from '../common/ResourceState';

const PREVIEW_MAX_BYTES = 256 * 1024;
const GLOB_MAX_RESULTS = 100;

interface FilesPanelProps {
  initialPath?: string;
  onAddToChat?: (path: string) => void;
  onPathChange?: (path: string) => void;
}

type PreviewState =
  | { kind: 'idle' }
  | { kind: 'loading'; path: string }
  | {
      kind: 'text';
      path: string;
      content: string;
      mimeType: string;
      truncated: boolean;
    }
  | { kind: 'data'; path: string; mimeType: string; dataUrl: string }
  | { kind: 'error'; path?: string; message: string };

interface BreadcrumbItem {
  label: string;
  path: string;
}

export function FilesPanel({
  initialPath,
  onAddToChat,
  onPathChange,
}: FilesPanelProps) {
  const files = useFiles();
  const syncedPathRef = useRef<string | undefined>(undefined);
  const [currentPath, setCurrentPath] = useState('.');
  const [entries, setEntries] = useState<DaemonDirectoryEntry[]>([]);
  const [listingTruncated, setListingTruncated] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string>();
  const [selectedStat, setSelectedStat] = useState<DaemonFileStat>();
  const [statError, setStatError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [panelError, setPanelError] = useState<string>();
  const [preview, setPreview] = useState<PreviewState>({ kind: 'idle' });
  const [globPattern, setGlobPattern] = useState('');
  const [globResults, setGlobResults] = useState<string[]>();
  const [globLoading, setGlobLoading] = useState(false);
  const [globError, setGlobError] = useState<string>();
  const [copiedPath, setCopiedPath] = useState<string>();

  async function loadDirectory(
    path: string,
    options: { syncPath?: boolean } = {},
  ) {
    setLoading(true);
    setPanelError(undefined);
    try {
      const listing = await files.listDirectory(path);
      setCurrentPath(listing.path);
      setEntries(listing.entries);
      setListingTruncated(listing.truncated);
      if (options.syncPath !== false) {
        syncedPathRef.current = listing.path;
        onPathChange?.(listing.path);
      }
    } catch (error) {
      setPanelError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  async function openInitialPath(path: string) {
    setPanelError(undefined);
    try {
      const stat = await files.stat(path);
      if (stat.type === 'directory') {
        await loadDirectory(path, { syncPath: false });
        return;
      }
      const parentPath = getParentPath(path) ?? '.';
      await loadDirectory(parentPath, { syncPath: false });
      await previewFile(path, { syncPath: false });
    } catch (error) {
      setPanelError(errorMessage(error));
      await loadDirectory('.', { syncPath: false });
    }
  }

  useEffect(() => {
    const path = initialPath || '.';
    if (syncedPathRef.current === path) return;
    syncedPathRef.current = path;
    void openInitialPath(path);
    // Sync when the URL path changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPath]);

  const parentPath = useMemo(() => getParentPath(currentPath), [currentPath]);
  const breadcrumbs = useMemo(() => getBreadcrumbs(currentPath), [currentPath]);
  const sortedEntries = useMemo(() => sortEntries(entries), [entries]);

  async function openEntry(entry: DaemonDirectoryEntry) {
    const entryPath = joinPath(currentPath, entry.name);
    if (entry.kind === 'directory') {
      await loadDirectory(entryPath);
      return;
    }
    await previewFile(entryPath);
  }

  async function previewFile(
    path: string,
    options: { syncPath?: boolean } = {},
  ) {
    setSelectedPath(path);
    setSelectedStat(undefined);
    setStatError(undefined);
    setPreview({ kind: 'loading', path });
    if (options.syncPath !== false) {
      syncedPathRef.current = path;
      onPathChange?.(path);
    }
    void loadFileStat(path);
    try {
      const bytes = await files.readFileBytes(path, {
        maxBytes: PREVIEW_MAX_BYTES,
      });
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
      const text = decodeBase64(bytes.contentBase64);
      if (text === null) {
        setPreview({
          kind: 'error',
          path,
          message: 'Failed to decode file content: invalid base64 data.',
        });
        return;
      }
      setPreview({
        kind: 'text',
        path,
        mimeType,
        content: text,
        truncated: bytes.truncated,
      });
    } catch (error) {
      setPreview({ kind: 'error', path, message: errorMessage(error) });
    }
  }

  async function loadFileStat(path: string) {
    try {
      setSelectedStat(await files.stat(path));
    } catch (error) {
      setStatError(errorMessage(error));
    }
  }

  async function searchFiles() {
    const pattern = globPattern.trim();
    if (!pattern) {
      setGlobResults(undefined);
      setGlobError(undefined);
      return;
    }
    setGlobLoading(true);
    setGlobError(undefined);
    try {
      const result = await files.globWorkspace(pattern, {
        maxResults: GLOB_MAX_RESULTS,
      });
      setGlobResults(result.matches);
    } catch (error) {
      setGlobError(errorMessage(error));
    } finally {
      setGlobLoading(false);
    }
  }

  function clearSearch() {
    setGlobPattern('');
    setGlobResults(undefined);
    setGlobError(undefined);
  }

  async function copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
      setCopiedPath(path);
      window.setTimeout(() => setCopiedPath(undefined), 1200);
    } catch (error) {
      setPanelError(errorMessage(error));
    }
  }

  return (
    <div className="web-panel files-panel">
      <div className="web-panel-header">
        <div>
          <h2>文件</h2>
          <Breadcrumbs items={breadcrumbs} onOpen={loadDirectory} />
        </div>
        <div className="web-actions">
          <button type="button" onClick={() => void loadDirectory(currentPath)}>
            刷新
          </button>
          <button
            type="button"
            disabled={!parentPath}
            onClick={() => parentPath && void loadDirectory(parentPath)}
          >
            上一级
          </button>
        </div>
      </div>
      <form
        className="file-search"
        onSubmit={(event) => {
          event.preventDefault();
          void searchFiles();
        }}
      >
        <input
          aria-label="搜索文件"
          name="file-search"
          value={globPattern}
          onChange={(event) => setGlobPattern(event.target.value)}
          placeholder="搜索文件，例如 **/*.tsx"
        />
        <button type="submit" disabled={globLoading}>
          {globLoading ? '搜索中' : '搜索'}
        </button>
        <button type="button" onClick={clearSearch} disabled={!globPattern}>
          清除
        </button>
      </form>
      {globError ? <div className="web-error">{globError}</div> : null}
      {globResults ? (
        <SearchResults
          results={globResults}
          onOpenFile={previewFile}
          onOpenFolder={loadDirectory}
        />
      ) : null}
      {panelError ? <div className="web-error">{panelError}</div> : null}
      {listingTruncated ? (
        <div className="file-truncated-notice">
          目录结果已截断，可用搜索缩小范围。
        </div>
      ) : null}
      <div className="files-grid">
        <div className="file-browser">
          {loading ? <div className="web-empty">加载中…</div> : null}
          {!loading && sortedEntries.length === 0 ? (
            <div className="web-empty">当前目录暂无内容。</div>
          ) : null}
          {!loading
            ? sortedEntries.map((entry) => {
                const entryPath = joinPath(currentPath, entry.name);
                const active = entryPath === selectedPath;
                return (
                  <button
                    key={`${entry.kind}:${entry.name}`}
                    type="button"
                    className={active ? 'file-row active' : 'file-row'}
                    onClick={() => void openEntry(entry)}
                  >
                    <span>
                      {entry.kind === 'directory' ? 'dir' : entry.kind}
                    </span>
                    <strong>{entry.name}</strong>
                    {entry.ignored ? <em>ignored</em> : null}
                  </button>
                );
              })
            : null}
        </div>
        <PreviewPane
          copied={preview.kind !== 'idle' && preview.path === copiedPath}
          onAddToChat={onAddToChat}
          onCopyPath={copyPath}
          preview={preview}
          stat={
            preview.kind !== 'idle' && selectedStat?.path === preview.path
              ? selectedStat
              : undefined
          }
          statError={statError}
        />
      </div>
    </div>
  );
}

function Breadcrumbs({
  items,
  onOpen,
}: {
  items: BreadcrumbItem[];
  onOpen: (path: string) => Promise<void>;
}) {
  return (
    <nav className="file-breadcrumbs" aria-label="文件路径">
      {items.map((item, index) => (
        <span key={item.path}>
          {index > 0 ? (
            <span className="file-breadcrumb-separator">/</span>
          ) : null}
          <button type="button" onClick={() => void onOpen(item.path)}>
            {item.label}
          </button>
        </span>
      ))}
    </nav>
  );
}

function SearchResults({
  results,
  onOpenFile,
  onOpenFolder,
}: {
  results: string[];
  onOpenFile: (path: string) => Promise<void>;
  onOpenFolder: (path: string) => Promise<void>;
}) {
  return (
    <div className="file-search-results">
      <div className="file-search-results-header">
        <strong>{results.length} 个结果</strong>
        {results.length >= GLOB_MAX_RESULTS ? (
          <span>仅显示前 100 条</span>
        ) : null}
      </div>
      {results.length === 0 ? <p>没有匹配的文件。</p> : null}
      {results.map((path) => {
        const parentPath = getParentPath(path) ?? '.';
        return (
          <div className="file-search-result" key={path}>
            <button type="button" onClick={() => void onOpenFile(path)}>
              {path}
            </button>
            <button type="button" onClick={() => void onOpenFolder(parentPath)}>
              打开目录
            </button>
          </div>
        );
      })}
    </div>
  );
}

function PreviewPane({
  copied,
  onAddToChat,
  onCopyPath,
  preview,
  stat,
  statError,
}: {
  copied: boolean;
  onAddToChat?: (path: string) => void;
  onCopyPath: (path: string) => Promise<void>;
  preview: PreviewState;
  stat?: DaemonFileStat;
  statError?: string;
}) {
  if (preview.kind === 'idle') {
    return <div className="file-preview web-empty">选择文件后在这里预览。</div>;
  }
  if (preview.kind === 'loading') {
    return (
      <div className="file-preview web-empty">正在加载 {preview.path}…</div>
    );
  }
  if (preview.kind === 'error') {
    return (
      <div className="file-preview">
        <PreviewHeader
          copied={copied}
          onAddToChat={onAddToChat}
          onCopyPath={onCopyPath}
          path={preview.path}
        />
        <div className="web-error">{preview.message}</div>
      </div>
    );
  }
  return (
    <div className="file-preview">
      <PreviewHeader
        copied={copied}
        onAddToChat={onAddToChat}
        onCopyPath={onCopyPath}
        path={preview.path}
      />
      <FileMetadata preview={preview} stat={stat} statError={statError} />
      {preview.kind === 'data' ? (
        preview.mimeType === 'application/pdf' ? (
          <iframe title={preview.path} src={preview.dataUrl} />
        ) : (
          <img src={preview.dataUrl} alt={preview.path} />
        )
      ) : preview.mimeType.startsWith('text/html') ? (
        <>
          {preview.truncated ? (
            <p>预览已截断在 {formatBytes(PREVIEW_MAX_BYTES)}。</p>
          ) : null}
          <iframe
            className="file-html-preview"
            sandbox=""
            srcDoc={preview.content}
            title={preview.path}
          />
        </>
      ) : (
        <>
          {preview.truncated ? (
            <p>预览已截断在 {formatBytes(PREVIEW_MAX_BYTES)}。</p>
          ) : null}
          <pre>{preview.content}</pre>
        </>
      )}
    </div>
  );
}

function PreviewHeader({
  copied,
  onAddToChat,
  onCopyPath,
  path,
}: {
  copied: boolean;
  onAddToChat?: (path: string) => void;
  onCopyPath: (path: string) => Promise<void>;
  path?: string;
}) {
  if (!path) return null;
  return (
    <div className="file-preview-header">
      <h3>{path}</h3>
      <div className="file-preview-actions">
        <button type="button" onClick={() => void onCopyPath(path)}>
          {copied ? '已复制' : '复制路径'}
        </button>
        {onAddToChat ? (
          <button type="button" onClick={() => onAddToChat(path)}>
            引用到 Chat
          </button>
        ) : null}
      </div>
    </div>
  );
}

function FileMetadata({
  preview,
  stat,
  statError,
}: {
  preview: Exclude<PreviewState, { kind: 'idle' | 'loading' | 'error' }>;
  stat?: DaemonFileStat;
  statError?: string;
}) {
  return (
    <dl className="file-metadata">
      <div>
        <dt>Preview</dt>
        <dd>{preview.kind === 'data' ? preview.mimeType : preview.mimeType}</dd>
      </div>
      {stat ? (
        <>
          <div>
            <dt>Type</dt>
            <dd>{stat.type}</dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>{formatBytes(stat.sizeBytes)}</dd>
          </div>
          <div>
            <dt>Modified</dt>
            <dd>{formatTime(stat.modifiedMs)}</dd>
          </div>
        </>
      ) : null}
      {statError ? (
        <div>
          <dt>Metadata</dt>
          <dd>{statError}</dd>
        </div>
      ) : null}
    </dl>
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

function getBreadcrumbs(path: string): BreadcrumbItem[] {
  if (path === '.' || path === '') return [{ label: 'Workspace', path: '.' }];
  const parts = path.split('/').filter(Boolean);
  const items: BreadcrumbItem[] = [{ label: 'Workspace', path: '.' }];
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    items.push({ label: part, path: current });
  }
  return items;
}

function sortEntries(entries: DaemonDirectoryEntry[]) {
  return [...entries].sort((a, b) => {
    if (a.kind === 'directory' && b.kind !== 'directory') return -1;
    if (a.kind !== 'directory' && b.kind === 'directory') return 1;
    return a.name.localeCompare(b.name);
  });
}

function detectMimeType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.json')) return 'application/json;charset=utf-8';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
    return 'text/markdown;charset=utf-8';
  }
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    return 'text/html;charset=utf-8';
  }
  return 'text/plain;charset=utf-8';
}

function decodeBase64(input: string): string | null {
  try {
    const binary = atob(input);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
}

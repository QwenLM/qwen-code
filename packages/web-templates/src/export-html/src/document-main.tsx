import './document-styles.css';
import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';
// Transcript-only subpath: the package root also pulls in the interactive
// shell (App, daemon providers, editor chrome), which a read-only export
// never uses. Keep this import narrow so the inlined runtime stays small
// (see https://github.com/QwenLM/qwen-code/issues/11031).
import { WebShellTranscript } from '@qwen-code/web-shell/transcript';

declare const __EXPORT_TRANSCRIPT_RENDERER_VERSION__: string;
declare const __EXPORT_TRANSCRIPT_MAX_BLOCKS__: number;
declare const __EXPORT_TRANSCRIPT_MAX_ENVELOPE_BYTES__: number;

interface ExportTranscriptDocument {
  schemaVersion: 1;
  rendererVersion: string;
  blocks: DaemonTranscriptBlock[];
  metadata: {
    title?: string;
    startedAt?: string;
    exportedAt: string;
    complete: boolean;
    truncated: boolean;
    projectName?: string;
    repository?: string;
    gitBranch?: string;
    model?: string;
    channel?: string;
    promptCount?: number;
    contextUsagePercent?: number;
    contextWindowSize?: number;
    totalTokens?: number;
    filesWritten?: number;
    linesAdded?: number;
    linesRemoved?: number;
  };
}

type DocumentTheme = 'light' | 'dark';

const DOCUMENT_THEME_STORAGE_KEY = 'qwen-export-theme';

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isOptionalNonNegativeNumber(
  value: unknown,
): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === 'number' && Number.isFinite(value) && value >= 0)
  );
}

function parseDocument(): ExportTranscriptDocument {
  const envelope = document.getElementById('transcript-document');
  if (!(envelope instanceof HTMLScriptElement)) {
    throw new Error('Transcript document envelope is missing.');
  }
  const serialized = envelope.textContent ?? '';
  if (serialized.length > __EXPORT_TRANSCRIPT_MAX_ENVELOPE_BYTES__) {
    throw new Error('Transcript document exceeds the envelope budget.');
  }
  if (
    new TextEncoder().encode(serialized).byteLength >
    __EXPORT_TRANSCRIPT_MAX_ENVELOPE_BYTES__
  ) {
    throw new Error('Transcript document exceeds the envelope budget.');
  }
  const value = JSON.parse(serialized) as Partial<ExportTranscriptDocument>;
  if (
    value.schemaVersion !== 1 ||
    value.rendererVersion !== __EXPORT_TRANSCRIPT_RENDERER_VERSION__ ||
    !Array.isArray(value.blocks) ||
    value.blocks.length > __EXPORT_TRANSCRIPT_MAX_BLOCKS__ ||
    !value.metadata ||
    typeof value.metadata !== 'object' ||
    Array.isArray(value.metadata) ||
    !isOptionalString(value.metadata.title) ||
    !isOptionalString(value.metadata.startedAt) ||
    !isOptionalString(value.metadata.projectName) ||
    !isOptionalString(value.metadata.repository) ||
    !isOptionalString(value.metadata.gitBranch) ||
    !isOptionalString(value.metadata.model) ||
    !isOptionalString(value.metadata.channel) ||
    !isOptionalNonNegativeNumber(value.metadata.promptCount) ||
    !isOptionalNonNegativeNumber(value.metadata.contextUsagePercent) ||
    !isOptionalNonNegativeNumber(value.metadata.contextWindowSize) ||
    !isOptionalNonNegativeNumber(value.metadata.totalTokens) ||
    !isOptionalNonNegativeNumber(value.metadata.filesWritten) ||
    !isOptionalNonNegativeNumber(value.metadata.linesAdded) ||
    !isOptionalNonNegativeNumber(value.metadata.linesRemoved) ||
    typeof value.metadata.exportedAt !== 'string' ||
    typeof value.metadata.complete !== 'boolean' ||
    typeof value.metadata.truncated !== 'boolean'
  ) {
    throw new Error('Transcript document is incompatible with this renderer.');
  }
  return value as ExportTranscriptDocument;
}

function readInitialTheme(): DocumentTheme {
  try {
    const stored = localStorage.getItem(DOCUMENT_THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Local storage may be unavailable for a standalone file.
  }
  return 'dark';
}

function formatDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatTokenLimit(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value >= 1_000_000) return `${value / 1_000_000}m`;
  if (value >= 1_000) return `${value / 1_000}k`;
  return String(value);
}

function MetadataItem({
  label,
  value,
}: {
  label: string;
  value: string | number | undefined;
}) {
  if (value === undefined || value === '') return null;
  return (
    <div className="document-metadata-item">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function DocumentMetadata({
  metadata,
}: {
  metadata: ExportTranscriptDocument['metadata'];
}) {
  const contextUsage =
    metadata.contextUsagePercent === undefined
      ? undefined
      : `${metadata.contextUsagePercent > 100 ? '>100' : metadata.contextUsagePercent}%${
          metadata.contextWindowSize === undefined
            ? ''
            : ` of ${formatTokenLimit(metadata.contextWindowSize)}`
        }`;
  return (
    <aside className="document-metadata" data-document-metadata>
      <section>
        <h2>Session Info</h2>
        <dl>
          <MetadataItem
            label="Session"
            value={metadata.title ?? 'Qwen Code Chat Export'}
          />
          <MetadataItem
            label="Started"
            value={formatDate(metadata.startedAt)}
          />
          <MetadataItem
            label="Exported"
            value={formatDate(metadata.exportedAt)}
          />
          <MetadataItem label="Project" value={metadata.projectName} />
          <MetadataItem label="Repository" value={metadata.repository} />
          <MetadataItem label="Branch" value={metadata.gitBranch} />
          <MetadataItem label="Model" value={metadata.model} />
          <MetadataItem label="Channel" value={metadata.channel} />
        </dl>
      </section>
      <section>
        <h2>Statistics</h2>
        <dl>
          <MetadataItem label="Prompts" value={metadata.promptCount} />
          <MetadataItem label="Context Usage" value={contextUsage} />
          <MetadataItem
            label="Tokens"
            value={metadata.totalTokens?.toLocaleString()}
          />
        </dl>
      </section>
      <section>
        <h2>File Operations</h2>
        <dl>
          <MetadataItem label="Files modified" value={metadata.filesWritten} />
          <MetadataItem label="Lines added" value={metadata.linesAdded} />
          <MetadataItem label="Lines removed" value={metadata.linesRemoved} />
        </dl>
      </section>
    </aside>
  );
}

function DocumentApp({ value }: { value: ExportTranscriptDocument }) {
  const [theme, setTheme] = useState<DocumentTheme>(readInitialTheme);
  const [expanded, setExpanded] = useState(true);
  const expandedRef = useRef(expanded);
  const restoreAfterPrintRef = useRef<boolean | null>(null);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.classList.toggle('light', theme === 'light');
    try {
      localStorage.setItem(DOCUMENT_THEME_STORAGE_KEY, theme);
    } catch {
      // Persistence is best-effort for standalone files.
    }
  }, [theme]);

  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  useEffect(() => {
    const expandForPrint = () => {
      restoreAfterPrintRef.current = expandedRef.current;
      flushSync(() => setExpanded(true));
    };
    const restoreAfterPrint = () => {
      const previous = restoreAfterPrintRef.current;
      restoreAfterPrintRef.current = null;
      if (previous !== null) flushSync(() => setExpanded(previous));
    };
    addEventListener('beforeprint', expandForPrint);
    addEventListener('afterprint', restoreAfterPrint);
    return () => {
      removeEventListener('beforeprint', expandForPrint);
      removeEventListener('afterprint', restoreAfterPrint);
    };
  }, []);

  useEffect(() => {
    document.title = value.metadata.title || 'Qwen Code Chat Export';
    requestAnimationFrame(() => {
      document.body.dataset.renderComplete = 'true';
    });
  }, [value.metadata.title]);

  return (
    <main className="document-shell">
      <header className="document-header">
        <div>
          <h1>{value.metadata.title || 'Qwen Code Chat Export'}</h1>
          <p>
            {value.metadata.startedAt
              ? `Started ${value.metadata.startedAt}`
              : `Exported ${value.metadata.exportedAt}`}
          </p>
        </div>
        {(!value.metadata.complete || value.metadata.truncated) && (
          <span className="document-warning">Partial export</span>
        )}
        <div className="document-actions" aria-label="Document controls">
          <button
            type="button"
            data-document-expand-all
            disabled={expanded}
            onClick={() => setExpanded(true)}
          >
            Expand all
          </button>
          <button
            type="button"
            data-document-collapse-all
            disabled={!expanded}
            onClick={() => setExpanded(false)}
          >
            Collapse all
          </button>
          <button
            type="button"
            data-document-theme-toggle
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            onClick={() =>
              setTheme((current) => (current === 'dark' ? 'light' : 'dark'))
            }
          >
            {theme === 'dark' ? 'Light theme' : 'Dark theme'}
          </button>
        </div>
      </header>
      <div className="document-content">
        <div className="document-transcript">
          <WebShellTranscript
            blocks={value.blocks}
            renderMode="document"
            compactThinking
            documentExpanded={expanded}
            theme={theme}
          />
        </div>
        <DocumentMetadata metadata={value.metadata} />
      </div>
    </main>
  );
}

function DocumentError() {
  useEffect(() => {
    document.body.dataset.renderComplete = 'error';
  }, []);
  return (
    <main className="document-error" role="alert">
      <h1>Unable to open this chat export</h1>
      <p>The file is incomplete or uses an incompatible renderer version.</p>
    </main>
  );
}

class DocumentErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? <DocumentError /> : this.props.children;
  }
}

const rootNode = document.getElementById('app');
if (!rootNode) throw new Error('Transcript document root is missing.');
const root = createRoot(rootNode);
try {
  root.render(
    <DocumentErrorBoundary>
      <DocumentApp value={parseDocument()} />
    </DocumentErrorBoundary>,
  );
} catch {
  root.render(<DocumentError />);
}

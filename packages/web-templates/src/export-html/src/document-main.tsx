import './document-styles.css';
import { Component, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';
import { WebShellTranscript } from '@qwen-code/web-shell';

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
  };
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
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
    typeof value.metadata.exportedAt !== 'string' ||
    typeof value.metadata.complete !== 'boolean' ||
    typeof value.metadata.truncated !== 'boolean'
  ) {
    throw new Error('Transcript document is incompatible with this renderer.');
  }
  return value as ExportTranscriptDocument;
}

function DocumentApp({ value }: { value: ExportTranscriptDocument }) {
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
      </header>
      <WebShellTranscript
        blocks={value.blocks}
        renderMode="document"
        compactThinking
        theme="light"
      />
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

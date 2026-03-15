import './styles.css';
import logoSvg from './favicon.svg';
import { TempFileModal, useModalState } from './components/TempFileModal';

declare global {
  interface Window {
    React: typeof import('react');
    ReactDOM: typeof import('react-dom/client');
  }
}

const ReactDOM = window.ReactDOM;

declare const QwenCodeWebUI: {
  ChatViewer: (props: {
    messages: unknown[];
    autoScroll: boolean;
    theme: string;
  }) => React.ReactNode;
  PlatformProvider: (props: {
    value: unknown;
    children: React.ReactNode;
  }) => React.ReactNode;
};

const { ChatViewer, PlatformProvider } = QwenCodeWebUI;

type ChatData = {
  messages?: unknown[];
  sessionId?: string;
  startTime?: string;
  metadata?: ExportMetadata;
};

type ExportMetadata = {
  sessionId: string;
  startTime: string;
  relativeTime: string;
  exportTime: string;
  cwd: string;
  gitBranch?: string;
  model?: string;
  channel?: string;
  promptCount: number;
  contextUsagePercent?: number;
  totalTokens?: number;
  filesRead?: number;
  filesWritten?: number;
  linesAdded?: number;
  linesRemoved?: number;
  uniqueFiles: string[];
  requestId?: string;
};

type PlatformContextValue = {
  platform: 'web';
  postMessage: (message: unknown) => void;
  onMessage: (handler: (event: MessageEvent) => void) => () => void;
  openFile: (path: string) => void;
  openTempFile?: (content: string, fileName?: string) => void;
  getResourceUrl: () => string | undefined;
  features: {
    canOpenFile: boolean;
    canOpenTempFile?: boolean;
    canCopy: boolean;
  };
};
type ChatViewerMessage = { type?: string } & Record<string, unknown>;

const logoSvgWithGradient = (() => {
  if (!logoSvg) {
    return logoSvg;
  }

  const gradientDef =
    '<defs><linearGradient id="qwen-logo-gradient" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#60a5fa" /><stop offset="100%" stop-color="#a855f7" /></linearGradient></defs>';

  const withDefs = logoSvg.replace(/<svg([^>]*)>/, `<svg$1>${gradientDef}`);

  return withDefs.replace(/fill="[^"]*"/, 'fill="url(#qwen-logo-gradient)"');
})();

const React = window.React;

const usePlatformContext = () => {
  const { modalState, openModal, closeModal } = useModalState();

  const platformContext = React.useMemo(
    () =>
      ({
        platform: 'web' as PlatformContextValue['platform'],
        postMessage: (message: unknown) => {
          console.log('Posted message:', message);
        },
        onMessage: (handler: (event: MessageEvent) => void) => {
          window.addEventListener('message', handler);
          return () => window.removeEventListener('message', handler);
        },
        openFile: (path: string) => {
          console.log('Opening file:', path);
        },
        openTempFile: openModal,
        getResourceUrl: () => undefined,
        features: {
          canOpenFile: false,
          canOpenTempFile: true,
          canCopy: true,
        },
      }) satisfies PlatformContextValue,
    [openModal],
  );

  return { platformContext, modalState, closeModal };
};

const isChatViewerMessage = (value: unknown): value is ChatViewerMessage =>
  Boolean(value) && typeof value === 'object';

const parseChatData = (): ChatData => {
  const chatDataElement = document.getElementById('chat-data');
  if (!chatDataElement?.textContent) {
    return {};
  }

  try {
    const parsed = JSON.parse(chatDataElement.textContent) as unknown;
    if (parsed && typeof parsed === 'object') {
      return parsed as ChatData;
    }
    return {};
  } catch (error) {
    console.error('Failed to parse chat data.', error);
    return {};
  }
};

const formatSessionDate = (startTime?: string | null) => {
  if (!startTime) {
    return '-';
  }

  try {
    const date = new Date(startTime);
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return startTime;
  }
};

const formatExportTime = (exportTime?: string | null) => {
  if (!exportTime) {
    return '-';
  }

  try {
    const date = new Date(exportTime);
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return exportTime;
  }
};

const formatPath = (path: string, maxLength: number = 40) => {
  if (!path || path.length <= maxLength) return path;
  const parts = path.split('/');
  if (parts.length <= 2) return '...' + path.slice(-maxLength + 3);
  return '...' + path.slice(-maxLength + 3);
};

const CopyButton = ({ text }: { text: string }) => {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="copy-button"
      title={copied ? 'Copied!' : 'Copy to clipboard'}
      aria-label={copied ? 'Copied!' : 'Copy to clipboard'}
    >
      {copied ? (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
};

const MetadataItem = ({
  label,
  value,
  valueClass,
}: {
  label: string;
  value?: string | number;
  valueClass?: string;
}) => {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return (
    <div className="metadata-item">
      <div className="metadata-content">
        <span className="metadata-label">{label}</span>
        <span
          className={`metadata-value ${valueClass || ''}`}
          title={typeof value === 'string' ? value : undefined}
        >
          {value}
        </span>
      </div>
    </div>
  );
};

const MetadataSidebar = ({ metadata }: { metadata: ExportMetadata }) => {
  const uniqueFilesCount = metadata.uniqueFiles?.length ?? 0;

  return (
    <aside className="metadata-sidebar">
      <div className="metadata-section">
        <h3 className="metadata-section-title">Session Info</h3>
        <MetadataItem label="Time" value={metadata.relativeTime} />
        <MetadataItem label="Project" value={formatPath(metadata.cwd)} />
        {metadata.gitBranch && (
          <MetadataItem label="Branch" value={metadata.gitBranch} />
        )}
        {metadata.model && (
          <MetadataItem label="Model" value={metadata.model} />
        )}
        {metadata.channel && (
          <MetadataItem label="Channel" value={metadata.channel} />
        )}
      </div>

      <div className="metadata-section">
        <h3 className="metadata-section-title">Statistics</h3>
        <MetadataItem label="Prompts" value={metadata.promptCount} />
        {metadata.contextUsagePercent !== undefined && (
          <MetadataItem
            label="Context"
            value={`${metadata.contextUsagePercent}% of 128k`}
          />
        )}
        {metadata.totalTokens !== undefined && (
          <MetadataItem
            label="Tokens"
            value={metadata.totalTokens.toLocaleString()}
          />
        )}
        <MetadataItem label="Files" value={uniqueFilesCount} />
      </div>

      <div className="metadata-section">
        <h3 className="metadata-section-title">File Operations</h3>
        {metadata.filesRead !== undefined && metadata.filesRead > 0 && (
          <MetadataItem label="Read" value={metadata.filesRead} />
        )}
        {metadata.filesWritten !== undefined && metadata.filesWritten > 0 && (
          <MetadataItem label="Written" value={metadata.filesWritten} />
        )}
        {metadata.linesAdded !== undefined && metadata.linesAdded > 0 && (
          <MetadataItem
            label="Added"
            value={`+${metadata.linesAdded}`}
            valueClass="text-green"
          />
        )}
        {metadata.linesRemoved !== undefined && metadata.linesRemoved > 0 && (
          <MetadataItem
            label="Removed"
            value={`-${metadata.linesRemoved}`}
            valueClass="text-red"
          />
        )}
      </div>

      <div className="metadata-section metadata-section-small">
        {metadata.requestId ? (
          <div className="metadata-item">
            <div className="metadata-content">
              <span className="metadata-label">Request Id</span>
              <div className="metadata-value-with-copy">
                <span className="metadata-value font-mono">
                  {metadata.requestId}
                </span>
                <CopyButton text={metadata.requestId} />
              </div>
            </div>
          </div>
        ) : (
          <MetadataItem
            label="Session ID"
            value={metadata.sessionId}
            valueClass="font-mono"
          />
        )}
        <MetadataItem
          label="Export Time"
          value={formatExportTime(metadata.exportTime)}
        />
      </div>
    </aside>
  );
};

const App = () => {
  const chatData = parseChatData();
  const rawMessages = Array.isArray(chatData.messages) ? chatData.messages : [];
  const messages = rawMessages
    .filter(isChatViewerMessage)
    .filter((record) => record.type !== 'system');
  const sessionId = chatData.sessionId ?? '-';
  const sessionDate = formatSessionDate(chatData.startTime);
  const metadata = chatData.metadata;
  const { platformContext, modalState, closeModal } = usePlatformContext();

  return (
    <div className="page-wrapper">
      <header className="header">
        <div className="header-left">
          <div
            className="logo-icon"
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: logoSvgWithGradient }}
          />
          <div className="logo">
            <div className="logo-text" data-text="QWEN">
              <span className="logo-text-inner">QWEN</span>
            </div>
          </div>
        </div>
        <div className="meta">
          <div className="meta-item">
            <span className="meta-label">Session Id</span>
            <span className="font-mono">{sessionId}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Export Time</span>
            <span>{sessionDate}</span>
          </div>
        </div>
      </header>
      <div className="content-wrapper">
        <div className="chat-container">
          <PlatformProvider value={platformContext}>
            <ChatViewer messages={messages} autoScroll={false} theme="dark" />
          </PlatformProvider>
        </div>
        {metadata && <MetadataSidebar metadata={metadata} />}
      </div>
      <TempFileModal state={modalState} onClose={closeModal} />
    </div>
  );
};

const rootElement = document.getElementById('app');
if (!rootElement) {
  console.error('App container not found.');
} else {
  ReactDOM.createRoot(rootElement).render(<App />);
}

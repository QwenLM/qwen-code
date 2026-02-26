import './styles.css';
import logoSvg from './favicon.svg';

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
};

type PlatformContextValue = {
  platform: 'web';
  postMessage: (message: unknown) => void;
  onMessage: (handler: (event: MessageEvent) => void) => () => void;
  openFile: (path: string) => void;
  getResourceUrl: () => string | undefined;
  features: {
    canOpenFile: boolean;
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

const platformContext = {
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
  getResourceUrl: () => undefined,
  features: {
    canOpenFile: false,
    canCopy: true,
  },
} satisfies PlatformContextValue;

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

const App = () => {
  const chatData = parseChatData();
  const rawMessages = Array.isArray(chatData.messages) ? chatData.messages : [];
  const messages = rawMessages
    .filter(isChatViewerMessage)
    .filter((record) => record.type !== 'system');
  const sessionId = chatData.sessionId ?? '-';
  const sessionDate = formatSessionDate(chatData.startTime);

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
      <div className="chat-container">
        <PlatformProvider value={platformContext}>
          <ChatViewer messages={messages} autoScroll={false} theme="dark" />
        </PlatformProvider>
      </div>
    </div>
  );
};

const rootElement = document.getElementById('app');
if (!rootElement) {
  console.error('App container not found.');
} else {
  ReactDOM.createRoot(rootElement).render(<App />);
}

import './styles.css';
import logoSvg from './favicon.svg';
import { TempFileModal } from './components/TempFileModal.js';
import { usePlatformContext } from './components/hooks.js';
import { MetadataSidebar } from './components/MetadataSidebar.js';
import {
  parseChatData,
  isChatViewerMessage,
  formatSessionDate,
} from './components/utils.js';

declare global {
  interface Window {
    React: typeof import('react');
    ReactDOM: typeof import('react-dom/client');
  }
}

const ReactDOM = window.ReactDOM;
const React = window.React;

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

const logoSvgWithGradient = (() => {
  if (!logoSvg) {
    return logoSvg;
  }

  const gradientDef =
    '<defs><linearGradient id="qwen-logo-gradient" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#60a5fa" /><stop offset="100%" stop-color="#a855f7" /></linearGradient></defs>';

  const withDefs = logoSvg.replace(/<svg([^>]*)>/, `<svg$1>${gradientDef}`);

  return withDefs.replace(/fill="[^"]*"/, 'fill="url(#qwen-logo-gradient)"');
})();

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

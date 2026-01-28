/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 141.38 140"><defs><linearGradient id="qwen-gradient" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#60a5fa"/><stop offset="100%" stop-color="#a855f7"/></linearGradient></defs><path fill="url(#qwen-gradient)" d="m140.93 85-16.35-28.33-1.93-3.34 8.66-15a3.323 3.323 0 0 0 0-3.34l-9.62-16.67c-.3-.51-.72-.93-1.22-1.22s-1.07-.45-1.67-.45H82.23l-8.66-15a3.33 3.33 0 0 0-2.89-1.67H51.43c-.59 0-1.17.16-1.66.45-.5.29-.92.71-1.22 1.22L32.19 29.98l-1.92 3.33H12.96c-.59 0-1.17.16-1.66.45-.5.29-.93.71-1.22 1.22L.45 51.66a3.323 3.323 0 0 0 0 3.34l18.28 31.67-8.66 15a3.32 3.32 0 0 0 0 3.34l9.62 16.67c.3.51.72.93 1.22 1.22s1.07.45 1.67.45h36.56l8.66 15a3.35 3.35 0 0 0 2.89 1.67h19.25a3.34 3.34 0 0 0 2.89-1.67l18.28-31.67h17.32c.6 0 1.17-.16 1.67-.45s.92-.71 1.22-1.22l9.62-16.67a3.323 3.323 0 0 0 0-3.34ZM51.44 3.33 61.07 20l-9.63 16.66h76.98l-9.62 16.66H45.67l-11.54-20zM57.21 120H22.58l9.63-16.67h19.25l-38.5-66.67h19.25l9.62 16.67L68.78 100l-11.55 20Zm61.59-33.34-9.62-16.67-38.49 66.67-9.63-16.67 9.63-16.66 26.94-46.67h23.1l17.32 30z"/></svg>';

export const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="en" class="dark">

<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}">
  <title>Qwen Code Chat Export</title>
  <!-- Load React and ReactDOM from CDN -->
  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>

  <!-- Manually create the jsxRuntime object to satisfy the dependency -->
  <script>
    // Provide a minimal JSX runtime for builds that expect react/jsx-runtime globals.
    const withKey = (props, key) =>
      key == null ? props : Object.assign({}, props, { key });
    const jsx = (type, props, key) => React.createElement(type, withKey(props, key));
    const jsxRuntime = {
      Fragment: React.Fragment,
      jsx,
      jsxs: jsx,
      jsxDEV: jsx
    };

    window.ReactJSXRuntime = jsxRuntime;
    window['react/jsx-runtime'] = jsxRuntime;
    window['react/jsx-dev-runtime'] = jsxRuntime;
  </script>

  <!-- Load the webui library from CDN -->
  <script src="https://unpkg.com/@qwen-code/webui@0.1.0-beta.3/dist/index.umd.js"></script>

  <!-- Load the CSS -->
  <link rel="stylesheet" href="https://unpkg.com/@qwen-code/webui@0.1.0-beta.3/dist/styles.css">
  
  <!-- Load Google Font for Logo -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap" rel="stylesheet">

  <style>
    :root {
      --bg-primary: #18181b;
      --bg-secondary: #27272a;
      --text-primary: #f4f4f5;
      --text-secondary: #a1a1aa;
      --border-color: #3f3f46;
      --accent-color: #3b82f6;
    }

    body {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      margin: 0;
      padding: 0;
      background-color: var(--bg-primary);
      color: var(--text-primary);
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }

    .page-wrapper {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    .header {
      width: 100%;
      padding: 16px 24px;
      border-bottom: 1px solid var(--border-color);
      background-color: rgba(24, 24, 27, 0.95);
      backdrop-filter: blur(8px);
      position: sticky;
      top: 0;
      z-index: 100;
      display: flex;
      justify-content: space-between;
      align-items: center;
      box-sizing: border-box;
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .logo-icon {
      width: 24px;
      height: 24px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .logo-icon svg {
      width: 100%;
      height: 100%;
    }

    /* Logo Styles */
    .logo {
      display: flex;
      flex-direction: column;
      line-height: 1;
    }

    .logo-text {
      font-family: 'Press Start 2P', cursive;
      font-weight: 400;
      font-size: 24px;
      letter-spacing: -0.05em;
      position: relative;
      color: white; /* Fallback */
    }

    .logo-text-inner {
      background: linear-gradient(to right, #60a5fa, #a855f7);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      position: relative;
      z-index: 2;
    }

    /* Echo effect */
    .logo-text::before,
    .logo-text::after {
      content: attr(data-text);
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      z-index: 1;
      background: none;
      -webkit-text-fill-color: transparent;
      -webkit-text-stroke: 1px rgba(96, 165, 250, 0.3);
    }

    .logo-text::before {
      transform: translate(2px, 2px);
      -webkit-text-stroke: 1px rgba(168, 85, 247, 0.3);
    }

    .logo-text::after {
      transform: translate(4px, 4px);
      opacity: 0.4;
    }

    .logo-sub {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-secondary);
      letter-spacing: 0.05em;
      text-transform: uppercase;
      margin-top: 4px;
    }

    .badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 999px;
      background-color: var(--bg-secondary);
      color: var(--text-secondary);
      border: 1px solid var(--border-color);
      font-weight: 500;
    }

    .meta {
      display: flex;
      gap: 24px;
      font-size: 13px;
      color: var(--text-secondary);
    }

    .meta-item {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .meta-label {
      color: #71717a;
    }

    .chat-container {
      width: 100%;
      max-width: 900px;
      padding: 40px 20px;
      box-sizing: border-box;
      flex: 1;
    }

    /* Scrollbar styling */
    ::-webkit-scrollbar {
      width: 10px;
      height: 10px;
    }

    ::-webkit-scrollbar-track {
      background: var(--bg-primary);
    }

    ::-webkit-scrollbar-thumb {
      background: var(--bg-secondary);
      border-radius: 5px;
      border: 2px solid var(--bg-primary);
    }

    ::-webkit-scrollbar-thumb:hover {
      background: #52525b;
    }

    /* Responsive adjustments */
    @media (max-width: 768px) {
      .chat-container {
        max-width: 100%;
        padding: 20px 16px;
      }

      .header {
        padding: 12px 16px;
        flex-direction: column;
        align-items: flex-start;
        gap: 12px;
      }

      .header-left {
        width: 100%;
        justify-content: space-between;
      }

      .meta {
        width: 100%;
        flex-direction: column;
        gap: 6px;
      }
    }

    @media (max-width: 480px) {
      .chat-container {
        padding: 16px 12px;
      }
    }
  </style>
</head>

<body>
  <div class="page-wrapper">
    <div class="header">
      <div class="header-left">
        <div class="logo-icon">${FAVICON_SVG}</div>
        <div class="logo">
          <div class="logo-text" data-text="QWEN">
            <span class="logo-text-inner">QWEN</span>
          </div>
        </div>
      </div>
      <div class="meta">
        <div class="meta-item">
          <span class="meta-label">Session Id</span>
          <span id="session-id" class="font-mono">-</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Export Time</span>
          <span id="session-date">-</span>
        </div>
      </div>
    </div>

    <div id="chat-root-no-babel" class="chat-container"></div>
  </div>

  <script id="chat-data" type="application/json">
    // DATA_PLACEHOLDER: Chat export data will be injected here
  </script>

  <script>
    const chatDataElement = document.getElementById('chat-data');
    const chatData = chatDataElement?.textContent
      ? JSON.parse(chatDataElement.textContent)
      : {};
    const rawMessages = Array.isArray(chatData.messages) ? chatData.messages : [];
    const messages = rawMessages.filter((record) => record && record.type !== 'system');

    // Populate metadata
    const sessionIdElement = document.getElementById('session-id');
    if (sessionIdElement && chatData.sessionId) {
      sessionIdElement.textContent = chatData.sessionId;
    }

    const sessionDateElement = document.getElementById('session-date');
    if (sessionDateElement && chatData.startTime) {
      try {
        const date = new Date(chatData.startTime);
        sessionDateElement.textContent = date.toLocaleString(undefined, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });
      } catch (e) {
        sessionDateElement.textContent = chatData.startTime;
      }
    }

    // Get the ChatViewer and Platform components from the global object
    const { ChatViewer, PlatformProvider } = QwenCodeWebUI;

    // Define a minimal platform context for web usage
    const platformContext = {
      platform: 'web',
      postMessage: (message) => {
        console.log('Posted message:', message);
      },
      onMessage: (handler) => {
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
      },
      openFile: (path) => {
        console.log('Opening file:', path);
      },
      getResourceUrl: (resource) => {
        return null;
      },
      features: {
        canOpenFile: false,
        canCopy: true
      }
    };

    // Render the ChatViewer component without Babel
    const rootElementNoBabel = document.getElementById('chat-root-no-babel');

    // Create the ChatViewer element wrapped with PlatformProvider using React.createElement (no JSX)
    const ChatAppNoBabel = React.createElement(PlatformProvider, { value: platformContext },
      React.createElement(ChatViewer, {
        messages,
        autoScroll: false,
        theme: 'dark'
      })
    );

    ReactDOM.render(ChatAppNoBabel, rootElementNoBabel);
  </script>
</body>

</html>
`;

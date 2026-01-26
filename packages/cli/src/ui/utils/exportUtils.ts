/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part, Content } from '@google/genai';
import type { ChatRecord } from '@qwen-code/qwen-code-core';

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="en">

<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
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
  <script src="https://unpkg.com/@qwen-code/webui@0.1.0-beta.2/dist/index.umd.js"></script>

  <!-- Load the CSS -->
  <link rel="stylesheet" href="https://unpkg.com/@qwen-code/webui@0.1.0-beta.2/dist/styles.css">

  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      margin: 0;
      padding: 0;
      background-color: #f9fafb;
      color: #111827;
      line-height: 1.5;
    }

    .page-wrapper {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 40px 20px;
    }

    .header {
      text-align: center;
      margin-bottom: 32px;
      width: 100%;
      max-width: 900px;
    }

    h1 {
      font-size: 24px;
      font-weight: 600;
      margin: 0 0 16px 0;
      color: #111827;
    }

    .meta {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 16px 32px;
      color: #6b7280;
      font-size: 14px;
    }

    .meta-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .meta-label {
      font-weight: 500;
    }

    .chat-container {
      width: 100%;
      max-width: 900px;
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
      min-height: 400px;
    }
  </style>
</head>

<body>
  <div class="page-wrapper">
    <div class="header">
      <h1>Qwen Code Chat Export</h1>
      <div class="meta">
        <div class="meta-item">
          <span class="meta-label">Session ID:</span>
          <span id="session-id">-</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Date:</span>
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
        sessionDateElement.textContent = date.toLocaleString();
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
        // In a web context, you might want to handle messages differently
        console.log('Posted message:', message);
      },
      onMessage: (handler) => {
        // In a web context, you might listen for custom events
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
      },
      openFile: (path) => {
        console.log('Opening file:', path);
      },
      getResourceUrl: (resource) => {
        // Return URLs for platform-specific resources
        return null; // Use default resources
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
        theme: 'light'
      })
    );

    ReactDOM.render(ChatAppNoBabel, rootElementNoBabel);
  </script>
</body>

</html>
`;

function escapeJsonForHtml(json: string): string {
  return json
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');
}

/**
 * Extracts text content from a Content object's parts.
 */
export function extractTextFromContent(content: Content | undefined): string {
  if (!content?.parts) return '';

  const textParts: string[] = [];
  for (const part of content.parts as Part[]) {
    if ('text' in part) {
      const textPart = part as { text: string };
      textParts.push(textPart.text);
    } else if ('functionCall' in part) {
      const fnPart = part as { functionCall: { name: string; args: unknown } };
      textParts.push(
        `[Function Call: ${fnPart.functionCall.name}]\n${JSON.stringify(fnPart.functionCall.args, null, 2)}`,
      );
    } else if ('functionResponse' in part) {
      const fnResPart = part as {
        functionResponse: { name: string; response: unknown };
      };
      textParts.push(
        `[Function Response: ${fnResPart.functionResponse.name}]\n${JSON.stringify(fnResPart.functionResponse.response, null, 2)}`,
      );
    }
  }

  return textParts.join('\n');
}

/**
 * Transforms ChatRecord messages to markdown format.
 */
export function transformToMarkdown(
  messages: ChatRecord[],
  sessionId: string,
  startTime: string,
): string {
  const lines: string[] = [];

  // Add header with metadata
  lines.push('# Chat Session Export\n');
  lines.push(`**Session ID**: ${sessionId}\n`);
  lines.push(`**Start Time**: ${startTime}\n`);
  lines.push(`**Exported**: ${new Date().toISOString()}\n`);
  lines.push('---\n');

  // Process each message
  for (const record of messages) {
    if (record.type === 'user') {
      lines.push('## User\n');
      const text = extractTextFromContent(record.message);
      lines.push(`${text}\n`);
    } else if (record.type === 'assistant') {
      lines.push('## Assistant\n');
      const text = extractTextFromContent(record.message);
      lines.push(`${text}\n`);
    } else if (record.type === 'tool_result') {
      lines.push('## Tool Result\n');
      if (record.toolCallResult) {
        const resultDisplay = record.toolCallResult.resultDisplay;
        if (resultDisplay) {
          lines.push('```\n');
          lines.push(
            typeof resultDisplay === 'string'
              ? resultDisplay
              : JSON.stringify(resultDisplay, null, 2),
          );
          lines.push('\n```\n');
        }
      }
      const text = extractTextFromContent(record.message);
      if (text) {
        lines.push(`${text}\n`);
      }
    } else if (record.type === 'system') {
      // Skip system messages or format them minimally
      if (record.subtype === 'chat_compression') {
        lines.push('_[Chat history compressed]_\n');
      }
    }

    lines.push('\n');
  }

  return lines.join('');
}

/**
 * Loads the HTML template from a bundled string constant.
 */
export async function loadHtmlTemplate(): Promise<string> {
  return HTML_TEMPLATE;
}

/**
 * Prepares export data from conversation.
 */
export function prepareExportData(conversation: {
  sessionId: string;
  startTime: string;
  messages: ChatRecord[];
}): {
  sessionId: string;
  startTime: string;
  messages: ChatRecord[];
} {
  return {
    sessionId: conversation.sessionId,
    startTime: conversation.startTime,
    messages: conversation.messages,
  };
}

/**
 * Injects JSON data into the HTML template.
 */
export function injectDataIntoHtmlTemplate(
  template: string,
  data: {
    sessionId: string;
    startTime: string;
    messages: ChatRecord[];
  },
): string {
  const jsonData = JSON.stringify(data, null, 2);
  const escapedJsonData = escapeJsonForHtml(jsonData);
  const html = template.replace(
    /<script id="chat-data" type="application\/json">\s*\/\/ DATA_PLACEHOLDER:.*?\s*<\/script>/s,
    `<script id="chat-data" type="application/json">\n${escapedJsonData}\n    </script>`,
  );
  return html;
}

/**
 * Generates a filename with timestamp for export files.
 */
export function generateExportFilename(extension: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `export-${timestamp}.${extension}`;
}

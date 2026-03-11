/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Returns the HTML template for the daemon web UI.
 * This is a self-contained single-page application with embedded CSS and JS.
 */
export function getWebUIHtml(sessionId: string, authToken: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Qwen Code - Session ${sessionId.slice(0, 8)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg: #1e1e2e; --surface: #282838; --border: #3b3b52;
      --text: #cdd6f4; --text-dim: #a6adc8; --accent: #89b4fa;
      --user-bg: #313244; --assistant-bg: #1e1e2e;
      --error: #f38ba8; --success: #a6e3a1;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
      background: var(--bg); color: var(--text);
      height: 100vh; display: flex; flex-direction: column;
    }
    header {
      padding: 12px 20px; background: var(--surface); border-bottom: 1px solid var(--border);
      display: flex; align-items: center; justify-content: space-between;
    }
    header h1 { font-size: 16px; font-weight: 600; }
    header .status { font-size: 12px; display: flex; align-items: center; gap: 6px; }
    header .dot { width: 8px; height: 8px; border-radius: 50%; }
    header .dot.connected { background: var(--success); }
    header .dot.disconnected { background: var(--error); }
    #messages {
      flex: 1; overflow-y: auto; padding: 16px 20px;
      display: flex; flex-direction: column; gap: 12px;
    }
    .message {
      padding: 12px 16px; border-radius: 8px; max-width: 85%;
      white-space: pre-wrap; word-break: break-word; line-height: 1.5; font-size: 14px;
    }
    .message.user {
      background: var(--user-bg); align-self: flex-end; border: 1px solid var(--border);
    }
    .message.assistant {
      background: var(--assistant-bg); align-self: flex-start; border: 1px solid var(--border);
    }
    .message.system {
      font-size: 12px; color: var(--text-dim); align-self: center;
      font-style: italic; background: none; padding: 4px;
    }
    .message.error { border-color: var(--error); color: var(--error); }
    .tool-call {
      font-size: 12px; color: var(--text-dim); padding: 6px 10px;
      background: var(--surface); border-radius: 4px; border-left: 3px solid var(--accent);
      margin: 4px 0;
    }
    #input-area {
      padding: 12px 20px; background: var(--surface); border-top: 1px solid var(--border);
      display: flex; gap: 8px;
    }
    #prompt-input {
      flex: 1; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--border);
      background: var(--bg); color: var(--text); font-size: 14px; font-family: inherit;
      resize: none; min-height: 42px; max-height: 120px;
    }
    #prompt-input:focus { outline: none; border-color: var(--accent); }
    #prompt-input::placeholder { color: var(--text-dim); }
    button {
      padding: 10px 20px; border-radius: 8px; border: none; cursor: pointer;
      font-size: 14px; font-weight: 500; transition: opacity 0.2s;
    }
    button:hover { opacity: 0.85; }
    button:disabled { opacity: 0.4; cursor: not-allowed; }
    #send-btn { background: var(--accent); color: #1e1e2e; }
    #stop-btn { background: var(--error); color: #1e1e2e; display: none; }
    .typing { color: var(--text-dim); font-style: italic; font-size: 13px; padding: 8px 0; }
  </style>
</head>
<body>
  <header>
    <h1>Qwen Code</h1>
    <div class="status">
      <span class="dot disconnected" id="status-dot"></span>
      <span id="status-text">Connecting...</span>
    </div>
  </header>
  <div id="messages"></div>
  <div id="input-area">
    <textarea id="prompt-input" placeholder="Type your prompt..." rows="1"></textarea>
    <button id="send-btn" onclick="sendPrompt()">Send</button>
    <button id="stop-btn" onclick="stopTask()">Stop</button>
  </div>

  <script>
    const SESSION_ID = ${JSON.stringify(sessionId)};
    const AUTH_TOKEN = ${JSON.stringify(authToken)};
    const messagesEl = document.getElementById('messages');
    const inputEl = document.getElementById('prompt-input');
    const sendBtn = document.getElementById('send-btn');
    const stopBtn = document.getElementById('stop-btn');
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');

    let ws = null;
    let isProcessing = false;
    let currentAssistantEl = null;

    function connect() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(protocol + '//' + location.host + '/ws?token=' + AUTH_TOKEN + '&session=' + SESSION_ID);

      ws.onopen = () => {
        statusDot.className = 'dot connected';
        statusText.textContent = 'Connected';
      };

      ws.onclose = () => {
        statusDot.className = 'dot disconnected';
        statusText.textContent = 'Disconnected';
        setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        statusDot.className = 'dot disconnected';
        statusText.textContent = 'Error';
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        handleMessage(msg);
      };
    }

    function handleMessage(msg) {
      switch (msg.type) {
        case 'connected':
          addSystemMessage('Session connected');
          break;
        case 'history':
          if (msg.data && Array.isArray(msg.data)) {
            msg.data.forEach(item => {
              if (item.role === 'user') addMessage(item.text, 'user');
              else if (item.role === 'assistant') addMessage(item.text, 'assistant');
              else if (item.role === 'tool') addToolCall(item.text);
            });
          }
          break;
        case 'output':
          if (!currentAssistantEl) {
            currentAssistantEl = addMessage('', 'assistant');
          }
          currentAssistantEl.textContent += (msg.data || '');
          messagesEl.scrollTop = messagesEl.scrollHeight;
          break;
        case 'status':
          if (msg.data === 'done' || msg.data === 'stopped') {
            setProcessing(false);
            currentAssistantEl = null;
          } else if (msg.data === 'processing') {
            setProcessing(true);
          } else if (typeof msg.data === 'string' && msg.data.startsWith('tool:')) {
            addToolCall(msg.data.slice(5));
          }
          break;
        case 'error':
          const errEl = addMessage(msg.data || 'Unknown error', 'assistant');
          errEl.classList.add('error');
          setProcessing(false);
          currentAssistantEl = null;
          break;
      }
    }

    function addMessage(text, role) {
      const el = document.createElement('div');
      el.className = 'message ' + role;
      el.textContent = text;
      messagesEl.appendChild(el);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return el;
    }

    function addSystemMessage(text) {
      const el = document.createElement('div');
      el.className = 'message system';
      el.textContent = text;
      messagesEl.appendChild(el);
    }

    function addToolCall(text) {
      const el = document.createElement('div');
      el.className = 'tool-call';
      el.textContent = text;
      messagesEl.appendChild(el);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function setProcessing(processing) {
      isProcessing = processing;
      sendBtn.style.display = processing ? 'none' : '';
      stopBtn.style.display = processing ? '' : 'none';
      inputEl.disabled = processing;
    }

    function sendPrompt() {
      const text = inputEl.value.trim();
      if (!text || isProcessing || !ws || ws.readyState !== WebSocket.OPEN) return;
      addMessage(text, 'user');
      ws.send(JSON.stringify({ type: 'prompt', sessionId: SESSION_ID, data: text }));
      inputEl.value = '';
      inputEl.style.height = 'auto';
      setProcessing(true);
      currentAssistantEl = null;
    }

    function stopTask() {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'stop', sessionId: SESSION_ID }));
      }
    }

    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPrompt(); }
    });

    inputEl.addEventListener('input', () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    });

    connect();
  </script>
</body>
</html>`;
}

/** Returns a minimal HTML page for the sessions list. */
export function getSessionsListHtml(
  sessions: Array<{ sessionId: string; prompt: string; createdAt: string }>,
  authToken: string,
): string {
  const sessionRows = sessions
    .map(
      (s) =>
        `<tr>
      <td><a href="/session/${s.sessionId}?token=${authToken}">${s.sessionId.slice(0, 8)}...</a></td>
      <td>${escapeHtml(s.prompt || '(no prompt)')}</td>
      <td>${s.createdAt}</td>
    </tr>`,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Qwen Code - Sessions</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', monospace;
      background: #1e1e2e; color: #cdd6f4; padding: 40px 20px;
    }
    h1 { font-size: 22px; margin-bottom: 20px; }
    table { width: 100%; max-width: 800px; border-collapse: collapse; }
    th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid #3b3b52; }
    th { color: #a6adc8; font-size: 12px; text-transform: uppercase; }
    a { color: #89b4fa; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .empty { color: #a6adc8; font-style: italic; padding: 20px 0; }
    .new-session {
      display: inline-block; margin-bottom: 20px; padding: 8px 16px;
      background: #89b4fa; color: #1e1e2e; border-radius: 6px;
      font-weight: 500; font-size: 14px;
    }
    .new-session:hover { text-decoration: none; opacity: 0.85; }
  </style>
</head>
<body>
  <h1>Qwen Code Daemon</h1>
  <a href="/session/new?token=${authToken}" class="new-session">+ New Session</a>
  ${
    sessions.length > 0
      ? `<table>
    <thead><tr><th>Session</th><th>Prompt</th><th>Created</th></tr></thead>
    <tbody>${sessionRows}</tbody>
  </table>`
      : '<p class="empty">No active sessions. Click "New Session" to start one.</p>'
  }
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

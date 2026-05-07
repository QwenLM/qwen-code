/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Qwen Remote Control</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <main>
      <section class="toolbar">
        <div>
          <h1>Qwen Remote Control</h1>
          <p id="status">Disconnected</p>
        </div>
        <div class="auth">
          <input id="token" type="password" autocomplete="one-time-code" placeholder="Pairing token" />
          <button id="connect">Connect</button>
        </div>
      </section>
      <section class="controls">
        <input id="session-name" placeholder="Session name" />
        <input id="cwd" placeholder="Working directory" />
        <input id="model" placeholder="Model" />
        <select id="permission-mode">
          <option value="">Default permission</option>
          <option value="default">default</option>
          <option value="plan">plan</option>
          <option value="auto-edit">auto-edit</option>
          <option value="yolo">yolo</option>
        </select>
        <button id="create">New session</button>
        <button id="interrupt">Interrupt</button>
      </section>
      <section class="layout">
        <aside>
          <h2>Sessions</h2>
          <div id="sessions"></div>
        </aside>
        <section class="workspace">
          <div id="log"></div>
          <form id="prompt-form">
            <textarea id="prompt" rows="4" placeholder="Send a prompt"></textarea>
            <button type="submit">Send</button>
          </form>
        </section>
      </section>
    </main>
    <script type="module" src="/app.js"></script>
  </body>
</html>`;

export const STYLES_CSS = `:root {
  color-scheme: light dark;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
body {
  margin: 0;
  background: #f7f7f8;
  color: #202124;
}
main {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}
.toolbar,
.controls {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid #d8dbe0;
  background: #ffffff;
}
.toolbar {
  justify-content: space-between;
}
h1,
h2,
p {
  margin: 0;
}
h1 {
  font-size: 18px;
}
h2 {
  font-size: 14px;
  margin-bottom: 8px;
}
#status {
  margin-top: 4px;
  font-size: 13px;
  color: #5f6368;
}
input,
select,
textarea,
button {
  font: inherit;
  border: 1px solid #c4c7cc;
  border-radius: 6px;
  padding: 8px 10px;
  background: #ffffff;
  color: #202124;
}
button {
  cursor: pointer;
  background: #1a73e8;
  color: #ffffff;
  border-color: #1a73e8;
}
button.secondary {
  background: #ffffff;
  color: #1a73e8;
}
.layout {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(180px, 260px) 1fr;
  min-height: 0;
}
aside {
  border-right: 1px solid #d8dbe0;
  background: #ffffff;
  padding: 12px;
  overflow: auto;
}
.session {
  display: block;
  width: 100%;
  text-align: left;
  margin-bottom: 8px;
  background: #ffffff;
  color: #202124;
  border-color: #d8dbe0;
}
.session.active {
  border-color: #1a73e8;
}
.workspace {
  display: grid;
  grid-template-rows: 1fr auto;
  min-width: 0;
  min-height: 0;
}
#log {
  overflow: auto;
  padding: 16px;
}
.entry {
  white-space: pre-wrap;
  word-break: break-word;
  border-bottom: 1px solid #e4e7eb;
  padding: 10px 0;
}
.entry strong {
  color: #1a73e8;
}
.approval {
  border: 1px solid #fbbc04;
  background: #fff8e1;
  border-radius: 6px;
  padding: 10px;
}
#prompt-form {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 12px;
  padding: 12px;
  border-top: 1px solid #d8dbe0;
  background: #ffffff;
}
@media (max-width: 720px) {
  .toolbar,
  .controls,
  .layout,
  #prompt-form {
    display: flex;
    flex-direction: column;
    align-items: stretch;
  }
  aside {
    border-right: 0;
    border-bottom: 1px solid #d8dbe0;
    max-height: 180px;
  }
}
@media (prefers-color-scheme: dark) {
  body,
  input,
  select,
  textarea,
  .toolbar,
  .controls,
  aside,
  #prompt-form,
  .session {
    background: #151719;
    color: #f1f3f4;
  }
  body {
    background: #0f1113;
  }
  .entry,
  .toolbar,
  .controls,
  aside,
  #prompt-form {
    border-color: #33373d;
  }
}`;

export const APP_JS = `const protocolVersion = 1;
let socket;
let clientToken = localStorage.getItem('qwenRemoteClientToken') || '';
let activeSessionId = null;
let authenticated = false;
let authTimer = null;
const sessions = new Map();
const status = document.getElementById('status');
const log = document.getElementById('log');
const sessionsEl = document.getElementById('sessions');
const tokenInput = document.getElementById('token');

if (clientToken) tokenInput.value = clientToken;

function setStatus(text) {
  status.textContent = text;
}

function randomId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
}

function clearAuthTimer() {
  if (authTimer) {
    clearTimeout(authTimer);
    authTimer = null;
  }
}

function clearStoredToken() {
  clientToken = '';
  localStorage.removeItem('qwenRemoteClientToken');
  tokenInput.value = '';
}

function send(type, payload = {}, sessionId) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const envelope = { v: protocolVersion, id: randomId(), type, payload };
  const resolvedSessionId =
    arguments.length >= 3 ? sessionId : activeSessionId;
  if (
    typeof resolvedSessionId === 'string' &&
    resolvedSessionId.length > 0
  ) {
    envelope.sessionId = resolvedSessionId;
  }
  socket.send(JSON.stringify(envelope));
}

function appendEntry(title, payload, className = '') {
  const entry = document.createElement('div');
  entry.className = 'entry ' + className;
  const strong = document.createElement('strong');
  strong.textContent = title;
  const body = document.createElement('pre');
  body.textContent = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  entry.append(strong, body);
  log.append(entry);
  log.scrollTop = log.scrollHeight;
}

function renderSessions() {
  sessionsEl.replaceChildren();
  for (const session of sessions.values()) {
    const button = document.createElement('button');
    button.className = 'session' + (session.id === activeSessionId ? ' active' : '');
    button.textContent = session.name || session.id.slice(0, 8) + ' - ' + session.state;
    button.addEventListener('click', () => {
      activeSessionId = session.id;
      log.replaceChildren();
      send('session/attach', { since: 0 }, activeSessionId);
      renderSessions();
    });
    sessionsEl.append(button);
  }
}

function handleApproval(message) {
  const wrapper = document.createElement('div');
  wrapper.className = 'entry approval';
  const title = document.createElement('strong');
  title.textContent = 'Tool approval: ' + message.request.tool_name;
  const details = document.createElement('pre');
  details.textContent = JSON.stringify(message.request, null, 2);
  const allow = document.createElement('button');
  allow.textContent = 'Allow';
  const deny = document.createElement('button');
  deny.textContent = 'Deny';
  deny.className = 'secondary';
  allow.addEventListener('click', () => send('tool/respond', { requestId: message.request_id, behavior: 'allow' }));
  deny.addEventListener('click', () => send('tool/respond', { requestId: message.request_id, behavior: 'deny', message: 'Denied from remote UI' }));
  wrapper.append(title, details, allow, deny);
  log.append(wrapper);
  log.scrollTop = log.scrollHeight;
}

function handleMessage(envelope) {
  if (envelope.type === 'auth/result') {
    clearAuthTimer();
    authenticated = true;
    if (envelope.payload.clientToken) {
      clientToken = envelope.payload.clientToken;
      localStorage.setItem('qwenRemoteClientToken', clientToken);
      tokenInput.value = clientToken;
    }
    setStatus('Connected');
    for (const session of envelope.payload.sessions || []) sessions.set(session.id, session);
    renderSessions();
    return;
  }
  if (envelope.type === 'session/list/result') {
    sessions.clear();
    for (const session of envelope.payload.sessions || []) sessions.set(session.id, session);
    renderSessions();
    return;
  }
  if (envelope.type === 'session/state') {
    sessions.set(envelope.payload.id, envelope.payload);
    if (!activeSessionId) activeSessionId = envelope.payload.id;
    renderSessions();
    return;
  }
  if (envelope.type === 'history/replay') {
    for (const event of envelope.payload.events || []) handleMessage(event);
    return;
  }
  if (envelope.type === 'control/request') {
    if (envelope.payload.request?.subtype === 'can_use_tool') handleApproval(envelope.payload);
    else appendEntry('Control request', envelope.payload);
    return;
  }
  if (envelope.type === 'event/append') {
    appendEntry(envelope.payload.type || 'Event', envelope.payload);
    return;
  }
  if (envelope.type === 'error') {
    if (!authenticated) {
      clearAuthTimer();
      setStatus('Auth failed');
      clearStoredToken();
    }
    appendEntry('Error', envelope.payload, 'error');
    return;
  }
  appendEntry(envelope.type, envelope.payload || {});
}

document.getElementById('connect').addEventListener('click', () => {
  clearAuthTimer();
  authenticated = false;
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.close();
  }
  socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  setStatus('Connecting');
  socket.addEventListener('open', () => {
    setStatus('Authenticating');
    send('auth/pair', { token: tokenInput.value.trim() }, undefined);
    authTimer = setTimeout(() => {
      if (!authenticated) {
        setStatus('Auth timeout');
        appendEntry('Error', { message: 'No auth response from remote-control server. Check the pairing token and restart /remote-control if needed.' }, 'error');
      }
    }, 10000);
  });
  socket.addEventListener('message', (event) => handleMessage(JSON.parse(event.data)));
  socket.addEventListener('error', () => {
    clearAuthTimer();
    setStatus('Connection error');
  });
  socket.addEventListener('close', () => {
    clearAuthTimer();
    if (!authenticated) {
      setStatus('Disconnected');
    }
  });
});

document.getElementById('create').addEventListener('click', () => {
  send('session/create', {
    name: document.getElementById('session-name').value.trim() || undefined,
    cwd: document.getElementById('cwd').value.trim() || undefined,
    model: document.getElementById('model').value.trim() || undefined,
    permissionMode: document.getElementById('permission-mode').value || undefined,
  }, undefined);
});

document.getElementById('interrupt').addEventListener('click', () => send('control/interrupt'));
document.getElementById('prompt-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const prompt = document.getElementById('prompt');
  send('user/submit', { text: prompt.value });
  prompt.value = '';
});
`;

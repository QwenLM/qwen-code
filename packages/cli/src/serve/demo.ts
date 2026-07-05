/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Inline HTML for the `/demo` debug page. Served as a single self-contained
 * page with no external dependencies so it works without a build step or
 * static-file serving.
 */
export function getDemoHtml(_port: number): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Qwen Serve Demo</title>
<style>
  :root { --bg: #1a1a2e; --surface: #16213e; --border: #0f3460; --accent: #e94560; --text: #eee; --text2: #aab; --ok: #4ade80; --warn: #fbbf24; --err: #f87171; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'SF Mono', 'Menlo', 'Consolas', monospace; font-size: 13px; background: var(--bg); color: var(--text); min-height: 100vh; }
  .header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 12px 20px; display: flex; align-items: center; gap: 12px; }
  .header h1 { font-size: 16px; font-weight: 600; }
  .header .badge { font-size: 11px; background: var(--accent); color: #fff; padding: 2px 8px; border-radius: 10px; }
  .header .status { margin-left: auto; display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text2); }
  .header .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--err); }
  .header .dot.ok { background: var(--ok); }
  .container { display: grid; grid-template-columns: 340px 1fr; height: calc(100vh - 49px); }
  .sidebar { background: var(--surface); border-right: 1px solid var(--border); overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 12px; }
  .panel { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 12px; }
  .panel h3 { font-size: 12px; color: var(--accent); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
  .panel label { display: block; font-size: 11px; color: var(--text2); margin-bottom: 3px; }
  .panel input, .panel textarea { width: 100%; background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 6px 8px; border-radius: 4px; font-family: inherit; font-size: 12px; margin-bottom: 8px; }
  .panel input:focus, .panel textarea:focus { outline: none; border-color: var(--accent); }
  .panel textarea { resize: vertical; min-height: 60px; }
  .btn { display: inline-flex; align-items: center; gap: 4px; padding: 6px 14px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface); color: var(--text); font-family: inherit; font-size: 12px; cursor: pointer; transition: all 0.15s; }
  .btn:hover { border-color: var(--accent); color: var(--accent); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn.primary:hover { opacity: 0.85; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-row { display: flex; gap: 6px; flex-wrap: wrap; }
  .main { display: flex; flex-direction: column; overflow: hidden; }
  .tabs { display: flex; background: var(--surface); border-bottom: 1px solid var(--border); }
  .tab { padding: 8px 16px; font-size: 12px; color: var(--text2); cursor: pointer; border-bottom: 2px solid transparent; }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .tab-content { flex: 1; overflow: hidden; display: none; flex-direction: column; }
  .tab-content.active { display: flex; }
  .log { flex: 1; overflow-y: auto; padding: 12px; font-size: 12px; line-height: 1.6; }
  .log-entry { padding: 3px 0; border-bottom: 1px solid rgba(255,255,255,0.03); word-break: break-all; }
  .log-entry .ts { color: var(--text2); margin-right: 8px; font-size: 11px; }
  .log-entry .tag { display: inline-block; padding: 0 5px; border-radius: 3px; font-size: 10px; margin-right: 6px; }
  .tag-info { background: #1e40af; color: #93c5fd; }
  .tag-event { background: #065f46; color: #6ee7b7; }
  .tag-error { background: #7f1d1d; color: #fca5a5; }
  .tag-response { background: #713f12; color: #fde68a; }
  .tag-thought { background: #4c1d95; color: #c4b5fd; }
  .tag-message { background: #164e63; color: #67e8f9; }
  .chat { flex: 1; overflow-y: auto; padding: 16px; }
  .chat-msg { margin-bottom: 12px; max-width: 85%; }
  .chat-msg.user { margin-left: auto; }
  .chat-msg .bubble { padding: 8px 12px; border-radius: 8px; line-height: 1.5; white-space: pre-wrap; }
  .chat-msg.user .bubble { background: var(--accent); color: #fff; border-bottom-right-radius: 2px; }
  .chat-msg.assistant .bubble { background: var(--surface); border: 1px solid var(--border); border-bottom-left-radius: 2px; }
  .chat-msg .meta { font-size: 10px; color: var(--text2); margin-top: 3px; }
  .chat-input { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--border); background: var(--surface); }
  .chat-input input { flex: 1; }
  .session-info { font-size: 11px; color: var(--text2); padding: 4px 0; }
  .session-info span { color: var(--ok); }
  .empty-hint { color: var(--text2); text-align: center; padding: 40px 20px; font-size: 12px; }
  .permission-card { background: var(--surface); border: 1px solid var(--warn); border-radius: 6px; padding: 10px 12px; margin: 8px 0; }
  .permission-card h4 { color: var(--warn); font-size: 12px; margin-bottom: 6px; }
  .permission-card .opt-btn { margin-right: 4px; margin-top: 4px; }
</style>
</head>
<body>

<div class="header">
  <h1>Qwen Serve</h1>
  <span class="badge">Demo</span>
  <div class="status">
    <span class="dot" id="statusDot"></span>
    <span id="statusText">Connecting...</span>
  </div>
</div>

<div class="container">
  <div class="sidebar">
    <div class="panel">
      <h3>Session</h3>
      <label>Working Directory (cwd)</label>
      <input type="text" id="cwdInput" placeholder="/path/to/project" />
      <div class="btn-row">
        <button class="btn primary" id="btnCreateSession">Create / Attach</button>
        <button class="btn" id="btnListSessions">List</button>
      </div>
      <div class="session-info" id="sessionInfo" style="display:none">
        Session: <span id="sessionIdDisplay"></span>
      </div>
    </div>

    <div class="panel">
      <h3>Prompt</h3>
      <textarea id="promptInput" placeholder="Type your prompt here..."></textarea>
      <div class="btn-row">
        <button class="btn primary" id="btnSendPrompt" disabled>Send</button>
        <button class="btn" id="btnCancel" disabled>Cancel</button>
      </div>
    </div>

    <div class="panel">
      <h3>Model</h3>
      <input type="text" id="modelInput" placeholder="Model ID (e.g. qwen3-coder)" />
      <button class="btn" id="btnSetModel" disabled>Switch Model</button>
    </div>

    <div class="panel">
      <h3>Auth Token</h3>
      <label>Bearer Token (if --token is set)</label>
      <input type="password" id="tokenInput" placeholder="Optional bearer token" />
    </div>

    <div class="panel">
      <h3>Quick Actions</h3>
      <div class="btn-row">
        <button class="btn" id="btnHealth">Health</button>
        <button class="btn" id="btnHealthDeep">Health (deep)</button>
        <button class="btn" id="btnCaps">Capabilities</button>
      </div>
    </div>

    <div class="panel" id="permissionPanel" style="display:none">
      <h3>Pending Permissions</h3>
      <div id="permissionList"></div>
    </div>
  </div>

  <div class="main">
    <div class="tabs">
      <div class="tab active" data-tab="chat">Chat</div>
      <div class="tab" data-tab="events">Events</div>
      <div class="tab" data-tab="requests">API Log</div>
    </div>

    <div class="tab-content active" id="tab-chat">
      <div class="chat" id="chatArea">
        <div class="empty-hint">Create a session to start chatting</div>
      </div>
      <div class="chat-input">
        <input type="text" id="chatInput" placeholder="Send a message..." disabled />
        <button class="btn primary" id="btnChatSend" disabled>Send</button>
      </div>
    </div>

    <div class="tab-content" id="tab-events">
      <div class="log" id="eventLog"></div>
    </div>

    <div class="tab-content" id="tab-requests">
      <div class="log" id="requestLog"></div>
    </div>
  </div>
</div>

<script>
(function() {
  const BASE = '';
  let sessionId = null;
  let eventSource = null;
  let currentAssistantBubble = null;
  let currentThought = '';

  // --- DOM refs ---
  const $ = (s) => document.querySelector(s);
  const statusDot = $('#statusDot');
  const statusText = $('#statusText');
  const cwdInput = $('#cwdInput');
  const promptInput = $('#promptInput');
  const modelInput = $('#modelInput');
  const tokenInput = $('#tokenInput');
  const chatArea = $('#chatArea');
  const chatInput = $('#chatInput');
  const eventLog = $('#eventLog');
  const requestLog = $('#requestLog');
  const sessionInfo = $('#sessionInfo');
  const sessionIdDisplay = $('#sessionIdDisplay');
  const permissionPanel = $('#permissionPanel');
  const permissionList = $('#permissionList');

  // --- Tabs ---
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      $('#tab-' + tab.dataset.tab).classList.add('active');
    });
  });

  // --- Logging ---
  function ts() {
    return new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  const MAX_LOG_ENTRIES = 500;
  function addLog(container, tag, tagClass, msg) {
    const el = document.createElement('div');
    el.className = 'log-entry';
    const text = typeof msg === 'object' ? JSON.stringify(msg, null, 2) : msg;
    const tsSpan = document.createElement('span');
    tsSpan.className = 'ts';
    tsSpan.textContent = ts();
    const tagSpan = document.createElement('span');
    tagSpan.className = 'tag ' + tagClass;
    tagSpan.textContent = tag;
    el.appendChild(tsSpan);
    el.appendChild(tagSpan);
    el.appendChild(document.createTextNode(text));
    container.appendChild(el);
    while (container.children.length > MAX_LOG_ENTRIES) {
      container.removeChild(container.firstChild);
    }
    container.scrollTop = container.scrollHeight;
  }
  function logEvent(tag, msg) { addLog(eventLog, tag, 'tag-event', msg); }
  function logRequest(tag, msg) { addLog(requestLog, tag, 'tag-info', msg); }
  function logResponse(tag, msg) { addLog(requestLog, tag, 'tag-response', msg); }
  function logError(tag, msg) { addLog(requestLog, tag, 'tag-error', msg); }

  function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  // --- 401 token hint ---
  let tokenHintTimer = null;
  function highlightTokenInput(msg) {
    tokenInput.style.borderColor = 'var(--warn)';
    tokenInput.focus();
    // Show hint text below the input
    let hint = document.getElementById('tokenHint');
    if (!hint) {
      hint = document.createElement('div');
      hint.id = 'tokenHint';
      hint.style.cssText = 'font-size:11px;color:var(--warn);margin-top:-4px;margin-bottom:4px;';
      tokenInput.parentNode.insertBefore(hint, tokenInput.nextSibling);
    }
    hint.textContent = msg;
    if (tokenHintTimer) clearTimeout(tokenHintTimer);
    tokenHintTimer = setTimeout(() => {
      tokenInput.style.borderColor = '';
      hint.textContent = '';
    }, 6000);
  }

  // --- API helpers ---
  function authHeaders() {
    const token = tokenInput.value.trim();
    return token ? { 'Authorization': 'Bearer ' + token } : {};
  }

  async function api(method, path, body) {
    const opts = { method, headers: { ...authHeaders() } };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    logRequest(method, path + (body ? ' ' + JSON.stringify(body) : ''));
    try {
      const res = await fetch(BASE + path, opts);
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      if (!res.ok) {
        logError(res.status, JSON.stringify(data));
        if (res.status === 401) {
          highlightTokenInput('API returned 401 — enter your bearer token below');
        }
        return { ok: false, status: res.status, data };
      }
      logResponse(res.status, JSON.stringify(data));
      return { ok: true, status: res.status, data };
    } catch (err) {
      logError('ERR', err.message);
      return { ok: false, status: 0, data: { error: err.message } };
    }
  }

  // --- Health check on load ---
  async function checkHealth() {
    const r = await api('GET', '/health');
    if (r.ok) {
      statusDot.classList.add('ok');
      statusText.textContent = 'Connected';
    } else {
      statusDot.classList.remove('ok');
      statusText.textContent = 'Disconnected';
    }
  }

  // --- Session ---
  async function createSession() {
    const cwd = cwdInput.value.trim();
    if (!cwd) { alert('Please enter a working directory'); return; }
    const r = await api('POST', '/session', { cwd });
    if (r.ok) {
      sessionId = r.data.sessionId;
      sessionInfo.style.display = 'block';
      sessionIdDisplay.textContent = sessionId;
      enablePrompt(true);
      chatArea.innerHTML = '';
      currentAssistantBubble = null;
      pendingPerms.clear();
      renderPermissions();
      if (r.data.attached) {
        addChatMeta('Attached to existing session');
      } else {
        addChatMeta('New session created');
      }
      connectSSE();
    } else {
      const msg = r.data.error || 'session creation failed (' + r.status + ')';
      addChatMeta('Error: ' + msg);
      if (r.status === 401) highlightTokenInput('Token required or invalid');
    }
  }

  function enablePrompt(on) {
    $('#btnSendPrompt').disabled = !on;
    $('#btnCancel').disabled = !on;
    $('#btnSetModel').disabled = !on;
    chatInput.disabled = !on;
    $('#btnChatSend').disabled = !on;
  }

  // --- SSE ---
  function connectSSE() {
    if (eventSource) { eventSource.close(); }
    const url = BASE + '/session/' + sessionId + '/events';
    logEvent('SSE', 'Connecting to ' + url);

    // Use fetch-based SSE to avoid Origin header issues with EventSource
    const abort = new AbortController();
    eventSource = { close: () => abort.abort() };

    (async function readSSE() {
      try {
        const hdrs = authHeaders();
        const res = await fetch(url, { signal: abort.signal, headers: hdrs });
        if (!res.ok) {
          logEvent('SSE-ERR', 'HTTP ' + res.status);
          statusDot.classList.remove('ok');
          statusText.textContent = 'SSE failed (' + res.status + ')';
          enablePrompt(false);
          if (res.status === 401) {
            highlightTokenInput('SSE returned 401 — enter your bearer token and recreate the session');
          }
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let currentEvent = {};

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              currentEvent.data = line.slice(6);
            } else if (line.startsWith('event: ')) {
              currentEvent.event = line.slice(7);
            } else if (line.startsWith('id: ')) {
              currentEvent.id = line.slice(4);
            } else if (line === '') {
              if (currentEvent.data) {
                handleSSEMessage(currentEvent);
              }
              currentEvent = {};
            }
          }
        }
        // Process any remaining buffered data
        if (currentEvent.data) handleSSEMessage(currentEvent);
        statusDot.classList.remove('ok');
        statusText.textContent = 'SSE stream ended';
        enablePrompt(false);
        logEvent('SSE', 'Stream ended by server');
      } catch (err) {
        if (err.name !== 'AbortError') {
          logEvent('SSE-ERR', err.message);
          statusDot.classList.remove('ok');
          statusText.textContent = 'SSE error';
          enablePrompt(false);
        }
      }
    })();
  }

  function handleSSEMessage(msg) {
    let data;
    try { data = JSON.parse(msg.data); } catch { data = msg.data; }
    const type = data.type || msg.event || 'unknown';

    if (type === 'session_update' && data.data) {
      const update = data.data.update || data.data;
      const kind = update.sessionUpdate;

      if (kind === 'agent_message_chunk') {
        const text = update.content?.text || '';
        if (text) appendAssistantChunk(text);
        if (update._meta?.usage) {
          const u = update._meta.usage;
          addChatMeta('tokens: in=' + u.inputTokens + ' out=' + u.outputTokens + ' | ' + (update._meta.durationMs || 0) + 'ms');
          currentAssistantBubble = null;
        }
        logEvent('MSG', text || '(usage meta)');
      } else if (kind === 'agent_thought_chunk') {
        const text = update.content?.text || '';
        currentThought += text;
        logEvent('THINK', text);
      } else {
        logEvent(kind || type, JSON.stringify(update));
      }
    } else if (type === 'permission_request') {
      handlePermissionRequest(data);
      logEvent('PERM', JSON.stringify(data.data));
    } else if (type === 'permission_resolved') {
      logEvent('PERM-OK', JSON.stringify(data.data));
      removePermission(data.data?.requestId);
    } else if (type === 'session_died') {
      addChatMeta('Session died: ' + JSON.stringify(data.data));
      logEvent('DIED', JSON.stringify(data.data));
      enablePrompt(false);
    } else if (type === 'model_switched') {
      addChatMeta('Model switched: ' + JSON.stringify(data.data));
      logEvent('MODEL', JSON.stringify(data.data));
    } else {
      logEvent(type, JSON.stringify(data));
    }
  }

  // --- Chat UI ---
  function addUserMessage(text) {
    currentAssistantBubble = null;
    currentThought = '';
    const el = document.createElement('div');
    el.className = 'chat-msg user';
    el.innerHTML = '<div class="bubble">' + escHtml(text) + '</div>';
    chatArea.appendChild(el);
    chatArea.scrollTop = chatArea.scrollHeight;
  }

  function appendAssistantChunk(text) {
    if (!currentAssistantBubble) {
      if (currentThought) {
        const te = document.createElement('div');
        te.className = 'chat-msg assistant';
        te.innerHTML = '<div class="bubble" style="color:var(--text2);font-style:italic;border-color:var(--border)">Thinking: ' + escHtml(currentThought) + '</div>';
        chatArea.appendChild(te);
        currentThought = '';
      }
      const el = document.createElement('div');
      el.className = 'chat-msg assistant';
      el.innerHTML = '<div class="bubble"></div>';
      chatArea.appendChild(el);
      currentAssistantBubble = el.querySelector('.bubble');
    }
    currentAssistantBubble.textContent += text;
    chatArea.scrollTop = chatArea.scrollHeight;
  }

  function addChatMeta(text) {
    const el = document.createElement('div');
    el.className = 'chat-msg assistant';
    el.innerHTML = '<div class="meta">' + escHtml(text) + '</div>';
    chatArea.appendChild(el);
    chatArea.scrollTop = chatArea.scrollHeight;
  }

  // --- Prompt ---
  let promptInFlight = false;
  async function sendPrompt(text) {
    if (!sessionId || !text.trim() || promptInFlight) return;
    promptInFlight = true;
    enablePrompt(false);
    addUserMessage(text.trim());
    promptInput.value = '';
    chatInput.value = '';
    try {
      const r = await api('POST', '/session/' + sessionId + '/prompt', {
        prompt: [{ type: 'text', text: text.trim() }]
      });
      if (r.ok) {
        addChatMeta('stopReason: ' + (r.data.stopReason || 'unknown'));
      } else {
        addChatMeta('Error: ' + (r.data.error || 'prompt failed (' + r.status + ')'));
      }
    } finally {
      promptInFlight = false;
      if (sessionId) enablePrompt(true);
    }
  }

  // --- Permission handling ---
  const pendingPerms = new Map();

  function handlePermissionRequest(data) {
    const req = data.data;
    const requestId = req?.requestId;
    if (!requestId) return;
    pendingPerms.set(requestId, req);
    renderPermissions();

    addChatMeta('Permission requested: ' + requestId);
  }

  function removePermission(requestId) {
    pendingPerms.delete(requestId);
    renderPermissions();
  }

  function renderPermissions() {
    if (pendingPerms.size === 0) {
      permissionPanel.style.display = 'none';
      return;
    }
    permissionPanel.style.display = 'block';
    permissionList.innerHTML = '';
    for (const [id, req] of pendingPerms) {
      const card = document.createElement('div');
      card.className = 'permission-card';

      const h4 = document.createElement('h4');
      h4.textContent = req.tool?.name || 'Permission';
      card.appendChild(h4);

      const idDiv = document.createElement('div');
      idDiv.style.cssText = 'font-size:11px;color:var(--text2);margin-bottom:6px';
      idDiv.textContent = id;
      card.appendChild(idDiv);

      // Show toolCall context (command, input, path, etc.) when available
      const tc = req.toolCall || req.tool;
      if (tc) {
        const detail = document.createElement('pre');
        detail.style.cssText = 'font-size:11px;color:var(--text2);margin-bottom:6px;white-space:pre-wrap;word-break:break-all;max-height:120px;overflow-y:auto;background:var(--bg);padding:6px;border-radius:4px;border:1px solid var(--border)';
        const parts = [];
        if (tc.command) parts.push('command: ' + tc.command);
        if (tc.input) parts.push('input: ' + (typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input, null, 2)));
        if (tc.path) parts.push('path: ' + tc.path);
        if (tc.diff) parts.push('diff: ' + tc.diff);
        if (tc.serverUrl) parts.push('url: ' + tc.serverUrl);
        if (parts.length === 0 && tc.name) parts.push('tool: ' + tc.name);
        if (parts.length > 0) {
          detail.textContent = parts.join('\\n');
          card.appendChild(detail);
        }
      }

      function makePermBtn(reqId, optId, label, isCancel) {
        const btn = document.createElement('button');
        btn.className = 'btn opt-btn';
        btn.textContent = label;
        btn.dataset.req = reqId;
        if (isCancel) {
          btn.dataset.cancel = '1';
          btn.style.borderColor = 'var(--err)';
          btn.style.color = 'var(--err)';
        } else {
          btn.dataset.opt = optId;
        }
        btn.addEventListener('click', async () => {
          let outcome;
          if (isCancel) {
            outcome = { outcome: 'cancelled' };
          } else {
            outcome = { outcome: 'selected', optionId: optId };
          }
          const result = await api('POST', '/permission/' + reqId, { outcome });
          if (result.ok) {
            removePermission(reqId);
          } else {
            logError('PERM-ERR', 'Failed to resolve permission ' + reqId + ': ' + JSON.stringify(result.data));
          }
        });
        return btn;
      }

      if (req.options && Array.isArray(req.options)) {
        for (const opt of req.options) {
          card.appendChild(makePermBtn(id, opt.optionId, opt.name || opt.optionId, false));
        }
      }
      card.appendChild(makePermBtn(id, null, 'Cancel', true));
      permissionList.appendChild(card);
    }
  }

  // --- Button bindings ---
  $('#btnCreateSession').addEventListener('click', createSession);
  $('#btnListSessions').addEventListener('click', async () => {
    const cwd = cwdInput.value.trim();
    if (!cwd) { alert('Enter a cwd first'); return; }
    await api('GET', '/workspace/' + encodeURIComponent(cwd) + '/sessions');
  });
  $('#btnSendPrompt').addEventListener('click', () => sendPrompt(promptInput.value));
  $('#btnChatSend').addEventListener('click', () => sendPrompt(chatInput.value));
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPrompt(chatInput.value); }
  });
  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPrompt(promptInput.value); }
  });
  $('#btnCancel').addEventListener('click', async () => {
    if (!sessionId) return;
    await api('POST', '/session/' + sessionId + '/cancel', {});
  });
  $('#btnSetModel').addEventListener('click', async () => {
    if (!sessionId) return;
    const mid = modelInput.value.trim();
    if (!mid) { alert('Enter a model ID'); return; }
    await api('POST', '/session/' + sessionId + '/model', { modelId: mid });
  });
  $('#btnHealth').addEventListener('click', () => api('GET', '/health'));
  $('#btnHealthDeep').addEventListener('click', () => api('GET', '/health?deep=1'));
  $('#btnCaps').addEventListener('click', () => api('GET', '/capabilities'));

  // --- Init ---
  checkHealth();
})();
</script>
</body>
</html>`;
}

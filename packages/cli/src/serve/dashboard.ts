/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Inline HTML for the `/dashboard` status page. Self-contained with no
 * external dependencies — same pattern as `/demo`.
 */
export function getDashboardHtml(): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Qwen Serve Dashboard</title>
<style>
  :root { --bg: #1a1a2e; --surface: #16213e; --border: #0f3460; --accent: #e94560; --text: #eee; --text2: #aab; --ok: #4ade80; --warn: #fbbf24; --err: #f87171; --surface2: #1e2a4a; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'SF Mono', 'Menlo', 'Consolas', monospace; font-size: 13px; background: var(--bg); color: var(--text); min-height: 100vh; }
  .header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 10px 20px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .header h1 { font-size: 16px; font-weight: 600; white-space: nowrap; }
  .badge { font-size: 11px; background: var(--accent); color: #fff; padding: 2px 8px; border-radius: 10px; }
  .header-right { margin-left: auto; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
  .dot-ok { background: var(--ok); }
  .dot-warn { background: var(--warn); }
  .dot-err { background: var(--err); }
  .dot-gray { background: var(--text2); }
  .uptime { font-size: 12px; color: var(--text2); }
  .controls { display: flex; align-items: center; gap: 8px; }
  .controls select, .controls input { background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 4px 8px; border-radius: 4px; font-family: inherit; font-size: 12px; }
  .controls select:focus, .controls input:focus { outline: none; border-color: var(--accent); }
  .btn { display: inline-flex; align-items: center; gap: 4px; padding: 4px 12px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface); color: var(--text); font-family: inherit; font-size: 12px; cursor: pointer; }
  .btn:hover { border-color: var(--accent); color: var(--accent); }
  .btn.active { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .toggle { display: inline-flex; border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
  .toggle .btn { border: none; border-radius: 0; }
  .toggle .btn + .btn { border-left: 1px solid var(--border); }
  .main { max-width: 960px; margin: 0 auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  .card-header { padding: 10px 14px; font-size: 12px; color: var(--accent); text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px; }
  .card-body { padding: 12px 14px; }
  .card-body:empty { display: none; }
  .kv { display: grid; grid-template-columns: 160px 1fr; gap: 4px 12px; font-size: 12px; }
  .kv dt { color: var(--text2); }
  .kv dd { color: var(--text); word-break: break-all; }
  .chip { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; }
  .chip-ok { background: rgba(74,222,128,0.15); color: var(--ok); }
  .chip-warn { background: rgba(251,191,36,0.15); color: var(--warn); }
  .chip-err { background: rgba(248,113,113,0.15); color: var(--err); }
  .chip-off { background: rgba(170,170,187,0.1); color: var(--text2); }
  .cap-bar { height: 6px; background: var(--bg); border-radius: 3px; overflow: hidden; margin-top: 4px; }
  .cap-fill { height: 100%; border-radius: 3px; transition: width 0.3s; }
  .issue { padding: 8px 12px; font-size: 12px; display: flex; align-items: baseline; gap: 8px; border-bottom: 1px solid rgba(255,255,255,0.05); }
  .issue:last-child { border-bottom: none; }
  .issue-code { font-weight: 600; white-space: nowrap; }
  .feat-tag { display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 11px; background: var(--surface2); color: var(--text2); margin: 2px; }
  .section-toggle { width: 100%; text-align: left; background: var(--surface2); border: none; border-bottom: 1px solid var(--border); color: var(--text); font-family: inherit; font-size: 12px; padding: 8px 14px; cursor: pointer; display: flex; align-items: center; gap: 8px; }
  .section-toggle:hover { background: var(--border); }
  .section-body { padding: 10px 14px; font-size: 12px; display: none; }
  .section-body.open { display: block; }
  .section-body pre { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 8px; font-size: 11px; overflow-x: auto; max-height: 300px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; color: var(--text2); font-weight: 500; padding: 6px 8px; border-bottom: 1px solid var(--border); }
  td { padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,0.03); }
  .err-banner { background: rgba(248,113,113,0.1); border: 1px solid rgba(248,113,113,0.3); border-radius: 6px; padding: 16px; text-align: center; color: var(--err); }
  .loading { text-align: center; padding: 40px; color: var(--text2); }
  .last-updated { font-size: 11px; color: var(--text2); }
  .token-row { display: flex; align-items: center; gap: 6px; }
  .token-row input { width: 180px; }
  .token-hint { font-size: 11px; color: var(--warn); }
  .sub-section { margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.05); }
  .sub-title { font-size: 11px; color: var(--accent); margin-bottom: 6px; text-transform: uppercase; }
</style>
</head>
<body>

<div class="header">
  <h1>Qwen Serve</h1>
  <span class="badge">Dashboard</span>
  <span class="dot dot-gray" id="statusDot"></span>
  <span class="uptime" id="uptimeText"></span>
  <div class="header-right">
    <div class="toggle" id="detailToggle">
      <button class="btn active" data-detail="summary">Summary</button>
      <button class="btn" data-detail="full">Full</button>
    </div>
    <div class="controls">
      <select id="intervalSelect">
        <option value="0">Off</option>
        <option value="5000">5s</option>
        <option value="10000" selected>10s</option>
        <option value="30000">30s</option>
      </select>
      <button class="btn" id="btnRefresh">Refresh</button>
    </div>
    <span class="last-updated" id="lastUpdated"></span>
    <div class="token-row">
      <input type="password" id="tokenInput" placeholder="Bearer token" />
    </div>
  </div>
</div>

<div class="main" id="content">
  <div class="loading">Loading...</div>
</div>

<script>
(function() {
  let detail = sessionStorage.getItem('dashboard_detail') || 'summary';
  let interval = parseInt(sessionStorage.getItem('dashboard_interval') || '10000', 10);
  let timer = null;
  let fetching = false;

  const content = document.getElementById('content');
  const statusDot = document.getElementById('statusDot');
  const uptimeText = document.getElementById('uptimeText');
  const lastUpdated = document.getElementById('lastUpdated');
  const tokenInput = document.getElementById('tokenInput');
  const intervalSelect = document.getElementById('intervalSelect');

  const savedToken = sessionStorage.getItem('dashboard_token') || '';
  if (savedToken) tokenInput.value = savedToken;
  tokenInput.addEventListener('input', () => {
    sessionStorage.setItem('dashboard_token', tokenInput.value);
  });

  intervalSelect.value = String(interval);
  intervalSelect.addEventListener('change', () => {
    interval = parseInt(intervalSelect.value, 10);
    sessionStorage.setItem('dashboard_interval', String(interval));
    scheduleRefresh();
  });

  document.getElementById('btnRefresh').addEventListener('click', () => fetchStatus());

  const toggleBtns = document.querySelectorAll('#detailToggle .btn');
  toggleBtns.forEach(btn => {
    if (btn.dataset.detail === detail) btn.classList.add('active');
    else btn.classList.remove('active');
    btn.addEventListener('click', () => {
      detail = btn.dataset.detail;
      sessionStorage.setItem('dashboard_detail', detail);
      toggleBtns.forEach(b => b.classList.toggle('active', b === btn));
      fetchStatus();
    });
  });

  function authHeaders() {
    const token = tokenInput.value.trim();
    return token ? { 'Authorization': 'Bearer ' + token } : {};
  }

  function fmtUptime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return h + 'h ' + m + 'm ' + sec + 's';
    if (m > 0) return m + 'm ' + sec + 's';
    return sec + 's';
  }

  function fmtBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function fmtTime(iso) {
    return new Date(iso).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = String(s ?? '');
    return d.innerHTML;
  }

  function statusDotClass(status) {
    if (status === 'ok') return 'dot-ok';
    if (status === 'warning') return 'dot-warn';
    if (status === 'error') return 'dot-err';
    return 'dot-gray';
  }

  function chipClass(status) {
    if (status === 'ok' || status === true) return 'chip-ok';
    if (status === 'warning') return 'chip-warn';
    if (status === 'error' || status === 'unavailable') return 'chip-err';
    return 'chip-off';
  }

  function boolChip(val, label) {
    return '<span class="chip ' + (val ? 'chip-ok' : 'chip-off') + '">' + esc(label) + ': ' + (val ? 'yes' : 'no') + '</span> ';
  }

  function capacityBar(current, max) {
    if (max === null || max === undefined || max <= 0) return '';
    const pct = Math.min(100, (current / max) * 100);
    const color = pct >= 90 ? 'var(--err)' : pct >= 75 ? 'var(--warn)' : 'var(--ok)';
    return '<div class="cap-bar"><div class="cap-fill" style="width:' + pct.toFixed(1) + '%;background:' + color + '"></div></div>';
  }

  function kvPair(label, value) {
    return '<dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd>';
  }

  function renderIssues(issues) {
    if (!issues || issues.length === 0) return '';
    let html = '<div class="card"><div class="card-header">Issues (' + issues.length + ')</div><div class="card-body">';
    for (const issue of issues) {
      const cls = issue.severity === 'error' ? 'chip-err' : 'chip-warn';
      html += '<div class="issue"><span class="issue-code chip ' + cls + '">' + esc(issue.code) + '</span><span>' + esc(issue.message) + '</span></div>';
    }
    return html + '</div></div>';
  }

  function renderDaemon(d) {
    let html = '<div class="card"><div class="card-header">Daemon</div><div class="card-body"><dl class="kv">';
    html += kvPair('PID', d.pid);
    html += kvPair('Uptime', fmtUptime(d.uptimeMs));
    html += kvPair('Mode', d.mode);
    html += kvPair('Workspace', d.workspaceCwd);
    if (d.qwenCodeVersion) html += kvPair('Version', d.qwenCodeVersion);
    if (d.daemonId) html += kvPair('Daemon ID', d.daemonId);
    if (d.startup) {
      html += kvPair('Started at', fmtTime(d.startup.processStartedAt));
      if (d.startup.processToListenMs !== undefined) html += kvPair('Startup time', d.startup.processToListenMs + 'ms');
      html += kvPair('Preheat', d.startup.preheat.status + (d.startup.preheat.durationMs !== undefined ? ' (' + d.startup.preheat.durationMs + 'ms)' : ''));
    }
    if (d.logPath) html += kvPair('Log path', d.logPath);
    return html + '</dl></div></div>';
  }

  function renderRuntime(r, limits) {
    let html = '<div class="card"><div class="card-header">Runtime</div><div class="card-body">';
    if (r.loading) html += '<div class="chip chip-warn">Loading...</div>';
    if (r.error) html += '<div class="chip chip-err">' + esc(r.error) + '</div>';

    html += '<dl class="kv">';
    html += kvPair('Sessions', r.sessions.active + (limits.maxSessions ? ' / ' + limits.maxSessions : ''));
    html += '</dl>';
    if (limits.maxSessions) html += capacityBar(r.sessions.active, limits.maxSessions);

    html += '<dl class="kv" style="margin-top:8px">';
    html += kvPair('Permissions pending', r.permissions.pending);
    html += kvPair('Permission policy', r.permissions.policy);
    html += '<dt>Channel</dt><dd><span class="dot ' + (r.channel.live ? 'dot-ok' : 'dot-err') + '"></span> ' + (r.channel.live ? 'live' : 'down') + '</dd>';
    html += '</dl>';

    // Channel worker
    if (r.channelWorker && r.channelWorker.enabled) {
      html += '<div class="sub-section"><div class="sub-title">Channel Worker</div><dl class="kv">';
      html += kvPair('State', r.channelWorker.state);
      if (r.channelWorker.pid !== undefined) html += kvPair('PID', r.channelWorker.pid);
      if (r.channelWorker.channels) html += kvPair('Channels', r.channelWorker.channels.join(', ') || 'none');
      if (r.channelWorker.restartCount !== undefined) html += kvPair('Restarts', r.channelWorker.restartCount);
      html += '</dl></div>';
    }

    // Transport
    html += '<div class="sub-section"><div class="sub-title">Transport</div><dl class="kv">';
    html += kvPair('REST SSE active', r.transport.restSseActive);
    if (r.transport.acp.enabled) {
      html += kvPair('ACP connections', r.transport.acp.connections);
      html += kvPair('ACP streams', 'conn=' + r.transport.acp.connectionStreams + ' sess=' + r.transport.acp.sessionStreams + ' sse=' + r.transport.acp.sseStreams + ' ws=' + r.transport.acp.wsStreams);
      html += kvPair('Pending client reqs', r.transport.acp.pendingClientRequests);
    } else {
      html += kvPair('ACP', 'disabled');
    }
    html += '</dl>';
    if (r.transport.acp.enabled && limits.acpConnectionCap) {
      html += capacityBar(r.transport.acp.connections, limits.acpConnectionCap);
    }
    html += '</div>';

    // Rate limit
    html += '<div class="sub-section"><div class="sub-title">Rate Limiting</div><dl class="kv">';
    html += kvPair('Enabled', r.rateLimit.enabled ? 'yes' : 'no');
    if (r.rateLimit.enabled) {
      const h = r.rateLimit.rejectedSinceStart;
      html += kvPair('Rejected', 'prompt=' + (h.prompt||0) + ' mutation=' + (h.mutation||0) + ' read=' + (h.read||0));
    }
    html += '</dl></div>';

    // Memory
    html += '<div class="sub-section"><div class="sub-title">Process Memory</div><dl class="kv">';
    html += kvPair('RSS', fmtBytes(r.process.rss));
    html += kvPair('Heap used', fmtBytes(r.process.heapUsed));
    html += kvPair('Heap total', fmtBytes(r.process.heapTotal));
    html += '</dl></div>';

    return html + '</div></div>';
  }

  function renderSecurity(s) {
    let html = '<div class="card"><div class="card-header">Security</div><div class="card-body">';
    html += boolChip(s.tokenConfigured, 'token');
    html += boolChip(s.requireAuth, 'requireAuth');
    html += boolChip(s.loopbackBind, 'loopback');
    html += boolChip(s.sessionShellCommandEnabled, 'shell');
    html += '<br/><span class="chip chip-off">allowOrigin: ' + esc(s.allowOriginMode) + '</span>';
    return html + '</div></div>';
  }

  function renderLimits(l) {
    let html = '<div class="card"><div class="card-header">Limits</div><div class="card-body"><dl class="kv">';
    const entries = [
      ['Max sessions', l.maxSessions],
      ['Max pending prompts', l.maxPendingPromptsPerSession],
      ['Listener max connections', l.listenerMaxConnections],
      ['Event ring size', l.eventRingSize],
      ['Prompt deadline', l.promptDeadlineMs !== null ? l.promptDeadlineMs + 'ms' : null],
      ['Writer idle timeout', l.writerIdleTimeoutMs !== null ? l.writerIdleTimeoutMs + 'ms' : null],
      ['Channel idle timeout', l.channelIdleTimeoutMs + 'ms'],
      ['Session idle timeout', l.sessionIdleTimeoutMs + 'ms'],
      ['ACP connection cap', l.acpConnectionCap],
    ];
    for (const [label, val] of entries) {
      html += kvPair(label, val !== null && val !== undefined ? val : 'unlimited');
    }
    return html + '</dl></div></div>';
  }

  function renderCapabilities(c) {
    let html = '<div class="card"><div class="card-header">Capabilities</div><div class="card-body">';
    html += '<dl class="kv">';
    html += kvPair('Protocol', c.protocolVersions.current);
    html += '</dl>';
    if (c.features && c.features.length > 0) {
      html += '<div style="margin-top:8px">';
      for (const f of c.features) {
        html += '<span class="feat-tag">' + esc(f) + '</span>';
      }
      html += '</div>';
    }
    return html + '</div></div>';
  }

  function renderSessions(sessions) {
    if (!sessions || sessions.length === 0) {
      return '<div class="card"><div class="card-header">Sessions (0)</div><div class="card-body"><span style="color:var(--text2)">No active sessions</span></div></div>';
    }
    let html = '<div class="card"><div class="card-header">Sessions (' + sessions.length + ')</div><div class="card-body"><table>';
    html += '<tr><th>Session ID</th><th>Name</th><th>Clients</th><th>Prompts</th><th>Active</th><th>Model</th></tr>';
    for (const s of sessions) {
      const shortId = s.sessionId.length > 12 ? s.sessionId.slice(0, 12) + '...' : s.sessionId;
      html += '<tr>';
      html += '<td title="' + esc(s.sessionId) + '">' + esc(shortId) + '</td>';
      html += '<td>' + esc(s.displayName || '-') + '</td>';
      html += '<td>' + s.clientCount + '</td>';
      html += '<td>' + s.pendingPromptCount + '</td>';
      html += '<td><span class="chip ' + (s.hasActivePrompt ? 'chip-ok' : 'chip-off') + '">' + (s.hasActivePrompt ? 'yes' : 'no') + '</span></td>';
      html += '<td>' + esc(s.currentModelId || '-') + '</td>';
      html += '</tr>';
    }
    return html + '</table></div></div>';
  }

  function renderWorkspace(ws) {
    let html = '<div class="card"><div class="card-header">Workspace Status</div>';
    const sections = Object.entries(ws);
    for (const [name, sec] of sections) {
      const dotCls = statusDotClass(sec.status);
      const dur = sec.durationMs !== undefined ? ' (' + sec.durationMs + 'ms)' : '';
      const id = 'ws-' + name;
      html += '<button class="section-toggle" onclick="var b=document.getElementById(\\'' + id + '\\');b.classList.toggle(\\'open\\')">';
      html += '<span class="dot ' + dotCls + '"></span> ' + esc(name) + dur;
      if (sec.error) html += ' <span class="chip chip-err">' + esc(sec.error.kind) + '</span>';
      html += '</button>';
      html += '<div class="section-body" id="' + id + '">';
      if (sec.summary && Object.keys(sec.summary).length > 0) {
        html += '<dl class="kv">';
        for (const [k, v] of Object.entries(sec.summary)) {
          html += kvPair(k, v);
        }
        html += '</dl>';
      }
      if (sec.data) {
        html += '<pre>' + esc(JSON.stringify(sec.data, null, 2)) + '</pre>';
      }
      if (sec.error) {
        html += '<div class="chip chip-err" style="margin-top:8px">' + esc(sec.error.message) + '</div>';
      }
      html += '</div>';
    }
    return html + '</div>';
  }

  function renderAcpConnections(conns) {
    if (!conns || conns.length === 0) {
      return '<div class="card"><div class="card-header">ACP Connections (0)</div><div class="card-body"><span style="color:var(--text2)">No active connections</span></div></div>';
    }
    let html = '<div class="card"><div class="card-header">ACP Connections (' + conns.length + ')</div><div class="card-body"><pre>';
    html += esc(JSON.stringify(conns, null, 2));
    return html + '</pre></div></div>';
  }

  function render(data) {
    statusDot.className = 'dot ' + statusDotClass(data.status);
    uptimeText.textContent = fmtUptime(data.daemon.uptimeMs);
    if (data.daemon.qwenCodeVersion) {
      uptimeText.textContent += ' · v' + data.daemon.qwenCodeVersion;
    }

    let html = '';
    html += renderIssues(data.issues);
    html += renderDaemon(data.daemon);
    html += renderRuntime(data.runtime, data.limits);
    html += renderSecurity(data.security);
    html += renderLimits(data.limits);
    html += renderCapabilities(data.capabilities);

    if (data.full) {
      html += renderSessions(data.full.sessions);
      if (data.full.workspace) html += renderWorkspace(data.full.workspace);
      html += renderAcpConnections(data.full.acpConnections);
      if (data.full.auth) {
        html += '<div class="card"><div class="card-header">Auth</div><div class="card-body"><dl class="kv">';
        html += kvPair('Device flow providers', (data.full.auth.supportedDeviceFlowProviders || []).join(', ') || 'none');
        html += kvPair('Pending device flows', data.full.auth.pendingDeviceFlowCount);
        html += '</dl></div></div>';
      }
    }

    content.innerHTML = html;
  }

  async function fetchStatus() {
    if (fetching) return;
    fetching = true;
    try {
      const res = await fetch('/daemon/status?detail=' + detail, { headers: authHeaders() });
      if (!res.ok) {
        if (res.status === 401) {
          tokenInput.style.borderColor = 'var(--warn)';
          tokenInput.focus();
          setTimeout(() => { tokenInput.style.borderColor = ''; }, 4000);
        }
        const text = await res.text();
        content.innerHTML = '<div class="err-banner">HTTP ' + res.status + ': ' + esc(text) + '</div>';
        statusDot.className = 'dot dot-err';
        return;
      }
      const data = await res.json();
      render(data);
      lastUpdated.textContent = 'Updated ' + new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch (err) {
      content.innerHTML = '<div class="err-banner">Fetch failed: ' + esc(err.message) + '</div>';
      statusDot.className = 'dot dot-err';
    } finally {
      fetching = false;
    }
  }

  function scheduleRefresh() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (interval <= 0) return;
    timer = setTimeout(async () => {
      await fetchStatus();
      scheduleRefresh();
    }, interval);
  }

  fetchStatus().then(scheduleRefresh);
})();
</script>
</body>
</html>`;
}

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
  <span class="badge" id="badgeText">Dashboard</span>
  <span class="dot dot-gray" id="statusDot"></span>
  <span class="uptime" id="uptimeText"></span>
  <div class="header-right">
    <div class="toggle" id="langToggle">
      <button class="btn active" data-lang="en">EN</button>
      <button class="btn" data-lang="zh">中文</button>
    </div>
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
  var I18N = {
    en: {
      badge: 'Dashboard', loading: 'Loading...', refresh: 'Refresh', updated: 'Updated',
      issues: 'Issues', daemon: 'Daemon', runtime: 'Runtime', security: 'Security',
      limits: 'Limits', capabilities: 'Capabilities', sessions: 'Sessions',
      workspaceStatus: 'Workspace Status', acpConnections: 'ACP Connections', auth: 'Auth',
      pid: 'PID', uptime: 'Uptime', mode: 'Mode', workspace: 'Workspace', version: 'Version',
      daemonId: 'Daemon ID', startedAt: 'Started at', startupTime: 'Startup time', preheat: 'Preheat',
      logPath: 'Log path', permPending: 'Permissions pending', permPolicy: 'Permission policy',
      channel: 'Channel', live: 'live', down: 'down', channelWorker: 'Channel Worker',
      state: 'State', channels: 'Channels', restarts: 'Restarts', none: 'none',
      transport: 'Transport', restSse: 'REST SSE active', acpConns: 'ACP connections',
      acpStreams: 'ACP streams', pendingReqs: 'Pending client reqs', disabled: 'disabled',
      rateLimit: 'Rate Limiting', enabled: 'Enabled', rejected: 'Rejected',
      yes: 'yes', no: 'no', unlimited: 'unlimited',
      processMem: 'Process Memory', rss: 'RSS', heapUsed: 'Heap used', heapTotal: 'Heap total',
      maxSessions: 'Max sessions', maxPending: 'Max pending prompts',
      listenerMax: 'Listener max connections', eventRing: 'Event ring size',
      promptDeadline: 'Prompt deadline', writerIdle: 'Writer idle timeout',
      channelIdle: 'Channel idle timeout', sessionIdle: 'Session idle timeout',
      acpCap: 'ACP connection cap', protocol: 'Protocol',
      sessionId: 'Session ID', name: 'Name', clients: 'Clients', prompts: 'Prompts',
      active: 'Active', model: 'Model', noSessions: 'No active sessions',
      noConnections: 'No active connections',
      deviceProviders: 'Device flow providers', pendingFlows: 'Pending device flows',
      fetchFailed: 'Fetch failed',
    },
    zh: {
      badge: '仪表盘', loading: '加载中...', refresh: '刷新', updated: '已更新',
      issues: '问题', daemon: '守护进程', runtime: '运行时', security: '安全',
      limits: '限制', capabilities: '能力', sessions: '会话',
      workspaceStatus: '工作区状态', acpConnections: 'ACP 连接', auth: '认证',
      pid: 'PID', uptime: '运行时间', mode: '模式', workspace: '工作区', version: '版本',
      daemonId: '守护进程 ID', startedAt: '启动时间', startupTime: '启动耗时', preheat: '预热',
      logPath: '日志路径', permPending: '待处理权限', permPolicy: '权限策略',
      channel: '通道', live: '在线', down: '离线', channelWorker: '通道 Worker',
      state: '状态', channels: '通道', restarts: '重启次数', none: '无',
      transport: '传输', restSse: 'REST SSE 活跃', acpConns: 'ACP 连接数',
      acpStreams: 'ACP 流', pendingReqs: '待处理客户端请求', disabled: '已禁用',
      rateLimit: '速率限制', enabled: '已启用', rejected: '已拒绝',
      yes: '是', no: '否', unlimited: '无限制',
      processMem: '进程内存', rss: 'RSS', heapUsed: '堆已用', heapTotal: '堆总量',
      maxSessions: '最大会话数', maxPending: '最大待处理提示数',
      listenerMax: '监听器最大连接数', eventRing: '事件环大小',
      promptDeadline: '提示超时', writerIdle: '写入空闲超时',
      channelIdle: '通道空闲超时', sessionIdle: '会话空闲超时',
      acpCap: 'ACP 连接上限', protocol: '协议',
      sessionId: '会话 ID', name: '名称', clients: '客户端', prompts: '提示',
      active: '活跃', model: '模型', noSessions: '无活跃会话',
      noConnections: '无活跃连接',
      deviceProviders: '设备流提供商', pendingFlows: '待处理设备流',
      fetchFailed: '请求失败',
    }
  };

  var lang = sessionStorage.getItem('dashboard_lang') || 'en';
  var t = I18N[lang] || I18N.en;
  let detail = sessionStorage.getItem('dashboard_detail') || 'summary';
  let interval = parseInt(sessionStorage.getItem('dashboard_interval') || '10000', 10);
  let timer = null;
  let fetching = false;
  let lastData = null;

  const content = document.getElementById('content');
  const statusDot = document.getElementById('statusDot');
  const uptimeText = document.getElementById('uptimeText');
  const lastUpdated = document.getElementById('lastUpdated');
  const tokenInput = document.getElementById('tokenInput');
  const intervalSelect = document.getElementById('intervalSelect');
  const badgeText = document.getElementById('badgeText');

  function switchLang(newLang) {
    lang = newLang;
    t = I18N[lang] || I18N.en;
    sessionStorage.setItem('dashboard_lang', lang);
    badgeText.textContent = t.badge;
    document.getElementById('btnRefresh').textContent = t.refresh;
    if (lastData) render(lastData);
    else content.innerHTML = '<div class="loading">' + t.loading + '</div>';
  }

  // Lang toggle
  var langBtns = document.querySelectorAll('#langToggle .btn');
  langBtns.forEach(function(btn) {
    if (btn.dataset.lang === lang) btn.classList.add('active');
    else btn.classList.remove('active');
    btn.addEventListener('click', function() {
      langBtns.forEach(function(b) { b.classList.toggle('active', b === btn); });
      switchLang(btn.dataset.lang);
    });
  });

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

  // Init lang text
  badgeText.textContent = t.badge;
  document.getElementById('btnRefresh').textContent = t.refresh;

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
    return '<span class="chip ' + (val ? 'chip-ok' : 'chip-off') + '">' + esc(label) + ': ' + (val ? t.yes : t.no) + '</span> ';
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
    let html = '<div class="card"><div class="card-header">' + t.issues + ' (' + issues.length + ')</div><div class="card-body">';
    for (const issue of issues) {
      const cls = issue.severity === 'error' ? 'chip-err' : 'chip-warn';
      html += '<div class="issue"><span class="issue-code chip ' + cls + '">' + esc(issue.code) + '</span><span>' + esc(issue.message) + '</span></div>';
    }
    return html + '</div></div>';
  }

  function renderDaemon(d) {
    let html = '<div class="card"><div class="card-header">' + t.daemon + '</div><div class="card-body"><dl class="kv">';
    html += kvPair(t.pid, d.pid);
    html += kvPair(t.uptime, fmtUptime(d.uptimeMs));
    html += kvPair(t.mode, d.mode);
    html += kvPair(t.workspace, d.workspaceCwd);
    if (d.qwenCodeVersion) html += kvPair(t.version, d.qwenCodeVersion);
    if (d.daemonId) html += kvPair(t.daemonId, d.daemonId);
    if (d.startup) {
      html += kvPair(t.startedAt, fmtTime(d.startup.processStartedAt));
      if (d.startup.processToListenMs !== undefined) html += kvPair(t.startupTime, d.startup.processToListenMs + 'ms');
      html += kvPair(t.preheat, d.startup.preheat.status + (d.startup.preheat.durationMs !== undefined ? ' (' + d.startup.preheat.durationMs + 'ms)' : ''));
    }
    if (d.logPath) html += kvPair(t.logPath, d.logPath);
    return html + '</dl></div></div>';
  }

  function renderRuntime(r, limits) {
    let html = '<div class="card"><div class="card-header">' + t.runtime + '</div><div class="card-body">';
    if (r.loading) html += '<div class="chip chip-warn">' + t.loading + '</div>';
    if (r.error) html += '<div class="chip chip-err">' + esc(r.error) + '</div>';

    html += '<dl class="kv">';
    html += kvPair(t.sessions, r.sessions.active + (limits.maxSessions ? ' / ' + limits.maxSessions : ''));
    html += '</dl>';
    if (limits.maxSessions) html += capacityBar(r.sessions.active, limits.maxSessions);

    html += '<dl class="kv" style="margin-top:8px">';
    html += kvPair(t.permPending, r.permissions.pending);
    html += kvPair(t.permPolicy, r.permissions.policy);
    html += '<dt>' + t.channel + '</dt><dd><span class="dot ' + (r.channel.live ? 'dot-ok' : 'dot-err') + '"></span> ' + (r.channel.live ? t.live : t.down) + '</dd>';
    html += '</dl>';

    if (r.channelWorker && r.channelWorker.enabled) {
      html += '<div class="sub-section"><div class="sub-title">' + t.channelWorker + '</div><dl class="kv">';
      html += kvPair(t.state, r.channelWorker.state);
      if (r.channelWorker.pid !== undefined) html += kvPair(t.pid, r.channelWorker.pid);
      if (r.channelWorker.channels) html += kvPair(t.channels, r.channelWorker.channels.join(', ') || t.none);
      if (r.channelWorker.restartCount !== undefined) html += kvPair(t.restarts, r.channelWorker.restartCount);
      html += '</dl></div>';
    }

    html += '<div class="sub-section"><div class="sub-title">' + t.transport + '</div><dl class="kv">';
    html += kvPair(t.restSse, r.transport.restSseActive);
    if (r.transport.acp.enabled) {
      html += kvPair(t.acpConns, r.transport.acp.connections);
      html += kvPair(t.acpStreams, 'conn=' + r.transport.acp.connectionStreams + ' sess=' + r.transport.acp.sessionStreams + ' sse=' + r.transport.acp.sseStreams + ' ws=' + r.transport.acp.wsStreams);
      html += kvPair(t.pendingReqs, r.transport.acp.pendingClientRequests);
    } else {
      html += kvPair('ACP', t.disabled);
    }
    html += '</dl>';
    if (r.transport.acp.enabled && limits.acpConnectionCap) {
      html += capacityBar(r.transport.acp.connections, limits.acpConnectionCap);
    }
    html += '</div>';

    html += '<div class="sub-section"><div class="sub-title">' + t.rateLimit + '</div><dl class="kv">';
    html += kvPair(t.enabled, r.rateLimit.enabled ? t.yes : t.no);
    if (r.rateLimit.enabled) {
      const h = r.rateLimit.rejectedSinceStart;
      html += kvPair(t.rejected, 'prompt=' + (h.prompt||0) + ' mutation=' + (h.mutation||0) + ' read=' + (h.read||0));
    }
    html += '</dl></div>';

    html += '<div class="sub-section"><div class="sub-title">' + t.processMem + '</div><dl class="kv">';
    html += kvPair(t.rss, fmtBytes(r.process.rss));
    html += kvPair(t.heapUsed, fmtBytes(r.process.heapUsed));
    html += kvPair(t.heapTotal, fmtBytes(r.process.heapTotal));
    html += '</dl></div>';

    return html + '</div></div>';
  }

  function renderSecurity(s) {
    let html = '<div class="card"><div class="card-header">' + t.security + '</div><div class="card-body">';
    html += boolChip(s.tokenConfigured, 'token');
    html += boolChip(s.requireAuth, 'requireAuth');
    html += boolChip(s.loopbackBind, 'loopback');
    html += boolChip(s.sessionShellCommandEnabled, 'shell');
    html += '<br/><span class="chip chip-off">allowOrigin: ' + esc(s.allowOriginMode) + '</span>';
    return html + '</div></div>';
  }

  function renderLimits(l) {
    let html = '<div class="card"><div class="card-header">' + t.limits + '</div><div class="card-body"><dl class="kv">';
    const entries = [
      [t.maxSessions, l.maxSessions],
      [t.maxPending, l.maxPendingPromptsPerSession],
      [t.listenerMax, l.listenerMaxConnections],
      [t.eventRing, l.eventRingSize],
      [t.promptDeadline, l.promptDeadlineMs !== null ? l.promptDeadlineMs + 'ms' : null],
      [t.writerIdle, l.writerIdleTimeoutMs !== null ? l.writerIdleTimeoutMs + 'ms' : null],
      [t.channelIdle, l.channelIdleTimeoutMs + 'ms'],
      [t.sessionIdle, l.sessionIdleTimeoutMs + 'ms'],
      [t.acpCap, l.acpConnectionCap],
    ];
    for (const [label, val] of entries) {
      html += kvPair(label, val !== null && val !== undefined ? val : t.unlimited);
    }
    return html + '</dl></div></div>';
  }

  function renderCapabilities(c) {
    let html = '<div class="card"><div class="card-header">' + t.capabilities + '</div><div class="card-body">';
    html += '<dl class="kv">';
    html += kvPair(t.protocol, c.protocolVersions.current);
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
      return '<div class="card"><div class="card-header">' + t.sessions + ' (0)</div><div class="card-body"><span style="color:var(--text2)">' + t.noSessions + '</span></div></div>';
    }
    let html = '<div class="card"><div class="card-header">' + t.sessions + ' (' + sessions.length + ')</div><div class="card-body"><table>';
    html += '<tr><th>' + t.sessionId + '</th><th>' + t.name + '</th><th>' + t.clients + '</th><th>' + t.prompts + '</th><th>' + t.active + '</th><th>' + t.model + '</th></tr>';
    for (const s of sessions) {
      const shortId = s.sessionId.length > 12 ? s.sessionId.slice(0, 12) + '...' : s.sessionId;
      html += '<tr>';
      html += '<td title="' + esc(s.sessionId) + '">' + esc(shortId) + '</td>';
      html += '<td>' + esc(s.displayName || '-') + '</td>';
      html += '<td>' + s.clientCount + '</td>';
      html += '<td>' + s.pendingPromptCount + '</td>';
      html += '<td><span class="chip ' + (s.hasActivePrompt ? 'chip-ok' : 'chip-off') + '">' + (s.hasActivePrompt ? t.yes : t.no) + '</span></td>';
      html += '<td>' + esc(s.currentModelId || '-') + '</td>';
      html += '</tr>';
    }
    return html + '</table></div></div>';
  }

  function renderWorkspace(ws) {
    let html = '<div class="card"><div class="card-header">' + t.workspaceStatus + '</div>';
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
      return '<div class="card"><div class="card-header">' + t.acpConnections + ' (0)</div><div class="card-body"><span style="color:var(--text2)">' + t.noConnections + '</span></div></div>';
    }
    let html = '<div class="card"><div class="card-header">' + t.acpConnections + ' (' + conns.length + ')</div><div class="card-body"><pre>';
    html += esc(JSON.stringify(conns, null, 2));
    return html + '</pre></div></div>';
  }

  function render(data) {
    lastData = data;
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
        html += '<div class="card"><div class="card-header">' + t.auth + '</div><div class="card-body"><dl class="kv">';
        html += kvPair(t.deviceProviders, (data.full.auth.supportedDeviceFlowProviders || []).join(', ') || t.none);
        html += kvPair(t.pendingFlows, data.full.auth.pendingDeviceFlowCount);
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
      lastUpdated.textContent = t.updated + ' ' + new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch (err) {
      content.innerHTML = '<div class="err-banner">' + t.fetchFailed + ': ' + esc(err.message) + '</div>';
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

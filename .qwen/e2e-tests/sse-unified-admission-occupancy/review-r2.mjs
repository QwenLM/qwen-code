#!/usr/bin/env node
/**
 * G5 — review-round-2 behaviors (issue #17554): terminal codes at
 * saturation, access-log attribution, plural-mount gating, primary
 * deep-health listener pair. Zero-dependency, Node >= 22.
 *
 * Usage: node review-r2.mjs --base URL --token-file F [--log-file F]
 * Runs all checks sequentially against a daemon started with
 * --max-connections 12 --max-sse-connections 6 and TWO workspaces.
 */
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}
const base = flag('base', 'http://127.0.0.1:4199');
const token = readFileSync(flag('token-file'), 'utf8').trim();
const logFile = flag('log-file');
const auth = { Authorization: `Bearer ${token}` };
const jsonHeaders = { 'content-type': 'application/json', ...auth };
const held = [];
const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} :: ${JSON.stringify(detail)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function j(res) {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}
async function status() {
  return (await fetch(`${base}/daemon/status?detail=full`, { headers: auth })).json();
}
async function deep() {
  return (await fetch(`${base}/health?deep=1`, { headers: auth })).json();
}
async function newSession() {
  const res = await fetch(`${base}/session`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({}),
  });
  const body = await j(res);
  if (res.status !== 200 && res.status !== 201)
    throw new Error(`POST /session -> ${res.status} ${JSON.stringify(body)}`);
  // The daemon ISSUES the client id; caller-asserted ids are rejected
  // (InvalidClientIdError). Use the issued id on every session route.
  return { sessionId: body.sessionId ?? body.id, clientId: body.clientId };
}
async function openRest(sessionId) {
  const controller = new AbortController();
  const res = await fetch(`${base}/session/${sessionId}/events`, {
    headers: { ...auth, 'X-Qwen-Client-Id': clientId },
    signal: controller.signal,
  });
  held.push({ controller, res });
  return res;
}
async function acpInit(pathname = '/acp') {
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } }),
  });
  const connId = res.headers.get('acp-connection-id');
  await j(res);
  return { status: res.status, connId };
}
function wsUpgradeProbe(pathname = '/acp') {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    const req = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: pathname,
      headers: {
        ...auth,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
      },
    });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve({ status: 101 });
    });
    req.on('response', (res) => {
      res.resume();
      resolve({ status: res.statusCode, retryAfter: res.headers['retry-after'] });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── 1. Baseline + primary deep-health listener pair ─────────────────
const { sessionId: session, clientId } = await newSession();
const before = await status();
const streams = [];
for (let i = 0; i < 3; i++) streams.push(await openRest(session));
await sleep(300);
const mid = await status();
const midDeep = await deep();
record(
  'occupancy-counts-rest',
  mid.runtime.transport.streamOccupancy.total === before.runtime.transport.streamOccupancy.total + 3,
  { before: before.runtime.transport.streamOccupancy.total, after: mid.runtime.transport.streamOccupancy.total },
);
record(
  'deep-health-primary-listener-pair',
  midDeep.listenerConnectedClients === mid.runtime.transport.streamOccupancy.byListener.primary &&
    midDeep.listenerConnectedClientsMax === mid.limits.maxSseConnectionsPerListener.primary &&
    midDeep.connectedClients === mid.runtime.transport.streamOccupancy.total &&
    midDeep.connectedClientsMax === mid.limits.maxSseConnections,
  {
    listenerPair: [midDeep.listenerConnectedClients, midDeep.listenerConnectedClientsMax],
    aggregatePair: [midDeep.connectedClients, midDeep.connectedClientsMax],
    byListenerPrimary: mid.runtime.transport.streamOccupancy.byListener.primary,
    perListenerPrimary: mid.limits.maxSseConnectionsPerListener.primary,
  },
);

// ── 2. BTW terminal codes at saturation ──────────────────────────────
const btwFirst = await fetch(`${base}/session/${session}/btw/stream`, {
  method: 'POST',
  headers: { ...jsonHeaders, 'X-Qwen-Client-Id': clientId },
  body: JSON.stringify({ question: 'Why is the sky blue?', requestId: 'r2-btw-1' }),
});
const btwFirstBody = await j(btwFirst);
if (btwFirst.status === 200) {
  held.push({ controller: new AbortController(), res: btwFirst, noAbort: true });
  // Fill the cap with REST streams (3 held + 3 more = 6).
  for (let i = 0; i < 3; i++) streams.push(await openRest(session));
  await sleep(300);
  const sat = await status();
  const conflict = await fetch(`${base}/session/${session}/btw/stream`, {
    method: 'POST',
    headers: { ...jsonHeaders, 'X-Qwen-Client-Id': clientId },
    body: JSON.stringify({ question: 'A different question?', requestId: 'r2-btw-1' }),
  });
  const conflictBody = await j(conflict);
  record('btw-conflict-409-at-saturation', conflict.status === 409 && conflictBody?.code === 'btw_request_conflict', {
    occupancy: sat.runtime.transport.streamOccupancy.total,
    status: conflict.status,
    code: conflictBody?.code,
  });
  const expired = await fetch(`${base}/session/${session}/btw/stream`, {
    method: 'POST',
    headers: { ...jsonHeaders, 'X-Qwen-Client-Id': clientId },
    body: JSON.stringify({ question: 'Why is the sky blue?', requestId: 'r2-unknown', resume: true }),
  });
  const expiredBody = await j(expired);
  record('btw-expired-410-at-saturation', expired.status === 410 && expiredBody?.code === 'btw_expired', {
    status: expired.status,
    code: expiredBody?.code,
  });
} else {
  record('btw-terminal-codes', false, { note: 'first BTW not admitted; covered-by-unit', status: btwFirst.status, body: btwFirstBody });
  for (let i = 0; i < 3; i++) streams.push(await openRest(session));
  await sleep(300);
}

// ── 3. Ownership 403 terminal at saturation (ACP) ────────────────────
const connB = await acpInit();
const foreign = await fetch(`${base}/acp`, {
  headers: { ...auth, accept: 'text/event-stream', 'acp-connection-id': connB.connId, 'acp-session-id': 'r2-foreign-session' },
});
const foreignBody = await j(foreign);
record('acp-ownership-403-at-saturation', foreign.status === 403 && foreignBody?.error === 'Session not owned by this connection', {
  status: foreign.status,
  error: foreignBody?.error,
});
const connScoped = await fetch(`${base}/acp`, {
  headers: { ...auth, accept: 'text/event-stream', 'acp-connection-id': connB.connId },
});
const connScopedBody = await j(connScoped);
record('acp-conn-stream-503-at-saturation', connScoped.status === 503 && connScopedBody?.code === 'sse_connection_limit_exceeded', {
  status: connScoped.status,
  code: connScopedBody?.code,
  scope: connScopedBody?.scope,
});

// ── 4. Aggregate refusal shape + short-request headroom ──────────────
const overflow = await fetch(`${base}/session/${session}/events`, { headers: auth });
const overflowBody = await j(overflow);
record('rest-overflow-503-shape', overflow.status === 503 && overflow.headers.get('retry-after') === '5' && overflowBody?.code === 'sse_connection_limit_exceeded' && overflowBody?.scope === 'daemon' && overflowBody?.limit === 6, {
  status: overflow.status,
  body: overflowBody,
});
const healthAtSat = await fetch(`${base}/health`, { headers: auth });
record('health-200-at-saturation', healthAtSat.status === 200, { status: healthAtSat.status });
await j(healthAtSat);

// ── 5. Plural mount gating ───────────────────────────────────────────
const fullStatus = await status();
const wsList = fullStatus.workspaces ?? [];
const secondary = wsList.find((w) => w.primary === false || w.isPrimary === false);
if (secondary) {
  const sel = secondary.workspaceId ?? secondary.id;
  const pluralConn = await acpInit(`/workspaces/${sel}/acp`);
  const pluralRefused = await fetch(`${base}/workspaces/${sel}/acp`, {
    headers: { ...auth, accept: 'text/event-stream', 'acp-connection-id': pluralConn.connId },
  });
  const pluralBody = await j(pluralRefused);
  record('plural-sse-503-at-saturation', pluralRefused.status === 503 && pluralBody?.code === 'sse_connection_limit_exceeded', {
    selector: sel,
    status: pluralRefused.status,
    code: pluralBody?.code,
  });
  const pluralWs = await wsUpgradeProbe(`/workspaces/${sel}/acp`);
  record('plural-ws-503-pre-upgrade', pluralWs.status === 503 && pluralWs.retryAfter === '5', pluralWs);
} else {
  record('plural-mount', false, { note: 'no secondary workspace found', wsList });
}

// ── 6. Access-log attribution ────────────────────────────────────────
if (logFile) {
  await sleep(500);
  const log = readFileSync(logFile, 'utf8');
  const lines = log.split('\n').filter((l) => l.includes('request completed') && l.includes('sse_connection_limit_exceeded'));
  record('access-log-code-attribution', lines.length > 0, { matchingLines: lines.length, sample: lines[0]?.slice(0, 400) });
}

// ── 7. Release + readmission ─────────────────────────────────────────
for (const h of held) {
  if (h.noAbort) continue;
  h.controller.abort();
  await h.res.body?.cancel().catch(() => {});
}
await sleep(800);
const after = await status();
const afterDeep = await deep();
record('slots-released', after.runtime.transport.streamOccupancy.total === before.runtime.transport.streamOccupancy.total && afterDeep.connectedClients === after.runtime.transport.streamOccupancy.total, {
  before: before.runtime.transport.streamOccupancy.total,
  after: after.runtime.transport.streamOccupancy.total,
});
const readmit = await openRest(session);
record('readmission-after-release', readmit.status === 200, { status: readmit.status });
readmit.body?.cancel().catch(() => {});

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
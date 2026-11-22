#!/usr/bin/env node
/**
 * Zero-dependency load driver for the unified SSE admission/occupancy E2E
 * plan (issue #17554). Node >= 22 (global fetch + WebSocket).
 *
 * Subcommands:
 *   new-sessions --base URL --token-file F --n N
 *   open --base URL --token-file F --surface rest|acp-sse|acp-ws
 *        --count N [--session ID] [--hold SECS] [--probe]
 *   attempt --base URL --token-file F --surface rest|acp-sse|acp-ws
 *        [--session ID]          (open one stream, report, close)
 *   status --base URL --token-file F
 *   lan-enable --base URL --token-file F --pairing-out F
 *
 * The token is read from the file and never printed.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const cmd = argv[0];
function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}
const base = flag('base', 'http://127.0.0.1:4170');
const tokenFile = flag('token-file');
const token = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : undefined;
const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(res) {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

async function newSessions(n) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const res = await fetch(`${base}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders },
      body: JSON.stringify({}),
    });
    const body = await json(res);
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`POST /session -> ${res.status}: ${JSON.stringify(body)}`);
    }
    ids.push(body.sessionId);
  }
  return ids;
}

async function acpInitialize() {
  const res = await fetch(`${base}/acp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
  });
  if (res.status !== 200) {
    return { error: `initialize -> ${res.status}`, body: await json(res) };
  }
  const connId = res.headers.get('acp-connection-id');
  await json(res);
  return { connId };
}

/** Open one stream of the surface; returns {kind, ...}. kind:
 * established | refused | silent | other. Keeps the stream handle open. */
async function openOne(surface, sessionId) {
  if (surface === 'rest') {
    try {
      const res = await fetch(
        `${base}/session/${sessionId ?? 'sess-e2e'}/events`,
        { headers: { ...authHeaders } },
      );
      if (res.status === 200) {
        // Healthy consumer: drain frames so heartbeats never stall.
        const reader = res.body.getReader();
        void (async () => {
          try {
            while (!(await reader.read()).done) {}
          } catch {}
        })();
        return { kind: 'established', close: () => reader.cancel().catch(() => {}) };
      }
      const body = await json(res);
      if (res.status === 503) return { kind: 'refused', status: 503, body };
      return { kind: 'other', status: res.status, body };
    } catch (err) {
      return { kind: 'silent', error: err.cause?.code ?? err.message };
    }
  }
  if (surface === 'acp-sse') {
    const init = await acpInitialize();
    if (!init.connId) return { kind: 'other', stage: 'initialize', ...init };
    try {
      const res = await fetch(`${base}/acp`, {
        headers: {
          accept: 'text/event-stream',
          'acp-connection-id': init.connId,
          ...authHeaders,
        },
      });
      if (res.status === 200) {
        const reader = res.body.getReader();
        void (async () => {
          try {
            while (!(await reader.read()).done) {}
          } catch {}
        })();
        return { kind: 'established', close: () => reader.cancel().catch(() => {}) };
      }
      const body = await json(res);
      if (res.status === 503) return { kind: 'refused', status: 503, body };
      return { kind: 'other', status: res.status, body };
    } catch (err) {
      return { kind: 'silent', error: err.cause?.code ?? err.message };
    }
  }
  if (surface === 'acp-ws') {
    const wsUrl = base.replace(/^http/, 'ws') + '/acp';
    return await new Promise((resolve) => {
      let settled = false;
      const ws = new WebSocket(wsUrl, { headers: authHeaders });
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { ws.close(); } catch {}
          resolve({ kind: 'silent', error: 'timeout' });
        }
      }, 8000);
      ws.addEventListener('error', (ev) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ kind: 'silent', error: ev.message ?? 'ws-error' });
        }
      });
      ws.addEventListener('close', (ev) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ kind: 'silent', error: `closed-before-init code=${ev.code}` });
        }
      });
      ws.addEventListener('open', () => {
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: 1 },
          }),
        );
      });
      ws.addEventListener('message', (ev) => {
        if (settled) return;
        let msg;
        try { msg = JSON.parse(String(ev.data)); } catch { return; }
        if (msg.id === 1 && msg.result) {
          settled = true;
          clearTimeout(timer);
          resolve({ kind: 'established', close: () => { try { ws.close(); } catch {} } });
        } else if (msg.id === 1 && msg.error) {
          settled = true;
          clearTimeout(timer);
          resolve({ kind: 'other', stage: 'initialize', body: msg.error });
          try { ws.close(); } catch {}
        }
      });
    });
  }
  throw new Error(`unknown surface ${surface}`);
}

async function probe() {
  const out = {};
  for (const path of ['/health', '/capabilities', '/']) {
    try {
      const res = await fetch(`${base}${path}`, { headers: { ...authHeaders } });
      out[path] = res.status;
      await res.arrayBuffer().catch(() => {});
    } catch (err) {
      out[path] = `ERR:${err.cause?.code ?? err.message}`;
    }
  }
  return out;
}

async function statusSnapshot() {
  const out = {};
  try {
    const res = await fetch(`${base}/daemon/status?detail=full`, {
      headers: { ...authHeaders },
    });
    const body = await json(res);
    out.limits = body?.limits;
    out.transport = body?.runtime?.transport;
  } catch (err) {
    out.statusError = err.message;
  }
  try {
    const res = await fetch(`${base}/health?deep=1`, { headers: { ...authHeaders } });
    const body = await json(res);
    out.deepHealth = {
      status: body?.status,
      connectedClients: body?.connectedClients,
      connectedClientsMax: body?.connectedClientsMax,
    };
  } catch (err) {
    out.deepHealthError = err.message;
  }
  return out;
}

function tally(results) {
  const t = { established: 0, refused: 0, silent: 0, other: 0 };
  for (const r of results) t[r.kind] = (t[r.kind] ?? 0) + 1;
  return t;
}

async function main() {
  if (cmd === 'new-sessions') {
    const ids = await newSessions(Number(flag('n', '1')));
    console.log(JSON.stringify({ sessionIds: ids }));
    return;
  }
  if (cmd === 'status') {
    console.log(JSON.stringify(await statusSnapshot(), null, 2));
    return;
  }
  if (cmd === 'lan-enable') {
    const res = await fetch(`${base}/workspace/local-control/enable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders },
      body: JSON.stringify({}),
    });
    const body = await json(res);
    if (res.status !== 200) {
      console.log(JSON.stringify({ error: res.status, body }));
      process.exitCode = 1;
      return;
    }
    const url = body.url;
    const secret = url ? new URL(url).hash.match(/token=([^&]+)/)?.[1] : undefined;
    const pairingOut = flag('pairing-out');
    if (secret && pairingOut) {
      writeFileSync(pairingOut, decodeURIComponent(secret));
    }
    console.log(
      JSON.stringify({
        active: body.active,
        address: body.address,
        port: body.port,
        authority: body.address ? `${body.address}:${body.port}` : undefined,
        pairingSecretWritten: Boolean(secret && pairingOut),
      }),
    );
    return;
  }
  if (cmd === 'open' || cmd === 'attempt') {
    const surface = flag('surface', 'rest');
    const count = cmd === 'attempt' ? 1 : Number(flag('count', '1'));
    const holdS = cmd === 'attempt' ? 0 : Number(flag('hold', '30'));
    const sessionId = flag('session');
    const doProbe = argv.includes('--probe');
    const handles = [];
    const results = [];
    for (let i = 0; i < count; i++) {
      const r = await openOne(surface, sessionId);
      results.push(r);
      if (r.kind === 'established') handles.push(r);
    }
    const ramp = {
      event: 'ramp_complete',
      surface,
      counts: tally(results),
      refusals: results
        .filter((r) => r.kind === 'refused')
        .map((r) => r.body)
        .slice(0, 3),
      others: results
        .filter((r) => r.kind === 'other' || r.kind === 'silent')
        .slice(0, 3),
    };
    console.log(JSON.stringify(ramp));
    if (doProbe) {
      console.log(JSON.stringify({ event: 'probe_after_ramp', probes: await probe() }));
    }
    const holdUntil = Date.now() + holdS * 1000;
    let tick = 0;
    while (Date.now() < holdUntil) {
      await sleep(Math.min(5000, Math.max(0, holdUntil - Date.now())));
      tick++;
      if (doProbe && Date.now() < holdUntil) {
        console.log(
          JSON.stringify({ event: `hold_tick_${tick}`, probes: await probe() }),
        );
      }
    }
    if (doProbe && holdS > 0) {
      console.log(JSON.stringify({ event: 'status_during_hold', ...(await statusSnapshot()) }));
    }
    for (const h of handles) h.close();
    await sleep(500);
    console.log(
      JSON.stringify({
        event: 'released',
        closed: handles.length,
        ...(await statusSnapshot()),
      }),
    );
    return;
  }
  console.error(`unknown command: ${cmd}`);
  process.exitCode = 2;
}

main().catch((err) => {
  console.error(JSON.stringify({ fatal: err.message }));
  process.exitCode = 1;
});
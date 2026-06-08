/**
 * Throwaway manual e2e for @qwen-code/rc-gateway against a REAL `qwen serve`.
 * Spawns the repo CLI daemon on loopback, stands up the gateway in front of it,
 * and exercises pairing -> scoped token -> authenticated, scope-gated proxy.
 * Not part of the test suite; run with: node scripts/rc-gateway-e2e.mjs
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DaemonClient } from '@qwen-code/sdk';
import {
  createGatewayApp,
  TokenStore,
  PairingService,
  VapidStore,
  PushStore,
  SESSION_READ,
  APPROVE,
  WRITE,
  OWNER,
} from '../packages/rc-gateway/dist/index.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cli = join(repoRoot, 'packages/cli/dist/index.js');
const DAEMON_PORT = 4199;
const GATEWAY_PORT = 4198;
const token = randomBytes(32).toString('base64url');
const workspace = mkdtempSync(join(tmpdir(), 'rc-e2e-ws-'));

let pass = 0;
let fail = 0;
const ok = (m) => {
  pass++;
  console.log(`  PASS  ${m}`);
};
const bad = (m) => {
  fail++;
  console.log(`  FAIL  ${m}`);
};

async function poll(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await fn()) return true;
    } catch {
      /* retry */
    }
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

console.log(`\n=== rc-gateway e2e vs real qwen serve ===`);
console.log(`daemon cli: ${cli}`);
console.log(`workspace:  ${workspace}\n`);

const daemon = spawn(
  process.execPath,
  [
    cli,
    'serve',
    '--hostname',
    '127.0.0.1',
    '--port',
    String(DAEMON_PORT),
    '--require-auth',
    '--workspace',
    workspace,
  ],
  { env: { ...process.env, QWEN_SERVER_TOKEN: token }, stdio: 'inherit' },
);

let gatewayServer;
const cleanup = () => {
  try {
    gatewayServer?.close();
  } catch {
    /* ignore */
  }
  try {
    daemon.kill('SIGTERM');
  } catch {
    /* ignore */
  }
};

try {
  const daemonBase = `http://127.0.0.1:${DAEMON_PORT}`;
  const dc = new DaemonClient({ baseUrl: daemonBase, token });

  // 1. Real daemon boots with our exact flags and becomes healthy.
  await poll(
    async () => (await dc.health()).status === 'ok',
    20000,
    'daemon health',
  );
  ok('real qwen serve boots with --hostname/--port/--require-auth and is healthy');

  // Gateway in front of the real daemon.
  const store = await TokenStore.open(join(workspace, 'tokens.json'));
  const pairing = new PairingService();
  const vapid = await VapidStore.open(join(workspace, 'vapid.json'));
  const pushStore = await PushStore.open(join(workspace, 'push.json'));
  const app = createGatewayApp({ daemon: dc, store, pairing, vapid, pushStore });
  gatewayServer = await new Promise((res) => {
    const s = app.listen(GATEWAY_PORT, '127.0.0.1', () => res(s));
  });
  const gw = `http://127.0.0.1:${GATEWAY_PORT}`;

  // 2. Gateway health.
  {
    const r = await fetch(`${gw}/rc/health`);
    r.status === 200 ? ok('gateway /rc/health 200') : bad(`gateway health ${r.status}`);
  }

  // 3. Pairing -> scoped token.
  const { code } = pairing.mint([SESSION_READ]);
  const redeem = await fetch(`${gw}/rc/pair/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, label: 'e2e' }),
  });
  const redeemBody = await redeem.json();
  redeem.status === 200 &&
  JSON.stringify(redeemBody.scopes) === JSON.stringify([SESSION_READ]) &&
  typeof redeemBody.token === 'string'
    ? ok('pair redeem -> 200 with scoped token')
    : bad(`pair redeem ${redeem.status} ${JSON.stringify(redeemBody)}`);
  const userToken = redeemBody.token;

  // 4. Events without a token -> 401.
  {
    const r = await fetch(`${gw}/rc/session/nope/events`);
    r.status === 401 ? ok('events without token -> 401') : bad(`no-token ${r.status}`);
  }

  // 5. Events with a no-scope token -> 403.
  {
    const { code: c2 } = pairing.mint([]);
    const r2 = await fetch(`${gw}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: c2, label: 'weak' }),
    });
    const weak = (await r2.json()).token;
    const r = await fetch(`${gw}/rc/session/nope/events`, {
      headers: { Authorization: `Bearer ${weak}` },
    });
    r.status === 403 ? ok('events with no-scope token -> 403') : bad(`no-scope ${r.status}`);
  }

  // 6. Authenticated, scoped proxy actually reaches the REAL daemon.
  //    For an unknown session the daemon errors during connect, which the
  //    gateway maps to 502 (proves the request traversed gateway->daemon).
  {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 5000);
    try {
      const r = await fetch(`${gw}/rc/session/does-not-exist/events`, {
        headers: { Authorization: `Bearer ${userToken}` },
        signal: ac.signal,
      });
      r.status === 502 || r.status === 404
        ? ok(`scoped proxy reached real daemon (status ${r.status} for unknown session)`)
        : bad(`unexpected proxy status ${r.status}`);
    } catch (e) {
      bad(`proxy request errored/hung: ${e}`);
    } finally {
      clearTimeout(t);
    }
  }
  // The web viewer is served at /ui/ (public HTML).
  {
    const r = await fetch(`${gw}/ui/`);
    const body = await r.text();
    r.status === 200 && body.includes('qwen-rc viewer')
      ? ok('web viewer served at /ui/')
      : bad(`/ui/ returned ${r.status}`);
  }

  // Permission vote with an approve-scoped token reaches the real daemon.
  {
    const { code: pc } = pairing.mint([SESSION_READ, APPROVE]);
    const rr = await fetch(`${gw}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: pc, label: 'approver' }),
    });
    const at = (await rr.json()).token;
    const r = await fetch(`${gw}/rc/session/does-not-exist/permission/nope`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${at}`,
      },
      body: JSON.stringify({ outcome: 'cancelled' }),
    });
    r.status === 404
      ? ok('permission vote reached real daemon (404 no pending)')
      : bad(`vote returned ${r.status}`);
  }

  // Prompt with a write-scoped token reaches the real daemon. For an unknown
  // session the daemon rejects with a non-2xx, which the gateway maps to 502
  // (proves route + scope + daemon reached without needing a live model turn).
  {
    const { code: wc } = pairing.mint([SESSION_READ, WRITE]);
    const rr = await fetch(`${gw}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: wc, label: 'writer' }),
    });
    const wt = (await rr.json()).token;
    const r = await fetch(`${gw}/rc/session/does-not-exist/prompt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${wt}`,
      },
      body: JSON.stringify({ prompt: 'ping' }),
    });
    r.status === 502
      ? ok('prompt reached real daemon (502 for unknown session)')
      : bad(`prompt returned ${r.status}`);
  }

  // WebPush (cycle 8): vapid key, subscribe, list, delete — pure gateway state,
  // exercised with the session:read userToken (own-subscription ops only).
  {
    const vr = await fetch(`${gw}/rc/push/vapid`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    const vb = await vr.json();
    vr.status === 200 && typeof vb.applicationServerKey === 'string'
      ? ok('push vapid -> 200 with applicationServerKey')
      : bad(`push vapid ${vr.status} ${JSON.stringify(vb)}`);

    const sr = await fetch(`${gw}/rc/push/subscribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({
        subscription: {
          endpoint: 'https://push.example.com/e2e-1',
          keys: { p256dh: 'p256dh-e2e', auth: 'auth-e2e' },
        },
      }),
    });
    const sb = await sr.json();
    const subId = sb.id;
    sr.status === 201 && typeof subId === 'string'
      ? ok('push subscribe -> 201 with id')
      : bad(`push subscribe ${sr.status} ${JSON.stringify(sb)}`);

    const lr = await fetch(`${gw}/rc/push/subscriptions`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    const lb = await lr.json();
    lr.status === 200 &&
    Array.isArray(lb.subscriptions) &&
    lb.subscriptions.some((s) => s.id === subId)
      ? ok('push subscriptions list includes new subscription')
      : bad(`push list ${lr.status} ${JSON.stringify(lb)}`);

    const dr = await fetch(`${gw}/rc/push/subscriptions/${subId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${userToken}` },
    });
    dr.status === 204
      ? ok('push unsubscribe -> 204')
      : bad(`push delete ${dr.status}`);
  }

  // WebPush send-test (cycle 9): an owner token subscribes a dummy endpoint and
  // POSTs /rc/push/test. The route is owner-gated and fans out to the caller's
  // own subscriptions. The real send to the dummy endpoint fails/expires
  // (network/410) which is fine — we assert only the route + fan-out wiring
  // (200 with sent>=1), not delivery success.
  {
    const { code: oc } = pairing.mint([SESSION_READ, OWNER]);
    const orr = await fetch(`${gw}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: oc, label: 'push-owner' }),
    });
    const ownerToken = (await orr.json()).token;

    const sr = await fetch(`${gw}/rc/push/subscribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        subscription: {
          endpoint: 'https://push.example.com/e2e-test-target',
          keys: { p256dh: 'p256dh-e2e-test', auth: 'auth-e2e-test' },
        },
      }),
    });
    sr.status === 201
      ? ok('push subscribe (owner, for send-test) -> 201')
      : bad(`push owner subscribe ${sr.status}`);

    const tr = await fetch(`${gw}/rc/push/test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ sessionId: 'e2e' }),
    });
    const tb = await tr.json();
    tr.status === 200 && typeof tb.sent === 'number' && tb.sent >= 1
      ? ok(`push test route -> 200 with sent=${tb.sent}`)
      : bad(`push test ${tr.status} ${JSON.stringify(tb)}`);

    // A non-owner (session:read-only) token must be rejected at the owner gate.
    const ntr = await fetch(`${gw}/rc/push/test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({}),
    });
    ntr.status === 403
      ? ok('push test route as non-owner -> 403')
      : bad(`push test non-owner ${ntr.status}`);
  }
} catch (e) {
  bad(`fatal: ${e?.message ?? e}`);
} finally {
  cleanup();
}

console.log(`\n=== e2e result: ${pass} passed, ${fail} failed ===\n`);
// Give sockets a moment to close, then exit with status.
setTimeout(() => process.exit(fail === 0 ? 0 : 1), 500);

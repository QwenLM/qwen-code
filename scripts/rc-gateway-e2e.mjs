/**
 * Throwaway manual e2e for @qwen-code/rc-gateway against a REAL `qwen serve`.
 * Spawns the repo CLI daemon on loopback, stands up the gateway in front of it,
 * and exercises pairing -> scoped token -> authenticated, scope-gated proxy.
 * Not part of the test suite; run with: node scripts/rc-gateway-e2e.mjs
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  statSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DaemonClient } from '@qwen-code/sdk';
import {
  createGatewayApp,
  SessionEventPump,
  TokenStore,
  PairingService,
  VapidStore,
  PushStore,
  SnoozeStore,
  SESSION_READ,
  APPROVE,
  WRITE,
  OWNER,
  BRIDGE,
  resolveForkChatsDir,
} from '../packages/rc-gateway/dist/index.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cli = join(repoRoot, 'packages/cli/dist/index.js');
const DAEMON_PORT = 4199;
const GATEWAY_PORT = 4198;
const token = randomBytes(32).toString('base64url');
const workspace = mkdtempSync(join(tmpdir(), 'rc-e2e-ws-'));
// Fixture command file lives inside the daemon's (tmpdir) workspace so the
// gateway's on-demand loader picks it up from <workspaceCwd>/.qwen/commands.
const cmdDir = join(workspace, '.qwen', 'commands');
const cmdFile = join(cmdDir, 'echo.md');

// Session-fork (cycle 21) transcript files written under the REAL
// ~/.qwen/.../chats dir (outside the repo) — tracked here so the finally
// block removes them and never pollutes the user's real sessions.
const forkArtifacts = [];

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
let pump;
const sidecarProcs = [];
const cleanup = async () => {
  for (const p of sidecarProcs) {
    try {
      p.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  try {
    if (pump) await pump.stop();
  } catch {
    /* ignore */
  }
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
  // Remove the slash-command fixture so the (tmpdir) workspace is left clean.
  try {
    rmSync(cmdFile, { force: true });
  } catch {
    /* ignore */
  }
  // Remove the fork transcript files written under the real ~/.qwen chats dir.
  for (const f of forkArtifacts) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* ignore */
    }
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
  ok(
    'real qwen serve boots with --hostname/--port/--require-auth and is healthy',
  );

  // Gateway in front of the real daemon.
  const store = await TokenStore.open(join(workspace, 'tokens.json'));
  const pairing = new PairingService();
  const vapid = await VapidStore.open(join(workspace, 'vapid.json'));
  const pushStore = await PushStore.open(join(workspace, 'push.json'));
  const snooze = await SnoozeStore.open(join(workspace, 'snooze.state'));
  const { app, notifier } = createGatewayApp({
    daemon: dc,
    store,
    pairing,
    vapid,
    pushStore,
    snooze,
  });
  gatewayServer = await new Promise((res) => {
    const s = app.listen(GATEWAY_PORT, '127.0.0.1', () => res(s));
  });
  const gw = `http://127.0.0.1:${GATEWAY_PORT}`;

  // 2. Gateway health.
  {
    const r = await fetch(`${gw}/rc/health`);
    r.status === 200
      ? ok('gateway /rc/health 200')
      : bad(`gateway health ${r.status}`);
  }

  // 2b. Session event pump (cycle 10): starts cleanly against the REAL daemon
  //     (capabilities + empty session list resolve; no exception), and the
  //     gateway stays healthy after it boots. No event is asserted — auto-push
  //     delivery is verified-locally-only.
  {
    try {
      pump = new SessionEventPump(dc, notifier);
      await pump.start();
      const r = await fetch(`${gw}/rc/health`);
      r.status === 200
        ? ok('session event pump started cleanly; gateway still healthy')
        : bad(`gateway unhealthy after pump start (${r.status})`);
    } catch (e) {
      bad(`pump start threw: ${e?.message ?? e}`);
    }
  }

  // 2c. Sidecar process-split (add-*-bridge "Bridge process configuration"):
  //     the standalone `qwen-rc-bridge <kind>` entrypoint reads env-only config,
  //     fails fast on a missing required var, and talks the gateway ONLY over the
  //     loopback contract with its operator bridge token. Exercised by spawning
  //     the real built entrypoint against this gateway.
  {
    const sidecar = join(repoRoot, 'packages/rc-gateway/dist/bridge-sidecar.js');

    // Spawn the entrypoint, capturing combined stdout+stderr.
    const spawnSidecar = (args, env) => {
      const proc = spawn(process.execPath, [sidecar, ...args], {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      sidecarProcs.push(proc);
      let out = '';
      proc.stdout.on('data', (d) => (out += d.toString()));
      proc.stderr.on('data', (d) => (out += d.toString()));
      return { proc, output: () => out };
    };

    // (A) Fail-fast: missing TELEGRAM_BOT_TOKEN -> exit 1 + exact stderr.
    {
      const { proc, output } = spawnSidecar(['telegram'], {
        TELEGRAM_BOT_TOKEN: '',
        QWEN_DAEMON_URL: gw,
        QWEN_BRIDGE_TOKEN: 'qwk_whatever',
        QWEN_BRIDGE_PAIRING_CODE: '',
      });
      const exitCode = await new Promise((res) => proc.on('exit', res));
      exitCode === 1 && output().includes('TELEGRAM_BOT_TOKEN is required')
        ? ok('sidecar fails fast on missing bot token (exit 1, exact message)')
        : bad(`sidecar fail-fast exit=${exitCode} out=${output().trim()}`);
    }

    // (B) Loopback contract + pairing-code bootstrap: the sidecar redeems a
    //     one-time PAIRING CODE (real POST /rc/pair/redeem), persists the token
    //     at mode 0600, and registers over the daemon HTTP contract. Passing a
    //     code (not a pre-redeemed token) exercises the real fetch redeem +
    //     writeToken(0600) path. We poll the owner bridge list until it shows.
    {
      const { code: oc } = pairing.mint([OWNER]);
      const orr = await fetch(`${gw}/rc/pair/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: oc, label: 'sidecar-owner' }),
      });
      const ownerTok = (await orr.json()).token;
      const { code: pairingCode } = pairing.mint([BRIDGE]);
      const stateDir = mkdtempSync(join(tmpdir(), 'rc-e2e-sidecar-'));

      spawnSidecar(['telegram'], {
        TELEGRAM_BOT_TOKEN: 'fake-bot-token',
        QWEN_DAEMON_URL: gw,
        QWEN_BRIDGE_TOKEN: '',
        QWEN_BRIDGE_PAIRING_CODE: pairingCode,
        QWEN_BRIDGE_STATE_DIR: stateDir,
      });

      try {
        await poll(
          async () => {
            const r = await fetch(`${gw}/rc/bridges`, {
              headers: { Authorization: `Bearer ${ownerTok}` },
            });
            if (r.status !== 200) return false;
            const { bridges } = await r.json();
            return (
              Array.isArray(bridges) &&
              bridges.some((b) => b.id === 'telegram')
            );
          },
          10000,
          'sidecar bridge registration',
        );
        ok('sidecar redeems a pairing code and registers over the loopback contract');
        const mode = statSync(join(stateDir, 'token')).mode & 0o777;
        mode === 0o600
          ? ok('sidecar persists the redeemed token at mode 0600')
          : bad(`persisted token mode ${mode.toString(8)} (want 600)`);
      } catch {
        bad('sidecar did not register within 10s');
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    }
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
    r.status === 401
      ? ok('events without token -> 401')
      : bad(`no-token ${r.status}`);
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
    r.status === 403
      ? ok('events with no-scope token -> 403')
      : bad(`no-scope ${r.status}`);
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
        ? ok(
            `scoped proxy reached real daemon (status ${r.status} for unknown session)`,
          )
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
  // The push service worker is served at /ui/sw.js (public static asset).
  {
    const r = await fetch(`${gw}/ui/sw.js`);
    r.status === 200
      ? ok('service worker served at /ui/sw.js')
      : bad(`/ui/sw.js returned ${r.status}`);
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

    // Per-subscription prefs (cycle 16): PATCH the prefs, then confirm GET
    // reflects them. Pure gateway state on our own subscription record.
    const ppr = await fetch(`${gw}/rc/push/subscriptions/${subId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({ prefs: ['task.completed'] }),
    });
    const ppb = await ppr.json();
    ppr.status === 200 &&
    Array.isArray(ppb.prefs) &&
    ppb.prefs.length === 1 &&
    ppb.prefs[0] === 'task.completed'
      ? ok('push PATCH prefs -> 200 with prefs:[task.completed]')
      : bad(`push patch prefs ${ppr.status} ${JSON.stringify(ppb)}`);

    const plr = await fetch(`${gw}/rc/push/subscriptions`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    const plb = await plr.json();
    plr.status === 200 &&
    Array.isArray(plb.subscriptions) &&
    plb.subscriptions.some(
      (s) =>
        s.id === subId &&
        Array.isArray(s.prefs) &&
        s.prefs[0] === 'task.completed',
    )
      ? ok('push subscriptions list reflects updated prefs')
      : bad(`push list prefs ${plr.status} ${JSON.stringify(plb)}`);

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

  // Routing snooze (cycle 15): owner-gated POST/GET/DELETE /rc/routing/snooze.
  // Pure gateway state (no daemon involvement).
  {
    const { code: sc } = pairing.mint([SESSION_READ, OWNER]);
    const srr = await fetch(`${gw}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: sc, label: 'snooze-owner' }),
    });
    const snoozeOwnerToken = (await srr.json()).token;

    const pr = await fetch(`${gw}/rc/routing/snooze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${snoozeOwnerToken}`,
      },
      body: JSON.stringify({ durationSec: 1 }),
    });
    const pb = await pr.json();
    pr.status === 200 && pb.scope === 'all' && typeof pb.until === 'number'
      ? ok('routing snooze POST -> 200 {until,scope:all}')
      : bad(`routing snooze POST ${pr.status} ${JSON.stringify(pb)}`);

    const gr = await fetch(`${gw}/rc/routing/snooze`, {
      headers: { Authorization: `Bearer ${snoozeOwnerToken}` },
    });
    const gb = await gr.json();
    gr.status === 200 && gb.active === true
      ? ok('routing snooze GET -> active:true')
      : bad(`routing snooze GET ${gr.status} ${JSON.stringify(gb)}`);

    const drr = await fetch(`${gw}/rc/routing/snooze`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${snoozeOwnerToken}` },
    });
    drr.status === 204
      ? ok('routing snooze DELETE -> 204')
      : bad(`routing snooze DELETE ${drr.status}`);

    // A non-owner (session:read-only) token is rejected at the owner gate.
    const nsr = await fetch(`${gw}/rc/routing/snooze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({ durationSec: 1 }),
    });
    nsr.status === 403
      ? ok('routing snooze POST as non-owner -> 403')
      : bad(`routing snooze non-owner ${nsr.status}`);
  }

  // Link-share core (cycle 18): owner mints a session-locked, TTL-bounded share
  // token for a bogus session, lists it, proves the lock 403s a different
  // session, then revokes it. Pure gateway state (no daemon involvement).
  {
    const { code: shc } = pairing.mint([SESSION_READ, OWNER]);
    const shrr = await fetch(`${gw}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: shc, label: 'share-owner' }),
    });
    const shareOwnerToken = (await shrr.json()).token;

    const mr = await fetch(`${gw}/rc/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${shareOwnerToken}`,
      },
      body: JSON.stringify({ sessionId: 'share-sess', ttlSec: 3600 }),
    });
    const mb = await mr.json();
    mr.status === 201 &&
    typeof mb.id === 'string' &&
    typeof mb.token === 'string' &&
    mb.url === '/ui/share/' + mb.token &&
    typeof mb.expiresAt === 'number'
      ? ok('share mint -> 201 {id,token,url,expiresAt}')
      : bad(`share mint ${mr.status} ${JSON.stringify(mb)}`);

    const lr = await fetch(`${gw}/rc/share`, {
      headers: { Authorization: `Bearer ${shareOwnerToken}` },
    });
    const lb = await lr.json();
    lr.status === 200 &&
    Array.isArray(lb.shares) &&
    lb.shares.some((s) => s.id === mb.id && s.sessionLockId === 'share-sess')
      ? ok('share list includes the minted share')
      : bad(`share list ${lr.status} ${JSON.stringify(lb)}`);

    // The share token on a DIFFERENT session -> 403 session_locked.
    const wr = await fetch(`${gw}/rc/session/some-other-session/events`, {
      headers: { Authorization: `Bearer ${mb.token}` },
    });
    const wb = await wr.json().catch(() => ({}));
    wr.status === 403 && wb.code === 'session_locked'
      ? ok('share token on a different session -> 403 session_locked')
      : bad(`share wrong-session ${wr.status} ${JSON.stringify(wb)}`);

    const dr = await fetch(`${gw}/rc/share/${mb.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${shareOwnerToken}` },
    });
    dr.status === 204
      ? ok('share revoke -> 204')
      : bad(`share revoke ${dr.status}`);
  }

  // Cross-session search core (cycle 19): owner-gated GET /rc/search. A pure
  // gateway read over the daemon's on-disk JSONL transcripts. For the e2e
  // workspace there are likely no matching transcripts, so hits is an array
  // (typically empty); the contract under test is 200 + a hits array, owner-only.
  {
    const { code: sec } = pairing.mint([SESSION_READ, OWNER]);
    const serr = await fetch(`${gw}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: sec, label: 'search-owner' }),
    });
    const searchOwnerToken = (await serr.json()).token;

    const sr = await fetch(`${gw}/rc/search?q=test`, {
      headers: { Authorization: `Bearer ${searchOwnerToken}` },
    });
    const sb = await sr.json().catch(() => ({}));
    sr.status === 200 && Array.isArray(sb.hits)
      ? ok(`search GET -> 200 with hits array (len=${sb.hits.length})`)
      : bad(`search GET ${sr.status} ${JSON.stringify(sb)}`);

    // A non-owner (session:read-only) token is rejected at the owner gate.
    const nsr = await fetch(`${gw}/rc/search?q=test`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    nsr.status === 403
      ? ok('search GET as non-owner -> 403')
      : bad(`search non-owner ${nsr.status}`);
  }

  // Custom slash commands (cycle 20): drop a valid workspace command into the
  // real daemon's <workspaceCwd>/.qwen/commands, then GET /rc/commands picks it
  // up on-demand. invoke of an unknown command 404s; no-token GET 401s.
  {
    mkdirSync(cmdDir, { recursive: true });
    writeFileSync(
      cmdFile,
      '---\nname: echo\ndescription: echo the args\nscope: write\n---\nEcho: ${args}\n',
    );

    // GET with the owner token -> 200 {v:1, commands:[...]} containing echo
    // with invocableByYou:true (owner mint below includes WRITE).
    const { code: cc } = pairing.mint([SESSION_READ, WRITE]);
    const crr = await fetch(`${gw}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: cc, label: 'cmd-writer' }),
    });
    const cmdToken = (await crr.json()).token;

    const lr = await fetch(`${gw}/rc/commands`, {
      headers: { Authorization: `Bearer ${cmdToken}` },
    });
    const lb = await lr.json().catch(() => ({}));
    const echo = Array.isArray(lb.commands)
      ? lb.commands.find((c) => c.name === 'echo')
      : undefined;
    lr.status === 200 && lb.v === 1 && echo && echo.invocableByYou === true
      ? ok('GET /rc/commands -> 200 {v:1} with fixture echo invocableByYou:true')
      : bad(`commands list ${lr.status} ${JSON.stringify(lb)}`);

    // Invoke an unknown command on a bogus session -> 404 unknown_command
    // (the 404 short-circuits before the daemon is touched).
    const ir = await fetch(`${gw}/rc/session/does-not-exist/command/nope`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cmdToken}`,
      },
      body: JSON.stringify({}),
    });
    const ib = await ir.json().catch(() => ({}));
    ir.status === 404 && ib.code === 'unknown_command'
      ? ok('invoke unknown command -> 404 unknown_command')
      : bad(`invoke unknown ${ir.status} ${JSON.stringify(ib)}`);

    // GET /rc/commands without a token -> 401.
    const nr = await fetch(`${gw}/rc/commands`);
    nr.status === 401
      ? ok('GET /rc/commands without token -> 401')
      : bad(`commands no-token ${nr.status}`);
  }

  // Session forking (cycle 21): THE drift detector. Write a real parent
  // transcript into the REAL daemon's derived chats dir, POST the fork, then
  // assert the fork (a) responds 200, (b) has a JSONL on disk, and — the
  // make-or-break signal — (c) APPEARS in listWorkspaceSessions, which proves
  // the real daemon restored our gateway-written file by path (loadSession
  // resolves purely by path; a 502 here would mean loadSession rejected the
  // fabricated record; a 404 would mean the chats-dir derivation diverged).
  {
    // Single source of truth: derive the chats dir from the daemon's REPORTED
    // workspaceCwd (it may realpath/normalize the --workspace arg), and use the
    // SAME string for the fabricated record's cwd so loadSession's ownership
    // re-check passes.
    const caps = await dc.capabilities();
    const wsCwd = caps.workspaceCwd;
    const chatsDir = resolveForkChatsDir(wsCwd);
    mkdirSync(chatsDir, { recursive: true });

    const parentId = randomUUID();
    const parentPath = join(chatsDir, `${parentId}.jsonl`);
    forkArtifacts.push(parentPath);
    const parentRecord = {
      uuid: randomUUID(),
      parentUuid: null,
      sessionId: parentId,
      timestamp: new Date().toISOString(),
      type: 'user',
      cwd: wsCwd,
      version: '0.0.0',
      message: { role: 'user', parts: [{ text: 'hello from e2e parent' }] },
    };
    writeFileSync(parentPath, JSON.stringify(parentRecord) + '\n', {
      mode: 0o600,
    });

    // A write-scoped token forks.
    const { code: fc } = pairing.mint([SESSION_READ, WRITE]);
    const frr = await fetch(`${gw}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: fc, label: 'forker' }),
    });
    const forkToken = (await frr.json()).token;

    const fr = await fetch(`${gw}/rc/session/${parentId}/fork`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${forkToken}`,
      },
      body: JSON.stringify({}),
    });
    const fb = await fr.json().catch(() => ({}));
    let newId;
    if (
      fr.status === 200 &&
      typeof fb.sessionId === 'string' &&
      fb.parentSessionId === parentId &&
      typeof fb.forkedAt === 'string'
    ) {
      newId = fb.sessionId;
      forkArtifacts.push(join(chatsDir, `${newId}.jsonl`));
      ok(`fork POST -> 200 {sessionId, parentSessionId, forkedAt}`);
    } else {
      bad(
        `fork POST ${fr.status} ${JSON.stringify(fb)} ` +
          `(502 = loadSession rejected the fabricated record; ` +
          `404 = chats-dir derivation diverged = DRIFT DETECTOR FIRING)`,
      );
    }

    // (b) The fork's JSONL exists on disk.
    if (newId) {
      existsSync(join(chatsDir, `${newId}.jsonl`))
        ? ok('fork JSONL written to the derived chats dir')
        : bad('fork JSONL missing on disk');
    }

    // (c) THE make-or-break signal: the fork appears in listWorkspaceSessions,
    //     proving the real daemon restored our gateway-written file by path.
    if (newId) {
      try {
        const summaries = await dc.listWorkspaceSessions(wsCwd);
        summaries.some((s) => s.sessionId === newId)
          ? ok(
              'RESTORE-BY-PATH: fork appears in listWorkspaceSessions ' +
                '(real daemon restored our gateway-written file)',
            )
          : bad(
              'RESTORE-BY-PATH FAILED: fork NOT in listWorkspaceSessions ' +
                `(restored ids: ${JSON.stringify(summaries.map((s) => s.sessionId))})`,
            );
      } catch (e) {
        bad(`listWorkspaceSessions threw: ${e?.message ?? e}`);
      }
    }

    // (d) Lineage (cycle 47): an OWNER token walks the fork's chain to root.
    //     Reuses the REAL parent+fork on disk above; chain = [fork, parent].
    if (newId) {
      const { code: lc } = pairing.mint([SESSION_READ, OWNER]);
      const lrr = await fetch(`${gw}/rc/pair/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: lc, label: 'lineage-owner' }),
      });
      const lineageToken = (await lrr.json()).token;

      const lr = await fetch(`${gw}/rc/session/${newId}/lineage`, {
        headers: { Authorization: `Bearer ${lineageToken}` },
      });
      const lb = await lr.json().catch(() => ({}));
      lr.status === 200 &&
      lb.sessionId === newId &&
      Array.isArray(lb.chain) &&
      lb.chain.length === 2 &&
      lb.chain[0]?.sessionId === newId &&
      lb.chain[1]?.sessionId === parentId &&
      lb.truncated === false
        ? ok('lineage GET -> 200 chain [fork, parent] to root')
        : bad(`lineage GET ${lr.status} ${JSON.stringify(lb)}`);

      // A WRITE-but-not-OWNER token is 403 (topology is owner-only).
      const nr = await fetch(`${gw}/rc/session/${newId}/lineage`, {
        headers: { Authorization: `Bearer ${forkToken}` },
      });
      nr.status === 403
        ? ok('lineage GET as non-owner -> 403')
        : bad(`lineage non-owner expected 403, got ${nr.status}`);

      // Session listing (cycle 50): an OWNER token GETs /rc/sessions; the flat
      // list (over the REAL on-disk chats dir, which holds other sessions too)
      // must contain the parent with forks=[fork] AND the fork with
      // parentSessionId=parent. Tolerant: match specific ids, never a length.
      const slr = await fetch(`${gw}/rc/sessions`, {
        headers: { Authorization: `Bearer ${lineageToken}` },
      });
      const slb = await slr.json().catch(() => ({}));
      const items = Array.isArray(slb.sessions) ? slb.sessions : [];
      const parentItem = items.find((s) => s.sessionId === parentId);
      const forkItem = items.find((s) => s.sessionId === newId);
      slr.status === 200 &&
      parentItem &&
      Array.isArray(parentItem.forks) &&
      parentItem.forks.includes(newId) &&
      forkItem &&
      forkItem.parentSessionId === parentId
        ? ok('sessions GET -> 200 parent has forks=[fork], fork points to parent')
        : bad(
            `sessions GET ${slr.status} parent=${JSON.stringify(parentItem)} ` +
              `fork=${JSON.stringify(forkItem)}`,
          );

      // A WRITE-but-not-OWNER token is 403 (topology is owner-only).
      const nsl = await fetch(`${gw}/rc/sessions`, {
        headers: { Authorization: `Bearer ${forkToken}` },
      });
      nsl.status === 403
        ? ok('sessions GET as non-owner -> 403')
        : bad(`sessions non-owner expected 403, got ${nsl.status}`);
    }

    // Owner event stream (cycle 49): an OWNER token opens GET /rc/events; an
    // audited action (minting a token) must arrive LIVE as a data frame. Uses
    // the raw http client (node fetch batches SSE chunks until close). Bounded
    // by a hard timeout so it can never hang the suite.
    {
      const { code: ec } = pairing.mint([SESSION_READ, OWNER]);
      const err_ = await fetch(`${gw}/rc/pair/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: ec, label: 'events-owner' }),
      });
      const eventsToken = (await err_.json()).token;
      const u = new URL(`${gw}/rc/events`);

      const result = await new Promise((resolve) => {
        let settled = false;
        const done = (v) => {
          if (!settled) {
            settled = true;
            resolve(v);
          }
        };
        const req = http.get(
          {
            hostname: u.hostname,
            port: u.port,
            path: u.pathname,
            headers: { Authorization: `Bearer ${eventsToken}` },
          },
          (res) => {
            if (res.statusCode !== 200) {
              done({ ok: false, why: `status ${res.statusCode}` });
              return;
            }
            res.setEncoding('utf8');
            let buf = '';
            let acted = false;
            res.on('data', (chunk) => {
              buf += chunk;
              if (!acted && buf.includes(': ok')) {
                acted = true;
                // Mint a token via the owner API -> audits token_minted.
                fetch(`${gw}/rc/tokens`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${eventsToken}`,
                  },
                  body: JSON.stringify({ scopes: ['session:read'] }),
                }).catch(() => {});
              }
              if (
                buf
                  .split('\n')
                  .some(
                    (l) => l.startsWith('data: ') && l.includes('token_minted'),
                  )
              ) {
                req.destroy();
                done({ ok: true });
              }
            });
          },
        );
        req.on('error', (e) => done({ ok: false, why: e.message }));
        setTimeout(() => {
          req.destroy();
          done({ ok: false, why: 'timeout' });
        }, 5000);
      });
      result.ok
        ? ok('owner event stream -> live token_minted frame')
        : bad(`owner event stream: ${result.why}`);

      // A non-owner (session:read) token is rejected at the OWNER gate.
      const nr = await fetch(`${gw}/rc/events`, {
        headers: { Authorization: `Bearer ${forkToken}` },
      });
      nr.status === 403
        ? ok('owner event stream as non-owner -> 403')
        : bad(`owner events non-owner expected 403, got ${nr.status}`);
    }

    // Error case: forking an unknown parent -> 404 parent_transcript_not_found.
    {
      const ur = await fetch(`${gw}/rc/session/${randomUUID()}/fork`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${forkToken}`,
        },
        body: JSON.stringify({}),
      });
      const ub = await ur.json().catch(() => ({}));
      ur.status === 404 && ub.code === 'parent_transcript_not_found'
        ? ok('fork unknown parent -> 404 parent_transcript_not_found')
        : bad(`fork unknown parent ${ur.status} ${JSON.stringify(ub)}`);
    }

    // Named fork (cycle 86): POST {name} appends a core-faithful custom_title
    // record. Assert against the REAL daemon that (a) the fork still restores by
    // path (loadSession accepted the appended record — a malformed one would be
    // a clean 502), and (b) the name surfaces via /rc/sessions' tail reader (the
    // write-half counterpart to cycle 85's read half). Then fork the NAMED fork
    // with a new name and assert most-recent-wins over the inherited title.
    {
      const { code: nc } = pairing.mint([SESSION_READ, OWNER]);
      const nrr = await fetch(`${gw}/rc/pair/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: nc, label: 'named-owner' }),
      });
      const ownerToken = (await nrr.json()).token;

      const NAME = 'E2E Named Fork';
      const nf = await fetch(`${gw}/rc/session/${parentId}/fork`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${forkToken}`,
        },
        body: JSON.stringify({ name: `  ${NAME}  ` }),
      });
      const nfb = await nf.json().catch(() => ({}));
      let namedId;
      if (nf.status === 200 && typeof nfb.sessionId === 'string') {
        namedId = nfb.sessionId;
        forkArtifacts.push(join(chatsDir, `${namedId}.jsonl`));
        ok('named fork POST -> 200');
      } else {
        bad(`named fork POST ${nf.status} ${JSON.stringify(nfb)}`);
      }

      // (a) Restores by path against the real daemon.
      if (namedId) {
        try {
          const summaries = await dc.listWorkspaceSessions(wsCwd);
          summaries.some((s) => s.sessionId === namedId)
            ? ok('named fork restored by path (in listWorkspaceSessions)')
            : bad('named fork NOT in listWorkspaceSessions');
        } catch (e) {
          bad(`named fork listWorkspaceSessions threw: ${e?.message ?? e}`);
        }
      }

      // (b) The name surfaces via /rc/sessions' tail reader (cycle 85 oracle).
      if (namedId) {
        const sr = await fetch(`${gw}/rc/sessions`, {
          headers: { Authorization: `Bearer ${ownerToken}` },
        });
        const sb = await sr.json().catch(() => ({}));
        const item = (Array.isArray(sb.sessions) ? sb.sessions : []).find(
          (s) => s.sessionId === namedId,
        );
        sr.status === 200 && item && item.title === NAME
          ? ok(`named fork title surfaces via /rc/sessions ("${NAME}")`)
          : bad(`named fork title ${sr.status} item=${JSON.stringify(item)}`);
      }

      // (c) Fork the NAMED fork (now itself titled) with a different name -> the
      //     new name wins over the inherited custom_title (most-recent-wins).
      if (namedId) {
        const SECOND = 'Renamed Grand Fork';
        const gf = await fetch(`${gw}/rc/session/${namedId}/fork`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${forkToken}`,
          },
          body: JSON.stringify({ name: SECOND }),
        });
        const gfb = await gf.json().catch(() => ({}));
        if (gf.status === 200 && typeof gfb.sessionId === 'string') {
          forkArtifacts.push(join(chatsDir, `${gfb.sessionId}.jsonl`));
          const sr = await fetch(`${gw}/rc/sessions`, {
            headers: { Authorization: `Bearer ${ownerToken}` },
          });
          const sb = await sr.json().catch(() => ({}));
          const item = (Array.isArray(sb.sessions) ? sb.sessions : []).find(
            (s) => s.sessionId === gfb.sessionId,
          );
          item && item.title === SECOND
            ? ok('named fork of a titled parent -> new name wins (most-recent)')
            : bad(`grand fork title item=${JSON.stringify(item)}`);
        } else {
          bad(`grand fork POST ${gf.status} ${JSON.stringify(gfb)}`);
        }
      }
    }

    // Error case: forking without a token -> 401.
    {
      const nr = await fetch(`${gw}/rc/session/${parentId}/fork`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      nr.status === 401
        ? ok('fork without token -> 401')
        : bad(`fork no-token ${nr.status}`);
    }

    // Error case: forking with a session:read-only token -> 403 (WRITE gate).
    {
      const wr = await fetch(`${gw}/rc/session/${parentId}/fork`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({}),
      });
      wr.status === 403
        ? ok('fork with insufficient (session:read) token -> 403')
        : bad(`fork insufficient-scope ${wr.status}`);
    }
  }
} catch (e) {
  bad(`fatal: ${e?.message ?? e}`);
} finally {
  await cleanup();
}

console.log(`\n=== e2e result: ${pass} passed, ${fail} failed ===\n`);
// Give sockets a moment to close, then exit with status.
setTimeout(() => process.exit(fail === 0 ? 0 : 1), 500);

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DaemonClient } from '@qwen-code/sdk';
import { startStubDaemon, type StubDaemon } from './testing/stubDaemon.js';
import { TokenStore } from './tokenStore.js';
import { PairingService } from './pairing.js';
import { VapidStore } from './webpush/vapid.js';
import { PushStore } from './pushStore.js';
import { SnoozeStore } from './routing/snooze.js';
import { createGatewayApp } from './server.js';
import { ApnsStore } from './nativePush/apnsStore.js';
import type { PushNotifier } from './webpush/notifier.js';
import {
  OWNER,
  SESSION_READ,
  APPROVE,
  WRITE,
  SHARE,
  BRIDGE,
} from './scopes.js';

let gateway: Server | undefined;
let stub: StubDaemon | undefined;

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  if (stub) await stub.close();
  gateway = undefined;
  stub = undefined;
});

async function boot(
  stubOpts?: Parameters<typeof startStubDaemon>[0],
  extraDeps?: Partial<Parameters<typeof createGatewayApp>[0]>,
): Promise<{
  url: string;
  pairing: PairingService;
  store: TokenStore;
  auditPath: string;
  vapid: VapidStore;
  pushStore: PushStore;
  notifier: PushNotifier | undefined;
}> {
  stub = await startStubDaemon(stubOpts);
  const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
  const dir = mkdtempSync(join(tmpdir(), 'rc-srv-'));
  const auditPath = join(dir, 'audit.log');
  const store = await TokenStore.open(join(dir, 'tokens.json'));
  const pairing = new PairingService();
  const vapid = await VapidStore.open(join(dir, 'vapid.json'));
  const pushStore = await PushStore.open(join(dir, 'push.json'));
  const snooze = await SnoozeStore.open(join(dir, 'snooze.state'));
  // Isolate the loader's user-commands root from the real ~/.qwen/commands.
  const commandsUserDir = join(dir, 'user-commands');
  const { app, notifier } = createGatewayApp({
    daemon,
    store,
    pairing,
    auditPath,
    vapid,
    pushStore,
    snooze,
    commandsUserDir,
    ...extraDeps,
  }); // `audit` is also returned; boot() does not need it here.
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    pairing,
    store,
    auditPath,
    vapid,
    pushStore,
    notifier,
  };
}

function readAudit(path: string): Array<Record<string, unknown>> {
  // With daily rotation, records land in audit-YYYY-MM-DD.log files in
  // dirname(path). Read all of them (the AuditLog dir = dirname(path)).
  const dir = path.endsWith('.log')
    ? path.slice(0, path.lastIndexOf('/'))
    : path;
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => /^audit-.*\.log$/.test(f))
      .sort();
  } catch {
    return [];
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const name of files) {
    try {
      const body = readFileSync(`${dir}/${name}`, 'utf8').trim();
      if (body)
        rows.push(
          ...body
            .split('\n')
            .map((l) => JSON.parse(l) as Record<string, unknown>),
        );
    } catch {
      // skip unreadable file
    }
  }
  return rows;
}

async function pollAudit(
  path: string,
  predicate: (rows: Array<Record<string, unknown>>) => boolean,
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + 2000;
  let rows = readAudit(path);
  while (!predicate(rows) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    rows = readAudit(path);
  }
  return rows;
}

describe('gateway app', () => {
  it('happy path: redeem a code then stream events', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([SESSION_READ]);
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'phone' }),
    });
    expect(redeem.status).toBe(200);
    const { token, scopes } = (await redeem.json()) as {
      token: string;
      scopes: string[];
    };
    expect(scopes).toEqual([SESSION_READ]);

    const events = await fetch(
      `${url}/session/11111111111111111111111111111111/events`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    expect(events.status).toBe(200);
    const text = await events.text();
    expect(text).toContain('"text":"one"');
  });

  it("PROOF (stale-UI diagnosis): bare /session/:id/events routes; the UI's /rc/session/:id/events 404s", async () => {
    // The shipped public/index.html + sw.js call /rc/session/:id/{events,prompt,
    // permission,...}, but commit 6ae9154d4 (2026-07-09) migrated those routes
    // to the BARE /session/:id/* namespace and the web UI was never updated.
    // This locks the mismatch: authenticated, so a 404 is a *routing* miss (no
    // such route), not an auth rejection — proving the phone UI's per-session
    // calls are dead until repointed. See task #37.
    const { url, pairing } = await boot();
    const { code } = pairing.mint([SESSION_READ]);
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'phone' }),
    });
    const { token } = (await redeem.json()) as { token: string };
    const sid = '11111111111111111111111111111111';
    const auth = { Authorization: `Bearer ${token}` };

    // Bare namespace (server's real mount) → routed, streams.
    const bare = await fetch(`${url}/session/${sid}/events`, { headers: auth });
    expect(bare.status).toBe(200);
    await bare.text(); // drain the SSE body so the socket closes

    // The UI's stale prefix → no such route. 404 (not 401/403) confirms the
    // request got PAST auth and died at routing.
    const prefixed = await fetch(`${url}/rc/session/${sid}/events`, {
      headers: auth,
    });
    expect(prefixed.status).toBe(404);
  });

  it('POST /session (create): a WRITE token creates a session; read-only is denied', async () => {
    // add "New conversation": the gateway now mounts a bare create-session
    // route so a freshly-paired client has a session to drive.
    const { url, pairing } = await boot();

    // A WRITE token creates one (daemon stub returns stub-agent-N).
    const { code: wcode } = pairing.mint([WRITE, SESSION_READ]);
    const wredeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: wcode, label: 'phone' }),
    });
    const { token: wtoken } = (await wredeem.json()) as { token: string };
    const created = await fetch(`${url}/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${wtoken}`,
      },
      body: JSON.stringify({ cwd: '' }),
    });
    expect(created.status).toBe(200);
    const body = (await created.json()) as { sessionId: string };
    expect(body.sessionId).toBeTruthy();

    // A session:read-only token cannot create (WRITE required).
    const { code: rcode } = pairing.mint([SESSION_READ]);
    const rredeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: rcode, label: 'viewer' }),
    });
    const { token: rtoken } = (await rredeem.json()) as { token: string };
    const denied = await fetch(`${url}/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${rtoken}`,
      },
      body: JSON.stringify({}),
    });
    expect(denied.status).toBe(403);
  });

  it('POST /session/:id/resume: a WRITE token resumes via the daemon; read-only is denied', async () => {
    // add-resume-conversations: the gateway mounts a bare resume route so a
    // phone can reactivate a past conversation on its workspace's daemon.
    const dir = mkdtempSync(join(tmpdir(), 'rc-srv-resume-'));
    const { url, pairing } = await boot();

    // A WRITE token resumes (the stub daemon echoes back sessionId + the
    // posted cwd as workspaceCwd).
    const { code: wcode } = pairing.mint([WRITE, SESSION_READ]);
    const wredeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: wcode, label: 'phone' }),
    });
    const { token: wtoken } = (await wredeem.json()) as { token: string };
    const resumed = await fetch(
      `${url}/session/11111111111111111111111111111111/resume`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${wtoken}`,
        },
        body: JSON.stringify({ cwd: dir }),
      },
    );
    expect(resumed.status).toBe(200);
    const body = (await resumed.json()) as {
      sessionId: string;
      workspaceCwd: string;
    };
    expect(body).toMatchObject({
      sessionId: '11111111111111111111111111111111',
      workspaceCwd: dir,
    });
    expect(stub!.lastResumeSessionBody).toMatchObject({ cwd: dir });

    // A session:read-only token cannot resume (WRITE required).
    const { code: rcode } = pairing.mint([SESSION_READ]);
    const rredeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: rcode, label: 'viewer' }),
    });
    const { token: rtoken } = (await rredeem.json()) as { token: string };
    const denied = await fetch(
      `${url}/session/11111111111111111111111111111111/resume`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${rtoken}`,
        },
        body: JSON.stringify({ cwd: dir }),
      },
    );
    expect(denied.status).toBe(403);
  });

  it('a bridge-scope token can stream a session (the bundle includes session:read)', async () => {
    // add-bridge-protocol slice 1: a `bridge` grant expands to the concrete
    // {bridge, session:read, approve, write} bundle, so a bridge can subscribe
    // to the very stream it bridges — 200, not 403.
    const { url, pairing } = await boot();
    const { code } = pairing.mint([BRIDGE]);
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'tg-bridge' }),
    });
    expect(redeem.status).toBe(200);
    const { token, scopes } = (await redeem.json()) as {
      token: string;
      scopes: string[];
    };
    expect([...scopes].sort()).toEqual(
      [BRIDGE, SESSION_READ, APPROVE, WRITE].sort(),
    );
    const events = await fetch(
      `${url}/session/11111111111111111111111111111111/events`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    expect(events.status).toBe(200); // session:read satisfied by the bundle
  });

  it('rejects an invalid pairing code with 400', async () => {
    const { url } = await boot();
    const res = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'bogus', label: 'x' }),
    });
    expect(res.status).toBe(400);
  });

  it('401s the events route without a token', async () => {
    const { url } = await boot();
    const res = await fetch(
      `${url}/session/11111111111111111111111111111111/events`,
    );
    expect(res.status).toBe(401);
  });

  it('403s when the token lacks session:read', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([]); // grant no scopes
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'weak' }),
    });
    const { token } = (await redeem.json()) as { token: string };
    const res = await fetch(
      `${url}/session/11111111111111111111111111111111/events`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    expect(res.status).toBe(403);
  });

  it('revoking a token evicts its open SSE stream', async () => {
    const { url, pairing } = await boot({ holdOpenMs: 5000 });

    const ownerCode = pairing.mint([OWNER, SESSION_READ]);
    const ownerRedeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: ownerCode.code, label: 'owner' }),
    });
    const ownerToken = ((await ownerRedeem.json()) as { token: string }).token;

    const victimCode = pairing.mint([SESSION_READ]);
    const victimRedeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: victimCode.code, label: 'victim' }),
    });
    const victim = (await victimRedeem.json()) as { id: string; token: string };

    const ac = new AbortController();
    const stream = await fetch(
      `${url}/session/11111111111111111111111111111111/events`,
      {
        headers: { Authorization: `Bearer ${victim.token}` },
        signal: ac.signal,
      },
    );
    await stream.body!.getReader().read();

    const del = await fetch(`${url}/rc/tokens/${victim.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(del.status).toBe(204);

    const deadline = Date.now() + 5000;
    while (!stub!.eventsAbortedByClient && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(stub!.eventsAbortedByClient).toBe(true);
    ac.abort();
  });

  it('writes audit lines for redeem and a bad-token request', async () => {
    const { url, pairing, auditPath } = await boot();
    const { code } = pairing.mint([OWNER, SESSION_READ]);
    await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'owner' }),
    });
    await fetch(`${url}/session/11111111111111111111111111111111/events`, {
      headers: { Authorization: 'Bearer not-a-token' },
    });

    const rows = await pollAudit(
      auditPath,
      (r) =>
        r.some((x) => x.action === 'pairing_redeemed') &&
        r.some((x) => x.action === 'auth_failed'),
    );
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('pairing_redeemed');
    expect(actions).toContain('auth_failed');
    // Read all daily audit files from the audit dir (daily rotation).
    const auditDir = auditPath.slice(0, auditPath.lastIndexOf('/'));
    const auditText = readdirSync(auditDir)
      .filter((f) => /^audit-.*\.log$/.test(f))
      .map((f) => readFileSync(`${auditDir}/${f}`, 'utf8'))
      .join('');
    expect(auditText).not.toContain('not-a-token');
    // Structural no-secret guarantee: no bearer material ever lands in audit.
    expect(auditText).not.toContain('Bearer');
  });

  it('serves owner GET /rc/audit with recorded events', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([OWNER, SESSION_READ]);
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'owner' }),
    });
    const ownerToken = ((await redeem.json()) as { token: string }).token;

    const res = await fetch(`${url}/rc/audit`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ action: string }>;
    expect(rows.some((r) => r.action === 'pairing_redeemed')).toBe(true);
  });

  it('owner GET /rc/search?q=x returns 200 with a hits array (no transcripts → [])', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([OWNER, SESSION_READ]);
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'owner' }),
    });
    const ownerToken = ((await redeem.json()) as { token: string }).token;

    const res = await fetch(`${url}/rc/search?q=x`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: unknown[] };
    expect(Array.isArray(body.hits)).toBe(true);
    expect(body.hits).toHaveLength(0);
  });

  it('403s GET /rc/search for a non-owner token', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([SESSION_READ]); // no owner
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'reader' }),
    });
    const token = ((await redeem.json()) as { token: string }).token;

    const res = await fetch(`${url}/rc/search?q=x`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it('a session-locked share token can GET /rc/search (200, confined to its session)', async () => {
    const { url, store, auditPath } = await boot();
    const share = await store.issueShare({
      scopes: [SHARE, SESSION_READ],
      label: 'guest',
      sessionLockId: 'locked-sess',
      ttlSec: 3600,
      parentId: 'owner',
    });
    // The mount (SESSION_READ) admits the share; the in-handler authz confines
    // it to its locked session (no transcripts → empty hits, but 200 not 403).
    const res = await fetch(`${url}/rc/search?q=x&sessionId=someone-else`, {
      headers: { Authorization: `Bearer ${share.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: unknown[] };
    expect(Array.isArray(body.hits)).toBe(true);
    // The guest search row is share-attributable (cycle 31 / L4).
    const rows = await pollAudit(auditPath, (r) =>
      r.some((x) => x.action === 'search_performed'),
    );
    const a = rows.find((x) => x.action === 'search_performed');
    expect(a).toBeDefined();
    expect(a!.shareId).toBe(share.id);
    expect(a!.shareLabel).toBe('guest');
  });

  it('400s GET /rc/search with a missing q for an owner token', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([OWNER, SESSION_READ]);
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'owner' }),
    });
    const ownerToken = ((await redeem.json()) as { token: string }).token;

    const res = await fetch(`${url}/rc/search`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('invalid_query');
  });

  it('createGatewayApp returns a notifier when push stores are supplied', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const dir = mkdtempSync(join(tmpdir(), 'rc-srv-'));
    const store = await TokenStore.open(join(dir, 'tokens.json'));
    const pairing = new PairingService();
    const vapid = await VapidStore.open(join(dir, 'vapid.json'));
    const pushStore = await PushStore.open(join(dir, 'push.json'));

    const withStores = createGatewayApp({
      daemon,
      store,
      pairing,
      vapid,
      pushStore,
    });
    expect(withStores.notifier).toBeDefined();

    const withoutStores = createGatewayApp({ daemon, store, pairing });
    expect(withoutStores.notifier).toBeUndefined();

    // The opt-in coalescing window is accepted and still yields a notifier
    // (cycle 63; default 0 = disabled, so the unset case above is the no-op path).
    const withCoalesce = createGatewayApp({
      daemon,
      store,
      pairing,
      vapid,
      pushStore,
      coalesceWindowMs: 5000,
    });
    expect(withCoalesce.notifier).toBeDefined();
  });

  it('GET /rc/push/digest returns {digests:[]} for owner, 403 for non-owner (cycle 71)', async () => {
    const { url, pairing } = await boot();
    const owner = pairing.mint([OWNER, SESSION_READ]);
    const ownerToken = await (
      await fetch(`${url}/rc/pair/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: owner.code, label: 'owner' }),
      })
    ).json();
    const dr = await fetch(`${url}/rc/push/digest`, {
      headers: { Authorization: `Bearer ${ownerToken.token}` },
    });
    expect(dr.status).toBe(200);
    expect(await dr.json()).toEqual({ digests: [] });

    const reader = pairing.mint([SESSION_READ]);
    const readerToken = await (
      await fetch(`${url}/rc/pair/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: reader.code, label: 'reader' }),
      })
    ).json();
    const dr2 = await fetch(`${url}/rc/push/digest`, {
      headers: { Authorization: `Bearer ${readerToken.token}` },
    });
    expect(dr2.status).toBe(403);
  });

  it('createGatewayApp returns the audit instance', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const dir = mkdtempSync(join(tmpdir(), 'rc-srv-'));
    const store = await TokenStore.open(join(dir, 'tokens.json'));
    const pairing = new PairingService();

    const built = createGatewayApp({ daemon, store, pairing });
    expect(built.audit).toBeDefined();
    expect(typeof built.audit.record).toBe('function');
  });

  it('serves the web viewer at /ui/ without auth', async () => {
    const { url } = await boot();
    const res = await fetch(`${url}/ui/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('qwen-rc viewer');
  });

  it('serves the push service worker at /ui/sw.js without auth', async () => {
    const { url } = await boot();
    const res = await fetch(`${url}/ui/sw.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
  });

  it('serves the enrollment UI at /ui/index.html', async () => {
    const { url } = await boot();
    const res = await fetch(`${url}/ui/index.html`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('id="enable"');
    expect(body).toContain('sw.js');
  });

  it('404s unknown /ui assets', async () => {
    const { url } = await boot();
    const res = await fetch(`${url}/ui/does-not-exist.js`);
    expect(res.status).toBe(404);
  });

  it('serves the share bootstrap page at /ui/share/<token> (dumb sendFile)', async () => {
    const { url } = await boot();
    const res = await fetch(`${url}/ui/share/any-token-value`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('qwen-rc shared session');
  });

  it('serves the share page at /ui/share too (reload after URL scrub)', async () => {
    const { url } = await boot();
    const res = await fetch(`${url}/ui/share`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('qwen-rc shared session');
  });

  it('the share route does not shadow other /ui static assets', async () => {
    const { url } = await boot();
    const res = await fetch(`${url}/ui/sw.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
  });

  it('routes an approve-scoped permission vote to the daemon', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([SESSION_READ, OWNER, APPROVE]);
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'owner' }),
    });
    const ownerToken = ((await redeem.json()) as { token: string }).token;

    const mint = await fetch(`${url}/rc/tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        scopes: [SESSION_READ, APPROVE],
        label: 'approver',
      }),
    });
    expect(mint.status).toBe(200);
    const approveToken = ((await mint.json()) as { token: string }).token;

    const vote = await fetch(`${url}/session/sess-1/permission/req-1`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${approveToken}`,
      },
      body: JSON.stringify({ outcome: 'cancelled' }),
    });
    expect(vote.status).toBe(200);
  });

  it('lets an APPROVE-scoped share vote on its locked session, 403s another (cycle 80 spine)', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([SESSION_READ, OWNER]);
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'owner' }),
    });
    const ownerToken = ((await redeem.json()) as { token: string }).token;

    // Owner mints an APPROVE-scoped share locked to sess-1.
    const mint = await fetch(`${url}/rc/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        sessionId: 'sess-1',
        ttlSec: 3600,
        scope: 'approve',
      }),
    });
    expect(mint.status).toBe(201);
    const share = (await mint.json()) as { token: string };

    // Votes on its locked session → passes requireScope(APPROVE)+enforceSessionLock
    // and reaches the daemon (stub answers 200).
    const ok = await fetch(`${url}/session/sess-1/permission/req-1`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${share.token}`,
      },
      body: JSON.stringify({ outcome: 'cancelled' }),
    });
    expect(ok.status).toBe(200);

    // Votes on a DIFFERENT session → 403 session_locked (the lock backstop).
    const wrong = await fetch(`${url}/session/sess-2/permission/req-1`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${share.token}`,
      },
      body: JSON.stringify({ outcome: 'cancelled' }),
    });
    expect(wrong.status).toBe(403);
    expect(((await wrong.json()) as { code: string }).code).toBe(
      'session_locked',
    );
  });

  it('routes a write-scoped prompt to the daemon', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([SESSION_READ, WRITE]);
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'writer' }),
    });
    const writeToken = ((await redeem.json()) as { token: string }).token;

    const res = await fetch(`${url}/session/s1/prompt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${writeToken}`,
      },
      body: JSON.stringify({ prompt: 'hi' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).stopReason).toBe('end_turn');
  });

  it("a bridge prompt with X-RC-SubActor stamps the audit row's subActor", async () => {
    const { url, pairing, auditPath } = await boot();
    const { code } = pairing.mint([BRIDGE]); // expands to the bridge bundle
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'tg-bridge' }),
    });
    const bridgeToken = ((await redeem.json()) as { token: string }).token;

    const res = await fetch(`${url}/session/s1/prompt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bridgeToken}`,
        'X-RC-SubActor': 'telegram:alice',
      },
      body: JSON.stringify({ prompt: 'hi' }),
    });
    expect(res.status).toBe(200);
    const rows = await pollAudit(auditPath, (r) =>
      r.some((x) => x.action === 'prompt_sent'),
    );
    const sent = rows.find((x) => x.action === 'prompt_sent');
    expect(sent?.subActor).toBe('telegram:alice');
  });

  it('mints an invite (OWNER) and a bridge token redeems it (sole bind path)', async () => {
    const { url, pairing } = await boot();
    // Token-for helper inline: mint via pairing then redeem to a bearer token.
    const tokenFor = async (scopes: string[]) => {
      const { code } = pairing.mint(scopes);
      const r = await fetch(`${url}/rc/pair/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, label: 'x' }),
      });
      return ((await r.json()) as { token: string }).token;
    };
    const ownerToken = await tokenFor([OWNER]);
    const bridgeToken = await tokenFor([BRIDGE]);

    // Owner mints an invite for a session.
    const mint = await fetch(`${url}/rc/bridges/invites`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ kind: 'telegram', sessionId: 'sess-1' }),
    });
    expect(mint.status).toBe(200);
    const { token } = (await mint.json()) as { token: string };
    expect(token.startsWith('inv_')).toBe(true);

    // A bridge token redeems it (BRIDGE scope) → learns the session.
    const redeem = await fetch(`${url}/rc/bridges/telegram/invite/redeem`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bridgeToken}`,
      },
      body: JSON.stringify({ token }),
    });
    expect(redeem.status).toBe(200);
    expect((await redeem.json()).sessionId).toBe('sess-1');

    // Single-use: a second redeem fails with the spec error text.
    const again = await fetch(`${url}/rc/bridges/telegram/invite/redeem`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bridgeToken}`,
      },
      body: JSON.stringify({ token }),
    });
    expect(again.status).toBe(400);
    expect((await again.json()).error).toBe('Invalid or expired invite token');
  });

  it('a non-OWNER token cannot mint an invite (403)', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([SESSION_READ, WRITE]); // no owner
    const r = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'x' }),
    });
    const token = ((await r.json()) as { token: string }).token;
    const mint = await fetch(`${url}/rc/bridges/invites`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ kind: 'telegram', sessionId: 'sess-1' }),
    });
    expect(mint.status).toBe(403);
  });

  it('a non-BRIDGE token cannot redeem an invite (403)', async () => {
    const { url, pairing } = await boot();
    // session:read+approve (a plain phone), no bridge scope.
    const { code } = pairing.mint([SESSION_READ, APPROVE]);
    const r = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'x' }),
    });
    const token = ((await r.json()) as { token: string }).token;
    const redeem = await fetch(`${url}/rc/bridges/telegram/invite/redeem`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ token: 'inv_whatever' }),
    });
    expect(redeem.status).toBe(403);
  });

  it('a NON-bridge write token sending X-RC-SubActor gets 400 sub_actor_forbidden_scope', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([SESSION_READ, WRITE]); // no bridge
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'writer' }),
    });
    const writeToken = ((await redeem.json()) as { token: string }).token;

    const res = await fetch(`${url}/session/s1/prompt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${writeToken}`,
        'X-RC-SubActor': 'telegram:victim', // non-bridge scope → rejected
      },
      body: JSON.stringify({ prompt: 'hi' }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe('sub_actor_forbidden_scope');
  });

  it('403s the fork route for a token lacking write', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([SESSION_READ]); // no write
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'reader' }),
    });
    const token = ((await redeem.json()) as { token: string }).token;

    const res = await fetch(
      `${url}/session/11111111111111111111111111111111/fork`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(403);
  });

  it('mounts the fork route: 404s a missing parent for a write token', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([SESSION_READ, WRITE]);
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'forker' }),
    });
    const writeToken = ((await redeem.json()) as { token: string }).token;

    // A syntactically-valid but nonexistent parent id under the stub's
    // /stub/workspace chats dir → 404 parent_transcript_not_found.
    const res = await fetch(
      `${url}/session/22222222222222222222222222222222/fork`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${writeToken}`,
        },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('parent_transcript_not_found');
  });

  it('403s the rewind route for a write token (owner scope required)', async () => {
    const { url, pairing } = await boot();
    // owner ⊄ write: a write token is strictly weaker than owner, so the
    // OWNER-gated rewind route must reject it BEFORE the handler runs.
    const { code } = pairing.mint([SESSION_READ, WRITE]);
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'writer' }),
    });
    const writeToken = ((await redeem.json()) as { token: string }).token;

    const res = await fetch(
      `${url}/session/11111111111111111111111111111111/rewind`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${writeToken}`,
        },
        body: JSON.stringify({ toTurn: 0 }),
      },
    );
    expect(res.status).toBe(403);
  });

  it('mounts the rewind route: an owner token reaches the handler (not 403)', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([OWNER]);
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'owner' }),
    });
    const ownerToken = ((await redeem.json()) as { token: string }).token;

    // No on-disk transcript was written for this id, so the handler answers
    // 404 (session/parent transcript not found). The assertion is that OWNER
    // scope reaches the handler at all — i.e. NOT 403.
    const res = await fetch(
      `${url}/session/11111111111111111111111111111111/rewind`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`,
        },
        body: JSON.stringify({ toTurn: 0 }),
      },
    );
    expect(res.status).not.toBe(403);
  });

  it('rewind shares the prompt route PromptQueue: 409 rewind_in_progress while a prompt holds the slot', async () => {
    // Behavioural proof that server.ts injects the SAME PromptQueue instance
    // into both the prompt route and the rewind route. The prompt route
    // acquires the per-session FIFO slot BEFORE calling the daemon and holds it
    // until the daemon responds; a long promptDelayMs keeps it held. The rewind
    // route's guard is a zero-wait acquire on that same session slot — if (and
    // only if) it is the same queue object, a held slot makes rewind fail
    // immediately with 409 rewind_in_progress (a separate queue would let the
    // rewind proceed to a 404 transcript-not-found instead). The delay is long
    // enough that the slot is provably held during the ~ms-scale rewind probe,
    // yet short enough that awaiting the prompt at the end keeps teardown quick.
    const sessionId = '33333333333333333333333333333333';
    const { url, pairing } = await boot({ promptDelayMs: 500 });
    const { code } = pairing.mint([OWNER]); // owner ⊃ write: prompts AND rewinds
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'owner' }),
    });
    const token = ((await redeem.json()) as { token: string }).token;

    // Fire the prompt WITHOUT awaiting: it acquires and holds the session slot
    // while the stub daemon sits on the 5s delay.
    const promptPromise = fetch(`${url}/session/${sessionId}/prompt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ prompt: 'hold the slot' }),
    }).catch(() => undefined);

    // The stub records the prompt body the instant the request arrives (before
    // the delay), which is strictly after the gateway has acquired the queue
    // slot — so this poll proves the slot is held before we probe the rewind.
    const deadline = Date.now() + 2000;
    while (stub!.lastPromptBody === undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(stub!.lastPromptBody).toBeDefined();

    const rewind = await fetch(`${url}/session/${sessionId}/rewind`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ toTurn: 0 }),
    });
    expect(rewind.status).toBe(409);
    expect((await rewind.json()).code).toBe('rewind_in_progress');

    await promptPromise; // let the in-flight prompt settle before teardown
  });

  it('records activity on a prompt POST without breaking the route (working-device middleware wired)', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([SESSION_READ, APPROVE, WRITE]);
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'worker' }),
    });
    const token = ((await redeem.json()) as { token: string }).token;

    const res = await fetch(`${url}/session/s1/prompt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ prompt: 'hi' }),
    });
    // The recordActivity middleware runs after requireScope and must not alter
    // the route's normal 200 response.
    expect(res.status).toBe(200);
    expect((await res.json()).stopReason).toBe('end_turn');
  });

  it('403s a prompt from a session:read-only token', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([SESSION_READ]);
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'reader' }),
    });
    const readToken = ((await redeem.json()) as { token: string }).token;

    const res = await fetch(`${url}/session/s1/prompt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${readToken}`,
      },
      body: JSON.stringify({ prompt: 'hi' }),
    });
    expect(res.status).toBe(403);
  });

  it('serves the push vapid + subscribe round-trip for a session:read token', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([SESSION_READ]);
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'reader' }),
    });
    const token = ((await redeem.json()) as { token: string }).token;

    const vapidRes = await fetch(`${url}/rc/push/vapid`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(vapidRes.status).toBe(200);
    const vapidBody = (await vapidRes.json()) as {
      applicationServerKey: string;
    };
    expect(vapidBody.applicationServerKey.length).toBeGreaterThan(0);

    const sub = await fetch(`${url}/rc/push/subscribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        subscription: {
          endpoint: 'https://push.example.com/1',
          keys: { p256dh: 'p', auth: 'a' },
        },
      }),
    });
    expect(sub.status).toBe(201);

    const list = await fetch(`${url}/rc/push/subscriptions`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { subscriptions: unknown[] };
    expect(listBody.subscriptions).toHaveLength(1);
  });

  it('owner subscribes then POST /rc/push/test returns 200 {sent:1}', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([SESSION_READ, OWNER]);
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'owner' }),
    });
    const token = ((await redeem.json()) as { token: string }).token;

    const sub = await fetch(`${url}/rc/push/subscribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        subscription: {
          endpoint: 'https://push.example.com/owner-test',
          keys: { p256dh: 'p', auth: 'a' },
        },
      }),
    });
    expect(sub.status).toBe(201);

    const test = await fetch(`${url}/rc/push/test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ sessionId: 'sess-test' }),
    });
    expect(test.status).toBe(200);
    const body = (await test.json()) as { sent: number };
    expect(body.sent).toBe(1);
  });

  it('subscribe then PATCH /rc/push/subscriptions/:id prefs returns 200 via the mounted router', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([SESSION_READ, OWNER]);
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'owner' }),
    });
    const token = ((await redeem.json()) as { token: string }).token;

    const sub = await fetch(`${url}/rc/push/subscribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        subscription: {
          endpoint: 'https://push.example.com/prefs-target',
          keys: { p256dh: 'p', auth: 'a' },
        },
      }),
    });
    expect(sub.status).toBe(201);
    const subId = ((await sub.json()) as { id: string }).id;

    const patch = await fetch(`${url}/rc/push/subscriptions/${subId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ prefs: ['task.completed'] }),
    });
    expect(patch.status).toBe(200);
    const patchBody = (await patch.json()) as { id: string; prefs: string[] };
    expect(patchBody.prefs).toEqual(['task.completed']);
  });

  it('owner can POST /rc/routing/snooze then GET reports active', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([SESSION_READ, OWNER]);
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'owner' }),
    });
    const token = ((await redeem.json()) as { token: string }).token;

    const post = await fetch(`${url}/rc/routing/snooze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ durationSec: 60 }),
    });
    expect(post.status).toBe(200);
    const postBody = (await post.json()) as { until: number; scope: string };
    expect(postBody.scope).toBe('all');

    const get = await fetch(`${url}/rc/routing/snooze`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(get.status).toBe(200);
    const getBody = (await get.json()) as { active: boolean };
    expect(getBody.active).toBe(true);
  });

  it('403s POST /rc/routing/snooze for a session:read-only token', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([SESSION_READ]); // no owner
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'reader' }),
    });
    const token = ((await redeem.json()) as { token: string }).token;

    const res = await fetch(`${url}/rc/routing/snooze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ durationSec: 60 }),
    });
    expect(res.status).toBe(403);
  });

  it('mints a session-locked share; its token reaches the locked session but is 403d on others and on prompt', async () => {
    const { url, pairing } = await boot();
    // Owner mints the share for session s1.
    const { code } = pairing.mint([SESSION_READ, OWNER]);
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'owner' }),
    });
    const ownerToken = ((await redeem.json()) as { token: string }).token;

    const mint = await fetch(`${url}/rc/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ sessionId: 's1', ttlSec: 3600 }),
    });
    expect(mint.status).toBe(201);
    const share = (await mint.json()) as {
      id: string;
      token: string;
      url: string;
    };
    expect(share.url).toBe('/ui/share/' + share.token);

    // The share token reaches its own locked session (passes the lock — not 403).
    const ok = await fetch(`${url}/session/s1/events`, {
      headers: { Authorization: `Bearer ${share.token}` },
    });
    expect(ok.status).not.toBe(403);

    // The share token on a DIFFERENT session → 403 session_locked.
    const wrong = await fetch(`${url}/session/s2/events`, {
      headers: { Authorization: `Bearer ${share.token}` },
    });
    expect(wrong.status).toBe(403);
    expect(((await wrong.json()) as { code: string }).code).toBe(
      'session_locked',
    );

    // The share token on the prompt route (its own session) → 403: no write scope.
    const prompt = await fetch(`${url}/session/s1/prompt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${share.token}`,
      },
      body: JSON.stringify({ prompt: 'x' }),
    });
    expect(prompt.status).toBe(403);

    // GET /rc/share (owner) lists the minted share.
    const list = await fetch(`${url}/rc/share`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      shares: Array<{ id: string; sessionLockId: string }>;
    };
    expect(listBody.shares.some((s) => s.id === share.id)).toBe(true);
  });

  it('a share token redeems via GET /rc/share/whoami (mounted before the owner gate); an owner token is 403d there', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([SESSION_READ, OWNER]);
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'owner' }),
    });
    const ownerToken = ((await redeem.json()) as { token: string }).token;

    const mint = await fetch(`${url}/rc/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ sessionId: 's1', ttlSec: 3600, maxUses: 1 }),
    });
    const share = (await mint.json()) as { id: string; token: string };

    // The share token reaches whoami (NOT 403d by the owner gate) and redeems.
    const who = await fetch(`${url}/rc/share/whoami`, {
      headers: { Authorization: `Bearer ${share.token}` },
    });
    expect(who.status).toBe(200);
    const meta = (await who.json()) as {
      sessionId: string;
      usesRemaining: number;
    };
    expect(meta).toMatchObject({ sessionId: 's1', usesRemaining: 0 });

    // A fresh (cookie-less) redemption is now exhausted.
    const again = await fetch(`${url}/rc/share/whoami`, {
      headers: { Authorization: `Bearer ${share.token}` },
    });
    expect(again.status).toBe(410);

    // An owner token lacks SHARE → 403 at whoami (route order + scope gate).
    const ownerWho = await fetch(`${url}/rc/share/whoami`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(ownerWho.status).toBe(403);
  });

  it('403s POST /rc/share for a non-owner token', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([SESSION_READ]); // no owner
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'reader' }),
    });
    const token = ((await redeem.json()) as { token: string }).token;

    const res = await fetch(`${url}/rc/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ sessionId: 's1', ttlSec: 3600 }),
    });
    expect(res.status).toBe(403);
  });

  it('GET /rc/commands lists workspace commands with invocableByYou for a write caller', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-cmd-ws-'));
    const cmdDir = join(dir, '.qwen', 'commands');
    mkdirSync(cmdDir, { recursive: true });
    writeFileSync(
      join(cmdDir, 'triage.md'),
      '---\nname: triage\ndescription: triage it\nscope: write\n---\nbody ${args}',
    );
    const { url, pairing } = await boot({ workspaceCwd: dir });
    const { code } = pairing.mint([SESSION_READ, WRITE]);
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'writer' }),
    });
    const token = ((await redeem.json()) as { token: string }).token;

    const res = await fetch(`${url}/rc/commands`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      v: number;
      commands: Array<{ name: string; invocableByYou: boolean }>;
    };
    expect(body.v).toBe(1);
    const triage = body.commands.find((c) => c.name === 'triage');
    expect(triage).toBeDefined();
    expect(triage!.invocableByYou).toBe(true);
  });

  it('401s GET /rc/commands without a token', async () => {
    const { url } = await boot();
    const res = await fetch(`${url}/rc/commands`);
    expect(res.status).toBe(401);
  });

  it('403s GET /rc/commands for a token lacking session:read', async () => {
    const { url, pairing } = await boot();
    // `share` is a pure marker scope with no functional implications — it does
    // NOT imply session:read (unlike write/approve/owner which all do via the
    // implication hierarchy). Use it to exercise the 403 path.
    const { code } = pairing.mint([SHARE]);
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'share-marker-only' }),
    });
    const token = ((await redeem.json()) as { token: string }).token;
    const res = await fetch(`${url}/rc/commands`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it('404s POST /session/:id/command/:name for an unknown command (route wired)', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([SESSION_READ, WRITE]);
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'writer' }),
    });
    const token = ((await redeem.json()) as { token: string }).token;
    const res = await fetch(`${url}/session/s1/command/nope`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe(
      'unknown_command',
    );
  });

  it('403s POST /session/:id/command/:name for a session:read-only token', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([SESSION_READ]); // no write
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'reader' }),
    });
    const token = ((await redeem.json()) as { token: string }).token;
    const res = await fetch(`${url}/session/s1/command/whatever`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it('403s the push vapid route for a token lacking session:read', async () => {
    const { url, pairing } = await boot();
    // `share` is a pure marker scope with no functional implications — it does
    // NOT imply session:read (unlike owner/write/approve which all do). Use it
    // to exercise the 403 path on the vapid route.
    const { code } = pairing.mint([SHARE]);
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'share-marker-only' }),
    });
    const token = ((await redeem.json()) as { token: string }).token;

    const res = await fetch(`${url}/rc/push/vapid`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });
});

describe('GET /ui/clients-manifest.json (multi-workspace-client)', () => {
  const TOML = '[[daemon]]\nname = "a"\nurl = "https://h:4170"\n';
  async function redeem(
    url: string,
    pairing: PairingService,
    scopes: string[],
  ) {
    const { code } = pairing.mint(scopes);
    const r = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'x' }),
    });
    return ((await r.json()) as { token: string }).token;
  }

  it('owner token → 200 parsed manifest (route resolves before the static /ui mount)', async () => {
    const { url, pairing } = await boot(undefined, {
      clientsManifestReadToml: async () => TOML,
    });
    const token = await redeem(url, pairing, [OWNER]);
    const r = await fetch(`${url}/ui/clients-manifest.json`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { daemons: unknown[] };
    expect(body.daemons).toHaveLength(1);
  });

  it('read-scope token → 403', async () => {
    const { url, pairing } = await boot(undefined, {
      clientsManifestReadToml: async () => TOML,
    });
    const token = await redeem(url, pairing, [SESSION_READ]);
    const r = await fetch(`${url}/ui/clients-manifest.json`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(403);
  });

  it('no token → 401', async () => {
    const { url } = await boot(undefined, {
      clientsManifestReadToml: async () => TOML,
    });
    const r = await fetch(`${url}/ui/clients-manifest.json`);
    expect(r.status).toBe(401);
  });
});

describe('APNs registration auth floor (native-mobile-shells)', () => {
  async function redeemToken(
    url: string,
    pairing: PairingService,
    scopes: string[],
  ) {
    const { code } = pairing.mint(scopes);
    const r = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'x' }),
    });
    return ((await r.json()) as { token: string }).token;
  }
  const body = {
    deviceToken: '0123456789abcdef'.repeat(4), // realistic 64-hex APNs token
    bundleId: 'dev.qwen.rc',
    shellVersion: '1.0.0',
  };

  it('requires session:read — a zero-scope token is 403', async () => {
    const apnsDir = mkdtempSync(join(tmpdir(), 'rc-apns-floor-'));
    const apnsStore = await ApnsStore.open(join(apnsDir, 'apns.json'));
    const { url, pairing } = await boot(undefined, { apnsStore });
    const token = await redeemToken(url, pairing, []); // no scopes
    const r = await fetch(`${url}/rc/native-push/apns/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    expect(r.status).toBe(403);
    expect(apnsStore.listAll()).toHaveLength(0);
    rmSync(apnsDir, { recursive: true, force: true });
  });

  it('a session:read token can register (201)', async () => {
    const apnsDir = mkdtempSync(join(tmpdir(), 'rc-apns-ok-'));
    const apnsStore = await ApnsStore.open(join(apnsDir, 'apns.json'));
    const { url, pairing } = await boot(undefined, { apnsStore });
    const token = await redeemToken(url, pairing, [SESSION_READ]);
    const r = await fetch(`${url}/rc/native-push/apns/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    expect(r.status).toBe(201);
    rmSync(apnsDir, { recursive: true, force: true });
  });
});

describe('GET /.well-known/assetlinks.json is PUBLIC (native-mobile-shells)', () => {
  const LINKS = [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: 'dev.qwen.rc' },
    },
  ];

  it('serves 200 with NO Authorization header when a TWA is configured', async () => {
    const { url } = await boot(undefined, { assetLinks: () => LINKS });
    const r = await fetch(`${url}/.well-known/assetlinks.json`); // no bearer
    expect(r.status).toBe(200); // the point: NOT 401 (mounted before bearerResolve)
    expect(await r.json()).toEqual(LINKS);
  });

  it('serves 404 (not 401) with no token when no TWA is configured', async () => {
    const { url } = await boot(undefined, { assetLinks: () => null });
    const r = await fetch(`${url}/.well-known/assetlinks.json`);
    expect(r.status).toBe(404);
  });
});

describe('APNs token-revoke cascade (native-mobile-shells)', () => {
  it('revoking a token removes its APNs subscriptions in the same request', async () => {
    const apnsDir = mkdtempSync(join(tmpdir(), 'rc-apns-srv-'));
    const apnsStore = await ApnsStore.open(join(apnsDir, 'apns.json'));
    const { url, pairing } = await boot(undefined, { apnsStore });

    // Mint+redeem an owner token (to call DELETE /rc/tokens/:id) and a victim.
    const owner = pairing.mint([OWNER]);
    const ownerToken = (
      (await (
        await fetch(`${url}/rc/pair/redeem`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: owner.code, label: 'owner' }),
        })
      ).json()) as { token: string }
    ).token;

    const victim = pairing.mint([SESSION_READ]);
    const victimRes = (await (
      await fetch(`${url}/rc/pair/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: victim.code, label: 'phone' }),
      })
    ).json()) as { id: string; token: string };

    // The victim registers an APNs device token.
    await fetch(`${url}/rc/native-push/apns/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${victimRes.token}`,
      },
      body: JSON.stringify({
        deviceToken: '0123456789abcdef'.repeat(4),
        bundleId: 'dev.qwen.rc',
        shellVersion: '1.0.0',
      }),
    });
    expect(apnsStore.listAll()).toHaveLength(1);

    // Owner revokes the victim token → subscriptions cascade-removed.
    const del = await fetch(`${url}/rc/tokens/${victimRes.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(del.status).toBe(204);
    expect(apnsStore.listAll()).toHaveLength(0);

    rmSync(apnsDir, { recursive: true, force: true });
  });

  it('delivers a permission.required to a registered APNs device through the wired sender', async () => {
    const apnsDir = mkdtempSync(join(tmpdir(), 'rc-apns-deliver-'));
    const apnsStore = await ApnsStore.open(join(apnsDir, 'apns.json'));
    // Fake the HTTP/2 transport to Apple (the vendor ceiling) and capture POSTs.
    const posts: Array<{ deviceToken: string; topic: string; jwt: string }> =
      [];
    const transport = {
      post: async (req: {
        deviceToken: string;
        topic: string;
        jwt: string;
      }) => {
        posts.push({
          deviceToken: req.deviceToken,
          topic: req.topic,
          jwt: req.jwt,
        });
        return { status: 200 };
      },
    };
    const { url, pairing, notifier } = await boot(undefined, {
      apnsStore,
      apns: {
        signer: { token: () => 'fake-jwt' },
        bundleId: 'dev.qwen.rc',
        host: 'api.push.apple.com',
        transport,
      },
    });

    // Redeem an approver token (scope gate) and register its APNs device.
    const approver = pairing.mint([SESSION_READ, APPROVE]);
    const approverToken = (
      (await (
        await fetch(`${url}/rc/pair/redeem`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: approver.code, label: 'phone' }),
        })
      ).json()) as { token: string }
    ).token;
    await fetch(`${url}/rc/native-push/apns/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${approverToken}`,
      },
      body: JSON.stringify({
        deviceToken: 'abcdef0123456789'.repeat(4), // realistic 64-hex token
        bundleId: 'dev.qwen.rc',
        shellVersion: '1.0.0',
      }),
    });

    // Drive a notification through the gateway's own (wired) notifier.
    await notifier!.notify(
      {
        type: 'permission_request',
        data: { toolCall: { name: 'bash' }, requestId: 'r1' },
      },
      { sessionId: 's1' },
    );

    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      deviceToken: 'abcdef0123456789'.repeat(4),
      topic: 'dev.qwen.rc',
      jwt: 'fake-jwt',
    });

    rmSync(apnsDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// CORS preflight + actual-request middleware (Task 1.4)
// ---------------------------------------------------------------------------

describe('CORS preflight and actual-request middleware', () => {
  it('OPTIONS from an unlisted origin returns 403 with no ACAO header', async () => {
    const { url } = await boot();
    const res = await fetch(`${url}/rc/health`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://unlisted.evil.com',
        'Access-Control-Request-Method': 'GET',
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('OPTIONS from an allowlisted origin returns 204 with ACAO + credentials + Vary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-cors-srv-'));
    const s = await TokenStore.open(join(dir, 'tokens.json'));
    await s.admitOrigin('https://app.example.com', 'tok1');
    const { url: url2 } = await boot(undefined, {
      store: s,
    });
    const res = await fetch(`${url2}/rc/health`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.example.com',
        'Access-Control-Request-Method': 'GET',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'https://app.example.com',
    );
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('vary')).toBe('Origin');
  });

  it('actual GET from an unlisted origin has no ACAO header (still 200 for public routes)', async () => {
    const { url } = await boot();
    const res = await fetch(`${url}/rc/health`, {
      headers: { Origin: 'https://unlisted.evil.com' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('actual GET from an allowlisted origin gets ACAO + credentials + Vary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-cors-srv2-'));
    const s = await TokenStore.open(join(dir, 'tokens.json'));
    await s.admitOrigin('https://app.example.com', 'tok1');
    const { url: url2 } = await boot(undefined, { store: s });
    const res = await fetch(`${url2}/rc/health`, {
      headers: { Origin: 'https://app.example.com' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'https://app.example.com',
    );
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('vary')).toBe('Origin');
  });

  it('GET /rc/cors returns 200 with origins array for owner token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-cors-srv3-'));
    const s = await TokenStore.open(join(dir, 'tokens.json'));
    const p = new PairingService();
    const { url } = await boot(undefined, { store: s, pairing: p });
    const { code } = p.mint(['owner']);
    const redeemRes = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'owner' }),
    });
    const { token: ownerToken } = (await redeemRes.json()) as { token: string };
    await s.admitOrigin('https://app.example.com', 'tok1');
    const res = await fetch(`${url}/rc/cors`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { origins: Array<{ origin: string }> };
    expect(
      body.origins.some((o) => o.origin === 'https://app.example.com'),
    ).toBe(true);
  });
});

# RC Gateway Permission Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the browser viewer approve/deny a session's pending permission requests — an `approve` scope + a `POST /rc/session/:id/permission/:requestId` proxy (→ SDK `respondToSessionPermission`) + approve/deny buttons in the viewer + a `permission_voted` audit event.

**Architecture:** A new flat `approve` scope gates a new vote proxy route that calls the SDK and audits the outcome. The boot pairing code grants `approve` so the owner viewer can vote. The vanilla viewer detects `permission_request` events and renders interactive cards that POST the vote with the bearer. Zero upstream-file edits.

**Tech Stack:** TypeScript (ESM, NodeNext), Express, `@qwen-code/sdk`, vanilla browser JS, vitest.

---

## File Structure

```
packages/rc-gateway/
  src/scopes.ts               # MODIFY: APPROVE + KNOWN_SCOPES
  src/auditLog.ts             # MODIFY: 'permission_voted' action
  src/routes/permission.ts    # NEW: createPermissionVoteRoute
  src/routes/permission.test.ts # NEW
  src/testing/stubDaemon.ts   # MODIFY: POST /session/:id/permission/:requestId
  src/server.ts               # MODIFY: wire vote route
  src/server.test.ts          # MODIFY: server integration test
  src/cli.ts                  # MODIFY: boot grant adds APPROVE
  src/index.ts                # MODIFY: export route + APPROVE
  public/index.html           # MODIFY: approve/deny cards
  scripts/rc-gateway-e2e.mjs  # MODIFY: vote e2e check (repo-root path)
```

---

## Task 1: Scope + audit action + vote route

**Files:**

- Modify: `packages/rc-gateway/src/scopes.ts`, `src/auditLog.ts`, `src/testing/stubDaemon.ts`
- Create: `packages/rc-gateway/src/routes/permission.ts`, `src/routes/permission.test.ts`

- [ ] **Step 1: Add `APPROVE` to `scopes.ts`** (after the existing `OWNER`/`KNOWN_SCOPES`). Replace the `KNOWN_SCOPES` line so it includes APPROVE:

```ts
/** Vote on a session's pending permission requests. */
export const APPROVE: RcScope = 'approve';

/** All scopes the gateway recognizes (used to reject unknown mint scopes). */
export const KNOWN_SCOPES: readonly RcScope[] = [OWNER, SESSION_READ, APPROVE];
```

(Remove the old `KNOWN_SCOPES` definition so there is exactly one, now including `APPROVE`. Keep `OWNER`/`SESSION_READ` as-is.)

- [ ] **Step 2: Add the audit action** in `auditLog.ts`. Add `'permission_voted'` to BOTH the `AuditAction` union and the `AUDIT_ACTIONS` array (append after `'session_detached'` in each):

```ts
// in the AuditAction union, add:
  | 'permission_voted'
```

```ts
// in AUDIT_ACTIONS, add as the last element:
  'permission_voted',
```

- [ ] **Step 3: Extend the stub daemon** (`src/testing/stubDaemon.ts`) to answer permission votes. Add to `StubDaemonOptions`:

```ts
  /** Status for POST /session/:id/permission/:requestId (default 200 = accepted). */
  permissionStatus?: number;
```

And register this route (the stub uses `express`; add alongside its other routes, e.g. after the `/session/:id/events` handler). The stub currently has no body parser, so add `express.json()` once at the top of `startStubDaemon` before the routes if not present:

```ts
app.use(express.json());
```

```ts
app.post('/session/:id/permission/:requestId', (_req, res) => {
  const status = opts.permissionStatus ?? 200;
  res.status(status).json(status === 200 ? {} : { error: 'no pending' });
});
```

(If `express.json()` is already applied in the stub, don't add it twice.)

- [ ] **Step 4: Write failing route tests** in `routes/permission.test.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DaemonClient } from '@qwen-code/sdk';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { TokenStore } from '../tokenStore.js';
import { bearerResolve, requireScope } from '../auth.js';
import { APPROVE, SESSION_READ } from '../scopes.js';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';
import { createPermissionVoteRoute } from './permission.js';

let server: Server | undefined;
let stub: StubDaemon | undefined;
let store: TokenStore;
let audit: AuditRecorder & { calls: AuditEntry[] };

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  if (stub) await stub.close();
  server = undefined;
  stub = undefined;
});

beforeEach(async () => {
  store = await TokenStore.open(
    join(mkdtempSync(join(tmpdir(), 'rc-perm-')), 'tokens.json'),
  );
  audit = fakeAudit();
});

async function mount(daemon: DaemonClient): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use(bearerResolve(store, audit));
  app.post(
    '/rc/session/:id/permission/:requestId',
    requireScope(APPROVE, audit),
    createPermissionVoteRoute(daemon, audit),
  );
  const s: Server = await new Promise((resolve) => {
    const sv = app.listen(0, '127.0.0.1', () => resolve(sv));
  });
  server = s;
  const { port } = s.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function postVote(
  url: string,
  token: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${url}/rc/session/sess-1/permission/req-1`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

describe('permission vote route', () => {
  it('accepts a selected vote with an approve token (200)', async () => {
    stub = await startStubDaemon({ permissionStatus: 200 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const { token } = await store.issue([SESSION_READ, APPROVE], 'owner');
    const url = await mount(daemon);
    const res = await postVote(url, token, {
      outcome: 'selected',
      optionId: 'allow',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).accepted).toBe(true);
    const voted = audit.calls.find((c) => c.action === 'permission_voted');
    expect(voted).toBeDefined();
    expect(voted!.detail).toMatchObject({ requestId: 'req-1', accepted: true });
  });

  it('accepts a cancelled vote (200)', async () => {
    stub = await startStubDaemon({ permissionStatus: 200 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const { token } = await store.issue([APPROVE], 'owner');
    const url = await mount(daemon);
    const res = await postVote(url, token, { outcome: 'cancelled' });
    expect(res.status).toBe(200);
  });

  it('400s an invalid vote (selected without optionId)', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const { token } = await store.issue([APPROVE], 'owner');
    const url = await mount(daemon);
    const res = await postVote(url, token, { outcome: 'selected' });
    expect(res.status).toBe(400);
  });

  it('403s a token without approve scope', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const { token } = await store.issue([SESSION_READ], 'phone');
    const url = await mount(daemon);
    const res = await postVote(url, token, {
      outcome: 'selected',
      optionId: 'allow',
    });
    expect(res.status).toBe(403);
  });

  it('404s when the daemon has no pending request', async () => {
    stub = await startStubDaemon({ permissionStatus: 404 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const { token } = await store.issue([APPROVE], 'owner');
    const url = await mount(daemon);
    const res = await postVote(url, token, { outcome: 'cancelled' });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `cd /home/evan/projects/qwen-code && npx vitest run --root packages/rc-gateway "routes/permission"`
Expected: FAIL (`createPermissionVoteRoute` not exported).

- [ ] **Step 6: Implement `routes/permission.ts`**

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { DaemonClient, PermissionResponse } from '@qwen-code/sdk';
import type { AuditRecorder } from '../auditLog.js';

/** POST /rc/session/:id/permission/:requestId { outcome, optionId? } → vote. */
export function createPermissionVoteRoute(
  daemon: DaemonClient,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    const requestId = req.params.requestId;
    const body = (req.body ?? {}) as { outcome?: unknown; optionId?: unknown };

    let response: PermissionResponse;
    if (body.outcome === 'cancelled') {
      response = { outcome: 'cancelled' };
    } else if (
      body.outcome === 'selected' &&
      typeof body.optionId === 'string' &&
      body.optionId.length > 0
    ) {
      response = { outcome: 'selected', optionId: body.optionId };
    } else {
      res.status(400).json({ error: 'Invalid vote', code: 'invalid_vote' });
      return;
    }

    let accepted: boolean;
    try {
      accepted = await daemon.respondToSessionPermission(
        sessionId,
        requestId,
        response,
      );
    } catch {
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
      return;
    }

    void audit?.record({
      action: 'permission_voted',
      actorTokenId: req.rcClient?.id,
      target: sessionId,
      detail: { requestId, outcome: body.outcome, accepted },
    });

    if (accepted) {
      res.status(200).json({ accepted: true });
    } else {
      res.status(404).json({
        error: 'No pending permission request',
        code: 'no_pending_permission',
      });
    }
  };
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd /home/evan/projects/qwen-code && npx vitest run --root packages/rc-gateway "routes/permission"`
Expected: PASS (5 tests).

- [ ] **Step 8: Commit**

```bash
git add packages/rc-gateway/src/scopes.ts packages/rc-gateway/src/auditLog.ts packages/rc-gateway/src/testing/stubDaemon.ts packages/rc-gateway/src/routes/permission.ts packages/rc-gateway/src/routes/permission.test.ts
git commit -m "feat(rc-gateway): approve scope + permission-vote proxy route"
```

---

## Task 2: Wire + boot grant + viewer UI + verify

**Files:**

- Modify: `src/server.ts`, `src/server.test.ts`, `src/cli.ts`, `src/index.ts`, `public/index.html`, `scripts/rc-gateway-e2e.mjs`

- [ ] **Step 1: Wire the route in `server.ts`.** Add the import beside the other route imports:

```ts
import { createPermissionVoteRoute } from './routes/permission.js';
```

Add `APPROVE` to the scopes import from `./scopes.js` (it currently imports `OWNER, SESSION_READ`):

```ts
import { OWNER, SESSION_READ, APPROVE } from './scopes.js';
```

Register the route AFTER the session-events route (inside `createGatewayApp`, after `app.use(bearerResolve(...))`):

```ts
app.post(
  '/rc/session/:id/permission/:requestId',
  requireScope(APPROVE, audit),
  createPermissionVoteRoute(deps.daemon, audit),
);
```

- [ ] **Step 2: Boot grant in `cli.ts`.** Change the import to add APPROVE and update the mint + banner:

```ts
import { OWNER, SESSION_READ, APPROVE } from './scopes.js';
```

Change `pairing.mint([OWNER, SESSION_READ])` to:

```ts
const { code, expiresAt } = pairing.mint([OWNER, SESSION_READ, APPROVE]);
```

Update the grants banner line to:

```ts
        `  (expires ${new Date(expiresAt).toISOString()}, grants [${OWNER}, ${SESSION_READ}, ${APPROVE}])`,
```

- [ ] **Step 3: Export from `index.ts`.** Add `APPROVE` to the scopes export and add the route export. Change the scopes line to:

```ts
export {
  SESSION_READ,
  OWNER,
  APPROVE,
  KNOWN_SCOPES,
  type RcScope,
} from './scopes.js';
```

Add:

```ts
export { createPermissionVoteRoute } from './routes/permission.js';
```

- [ ] **Step 4: Replace `public/index.html`** with this version (adds a `#cards` area and permission-request handling; vanilla, `textContent`/DOM only — XSS-safe):

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>qwen-rc viewer</title>
    <style>
      body {
        font-family: system-ui, sans-serif;
        max-width: 760px;
        margin: 2rem auto;
        padding: 0 1rem;
      }
      h1 {
        font-size: 1.2rem;
      }
      section {
        border: 1px solid #ccc;
        border-radius: 8px;
        padding: 1rem;
        margin-bottom: 1rem;
      }
      input {
        padding: 0.4rem;
        font: inherit;
      }
      button {
        padding: 0.4rem 0.8rem;
        font: inherit;
        cursor: pointer;
      }
      #status {
        min-height: 1.2em;
        color: #444;
        margin-bottom: 0.5rem;
      }
      .card {
        border: 1px solid #c80;
        background: #fffbe6;
        border-radius: 8px;
        padding: 0.6rem;
        margin-bottom: 0.5rem;
      }
      .card pre {
        white-space: pre-wrap;
        margin: 0 0 0.4rem;
        font-size: 0.8rem;
      }
      #log {
        background: #111;
        color: #ddd;
        padding: 0.5rem;
        height: 40vh;
        overflow: auto;
        white-space: pre-wrap;
        font-family: ui-monospace, monospace;
        font-size: 0.85rem;
      }
    </style>
  </head>
  <body id="rc-app">
    <h1>qwen-rc viewer</h1>
    <section>
      <label>Pairing code <input id="code" placeholder="paste code" /></label>
      <button id="pair">Pair</button>
    </section>
    <section>
      <label>Session id <input id="session" placeholder="session id" /></label>
      <button id="watch">Watch</button>
      <button id="stop" disabled>Stop</button>
    </section>
    <div id="status"></div>
    <div id="cards"></div>
    <pre id="log"></pre>
    <script>
      const $ = (id) => document.getElementById(id);
      const TOKEN_KEY = 'qwen-rc-token';
      const setStatus = (m) => {
        $('status').textContent = m;
      };
      const log = (m) => {
        const el = $('log');
        el.textContent += m + '\n';
        el.scrollTop = el.scrollHeight;
      };
      const cards = new Map(); // requestId -> { el, buttons }

      const token = () => localStorage.getItem(TOKEN_KEY);

      $('pair').onclick = async () => {
        const code = $('code').value.trim();
        if (!code) return setStatus('enter a code');
        try {
          const res = await fetch('/rc/pair/redeem', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, label: 'web' }),
          });
          if (!res.ok) return setStatus('invalid code (' + res.status + ')');
          const data = await res.json();
          localStorage.setItem(TOKEN_KEY, data.token);
          setStatus('paired; scopes: ' + (data.scopes || []).join(', '));
        } catch (e) {
          setStatus('pair failed: ' + e);
        }
      };

      async function vote(sessionId, requestId, outcome, optionId) {
        const entry = cards.get(requestId);
        try {
          const res = await fetch(
            '/rc/session/' +
              encodeURIComponent(sessionId) +
              '/permission/' +
              encodeURIComponent(requestId),
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + token(),
              },
              body: JSON.stringify(
                outcome === 'selected' ? { outcome, optionId } : { outcome },
              ),
            },
          );
          if (entry) {
            entry.disable();
            if (res.status === 200) entry.note('voted: ' + outcome);
            else if (res.status === 404) entry.note('already resolved');
            else if (res.status === 401 || res.status === 403)
              entry.note('not authorized');
            else entry.note('vote failed (' + res.status + ')');
          }
        } catch (e) {
          if (entry) entry.note('vote error: ' + e);
        }
      }

      function renderPermissionCard(data, sessionId) {
        const requestId = data.requestId;
        if (!requestId || cards.has(requestId)) return;
        const card = document.createElement('div');
        card.className = 'card';
        const summary = document.createElement('pre');
        summary.textContent =
          'permission request ' +
          requestId +
          '\n' +
          JSON.stringify(data.toolCall, null, 2);
        card.appendChild(summary);
        const note = document.createElement('div');
        const buttons = [];
        for (const opt of data.options || []) {
          const b = document.createElement('button');
          b.textContent = 'Approve: ' + (opt.name || opt.optionId);
          b.onclick = () =>
            vote(sessionId, requestId, 'selected', opt.optionId);
          card.appendChild(b);
          buttons.push(b);
        }
        const deny = document.createElement('button');
        deny.textContent = 'Deny';
        deny.onclick = () => vote(sessionId, requestId, 'cancelled');
        card.appendChild(deny);
        buttons.push(deny);
        card.appendChild(note);
        $('cards').appendChild(card);
        cards.set(requestId, {
          el: card,
          disable: () => buttons.forEach((b) => (b.disabled = true)),
          note: (m) => {
            note.textContent = m;
          },
        });
      }

      function resolveCard(requestId) {
        const entry = cards.get(requestId);
        if (entry) {
          entry.disable();
          entry.note('resolved');
        }
      }

      let controller = null;
      $('stop').onclick = () => {
        if (controller) controller.abort();
      };

      $('watch').onclick = async () => {
        if (!token()) return setStatus('pair first');
        const id = $('session').value.trim();
        if (!id) return setStatus('enter a session id');
        controller = new AbortController();
        $('watch').disabled = true;
        $('stop').disabled = false;
        setStatus('connecting…');
        try {
          const res = await fetch(
            '/rc/session/' + encodeURIComponent(id) + '/events',
            {
              headers: { Authorization: 'Bearer ' + token() },
              signal: controller.signal,
            },
          );
          if (!res.ok) {
            setStatus('not authorized (' + res.status + ') — re-pair');
            return;
          }
          setStatus('streaming');
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const blocks = buf.split('\n\n');
            buf = blocks.pop() || '';
            for (const block of blocks) {
              const dataLine = block
                .split('\n')
                .find((l) => l.startsWith('data:'));
              if (!dataLine) continue;
              const payload = dataLine.slice(5).trim();
              let ev;
              try {
                ev = JSON.parse(payload);
              } catch {
                log(payload);
                continue;
              }
              if (ev && ev.type === 'permission_request' && ev.data) {
                renderPermissionCard(ev.data, id);
              } else if (
                ev &&
                ev.type === 'permission_resolved' &&
                ev.data &&
                ev.data.requestId
              ) {
                resolveCard(ev.data.requestId);
                log(JSON.stringify(ev));
              } else {
                log(JSON.stringify(ev));
              }
            }
          }
          setStatus('stream ended');
        } catch (e) {
          setStatus(
            controller.signal.aborted ? 'stopped' : 'stream error: ' + e,
          );
        } finally {
          $('watch').disabled = false;
          $('stop').disabled = true;
        }
      };
    </script>
  </body>
</html>
```

- [ ] **Step 5: Add a server integration test** to `server.test.ts` (append inside `describe('gateway app', ...)`). It mints an approve-scoped token via a pairing code and votes against the stub (whose default `permissionStatus` is 200):

```ts
it('routes an approve-scoped permission vote to the daemon', async () => {
  const { url, pairing } = await boot();
  const { code } = pairing.mint([SESSION_READ, OWNER]); // owner can mint
  const redeem = await fetch(`${url}/rc/pair/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, label: 'owner' }),
  });
  const ownerToken = ((await redeem.json()) as { token: string }).token;

  // Mint an approve-scoped token via /rc/tokens (owner only).
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

  const vote = await fetch(`${url}/rc/session/sess-1/permission/req-1`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${approveToken}`,
    },
    body: JSON.stringify({ outcome: 'cancelled' }),
  });
  // Default stub permissionStatus is 200 → accepted.
  expect(vote.status).toBe(200);
});
```

Add `APPROVE` to the scopes import at the top of `server.test.ts` (it currently imports `OWNER, SESSION_READ`):

```ts
import { OWNER, SESSION_READ, APPROVE } from './scopes.js';
```

- [ ] **Step 6: Extend the e2e** `scripts/rc-gateway-e2e.mjs` (repo root). Add `APPROVE` to the import from `../packages/rc-gateway/dist/index.js`, and after the existing checks add a vote check (use the script's `gw`, `ok`, `bad`, `pairing`):

```js
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
```

(Adapt variable names to the script's actuals if they differ. The import line is `import { createGatewayApp, TokenStore, PairingService, SESSION_READ } from '../packages/rc-gateway/dist/index.js';` — add `APPROVE`.)

- [ ] **Step 7: Typecheck, lint, build**

Run:

```bash
cd /home/evan/projects/qwen-code
npm run typecheck --workspace @qwen-code/rc-gateway
npm run lint --workspace @qwen-code/rc-gateway
npm run build --workspace @qwen-code/rc-gateway
```

Expected: clean.

- [ ] **Step 8: Full suite**

Run: `cd /home/evan/projects/qwen-code && npm run test --workspace @qwen-code/rc-gateway`
Expected: PASS — all green (permission 5, server 10, plus existing; total ~68 across 12 files). Report the exact total.

- [ ] **Step 9: Manual e2e (not gating, once)**

Run: `node scripts/rc-gateway-e2e.mjs` (expect the new vote check to pass: 404 against the real daemon). Browser approve/deny is manual: `node packages/rc-gateway/dist/cli.js serve`, open `/ui/`, pair, watch a session that triggers a tool permission, and tap Approve/Deny.

- [ ] **Step 10: Commit**

```bash
git add packages/rc-gateway/src/server.ts packages/rc-gateway/src/server.test.ts packages/rc-gateway/src/cli.ts packages/rc-gateway/src/index.ts packages/rc-gateway/public/index.html scripts/rc-gateway-e2e.mjs
git commit -m "feat(rc-gateway): wire permission vote; boot grant approve; viewer approve/deny UI"
```

---

## Self-Review

**Spec coverage:**

- `approve` scope + `KNOWN_SCOPES` → T1 Step 1. ✓
- `permission_voted` audit action → T1 Step 2. ✓
- Vote route (validate outcome/optionId → 400; `respondToSessionPermission` → 200/404; throw → 502; audit with `accepted`) → T1 Step 6, tested T1 Step 4. ✓
- Stub daemon permission endpoint (configurable 200/404) → T1 Step 3. ✓
- Wiring `requireScope(APPROVE)` → T2 Step 1; 403 path tested in T1. ✓
- Boot grant adds `approve` → T2 Step 2. ✓
- Viewer approve/deny cards (permission_request → card; vote POST with bearer; resolve on permission_resolved; textContent/DOM only) → T2 Step 4. ✓
- Exports → T2 Step 3. ✓
- Server integration + e2e → T2 Steps 5/6. ✓
- Error model rows (401/403/400/404/502/200) covered across T1 tests + wiring. ✓
- Deferred (prompt-sending, push, webui) → absent. ✓

**Placeholder scan:** none — complete code throughout.

**Type/name consistency:** `APPROVE`/`KNOWN_SCOPES`; `createPermissionVoteRoute(daemon, audit?)`; `respondToSessionPermission(sessionId, requestId, response)` (matches SDK); `PermissionResponse` imported from `@qwen-code/sdk` (verified exported); `permission_voted` in both `AuditAction` and `AUDIT_ACTIONS`; route path `/rc/session/:id/permission/:requestId` consistent between route, wiring, tests, viewer, e2e. The viewer reads `ev.type`/`ev.data` matching the SSE envelope (`{ v, id, type, data }`) the proxy emits. ✓

**Note:** the server integration test mints the approve token via `/rc/tokens` (owner-gated) rather than relying on the boot grant, so it's independent of the cli.ts change; the cli boot grant is covered by the manual e2e and the design intent (owner viewer can approve out of the box).

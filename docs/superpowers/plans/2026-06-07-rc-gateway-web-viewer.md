# RC Gateway Minimal Web Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a minimal same-origin, read-only web viewer at `/ui/` so a browser can pair (get a token) and watch a session's SSE stream live — vanilla, no CORS, no build tooling.

**Architecture:** A single static `public/index.html` (inline CSS+JS) does redeem → `localStorage` token → fetch-stream the events route with the bearer. The gateway serves `public/` at `/ui/` via `express.static`, registered before auth (the shell is public). Serving is integration-tested; the UI itself is proven by manual e2e. Zero upstream-file edits.

**Tech Stack:** TypeScript (ESM, NodeNext), Express (`express.static`), vanilla browser JS, vitest.

---

## File Structure

```
packages/rc-gateway/
  public/index.html      # NEW: vanilla read-only viewer (pair + watch)
  src/server.ts          # MODIFY: serve /ui (express.static), GatewayDeps.webRoot?
  src/server.test.ts     # MODIFY: /ui serving tests
  src/cli.ts             # MODIFY: banner line pointing at /ui/
  scripts/rc-gateway-e2e.mjs  # MODIFY: assert GET /ui/ returns HTML
```

---

## Task 1: Serve the web viewer at /ui/

**Files:**

- Create: `packages/rc-gateway/public/index.html`
- Modify: `packages/rc-gateway/src/server.ts`
- Test: `packages/rc-gateway/src/server.test.ts`

- [ ] **Step 1: Add failing serving tests** to `server.test.ts` (append inside `describe('gateway app', ...)`):

```ts
it('serves the web viewer at /ui/ without auth', async () => {
  const { url } = await boot();
  const res = await fetch(`${url}/ui/`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/html');
  expect(await res.text()).toContain('qwen-rc viewer');
});

it('404s unknown /ui assets', async () => {
  const { url } = await boot();
  const res = await fetch(`${url}/ui/does-not-exist.js`);
  expect(res.status).toBe(404);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/evan/projects/qwen-code && npx vitest run --root packages/rc-gateway server`
Expected: FAIL (`/ui/` → 404, no static route yet).

- [ ] **Step 3: Create `packages/rc-gateway/public/index.html`**

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
      #log {
        background: #111;
        color: #ddd;
        padding: 0.5rem;
        height: 50vh;
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

      let controller = null;
      $('stop').onclick = () => {
        if (controller) controller.abort();
      };

      $('watch').onclick = async () => {
        const token = localStorage.getItem(TOKEN_KEY);
        if (!token) return setStatus('pair first');
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
              headers: { Authorization: 'Bearer ' + token },
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
              try {
                log(JSON.stringify(JSON.parse(payload)));
              } catch {
                log(payload);
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

- [ ] **Step 4: Serve it in `server.ts`.** Add the `node:url` import at the top of the import block:

```ts
import { fileURLToPath } from 'node:url';
```

Add `webRoot?` to `GatewayDeps`:

```ts
export interface GatewayDeps {
  daemon: DaemonClient;
  store: TokenStore;
  pairing: PairingService;
  /** Audit log path; defaults to ~/.qwen/rc/audit.log. */
  auditPath?: string;
  /** Static web-client root; defaults to the package's public/ dir. */
  webRoot?: string;
}
```

Inside `createGatewayApp`, register the static route BEFORE `app.use(bearerResolve(...))` — put it right after the `app.post('/rc/pair/redeem', ...)` line:

```ts
const webRoot =
  deps.webRoot ?? fileURLToPath(new URL('../public', import.meta.url));
app.use('/ui', express.static(webRoot));
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /home/evan/projects/qwen-code && npx vitest run --root packages/rc-gateway server`
Expected: PASS (existing 7 + 2 new = 9). The `text/html` + `qwen-rc viewer` assertions confirm `public/index.html` is served; the 404 confirms `express.static` rejects unknown paths.

- [ ] **Step 6: Commit**

```bash
git add packages/rc-gateway/public/index.html packages/rc-gateway/src/server.ts packages/rc-gateway/src/server.test.ts
git commit -m "feat(rc-gateway): serve minimal read-only web viewer at /ui/"
```

---

## Task 2: CLI banner + e2e + verification

**Files:**

- Modify: `packages/rc-gateway/src/cli.ts`
- Modify: `packages/rc-gateway/scripts/rc-gateway-e2e.mjs` — NOTE: the script is at `scripts/rc-gateway-e2e.mjs` in the REPO ROOT (`/home/evan/projects/qwen-code/scripts/rc-gateway-e2e.mjs`), not under the package.

- [ ] **Step 1: Add a viewer line to the CLI banner in `cli.ts`.** In the `app.listen` callback's `console.log([...])` array, add a line after the `listening on` line:

```ts
        `web viewer: http://127.0.0.1:${port}/ui/`,
```

- [ ] **Step 2: Extend the manual e2e** `scripts/rc-gateway-e2e.mjs` to assert the viewer serves. After the existing checks (and before `cleanup()` in the `try` block), add:

```js
// 7. The web viewer is served at /ui/ (public, HTML).
{
  const r = await fetch(`${gw}/ui/`);
  const body = await r.text();
  r.status === 200 && body.includes('qwen-rc viewer')
    ? ok('web viewer served at /ui/')
    : bad(`/ui/ returned ${r.status}`);
}
```

(`gw` is the gateway base URL variable already defined in the script; `ok`/`bad` are its existing helpers. If the variable names differ, adapt to the script's actual locals.)

- [ ] **Step 3: Typecheck, lint, build**

Run:

```bash
cd /home/evan/projects/qwen-code
npm run typecheck --workspace @qwen-code/rc-gateway
npm run lint --workspace @qwen-code/rc-gateway
npm run build --workspace @qwen-code/rc-gateway
```

Expected: clean. (`public/index.html` is not compiled by tsc and not linted by `eslint src` — it ships as a static asset.)

- [ ] **Step 4: Run the full package suite**

Run: `cd /home/evan/projects/qwen-code && npm run test --workspace @qwen-code/rc-gateway`
Expected: PASS — all green (server now 9; total ~62 across 11 files).

- [ ] **Step 5: Manual e2e (not gating, do once)**

Run:

```bash
node scripts/rc-gateway-e2e.mjs   # confirms /ui/ serves HTML against the real daemon
```

Then, for the real UI: `node packages/rc-gateway/dist/cli.js serve`, open `http://127.0.0.1:4170/ui/` in a browser, paste the printed owner pairing code, create/find a session id, and confirm events render. (Browser step is manual.)

- [ ] **Step 6: Commit**

```bash
git add packages/rc-gateway/src/cli.ts scripts/rc-gateway-e2e.mjs
git commit -m "feat(rc-gateway): cli banner + e2e assertion for /ui viewer"
```

---

## Self-Review

**Spec coverage** (design §Components / §Testing):

- Static client `public/index.html` (pair → localStorage token → fetch-stream SSE with bearer → render; Stop via AbortController; status/errors) → Task 1 Step 3. ✓
- `express.static` serving at `/ui/` before auth + `webRoot` dep (`new URL('../public', import.meta.url)`) → Task 1 Step 4. ✓
- Serving integration tests (200 html + marker, no-auth, 404 unknown) → Task 1 Step 1. ✓
- CLI banner line → Task 2 Step 1. ✓
- e2e `/ui/` assertion + manual browser proof → Task 2 Steps 2/5. ✓
- Key choices: same-origin/no-CORS (no CORS code added), no webui/bundler (plain HTML), token never in URL (Authorization header + localStorage only) → reflected in the client. ✓
- Deferred (interactivity, webui, cross-origin CORS, PWA) → correctly absent. ✓

**Placeholder scan:** No TBD/TODO; complete file content + exact edits. ✓

**Type/name consistency:** `GatewayDeps.webRoot?`; `fileURLToPath(new URL('../public', import.meta.url))`; `express.static(webRoot)` registered before `bearerResolve`. Test marker string `qwen-rc viewer` matches the `<title>` in `index.html`. The events route + `/rc/pair/redeem` paths the client calls match the existing routes. ✓

**Note:** `public/index.html` is a static asset — intentionally not TypeScript, not tsc-compiled, not covered by `eslint src`; its behavior is verified by the serving integration tests (delivery) + manual browser e2e (function). prettier/lint-staged only matches `*.{js,jsx,ts,tsx,json,md}`, so the HTML is committed as authored.

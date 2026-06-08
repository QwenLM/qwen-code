# RC Gateway — Prompt Sending Implementation Plan (Cycle 7)

> **For agentic workers:** Implement task-by-task with TDD. Steps use checkbox (`- [ ]`) syntax. All work is inside `packages/rc-gateway/` — ZERO edits to any file outside it.

**Goal:** Add a `write`-scoped `POST /rc/session/:id/prompt` route that proxies the SDK's `daemon.prompt()`, audited as `prompt_sent`, plus a viewer composer — completing "fully drive the agent from your phone."

**Architecture:** Fork-owned gateway proxying the unmodified daemon via `@qwen-code/sdk`. Symmetric to cycle 6 (permission approval). See design: `docs/superpowers/specs/2026-06-07-rc-gateway-prompt-sending-design.md`.

**Tech Stack:** TypeScript (NodeNext ESM), Express, vitest, `@qwen-code/sdk` `DaemonClient`.

**SDK contract (verified):** `daemon.prompt(sessionId, { prompt: PromptContentBlock[], _meta? }, signal?, clientId?) → Promise<{ stopReason: string }>`. `PromptContentBlock = { type:'text'; text:string } | Record<string,unknown>`. Long-lived (SDK bypasses its own timeout); cancellable via AbortSignal.

**Commit convention:** end every commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. License header on every new `src/*.ts`.

---

### Task 1: `write` scope

**Files:** Modify `src/scopes.ts`; `src/index.ts` (export). Test: `src/scopes.test.ts` if present else assert via server test.

- [ ] **Step 1:** Add `export const WRITE: RcScope = 'write';` (with a one-line doc comment) after `APPROVE` in `src/scopes.ts`, and add `WRITE` to `KNOWN_SCOPES` → `[OWNER, SESSION_READ, APPROVE, WRITE]`.
- [ ] **Step 2:** Export `WRITE` from `src/index.ts` (add to the `./scopes.js` export block).
- [ ] **Step 3:** `npm run typecheck --workspace @qwen-code/rc-gateway` → passes.
- [ ] **Step 4:** Commit: `feat(rc-gateway): add write scope`.

### Task 2: `prompt_sent` audit action

**Files:** Modify `src/auditLog.ts`.

- [ ] **Step 1:** Add `'prompt_sent'` to the `AuditAction` union and to the `AUDIT_ACTIONS` runtime array.
- [ ] **Step 2:** `npm run typecheck --workspace @qwen-code/rc-gateway` → passes.
- [ ] **Step 3:** Commit: `feat(rc-gateway): add prompt_sent audit action`.

### Task 3: stub daemon prompt endpoint

**Files:** Modify `src/testing/stubDaemon.ts`.

- [ ] **Step 1:** Add options `promptStatus?: number` (default 200) and `promptStopReason?: string` (default `'end_turn'`) to `StubDaemonOptions`.
- [ ] **Step 2:** Add handler `app.post('/session/:id/prompt', ...)`: if `promptStatus` is 200 respond `200 { stopReason: promptStopReason }`; else respond `promptStatus` with `{ error: 'stub error' }`. (Body ignored, like the permission handler.)
- [ ] **Step 3:** Commit: `test(rc-gateway): stub daemon prompt endpoint`.

### Task 4: prompt route (TDD)

**Files:** Create `src/routes/prompt.ts`, `src/routes/prompt.test.ts`. Modify `src/index.ts` (export `createPromptRoute`).

- [ ] **Step 1 (failing test):** Write `src/routes/prompt.test.ts` modeled on `permission.test.ts`. Build a tiny Express app that mounts `createPromptRoute(daemon, fakeAudit)` at `POST /rc/session/:id/prompt` (no auth middleware in the unit test — inject `req.rcClient` via a tiny middleware `(req,_res,next)=>{req.rcClient={id:'tok1',scopes:['write']};next()}` and `express.json()`). Use the real `DaemonClient` from `@qwen-code/sdk` pointed at `startStubDaemon(...)`. Cases:
  - `{ prompt: 'hello' }` → 200, body `{ stopReason: 'end_turn' }`.
  - `{ blocks: [{ type:'text', text:'hi' }] }` → 200.
  - `{}` and `{ prompt: '' }` and `{ blocks: [] }` → 400 `{ code:'invalid_prompt' }`.
  - stub with `promptStatus:500` → 502 `{ code:'daemon_unavailable' }`.
  - fakeAudit (an object collecting `record()` calls) captures one `prompt_sent` with `actorTokenId:'tok1'`, `target` = session id, `detail.stopReason:'end_turn'`, a numeric `detail.blocks`, and **assert the recorded entry contains no field equal to the prompt text** (e.g. assert `JSON.stringify(entry)` does not include `'hello'`).
- [ ] **Step 2:** Run `npm run test --workspace @qwen-code/rc-gateway -- prompt` → FAILS (module not found).
- [ ] **Step 3 (implement):** Create `src/routes/prompt.ts` per the design's route spec. Key points:
  - License header. `import type { RequestHandler } from 'express'; import type { DaemonClient, PromptContentBlock } from '@qwen-code/sdk'; import type { AuditRecorder } from '../auditLog.js';`
  - Parse body into `blocks: PromptContentBlock[]`: non-empty string `body.prompt` → `[{type:'text',text:body.prompt}]`; else non-empty array `body.blocks` → use verbatim; else `400 {error:'Invalid prompt',code:'invalid_prompt'}`.
  - `const controller = new AbortController(); req.on('close', () => controller.abort());`
  - `try { const result = await daemon.prompt(sessionId, { prompt: blocks }, controller.signal); ... } catch (e) { if (controller.signal.aborted) return; res.status(502).json({error:'Daemon unavailable',code:'daemon_unavailable'}); return; }`
  - On success: `void audit?.record({ action:'prompt_sent', actorTokenId: req.rcClient?.id, target: sessionId, detail: { stopReason: result.stopReason, blocks: blocks.length } });` then `res.status(200).json({ stopReason: result.stopReason });`
  - Guard the success/audit/response so they don't run if the response was already ended by an abort (check `res.writableEnded` or rely on the abort-catch path). Simplest: if `controller.signal.aborted` after the await, `return` without responding.
- [ ] **Step 4:** Export `createPromptRoute` from `src/index.ts`.
- [ ] **Step 5:** Run `npm run test --workspace @qwen-code/rc-gateway -- prompt` → PASSES.
- [ ] **Step 6:** Commit: `feat(rc-gateway): write-scoped prompt proxy route`.

### Task 5: wire route + boot grant

**Files:** Modify `src/server.ts`, `src/cli.ts`, `src/server.test.ts`.

- [ ] **Step 1 (failing server test):** In `src/server.test.ts`, add a test: boot the app with a stub daemon, mint a `write`-scoped token via a pairing code (follow the existing approve-scoped test pattern), `POST /rc/session/s1/prompt { prompt:'hi' }` with the bearer → expect 200 and `stopReason`. Also assert a `session:read`-only token → 403.
- [ ] **Step 2:** Run the server test → FAILS (route not wired).
- [ ] **Step 3 (implement):** In `src/server.ts`: import `WRITE` from `./scopes.js` and `createPromptRoute` from `./routes/prompt.js`; after the permission route add:
  ```ts
  app.post(
    '/rc/session/:id/prompt',
    requireScope(WRITE, audit),
    createPromptRoute(deps.daemon, audit),
  );
  ```
- [ ] **Step 4:** In `src/cli.ts`: import `WRITE`; change the mint to `pairing.mint([OWNER, SESSION_READ, APPROVE, WRITE])`; update the banner grants line to include `${WRITE}`.
- [ ] **Step 5:** Run server test → PASSES.
- [ ] **Step 6:** Commit: `feat(rc-gateway): wire prompt route; boot grant write`.

### Task 6: viewer composer

**Files:** Modify `public/index.html` (static asset — not tsc/eslint).

- [ ] **Step 1:** Promote the watched session id to a script-scoped variable: add `let watchedSessionId = null;` near `let controller = null;` and set `watchedSessionId = id;` at the start of the `$('watch').onclick` handler (after reading `id`).
- [ ] **Step 2:** Add markup after the `#cards` div: a `<section id="composer" style="display:none">` containing a `<textarea id="prompt" rows="3" style="width:100%"></textarea>` and `<button id="send">Send</button>`. Reveal it (`$('composer').style.display=''`) once streaming starts (in the watch handler after `setStatus('streaming')`).
- [ ] **Step 3:** Add a `send` handler: read textarea value (trim); if empty `setStatus('empty prompt')`; else disable button + `setStatus('sending…')`, `POST /rc/session/<watchedSessionId>/prompt` with `{prompt}` + bearer; on 200 clear textarea and `setStatus('sent: '+ (json.stopReason||'ok'))`; 400 → 'empty prompt'; 401/403 → 'not authorized'; else 'send failed ('+status+')'; finally re-enable button. All via `textContent`/value (XSS-safe).
- [ ] **Step 4:** Commit: `feat(rc-gateway): viewer prompt composer`.

### Task 7: e2e + full verification

**Files:** Modify `scripts/rc-gateway-e2e.mjs`.

- [ ] **Step 1:** Add an e2e check: with a `write`-scoped token (the boot grant now includes it), `POST /rc/session/<bogus>/prompt { prompt:'ping' }` against the real daemon → expect a non-2xx surfaced as 502 (daemon rejects unknown session). Bump the check count in the script's summary.
- [ ] **Step 2:** Run `npm run typecheck --workspace @qwen-code/rc-gateway && npm run lint --workspace @qwen-code/rc-gateway && npm run build --workspace @qwen-code/rc-gateway && npm run test --workspace @qwen-code/rc-gateway` → all green.
- [ ] **Step 3:** Run the e2e: `node scripts/rc-gateway-e2e.mjs` (it spawns a real `qwen serve`) → all checks pass.
- [ ] **Step 4:** Commit any e2e changes: `test(rc-gateway): e2e prompt check`.

## Self-review checklist (run before declaring done)

- All new `src/*.ts` have the license header.
- `KNOWN_SCOPES` includes `WRITE`; `AUDIT_ACTIONS` includes `'prompt_sent'`.
- Audit entry for `prompt_sent` contains NO prompt text (only stopReason + block count + ids).
- Client-disconnect aborts the daemon prompt and does not emit a 502.
- Zero files outside `packages/rc-gateway/` changed (except the two docs/ design+plan files).

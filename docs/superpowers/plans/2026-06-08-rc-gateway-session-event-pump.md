# RC Gateway — Session Event Pump (Cycle 10)

> **For agentic workers:** TDD, `- [ ]` steps. All work inside `packages/rc-gateway/` (+ repo-root `scripts/rc-gateway-e2e.mjs`). ZERO edits outside `packages/rc-gateway/`.

**Goal:** A `SessionEventPump` that holds the gateway's own persistent daemon-SSE subscriptions (discover sessions → subscribe per session → call the cycle-9 `notifier.notify`), so push fires with no browser open. Best-effort, never crashes the gateway.

**Design:** `docs/superpowers/specs/2026-06-08-rc-gateway-session-event-pump-design.md` (read it — full signatures + test plan).

**SDK (verified):** `daemon.capabilities()→{workspaceCwd?}`, `daemon.listWorkspaceSessions(cwd)→DaemonSessionSummary[]`, `daemon.subscribeEvents(id,{signal,lastEventId})→AsyncGenerator<DaemonEvent>` where `DaemonEvent={id?,v:1,type,data}`.

**Conventions:** license header; `.js` imports; commit per task ending with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; prettier pre-commit hook expected.

---

### Task 1: stub daemon capabilities + sessions endpoints

**Files:** `src/testing/stubDaemon.ts`.

- [ ] Add options: `workspaceCwd?: string` (default `'/stub/workspace'`), `sessions?: DaemonSessionSummary[]` (default `[]`), `capabilitiesStatus?: number` (default 200).
- [ ] `GET /capabilities`: if `capabilitiesStatus!==200` → that status + `{error}`; else `{ v:1, mode:'ready', features:[], modelServices:[], workspaceCwd }`. (Import `DaemonSessionSummary` type from `@qwen-code/sdk` for the option type; `mode` value just needs to be a string the SDK accepts — use whatever the type allows, e.g. `'ready'`; if the `DaemonMode` union rejects it, use a valid member found in the SDK types.)
- [ ] `GET /workspace/:cwd/sessions` → `{ sessions: opts.sessions ?? [] }` (ignore the `:cwd` param).
- [ ] typecheck. Commit: `test(rc-gateway): stub daemon capabilities + sessions`.

### Task 2: SessionEventPump (TDD)

**Files:** Create `src/webpush/pump.ts`, `src/webpush/pump.test.ts`. Export `SessionEventPump` from `src/index.ts`.

- [ ] **Failing test** `pump.test.ts` per the design's test bullets. Use a real `DaemonClient`→`startStubDaemon`, a fake notifier `{ notify: async (e,ctx)=>{ collected.push({e,ctx}) } }`, `pollMs:20`, `reconnectMs:0`, `sleep:async()=>{}`, and the `onDispatch` hook (or poll `collected`) with a deadline helper. Cases: dispatch of a `permission_request` for `s1`; session removed → loop aborted (no further dispatch); `capabilitiesStatus:500` → start resolves, 0 dispatch; empty sessions → 0 dispatch; `stop()` cleanly ends (no open handles → test process exits).
- [ ] Run `-- pump` → FAILS (module not found).
- [ ] **Implement** `src/webpush/pump.ts`. Entry type: `interface Loop { active: boolean; ctrl: AbortController; lastEventId?: number }`. Fields: `daemon`, `notifier`, opts (with defaults), `loops = new Map<string, Loop>()`, `workspaceCwd = ''`, `stopped = false`, `timer`.
  - `async start()`: `this.stopped=false`; try `const caps = await daemon.capabilities(); this.workspaceCwd = caps.workspaceCwd ?? ''` catch (log warn, leave ''). `await this.reconcile()`. Then `this.timer = setIntervalFn(()=>{ void this.reconcile() }, pollMs)`; `if (timer.unref) timer.unref()`.
  - `async reconcile()`: if stopped or no workspaceCwd → return. `let list; try { list = await daemon.listWorkspaceSessions(this.workspaceCwd) } catch { return }`. `const ids = new Set(list.map(s=>s.sessionId))`. For each `s` in list whose id is not in `loops` → `this.spawnLoop(s)`. For each tracked id NOT in `ids` → `loop.active=false; loop.ctrl.abort(); loops.delete(id)`.
  - `spawnLoop(s)`: `const loop = { active:true, ctrl:new AbortController() }; loops.set(s.sessionId, loop)`. Fire `void this.runLoop(s, loop)`.
  - `async runLoop(s, loop)`: `const name = opts.sessionName?.(s)`. `while (loop.active && !this.stopped) { try { for await (const ev of daemon.subscribeEvents(s.sessionId, { signal: loop.ctrl.signal, lastEventId: loop.lastEventId })) { if (typeof ev.id==='number') loop.lastEventId = ev.id; await this.notifier.notify({type:ev.type,data:ev.data},{sessionId:s.sessionId,sessionName:name}); this.opts.onDispatch?.(s.sessionId, ev); } } catch (err) { if (loop.ctrl.signal.aborted) break; } if (!loop.active || this.stopped) break; await this.sleep(this.reconnectMs); }`. (Loop exits cleanly when aborted; otherwise reconnects after backoff. Never rethrow.)
  - `async stop()`: `this.stopped=true; if (timer) clearIntervalFn(timer); for (const loop of loops.values()){ loop.active=false; loop.ctrl.abort() } loops.clear()`.
- [ ] Run `-- pump` → PASSES. Export from `src/index.ts`.
- [ ] Commit: `feat(rc-gateway): session event pump for push triggering`.

### Task 3: server.ts return-shape refactor

**Files:** `src/server.ts`, `src/server.test.ts`, `src/index.ts` (type exports if needed), and update `src/cli.ts` minimally so it compiles.

- [ ] Change `createGatewayApp` to return `{ app: Express; notifier?: PushNotifier }`. Build `sender`/`notifier` as today inside the `if (deps.vapid && deps.pushStore)` block; capture `notifier` in an outer `let notifier: PushNotifier | undefined`; `return { app, notifier }`.
- [ ] Update `src/cli.ts`: `const { app } = createGatewayApp({...})` (pump wiring comes in Task 4 — for now just destructure so it compiles).
- [ ] Update `src/server.test.ts` `boot()`: `const { app, notifier } = createGatewayApp(...)`; return `notifier` in boot's result object. Existing tests using `app` keep working. Add a test: stores supplied → `notifier` defined; a second `createGatewayApp` without vapid/pushStore → `notifier` undefined.
- [ ] Run full test suite → green. Commit: `refactor(rc-gateway): createGatewayApp returns { app, notifier }`.

### Task 4: CLI wires the pump

**Files:** `src/cli.ts`.

- [ ] `import { SessionEventPump } from './webpush/pump.js';`
- [ ] `const { app, notifier } = createGatewayApp({ daemon: handle.daemon, store, pairing, vapid, pushStore });`
- [ ] After `app.listen(...)` callback (or right after listen), if `notifier`: `const pump = new SessionEventPump(handle.daemon, notifier); await pump.start();` Keep `pump` in scope for shutdown. Add banner line `push pump: watching ${ ... }` — simplest: just print `push pump: started`.
- [ ] `shutdown`: `if (pump) await pump.stop();` before `await handle.stop()`.
- [ ] typecheck + build. Commit: `feat(rc-gateway): start session event pump on serve`.

### Task 5: e2e + full verification

**Files:** `scripts/rc-gateway-e2e.mjs`.

- [ ] The e2e already boots the real daemon+gateway via the CLI path or its own harness. If it constructs the gateway itself, ensure it still works with the new return shape. Add a check: the gateway process starts cleanly with the pump (no crash within a couple seconds of boot) — i.e., health still 200 after boot. (No event assertion; auto-push delivery is verified-locally-only.) If the e2e script doesn't use the pump path, just confirm it still passes unchanged and note that.
- [ ] Run ALL: `npm run typecheck && npm run lint && npm run build && npm run test` (each `--workspace @qwen-code/rc-gateway`) → green. Then `node scripts/rc-gateway-e2e.mjs` → pass.
- [ ] Commit: `test(rc-gateway): e2e pump boot check`.

## Self-review checklist

- Pump NEVER throws into the gateway: capabilities failure, listWorkspaceSessions failure, subscribe failure all caught + logged; `start()` always resolves.
- `stop()` aborts every loop and clears the interval → no leaked timers/sockets (the pump test must exit cleanly, proving no open handles).
- Reconnect preserves `lastEventId`; aborted loops do NOT reconnect; removed sessions' loops are aborted.
- `notifier.notify` is awaited per event (already never-throws from cycle 9).
- createGatewayApp return-shape change updated at BOTH call sites (cli.ts, server.test boot()); all prior tests green.
- timers `unref()`'d so they don't keep the process alive. Zero files outside packages/rc-gateway/ except the e2e script.

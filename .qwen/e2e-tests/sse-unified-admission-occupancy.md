# E2E test plan: unified SSE admission/occupancy (issue #17554, follow-ups 1+2)

Design: `docs/design/sse-unified-admission-occupancy.md`
Branch: `feat/sse-unified-admission-occupancy`

## Harness

- Daemon binary: baseline dry-run uses the globally installed `qwen`;
  verification uses `node dist/cli.js` after `npm run build && npm run bundle`.
- Scratch workspace per group: `/tmp/sse-uni-e2e/<group>/ws` (git-init not
  required; serve binds the directory). Runtime isolation:
  `QWEN_RUNTIME_DIR=/tmp/sse-uni-e2e/<group>/runtime`.
- Auth: `--require-auth` with a token file created per group; the token is
  read from the file by the driver and never printed.
- Driver: `.qwen/e2e-tests/sse-unified-admission-occupancy/load.mjs`
  (zero-dependency Node script, written during dry-run). Capabilities:
  - open REST event streams (`GET /session/:id/events`),
  - open ACP connections (WS upgrade + `initialize`, then GET SSE conn
    stream), counted separately,
  - hold/read modes, per-surface tallies of `200 / 503(code) / silent-close`,
  - probe `/health`, `/health?deep=1`, `/daemon/status?detail=full`,
  - enable local-control via `POST /workspace/local-control/enable` and open
    streams against the LAN authority with the pairing token.
- No model calls needed: parked sessions + ACP initialize exercise the
  admission/occupancy paths. Generation/artifact surfaces are covered by the
  behavior unit tests with a fake bridge (they need a generator; the E2E
  focus is the listener-level guarantee).

## G1 — Baseline gap (global `qwen`, pre-implementation)

Start: `qwen serve --hostname 127.0.0.1 --port 0 --require-auth --max-connections 12 --max-sse-connections 6 --workspace <ws>` (port read from the boot log/status file).

Steps and expected BASELINE behavior (the gap):

1. Open 6 ACP WS connections (initialize OK). Open 1 REST event stream.
   - `daemon/status`: `runtime.transport.restSseActive == 1`; no
     `streamOccupancy` field; `limits.maxSseConnectionsPerListener` absent.
   - deep health `connectedClients == 1` despite 7 long-lived streams.
2. Open 6 more ACP WS connections (total 12 WS + 1 REST = 13 > listener 12).
   - Baseline: no `sse_connection_limit_exceeded` refusal for ACP; sockets
     beyond the listener budget close silently at accept time (curl/fetch
     code 000 / ECONNRESET), `/health` becomes unreachable while saturated.
3. Record: occupancy invisible, cap REST-only, silent accept-time closes.

## G2 — Unified occupancy + aggregate cap (local bundle)

Same flags as G1 (`--max-connections 12 --max-sse-connections 6`).

1. Open 3 REST + 2 ACP SSE (on initialized connections) + 1 ACP WS = 6
   streams. Expect all admitted; status:
   - `streamOccupancy.total == 6`,
   - `bySurface.restEvents == 3`, `bySurface.acpSse == 2`,
     `bySurface.acpWs == 1`,
   - `byListener.primary == 6`,
   - `restSseActive == 3` (unchanged semantics),
   - deep health `connectedClients == 6 == connectedClientsMax` pair.
2. Attempt one more stream of EACH surface (REST, ACP SSE, ACP WS).
   - REST + ACP SSE: `503`, `Retry-After: 5`,
     `code == sse_connection_limit_exceeded`, `scope == "daemon"`,
     `limit == 6`, `active == 6`.
   - ACP WS: raw `HTTP/1.1 503` before upgrade (no 101), Retry-After 5.
   - `/health`, `/capabilities`, `/` stay 200 throughout.
3. Close one REST stream; the next ACP WS attempt is admitted (slot freed,
   aggregate back to 6). Close all; `streamOccupancy.total == 0`,
   `restSseActive == 0`, deep health `connectedClients == 0`.

## G3 — Per-listener clamp (local bundle, real LAN listener)

The listener clamp (floor(64×0.8)=51) must bind BEFORE the aggregate cap,
so start with `--max-connections 256 --max-sse-connections 204` and
saturate the LAN listener with 51 streams on one parked session (under the
per-session EventBus cap 64; no model calls). Then:

1. `POST /workspace/local-control/enable` → LAN authority + pairing token.
2. Open 51 REST event streams on the LAN authority (pairing token).
   - All admitted; `byListener['local-control'] == 51`,
     `limits.maxSseConnectionsPerListener['local-control'] == 51`.
3. Attempt stream 52 on LAN: `503` with `scope == "listener"`,
   `listener == "local-control"`, `limit == 51`, `active == 51`.
4. Simultaneously a REST stream on the PRIMARY authority is admitted
   (aggregate 204 not reached; primary clamp independent).
5. `/health` on the LAN authority stays 200 while its SSE fleet is clamped.
6. Close all LAN streams; `byListener['local-control'] == 0`.

Fallback if 51 concurrent LAN streams are impractical on the test host:
the behavior unit tests drive a tagged second listener with a tiny budget;
record the E2E as covered-by-unit with the reason.

## G4 — Sentinels and explicit override (local bundle)

1. `--max-sse-connections 0`: status `maxSseConnections == null`,
   `maxSseConnectionsPerListener` all null; 13 mixed streams on a
   12-socket listener are NOT refused by the app cap (listener-level silent
   close may still occur — that is the documented opt-out).
2. `--max-connections 10 --max-sse-connections 5`: aggregate 5 enforced
   across surfaces (6th mixed stream refused, `limit == 5`);
   `maxSseConnectionsPerListener.primary == 5`, pairing == 51.
3. `--max-connections 0 --max-sse-connections 4`: explicit cap still
   applies (4 admitted, 5th refused) with listener cap disabled.

## Regression sanity (all groups)

- `/health` shallow stays `{"status":"ok"}` with no new fields.
- REST rejection body/log shape unchanged for aggregate refusals
  (field-level parity with the #17502 guard suite).
- Daemon shuts down cleanly with streams open (no hang, no unhandled
  rejection in the log).

## Results

### G1 baseline dry-run (2026-11-17, global qwen 0.28.0, port 4195)

Note: global 0.28.0 predates #17502 (release commit `90a25646c9ea` is older
than `f992bcdd2374`), so `--max-sse-connections` does not exist there; G1 ran
with `--max-connections 12` only. The non-REST invisibility gap is present in
every released version including this one.

- 6 ACP WS + 1 REST stream open: `transport.restSseActive == 1`,
  `acp.wsStreams == 6`, deep health `connectedClients == 1` despite 7
  long-lived streams; no `streamOccupancy`, no `maxSseConnections`, no
  `connectedClientsMax`. **Occupancy invisible outside REST.**
- 6 more WS attempted (13 total > listener 12): `established: 5, refused: 0,
  silent: 1` — the 13th got "Received network error or non-101 status code"
  (silent accept-time close, no HTTP refusal). During saturation `/health`,
  `/capabilities`, `/` all `ECONNRESET`/`UND_ERR_SOCKET`; status fetch failed.
  **No explicit load shedding; diagnostic surface dark.**
- After release: status/deep-health reachable again, `restSseActive == 1`
  (the still-held REST stream), service recovered.

Evidence: `/tmp/sse-uni-e2e/g1/{daemon.log,ws-open.log,rest-open.log,ws-overflow.log}`.

### G2–G4 verification (local bundle, 2026-11-17, ports 4196/4197)

Bundle: `node dist/cli.js` after `npm run build && npm run bundle`;
discriminating string `sse_connection_limit_exceeded` present in
`dist/chunks/chunk-KI4HWOXX.js`.

**G2 (cap 6 / listener 12, port 4196)** — 3 REST + 2 ACP SSE + 1 ACP WS held
concurrently:

- `streamOccupancy.total == 6`, `bySurface {restEvents:3, acpSse:2, acpWs:1}`,
  `byListener.primary == 6`; `restSseActive == 3` (REST-only semantics kept);
  deep health `connectedClients == 6 == connectedClientsMax`;
  `limits.maxSseConnectionsPerListener {primary:6, local-control:51,
  remote-access:51}`.
- Overflow attempts: REST `503` body
  `{error:"Daemon SSE connection limit reached (6/6)...",
  code:"sse_connection_limit_exceeded", limit:6, active:6, scope:"daemon"}`;
  ACP SSE identical; ACP WS raw `HTTP/1.1 503 Service Unavailable` +
  `Retry-After: 5` BEFORE upgrade (curl upgrade probe).
- Saturation probes: `/health`, `/capabilities`, `/` all `200`.
- After release: `total == 0`, `restSseActive == 0`, `connectedClients == 0`;
  a fresh REST stream is readmitted (`established:1`). Zero silent refusals
  throughout.

**G3 (LAN clamp)** — NOT RUNNABLE on this host: `POST
/workspace/local-control/enable` returns `409 no_lan_interface` (en0 is
30.221.96.193, an office network outside RFC1918; no private IPv4
candidate). Covered instead by the behavior unit test `clamps the pairing
listener independently of the primary listener` (server.test.ts), which
drives the REAL `LocalControlService` (real pairing credential, real second
listener) with the LAN selection pinned to loopback: 51 LAN streams admitted,
52nd gets the listener-scoped 503 (`scope:"listener",
listener:"local-control", limit:51, active:51`), a primary stream still
admits, LAN `/health` stays 200, occupancy returns to baseline on close.

**G4a (explicit cap 5 / listener 10, port 4197)** — 3 REST + 1 ACP SSE + 1
ACP WS held: 6th REST attempt `503` with `limit:5, active:5, scope:"daemon"`;
status `maxSseConnections:5`, `perListener {primary:5, local-control:51,
remote-access:51}`, deep pair `5/5`.

**G4b (disabled sentinel `--max-sse-connections 0`, listener 10)** — 4 REST
+ 2 ACP SSE + 1 ACP WS all admitted (7 concurrent, zero refusals);
`maxSseConnections:null`, `perListener` all null, deep
`connectedClientsMax:null`; occupancy still observable (`total:7`).

Evidence: `/tmp/sse-uni-e2e/g2/*.log`, `/tmp/sse-uni-e2e/g4a-*.log`,
`/tmp/sse-uni-e2e/g4b-*.log`, `/tmp/sse-uni-e2e/g3/daemon.log` (enable 409).

### Regression summary

- New: sse-occupancy unit 18/18; unified behavior 4/4; btw 1/1;
  session-agents 9/9; artifact-library admission 2/2; hosted events 1/1.
- Red-first witness (wiring stashed, shared module kept): unified 3 red
  (occupancy 0 vs 5; 200 vs 503 ×2) + reporting-only test green; btw/agents/
  artifact/hosted all red on the pre-wiring tree. Logs:
  `/tmp/sse-uni-e2e/red-*.log`.
- #17502 pins unchanged: guard suite 7/7, T2.9 filter 51/51.
- Aux 8 files 318/318; run-qwen-serve + ACP transport + workspace-qualified
  + remote-access 1065/1065; hosted-harness full 832/832; SDK
  public-surface 28/28; REST-docs contract 15/15.
- server.test.ts full: 1483/1485 — the 2 reds (archive catalog invalidation,
  capabilities workspaceCwd) pass in isolation, touch no changed code path,
  and belong to the load-sensitive family documented in #17502's report.
- `npm run typecheck` exit 0; eslint + prettier clean on all changed files.
- Environment limitation: `packages/web-templates` build fails on this host
  at the export-html renderer size budget (2,140,080 > 2,140,000 bytes, 80
  over) — pre-existing, unrelated to this change (web-shell untouched);
  same-commit artifacts borrowed from the x7 checkout to satisfy the CLI
  test prerequisite.

### PR2 — Web Shell status row (follow-up 3)

- `DaemonStatusDialog.test.tsx` + `i18n.test.ts`: 109/109 (four new states:
  paired `6 / 204`, cap-only `204`, `0 / unlimited`, row absent for older
  daemons); web-shell typecheck exit 0; eslint/prettier clean.

### PR3 — deferred #17502 review pins (follow-up 4)

New describe "Deferred #17502 review pins" (5 tests, all green) with
executed mutation witnesses (mutant red → restored green):

- zero-budget opt-out at the arm gate (direct `createServeApp` embed;
  no idle interval armed, stalled writer never evicted) — mutant
  `writerIdleBudgetMs >= 0` red.
- budget-comparison discrimination (`0 < idleForMs < budget` stands down,
  past budget evicts; manual reaper ticks at +500ms / +2500ms on a 2000ms
  budget) — mutant with the `< budget` comparison removed red.
- explicit `maxSseConnections: 5` enforced at the 503 site (exact body) +
  deep-health `connectedClientsMax: 5` + readmission after release.
- admission-refusal WARN pinned with surface/listener/scope/sessionId
  context (fakeDaemonLog).
- `clearInterval(idleTimer)` + heartbeat timer cleared on stream close —
  mutant removing the idle clear red.

Hygiene landed with the pins:

- `expectCountsReleased` / `expectCountReleased` reconciled into one
  shared `expectSseSlotReleased(beforeActive, server?)`.
- The identical forced-stall write spies (TLS throw variant, default-arm,
  heartbeat) deduped into `spyOnForcedSseStall`; the semantically distinct
  one-shot-backpressure and observing spies stay inline.
- The heartbeat-only stall test ticks the captured 15s heartbeat callback
  manually — measured ~15.7s wait removed (test now ~1s); the
  backpressure-bypass mutant still red.
- Hand-rolled deadline read loops (two healthy-idle tests, arming suite)
  replaced by `readSseUntilMarker`, which keeps ONE pending read across
  wake ticks — the abandoned `reader.read()` promises that could swallow
  a frame are gone.
- Drain-stall eviction test now also asserts the shared slot is released.

Regression: T2.9 51/51, arming 5/5, unified 6/6, drain 1/1; cli typecheck
0 errors; eslint/prettier clean. **Full file: 1492/1492 passed, exit 0**
(`/tmp/sse-uni-e2e/green-pr3-full.log`) — zero flakes on the idle machine.
### G5 — review-round-2 behaviors (local bundle, 2026-11-18, port 4199)

Driver: `review-r2.mjs` (same directory). Daemon: head bundle,
`--max-connections 12 --max-sse-connections 6`, TWO workspaces.
**13/13 PASS** (`/tmp/sse-uni-e2e/r2/g5-results.log`):

- occupancy counts REST streams; deep health on the PRIMARY listener
  reports `listenerConnectedClients/Max == 3/6` matching
  `byListener.primary` / `perListener.primary`, aggregate pair `3/6`.
  (LAN-side pair: covered-by-unit, G3 reason — `no_lan_interface` here.)
- BTW at saturation (occupancy 6): duplicate requestId with a different
  question → `409 btw_request_conflict`; unknown resume → `410 btw_expired`.
  Requires the daemon-ISSUED clientId from `POST /session` (caller-asserted
  ids are `400 invalid_client_id`); one real side-question model call was
  made to create the first request (verification artifact).
- ACP at saturation: foreign `acp-session-id` → `403 Session not owned by
  this connection` (terminal, before the gate); connection-scoped stream →
  `503 sse_connection_limit_exceeded scope=daemon`.
- REST overflow: exact `503 + Retry-After: 5` body (`limit 6, active 6,
  scope daemon`); `/health` 200 throughout.
- Plural mount (`/workspaces/<secondary>/acp`): SSE 503 with the shared
  code; WS upgrade refused pre-upgrade with raw 503 + Retry-After 5.
- Access log: daemon.log carries `route=GET /acp
  code=sse_connection_limit_exceeded reason=daemon status=503 request
  completed` (14 matching lines across runs).
- Slots released to baseline on close; fresh stream readmitted.

### PR2 pr-ui-verify — four row states (2026-11-18, head 1e86fc1d386a)

Driver: `ui-row-states.mjs`; report: `pr-ui-verify-17663-r2.md`; screenshots
on fork branch `assets-pr17663` dir `pr17663-r2/` (raw 200 image/png each).
**4/4 PASS**, zero page errors: paired `6 / 204` (head bundle + 6 held
streams), cap-only exact `SSE admission (used / cap)204` (base-commit
`b2bdf590191a` bundle), `0 / unlimited` (`--max-sse-connections 0`), no row
(global qwen 0.28.0, pre-#17502). Dialog entry: rail More → Daemon Status;
row lives on the default Overview tab. Cap-only binary built in a detached
scratch worktree with a local-only 100-byte web-templates budget raise
(Node-version artifact; CI passes); scratch worktree removed after the run.

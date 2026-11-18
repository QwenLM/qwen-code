# Unified SSE admission and occupancy across daemon stream surfaces

[English](sse-unified-admission-occupancy.md) | [简体中文](sse-unified-admission-occupancy.zh-CN.md)

- Status: implemented and verified (same PR; see the validation plan and the
  E2E results in `.qwen/e2e-tests/sse-unified-admission-occupancy.md`)
- Date: 2026-11-17
- Issue: #17554 (follow-up to #17502, merged `f992bcdd2374`)
- Scope of this design: follow-ups 1 and 2 of #17554. Follow-up 3 (Web Shell
  status row) and follow-up 4 (deferred test pins from the #17502 review) are
  delivered as stacked follow-up PRs and are out of scope here.

## Problem statement

#17502 bounded the REST SSE fleet so it can no longer silently consume the
whole HTTP listener: an admission cap (`--max-sse-connections`, default 80% of
the effective listener cap), a default-on writer-stall reaper, RST force-close
that actually frees the slot, TCP keepalive, and
`limits.maxSseConnections` / `connectedClientsMax` observability. As documented
in that PR's Risk & Scope, the cap, reaper, and occupancy gauge cover
`GET /session/:id/events` only.

Every other long-lived stream surface still pins one listener slot per
connection without touching `activeSseCount`:

| Surface                                  | Route / class                                                                                                                                      | Existing bound                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Agent session events                     | `GET /workspaces/:workspace/agent/session-events` (`routes/session-agents.ts`)                                                                     | none per listener                 |
| Session generation                       | `POST /session/:id/generate` (`routes/session.ts`)                                                                                                 | generator lifetime                |
| Workspace generation                     | `POST /workspace/generate` (`workspace-generation.ts`)                                                                                             | generator lifetime                |
| Artifact library / side-question streams | `ArtifactLibraryStream` (`server/artifact-library-stream.ts`, used by the artifact-library read route and `streamBtwSnapshots` in `btw-stream.ts`) | request concurrency               |
| Hosted-harness events                    | `GET /session/:id/events` in the `hosted-harness` profile (`hosted-harness-session.ts`)                                                            | none per listener                 |
| ACP SSE                                  | `GET /acp` and `GET /workspaces/:workspace/acp` (`acp-http/sse-stream.ts`)                                                                         | ACP connection cap (64 per mount) |
| ACP WebSocket                            | WS upgrade on the same paths (`acp-http/index.ts`)                                                                                                 | ACP connection cap (64 per mount) |

Two gaps follow:

1. **Invisible, unbounded-by-the-cap occupancy.** The per-session EventBus
   subscriber cap (64) and the per-mount ACP connection cap (64) continue to
   bound these surfaces, but they are invisible to the SSE occupancy gauge and
   the admission cap. With multiple workspace mounts, ACP alone can exceed the
   listener headroom the cap reserves; a fleet of generation or agent-event
   streams can do the same. Saturation is neither observable nor rejected
   explicitly outside the REST event stream.
2. **No per-listener headroom guarantee.** The local-control and remote-access
   listeners keep their own 64-socket `maxConnections` budget. The app-level
   SSE cap is daemon-wide, not per listener, so a LAN listener can still
   saturate at 64 streams and take its pairing/health surface down at accept
   time — the exact failure #17502 fixed for the primary listener.

## Goals

- One occupancy accounting shared by every surface above. The by-surface /
  by-listener breakdown lives on `/daemon/status`
  (`runtime.transport.streamOccupancy`); deep health carries the aggregate
  pair (`connectedClients` / `connectedClientsMax`) plus the arriving
  listener's own pair (`listenerConnectedClients` /
  `listenerConnectedClientsMax`), not the full breakdown.
- The existing `--max-sse-connections` admission cap gates **all** these
  surfaces with the same explicit `503 + Retry-After: 5`
  (`sse_connection_limit_exceeded`) refusal the REST stream uses (ACP
  WebSocket upgrades get a body-less 503 before the upgrade).
- Per-listener admission clamps so the pairing listeners get the same 80%
  headroom guarantee as the primary listener.
- Additive wire changes only; existing fields keep their names. The REST
  stream's rejection body, log lines, and counting timing are preserved
  EXCEPT for the deliberate changes this design documents: the additive
  `scope` (and listener-scoped `listener`) refusal fields, the new
  pairing-listener clamp (a REST stream arriving on a pairing listener is
  refused at that listener's 51-stream clamp, or at the aggregate cap when
  that is lower), the `connectedClients`
  re-scope from REST-only to the aggregate, and the refusal's `active`
  value (with the `activeSseCount` log field): a daemon-scope refusal now
  reports `active` = `streamOccupancy.total`, a listener-scope refusal that
  listener's own count — not the REST-only count the base implementation
  logged and returned.

## Non-goals

- Extending the writer-stall reaper beyond `GET /session/:id/events`. The cap
  now bounds total occupancy on every surface; reaper coverage for the other
  surfaces is a separate concern (their lifecycles differ: generation streams
  end with the generator, ACP has an idle TTL, agent events have heartbeats).
- Web Shell `DaemonStatusDialog` rows (follow-up 3, stacked PR).
- The deferred #17502 review test pins and test hygiene (follow-up 4, stacked
  PR).
- Other WebSocket surfaces not listed in #17554 (`/cdp` tunnel, voice,
  MCP app sandbox, extra WS routes). They keep their own gates; the occupancy
  gauge documents its surface set explicitly.
- Changing drain/shutdown wait semantics in `run-qwen-serve.ts`.

## Proposed solution

### Shared occupancy module

New module `packages/cli/src/serve/sse-occupancy.ts` owns all stream occupancy
state (module-level, matching today's `activeSseCount` placement):

- Surfaces: `restEvents`, `agentEvents`, `generation` (both generation routes),
  `artifactLibrary` (artifact-library read stream and side-question snapshots),
  `hostedEvents`, `acpSse`, `acpWs`.
- Counters: per surface, per listener kind (`primary`, `local-control`,
  `remote-access`), and a total. Listener kind resolves through the existing
  `listenerIdentityOf(req)` tag (falls back to `primary` for synthetic
  requests, exactly as the auth gate does).
- `getSseOccupancy()` returns a fresh snapshot
  `{ total, bySurface, byListener }` for status/health surfaces.
- `checkSseAdmission({ surface, req, res, caps, daemonLog?, logContext? })`
  is the gate: returns `true` when admitted; on saturation it sends the 503
  refusal itself and returns `false`. It checks the aggregate cap first, then
  the arriving listener's cap. No reservation is taken (same documented
  overshoot window as #17502: concurrent handshakes can exceed the cap by the
  number of in-flight admissions; the listener cap remains the hard backstop).
- `countSseStream(surface, req, res?)` increments the counters and returns an
  idempotent `release()`. When `res` is provided it also hooks
  `res.once('close', release)` so the slot is freed on every teardown path
  without threading a release call through each surface's cleanup.

The REST route keeps its early-check / late-count ordering: the gate runs
before the subscription handshake (load shedding), the count is taken where
`activeSseCount++` lives today, and `finalize` calls the explicit release.
All other surfaces check and count at their commit point (immediately before
the 200 headers / WS upgrade) and rely on the close-hooked release.

### Cap derivation

`daemon-status.ts` gains, next to the existing `sseMaxConnections` helper:

- `PAIRING_LISTENER_MAX_CONNECTIONS = 64` — the socket budget shared by the
  local-control and remote-access listeners. `local-control/service.ts` and
  `remote-access.ts` switch their private `64` literals to this constant so
  the budget and the derived clamp cannot drift.
- `resolveSseAdmissionCaps({ maxConnections, maxSseConnections })` returning
  `{ aggregate, byListener }`:
  - `aggregate = sseMaxConnections(...) ?? undefined` — the existing helper,
    unchanged (explicit override floors/clamps; `0`/`Infinity` and a disabled
    listener cap derive unlimited).
  - `byListener.primary = aggregate` — the aggregate is already clamped to the
    primary listener's 80% headroom ceiling.
  - `byListener['local-control'] = byListener['remote-access'] =`
    `aggregate === undefined ? undefined : max(1, floor(64 × 0.8))` = 51 when
    enabled. When the operator disables the cap, the per-listener clamps are
    disabled too — parity with the primary listener's opt-out semantics.

Both checks apply at admission: a stream is refused when the daemon-wide total
reaches the aggregate cap **or** its listener's occupancy reaches that
listener's clamp. With defaults (aggregate 204, pairing 51) the primary
listener keeps ≥52 slots for short requests, each pairing listener keeps ≥13
of its 64, and — absent concurrent in-flight handshakes, the reservation-free
window documented above — the combined fleet stays within 204. A configured
aggregate below 51 binds on every listener, pairing included.

### Refusal shape

The shared gate reproduces the REST refusal exactly for aggregate rejections:

- `503`, `Retry-After: 5`.
- Body: `{ error: "Daemon SSE connection limit reached (<active>/<limit>). Retry after the Retry-After interval.", code: "sse_connection_limit_exceeded", limit, active, scope }`
  where `scope` is `"daemon"` for the aggregate cap. Listener-scoped refusals
  use the listener's `active`/`limit` and add `scope: "listener"` plus the
  `listener` kind. `scope`/`listener` are additive fields; existing clients
  branch on `code`. `active` is the occupancy of the population the binding
  cap governs: the daemon total for a daemon-scope refusal, the arriving
  listener's own count for a listener-scope refusal — never the REST-only
  count, even when the refused request is a REST stream.
- `daemonLog.warn('SSE connection limit reached', { surface, listener, scope, activeSseCount, limit, ...logContext })`;
  the stderr fallback keeps today's byte-identical line
  `qwen serve: SSE connection limit reached (active=<n>, limit=<n>); rejecting new SSE client with 503`.
  The REST route passes `sessionId` in `logContext` as today.

For the ACP WS upgrade (no Express response), the refusal mirrors the existing
drain rejection written on the raw socket:
`HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\n\r\n` then destroy,
logged through the existing upgrade-rejection log line with the cap details
(`sse-connection-limit scope=<scope> active=<n> limit=<n>`).

### Surface wiring

| Surface                  | Gate placement                                                                                                                                                     | Count / release                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `restEvents`             | existing early check, replaced by the shared gate                                                                                                                  | existing late count site with the `res` close-hook/destroyed backstop; explicit release in `finalize` (idempotent) |
| `agentEvents`            | after runtime/session-id validation, before 200 headers                                                                                                            | close-hooked release                                                                                               |
| `generation` (session)   | after bridge capability check, before 200 headers                                                                                                                  | close-hooked release                                                                                               |
| `generation` (workspace) | same                                                                                                                                                               | close-hooked release                                                                                               |
| `artifactLibrary`        | before `new ArtifactLibraryStream(res)` at the read route; for the BTW stream, terminal 409/410 precheck first, then the gate immediately before `btwStreams.open` | close-hooked release                                                                                               |
| `hostedEvents`           | after identity/epoch/cursor validation, before headers                                                                                                             | close-hooked release                                                                                               |
| `acpSse`                 | in `handleAcpGet` after connection validation AND the session-ownership 403 (authorization keeps its terminal code at saturation), before either stream branch     | close-hooked release                                                                                               |
| `acpWs`                  | before `wss.handleUpgrade` on the ACP path (extra WS routes keep their own gates); refusal written on the raw socket                                               | counted in the upgrade callback, released in the existing `ws.on('close')`                                         |

Caps flow from `createServeApp` (`resolveSseAdmissionCaps(opts)`) through each
route registrar's deps. Every deps entry is optional: direct embeds and unit
fixtures that omit caps keep today's unlimited behavior.

### Reporting

- `runtime.transport.restSseActive` — unchanged (REST event surface only).
- `runtime.transport.streamOccupancy` — additive:
  `{ total, bySurface, byListener }` from `getSseOccupancy()`. Includes
  `acpWs`: the gauge measures listener-slot occupancy, not SSE frames.
- `limits.maxSseConnections` — unchanged (aggregate cap).
- `limits.maxSseConnectionsPerListener` — additive:
  `{ primary, 'local-control', 'remote-access' }`, each `number | null`
  (`null` = unlimited), from the same resolver.
- `GET /health?deep=1`: `connectedClients` broadens from the REST-only count
  to `streamOccupancy.total` so the occupancy/cap pair shares one scope — a
  probe must see ACP/generation saturation against the same cap that refuses
  it. `connectedClients` was introduced by #17502 with the REST-only scope;
  this design widens it deliberately and documents the change.
  `connectedClientsMax` stays the aggregate cap. Additive
  `listenerConnectedClients` / `listenerConnectedClientsMax` report the
  arriving listener's governing pair: the bound is the tighter of the
  aggregate cap and that listener's clamp from the same `caps.byListener`
  the gate uses (the aggregate itself on primary, 51 on pairing listeners;
  `null` = unlimited), since the gate tests the aggregate first and a lower
  aggregate binds on every listener; the numerator counts the population
  that bound governs — the daemon total when the aggregate cap binds, the
  listener's own streams when its clamp binds — so the pair cannot read as
  free headroom on a listener that is already refusing (review R1-6).
- Every HTTP saturation refusal calls `markAccessLogError` with
  `sse_connection_limit_exceeded` so the access log attributes the branch
  (the `{error, code}` convention); the ACP WS refusal writes the raw socket
  pre-upgrade and has no access-log line (review R1-7).
- `run-qwen-serve.ts` bootstrap status gains `maxSseConnectionsPerListener`
  next to the existing `maxSseConnections`.
- SDK mirror (`sdk-typescript/src/daemon/types.ts`): additive optional
  `limits.maxSseConnectionsPerListener` and `runtime.transport.streamOccupancy`
  with string-keyed records (the SDK widens daemon unions to strings by
  convention).

### Documentation

Same-PR updates everywhere the "REST events only" scope claim appears:
`docs/users/qwen-serve.md` (flag table, threat-model scope note),
`docs/developers/daemon/17-configuration.md`,
`docs/developers/daemon/20-quickstart-operations.md`,
`docs/developers/qwen-serve-protocol.md` (status and deep-health examples),
the public `ServeOptions.maxSseConnections` JSDoc and the
`--max-sse-connections` `--help` copy, and the two earlier design records
(`daemon-global-deep-health.md`, `daemon-idle-detection-api.md` — updated
rows plus superseded-by notes). The reaper's REST-only scope stays
documented as-is.

## Design decisions and rationale

1. **One aggregate counter plus per-surface/per-listener breakdowns**, not
   per-surface caps. The issue asks for saturation to be observable and
   bounded everywhere; a single admission budget with breakdowns keeps the
   operator knob (`--max-sse-connections`) singular and matches the existing
   helper. Per-surface caps would multiply configuration without a stated
   need.
2. **ACP WS counts and is gated.** A WS connection pins a listener slot exactly
   like an SSE stream; leaving it outside the aggregate would leave the same
   exhaustion hole through a different surface. The per-mount ACP connection
   cap (64) remains as a protocol-level bound; the aggregate is the
   listener-level one. Gate placement before `handleUpgrade` means a refused
   client sees an HTTP 503, not a successful upgrade followed by a close.
3. **`connectedClients` broadens to the aggregate.** A gauge paired with a cap
   must share the cap's scope; otherwise a fleet of ACP streams reads as zero
   occupancy while the cap is full. The field is one day old (#17502) and its
   consumers pair it with `connectedClientsMax`.
4. **Close-hooked release on every HTTP surface.** Every teardown path of an
   HTTP response ends in `'close'`; hooking it once avoids threading a release
   call through each surface's distinct cleanup (generation `finally`,
   artifact `onClose`, hosted `stop`, ACP `SseStream.close`). The REST route
   ALSO keeps its explicit `finalize` release (idempotent, so the double path
   is safe): the explicit release preserves its counting timing, while the
   close hook / destroyed-guard backstops a client abort inside the async
   subscription handshake window, whose `'close'` can fire before the route's
   own finalize listeners register — without the backstop that abort leaks a
   shared slot permanently (found in review; pinned by a regression test).
5. **Early check / late count preserved for REST.** Moving the count before
   the subscription handshake would change the documented overshoot window
   and the 429/404 paths' counting behavior; the existing ordering is pinned
   by tests and stays.
6. **Cap helpers live in `daemon-status.ts`.** Status surfaces already import
   `sseMaxConnections` from there; placing the resolver beside it keeps
   `sse-occupancy.ts` a leaf-ward module and avoids a status↔occupancy import
   cycle. The occupancy snapshot reaches status through an injected getter,
   the same pattern as `getRestSseActive`.
7. **Module-level counters.** Matches today's `activeSseCount` placement.
   Direct embeds in one process share the counters, as they already do; tests
   assert before/after deltas.

## Constraints and risks

- **Reservation-free window.** As in #17502, concurrent admissions can
  overshoot the cap by the number of in-flight handshakes; the listener's
  `maxConnections` remains the hard backstop. The cap stops gradual
  accumulation, which is its stated job.
- **ACP reconnect under saturation.** A reconnecting ACP SSE stream refused
  with 503 will not be retried by `EventSource`-style clients (5xx is
  terminal). This is the intended load-shedding behavior — the same contract
  the REST stream already has — and the slot frees as soon as the stalled
  fleet drains. SDK reconnect loops should back off on 503.
- **Shared counters across embeds.** Multiple `createServeApp` instances in
  one process share occupancy (pre-existing behavior for `activeSseCount`).
  Per-app isolation is not introduced here.
- **Hosted-harness profile.** Its event handler now shares the aggregate cap;
  a hosted deployment that runs many streams per instance sees the same 204
  default. Operators can raise or disable it with the existing flag.
- **Reaper coverage unchanged.** A stalled writer on a non-REST surface still
  holds its slot until the client disconnects or the surface's own lifecycle
  ends; the cap bounds how many such slots can exist at once. Shutdown is
  the backstop: the listener close force-closes remaining connections after
  the close timeout — including upgraded sockets, which
  `closeAllConnections()` alone does not reach — releasing their slots
  (pinned by the shutdown tests).

## Files affected

- New: `packages/cli/src/serve/sse-occupancy.ts` (+ collocated unit test).
- `packages/cli/src/serve/daemon-status.ts` — pairing constant, resolver,
  status fields, injected occupancy getter.
- `packages/cli/src/serve/routes/sse-events.ts` — delegate counter/gate to the
  shared module; behavior preserved.
- `packages/cli/src/serve/routes/session-agents.ts`,
  `packages/cli/src/serve/workspace-generation.ts`,
  `packages/cli/src/serve/routes/session.ts` (generation, artifact-library,
  and the `streamBtwSnapshots` call site),
  `packages/cli/src/serve/hosted-harness-session.ts`,
  `packages/cli/src/serve/acp-http/index.ts` — gates + counting.
- `packages/cli/src/serve/btw-stream.ts` — `BtwStreamRequests.precheck` split
  out of `open` so the route decides the terminal 409/410 before the
  admission gate; `open` re-runs it (review R1-5).
- `packages/cli/src/serve/server.ts` — resolve caps once, thread through deps,
  wire status/health getters.
- `packages/cli/src/serve/routes/daemon-status.ts` — inject the occupancy
  getter into the status response builder.
- `packages/cli/src/serve/routes/health.ts` — `connectedClients` scope and
  the arriving listener's occupancy/governing-bound pair.
- `packages/cli/src/serve/local-control/service.ts`,
  `packages/cli/src/serve/remote-access.ts` — share the pairing budget
  constant.
- `packages/cli/src/serve/run-qwen-serve.ts` — bootstrap status field.
- `packages/sdk-typescript/src/daemon/types.ts` — additive mirror.
- Docs listed above; new behavior tests (red-first) in a collocated
  `sse-occupancy` test file plus surface-level additions where the harness
  already exists.

## Validation plan

1. **Red-first unit/behavior tests** on the pre-change tree:
   - occupancy snapshot fields absent / counters do not move for non-REST
     surfaces;
   - a saturated non-REST surface admits instead of refusing;
   - a LAN listener saturates at its socket budget without a listener-scoped
     refusal.
2. **Green after implementation**: per-surface count/release pairing (open →
   `bySurface`/`byListener`/`total` +1, close → back to baseline), aggregate
   503 with the exact code/Retry-After on each surface, listener-scoped 503 on
   a tagged local-control listener while the primary listener still admits,
   `/health` reachable throughout, WS pre-upgrade 503, status/deep-health
   field pairing, disabled sentinels (`0`/`Infinity`/listener `0`) and explicit
   override clamping through the resolver.
3. **Regression**: the existing SSE guard suite, T2.9 reaper suite,
   `run-qwen-serve.test.ts`, ACP transport suites, local-control/remote-access
   suites, SDK public-surface test; `npm run build && npm run typecheck`.
4. **E2E** (test plan in `.qwen/e2e-tests/`): real daemon from the local
   bundle; saturate via generation/agent-event streams and via ACP WS; verify
   explicit refusals, headroom probes, status/deep-health pairing, and slot
   release after drain. Baseline dry-run against the global `qwen` CLI first
   to record the gap.

## Acceptance criteria

- Every surface in the table increments the shared occupancy while open and
  releases it on close, on every teardown path.
- At the aggregate cap, every surface refuses with
  `503 + Retry-After: 5 + sse_connection_limit_exceeded` (WS: raw-socket 503
  before upgrade); short requests keep serving.
- At a pairing listener's clamp, streams arriving on that listener are refused
  with the listener-scoped body while other listeners still admit.
- `daemon/status` reports `streamOccupancy` and `maxSseConnectionsPerListener`;
  deep health's `connectedClients` equals `streamOccupancy.total` and pairs
  with `connectedClientsMax`, and the arriving listener's
  `listenerConnectedClients` / `listenerConnectedClientsMax` pair matches the
  clamp that governs it.
- The REST stream's rejection body, log lines, and counting timing are
  preserved except the documented additive `scope`/`listener` fields, the
  pairing-listener clamp, and the `connectedClients` re-scope; all #17502
  test pins stay green without retargeting.
- Terminal authorization/outcomes keep their status codes at saturation:
  a foreign ACP session id still gets 403, and BTW duplicate/expired requests
  still get 409/410 (the gate decides resource admission only).
- Every HTTP saturation refusal is attributed in the access log with
  `code: sse_connection_limit_exceeded`.
- Disabled sentinels and explicit overrides behave exactly as the existing
  `sseMaxConnections` contract, extended per listener.

## Open questions / follow-ups

- Follow-up 3 (Web Shell row) and follow-up 4 (deferred test pins) land as
  stacked PRs on top of this change.
- Resolved by #17712: reaper coverage stays REST-only by decision — the
  non-REST surfaces have heterogeneous lifecycles (generator completion,
  ACP idle-TTL, heartbeats), so a per-surface writer-stall reaper is a
  separate design; the stalled non-reading peer bound is documented instead
  (users guide scope note and Constraints above). The `remote-access`
  pairing listener now carries the same end-to-end admission pin as
  `local-control` (clamp, listener-scoped refusal, access-log attribution,
  deep-health pair), and shutdown drain coverage is pinned for the
  generation and ACP surfaces (open streams neither hang `handle.close()`
  nor leak their slots, including an upgraded peer that never answers a
  close frame); the remaining counted surfaces share the same release hook
  but have no shutdown pin yet.

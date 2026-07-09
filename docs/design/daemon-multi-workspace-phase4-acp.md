# Daemon Multi-Workspace Phase 4: Workspace-Qualified ACP

## Summary

This document designs Phase 4 of issue #6378: workspace-qualified ACP for
`qwen serve`. It builds directly on the Phase 3 workspace-qualified REST branch
(`codex/phase3-workspace-qualified-rest`, PR #6567), which is **not yet merged**
(state `CHANGES_REQUESTED`). Phase 4 mounts a per-workspace ACP endpoint at
`/workspaces/:workspace/acp`, gives each workspace runtime its own ACP
dispatcher and connection state, and lets the Web Shell pick a workspace from
`/capabilities`. Legacy `/acp` stays bound to the primary runtime so existing
Web Shell and ACP clients are unaffected.

Phase 4 is scoped to the ACP transport (Streamable HTTP + the reverse `/acp`
WebSocket, its mirrored workspace methods, and reverse MCP/CDP). Voice
(`/workspaces/:workspace/voice/stream`) and daemon-managed channel workers are
**Phase 4b**; dynamic workspace add/remove is **Phase 5**. Neither is in scope
here.

The core finding from the seam investigation: Phase 4 is mostly a *wiring and
routing* change, not a rewrite. `AcpDispatcher` is already workspace-bound by
construction, its `workspaceCwd` consistency check already exists, Phase 3
already made the mirrored REST surface per-runtime, and `clientMcpSenderRegistry`
is already a per-runtime field. The real work is (1) turning the single ACP mount
into one dispatcher per runtime (each with its own remember-lane; still one
`mountAcpHttp` call and one upgrade listener; an `AcpHttpHandle` that owns every
runtime's registry), (2) extending that WebSocket upgrade listener to dispatch by
URL path, (3) making the device-flow registry per-runtime, and (4) syncing the
new `workspace_qualified_acp` capability tag across the SDK/CLI capability types
and tests.

## Dependencies on Phase 3 (unmerged)

Phase 4 consumes these Phase 3 seams. Because PR #6567 is `CHANGES_REQUESTED`,
treat them as *to-be-stabilized*; Phase 4 implementation must rebase onto the
merged Phase 3.

- `packages/cli/src/serve/workspace-route-runtime.ts`:
  - `resolveRegisteredWorkspaceRuntimeByPathSelector(registry, selector)` — pure
    function, returns `WorkspaceRuntime | undefined`. **Reusable by the WS
    upgrade listener** (see Open Questions).
  - `resolveWorkspaceRuntimeFromParam(registry, req, res, param)` — Express-bound
    (writes `res.status().json()`). **Usable for the HTTP ACP routes, not for the
    WS upgrade path** (the upgrade listener has only a raw `IncomingMessage` +
    `socket`, no Express `res`).
  - `requireTrustedWorkspaceRuntime(runtime, res)` — Express-bound trust gate,
    reused by the HTTP ACP routes.
  - `isPortableAbsolutePath` / `sendWorkspaceMismatch` — reused for selector
    parsing and error shape.
- Per-runtime REST handlers registered in `server.ts`
  (`registerWorkspaceQualified{FileRead,FileWrite,Trust,Status,Permissions,Settings,Lifecycle,McpControl,Tools}Routes`).
  The ACP dispatcher mirrors these surfaces; Phase 4 relies on their per-runtime
  behavior existing.
- `/capabilities` `workspaces[]` (Phase 2a), built in
  `packages/cli/src/serve/routes/capabilities.ts` (L79-84) and mirrored in
  `packages/cli/src/serve/daemon-status.ts` (L432-437) with `id` / `cwd` /
  `primary` / `trusted` per runtime. Feature-flag declarations and their
  advertise/toggle predicates live in
  `packages/cli/src/serve/capabilities.ts`.

## Baseline: current ACP seam (Phase 3 tree)

- `mountAcpHttp(app, primaryBridge, opts)` in
  `packages/cli/src/serve/acp-http/index.ts` is called once from `server.ts`
  (L1226-1275) with **all-primary** inputs: `primaryBridge`,
  `primaryBoundWorkspace`, `primaryWorkspace`, `primaryRouteFileSystemFactory`,
  the app-global `deviceFlowRegistry`, `primaryRuntime.clientMcpSenderRegistry`,
  and `primaryRuntime.env` (for the voice `extraWsRoute`).
- One dispatcher per mount: `mountAcpHttp` builds a single `AcpDispatcher` and a
  single `ConnectionRegistry`, and returns an `AcpHttpHandle` whose `registry` is
  that single registry and whose `attachServer` installs exactly one
  `httpServer.on('upgrade', ...)` listener (index.ts L1536, L1555). `dispose`
  removes that one listener and closes that one registry (index.ts L1543-1553).
- **Single WebSocket upgrade listener** (index.ts `setupWebSocket`, upgrade
  handler at L903-1045). It is installed once via
  `AcpHttpHandle.attachServer(server)` after `listen()`. It:
  - parses the upgrade URL,
  - rejects any path that is not `opts.path` (`/acp`), not `/cdp`, and not an
    `extraWsRoutes` entry — `socket.destroy()` on unknown path (index.ts
    L935-939),
  - runs shared security checks (loopback, host allowlist, CSRF/origin, bearer
    token) for **all** paths,
  - then branches: `/cdp` -> `attachCdpClient`; `extraRoute` -> `onConnection`;
    else the ACP initialize handshake.
  - The doc comment at L328-337 is explicit: a second `'upgrade'` listener cannot
    coexist because this one destroys unknown paths. Phase 4 must extend this one
    listener, not add another.
- `AcpDispatcher` (dispatch.ts L644-656) is already workspace-bound by
  constructor: `bridge`, `boundWorkspace`, `workspace`, `workspaceRememberLane`,
  `fsFactory?`, `deviceFlowRegistry?`, `sessionShellCommandEnabled`, `registry?`,
  `archiveCoordinator`. Every mirrored workspace method it serves reads these
  fields, so binding a dispatcher to a runtime automatically scopes file /
  permissions / settings / trust / tools / mcp / memory / agents / auth to that
  runtime.
- Two of those dispatcher deps are single-instance bound to primary today:
  `workspaceRememberLane = new WorkspaceRememberTaskLane(primaryBridge)`
  (server.ts L816) and `archiveCoordinator = new SessionArchiveCoordinator()`
  (server.ts L596). `sessionShellCommandEnabled` is a global policy, safe to
  share.
- Consistency check already exists: `parseRequestedWorkspace` (dispatch.ts
  L694-697) throws `WorkspaceMismatchError` when a request's `workspaceCwd` does
  not equal `this.boundWorkspace`; the error maps to `INVALID_PARAMS` (L577).
- `WorkspaceRuntime` (workspace-registry.ts L28-38) carries
  `clientMcpSenderRegistry` per runtime but has **no `deviceFlowRegistry`
  field** — device-flow is still app-global (`setupDeviceFlowRegistry({ app,
  bridge })` at server.ts L609, bound to the primary bridge).

## Architecture: per-runtime ACP mount

Keep Option B: one daemon, N independent workspace runtimes. For ACP:

- Each registered runtime gets its own `AcpDispatcher` + `ConnectionRegistry` +
  reverse-MCP provider factory + device-flow registry, all bound to that
  runtime's `bridge` / `workspace` / `routeFileSystemFactory` /
  `clientMcpSenderRegistry` / `env`.
- Legacy `/acp` stays bound to the primary runtime's dispatcher (unchanged wire
  behavior).
- New `/workspaces/:workspace/acp` binds to the resolved runtime's dispatcher.
- **Invariant: `mountAcpHttp` is still called exactly once** and installs exactly
  one `httpServer.on('upgrade', ...)` listener. It changes from "single bridge +
  opts" to accepting the `WorkspaceRegistry` (plus shared, non-workspace
  concerns: token, allowedOrigins, hostname, `checkRate`,
  `sessionShellCommandEnabled`, `cdpTunnelRegistry`). Internally it builds a
  `Map<workspaceId, RuntimeAcpMount>`; the primary entry stays addressable by the
  legacy `/acp` path.
- Each `RuntimeAcpMount` is constructed with that runtime's own `bridge`,
  `workspace`, `routeFileSystemFactory`, `clientMcpSenderRegistry`, `env`, a new
  per-runtime `deviceFlowRegistry`, a new per-runtime
  `WorkspaceRememberTaskLane(runtime.bridge)`, its `AcpDispatcher`, and its
  `ConnectionRegistry`. `archiveCoordinator` and `sessionShellCommandEnabled` can
  be shared unless per-workspace archive state requires otherwise (see Open
  Questions).
- All four dispatch entry points must select the resolved runtime's mount, not
  the primary one: `POST`, `GET` (SSE), and `DELETE` on the plural path (Express,
  via `resolveWorkspaceRuntimeFromParam`; today each closes over the single
  dispatcher at index.ts L533/L675/L849), plus the WS upgrade branch (below).
  Legacy `/acp` POST/GET/DELETE/upgrade keep dispatching to primary.
- `AcpHttpHandle` must grow from a single `registry` to owning every runtime's
  dispatcher + `ConnectionRegistry`; `dispose` closes all of them and removes the
  single upgrade listener.
- Session lifecycle: ACP `session/new` / `load` / `resume` on a plural mount must
  fire the same bridge-lifecycle `register` / `remove` callbacks that feed the
  Phase 2b `WorkspaceSessionOwnerIndex` (workspace-registry.ts L48-119). A session
  created over `/workspaces/B/acp` must then be discoverable by REST owner-routed
  reads (context, stats, etc.) and vice versa. Phase 2b already scoped this index
  to cover "REST and the later ACP dispatcher"; Phase 4 is where the ACP side is
  actually wired.

## WebSocket upgrade dispatch (core design)

The upgrade listener is the one place ACP routing is not Express-driven, so it
needs explicit path handling.

- Keep the shared security checks (loopback / host allowlist / CSRF / bearer)
  exactly as they are, applied uniformly before any workspace resolution.
- Extend path classification. Today: `pathname === '/acp' | '/cdp' | extraRoute`.
  Phase 4 adds a branch for `/workspaces/:workspace/acp`:
  1. Match the prefix and extract the raw `:workspace` selector segment.
  2. Resolve with the pure function
     `resolveRegisteredWorkspaceRuntimeByPathSelector(registry, decodeURIComponent(selector))`
     (id-first, then encoded canonical cwd, matching the REST resolver).
  3. On no match: reject the upgrade with a 400-class close
     (`socket.write('HTTP/1.1 400 ...')` + `destroy()`), mirroring the REST
     `workspace_mismatch`. No fallback to primary.
  4. On match: run the ACP initialize handshake against the resolved runtime's
     dispatcher + `ConnectionRegistry` (not the primary ones).
- Reverse `/cdp` and voice `extraWsRoutes` stay primary-bound in Phase 4 (voice
  is 4b). The `/cdp` branch is unchanged.
- Legacy `/acp` upgrade continues to bind to the primary dispatcher.
- `%2F` in the encoded cwd selector: the daemon parses the raw upgrade URL
  itself (`new URL(req.url, ...)`), so it is not subject to Express path
  decoding, but reverse proxies may still normalize `%2F`. Recommend the
  `id`-based selector for WS in proxy deployments (same guidance as Phase 2b/3
  REST). The HTTP plural routes instead reuse `resolveWorkspaceRuntimeFromParam`,
  which reads `req.params` (Express decodes once), so they inherit the Phase 3
  encoded-selector handling for free.
- Observability: the WS upgrade path and its ACP dispatch bypass Express
  middleware, so daemon telemetry/logging must stamp the resolved workspace
  explicitly here (the same reason `checkRate` is threaded through `opts`); the
  Phase 1 request-time workspace hashing only covers Express routes.

## Per-runtime device-flow registry

Device-flow is the one mirrored surface that is still app-global and must change.

- Add `deviceFlowRegistry` to `WorkspaceRuntime` (or build one per runtime inside
  `mountAcpHttp`). Each runtime's dispatcher receives its own registry.
- `setupDeviceFlowRegistry` must be invoked per runtime (bound to that runtime's
  bridge/env), not once against the primary bridge.
- Workspace-qualified auth routes/methods
  (`GET/DELETE /workspaces/:workspace/auth/device-flow/:id` and the ACP
  `_qwen/workspace/auth/device_flow/*` methods) must resolve the target runtime's
  registry and reject/hide flows that belong to another workspace.
- Shutdown must dispose every runtime's registry, not just
  `app.locals.deviceFlowRegistry`.
- Auth provider install callbacks are already `boundWorkspace`-scoped inside the
  dispatcher; per-runtime dispatchers make this correct automatically. Legacy
  primary auth routes keep writing primary.

## Dispatcher mirror surface (runtime binding)

The reverse `/acp` WS mirrors a large REST surface (index.ts `WS_READ_METHODS`
L186-219 and dispatch.ts vendor methods): file read/list/glob/stat, workspace
mcp / skills / providers / env / preflight / trust / permissions / voice / tools
/ agents / memory / auth, session groups, setup-github. Because these all read
the dispatcher's constructor fields, binding a dispatcher to a runtime scopes
them for free. Phase 4 does **not** re-implement them; it only ensures each
runtime's dispatcher is constructed with that runtime's dependencies. That set
explicitly includes the per-runtime `deviceFlowRegistry` and
`WorkspaceRememberTaskLane`: if either is left as the primary singleton,
non-primary `_qwen/workspace/memory/remember` and `auth/device_flow` calls would
silently run against the primary bridge.

Consistency guarantee: since each mounted dispatcher is runtime-bound and
`parseRequestedWorkspace` already throws `WorkspaceMismatchError` when a
request's `workspaceCwd` differs from `boundWorkspace`, a client that connects to
`/workspaces/A/acp` but sends `workspaceCwd: B` in params is rejected. Phase 4
should add a test asserting this, and confirm the same guard covers `session/new`
(`parseOptionalWorkspaceCwd`, dispatch.ts L1059).

## Reverse MCP / CDP isolation

- Reverse tool channel: the `clientMcpProviderFactory` currently closes over
  `primaryRuntime.clientMcpSenderRegistry` + `primaryBridge` (server.ts
  L1252-1257). Per-runtime mounts build the factory from the *resolved runtime's*
  `clientMcpSenderRegistry` + `bridge`, so a WS connection on `/workspaces/B/acp`
  registers client-hosted MCP servers in B's runtime only.
- Per-connection `ClientMcpWsConnection` and `cdpEndpoint` stay per-connection;
  they simply attach to the owning runtime's dispatcher.
- CDP tunnel: `cdpTunnelRegistry` is process-scoped and the CDP bridge is claimed
  by an extension `/acp` connection whose `clientInfo.name === 'qwen-cdp-bridge'`.
  Phase 4 keeps CDP claiming on legacy `/acp` (primary) as the pragmatic default;
  workspace-scoped CDP is called out as an Open Question rather than solved here,
  because a single loopback puppeteer client + one `/cdp` endpoint does not map
  cleanly to N runtimes. Concretely, non-primary `RuntimeAcpMount`s must leave
  the `cdpTunnelOverWs` / `/cdp` branch and the `chrome-devtools` runtime-MCP
  registration off; only the primary mount wires them.

## Trust gate

- Untrusted registered workspaces remain visible/read-only but must not spawn a
  child. On `/workspaces/:workspace/acp`, the ownership-granting ops
  (`session/new`, `session/load`, `session/resume`; dispatch.ts
  `CONN_ROUTED_METHODS` L239-243) must reject with an `untrusted_workspace` error
  and not spawn, matching the REST 403 `untrusted_workspace` semantics already
  implemented in `routes/session-runtime.ts` (L39-53) and `routes/session.ts`
  (session create/load/resume trust gates plus `session_workspace_conflict`).
- Reuse the trust decision that Phase 3 exposes via
  `requireTrustedWorkspaceRuntime` for the HTTP ACP routes; for the WS path the
  equivalent check runs on the resolved runtime's `trusted` flag before the
  handshake grants a session.
- Boot-frozen trust is the Phase 2a baseline; runtime trust flips
  (drain/stop the workspace's ACP child + clear its session index on revoke) stay
  aligned with whatever trust-mutation phase lands, and are not re-implemented
  here.

## Capabilities and Web Shell picker

- Add an ACP feature flag (e.g. `workspace_qualified_acp`) in
  `packages/cli/src/serve/capabilities.ts` (flag declaration + advertise/toggle
  predicate), advertised only when more than one runtime is registered and ACP is
  enabled (mirror the `multi_workspace_sessions` gating at capabilities.ts
  L408-409). If Phase 4 lands across multiple PRs, do not advertise the tag until
  the full plural ACP loop (HTTP + WS + device-flow + owner-index wiring) is
  complete, so clients never build `/workspaces/:id/acp` URLs against a half-wired
  surface (same half-enable guard philosophy as the Phase 2a feature gate).
  Update the note on `workspace_qualified_rest_core` (L264-271) that currently
  says "ACP/WebSocket, auth, voice, and extensions stay on their existing
  primary-workspace routes in this phase."
- Adding the tag is not local to `capabilities.ts`. It must be synced to: the
  `/capabilities` response builder in `routes/capabilities.ts`, the SDK
  capability types (`packages/sdk-typescript/src/daemon/types.ts`), the CLI serve
  types (`packages/cli/src/serve/types.ts`), and the feature-set assertion in
  `server.test.ts` (L376-381). This is required Phase 4 work, not optional.
- `workspaces[]` already exists (Phase 2a), built in `routes/capabilities.ts`
  (L79-84) and `daemon-status.ts` (L432-437) with `id` / `cwd` / `primary` /
  `trusted` per runtime. The Web Shell reads it and builds `/workspaces/:id/acp`
  connection URLs; the picker disables (or read-only marks) untrusted entries.
- The SDK `DaemonClient` (added in Phase 3) already reads `caps.workspaces[].cwd`
  for session routing; a workspace-qualified ACP connect helper is the natural
  extension. The capability-type sync above is required; the connect helper
  itself can follow.

## Failure paths

- `workspace_mismatch`: unknown WS/HTTP selector -> 400-class reject; never fall
  back to primary.
- `untrusted_workspace`: ownership-granting ACP op on an untrusted runtime ->
  reject, no spawn.
- `workspaceCwd` param mismatch: `WorkspaceMismatchError` -> `INVALID_PARAMS`
  (already wired).
- Child crash: isolated to the owning runtime; other runtimes' dispatchers and
  connections are unaffected (larger single-daemon fault radius is a documented
  known limitation).
- Trust revoked: when a trust-mutation phase lands, revoking a runtime must
  drain/stop its ACP child and clear its session index; Phase 4 only guarantees
  the per-runtime ACP mount is drainable, it does not add trust mutation itself.
- Global shutdown: dispose every runtime's dispatcher, `ConnectionRegistry`, and
  device-flow registry — not only the primary/app-global ones.
- Rate limiting: ACP HTTP/WS admission uses `checkRate` keyed per
  connection/session (index.ts L627-641, L1175-1178). The plural mounts share the
  one limiter; keys must stay unambiguous across runtimes so one workspace cannot
  exhaust or bypass another's budget.
- Capacity: `maxConnections` is enforced per-runtime `ConnectionRegistry`, so
  total ACP connections scale to N x `maxConnections` (a per-workspace budget,
  matching the `maxSessions` per-workspace model). Fresh-session total stays
  bounded by the Phase 2a `maxTotalSessions` admission at the bridge seam, which
  ACP session creation already passes through.

## Non-goals (Phase 4b / 5)

- `/workspaces/:workspace/voice/stream` and per-workspace voice settings (4b).
- Daemon-managed channel worker grouping / pidfile / status (4b).
- Dynamic workspace add/remove and lazy runtime create (5).

## Test strategy

- WS upgrade dispatch: unit-test path classification — `/acp` (primary),
  `/workspaces/:id/acp` (resolved), unknown selector (reject), `%2F`-encoded cwd
  selector, and that shared security checks still run for the plural path.
- Cross-workspace isolation: a connection on `/workspaces/A/acp` cannot see or
  drive a session owned by B; `session/list` and mirrored reads return only A's
  view.
- Cross-transport ownership: a session created via `/workspaces/B/acp` is
  resolvable by REST owner-routed reads (e.g. `GET /session/:id/stats`) and by
  `resolveLiveSessionOwner`, confirming ACP creation feeds the owner index.
- Consistency: connect to A, send `workspaceCwd: B` -> `WorkspaceMismatchError`.
- Trust gate: `session/new|load|resume` on an untrusted runtime -> rejected, no
  child spawned.
- Device-flow: a flow started under A is not visible/deletable via B's routes;
  shutdown disposes all runtimes' registries.
- Reverse MCP: `mcp_register` on `/workspaces/B/acp` lands in B's
  `clientMcpSenderRegistry` and B's bridge only.
- Rate limiting: prompts/mutations on `/workspaces/A/acp` and `/workspaces/B/acp`
  are metered independently and neither can bypass the shared limiter.
- Capabilities: `workspace_qualified_acp` advertised only with >1 runtime;
  `workspaces[]` shape unchanged.

## Open questions / feedback to Phase 3

1. **Keep `resolveRegisteredWorkspaceRuntimeByPathSelector` as a pure function.**
   The WS upgrade listener cannot use the Express-bound
   `resolveWorkspaceRuntimeFromParam`. Phase 4 depends on the pure resolver
   staying free of `req`/`res` coupling. If Phase 3 review changes that seam,
   preserve a pure `(registry, selector) => runtime | undefined` entry point.
2. **Device-flow per-runtime ownership: Phase 3 or Phase 4?** It is currently
   app-global. Phase 4 owns the change unless Phase 3 review prefers to add the
   `WorkspaceRuntime.deviceFlowRegistry` field earlier. Decide who lands the
   field to avoid a rebase collision.
3. **CDP tunnel per-workspace model.** One loopback puppeteer client + one `/cdp`
   endpoint does not map cleanly to N runtimes. Phase 4 keeps CDP on primary;
   confirm that is acceptable or scope a workspace-qualified CDP follow-up.
4. **Voice deferral.** Confirm voice stays primary-only until Phase 4b even
   though the ACP dispatcher already exposes `_qwen/workspace/voice` reads.
5. **`archiveCoordinator` scope.** It is a single `SessionArchiveCoordinator`
   today (server.ts L596). Confirm sharing it across runtimes is safe given Phase
   3's workspace-qualified archive/organization, or make it per-runtime.
6. **Rate-limit key dimensioning.** Decide whether ACP plural admission keys need
   an explicit workspace dimension, or whether per-connection/session keys are
   already unambiguous across mounts.

# Serve Runtime

## Overview

`packages/cli/src/serve/` is the boot layer for `qwen serve`. It translates CLI flags into `ServeOptions`, validates startup configuration, builds the Express app, wires middleware, registers routes, exposes daemon-host preflight/status providers, maintains the permission audit ring, and owns the two-phase graceful shutdown sequence. HTTP-facing work lives in this layer; ACP-facing work lives one layer below in `@qwen-code/acp-bridge` (see [`03-acp-bridge.md`](./03-acp-bridge.md)).

## Responsibilities

- Parse and validate `ServeOptions`: listen address, auth, workspace, session / connection caps, MCP budget / pool, CORS, prompt / SSE / session idle timeouts, rate limit, and related toggles.
- **Canonicalize** the primary workspace exactly once, and canonicalize every repeated `--workspace` before registering session runtimes. The primary canonical form is shared by `/capabilities.workspaceCwd`, the `POST /session` fallback, and the primary bridge.
- Reject unsafe or invalid startup configurations: non-loopback bind without token, `--require-auth` without token, wildcard or non-loopback HTTP(S) `--allow-origin` without token, `mcpBudgetMode='enforce'` without a positive `mcpClientBudget`, a nonexistent or non-directory `--workspace`, and invalid timeout or rate-limit values.
- Construct the `WorkspaceFileSystem` factory, permission audit publisher, `DaemonStatusProvider`, and `acp-bridge`.
- Build the Express app, wire middleware (`allowOriginCors` over the mutable origin allowlist -> `hostAllowlist` -> access log -> `bearerAuth` -> rate limit -> JSON parser -> telemetry -> per-route `mutationGate`), and mount session, workspace CRUD, file, device-flow auth, permission vote, and ACP HTTP routes. (The unconditional `denyBrowserOriginCors` wall remains only in the bootstrap app, `run-qwen-serve.ts`.)
- Bind the listening port and register signal handlers.
- Run two-phase shutdown on SIGINT/SIGTERM; force-exit on a second signal.

## Architecture

**Entry**: `runQwenServe(opts, deps)` in `packages/cli/src/serve/run-qwen-serve.ts`. Returns a `RunHandle` (`{ url, port, close, ... }`).

**App factory**: `createServeApp(opts, getPort, deps)` in `packages/cli/src/serve/server.ts`. Builds the Express `Application`. Direct embedders and tests call it without the bootstrap wrapper.

**Capability registry**: `SERVE_CAPABILITY_REGISTRY` in `packages/cli/src/serve/capabilities.ts`. Each tag has a `since` version and optional `modes`. Conditional tags are omitted when their deployment or runtime predicate is false; the registry and predicate map are the source of truth. See [`11-capabilities-versioning.md`](./11-capabilities-versioning.md).

**Middleware** (`packages/cli/src/serve/auth.ts` and `server.ts`):

| Middleware, in registration order | Purpose                                                                                                                                                                                                         | Notes                                                                                                                                                                                                                                                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allowOriginCors`                 | Always installed on the runtime app over a `MutableOriginAllowlist`: `--allow-origin <pattern>` entries seed it, Local Control adds the LAN origin while enabled; unmatched origins get the 403 deny envelope.  | See [`12-auth-security.md`](./12-auth-security.md).                                                                                                                                                                                                                                                                               |
| `hostAllowlist(bind, getPort)`    | On loopback, validate `Host` belongs to `localhost`, `127.0.0.1`, `[::1]`, `host.docker.internal`, or the exact bound loopback address, plus the actual port; port-less forms are accepted on ports 80 and 443. | Defense against DNS rebinding. Comparison is case-insensitive and cached per port. The Local Control LAN listener always enforces its advertised-authority Host check, whatever the primary bind is.                                                                                                                              |
| Access-log middleware             | Records method, path, status, durationMs, sessionId, and clientId to `DaemonLogger` when a request finishes.                                                                                                    | Registered **before** `bearerAuth`, so 401 denials are logged too. Skips `/health` and heartbeat.                                                                                                                                                                                                                                 |
| `bearerAuth(token)`               | SHA-256 plus `timingSafeEqual` constant-time bearer comparison.                                                                                                                                                 | Open passthrough when no token is configured (loopback dev default). `Bearer` scheme is case-insensitive.                                                                                                                                                                                                                         |
| Rate-limit middleware             | Optional per-tier token bucket for prompt, mutation, and read routes.                                                                                                                                           | Registered after `bearerAuth` and before JSON parsing; returns 429 before parsing when a bucket is exhausted.                                                                                                                                                                                                                     |
| `express.json({ limit: '10mb' })` | JSON body parsing.                                                                                                                                                                                              | Parse errors return 400.                                                                                                                                                                                                                                                                                                          |
| `daemonTelemetryMiddleware`       | Wraps classified daemon API requests that reach this point in an OpenTelemetry span through `withDaemonRequestSpan`.                                                                                            | Attributes include canonical route, resolved workspace hash, sessionId, clientId, and status code. Earlier auth, rate-limit, and body-parser rejections are outside this span boundary.                                                                                                                                           |
| `createMutationGate` (per-route)  | Route-level opt-in gate for mutations that require operator authority. Trusted primary-listener requests, bearer-authenticated requests, and paired Local Control requests qualify.                             | A token-less primary request that reaches the strict gate without trusted-loopback authority returns `401 { code: 'token_required' }`. Missing or invalid configured credentials are rejected earlier by bearer middleware with plain `401 Unauthorized`. Not global `app.use`; routes call `mutate({ strict: true })` as needed. |

**Subsystems**:

| Path                                                             | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serve/fs/`                                                      | `WorkspaceFileSystem` factory plus `policy.ts` (size/trust/binary checks), `paths.ts` (canonicalize, resolveWithin, symlink rejection), `audit.ts`, and typed `FsError` values.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `serve/routes/workspace-file-read.ts`, `workspace-file-write.ts` | HTTP handlers for `GET /file`, `GET /file/bytes`, `POST /file/write`, and `POST /file/edit`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `serve/routes/background-agents.ts`                              | `GET /background-agents` — the sessions the Agent View supervisor is running, read from the roster rather than from the daemon's own session model. Read-only: acting on one goes through the supervisor's socket, which the CLI does.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `serve/workspace-memory.ts`                                      | `GET/POST /workspace/memory` (QWEN.md CRUD).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `serve/workspace-agents.ts`                                      | `GET/POST/DELETE /workspace/agents` (subagent CRUD).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `serve/daemon-status-provider.ts`                                | Env snapshot plus daemon-host preflight cells: Node version, CLI entry, workspace stat, ripgrep, git, npm.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `serve/permission-audit.ts`                                      | `PermissionAuditRing` (512-entry FIFO) and `createPermissionAuditPublisher`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `serve/auth/device-flow.ts`, `qwen-device-flow-provider.ts`      | Device-flow OAuth routes. See [`12-auth-security.md`](./12-auth-security.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `serve/daemon-logger.ts`                                         | `DaemonLogger` structured file logs. See [`19-observability.md`](./19-observability.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `serve/debug-mode.ts`                                            | Shared `isServeDebugMode()` predicate controlling verbose error context in HTTP responses.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `serve/acp-http/`                                                | ACP Streamable HTTP transport (RFD #721), mounted at `/acp`. Seven files implement JSON-RPC POST, SSE GET, DELETE teardown, and shared bridge usage in parallel with the REST surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `serve/web-shell-static.ts`, `serve/web-shell-resolver.ts`       | Locate and mount the built Web Shell assets (the daemon's browser UI) at `/`, `/assets`, and `/session/:id`, plus the SPA deep-link fallback registered after all API routes. Mounted **before** `bearerAuth` in every launch mode because a browser cannot attach `Authorization` to a navigation or subresource. API calls follow the normal authority policy: configured tokens gate normal API routes except loopback `/health` unless `--require-auth` is set, while channel webhook ingress always uses its own shared secret and the token-less trusted-loopback primary listener has full operator access. Degrades to API-only when the assets are absent; `--no-web` opts out. |

**ACP bridge package imports**:

- Event-bus primitives are imported from `@qwen-code/acp-bridge/eventBus`.
- Status primitives are imported from `@qwen-code/acp-bridge/status`.
- `serve/acp-session-bridge.ts` remains as the CLI-local compatibility facade for the broader bridge surface.

## Flow

### Boot sequence

Before `runQwenServe()` starts this sequence, the CLI-only `--open-with-auth` mode validates loopback/Web Shell eligibility and fills `ServeOptions.token` with the selected configured token, or with 32 random bytes encoded as base64url when that selection is empty. Direct embedders and invocations without that default-off flag do not generate a token.

1. **Resolve and trim token** from `opts.token` or `QWEN_SERVER_TOKEN`; this
   avoids a trailing newline from `cat token.txt` silently breaking bearer
   comparison.
2. **Hostname typo guard**: `--hostname localhost:4170` errors and suggests `--port`.
3. **Auth preflight**: non-loopback without token refuses; `--require-auth` without token refuses.
4. **Workspace validation**: absolute path, exists, directory. `EACCES` / `EPERM` are wrapped to point at the flag.
5. **Canonicalize workspace**: `canonicalizeWorkspace(rawWorkspace)` runs `realpathSync.native` once and feeds `/capabilities`, the `POST /session` fallback, and the bridge.
6. **MCP budget validation**: positive integer; `enforce` requires a budget.
7. **MCP pool toggle inference**: parent env `QWEN_SERVE_NO_MCP_POOL=1` makes `mcpPoolActive=false`, so capabilities honestly omit `mcp_workspace_pool` and `mcp_pool_restart`.
8. **CORS / timeout / rate-limit validation**: wildcard and non-loopback HTTP(S) `--allow-origin` values require a token; prompt, writer, channel idle, session idle, reaper, and rate-limit window values fail fast when invalid.
9. **Per-handle `childEnvOverrides`**: pass `QWEN_SERVE_MCP_CLIENT_BUDGET` and `QWEN_SERVE_MCP_BUDGET_MODE` to the ACP child through `BridgeOptions.childEnvOverrides` instead of mutating `process.env`.
10. **Load `settings.json` once**: read `context.fileName`, `policy.permissionStrategy`, and `policy.consensusQuorum`. Corrupt files fall back to defaults. `validatePolicyConfig()` checks `policy.*` against `SERVE_CAPABILITY_REGISTRY.permission_mediation.modes`; unknown strategies or non-positive `consensusQuorum` throw `InvalidPolicyConfigError`. A quorum set under a non-`consensus` strategy logs a stderr warning.
11. **Allocate `PermissionAuditRing`** (512 entries).
12. **Build `fsFactory`**: `runQwenServe` defaults to `trusted: true`; direct `createServeApp` callers default to `trusted: false` and warn once.
13. **`createHttpAcpBridge`**, see [`03-acp-bridge.md`](./03-acp-bridge.md).
14. **`createServeApp`** assembles Express.
15. **Create and lifecycle-bind the HTTP(S) server before listening**, then call `server.listen(port, hostname)` and resolve the actual `getPort()` for host allowlist. Conversations ownership cannot start until this listener and the remaining host startup gates are ready.
16. **Register SIGINT / SIGTERM handlers** for graceful shutdown through the shared app lifecycle.

### Graceful shutdown

1. **Seal admission and begin all drains** on the first signal:
   - Dispose the device-flow registry and cancel pending flows.
   - `bridge.shutdown()` marks each channel `isDying = true`, sends graceful close to each ACP child stdin, waits `KILL_HARD_DEADLINE_MS` (10s) per channel, then calls `channel.kill()` if needed.
2. **Close the listener while app and host drains run**:
   - `server.close()` stops accepting new connections and lets in-flight requests finish.
   - `SHUTDOWN_FORCE_CLOSE_MS` (5s) triggers `server.closeAllConnections()`.
   - A second 2s deadline escalates again if needed.
3. **Release Conversations ownership only after positive shutdown proof** from the listener, app-local work, host-owned work, Live discovery cleanup, and runtime drains. Any incomplete proof rejects shutdown instead of allowing an unsafe handoff.
4. **Second signal while exiting**:
   - `bridge.killAllSync()` + `process.exit(1)` to avoid orphaned children blocking daemon exit.

## State and lifecycle

`RunHandle` exposes:

- `url`: resolved listen URL, after ephemeral port resolution.
- `port`: actual port, including `0` resolution.
- `close()`: programmatic shutdown for embedders and tests.

Calling `createServeApp` directly still returns only an `Application`. An embedder that needs Live/Conversations must create the actual Node server, call `getServeAppLifecycle(app).bindServer(server)` before its first `listen()`, and await `lifecycle.close()` during shutdown. Without binding, ordinary routes remain available but Live/Conversations fail closed. Calling raw `server.close()` triggers event-driven cleanup, but the embedder must still await `lifecycle.close()` to observe drain or ownership-release failures.

## Dependencies

| Upstream used by `serve/`                                                                       | Downstream using `serve/`                 |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `@qwen-code/acp-bridge`: bridge, event bus, status types                                        | The `qwen` CLI `serve` subcommand handler |
| `packages/core`: `getAllMemoryFilenames`, `Config`, `WorkspaceContext`                          | Direct embedders, tests                   |
| ACP SDK (`@agentclientprotocol/sdk`): `PROTOCOL_VERSION`, `ClientSideConnection` through bridge |                                           |
| Express + body-parser, `node:crypto`, `node:fs`, `node:path`                                    |                                           |

## Configuration

| Source          | Key                                                                                                        | Effect                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Env             | `QWEN_SERVER_TOKEN`                                                                                        | Bearer token after trim.                                                                                   |
| Env             | `QWEN_SERVE_NO_MCP_POOL=1`                                                                                 | Forces `mcpPoolActive=false`.                                                                              |
| ACP child env   | `QWEN_SERVE_MCP_CLIENT_BUDGET` / `QWEN_SERVE_MCP_BUDGET_MODE`                                              | Generated from `--mcp-client-budget` / `--mcp-budget-mode` and forwarded through `childEnvOverrides`.      |
| Env             | `QWEN_SERVE_PROMPT_DEADLINE_MS` / `QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS`                                      | Default prompt / SSE idle timeouts.                                                                        |
| Env             | `QWEN_SERVE_RATE_LIMIT*`                                                                                   | Rate-limit switch, prompt / mutation / read caps, and window default.                                      |
| Env             | `QWEN_SERVE_DEBUG=1`                                                                                       | Verbose stderr logs. See [`19-observability.md`](./19-observability.md).                                   |
| Flags           | `--hostname`, `--port`                                                                                     | Listen binding.                                                                                            |
| Flags           | `--token`, `--require-auth`, `--enable-session-shell`                                                      | Bearer token, loopback auth hardening, and explicit shell execution switch.                                |
| CLI flags       | `--open-with-auth`                                                                                         | Default-off loopback Web Shell launch that reuses or generates a process-lifetime bearer before runtime.   |
| Flag            | `--workspace`                                                                                              | Overrides `process.cwd()`; repeat to register additional isolated workspace runtimes.                      |
| Flags           | `--max-sessions`, `--max-pending-prompts-per-session`, `--max-connections`, `--event-ring-size`            | Bridge / Express caps.                                                                                     |
| Flags           | `--mcp-client-budget=N`, `--mcp-budget-mode={off,warn,enforce}`                                            | Forwarded to the ACP child.                                                                                |
| Flags           | `--allow-origin`, `--allow-private-auth-base-url`                                                          | Browser CORS allowlist and localhost/private auth provider installation switch.                            |
| Flag            | `--web` / `--no-web`                                                                                       | Serve or skip the Web Shell UI at the daemon root (default serves). `--no-web` leaves the daemon API-only. |
| Flags           | `--prompt-deadline-ms`, `--writer-idle-timeout-ms`, `--channel-idle-timeout-ms`, `--initialize-timeout-ms` | Prompt, SSE writer, ACP child idle lifecycle, and ACP child request timeout control.                       |
| Flags           | `--session-reap-interval-ms`, `--session-idle-timeout-ms`                                                  | Disconnected-session reaping control.                                                                      |
| Flags           | `--rate-limit*`                                                                                            | Per-tier HTTP rate limit.                                                                                  |
| `settings.json` | `policy.permissionStrategy`, `policy.consensusQuorum`                                                      | `MultiClientPermissionMediator` policy and quorum.                                                         |
| `settings.json` | `context.fileName`                                                                                         | Workspace memory filename passed to `/workspace/init` through the workspace-service `contextFilename`.     |

See [`17-configuration.md`](./17-configuration.md) for the merged reference.

## Caveats and known limits

- Direct `createServeApp` without `deps.fsFactory` or `deps.bridge` defaults to `trusted: false`; agent-side ACP `writeTextFile` rejects as `untrusted_workspace`. The warning is printed once.
- The runtime app runs `allowOriginCors` over the mutable allowlist; unmatched `Origin` values get the 403 deny envelope (the unconditional `denyBrowserOriginCors` wall survives only in the bootstrap app). The **loopback** Web Shell works because another middleware strips matching loopback same-origin values first — non-loopback binds require `--allow-origin` for the shell's XHRs.
- Body-parser ordering: routes using `mutate({ strict: true })` return 401 only after `express.json()`. The worst case is `--max-connections × express.json({limit: '10mb'})`, up to about 2.5 GB of transient memory on a saturated loopback listener; this tradeoff is intentional.
- Multiple daemons in one process must use per-handle `childEnvOverrides`; mutating `process.env` races because `defaultSpawnChannelFactory` snapshots env at spawn time.

## References

- `packages/cli/src/serve/run-qwen-serve.ts` (bootstrap, boot validation, graceful shutdown)
- `packages/cli/src/serve/server.ts` (`createServeApp()`, middleware and route assembly)
- `packages/cli/src/serve/auth.ts` (CORS, Host allowlist, bearer auth, mutation gate)
- `packages/cli/src/serve/rate-limit.ts` (per-tier HTTP rate limit)
- `packages/cli/src/serve/capabilities.ts` (capability registry and conditional advertisement)
- `packages/cli/src/serve/types.ts` (`ServeOptions`, `CapabilitiesEnvelope`)
- `packages/cli/src/serve/daemon-status-provider.ts`
- `packages/cli/src/serve/permission-audit.ts`
- Issues: [#3803](https://github.com/QwenLM/qwen-code/issues/3803), [#4175](https://github.com/QwenLM/qwen-code/issues/4175)

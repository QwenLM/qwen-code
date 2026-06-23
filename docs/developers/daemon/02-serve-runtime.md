# Serve Runtime

## Overview

`packages/cli/src/serve/` is the boot layer for `qwen serve`. It translates CLI flags into `ServeOptions`, validates startup configuration, builds the Express app, wires middleware, registers routes, exposes daemon-host preflight/status providers, maintains the permission audit ring, and owns the two-phase graceful shutdown sequence. HTTP-facing work lives in this layer; ACP-facing work lives one layer below in `@qwen-code/acp-bridge` (see [`03-acp-bridge.md`](./03-acp-bridge.md)).

## Responsibilities

- Parse and validate `ServeOptions`: listen address, auth, workspace, session / connection caps, MCP budget / pool, CORS, prompt / SSE / session idle timeouts, rate limit, and related toggles.
- **Canonicalize** the bound workspace exactly once. The same canonical form is shared by `/capabilities`, the `POST /session` fallback, and the bridge.
- Reject unsafe or invalid startup configurations: non-loopback bind without token, `--require-auth` without token, `--allow-origin '*'` without token, `mcpBudgetMode='enforce'` without a positive `mcpClientBudget`, a nonexistent or non-directory `--workspace`, and invalid timeout or rate-limit values.
- Construct the `WorkspaceFileSystem` factory, permission audit publisher, `DaemonStatusProvider`, and `acp-bridge`.
- Build the Express app, wire middleware (`denyBrowserOriginCors` / `allowOriginCors` -> `hostAllowlist` -> access log -> `bearerAuth` -> rate limit -> JSON parser -> telemetry -> per-route `mutationGate`), and mount session, workspace CRUD, file, device-flow auth, permission vote, and ACP HTTP routes.
- Bind the listening port and register signal handlers.
- Run two-phase shutdown on SIGINT/SIGTERM; force-exit on a second signal.

## Architecture

**Entry**: `runQwenServe(opts, deps)` in `packages/cli/src/serve/run-qwen-serve.ts`. Returns a `RunHandle` (`{ url, port, close, ... }`).

**App factory**: `createServeApp(opts, getPort, deps)` in `packages/cli/src/serve/server.ts`. Builds the Express `Application`. Direct embedders and tests call it without the bootstrap wrapper.

**Capability registry**: `SERVE_CAPABILITY_REGISTRY` in `packages/cli/src/serve/capabilities.ts`. Each tag has a `since` version and optional `modes`. Ten conditional tags (`require_auth`, `mcp_workspace_pool`, `mcp_pool_restart`, `allow_origin`, `prompt_absolute_deadline`, `writer_idle_timeout`, `workspace_settings`, `session_shell_command`, `rate_limit`, `workspace_reload`) are omitted when their corresponding toggle is off. See [`11-capabilities-versioning.md`](./11-capabilities-versioning.md).

**Middleware** (`packages/cli/src/serve/auth.ts` and `server.ts`):

| Middleware, in registration order           | Purpose                                                                                                                    | Notes                                                                                                             |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `denyBrowserOriginCors` / `allowOriginCors` | Deny all `Origin` headers by default; switch to an allowlist when `--allow-origin <pattern>` is configured.                | See [`12-auth-security.md`](./12-auth-security.md).                                                               |
| `hostAllowlist(bind, getPort)`              | On loopback, validate `Host` belongs to `localhost`, `127.0.0.1`, `[::1]`, or `host.docker.internal` plus the actual port. | Defense against DNS rebinding. Comparison is case-insensitive and cached per port.                                |
| Access-log middleware                       | Records method, path, status, durationMs, sessionId, and clientId to `DaemonLogger` when a request finishes.               | Registered **before** `bearerAuth`, so 401 denials are logged too. Skips `/health` and heartbeat.                 |
| `bearerAuth(token)`                         | SHA-256 plus `timingSafeEqual` constant-time bearer comparison.                                                            | Open passthrough when no token is configured (loopback dev default). `Bearer` scheme is case-insensitive.         |
| Rate-limit middleware                       | Optional per-tier token bucket for prompt, mutation, and read routes.                                                      | Registered after `bearerAuth` and before JSON parsing; returns 429 before parsing when a bucket is exhausted.     |
| `express.json({ limit: '10mb' })`           | JSON body parsing.                                                                                                         | Parse errors return 400.                                                                                          |
| `daemonTelemetryMiddleware`                 | Wraps each HTTP request in an OpenTelemetry span through `withDaemonRequestSpan`.                                          | Attributes include route, sessionId, clientId, and status code.                                                   |
| `createMutationGate` (per-route)            | Route-level opt-in gate for mutation routes that require token even on loopback.                                           | Returns `401 { code: 'token_required' }`. Not global `app.use`; routes call `mutate({ strict: true })` as needed. |

**Subsystems**:

| Path                                                             | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `serve/fs/`                                                      | `WorkspaceFileSystem` factory plus `policy.ts` (size/trust/binary checks), `paths.ts` (canonicalize, resolveWithin, symlink rejection), `audit.ts`, and typed `FsError` values.                                                                                                                                                                                                                                                                              |
| `serve/routes/workspace-file-read.ts`, `workspace-file-write.ts` | HTTP handlers for `GET /file`, `GET /file/bytes`, `POST /file/write`, and `POST /file/edit`.                                                                                                                                                                                                                                                                                                                                                                 |
| `serve/workspace-memory.ts`                                      | `GET/POST /workspace/memory` (QWEN.md CRUD).                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `serve/workspace-agents.ts`                                      | `GET/POST/DELETE /workspace/agents` (subagent CRUD).                                                                                                                                                                                                                                                                                                                                                                                                         |
| `serve/daemon-status-provider.ts`                                | Env snapshot plus daemon-host preflight cells: Node version, CLI entry, workspace stat, ripgrep, git, npm.                                                                                                                                                                                                                                                                                                                                                   |
| `serve/permission-audit.ts`                                      | `PermissionAuditRing` (512-entry FIFO) and `createPermissionAuditPublisher`.                                                                                                                                                                                                                                                                                                                                                                                 |
| `serve/auth/device-flow.ts`, `qwen-device-flow-provider.ts`      | Device-flow OAuth routes. See [`12-auth-security.md`](./12-auth-security.md).                                                                                                                                                                                                                                                                                                                                                                                |
| `serve/daemon-logger.ts`                                         | `DaemonLogger` structured file logs. See [`19-observability.md`](./19-observability.md).                                                                                                                                                                                                                                                                                                                                                                     |
| `serve/debug-mode.ts`                                            | Shared `isServeDebugMode()` predicate controlling verbose error context in HTTP responses.                                                                                                                                                                                                                                                                                                                                                                   |
| `serve/acp-http/`                                                | ACP Streamable HTTP transport (RFD #721), mounted at `/acp`. Seven files implement JSON-RPC POST, SSE GET, DELETE teardown, and shared bridge usage in parallel with the REST surface.                                                                                                                                                                                                                                                                       |
| `serve/demo.ts`                                                  | Self-contained inline HTML for `GET /demo`: browser debug console with chat UI, event log, and workspace inspector. On loopback without `--require-auth`, it is registered **before** `bearerAuth`; on non-loopback or with `--require-auth`, it is registered **after** `bearerAuth`. Served with CSP `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'` plus `X-Frame-Options: DENY`. |

**Re-export shims** for compatibility with pre-F1 import paths:

- `serve/event-bus.ts` -> `@qwen-code/acp-bridge/eventBus`
- `serve/status.ts` -> `@qwen-code/acp-bridge/status`
- `serve/httpAcpBridge.ts` -> `@qwen-code/acp-bridge`

## Flow

### Boot sequence

1. **Resolve and trim token** from `opts.token` or `QWEN_SERVER_TOKEN`; this
   avoids a trailing newline from `cat token.txt` silently breaking bearer
   comparison.
2. **Hostname typo guard**: `--hostname localhost:4170` errors and suggests `--port`.
3. **Auth preflight**: non-loopback without token refuses; `--require-auth` without token refuses.
4. **Workspace validation**: absolute path, exists, directory. `EACCES` / `EPERM` are wrapped to point at the flag.
5. **Canonicalize workspace**: `canonicalizeWorkspace(rawWorkspace)` runs `realpathSync.native` once and feeds `/capabilities`, the `POST /session` fallback, and the bridge.
6. **MCP budget validation**: positive integer; `enforce` requires a budget.
7. **MCP pool toggle inference**: parent env `QWEN_SERVE_NO_MCP_POOL=1` makes `mcpPoolActive=false`, so capabilities honestly omit `mcp_workspace_pool` and `mcp_pool_restart`.
8. **CORS / timeout / rate-limit validation**: `--allow-origin '*'` requires token; prompt, writer, channel idle, session idle, reaper, and rate-limit window values fail fast when invalid.
9. **Per-handle `childEnvOverrides`**: pass `QWEN_SERVE_MCP_CLIENT_BUDGET` and `QWEN_SERVE_MCP_BUDGET_MODE` to the ACP child through `BridgeOptions.childEnvOverrides` instead of mutating `process.env`.
10. **Load `settings.json` once**: read `context.fileName`, `policy.permissionStrategy`, and `policy.consensusQuorum`. Corrupt files fall back to defaults. `validatePolicyConfig()` checks `policy.*` against `SERVE_CAPABILITY_REGISTRY.permission_mediation.modes`; unknown strategies or non-positive `consensusQuorum` throw `InvalidPolicyConfigError`. A quorum set under a non-`consensus` strategy logs a stderr warning.
11. **Allocate `PermissionAuditRing`** (512 entries).
12. **Build `fsFactory`**: `runQwenServe` defaults to `trusted: true`; direct `createServeApp` callers default to `trusted: false` and warn once.
13. **`createHttpAcpBridge`**, see [`03-acp-bridge.md`](./03-acp-bridge.md).
14. **`createServeApp`** assembles Express.
15. **`server.listen(port, hostname)`**, then resolve the actual `getPort()` for host allowlist.
16. **Register SIGINT / SIGTERM handlers** for graceful shutdown.

### Graceful shutdown

1. **Phase 1 - bridge teardown** on first signal:
   - Dispose the device-flow registry and cancel pending flows.
   - `bridge.shutdown()` marks each channel `isDying = true`, sends graceful close to each ACP child stdin, waits `KILL_HARD_DEADLINE_MS` (10s) per channel, then calls `channel.kill()` if needed.
2. **Phase 2 - HTTP teardown**:
   - `server.close()` stops accepting new connections and lets in-flight requests finish.
   - `SHUTDOWN_FORCE_CLOSE_MS` (5s) triggers `server.closeAllConnections()`.
   - A second 2s deadline escalates again if needed.
3. **Second signal while exiting**:
   - `bridge.killAllSync()` + `process.exit(1)` to avoid orphaned children blocking daemon exit.

## State and lifecycle

`RunHandle` exposes:

- `url`: resolved listen URL, after ephemeral port resolution.
- `port`: actual port, including `0` resolution.
- `close({ timeoutMs? })`: programmatic shutdown for embedders and tests.

Calling `createServeApp` directly returns only an `Application`; the embedder owns `listen` and shutdown.

## Dependencies

| Upstream used by `serve/`                                                                       | Downstream using `serve/`                 |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `@qwen-code/acp-bridge`: bridge, event bus, status types                                        | The `qwen` CLI `serve` subcommand handler |
| `packages/core`: `loadSettings`, `getCurrentGeminiMdFilename`, `Config`, `WorkspaceContext`     | Direct embedders, tests                   |
| ACP SDK (`@agentclientprotocol/sdk`): `PROTOCOL_VERSION`, `ClientSideConnection` through bridge |                                           |
| Express + body-parser, `node:crypto`, `node:fs`, `node:path`                                    |                                           |

## Configuration

| Source          | Key                                                                                             | Effect                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Env             | `QWEN_SERVER_TOKEN`                                                                             | Bearer token after trim.                                                                              |
| Env             | `QWEN_SERVE_NO_MCP_POOL=1`                                                                      | Forces `mcpPoolActive=false`.                                                                         |
| ACP child env   | `QWEN_SERVE_MCP_CLIENT_BUDGET` / `QWEN_SERVE_MCP_BUDGET_MODE`                                   | Generated from `--mcp-client-budget` / `--mcp-budget-mode` and forwarded through `childEnvOverrides`. |
| Env             | `QWEN_SERVE_PROMPT_DEADLINE_MS` / `QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS`                           | Default prompt / SSE idle timeouts.                                                                   |
| Env             | `QWEN_SERVE_RATE_LIMIT*`                                                                        | Rate-limit switch, prompt / mutation / read caps, and window default.                                 |
| Env             | `QWEN_SERVE_DEBUG=1`                                                                            | Verbose stderr logs. See [`19-observability.md`](./19-observability.md).                              |
| Flags           | `--hostname`, `--port`                                                                          | Listen binding.                                                                                       |
| Flags           | `--token`, `--require-auth`, `--enable-session-shell`                                           | Bearer token, loopback auth hardening, and explicit shell execution switch.                           |
| Flag            | `--workspace`                                                                                   | Overrides `process.cwd()`.                                                                            |
| Flags           | `--max-sessions`, `--max-pending-prompts-per-session`, `--max-connections`, `--event-ring-size` | Bridge / Express caps.                                                                                |
| Flags           | `--mcp-client-budget=N`, `--mcp-budget-mode={off,warn,enforce}`                                 | Forwarded to the ACP child.                                                                           |
| Flags           | `--allow-origin`, `--allow-private-auth-base-url`                                               | Browser CORS allowlist and localhost/private auth provider installation switch.                       |
| Flags           | `--prompt-deadline-ms`, `--writer-idle-timeout-ms`, `--channel-idle-timeout-ms`                 | Prompt, SSE writer, and ACP child idle lifecycle control.                                             |
| Flags           | `--session-reap-interval-ms`, `--session-idle-timeout-ms`                                       | Disconnected-session reaping control.                                                                 |
| Flags           | `--rate-limit*`                                                                                 | Per-tier HTTP rate limit.                                                                             |
| `settings.json` | `policy.permissionStrategy`, `policy.consensusQuorum`                                           | `MultiClientPermissionMediator` policy and quorum.                                                    |
| `settings.json` | `context.fileName`                                                                              | `getCurrentGeminiMdFilename` override for the bridge.                                                 |

See [`17-configuration.md`](./17-configuration.md) for the merged reference.

## Caveats and known limits

- Direct `createServeApp` without `deps.fsFactory` or `deps.bridge` defaults to `trusted: false`; agent-side ACP `writeTextFile` rejects as `untrusted_workspace`. The warning is printed once.
- `denyBrowserOriginCors` rejects **all** requests carrying `Origin`; the demo page works because another middleware strips matching same-origin values first.
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

# Quickstart & Operations

This page focuses on **how to start `qwen serve`, how to verify that it is working, and what the internal call chain looks like from `qwen serve` to the listening server**. Architecture, components, and wire protocol details live in the other daemon deep-dive pages.

## 1. Shortest path

```bash
qwen serve
```

Output:

```text
qwen serve listening on http://127.0.0.1:4170 (mode=http-bridge, workspace=/your/cwd)
qwen serve: bound to workspace "/your/cwd"
qwen serve: trusted loopback mode; local callers have full API access without bearer authentication. Use --require-auth with QWEN_SERVER_TOKEN on shared or untrusted hosts.
```

Open `http://127.0.0.1:4170/` in a browser to get the Web Shell UI: chat, session list, and workspace inspection. This token-less loopback primary listener grants local callers full operator API authority, while preserving workspace trust, session ownership, client-id, permission, feature, validation, and resource checks. `createServeApp()` mounts the bundled Web Shell assets (`packages/cli/src/serve/web-shell-static.ts`) **before** `bearerAuth`, so the shell itself loads without a token; its own API calls carry the bearer when one is configured — start the daemon with `--open` (which puts the token in the URL fragment, never sent to the server) or append `#token=…` manually when auth is enabled. `--no-web` opts out and leaves the daemon API-only.

## 2. Launch recipes

```bash
# 1. Local dev default (loopback, no token)
qwen serve

# 2. Explicit workspace + ephemeral port
qwen serve --workspace /path/to/repo --port 0

# 3. Hardened loopback development (force bearer even on loopback)
QWEN_SERVER_TOKEN=$(openssl rand -hex 32) qwen serve --require-auth

# 4. Expose to LAN (non-loopback requires a token)
QWEN_SERVER_TOKEN=$(openssl rand -hex 32) \
  qwen serve --hostname 0.0.0.0 --port 4170

# 5. Tune for many sessions and a larger replay ring
qwen serve --max-sessions 0 --event-ring-size 32000

# 6. Multi-client collaboration + strict MCP budget
QWEN_SERVER_TOKEN=secret \
  qwen serve --require-auth \
             --mcp-client-budget 10 \
             --mcp-budget-mode enforce

# 7. Start with a consensus policy configured in settings.json
# settings.json: { "policy": { "permissionStrategy": "consensus", "consensusQuorum": 2 } }
qwen serve

# 8. Debug logging
QWEN_SERVE_DEBUG=1 qwen serve

# 9. Disable the F2 pool (fallback to per-session MCP clients)
QWEN_SERVE_NO_MCP_POOL=1 qwen serve

# 10. Allow browser web UI cross-origin access
QWEN_SERVER_TOKEN=secret \
  qwen serve --allow-origin 'http://localhost:3000'

# 11. Prompt deadline + SSE idle timeout
qwen serve --prompt-deadline-ms 300000 --writer-idle-timeout-ms 600000

# 12. Keep the ACP child warm after the last session closes
qwen serve --channel-idle-timeout-ms 60000

# 13. Enable HTTP rate limiting
QWEN_SERVE_RATE_LIMIT=1 qwen serve
```

With the hardened loopback recipe (3), `/health` is registered after `bearerAuth`, so probes must carry the token like every other API route (the Web Shell static surface stays pre-auth by design; pass `--no-web` for an API-only daemon).

## 3. Full startup flags

The CLI is defined in **`packages/cli/src/commands/serve.ts`**:

| Flag                                    | Type                           | Default                                          | Required when                            | Effect                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------- | ------------------------------ | ------------------------------------------------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--port <n>`                            | number                         | `4170`                                           | -                                        | TCP port; `0` means OS-assigned ephemeral port.                                                                                                                                                                                                                                                                                                                                                                                   |
| `--hostname <host>`                     | string                         | `127.0.0.1`                                      | Non-loopback requires token              | Bind address. Loopback values: `127.0.0.1`, `localhost`, `::1`, `[::1]`. `[::1]` brackets are stripped automatically; `host:port` input is rejected with guidance to use `--port`.                                                                                                                                                                                                                                                |
| `--token <s>`                           | string                         | env / none                                       | Non-loopback and `--require-auth`        | Bearer token; trimmed once. **It appears in `/proc/<pid>/cmdline`, so prefer `QWEN_SERVER_TOKEN`**. Boot stderr also warns about this.                                                                                                                                                                                                                                                                                            |
| `--max-sessions <n>`                    | number                         | `32`                                             | -                                        | Per-workspace active session cap. Excess spawn returns 503. `0` means unlimited. `NaN` / negative values throw.                                                                                                                                                                                                                                                                                                                   |
| `--max-total-sessions <n>`              | number                         | derived for multiple startup/restored workspaces | -                                        | Daemon-wide active session cap. When omitted, a finite default is derived once from the per-workspace cap and startup/restored workspace count; dynamic registration does not recompute it. `0` means unlimited.                                                                                                                                                                                                                  |
| `--memory-budget-mb <n>`                | integer in `[1024, 1048576]`   | 50% of cgroup/host memory                        | -                                        | Total memory budget for the daemon process tree, capped at resolved available memory. No child is sized from it; the one consumer today is the adaptive live-journal growth pool (see `--max-journal-bytes`). Reported under `limits.memory`, including a modeled per-child partition.                                                                                                                                            |
| `--max-journal-events <n>`              | positive safe integer          | `10000`                                          | -                                        | Per-session baseline cap on in-flight `liveJournal` replay entries. Adaptive growth can raise it (see `--max-journal-bytes`); pinning either journal flag disables growth.                                                                                                                                                                                                                                                        |
| `--max-journal-bytes <n>`               | positive safe integer          | `8388608`                                        | -                                        | Per-session baseline byte cap on the in-flight `liveJournal`. Breaching turns grow the caps on demand (toward double, limited by remaining pool headroom) within one daemon-wide pool of 5% of the effective `--memory-budget-mb` (capped at `1024` MB; 0 — growth disabled — when the effective budget falls below the 1024 MB minimum), never past a 256 MiB per-session hard cap; pinning either journal flag disables growth. |
| `--memory-pressure-mode <mode>`         | `off` \| `observe`             | `observe`                                        | Observation only                         | Reports `runtime.memory.pressure` in both modes; only `observe` raises the `daemon_memory_pressure` issue. Root process only.                                                                                                                                                                                                                                                                                                     |
| `--child-heap-mode <mode>`              | `off` \| `observe`             | `observe`                                        | Observation only                         | Under `observe`, reports the modeled partition under `limits.memory.childHeap`; applies nothing and refuses nothing. Under `off`, that block's two figures are `null`.                                                                                                                                                                                                                                                            |
| `--max-pending-prompts-per-session <n>` | number                         | `5`                                              | -                                        | Accepted but pending/running prompt cap per session. Excess prompt returns 503. `0` / `Infinity` means unlimited. Negative or non-integer values throw.                                                                                                                                                                                                                                                                           |
| `--workspace <dir>`                     | string / repeatable            | `process.cwd()`                                  | -                                        | Startup workspace runtime; repeat to register additional isolated runtimes. The first is primary. Each value **must be an absolute path, must exist, and must be a directory**. Boot canonicalizes every value via `canonicalizeWorkspace`. `POST /session` with a mismatched `cwd` returns `400 workspace_mismatch`.                                                                                                             |
| `--max-connections <n>`                 | number                         | `256`                                            | -                                        | Listener-level `server.maxConnections`. `0` / `Infinity` means unlimited. `NaN` / negative values fail boot to avoid fail-open behavior.                                                                                                                                                                                                                                                                                          |
| `--require-auth`                        | boolean                        | `false`                                          | Token required                           | Extends bearer auth to loopback **and** `/health`. Boot refuses to start without a token.                                                                                                                                                                                                                                                                                                                                         |
| `--enable-session-shell`                | boolean                        | `false`                                          | Bearer or trusted loopback               | Enables direct `POST /session/:id/shell` execution. Callers must also send a session-bound `X-Qwen-Client-Id`.                                                                                                                                                                                                                                                                                                                    |
| `--event-ring-size <n>`                 | number                         | `8000`                                           | -                                        | Per-session SSE replay ring depth. Soft cap is `MAX_EVENT_RING_SIZE = 1_000_000`; out-of-range values throw during bridge construction.                                                                                                                                                                                                                                                                                           |
| `--http-bridge`                         | boolean                        | `true`                                           | -                                        | Bridge mode: production attempts to preheat one primary `qwen --acp` child and retries on first use after failure; trusted secondaries start one on demand, while untrusted secondaries cannot start ACP. Stage 2 in-process mode is not implemented yet; `--no-http-bridge` falls back and prints to stderr.                                                                                                                     |
| `--mcp-client-budget <n>`               | number                         | none                                             | Required for `mcp-budget-mode=enforce`   | Workspace MCP client cap. Must be a positive integer.                                                                                                                                                                                                                                                                                                                                                                             |
| `--mcp-budget-mode <m>`                 | `'enforce' \| 'warn' \| 'off'` | `warn` when a budget is set, otherwise `off`     | `enforce` requires `--mcp-client-budget` | `enforce` refuses, `warn` only warns at 75%, `off` is observation only.                                                                                                                                                                                                                                                                                                                                                           |
| `--allow-origin <pattern>`              | repeatable string              | none                                             | -                                        | CORS allowlist that replaces the default Origin denial. `*` requires a token.                                                                                                                                                                                                                                                                                                                                                     |
| `--allow-private-auth-base-url`         | boolean                        | `false`                                          | -                                        | Allows localhost / private-network auth provider `baseUrl` installation. Use only for trusted local development.                                                                                                                                                                                                                                                                                                                  |
| `--prompt-deadline-ms <n>`              | number                         | none                                             | -                                        | Server-side prompt wallclock limit in ms; timeout aborts the prompt.                                                                                                                                                                                                                                                                                                                                                              |
| `--writer-idle-timeout-ms <n>`          | number                         | none                                             | -                                        | Per-SSE-connection idle timeout in ms.                                                                                                                                                                                                                                                                                                                                                                                            |
| `--channel-idle-timeout-ms <n>`         | number                         | `0`                                              | -                                        | Keeps the ACP child alive after the last session closes. `0` means reclaim immediately.                                                                                                                                                                                                                                                                                                                                           |
| `--initialize-timeout-ms <n>`           | number                         | `10000`                                          | -                                        | ACP child request timeout, including the initialize handshake (ms).                                                                                                                                                                                                                                                                                                                                                               |
| `--session-reap-interval-ms <n>`        | number                         | `60000`                                          | -                                        | Session reaper scan interval. `0` disables it.                                                                                                                                                                                                                                                                                                                                                                                    |
| `--session-idle-timeout-ms <n>`         | number                         | `1800000`                                        | -                                        | Disconnected-session idle timeout. `0` disables it.                                                                                                                                                                                                                                                                                                                                                                               |
| `--rate-limit` / `--no-rate-limit`      | boolean                        | env / off                                        | -                                        | Enables or disables per-tier HTTP rate limiting.                                                                                                                                                                                                                                                                                                                                                                                  |
| `--rate-limit-prompt <n>`               | number                         | `10`                                             | `--rate-limit`                           | Prompt requests per window.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `--rate-limit-mutation <n>`             | number                         | `30`                                             | `--rate-limit`                           | Mutation requests per window.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--rate-limit-read <n>`                 | number                         | `120`                                            | `--rate-limit`                           | Read requests per window.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--rate-limit-window-ms <n>`            | number                         | `60000`                                          | `--rate-limit`                           | Rate limit window length; must be `>= 1000`.                                                                                                                                                                                                                                                                                                                                                                                      |

## 4. Environment variables

| Env                                 | Equivalent flag / effect                                                                                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QWEN_SERVER_TOKEN`                 | Equivalent to `--token`; `--token` wins. Trimmed once at boot to avoid a trailing newline from `cat token.txt`.                                                         |
| `QWEN_SERVE_DEBUG`                  | `1` / `true` / `on` / `yes` (case-insensitive) enables verbose stderr logs.                                                                                             |
| `QWEN_SERVE_NO_MCP_POOL`            | `1` disables the workspace MCP pool entirely and falls back to per-session `McpClientManager`. Capabilities stop advertising `mcp_workspace_pool` / `mcp_pool_restart`. |
| `QWEN_SERVE_MCP_CLIENT_BUDGET`      | ACP-child internal budget input. The CLI generates it from `--mcp-client-budget` through `childEnvOverrides`; it is not a parent-process env fallback.                  |
| `QWEN_SERVE_MCP_BUDGET_MODE`        | ACP-child internal budget mode. The CLI generates it from `--mcp-budget-mode` through `childEnvOverrides`; it is not a parent-process env fallback.                     |
| `QWEN_SERVE_PROMPT_DEADLINE_MS`     | Env fallback for `--prompt-deadline-ms`.                                                                                                                                |
| `QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS` | Env fallback for `--writer-idle-timeout-ms`.                                                                                                                            |
| `QWEN_SERVE_MCP_POOL_TRANSPORTS`    | Read by the ACP child. Comma-separated pooled transport allowlist; default is `stdio,websocket`.                                                                        |
| `QWEN_SERVE_MCP_POOL_DRAIN_MS`      | Read by the ACP child. Pool entry idle drain delay; default is `30000`, clamped to `1000..600000` ms.                                                                   |
| `QWEN_SERVE_RATE_LIMIT`             | `1` / `true` enables rate limiting; CLI flag wins.                                                                                                                      |
| `QWEN_SERVE_RATE_LIMIT_PROMPT`      | Env fallback for `--rate-limit-prompt`.                                                                                                                                 |
| `QWEN_SERVE_RATE_LIMIT_MUTATION`    | Env fallback for `--rate-limit-mutation`.                                                                                                                               |
| `QWEN_SERVE_RATE_LIMIT_READ`        | Env fallback for `--rate-limit-read`.                                                                                                                                   |
| `QWEN_SERVE_RATE_LIMIT_WINDOW_MS`   | Env fallback for `--rate-limit-window-ms`.                                                                                                                              |

Per-handle env overrides are intentional: two daemons running in the same process do not race on `process.env`. `defaultSpawnChannelFactory` snapshots env at spawn time.

## 5. `settings.json` is also read

Boot calls `loadSettings(boundWorkspace)` once:

| Key                         | Type                                                               | Behavior                                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `policy.permissionStrategy` | `'first-responder' \| 'designated' \| 'consensus' \| 'local-only'` | Sets `BridgeOptions.permissionPolicy`. **Boot validates with `validatePolicyConfig`**; unknown values throw `InvalidPolicyConfigError` instead of falling back silently. |
| `policy.consensusQuorum`    | positive integer                                                   | N for the `consensus` policy. Default is `floor(M/2)+1`. If set under a non-consensus policy, it is ignored and boot logs a stderr warning.                              |
| `context.fileName`          | string                                                             | Controls which file `POST /workspace/init` writes through the workspace-service `contextFilename`.                                                                       |
| `tools.disabled`            | string[]                                                           | Normalized through `normalizeDisabledToolList()` (trim, drop empty entries, dedupe) before affecting the next ACP child spawn.                                           |
| `tools.approvalMode`        | string                                                             | Default session approval mode.                                                                                                                                           |
| `telemetry`                 | object                                                             | OTel configuration: `enabled`, `otlpEndpoint`, `otlpProtocol`, per-signal endpoints, and more. See [`17-configuration.md`](./17-configuration.md).                       |

Settings I/O failure, such as malformed JSON, falls back to defaults. `InvalidPolicyConfigError` is the exception: policy misconfiguration fails boot explicitly.

## 6. Boot refusal scenarios (explicit failures)

`run-qwen-serve.ts` intentionally throws instead of falling back in these cases:

| Scenario                                                                      | Error prefix                                                                                        |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Non-loopback bind without token                                               | `Refusing to bind ... without a bearer token`                                                       |
| `--require-auth` without token                                                | `Refusing to start with --require-auth set but no bearer token`                                     |
| `--workspace` does not exist, is not a directory, or is not absolute          | `Invalid --workspace ...`                                                                           |
| `--workspace` stat permission denied                                          | `Invalid --workspace ...: permission denied`                                                        |
| `--mcp-client-budget` is not a positive integer                               | `Must be a positive integer`                                                                        |
| `--mcp-budget-mode=enforce` without budget                                    | `requires a positive mcpClientBudget`                                                               |
| `--hostname` is written as `localhost:4170`                                   | `looks like a "host:port" combination. Use --port`                                                  |
| `--hostname [::1]:8080`                                                       | `Invalid --hostname ... brackets indicate an IPv6 literal but the value is not a clean [addr] form` |
| `--max-connections` is `NaN` or negative                                      | `Must be >= 0`                                                                                      |
| `--event-ring-size > 1_000_000`                                               | Thrown during bridge construction                                                                   |
| `--allow-origin '*'` without token                                            | `Refusing to start with --allow-origin '*' but no bearer token configured`                          |
| `--prompt-deadline-ms` / `--writer-idle-timeout-ms` is not a positive integer | `Must be a positive integer`                                                                        |
| `--initialize-timeout-ms` is not a positive integer or exceeds `2^31-1`       | `Must be a positive integer` / `Exceeds maximum JS timer delay`                                     |
| Unknown `policy.permissionStrategy` or non-positive `policy.consensusQuorum`  | `InvalidPolicyConfigError`                                                                          |

## 7. Curl verification checklist

```bash
# 1. Liveness
curl http://127.0.0.1:4170/health
# -> {"status":"ok"}

# 1.1 Deep health
curl -s 'http://127.0.0.1:4170/health?deep=1' | jq

# 2. Capabilities
curl -s http://127.0.0.1:4170/capabilities | jq

# 3. Preflight readiness
curl -s http://127.0.0.1:4170/workspace/preflight | jq

# 4. Env snapshot (secrets only report presence)
curl -s http://127.0.0.1:4170/workspace/env | jq

# 5. MCP pool / budget snapshot
curl -s http://127.0.0.1:4170/workspace/mcp | jq

# 6. Create a session
curl -s -X POST http://127.0.0.1:4170/session \
  -H 'Content-Type: application/json' \
  -H 'X-Qwen-Client-Id: curl-debug' \
  -d '{}' | jq

# 7. Tail SSE (replace <sid>)
curl -N \
  -H 'Accept: text/event-stream' \
  -H 'X-Qwen-Client-Id: curl-debug' \
  -H 'Last-Event-ID: 0' \
  'http://127.0.0.1:4170/session/<sid>/events'

# 8. Web Shell UI
open http://127.0.0.1:4170/
```

When bearer auth is enabled, add `-H "Authorization: Bearer $QWEN_SERVER_TOKEN"` to every request.

## 8. Is there a browser UI?

**Yes — the Web Shell.** `resolveWebShellDir()` finds the built assets (bundled next to the CLI bundle in a release, `packages/web-shell/dist` in a checkout) and `mountWebShellAssets()` serves them at `/`, `/assets`, and `/session/:id` document navigations (browser deep links — a plain `curl /session/<id>` gets the API's 401/404, not the shell). When the assets are missing the daemon degrades to API-only instead of crashing; `--no-web` opts out explicitly.

The static shell is mounted **before** `bearerAuth` in every launch mode — a browser cannot attach an `Authorization` header to an address-bar navigation or a `<script src>` subresource, so gating it would just break the UI. API calls use trusted-loopback authority on the token-less primary listener or attach the configured bearer in authenticated modes. On a non-loopback bind the shell is read-only unless `--allow-origin <origin>` is passed — same-origin POSTs carry an `Origin` header that the CORS wall rejects (403) — so pass `--allow-origin` for any bind beyond loopback.

CSP is built by `buildWebShellCsp()` and is deliberately looser than a static page's (`'unsafe-inline'` for the inline `performance.measure` patch, `eval`/wasm/blob workers for shiki and mermaid, `data:` for katex fonts, `connect-src 'self'` for SSE). `frame-ancestors 'none'` plus `X-Frame-Options: DENY` block clickjacking, except when an extension origin is explicitly allowed via `--allow-origin` so the UI can be hosted in a Chrome side panel (#5626).

For raw protocol inspection, subscribe to the SSE stream directly (`routes/sse-events.ts`) — see the curl recipes in section 7.

## 9. Call chain from `qwen serve` to the listening server

```text
qwen serve
   |
   v (process)
packages/cli/index.ts              main()
   |
   v
llm.tsx                         main() - parseArguments()
   |
   v (yargs assembly)
config/config.ts                   import { serveCommand } ...
config/config.ts                   .command(serveCommand)
config/config.ts                   await yargsInstance.parse()
   |
   v (handler)
commands/serve.ts                  handler(argv) - boot pre-checks
commands/serve.ts                  const { runQwenServe } = await import('../serve/index.js')   # lazy load
commands/serve.ts                  await runQwenServe({...})
   |
   v
serve/run-qwen-serve.ts              runQwenServe(opts, deps)
   |  |- trim token
   |  |- hostname mismatch fallback
   |  |- auth preflight
   |  |- workspace validation + canonicalization
   |  |- MCP budget validation + childEnvOverrides
   |  |- loadSettings + validatePolicyConfig
   |  |- PermissionAuditRing + publisher
   |  |- resolveBridgeFsFactory
   |  `- createHttpAcpBridge({...})
   |
   v
serve/run-qwen-serve.ts              const app = createServeApp(opts, () => actualPort, {...})
   |
   v
serve/server.ts                    createServeApp() - builds Express app (**does not listen**)
   |  |- middleware chain (Host allowlist / CORS / bearerAuth / mutation gate / rate limit)
   |  |- route mounting (health / web-shell static / capabilities / workspace / session / SSE / ACP HTTP)
   |  `- return app
   |
   v
serve/run-qwen-serve.ts              server = createServer(app) / https.createServer(..., app)
   |  |- lifecycle.bindServer(server, { startupReady, drainHost })
   |  |- server.listen(port, hostname)
   |  |- server.maxConnections = cap
   |  |- actualPort = server.address().port
   |  |- write "qwen serve listening on ..."
   |  |- register SIGINT / SIGTERM (onSignal)
   |  `- resolve(handle: RunHandle)
   |
   v
commands/serve.ts                  await blockForever()    // block forever until signal
```

Key facts:

- **`createServeApp` only builds; it does not listen.** It returns an `express()` instance with middleware and routes mounted. Ordinary-only embedders may continue to own `app.listen()`. Embedders that use Live/Conversations must bind the actual Node server to the exported app lifecycle before listening and await that lifecycle during shutdown.
- **`() => actualPort` is a lazy closure.** `actualPort` is assigned in the `server.listen` callback. The `hostAllowlist` middleware reads it on demand, so ephemeral ports (`--port 0`) still gate the `Host` header correctly.
- **`await blockForever()` is intentional.** If `yargs.parse()` resolves, the CLI top level falls through into the interactive TUI entrypoint (`llm.tsx`). SIGINT / SIGTERM exit through `runQwenServe`'s `onSignal` path.

## 10. HTTP route file split

The main assembly happens in `createServeApp()` in `server.ts`, which wires middleware and mounts focused route modules:

| Routes                                                                                       | File                                                    | Mounting entry                                                                 |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `/health`                                                                                    | `packages/cli/src/serve/routes/health.ts`               | `healthRoutes.register()`                                                      |
| `/daemon/status`                                                                             | `packages/cli/src/serve/routes/daemon-status.ts`        | `registerDaemonStatusRoutes()`                                                 |
| `/capabilities`, workspace init/tool/MCP mutation routes, ACP HTTP bridge                    | `packages/cli/src/serve/server.ts`                      | Registered directly inside `createServeApp()`                                  |
| Workspace status, env, preflight, MCP/tool/provider/skill summaries                          | `packages/cli/src/serve/routes/workspace-status.ts`     | `registerWorkspaceStatusRoutes()`, `registerWorkspaceDiagnosticStatusRoutes()` |
| Workspace extensions and extension operations                                                | `packages/cli/src/serve/routes/workspace-extensions.ts` | `registerWorkspaceExtensionRoutes()`                                           |
| `/workspace/memory` (GET/POST)                                                               | `packages/cli/src/serve/workspace-memory.ts`            | `mountWorkspaceMemoryRoutes()`                                                 |
| All `/workspace/agents` CRUD routes                                                          | `packages/cli/src/serve/workspace-agents.ts`            | `mountWorkspaceAgentsRoutes()`                                                 |
| `GET /file`, `/file/bytes`, `/list`, `/glob`, `/stat`                                        | `packages/cli/src/serve/routes/workspace-file-read.ts`  | `registerWorkspaceFileReadRoutes()`                                            |
| `POST /file/write`, `/file/edit`                                                             | `packages/cli/src/serve/routes/workspace-file-write.ts` | `registerWorkspaceFileWriteRoutes()`                                           |
| Workspace setup, trust, settings, permissions, and voice routes                              | `packages/cli/src/serve/routes/workspace-*.ts`          | `registerWorkspaceSetupGithubRoutes()`, `registerWorkspaceTrustRoutes()`, etc. |
| Workspace auth provider and device-flow routes                                               | `packages/cli/src/serve/routes/workspace-auth.ts`       | `registerWorkspaceAuthRoutes()`                                                |
| Session lifecycle, prompt, metadata, language, shell, recap, rewind, branch, and list routes | `packages/cli/src/serve/routes/session.ts`              | `registerSessionRoutes()`                                                      |
| `GET /session/:id/events` SSE stream                                                         | `packages/cli/src/serve/routes/sse-events.ts`           | `registerSseEventsRoutes()`                                                    |
| Permission response routes                                                                   | `packages/cli/src/serve/routes/permission.ts`           | `registerPermissionRoutes()`                                                   |

For the complete route and wire protocol reference, see [`../qwen-serve-protocol.md`](../qwen-serve-protocol.md). For architecture, see [`01-architecture.md`](./01-architecture.md).

## 11. Graceful vs hard shutdown

- **First SIGINT / SIGTERM** -> `runQwenServe` `onSignal` -> two-phase graceful shutdown:
  1. `bridge.shutdown()`: each channel gets `KILL_HARD_DEADLINE_MS` (10s), then `channel.kill()`.
  2. `server.close()`: in-flight requests drain, `SHUTDOWN_FORCE_CLOSE_MS` (5s) triggers `closeAllConnections()`, then a second 2s deadline applies.
- **Second SIGINT / SIGTERM while already exiting** -> `bridge.killAllSync()` synchronously SIGKILLs all ACP children and calls `process.exit(1)` to avoid orphan processes.

`RunHandle.close()` returned by `runQwenServe` is the programmatic equivalent for embedders and tests.

## 12. Embedded invocation (bypass CLI)

```ts
import { runQwenServe } from '@qwen-code/qwen-code/serve';

const handle = await runQwenServe({
  port: 0, // ephemeral
  hostname: '127.0.0.1',
  mode: 'http-bridge',
  maxSessions: 20,
  workspace: '/abs/path/to/repo',
});
console.log(`Daemon at ${handle.url}`);
// ... call handle.bridge directly or access handle.server
await handle.close(); // programmatic shutdown
```

Or get the Express app directly and bind the listener lifecycle yourself. This form is required when the embed uses Live/Conversations:

```ts
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createServeApp,
  getServeAppLifecycle,
} from '@qwen-code/qwen-code/serve';

let actualPort = 0;
const app = createServeApp(
  {
    port: 0,
    hostname: '127.0.0.1',
    mode: 'http-bridge',
    maxSessions: 20,
  },
  () => actualPort,
  {
    /* deps: bridge, fsFactory, ... */
  },
);

const lifecycle = getServeAppLifecycle(app);
const server = createServer(app);
lifecycle.bindServer(server);
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve());
});
actualPort = (server.address() as AddressInfo).port;
console.log('listening on', server.address());

// Stop admission, drain app work, close the listener, and release ownership.
await lifecycle.close();
```

Calling raw `server.close()` also starts the same event-driven cleanup, but it is only best effort unless the process remains alive; always await `lifecycle.close()` to receive shutdown errors. If no server is bound, Live/Conversations requests fail closed while ordinary-only app behavior is unchanged.

Note: when calling `createServeApp` directly, the default `fsFactory.trusted = false`. Agent-side ACP `writeTextFile` is rejected as `untrusted_workspace`, and a stderr warning is printed once. Either inject `deps.fsFactory` with explicit trust, inject `deps.bridge`, or accept the trust-gated default behavior.

## 13. Debugging recipes

See the debugging section in [`19-observability.md`](./19-observability.md). The common commands are:

```bash
# Is the daemon alive?
curl http://127.0.0.1:4170/health

# Which capabilities are advertised?
curl -s http://127.0.0.1:4170/capabilities | jq

# Daemon-host readiness
curl -s http://127.0.0.1:4170/workspace/preflight | jq

# Tail live SSE
curl -N -H 'Accept: text/event-stream' \
     -H 'Last-Event-ID: 0' \
     'http://127.0.0.1:4170/session/<sid>/events'

# Verbose logs
QWEN_SERVE_DEBUG=1 qwen serve
```

## References

- CLI entry: `packages/cli/src/commands/serve.ts`
- Bootstrap: `packages/cli/src/serve/run-qwen-serve.ts`
- Express factory: `packages/cli/src/serve/server.ts`
- Middleware: `packages/cli/src/serve/auth.ts`
- Bridge factory: `packages/acp-bridge/src/bridge.ts`
- Web Shell static mount: `packages/cli/src/serve/web-shell-static.ts`
- User docs: [`../../users/qwen-serve.md`](../../users/qwen-serve.md)
- Wire protocol: [`../qwen-serve-protocol.md`](../qwen-serve-protocol.md)

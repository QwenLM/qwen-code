# Configuration Reference

## Overview

This page collects every setting that affects the `qwen serve` daemon and its adapters: environment variables, CLI flags, `settings.json` keys, and programmatic options. Feature-specific pages link back here when they need cross-cutting configuration details.

## CLI flags (`qwen serve`)

| Flag                                    | Type                       | Default                                    | Effect                                                                                                                                                                              |
| --------------------------------------- | -------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--hostname <host>`                     | string                     | `127.0.0.1`                                | Bind address. Loopback values: `127.0.0.1`, `localhost`, `::1`, `[::1]`. Non-loopback requires a bearer token at boot. `host:port` input is rejected with guidance to use `--port`. |
| `--port <n>`                            | number                     | `4170`                                     | Listen port; `0` means ephemeral.                                                                                                                                                   |
| `--token <s>`                           | string                     | env                                        | Bearer token. Overrides `QWEN_SERVER_TOKEN` and is trimmed at boot. It appears in the process command line, so prefer env in deployments.                                           |
| `--require-auth`                        | boolean                    | `false`                                    | Extends bearer auth to loopback and `/health`; boot refuses to start without a token.                                                                                               |
| `--workspace <dir>`                     | absolute path              | `process.cwd()`                            | Bound workspace. Must be absolute and a directory; canonicalized once at boot.                                                                                                      |
| `--max-sessions <n>`                    | number                     | `20`                                       | Active session cap. `0` / `Infinity` means unlimited; `NaN` / negative values throw.                                                                                                |
| `--max-pending-prompts-per-session <n>` | number                     | `5`                                        | Accepted but pending/running prompt cap per session. Excess prompt returns 503. `0` / `Infinity` means unlimited; negative or non-integer values throw.                             |
| `--max-connections <n>`                 | number                     | `256`                                      | HTTP listener `server.maxConnections`; `0` / `Infinity` means unlimited.                                                                                                            |
| `--enable-session-shell`                | boolean                    | `false`                                    | Enables direct `POST /session/:id/shell` execution. Requires bearer token, and every call must carry a session-bound `X-Qwen-Client-Id`.                                            |
| `--event-ring-size <n>`                 | number                     | `8000`                                     | Per-session SSE replay ring; soft cap is `1_000_000`.                                                                                                                               |
| `--http-bridge`                         | boolean                    | `true`                                     | Stage 1 bridge mode. `--no-http-bridge` still falls back to http-bridge and prints to stderr.                                                                                       |
| `--mcp-client-budget <n>`               | positive integer           | unset                                      | Sets `WorkspaceMcpBudget.clientBudget` and forwards it to the ACP child through `childEnvOverrides`.                                                                                |
| `--mcp-budget-mode <m>`                 | `off` / `warn` / `enforce` | `warn` when budget is set, otherwise `off` | Sets `WorkspaceMcpBudget.mode`; `enforce` requires `--mcp-client-budget`.                                                                                                           |
| `--allow-origin <pattern>`              | repeatable string          | unset                                      | Cross-origin allowlist that replaces the default CORS denial. `*` allows any origin but requires a token.                                                                           |
| `--allow-private-auth-base-url`         | boolean                    | `false`                                    | Allows `/workspace/auth/provider` to install localhost / private-network auth provider `baseUrl`; use only in trusted local development.                                            |
| `--prompt-deadline-ms <n>`              | positive integer           | unset                                      | Server-side prompt wallclock limit in ms. Timeout aborts and returns an error.                                                                                                      |
| `--writer-idle-timeout-ms <n>`          | positive integer           | unset                                      | Per-SSE-connection idle timeout in ms. The daemon closes the SSE connection when no event is sent for this duration.                                                                |
| `--channel-idle-timeout-ms <n>`         | non-negative integer       | `0`                                        | How long to keep the ACP child alive after the last session closes. `0` means reclaim immediately.                                                                                  |
| `--session-reap-interval-ms <n>`        | non-negative integer       | `60000`                                    | Session reaper scan interval; `0` disables it.                                                                                                                                      |
| `--session-idle-timeout-ms <n>`         | non-negative integer       | `1800000`                                  | Disconnected-session idle reaping time; `0` disables it.                                                                                                                            |
| `--rate-limit` / `--no-rate-limit`      | boolean                    | env / off                                  | Enables per-tier HTTP rate limiting for prompt, mutation, and read routes.                                                                                                          |
| `--rate-limit-prompt <n>`               | positive integer           | `10`                                       | Prompt request limit per window; requires rate limiting to be enabled.                                                                                                              |
| `--rate-limit-mutation <n>`             | positive integer           | `30`                                       | Mutation request limit per window; requires rate limiting to be enabled.                                                                                                            |
| `--rate-limit-read <n>`                 | positive integer           | `120`                                      | Read request limit per window; requires rate limiting to be enabled.                                                                                                                |
| `--rate-limit-window-ms <n>`            | integer `>= 1000`          | `60000`                                    | Rate limit window length; requires rate limiting to be enabled.                                                                                                                     |
| no flag                                 | -                          | -                                          | `QWEN_SERVE_NO_MCP_POOL=1` fully disables the pool.                                                                                                                                 |

## Environment variables

### Read by `runQwenServe` / Express middleware

| Env                                 | Effect                                                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `QWEN_SERVER_TOKEN`                 | Bearer token; trimmed at boot.                                                                                                                                           |
| `QWEN_SERVE_DEBUG`                  | `1` / `true` / `on` / `yes` (case-insensitive) enables verbose stderr logs. See [`19-observability.md`](./19-observability.md).                                          |
| `QWEN_SERVE_NO_MCP_POOL`            | `1` disables the workspace MCP transport pool and falls back to per-session `McpClientManager`; capabilities stop advertising `mcp_workspace_pool` / `mcp_pool_restart`. |
| `QWEN_SERVE_PROMPT_DEADLINE_MS`     | Env fallback for `--prompt-deadline-ms`.                                                                                                                                 |
| `QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS` | Env fallback for `--writer-idle-timeout-ms`.                                                                                                                             |
| `QWEN_SERVE_RATE_LIMIT`             | `1` / `true` enables per-tier HTTP rate limiting; CLI `--rate-limit` / `--no-rate-limit` wins.                                                                           |
| `QWEN_SERVE_RATE_LIMIT_PROMPT`      | Env fallback for `--rate-limit-prompt`.                                                                                                                                  |
| `QWEN_SERVE_RATE_LIMIT_MUTATION`    | Env fallback for `--rate-limit-mutation`.                                                                                                                                |
| `QWEN_SERVE_RATE_LIMIT_READ`        | Env fallback for `--rate-limit-read`.                                                                                                                                    |
| `QWEN_SERVE_RATE_LIMIT_WINDOW_MS`   | Env fallback for `--rate-limit-window-ms`.                                                                                                                               |

### Forwarded to the ACP child through `BridgeOptions.childEnvOverrides`

`runQwenServe` builds these per handle so two daemons in one process do not race on `process.env`. The budget variables are not parent-process env fallbacks for `qwen serve`; the CLI path must generate them from `--mcp-client-budget` / `--mcp-budget-mode`.

| Env                              | Effect                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `QWEN_SERVE_MCP_CLIENT_BUDGET`   | Positive integer string consumed by the ACP child's `readBudgetFromEnv()`.                                               |
| `QWEN_SERVE_MCP_BUDGET_MODE`     | `off` / `warn` / `enforce`.                                                                                              |
| `QWEN_SERVE_MCP_POOL_TRANSPORTS` | Comma-separated transport allowlist; default pooled transports are `stdio,websocket`; can explicitly include `http,sse`. |
| `QWEN_SERVE_MCP_POOL_DRAIN_MS`   | Pool entry idle drain delay; default `30000`, clamped to `1000..600000` ms.                                              |

### Read by SDK / adapters

| Env                     | Effect                                                            |
| ----------------------- | ----------------------------------------------------------------- |
| `QWEN_DAEMON_URL`       | Daemon base URL for CLI TUI adapter, channels, and IDE companion. |
| `QWEN_DAEMON_TOKEN`     | Bearer token.                                                     |
| `QWEN_DAEMON_WORKSPACE` | Overrides the `cwd` sent to `POST /session`.                      |

## `settings.json` keys

The daemon reads settings once at boot through `loadSettings(boundWorkspace)` inside `runQwenServe`. Malformed settings fall back to defaults through a try/catch guard.

| Key                         | Type                                                               | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy.permissionStrategy` | `'first-responder' \| 'designated' \| 'consensus' \| 'local-only'` | Sets `BridgeOptions.permissionPolicy`; the active value appears in `/capabilities` as `policy.permission`. **Boot validates** through `validatePolicyConfig()` against `SERVE_CAPABILITY_REGISTRY.permission_mediation.modes`. Unknown literals throw `InvalidPolicyConfigError` and fail boot explicitly.                                                                                                                                                                                                                               |
| `policy.consensusQuorum`    | positive integer                                                   | N for the `consensus` policy. **Default** is `floor(M/2) + 1` over `votersAtIssue.size` (M=2 means unanimous; larger even M means more than half). If set under a non-consensus policy, it is ignored and boot prints a stderr warning. Non-positive integers throw `InvalidPolicyConfigError`. See [`04-permission-mediation.md`](./04-permission-mediation.md).                                                                                                                                                                        |
| `context.fileName`          | string                                                             | Overrides `getCurrentGeminiMdFilename()` through `BridgeOptions.contextFilename`.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `tools.disabled`            | string[]                                                           | Tools disabled for the next ACP child spawn. Normalized through `normalizeDisabledToolList()` (`packages/cli/src/config/normalizeDisabledTools.ts`): non-array becomes `[]`, non-string entries are skipped, whitespace is trimmed, empty entries are dropped, and duplicates are removed while preserving first occurrence. Boot and `restartMcpServer` settings refresh both run through this function. `ToolRegistry.has(name)` is exact and case-sensitive. `POST /workspace/tools/:name/enable` and `tool_toggled` update this key. |
| `tools.approvalMode`        | `'default' \| 'auto' \| ...`                                       | Default session approval mode; `POST /session/:id/approval-mode` writes here when `persist: true`.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `telemetry`                 | object                                                             | OTel config. Keys include `enabled`, `otlpEndpoint`, `otlpProtocol`, `otlpTracesEndpoint`, `otlpLogsEndpoint`, `otlpMetricsEndpoint`, `target`, `outfile`, `includeSensitiveSpanAttributes`, `resourceAttributes`, and `metrics.includeSessionId`. `resolveTelemetrySettings()` reads it at boot and initializes `initializeTelemetry()`.                                                                                                                                                                                                |

## `ServeOptions` (programmatic embedding)

`packages/cli/src/serve/types.ts` defines the typed options object accepted by both `runQwenServe` and `createServeApp`. It mirrors the CLI flags above and adds:

| Field                         | Effect                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| `eventRingSize`               | Overrides the default per-session ring size.                                                  |
| `maxPendingPromptsPerSession` | Pending prompt cap per session; `0` / `Infinity` means unlimited.                             |
| `mcpPoolActive`               | Programmatic switch, defaulting from `QWEN_SERVE_NO_MCP_POOL`.                                |
| `allowOrigins`                | Cross-origin allowlist (`string[]`), corresponding to `--allow-origin`.                       |
| `allowPrivateAuthBaseUrl`     | Allows private / localhost auth provider `baseUrl` installation.                              |
| `enableSessionShell`          | Enables session shell execution; bearer token and session-bound client id are still required. |
| `promptDeadlineMs`            | Prompt wallclock limit.                                                                       |
| `writerIdleTimeoutMs`         | SSE writer idle timeout.                                                                      |
| `channelIdleTimeoutMs`        | How long to keep the ACP child warm after the last session closes.                            |
| `sessionReapIntervalMs`       | Session reaper scan interval.                                                                 |
| `sessionIdleTimeoutMs`        | Disconnected-session idle reaping time.                                                       |
| `rateLimit*`                  | Per-tier HTTP rate limit switch, thresholds, and window.                                      |

## `BridgeOptions` (programmatic bridge embedding)

`packages/acp-bridge/src/bridgeOptions.ts` defines bridge options. See [`03-acp-bridge.md`](./03-acp-bridge.md) for the full table. Key fields:

| Field                                                                                                                   | Effect                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `boundWorkspace`                                                                                                        | Required canonical workspace.                                                                 |
| `sessionScope`                                                                                                          | `'single'` (default) vs `'thread'`.                                                           |
| `initializeTimeoutMs`, `maxSessions`, `eventRingSize`, `permissionResponseTimeoutMs`, `maxPendingPermissionsPerSession` | Bounded resource caps.                                                                        |
| `channelFactory`                                                                                                        | Pluggable ACP child factory; default is `defaultSpawnChannelFactory`.                         |
| `fileSystem`                                                                                                            | `BridgeFileSystem` adapter. See [`07-workspace-filesystem.md`](./07-workspace-filesystem.md). |
| `permissionPolicy`, `permissionConsensusQuorum`, `permissionAudit`                                                      | Mediator wiring.                                                                              |
| `statusProvider`                                                                                                        | Daemon-host preflight cells.                                                                  |
| `childEnvOverrides`                                                                                                     | Per-handle environment additions or removals.                                                 |
| `contextFilename`                                                                                                       | Overrides `getCurrentGeminiMdFilename()`.                                                     |
| `channelIdleTimeoutMs`                                                                                                  | How long to keep the ACP child alive after the last session closes, in ms; default `0`.       |

## Important defaults

| Constant                          | File                    | Value             | Meaning                                                           |
| --------------------------------- | ----------------------- | ----------------- | ----------------------------------------------------------------- |
| `DEFAULT_MAX_SESSIONS`            | `bridge.ts`             | `20`              | Session cap before `SessionLimitExceededError`.                   |
| `MAX_EVENT_RING_SIZE`             | `bridge.ts`             | `1_000_000`       | Soft cap for `BridgeOptions.eventRingSize`; guards against typos. |
| `DEFAULT_RING_SIZE`               | `eventBus.ts`           | `8000`            | Per-session SSE replay ring depth.                                |
| `DEFAULT_MAX_QUEUED`              | `eventBus.ts`           | `256`             | Per-subscriber queue cap.                                         |
| `DEFAULT_MAX_SUBSCRIBERS`         | `eventBus.ts`           | `64`              | Per-bus subscriber cap.                                           |
| `WARN_THRESHOLD_RATIO`            | `eventBus.ts`           | `0.75`            | `slow_client_warning` trigger.                                    |
| `WARN_RESET_RATIO`                | `eventBus.ts`           | `0.375`           | Hysteresis re-arm threshold.                                      |
| `DEFAULT_INIT_TIMEOUT_MS`         | `bridge.ts`             | `10_000`          | ACP `initialize` handshake timeout.                               |
| `MCP_RESTART_TIMEOUT_MS`          | `bridge.ts`             | `300_000`         | Bridge timeout for `/workspace/mcp/:server/restart`.              |
| `DEFAULT_PERMISSION_TIMEOUT_MS`   | `bridge.ts`             | `5 * 60_000`      | Per-permission request wallclock.                                 |
| `DEFAULT_MAX_PENDING_PER_SESSION` | `bridge.ts`             | `64`              | Aligned with `DEFAULT_MAX_SUBSCRIBERS`.                           |
| `MAX_RESOLVED_PERMISSION_RECORDS` | `permissionMediator.ts` | `512`             | FIFO for recently resolved permissions.                           |
| `KILL_HARD_DEADLINE_MS`           | `spawnChannel.ts`       | `10_000`          | Per-channel graceful shutdown window.                             |
| `SHUTDOWN_FORCE_CLOSE_MS`         | `runQwenServe.ts`       | `5_000`           | HTTP server force-close timer.                                    |
| `MAX_READ_BYTES`                  | `fs/policy.ts`          | `256 * 1024`      | Read cap.                                                         |
| `MAX_WRITE_BYTES`                 | `fs/policy.ts`          | `5 * 1024 * 1024` | Write cap.                                                        |
| `MAX_DISPLAY_NAME_LENGTH`         | `bridge.ts`             | `256`             | Session `displayName` cap.                                        |

## Cross-references

- Auth settings: [`12-auth-security.md`](./12-auth-security.md)
- Capabilities and protocol version: [`11-capabilities-versioning.md`](./11-capabilities-versioning.md)
- Event ring and backpressure tuning: [`10-event-bus.md`](./10-event-bus.md)
- MCP pool / budget: [`05-mcp-transport-pool.md`](./05-mcp-transport-pool.md) and [`06-mcp-budget-guardrails.md`](./06-mcp-budget-guardrails.md)
- Permission policy: [`04-permission-mediation.md`](./04-permission-mediation.md)
- User operations guide: [`../../users/qwen-serve.md`](../../users/qwen-serve.md)

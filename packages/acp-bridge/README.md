# `@qwen-code/acp-bridge`

Shared ACP bridge primitives consumed by `qwen serve`, channels, IDE, TUI,
and remote-control adapters. Lives in the monorepo, not published to npm.

This is **PR 22a** of the Mode B daemon roadmap (#4175 Wave 5). The full
extraction is split:

| Slice             | Scope                                                                                                                                               | Status                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **PR 22a** (this) | Skeleton + `EventBus` + `inMemoryChannel` + `AcpChannel` types + `PermissionMediator` type-only stub                                                | this PR                                      |
| **PR 22b**        | Lift `BridgeClient` + `createHttpAcpBridge` + `defaultSpawnChannelFactory` from `cli/src/serve/httpAcpBridge.ts`                                    | after PR 17 (#4282) and PR 14b (#4271) merge |
| **PR 24**         | Implement the four `PermissionMediator` strategies (`first-responder`, `designated`, `consensus`, `local-only`) + pair-token revocation + audit log | Wave 5                                       |

## What's here today

- `eventBus` — per-session NDJSON pub/sub with bounded ring replay,
  `Last-Event-ID` reconnect, and slow-client backpressure
  (`slow_client_warning` → `client_evicted`).
- `inMemoryChannel` — paired NDJSON streams without spawning a child;
  used for in-process bridge tests and the parked Mode A
  (`qwen --serve`) path.
- `channel` — `AcpChannel` / `AcpChannelExitInfo` / `ChannelFactory`
  type contract that `httpAcpBridge.ts` already injects via
  `BridgeOptions.channelFactory`.
- `permission` — type-only `PermissionMediator` interface,
  `PermissionPolicy` literal union (4 strategies), and
  `PermissionResolution` discriminated union. **No implementation
  yet** — first-responder voting still lives in
  `cli/src/serve/httpAcpBridge.ts BridgeClient.requestPermission`.
  PR 24 will move that and add the other three policies behind this
  interface.
- `status` (PR 22b/1) — wire-contract status types for
  `/workspace/{mcp,skills,providers,env,preflight}` and
  `/session/:id/{context,supported-commands}` routes, the
  `STATUS_SCHEMA_VERSION` / `SERVE_*_EXT_METHODS` constants,
  `BridgeTimeoutError` / `MissingCliEntryError` /
  `BridgeChannelClosedError` typed exceptions, and the
  `mapDomainErrorToErrorKind` classifier (regex → `instanceof` after
  #4299 / #4300). The 27-symbol contract `acp-integration/acpAgent.ts`
  consumes lives here.
- `workspacePaths` (PR 22b/1) — `canonicalizeWorkspace` (the
  cross-module BX9_q contract used by `config.ts` / `settings.ts` /
  `sandbox.ts` / bridge to collapse boot-time + per-request workspace
  paths to one canonical key) plus `MAX_WORKSPACE_PATH_LENGTH`.
- `bridgeErrors` (PR 22b/1) — 11 typed `Error` subclasses the bridge
  throws (`SessionNotFoundError`, `WorkspaceMismatchError`,
  `RestoreInProgressError`, etc.); HTTP route layer
  `instanceof`-branches on these to map to specific status codes.
- `bridgeTypes` (PR 22b/1) — public bridge contract types:
  `BridgeSpawnRequest`, `BridgeSession`, `BridgeRestoreSessionRequest`,
  `BridgeSessionState`, `BridgeRestoredSession`, `BridgeSessionSummary`,
  `SessionMetadataUpdate`, `BridgeClientRequestContext`,
  `BridgeHeartbeatResult`, `BridgeHeartbeatState`, plus the
  `HttpAcpBridge` interface itself (~30-method facade).
- `bridgeOptions` (PR 22b/2) — `BridgeOptions` interface (factory
  construction contract: `boundWorkspace`, `channelFactory`,
  `maxSessions`, `eventRingSize`, `permissionResponseTimeoutMs`,
  persistence callbacks, etc.) and the new `DaemonStatusProvider`
  injection seam for daemon-host env / preflight cells (production
  impl in `cli/src/serve/daemonStatusProvider.ts`).

## What's not here yet

- The bridge core itself (`BridgeClient`, `createHttpAcpBridge`,
  `defaultSpawnChannelFactory`, all the `BridgeSession*` types).
  It stays in `packages/cli/src/serve/httpAcpBridge.ts` until the
  in-flight Wave 4 PRs that touch the bridge surface (#4282 PR 17 and
  #4271 PR 14b) merge — moving it now would create a 3-way merge
  on a 4400-LOC file for no win.
- The per-session FileSystemService injection point (PR 18 #4250
  introduced the boundary; PR 22b will parameterize bridge writes
  through it instead of the inline `BridgeClient.writeTextFile`).

## Imports — root vs subpaths

The package exposes both a barrel root (`@qwen-code/acp-bridge`) and
per-module subpaths (`/eventBus`, `/inMemoryChannel`, `/channel`,
`/permission`). They re-export the same symbols, so either form
resolves to the same module at runtime. Pick by intent:

- **Root** for application/test code that uses several primitives at
  once — concise and matches how `serve/` imports landed today.
- **Subpaths** for client adapters (TUI / channels / IDE / future
  `remoteControl`) that only consume one slice — keeps the
  dependency surface explicit and lets bundlers tree-shake the rest.

Both variants are stable. PR 22b will not change either set.

## Backward compatibility

`packages/cli/src/serve/eventBus.ts` and
`packages/cli/src/serve/inMemoryChannel.ts` remain as one-line
re-export wrappers, so every existing relative import inside
`serve/` and the one external import in `cli/src/commands/serve.ts`
keeps resolving without churn.

`httpAcpBridge.ts` continues to export `AcpChannel` /
`AcpChannelExitInfo` / `ChannelFactory` (now via re-export from this
package) so any external consumer of those types is unaffected.

## See also

- #4175 Wave 5 PR 22 row
- #3803 `Stage 1.5-prereq AcpChannel lift` (chiga0's original framing)
- `httpAcpBridge.ts:1096-1106` (FIXME pointing at the four
  `PermissionMediator` strategies this package now declares)

# `@qwen-code/acp-bridge`

Shared ACP bridge primitives consumed by `qwen serve`, channels, IDE, TUI,
and remote-control adapters. Lives in the monorepo, not published to npm.

Lift history (#4175 Mode B daemon roadmap):

| Slice                | Scope                                                                                                                                                                                      | Status         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| **PR 22a** (#4295)   | Skeleton + `EventBus` + `inMemoryChannel` + `AcpChannel` types + `PermissionMediator` type-only stub                                                                                       | ✅ merged      |
| **PR 22b/1** (#4298) | Lift `status` + `workspacePaths` + `bridgeErrors` + `bridgeTypes`                                                                                                                          | ✅ merged      |
| **PR 22b/2** (#4304) | Lift `BridgeOptions` + new `DaemonStatusProvider` injection seam                                                                                                                           | ✅ merged      |
| **F1** (#4490)       | Lift `defaultSpawnChannelFactory` + `BridgeClient` + `createHttpAcpBridge` factory closure + new `BridgeFileSystem` injection seam (22b' scope)                                            | ✅ merged      |
| **F3 PR 24**         | Implement the four `PermissionMediator` policies (`first-responder`, `designated`, `consensus`, `local-only`) plus audit/emit fan-out; pair-token binding and revocation stay future scope | ✅ implemented |

## What's here today

- `eventBus` — per-session NDJSON pub/sub with bounded ring replay,
  `Last-Event-ID` reconnect, and slow-client backpressure
  (`slow_client_warning` → `client_evicted`).
- `inMemoryChannel` — paired NDJSON streams without spawning a child;
  used for in-process bridge tests and the parked Mode A
  (`qwen --serve`) path.
- `channel` — `AcpChannel` / `AcpChannelExitInfo` / `ChannelFactory`
  type contract that `createHttpAcpBridge` (now in this package) plus
  the channels / VSCode IDE companion's own-spawn paths consume via
  `BridgeOptions.channelFactory`.
- `permission` — `PermissionMediator` interface,
  `PermissionPolicy` literal union (4 strategies), and
  `PermissionResolution` discriminated union. `MultiClientPermissionMediator`
  implements the four policies, owns pending/resolved permission state, and
  handles strategy dispatch plus audit/emit fan-out; `BridgeClient` only
  plumbs `requestPermission` into `mediator.request`.
- `status` (PR 22b/1) — wire-contract status types for
  `/workspace/{mcp,skills,providers,env,preflight}` and
  `/session/:id/{context,supported-commands,tasks}` routes, the
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
  persistence callbacks, etc.) plus the `DaemonStatusProvider`
  injection seam for daemon-host env / preflight cells (production
  impl in `cli/src/serve/daemon-status-provider.ts`) and the F1
  `BridgeFileSystem` injection seam for the ACP fs proxy.
  `delegateReadTextFileToClient` defaults to `true`; same-host daemon callers
  may set it to `false` so child text reads use the regular CLI filesystem
  service while final ACP text writes remain delegated.
- `spawnChannel` (F1) — `defaultSpawnChannelFactory` + `killChild` +
  `SCRUBBED_CHILD_ENV_KEYS` denylist + `scrubChildEnv` pure env-policy
  helper (exported for adapter reuse + unit-test access; isolates the
  scrub + override + defense-in-depth ordering invariant the security
  argument relies on). Production spawn of the `qwen --acp` child
  with stderr prefix-and-forward, kill cascade, and env passthrough.
  Channels (`packages/channels/base/AcpBridge.ts`) and the VSCode IDE
  companion consume this directly instead of each reimplementing the
  child lifecycle.
- `bridgeClient` (F1) — `BridgeClient` class implementing the ACP
  `Client` surface: permission requests delegated to
  `PermissionMediator`, session-update fan-out into `EventBus`,
  child-side `extNotification` routing, early-event buffer + tombstone
  bookkeeping, inline fs proxy for `writeTextFile` / `readTextFile`.
  Exports the supporting `BridgeClientSessionEntry` type consumed by
  the session-entry lookup passed in by the factory.
- `bridge` (F1) — `createHttpAcpBridge` factory closure (~3000 LOC)
  - `ChannelInfo` / `SessionEntry` interfaces + factory-only
    helpers (`withTimeout`, `canonicalizeExistingAncestor`,
    `verifyParentWithinWorkspace`, debug log helpers,
    `hasControlCharacter`) + factory constants. Owns session
    bookkeeping, constructs the `MultiClientPermissionMediator` that
    owns permission state, and passes the session-entry lookup into
    `BridgeClient`.
- `bridgeFileSystem` (F1) — `BridgeFileSystem` interface for the
  ACP fs proxy. When wired through `BridgeOptions.fileSystem`,
  `BridgeClient.readTextFile` / `BridgeClient.writeTextFile`
  delegate to it instead of the inline `fs.realpath` /
  `fs.writeFile` / `fs.readFile` proxy. Production `qwen serve` injects
  `WorkspaceFileSystem` for final ACP `writeTextFile` content writes and for
  defensive handling of unexpected or capability-violating delegated reads;
  normal same-host text reads stay in the child. The interface remains
  workspace-scoped by default. A daemon-owned adapter may recognize the
  strict versioned provenance of a final built-in-tool write and use its
  same-host writer for an external target; this is not a generic ACP
  capability or authorization token.

## Imports — root vs subpaths

The package exposes both a barrel root (`@qwen-code/acp-bridge`) and
per-module subpaths (`/eventBus`, `/inMemoryChannel`, `/channel`,
`/permission`, `/status`, `/workspacePaths`, `/bridgeErrors`,
`/bridgeTypes`, `/bridgeOptions`, `/spawnChannel`, `/bridgeClient`,
`/bridge`, `/bridgeFileSystem`). They re-export the same symbols, so
either form resolves to the same module at runtime. Pick by intent:

- **Root** for application/test code that uses several primitives at
  once — concise and matches how `serve/` imports landed today.
- **Subpaths** for client adapters (TUI / channels / IDE / future
  `remoteControl`) that only consume one slice — keeps the
  dependency surface explicit and lets bundlers tree-shake the rest.

Both variants are stable across the F1 lift.

## Backward compatibility

CLI code imports event-bus and in-memory channel primitives directly from
`@qwen-code/acp-bridge/eventBus` and
`@qwen-code/acp-bridge/inMemoryChannel`.

`packages/cli/src/serve/acp-session-bridge.ts` remains as the CLI-local
compatibility facade for the broader bridge surface, forwarding previously
exported symbols (`createHttpAcpBridge`, `defaultSpawnChannelFactory`,
`BridgeClient`, typed errors, and type aliases) from the lifted subpaths.

## See also

- #4175 Mode B daemon roadmap (feature-cohesive F1-F5 plan targeting
  `daemon_mode_b_main`)
- #3803 `Stage 1.5-prereq AcpChannel lift` (chiga0's original framing)
- `permissionMediator.ts` implements the four `PermissionMediator`
  strategies declared in `permission.ts`; `BridgeClient.requestPermission`
  delegates to that mediator.

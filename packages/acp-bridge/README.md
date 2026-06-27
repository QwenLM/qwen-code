# `@qwen-code/acp-bridge`

Shared ACP bridge primitives consumed by `qwen serve`, channels, IDE, TUI,
and remote-control adapters. Lives in the monorepo, not published to npm.

Lift history (#4175 Mode B daemon roadmap):

| Slice                | Scope                                                                                                                                               | Status                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **PR 22a** (#4295)   | Skeleton + `EventBus` + `inMemoryChannel` + `AcpChannel` types + `PermissionMediator` type-only stub                                                | ✅ merged                       |
| **PR 22b/1** (#4298) | Lift `status` + `workspacePaths` + `bridgeErrors` + `bridgeTypes`                                                                                   | ✅ merged                       |
| **PR 22b/2** (#4304) | Lift `BridgeOptions` + new `DaemonStatusProvider` injection seam                                                                                    | ✅ merged                       |
| **F1** (this PR)     | Lift `defaultSpawnChannelFactory` + `BridgeClient` + `createHttpAcpBridge` factory closure + new `BridgeFileSystem` injection seam (22b' scope)     | ✅ in this PR                   |
| **F3 PR 24**         | Implement the four `PermissionMediator` strategies (`first-responder`, `designated`, `consensus`, `local-only`) + pair-token revocation + audit log | F3 in the feature-cohesive plan |

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
- `permission` — type-only `PermissionMediator` interface,
  `PermissionPolicy` literal union (4 strategies), and
  `PermissionResolution` discriminated union. **No implementation
  yet** — first-responder voting still lives in
  `BridgeClient.requestPermission` (in `bridgeClient.ts` after F1).
  F3 PR 24 will move that and add the other three policies behind
  this interface.
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
  `Client` surface: first-responder permission flow, session-update
  fan-out into `EventBus`, child-side `extNotification` routing,
  early-event buffer + tombstone bookkeeping, inline fs proxy for
  `writeTextFile` / `readTextFile`. Exports the supporting
  `PendingPermission` / `PermissionResolutionRecord` /
  `BridgeClientSessionEntry` types + `MAX_RESOLVED_PERMISSION_RECORDS`
  cap that the factory's bookkeeping maps consume.
- `bridge` (F1) — `createHttpAcpBridge` factory closure (~3000 LOC)
  - `ChannelInfo` / `SessionEntry` interfaces + factory-only
    helpers (`withTimeout`, `canonicalizeExistingAncestor`,
    `verifyParentWithinWorkspace`, debug log helpers,
    `hasControlCharacter`) + factory constants. Builds the
    bookkeeping closures (`resolveEntry`, `registerPending`, etc.)
    and wires them into `BridgeClient`.
- `bridgeFileSystem` (F1) — `BridgeFileSystem` interface for the
  ACP fs proxy. When wired through `BridgeOptions.fileSystem`,
  `BridgeClient.readTextFile` / `BridgeClient.writeTextFile`
  delegate to it instead of the inline `fs.realpath` /
  `fs.writeFile` / `fs.readFile` proxy. Production `qwen serve`
  follow-up wraps PR 18's `WorkspaceFileSystem` here so writes
  get TOCTOU + symlink + trust-gate + audit guarantees.

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

`packages/cli/src/serve/event-bus.ts` and
`packages/cli/src/serve/in-memory-channel.ts` remain as one-line
re-export wrappers, so every existing relative import inside
`serve/` and the one external import in `cli/src/commands/serve.ts`
keeps resolving without churn.

After F1, `packages/cli/src/serve/httpAcpBridge.ts` shrinks to a
~97-line re-export shim that forwards every previously-exported
symbol (`createHttpAcpBridge`, `defaultSpawnChannelFactory`,
`BridgeClient`, all the typed errors, all the type aliases) from
the lifted subpaths. Every relative `./httpAcpBridge.js` import in
`server.ts` / `run-qwen-serve.ts` / `workspace-agents.ts` /
`workspace-memory.ts` / `index.ts` / the bridge test suite keeps
resolving without any call-site changes.

## See also

- #4175 Mode B daemon roadmap (feature-cohesive F1-F5 plan targeting
  `daemon_mode_b_main`)
- #3803 `Stage 1.5-prereq AcpChannel lift` (chiga0's original framing)
- F3 PR 24 will replace the inline first-responder logic in
  `BridgeClient.requestPermission` with the four `PermissionMediator`
  strategies declared in `permission.ts`.

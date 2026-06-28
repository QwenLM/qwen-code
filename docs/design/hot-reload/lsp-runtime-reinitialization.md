# LSP Runtime Hot Reload Design

## Background

This design follows the same layering used by
`mcp-runtime-reinitialization.md`: the CLI decides when to trigger reloads, and
Core decides how to update runtime state. It also reuses the watcher principles
from `settings-change-detection.md`: no filesystem side effects at startup,
debounced changes, semantic diffs, serialized listeners, and listener failures
that do not affect the main session.

The key difference between LSP and MCP is that LSP server configuration does not
live in `settings.json`. Today the native LSP service uses `LspConfigLoader` to
read the workspace `.lsp.json` and enabled extensions' `lspServers`
declarations, writes the result into the single-session `LspServerManager` via
`NativeLspService.discoverAndPrepare()`, and finally starts all configured
servers with `start()`. Therefore `SettingsWatcher` alone cannot detect changes
to the workspace `.lsp.json`.

## Current Code Assessment

- LSP startup is controlled only by `--experimental-lsp` in
  `packages/cli/src/config/config.ts`. There is currently no
  `--allowed-lsp-server-names` flag or equivalent LSP CLI allow-list parameter;
  the existing `--allowed-mcp-server-names` flag is MCP-only.
- `NativeLspService` is constructed once during CLI config loading. The startup
  path calls `discoverAndPrepare()`, then `start()`, then wraps the service in
  `NativeLspClient` and attaches it to `Config`.
- `Config.setLspClient()` and `Config.setLspInitializationError()` currently
  throw after initialization, so runtime hot reload should not replace the
  client object. It should keep the existing `NativeLspClient` and only
  incrementally reconcile the service behind it.
- `LspConfigLoader` only reads the workspace `.lsp.json` and active extensions'
  `lspServers`. The workspace `.lsp.json` overrides extension config by server
  name.
- `LspServerManager.setServerConfigs()` currently clears all handles; it does
  not yet support incremental reconcile.
- The current repository has no shared pool path for LSP. Each session owns its
  own `NativeLspService` and subprocess/socket connections. The design should
  leave a boundary for a future shared pool, but v1 only implements
  single-session mode.

## Goals

Make LSP server configuration changes take effect without restarting the
current Qwen Code session:

- start a server when it is added;
- stop a server when it is removed, and remove it from status and tool routing;
- restart only the changed server when its config changes;
- keep unchanged servers connected and preserve their warm-up state;
- never start servers that are untrusted or not allowed;
- let LSP tools and `/lsp` status observe the new runtime state through the
  existing client object.

## Non-goals

- Do not add a shared LSP process pool in this change.
- Do not support toggling `--experimental-lsp` at runtime. If LSP was not
  enabled at startup, there is no service to reload.
- Do not fully watch extension install/uninstall changes that affect
  `lspServers`; manual `/reload` will cover extension config changes.

## Design

### 1. Identify Each LSP Server With a Stable Hash

Add a small helper near the LSP config code:

```ts
export function lspServerConfigHash(config: LspServerConfig): string;
```

The hash must be stable and based on the normalized runtime config produced by
`LspConfigLoader`:

- `name`
- `languages`
- `transport`
- `command`
- `args`
- `env`
- `initializationOptions`
- `settings`
- `extensionToLanguage`
- `workspaceFolder`
- `rootUri`
- `startupTimeout`
- `shutdownTimeout`
- `restartOnCrash`
- `maxRestarts`
- `trustRequired`
- `socket`

Object keys must be sorted so JSON property order does not cause unnecessary
restarts. Array order stays significant because command argument order and
language priority can be meaningful. Do not include runtime fields such as
process id, status, restart count, diagnostics, or warm-up state.

For future shared-pool compatibility, define the pool identity as:

```text
lsp:<workspaceRoot>:<serverName>:<configHash>
```

The v1 single-session manager only needs to maintain `serverName -> configHash`,
but the same hash can later be reused directly in the pool key.

### 2. Add Incremental Reconcile to `LspServerManager`

Hot reload should not reuse `setServerConfigs()`, which clears every handle.
Add:

```ts
async reconcileServerConfigs(
  configs: LspServerConfig[],
): Promise<LspReconcileResult>
```

Flow:

1. Build desired maps: `name -> config` and `name -> hash`.
2. For existing handles whose server no longer exists, call the existing
   `stopServer()`, then delete the handle.
3. For existing handles whose hash changed, call `stopServer()`, replace the
   handle with `{ config, status: 'NOT_STARTED' }`, then start it.
4. For new servers, create `{ config, status: 'NOT_STARTED' }` and start them.
5. For servers whose hash did not change, do nothing and keep the existing
   handle.

Add a private field:

```ts
private serverConfigHashes = new Map<string, string>();
```

Clear it in `stopAll()` and `clearServerHandles()`.

Return:

```ts
interface LspReconcileResult {
  added: string[];
  removed: string[];
  restarted: string[];
  unchanged: string[];
}
```

`skipped` is not part of the `LspServerManager` result. The manager only handles
configs that have passed admission; servers rejected by admission are aggregated
into the service-level result by `NativeLspService.reinitialize()`.

Concurrency:

- Add a reconcile queue in either `LspServerManager` or `NativeLspService` so
  reconciles run serially. Stopping and starting the same process must not race.
- If a new config arrives while a server is still starting, wait for
  `handle.startingPromise` before stopping it. Reuse the existing startup lock
  instead of adding an extra per-server lock.

Failure behavior:

- If a newly added or changed server fails to start, keep the handle and mark it
  as `FAILED` so `/lsp` can explain the failure.
- If a removed server logs an error during shutdown, still delete it from the
  handle map.
- One server's startup failure must not block reconcile for other servers.

### 3. Add `NativeLspService.reinitialize()`

Add:

```ts
async reinitialize(): Promise<LspServiceReinitializeResult>
```

Flow:

1. If `requireTrustedWorkspace` is true and `!config.isTrustedFolder()`, call
   `serverManager.stopAll()` and return. This prevents old LSP processes from
   continuing after the workspace becomes untrusted.
2. Use the existing `LspConfigLoader` to load the workspace `.lsp.json` and
   extension configs.
3. Merge configs using the current precedence.
4. Apply the LSP admission filter before reconcile.
5. Call `serverManager.reconcileServerConfigs(serverConfigs)`.
6. Clear `openedDocuments` and `lastConnections` only for removed and restarted
   servers; preserve document state for unchanged servers.

`.lsp.json` parse failures need special handling: do not treat parse failure as
empty config. The watcher or loader should return a parse-failed state;
`reinitialize()` should preserve the old runtime state, skip reconcile, and
write the error to status/logs. Only deleting the file, or parsing a valid empty
JSON config, means the desired config is empty.

`NativeLspService.reinitialize()` returns a service-level result:

```ts
interface LspServiceReinitializeResult {
  reconcile: LspReconcileResult;
  skipped: Array<{
    name: string;
    reason: 'not_allowed' | 'workspace_untrusted' | 'server_trust_required';
  }>;
}
```

Add an optional `reinitialize()` method to `NativeLspClient` and delegate to the
service. To avoid opaque type assertions in `Config.reinitializeLsp()`, extend
the `LspClient` interface directly:

```ts
reinitialize?: () => Promise<LspServiceReinitializeResult>;
```

Add to `Config`:

```ts
async reinitializeLsp(): Promise<LspServiceReinitializeResult | undefined>
```

When LSP is disabled or no client exists, this is a no-op. This method must not
replace the client after `Config.initialize()`.

Because `setLspInitializationError()` currently rejects calls after
initialization, add a runtime-safe private state setter:

```ts
private setRuntimeLspInitializationError(error: Error | string | undefined): void
```

`reinitializeLsp()` uses it to expose reload failures through
`getLspStatusSnapshot()` without loosening the public post-init client mutation
API.

### 4. Admission and Permission Boundary

Current LSP safety checks include:

- `--experimental-lsp` is the only enablement switch;
- workspace trust is checked before discovery/startup;
- each server's `trustRequired` defaults to true;
- command existence and command path safety are checked before spawn;
- `workspaceFolder` is constrained to the workspace root.

Hot reload must preserve these checks and complete them before starting a new
server or restarting a changed server. The key rule is: do not spawn first and
decide whether the server is allowed later.

Allow-list boundary:

- The current repository does not support a CLI allow-list for LSP server names.
  I confirmed LSP only has `--experimental-lsp`; allow-list parameters are
  MCP-only.
- If this feature adds `--allowed-lsp-server-names`, it must behave like the MCP
  startup allow-list and act as an upper bound for the entire session lifetime.
  Runtime config may narrow this set, but it must not expand beyond the CLI
  startup upper bound.
- Store the startup upper bound in `ConfigParameters.lsp`:

```ts
cliAllowedLspServerNames?: string[];
```

Expose a getter for it. Do not read the upper bound from mutable settings.

Admission should be extracted into a pure function:

```ts
filterLspServerConfigs(configs, {
  workspaceTrusted,
  requireTrustedWorkspace,
  cliAllowedServerNames,
}): {
  admitted: LspServerConfig[];
  skipped: Array<{
    name: string;
    reason: 'not_allowed' | 'workspace_untrusted' | 'server_trust_required';
  }>;
}
```

Even though there is no LSP approval store today, this helper makes the security
boundary explicit and leaves room for future hash-based approval gates.

Trust semantics must match the current startup path:

- If `requireTrustedWorkspace` is true and the workspace is untrusted,
  `NativeLspService.reinitialize()` stops all servers at the service layer and
  returns. It does not enter the admission filter and does not preserve old
  servers.
- If `requireTrustedWorkspace` is false, the service does not short-circuit
  globally, but the admission filter still skips individual servers with
  `trustRequired: true`.
- If the workspace is trusted, `trustRequired` does not block the server.

### 5. Triggering

Two trigger paths are needed.

#### Automatic Workspace `.lsp.json` Trigger

Add a narrow `LspConfigWatcher` in the CLI, modeled after `SettingsWatcher` but
with a smaller responsibility:

- watch only the workspace root and strictly match basename `.lsp.json`;
- do not create any directory or file;
- debounce for 300 ms;
- compare `.lsp.json` before/after using parse + canonicalize so formatting-only
  changes do not trigger reload;
- on parse failure, do not notify the reload listener; preserve the old runtime
  state and log the parse error. File deletion is a separate event and should
  notify the reload listener, producing empty workspace config;
- run callbacks serially;
- use listener timeout and failure isolation matching `SettingsWatcher`.

Register the watcher only when `config.isLspEnabled()` and the client supports
`reinitialize()`. On change, call:

```ts
await config.reinitializeLsp();
```

Then emit an explicit runtime event such as `AppEvent.LspStatusChanged`.
UI surfaces such as `/lsp`, `/about`, or `/status` can subscribe to that event
to refresh. On failure, also show a user-visible error through
`AppEvent.LogError`; do not only write a debug log.

#### Manual `/reload` Trigger

When the future `/reload` command lands, it should call both:

```ts
await config.reinitializeMcpServers(...);
await config.reinitializeLsp();
```

Manual reload also provides the fallback path for extension `lspServers`
changes, because those changes may not map to a workspace `.lsp.json` file
event.

## Single Session and Shared Pool

Current state: only single-session mode exists. The repository has no LSP
equivalent of the MCP transport pool.

v1: implement incremental reconcile inside `LspServerManager`. Each session owns
its own process and socket.

Future shared pool: keep `NativeLspService` as the consumer and replace
`LspServerManager` internals with acquire/release of:

```text
lsp:<workspaceRoot>:<name>:<hash>
```

pool entries. Admission filtering must still happen before acquire, matching the
MCP shared-pool fix, so disallowed or untrusted servers cannot be started
through the pool path.

## Unit Test Plan

Prioritize unit tests. Integration tests against real LSP servers are slow and
environment-dependent, so they are not required.

### Core Tests

`packages/core/src/lsp/configHash.test.ts`

- hash ignores object key order;
- changes to command, args order, env, settings, workspace folder, socket, and
  trust requirement change the hash;
- hash excludes status/process/runtime fields.

`packages/core/src/lsp/LspServerManager.test.ts`

- adding a server starts it exactly once;
- removing a server shuts it down and deletes it from handles;
- hash changes stop the old handle and start a new handle;
- unchanged hash does not stop/start and preserves handle identity;
- one server startup failure does not affect another server's reconcile;
- concurrent reconciles run serially;
- `stopAll()` and `clearServerHandles()` clear the hash map;
- reconcile return value only contains added/removed/restarted/unchanged, not
  admission skipped.

Mock `createLspConnection`, initialization, and shutdown in tests. Do not start
real language servers.

`packages/core/src/lsp/NativeLspService.test.ts`

- `reinitialize()` loads workspace and extension config and passes merged config
  to manager reconcile;
- `.lsp.json` parse failure preserves old runtime state and does not call
  manager reconcile;
- deleting `.lsp.json` treats workspace config as empty and triggers reconcile;
- untrusted workspace stops all servers and does not reconcile/start;
- if a CLI allow-list is implemented, the upper bound filters admitted configs;
- service-level return value aggregates admission skipped reasons;
- restarted/removed servers only clear their own document tracking.

`packages/core/src/config/config.test.ts`

- `reinitializeLsp()` is a no-op when disabled or no client exists;
- when enabled and the client supports `reinitialize`, it delegates the call;
- when reinitialize throws, the status snapshot exposes the initialization/reload
  error.

### CLI Tests

`packages/cli/src/config/lspConfigWatcher.test.ts`

- does not create `.lsp.json`;
- detects create/modify/delete;
- ignores unrelated files;
- ignores formatting-only changes after canonical parse;
- parse failure does not trigger the reload listener and records an error;
- deleting `.lsp.json` triggers the reload listener;
- duplicate file events are debounced;
- slow listeners run serially;
- listener failure does not affect later notifications.

`packages/cli/src/ui/AppContainer.test.tsx` or the corresponding event test

- `AppEvent.LspStatusChanged` triggers UI refresh;
- reload failure emits a user-visible error through `AppEvent.LogError`.

`packages/cli/src/config/config.test.ts`

- preserve the existing assertion that `--experimental-lsp` constructs and
  starts native LSP;
- if `--allowed-lsp-server-names` is added, the parser supports comma-separated
  values and repeated flags, and stores them as the startup upper bound.

`packages/cli/src/ui/commands/lspCommand.test.ts`

- if `LspStatusSnapshot` exposes skipped reasons, status output can show
  skipped/disallowed servers.

Coverage goals: new pure functions should be near 100%; watcher branch coverage
should be comparable to `SettingsWatcher`; manager reconcile must cover
add/remove/change/unchanged/failure/concurrency.

## Strict Review

### Conclusion

1. **v1 should not use stop-all/start-all.**
   That implementation is simplest, but every save would restart unchanged
   language servers and lose warm state. The current manager already has
   per-server lifecycle methods, and incremental reconcile is a manageable
   amount of additional code.

2. **Do not put `.lsp.json` changes into `SettingsWatcher`.**
   `SettingsWatcher` is responsible for settings-scope reloads. Making it watch
   arbitrary workspace files would blur the contract and make MCP/settings
   behavior harder to reason about. A separate, narrow `.lsp.json` watcher is
   clearer.

3. **Do not replace `NativeLspClient` after initialization.**
   `Config.setLspClient()` explicitly forbids post-init mutation. Updating the
   service behind the adapter avoids expanding the lifecycle API.

4. **Admission must happen before process spawn or pool acquire.**
   This is the same risk called out in the MCP shared-pool design. Even though
   LSP has no pool today, service-level reload results should return pre-start
   filtering skipped reasons so a future pool path does not accidentally start a
   rejected server.

5. **A new LSP CLI allow-list is optional, but if added it must be an upper
   bound.**
   The current code has no LSP allow-list. The design must not allow settings to
   expand command-line restrictions at runtime, or it would be weaker than MCP
   hot-reload security semantics.

### Remaining Risks

- Extension `lspServers` may change without `.lsp.json` changing. The automatic
  watcher does not cover all extension filesystem changes; manual `/reload`
  covers that path.
- Some language servers do not tolerate rapid restarts well. Serialized
  reconcile and debounce reduce the risk, but tests should cover fast
  consecutive changes.
- TCP/socket servers may be externally managed daemons. Reconcile should close
  the connection, but it should only assume ownership of the process when this
  process spawned the server via `command`.

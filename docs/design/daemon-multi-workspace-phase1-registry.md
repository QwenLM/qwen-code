# Daemon Multi-Workspace Phase 1 Registry

## Summary

Phase 1 introduces the internal single-runtime registry for `qwen serve` plus
the two guardrails now called out in issue #6378: daemon-scoped identity and
repeatable `--workspace` input handling. The daemon still serves exactly one
primary workspace. Route/API behavior remains unchanged except that multiple
explicit `--workspace` values now fail loudly instead of falling into the old
single-workspace path. Daemon log filename and telemetry service instance id
also intentionally change from workspace-scoped to daemon-scoped identity; the
PR release notes should call out that migration.

The registry is the future internal boundary for issue #6378's multi-workspace
rollout, but this step intentionally avoids protocol/schema expansion and does
not enable multi-workspace CLI behavior.

## Design

- `WorkspaceRuntime` wraps the current single-workspace serve objects:
  `workspaceCwd`, `AcpSessionBridge`, `DaemonWorkspaceService`, the REST route
  filesystem factory, and the current client-MCP sender registry.
- `WorkspaceRegistry` exposes only `primary`, `list()`, and exact
  `getByWorkspaceCwd()` lookup.
- `createServeApp` constructs the existing bridge/service/fsFactory stack first,
  then wraps it as the primary runtime.
- Existing `app.locals.fsFactory` and `app.locals.boundWorkspace` remain in
  place for current file routes. `app.locals.workspaceRegistry` is additive.
- Route modules keep their current signatures. The server assembly layer now
  passes values from `workspaceRegistry.primary`.
- Daemon log file names and telemetry service instance ids are daemon-scoped
  (`serve-<pid>.log`, `daemon:<pid>`). Workspace hash remains an attribute on
  log/telemetry records instead of being part of daemon identity.
- `runQwenServe` accepts the possible yargs runtime shape where `workspace` is
  an array. A single value still behaves like the existing single workspace;
  multiple values boot-error until multi-workspace support is enabled.

## Bounds

- No repeatable `--workspace` support yet; repeated values are rejected.
- No `workspaces[]` in `/capabilities` or daemon status.
- No SDK type changes.
- No plural `/workspaces/:workspace/...` routes.
- No session ownership index, env overlay, `maxTotalSessions`, or
  workspace-qualified ACP/voice/channel worker behavior.

## Audit Notes

The route filesystem factory is named `routeFileSystemFactory` because
production currently distinguishes bridge file access from REST route file
access. The registry must not collapse those boundaries.

`ClientMcpSenderRegistry` remains the current process-scoped single-daemon map
in this phase. The runtime stores the existing instance only; workspace-scoped
client-MCP isolation is a later multi-workspace concern.

`SessionArchiveCoordinator` and `WorkspaceRememberTaskLane` stay as current
server assembly collaborators. They are not registry core responsibilities in
Phase 1.

The daemon telemetry middleware now resolves the workspace cwd at request time,
even though Phase 1 still always resolves to primary. This preserves current
behavior while avoiding a primary-workspace hash closure that would be wrong
once workspace-qualified routes land.

## Verification

Targeted tests cover exact registry lookup, `createServeApp` locals exposure,
injected route filesystem factory preservation, existing file-route locals
behavior, daemon-scoped log/telemetry identity, request-time workspace hashing,
yargs single/repeated `--workspace` shapes, the single-workspace array path,
and the repeated `--workspace` boot guard. Final verification should run the
focused serve tests plus repository build and typecheck.

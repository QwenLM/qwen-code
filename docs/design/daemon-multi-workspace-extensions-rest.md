# Daemon Multi-Workspace: Workspace-Qualified Extensions REST

## Summary

Mirror the daemon's extension-management REST surface from the singular,
primary-bound `/workspace/extensions/*` to an additional workspace-qualified
`/workspaces/:workspace/extensions/*`, reusing the Phase 3 (issue #6378) runtime
resolver and trust gate. Extensions were the last core REST surface deliberately
left on the primary in Phase 3 (see the `workspace_qualified_rest_core` note in
`packages/cli/src/serve/capabilities.ts`). A new baseline capability tag,
`workspace_qualified_extensions`, lets clients discover the plural surface, and
the SDK `WorkspaceDaemonClient` gains matching convenience methods.

## Motivation

`qwen serve` can host several workspaces in one daemon. Phase 3 brought the core
REST surface (file, status, settings, permissions, trust, lifecycle, MCP, tool,
memory, agents, session storage) to `/workspaces/:workspace/...`, but explicitly
excluded extensions. This change closes that gap so ACP/SDK clients (and, later,
the Web Shell) can manage extensions for a specific hosted workspace rather than
only the primary one.

## Design

### Per-workspace controller extraction

Unlike the stateless Phase 3 routes (which duplicate handlers), the extensions
routes hold significant per-workspace mutable state: an install-serialization
queue, an async operation-history map, and a short-lived status cache. To avoid
duplicating ~400 lines of handler logic and to keep that state correct, the
per-workspace machinery is factored into
`createExtensionsController(deps)` in
`packages/cli/src/serve/routes/workspace-extensions-controller.ts`. Each
controller binds one workspace's `bridge`, `workspaceService`, and
`workspaceCwd`, and owns that workspace's queue, operation map, and status cache.

`registerWorkspaceExtensionRoutes` in
`packages/cli/src/serve/routes/workspace-extensions.ts` writes the nine handlers
once inside an internal `registerFor(base, resolveController)` and mounts them
twice:

- Singular `base = '/workspace/extensions'`, resolving to the primary
  controller (behavior unchanged).
- Plural `base = '/workspaces/:workspace/extensions'`, resolving the runtime per
  request and dispatching to that runtime's controller.

A `Map<workspaceCwd, ExtensionsController>` is seeded with the primary
controller, so the primary workspace shares one queue/operation-map/cache across
both the singular and plural routes (two competing install queues for one
extensions directory would risk corruption and inconsistent operation polling).
Non-primary controllers are created lazily on first plural request.

### Resolution and trust gate

The plural resolver reuses `workspace-route-runtime.ts`:

- `resolveWorkspaceRuntimeFromParam` — unknown selector -> `400 { code:
"workspace_mismatch" }`, never falling back to the primary.
- `requireTrustedWorkspaceRuntime` — used for mutations only.

Trust policy follows the two established Phase 3 precedents by verb: reads
(`GET` status, `GET` operations) resolve the runtime only (mirroring
`registerWorkspaceQualifiedFileReadRoutes`), while mutations
(install/check-updates/refresh/enable/disable/update/delete) additionally
require a trusted workspace (mirroring MCP control), returning
`403 { code: "untrusted_workspace" }` and never spawning work on an untrusted
workspace.

### Routes

Nine routes, mirrored 1:1:

- `GET /workspaces/:workspace/extensions`
- `GET /workspaces/:workspace/extensions/operations/:operationId`
- `POST /workspaces/:workspace/extensions/install`
- `POST /workspaces/:workspace/extensions/check-updates`
- `POST /workspaces/:workspace/extensions/refresh`
- `POST /workspaces/:workspace/extensions/:name/enable`
- `POST /workspaces/:workspace/extensions/:name/disable`
- `POST /workspaces/:workspace/extensions/:name/update`
- `DELETE /workspaces/:workspace/extensions/:name`

### Capability

A new baseline tag `workspace_qualified_extensions: { since: 'v1' }` is added to
`SERVE_CAPABILITY_REGISTRY` (not in `CONDITIONAL_SERVE_FEATURES`), advertised
unconditionally like `workspace_qualified_rest_core`: presence means the plural
routes exist on this build, independent of how many workspaces are hosted. A
dedicated tag (rather than folding into `workspace_qualified_rest_core`) is used
because `rest_core` is a baseline tag that already ships advertised without
extensions, so folding would give clients no version signal; a dedicated tag
preserves the codebase's "tag presence = behavior on" contract and matches the
Phase 4 precedent of adding its own tag. The `ServeFeature` type derives from the
registry, so no additional type wiring is needed; the `/capabilities` response
picks the tag up automatically via `getAdvertisedServeFeatures`.

### SDK

`WorkspaceDaemonClient` (obtained via `client.workspaceByCwd` /
`client.workspaceById`) gains `workspaceExtensions`, `extensionOperationStatus`,
`installExtension`, `checkExtensionUpdates`, `refreshExtensions`,
`enableExtension`, `disableExtension`, `updateExtension`, and
`uninstallExtension`, reusing the existing extension request/response types.

## Testing

- `packages/cli/src/serve/routes/workspace-qualified-extensions.test.ts`:
  capability advertisement; trusted/untrusted reads; unknown-selector mismatch;
  untrusted-mutation refusal; a mutation runs on the target workspace's bridge
  (not the primary); the primary controller is shared across singular and plural
  routes; per-workspace operation-history isolation.
- `packages/cli/src/serve/server.test.ts`: the baseline feature-set assertions
  include the new tag; existing singular extension-route tests are unchanged.
- `packages/sdk-typescript/test/unit/DaemonClient.test.ts`: the plural extension
  methods hit the expected `/workspaces/:workspace/extensions/*` URLs.

## Out of scope

- Relaxing the mutation trust gate to allow read-only access to untrusted
  workspaces (currently a conservative refusal for mutations only).
- Dynamic workspace add/remove (Phase 5); the controller map uses lazy
  get-or-create, which is equivalent under today's static registry.
- Web Shell UI for per-workspace extension management.

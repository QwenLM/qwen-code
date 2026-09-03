# Session resource catalog

## Problem

The daemon exposes Skill and MCP snapshots only at workspace scope:

- `GET /workspace/skills`
- `GET /workspace/mcp`
- `GET /workspaces/:workspace/skills`
- `GET /workspaces/:workspace/mcp`

A live session can use a Config rooted at a different working directory, such
as a generated worktree. Workspace snapshots can therefore describe a newer
or different configuration than the one the session actually loaded. A client
that renders resources for a selected session must not infer that relationship
from `workspaceCwd` or read settings files itself.

## API

Add the live-session-owner route:

```text
GET /session/:id/resources
```

It returns the sanitized Skill and MCP status projections built from that
session's live Config:

```json
{
  "v": 1,
  "sessionId": "session-1",
  "workspaceCwd": "/worktrees/session-1",
  "skills": {
    "v": 1,
    "workspaceCwd": "/worktrees/session-1",
    "initialized": true,
    "skills": []
  },
  "mcp": {
    "v": 1,
    "workspaceCwd": "/worktrees/session-1",
    "initialized": true,
    "discoveryState": "completed",
    "servers": []
  }
}
```

The nested objects deliberately reuse the existing workspace status contracts
without creating a second projection that can drift. Their `workspaceCwd`
values identify the Config that produced each snapshot and must match the
top-level value. Session snapshots omit workspace-owned MCP authentication,
pool, budget, and discovery-error fields because those sources are not keyed by
the selected session.

The route is observational. It does not initialize MCP discovery, attach a
client, reload settings, or create a runtime. Unknown, persisted-only, draining,
or otherwise unavailable sessions retain the existing owner-routed failure
semantics. Virtual subagent sessions are out of scope.

## Ownership and transport

The route is `live-session-owner` scoped. The daemon resolves the session owner
before dispatch and never falls back to the primary workspace runtime. The ACP
bridge sends `qwen/status/session/resources` through the connection that owns
the session. The ACP child resolves `sessionId` to its live `Session`, reads
`session.getConfig()`, and passes that Config to the existing sanitized Skill
and MCP status builders.

This must not be implemented by combining workspace routes: the workspace MCP
snapshot may aggregate data from several session Configs, while the workspace
Skill snapshot is rooted at the runtime's base Config.

The session projection therefore uses the selected Config's MCP manager for
status, discovery, and accounting; resolves Skill disablement details from the
selected Config's cached settings; omits workspace pool entry summaries,
workspace budget accounting, workspace discovery errors, and name-keyed OAuth
state; and disables the workspace-only fallback that scans other sessions for
resource and prompt counts. Two sessions with the same server name must not
affect each other's result.

## Compatibility and security

The daemon advertises `session_resources`. Older daemons return 404 and omit
the capability, so clients must pre-flight the tag before calling the route.
The TypeScript SDK exposes the route on both `DaemonClient` and
`DaemonSessionClient`.

The response inherits the existing redaction contract. It never includes MCP
headers, environment values, OAuth credentials, Skill bodies, hook definitions,
provider secrets, or raw settings documents.

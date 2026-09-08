# Minimal API profile

External REST integrations can run `qwen serve --no-web` today, but that flag
only removes UI assets. This change adds an opt-in route subset through
`--api-profile=minimal`; `full` remains the default.

Reuse existing handlers and authentication. One path gate runs before Web
Shell and channel webhook mounts, with authentication first. Reuse the gate
in the bootstrap app. Disable the existing ACP transport mount in minimal
mode so its shared raw WebSocket listener cannot bypass Express.

Capabilities are intersected with the subset at both response builders.
Disabled routes return 403 because SDK idempotent deletes treat 404 as success.
Existing session, permission, and filesystem handlers keep their own ownership,
trust, and validation checks. The subset's legacy session routes retain their
existing live-session ownership; file and workspace-tool routes retain primary-workspace
scope. No workspace-routing fallback is added.

The route list is documented in the existing protocol reference. A separate
hand-maintained OpenAPI contract and public Node embedding export are deferred.
This feature is not a sandbox or per-token authorization policy: approved agent
tools retain their existing authority.

Verify real HTTP routing, authentication ordering, capability filtering,
bootstrap behavior, and rejected WebSocket upgrades. Verify the default full
profile still exposes its existing routes and transport.

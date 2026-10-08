# MCP Management Runtime Model

MCP configuration is the durable source of truth. Each CLI or Web session
continues to own an independent MCP runtime so the CLI does not depend on a
workspace management process.

The Web management page may create an optional management runtime for status
and management operations. Configuration-changing operations persist first,
then reconcile every live runtime in the same ACP process. A later session
loads the persisted configuration normally.

Management status is read from the management runtime's client manager, not
from the process-wide compatibility status map. The compatibility map remains
unchanged for existing CLI consumers. Shared-pool reconnects restart the pool
entry; non-pooled reconnects rediscover the server in each live runtime.

Server provenance remains distinct: user settings, workspace settings,
project `.mcp.json`, and extensions. Disabling project or workspace servers
writes the exclusion to workspace-local settings without modifying the shared
project file.

## Daemon API ownership

Durable MCP configuration uses `/workspace/config/mcp/*` for user scope and
`/workspaces/:workspace/config/mcp/*` for workspace scope. Runtime observation
and control use the matching `/runtime/mcp/*` routes. Qualified routes always
resolve the selected workspace and never fall back to the primary runtime.
Runtime operations and workspace-scoped configuration mutations require trust;
daemon-local configuration reads and user-scoped mutations do not.

Each workspace coordinator serializes MCP preparation, reload, restart, and
authentication against its physical ACP runtime. Its capability status exposes
an operation `revision` and the observed `runtimeEpoch`; consumers may render
them but do not send them back. The revision rejects stale results from an
older MCP operation, while the epoch rejects results from a replaced ACP child.
A result is ready only when discovery is complete and came from the current
live epoch. Configuration written while the runtime is cold is durable and
reconciles on the next ensure. Configuration written during a drain is replayed
if the drain rolls back.

OAuth remains owned by each workspace's ACP child, while daemon-global
admission serializes authentication because every child uses the same callback
port. The owning Bridge retains admission until authentication is observed as
settled or its runtime exits.

The Web Shell MCP manager uses configuration routes for add, edit, remove,
enable, and disable, and runtime routes for status, discovery, tools,
resources, restart, approval, and OAuth. Existing legacy MCP routes remain as
a compatibility surface for older clients.

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

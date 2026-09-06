/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Upper bound on a single MCP server (re)discovery. The MCP manager's
// per-server discovery can take up to 5 minutes
// (McpClientManager.MAX_DISCOVERY_TIMEOUT_MS). Both the bridge
// (server-side race deadline) and the SDK (client-side default) must
// agree on this value
export const MCP_RESTART_SERVER_DEADLINE_MS = 300_000;

// Extra headroom so the client AbortSignal never fires before the
// daemon finishes serializing its success/error response.
export const MCP_RESTART_CLIENT_HEADROOM_MS = 30_000;

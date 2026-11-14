/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Enum representing the connection status of an MCP server
 */
export enum MCPServerStatus {
  /** Server is disconnected or experiencing errors */
  DISCONNECTED = 'disconnected',
  /** Server is in the process of connecting */
  CONNECTING = 'connecting',
  /** Server is connected and ready to use */
  CONNECTED = 'connected',
}

/**
 * Map to track the status of each MCP server within the core package
 */
const serverStatuses: Map<string, MCPServerStatus> = new Map();

/**
 * The most recent connect/discovery failure message per server. Discovery is
 * best-effort and swallows connect errors (logged only via `debugLogger`),
 * so the status enum alone cannot tell a consumer WHY a server is not
 * CONNECTED. Producers that fail a connect/discovery record the cause here;
 * consumers that observe a non-CONNECTED status (e.g. `qwen mcp reconnect`)
 * can read it back. Entries are dropped automatically when the server
 * reaches CONNECTED or is removed from the registry.
 */
const serverLastErrors: Map<string, string> = new Map();

/**
 * Record the most recent connect/discovery failure message for a server.
 */
export function recordMCPServerLastError(
  serverName: string,
  message: string,
): void {
  serverLastErrors.set(serverName, message);
}

/**
 * The most recently recorded connect/discovery failure message for a server,
 * or `undefined` when nothing is recorded (never failed, last attempt
 * succeeded, or the server was removed from the registry).
 */
export function getMCPServerLastError(serverName: string): string | undefined {
  return serverLastErrors.get(serverName);
}

/**
 * Servers whose owner is tearing them down on purpose: operator Disconnect,
 * Clear OAuth, `disableMcpServer`, pool eviction, session shutdown. A
 * deliberate teardown and abort damage both write `CONNECTED -> DISCONNECTED`,
 * so the transition alone cannot tell them apart; the owner records the
 * intent here BEFORE it starts closing the transport, and abort recovery
 * reads it back to stay out of the way. Cleared by `updateMCPServerStatus`
 * when the server next reaches `CONNECTED`, and by `removeMCPServerStatus`
 * when it leaves the registry, so the marker never outlives the teardown it
 * describes.
 */
const deliberateTeardownServers: Set<string> = new Set();

/**
 * Record that `serverName` is being torn down on purpose. Call this before
 * the transport actually closes: an abort repair that runs inside the status
 * notification otherwise sees the transition as unrequested damage. The
 * marker is dropped inside `updateMCPServerStatus` once the server reaches
 * `CONNECTED` again, and in `removeMCPServerStatus` when it leaves the
 * registry, so it never outlives the teardown it describes.
 */
export function markMCPServerTeardownIntent(serverName: string): void {
  deliberateTeardownServers.add(serverName);
}

/** Whether `serverName` is currently being torn down on purpose. */
export function isMCPServerTeardownIntent(serverName: string): boolean {
  return deliberateTeardownServers.has(serverName);
}

/**
 * Per-connection status, keyed by the SDK `Client` instance that owns the
 * transport. The name-keyed registry above cannot tell two live connections
 * for the same server name apart — the pool intentionally keeps one entry per
 * `serverName + fingerprint` — so an abort repair reading only the name would
 * attribute a sibling connection's drop to the invocation that armed it.
 */
const connectionStatuses: WeakMap<object, MCPServerStatus> = new WeakMap();

/**
 * Record the status of one connection. Called by the owner of the SDK
 * `Client` alongside each name-keyed write, so consumers that hold the client
 * can read their own connection's truth rather than the shared name.
 */
export function recordMCPConnectionStatus(
  connection: object,
  status: MCPServerStatus,
): void {
  connectionStatuses.set(connection, status);
}

/**
 * The most recent status recorded for `connection`, or `undefined` when the
 * connection is not tracked (legacy single-connection paths).
 */
export function getMCPConnectionStatus(
  connection: object | undefined,
): MCPServerStatus | undefined {
  if (!connection) return undefined;
  return connectionStatuses.get(connection);
}

/**
 * Event listeners for MCP server status changes.
 * `status` is `undefined` when the server has been removed from the registry
 * (e.g. disabled via `/mcp`), so consumers can drop it from their snapshots
 * rather than continue to count it as `DISCONNECTED`.
 */
type StatusChangeListener = (
  serverName: string,
  status: MCPServerStatus | undefined,
) => void;
const statusChangeListeners: StatusChangeListener[] = [];

/**
 * Add a listener for MCP server status changes
 */
export function addMCPStatusChangeListener(
  listener: StatusChangeListener,
): void {
  statusChangeListeners.push(listener);
}

/**
 * Remove a listener for MCP server status changes
 */
export function removeMCPStatusChangeListener(
  listener: StatusChangeListener,
): void {
  const index = statusChangeListeners.indexOf(listener);
  if (index !== -1) {
    statusChangeListeners.splice(index, 1);
  }
}

/**
 * Update the status of an MCP server
 */
export function updateMCPServerStatus(
  serverName: string,
  status: MCPServerStatus,
): void {
  serverStatuses.set(serverName, status);
  if (status === MCPServerStatus.CONNECTED) {
    // A live connection invalidates any previously recorded failure cause;
    // keeping it would let a stale error shadow a recovered server.
    serverLastErrors.delete(serverName);
    // Same for a teardown marker: a server that answers again is not being
    // torn down, so a repair listener must not skip its next real drop.
    deliberateTeardownServers.delete(serverName);
  }
  // Snapshot the listener list so a listener that detaches itself (or
  // attaches a new one) during dispatch doesn't mutate the array we're
  // iterating.
  for (const listener of [...statusChangeListeners]) {
    listener(serverName, status);
  }
}

/**
 * Remove an MCP server from the status registry and notify listeners.
 * Used when a server is disabled or removed from configuration so it no
 * longer shows up in the Footer's MCP health pill as offline.
 */
export function removeMCPServerStatus(serverName: string): void {
  serverLastErrors.delete(serverName);
  deliberateTeardownServers.delete(serverName);
  if (!serverStatuses.has(serverName)) {
    return;
  }
  serverStatuses.delete(serverName);
  for (const listener of [...statusChangeListeners]) {
    listener(serverName, undefined);
  }
}

/**
 * Get the current status of an MCP server
 */
export function getMCPServerStatus(serverName: string): MCPServerStatus {
  return serverStatuses.get(serverName) || MCPServerStatus.DISCONNECTED;
}

/**
 * Get all MCP server statuses
 */
export function getAllMCPServerStatuses(): Map<string, MCPServerStatus> {
  return new Map(serverStatuses);
}

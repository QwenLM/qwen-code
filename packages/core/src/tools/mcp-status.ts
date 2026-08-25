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

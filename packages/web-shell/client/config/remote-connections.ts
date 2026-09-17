import { getAllowedDaemonOrigin, getDaemonBaseUrl } from './daemon';

const STORAGE_KEY = 'qwen-remote-connections';

/**
 * Host and port of a daemon origin, for display. Falls back to the raw value
 * rather than throwing: this runs on render paths, and a catalog entry that
 * predates the current validation must not take the panel down with it.
 */
export function formatOriginHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function storeRemoteConnections(origins: string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(origins));
  } catch {
    // A connection remains usable in the current tab when persistence fails.
  }
}

export function readRemoteConnections(): string[] {
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) || '[]',
    );
    if (!Array.isArray(value)) return [];
    return Array.from(
      new Set(
        value.filter(
          (origin): origin is string =>
            typeof origin === 'string' &&
            getAllowedDaemonOrigin(origin) === origin &&
            origin !== window.location.origin,
        ),
      ),
    );
  } catch {
    return [];
  }
}

export function rememberRemoteConnection(origin: string): void {
  const normalized = getAllowedDaemonOrigin(origin);
  if (!normalized || normalized === window.location.origin) return;
  const connections = readRemoteConnections();
  if (connections.includes(normalized)) return;
  storeRemoteConnections([...connections, normalized]);
}

export function forgetRemoteConnection(origin: string): string[] {
  const connections = readRemoteConnections().filter(
    (connection) => connection !== origin,
  );
  storeRemoteConnections(connections);
  return connections;
}

export function isRemoteConnectionKnown(origin: string): boolean {
  return readRemoteConnections().includes(origin);
}

/**
 * Remote computers offered as a workspace location: the persisted catalog plus
 * the daemon this tab is pointed at, which is reachable now even if the catalog
 * write was refused. Callers use the count to decide whether a location step is
 * worth showing at all, so both sites must agree on the list.
 */
export function listRemoteComputers(): string[] {
  const current = getDaemonBaseUrl();
  return Array.from(
    new Set([
      ...readRemoteConnections(),
      ...(current && current !== window.location.origin ? [current] : []),
    ]),
  );
}

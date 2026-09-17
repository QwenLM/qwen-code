import { getAllowedDaemonOrigin } from './daemon';

const STORAGE_KEY = 'qwen-remote-connections';

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

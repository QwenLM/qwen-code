import {
  confirmDaemonTarget,
  getAllowedDaemonOrigin,
  getDaemonBaseUrl,
  navigateToDaemon,
  persistDaemonToken,
} from './daemon';

const STORAGE_KEY = 'qwen-remote-connections';
const ADD_FLOW_PARAM = 'addRemoteConnection';
const ADD_RETURN_URL_KEY = 'qwen-remote-connection-return';
const SETTINGS_PARAM = 'settings';
const CONNECTIONS_SETTINGS = 'Connections';

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
  persistDaemonToken('', origin);
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

export function isRemoteConnectionAddActive(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    new URLSearchParams(window.location.search).get(ADD_FLOW_PARAM) === 'verify'
  );
}

function clearRemoteConnectionAddStep(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(ADD_FLOW_PARAM)) return;
  url.searchParams.delete(ADD_FLOW_PARAM);
  window.history.replaceState(null, '', url);
}

export function startRemoteConnectionAdd(
  daemonOrigin: string,
  token?: string,
): boolean {
  const returnUrl = new URL(window.location.href);
  returnUrl.searchParams.delete(ADD_FLOW_PARAM);
  returnUrl.searchParams.delete(SETTINGS_PARAM);
  returnUrl.searchParams.delete('token');
  returnUrl.hash = '';

  try {
    window.sessionStorage.setItem(ADD_RETURN_URL_KEY, returnUrl.toString());
  } catch {
    return false;
  }

  const started = navigateToDaemon(daemonOrigin, token, {
    continueRemoteConnectionAdd: true,
  });
  if (started) return true;

  try {
    window.sessionStorage.removeItem(ADD_RETURN_URL_KEY);
  } catch {
    // The write above succeeded; cleanup is best-effort after a failed switch.
  }
  return false;
}

function returnFromRemoteConnectionAdd(): boolean {
  let saved: string | null = null;
  try {
    saved = window.sessionStorage.getItem(ADD_RETURN_URL_KEY);
    window.sessionStorage.removeItem(ADD_RETURN_URL_KEY);
  } catch {
    return false;
  }
  if (!saved) return false;

  try {
    const url = new URL(saved);
    if (url.origin !== window.location.origin) return false;
    url.searchParams.delete(ADD_FLOW_PARAM);
    url.searchParams.delete('token');
    url.searchParams.set(SETTINGS_PARAM, CONNECTIONS_SETTINGS);
    url.hash = '';
    const savedDaemon = url.searchParams.get('daemon');
    const savedDaemonOrigin = savedDaemon
      ? getAllowedDaemonOrigin(savedDaemon)
      : url.origin;
    if (!savedDaemonOrigin) return false;
    confirmDaemonTarget(savedDaemonOrigin);
    window.location.assign(url.toString());
    return true;
  } catch {
    return false;
  }
}

export function completeRemoteConnectionAdd(origin: string): boolean {
  if (!isRemoteConnectionAddActive()) return false;
  rememberRemoteConnection(origin);
  if (returnFromRemoteConnectionAdd()) return true;
  clearRemoteConnectionAddStep();
  return false;
}

export function leaveRemoteConnectionAdd(): boolean {
  if (!isRemoteConnectionAddActive()) return false;
  if (returnFromRemoteConnectionAdd()) return true;
  clearRemoteConnectionAddStep();
  return false;
}

export function getInitialConnectionsSettingsCategory(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  return new URLSearchParams(window.location.search).get(SETTINGS_PARAM) ===
    CONNECTIONS_SETTINGS
    ? CONNECTIONS_SETTINGS
    : undefined;
}

export function clearInitialConnectionsSettingsCategory(): void {
  const url = new URL(window.location.href);
  if (url.searchParams.get(SETTINGS_PARAM) !== CONNECTIONS_SETTINGS) return;
  url.searchParams.delete(SETTINGS_PARAM);
  window.history.replaceState(null, '', url);
}

import type { Session } from 'electron';
import type { OpenSessionTarget } from '../shared/protocol.ts';
import { buildHostWebSocketUrl } from './discovery.ts';

type RestrictedSession = Pick<
  Session,
  | 'setDevicePermissionHandler'
  | 'setDisplayMediaRequestHandler'
  | 'setPermissionCheckHandler'
  | 'setPermissionRequestHandler'
>;

export function denyWebShellPermissions(session: RestrictedSession): void {
  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  session.setDevicePermissionHandler(() => false);
  session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
}

export function buildWebShellSessionUrl(
  daemonUrl: string,
  target: OpenSessionTarget,
): string {
  const url = new URL(buildHostWebSocketUrl(daemonUrl));
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = `/session/${encodeURIComponent(target.sessionId)}`;
  url.search = '';
  url.searchParams.set('workspace', target.workspaceId);
  url.hash = '';
  return url.toString();
}

function comparableOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === 'ws:') url.protocol = 'http:';
    else if (url.protocol === 'wss:') url.protocol = 'https:';
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function isSameDaemonOrigin(
  value: string,
  daemonOrigin: string,
): boolean {
  const requestOrigin = comparableOrigin(value);
  const expectedOrigin = comparableOrigin(daemonOrigin);
  return requestOrigin !== undefined && requestOrigin === expectedOrigin;
}

export function authorizeDaemonRequest(
  requestUrl: string,
  daemonOrigin: string,
  token: string | undefined,
  headers: Record<string, string>,
): Record<string, string> {
  const result = { ...headers };
  if (!token) return result;
  for (const name of Object.keys(result)) {
    if (name.toLowerCase() === 'authorization') delete result[name];
  }
  if (isSameDaemonOrigin(requestUrl, daemonOrigin)) {
    result.Authorization = `Bearer ${token}`;
  }
  return result;
}

export function isSafeExternalUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

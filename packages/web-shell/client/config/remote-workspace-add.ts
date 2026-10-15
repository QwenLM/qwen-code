import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import {
  confirmDaemonTarget,
  getAllowedDaemonOrigin,
  getDaemonToken,
  navigateToDaemon,
  persistDaemonToken,
} from './daemon';

const FLOW_PARAM = 'addRemoteWorkspace';
const RETURN_URL_KEY = 'qwen-remote-workspace-return';

export interface RemotePathSuggestions {
  dir: string;
  sep: string;
  suggestions: { name: string; path: string }[];
  truncated: boolean;
}

/**
 * Headers for a call to this page's own daemon through one of its
 * remote-workspace proxy routes.
 *
 * Two different credentials travel together, and they are not interchangeable:
 * `Authorization` authenticates to the daemon that *serves* the proxy route —
 * the routes are registered behind that daemon's global bearer gate, so
 * omitting it 401s on any daemon started with `--token` — while
 * `X-Daemon-Token` carries the *target* daemon's credential for the proxy to
 * forward upstream.
 *
 * The serving daemon is the page origin, never `getDaemonBaseUrl()`: the proxy
 * URLs are relative, and a `?daemon=` override names the target of the proxy,
 * not the host answering it. Reading the token with no argument would hand the
 * target's credential to the serving daemon's gate whenever the shell is
 * pointed at another computer, which is exactly the case these routes exist
 * for.
 */
function remoteProxyHeaders(
  targetOrigin: string,
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  const servingToken = getDaemonToken(window.location.origin);
  if (servingToken) headers['Authorization'] = `Bearer ${servingToken}`;
  const targetToken = getDaemonToken(targetOrigin);
  if (targetToken) headers['X-Daemon-Token'] = targetToken;
  return headers;
}

function recoverRejectedTargetCredential(daemonOrigin: string): void {
  persistDaemonToken('', daemonOrigin);
  selectRemoteWorkspaceLocation(daemonOrigin);
}

/**
 * Fetches directory suggestions from an arbitrary daemon origin without
 * navigating the page. Used by the Add-workspace dialog's location switcher
 * so the user can browse a remote daemon's folders in place.
 *
 * Goes through the current daemon's proxy route to avoid CSP issues.
 */
export async function fetchRemotePathSuggestions(
  daemonOrigin: string,
  prefix: string,
): Promise<RemotePathSuggestions> {
  const query = new URLSearchParams({ daemon: daemonOrigin, prefix });
  const res = await fetch(
    `/remote-workspace-path-suggestions?${query.toString()}`,
    { headers: remoteProxyHeaders(daemonOrigin) },
  );
  if (!res.ok) {
    if (res.status === 401) recoverRejectedTargetCredential(daemonOrigin);
    throw new DaemonHttpError(
      res.status,
      undefined,
      `Failed to fetch directory suggestions from ${daemonOrigin}: ${res.status}`,
    );
  }
  return (await res.json()) as RemotePathSuggestions;
}

/**
 * Registers a workspace on an arbitrary daemon origin without navigating the
 * page. Used by the Add-workspace dialog when the user browsed a remote
 * daemon's folders in place and then confirms the add.
 *
 * Goes through the current daemon's proxy route to avoid CSP issues.
 */
export async function addWorkspaceToDaemon(
  daemonOrigin: string,
  cwd: string,
  persist: boolean,
  displayName?: string,
): Promise<void> {
  const res = await fetch('/remote-workspaces', {
    method: 'POST',
    headers: remoteProxyHeaders(daemonOrigin, {
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify({
      daemon: daemonOrigin,
      cwd,
      ...(persist ? { persist: true } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 401) recoverRejectedTargetCredential(daemonOrigin);
    throw new DaemonHttpError(
      res.status,
      body,
      `Failed to add workspace on ${daemonOrigin}: ${res.status} ${body}`,
    );
  }
}

export function isRemoteWorkspaceAddActive(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    new URLSearchParams(window.location.search).get(FLOW_PARAM) === 'browse'
  );
}

export function clearRemoteWorkspaceAddStep(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(FLOW_PARAM)) return;
  url.searchParams.delete(FLOW_PARAM);
  window.history.replaceState(window.history.state, '', url);
}

export function startRemoteWorkspaceAdd(
  daemonOrigin: string,
  token?: string,
): boolean {
  const returnUrl = new URL(window.location.href);
  returnUrl.searchParams.delete(FLOW_PARAM);
  returnUrl.searchParams.delete('token');
  returnUrl.hash = '';

  try {
    window.sessionStorage.setItem(RETURN_URL_KEY, returnUrl.toString());
  } catch {
    return false;
  }

  const started = navigateToDaemon(daemonOrigin, token, {
    continueFlow: 'workspace',
  });
  if (started) return true;

  window.history.replaceState(window.history.state, '', returnUrl);
  try {
    window.sessionStorage.removeItem(RETURN_URL_KEY);
  } catch {
    // The write above succeeded; removal is best-effort after a failed switch.
  }
  return false;
}

export function selectRemoteWorkspaceLocation(
  daemonOrigin: string,
  token?: string,
): boolean {
  try {
    if (window.sessionStorage.getItem(RETURN_URL_KEY)) {
      return navigateToDaemon(daemonOrigin, token, {
        continueFlow: 'workspace',
      });
    }
  } catch {
    return false;
  }
  return startRemoteWorkspaceAdd(daemonOrigin, token);
}

export function leaveRemoteWorkspaceAdd(): boolean {
  clearRemoteWorkspaceAddStep();
  let saved: string | null = null;
  try {
    saved = window.sessionStorage.getItem(RETURN_URL_KEY);
    window.sessionStorage.removeItem(RETURN_URL_KEY);
  } catch {
    return false;
  }
  if (!saved) return false;

  try {
    const url = new URL(saved);
    if (url.origin !== window.location.origin) return false;
    url.searchParams.delete('token');
    url.hash = '';
    url.searchParams.delete(FLOW_PARAM);
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

export function completeRemoteWorkspaceAdd(): void {
  clearRemoteWorkspaceAddStep();
  try {
    window.sessionStorage.removeItem(RETURN_URL_KEY);
  } catch {
    // The completed add does not depend on cleaning up its return location.
  }
}

/**
 * Drops a return location whose flow was abandoned rather than finished.
 *
 * The key is only ever written immediately before a navigation that carries
 * `FLOW_PARAM` (see startRemoteWorkspaceAdd and navigateToDaemon), so booting
 * without that marker means the hand-over was abandoned — a reload or the
 * browser's Back button strips the dialog but leaves this key behind, and the
 * next Cancel in any Add-workspace dialog would consume the stale location and
 * navigate the whole shell back to it.
 */
export function discardAbandonedRemoteWorkspaceAdd(): void {
  try {
    window.sessionStorage.removeItem(RETURN_URL_KEY);
  } catch {
    // Nothing to discard when storage is unavailable.
  }
}

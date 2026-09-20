import {
  confirmDaemonTarget,
  getAllowedDaemonOrigin,
  navigateToDaemon,
} from './daemon';

const FLOW_PARAM = 'addRemoteWorkspace';
const RETURN_URL_KEY = 'qwen-remote-workspace-return';

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
  window.history.replaceState(null, '', url);
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

  window.history.replaceState(null, '', returnUrl);
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

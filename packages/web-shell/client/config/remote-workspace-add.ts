import {
  confirmDaemonTarget,
  getAllowedDaemonOrigin,
  navigateToDaemon,
} from './daemon';

const FLOW_PARAM = 'addRemoteWorkspace';
const RETURN_URL_KEY = 'qwen-remote-workspace-return';

export type RemoteWorkspaceAddStep = 'connect' | 'browse';

export function getRemoteWorkspaceAddStep():
  | RemoteWorkspaceAddStep
  | undefined {
  const step = new URLSearchParams(window.location.search).get(FLOW_PARAM);
  return step === 'connect' || step === 'browse' ? step : undefined;
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
    continueRemoteWorkspaceAdd: true,
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

export function leaveRemoteWorkspaceAdd(reopenConnection = false): boolean {
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
    if (reopenConnection) url.searchParams.set(FLOW_PARAM, 'connect');
    else url.searchParams.delete(FLOW_PARAM);
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

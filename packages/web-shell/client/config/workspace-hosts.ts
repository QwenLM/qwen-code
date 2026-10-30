import { createContext, useEffect, useState } from 'react';
import type { DaemonWorkspaceCapability } from '@qwen-code/sdk/daemon';
import {
  buildDaemonConnectionUrl,
  confirmDaemonTarget,
  getAllowedDaemonOrigin,
} from './daemon';

export const WorkspaceHostsEnabled = createContext(false);
const STORAGE_KEY = 'qwen-workspace-hosts';
export const WORKSPACE_HOSTS_CHANGE_EVENT = 'qwen-workspace-hosts';
const CHANGE_EVENT = WORKSPACE_HOSTS_CHANGE_EVENT;
export interface WorkspaceHost {
  origin: string;
  workspaces: Pick<DaemonWorkspaceCapability, 'id' | 'cwd' | 'displayName'>[];
}

export function readWorkspaceHosts(): WorkspaceHost[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEY) || '[]',
    );
    if (!Array.isArray(value)) return [];
    return value.filter(
      (host): host is WorkspaceHost =>
        host &&
        typeof host.origin === 'string' &&
        getAllowedDaemonOrigin(host.origin) === host.origin &&
        Array.isArray(host.workspaces) &&
        host.workspaces.every(
          (ws: Record<string, unknown>) =>
            ws &&
            typeof ws.id === 'string' &&
            typeof ws.cwd === 'string' &&
            (ws.displayName === undefined ||
              typeof ws.displayName === 'string'),
        ),
    );
  } catch {
    return [];
  }
}

export function rememberWorkspaceHost(
  origin: string,
  workspaces: WorkspaceHost['workspaces'],
): void {
  const hosts = readWorkspaceHosts();
  const index = hosts.findIndex((host) => host.origin === origin);
  const host = {
    origin,
    workspaces: workspaces.map(({ id, cwd, displayName }) => ({
      id,
      cwd,
      displayName,
    })),
  };
  if (index >= 0) {
    if (JSON.stringify(hosts[index]) === JSON.stringify(host)) return;
    hosts[index] = host;
  } else {
    hosts.push(host);
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(hosts));
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // Connections remain usable when browser persistence is unavailable.
  }
}

/**
 * Drop a host from the saved workspace catalog, e.g. when its connection is
 * removed from Settings: the fan-out group must disappear in the same tab,
 * not just on the next load.
 */
export function forgetWorkspaceHost(origin: string): void {
  const hosts = readWorkspaceHosts().filter((host) => host.origin !== origin);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(hosts));
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // Connections remain usable when browser persistence is unavailable.
  }
}

/** Saved hosts, kept in sync with catalog updates from this and other tabs. */
export function useWorkspaceHosts(): WorkspaceHost[] {
  const [hosts, setHosts] = useState(readWorkspaceHosts);
  useEffect(() => {
    const update = () => setHosts(readWorkspaceHosts());
    window.addEventListener(CHANGE_EVENT, update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener(CHANGE_EVENT, update);
      window.removeEventListener('storage', update);
    };
  }, []);
  return hosts;
}

export function openHostedWorkspace(
  origin: string,
  workspaceId?: string,
): void {
  const href = buildDaemonConnectionUrl(origin, window.location.href);
  if (!href) return;
  const url = new URL(href);
  if (workspaceId) url.searchParams.set('workspace', workspaceId);
  confirmDaemonTarget(getAllowedDaemonOrigin(origin));
  window.location.assign(url.toString());
}

import { createContext, useEffect, useState } from 'react';
import type { DaemonWorkspaceCapability } from '@qwen-code/sdk/daemon';
import {
  buildDaemonConnectionUrl,
  confirmDaemonTarget,
  consumeDaemonTargetConfirmation,
  getAllowedDaemonOrigin,
} from './daemon';

export const WorkspaceHostsEnabled = createContext(false);
const STORAGE_KEY = 'qwen-workspace-hosts';
const CHANGE_EVENT = 'qwen-workspace-hosts';
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

/**
 * Whether a page load may connect to `origin` without asking first: the page's
 * own daemon, a host this browser has already connected to, or a host the user
 * just chose in this tab. A bare `?daemon=` link is none of these.
 */
export function isKnownDaemonTarget(origin: string): boolean {
  if (origin === window.location.origin) return true;
  const confirmed = consumeDaemonTargetConfirmation(origin);
  return (
    confirmed || readWorkspaceHosts().some((host) => host.origin === origin)
  );
}

export function getWorkspaceReturnUrl(): string | undefined {
  const current = new URL(window.location.href);
  const saved = current.searchParams.get('workspaceReturn');
  if (!saved) return undefined;
  try {
    const url = new URL(saved, current.origin);
    if (url.origin !== current.origin) return undefined;
    url.searchParams.delete('token');
    url.searchParams.delete('workspaceReturn');
    url.searchParams.delete('addWorkspace');
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
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

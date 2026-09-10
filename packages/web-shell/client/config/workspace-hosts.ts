import { createContext } from 'react';
import type { DaemonWorkspaceCapability } from '@qwen-code/sdk/daemon';
import { buildDaemonConnectionUrl, getAllowedDaemonOrigin } from './daemon';

export const WorkspaceHostsEnabled = createContext(false);
const STORAGE_KEY = 'qwen-workspace-hosts';
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
    window.dispatchEvent(new Event('qwen-workspace-hosts'));
  } catch {
    // Connections remain usable when browser persistence is unavailable.
  }
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
  window.location.assign(url.toString());
}

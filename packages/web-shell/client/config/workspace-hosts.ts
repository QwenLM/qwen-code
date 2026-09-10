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
  const hosts = readWorkspaceHosts().filter((host) => host.origin !== origin);
  hosts.push({
    origin,
    workspaces: workspaces.map(({ id, cwd, displayName }) => ({
      id,
      cwd,
      displayName,
    })),
  });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(hosts));
    window.dispatchEvent(new Event('qwen-workspace-hosts'));
  } catch {
    // Connections remain usable when browser persistence is unavailable.
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

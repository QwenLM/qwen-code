import { useContext, useEffect } from 'react';
import { DaemonClient } from '@qwen-code/sdk/daemon';
import { useWorkspace } from '@qwen-code/web-shell/daemon-react-sdk';
import { getDaemonToken } from '../../config/daemon';
import {
  WorkspaceHostsEnabled,
  rememberWorkspaceHost,
  openHostedWorkspace,
  useWorkspaceHosts,
} from '../../config/workspace-hosts';
import { useI18n } from '../../i18n';
import { Laptop, Folder, Server } from 'lucide-react';

export function WorkspaceHostProjects() {
  const enabled = useContext(WorkspaceHostsEnabled);
  return enabled ? <HostProjects /> : null;
}

function HostProjects() {
  const workspace = useWorkspace();
  const { t } = useI18n();
  const origin = new URL(
    workspace.baseUrl || window.location.origin,
    window.location.origin,
  ).origin;
  const hosts = useWorkspaceHosts();
  useEffect(() => {
    if (workspace.capabilities?.workspaces) {
      rememberWorkspaceHost(
        origin,
        workspace.capabilities.workspaces.filter((ws) => ws.kind !== 'live'),
      );
    }
  }, [origin, workspace.capabilities?.workspaces]);
  useEffect(() => {
    if (origin === window.location.origin) return;
    let cancelled = false;
    const local = window.location.origin;
    const client = new DaemonClient({
      baseUrl: local,
      token: getDaemonToken(local),
    });
    void client
      .capabilities()
      .then((capabilities) => {
        if (!cancelled)
          rememberWorkspaceHost(
            local,
            (capabilities.workspaces || []).filter((ws) => ws.kind !== 'live'),
          );
      })
      .catch(() => {
        /* Keep saved local projects available while offline. */
      });
    return () => {
      cancelled = true;
    };
  }, [origin]);
  const otherHosts = hosts.filter((host) => host.origin !== origin);
  // Until another host is saved there is nowhere else to go, so a browser that
  // only uses the page's own daemon keeps the plain project list.
  if (origin === window.location.origin && otherHosts.length === 0) {
    return null;
  }
  if (
    origin !== window.location.origin &&
    !otherHosts.some((host) => host.origin === window.location.origin)
  ) {
    otherHosts.unshift({ origin: window.location.origin, workspaces: [] });
  }
  return (
    <div className="px-3 py-2 text-sm">
      {otherHosts.map((host) => (
        <div key={host.origin} className="mb-3">
          <button
            type="button"
            className="w-full truncate text-left text-xs text-muted-foreground"
            onClick={() => openHostedWorkspace(host.origin)}
          >
            {host.origin === window.location.origin ? (
              <Laptop className="mr-2 inline size-4" aria-hidden="true" />
            ) : (
              <Server className="mr-2 inline size-4" aria-hidden="true" />
            )}
            {host.origin === window.location.origin
              ? t('workspaceHost.local')
              : host.origin}
          </button>
          {host.workspaces.map((project) => (
            <button
              key={project.id}
              type="button"
              className="block w-full truncate rounded px-2 py-1 text-left hover:bg-accent"
              title={`${host.origin} — ${project.cwd}`}
              onClick={() => openHostedWorkspace(host.origin, project.id)}
            >
              {host.origin === window.location.origin ? (
                <Folder className="mr-2 inline size-4" aria-hidden="true" />
              ) : (
                <Server className="mr-2 inline size-4" aria-hidden="true" />
              )}
              {project.displayName ||
                project.cwd.split(/[\\/]/).filter(Boolean).pop() ||
                project.cwd}
            </button>
          ))}
        </div>
      ))}
      <div className="truncate text-xs text-muted-foreground" title={origin}>
        {origin === window.location.origin ? (
          <Laptop className="mr-2 inline size-4" aria-hidden="true" />
        ) : (
          <Server className="mr-2 inline size-4" aria-hidden="true" />
        )}
        {origin === window.location.origin
          ? t('workspaceHost.local')
          : `${t('workspaceHost.remote')} · ${origin}`}
      </div>
    </div>
  );
}

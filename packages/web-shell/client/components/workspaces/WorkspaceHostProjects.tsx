import { useContext, useEffect } from 'react';
import { DaemonClient } from '@qwen-code/sdk/daemon';
import { useWorkspace } from '@qwen-code/web-shell/daemon-react-sdk';
import { Folder, Laptop, Server } from 'lucide-react';
import { getDaemonToken } from '../../config/daemon';
import {
  WorkspaceHostsEnabled,
  openHostedWorkspace,
  rememberWorkspaceHost,
  useWorkspaceHosts,
  type WorkspaceHost,
} from '../../config/workspace-hosts';
import { useI18n } from '../../i18n';
import sectionStyles from '../sidebar/WorkspaceSection.module.css';

const GROUP_LABEL_CLASS =
  'flex w-full min-w-0 items-center gap-1.5 px-2 pb-1 pt-3 text-left text-[11px] font-medium text-muted-foreground';

function useCurrentHostOrigin(): string {
  const workspace = useWorkspace();
  return new URL(
    workspace.baseUrl || window.location.origin,
    window.location.origin,
  ).origin;
}

/**
 * Saved hosts other than the connected one. While a remote host is connected
 * the page's own daemon is always listed, so there is a way back to it.
 */
function useOtherHosts(origin: string): WorkspaceHost[] {
  const others = useWorkspaceHosts().filter((host) => host.origin !== origin);
  if (
    origin !== window.location.origin &&
    !others.some((host) => host.origin === window.location.origin)
  ) {
    others.unshift({ origin: window.location.origin, workspaces: [] });
  }
  return others;
}

function HostLabel({ origin }: { origin: string }) {
  const { t } = useI18n();
  const local = origin === window.location.origin;
  const Icon = local ? Laptop : Server;
  return (
    <>
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">
        {local ? t('workspaceHost.local') : new URL(origin).host}
      </span>
    </>
  );
}

/**
 * Names the connected host above its live project list. Until another host is
 * saved there is nothing to tell apart, so the plain list stays unlabeled.
 */
export function WorkspaceHostHeading() {
  const enabled = useContext(WorkspaceHostsEnabled);
  return enabled ? <CurrentHostHeading /> : null;
}

function CurrentHostHeading() {
  const origin = useCurrentHostOrigin();
  const others = useOtherHosts(origin);
  if (others.length === 0) return null;
  return (
    <div className={GROUP_LABEL_CLASS} title={origin}>
      <HostLabel origin={origin} />
    </div>
  );
}

/**
 * Saved projects on the other hosts, grouped by host below the live list.
 * Only the connected host is live; choosing one of these reloads the page
 * against its host.
 */
export function OtherHostProjects() {
  const enabled = useContext(WorkspaceHostsEnabled);
  return enabled ? <OtherHosts /> : null;
}

function OtherHosts() {
  const workspace = useWorkspace();
  const { t } = useI18n();
  const origin = useCurrentHostOrigin();
  const others = useOtherHosts(origin);
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
  if (others.length === 0) return null;
  return (
    <div data-testid="other-host-projects">
      {others.map((host) => {
        const ProjectIcon =
          host.origin === window.location.origin ? Folder : Server;
        return (
          <div key={host.origin}>
            <button
              type="button"
              className={`${GROUP_LABEL_CLASS} hover:text-foreground`}
              title={t('workspaceHost.openHost', { host: host.origin })}
              onClick={() => openHostedWorkspace(host.origin)}
            >
              <HostLabel origin={host.origin} />
            </button>
            {host.workspaces.map((project) => (
              <div key={project.id} className={sectionStyles.headerRow}>
                <button
                  type="button"
                  className={sectionStyles.header}
                  title={`${host.origin} — ${project.cwd}`}
                  onClick={() => openHostedWorkspace(host.origin, project.id)}
                >
                  <span className={sectionStyles.chevron}>
                    <ProjectIcon
                      className={sectionStyles.folderIcon}
                      size={14}
                      strokeWidth={1.4}
                      aria-hidden="true"
                    />
                  </span>
                  <span className={sectionStyles.headerContent}>
                    <span className={sectionStyles.name}>
                      {project.displayName ||
                        project.cwd.split(/[\\/]/).filter(Boolean).pop() ||
                        project.cwd}
                    </span>
                  </span>
                </button>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

import { useContext, useEffect, useMemo } from 'react';
import type {
  DaemonSessionSummary,
  DaemonWorkspaceCapability,
} from '@qwen-code/sdk/daemon';
import { useWorkspace } from '@qwen-code/web-shell/daemon-react-sdk';
import { Folder, Server, Trash2Icon } from 'lucide-react';
import { useDaemonTargetOptional } from '../../config/daemon-target';
import { useWorkspaceRemoval } from './useWorkspaceRemoval';
import { WorkspaceRemovalDialog } from './WorkspaceRemovalDialog';
import {
  getHostClient,
  useFanoutOrigins,
  useHostCapabilities,
  useHostFanout,
} from '../../config/host-fanout';
import {
  WorkspaceHostsEnabled,
  openHostedWorkspace,
  rememberWorkspaceHost,
  useWorkspaceHosts,
  type WorkspaceHost,
} from '../../config/workspace-hosts';
import { useI18n } from '../../i18n';
import { measureSessionTitleScroll } from '../sidebar/sessionTitleScroll';
import { WorkspaceSection } from '../sidebar/WorkspaceSection';
import sectionStyles from '../sidebar/WorkspaceSection.module.css';
import sidebarStyles from '../sidebar/WebShellSidebar.module.css';
import { HostLabel } from './HostLabel';

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
 * The canonical fan-out host set (saved hosts, remote connections, the way
 * back to the page origin when focused remote) minus the focused daemon.
 * `useFanoutOrigins` already adjusts for the focused host it knows via
 * DaemonTargetProvider; the filter/add here covers embedded shells that
 * render outside that provider, so the way-back group survives there too.
 */
function useOtherOrigins(origin: string): string[] {
  const origins = useFanoutOrigins();
  return useMemo(() => {
    const others = origins.filter((host) => host !== origin);
    const local = window.location.origin;
    if (origin !== local && !others.includes(local)) others.push(local);
    return others;
  }, [origins, origin]);
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
  const others = useOtherOrigins(origin);
  if (others.length === 0) return null;
  return (
    <div className={GROUP_LABEL_CLASS} title={origin}>
      <HostLabel origin={origin} />
    </div>
  );
}

export type OpenHostSessionHandler = (
  origin: string,
  sessionId: string,
  workspaceCwd?: string,
) => void;

/**
 * Switch to a host (optionally preselecting a workspace): an in-app focus
 * change when the document's CSP already covers the origin, otherwise the
 * legacy full navigation that re-serves the shell widened for the host.
 */
function useOpenHostedWorkspaceFlow(): (
  origin: string,
  workspaceId?: string,
) => void {
  const target = useDaemonTargetOptional();
  return (origin, workspaceId) => {
    if (target?.coversOrigin(origin)) {
      target.focusHost(workspaceId ? { origin, workspaceId } : { origin });
    } else {
      openHostedWorkspace(origin, workspaceId);
    }
  };
}

/**
 * Live projects on the other hosts, grouped by host below the focused list.
 * Each group polls its own daemon; a host that drops offline or rejects the
 * saved credential keeps its last known projects with a muted status hint.
 */
export function OtherHostProjects({
  onOpenHostSession,
}: {
  onOpenHostSession?: OpenHostSessionHandler;
}) {
  const enabled = useContext(WorkspaceHostsEnabled);
  return enabled ? <OtherHosts onOpenHostSession={onOpenHostSession} /> : null;
}

function OtherHosts({
  onOpenHostSession,
}: {
  onOpenHostSession?: OpenHostSessionHandler;
}) {
  const origin = useCurrentHostOrigin();
  const origins = useOtherOrigins(origin);
  const saved = useWorkspaceHosts();
  // Owns the per-origin client pool lifecycle (clients are created with the
  // host set and dropped when hosts leave it); per-host live state comes
  // from useHostCapabilities inside FanoutHostGroup.
  useHostFanout(origins);
  if (origins.length === 0) return null;
  return (
    <div data-testid="other-host-projects">
      {origins.map((hostOrigin) => (
        <FanoutHostGroup
          key={hostOrigin}
          origin={hostOrigin}
          saved={
            saved.find((host) => host.origin === hostOrigin)?.workspaces ??
            NO_SAVED_WORKSPACES
          }
          onOpenHostSession={onOpenHostSession}
        />
      ))}
    </div>
  );
}

const NO_SAVED_WORKSPACES: WorkspaceHost['workspaces'] = [];

function FanoutHostGroup({
  origin,
  saved,
  onOpenHostSession,
}: {
  origin: string;
  saved: WorkspaceHost['workspaces'];
  onOpenHostSession?: OpenHostSessionHandler;
}) {
  const { t } = useI18n();
  const { workspaces, status, generation, refresh } =
    useHostCapabilities(origin);
  const openHostWorkspace = useOpenHostedWorkspaceFlow();
  // Workspace removal runs over the host's own client: it is catalog
  // management with the user's own per-origin token, distinct from the
  // phase-1 read-only chat/terminal surface the fan-out rows stay under.
  const removal = useWorkspaceRemoval({
    removeWorkspace: (workspaceId, options) =>
      getHostClient(origin).workspaceById(workspaceId).remove(options),
    onRemoved: async () => {
      refresh();
    },
    onError: () => {},
    errorMessage: t('sidebar.removeWorkspaceError'),
  });
  const liveWorkspaces = useMemo(
    () => workspaces?.filter((workspace) => workspace.kind !== 'live'),
    [workspaces],
  );
  // A successful poll refreshes the saved catalog that doubles as the
  // offline snapshot; a failed poll leaves it untouched, so the last known
  // group survives an unreachable page-origin daemon.
  useEffect(() => {
    if (status === 'online' && liveWorkspaces) {
      rememberWorkspaceHost(origin, liveWorkspaces);
    }
  }, [origin, liveWorkspaces, status]);

  const offline = status === 'offline';
  const unauthorized = status === 'unauthorized';
  const live = !offline && !unauthorized;
  const statusHint = offline
    ? t('workspaceHost.statusOffline')
    : unauthorized
      ? t('workspaceHost.statusUnauthorized')
      : undefined;
  const statusDetail = offline
    ? t('workspaceHost.offlineHint')
    : unauthorized
      ? t('workspaceHost.unauthorizedHint')
      : undefined;
  const snapshotWorkspaces = liveWorkspaces ?? saved;

  return (
    <div>
      <button
        type="button"
        className={`${GROUP_LABEL_CLASS} hover:text-foreground`}
        title={statusDetail ?? t('workspaceHost.openHost', { host: origin })}
        onClick={() => openHostWorkspace(origin)}
      >
        <HostLabel origin={origin} />
        {statusHint && (
          <span
            className={sectionStyles.badge}
            data-testid="host-status"
            title={statusDetail}
          >
            {statusHint}
          </span>
        )}
      </button>
      {live && liveWorkspaces
        ? liveWorkspaces.map((workspace) => (
            <LiveHostWorkspace
              key={workspace.id}
              origin={origin}
              workspace={workspace}
              generation={generation}
              onOpenHostSession={onOpenHostSession}
              onRemoveWorkspace={removal.request}
            />
          ))
        : snapshotWorkspaces.map((workspace) => (
            <SnapshotHostWorkspaceRow
              key={workspace.id}
              origin={origin}
              workspace={workspace}
              disabled={unauthorized}
              disabledHint={statusDetail}
              onOpen={openHostWorkspace}
            />
          ))}
      <WorkspaceRemovalDialog
        removal={removal}
        currentSessionInCandidate={false}
      />
    </div>
  );
}

/**
 * One live workspace of a fan-out host. Sessions come from WorkspaceSection's
 * own catalog queries against the host's client; chat/terminal/name-trust
 * mutations are focused-host-only in this phase, while workspace removal is
 * offered on the row — it runs the daemon REST of that very host.
 */
function LiveHostWorkspace({
  origin,
  workspace,
  generation,
  onOpenHostSession,
  onRemoveWorkspace,
}: {
  origin: string;
  workspace: DaemonWorkspaceCapability;
  generation: number;
  onOpenHostSession?: OpenHostSessionHandler;
  onRemoveWorkspace?: (workspace: DaemonWorkspaceCapability) => void;
}) {
  const { t } = useI18n();
  const openSession = (session: DaemonSessionSummary) => {
    if (onOpenHostSession) {
      onOpenHostSession(origin, session.sessionId, workspace.cwd);
    } else {
      // Without an in-app opener the legacy navigation still lands on the
      // right host and project.
      openHostedWorkspace(origin, workspace.id);
    }
  };
  return (
    <WorkspaceSection
      workspace={workspace}
      remote={origin !== window.location.origin}
      client={getHostClient(origin)}
      reloadToken={generation}
      storageKey={`${origin}\0${workspace.id}`}
      untrustedLabel={t('sidebar.workspaceUntrusted')}
      readOnlyLabel={t('sidebar.workspaceReadOnly')}
      trustToOpenLabel={t('sidebar.workspaceTrustToOpen')}
      noSessionsLabel={t('sidebar.noSessions')}
      loadErrorLabel={t('sidebar.loadFailed')}
      organizationEnabled={false}
      channelGroupingEnabled={false}
      ungroupedLabel={t('sidebar.groupUngrouped')}
      showSessionDetails={false}
      headerActions={
        onRemoveWorkspace && workspace.removable
          ? () => (
              <button
                type="button"
                className={sectionStyles.workspaceHeaderAction}
                title={t('sidebar.removeWorkspace')}
                data-testid="fanout-remove-workspace"
                onClick={() => onRemoveWorkspace(workspace)}
              >
                <Trash2Icon
                  className={sectionStyles.folderIcon}
                  size={14}
                  strokeWidth={1.4}
                  aria-hidden="true"
                />
              </button>
            )
          : undefined
      }
      renderSession={(session) => (
        <FanoutSessionRow
          key={session.sessionId}
          session={session}
          onOpen={() => openSession(session)}
        />
      )}
    />
  );
}

/**
 * The last known projects of a host whose live list is unavailable: still a
 * way over (offline), or inert until re-authenticated (unauthorized).
 */
function SnapshotHostWorkspaceRow({
  origin,
  workspace,
  disabled,
  disabledHint,
  onOpen,
}: {
  origin: string;
  workspace: WorkspaceHost['workspaces'][number];
  disabled: boolean;
  disabledHint: string | undefined;
  onOpen: (origin: string, workspaceId?: string) => void;
}) {
  const Icon = origin === window.location.origin ? Folder : Server;
  return (
    <div className={sectionStyles.headerRow}>
      <button
        type="button"
        className={sectionStyles.header}
        disabled={disabled}
        title={disabledHint ?? `${origin} — ${workspace.cwd}`}
        onClick={() => onOpen(origin, workspace.id)}
      >
        <span className={sectionStyles.chevron}>
          <Icon
            className={sectionStyles.folderIcon}
            size={14}
            strokeWidth={1.4}
            aria-hidden="true"
          />
        </span>
        <span className={sectionStyles.headerContent}>
          <span className={sectionStyles.name}>
            {workspace.displayName ||
              workspace.cwd.split(/[\\/]/).filter(Boolean).pop() ||
              workspace.cwd}
          </span>
        </span>
      </button>
    </div>
  );
}

/**
 * A session of a fan-out host: opens through the sidebar's host-session
 * callback (which focuses the host in-app when covered) and carries no
 * mutation actions — those stay focused-host-only.
 */
function FanoutSessionRow({
  session,
  onOpen,
}: {
  session: DaemonSessionSummary;
  onOpen: () => void;
}) {
  const label = session.displayName?.trim() || session.sessionId.slice(0, 8);
  return (
    <div
      className={sidebarStyles.sessionRow}
      role="button"
      tabIndex={0}
      title={label}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onOpen();
      }}
      onMouseEnter={(event) => measureSessionTitleScroll(event.currentTarget)}
    >
      <span className={sidebarStyles.sessionText} data-web-shell-session-title>
        <span className={sidebarStyles.sessionTextInner}>{label}</span>
      </span>
    </div>
  );
}

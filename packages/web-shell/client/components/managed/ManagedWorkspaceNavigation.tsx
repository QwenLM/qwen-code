import { useEffect, useRef, useState } from 'react';
import { FolderClosedIcon, FolderOpenIcon, SquarePenIcon } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import {
  readWorkspaceExpanded,
  writeWorkspaceExpanded,
} from '../sidebar/workspaceExpansion';
import sectionStyles from '../sidebar/WorkspaceSection.module.css';
import sidebarStyles from '../sidebar/WebShellSidebar.module.css';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionSummary,
  ManagedAgentWorkspace,
} from './managed-agent-provider';

interface WorkspaceNavigationGroup {
  workspace?: ManagedAgentWorkspace;
  sessions: ManagedAgentSessionSummary[];
}

export function ManagedWorkspaceNavigation({
  provider,
  clientId,
  sessions,
  sessionId,
  workspaceId,
  active,
  search,
  revision,
  onSelectWorkspace,
  onSelectSession,
  onWorkspacesChange,
}: {
  provider: ManagedAgentProvider;
  clientId: string;
  sessions: ManagedAgentSessionSummary[];
  sessionId?: string;
  workspaceId?: string;
  active: boolean;
  search: string;
  revision: number;
  onSelectWorkspace?: (workspaceId: string) => void;
  onSelectSession: (sessionId: string, workspaceId?: string) => void;
  onWorkspacesChange?: (workspaces: ManagedAgentWorkspace[]) => void;
}) {
  const { t } = useI18n();
  const binding = provider.workspaceBinding!;
  const [workspaces, setWorkspaces] = useState<ManagedAgentWorkspace[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [supported, setSupported] = useState(false);
  const [error, setError] = useState<string>();
  const lifetime = useRef<AbortController | undefined>(undefined);
  const busy = useRef(false);

  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    busy.current = false;
    setLoading(true);
    setError(undefined);
    setNextCursor(undefined);
    void binding.list({ clientId, limit: 50, signal: abort.signal }).then(
      (page) => {
        if (abort.signal.aborted) return;
        setWorkspaces([
          ...new Map(
            [
              ...page.data,
              ...(page.defaultWorkspace ? [page.defaultWorkspace] : []),
            ].map((item) => [item.workspaceId, item]),
          ).values(),
        ]);
        setNextCursor(page.nextCursor);
        setSupported(page.supported);
        setLoading(false);
      },
      (failure: unknown) => {
        if (abort.signal.aborted) return;
        setSupported(false);
        setError(failure instanceof Error ? failure.message : String(failure));
        setLoading(false);
      },
    );
    return () => abort.abort();
  }, [binding, clientId, revision]);

  useEffect(() => {
    onWorkspacesChange?.(supported ? workspaces : []);
  }, [onWorkspacesChange, supported, workspaces]);

  async function loadMore() {
    const abort = lifetime.current;
    if (!abort || abort.signal.aborted || busy.current || !nextCursor) return;
    busy.current = true;
    setLoading(true);
    setError(undefined);
    try {
      const page = await binding.list({
        clientId,
        cursor: nextCursor,
        limit: 50,
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      setWorkspaces((current) => [
        ...new Map(
          [...current, ...page.data].map((item) => [item.workspaceId, item]),
        ).values(),
      ]);
      setNextCursor(page.nextCursor);
      setSupported(page.supported);
    } catch (failure) {
      if (!abort.signal.aborted)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (!abort.signal.aborted) {
        busy.current = false;
        setLoading(false);
      }
    }
  }

  const groups = new Map<string | undefined, WorkspaceNavigationGroup>(
    workspaces.map((workspace) => [
      workspace.workspaceId,
      { workspace, sessions: [] },
    ]),
  );
  for (const session of sessions) {
    const id = session.workspace?.workspaceId;
    const group: WorkspaceNavigationGroup = groups.get(id) ?? { sessions: [] };
    group.sessions.push(session);
    groups.set(id, group);
  }
  if (workspaceId && !groups.has(workspaceId)) {
    groups.set(workspaceId, { sessions: [] });
  }
  const query = search.trim().toLocaleLowerCase();
  return (
    <>
      {error && (
        <p role="alert" className={sectionStyles.error}>
          {t('managed.workspaceLoadFailed')} {error}
        </p>
      )}
      {loading && (
        <p role="status" className={sectionStyles.empty}>
          {t('managed.loading')}
        </p>
      )}
      {[...groups].map(([id, group]) => {
        const label =
          group.workspace?.displayName || id || t('managed.sessions');
        const matchesWorkspace =
          !query || `${label} ${id ?? ''}`.toLocaleLowerCase().includes(query);
        const visible = matchesWorkspace
          ? group.sessions
          : group.sessions.filter((session) =>
              `${session.title} ${session.sessionId}`
                .toLocaleLowerCase()
                .includes(query),
            );
        if (!matchesWorkspace && !visible.length) return null;
        return (
          <ManagedWorkspaceGroup
            key={JSON.stringify([provider.storageKey, id])}
            storageKey={JSON.stringify(['managed', provider.storageKey, id])}
            workspaceId={id}
            label={label}
            sessions={visible}
            sessionId={sessionId}
            active={active}
            searchActive={Boolean(query)}
            canCreate={supported && group.workspace?.canCreateSession === true}
            onSelectWorkspace={onSelectWorkspace}
            onSelectSession={onSelectSession}
          />
        );
      })}
      {!groups.size && !loading && !error && (
        <p className={sectionStyles.empty}>{t('managed.workspaceEmpty')}</p>
      )}
      {nextCursor && (
        <Button
          variant="ghost"
          disabled={loading}
          onClick={() => void loadMore()}
          aria-label={`${t('managed.more')} ${t('managed.workspaceLabel')}`}
        >
          {t('managed.more')} · {t('managed.workspaceLabel')}
        </Button>
      )}
    </>
  );
}

function ManagedWorkspaceGroup({
  storageKey,
  workspaceId,
  label,
  sessions,
  sessionId,
  active,
  searchActive,
  canCreate,
  onSelectWorkspace,
  onSelectSession,
}: {
  storageKey: string;
  workspaceId?: string;
  label: string;
  sessions: ManagedAgentSessionSummary[];
  sessionId?: string;
  active: boolean;
  searchActive: boolean;
  canCreate: boolean;
  onSelectWorkspace?: (workspaceId: string) => void;
  onSelectSession: (sessionId: string, workspaceId?: string) => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(() =>
    readWorkspaceExpanded(storageKey),
  );
  const containsSelection = sessions.some(
    (item) => item.sessionId === sessionId,
  );
  useEffect(() => {
    if (active && containsSelection) setExpanded(true);
  }, [active, containsSelection, sessionId]);
  const open = expanded || searchActive;
  const Icon = open ? FolderOpenIcon : FolderClosedIcon;
  return (
    <div
      className={sectionStyles.section}
      data-managed-workspace={workspaceId ?? ''}
    >
      <div className={sectionStyles.headerRow}>
        <button
          type="button"
          className={sectionStyles.header}
          aria-expanded={open}
          onClick={() => {
            const next = !expanded;
            setExpanded(next);
            writeWorkspaceExpanded(storageKey, next);
          }}
        >
          <Icon size={14} strokeWidth={1.4} aria-hidden="true" />
          <span className={sectionStyles.name} title={workspaceId}>
            {label}
          </span>
          <span className={sectionStyles.badge}>
            {t('managed.managedMode')}
          </span>
        </button>
        {workspaceId && onSelectWorkspace && (
          <button
            type="button"
            className={sidebarStyles.workspaceHeaderAction}
            disabled={!canCreate}
            aria-label={`${t('sidebar.newTask')}: ${label}`}
            title={t('sidebar.newTask')}
            onClick={() => onSelectWorkspace(workspaceId)}
          >
            <SquarePenIcon size={16} strokeWidth={1.2} aria-hidden="true" />
          </button>
        )}
      </div>
      {open && (
        <div className={sectionStyles.sessions}>
          {sessions.map((session) => (
            <button
              type="button"
              key={session.sessionId}
              className={`${sidebarStyles.sessionRow} w-full text-left ${active && sessionId === session.sessionId ? sidebarStyles.currentSession : ''}`}
              aria-current={
                active && sessionId === session.sessionId ? 'page' : undefined
              }
              title={t(`managed.phase.${session.phase}`)}
              onClick={() => onSelectSession(session.sessionId, workspaceId)}
            >
              <span className={sectionStyles.sessionName}>
                {session.title || session.sessionId}
              </span>
            </button>
          ))}
          {!sessions.length && (
            <p className={sectionStyles.empty}>{t('sidebar.noSessions')}</p>
          )}
        </div>
      )}
    </div>
  );
}

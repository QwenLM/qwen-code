import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionSummary,
} from './managed-agent-provider';

export interface ManagedArchivedSessionsStatus {
  count: number;
  loading: boolean;
  error: boolean;
}

export function ManagedArchivedSessions({
  provider,
  clientId,
  sessionId,
  active,
  onSelectSession,
  renderSessionActions,
  onSessionsChange,
  onStatusChange,
}: {
  provider: ManagedAgentProvider;
  clientId: string;
  sessionId?: string;
  active: boolean;
  onSelectSession: (sessionId: string, workspaceId?: string) => void;
  renderSessionActions: (session: ManagedAgentSessionSummary) => ReactNode;
  onSessionsChange: (sessions: ManagedAgentSessionSummary[]) => void;
  onStatusChange?: (status: ManagedArchivedSessionsStatus) => void;
}) {
  const { t } = useI18n();
  const [cursor, setCursor] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState<{
    sessions: ManagedAgentSessionSummary[];
    nextCursor?: string;
    loading: boolean;
    error?: string;
  }>({ sessions: [], loading: true });

  useEffect(() => {
    const abort = new AbortController();
    setPage((current) => ({ ...current, loading: true, error: undefined }));
    void provider
      .listSessions({
        clientId,
        archiveState: 'archived',
        limit: 50,
        cursor,
        signal: abort.signal,
      })
      .then((result) => {
        if (abort.signal.aborted) return;
        setPage((current) => ({
          sessions: [
            ...new Map(
              [...current.sessions, ...result.sessions].map((session) => [
                session.sessionId,
                session,
              ]),
            ).values(),
          ],
          nextCursor: result.nextCursor,
          loading: false,
        }));
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          setPage((current) => ({
            ...current,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          }));
      });
    return () => abort.abort();
  }, [provider, clientId, cursor, attempt]);

  useEffect(
    () => onSessionsChange(page.sessions),
    [onSessionsChange, page.sessions],
  );
  useEffect(() => {
    onStatusChange?.({
      count: page.sessions.length,
      loading: page.loading,
      error: Boolean(page.error),
    });
  }, [onStatusChange, page.sessions.length, page.loading, page.error]);

  return (
    <div data-managed-archived-sessions>
      {page.sessions.map((session) => (
        <div key={session.sessionId} className="flex min-w-0 items-center">
          <Button
            variant={
              active && sessionId === session.sessionId ? 'secondary' : 'ghost'
            }
            className="h-auto min-w-0 flex-1 justify-start py-2 text-left"
            aria-current={
              active && sessionId === session.sessionId ? 'page' : undefined
            }
            onClick={() =>
              onSelectSession(session.sessionId, session.workspace?.workspaceId)
            }
          >
            <span className="truncate">
              {session.title || session.sessionId}
            </span>
          </Button>
          {renderSessionActions(session)}
        </div>
      ))}
      {page.loading && <p role="status">{t('managed.loading')}</p>}
      {page.error && (
        <div>
          <p role="alert">{page.error}</p>
          <Button
            variant="ghost"
            onClick={() => setAttempt((value) => value + 1)}
          >
            {t('managed.retry')}
          </Button>
        </div>
      )}
      {page.nextCursor && !page.error && (
        <Button
          variant="ghost"
          disabled={page.loading}
          aria-label={`${t('managed.more')} ${t('sidebar.archivedTitle')}`}
          onClick={() => setCursor(page.nextCursor)}
        >
          {t('managed.more')}
        </Button>
      )}
    </div>
  );
}

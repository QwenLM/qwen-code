import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import { ManagedArtifactContent } from './ManagedToolResultPanel';
import type { ManagedAgentSessionSummary } from './managed-agent-provider';
import type {
  ManagedArtifact,
  ManagedToolResultReader,
  ManagedWorkspaceArtifactReader,
} from './managed-tool-result-types';

/**
 * Workspace-wide artifact library: one cursor page across the workspace's
 * sessions, with the session-scoped reader reused for preview and download.
 */
export function ManagedArtifactLibraryPage({
  library,
  reader,
  workspaceId,
  workspaceLabel,
  clientId,
  sessions,
  onClose,
}: {
  library: ManagedWorkspaceArtifactReader;
  reader: ManagedToolResultReader;
  workspaceId: string;
  workspaceLabel: string;
  clientId: string;
  sessions: ManagedAgentSessionSummary[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [rows, setRows] = useState<ManagedArtifact[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [nextCursor, setNextCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [revision, setRevision] = useState(0);
  const pageAbort = useRef<AbortController | undefined>(undefined);
  const titles = useMemo(
    () =>
      new Map(sessions.map((session) => [session.sessionId, session.title])),
    [sessions],
  );

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError(undefined);
    setRows([]);
    setSelectedId(undefined);
    setNextCursor(undefined);
    void library
      .listArtifacts(workspaceId, { clientId, signal: abort.signal, limit: 50 })
      .then(
        (page) => {
          if (abort.signal.aborted) return;
          setRows(page.data.map((entry) => entry.artifact));
          setSelectedId(page.data[0]?.artifact.id);
          setNextCursor(
            page.hasMore ? (page.nextCursor ?? undefined) : undefined,
          );
          setLoading(false);
        },
        (failure: unknown) => {
          if (abort.signal.aborted) return;
          setError(failure);
          setLoading(false);
        },
      );
    return () => {
      abort.abort();
      pageAbort.current?.abort();
    };
  }, [library, workspaceId, clientId, revision]);

  const loadMore = async () => {
    if (!nextCursor || loading) return;
    const abort = new AbortController();
    pageAbort.current = abort;
    setLoading(true);
    setError(undefined);
    try {
      const page = await library.listArtifacts(workspaceId, {
        clientId,
        signal: abort.signal,
        cursor: nextCursor,
        limit: 50,
      });
      if (abort.signal.aborted) return;
      setRows((current) => [
        ...new Map(
          [...current, ...page.data.map((entry) => entry.artifact)].map(
            (artifact) => [artifact.id, artifact],
          ),
        ).values(),
      ]);
      setNextCursor(page.hasMore ? (page.nextCursor ?? undefined) : undefined);
    } catch (failure) {
      if (!abort.signal.aborted) setError(failure);
    } finally {
      if (!abort.signal.aborted) setLoading(false);
    }
  };

  const sessionLabel = (sessionId: string) =>
    titles.get(sessionId) ||
    `${t('managed.artifactLibrary.sessionFallback')} ${sessionId.slice(0, 8)}`;
  const selected = rows.find((artifact) => artifact.id === selectedId);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-3xl"
        aria-describedby="managed-artifact-library-description"
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>
            {t('managed.artifactLibrary.title')} · {workspaceLabel}
          </DialogTitle>
          <DialogDescription id="managed-artifact-library-description">
            {t('managed.artifactLibrary.description')}
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => setRevision((value) => value + 1)}
          >
            {t('managed.artifactLibrary.refresh')}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t('managed.artifactLibrary.close')}
          </Button>
        </div>
        {loading && <p role="status">{t('managed.loading')}</p>}
        {error !== undefined && <LibraryError error={error} />}
        {!loading && error === undefined && rows.length === 0 && (
          <p>{t('managed.artifactLibrary.empty')}</p>
        )}
        {rows.length > 0 && (
          <div
            className="flex flex-col gap-2"
            role="group"
            aria-label={t('managed.artifactLibrary.title')}
          >
            {rows.map((artifact) => (
              <Button
                key={artifact.id}
                variant={artifact.id === selectedId ? 'secondary' : 'outline'}
                aria-pressed={artifact.id === selectedId}
                className="justify-start"
                onClick={() => setSelectedId(artifact.id)}
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span>
                    {artifact.stream_role} ·{' '}
                    {artifact.byte_length.toLocaleString()} B
                  </span>
                  <span>{sessionLabel(artifact.session_id)}</span>
                  <span>{new Date(artifact.created_at).toLocaleString()}</span>
                  {artifact.availability === 'unavailable' && (
                    <span>{t('managed.artifactLibrary.unavailableBadge')}</span>
                  )}
                </span>
              </Button>
            ))}
          </div>
        )}
        {nextCursor && (
          <Button
            variant="outline"
            disabled={loading}
            onClick={() => void loadMore()}
          >
            {t('managed.more')}
          </Button>
        )}
        {selected && (
          <ManagedArtifactContent
            key={`${workspaceId}:${selected.id}:${selected.revision}:${revision}`}
            artifact={selected}
            reader={reader}
            clientId={clientId}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function LibraryError({ error }: { error: unknown }) {
  const { t } = useI18n();
  if (error instanceof JavaManagedAgentHttpError && error.status === 404) {
    return <p role="alert">{t('managed.artifactLibrary.unavailable')}</p>;
  }
  return (
    <p role="alert">
      {t('managed.artifactLibrary.loadFailed')}{' '}
      {error instanceof Error ? error.message : String(error)}
    </p>
  );
}

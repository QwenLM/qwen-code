import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  useConnection,
  useWorkspace,
  useWorkspaceActions,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { useI18n } from '../../i18n';
import {
  useWorkspaceArtifactLibrary,
  type WorkspaceArtifactLibraryReader,
  type WorkspaceArtifactLibraryRequestError,
  type WorkspaceArtifactLibraryRow,
} from '../../hooks/useWorkspaceArtifactLibrary';
import { getSessionCatalogStore } from '../../session-catalog/session-catalog-store';
import { FileTypeIcon } from '../FileTypeIcon';
import { Button } from '../ui/button';
import { ArtifactDetail } from './ArtifactPanel';
import {
  artifactDisplayName,
  classifyWorkspaceArtifactDispatch,
  formatArtifactSize,
} from './artifactUtils';
import { useArtifactWorkspaceTarget } from './useArtifactWorkspaceTarget';
import styles from './WorkspaceArtifactLibraryPage.module.css';

export const DEFAULT_ARTIFACT_LIBRARY_RENDER_STEP = 50;

export interface WorkspaceArtifactLibraryPageProps {
  workspaceCwd: string | undefined;
  onOpenSession: (
    sessionId: string,
    archiveState: 'active' | 'archived',
  ) => void;
  onJumpToSessionArtifact: (
    sessionId: string,
    artifactId: string,
    archiveState: 'active' | 'archived',
  ) => void;
  reader?: WorkspaceArtifactLibraryReader;
  features?: readonly string[];
  isSessionLive?: (sessionId: string) => boolean;
  renderLimitStep?: number;
}

function formatSessionLabel(
  row: Pick<WorkspaceArtifactLibraryRow, 'sessionId' | 'session'>,
  fallbackPrefix: string,
): string {
  const name = row.session.displayName?.trim();
  return name && name.length > 0
    ? name
    : `${fallbackPrefix} ${row.sessionId.slice(0, 8)}`;
}

function describeRequestError(
  error: WorkspaceArtifactLibraryRequestError,
  t: (key: string) => string,
): string {
  if (error.status === 409 && error.code === 'artifact_library_unavailable') {
    return t('workspaceArtifactLibrary.persistenceUnavailable');
  }
  if (error.status === 503 && error.code === 'workspace_runtime_unavailable') {
    return t('workspaceArtifactLibrary.runtimeUnavailable');
  }
  return `${t('workspaceArtifactLibrary.loadFailed')} ${error.message}`;
}

export function WorkspaceArtifactLibraryPage({
  workspaceCwd,
  onOpenSession,
  onJumpToSessionArtifact,
  reader: readerProp,
  features: featuresProp,
  isSessionLive: isSessionLiveProp,
  renderLimitStep = DEFAULT_ARTIFACT_LIBRARY_RENDER_STEP,
}: WorkspaceArtifactLibraryPageProps) {
  const { t } = useI18n();
  const workspace = useWorkspace();
  const workspaceActions = useWorkspaceActions();
  const connection = useConnection();
  const reader = readerProp ?? workspaceActions;
  const features = featuresProp ?? workspace.capabilities?.features;
  const workspaceTarget = useArtifactWorkspaceTarget(workspaceCwd);

  const [liveRevision, setLiveRevision] = useState(0);
  useEffect(() => {
    if (isSessionLiveProp || !workspaceCwd || !workspace.client) return;
    const store = getSessionCatalogStore(workspace.client);
    return store.subscribeLiveSessions(workspaceCwd, () => {
      setLiveRevision((value) => value + 1);
    });
  }, [isSessionLiveProp, workspace.client, workspaceCwd]);

  const checkSessionLive = useCallback(
    (sessionId: string): boolean => {
      if (isSessionLiveProp) return isSessionLiveProp(sessionId);
      if (
        connection.sessionId === sessionId &&
        connection.status === 'connected'
      )
        return true;
      if (!workspaceCwd || !workspace.client) return false;
      void liveRevision;
      return (
        getSessionCatalogStore(workspace.client).getLiveSession(
          workspaceCwd,
          sessionId,
        ) !== undefined
      );
    },
    [
      connection.sessionId,
      connection.status,
      isSessionLiveProp,
      liveRevision,
      workspace.client,
      workspaceCwd,
    ],
  );

  const library = useWorkspaceArtifactLibrary({
    workspaceSelector: workspaceCwd,
    reader,
    features,
  });

  const [filterText, setFilterText] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined);
  const [activatedKey, setActivatedKey] = useState<string | undefined>(
    undefined,
  );
  const [activationNonce, setActivationNonce] = useState(0);
  const [renderLimit, setRenderLimit] = useState(renderLimitStep);

  useEffect(() => {
    setFilterText('');
    setSelectedKey(undefined);
    setActivatedKey(undefined);
  }, [workspaceCwd]);

  useEffect(() => {
    setRenderLimit(renderLimitStep);
  }, [library.owner?.generation, library.owner?.workspaceKey, renderLimitStep]);

  const sessionFallback = t('workspaceArtifactLibrary.sessionFallback');
  const normalizedFilter = filterText.trim().toLowerCase();

  const filteredRows = useMemo(() => {
    if (!normalizedFilter) return library.rows;
    return library.rows.filter((row) => {
      const title = artifactDisplayName(row.artifact).toLowerCase();
      const description = (row.artifact.description ?? '').toLowerCase();
      const path = (row.artifact.workspacePath ?? '').toLowerCase();
      const label = formatSessionLabel(row, sessionFallback).toLowerCase();
      return (
        title.includes(normalizedFilter) ||
        description.includes(normalizedFilter) ||
        path.includes(normalizedFilter) ||
        label.includes(normalizedFilter)
      );
    });
  }, [library.rows, normalizedFilter, sessionFallback]);

  const visibleRows = useMemo(
    () => filteredRows.slice(0, renderLimit),
    [filteredRows, renderLimit],
  );

  const selectedRow = useMemo(() => {
    if (selectedKey) {
      const match = filteredRows.find((row) => row.key === selectedKey);
      if (match) return match;
    }
    return visibleRows.find((row) => {
      const dispatch = classifyWorkspaceArtifactDispatch(
        row.artifact,
        checkSessionLive(row.sessionId),
      );
      return dispatch.kind !== 'jump_web_preview_snapshot';
    });
  }, [checkSessionLive, filteredRows, selectedKey, visibleRows]);

  const handleRowActivate = (row: WorkspaceArtifactLibraryRow) => {
    const dispatch = classifyWorkspaceArtifactDispatch(
      row.artifact,
      checkSessionLive(row.sessionId),
    );
    if (dispatch.kind === 'jump_web_preview_snapshot') {
      onJumpToSessionArtifact(
        row.sessionId,
        row.artifact.id,
        row.session.archiveState,
      );
      return;
    }
    setSelectedKey(row.key);
    setActivatedKey(row.key);
    setActivationNonce((value) => value + 1);
  };

  const progressCounter =
    library.progress.total !== undefined
      ? `${library.progress.received}/${library.progress.total}`
      : `${library.progress.received}`;

  return (
    <div
      className={styles.container}
      data-testid="workspace-artifact-library-page"
    >
      <div className={styles.toolbar}>
        <p className={styles.description}>
          {t('workspaceArtifactLibrary.description')}
        </p>
        <div className={styles.toolbarControls}>
          <input
            type="search"
            className={styles.filterInput}
            data-testid="workspace-artifact-library-filter"
            placeholder={t('workspaceArtifactLibrary.filterPlaceholder')}
            aria-label={t('workspaceArtifactLibrary.filterPlaceholder')}
            value={filterText}
            onChange={(event) => setFilterText(event.target.value)}
          />
          <Button
            variant="outline"
            size="sm"
            data-testid="workspace-artifact-library-refresh"
            onClick={library.refresh}
          >
            {t('workspaceArtifactLibrary.refresh')}
          </Button>
        </div>
      </div>

      <div
        className={styles.statusBar}
        role="status"
        data-testid="workspace-artifact-library-status"
      >
        {library.scanning && (
          <span>
            {t('workspaceArtifactLibrary.scanning')} ({progressCounter})
          </span>
        )}
        {!library.scanning &&
          library.complete &&
          library.sessionErrors.length === 0 && (
            <span>
              {t('workspaceArtifactLibrary.enumerationComplete')} (
              {progressCounter})
            </span>
          )}
        {!library.scanning &&
          library.complete &&
          library.sessionErrors.length > 0 && (
            <span>
              {t('workspaceArtifactLibrary.finishedWithErrors')} (
              {progressCounter})
            </span>
          )}
      </div>

      {library.partial && !library.requestError && (
        <div
          className={styles.banner}
          role="alert"
          data-testid="workspace-artifact-library-partial-banner"
        >
          <span>
            {t('workspaceArtifactLibrary.partialBanner')} ({progressCounter})
          </span>
          <Button variant="outline" size="sm" onClick={library.refresh}>
            {t('workspaceArtifactLibrary.retry')}
          </Button>
        </div>
      )}

      {library.requestError && (
        <div
          className={`${styles.banner} ${styles.errorBanner}`}
          role="alert"
          data-testid="workspace-artifact-library-request-error"
        >
          <span>{describeRequestError(library.requestError, t)}</span>
          <Button variant="outline" size="sm" onClick={library.refresh}>
            {t('workspaceArtifactLibrary.retry')}
          </Button>
        </div>
      )}

      {library.sessionErrors.length > 0 && (
        <div
          className={styles.sessionErrors}
          role="region"
          aria-label={t('workspaceArtifactLibrary.sessionErrorsTitle')}
          data-testid="workspace-artifact-library-session-errors"
        >
          <strong>{t('workspaceArtifactLibrary.sessionErrorsTitle')}</strong>
          <ul className={styles.sessionErrorsList}>
            {library.sessionErrors.map((err) => (
              <li key={err.sessionId}>
                <code>{err.sessionId.slice(0, 8)}</code> · {err.code}:{' '}
                {err.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!library.scanning &&
        library.complete &&
        !library.requestError &&
        library.rows.length === 0 &&
        library.sessionErrors.length === 0 && (
          <p
            className={styles.emptyState}
            data-testid="workspace-artifact-library-empty"
          >
            {t('workspaceArtifactLibrary.empty')}
          </p>
        )}

      {library.rows.length > 0 && filteredRows.length === 0 && (
        <p
          className={styles.emptyState}
          data-testid="workspace-artifact-library-filter-empty"
        >
          {t('workspaceArtifactLibrary.filterEmpty')}
        </p>
      )}

      {visibleRows.length > 0 && (
        <div className={styles.body}>
          <div className={styles.listPane}>
            <ul
              className={styles.rows}
              data-testid="workspace-artifact-library-rows"
            >
              {visibleRows.map((row) => {
                const displayName = artifactDisplayName(row.artifact);
                const sessionLabel = formatSessionLabel(row, sessionFallback);
                const size = formatArtifactSize(row.artifact.sizeBytes);
                const timestamp =
                  row.artifact.updatedAt || row.artifact.createdAt;
                const isSelected = selectedRow?.key === row.key;
                const isArchived = row.session.archiveState === 'archived';
                const dispatch = classifyWorkspaceArtifactDispatch(
                  row.artifact,
                  checkSessionLive(row.sessionId),
                );
                return (
                  <li
                    key={row.key}
                    className={`${styles.rowCard} ${
                      isSelected ? styles.rowCardSelected : ''
                    }`}
                    data-testid="workspace-artifact-library-row"
                    data-artifact-id={row.artifact.id}
                    data-session-id={row.sessionId}
                  >
                    <button
                      type="button"
                      className={styles.rowSelectButton}
                      onClick={() => handleRowActivate(row)}
                      aria-pressed={
                        dispatch.kind === 'jump_web_preview_snapshot'
                          ? undefined
                          : isSelected
                      }
                      title={
                        dispatch.kind === 'jump_web_preview_snapshot'
                          ? t('workspaceArtifactLibrary.jumpToPreview')
                          : displayName
                      }
                    >
                      <span className={styles.rowTitleGroup}>
                        <FileTypeIcon
                          name={
                            row.artifact.workspacePath ?? row.artifact.title
                          }
                          mimeType={row.artifact.mimeType}
                          size={16}
                          strokeWidth={1.7}
                          aria-hidden
                        />
                        <span className={styles.rowTitle}>{displayName}</span>
                      </span>
                      {size && <span>{size}</span>}
                    </button>
                    <div className={styles.rowMeta}>
                      <button
                        type="button"
                        className={styles.sessionLink}
                        data-testid="workspace-artifact-library-session-link"
                        onClick={() =>
                          onOpenSession(row.sessionId, row.session.archiveState)
                        }
                        title={t('workspaceArtifactLibrary.openSession')}
                      >
                        <span>{sessionLabel}</span>
                        <span className={styles.archiveBadge}>
                          {t(
                            isArchived
                              ? 'workspaceArtifactLibrary.archivedBadge'
                              : 'workspaceArtifactLibrary.activeBadge',
                          )}
                        </span>
                      </button>
                      {timestamp && (
                        <time dateTime={timestamp}>
                          {new Date(timestamp).toLocaleString()}
                        </time>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            {filteredRows.length > visibleRows.length && (
              <Button
                variant="outline"
                size="sm"
                data-testid="workspace-artifact-library-load-more"
                onClick={() =>
                  setRenderLimit((current) => current + renderLimitStep)
                }
              >
                {t('workspaceArtifactLibrary.loadMore')} ({visibleRows.length}/
                {filteredRows.length})
              </Button>
            )}
          </div>
          {selectedRow && workspaceTarget && (
            <div
              className={styles.detailPane}
              data-testid="workspace-artifact-library-detail"
            >
              <ArtifactDetail
                key={`${selectedRow.key}:${
                  selectedRow.key === activatedKey ? activationNonce : 0
                }`}
                artifact={selectedRow.artifact}
                sourceSessionId={selectedRow.sessionId}
                workspaceActions={workspaceTarget.actions}
                onSnapshotSessionNotFound={
                  selectedRow.key === activatedKey
                    ? () =>
                        onJumpToSessionArtifact(
                          selectedRow.sessionId,
                          selectedRow.artifact.id,
                          selectedRow.session.archiveState,
                        )
                    : undefined
                }
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

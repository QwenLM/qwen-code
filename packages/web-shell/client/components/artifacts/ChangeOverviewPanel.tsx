import { useMemo, useState } from 'react';
import { RefreshCwIcon } from 'lucide-react';
import { useI18n } from '../../i18n';
import { useExternalLinkOpener } from '../../hooks/useExternalLinkOpener';
import { sanitizeControlChars } from '../messages/toolFormatting';
import { LineStats } from './LineStats';
import { useChangeOverview } from './useChangeOverview';
import type { ChangeOverviewUnit } from './change-overview';
import styles from './ChangeOverviewPanel.module.css';

function unitLabel(unit: ChangeOverviewUnit, uncommittedLabel: string): string {
  switch (unit.kind) {
    case 'uncommitted':
      return uncommittedLabel;
    case 'pr':
      return unit.title;
    case 'commit':
      return unit.shortSha;
  }
}

function unavailableMessageKey(
  unit: Extract<ChangeOverviewUnit, { kind: 'pr' }>,
): string {
  switch (unit.unavailableCause) {
    case 'cli':
      return 'changeOverview.prUnavailableCli';
    case 'route':
      return 'changeOverview.prUnavailableRoute';
    default:
      return 'changeOverview.prUnavailable';
  }
}

export function ChangeOverviewPanel({
  workspaceCwd,
  sessionId,
}: {
  workspaceCwd: string;
  sessionId?: string;
}) {
  const { t } = useI18n();
  const openExternalLink = useExternalLinkOpener();
  const {
    gitAvailable,
    loadFailed,
    loading,
    units,
    commitsTruncated,
    refresh,
  } = useChangeOverview(workspaceCwd, sessionId);
  const [selectedId, setSelectedId] = useState<string>('uncommitted');

  const selected = useMemo(
    () => units.find((unit) => unit.id === selectedId) ?? units[0],
    [units, selectedId],
  );

  const selectedUnavailable =
    selected?.kind === 'pr' && selected.state === 'unavailable';

  // The toolbar (with Refresh) stays mounted in every state so a transient or
  // non-git verdict is always recoverable without closing the tab.
  return (
    <div className={styles.root} aria-busy={loading}>
      <div className={styles.toolbar}>
        <span className={styles.toolbarTitle}>{t('changeOverview.title')}</span>
        <button
          type="button"
          className={styles.refreshButton}
          onClick={refresh}
          disabled={loading}
          aria-label={t('changeOverview.refresh')}
          title={t('changeOverview.refresh')}
        >
          <RefreshCwIcon size={14} />
        </button>
      </div>

      {gitAvailable && units.length > 0 && (
        <div className={styles.scopeRow} role="tablist">
          {units.map((unit) => {
            const badgeHidden =
              unit.kind === 'commit' ||
              (unit.kind === 'pr' && unit.state === 'unavailable');
            return (
              <button
                key={unit.id}
                type="button"
                role="tab"
                aria-selected={selected?.id === unit.id}
                className={`${styles.scopeChip} ${
                  selected?.id === unit.id ? styles.scopeChipActive : ''
                }`}
                onClick={() => setSelectedId(unit.id)}
                title={
                  unit.kind === 'commit'
                    ? sanitizeControlChars(unit.subject)
                    : undefined
                }
              >
                <span className={styles.scopeChipLabel}>
                  {unitLabel(unit, t('changeOverview.uncommitted'))}
                </span>
                {!badgeHidden && (
                  <span className={styles.scopeBadge}>{unit.filesCount}</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {gitAvailable && commitsTruncated && (
        <div className={styles.commitsNote}>
          {t('changeOverview.hiddenCommits')}
        </div>
      )}

      {/* Keyed per selected unit so switching scope remounts the scroll region
          and resets its offset instead of inheriting the previous scroll. */}
      <div className={styles.body} key={selected?.id ?? 'none'}>
        {!gitAvailable ? (
          <div className={styles.message}>{t('changeOverview.notGit')}</div>
        ) : loadFailed ? (
          <div className={styles.message}>{t('changeOverview.loadFailed')}</div>
        ) : loading && units.length === 0 ? (
          <div className={styles.message}>{t('changeOverview.loading')}</div>
        ) : !selected ? (
          <div className={styles.message}>{t('changeOverview.empty')}</div>
        ) : (
          <>
            <div className={styles.scaleHeader}>
              <span className={styles.scaleTitle}>
                {selected.kind === 'commit'
                  ? sanitizeControlChars(selected.subject)
                  : unitLabel(selected, t('changeOverview.uncommitted'))}
              </span>
              {!selectedUnavailable && (
                <>
                  <span>
                    {t('changeOverview.files', { count: selected.filesCount })}
                  </span>
                  <LineStats
                    additions={selected.additions}
                    deletions={selected.deletions}
                    className={styles.lineStats}
                    additionsClassName={styles.additions}
                    deletionsClassName={styles.deletions}
                  />
                </>
              )}
              {selected.kind === 'pr' && selected.url && (
                <a
                  href={selected.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.prLink}
                  onClick={(event) => openExternalLink(event, selected.url)}
                >
                  {t('changeOverview.openPr')}
                </a>
              )}
            </div>

            {selectedUnavailable ? (
              <div className={styles.message}>
                {t(
                  unavailableMessageKey(
                    selected as Extract<ChangeOverviewUnit, { kind: 'pr' }>,
                  ),
                )}
              </div>
            ) : selected.files.length === 0 && selected.hiddenCount === 0 ? (
              <div className={styles.message}>{t('changeOverview.empty')}</div>
            ) : selected.files.length > 0 ? (
              <div className={styles.fileList}>
                {selected.files.map((file) => (
                  <div key={file.path} className={styles.fileRow}>
                    <span
                      className={styles.filePath}
                      title={sanitizeControlChars(file.path)}
                    >
                      {sanitizeControlChars(file.path)}
                    </span>
                    {file.isBinary ? (
                      <span className={styles.fileBinary}>~</span>
                    ) : (
                      <LineStats
                        additions={file.additions}
                        deletions={file.deletions}
                        className={`${styles.lineStats} ${styles.fileStats}`}
                        additionsClassName={styles.additions}
                        deletionsClassName={styles.deletions}
                      />
                    )}
                  </div>
                ))}
              </div>
            ) : null}

            {selected.hiddenCount > 0 && (
              <div className={styles.hiddenNote}>
                {t('changeOverview.hiddenFiles', {
                  count: selected.hiddenCount,
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

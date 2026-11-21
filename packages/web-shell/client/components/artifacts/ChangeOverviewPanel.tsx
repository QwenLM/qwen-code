import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
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
  const { t, isRtl } = useI18n();
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

  // The tablist only renders with units; the body must not advertise an orphan
  // tabpanel in the loading/error/empty/non-git states (no tab to label it).
  const hasTabs = gitAvailable && units.length > 0;

  // Roving tabindex: only the selected tab is in the tab order; Arrow/Home/End
  // move focus and selection together (automatic activation), wrapping at the
  // ends, so the scope selector is a keyboard-operable tab widget (D4-1).
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const handleTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    // Leave modified keys to the browser: Alt+Left/Right is Back/Forward and
    // Ctrl+Home/End scrolls the document; swallowing them here would turn
    // navigation into a scope change.
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const forwardKey = isRtl ? 'ArrowLeft' : 'ArrowRight';
    const backwardKey = isRtl ? 'ArrowRight' : 'ArrowLeft';
    let next: number;
    switch (event.key) {
      case forwardKey:
        next = (index + 1) % units.length;
        break;
      case backwardKey:
        next = (index - 1 + units.length) % units.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = units.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const unit = units[next];
    setSelectedId(unit.id);
    const tab = tabRefs.current.get(unit.id);
    tab?.focus({ preventScroll: true });
    // The chip row scrolls horizontally; bring the newly selected chip into
    // view so keyboard navigation past the visible strip is not clipped.
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

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

      {hasTabs && (
        <div
          className={styles.scopeRow}
          role="tablist"
          aria-label={t('changeOverview.title')}
        >
          {units.map((unit, index) => {
            const badgeHidden =
              unit.kind === 'commit' ||
              (unit.kind === 'pr' && unit.state === 'unavailable');
            const isSelected = selected?.id === unit.id;
            return (
              <button
                key={unit.id}
                ref={(el) => {
                  if (el) tabRefs.current.set(unit.id, el);
                  else tabRefs.current.delete(unit.id);
                }}
                type="button"
                role="tab"
                id={`change-overview-tab-${unit.id}`}
                aria-selected={isSelected}
                aria-controls="change-overview-tabpanel"
                tabIndex={isSelected ? 0 : -1}
                className={`${styles.scopeChip} ${
                  isSelected ? styles.scopeChipActive : ''
                }`}
                onClick={() => setSelectedId(unit.id)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
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
      <div
        className={styles.body}
        key={selected?.id ?? 'none'}
        role={hasTabs ? 'tabpanel' : undefined}
        id={hasTabs ? 'change-overview-tabpanel' : undefined}
        aria-labelledby={
          hasTabs && selected ? `change-overview-tab-${selected.id}` : undefined
        }
        tabIndex={hasTabs ? 0 : undefined}
      >
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

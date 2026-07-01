import { useCallback, useEffect, useRef, useState } from 'react';
import { dp } from './dialogStyles';
import {
  useConnection,
  useSessions,
  type DaemonSessionSummary,
} from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { useListboxKeyboard } from '../../hooks/useListboxKeyboard';
import { useFilterInput } from '../../hooks/useFilterInput';
import { SessionRow } from './SessionRow';

interface ReleaseSessionDialogProps {
  onReleased: (sessionId: string) => void;
  onError: (error: unknown) => void;
  onClose: () => void;
}

const LIST_ID = 'release-session-list';
const optionId = (index: number) => `${LIST_ID}-opt-${index}`;

export function ReleaseSessionDialog({
  onReleased,
  onError,
  onClose,
}: ReleaseSessionDialogProps) {
  const { t } = useI18n();
  const connection = useConnection();
  const {
    sessions,
    loading,
    error: sessionsError,
    releaseSession,
  } = useSessions({ autoLoad: true });
  const currentSessionId = connection.sessionId;
  const [deleting, setDeleting] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [hasSelectedSession, setHasSelectedSession] = useState(false);
  const { filterValue: filterQuery, inputProps } = useFilterInput(() => {
    setSelectedIdx(0);
    setHasSelectedSession(false);
  });
  const [message, setMessage] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (sessionsError) setMessage(sessionsError.message);
  }, [sessionsError]);

  const filtered = filterQuery
    ? sessions.filter((s) => {
        const q = filterQuery.toLowerCase();
        return (
          (s.displayName || '').toLowerCase().includes(q) ||
          s.sessionId.toLowerCase().includes(q)
        );
      })
    : sessions;

  const selectRow = (index: number) => {
    setSelectedIdx(index);
    setHasSelectedSession(true);
  };

  useEffect(() => {
    if (selectedIdx >= filtered.length && filtered.length > 0) {
      setSelectedIdx(filtered.length - 1);
    }
  }, [filtered.length, selectedIdx]);

  useEffect(() => {
    const el = listRef.current?.children[selectedIdx] as
      | HTMLElement
      | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Enter only moves/commits the highlight; the actual (destructive) release
  // still requires pressing the danger button — mirroring the click behaviour.
  const { keyboardMode } = useListboxKeyboard({
    itemCount: filtered.length,
    activeIndex: selectedIdx,
    onActiveIndexChange: selectRow,
    onConfirm: selectRow,
  });

  const handleRelease = useCallback(
    (targetSession?: DaemonSessionSummary) => {
      const session = targetSession ?? filtered[selectedIdx];
      if (!session || deleting) return;
      const releasable =
        (session.clientCount ?? 0) > 0 || session.hasActivePrompt === true;
      if (!releasable) {
        setMessage(t('release.inactive'));
        return;
      }
      if (session.sessionId === currentSessionId) {
        setMessage(t('release.cannotCurrent'));
        return;
      }
      if (!releaseSession) return;
      setDeleting(true);
      releaseSession(session.sessionId)
        .then(() => {
          onReleased(session.sessionId);
          onClose();
        })
        .catch((error: unknown) => {
          onError(error);
          setDeleting(false);
        });
    },
    [
      currentSessionId,
      deleting,
      filtered,
      onClose,
      onError,
      onReleased,
      releaseSession,
      selectedIdx,
      t,
    ],
  );

  const selectedSession = filtered[selectedIdx];
  const selectedReleasable =
    selectedSession &&
    ((selectedSession.clientCount ?? 0) > 0 ||
      selectedSession.hasActivePrompt === true);
  const canRelease =
    !deleting &&
    !loading &&
    hasSelectedSession &&
    !!selectedSession &&
    selectedSession.sessionId !== currentSessionId &&
    !!selectedReleasable;

  return (
    <div className={dp('picker', 'picker-in-shell')}>
      <div className={dp('picker-search')}>
        <span className={dp('picker-search-label')}>
          {t('resume.search')}:{' '}
        </span>
        <input
          ref={inputRef}
          className={dp('picker-search-input')}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={LIST_ID}
          aria-activedescendant={
            hasSelectedSession && filtered.length > 0
              ? optionId(selectedIdx)
              : undefined
          }
          {...inputProps}
          placeholder=""
        />
        <span className={dp('picker-search-hint')}>
          {message ||
            (deleting
              ? t('release.releasing')
              : loading
                ? t('common.loading')
                : filterQuery
                  ? t('release.matches', { count: filtered.length })
                  : '')}
        </span>
      </div>

      <div className={dp('picker-sep')} />

      <div
        id={LIST_ID}
        role="listbox"
        className={dp(
          'picker-list',
          keyboardMode ? 'picker-keyboard-only' : undefined,
        )}
        ref={listRef}
      >
        {loading && (
          <div className={dp('picker-empty')}>{t('common.loading')}</div>
        )}
        {!loading && filtered.length === 0 && (
          <div className={dp('picker-empty')}>
            {filterQuery
              ? t('release.noMatch', { query: filterQuery })
              : t('release.none')}
          </div>
        )}
        {!loading &&
          filtered.map((s, i) => {
            const isCurrent = s.sessionId === currentSessionId;
            const isReleasable =
              (s.clientCount ?? 0) > 0 || s.hasActivePrompt === true;
            const isDisabled = isCurrent || !isReleasable;
            return (
              <SessionRow
                key={s.sessionId}
                session={s}
                optionId={optionId(i)}
                active={hasSelectedSession && i === selectedIdx}
                current={isCurrent}
                disabled={isDisabled}
                currentLabel={t('resume.current')}
                trailing={
                  !isCurrent && !isReleasable ? (
                    <span className={dp('picker-item-badge')}>
                      {t('release.inactiveBadge')}
                    </span>
                  ) : undefined
                }
                onClick={() => selectRow(i)}
              />
            );
          })}
      </div>

      <div className={dp('picker-sep')} />
      <div className={dp('dialog-footer-actions')}>
        <button
          type="button"
          className={dp('dialog-inline-button')}
          onClick={onClose}
          disabled={deleting}
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className={dp('dialog-danger-button')}
          onClick={() => handleRelease()}
          disabled={!canRelease}
        >
          {deleting ? t('release.releasing') : t('release.action')}
        </button>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { dp } from './dialogStyles';
import {
  useConnection,
  type DaemonSessionSummary,
} from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { useListboxKeyboard } from '../../hooks/useListboxKeyboard';
import { useFilterInput } from '../../hooks/useFilterInput';
import { SessionRow } from './SessionRow';
import { useScopedSessions } from '../../hooks/useScopedSessions';

interface ReleaseSessionDialogProps {
  onReleased: (sessionId: string) => void;
  onError: (error: unknown) => void;
  onClose: () => void;
  workspaceCwd?: string;
}

const LIST_ID = 'release-session-list';
const optionId = (index: number) => `${LIST_ID}-opt-${index}`;

export function ReleaseSessionDialog({
  onReleased,
  onError,
  onClose,
  workspaceCwd,
}: ReleaseSessionDialogProps) {
  const { t } = useI18n();
  const connection = useConnection();
  const {
    sessions,
    loading,
    error: sessionsError,
    releaseSession,
  } = useScopedSessions(workspaceCwd, { autoLoad: true });
  const currentSessionId = connection.sessionId;
  const [deleting, setDeleting] = useState(false);
  // -1 = no highlight; see ResumeDialog for the rationale.
  const [cursorIdx, setCursorIdx] = useState(-1);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );
  const { filterValue: filterQuery, inputProps } = useFilterInput(() => {
    setCursorIdx(-1);
    setSelectedSessionId(null);
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

  const confirmRow = (index: number) => {
    const session = filtered[index];
    if (!session) return;

    const isCurrent = session.sessionId === currentSessionId;
    const isReleasable =
      (session.clientCount ?? 0) > 0 || session.hasActivePrompt === true;
    if (isCurrent || !isReleasable) return;

    setCursorIdx(index);
    setSelectedSessionId(session.sessionId);
  };

  useEffect(() => {
    if (cursorIdx >= filtered.length && filtered.length > 0) {
      setCursorIdx(filtered.length - 1);
    }
  }, [filtered.length, cursorIdx]);

  useEffect(() => {
    const el = listRef.current?.children[cursorIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursorIdx]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Arrows move only the roving cursor. Enter/click confirms the target row,
  // but the destructive release still stays behind the danger button.
  const { keyboardMode } = useListboxKeyboard({
    itemCount: filtered.length,
    activeIndex: cursorIdx,
    onActiveIndexChange: setCursorIdx,
    onConfirm: confirmRow,
  });

  const handleRelease = useCallback(
    (targetSession?: DaemonSessionSummary) => {
      const session =
        targetSession ??
        filtered.find((s) => s.sessionId === selectedSessionId) ??
        undefined;
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
      selectedSessionId,
      t,
    ],
  );

  const selectedSession =
    filtered.find((s) => s.sessionId === selectedSessionId) ?? undefined;
  const selectedReleasable =
    selectedSession &&
    ((selectedSession.clientCount ?? 0) > 0 ||
      selectedSession.hasActivePrompt === true);
  const canRelease =
    !deleting &&
    !loading &&
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
          aria-label={t('resume.search')}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={LIST_ID}
          aria-activedescendant={
            cursorIdx >= 0 && cursorIdx < filtered.length
              ? optionId(cursorIdx)
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
                active={i === cursorIdx}
                confirmed={s.sessionId === selectedSessionId}
                ariaSelected={s.sessionId === selectedSessionId}
                // In release/delete dialogs, "current session" is just a
                // disabled reason, not the confirmed target. Keep the stronger
                // accent bar + ✓ for the actual confirmed release target only.
                current={false}
                disabled={isDisabled}
                trailing={
                  isCurrent ? (
                    <span className={dp('picker-item-badge')}>
                      {t('resume.current')}
                    </span>
                  ) : !isReleasable ? (
                    <span className={dp('picker-item-badge')}>
                      {t('release.inactiveBadge')}
                    </span>
                  ) : undefined
                }
                onClick={() => confirmRow(i)}
                onActivate={() => setCursorIdx(i)}
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

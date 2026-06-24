import { useCallback, useEffect, useRef, useState } from 'react';
import { dp } from './dialogStyles';
import {
  useConnection,
  useSessions,
  type DaemonSessionSummary,
} from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { formatRelativeTime } from '../../utils/formatRelativeTime';

interface ReleaseSessionDialogProps {
  onReleased: (sessionId: string) => void;
  onError: (error: unknown) => void;
  onClose: () => void;
}

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
  const [searchQuery, setSearchQuery] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (sessionsError) setMessage(sessionsError.message);
  }, [sessionsError]);

  const filtered = searchQuery
    ? sessions.filter((s) => {
        const q = searchQuery.toLowerCase();
        return (
          (s.displayName || '').toLowerCase().includes(q) ||
          s.sessionId.toLowerCase().includes(q)
        );
      })
    : sessions;

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
    <div className={dp('resume-picker', 'resume-picker-in-shell')}>
      <div className={dp('resume-picker-search')}>
        <span className={dp('resume-picker-search-label')}>
          {t('resume.search')}:{' '}
        </span>
        <input
          ref={inputRef}
          className={dp('resume-picker-search-input')}
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            setSelectedIdx(0);
            setHasSelectedSession(false);
          }}
          placeholder=""
        />
        <span className={dp('resume-picker-search-hint')}>
          {message ||
            (deleting
              ? t('release.releasing')
              : loading
                ? t('common.loading')
                : searchQuery
                  ? t('release.matches', { count: filtered.length })
                  : '')}
        </span>
      </div>

      <div className={dp('resume-picker-sep')} />

      <div className={dp('resume-picker-list')} ref={listRef}>
        {loading && (
          <div className={dp('resume-picker-empty')}>{t('common.loading')}</div>
        )}
        {!loading && filtered.length === 0 && (
          <div className={dp('resume-picker-empty')}>
            {searchQuery
              ? t('release.noMatch', { query: searchQuery })
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
              <div
                key={s.sessionId}
                className={dp(
                  'resume-picker-item',
                  'resume-picker-session-item',
                  hasSelectedSession && i === selectedIdx
                    ? 'selected'
                    : undefined,
                  isCurrent ? 'resume-picker-item-current' : undefined,
                  isDisabled ? 'disabled' : undefined,
                )}
                onClick={() => {
                  setSelectedIdx(i);
                  setHasSelectedSession(true);
                }}
              >
                <div className={dp('resume-picker-item-row')}>
                  <span className={dp('resume-picker-item-title')}>
                    {s.displayName || s.sessionId.slice(0, 8)}
                  </span>
                  {isCurrent && (
                    <span className={dp('resume-picker-item-badge')}>
                      {t('resume.current')}
                    </span>
                  )}
                  {!isCurrent && !isReleasable && (
                    <span className={dp('resume-picker-item-badge')}>
                      {t('release.inactiveBadge')}
                    </span>
                  )}
                </div>
                <div className={dp('resume-picker-item-meta')}>
                  <span>
                    {(s.updatedAt || s.createdAt) &&
                      formatRelativeTime(s.updatedAt || s.createdAt || '', t)}
                  </span>
                  <span className={dp('resume-picker-item-detail')}>
                    {t('common.clients', { count: s.clientCount ?? 0 })}
                  </span>
                  {s.hasActivePrompt && (
                    <span className={dp('resume-picker-item-detail')}>
                      {t('resume.activePrompt')}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
      </div>

      <div className={dp('resume-picker-sep')} />
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

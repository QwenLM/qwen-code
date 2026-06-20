import { useCallback, useEffect, useRef, useState } from 'react';
import { dp } from './dialogStyles';
import {
  useConnection,
  useSessions,
  type DaemonSessionSummary,
} from '@qwen-code/webui/daemon-react-sdk';
import { useDelayedGlobalKeyDown } from '../../hooks/useDelayedGlobalKeyDown';
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
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

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

  useDelayedGlobalKeyDown(
    (e: KeyboardEvent) => {
      if (deleting) return;
      if (searchMode) {
        if (e.key === 'Escape') {
          e.preventDefault();
          if (searchQuery) {
            setSearchQuery('');
          } else {
            setSearchMode(false);
          }
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          if (filtered.length > 0) {
            setSearchMode(false);
          }
          return;
        }
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          setSearchMode(false);
          if (e.key === 'ArrowDown') {
            setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1));
          }
        }
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        if (searchQuery) {
          setSearchQuery('');
          setSelectedIdx(0);
        } else {
          onClose();
        }
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1));
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        if (selectedIdx === 0) {
          setSearchMode(true);
        } else {
          setSelectedIdx((i) => Math.max(i - 1, 0));
        }
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        handleRelease();
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        setSearchMode(true);
      }
    },
    [
      deleting,
      filtered.length,
      handleRelease,
      onClose,
      searchMode,
      searchQuery,
      selectedIdx,
    ],
  );

  return (
    // Hover selection is intentionally disabled here: otherwise a stationary
    // mouse can override the row selected by keyboard ↑↓ navigation.
    <div className={dp('resume-picker', 'resume-picker-keyboard-only')}>
      <div className={dp('resume-picker-header')}>
        <span className={dp('resume-picker-title')}>{t('release.title')}</span>
        {searchQuery && (
          <span className={dp('resume-picker-count')}>
            ({filtered.length} matches)
          </span>
        )}
        <button
          className={dp('resume-picker-close')}
          onClick={onClose}
          title={t('common.close')}
        >
          ESC
        </button>
      </div>

      <div className={dp('resume-picker-search')}>
        {searchMode ? (
          <>
            <span className={dp('resume-picker-search-label')}>
              {t('resume.search')}:{' '}
            </span>
            <input
              className={dp('resume-picker-search-input')}
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setSelectedIdx(0);
              }}
              autoFocus
              placeholder=""
            />
          </>
        ) : searchQuery ? (
          <>
            <span className={dp('resume-picker-search-label')}>
              {t('resume.filter')}:{' '}
            </span>
            <span className={dp('resume-picker-search-value')}>
              {searchQuery}
            </span>
          </>
        ) : (
          <span className={dp('resume-picker-search-hint')}>
            {message ||
              (deleting
                ? t('release.releasing')
                : loading
                  ? t('common.loading')
                  : t('release.pressSearch'))}
          </span>
        )}
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
                  i === selectedIdx && !searchMode ? 'selected' : undefined,
                  isDisabled ? 'resume-picker-item-current' : undefined,
                  isDisabled ? 'disabled' : undefined,
                )}
                onClick={() => {
                  setSelectedIdx(i);
                  if (!isDisabled) handleRelease(s);
                }}
              >
                <div className={dp('resume-picker-item-row')}>
                  <span className={dp('resume-picker-item-prefix')}>
                    {i === selectedIdx && !searchMode ? '›' : ' '}
                  </span>
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

      <div className={dp('resume-picker-footer')}>
        {searchMode ? t('dialog.footer.search') : t('release.footer')}
      </div>
    </div>
  );
}

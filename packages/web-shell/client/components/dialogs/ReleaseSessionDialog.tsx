import { useCallback, useEffect, useRef, useState } from 'react';
import { dp } from './dialogStyles';
import { useDelayedGlobalKeyDown } from '../../hooks/useDelayedGlobalKeyDown';
import { useI18n } from '../../i18n';

function formatRelativeTime(iso: string, language: string): string {
  if (language !== 'zh-CN') {
    return new Date(iso).toLocaleString();
  }
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(iso).toLocaleDateString();
}

interface SessionInfo {
  sessionId: string;
  title?: string;
  displayName?: string;
  createdAt?: string;
  updatedAt?: string;
  clientCount?: number;
  hasActivePrompt?: boolean;
}

interface ReleaseSessionDialogProps {
  currentSessionId?: string | null;
  loadSessions: () => Promise<SessionInfo[]>;
  releaseSession: (sessionId: string) => Promise<void>;
  onReleased: (sessionId: string) => void;
  onError: (error: unknown) => void;
  onClose: () => void;
}

export function ReleaseSessionDialog({
  currentSessionId,
  loadSessions,
  releaseSession,
  onReleased,
  onError,
  onClose,
}: ReleaseSessionDialogProps) {
  const { language, t } = useI18n();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadSessions()
      .then((loadedSessions) => {
        setSessions(loadedSessions);
      })
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setLoading(false));
  }, [loadSessions]);

  const filtered = searchQuery
    ? sessions.filter((s) => {
        const q = searchQuery.toLowerCase();
        return (
          (s.displayName || s.title || '').toLowerCase().includes(q) ||
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
    (targetSession?: SessionInfo) => {
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
    <div className={dp('resume-picker')}>
      <div className={dp('resume-picker-header')}>
        <span className={dp('resume-picker-title')}>{t('release.title')}</span>
        {searchQuery && (
          <span className={dp('resume-picker-count')}>
            ({filtered.length} matches)
          </span>
        )}
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
                  i === selectedIdx && !searchMode ? 'selected' : undefined,
                  isDisabled ? 'resume-picker-item-current' : undefined,
                  isDisabled ? 'disabled' : undefined,
                )}
                onClick={() => {
                  setSelectedIdx(i);
                  if (!isDisabled) handleRelease(s);
                }}
                onMouseEnter={() => setSelectedIdx(i)}
              >
                <div className={dp('resume-picker-item-row')}>
                  <span className={dp('resume-picker-item-prefix')}>
                    {i === selectedIdx && !searchMode ? '›' : ' '}
                  </span>
                  <span className={dp('resume-picker-item-title')}>
                    {s.displayName || s.title || s.sessionId.slice(0, 8)}
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
                      formatRelativeTime(
                        s.updatedAt || s.createdAt || '',
                        language,
                      )}
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

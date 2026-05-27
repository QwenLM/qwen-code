import { useState, useEffect, useRef, useCallback } from 'react';
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

interface ResumeDialogProps {
  currentSessionId?: string | null;
  loadSessions: () => Promise<SessionInfo[]>;
  onSelect: (sessionId: string) => void;
  onClose: () => void;
}

export function ResumeDialog({
  currentSessionId,
  loadSessions,
  onSelect,
  onClose,
}: ResumeDialogProps) {
  const { language, t } = useI18n();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadSessions()
      .then((loadedSessions) => {
        setSessions(loadedSessions);
        setLoading(false);
      })
      .catch(() => setLoading(false));
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

  // Keep selection in bounds
  useEffect(() => {
    if (selectedIdx >= filtered.length && filtered.length > 0) {
      setSelectedIdx(filtered.length - 1);
    }
  }, [filtered.length, selectedIdx]);

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.children[selectedIdx] as
      | HTMLElement
      | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  const handleSelect = useCallback(() => {
    const session = filtered[selectedIdx];
    if (session) {
      onSelect(session.sessionId);
      onClose();
    }
  }, [filtered, selectedIdx, onSelect, onClose]);

  useDelayedGlobalKeyDown(
    (e: KeyboardEvent) => {
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
          return;
        }
        // Let the input handle other keys
        return;
      }

      // List mode
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
        handleSelect();
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        setSearchMode(true);
        return;
      }
    },
    [searchMode, searchQuery, filtered, selectedIdx, onClose, handleSelect],
  );

  return (
    <div className={dp('resume-picker')}>
      {/* Header */}
      <div className={dp('resume-picker-header')}>
        <span className={dp('resume-picker-title')}>{t('resume.title')}</span>
        {searchQuery && (
          <span className={dp('resume-picker-count')}>
            ({filtered.length} matches)
          </span>
        )}
      </div>

      {/* Search row */}
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
            {t('resume.pressSearch')}
          </span>
        )}
      </div>

      {/* Separator */}
      <div className={dp('resume-picker-sep')} />

      {/* Session list */}
      <div className={dp('resume-picker-list')} ref={listRef}>
        {loading && (
          <div className={dp('resume-picker-empty')}>{t('common.loading')}</div>
        )}
        {!loading && filtered.length === 0 && (
          <div className={dp('resume-picker-empty')}>
            {searchQuery
              ? t('resume.noMatch', { query: searchQuery })
              : t('resume.none')}
          </div>
        )}
        {!loading &&
          filtered.map((s, i) => {
            const isCurrent = s.sessionId === currentSessionId;
            return (
              <div
                key={s.sessionId}
                className={dp(
                  'resume-picker-item',
                  i === selectedIdx && !searchMode ? 'selected' : undefined,
                  isCurrent ? 'resume-picker-item-current' : undefined,
                )}
                onClick={() => {
                  onSelect(s.sessionId);
                  onClose();
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

      {/* Separator */}
      <div className={dp('resume-picker-sep')} />

      {/* Footer */}
      <div className={dp('resume-picker-footer')}>
        {searchMode
          ? t('dialog.footer.search')
          : t('dialog.footer.navSelectCancel')}
      </div>
    </div>
  );
}

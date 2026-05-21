import { useState, useEffect, useRef, useCallback } from 'react';

function formatRelativeTime(iso: string): string {
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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
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
    };
    const timer = setTimeout(
      () => window.addEventListener('keydown', handler),
      50,
    );
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', handler);
    };
  }, [searchMode, searchQuery, filtered, selectedIdx, onClose, handleSelect]);

  return (
    <div className="resume-picker">
      {/* Header */}
      <div className="resume-picker-header">
        <span className="resume-picker-title">Resume Session</span>
        {searchQuery && (
          <span className="resume-picker-count">
            ({filtered.length} matches)
          </span>
        )}
      </div>

      {/* Search row */}
      <div className="resume-picker-search">
        {searchMode ? (
          <>
            <span className="resume-picker-search-label">Search: </span>
            <input
              className="resume-picker-search-input"
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
            <span className="resume-picker-search-label">Filter: </span>
            <span className="resume-picker-search-value">{searchQuery}</span>
          </>
        ) : (
          <span className="resume-picker-search-hint">Press / to search</span>
        )}
      </div>

      {/* Separator */}
      <div className="resume-picker-sep" />

      {/* Session list */}
      <div className="resume-picker-list" ref={listRef}>
        {loading && <div className="resume-picker-empty">加载中...</div>}
        {!loading && filtered.length === 0 && (
          <div className="resume-picker-empty">
            {searchQuery
              ? `没有匹配 "${searchQuery}" 的会话`
              : '没有可恢复的会话'}
          </div>
        )}
        {!loading &&
          filtered.map((s, i) => {
            const isCurrent = s.sessionId === currentSessionId;
            return (
              <div
                key={s.sessionId}
                className={`resume-picker-item ${i === selectedIdx && !searchMode ? 'selected' : ''} ${isCurrent ? 'resume-picker-item-current' : ''}`}
                onClick={() => {
                  onSelect(s.sessionId);
                  onClose();
                }}
                onMouseEnter={() => setSelectedIdx(i)}
              >
                <div className="resume-picker-item-row">
                  <span className="resume-picker-item-prefix">
                    {i === selectedIdx && !searchMode ? '›' : ' '}
                  </span>
                  <span className="resume-picker-item-title">
                    {s.displayName || s.title || s.sessionId.slice(0, 8)}
                  </span>
                  {isCurrent && (
                    <span className="resume-picker-item-badge">current</span>
                  )}
                </div>
                <div className="resume-picker-item-meta">
                  {(s.updatedAt || s.createdAt) &&
                    formatRelativeTime(s.updatedAt || s.createdAt || '')}
                </div>
              </div>
            );
          })}
      </div>

      {/* Separator */}
      <div className="resume-picker-sep" />

      {/* Footer */}
      <div className="resume-picker-footer">
        {searchMode
          ? 'Type to search · Enter to commit · Esc to clear'
          : '↑↓ to navigate · / to search · Enter to select · Esc to cancel'}
      </div>
    </div>
  );
}

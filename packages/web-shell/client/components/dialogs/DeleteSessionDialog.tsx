import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dp } from './dialogStyles';
import { useConnection, useSessions } from '@qwen-code/webui/daemon-react-sdk';
import { useDelayedGlobalKeyDown } from '../../hooks/useDelayedGlobalKeyDown';
import { useI18n } from '../../i18n';
import { formatRelativeTime } from '../../utils/formatRelativeTime';

interface DeleteSessionDialogProps {
  onDeleted: (sessionIds: string[]) => void;
  onError: (error: unknown) => void;
  onClose: () => void;
}

export function DeleteSessionDialog({
  onDeleted,
  onError,
  onClose,
}: DeleteSessionDialogProps) {
  const { t } = useI18n();
  const connection = useConnection();
  const {
    sessions,
    loading,
    error: sessionsError,
    deleteSession,
    deleteSessions,
  } = useSessions({ autoLoad: true });
  const currentSessionId = connection.sessionId;
  const [deleting, setDeleting] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (sessionsError) setMessage(sessionsError.message);
  }, [sessionsError]);

  const filtered = useMemo(
    () =>
      searchQuery
        ? sessions.filter((s) => {
            const q = searchQuery.toLowerCase();
            return (
              (s.displayName || s.title || '').toLowerCase().includes(q) ||
              s.sessionId.toLowerCase().includes(q)
            );
          })
        : sessions,
    [sessions, searchQuery],
  );

  useEffect(() => {
    if (searchQuery && selectedIds.size > 0) {
      const filteredSet = new Set(filtered.map((s) => s.sessionId));
      setSelectedIds((prev) => {
        const pruned = new Set([...prev].filter((id) => filteredSet.has(id)));
        return pruned.size === prev.size ? prev : pruned;
      });
    }
  }, [searchQuery, filtered, selectedIds.size]);

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

  const toggleSelection = useCallback(
    (sessionId: string) => {
      if (sessionId === currentSessionId) return;
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(sessionId)) {
          next.delete(sessionId);
        } else {
          next.add(sessionId);
        }
        return next;
      });
    },
    [currentSessionId],
  );

  const handleDelete = useCallback(() => {
    if (deleting) return;

    if (selectedIds.size > 0) {
      const filteredSet = new Set(filtered.map((s) => s.sessionId));
      const idsToDelete = Array.from(selectedIds).filter((id) =>
        filteredSet.has(id),
      );
      if (idsToDelete.length === 0) return;
      setDeleting(true);
      deleteSessions(idsToDelete)
        .then((res) => {
          const succeeded = res.removed.length + res.notFound.length;
          const failed = res.errors.length;

          if (failed > 0 && succeeded > 0) {
            onError(
              new Error(
                t('delete.partialFail', {
                  removed: succeeded,
                  failed,
                  detail: res.errors[0].error,
                }),
              ),
            );
            onClose();
            return;
          }

          if (failed > 0) {
            setMessage(
              t('delete.allFailed', {
                count: failed,
                reason: res.errors[0].error,
              }),
            );
            setDeleting(false);
            setSelectedIds(new Set());
            return;
          }

          if (succeeded === 0) {
            setMessage(t('delete.nonRemoved'));
            setDeleting(false);
            setSelectedIds(new Set());
            return;
          }

          onDeleted([...res.removed, ...res.notFound]);
          onClose();
        })
        .catch((error: unknown) => {
          onError(error);
          setDeleting(false);
        });
      return;
    }

    const session = filtered[selectedIdx];
    if (!session) return;
    if (session.sessionId === currentSessionId) {
      setMessage(t('delete.cannotCurrent'));
      return;
    }
    setDeleting(true);
    deleteSession(session.sessionId)
      .then((removed) => {
        if (!removed) {
          setMessage(t('delete.notFound'));
          setDeleting(false);
          return;
        }
        onDeleted([session.sessionId]);
        onClose();
      })
      .catch((error: unknown) => {
        onError(error);
        setDeleting(false);
      });
  }, [
    currentSessionId,
    deleteSession,
    deleteSessions,
    deleting,
    filtered,
    onClose,
    onDeleted,
    onError,
    selectedIdx,
    selectedIds,
    t,
  ]);

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
            setSelectedIdx(0);
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
      if (e.key === ' ') {
        e.preventDefault();
        const session = filtered[selectedIdx];
        if (session) toggleSelection(session.sessionId);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        handleDelete();
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        setSearchMode(true);
      }
    },
    [
      deleting,
      filtered,
      handleDelete,
      onClose,
      searchMode,
      searchQuery,
      selectedIdx,
      toggleSelection,
    ],
  );

  const hasSelection = selectedIds.size > 0;

  return (
    // Hover selection is intentionally disabled here: otherwise a stationary
    // mouse can override the row selected by keyboard ↑↓ navigation.
    <div className={dp('resume-picker', 'resume-picker-keyboard-only')}>
      <div className={dp('resume-picker-header')}>
        <span className={dp('resume-picker-title')}>{t('delete.title')}</span>
        {hasSelection && (
          <span className={dp('resume-picker-count')}>
            ({t('delete.selected', { count: selectedIds.size })})
          </span>
        )}
        {!hasSelection && searchQuery && (
          <span className={dp('resume-picker-count')}>
            ({t('delete.matches', { count: filtered.length })})
          </span>
        )}
        <button
          className={dp('resume-picker-close')}
          onClick={onClose}
          title="Close"
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
                ? t('delete.deleting')
                : loading
                  ? t('common.loading')
                  : t('delete.pressSearch'))}
          </span>
        )}
      </div>

      <div className={dp('resume-picker-sep')} />

      <div className={dp('resume-picker-list')} ref={listRef}>
        {loading && (
          <div className={dp('resume-picker-empty')}>{t('common.loading')}</div>
        )}
        {!loading && sessionsError && (
          <div className={dp('resume-picker-empty')}>
            {sessionsError.message}
          </div>
        )}
        {!loading && !sessionsError && filtered.length === 0 && (
          <div className={dp('resume-picker-empty')}>
            {searchQuery
              ? t('delete.noMatch', { query: searchQuery })
              : t('delete.none')}
          </div>
        )}
        {!loading &&
          filtered.map((s, i) => {
            const isCurrent = s.sessionId === currentSessionId;
            const isChecked = selectedIds.has(s.sessionId);
            const checkbox = isChecked ? '[x] ' : '[ ] ';
            return (
              <div
                key={s.sessionId}
                className={dp(
                  'resume-picker-item',
                  'resume-picker-session-item',
                  i === selectedIdx && !searchMode ? 'selected' : undefined,
                  isCurrent ? 'resume-picker-item-current' : undefined,
                  isCurrent ? 'disabled' : undefined,
                )}
                onClick={() => {
                  setSelectedIdx(i);
                  if (!isCurrent) toggleSelection(s.sessionId);
                }}
              >
                <div className={dp('resume-picker-item-row')}>
                  <span className={dp('resume-picker-item-prefix')}>
                    {i === selectedIdx && !searchMode ? '›' : ' '}
                  </span>
                  <span className={dp('resume-picker-item-checkbox')}>
                    {checkbox}
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
        {searchMode ? t('dialog.footer.search') : t('delete.footer')}
      </div>
    </div>
  );
}

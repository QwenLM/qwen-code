import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dp } from './dialogStyles';
import { useConnection, useSessions } from '@qwen-code/webui/daemon-react-sdk';
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
  const [searchQuery, setSearchQuery] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (sessionsError) setMessage(sessionsError.message);
  }, [sessionsError]);

  const filtered = useMemo(
    () =>
      searchQuery
        ? sessions.filter((s) => {
            const q = searchQuery.toLowerCase();
            return (
              (s.displayName || '').toLowerCase().includes(q) ||
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

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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

  const hasSelection = selectedIds.size > 0;
  const canDelete = !deleting && !loading && hasSelection;

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
            setSelectedIds(new Set());
          }}
          placeholder=""
        />
        <span className={dp('resume-picker-search-hint')}>
          {message ||
            (deleting
              ? t('delete.deleting')
              : loading
                ? t('common.loading')
                : hasSelection
                  ? t('delete.selected', { count: selectedIds.size })
                  : searchQuery
                    ? t('delete.matches', { count: filtered.length })
                    : '')}
        </span>
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
                  isChecked ? 'selected' : undefined,
                  isCurrent ? 'resume-picker-item-current' : undefined,
                  isCurrent ? 'disabled' : undefined,
                )}
                onClick={() => {
                  setSelectedIdx(i);
                  if (!isCurrent) toggleSelection(s.sessionId);
                }}
              >
                <div className={dp('resume-picker-item-row')}>
                  <span className={dp('resume-picker-item-checkbox')}>
                    {checkbox}
                  </span>
                  <span className={dp('resume-picker-item-title')}>
                    {s.displayName || s.sessionId.slice(0, 8)}
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
          onClick={handleDelete}
          disabled={!canDelete}
        >
          {deleting ? t('delete.deleting') : t('delete.action')}
        </button>
      </div>
    </div>
  );
}

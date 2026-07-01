import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dp } from './dialogStyles';
import { useConnection, useSessions } from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { useListboxKeyboard } from '../../hooks/useListboxKeyboard';
import { useFilterInput } from '../../hooks/useFilterInput';
import { SessionRow } from './SessionRow';

interface DeleteSessionDialogProps {
  onDeleted: (sessionIds: string[]) => void;
  onError: (error: unknown) => void;
  onClose: () => void;
}

const LIST_ID = 'delete-session-list';
const optionId = (index: number) => `${LIST_ID}-opt-${index}`;

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
  // `selectedIdx` is the keyboard/hover cursor (roving highlight); `selectedIds`
  // is the multi-select set marked for deletion (shown by the [x] checkbox).
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const { filterValue: filterQuery, inputProps } = useFilterInput(() => {
    setSelectedIdx(0);
    setSelectedIds(new Set());
  });
  const [message, setMessage] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (sessionsError) setMessage(sessionsError.message);
  }, [sessionsError]);

  const filtered = useMemo(
    () =>
      filterQuery
        ? sessions.filter((s) => {
            const q = filterQuery.toLowerCase();
            return (
              (s.displayName || '').toLowerCase().includes(q) ||
              s.sessionId.toLowerCase().includes(q)
            );
          })
        : sessions,
    [sessions, filterQuery],
  );

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

  useEffect(() => {
    if (filterQuery && selectedIds.size > 0) {
      const filteredSet = new Set(filtered.map((s) => s.sessionId));
      setSelectedIds((prev) => {
        const pruned = new Set([...prev].filter((id) => filteredSet.has(id)));
        return pruned.size === prev.size ? prev : pruned;
      });
    }
  }, [filterQuery, filtered, selectedIds.size]);

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

  // Enter toggles the cursor row's checkbox; the actual (destructive) delete
  // still requires pressing the danger button — mirroring the click behaviour.
  const { keyboardMode } = useListboxKeyboard({
    itemCount: filtered.length,
    activeIndex: selectedIdx,
    onActiveIndexChange: setSelectedIdx,
    onConfirm: (index) => {
      const session = filtered[index];
      if (session) toggleSelection(session.sessionId);
    },
  });

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
            filtered.length > 0 ? optionId(selectedIdx) : undefined
          }
          {...inputProps}
          placeholder=""
        />
        <span className={dp('picker-search-hint')}>
          {message ||
            (deleting
              ? t('delete.deleting')
              : loading
                ? t('common.loading')
                : hasSelection
                  ? t('delete.selected', { count: selectedIds.size })
                  : filterQuery
                    ? t('delete.matches', { count: filtered.length })
                    : '')}
        </span>
      </div>

      <div className={dp('picker-sep')} />

      <div
        id={LIST_ID}
        role="listbox"
        aria-multiselectable="true"
        className={dp(
          'picker-list',
          keyboardMode ? 'picker-keyboard-only' : undefined,
        )}
        ref={listRef}
      >
        {loading && (
          <div className={dp('picker-empty')}>{t('common.loading')}</div>
        )}
        {!loading && sessionsError && (
          <div className={dp('picker-empty')}>{sessionsError.message}</div>
        )}
        {!loading && !sessionsError && filtered.length === 0 && (
          <div className={dp('picker-empty')}>
            {filterQuery
              ? t('delete.noMatch', { query: filterQuery })
              : t('delete.none')}
          </div>
        )}
        {!loading &&
          filtered.map((s, i) => {
            const isCurrent = s.sessionId === currentSessionId;
            const isChecked = selectedIds.has(s.sessionId);
            return (
              <SessionRow
                key={s.sessionId}
                session={s}
                optionId={optionId(i)}
                active={i === selectedIdx}
                ariaSelected={isChecked}
                current={isCurrent}
                disabled={isCurrent}
                currentLabel={t('resume.current')}
                leading={
                  <span
                    className={dp(
                      'picker-item-checkbox',
                      isChecked ? 'picker-item-checkbox-checked' : undefined,
                    )}
                  >
                    {isChecked ? '[x] ' : '[ ] '}
                  </span>
                }
                onClick={() => {
                  setSelectedIdx(i);
                  if (!isCurrent) toggleSelection(s.sessionId);
                }}
                onActivate={() => setSelectedIdx(i)}
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
          onClick={handleDelete}
          disabled={!canDelete}
        >
          {deleting ? t('delete.deleting') : t('delete.action')}
        </button>
      </div>
    </div>
  );
}

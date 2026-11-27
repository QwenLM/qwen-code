import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dp } from './dialogStyles';
import { sessionMatchesGitQuery } from '../sidebar/sessionSearch';
import {
  useConnection,
  type DaemonSessionSummary,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { useListboxKeyboard } from '../../hooks/useListboxKeyboard';
import { useFilterInput } from '../../hooks/useFilterInput';
import { SessionRow } from './SessionRow';
import { useScopedSessions } from '../../hooks/useScopedSessions';
import { sessionBlocksDelete } from '../../session-catalog/session-live-work';
import { useDaemonAvailability } from '../../daemon/availability-context.js';
import { isDaemonUnavailableError } from '../../daemon/availability.js';

interface DeleteSessionDialogProps {
  /**
   * `attachedSessionId` is the session this client was attached to when the
   * delete was confirmed. The daemon publishes the terminal `session_closed`
   * frame before it answers the delete request, so by the time this fires the
   * caller can no longer read the attachment off the connection (#12619).
   */
  onDeleted: (
    sessionIds: string[],
    meta?: { attachedSessionId?: string },
  ) => void;
  onError: (error: unknown) => void;
  onClose: () => void;
  workspaceCwd?: string;
}

const LIST_ID = 'delete-session-list';
const optionId = (index: number) => `${LIST_ID}-opt-${index}`;

export function DeleteSessionDialog({
  onDeleted,
  onError,
  onClose,
  workspaceCwd,
}: DeleteSessionDialogProps) {
  const { t } = useI18n();
  const availability = useDaemonAvailability();
  const connection = useConnection();
  const {
    sessions,
    loading,
    error: sessionsError,
    deleteSession,
    deleteSessions,
  } = useScopedSessions(workspaceCwd, {
    autoLoad: true,
    maxAgeMs: 1_000,
  });
  const currentSessionId = connection.sessionId;
  const outageMessage =
    availability !== 'available'
      ? t(
          availability === 'auth-required'
            ? 'daemon.connection.authRequired'
            : 'daemon.connection.unavailable',
        )
      : undefined;
  const sessionErrorMessage = outageMessage ?? sessionsError?.message;
  const [deleting, setDeleting] = useState(false);
  // `selectedIdx` is the keyboard/hover cursor (roving highlight, -1 = none —
  // see ResumeDialog for the rationale); `selectedIds` is the multi-select set
  // marked for deletion (shown by the [x] checkbox).
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const { filterValue: filterQuery, inputProps } = useFilterInput(() => {
    setSelectedIdx(-1);
    setSelectedIds(new Set());
  });
  // One owner per slot: `message` mirrors the load error, `outcome` holds what
  // a delete reported. Sharing them let error recovery wipe a delete failure.
  const [message, setMessage] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  // An id, not rendered text and not a remembered reason: the refusal is about
  // a row's live state, so it has to expire with that state, and the reason has
  // to be re-read from the row instead of frozen at click time.
  const [refusalId, setRefusalId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Mirror the load error rather than latch it: the list refetches every
  // second, so one failed poll must not mute the hint for the dialog's life.
  useEffect(() => {
    setMessage(sessionsError ? sessionsError.message : null);
  }, [sessionsError]);

  const filtered = useMemo(
    () =>
      sessions.filter((session) => {
        if (session.sourceType === 'qwen-live') return false;
        const q = filterQuery.toLowerCase();
        return (
          !q ||
          (session.displayName || '').toLowerCase().includes(q) ||
          session.sessionId.toLowerCase().includes(q) ||
          sessionMatchesGitQuery(session, q)
        );
      }),
    [sessions, filterQuery],
  );

  // The current session is deletable (issue #12619), but deleting the session
  // the client is attached to tears its runtime down, so it is only offered
  // once nothing is running. Background work blocks any row, attached or not:
  // the delete route has no idle guard, so confirming would kill work the
  // sidebar row advertises and already refuses to delete.
  const blocksDelete = useCallback(
    (session: DaemonSessionSummary) =>
      sessionBlocksDelete(session, session.sessionId === currentSessionId),
    [currentSessionId],
  );

  const toggleSelection = useCallback(
    (session: DaemonSessionSummary) => {
      if (blocksDelete(session)) {
        // The danger button is disabled in this state, so this click is the
        // only place the user can be told why the row will not tick. Arming is
        // skipped while a delete runs or a load error holds the hint, so the
        // refusal cannot resurface once they clear; a delete outcome outranks
        // it in the hint and is only cleared by the next confirm, which drops
        // the refusal too.
        if (!deleting && !message) setRefusalId(session.sessionId);
        return;
      }
      // A refusal is not an error: clearing it leaves any load or delete error
      // sharing the hint untouched.
      setRefusalId(null);
      const sessionId = session.sessionId;
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
    [blocksDelete, deleting, message],
  );

  useEffect(() => {
    if (selectedIds.size === 0) return;
    // Drop rows that filtered out AND rows that turned busy since they were
    // ticked. A blocked row cannot be unchecked by hand, so leaving it in the
    // set would show a checked, counted row that the request silently omits.
    const keep = new Set(
      filtered.filter((s) => !blocksDelete(s)).map((s) => s.sessionId),
    );
    setSelectedIds((prev) => {
      const pruned = new Set([...prev].filter((id) => keep.has(id)));
      return pruned.size === prev.size ? prev : pruned;
    });
  }, [blocksDelete, filtered, selectedIds.size]);

  // Expire the refusal with the condition that produced it: once the row
  // leaves the list or stops being blocked, the hint must stop asserting it
  // and let the selection count through again.
  useEffect(() => {
    if (!refusalId) return;
    const row = filtered.find((s) => s.sessionId === refusalId);
    if (!row || !blocksDelete(row)) setRefusalId(null);
  }, [blocksDelete, filtered, refusalId]);

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
      if (session) toggleSelection(session);
    },
  });

  // Re-evaluated at confirm time, not only on click: a row ticked while idle
  // can start background work afterwards, and `toggleSelection` refuses to
  // uncheck a blocked row, so the checked set alone cannot be trusted.
  const deletableSelectedIds = useMemo(
    () =>
      filtered
        .filter((s) => selectedIds.has(s.sessionId) && !blocksDelete(s))
        .map((s) => s.sessionId),
    [blocksDelete, filtered, selectedIds],
  );

  const handleDelete = useCallback(() => {
    if (deleting) return;
    // Confirming supersedes both: the hint now belongs to this delete's
    // progress and outcome, not an older row's rule or an earlier result.
    setRefusalId(null);
    setOutcome(null);
    // Captured before the request: the daemon's terminal `session_closed`
    // frame clears `connection.sessionId` before the delete resolves, so this
    // is the last point where the attachment is still readable (#12619).
    const attachedSessionId = currentSessionId;

    if (selectedIds.size > 0) {
      const idsToDelete = deletableSelectedIds;
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
            setOutcome(
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
            setOutcome(t('delete.nonRemoved'));
            setDeleting(false);
            setSelectedIds(new Set());
            return;
          }

          onDeleted([...res.removed, ...res.notFound], { attachedSessionId });
          onClose();
        })
        .catch((error: unknown) => {
          onError(
            isDaemonUnavailableError(error)
              ? new Error(outageMessage ?? t('daemon.connection.unavailable'))
              : error,
          );
          setDeleting(false);
        });
      return;
    }

    const session = filtered[selectedIdx];
    if (!session) return;
    // Unreachable from the button, which is disabled with an empty selection;
    // kept as a guard. The reason is reported by toggleSelection instead.
    if (blocksDelete(session)) return;
    setDeleting(true);
    deleteSession(session.sessionId)
      .then((removed) => {
        if (!removed) {
          setOutcome(t('delete.notFound'));
          setDeleting(false);
          return;
        }
        onDeleted([session.sessionId], { attachedSessionId });
        onClose();
      })
      .catch((error: unknown) => {
        onError(
          isDaemonUnavailableError(error)
            ? new Error(outageMessage ?? t('daemon.connection.unavailable'))
            : error,
        );
        setDeleting(false);
      });
  }, [
    blocksDelete,
    currentSessionId,
    deletableSelectedIds,
    deleteSession,
    deleteSessions,
    deleting,
    filtered,
    onClose,
    onDeleted,
    onError,
    outageMessage,
    selectedIdx,
    selectedIds,
    t,
  ]);

  const refusedRow = refusalId
    ? filtered.find((s) => s.sessionId === refusalId)
    : undefined;
  // Re-checked here as well as in the expiry effect: that effect runs after
  // paint, so without this the hint could assert a rule the row no longer meets.
  const refusalText =
    refusedRow && blocksDelete(refusedRow)
      ? refusedRow.detachedBackgroundWork === 'running'
        ? t('delete.detachedRunningDisabled')
        : refusedRow.sessionId === currentSessionId
          ? t('delete.cannotCurrent')
          : t('sidebar.deleteRunningDisabled')
      : null;
  const advisoryText = filtered.some(
    (s) =>
      s.detachedBackgroundWork === 'unknown' &&
      selectedIds.has(s.sessionId) &&
      !blocksDelete(s),
  )
    ? t('delete.mayStillBeRunning')
    : null;
  const hasSelection = selectedIds.size > 0;
  const canDelete = !deleting && !loading && deletableSelectedIds.length > 0;

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
            selectedIdx >= 0 && selectedIdx < filtered.length
              ? optionId(selectedIdx)
              : undefined
          }
          {...inputProps}
          placeholder=""
        />
        <span className={dp('picker-search-hint')}>
          {outageMessage ||
            outcome ||
            message ||
            refusalText ||
            (deleting && t('delete.deleting')) ||
            advisoryText ||
            (loading
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
        {loading && !outageMessage && (
          <div className={dp('picker-empty')}>{t('common.loading')}</div>
        )}
        {(outageMessage || (!loading && sessionErrorMessage)) && (
          <div className={dp('picker-empty')}>{sessionErrorMessage}</div>
        )}
        {!loading && !sessionErrorMessage && filtered.length === 0 && (
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
            const deleteBlocked = blocksDelete(s);
            return (
              <SessionRow
                key={s.sessionId}
                session={s}
                optionId={optionId(i)}
                active={i === selectedIdx}
                ariaSelected={isChecked}
                current={false}
                disabled={deleteBlocked}
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
                trailing={
                  isCurrent ? (
                    <span className={dp('picker-item-badge')}>
                      {t('resume.current')}
                    </span>
                  ) : undefined
                }
                onClick={() => {
                  setSelectedIdx(i);
                  toggleSelection(s);
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

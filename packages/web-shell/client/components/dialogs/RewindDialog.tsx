import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  DaemonRewindSnapshotInfo,
  DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import { findDaemonRewindUserBlock } from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import { useListboxKeyboard } from '../../hooks/useListboxKeyboard';
import { dp } from './dialogStyles';
import styles from './RewindDialog.module.css';

const LIST_ID = 'rewind-snapshot-list';
const optionId = (index: number) => `${LIST_ID}-opt-${index}`;

interface RewindDialogProps {
  blocks: readonly DaemonTranscriptBlock[];
  loadSnapshots: () => Promise<{ snapshots: DaemonRewindSnapshotInfo[] }>;
  rewind: (promptId: string) => Promise<void>;
  onError: (error: unknown) => void;
  onClose: () => void;
}

function formatSnapshotTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return timestamp;
  return date.toLocaleString();
}

export function RewindDialog({
  blocks,
  loadSnapshots,
  rewind,
  onError,
  onClose,
}: RewindDialogProps) {
  const { t } = useI18n();
  const [snapshots, setSnapshots] = useState<DaemonRewindSnapshotInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [rewindingPromptId, setRewindingPromptId] = useState<string | null>(
    null,
  );
  // `cursorIdx` is the roving keyboard/hover highlight; `selectedPromptId` is
  // the confirmed target the danger button acts on. They are separate so moving
  // the highlight with the arrow keys does not change what will be rewound until
  // the user commits with Enter or a click.
  const [cursorIdx, setCursorIdx] = useState(0);
  const [selectedPromptId, setSelectedPromptId] = useState<string | null>(null);
  // Inline failure text. The app-level onError toast deduplicates repeats, so
  // a second identical failure would otherwise be invisible in this dialog.
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    loadSnapshots()
      .then((result) => {
        if (alive) setSnapshots(result.snapshots);
      })
      .catch((error: unknown) => {
        if (alive) onError(error);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [loadSnapshots, onError]);

  const items = useMemo(() => {
    // Count identities once so duplicate detection is a lookup instead of a
    // nested filter.
    const identityCounts = new Map<string, number>();
    for (const snapshot of snapshots) {
      const identity = snapshot.daemonPromptId;
      if (identity !== undefined) {
        identityCounts.set(identity, (identityCounts.get(identity) ?? 0) + 1);
      }
    }
    return snapshots
      .map((snapshot) => {
        const identity = snapshot.daemonPromptId;
        // A duplicated identity cannot be resolved to one turn, so both rows
        // refuse rather than pointing at the same checkpoint twice.
        const usable =
          identity !== undefined && identityCounts.get(identity) === 1;
        const block = usable
          ? findDaemonRewindUserBlock(blocks, identity)
          : undefined;
        return {
          snapshot,
          promptText: block?.text.trim() ?? '',
          // The rewind itself carries only the prompt identity, so a turn
          // outside the loaded transcript window stays targetable: the block
          // lookup above supplies the preview text, not the permission. Only a
          // snapshot with no usable identity is unavailable, and it says why.
          available: usable,
        };
      })
      .sort((a, b) => a.snapshot.turnIndex - b.snapshot.turnIndex);
  }, [blocks, snapshots]);

  // Keep the cursor in range as snapshots load / change.
  useEffect(() => {
    if (cursorIdx >= items.length && items.length > 0) {
      setCursorIdx(items.length - 1);
    }
  }, [items.length, cursorIdx]);

  const listRef = useRef<HTMLDivElement>(null);
  const isRewinding = rewindingPromptId !== null;

  const handleRewind = (promptId: string | null) => {
    if (!promptId || rewindingPromptId) return;
    setRewindingPromptId(promptId);
    setMessage(null);
    rewind(promptId)
      .then(() => {
        onClose();
      })
      .catch((error: unknown) => {
        onError(error);
        setMessage(
          t('rewind.failed', {
            reason: error instanceof Error ? error.message : String(error),
          }),
        );
        setRewindingPromptId(null);
      });
  };

  // Arrows move the cursor (highlight) only; Enter/click commits the cursor row
  // as the confirmed target. The irreversible rewind stays behind the danger
  // button, consistent with the other destructive dialogs (delete / release).
  const commitRow = (index: number) => {
    const item = items[index];
    if (item?.available) {
      setCursorIdx(index);
      setSelectedPromptId(item.snapshot.promptId);
    }
  };
  const { keyboardMode } = useListboxKeyboard({
    itemCount: items.length,
    activeIndex: cursorIdx,
    onActiveIndexChange: setCursorIdx,
    onConfirm: commitRow,
    enabled: !isRewinding,
  });

  useEffect(() => {
    const el = listRef.current?.children[cursorIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursorIdx]);

  // Snapshots load asynchronously: while loading, nothing in this dialog is
  // focusable, so DialogShell parks focus on the dialog panel. Once the listbox
  // mounts, pull focus into it — but only if focus is still parked on the panel
  // — so screen readers announce the active option via aria-activedescendant
  // instead of staying silent until the user tabs into the list.
  useEffect(() => {
    if (loading || items.length === 0) return;
    const active = document.activeElement;
    if (active?.getAttribute('role') === 'dialog') {
      listRef.current?.focus();
    }
  }, [loading, items.length]);

  if (loading) {
    return <div className={dp('picker-empty')}>{t('rewind.loading')}</div>;
  }

  if (items.length === 0) {
    return <div className={dp('picker-empty')}>{t('rewind.empty')}</div>;
  }

  return (
    <div className={styles.root}>
      <div
        className={`${styles.list} ${keyboardMode ? styles.keyboardOnly : ''}`}
        ref={listRef}
        role="listbox"
        aria-label={t('rewind.title')}
        tabIndex={0}
        aria-activedescendant={
          items.length > 0 ? optionId(cursorIdx) : undefined
        }
      >
        {items.map(({ snapshot, promptText, available }, index) => {
          const isCursor = index === cursorIdx;
          const isSelected = selectedPromptId === snapshot.promptId;
          const label =
            promptText ||
            (snapshot.daemonPromptId
              ? t('rewind.promptFallback', {
                  id: snapshot.promptId.slice(-8),
                })
              : t('rewind.identityUnavailable'));
          return (
            <div
              key={snapshot.promptId}
              id={optionId(index)}
              role="option"
              aria-selected={isSelected}
              aria-disabled={isRewinding || !available || undefined}
              className={`${styles.item} ${isCursor ? styles.itemCursor : ''} ${
                isSelected ? styles.itemSelected : ''
              } ${isRewinding || !available ? styles.itemDisabled : ''}`}
              onClick={() => {
                if (!isRewinding) commitRow(index);
              }}
              onMouseMove={() => setCursorIdx(index)}
            >
              <div className={styles.prompt} title={label}>
                <span className={styles.turn}>#{snapshot.turnIndex + 1}</span>{' '}
                {label}
              </div>
              <div className={styles.time}>
                {formatSnapshotTime(snapshot.timestamp)}
              </div>
            </div>
          );
        })}
      </div>
      <div className={styles.footer}>
        {message && (
          <span className={styles.footerMessage} role="alert">
            {message}
          </span>
        )}
        <button
          type="button"
          className={dp('dialog-inline-button')}
          onClick={onClose}
          disabled={rewindingPromptId !== null}
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className={`${dp('dialog-danger-button')} ${styles.dangerButton}`}
          onClick={() => handleRewind(selectedPromptId)}
          disabled={
            !items.some(
              (item) =>
                item.snapshot.promptId === selectedPromptId && item.available,
            ) || rewindingPromptId !== null
          }
        >
          {rewindingPromptId ? t('rewind.rewinding') : t('rewind.confirm')}
        </button>
      </div>
    </div>
  );
}

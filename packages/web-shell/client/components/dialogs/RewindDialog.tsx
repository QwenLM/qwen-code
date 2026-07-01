import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  DaemonRewindSnapshotInfo,
  DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';
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

function promptTextForTurn(
  blocks: readonly DaemonTranscriptBlock[],
  turnIndex: number,
): string {
  let userIndex = 0;
  for (const block of blocks) {
    if (block.kind !== 'user') continue;
    if (userIndex === turnIndex) return block.text.trim();
    userIndex += 1;
  }
  return '';
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
  const [selectedPromptId, setSelectedPromptId] = useState<string | null>(null);

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

  const items = useMemo(
    () =>
      snapshots
        .map((snapshot) => ({
          snapshot,
          promptText: promptTextForTurn(blocks, snapshot.turnIndex),
        }))
        .sort((a, b) => a.snapshot.turnIndex - b.snapshot.turnIndex),
    [blocks, snapshots],
  );

  useEffect(() => {
    if (items.length > 0 && !selectedPromptId) {
      setSelectedPromptId(items[0]!.snapshot.promptId);
    }
  }, [items, selectedPromptId]);

  const selectedIdx = items.findIndex(
    ({ snapshot }) => snapshot.promptId === selectedPromptId,
  );
  const listRef = useRef<HTMLDivElement>(null);
  const isRewinding = rewindingPromptId !== null;

  const handleRewind = (promptId: string | null) => {
    if (!promptId || rewindingPromptId) return;
    setRewindingPromptId(promptId);
    rewind(promptId)
      .then(() => {
        onClose();
      })
      .catch((error: unknown) => {
        onError(error);
        setRewindingPromptId(null);
      });
  };

  // Arrows move the highlight; Enter confirms it (this is a single-select
  // picker, so Enter runs the rewind for the highlighted snapshot).
  const { keyboardMode } = useListboxKeyboard({
    itemCount: items.length,
    activeIndex: selectedIdx < 0 ? 0 : selectedIdx,
    onActiveIndexChange: (index) => {
      const item = items[index];
      if (item) setSelectedPromptId(item.snapshot.promptId);
    },
    onConfirm: (index) => handleRewind(items[index]?.snapshot.promptId ?? null),
    enabled: !isRewinding,
  });

  useEffect(() => {
    const el = listRef.current?.children[selectedIdx] as
      | HTMLElement
      | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

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
        tabIndex={0}
        aria-activedescendant={
          items.length > 0 && selectedIdx >= 0
            ? optionId(selectedIdx)
            : undefined
        }
      >
        {items.map(({ snapshot, promptText }, index) => {
          const selected = selectedPromptId === snapshot.promptId;
          const label =
            promptText ||
            t('rewind.promptFallback', {
              id: snapshot.promptId.slice(-8),
            });
          return (
            <div
              key={snapshot.promptId}
              id={optionId(index)}
              role="option"
              aria-selected={selected}
              aria-disabled={isRewinding || undefined}
              className={`${styles.item} ${
                selected ? styles.itemSelected : ''
              } ${isRewinding ? styles.itemDisabled : ''}`}
              onClick={() => {
                if (!isRewinding) setSelectedPromptId(snapshot.promptId);
              }}
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
          disabled={!selectedPromptId || rewindingPromptId !== null}
        >
          {rewindingPromptId ? t('rewind.rewinding') : t('rewind.confirm')}
        </button>
      </div>
    </div>
  );
}

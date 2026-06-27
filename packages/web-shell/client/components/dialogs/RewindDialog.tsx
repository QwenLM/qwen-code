import { useEffect, useMemo, useState } from 'react';
import type {
  DaemonRewindSnapshotInfo,
  DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import { dp } from './dialogStyles';
import styles from './RewindDialog.module.css';

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

  const handleRewind = () => {
    const promptId = selectedPromptId;
    if (!promptId) return;
    if (rewindingPromptId) return;
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

  if (loading) {
    return (
      <div className={dp('resume-picker-empty')}>{t('rewind.loading')}</div>
    );
  }

  if (items.length === 0) {
    return <div className={dp('resume-picker-empty')}>{t('rewind.empty')}</div>;
  }

  return (
    <div className={styles.root}>
      <div className={styles.list} role="list">
        {items.map(({ snapshot, promptText }) => {
          const selected = selectedPromptId === snapshot.promptId;
          const disabled = rewindingPromptId !== null;
          const label =
            promptText ||
            t('rewind.promptFallback', {
              id: snapshot.promptId.slice(-8),
            });
          return (
            <button
              key={snapshot.promptId}
              type="button"
              className={`${styles.item} ${
                selected ? styles.itemSelected : ''
              }`}
              disabled={disabled}
              onClick={() => setSelectedPromptId(snapshot.promptId)}
            >
              <div className={styles.prompt} title={label}>
                <span className={styles.turn}>#{snapshot.turnIndex + 1}</span>{' '}
                {label}
              </div>
              <div className={styles.time}>
                {formatSnapshotTime(snapshot.timestamp)}
              </div>
            </button>
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
          onClick={handleRewind}
          disabled={!selectedPromptId || rewindingPromptId !== null}
        >
          {rewindingPromptId ? t('rewind.rewinding') : t('rewind.confirm')}
        </button>
      </div>
    </div>
  );
}

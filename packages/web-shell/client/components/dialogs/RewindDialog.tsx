import { useCallback, useEffect, useRef, useState } from 'react';
import type { DaemonRewindSnapshotInfo } from '@qwen-code/webui/daemon-react-sdk';
import { dp } from './dialogStyles';
import { useDelayedGlobalKeyDown } from '../../hooks/useDelayedGlobalKeyDown';
import { useI18n } from '../../i18n';

export interface RewindTarget extends DaemonRewindSnapshotInfo {
  text: string;
}

export type RewindRestoreOption = 'both' | 'conversation';

type RestoreChoice =
  | { key: RewindRestoreOption; label: string; detail?: string }
  | { key: 'cancel'; label: string; detail?: string };

interface RewindDialogProps {
  targets: readonly RewindTarget[];
  loading: boolean;
  error?: string;
  onRewind: (
    target: RewindTarget,
    option: RewindRestoreOption,
  ) => Promise<void>;
  onClose: () => void;
}

function previewText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '(empty)';
  return normalized.length > 120
    ? `${normalized.slice(0, 120)}...`
    : normalized;
}

function getRestoreOptions(
  target: RewindTarget,
  t: ReturnType<typeof useI18n>['t'],
): RestoreChoice[] {
  const hasChanges = target.diffStats.filesChanged > 0;
  const options: RestoreChoice[] = [];
  if (hasChanges) {
    options.push({
      key: 'both',
      label: t('rewind.option.both'),
      detail: t('rewind.option.fileDetail', {
        files: target.diffStats.filesChanged,
        insertions: target.diffStats.insertions,
        deletions: target.diffStats.deletions,
      }),
    });
  }
  options.push({ key: 'conversation', label: t('rewind.option.conversation') });
  options.push({ key: 'cancel', label: t('rewind.option.cancel') });
  return options;
}

export function RewindDialog({
  targets,
  loading,
  error,
  onRewind,
  onClose,
}: RewindDialogProps) {
  const { t } = useI18n();
  const [selectedIdx, setSelectedIdx] = useState(() =>
    Math.max(0, targets.length - 1),
  );
  const [confirmTarget, setConfirmTarget] = useState<RewindTarget | null>(null);
  const [restoreOptionIdx, setRestoreOptionIdx] = useState(0);
  const [restoring, setRestoring] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const restoreOptions = confirmTarget
    ? getRestoreOptions(confirmTarget, t)
    : [];
  const canRestoreFiles = restoreOptions.some(
    (option) => option.key === 'both',
  );

  useEffect(() => {
    setSelectedIdx(Math.max(0, targets.length - 1));
  }, [targets.length]);

  useEffect(() => {
    const el = listRef.current?.children[selectedIdx] as
      | HTMLElement
      | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  const handleConfirm = useCallback(() => {
    if (!confirmTarget || restoring) return;
    const options = getRestoreOptions(confirmTarget, t);
    const option = options[restoreOptionIdx];
    if (!option) return;
    if (option.key === 'cancel') {
      setConfirmTarget(null);
      setRestoreOptionIdx(0);
      return;
    }
    setRestoring(true);
    onRewind(confirmTarget, option.key)
      .then(onClose)
      .catch(() => {
        setRestoring(false);
      });
  }, [confirmTarget, onClose, onRewind, restoreOptionIdx, restoring, t]);

  useDelayedGlobalKeyDown(
    (e: KeyboardEvent) => {
      if (restoring) return;

      if (confirmTarget) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setConfirmTarget(null);
          setRestoreOptionIdx(0);
          return;
        }
        const options = getRestoreOptions(confirmTarget, t);
        if (e.key === 'ArrowDown' || e.key === 'j') {
          e.preventDefault();
          setRestoreOptionIdx((idx) => Math.min(idx + 1, options.length - 1));
          return;
        }
        if (e.key === 'ArrowUp' || e.key === 'k') {
          e.preventDefault();
          setRestoreOptionIdx((idx) => Math.max(idx - 1, 0));
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          handleConfirm();
          return;
        }
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (loading || error || targets.length === 0) return;
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        setSelectedIdx((idx) => Math.min(idx + 1, targets.length - 1));
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        setSelectedIdx((idx) => Math.max(idx - 1, 0));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const target = targets[selectedIdx];
        if (target) {
          setConfirmTarget(target);
          setRestoreOptionIdx(0);
        }
      }
    },
    [
      confirmTarget,
      error,
      handleConfirm,
      loading,
      onClose,
      restoring,
      selectedIdx,
      targets,
      t,
    ],
  );

  return (
    <div
      className={dp(
        'resume-picker',
        confirmTarget ? 'resume-picker-compact' : undefined,
        'resume-picker-keyboard-only',
      )}
    >
      <div className={dp('resume-picker-header')}>
        <span className={dp('resume-picker-title')}>
          {confirmTarget
            ? t('rewind.title')
            : t('rewind.titleWithCount', { count: targets.length })}
        </span>
        <button
          className={dp('resume-picker-close')}
          onClick={onClose}
          title="Close"
        >
          ESC
        </button>
      </div>

      <div className={dp('resume-picker-sep')} />

      {confirmTarget ? (
        <div className={dp('resume-picker-list', 'resume-picker-list-compact')}>
          <div className={dp('resume-picker-target')}>
            <span className={dp('resume-picker-target-label')}>
              {t('rewind.to')}
            </span>{' '}
            <span className={dp('resume-picker-target-text')}>
              {previewText(confirmTarget.text)}
            </span>
          </div>
          {restoreOptions.map((option, idx) => (
            <div
              key={option.key}
              className={dp(
                'resume-picker-item',
                idx === restoreOptionIdx ? 'selected' : undefined,
              )}
              onClick={() => {
                setRestoreOptionIdx(idx);
                if (option.key === 'cancel') {
                  setConfirmTarget(null);
                  setRestoreOptionIdx(0);
                  return;
                }
                setRestoring(true);
                onRewind(confirmTarget, option.key)
                  .then(onClose)
                  .catch(() => setRestoring(false));
              }}
            >
              <div className={dp('resume-picker-item-row')}>
                <span className={dp('resume-picker-item-prefix')}>
                  {idx === restoreOptionIdx ? '›' : ' '}
                </span>
                <span className={dp('resume-picker-item-title')}>
                  {option.label}
                </span>
                {option.detail && (
                  <span className={dp('resume-picker-item-detail')}>
                    {option.detail}
                  </span>
                )}
              </div>
            </div>
          ))}
          {!restoring && !canRestoreFiles && (
            <div className={dp('resume-picker-description')}>
              {t('rewind.filesUnavailable')}
            </div>
          )}
          {!restoring && canRestoreFiles && (
            <div className={dp('resume-picker-description')}>
              {t('rewind.filesNote')}
            </div>
          )}
          {restoring && (
            <div className={dp('resume-picker-description')}>
              {t('rewind.restoring')}
            </div>
          )}
        </div>
      ) : (
        <div className={dp('resume-picker-list')} ref={listRef}>
          {loading && (
            <div className={dp('resume-picker-empty')}>
              {t('common.loading')}
            </div>
          )}
          {!loading && error && (
            <div className={dp('resume-picker-empty')}>{error}</div>
          )}
          {!loading && !error && targets.length === 0 && (
            <div className={dp('resume-picker-empty')}>{t('rewind.none')}</div>
          )}
          {!loading &&
            !error &&
            targets.map((target, idx) => {
              return (
                <div
                  key={target.promptId ?? target.turnIndex}
                  className={dp(
                    'resume-picker-item',
                    idx === selectedIdx ? 'selected' : undefined,
                  )}
                  onClick={() => {
                    setConfirmTarget(target);
                    setRestoreOptionIdx(0);
                  }}
                >
                  <div className={dp('resume-picker-item-row')}>
                    <span className={dp('resume-picker-item-prefix')}>
                      {idx === selectedIdx ? '›' : ' '}
                    </span>
                    <span className={dp('resume-picker-item-title')}>
                      #{idx + 1} {previewText(target.text)}
                    </span>
                  </div>
                </div>
              );
            })}
        </div>
      )}

      <div className={dp('resume-picker-sep')} />
      <div className={dp('resume-picker-footer')}>
        {confirmTarget
          ? t('dialog.footer.navSelectBack')
          : t('dialog.footer.navSelectCancel')}
      </div>
    </div>
  );
}

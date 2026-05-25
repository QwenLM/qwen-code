import { useState, useEffect, useRef, useCallback } from 'react';
import { dp } from './dialogStyles';
import { DAEMON_APPROVAL_MODES } from '@qwen-code/sdk/daemon';
import { useDelayedGlobalKeyDown } from '../../hooks/useDelayedGlobalKeyDown';
import { useI18n } from '../../i18n';

interface ApprovalModeDialogProps {
  currentMode: string;
  onSelect: (modeId: string) => void;
  onClose: () => void;
}

export function ApprovalModeDialog({
  currentMode,
  onSelect,
  onClose,
}: ApprovalModeDialogProps) {
  const { t } = useI18n();
  const approvalModes = DAEMON_APPROVAL_MODES.map((id) => ({
    id,
    label: t(`mode.${id}`),
    description: t(`mode.${id}.desc`),
  }));
  const [selectedIdx, setSelectedIdx] = useState(() => {
    const idx = approvalModes.findIndex((m) => m.id === currentMode);
    return idx >= 0 ? idx : 0;
  });
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current?.children[selectedIdx] as
      | HTMLElement
      | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  const handleSelect = useCallback(() => {
    const mode = approvalModes[selectedIdx];
    if (mode) {
      onSelect(mode.id);
      onClose();
    }
  }, [approvalModes, selectedIdx, onSelect, onClose]);

  useDelayedGlobalKeyDown(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, approvalModes.length - 1));
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSelect();
        return;
      }
    },
    [approvalModes.length, selectedIdx, onClose, handleSelect],
  );

  return (
    <div className={dp('resume-picker')}>
      <div className={dp('resume-picker-header')}>
        <span className={dp('resume-picker-title')}>
          {t('local.approvalMode')}
        </span>
        <span className={dp('resume-picker-count')}>
          {t('common.current')}:{' '}
          {approvalModes.find((m) => m.id === currentMode)?.label ||
            currentMode}
        </span>
      </div>

      <div className={dp('resume-picker-sep')} />

      <div className={dp('resume-picker-list')} ref={listRef}>
        {approvalModes.map((m, i) => (
          <div
            key={m.id}
            className={dp(
              'resume-picker-item',
              i === selectedIdx ? 'selected' : undefined,
            )}
            onClick={() => {
              onSelect(m.id);
              onClose();
            }}
            onMouseEnter={() => setSelectedIdx(i)}
          >
            <div className={dp('resume-picker-item-row')}>
              <span className={dp('resume-picker-item-prefix')}>
                {i === selectedIdx ? '›' : ' '}
              </span>
              <span className={dp('resume-picker-item-title')}>{m.label}</span>
              {m.id === currentMode && (
                <span className={dp('resume-picker-item-check')}> ✓</span>
              )}
            </div>
            <div className={dp('resume-picker-item-meta')}>{m.description}</div>
          </div>
        ))}
      </div>

      <div className={dp('resume-picker-sep')} />

      <div className={dp('resume-picker-footer')}>
        {t('dialog.footer.navSelectCancel')}
      </div>
    </div>
  );
}

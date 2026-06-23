import { useEffect, useRef } from 'react';
import { DAEMON_APPROVAL_MODES } from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { ModeIcon } from '../ModeIcon';
import styles from './ApprovalModeDialog.module.css';

interface ApprovalModeDialogProps {
  currentMode: string;
  onSelect: (modeId: string) => void;
}

interface ModeItem {
  id: string;
  name: string;
  description: string;
}

export function ApprovalModeDialog({
  currentMode,
  onSelect,
}: ApprovalModeDialogProps) {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);
  const approvalModes: ModeItem[] = DAEMON_APPROVAL_MODES.map((id) => ({
    id,
    name: t(`mode.label.${id}`),
    description: t(`mode.desc.${id}`),
  }));

  const selectedIdx = approvalModes.findIndex((m) => m.id === currentMode);

  useEffect(() => {
    const el = listRef.current?.children[selectedIdx] as
      | HTMLElement
      | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  return (
    <div
      className={styles.list}
      ref={listRef}
      role="listbox"
      aria-label={t('mode.select')}
    >
      {approvalModes.map((mode) => {
        const selected = mode.id === currentMode;
        return (
          <button
            key={mode.id}
            type="button"
            role="option"
            aria-selected={selected}
            className={`${styles.row} ${selected ? styles.selected : ''}`}
            onClick={() => onSelect(mode.id)}
          >
            <span className={styles.modeIcon}>
              <ModeIcon mode={mode.id} />
            </span>
            <span className={styles.modeText}>
              <span className={styles.modeName}>{mode.name}</span>
              <span className={styles.modeDesc}>{mode.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

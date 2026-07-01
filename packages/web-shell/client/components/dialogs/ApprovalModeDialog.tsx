import { useEffect, useRef, useState } from 'react';
import { DAEMON_APPROVAL_MODES } from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { useListboxKeyboard } from '../../hooks/useListboxKeyboard';
import { dp } from './dialogStyles';
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
    name: t(`mode.listLabel.${id}`),
    description: t(`mode.desc.${id}`),
  }));

  const currentIdx = approvalModes.findIndex((m) => m.id === currentMode);
  const [activeIndex, setActiveIndex] = useState(
    currentIdx >= 0 ? currentIdx : 0,
  );

  const confirm = (index: number) => {
    const mode = approvalModes[index];
    if (mode) onSelect(mode.id);
  };

  const { keyboardMode } = useListboxKeyboard({
    itemCount: approvalModes.length,
    activeIndex,
    onActiveIndexChange: setActiveIndex,
    onConfirm: confirm,
  });

  useEffect(() => {
    const el = listRef.current?.children[activeIndex] as
      | HTMLElement
      | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <div
      className={`${styles.list} ${keyboardMode ? styles.keyboardOnly : ''}`}
      ref={listRef}
      role="listbox"
      tabIndex={0}
      aria-activedescendant={
        approvalModes.length > 0 ? `mode-opt-${activeIndex}` : undefined
      }
      aria-label={t('mode.select')}
    >
      {approvalModes.map((mode, index) => {
        const selected = index === activeIndex;
        const isCurrent = mode.id === currentMode;
        return (
          <div
            key={mode.id}
            id={`mode-opt-${index}`}
            role="option"
            // aria-selected marks the actual current mode; the roving keyboard
            // highlight is conveyed by aria-activedescendant + `.selected`.
            aria-selected={isCurrent}
            className={`${styles.row} ${selected ? styles.selected : ''} ${
              isCurrent ? dp('dialog-current') : ''
            }`}
            onClick={() => confirm(index)}
            onMouseMove={() => setActiveIndex(index)}
          >
            <span className={styles.modeIcon}>
              <ModeIcon mode={mode.id} />
            </span>
            <span className={styles.modeText}>
              <span className={styles.modeName}>{mode.name}</span>
              <span className={styles.modeDesc}>{mode.description}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

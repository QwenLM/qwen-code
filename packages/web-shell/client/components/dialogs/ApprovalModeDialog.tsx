import { useEffect, useRef, useState } from 'react';
import {
  EXECUTION_APPROVAL_MODES,
  type WebShellApprovalMode,
} from '../../utils/planMode';
import { useI18n } from '../../i18n';
import { useListboxKeyboard } from '../../hooks/useListboxKeyboard';
import { dp } from './dialogStyles';
import { ModeIcon } from '../ModeIcon';
import styles from './ApprovalModeDialog.module.css';

interface ApprovalModeDialogProps {
  currentMode: string;
  availableModes?: readonly WebShellApprovalMode[];
  sessionWorkflowEnabled?: boolean;
  onSelect: (modeId: string) => void;
}

interface ModeItem {
  id: string;
  name: string;
  description: string;
}

export function ApprovalModeDialog({
  currentMode,
  availableModes = EXECUTION_APPROVAL_MODES,
  onSelect,
}: ApprovalModeDialogProps) {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);
  const approvalModes: ModeItem[] = availableModes.map((id) => ({
    id,
    name: t(`mode.listLabel.${id}`),
    description: t(`mode.desc.${id}`),
  }));

  const currentIdx = approvalModes.findIndex((m) => m.id === currentMode);
  const [activeIndex, setActiveIndex] = useState(
    currentIdx >= 0 ? currentIdx : 0,
  );

  // Follow the current mode until the user first navigates: it can change
  // while the dialog is open (e.g. another client sharing the session flips
  // approval mode). Once the user has moved the highlight, don't steal it.
  const userNavigatedRef = useRef(false);
  useEffect(() => {
    if (userNavigatedRef.current || currentIdx < 0) return;
    setActiveIndex(currentIdx);
  }, [currentIdx]);

  const moveHighlight = (index: number) => {
    userNavigatedRef.current = true;
    setActiveIndex(index);
  };

  const highlightedIndex = Math.min(
    activeIndex,
    Math.max(0, approvalModes.length - 1),
  );

  // Re-anchor the highlight by row identity, not position: a same-length
  // swap otherwise leaves the index pointing at a row the user never
  // highlighted, and Enter would commit that row. A highlighted row that
  // still exists keeps the highlight (following it if it moved); one that
  // disappeared re-derives from the current mode. Keyed on the ids alone so
  // a current-mode change does not steal a highlight the user moved.
  const approvalModesKey = approvalModes.map((mode) => mode.id).join('\n');
  const approvalModesRef = useRef(approvalModes);
  const highlightedIdsRef = useRef(approvalModes.map((mode) => mode.id));
  useEffect(() => {
    approvalModesRef.current = approvalModes;
  });
  useEffect(() => {
    const previousIds = highlightedIdsRef.current;
    highlightedIdsRef.current = approvalModes.map((mode) => mode.id);
    setActiveIndex((prev) => {
      // The follow-current effect may have queued its own update in this
      // commit, leaving prev in new-list coordinates; until the user has
      // navigated, the current mode is the anchor and needs no lookup.
      if (!userNavigatedRef.current) return currentIdx >= 0 ? currentIdx : 0;
      const highlightedId = previousIds[prev];
      if (highlightedId === undefined) return 0;
      const index = approvalModesRef.current.findIndex(
        (mode) => mode.id === highlightedId,
      );
      if (index >= 0) return index;
      return currentIdx >= 0 ? currentIdx : 0;
    });
    // currentIdx is read fresh inside the update; keying on it would fire on
    // every mode change and steal a user-moved highlight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approvalModesKey]);

  const confirm = (index: number) => {
    const mode = approvalModes[index];
    if (mode) onSelect(mode.id);
  };

  const { keyboardMode } = useListboxKeyboard({
    itemCount: approvalModes.length,
    activeIndex: highlightedIndex,
    onActiveIndexChange: moveHighlight,
    onConfirm: confirm,
  });

  useEffect(() => {
    const el = listRef.current?.children[highlightedIndex] as
      | HTMLElement
      | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex]);

  return (
    <div
      className={`${styles.list} ${keyboardMode ? styles.keyboardOnly : ''}`}
      ref={listRef}
      role="listbox"
      tabIndex={0}
      aria-activedescendant={
        approvalModes.length > 0 ? `mode-opt-${highlightedIndex}` : undefined
      }
      aria-label={t('mode.select')}
      data-web-shell-approval-mode-dialog
    >
      {approvalModes.map((mode, index) => {
        const selected = index === highlightedIndex;
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
            data-web-shell-approval-mode-option
            data-mode-id={mode.id}
            onClick={() => confirm(index)}
            onMouseMove={() => moveHighlight(index)}
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

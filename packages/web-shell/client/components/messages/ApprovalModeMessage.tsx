import { useCallback, useEffect, useRef, useState } from 'react';
import { DAEMON_APPROVAL_MODES } from '@qwen-code/webui/daemon-react-sdk';
import { useDelayedGlobalKeyDown } from '../../hooks/useDelayedGlobalKeyDown';
import { useI18n } from '../../i18n';
import styles from './ApprovalModeMessage.module.css';

export const APPROVAL_MODE_ACTIVE_EVENT =
  'web-shell:approval-mode-panel-active';

interface ApprovalModeMessageProps {
  currentMode: string;
  onSelect: (modeId: string) => void;
  onClose: () => void;
}

interface ModeItem {
  id: string;
  name: string;
  description: string;
}

export function ApprovalModeMessage({
  currentMode,
  onSelect,
  onClose,
}: ApprovalModeMessageProps) {
  const { t } = useI18n();
  const panelIdRef = useRef(
    `approval-mode-${Math.random().toString(36).slice(2)}`,
  );
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const approvalModes: ModeItem[] = DAEMON_APPROVAL_MODES.map((id) => ({
    id,
    name: t(`mode.name.${id}`),
    description: t(`mode.desc.${id}`),
  }));

  const [selectedIdx, setSelectedIdx] = useState(() => {
    const idx = approvalModes.findIndex((m) => m.id === currentMode);
    return idx >= 0 ? idx : 0;
  });

  const emitActive = useCallback((active: boolean) => {
    window.dispatchEvent(
      new CustomEvent(APPROVAL_MODE_ACTIVE_EVENT, {
        detail: { id: panelIdRef.current, active },
      }),
    );
  }, []);

  useEffect(() => {
    emitActive(true);
    return () => emitActive(false);
  }, [emitActive]);

  // Close when the user presses outside the panel. The panel is rendered
  // inline (no modal backdrop), so we listen on the document. The press that
  // opened the panel has already finished propagating by the time this effect
  // runs, so it cannot self-close. We cover touch as well so a tap outside
  // dismisses on touch devices, not only via Escape / a row click.
  useEffect(() => {
    const onPointerOutside = (event: Event) => {
      // Only the primary (left) mouse button dismisses. Middle-click on
      // Linux/X11 pastes, and right-click opens a context menu — neither should
      // close the panel out from under the user. (Touch events have no button.)
      if (event instanceof MouseEvent && event.button !== 0) return;
      // If another handler already consumed the press, leave the panel alone.
      if (event.defaultPrevented) return;
      const panel = panelRef.current;
      const target = event.target;
      if (panel && target instanceof Node && !panel.contains(target)) {
        onCloseRef.current();
      }
    };
    window.addEventListener('mousedown', onPointerOutside);
    window.addEventListener('touchstart', onPointerOutside);
    return () => {
      window.removeEventListener('mousedown', onPointerOutside);
      window.removeEventListener('touchstart', onPointerOutside);
    };
  }, []);

  useEffect(() => {
    if (selectedIdx >= approvalModes.length && approvalModes.length > 0) {
      setSelectedIdx(approvalModes.length - 1);
    }
  }, [approvalModes.length, selectedIdx]);

  useEffect(() => {
    const el = listRef.current?.children[selectedIdx] as
      | HTMLElement
      | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  const handleSelect = useCallback(() => {
    const mode = approvalModes[selectedIdx];
    if (!mode) return;
    onSelect(mode.id);
    onClose();
  }, [approvalModes, onClose, onSelect, selectedIdx]);

  useDelayedGlobalKeyDown(
    (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const claim = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      if (e.key === 'Escape') {
        claim();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'j') {
        claim();
        setSelectedIdx((idx) =>
          approvalModes.length > 0 ? (idx + 1) % approvalModes.length : 0,
        );
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'k') {
        claim();
        setSelectedIdx((idx) =>
          approvalModes.length > 0
            ? (idx - 1 + approvalModes.length) % approvalModes.length
            : 0,
        );
        return;
      }
      if (e.key === 'Enter') {
        claim();
        handleSelect();
        return;
      }
    },
    [approvalModes.length, handleSelect, onClose],
  );

  return (
    <div ref={panelRef} className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>{t('mode.select')}</span>
      </div>

      <div
        className={styles.list}
        ref={listRef}
        role="listbox"
        aria-label={t('mode.select')}
      >
        {approvalModes.map((m, index) => {
          const selected = index === selectedIdx;
          return (
            <div
              key={m.id}
              role="option"
              aria-selected={selected}
              className={`${styles.row} ${selected ? styles.selected : ''}`}
              onClick={() => {
                onSelect(m.id);
                onClose();
              }}
              onMouseEnter={() => setSelectedIdx(index)}
            >
              <span className={styles.pointer}>{selected ? '›' : ' '}</span>
              <span className={styles.number}>{index + 1}.</span>
              <span className={styles.label}>
                {m.name} - {m.description}
              </span>
            </div>
          );
        })}
      </div>

      <div className={styles.footer}>{t('mode.footer')}</div>
    </div>
  );
}

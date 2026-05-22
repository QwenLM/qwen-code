import { useState, useEffect, useRef, useCallback } from 'react';
import { DAEMON_APPROVAL_MODES } from '@qwen-code/sdk/daemon';
import { useDelayedGlobalKeyDown } from '../../hooks/useDelayedGlobalKeyDown';

interface ApprovalModeDialogProps {
  currentMode: string;
  onSelect: (modeId: string) => void;
  onClose: () => void;
}

const APPROVAL_MODE_COPY: Record<
  (typeof DAEMON_APPROVAL_MODES)[number],
  { label: string; description: string }
> = {
  plan: { label: 'Plan 模式', description: '仅分析和规划，不执行工具' },
  default: { label: '默认模式', description: '每次工具调用都需要确认' },
  'auto-edit': { label: '自动编辑', description: '自动批准文件读写操作' },
  yolo: { label: 'YOLO 模式', description: '自动批准所有操作' },
};

const APPROVAL_MODES = DAEMON_APPROVAL_MODES.map((id) => ({
  id,
  ...APPROVAL_MODE_COPY[id],
}));

export function ApprovalModeDialog({
  currentMode,
  onSelect,
  onClose,
}: ApprovalModeDialogProps) {
  const [selectedIdx, setSelectedIdx] = useState(() => {
    const idx = APPROVAL_MODES.findIndex((m) => m.id === currentMode);
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
    const mode = APPROVAL_MODES[selectedIdx];
    if (mode) {
      onSelect(mode.id);
      onClose();
    }
  }, [selectedIdx, onSelect, onClose]);

  useDelayedGlobalKeyDown(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, APPROVAL_MODES.length - 1));
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
    [selectedIdx, onClose, handleSelect],
  );

  return (
    <div className="resume-picker">
      <div className="resume-picker-header">
        <span className="resume-picker-title">Approval Mode</span>
        <span className="resume-picker-count">
          current:{' '}
          {APPROVAL_MODES.find((m) => m.id === currentMode)?.label ||
            currentMode}
        </span>
      </div>

      <div className="resume-picker-sep" />

      <div className="resume-picker-list" ref={listRef}>
        {APPROVAL_MODES.map((m, i) => (
          <div
            key={m.id}
            className={`resume-picker-item ${i === selectedIdx ? 'selected' : ''}`}
            onClick={() => {
              onSelect(m.id);
              onClose();
            }}
            onMouseEnter={() => setSelectedIdx(i)}
          >
            <div className="resume-picker-item-row">
              <span className="resume-picker-item-prefix">
                {i === selectedIdx ? '›' : ' '}
              </span>
              <span className="resume-picker-item-title">{m.label}</span>
              {m.id === currentMode && (
                <span className="resume-picker-item-check"> ✓</span>
              )}
            </div>
            <div className="resume-picker-item-meta">{m.description}</div>
          </div>
        ))}
      </div>

      <div className="resume-picker-sep" />

      <div className="resume-picker-footer">
        ↑↓ to navigate · Enter to select · Esc to cancel
      </div>
    </div>
  );
}

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import type { Message, UserMessage } from '../../adapters/types';

export interface RewindTurn {
  id: string;
  content: string;
  turnIndex: number;
}

interface RewindDialogProps {
  messages: Message[];
  onSelect: (turn: RewindTurn) => void;
  onClose: () => void;
}

function getRewindTurns(messages: Message[]): RewindTurn[] {
  return messages
    .filter(
      (m): m is UserMessage =>
        m.role === 'user' && typeof m.turnIndex === 'number',
    )
    .map((m) => ({
      id: m.id,
      content: m.content,
      turnIndex: m.turnIndex!,
    }));
}

function preview(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized || '(empty prompt)';
}

export function RewindDialog({
  messages,
  onSelect,
  onClose,
}: RewindDialogProps) {
  const turns = useMemo(() => getRewindTurns(messages), [messages]);
  const [selectedIdx, setSelectedIdx] = useState(Math.max(0, turns.length - 1));
  const [confirming, setConfirming] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    rootRef.current?.focus();
  }, [confirming]);

  useEffect(() => {
    if (selectedIdx >= turns.length && turns.length > 0) {
      setSelectedIdx(turns.length - 1);
    }
  }, [selectedIdx, turns.length]);

  useEffect(() => {
    const el = listRef.current?.children[selectedIdx] as
      | HTMLElement
      | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx, confirming]);

  const selected = turns[selectedIdx];

  const confirm = useCallback(() => {
    if (selected) {
      onSelect(selected);
    }
  }, [onSelect, selected]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (confirming) {
          setConfirming(false);
        } else {
          onClose();
        }
        return;
      }

      if (confirming) {
        if (e.key === 'Enter' || e.key === 'y' || e.key === 'Y') {
          e.preventDefault();
          confirm();
          return;
        }
        if (e.key === 'n' || e.key === 'N') {
          e.preventDefault();
          setConfirming(false);
        }
        return;
      }

      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, turns.length - 1));
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (selected) setConfirming(true);
      }
    },
    [confirm, confirming, onClose, selected, turns.length],
  );

  if (turns.length === 0) {
    return (
      <div
        ref={rootRef}
        className="resume-picker"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="resume-picker-header">
          <span className="resume-picker-title">Rewind Conversation</span>
        </div>
        <div className="resume-picker-sep" />
        <div className="resume-picker-empty">没有可回退的用户消息。</div>
        <div className="resume-picker-sep" />
        <div className="resume-picker-footer">Esc to cancel</div>
      </div>
    );
  }

  if (confirming && selected) {
    return (
      <div
        ref={rootRef}
        className="resume-picker"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="resume-picker-header">
          <span className="resume-picker-title">Rewind Conversation</span>
        </div>
        <div className="resume-picker-sep" />
        <div className="rewind-confirm">
          <div className="rewind-confirm-label">Rewind to:</div>
          <div className="rewind-confirm-prompt">
            {preview(selected.content)}
          </div>
          <div className="rewind-confirm-warning">
            这会移除此消息之后的对话，并把该 prompt 放回输入框供你编辑。
          </div>
        </div>
        <div className="resume-picker-sep" />
        <div className="resume-picker-footer">
          Enter/Y to confirm · Esc/N to go back
        </div>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="resume-picker"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      <div className="resume-picker-header">
        <span className="resume-picker-title">Rewind Conversation</span>
        <span className="resume-picker-count">({turns.length} turns)</span>
      </div>
      <div className="resume-picker-sep" />
      <div className="resume-picker-list" ref={listRef}>
        {turns.map((turn, i) => (
          <div
            key={turn.id}
            className={`resume-picker-item ${i === selectedIdx ? 'selected' : ''}`}
            onClick={() => {
              setSelectedIdx(i);
              setConfirming(true);
            }}
            onMouseEnter={() => setSelectedIdx(i)}
          >
            <div className="resume-picker-item-row">
              <span className="resume-picker-item-prefix">
                {i === selectedIdx ? '›' : ' '}
              </span>
              <span className="resume-picker-item-meta">
                #{turn.turnIndex + 1}
              </span>
              <span className="resume-picker-item-title">
                {preview(turn.content)}
              </span>
            </div>
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

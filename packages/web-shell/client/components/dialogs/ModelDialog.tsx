import { useState, useEffect, useRef, useCallback } from 'react';
import type { ModelInfo } from '../../adapters/types';

interface ModelDialogProps {
  mode?: 'main' | 'fast';
  currentModel: string;
  availableModels: ModelInfo[];
  onSelect: (modelId: string) => void;
  onClose: () => void;
}

export function ModelDialog({
  mode = 'main',
  currentModel,
  availableModels,
  onSelect,
  onClose,
}: ModelDialogProps) {
  const isFastMode = mode === 'fast';
  const [selectedIdx, setSelectedIdx] = useState(() => {
    const idx = availableModels.findIndex((m) => m.id === currentModel);
    return idx >= 0 ? idx : 0;
  });
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [customMode, setCustomMode] = useState(false);
  const [customInput, setCustomInput] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const customInputRef = useRef<HTMLInputElement>(null);

  const filtered = searchQuery
    ? availableModels.filter((m) => {
        const q = searchQuery.toLowerCase();
        return (
          m.id.toLowerCase().includes(q) ||
          (m.label || '').toLowerCase().includes(q)
        );
      })
    : availableModels;

  useEffect(() => {
    if (selectedIdx >= filtered.length && filtered.length > 0) {
      setSelectedIdx(filtered.length - 1);
    }
  }, [filtered.length, selectedIdx]);

  useEffect(() => {
    const el = listRef.current?.children[selectedIdx] as
      | HTMLElement
      | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  useEffect(() => {
    if (customMode) {
      customInputRef.current?.focus();
    }
  }, [customMode]);

  const handleSelect = useCallback(() => {
    const model = filtered[selectedIdx];
    if (model) {
      onSelect(model.id);
      onClose();
    }
  }, [filtered, selectedIdx, onSelect, onClose]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (customMode) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setCustomMode(false);
          setCustomInput('');
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          const val = customInput.trim();
          if (val) {
            onSelect(val);
            onClose();
          }
          return;
        }
        return;
      }

      if (searchMode) {
        if (e.key === 'Escape') {
          e.preventDefault();
          if (searchQuery) {
            setSearchQuery('');
          } else {
            setSearchMode(false);
          }
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          if (filtered.length > 0) {
            setSearchMode(false);
          }
          return;
        }
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          setSearchMode(false);
          if (e.key === 'ArrowDown') {
            setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1));
          }
          return;
        }
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        if (searchQuery) {
          setSearchQuery('');
          setSelectedIdx(0);
        } else {
          onClose();
        }
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1));
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        if (selectedIdx === 0) {
          setSearchMode(true);
        } else {
          setSelectedIdx((i) => Math.max(i - 1, 0));
        }
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSelect();
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        setSearchMode(true);
        return;
      }
      if (e.key === 'c' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setCustomMode(true);
        return;
      }
    };
    const timer = setTimeout(
      () => window.addEventListener('keydown', handler),
      50,
    );
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', handler);
    };
  }, [
    searchMode,
    searchQuery,
    filtered,
    selectedIdx,
    onClose,
    handleSelect,
    customMode,
    customInput,
    onSelect,
  ]);

  return (
    <div className="resume-picker">
      <div className="resume-picker-header">
        <span className="resume-picker-title">
          {isFastMode ? 'Set Fast Model' : 'Switch Model'}
        </span>
        <span className="resume-picker-count">
          {isFastMode
            ? 'for suggestions and side tasks'
            : `current: ${currentModel || 'unknown'}`}
        </span>
      </div>

      <div className="resume-picker-search">
        {customMode ? (
          <>
            <span className="resume-picker-search-label">Custom: </span>
            <input
              ref={customInputRef}
              className="resume-picker-search-input"
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              autoFocus
              placeholder="输入模型 ID..."
            />
          </>
        ) : searchMode ? (
          <>
            <span className="resume-picker-search-label">Search: </span>
            <input
              className="resume-picker-search-input"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setSelectedIdx(0);
              }}
              autoFocus
              placeholder=""
            />
          </>
        ) : searchQuery ? (
          <>
            <span className="resume-picker-search-label">Filter: </span>
            <span className="resume-picker-search-value">{searchQuery}</span>
          </>
        ) : (
          <span className="resume-picker-search-hint">
            Press / to search, c for custom model
          </span>
        )}
      </div>

      <div className="resume-picker-sep" />

      <div className="resume-picker-list" ref={listRef}>
        {filtered.length === 0 && (
          <div className="resume-picker-empty">
            {searchQuery ? `没有匹配 "${searchQuery}" 的模型` : '没有可用模型'}
          </div>
        )}
        {filtered.map((m, i) => (
          <div
            key={m.id}
            className={`resume-picker-item ${i === selectedIdx && !searchMode && !customMode ? 'selected' : ''}`}
            onClick={() => {
              onSelect(m.id);
              onClose();
            }}
            onMouseEnter={() => setSelectedIdx(i)}
          >
            <div className="resume-picker-item-row">
              <span className="resume-picker-item-prefix">
                {i === selectedIdx && !searchMode && !customMode ? '›' : ' '}
              </span>
              <span className="resume-picker-item-title">
                {m.label || m.id}
              </span>
              {!isFastMode && m.id === currentModel && (
                <span className="resume-picker-item-check"> ✓</span>
              )}
            </div>
            <div className="resume-picker-item-meta">{m.id}</div>
          </div>
        ))}
      </div>

      <div className="resume-picker-sep" />

      <div className="resume-picker-footer">
        {customMode
          ? 'Enter to confirm · Esc to cancel'
          : searchMode
            ? 'Type to search · Enter to commit · Esc to clear'
            : isFastMode
              ? '↑↓ to navigate · / to search · c for custom · Enter to set fast model · Esc to cancel'
              : '↑↓ to navigate · / to search · c for custom · Enter to select · Esc to cancel'}
      </div>
    </div>
  );
}

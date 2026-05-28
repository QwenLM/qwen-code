import { useState, useEffect, useRef, useCallback } from 'react';
import { dp } from './dialogStyles';
import { useConnection } from '@qwen-code/webui/daemon-react-sdk';
import { useDelayedGlobalKeyDown } from '../../hooks/useDelayedGlobalKeyDown';
import { useI18n } from '../../i18n';

interface ModelDialogProps {
  mode?: 'main' | 'fast';
  onSelect: (modelId: string) => void;
  onClose: () => void;
}

export function ModelDialog({
  mode = 'main',
  onSelect,
  onClose,
}: ModelDialogProps) {
  const connection = useConnection();
  const currentModel = connection.currentModel ?? '';
  const availableModels = connection.models ?? [];
  const { t } = useI18n();
  const isFastMode = mode === 'fast';
  const [selectedIdx, setSelectedIdx] = useState(() => {
    const idx = availableModels.findIndex((m) => m.id === currentModel);
    return idx >= 0 ? idx : 0;
  });
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

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

  const handleSelect = useCallback(() => {
    const model = filtered[selectedIdx];
    if (model) {
      onSelect(model.id);
      onClose();
    }
  }, [filtered, selectedIdx, onSelect, onClose]);

  useDelayedGlobalKeyDown(
    (e: KeyboardEvent) => {
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
    },
    [searchMode, searchQuery, filtered, selectedIdx, onClose, handleSelect],
  );

  return (
    <div className={dp('resume-picker')}>
      <div className={dp('resume-picker-header')}>
        <span className={dp('resume-picker-title')}>
          {isFastMode ? t('model.setFast') : t('model.switch')}
        </span>
        <span className={dp('resume-picker-count')}>
          {isFastMode
            ? t('model.fastHint')
            : t('model.current', {
                model: currentModel || t('model.unknown'),
              })}
        </span>
        <button
          className={dp('resume-picker-close')}
          onClick={onClose}
          title="Close"
        >
          ESC
        </button>
      </div>

      <div className={dp('resume-picker-search')}>
        {searchMode ? (
          <>
            <span className={dp('resume-picker-search-label')}>
              {t('common.search')}:{' '}
            </span>
            <input
              className={dp('resume-picker-search-input')}
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
            <span className={dp('resume-picker-search-label')}>
              {t('resume.filter')}:{' '}
            </span>
            <span className={dp('resume-picker-search-value')}>
              {searchQuery}
            </span>
          </>
        ) : (
          <span className={dp('resume-picker-search-hint')}>
            {t('model.searchHint')}
          </span>
        )}
      </div>

      <div className={dp('resume-picker-sep')} />

      <div className={dp('resume-picker-list')} ref={listRef}>
        {filtered.length === 0 && (
          <div className={dp('resume-picker-empty')}>
            {searchQuery
              ? t('model.noMatch', { query: searchQuery })
              : t('model.none')}
          </div>
        )}
        {filtered.map((m, i) => (
          <div
            key={m.id}
            className={dp(
              'resume-picker-item',
              i === selectedIdx && !searchMode ? 'selected' : undefined,
            )}
            onClick={() => {
              onSelect(m.id);
              onClose();
            }}
            onMouseEnter={() => setSelectedIdx(i)}
          >
            <div className={dp('resume-picker-item-row')}>
              <span className={dp('resume-picker-item-prefix')}>
                {i === selectedIdx && !searchMode ? '›' : ' '}
              </span>
              <span className={dp('resume-picker-item-title')}>
                {m.label || m.id}
              </span>
              {!isFastMode && m.id === currentModel && (
                <span className={dp('resume-picker-item-check')}> ✓</span>
              )}
            </div>
            <div className={dp('resume-picker-item-meta')}>{m.id}</div>
          </div>
        ))}
      </div>

      <div className={dp('resume-picker-sep')} />

      <div className={dp('resume-picker-footer')}>
        {searchMode
          ? t('dialog.footer.search')
          : isFastMode
            ? t('dialog.footer.modelFast')
            : t('dialog.footer.navSelectCancel')}
      </div>
    </div>
  );
}

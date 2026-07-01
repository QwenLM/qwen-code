import { useState, useEffect, useRef } from 'react';
import { dp } from './dialogStyles';
import { useConnection, useSessions } from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { useListboxKeyboard } from '../../hooks/useListboxKeyboard';
import { useFilterInput } from '../../hooks/useFilterInput';
import { SessionRow } from './SessionRow';

interface ResumeDialogProps {
  onSelect: (sessionId: string) => void;
  onClose: () => void;
}

const LIST_ID = 'resume-session-list';
const optionId = (index: number) => `${LIST_ID}-opt-${index}`;

export function ResumeDialog({ onSelect, onClose }: ResumeDialogProps) {
  const { t } = useI18n();
  const connection = useConnection();
  const { sessions, loading, error } = useSessions({ autoLoad: true });
  const currentSessionId = connection.sessionId;
  const [selectedIdx, setSelectedIdx] = useState(0);
  const { filterValue: filterQuery, inputProps } = useFilterInput(() =>
    setSelectedIdx(0),
  );
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = filterQuery
    ? sessions.filter((s) => {
        const q = filterQuery.toLowerCase();
        return (
          (s.displayName || '').toLowerCase().includes(q) ||
          s.sessionId.toLowerCase().includes(q)
        );
      })
    : sessions;

  // Sessions load asynchronously; once they arrive, open with the highlight on
  // the current session (consistent with the model/theme/approval pickers),
  // before the user navigates or searches.
  const syncedRef = useRef(false);
  useEffect(() => {
    if (syncedRef.current || sessions.length === 0) return;
    syncedRef.current = true;
    const idx = sessions.findIndex((s) => s.sessionId === currentSessionId);
    if (idx > 0) setSelectedIdx(idx);
  }, [sessions, currentSessionId]);

  // Keep selection in bounds
  useEffect(() => {
    if (selectedIdx >= filtered.length && filtered.length > 0) {
      setSelectedIdx(filtered.length - 1);
    }
  }, [filtered.length, selectedIdx]);

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.children[selectedIdx] as
      | HTMLElement
      | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  const confirm = (index: number) => {
    const session = filtered[index];
    if (!session) return;
    onSelect(session.sessionId);
    onClose();
  };

  const { keyboardMode } = useListboxKeyboard({
    itemCount: filtered.length,
    activeIndex: selectedIdx,
    onActiveIndexChange: setSelectedIdx,
    onConfirm: confirm,
  });

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className={dp('picker', 'picker-in-shell')}>
      <div className={dp('picker-search')}>
        <span className={dp('picker-search-label')}>
          {t('resume.search')}:{' '}
        </span>
        <input
          ref={inputRef}
          className={dp('picker-search-input')}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={LIST_ID}
          aria-activedescendant={
            filtered.length > 0 ? optionId(selectedIdx) : undefined
          }
          {...inputProps}
          placeholder=""
        />
      </div>

      <div className={dp('picker-sep')} />

      <div
        id={LIST_ID}
        role="listbox"
        className={dp(
          'picker-list',
          keyboardMode ? 'picker-keyboard-only' : undefined,
        )}
        ref={listRef}
      >
        {loading && (
          <div className={dp('picker-empty')}>{t('common.loading')}</div>
        )}
        {!loading && error && (
          <div className={dp('picker-empty')}>
            {error.message || 'Failed to load sessions'}
          </div>
        )}
        {!loading && !error && filtered.length === 0 && (
          <div className={dp('picker-empty')}>
            {filterQuery
              ? t('resume.noMatch', { query: filterQuery })
              : t('resume.none')}
          </div>
        )}
        {!loading &&
          filtered.map((s, index) => (
            <SessionRow
              key={s.sessionId}
              session={s}
              optionId={optionId(index)}
              active={index === selectedIdx}
              current={s.sessionId === currentSessionId}
              currentLabel={t('resume.current')}
              onClick={() => confirm(index)}
              onActivate={() => setSelectedIdx(index)}
            />
          ))}
      </div>
    </div>
  );
}

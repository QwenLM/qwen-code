import { useState, useEffect, useRef } from 'react';
import { dp } from './dialogStyles';
import { useConnection, useSessions } from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { formatRelativeTime } from '../../utils/formatRelativeTime';

interface ResumeDialogProps {
  onSelect: (sessionId: string) => void;
  onClose: () => void;
}

export function ResumeDialog({ onSelect, onClose }: ResumeDialogProps) {
  const { t } = useI18n();
  const connection = useConnection();
  const { sessions, loading, error } = useSessions({ autoLoad: true });
  const currentSessionId = connection.sessionId;
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = searchQuery
    ? sessions.filter((s) => {
        const q = searchQuery.toLowerCase();
        return (
          (s.displayName || '').toLowerCase().includes(q) ||
          s.sessionId.toLowerCase().includes(q)
        );
      })
    : sessions;

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

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className={dp('resume-picker', 'resume-picker-in-shell')}>
      <div className={dp('resume-picker-search')}>
        <span className={dp('resume-picker-search-label')}>
          {t('resume.search')}:{' '}
        </span>
        <input
          ref={inputRef}
          className={dp('resume-picker-search-input')}
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            setSelectedIdx(0);
          }}
          placeholder=""
        />
      </div>

      <div className={dp('resume-picker-sep')} />

      <div className={dp('resume-picker-list')} ref={listRef}>
        {loading && (
          <div className={dp('resume-picker-empty')}>{t('common.loading')}</div>
        )}
        {!loading && error && (
          <div className={dp('resume-picker-empty')}>
            {error.message || 'Failed to load sessions'}
          </div>
        )}
        {!loading && !error && filtered.length === 0 && (
          <div className={dp('resume-picker-empty')}>
            {searchQuery
              ? t('resume.noMatch', { query: searchQuery })
              : t('resume.none')}
          </div>
        )}
        {!loading &&
          filtered.map((s) => {
            const isCurrent = s.sessionId === currentSessionId;
            return (
              <div
                key={s.sessionId}
                className={dp(
                  'resume-picker-item',
                  'resume-picker-session-item',
                  isCurrent ? 'resume-picker-item-current' : undefined,
                )}
                onClick={() => {
                  onSelect(s.sessionId);
                  onClose();
                }}
              >
                <div className={dp('resume-picker-item-row')}>
                  <span className={dp('resume-picker-item-title')}>
                    {s.displayName || s.sessionId.slice(0, 8)}
                  </span>
                  {isCurrent && (
                    <span className={dp('resume-picker-item-badge')}>
                      {t('resume.current')}
                    </span>
                  )}
                </div>
                <div className={dp('resume-picker-item-meta')}>
                  <span>
                    {(s.updatedAt || s.createdAt) &&
                      formatRelativeTime(s.updatedAt || s.createdAt || '', t)}
                  </span>
                  <span className={dp('resume-picker-item-detail')}>
                    {t('common.clients', { count: s.clientCount ?? 0 })}
                  </span>
                  {s.hasActivePrompt && (
                    <span className={dp('resume-picker-item-detail')}>
                      {t('resume.activePrompt')}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}

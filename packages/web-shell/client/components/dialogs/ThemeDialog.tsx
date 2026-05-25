import { useCallback, useEffect, useRef, useState } from 'react';
import { dp } from './dialogStyles';
import { useDelayedGlobalKeyDown } from '../../hooks/useDelayedGlobalKeyDown';
import { useI18n } from '../../i18n';

export type WebShellTheme = 'dark' | 'light';

interface ThemeDialogProps {
  currentTheme: WebShellTheme;
  onSelect: (theme: WebShellTheme) => void;
  onClose: () => void;
}

const THEME_IDS: WebShellTheme[] = ['dark', 'light'];

export function ThemeDialog({
  currentTheme,
  onSelect,
  onClose,
}: ThemeDialogProps) {
  const { t } = useI18n();
  const themes = THEME_IDS.map((id) => ({
    id,
    label: t(`theme.${id}`),
    description: t(`theme.${id}.desc`),
  }));
  const [selectedIdx, setSelectedIdx] = useState(() => {
    const idx = themes.findIndex((theme) => theme.id === currentTheme);
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
    const theme = themes[selectedIdx];
    if (theme) {
      onSelect(theme.id);
      onClose();
    }
  }, [onClose, onSelect, selectedIdx, themes]);

  useDelayedGlobalKeyDown(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'j') {
        event.preventDefault();
        setSelectedIdx((index) => Math.min(index + 1, themes.length - 1));
        return;
      }
      if (event.key === 'ArrowUp' || event.key === 'k') {
        event.preventDefault();
        setSelectedIdx((index) => Math.max(index - 1, 0));
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        handleSelect();
      }
    },
    [handleSelect, onClose, themes.length],
  );

  return (
    <div className={dp('resume-picker')}>
      <div className={dp('resume-picker-header')}>
        <span className={dp('resume-picker-title')}>{t('theme.title')}</span>
        <span className={dp('resume-picker-count')}>
          {t('theme.current', { theme: currentTheme })}
        </span>
      </div>

      <div className={dp('resume-picker-sep')} />

      <div className={dp('resume-picker-list')} ref={listRef}>
        {themes.map((theme, index) => (
          <div
            key={theme.id}
            className={dp(
              'resume-picker-item',
              index === selectedIdx ? 'selected' : undefined,
            )}
            onClick={() => {
              onSelect(theme.id);
              onClose();
            }}
            onMouseEnter={() => setSelectedIdx(index)}
          >
            <div className={dp('resume-picker-item-row')}>
              <span className={dp('resume-picker-item-prefix')}>
                {index === selectedIdx ? '›' : ' '}
              </span>
              <span className={dp('resume-picker-item-title')}>
                {theme.label}
              </span>
              {theme.id === currentTheme && (
                <span className={dp('resume-picker-item-check')}> ✓</span>
              )}
            </div>
            <div className={dp('resume-picker-item-meta')}>
              {theme.description}
            </div>
          </div>
        ))}
      </div>

      <div className={dp('resume-picker-sep')} />

      <div className={dp('resume-picker-footer')}>
        {t('dialog.footer.navSelectCancel')}
      </div>
    </div>
  );
}

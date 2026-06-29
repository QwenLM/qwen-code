import { useEffect, useRef, useState } from 'react';
import { dp } from './dialogStyles';
import { useI18n } from '../../i18n';
import { WEB_SHELL_THEMES, type WebShellTheme } from '../../themeContext';

interface ThemeDialogProps {
  currentTheme: WebShellTheme;
  onSelect: (theme: WebShellTheme) => void;
  onClose: () => void;
}

export function ThemeDialog({
  currentTheme,
  onSelect,
  onClose,
}: ThemeDialogProps) {
  const { t } = useI18n();
  const themes = WEB_SHELL_THEMES.map((id) => ({
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

  return (
    <div
      className={dp('resume-picker-list', 'resume-picker-list-compact')}
      ref={listRef}
      role="listbox"
    >
      {themes.map((theme, index) => {
        const selected = theme.id === currentTheme;
        return (
          <button
            key={theme.id}
            type="button"
            role="option"
            aria-selected={selected}
            className={dp(
              'resume-picker-item',
              'resume-picker-session-item',
              index === selectedIdx || selected ? 'selected' : undefined,
            )}
            onClick={() => {
              onSelect(theme.id);
              onClose();
            }}
            onMouseEnter={() => setSelectedIdx(index)}
          >
            <div className={dp('resume-picker-item-row')}>
              <span className={dp('resume-picker-item-title')}>
                {theme.label}
              </span>
              {selected && (
                <span className={dp('resume-picker-item-check')}> ✓</span>
              )}
            </div>
            <div className={dp('resume-picker-item-meta')}>
              {theme.description}
            </div>
          </button>
        );
      })}
    </div>
  );
}

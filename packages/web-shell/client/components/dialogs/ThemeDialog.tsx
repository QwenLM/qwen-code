import { useEffect, useRef, useState } from 'react';
import { dp } from './dialogStyles';
import { useI18n } from '../../i18n';
import { useListboxKeyboard } from '../../hooks/useListboxKeyboard';
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

  const confirm = (index: number) => {
    const theme = themes[index];
    if (!theme) return;
    onSelect(theme.id);
    onClose();
  };

  const { keyboardMode } = useListboxKeyboard({
    itemCount: themes.length,
    activeIndex: selectedIdx,
    onActiveIndexChange: setSelectedIdx,
    onConfirm: confirm,
  });

  useEffect(() => {
    const el = listRef.current?.children[selectedIdx] as
      | HTMLElement
      | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  return (
    <div
      className={dp(
        'picker-list',
        'picker-list-compact',
        keyboardMode ? 'picker-keyboard-only' : undefined,
      )}
      ref={listRef}
      role="listbox"
      aria-label={t('theme.title')}
      tabIndex={0}
      aria-activedescendant={
        themes.length > 0 ? `theme-opt-${selectedIdx}` : undefined
      }
    >
      {themes.map((theme, index) => {
        const selected = theme.id === currentTheme;
        return (
          <div
            key={theme.id}
            id={`theme-opt-${index}`}
            role="option"
            aria-selected={selected}
            className={dp(
              'picker-item',
              'picker-session-item',
              index === selectedIdx ? 'selected' : undefined,
              selected ? 'dialog-current' : undefined,
            )}
            onClick={() => confirm(index)}
            onMouseMove={() => setSelectedIdx(index)}
          >
            <div className={dp('picker-item-row')}>
              <span className={dp('picker-item-title')}>{theme.label}</span>
            </div>
            <div className={dp('picker-item-meta')}>{theme.description}</div>
          </div>
        );
      })}
    </div>
  );
}

import { type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../i18n';
import { useTheme, WebShellThemeId } from '../../themeContext';
import styles from './DialogShell.module.css';

type DialogSize = 'sm' | 'md' | 'lg' | 'xl';

interface DialogShellProps {
  title: string;
  subtitle?: string;
  size?: DialogSize;
  onClose: () => void;
  children: ReactNode;
}

const sizeClass: Record<DialogSize, string> = {
  sm: styles.sizeSm,
  md: styles.sizeMd,
  lg: styles.sizeLg,
  xl: styles.sizeXl,
};

export function DialogShell({
  title,
  subtitle,
  size = 'md',
  onClose,
  children,
}: DialogShellProps) {
  const { t } = useI18n();
  const theme = useTheme();
  const themeClass =
    theme === WebShellThemeId.Light ? styles.themeLight : styles.themeDark;

  const content = (
    <div className={`${styles.backdrop} ${themeClass}`} data-keyboard-scope>
      <section
        className={`${styles.panel} ${sizeClass[size]}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className={styles.header}>
          <div className={styles.titleWrap}>
            <div className={styles.title}>{title}</div>
            {subtitle && <div className={styles.subtitle}>{subtitle}</div>}
          </div>
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label={t('common.close')}
            title={t('common.close')}
          />
        </header>
        <div className={styles.body}>{children}</div>
      </section>
    </div>
  );

  if (typeof document === 'undefined') return content;
  return createPortal(content, document.body);
}

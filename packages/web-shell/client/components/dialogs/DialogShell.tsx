import { useEffect, useRef, type ReactNode } from 'react';
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

const FOCUSABLE_SELECTOR = [
  'a[href]:not([hidden])',
  'button:not([disabled]):not([hidden])',
  'input:not([disabled]):not([hidden])',
  'select:not([disabled]):not([hidden])',
  'textarea:not([disabled]):not([hidden])',
  '[tabindex]:not([tabindex="-1"]):not([hidden])',
].join(',');

function getFocusable(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  );
}

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
  const panelRef = useRef<HTMLElement>(null);
  // `onClose` may change identity across renders; keep the latest for the
  // once-bound key listener.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Move focus into the dialog on open, restore it to the opener on close, and
  // trap Tab within the panel. Escape closes. Attached in the capture phase so
  // Escape is handled here before the app-level window handler sees it.
  useEffect(() => {
    const panel = panelRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Autofocus: respect a child that already claimed focus (e.g. a search
    // input's own effect); otherwise focus the first content focusable (skipping
    // the header close button), else the panel itself. Falling back to the panel
    // rather than the close button avoids a stray focus ring when a list dialog's
    // options are managed via a roving highlight (tabIndex=-1) instead of focus.
    if (panel && !panel.contains(document.activeElement)) {
      const focusables = getFocusable(panel);
      const preferred = focusables.find(
        (el) => !el.hasAttribute('data-dialog-close'),
      );
      (preferred ?? panel).focus();
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      // Escape mid-IME-composition cancels the composition, not the dialog.
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key === 'Tab') {
        const focusables = getFocusable(panelRef.current);
        if (focusables.length === 0) {
          // Nothing focusable inside — keep focus on the panel itself.
          event.preventDefault();
          panelRef.current?.focus();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const activeEl = document.activeElement;
        const insideList = focusables.includes(activeEl as HTMLElement);
        if (!insideList) {
          // Focus is on the panel itself (e.g. a roving-highlight list where the
          // options are tabIndex=-1) — pull it into the dialog so Tab can't
          // escape to the page behind.
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && activeEl === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && activeEl === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      previouslyFocused?.focus?.();
    };
  }, []);

  const handleBackdropClick = (event: React.MouseEvent<HTMLDivElement>) => {
    // Only close on a completed click on the backdrop itself. This lets a press
    // that starts on the backdrop be cancelled before mouse-up, and it avoids
    // dismissing the dialog from a click inside the panel that bubbles out.
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  const content = (
    <div
      className={`${styles.backdrop} ${themeClass}`}
      data-keyboard-scope
      onClick={handleBackdropClick}
    >
      <section
        ref={panelRef}
        className={`${styles.panel} ${sizeClass[size]}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
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
            data-dialog-close
          />
        </header>
        <div className={styles.body}>{children}</div>
      </section>
    </div>
  );

  if (typeof document === 'undefined') return content;
  return createPortal(content, document.body);
}

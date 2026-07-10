import {
  createContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../i18n';
import { useTheme, WebShellThemeId } from '../../themeContext';
import styles from './DialogShell.module.css';

type DialogSize = 'sm' | 'md' | 'lg' | 'xl';

interface DialogShellProps {
  title: string;
  subtitle?: string;
  size?: DialogSize;
  /** Show a header toggle that expands the panel to (near) the full viewport.
   *  For content-heavy dialogs like Daemon Status; off by default. */
  allowFullscreen?: boolean;
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

// Mounted shells, bottom → top. Every shell listens on `document`, and
// `stopPropagation` cannot silence sibling listeners on the same node — so
// without this, one Escape would close every stacked dialog at once (and the
// bottom one would win any race, since it registered first). Only the topmost
// shell handles keys; stacked dialogs peel off one layer per Escape.
const shellStack: object[] = [];

export const DialogShellIdContext = createContext<object | null>(null);

export function isTopDialogShellId(shellId: object | null): boolean {
  // Most production callers live inside DialogShell and get a shell id. Tests or
  // any future standalone consumer may not; in that case, preserve the original
  // single-dialog behavior and allow the hook to handle keys normally.
  if (shellId === null) return true;
  return shellStack[shellStack.length - 1] === shellId;
}

export function DialogShell({
  title,
  subtitle,
  size = 'md',
  allowFullscreen = false,
  onClose,
  children,
}: DialogShellProps) {
  const { t } = useI18n();
  const [fullscreen, setFullscreen] = useState(false);
  const theme = useTheme();
  const themeClass =
    theme === WebShellThemeId.Light ? styles.themeLight : styles.themeDark;
  const panelRef = useRef<HTMLElement>(null);
  // `onClose` may change identity across renders; keep the latest for the
  // once-bound key listener.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Capture the opener during the dialog's first render, before any child
  // effects can move focus into an autofocused search field.
  const [previouslyFocused] = useState<HTMLElement | null>(() =>
    typeof document !== 'undefined'
      ? (document.activeElement as HTMLElement | null)
      : null,
  );
  // A completed backdrop click should close, but any drag that crosses the
  // panel boundary in either direction must not. Record whether the press both
  // started and ended on the backdrop itself, then let the synthesized click
  // close only when both are true.
  const backdropPressStartedRef = useRef(false);
  const backdropPressEndedRef = useRef(false);
  // Identity token for this shell instance in the module-level stack.
  const shellIdRef = useRef<object | null>(null);
  if (shellIdRef.current === null) shellIdRef.current = {};

  // Move focus into the dialog on open, restore it to the opener on close, and
  // trap Tab within the panel. Escape closes.
  useEffect(() => {
    const panel = panelRef.current;
    const shellId = shellIdRef.current!;
    shellStack.push(shellId);

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
      // With stacked dialogs, only the topmost shell may handle Escape/Tab —
      // a lower shell closing or trapping focus would act "through" the one
      // covering it.
      if (shellStack[shellStack.length - 1] !== shellId) return;
      // A control inside the dialog may consume the key first (e.g. Escape to
      // cancel an inline edit) — honor that instead of dismissing the dialog.
      if (event.defaultPrevented) return;
      // Escape mid-IME-composition cancels the composition, not the dialog.
      // keyCode 229 covers WebKit, which fires compositionend before the
      // committing key's keydown (see useListboxKeyboard for the same guard).
      if (event.isComposing || event.keyCode === 229) return;
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

    // Bubble phase on `document`, deliberately positioned in the middle of the
    // propagation chain: controls inside the dialog run first (and can consume
    // Escape via preventDefault, honored above), while `window`-level listeners
    // — the app's global shortcuts and useListboxKeyboard — run after, so the
    // stopPropagation on Escape still shields them. Moving this listener to the
    // capture phase would steal Escape from the dialog's own controls; moving
    // it to `window` would lose the race with the app-level handlers.
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      const idx = shellStack.indexOf(shellId);
      if (idx >= 0) shellStack.splice(idx, 1);
      if (shellStack.length === 0) {
        previouslyFocused?.focus?.();
        return;
      }
      // Another modal is still stacked above the page — keep focus inside the
      // remaining top shell instead of restoring it behind the modal layer.
      const scopes = Array.from(
        document.querySelectorAll<HTMLElement>('[data-keyboard-scope]'),
      );
      const topPanel =
        scopes[scopes.length - 1]?.querySelector<HTMLElement>(
          '[role="dialog"]',
        );
      const topFocusables = getFocusable(topPanel);
      const preferred = topFocusables.find(
        (el) => !el.hasAttribute('data-dialog-close'),
      );
      (preferred ?? topPanel)?.focus();
    };
  }, [previouslyFocused]);

  const handleBackdropMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    backdropPressStartedRef.current = event.target === event.currentTarget;
    backdropPressEndedRef.current = false;
  };

  const handleBackdropMouseUp = (event: React.MouseEvent<HTMLDivElement>) => {
    backdropPressEndedRef.current = event.target === event.currentTarget;
  };

  const handleBackdropClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const shouldClose =
      backdropPressStartedRef.current &&
      backdropPressEndedRef.current &&
      event.target === event.currentTarget;
    backdropPressStartedRef.current = false;
    backdropPressEndedRef.current = false;
    if (shouldClose) {
      onClose();
    }
  };

  const content = (
    <div
      className={`${styles.backdrop} ${themeClass}`}
      data-keyboard-scope
      onMouseDown={handleBackdropMouseDown}
      onMouseUp={handleBackdropMouseUp}
      onClick={handleBackdropClick}
    >
      <DialogShellIdContext.Provider value={shellIdRef.current}>
        <section
          ref={panelRef}
          className={`${styles.panel} ${
            fullscreen ? styles.panelFullscreen : sizeClass[size]
          }`}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          tabIndex={-1}
          data-web-shell-dialog
          data-web-shell-dialog-title={title}
        >
          <header className={styles.header}>
            <div className={styles.titleWrap}>
              <div className={styles.title}>{title}</div>
              {subtitle && <div className={styles.subtitle}>{subtitle}</div>}
            </div>
            {allowFullscreen && (
              <button
                type="button"
                className={styles.iconButton}
                onClick={() => setFullscreen((v) => !v)}
                aria-label={t(
                  fullscreen ? 'common.exitFullscreen' : 'common.fullscreen',
                )}
                aria-pressed={fullscreen}
                title={t(
                  fullscreen ? 'common.exitFullscreen' : 'common.fullscreen',
                )}
              >
                <svg
                  viewBox="0 0 16 16"
                  width="14"
                  height="14"
                  aria-hidden="true"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  {fullscreen ? (
                    <path d="M6 2v4H2M14 6h-4V2M6 14v-4H2M14 10h-4v4" />
                  ) : (
                    <path d="M2 6V2h4M10 2h4v4M2 10v4h4M10 14h4v-4" />
                  )}
                </svg>
              </button>
            )}
            <button
              type="button"
              className={styles.close}
              onClick={onClose}
              aria-label={t('common.close')}
              title={t('common.close')}
              data-dialog-close
            />
          </header>
          <div
            className={styles.body}
            data-dialog-fullscreen={fullscreen ? '' : undefined}
          >
            {children}
          </div>
        </section>
      </DialogShellIdContext.Provider>
    </div>
  );

  if (typeof document === 'undefined') return content;
  return createPortal(content, document.body);
}

import {
  createContext,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { Maximize2Icon, Minimize2Icon, XIcon } from 'lucide-react';
import { useI18n } from '../../i18n';
import { useTheme, WebShellThemeId } from '../../themeContext';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import styles from './DialogShell.module.css';

type DialogSize = 'sm' | 'md' | 'lg' | 'xl';

interface DialogShellProps {
  title: string;
  subtitle?: string;
  size?: DialogSize;
  allowFullscreen?: boolean;
  onClose: () => void;
  children: ReactNode;
}

const sizeClass: Record<DialogSize, string> = {
  sm: 'sm:max-w-[420px]',
  md: 'sm:max-w-[560px]',
  lg: 'sm:max-w-[720px]',
  xl: 'sm:max-w-[900px]',
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

const shellStack: object[] = [];

export const DialogShellIdContext = createContext<object | null>(null);

export function isTopDialogShellId(shellId: object | null): boolean {
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
  const theme = useTheme();
  const [fullscreen, setFullscreen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [previouslyFocused] = useState<HTMLElement | null>(() =>
    typeof document !== 'undefined'
      ? (document.activeElement as HTMLElement | null)
      : null,
  );
  const backdropPressStartedRef = useRef(false);
  const backdropPressEndedRef = useRef(false);
  const shellIdRef = useRef<object | null>(null);
  if (shellIdRef.current === null) shellIdRef.current = {};

  useEffect(() => {
    const panel = panelRef.current;
    const shellId = shellIdRef.current!;
    shellStack.push(shellId);

    if (panel && !panel.contains(document.activeElement)) {
      const preferred = getFocusable(panel).find(
        (element) => !element.hasAttribute('data-dialog-close'),
      );
      (preferred ?? panel).focus();
    }

    return () => {
      const index = shellStack.indexOf(shellId);
      if (index >= 0) shellStack.splice(index, 1);
      if (shellStack.length === 0) {
        previouslyFocused?.focus?.();
        return;
      }
      const scopes = Array.from(
        document.querySelectorAll<HTMLElement>('[data-keyboard-scope]'),
      );
      const topPanel =
        scopes[scopes.length - 1]?.querySelector<HTMLElement>(
          '[role="dialog"]',
        );
      const preferred = getFocusable(topPanel).find(
        (element) => !element.hasAttribute('data-dialog-close'),
      );
      (preferred ?? topPanel)?.focus();
    };
  }, [previouslyFocused]);

  const handleBackdropMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    backdropPressStartedRef.current = event.target === event.currentTarget;
    backdropPressEndedRef.current = false;
  };

  const handleBackdropMouseUp = (event: ReactMouseEvent<HTMLDivElement>) => {
    backdropPressEndedRef.current = event.target === event.currentTarget;
  };

  const handleBackdropClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const shouldClose =
      backdropPressStartedRef.current &&
      backdropPressEndedRef.current &&
      event.target === event.currentTarget;
    backdropPressStartedRef.current = false;
    backdropPressEndedRef.current = false;
    if (shouldClose) onClose();
  };

  const themeClass =
    theme === WebShellThemeId.Light ? styles.themeLight : styles.themeDark;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogShellIdContext.Provider value={shellIdRef.current}>
        <DialogContent
          ref={panelRef}
          showCloseButton={false}
          overlayProps={{
            onMouseDown: handleBackdropMouseDown,
            onMouseUp: handleBackdropMouseUp,
            onClick: handleBackdropClick,
          }}
          className={`${themeClass} ${
            theme === WebShellThemeId.Dark ? 'dark' : ''
          } flex max-h-[min(80vh,calc(100vh-48px))] flex-col gap-0 overflow-hidden p-0 font-mono text-sm ${
            fullscreen
              ? 'h-[calc(100vh-32px)] max-h-[calc(100vh-32px)] max-w-[calc(100vw-32px)] sm:max-w-[calc(100vw-32px)]'
              : sizeClass[size]
          }`}
          aria-label={title}
          data-keyboard-scope
          data-web-shell-dialog
          data-web-shell-dialog-title={title}
          onEscapeKeyDown={(event) => {
            if (event.defaultPrevented) return;
            event.preventDefault();
            if (
              event.isComposing ||
              event.keyCode === 229 ||
              !isTopDialogShellId(shellIdRef.current)
            ) {
              return;
            }
            onCloseRef.current();
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            const preferred = getFocusable(panelRef.current).find(
              (element) => !element.hasAttribute('data-dialog-close'),
            );
            (preferred ?? panelRef.current)?.focus();
          }}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <DialogHeader className="flex-row items-center gap-2 border-b px-4 py-2.5 text-left">
            <div className="min-w-0 flex-1">
              <DialogTitle>{title}</DialogTitle>
              {subtitle && (
                <DialogDescription className="mt-0.5 text-xs">
                  {subtitle}
                </DialogDescription>
              )}
            </div>
            {allowFullscreen && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => setFullscreen((value) => !value)}
                aria-label={t(
                  fullscreen ? 'common.exitFullscreen' : 'common.fullscreen',
                )}
                aria-pressed={fullscreen}
                title={t(
                  fullscreen ? 'common.exitFullscreen' : 'common.fullscreen',
                )}
              >
                {fullscreen ? <Minimize2Icon /> : <Maximize2Icon />}
              </Button>
            )}
            <DialogClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('common.close')}
                title={t('common.close')}
                data-dialog-close
              >
                <XIcon />
              </Button>
            </DialogClose>
          </DialogHeader>
          <div
            className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4"
            data-dialog-fullscreen={fullscreen ? '' : undefined}
          >
            {children}
          </div>
        </DialogContent>
      </DialogShellIdContext.Provider>
    </Dialog>
  );
}

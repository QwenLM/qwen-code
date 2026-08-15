import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  RotateCwIcon,
  XIcon,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import { extractErrorDetail } from '../../utils/errorDetail';
import {
  getDesktopBrowserApi,
  getDesktopLinkApi,
  type DesktopBrowserBounds,
  type DesktopBrowserState,
} from '../../utils/desktopBrowser';
import { requestToast } from '../ToastHost';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import styles from './DesktopBrowserPanel.module.css';

const MIN_PANEL_WIDTH = 360;
const MIN_APP_WIDTH = 480;

function initialPanelWidth(): number {
  return typeof window === 'undefined'
    ? 520
    : Math.max(MIN_PANEL_WIDTH, Math.min(520, window.innerWidth * 0.45));
}

function normalizeUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function elementBounds(element: HTMLElement): DesktopBrowserBounds | undefined {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return undefined;
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

export function DesktopBrowserPanel() {
  const { t } = useI18n();
  const api = getDesktopBrowserApi();
  const desktopLinks = getDesktopLinkApi();
  const contentRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [width, setWidth] = useState(initialPanelWidth);
  const [pendingUrl, setPendingUrl] = useState<string>();
  const [address, setAddress] = useState('');
  const [browserState, setBrowserState] = useState<DesktopBrowserState>({
    url: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  });

  const reportFailure = useCallback(
    (error: unknown) => {
      requestToast(
        'error',
        t('common.openFailed', { message: extractErrorDetail(error) }),
      );
    },
    [t],
  );

  const requestOpen = useCallback(
    (rawUrl: string) => {
      const url = normalizeUrl(rawUrl);
      if (!url) {
        reportFailure(new Error(t('desktopBrowser.httpOnly')));
        return;
      }
      setAddress(url);
      setPendingUrl(url);
      setVisible(true);
    },
    [reportFailure, t],
  );

  useEffect(() => {
    if (!api) return;
    const stopOpenRequests = api.onOpenRequested(requestOpen);
    const stopStateUpdates = api.onStateChanged((state) => {
      setBrowserState(state);
      if (state.url) setAddress(state.url);
    });
    return () => {
      stopOpenRequests();
      stopStateUpdates();
    };
  }, [api, requestOpen]);

  useLayoutEffect(() => {
    if (!api || !visible || !pendingUrl || !contentRef.current) return;
    const bounds = elementBounds(contentRef.current);
    if (!bounds) return;
    const openingUrl = pendingUrl;
    void api
      .open(openingUrl, bounds)
      .then(() => {
        setPendingUrl((current) =>
          current === openingUrl ? undefined : current,
        );
      })
      .catch(reportFailure);
  }, [api, pendingUrl, reportFailure, visible]);

  useEffect(() => {
    const content = contentRef.current;
    if (!api || !visible || !content) return;
    const syncBounds = () => {
      const bounds = elementBounds(content);
      if (bounds) api.setBounds(bounds);
    };
    const observer = new ResizeObserver(syncBounds);
    observer.observe(content);
    window.addEventListener('resize', syncBounds);
    syncBounds();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', syncBounds);
    };
  }, [api, visible]);

  const run = useCallback(
    (operation: (() => Promise<void>) | undefined) => {
      if (operation) void operation().catch(reportFailure);
    },
    [reportFailure],
  );

  const close = useCallback(() => {
    setVisible(false);
    setPendingUrl(undefined);
    run(api ? () => api.close() : undefined);
  }, [api, run]);

  const submitAddress = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const url = normalizeUrl(address);
      if (!url) {
        reportFailure(new Error(t('desktopBrowser.httpOnly')));
        return;
      }
      setAddress(url);
      run(api ? () => api.navigate(url) : undefined);
    },
    [address, api, reportFailure, run, t],
  );

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = width;
      const previousCursor = document.body.style.cursor;
      const previousSelect = document.body.style.userSelect;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      const move = (moveEvent: PointerEvent) => {
        const maxWidth = Math.max(
          MIN_PANEL_WIDTH,
          window.innerWidth - MIN_APP_WIDTH,
        );
        setWidth(
          Math.max(
            MIN_PANEL_WIDTH,
            Math.min(maxWidth, startWidth + startX - moveEvent.clientX),
          ),
        );
      };
      const stop = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', stop);
        window.removeEventListener('pointercancel', stop);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousSelect;
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', stop);
      window.addEventListener('pointercancel', stop);
    },
    [width],
  );

  if (!api || !visible) return null;

  return (
    <section
      className={styles.panel}
      style={{ '--desktop-browser-width': `${width}px` } as CSSProperties}
      aria-label={t('desktopBrowser.title')}
      data-testid="desktop-browser-panel"
    >
      <div
        className={styles.resizeHandle}
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={MIN_PANEL_WIDTH}
        aria-valuemax={Math.max(
          MIN_PANEL_WIDTH,
          window.innerWidth - MIN_APP_WIDTH,
        )}
        aria-valuenow={Math.round(width)}
        onPointerDown={startResize}
      />
      <div className={styles.surface}>
        <div className={styles.toolbar}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={!browserState.canGoBack}
            aria-label={t('desktopBrowser.back')}
            title={t('desktopBrowser.back')}
            onClick={() => run(() => api.goBack())}
          >
            <ArrowLeftIcon aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={!browserState.canGoForward}
            aria-label={t('desktopBrowser.forward')}
            title={t('desktopBrowser.forward')}
            onClick={() => run(() => api.goForward())}
          >
            <ArrowRightIcon aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('desktopBrowser.reload')}
            title={t('desktopBrowser.reload')}
            onClick={() => run(() => api.reload())}
          >
            {browserState.loading ? (
              <LoaderCircleIcon
                className={styles.loadingIcon}
                aria-hidden="true"
              />
            ) : (
              <RotateCwIcon aria-hidden="true" />
            )}
          </Button>
          <form className={styles.addressForm} onSubmit={submitAddress}>
            <Input
              value={address}
              onChange={(event) => setAddress(event.currentTarget.value)}
              aria-label={t('desktopBrowser.address')}
              spellCheck={false}
            />
          </form>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('desktopBrowser.openExternal')}
            title={t('desktopBrowser.openExternal')}
            onClick={() => {
              const url = normalizeUrl(browserState.url || address);
              if (url && desktopLinks) {
                run(() => desktopLinks.open(url, { forceExternal: true }));
              }
            }}
          >
            <ExternalLinkIcon aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('desktopBrowser.close')}
            title={t('desktopBrowser.close')}
            onClick={close}
          >
            <XIcon aria-hidden="true" />
          </Button>
        </div>
        <div
          ref={contentRef}
          className={styles.content}
          data-testid="desktop-browser-content"
        />
      </div>
    </section>
  );
}

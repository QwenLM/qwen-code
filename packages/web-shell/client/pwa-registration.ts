import { WEB_SHELL_SERVICE_WORKER_ROUTE } from '@qwen-code/sdk/daemon';

interface ServiceWorkerRegistrationOptions {
  production: boolean;
  root?: Pick<HTMLElement, 'hasAttribute'>;
  serviceWorker?: Pick<ServiceWorkerContainer, 'register'>;
  addLoadListener?: (listener: () => void) => void;
  warn?: (...args: unknown[]) => void;
}

/** Schedule standalone PWA registration after the initial document load. */
export function scheduleServiceWorkerRegistration({
  production,
  root = document.documentElement,
  serviceWorker = typeof navigator !== 'undefined' &&
  'serviceWorker' in navigator
    ? navigator.serviceWorker
    : undefined,
  addLoadListener = (listener) => window.addEventListener('load', listener),
  warn = (...args) => console.warn(...args),
}: ServiceWorkerRegistrationOptions): void {
  if (
    !production ||
    root.hasAttribute('data-web-shell-unsupported-browser') ||
    !serviceWorker
  )
    return;

  addLoadListener(() => {
    void serviceWorker
      .register(WEB_SHELL_SERVICE_WORKER_ROUTE, { scope: '/' })
      .catch((err: unknown) => {
        warn('qwen-code: service worker registration failed:', err);
      });
  });
}

export function registerServiceWorker(): void {
  if (
    !import.meta.env.PROD ||
    !window.isSecureContext ||
    window.self !== window.top ||
    !('serviceWorker' in navigator)
  ) {
    return;
  }

  void navigator.serviceWorker
    .register('/service-worker.js', { scope: '/', updateViaCache: 'none' })
    .catch((error: unknown) => {
      console.warn('Web Shell service worker registration failed:', error);
    });
}

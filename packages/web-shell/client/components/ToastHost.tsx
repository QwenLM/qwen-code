import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';
import { useWebShellPortalRoot } from '../portalRoot';
import styles from './ToastHost.module.css';

export type ToastTone = 'info' | 'warning' | 'error' | 'success';

export interface WebShellToast {
  id: string;
  tone: ToastTone;
  message: string;
}

interface ToastHostProps {
  toasts: readonly WebShellToast[];
  onDismiss: (id: string) => void;
  autoDismissMs?: number;
  /** Paint above dialog-backdrop-tier surfaces (fullscreen artifact panel). */
  elevated?: boolean;
}

export function ToastHost({
  toasts,
  onDismiss,
  autoDismissMs = 5000,
  elevated = false,
}: ToastHostProps) {
  const portalRoot = useWebShellPortalRoot();
  if (toasts.length === 0) return null;
  const host = (
    <div
      className={`${styles.host} ${elevated ? styles.hostElevated : ''}`}
      role="status"
      aria-live="polite"
      data-web-shell-toast-host
    >
      {toasts.map((toast) => (
        <ToastItem
          key={toast.id}
          toast={toast}
          onDismiss={onDismiss}
          autoDismissMs={autoDismissMs}
        />
      ))}
    </div>
  );
  // While elevated the host must share the portal root's stacking context:
  // in shadow-DOM portal mode the fullscreen drawer surface is sealed inside
  // the portal host (z = --web-shell-portal-root-z-index), so a toast left in
  // the app tree paints beneath it for its whole auto-dismiss lifetime.
  if (elevated && portalRoot) return createPortal(host, portalRoot);
  return host;
}

function ToastItem({
  toast,
  onDismiss,
  autoDismissMs,
}: {
  toast: WebShellToast;
  onDismiss: (id: string) => void;
  autoDismissMs: number;
}) {
  const { t } = useI18n();
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.id), autoDismissMs);
    return () => window.clearTimeout(timer);
  }, [autoDismissMs, onDismiss, toast.id]);

  return (
    <div
      className={`${styles.toast} ${styles[toast.tone]}`}
      data-web-shell-toast
      data-tone={toast.tone}
    >
      <div className={styles.message}>{toast.message}</div>
      <button
        type="button"
        className={styles.close}
        onClick={() => onDismiss(toast.id)}
        aria-label={t('toast.dismiss')}
        title={t('toast.dismissShort')}
      >
        x
      </button>
    </div>
  );
}

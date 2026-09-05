import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';
import { useWebShellPortalRoot } from '../portalRoot';
import styles from './ToastHost.module.css';

export type ToastTone = 'info' | 'warning' | 'error' | 'success';

/** Window event that asks the app-level toast host to show a toast. Lets
 * deeply nested components (markdown links, artifact actions) report failures
 * without prop-drilling the toast callback. */
export const TOAST_REQUEST_EVENT = 'qwen:toast-request';

export interface ToastRequestDetail {
  tone: ToastTone;
  message: string;
}

export function requestToast(tone: ToastTone, message: string): void {
  window.dispatchEvent(
    new CustomEvent<ToastRequestDetail>(TOAST_REQUEST_EVENT, {
      detail: { tone, message },
    }),
  );
}

export interface WebShellToast {
  id: string;
  tone: ToastTone;
  message: string;
  /** Epoch ms when the toast auto-dismisses; survives host remounts. */
  dismissAt: number;
}

interface ToastHostProps {
  toasts: readonly WebShellToast[];
  onDismiss: (id: string) => void;
  /** Paint above dialog-backdrop-tier surfaces (fullscreen artifact panel). */
  elevated?: boolean;
}

export function ToastHost({
  toasts,
  onDismiss,
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
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
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
}: {
  toast: WebShellToast;
  onDismiss: (id: string) => void;
}) {
  const { t } = useI18n();
  useEffect(() => {
    // Schedule against the deadline, not a fresh duration: toggling
    // `elevated` moves the host between the app tree and the portal root,
    // remounting this item, and a full new timer per remount would keep a
    // toast on screen indefinitely across repeated toggles.
    const delay = Math.max(0, toast.dismissAt - Date.now());
    const timer = window.setTimeout(() => onDismiss(toast.id), delay);
    return () => window.clearTimeout(timer);
  }, [onDismiss, toast.id, toast.dismissAt]);

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

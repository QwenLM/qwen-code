import { useEffect } from 'react';
import { useI18n } from '../i18n';
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
}

export function ToastHost({
  toasts,
  onDismiss,
  autoDismissMs = 5000,
}: ToastHostProps) {
  if (toasts.length === 0) return null;
  return (
    <div className={styles.host} role="status" aria-live="polite">
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
    <div className={`${styles.toast} ${styles[toast.tone]}`}>
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

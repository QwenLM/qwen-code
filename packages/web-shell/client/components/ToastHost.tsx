import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';
import { useWebShellPortalRoot } from '../portalRoot';
import styles from './ToastHost.module.css';

export type ToastTone = 'info' | 'warning' | 'error' | 'success';

export const MAX_TOASTS = 4;
export const TOAST_AUTO_DISMISS_MS = 5000;

/** Window event that asks the app-level toast host to show a toast. Lets
 * deeply nested components (markdown links, artifact actions) report failures
 * without prop-drilling the toast callback. */
export const TOAST_REQUEST_EVENT = 'qwen:toast-request';

export interface ToastRequestDetail {
  tone: ToastTone;
  message: string;
}

/**
 * Resolve the dispatch target for a toast request. An explicit scope (the
 * calling control's shell root) wins — ownership must not be inferred from
 * focus, which can sit in a co-mounted shell or nowhere at all. Without one,
 * walk the focused element through shadow roots (document.activeElement is
 * the shadow host, not the focused control) and use its shell root; failing
 * that, a single mounted shell root still receives the notice so an
 * unfocused or effect-driven call is not dropped. Only a document with no
 * unique shell falls back to window, where App's document-wide host listens.
 */
function resolveToastTarget(scope?: Element | null): Element | Window {
  if (scope) return scope;
  if (typeof document === 'undefined') return window;
  let active: Element | null = document.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  const focusedRoot =
    active instanceof Element ? active.closest('[data-web-shell-root]') : null;
  if (focusedRoot) return focusedRoot;
  const roots = document.querySelectorAll('[data-web-shell-root]');
  if (roots.length === 1) return roots[0]!;
  return window;
}

export function requestToast(
  tone: ToastTone,
  message: string,
  scope?: Element | null,
): void {
  // bubbles keeps the event reaching App's window listener from a shell
  // root; composed lets it cross a shadow boundary when the shell is
  // embedded in one.
  resolveToastTarget(scope).dispatchEvent(
    new CustomEvent<ToastRequestDetail>(TOAST_REQUEST_EVENT, {
      detail: { tone, message },
      bubbles: true,
      composed: true,
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

/**
 * The toast queue contract shared by App's listener and WindowToastHost, in
 * one place so the two hosts cannot drift: deadline-based auto-dismiss and
 * tone+message de-duplication with a capped stack (a repeat moves to the top
 * instead of stacking twice; the oldest overflow drops).
 */
export function createWebShellToast(
  tone: ToastTone,
  message: string,
  sequence: number,
): WebShellToast {
  return {
    id: `web-shell-toast-${Date.now()}-${sequence}`,
    tone,
    message,
    // Deadline instead of duration: the host remounts its items when the
    // elevated portal moves, and a fresh timer per remount would keep a
    // toast on screen indefinitely across repeated fullscreen toggles.
    dismissAt: Date.now() + TOAST_AUTO_DISMISS_MS,
  };
}

export function appendToastDeduped(
  current: readonly WebShellToast[],
  toast: WebShellToast,
): WebShellToast[] {
  const withoutDuplicate = current.filter(
    (item) => item.tone !== toast.tone || item.message !== toast.message,
  );
  return [...withoutDuplicate, toast].slice(-MAX_TOASTS);
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

/**
 * Self-contained host for the window toast channel, for shells that do not
 * carry App's toast state (the managed-only boot path). Same contract as
 * App's listener: non-empty message guard, tone+message de-duplication, a
 * capped stack, and deadline-based auto-dismiss. Without it, requestToast
 * from a nested control dispatches into a document with no listener and the
 * notice is silently dropped.
 *
 * `scope` narrows the listener to one shell's root element: requestToast
 * dispatches on the acting shell's root (bubbling to window), so co-mounted
 * shells do not show each other's notices. Omit it only for a single-shell
 * document.
 */
export function WindowToastHost({ scope }: { scope?: HTMLElement | null }) {
  const [toasts, setToasts] = useState<WebShellToast[]>([]);
  const toastIdRef = useRef(0);
  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ToastRequestDetail>).detail;
      if (!detail || typeof detail.message !== 'string' || !detail.message) {
        return;
      }
      const toast = createWebShellToast(
        detail.tone,
        detail.message,
        ++toastIdRef.current,
      );
      setToasts((current) => appendToastDeduped(current, toast));
    };
    const target: HTMLElement | Window = scope ?? window;
    target.addEventListener(TOAST_REQUEST_EVENT, handler);
    return () => target.removeEventListener(TOAST_REQUEST_EVENT, handler);
  }, [scope]);
  return <ToastHost toasts={toasts} onDismiss={dismissToast} />;
}

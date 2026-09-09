/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { getTranslator, type WebShellLanguage } from './i18n';
import {
  createTurnNotificationObserver,
  TurnNotificationContext,
  TurnNotificationNavigationContext,
  type TurnNotification,
} from './daemon/session/turn-notification-context';

export const BROWSER_NOTIFICATIONS_STORAGE_KEY =
  'qwen-code-web-shell-browser-notifications';
const CLAIMS_STORAGE_KEY = 'qwen-code-web-shell-notification-claims';
const MAX_CLAIMS = 1024;
const NOTIFICATION_ICON_URL = new URL(
  './assets/qwen-code-notification.png',
  import.meta.url,
).href;

export interface WebShellBrowserNotificationsOptions {
  /** Initial preference when none is saved. Defaults to false; never requests permission automatically. */
  defaultEnabled?: boolean;
  /** Application name prefixed to notification titles. Defaults to QwenCode. */
  appName?: string;
  /** Image URL, including HTTPS CDN URLs. Defaults to the bundled Qwen Code icon. */
  iconUrl?: string;
}

interface BrowserTurnNotificationsProps {
  children: ReactNode;
  language: WebShellLanguage;
  options?: WebShellBrowserNotificationsOptions;
}

type Permission = NotificationPermission | 'unavailable';

interface BrowserNotificationSettings {
  enabled: boolean;
  permission: Permission;
  pending: boolean;
  persistent: boolean;
  error: boolean;
  setEnabled(enabled: boolean): Promise<void>;
  refreshPermission(): void;
  syncLanguage(language: WebShellLanguage): void;
}

const BrowserNotificationSettingsContext = createContext<
  BrowserNotificationSettings | undefined
>(undefined);

export function useBrowserNotificationSettings() {
  return useContext(BrowserNotificationSettingsContext);
}

function permission(): Permission {
  return window.isSecureContext && typeof window.Notification === 'function'
    ? window.Notification.permission
    : 'unavailable';
}

function readStoredPreference(): string | null | undefined {
  try {
    return window.localStorage.getItem(BROWSER_NOTIFICATIONS_STORAGE_KEY);
  } catch {
    return undefined;
  }
}

function readPreference(defaultEnabled: boolean) {
  const stored = readStoredPreference();
  return {
    enabled: stored === 'true' || (stored == null && defaultEnabled),
    persistent: stored !== undefined,
  };
}

function notificationExcerpt(text: string, limit: number): string {
  const plain = text
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/(\*\*|__|~~|`)(.*?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(plain);
  return chars.length > limit
    ? chars.slice(0, limit - 1).join('') + '…'
    : plain;
}

export function BrowserTurnNotifications({
  children,
  language,
  options,
}: BrowserTurnNotificationsProps) {
  if (typeof window === 'undefined' || window.top !== window.self)
    return <>{children}</>;
  return (
    <StandaloneNotifications language={language} options={options}>
      {children}
    </StandaloneNotifications>
  );
}

function StandaloneNotifications({
  children,
  language,
  options,
}: BrowserTurnNotificationsProps) {
  const [navigationTarget] = useState(() => new EventTarget());
  const [appLanguage, syncLanguage] = useState<WebShellLanguage>();
  const [defaultEnabled] = useState(options?.defaultEnabled ?? false);
  const [preference, setPreference] = useState(() =>
    readPreference(defaultEnabled),
  );
  const [currentPermission, setPermission] = useState(permission);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const enabledRef = useRef(preference.enabled);
  const version = useRef(0);
  const mounted = useRef(true);
  const notifyRef = useRef<(turn: TurnNotification) => void>(() => {});
  const [observer] = useState(() =>
    createTurnNotificationObserver((turn) => notifyRef.current(turn)),
  );
  const refreshPermission = useCallback(() => setPermission(permission()), []);
  const savePreference = useCallback((enabled: boolean) => {
    enabledRef.current = enabled;
    let persistent = true;
    try {
      window.localStorage.setItem(
        BROWSER_NOTIFICATIONS_STORAGE_KEY,
        String(enabled),
      );
    } catch {
      persistent = false;
    }
    setPreference({ enabled, persistent });
  }, []);

  useEffect(() => {
    mounted.current = true;
    const requestVersion = version;
    const sync = (event: StorageEvent) => {
      if (event.key !== null && event.key !== BROWSER_NOTIFICATIONS_STORAGE_KEY)
        return;
      version.current++;
      const next = readPreference(defaultEnabled);
      enabledRef.current = next.enabled;
      setPreference(next);
      setPending(false);
      refreshPermission();
    };
    window.addEventListener('storage', sync);
    window.addEventListener('focus', refreshPermission);
    return () => {
      mounted.current = false;
      requestVersion.current++;
      window.removeEventListener('storage', sync);
      window.removeEventListener('focus', refreshPermission);
    };
  }, [refreshPermission, defaultEnabled]);

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      const request = ++version.current;
      setError(false);
      if (!enabled) {
        setPending(false);
        savePreference(false);
        return;
      }
      const storedBeforeRequest = readStoredPreference();
      let nextPermission = permission();
      if (nextPermission === 'default') {
        setPending(true);
        try {
          nextPermission = await window.Notification.requestPermission();
        } catch {
          if (mounted.current && request === version.current) setError(true);
        }
      }
      if (!mounted.current || request !== version.current) return;
      setPending(false);
      setPermission(permission());
      if (readStoredPreference() !== storedBeforeRequest) {
        const next = readPreference(defaultEnabled);
        enabledRef.current = next.enabled;
        setPreference(next);
        return;
      }
      if (nextPermission === 'granted') savePreference(true);
    },
    [savePreference, defaultEnabled],
  );

  notifyRef.current = (turn) => {
    const request = version.current;
    const canShow = () =>
      mounted.current &&
      request === version.current &&
      enabledRef.current &&
      permission() === 'granted' &&
      (document.visibilityState !== 'visible' || !document.hasFocus());
    if (turn.outcome === 'cancelled' || !canShow()) return;
    const show = async () => {
      // Hash identities so notification tags and shared storage contain no paths.
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(turn.key),
      );
      const tag = `qwen-code-turn:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
      let attempted = false;
      const deliver = (shared: boolean) => {
        attempted = true;
        if (!canShow()) return;
        if (shared) {
          try {
            const raw: unknown = JSON.parse(
              window.localStorage.getItem(CLAIMS_STORAGE_KEY) ?? '[]',
            );
            const claims = Array.isArray(raw)
              ? raw
                  .filter((key): key is string => typeof key === 'string')
                  .slice(-MAX_CLAIMS)
              : [];
            if (claims.includes(tag)) return;
            window.localStorage.setItem(
              CLAIMS_STORAGE_KEY,
              JSON.stringify([...claims.slice(-(MAX_CLAIMS - 1)), tag]),
            );
          } catch {
            // Storage restrictions degrade to page-local deduplication and tag replacement.
          }
        }
        const t = getTranslator(appLanguage ?? language);
        const appName = options?.appName?.trim() || 'QwenCode';
        const title = notificationExcerpt(turn.sessionTitle ?? '', 60);
        const prompt = notificationExcerpt(turn.promptText ?? '', 80);
        const excerpt =
          turn.outcome === 'failed'
            ? ''
            : notificationExcerpt(turn.responseText ?? '', 120);
        const status = t(`browserNotifications.${turn.outcome}`);
        const notification = new window.Notification(
          title ? `${appName} · ${title}` : appName,
          {
            body: [
              status,
              prompt && t('browserNotifications.prompt', { text: prompt }),
              excerpt && t('browserNotifications.reply', { text: excerpt }),
            ]
              .filter(Boolean)
              .join('\n'),
            icon: options?.iconUrl?.trim() || NOTIFICATION_ICON_URL,
            tag,
            ...{ renotify: false },
          },
        );
        notification.onclick = () => {
          try {
            window.focus();
          } catch {
            // Browsers may deny focus even though the page can still navigate.
          }
          try {
            if (turn.target) {
              navigationTarget.dispatchEvent(
                new CustomEvent('qwen:open-session', { detail: turn.target }),
              );
            }
          } finally {
            notification.close();
          }
        };
        notification.onerror = () => {
          if (mounted.current) setError(true);
        };
      };
      if (navigator.locks) {
        try {
          await navigator.locks.request(CLAIMS_STORAGE_KEY, () =>
            deliver(true),
          );
        } catch (failure) {
          if (attempted) throw failure;
          deliver(false);
        }
      } else deliver(false);
    };
    void show().catch(() => {
      if (mounted.current) setError(true);
    });
  };

  return (
    <TurnNotificationNavigationContext.Provider value={navigationTarget}>
      <TurnNotificationContext.Provider value={observer}>
        <BrowserNotificationSettingsContext.Provider
          value={{
            ...preference,
            permission: currentPermission,
            pending,
            error,
            setEnabled,
            refreshPermission,
            syncLanguage,
          }}
        >
          {children}
        </BrowserNotificationSettingsContext.Provider>
      </TurnNotificationContext.Provider>
    </TurnNotificationNavigationContext.Provider>
  );
}

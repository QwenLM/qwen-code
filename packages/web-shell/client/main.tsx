import React from 'react';
import ReactDOM from 'react-dom/client';
import { useCallback, useEffect, useState } from 'react';
import { DaemonWorkspaceProvider } from '@qwen-code/webui/daemon-react-sdk';
import { ErrorBoundary } from './components/ErrorBoundary';
import { RootErrorFallback } from './components/RootErrorFallback';
import { WorkspaceSessionProvider } from './components/WorkspaceSessionProvider';
import {
  getDaemonBaseUrl,
  getDaemonToken,
  removeDaemonTokenFromUrl,
  waitForDaemonTokenMessage,
} from './config/daemon';
import { normalizeLanguage, type WebShellLanguage } from './i18n';
import { WebShellThemeId, type WebShellTheme } from './themeContext';
import { buildSessionPathname, parseSessionId } from './utils/sessionPath';
import type { SessionChangeEvent } from './App';
import type {
  WebShellHostSettingsCategory,
  WebShellHostSettingValue,
} from './hostSettings';
import 'katex/dist/katex.min.css';
import './styles/standalone.css';

const DAEMON_BASE_URL = getDaemonBaseUrl();

const LANGUAGE_STORAGE_KEY = 'qwen-code-web-shell-language';
const THEME_STORAGE_KEY = 'qwen-code-web-shell-theme';
const HOST_BRIDGE_READY_EVENT = 'qwen-code-host-ready';

type HostSettingsDescriptor = Omit<WebShellHostSettingsCategory, 'onChange'>;

interface StandaloneHostBridge {
  loadSettings: (language: string) => Promise<HostSettingsDescriptor[]>;
  setSetting: (key: string, value: WebShellHostSettingValue) => Promise<void>;
  onSettingsChanged?: (callback: () => void) => () => void;
  reportStreamingState?: (state: string) => void;
  reportSessionChange?: (event: {
    type: 'submit' | 'turn_complete';
    failed?: boolean;
  }) => void;
}

function standaloneHostBridge(): StandaloneHostBridge | undefined {
  return (window as unknown as { qwenCodeHost?: StandaloneHostBridge })
    .qwenCodeHost;
}

function useHostSettings(
  bridge: StandaloneHostBridge | undefined,
  language: WebShellLanguage,
): readonly WebShellHostSettingsCategory[] {
  const [categories, setCategories] = useState<
    readonly WebShellHostSettingsCategory[]
  >([]);
  const reload = useCallback(async () => {
    if (!bridge) {
      setCategories([]);
      return;
    }
    const loaded = await bridge.loadSettings(language);
    setCategories(
      loaded.map((category) => ({
        ...category,
        onChange: async (key, value) => {
          await bridge.setSetting(key, value);
          await reload();
        },
      })),
    );
  }, [bridge, language]);

  useEffect(() => {
    let disposed = false;
    void reload().catch(() => {
      if (!disposed) setCategories([]);
    });
    const unsubscribe = bridge?.onSettingsChanged?.(() => {
      if (!disposed) void reload();
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [bridge, reload]);

  return categories;
}

function parseTheme(value: string | null): WebShellTheme | undefined {
  if (value === WebShellThemeId.Dark || value === WebShellThemeId.Light) {
    return value;
  }
  return undefined;
}

function getThemeFromUrl(): WebShellTheme | undefined {
  const theme = new URLSearchParams(window.location.search).get('theme');
  return parseTheme(theme);
}

function readStoredTheme(): WebShellTheme | undefined {
  try {
    return parseTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return undefined;
  }
}

function storeTheme(theme: WebShellTheme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore storage failures in private browsing or locked-down browsers.
  }
}

function getInitialTheme(): WebShellTheme {
  return getThemeFromUrl() ?? readStoredTheme() ?? WebShellThemeId.Dark;
}

function readStoredLanguage(): WebShellLanguage | undefined {
  try {
    const raw = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return raw ? normalizeLanguage(raw) : undefined;
  } catch {
    return undefined;
  }
}

function storeLanguage(language: WebShellLanguage): void {
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Ignore storage failures in private browsing or locked-down browsers.
  }
}

function getInitialLanguage(): WebShellLanguage {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('language') ?? params.get('lang');
  if (raw) return normalizeLanguage(raw);
  return normalizeLanguage(readStoredLanguage() ?? navigator.language);
}

function getSessionIdFromUrl(): string | undefined {
  return parseSessionId(window.location.pathname);
}

function getWorkspaceIdFromUrl(): string | undefined {
  return (
    new URLSearchParams(window.location.search).get('workspace') || undefined
  );
}

function replaceStandaloneSessionUrl(
  sessionId: string | undefined,
  workspaceId?: string,
): void {
  const url = new URL(window.location.href);
  url.pathname = buildSessionPathname(url.pathname, sessionId);
  if (sessionId && workspaceId) {
    url.searchParams.set('workspace', workspaceId);
  } else {
    url.searchParams.delete('workspace');
  }
  // Strip one-shot query params so bookmarked / shared URLs do not
  // permanently override stored preferences on every page load.
  url.searchParams.delete('theme');
  url.searchParams.delete('language');
  url.searchParams.delete('lang');
  if (!import.meta.env.DEV) {
    url.searchParams.delete('token');
    url.searchParams.delete('daemon');
  }
  window.history.replaceState(null, '', url);
}

export function StandaloneApp({ daemonToken }: { daemonToken?: string }) {
  const [theme, setTheme] = useState<WebShellTheme>(() => getInitialTheme());
  const [language, setLanguage] = useState<WebShellLanguage>(() =>
    getInitialLanguage(),
  );
  const [sessionId, setSessionId] = useState<string | undefined>(() =>
    getSessionIdFromUrl(),
  );
  const [workspaceId, setWorkspaceId] = useState<string | undefined>(() =>
    getWorkspaceIdFromUrl(),
  );
  const [hostBridge, setHostBridge] = useState(standaloneHostBridge);
  const hostSettings = useHostSettings(hostBridge, language);
  const baseUrl = DAEMON_BASE_URL || window.location.origin;
  useEffect(() => {
    const updateHostBridge = () => setHostBridge(standaloneHostBridge());
    window.addEventListener(HOST_BRIDGE_READY_EVENT, updateHostBridge);
    return () =>
      window.removeEventListener(HOST_BRIDGE_READY_EVENT, updateHostBridge);
  }, []);
  // Keep the <html> theme class and <meta name="theme-color"> in sync with
  // the React theme so mobile status bars / overscroll backgrounds stay
  // consistent when the user toggles or when ?theme= lands via URL.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('theme-dark', 'theme-light', 'dark');
    root.classList.add(`theme-${theme}`);
    root.classList.toggle('dark', theme === WebShellThemeId.Dark);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute('content', theme === 'light' ? '#ffffff' : '#0d0d0d');
    }
  }, [theme]);
  const handleThemeChange = useCallback((nextTheme: WebShellTheme) => {
    setTheme(nextTheme);
    storeTheme(nextTheme);
  }, []);
  const handleLanguageChange = useCallback((nextLanguage: WebShellLanguage) => {
    setLanguage(nextLanguage);
    storeLanguage(nextLanguage);
  }, []);
  const handleSessionIdChange = useCallback(
    (nextSessionId?: string, nextWorkspaceId?: string) => {
      setSessionId(nextSessionId);
      setWorkspaceId(nextWorkspaceId);
      replaceStandaloneSessionUrl(nextSessionId, nextWorkspaceId);
    },
    [],
  );
  const handleSessionChange = useCallback(
    (event: SessionChangeEvent) => {
      if (event.type === 'submit') {
        hostBridge?.reportSessionChange?.({ type: 'submit' });
      } else if (event.type === 'turn_complete') {
        hostBridge?.reportSessionChange?.({
          type: 'turn_complete',
          failed: Boolean(event.error),
        });
      }
    },
    [hostBridge],
  );

  return (
    <ErrorBoundary
      label="web-shell-root"
      fallback={(error, reset) => (
        <RootErrorFallback error={error} onRetry={reset} language={language} />
      )}
    >
      <DaemonWorkspaceProvider baseUrl={baseUrl} token={daemonToken}>
        <WorkspaceSessionProvider
          sessionId={sessionId}
          workspaceId={workspaceId}
          webShellProps={{
            theme,
            onThemeChange: handleThemeChange,
            language,
            onLanguageChange: handleLanguageChange,
            onSessionIdChange: handleSessionIdChange,
            onSessionChange: hostBridge ? handleSessionChange : undefined,
            onStreamingStateChange: hostBridge
              ? (state) => hostBridge.reportStreamingState?.(state)
              : undefined,
            hostSettings: hostBridge ? hostSettings : undefined,
            sidebar: true,
            header: {
              items: ['title', 'environment', 'rightPanel'],
            },
            rightPanel: {
              items: ['review', 'sideTask'],
            },
            environmentPanel: {
              items: ['environment', 'subagents', 'backgroundTasks'],
            },
            compactThinking: true,
            markdownTableMode: 'advanced',
          }}
        />
      </DaemonWorkspaceProvider>
    </ErrorBoundary>
  );
}

async function main() {
  const daemonToken = getDaemonToken() ?? (await waitForDaemonTokenMessage());
  removeDaemonTokenFromUrl();

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <StandaloneApp daemonToken={daemonToken} />
    </React.StrictMode>,
  );
}

void main();

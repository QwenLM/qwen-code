import React from 'react';
import ReactDOM from 'react-dom/client';
import { useCallback, useState } from 'react';
import {
  DaemonWorkspaceProvider,
  DaemonSessionProvider,
} from '@qwen-code/webui/daemon-react-sdk';
import { App } from './App';
import {
  getDaemonBaseUrl,
  getDaemonToken,
  removeDaemonTokenFromUrl,
} from './config/daemon';
import { normalizeLanguage, type WebShellLanguage } from './i18n';
import { WebShellThemeId, type WebShellTheme } from './themeContext';
import 'katex/dist/katex.min.css';
import './styles/standalone.css';

const DAEMON_BASE_URL = getDaemonBaseUrl();
const DAEMON_TOKEN = getDaemonToken();
removeDaemonTokenFromUrl();

const LANGUAGE_STORAGE_KEY = 'qwen-code-web-shell-language';
const THEME_STORAGE_KEY = 'qwen-code-web-shell-theme';

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
  const match = window.location.pathname.match(/\/session\/([^/]+)/);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

function replaceSessionUrl(sessionId: string): void {
  const url = new URL(window.location.href);
  url.pathname = `/session/${encodeURIComponent(sessionId)}`;
  if (!import.meta.env.DEV) {
    url.searchParams.delete('token');
    url.searchParams.delete('daemon');
  }
  window.history.replaceState(null, '', url);
}

function StandaloneApp() {
  const [theme, setTheme] = useState<WebShellTheme>(() => getInitialTheme());
  const [language, setLanguage] = useState<WebShellLanguage>(() =>
    getInitialLanguage(),
  );
  const [sessionId, setSessionId] = useState<string | undefined>(() =>
    getSessionIdFromUrl(),
  );
  const baseUrl = DAEMON_BASE_URL || window.location.origin;
  const handleThemeChange = useCallback((nextTheme: WebShellTheme) => {
    setTheme(nextTheme);
    storeTheme(nextTheme);
  }, []);
  const handleLanguageChange = useCallback((nextLanguage: WebShellLanguage) => {
    setLanguage(nextLanguage);
    storeLanguage(nextLanguage);
  }, []);
  const handleSessionIdChange = useCallback((sessionId: string) => {
    setSessionId(sessionId);
    replaceSessionUrl(sessionId);
  }, []);

  return (
    <DaemonWorkspaceProvider baseUrl={baseUrl} token={DAEMON_TOKEN}>
      <DaemonSessionProvider
        key={sessionId ?? 'new'}
        initialSessionId={sessionId}
        suppressOwnUserEcho
      >
        <App
          theme={theme}
          onThemeChange={handleThemeChange}
          language={language}
          onLanguageChange={handleLanguageChange}
          onSessionIdChange={handleSessionIdChange}
          compactThinking
        />
      </DaemonSessionProvider>
    </DaemonWorkspaceProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <StandaloneApp />
  </React.StrictMode>,
);

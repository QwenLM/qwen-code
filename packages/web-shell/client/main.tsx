import React from 'react';
import ReactDOM from 'react-dom/client';
import { useCallback, useMemo, useState } from 'react';
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
import 'katex/dist/katex.min.css';
import './styles/standalone.css';

const DAEMON_BASE_URL = getDaemonBaseUrl();
const DAEMON_TOKEN = getDaemonToken();
removeDaemonTokenFromUrl();

const LANGUAGE_STORAGE_KEY = 'qwen-code-web-shell-language';
const THEME_STORAGE_KEY = 'qwen-code-web-shell-theme';
type StandaloneTheme = 'dark' | 'light';

function getThemeFromUrl(): StandaloneTheme | undefined {
  const theme = new URLSearchParams(window.location.search).get('theme');
  return theme === 'dark' || theme === 'light' ? theme : undefined;
}

function readStoredTheme(): StandaloneTheme | undefined {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return raw === 'dark' || raw === 'light' ? raw : undefined;
  } catch {
    return undefined;
  }
}

function storeTheme(theme: StandaloneTheme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore storage failures in private browsing or locked-down browsers.
  }
}

function getInitialTheme(): StandaloneTheme {
  return getThemeFromUrl() ?? readStoredTheme() ?? 'dark';
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

function StandaloneApp() {
  const [theme, setTheme] = useState<StandaloneTheme>(() => getInitialTheme());
  const [language, setLanguage] = useState<WebShellLanguage>(() =>
    getInitialLanguage(),
  );
  const initialSessionId = useMemo(() => getSessionIdFromUrl(), []);
  const baseUrl = DAEMON_BASE_URL || window.location.origin;
  const handleThemeChange = useCallback((nextTheme: StandaloneTheme) => {
    setTheme(nextTheme);
    storeTheme(nextTheme);
  }, []);
  const handleLanguageChange = useCallback((nextLanguage: WebShellLanguage) => {
    setLanguage(nextLanguage);
    storeLanguage(nextLanguage);
  }, []);

  return (
    <DaemonWorkspaceProvider baseUrl={baseUrl} token={DAEMON_TOKEN}>
      <DaemonSessionProvider
        initialSessionId={initialSessionId}
        suppressOwnUserEcho
      >
        <App
          theme={theme}
          onThemeChange={handleThemeChange}
          language={language}
          onLanguageChange={handleLanguageChange}
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

import React from 'react';
import ReactDOM from 'react-dom/client';
import { useCallback, useState } from 'react';
import { App } from './App';
import { removeDaemonTokenFromUrl } from './config/daemon';
import { normalizeLanguage, type WebShellLanguage } from './i18n';
import 'katex/dist/katex.min.css';
import './styles/standalone.css';

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

function StandaloneApp() {
  const [theme, setTheme] = useState<StandaloneTheme>(() => getInitialTheme());
  const [language, setLanguage] = useState<WebShellLanguage>(() =>
    getInitialLanguage(),
  );
  const handleThemeChange = useCallback((nextTheme: StandaloneTheme) => {
    setTheme(nextTheme);
    storeTheme(nextTheme);
  }, []);
  const handleLanguageChange = useCallback((nextLanguage: WebShellLanguage) => {
    setLanguage(nextLanguage);
    storeLanguage(nextLanguage);
  }, []);

  return (
    <App
      theme={theme}
      onThemeChange={handleThemeChange}
      language={language}
      onLanguageChange={handleLanguageChange}
    />
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <StandaloneApp />
  </React.StrictMode>,
);

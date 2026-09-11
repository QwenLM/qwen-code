// Load resets before any component can import CSS modules.
import './styles/globals.css';
import React from 'react';
import {
  isKnownDaemonTarget,
  WorkspaceHostsEnabled,
} from './config/workspace-hosts';
import ReactDOM from 'react-dom/client';
import { useCallback, useEffect, useState } from 'react';
import {
  DaemonWorkspaceProvider,
  type DaemonProductSessionContext,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { BrowserTurnNotifications } from './browser-turn-notifications';
import { ErrorBoundary } from './components/ErrorBoundary';
import { StandaloneAuth } from './components/StandaloneAuth';
import { RootErrorFallback } from './components/RootErrorFallback';
import { WorkspaceSessionProvider } from './components/WorkspaceSessionProvider';
import {
  getDaemonBaseUrl,
  getDaemonToken,
  hasReloadSurvivableDaemonToken,
  removeDaemonTokenFromUrl,
  waitForDaemonTokenMessage,
} from './config/daemon';
import { normalizeLanguage, type WebShellLanguage } from './i18n';
import { WebShellThemeId, type WebShellTheme } from './themeContext';
import { DEFAULT_BRAND_NAME, type WebShellResolvedBrand } from './brandContext';
import { buildSessionPathname, parseSessionId } from './utils/sessionPath';
import 'katex/dist/katex.min.css';
import './styles/standalone.css';

const DAEMON_BASE_URL = getDaemonBaseUrl();
const REQUESTED_DAEMON_TARGET =
  new URLSearchParams(window.location.search).get('daemon') || '';
const INVALID_DAEMON_TARGET =
  Boolean(REQUESTED_DAEMON_TARGET) && !DAEMON_BASE_URL;
// A `?daemon=` link can name any origin; one this browser has never connected
// to is shown for confirmation instead of being probed on load.
const UNCONFIRMED_DAEMON_TARGET =
  Boolean(DAEMON_BASE_URL) && !isKnownDaemonTarget(DAEMON_BASE_URL);

const STANDALONE_COMPOSER_TOOLBAR_ADDITIONS = ['addMenu', 'plan'] as const;

const LANGUAGE_STORAGE_KEY = 'qwen-code-web-shell-language';
const THEME_STORAGE_KEY = 'qwen-code-web-shell-theme';
const BRAND_STORAGE_KEY = 'qwen-code-web-shell-brand';

/**
 * Cached for index.html's pre-paint script so a renamed deployment does not
 * flash the built-in title on every load. Mirrors THEME_STORAGE_KEY.
 */
interface StoredBrand {
  title?: string;
  logo?: string;
}

function webShellDocumentTitle(name?: string): string {
  // Truthiness, not `??`: an empty name means the built-in one, matching
  // useBrandName(), so the tab can never become " Web chat".
  return `${name || DEFAULT_BRAND_NAME} Web chat`;
}

const DEFAULT_DOCUMENT_TITLE = webShellDocumentTitle(undefined);

function storeBrand(brand: WebShellResolvedBrand): void {
  try {
    const title = webShellDocumentTitle(brand.name);
    if (title === DEFAULT_DOCUMENT_TITLE && !brand.logoDataUri) {
      window.localStorage.removeItem(BRAND_STORAGE_KEY);
      return;
    }
    const stored: StoredBrand = { title };
    if (brand.logoDataUri) stored.logo = brand.logoDataUri;
    window.localStorage.setItem(BRAND_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Ignore storage failures in private browsing or locked-down browsers.
  }
}

/**
 * Apply the resolved brand to the browser tab.
 *
 * Only the standalone entry does this: an embedded shell must not hijack its
 * host page's title or favicon. A removed logo cannot be undone here, because
 * the built-in favicon lives in index.html and is not recoverable once
 * overwritten — clearing the cache instead lets the next load restore it.
 */
function applyBrandToDocument(brand: WebShellResolvedBrand): void {
  document.title = webShellDocumentTitle(brand.name);
  if (brand.logoDataUri) {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link) link.href = brand.logoDataUri;
  }
  storeBrand(brand);
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

function getSessionContextFromUrl(): DaemonProductSessionContext | undefined {
  const context = new URLSearchParams(window.location.search).get('context');
  return context === 'standalone' || context === 'live'
    ? { kind: context }
    : undefined;
}

function replaceStandaloneSessionUrl(
  sessionId: string | undefined,
  workspaceId?: string,
  sessionContext?: DaemonProductSessionContext,
): void {
  const url = new URL(window.location.href);
  url.pathname = buildSessionPathname(url.pathname, sessionId);
  if (
    sessionId &&
    (sessionContext?.kind === 'standalone' || sessionContext?.kind === 'live')
  ) {
    url.searchParams.set('context', sessionContext.kind);
    url.searchParams.delete('workspace');
  } else if (sessionId && workspaceId) {
    url.searchParams.set('workspace', workspaceId);
    url.searchParams.delete('context');
  } else {
    url.searchParams.delete('workspace');
    url.searchParams.delete('context');
  }
  // Strip one-shot query params so bookmarked / shared URLs do not
  // permanently override stored preferences on every page load.
  url.searchParams.delete('theme');
  url.searchParams.delete('language');
  url.searchParams.delete('lang');
  // Boot already scrubbed ?token= (dev included), so drop it here too.
  // `daemon` is connection identity, not a one-shot preference: keep it so
  // session navigation and refresh stay on the selected remote daemon.
  url.searchParams.delete('token');
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
  const [sessionContext, setSessionContext] = useState<
    DaemonProductSessionContext | undefined
  >(() => getSessionContextFromUrl());
  const baseUrl = DAEMON_BASE_URL || window.location.origin;
  // One-shot ?theme=/?language=/?lang= params are consumed by the useState
  // initializers above; strip them once mounted so a bookmarked URL cannot
  // keep overriding stored preferences on later loads. (The reload retry
  // re-adds the live values, which the next boot consumes and strips again.)
  useEffect(() => {
    const url = new URL(window.location.href);
    const before = url.search;
    url.searchParams.delete('theme');
    url.searchParams.delete('language');
    url.searchParams.delete('lang');
    if (url.search !== before) {
      window.history.replaceState(null, '', url);
    }
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
  const handleBrandResolved = useCallback((brand: WebShellResolvedBrand) => {
    applyBrandToDocument(brand);
  }, []);
  const handleSessionIdChange = useCallback(
    (
      nextSessionId?: string,
      nextWorkspaceId?: string,
      _nextWorkspaceCwd?: string,
      nextSessionContext?: DaemonProductSessionContext,
    ) => {
      setSessionId(nextSessionId);
      const nonWorkspaceContext =
        nextSessionContext?.kind === 'standalone' ||
        nextSessionContext?.kind === 'live'
          ? nextSessionContext
          : undefined;
      setSessionContext(nonWorkspaceContext);
      setWorkspaceId(nonWorkspaceContext ? undefined : nextWorkspaceId);
      replaceStandaloneSessionUrl(
        nextSessionId,
        nextWorkspaceId,
        nonWorkspaceContext,
      );
    },
    [],
  );

  return (
    <ErrorBoundary
      label="web-shell-root"
      fallback={(error, reset) => {
        // A reload rebuilds the module graph — the only recovery for a crash
        // rooted in page-level module state (e.g. a duplicated context module
        // in dev). Reload is only safe when it cannot strand a credential:
        // either no token was resolved at boot (tokenless trusted loopback —
        // nothing to strand; reads the prop, never getDaemonToken(), whose
        // in-memory cache always reports a token after boot), or a token
        // survives in the URL or per-tab storage. Otherwise fall back to an
        // in-place reset, which keeps the in-memory token.
        const canReload = !daemonToken || hasReloadSurvivableDaemonToken();
        return (
          <RootErrorFallback
            error={error}
            onRetry={() => {
              if (!canReload) {
                reset();
                return;
              }
              // Session switches strip the one-shot theme/language params
              // from the URL; carry the live values so the reloaded page
              // comes back as the user had it.
              const url = new URL(window.location.href);
              url.searchParams.set('theme', theme);
              url.searchParams.set('language', language);
              window.history.replaceState(null, '', url);
              window.location.reload();
            }}
            retryMode={canReload ? 'reload' : 'reset'}
            language={language}
          />
        );
      }}
    >
      <BrowserTurnNotifications
        language={language}
        options={{ defaultEnabled: true }}
      >
        <WorkspaceHostsEnabled.Provider value={true}>
          <DaemonWorkspaceProvider baseUrl={baseUrl} token={daemonToken}>
            <WorkspaceSessionProvider
              sessionId={sessionId}
              workspaceId={workspaceId}
              sessionContext={sessionContext}
              webShellProps={{
                theme,
                onThemeChange: handleThemeChange,
                language,
                onLanguageChange: handleLanguageChange,
                onBrandResolved: handleBrandResolved,
                onSessionIdChange: handleSessionIdChange,
                sidebar: { enabled: true, showLive: true },
                header: {
                  items: [
                    'title',
                    'environment',
                    'rightPanel',
                    'tokenUsage',
                    'contextUsage',
                  ],
                },
                rightPanel: {
                  items: ['review', 'sideTask', 'terminal'],
                },
                environmentPanel: {
                  items: [
                    'environment',
                    'sources',
                    'subagents',
                    'backgroundTasks',
                    'attachments',
                    'artifacts',
                  ],
                },
                compactThinking: true,
                markdownTableMode: 'advanced',
                composerToolbarAdditionalActions:
                  STANDALONE_COMPOSER_TOOLBAR_ADDITIONS,
              }}
            />
          </DaemonWorkspaceProvider>
        </WorkspaceHostsEnabled.Provider>
      </BrowserTurnNotifications>
    </ErrorBoundary>
  );
}

async function main() {
  const baseUrl = DAEMON_BASE_URL || window.location.origin;
  const storedToken = INVALID_DAEMON_TARGET
    ? undefined
    : getDaemonToken(baseUrl);
  const daemonToken =
    storedToken ??
    (!INVALID_DAEMON_TARGET && baseUrl === window.location.origin
      ? await waitForDaemonTokenMessage()
      : undefined);
  removeDaemonTokenFromUrl();

  const container = document.getElementById('root');
  // Boot can outlast the watchdog's grace period (a slow daemon, a token
  // handshake that only completes after a restart settles), in which case
  // index.html's fallback panel is already in #root. React appends to the
  // container rather than replacing it, so drop the panel here — otherwise
  // the recovered app renders below a full-viewport "failed to load" screen.
  container?.querySelector('[data-boot-fallback]')?.remove();

  ReactDOM.createRoot(container!).render(
    <React.StrictMode>
      <StandaloneAuth
        baseUrl={baseUrl}
        initialToken={daemonToken}
        initialAddress={REQUESTED_DAEMON_TARGET || baseUrl}
        language={getInitialLanguage()}
        theme={getInitialTheme()}
        invalidTarget={INVALID_DAEMON_TARGET}
        unconfirmedTarget={UNCONFIRMED_DAEMON_TARGET}
      >
        {(token) => <StandaloneApp daemonToken={token} />}
      </StandaloneAuth>
    </React.StrictMode>,
  );
}

void main();

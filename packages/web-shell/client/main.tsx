// Load resets before any component can import CSS modules.
import './styles/globals.css';
import React from 'react';
import { scheduleServiceWorkerRegistration } from './pwa-registration.js';
import { StandaloneContext } from './config/standalone';
import { isKnownDaemonTarget } from './config/daemon';
import { isRemoteConnectionKnown } from './config/remote-connections';
import { exchangePairingCode } from './config/pairing';
import ReactDOM from 'react-dom/client';
import { useCallback, useEffect, useState } from 'react';
import { DaemonWorkspaceProvider } from '@qwen-code/web-shell/daemon-react-sdk';
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
import { inferStandaloneBasePath } from './utils/sessionPath';

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
  Boolean(DAEMON_BASE_URL) &&
  !isKnownDaemonTarget(DAEMON_BASE_URL) &&
  !isRemoteConnectionKnown(DAEMON_BASE_URL);

const STANDALONE_COMPOSER_TOOLBAR_ADDITIONS = ['addMenu', 'plan'] as const;

const LANGUAGE_STORAGE_KEY = 'qwen-code-web-shell-language';
const THEME_STORAGE_KEY = 'qwen-code-web-shell-theme';
const BRAND_STORAGE_KEY = 'qwen-code-web-shell-brand';
const MACOS_TITLEBAR_CLASS = 'qwen-code-macos-titlebar';

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

function hasMacOSOverlayTitlebar(): boolean {
  return (
    (window as Window & { __QWEN_CODE_MACOS_TITLEBAR__?: boolean })
      .__QWEN_CODE_MACOS_TITLEBAR__ === true
  );
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

/**
 * The standalone entry's own opinion on the theme: an explicit `?theme=`
 * param or a value the user previously chose in-app. `undefined` means "no
 * opinion" — App then resolves the daemon's effective `ui.theme` setting
 * instead of being shadowed by a built-in default (#11955).
 */
function getInitialTheme(): WebShellTheme | undefined {
  return getThemeFromUrl() ?? readStoredTheme();
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

/**
 * Same "no opinion" contract as getInitialTheme(): only an explicit
 * `?language=`/`?lang=` param or a stored in-app choice counts. Without one,
 * App falls through to the daemon's effective `general.language` setting.
 */
function getInitialLanguage(): WebShellLanguage | undefined {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('language') ?? params.get('lang');
  if (raw) return normalizeLanguage(raw);
  return readStoredLanguage();
}

export function StandaloneApp({ daemonToken }: { daemonToken?: string }) {
  const macosOverlayTitlebar = hasMacOSOverlayTitlebar();
  // The entry's own opinion — an explicit URL param or a stored in-app
  // choice. Passed down as the `theme`/`language` host props; `undefined`
  // lets App resolve the daemon's effective settings instead (#11955).
  const [theme, setTheme] = useState<WebShellTheme | undefined>(() =>
    getInitialTheme(),
  );
  const [language, setLanguage] = useState<WebShellLanguage | undefined>(() =>
    getInitialLanguage(),
  );
  // What document chrome (html class, theme-color, notifications, error
  // copy) should render with: the entry's own opinion when it has one, else
  // the value App resolved from settings and reports through
  // onThemeResolved/onLanguageResolved. Kept out of the props so a
  // settings-derived value never latches as a host override.
  const [documentTheme, setDocumentTheme] = useState<WebShellTheme>(
    () => theme ?? WebShellThemeId.Dark,
  );
  const [documentLanguage, setDocumentLanguage] = useState<WebShellLanguage>(
    () => language ?? normalizeLanguage(navigator.language),
  );
  const [navigationBasePath] = useState(() =>
    inferStandaloneBasePath(window.location.pathname),
  );
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
      window.history.replaceState(window.history.state, '', url);
    }
  }, []);
  // Keep the <html> theme class and <meta name="theme-color"> in sync with
  // the effective theme so mobile status bars / overscroll backgrounds stay
  // consistent when the user toggles or when ?theme= lands via URL. While
  // settings have not resolved yet, retain index.html's pre-paint default.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('theme-dark', 'theme-light', 'dark');
    root.classList.add(`theme-${documentTheme}`);
    root.classList.toggle('dark', documentTheme === WebShellThemeId.Dark);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute(
        'content',
        documentTheme === 'light' ? '#ffffff' : '#0d0d0d',
      );
    }
  }, [documentTheme]);
  // A user's in-app choice becomes the entry's own opinion: it overrides
  // settings on later loads and is persisted for the pre-paint script.
  const handleThemeChange = useCallback((nextTheme: WebShellTheme) => {
    setTheme(nextTheme);
    setDocumentTheme(nextTheme);
    storeTheme(nextTheme);
  }, []);
  const handleLanguageChange = useCallback((nextLanguage: WebShellLanguage) => {
    setLanguage(nextLanguage);
    setDocumentLanguage(nextLanguage);
    storeLanguage(nextLanguage);
  }, []);
  // A settings-derived value only steers document chrome — it must not
  // become the entry's opinion (no prop, no localStorage), or the next
  // settings.json edit would be shadowed by the stale copy.
  const handleThemeResolved = useCallback((nextTheme: WebShellTheme) => {
    setDocumentTheme(nextTheme);
  }, []);
  const handleLanguageResolved = useCallback(
    (nextLanguage: WebShellLanguage) => {
      setDocumentLanguage(nextLanguage);
    },
    [],
  );
  const handleBrandResolved = useCallback((brand: WebShellResolvedBrand) => {
    applyBrandToDocument(brand);
  }, []);

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
              // comes back as the user had it. Only the entry's own opinion
              // is carried — a settings-derived value is left out so the
              // reloaded page keeps following settings.json.
              const url = new URL(window.location.href);
              if (theme !== undefined) url.searchParams.set('theme', theme);
              if (language !== undefined)
                url.searchParams.set('language', language);
              window.history.replaceState(window.history.state, '', url);
              window.location.reload();
            }}
            retryMode={canReload ? 'reload' : 'reset'}
            language={documentLanguage}
          />
        );
      }}
    >
      {macosOverlayTitlebar && (
        <div
          className="qwen-code-macos-titlebar-drag-region"
          data-tauri-drag-region=""
          aria-hidden="true"
        />
      )}
      <BrowserTurnNotifications
        language={documentLanguage}
        options={{ defaultEnabled: true }}
      >
        <StandaloneContext.Provider value={true}>
          <DaemonWorkspaceProvider baseUrl={baseUrl} token={daemonToken}>
            <WorkspaceSessionProvider
              urlNavigation={{ basePath: navigationBasePath }}
              chromeTheme={documentTheme}
              chromeLanguage={documentLanguage}
              webShellProps={{
                theme,
                onThemeChange: handleThemeChange,
                onThemeResolved: handleThemeResolved,
                language,
                onLanguageChange: handleLanguageChange,
                onLanguageResolved: handleLanguageResolved,
                onBrandResolved: handleBrandResolved,
                sidebar: { enabled: true, showLive: true },
                className: macosOverlayTitlebar
                  ? MACOS_TITLEBAR_CLASS
                  : undefined,
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
                  items: [
                    'review',
                    'sideTask',
                    'terminal',
                    'webPreview',
                    'trajectory',
                  ],
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
        </StandaloneContext.Provider>
      </BrowserTurnNotifications>
    </ErrorBoundary>
  );
}

async function main() {
  const baseUrl = DAEMON_BASE_URL || window.location.origin;
  const storedToken = INVALID_DAEMON_TARGET
    ? undefined
    : getDaemonToken(baseUrl);
  if (INVALID_DAEMON_TARGET) {
    // Keep a fragment token for recovery, but never leave a server-visible
    // query token in the address bar or history.
    const url = new URL(window.location.href);
    if (url.searchParams.has('token')) {
      url.searchParams.delete('token');
      window.history.replaceState(window.history.state, '', url);
    }
  } else {
    removeDaemonTokenFromUrl();
  }
  // The native bootstrap may declare the WebView unsupported. Scrub a URL
  // token first, but leave its update message in place instead of mounting
  // React or waiting for the daemon-token handshake.
  if (
    document.documentElement.hasAttribute('data-web-shell-unsupported-browser')
  )
    return;
  const pairing = await exchangePairingCode(
    INVALID_DAEMON_TARGET ? '' : baseUrl,
  );
  const daemonToken =
    pairing?.token ??
    storedToken ??
    (!INVALID_DAEMON_TARGET && baseUrl === window.location.origin
      ? await waitForDaemonTokenMessage()
      : undefined);

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
        pairingFailed={Boolean(pairing?.failed)}
        // The auth gate renders before settings are reachable, so it keeps
        // the browser-locale default; the app itself now receives "no
        // opinion" (undefined) and lets the daemon's settings win.
        language={getInitialLanguage() ?? normalizeLanguage(navigator.language)}
        initialAddress={REQUESTED_DAEMON_TARGET || baseUrl}
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

// Deferred to `load` so registration does not compete with the initial module
// graph. The helper also guards secure-context and service-worker support.
scheduleServiceWorkerRegistration({ production: import.meta.env.PROD });

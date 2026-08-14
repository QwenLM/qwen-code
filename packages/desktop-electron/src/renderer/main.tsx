/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  StrictMode,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  WebShellWithProviders,
  type WebShellLanguage,
  type WebShellTheme,
} from '@qwen-code/web-shell';
import './desktop.css';
import type {
  ChatLaunchConfig,
  DesktopBrowserState,
  DesktopLaunchConfig,
  DesktopLiveStatus,
} from '../shared/types';
import {
  readChatNavigation,
  writeChatNavigation,
} from '../shared/chat-navigation';

const LANGUAGE_STORAGE_KEY = 'qwen-code-web-shell-language';
const THEME_STORAGE_KEY = 'qwen-code-web-shell-theme';

function initialTheme(): WebShellTheme {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === 'light'
      ? 'light'
      : 'dark';
  } catch {
    return 'dark';
  }
}

function initialLanguage(): WebShellLanguage {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  } catch {
    // Use the browser language when storage is unavailable.
  }
  if (stored === 'zh' || stored === 'zh-CN' || stored === 'zh-cn') {
    return 'zh-CN';
  }
  if (stored === 'en') return 'en';
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

function DesktopWebShell({ config }: { config: ChatLaunchConfig }) {
  const [theme, setTheme] = useState<WebShellTheme>(initialTheme);
  const [language, setLanguage] = useState<WebShellLanguage>(initialLanguage);
  const [navigation] = useState(() => readChatNavigation(window.location.href));

  useEffect(() => {
    document.documentElement.classList.toggle('theme-light', theme === 'light');
    document.documentElement.classList.toggle('theme-dark', theme === 'dark');
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'light' ? '#ffffff' : '#0d0d0d');
  }, [theme]);

  const handleThemeChange = useCallback((nextTheme: WebShellTheme) => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch {
      // The in-memory preference still applies for this window.
    }
    setTheme(nextTheme);
  }, []);

  const handleLanguageChange = useCallback((nextLanguage: WebShellLanguage) => {
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, nextLanguage);
    } catch {
      // The in-memory preference still applies for this window.
    }
    setLanguage(nextLanguage);
  }, []);

  const handleSessionIdChange = useCallback(
    (sessionId?: string, workspaceId?: string) => {
      window.history.replaceState(
        null,
        '',
        writeChatNavigation(window.location.href, { sessionId, workspaceId }),
      );
    },
    [],
  );

  return (
    <div className="desktop-shell">
      <header className="desktop-toolbar">
        <span className="desktop-toolbar__product">Qwen Code</span>
        <span className="desktop-toolbar__workspace" title={config.workspace}>
          {config.workspace.split(/[\\/]/).pop() || config.workspace}
        </span>
        <span className="desktop-toolbar__spacer" />
        <button
          type="button"
          className="desktop-toolbar__button"
          onClick={() => void window.qwenDesktop.newChatWindow()}
        >
          New window
        </button>
        <button
          type="button"
          className="desktop-toolbar__button desktop-toolbar__button--primary"
          onClick={() => void window.qwenDesktop.openBrowser()}
        >
          Browser
        </button>
        <button
          type="button"
          className="desktop-toolbar__button"
          onClick={() => void window.qwenDesktop.showVoiceOverlay()}
        >
          Voice
        </button>
      </header>
      <div className="desktop-shell__content">
        <WebShellWithProviders
          baseUrl={config.daemonBaseUrl}
          token={config.daemonToken}
          sessionId={navigation.sessionId}
          workspaceId={navigation.workspaceId}
          lockWorkspaceCwd={config.workspace}
          theme={theme}
          onThemeChange={handleThemeChange}
          language={language}
          onLanguageChange={handleLanguageChange}
          onSessionIdChange={handleSessionIdChange}
          sidebar
          header={{ items: ['title', 'environment', 'rightPanel'] }}
          rightPanel={{ items: ['review', 'sideTask'] }}
          environmentPanel={{
            items: ['environment', 'subagents', 'backgroundTasks'],
          }}
          compactThinking
          markdownTableMode="advanced"
        />
      </div>
    </div>
  );
}

function liveIsActive(status: DesktopLiveStatus | undefined): boolean {
  return Boolean(
    status &&
      ['starting', 'listening', 'thinking', 'speaking', 'stopping'].includes(
        status.state,
      ),
  );
}

function VoiceOverlay() {
  const [status, setStatus] = useState<DesktopLiveStatus>();
  const [error, setError] = useState<string>();
  const [mutating, setMutating] = useState(false);

  useEffect(() => {
    let mounted = true;
    let timer: number | undefined;
    const refresh = async () => {
      await window.qwenDesktop
        .getLiveStatus()
        .then((next) => {
          if (!mounted) return;
          setStatus(next);
          setError(undefined);
        })
        .catch((reason) => {
          if (!mounted) return;
          setError(reason instanceof Error ? reason.message : String(reason));
        });
      if (mounted) timer = window.setTimeout(() => void refresh(), 1_000);
    };
    void refresh();
    return () => {
      mounted = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  const mutate = (operation: () => Promise<DesktopLiveStatus>) => {
    setMutating(true);
    setError(undefined);
    void operation()
      .then(setStatus)
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => setMutating(false));
  };
  const active = liveIsActive(status);
  const stateText =
    status?.statusText ??
    (status?.state === 'listening'
      ? 'Listening…'
      : status?.state === 'thinking'
        ? 'Thinking…'
        : status?.state === 'speaking'
          ? 'Speaking…'
          : status?.state === 'starting'
            ? 'Starting…'
            : status?.available
              ? 'Ready for voice chat'
              : 'Voice needs setup');

  return (
    <main className="voice-overlay" data-state={status?.state ?? 'unavailable'}>
      <header className="voice-overlay__header">
        <span className="voice-overlay__title">Qwen Voice</span>
        {status?.shortcut ? (
          <span className="voice-overlay__shortcut">{status.shortcut}</span>
        ) : null}
        <button
          type="button"
          className="voice-overlay__close"
          aria-label="Close voice overlay"
          onClick={() => void window.qwenDesktop.closeVoiceOverlay()}
        >
          ×
        </button>
      </header>
      <section className="voice-overlay__body">
        <div className="voice-overlay__state">
          <span className="voice-overlay__orb" />
          <span>{stateText}</span>
        </div>
        {status?.transcript ? (
          <p className="voice-overlay__transcript" data-role="user">
            {status.transcript}
          </p>
        ) : null}
        {status?.caption ? (
          <p className="voice-overlay__transcript" data-role="assistant">
            {status.caption}
          </p>
        ) : null}
        {error || status?.message ? (
          <p className="voice-overlay__message">{error ?? status?.message}</p>
        ) : null}
      </section>
      <footer className="voice-overlay__controls">
        {!active ? (
          <>
            <button
              type="button"
              disabled={!status?.available || mutating}
              onClick={() =>
                mutate(() => window.qwenDesktop.startLive('resume'))
              }
            >
              Start
            </button>
            <button
              type="button"
              disabled={!status?.available || mutating}
              onClick={() => mutate(() => window.qwenDesktop.startLive('new'))}
            >
              New
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={mutating}
              onClick={() =>
                mutate(() =>
                  window.qwenDesktop.setLiveMute({
                    inputMuted: !status?.inputMuted,
                  }),
                )
              }
            >
              {status?.inputMuted ? 'Unmute mic' : 'Mute mic'}
            </button>
            <button
              type="button"
              disabled={mutating}
              onClick={() => mutate(window.qwenDesktop.stopLive)}
            >
              Stop
            </button>
          </>
        )}
        {!status?.available ? (
          <button
            type="button"
            onClick={() => void window.qwenDesktop.newChatWindow()}
          >
            Open Qwen
          </button>
        ) : null}
      </footer>
    </main>
  );
}

const EMPTY_BROWSER_STATE: DesktopBrowserState = {
  canGoBack: false,
  canGoForward: false,
  loading: true,
  title: 'Browser',
  url: '',
};

function BrowserChrome() {
  const [state, setState] = useState(EMPTY_BROWSER_STATE);
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string>();
  const editingRef = useRef(false);

  useEffect(() => {
    const dispose = window.qwenDesktop.onBrowserState((next) => {
      setState(next);
      if (!editingRef.current) setAddress(next.url);
    });
    void window.qwenDesktop.getBrowserState().then((next) => {
      setState(next);
      setAddress(next.url);
    });
    return dispose;
  }, []);

  const navigate = (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    void window.qwenDesktop
      .navigateBrowser(address)
      .then((next) => {
        setState(next);
        setAddress(next.url);
        editingRef.current = false;
      })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  };

  return (
    <main className="browser-chrome">
      <button
        type="button"
        className="browser-chrome__button"
        aria-label="Go back"
        disabled={!state.canGoBack}
        onClick={() => void window.qwenDesktop.goBackBrowser()}
      >
        ←
      </button>
      <button
        type="button"
        className="browser-chrome__button"
        aria-label="Go forward"
        disabled={!state.canGoForward}
        onClick={() => void window.qwenDesktop.goForwardBrowser()}
      >
        →
      </button>
      <button
        type="button"
        className="browser-chrome__button"
        aria-label="Reload"
        onClick={() => void window.qwenDesktop.reloadBrowser()}
      >
        {state.loading ? '×' : '↻'}
      </button>
      <form className="browser-chrome__form" onSubmit={navigate}>
        <input
          className="browser-chrome__address"
          aria-label="Browser address"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={address}
          onBlur={() => {
            editingRef.current = false;
          }}
          onChange={(event) => setAddress(event.target.value)}
          onFocus={(event) => {
            editingRef.current = true;
            event.currentTarget.select();
          }}
        />
      </form>
      {error ? (
        <span className="browser-chrome__error" title={error}>
          {error}
        </span>
      ) : (
        <span className="browser-chrome__title" title={state.title}>
          {state.title}
        </span>
      )}
      <button
        type="button"
        className="browser-chrome__qwen"
        onClick={() => void window.qwenDesktop.newChatWindow()}
      >
        Qwen
      </button>
    </main>
  );
}

function Bootstrap() {
  const [config, setConfig] = useState<DesktopLaunchConfig>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    window.qwenDesktop
      .getLaunchConfig()
      .then(setConfig)
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }, []);

  if (error) {
    return (
      <main className="desktop-loading">
        <p className="desktop-loading__message">
          Qwen Code could not start: {error}
        </p>
      </main>
    );
  }
  if (!config) {
    return (
      <main className="desktop-loading">
        <p className="desktop-loading__message">Starting Qwen Code…</p>
      </main>
    );
  }
  if (config.kind === 'browser') return <BrowserChrome />;
  if (config.kind === 'voice-overlay') return <VoiceOverlay />;
  return <DesktopWebShell config={config} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Bootstrap />
  </StrictMode>,
);

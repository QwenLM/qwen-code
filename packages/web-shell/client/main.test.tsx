// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonProductSessionContext } from '@qwen-code/web-shell/daemon-react-sdk';
import type { WebShellProps } from './App';
import { useBrowserNotificationSettings } from './browser-turn-notifications';
import type { WebShellResolvedBrand } from './brandContext';
import { extractInlineScript, readIndexHtml } from './test/indexHtmlTestUtils';

interface CapturedWorkspaceSessionProps {
  urlNavigation?: { basePath?: string };
  sessionId?: string;
  workspaceId?: string;
  sessionContext?: DaemonProductSessionContext;
  chromeTheme?: WebShellProps['theme'];
  chromeLanguage?: WebShellProps['language'];
  webShellProps: WebShellProps;
}

const testState = vi.hoisted(() => ({
  props: undefined as CapturedWorkspaceSessionProps | undefined,
  notificationEnabled: undefined as boolean | undefined,
  throwOnRender: false,
  tokenSurvivesReload: true,
  renderCount: 0,
}));

vi.mock('react-dom/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom/client')>()),
  default: { createRoot: () => ({ render: vi.fn() }) },
}));
vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  DaemonWorkspaceProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('./components/WorkspaceSessionProvider', () => ({
  WorkspaceSessionProvider: (props: CapturedWorkspaceSessionProps) => {
    testState.renderCount += 1;
    if (testState.throwOnRender) {
      throw new Error('render boom');
    }
    testState.props = props;
    testState.notificationEnabled = useBrowserNotificationSettings()?.enabled;
    return null;
  },
}));
vi.mock('./config/daemon', () => ({
  getDaemonBaseUrl: () => '',
  getAllowedDaemonOrigin: (value: string) => value,
  confirmDaemonTarget: vi.fn(),
  isKnownDaemonTarget: () => false,
  getDaemonToken: () => 'token',
  hasReloadSurvivableDaemonToken: () => testState.tokenSurvivesReload,
  navigateToDaemon: vi.fn(),
  persistDaemonToken: vi.fn(),
  removeDaemonTokenFromUrl: vi.fn(),
  waitForDaemonTokenMessage: vi.fn(),
}));

import { StandaloneApp } from './main';

describe('StandaloneApp', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    testState.props = undefined;
    testState.throwOnRender = false;
    testState.tokenSurvivesReload = true;
    testState.renderCount = 0;
    delete (window as Window & { __QWEN_CODE_MACOS_TITLEBAR__?: boolean })
      .__QWEN_CODE_MACOS_TITLEBAR__;
    window.history.replaceState(null, '', '/');
    // jsdom's document is shared across the file; never let one test's
    // document chrome leak into the next test's assertions.
    document.documentElement.classList.remove(
      'theme-dark',
      'theme-light',
      'dark',
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    // A failing assertion mid-test must not leak the console.error spy into
    // later tests in this file.
    vi.restoreAllMocks();
  });

  it('reloads the page when the root error fallback retry is clicked', () => {
    testState.throwOnRender = true;
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    // The boundary logs the caught error; keep the test output clean.
    vi.spyOn(console, 'error').mockImplementation(() => {});

    act(() => root.render(<StandaloneApp daemonToken="token" />));

    const retry = container.querySelector('button');
    expect(retry?.textContent).toBe('Reload page');
    expect(reload).not.toHaveBeenCalled();

    act(() => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('falls back to an in-place reset when the token cannot survive a reload', () => {
    testState.throwOnRender = true;
    testState.tokenSurvivesReload = false;
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    act(() => root.render(<StandaloneApp daemonToken="token" />));

    const retry = container.querySelector('button');
    expect(retry?.textContent).toBe('Try again');
    // React replays a throwing render before the boundary catches it, so pin
    // the delta across the retry, not an absolute render count.
    const rendersBeforeRetry = testState.renderCount;

    // The transient cause is gone by the time the user retries.
    testState.throwOnRender = false;
    act(() => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(reload).not.toHaveBeenCalled();
    expect(testState.renderCount).toBeGreaterThan(rendersBeforeRetry);
    expect(container.querySelector('button')).toBeNull();
  });

  it('reloads even without a survivable token when no token was resolved at boot', () => {
    // Tokenless trusted loopback: nothing a reload could strand.
    testState.throwOnRender = true;
    testState.tokenSurvivesReload = false;
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    act(() => root.render(<StandaloneApp daemonToken={undefined} />));

    const retry = container.querySelector('button');
    expect(retry?.textContent).toBe('Reload page');
    expect(reload).not.toHaveBeenCalled();

    act(() => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('carries the live theme and language across a reload retry', () => {
    window.history.replaceState(null, '', '/?theme=light&language=zh-CN');
    act(() => root.render(<StandaloneApp daemonToken="token" />));

    // Boot consumes the one-shot params, then strips them from the URL.
    expect(window.location.search).not.toContain('theme=');
    expect(testState.props?.webShellProps.theme).toBe('light');
    expect(testState.props?.webShellProps.language).toBe('zh-CN');

    window.history.replaceState(
      window.history.state,
      '',
      '/session/session-2?workspace=workspace-1',
    );
    testState.throwOnRender = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    act(() => root.render(<StandaloneApp daemonToken="token" />));

    // Stub after the last navigation so the snapshot href is current —
    // the handler builds the reload URL from window.location.href.
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    const replaceState = vi.spyOn(window.history, 'replaceState');

    const retry = container.querySelector('button');
    expect(retry?.textContent).toBe('重新加载');

    act(() => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(reload).toHaveBeenCalledTimes(1);
    const reloadUrl = String(replaceState.mock.calls.at(-1)?.[2]);
    expect(reloadUrl).toContain('theme=light');
    expect(reloadUrl).toContain('language=zh-CN');
    // The reload must land on the live session URL, not a stale snapshot.
    expect(reloadUrl).toContain('session-2');
    expect(reloadUrl).toContain('workspace=workspace-1');
  });

  it('passes no app opinion while retaining standalone document defaults (#11955)', () => {
    // "No opinion" (undefined) lets App resolve the daemon's effective
    // ui.theme / general.language. The concrete document fallbacks stay on
    // the separate chrome channel, where they cannot shadow settings.json.
    window.localStorage.clear();
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('zh-CN');
    act(() => root.render(<StandaloneApp daemonToken="token" />));

    expect(testState.props?.webShellProps.theme).toBeUndefined();
    expect(testState.props?.webShellProps.language).toBeUndefined();
    expect(testState.props?.chromeTheme).toBe('dark');
    expect(testState.props?.chromeLanguage).toBe('zh-CN');
    expect(document.documentElement.classList.contains('theme-dark')).toBe(
      true,
    );
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('keeps the stored theme and language as the entry opinion', () => {
    // Regression guard for the host-override contract: a value the user
    // previously chose in-app must keep winning over settings.json.
    window.localStorage.setItem('qwen-code-web-shell-theme', 'light');
    window.localStorage.setItem('qwen-code-web-shell-language', 'zh-CN');
    act(() => root.render(<StandaloneApp daemonToken="token" />));

    expect(testState.props?.webShellProps.theme).toBe('light');
    expect(testState.props?.webShellProps.language).toBe('zh-CN');
    window.localStorage.clear();
  });

  it('syncs document chrome to settings-resolved values without adopting them as its opinion', () => {
    window.localStorage.clear();
    document.documentElement.classList.add('theme-dark', 'dark');
    act(() => root.render(<StandaloneApp daemonToken="token" />));
    expect(document.documentElement.classList.contains('theme-dark')).toBe(
      true,
    );

    act(() => {
      testState.props?.webShellProps.onThemeResolved?.('light');
    });

    expect(document.documentElement.classList.contains('theme-light')).toBe(
      true,
    );
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    // The resolved value stays settings-owned: never re-issued as a host
    // prop and never written to localStorage, or the next settings.json
    // edit would be shadowed by the stale copy.
    expect(testState.props?.webShellProps.theme).toBeUndefined();
    expect(testState.props?.chromeTheme).toBe('light');
    expect(window.localStorage.getItem('qwen-code-web-shell-theme')).toBeNull();

    act(() => {
      testState.props?.webShellProps.onLanguageResolved?.('zh-CN');
    });

    expect(testState.props?.webShellProps.language).toBeUndefined();
    expect(testState.props?.chromeLanguage).toBe('zh-CN');
    expect(
      window.localStorage.getItem('qwen-code-web-shell-language'),
    ).toBeNull();
  });

  it('adopts and persists an in-app theme choice as the entry opinion', () => {
    window.localStorage.clear();
    act(() => root.render(<StandaloneApp daemonToken="token" />));

    act(() => {
      testState.props?.webShellProps.onThemeChange?.('light');
    });

    expect(testState.props?.webShellProps.theme).toBe('light');
    expect(window.localStorage.getItem('qwen-code-web-shell-theme')).toBe(
      'light',
    );
    expect(document.documentElement.classList.contains('theme-light')).toBe(
      true,
    );
    window.localStorage.clear();
  });

  it.each([
    [null, true],
    ['false', false],
    ['true', true],
  ])(
    'uses the standalone default unless the browser has saved %s',
    (stored, enabled) => {
      vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(stored);
      act(() => root.render(<StandaloneApp daemonToken="token" />));
      expect(testState.notificationEnabled).toBe(enabled);
    },
  );

  it('delegates URL ownership to the shared provider boundary', () => {
    window.history.replaceState(null, '', '/settings?instanceId=kept');
    act(() => root.render(<StandaloneApp daemonToken="token" />));
    expect(testState.props?.urlNavigation).toEqual({ basePath: '' });
    expect(testState.props?.sessionId).toBeUndefined();
    expect(testState.props?.webShellProps.onSessionIdChange).toBeUndefined();
    expect(window.location.pathname).toBe('/settings');
    expect(window.location.search).toBe('?instanceId=kept');
  });

  it('reserves a draggable title bar only when the macOS shell requests it', () => {
    (
      window as Window & { __QWEN_CODE_MACOS_TITLEBAR__?: boolean }
    ).__QWEN_CODE_MACOS_TITLEBAR__ = true;

    act(() => root.render(<StandaloneApp daemonToken="token" />));

    expect(testState.props?.webShellProps.className).toBe(
      'qwen-code-macos-titlebar',
    );
    expect(container.querySelector('[data-tauri-drag-region]')).not.toBeNull();
  });
});

describe('StandaloneApp brand', () => {
  const BRAND_STORAGE_KEY = 'qwen-code-web-shell-brand';
  let container: HTMLDivElement;
  let root: Root;
  let icon: HTMLLinkElement;

  beforeEach(() => {
    testState.props = undefined;
    window.history.replaceState(null, '', '/');
    window.localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    icon = document.createElement('link');
    icon.rel = 'icon';
    icon.setAttribute('href', 'data:image/svg+xml,BUILT-IN');
    document.head.appendChild(icon);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    icon.remove();
    window.localStorage.clear();
  });

  function resolveBrand(brand: WebShellResolvedBrand): void {
    act(() => root.render(<StandaloneApp daemonToken="token" />));
    act(() => {
      testState.props?.webShellProps.onBrandResolved?.(brand);
    });
  }

  function readCachedBrand(): unknown {
    const raw = window.localStorage.getItem(BRAND_STORAGE_KEY);
    return raw === null ? null : JSON.parse(raw);
  }

  it('applies the brand name to the document title and caches it', () => {
    resolveBrand({ name: 'QiuQiu Code' });

    expect(document.title).toBe('QiuQiu Code Web chat');
    expect(readCachedBrand()).toEqual({ title: 'QiuQiu Code Web chat' });
  });

  it('applies the logo to the favicon and caches both', () => {
    resolveBrand({
      name: 'QiuQiu Code',
      logoDataUri: 'data:image/svg+xml,LOGO',
    });

    expect(icon.getAttribute('href')).toBe('data:image/svg+xml,LOGO');
    expect(readCachedBrand()).toEqual({
      title: 'QiuQiu Code Web chat',
      logo: 'data:image/svg+xml,LOGO',
    });
  });

  it('restores the built-in title and clears the cache when no brand is configured', () => {
    window.localStorage.setItem(
      BRAND_STORAGE_KEY,
      JSON.stringify({
        title: 'QiuQiu Code Web chat',
        logo: 'data:image/svg+xml,LOGO',
      }),
    );

    resolveBrand({});

    expect(document.title).toBe('Qwen Code Web chat');
    expect(readCachedBrand()).toBeNull();
  });

  it('does not write a cache entry for the built-in brand', () => {
    resolveBrand({});

    expect(readCachedBrand()).toBeNull();
  });

  it('leaves the favicon alone when only a name is configured', () => {
    // `ui.brand.name` with no logoPath is the common white-label config. If the
    // guard that keeps a logo-less brand from touching the favicon is dropped,
    // `link.href = undefined` writes the literal string "undefined" into the
    // href and blanks the tab icon.
    resolveBrand({ name: 'QiuQiu Code' });

    expect(document.title).toBe('QiuQiu Code Web chat');
    expect(icon.getAttribute('href')).toBe('data:image/svg+xml,BUILT-IN');
  });

  it('derives the built-in title from the document, not from a parallel literal', () => {
    // The flash-free default works only while `webShellDocumentTitle(undefined)`
    // in main.tsx exactly equals index.html's static <title>. Check the two
    // copies against each other, not each against a third hard-coded literal.
    const htmlTitle = /<title>([^<]+)<\/title>/.exec(readIndexHtml())?.[1];

    resolveBrand({});

    expect(htmlTitle).toBeDefined();
    expect(document.title).toBe(htmlTitle);
  });

  it("round-trips the written cache through index.html's pre-paint script", () => {
    // The pre-paint cache is a cross-file contract: main.tsx writes an entry
    // under BRAND_STORAGE_KEY with {title, logo} fields, and index.html's
    // inline script reads it under its own literal key with its own field
    // names. Each side is otherwise pinned only against its own test's copy,
    // so a rename on either axis ships a flash of the built-in chrome with
    // the suite green. Read the entry main.tsx actually wrote — located by
    // enumeration, not by a literal — and feed it to the real inline script.
    resolveBrand({
      name: 'QiuQiu Code',
      logoDataUri: 'data:image/svg+xml,LOGO',
    });
    expect(window.localStorage.length).toBe(1);
    const writtenKey = window.localStorage.key(0)!;
    const raw = window.localStorage.getItem(writtenKey)!;

    const script = extractInlineScript('qwen-code-web-shell-brand');
    const stubIcon = { href: 'data:image/svg+xml,BUILT-IN' };
    const stubDocument = {
      title: 'Qwen Code Web chat',
      querySelector: (selector: string) =>
        selector === 'link[rel="icon"]' ? stubIcon : null,
    };
    const stubStorage = {
      getItem: (key: string) => (key === writtenKey ? raw : null),
    };
    Function('localStorage', 'document', script)(stubStorage, stubDocument);

    expect(stubDocument.title).toBe('QiuQiu Code Web chat');
    expect(stubIcon.href).toBe('data:image/svg+xml,LOGO');
  });
});

/**
 * @vitest-environment jsdom
 */
import { createElement, type MouseEvent as ReactMouseEvent } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { TOAST_REQUEST_EVENT } from '../components/ToastHost';
import { useExternalLinkOpener } from './useExternalLinkOpener';

type TauriWindow = { __TAURI__?: { core?: { invoke?: unknown } } };

function electronBrowserApi() {
  return {
    open: vi.fn(),
    navigate: vi.fn(),
    setBounds: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    close: vi.fn(),
    onOpenRequested: vi.fn(() => () => undefined),
    onStateChanged: vi.fn(() => () => undefined),
  };
}

function electronLinkApi() {
  return {
    open: vi.fn().mockResolvedValue(undefined),
    getPreference: vi.fn().mockResolvedValue('in-app' as const),
    setPreference: vi.fn().mockResolvedValue(undefined),
  };
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function TestLink({ url }: { url?: string }) {
  const openExternalLink = useExternalLinkOpener();
  return createElement(
    'a',
    {
      href: url,
      target: '_blank',
      rel: 'noreferrer',
      onClick: (event: ReactMouseEvent<HTMLAnchorElement>) =>
        openExternalLink(event, url),
    },
    'link',
  );
}

describe('useExternalLinkOpener', () => {
  let container: HTMLDivElement;
  let unmount: () => void;

  function render(url?: string): HTMLAnchorElement {
    container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        createElement(
          I18nProvider,
          { language: 'en' },
          createElement(TestLink, { url }),
        ),
      );
    });
    unmount = () => {
      act(() => root.unmount());
      container.remove();
    };
    return container.querySelector('a')!;
  }

  function click(
    anchor: HTMLAnchorElement,
    modifiers: { ctrlKey?: boolean; metaKey?: boolean } = {},
  ): MouseEvent {
    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
      ...modifiers,
    });
    act(() => {
      anchor.dispatchEvent(event);
    });
    return event;
  }

  afterEach(() => {
    delete (window as TauriWindow).__TAURI__;
    delete window.qwenCodeDesktop;
    vi.restoreAllMocks();
    if (unmount) unmount();
  });

  it('opens external links through the desktop opener', () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    (window as TauriWindow).__TAURI__ = { core: { invoke } };
    const anchor = render('https://github.com/QwenLM/qwen-code/issues/9108');
    const event = click(anchor);
    expect(event.defaultPrevented).toBe(true);
    expect(invoke).toHaveBeenCalledWith('plugin:opener|open_url', {
      url: 'https://github.com/QwenLM/qwen-code/issues/9108',
    });
  });

  it('routes Electron links to the in-app browser request', () => {
    const links = electronLinkApi();
    window.qwenCodeDesktop = {
      browserPanel: electronBrowserApi(),
      links,
    };
    const anchor = render('https://github.com/QwenLM/qwen-code');
    const event = click(anchor);
    expect(event.defaultPrevented).toBe(true);
    expect(links.open).toHaveBeenCalledWith(
      'https://github.com/QwenLM/qwen-code',
      { forceExternal: false },
    );
  });

  it('hands mail links to the Electron system opener', () => {
    const links = electronLinkApi();
    window.qwenCodeDesktop = {
      browserPanel: electronBrowserApi(),
      links,
    };
    const anchor = render('mailto:test@example.com');
    const event = click(anchor);
    expect(event.defaultPrevented).toBe(true);
    expect(links.open).toHaveBeenCalledWith('mailto:test@example.com', {
      forceExternal: false,
    });
  });

  it('forces Cmd/Ctrl-clicked Electron links into the system browser', () => {
    const links = electronLinkApi();
    window.qwenCodeDesktop = {
      browserPanel: electronBrowserApi(),
      links,
    };
    const anchor = render('https://github.com/QwenLM/qwen-code');
    const commandClick = click(anchor, { metaKey: true });
    const controlClick = click(anchor, { ctrlKey: true });
    expect(commandClick.defaultPrevented).toBe(true);
    expect(controlClick.defaultPrevented).toBe(true);
    expect(links.open).toHaveBeenNthCalledWith(
      1,
      'https://github.com/QwenLM/qwen-code',
      { forceExternal: true },
    );
    expect(links.open).toHaveBeenNthCalledWith(
      2,
      'https://github.com/QwenLM/qwen-code',
      { forceExternal: true },
    );
  });

  it('normalizes mixed-case schemes before invoking the opener', () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    (window as TauriWindow).__TAURI__ = { core: { invoke } };
    const anchor = render('HTTPS://github.com/QwenLM/qwen-code');
    const event = click(anchor);
    expect(event.defaultPrevented).toBe(true);
    expect(invoke).toHaveBeenCalledWith('plugin:opener|open_url', {
      url: 'https://github.com/QwenLM/qwen-code',
    });
  });

  it('leaves non-opener hrefs to native anchor behavior', () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    (window as TauriWindow).__TAURI__ = { core: { invoke } };
    const anchor = render('#fragment');
    const event = click(anchor);
    expect(event.defaultPrevented).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps native anchor behavior in plain browsers', () => {
    const anchor = render('https://github.com/QwenLM/qwen-code');
    const event = click(anchor);
    expect(event.defaultPrevented).toBe(false);
  });

  it('surfaces opener failures as error toasts', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('ForbiddenUrl'));
    (window as TauriWindow).__TAURI__ = { core: { invoke } };
    const toasts: Array<{ tone?: string; message?: string }> = [];
    const listener = (event: Event) => {
      toasts.push((event as CustomEvent).detail);
    };
    window.addEventListener(TOAST_REQUEST_EVENT, listener);
    try {
      const anchor = render('https://github.com/QwenLM/qwen-code');
      click(anchor);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(toasts).toHaveLength(1);
      expect(toasts[0].tone).toBe('error');
      expect(toasts[0].message).toContain('Could not open link');
    } finally {
      window.removeEventListener(TOAST_REQUEST_EVENT, listener);
    }
  });
});

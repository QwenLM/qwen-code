/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import {
  type DesktopBrowserApi,
  type DesktopBrowserState,
  type DesktopLinkApi,
} from '../../utils/desktopBrowser';
import { DesktopBrowserPanel } from './DesktopBrowserPanel';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class TestResizeObserver {
  observe() {}
  disconnect() {}
}

function createApi(): DesktopBrowserApi {
  return {
    open: vi.fn().mockResolvedValue(undefined),
    navigate: vi.fn().mockResolvedValue(undefined),
    setBounds: vi.fn(),
    goBack: vi.fn().mockResolvedValue(undefined),
    goForward: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    onOpenRequested: vi.fn(() => () => undefined),
    onStateChanged: vi.fn(() => () => undefined),
  };
}

function createLinkApi(): DesktopLinkApi {
  return {
    open: vi.fn().mockResolvedValue(undefined),
    getPreference: vi.fn().mockResolvedValue('in-app'),
    setPreference: vi.fn().mockResolvedValue(undefined),
  };
}

describe('DesktopBrowserPanel', () => {
  let container: HTMLDivElement;
  let unmount: () => void;
  let api: DesktopBrowserApi;
  let links: DesktopLinkApi;

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 480,
      y: 42,
      width: 520,
      height: 658,
      top: 42,
      right: 1000,
      bottom: 700,
      left: 480,
      toJSON: () => ({}),
    });
    api = createApi();
    links = createLinkApi();
    window.qwenCodeDesktop = { browserPanel: api, links };
    container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <DesktopBrowserPanel />
        </I18nProvider>,
      );
    });
    unmount = () => act(() => root.unmount());
  });

  afterEach(() => {
    unmount();
    container.remove();
    delete window.qwenCodeDesktop;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('opens a requested URL in the native view bounds and closes it', async () => {
    const callback = vi.mocked(api.onOpenRequested).mock.calls[0]?.[0];
    await act(async () => {
      callback?.('https://example.com');
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="desktop-browser-panel"]'),
    ).toBeTruthy();
    expect(api.open).toHaveBeenCalledWith('https://example.com/', {
      x: 480,
      y: 42,
      width: 520,
      height: 658,
    });

    const close = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Close browser"]',
    );
    act(() => close?.click());
    expect(api.close).toHaveBeenCalledOnce();
    expect(
      container.querySelector('[data-testid="desktop-browser-panel"]'),
    ).toBeNull();
  });

  it('reflects native navigation state in the toolbar', async () => {
    const openCallback = vi.mocked(api.onOpenRequested).mock.calls[0]?.[0];
    await act(async () => {
      openCallback?.('https://example.com/one');
      await Promise.resolve();
    });
    const onStateChanged = vi.mocked(api.onStateChanged);
    const callback = onStateChanged.mock.calls[0]?.[0];
    const state: DesktopBrowserState = {
      url: 'https://example.com/two',
      loading: false,
      canGoBack: true,
      canGoForward: false,
    };
    act(() => callback?.(state));
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Address"]')
        ?.value,
    ).toBe('https://example.com/two');
  });

  it('opens the current page in the default browser on request', async () => {
    const openCallback = vi.mocked(api.onOpenRequested).mock.calls[0]?.[0];
    await act(async () => {
      openCallback?.('https://example.com/one');
      await Promise.resolve();
    });
    const external = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open in default browser"]',
    );
    await act(async () => {
      external?.click();
      await Promise.resolve();
    });
    expect(links.open).toHaveBeenCalledWith('https://example.com/one', {
      forceExternal: true,
    });
  });
});

/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getDesktopBrowserApi,
  getDesktopLinkApi,
  type DesktopBrowserApi,
  type DesktopLinkApi,
} from './desktopBrowser';

function browserApi(): DesktopBrowserApi {
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

function linkApi(): DesktopLinkApi {
  return {
    open: vi.fn(),
    getPreference: vi.fn().mockResolvedValue('in-app'),
    setPreference: vi.fn(),
  };
}

describe('desktopBrowser', () => {
  afterEach(() => {
    delete window.qwenCodeDesktop;
  });

  it('detects the Electron browser-panel bridge', () => {
    expect(getDesktopBrowserApi()).toBeUndefined();
    const browser = browserApi();
    const links = linkApi();
    window.qwenCodeDesktop = { browserPanel: browser, links };
    expect(getDesktopBrowserApi()).toBe(browser);
    expect(getDesktopLinkApi()).toBe(links);
  });
});

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import {
  BrowserWindow,
  screen,
  session,
  WebContentsView,
  type WebContents,
} from 'electron';
import type { DesktopBrowserState } from '../shared/types';
import {
  DEFAULT_BROWSER_URL,
  isSafeBrowserUrl,
  normalizeBrowserUrl,
} from './browser-navigation';
import {
  captureWindowState,
  initialWindowBounds,
  type BrowserWindowState,
  type WindowState,
} from './state';

const BROWSER_CHROME_HEIGHT = 52;
const BROWSER_PARTITION = 'persist:qwen-desktop-browser';

export interface EmbeddedBrowserOptions {
  packageDir: string;
  onChanged: () => void;
  onClosed: () => void;
}

export class EmbeddedBrowser {
  private window: BrowserWindow | undefined;
  private view: WebContentsView | undefined;
  private state: DesktopBrowserState = {
    canGoBack: false,
    canGoForward: false,
    loading: false,
    title: 'Browser',
    url: DEFAULT_BROWSER_URL,
  };

  constructor(private readonly options: EmbeddedBrowserOptions) {}

  ownsChrome(sender: WebContents): boolean {
    return this.window?.webContents === sender;
  }

  getWindow(): BrowserWindow | undefined {
    return this.window;
  }

  getState(): DesktopBrowserState {
    return { ...this.state };
  }

  getSavedState(): BrowserWindowState | undefined {
    if (!this.window || this.window.isDestroyed()) return undefined;
    return {
      url: this.state.url,
      window: captureWindowState(this.window),
    };
  }

  async open(
    rawUrl?: string,
    savedBounds?: WindowState,
  ): Promise<BrowserWindow> {
    const normalized = rawUrl ? normalizeBrowserUrl(rawUrl) : undefined;
    if (rawUrl && !normalized) throw new Error('Enter a valid HTTP(S) URL.');
    if (this.window && !this.window.isDestroyed()) {
      if (normalized) await this.navigate(normalized);
      if (this.window.isMinimized()) this.window.restore();
      this.window.show();
      this.window.focus();
      return this.window;
    }

    const displays = screen.getAllDisplays().map((display) => display.workArea);
    const bounds = initialWindowBounds(savedBounds, displays);
    const { maximized, ...windowBounds } = bounds;
    const browserWindow = new BrowserWindow({
      ...windowBounds,
      backgroundColor: '#101114',
      minHeight: 520,
      minWidth: 720,
      show: false,
      title: 'Qwen Browser',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(
          this.options.packageDir,
          'dist',
          'preload',
          'index.cjs',
        ),
        sandbox: true,
        webSecurity: true,
      },
    });
    if (maximized) browserWindow.maximize();
    const browserSession = session.fromPartition(BROWSER_PARTITION);
    browserSession.setPermissionCheckHandler(() => false);
    browserSession.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false),
    );
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        partition: BROWSER_PARTITION,
        sandbox: true,
        webSecurity: true,
      },
    });
    this.window = browserWindow;
    this.view = view;
    browserWindow.contentView.addChildView(view);
    this.bindPageEvents(view);
    this.layoutView();
    browserWindow.once('ready-to-show', () => browserWindow.show());
    browserWindow.on('resize', () => {
      this.layoutView();
      this.options.onChanged();
    });
    browserWindow.on('move', this.options.onChanged);
    browserWindow.on('maximize', this.options.onChanged);
    browserWindow.on('unmaximize', this.options.onChanged);
    browserWindow.on('closed', () => {
      if (!view.webContents.isDestroyed()) view.webContents.close();
      this.window = undefined;
      this.view = undefined;
      this.options.onClosed();
    });
    browserWindow.webContents.on('will-navigate', (event, url) => {
      if (isTrustedBrowserChromeUrl(url)) return;
      event.preventDefault();
    });
    browserWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await browserWindow.loadURL(
      'qwen-desktop://app/index.html?surface=browser',
    );
    await this.navigate(normalized ?? DEFAULT_BROWSER_URL).catch(() => {});
    return browserWindow;
  }

  async navigate(rawUrl: string): Promise<DesktopBrowserState> {
    const url = normalizeBrowserUrl(rawUrl);
    if (!url) throw new Error('Enter a valid HTTP(S) URL.');
    const view = this.requireView();
    this.state = { ...this.state, loading: true, url };
    this.publishState();
    await view.webContents.loadURL(url);
    return this.getState();
  }

  goBack(): void {
    const navigation = this.requireView().webContents.navigationHistory;
    const target = navigation.getActiveIndex() - 1;
    if (target >= 0) navigation.goToIndex(target);
  }

  goForward(): void {
    const navigation = this.requireView().webContents.navigationHistory;
    const target = navigation.getActiveIndex() + 1;
    if (target < navigation.length()) navigation.goToIndex(target);
  }

  reload(): void {
    this.requireView().webContents.reload();
  }

  private requireView(): WebContentsView {
    if (!this.view || this.view.webContents.isDestroyed()) {
      throw new Error('The embedded browser is not open.');
    }
    return this.view;
  }

  private bindPageEvents(view: WebContentsView): void {
    const contents = view.webContents;
    const update = () => this.updateState();
    contents.on('did-start-loading', update);
    contents.on('did-stop-loading', update);
    contents.on('did-fail-load', update);
    contents.on('did-navigate', update);
    contents.on('did-navigate-in-page', update);
    contents.on('page-title-updated', update);
    contents.on('will-navigate', (event, url) => {
      if (isSafeBrowserUrl(url)) return;
      event.preventDefault();
    });
    contents.on('will-redirect', (event, url) => {
      if (isSafeBrowserUrl(url)) return;
      event.preventDefault();
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (isSafeBrowserUrl(url)) void this.navigate(url).catch(() => {});
      return { action: 'deny' };
    });
  }

  private updateState(): void {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    const url = contents.getURL();
    const navigation = contents.navigationHistory;
    this.state = {
      canGoBack: navigation.canGoBack(),
      canGoForward: navigation.canGoForward(),
      loading: contents.isLoading(),
      title: contents.getTitle() || 'Browser',
      url: isSafeBrowserUrl(url) ? url : this.state.url,
    };
    this.publishState();
    this.options.onChanged();
  }

  private publishState(): void {
    const contents = this.window?.webContents;
    if (!contents || contents.isDestroyed()) return;
    contents.send('desktop:browser-state', this.getState());
  }

  private layoutView(): void {
    const window = this.window;
    const view = this.view;
    if (!window || !view || window.isDestroyed()) return;
    const [width, height] = window.getContentSize();
    view.setBounds({
      x: 0,
      y: BROWSER_CHROME_HEIGHT,
      width,
      height: Math.max(0, height - BROWSER_CHROME_HEIGHT),
    });
  }
}

function isTrustedBrowserChromeUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'qwen-desktop:' && url.hostname === 'app';
  } catch {
    return false;
  }
}

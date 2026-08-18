/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ipcMain,
  session,
  shell,
  WebContentsView,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type Session,
} from 'electron';
import {
  BROWSER_PANEL_CHANNELS,
  BROWSER_PANEL_PARTITION,
  normalizeBrowserPanelBounds,
  normalizeBrowserPanelUrl,
  type BrowserPanelBounds,
  type BrowserPanelState,
} from '../shared/browser-panel';

export class BrowserPanelController {
  private browserSession: Session | undefined;
  private view: WebContentsView | undefined;

  constructor(
    private readonly getMainWindow: () => BrowserWindow | undefined,
  ) {}

  registerIpc(): void {
    ipcMain.handle(
      BROWSER_PANEL_CHANNELS.open,
      async (event, url: unknown, bounds: unknown) => {
        this.requireMainSender(event);
        await this.open(url, bounds);
      },
    );
    ipcMain.handle(
      BROWSER_PANEL_CHANNELS.navigate,
      async (event, url: unknown) => {
        this.requireMainSender(event);
        await this.navigate(url);
      },
    );
    ipcMain.on(BROWSER_PANEL_CHANNELS.setBounds, (event, bounds: unknown) => {
      if (!this.isMainSender(event)) return;
      const normalized = normalizeBrowserPanelBounds(bounds);
      if (normalized) this.view?.setBounds(normalized);
    });
    ipcMain.handle(BROWSER_PANEL_CHANNELS.goBack, (event) => {
      this.requireMainSender(event);
      const history = this.view?.webContents.navigationHistory;
      if (history?.canGoBack()) history.goBack();
    });
    ipcMain.handle(BROWSER_PANEL_CHANNELS.goForward, (event) => {
      this.requireMainSender(event);
      const history = this.view?.webContents.navigationHistory;
      if (history?.canGoForward()) history.goForward();
    });
    ipcMain.handle(BROWSER_PANEL_CHANNELS.reload, (event) => {
      this.requireMainSender(event);
      this.view?.webContents.reload();
    });
    ipcMain.handle(
      BROWSER_PANEL_CHANNELS.openExternal,
      async (event, url: unknown) => {
        this.requireMainSender(event);
        await shell.openExternal(requireBrowserPanelUrl(url));
      },
    );
    ipcMain.handle(BROWSER_PANEL_CHANNELS.close, (event) => {
      this.requireMainSender(event);
      this.close();
    });
  }

  close(): void {
    const view = this.view;
    if (!view) return;
    this.view = undefined;
    const window = this.getMainWindow();
    if (window && !window.isDestroyed()) {
      window.contentView.removeChildView(view);
    }
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }

  private async open(rawUrl: unknown, rawBounds: unknown): Promise<void> {
    const url = requireBrowserPanelUrl(rawUrl);
    const bounds = requireBrowserPanelBounds(rawBounds);
    const view = this.ensureView(bounds);
    view.setBounds(bounds);
    await view.webContents.loadURL(url);
  }

  private async navigate(rawUrl: unknown): Promise<void> {
    const url = requireBrowserPanelUrl(rawUrl);
    if (!this.view) throw new Error('The desktop browser panel is closed.');
    await this.view.webContents.loadURL(url);
  }

  private ensureView(bounds: BrowserPanelBounds): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;
    const window = this.getMainWindow();
    if (!window || window.isDestroyed()) {
      throw new Error('The desktop window is unavailable.');
    }
    const view = new WebContentsView({
      webPreferences: {
        session: this.ensureSession(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    view.setBackgroundColor('#ffffff');
    view.setBounds(bounds);
    const userAgent = view.webContents.userAgent.replace(
      /\sElectron\/[^\s]+/g,
      '',
    );
    if (userAgent) view.webContents.setUserAgent(userAgent);
    this.attachViewListeners(view);
    window.contentView.addChildView(view);
    this.view = view;
    return view;
  }

  private ensureSession(): Session {
    if (this.browserSession) return this.browserSession;
    const browserSession = session.fromPartition(BROWSER_PANEL_PARTITION);
    browserSession.setPermissionCheckHandler(() => false);
    browserSession.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    browserSession.on('will-download', (event) => event.preventDefault());
    this.browserSession = browserSession;
    return browserSession;
  }

  private attachViewListeners(view: WebContentsView): void {
    const contents = view.webContents;
    const blockUnsafeNavigation = (
      event: Electron.Event,
      url: string,
    ): void => {
      if (normalizeBrowserPanelUrl(url)) return;
      event.preventDefault();
      openMailtoExternally(url);
    };
    contents.on('will-navigate', blockUnsafeNavigation);
    contents.on('will-redirect', blockUnsafeNavigation);
    contents.setWindowOpenHandler(({ url }) => {
      const normalized = normalizeBrowserPanelUrl(url);
      if (normalized) void contents.loadURL(normalized).catch(() => undefined);
      else openMailtoExternally(url);
      return { action: 'deny' };
    });
    contents.on('did-start-loading', () => this.emitState());
    contents.on('did-stop-loading', () => this.emitState());
    contents.on('did-navigate', () => this.emitState());
    contents.on('did-navigate-in-page', () => this.emitState());
  }

  private emitState(): void {
    const window = this.getMainWindow();
    const contents = this.view?.webContents;
    if (
      !window ||
      window.isDestroyed() ||
      !contents ||
      contents.isDestroyed()
    ) {
      return;
    }
    const history = contents.navigationHistory;
    const state: BrowserPanelState = {
      url: contents.getURL(),
      loading: contents.isLoading(),
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
    };
    window.webContents.send(BROWSER_PANEL_CHANNELS.stateChanged, state);
  }

  private isMainSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    const window = this.getMainWindow();
    return Boolean(
      window &&
        !window.isDestroyed() &&
        event.sender.id === window.webContents.id,
    );
  }

  private requireMainSender(event: IpcMainInvokeEvent): void {
    if (!this.isMainSender(event)) throw new Error('Untrusted desktop sender.');
  }
}

function requireBrowserPanelUrl(raw: unknown): string {
  const url = normalizeBrowserPanelUrl(raw);
  if (!url) throw new Error('Only HTTP(S) URLs can be opened.');
  return url;
}

function requireBrowserPanelBounds(raw: unknown): BrowserPanelBounds {
  const bounds = normalizeBrowserPanelBounds(raw);
  if (!bounds) throw new Error('Invalid desktop browser bounds.');
  return bounds;
}

function openMailtoExternally(raw: unknown): void {
  if (typeof raw !== 'string') return;
  try {
    const url = new URL(raw);
    if (url.protocol === 'mailto:') {
      void shell.openExternal(url.href).catch(() => undefined);
    }
  } catch {
    return;
  }
}

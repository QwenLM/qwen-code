/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import {
  BrowserWindow,
  globalShortcut,
  ipcMain,
  screen,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import {
  COMPUTER_USE_CHANNELS,
  ComputerUseActivityTracker,
  extractComputerUseTarget,
  formatComputerUseAction,
  parseSseMessage,
  sessionIdFromUrl,
  takeSseMessages,
  type ComputerUseActivitySnapshot,
  type ComputerUseSurfaceState,
} from '../shared/computer-use';

const FRAME_POLL_INTERVAL_MS = 500;
const RECONNECT_DELAY_MS = 1_000;

interface RuntimeConnection {
  baseUrl: string;
  token: string;
}

interface ComputerUseControllerOptions {
  getAlwaysHidePictureInPicture(): boolean;
  getMainWindow(): BrowserWindow | undefined;
  getRuntime(): RuntimeConnection | undefined;
  language: string;
  log(message: string): void;
  setAlwaysHidePictureInPicture(hidden: boolean): void;
}

export class ComputerUseController {
  private abort: AbortController | undefined;
  private disposed = false;
  private escapeRegistered = false;
  private frameEtag: string | undefined;
  private framePending = false;
  private frameTimer: NodeJS.Timeout | undefined;
  private frameUnavailable = false;
  private readonly pictureInPictureOverrides = new Map<string, boolean>();
  private pictureInPictureWindow: BrowserWindow | undefined;
  private sessionId: string | undefined;
  private snapshot: ComputerUseActivitySnapshot = {
    active: false,
    args: {},
  };
  private state: ComputerUseSurfaceState;
  private statusWindow: BrowserWindow | undefined;
  private tracker = new ComputerUseActivityTracker();

  constructor(private readonly options: ComputerUseControllerOptions) {
    this.state = this.buildState();
  }

  registerIpc(): void {
    ipcMain.handle(COMPUTER_USE_CHANNELS.stop, async (event) => {
      this.requireTrustedSender(event);
      await this.stop();
    });
    ipcMain.handle(
      COMPUTER_USE_CHANNELS.setPictureInPictureVisible,
      (event, visible: unknown) => {
        this.requireTrustedSender(event);
        if (typeof visible !== 'boolean') {
          throw new Error('Invalid picture-in-picture visibility.');
        }
        if (this.sessionId) {
          this.pictureInPictureOverrides.set(this.sessionId, visible);
        }
        this.updateState();
      },
    );
    ipcMain.handle(
      COMPUTER_USE_CHANNELS.setAlwaysHidePictureInPicture,
      (event, hidden: unknown) => {
        this.requireTrustedSender(event);
        if (typeof hidden !== 'boolean') {
          throw new Error('Invalid picture-in-picture preference.');
        }
        this.options.setAlwaysHidePictureInPicture(hidden);
        if (this.sessionId) {
          this.pictureInPictureOverrides.delete(this.sessionId);
        }
        this.updateState();
      },
    );
  }

  setSessionFromUrl(url: string | undefined): void {
    const nextSessionId = url ? sessionIdFromUrl(url) : undefined;
    if (nextSessionId === this.sessionId && this.abort) {
      this.emitState();
      return;
    }
    this.stopObservation();
    this.sessionId = nextSessionId;
    this.frameEtag = undefined;
    this.frameUnavailable = false;
    this.snapshot = this.tracker.reset();
    this.state = this.buildState();
    this.stopFramePolling(true);
    this.unregisterEscapeShortcut();
    this.hideActivitySurfaces();
    this.emitState();
    if (!nextSessionId || this.disposed) return;
    const abort = new AbortController();
    this.abort = abort;
    void this.observeSession(nextSessionId, abort.signal);
  }

  reposition(): void {
    if (!this.state.active) return;
    this.positionStatusWindow();
    this.positionPictureInPictureWindow();
  }

  suspend(): void {
    this.setSessionFromUrl(undefined);
    this.destroySurface(this.statusWindow);
    this.destroySurface(this.pictureInPictureWindow);
    this.statusWindow = undefined;
    this.pictureInPictureWindow = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.setSessionFromUrl(undefined);
    this.destroySurface(this.statusWindow);
    this.destroySurface(this.pictureInPictureWindow);
    this.statusWindow = undefined;
    this.pictureInPictureWindow = undefined;
    ipcMain.removeHandler(COMPUTER_USE_CHANNELS.stop);
    ipcMain.removeHandler(COMPUTER_USE_CHANNELS.setPictureInPictureVisible);
    ipcMain.removeHandler(COMPUTER_USE_CHANNELS.setAlwaysHidePictureInPicture);
  }

  private async observeSession(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted && !this.disposed) {
      const runtime = this.options.getRuntime();
      if (!runtime) return;
      try {
        const response = await fetch(
          `${runtime.baseUrl}/session/${encodeURIComponent(sessionId)}/events`,
          {
            headers: {
              Accept: 'text/event-stream',
              Authorization: `Bearer ${runtime.token}`,
              'Last-Event-ID': '0',
            },
            signal,
          },
        );
        if (!response.ok || !response.body) {
          throw new Error(`session events returned ${response.status}`);
        }
        this.snapshot = this.tracker.reset();
        await this.consumeEventStream(response.body, signal);
      } catch (error) {
        if (signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        this.options.log(`Computer Use observer reconnecting: ${message}`);
      }
      await abortableDelay(RECONNECT_DELAY_MS, signal);
    }
  }

  private async consumeEventStream(
    stream: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let replaying = true;
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const parsed = takeSseMessages(buffer);
        buffer = parsed.rest;
        for (const message of parsed.messages) {
          const event = parseSseMessage(message);
          if (!event) continue;
          const eventType = eventTypeOf(event);
          const nextSnapshot = this.tracker.consume(event);
          const changed = !sameActivitySnapshot(this.snapshot, nextSnapshot);
          this.snapshot = nextSnapshot;
          if (eventType === 'replay_complete') {
            replaying = false;
            this.applySnapshot();
          } else if (!replaying && changed) {
            this.applySnapshot();
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private applySnapshot(): void {
    const wasActive = this.state.active;
    if (!wasActive && this.snapshot.active) {
      this.frameEtag = undefined;
      this.frameUnavailable = false;
    }
    this.state = this.buildState();
    if (this.state.active) {
      this.ensureStatusWindow();
      if (this.state.pictureInPictureVisible) {
        this.ensurePictureInPictureWindow();
        this.startFramePolling();
      } else {
        this.stopFramePolling(false);
      }
      this.registerEscapeShortcut();
    } else if (wasActive) {
      this.hideActivitySurfaces();
      this.stopFramePolling(true);
      this.unregisterEscapeShortcut();
    }
    this.emitState();
  }

  private updateState(): void {
    this.state = this.buildState(this.state.screenshot);
    if (this.state.active && this.state.pictureInPictureVisible) {
      this.ensurePictureInPictureWindow();
      this.startFramePolling();
    } else {
      this.pictureInPictureWindow?.hide();
      this.stopFramePolling(false);
    }
    this.emitState();
  }

  private buildState(screenshot?: string): ComputerUseSurfaceState {
    const alwaysHidePictureInPicture =
      this.options.getAlwaysHidePictureInPicture();
    const target = extractComputerUseTarget(this.snapshot.args);
    return {
      active: this.snapshot.active,
      action: formatComputerUseAction(
        this.snapshot.toolName,
        this.options.language,
      ),
      alwaysHidePictureInPicture,
      canStopWithEscape: this.snapshot.active,
      language: this.options.language,
      pictureInPictureVisible:
        this.snapshot.active &&
        ((this.sessionId
          ? this.pictureInPictureOverrides.get(this.sessionId)
          : undefined) ??
          !alwaysHidePictureInPicture),
      previewUnavailable: this.frameUnavailable,
      ...(screenshot ? { screenshot } : {}),
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      stopping: this.snapshot.active ? (this.state?.stopping ?? false) : false,
      ...(target ? { target } : {}),
    };
  }

  private startFramePolling(): void {
    if (this.frameTimer) return;
    this.frameTimer = setInterval(() => {
      void this.fetchFrame();
    }, FRAME_POLL_INTERVAL_MS);
    void this.fetchFrame();
  }

  private stopFramePolling(clearScreenshot: boolean): void {
    if (this.frameTimer) clearInterval(this.frameTimer);
    this.frameTimer = undefined;
    if (clearScreenshot && this.state.screenshot) {
      const { screenshot: _screenshot, ...state } = this.state;
      this.state = state;
    }
  }

  private async fetchFrame(): Promise<void> {
    if (
      this.framePending ||
      !this.state.active ||
      !this.state.pictureInPictureVisible
    ) {
      return;
    }
    const sessionId = this.sessionId;
    const runtime = this.options.getRuntime();
    if (!sessionId || !runtime) return;
    this.framePending = true;
    try {
      const response = await fetch(
        `${runtime.baseUrl}/session/${encodeURIComponent(sessionId)}/computer-use/frame`,
        {
          headers: {
            Accept: 'image/*',
            Authorization: `Bearer ${runtime.token}`,
            ...(this.frameEtag ? { 'If-None-Match': this.frameEtag } : {}),
          },
        },
      );
      if (
        sessionId !== this.sessionId ||
        !this.state.active ||
        !this.state.pictureInPictureVisible
      ) {
        return;
      }
      if (response.status === 204 || response.status === 304) {
        if (this.frameUnavailable) {
          this.frameUnavailable = false;
          this.state = this.buildState(this.state.screenshot);
          this.emitState();
        }
        return;
      }
      if (!response.ok) {
        throw new Error(`frame returned ${response.status}`);
      }
      const mimeType = response.headers.get('content-type')?.split(';')[0];
      if (
        mimeType !== 'image/png' &&
        mimeType !== 'image/jpeg' &&
        mimeType !== 'image/webp'
      ) {
        throw new Error('frame returned a non-image response');
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0) throw new Error('frame returned no image bytes');
      this.frameEtag = response.headers.get('etag') ?? undefined;
      this.frameUnavailable = false;
      this.state = this.buildState(
        `data:${mimeType};base64,${bytes.toString('base64')}`,
      );
      this.emitState();
    } catch (error) {
      if (
        sessionId === this.sessionId &&
        this.state.active &&
        this.state.pictureInPictureVisible
      ) {
        if (!this.frameUnavailable) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.options.log(`Computer Use frame fetch failed: ${message}`);
        }
        this.frameUnavailable = true;
        this.state = this.buildState(this.state.screenshot);
        this.emitState();
      }
    } finally {
      this.framePending = false;
    }
  }

  private ensureStatusWindow(): void {
    if (this.statusWindow && !this.statusWindow.isDestroyed()) {
      this.positionStatusWindow();
      this.statusWindow.showInactive();
      return;
    }
    const window = this.createSurfaceWindow('status', 360, 64, false);
    this.statusWindow = window;
    window.on('closed', () => {
      if (this.statusWindow === window) this.statusWindow = undefined;
    });
    void this.loadSurface(window, 'status');
  }

  private ensurePictureInPictureWindow(): void {
    if (
      this.pictureInPictureWindow &&
      !this.pictureInPictureWindow.isDestroyed()
    ) {
      this.pictureInPictureWindow.showInactive();
      return;
    }
    const window = this.createSurfaceWindow('pip', 258, 258, true);
    this.pictureInPictureWindow = window;
    window.on('close', (event) => {
      if (this.disposed || !this.state.active) return;
      event.preventDefault();
      if (this.sessionId) {
        this.pictureInPictureOverrides.set(this.sessionId, false);
      }
      this.updateState();
    });
    window.on('closed', () => {
      if (this.pictureInPictureWindow === window) {
        this.pictureInPictureWindow = undefined;
      }
    });
    void this.loadSurface(window, 'pip');
  }

  private createSurfaceWindow(
    mode: 'pip' | 'status',
    width: number,
    height: number,
    focusable: boolean,
  ): BrowserWindow {
    const window = new BrowserWindow({
      width,
      height,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      focusable,
      frame: false,
      fullscreenable: false,
      hasShadow: true,
      maximizable: false,
      minimizable: false,
      resizable: false,
      show: false,
      skipTaskbar: true,
      transparent: true,
      type: process.platform === 'darwin' ? 'panel' : undefined,
      webPreferences: {
        preload: path.join(__dirname, '../preload/computer-use-surface.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    window.setAlwaysOnTop(true, 'floating');
    window.setContentProtection(true);
    if (process.platform === 'darwin') {
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    if (mode === 'status') this.positionStatusWindow(window);
    else this.positionPictureInPictureWindow(window);
    return window;
  }

  private async loadSurface(
    window: BrowserWindow,
    mode: 'pip' | 'status',
  ): Promise<void> {
    try {
      await window.loadFile(
        path.join(__dirname, '../renderer/computer-use-surface.html'),
        { query: { mode } },
      );
      if (window.isDestroyed() || !this.state.active) return;
      this.emitToWindow(window, this.state);
      window.showInactive();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.log(`Computer Use surface failed: ${message}`);
    }
  }

  private positionStatusWindow(window = this.statusWindow): void {
    if (!window || window.isDestroyed()) return;
    const workArea = this.activityDisplay().workArea;
    const bounds = window.getBounds();
    window.setPosition(
      Math.round(workArea.x + (workArea.width - bounds.width) / 2),
      workArea.y + 18,
      false,
    );
  }

  private positionPictureInPictureWindow(
    window = this.pictureInPictureWindow,
  ): void {
    if (!window || window.isDestroyed()) return;
    const workArea = this.activityDisplay().workArea;
    const bounds = window.getBounds();
    const mainWindow = this.options.getMainWindow();
    const anchor =
      mainWindow && !mainWindow.isDestroyed()
        ? mainWindow.getBounds()
        : workArea;
    window.setPosition(
      clamp(
        anchor.x + anchor.width - bounds.width - 24,
        workArea.x + 12,
        workArea.x + workArea.width - bounds.width - 12,
      ),
      clamp(
        anchor.y + 64,
        workArea.y + 12,
        workArea.y + workArea.height - bounds.height - 12,
      ),
      false,
    );
  }

  private activityDisplay(): Electron.Display {
    const window = this.options.getMainWindow();
    return window && !window.isDestroyed()
      ? screen.getDisplayMatching(window.getBounds())
      : screen.getPrimaryDisplay();
  }

  private hideActivitySurfaces(): void {
    this.statusWindow?.hide();
    this.pictureInPictureWindow?.hide();
  }

  private emitState(): void {
    const mainWindow = this.options.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      const { screenshot: _screenshot, ...controlState } = this.state;
      this.emitToWindow(mainWindow, controlState);
    }
    if (this.statusWindow && !this.statusWindow.isDestroyed()) {
      const { screenshot: _screenshot, ...statusState } = this.state;
      this.emitToWindow(this.statusWindow, statusState);
    }
    if (
      this.pictureInPictureWindow &&
      !this.pictureInPictureWindow.isDestroyed()
    ) {
      this.emitToWindow(this.pictureInPictureWindow, this.state);
    }
  }

  private emitToWindow(
    window: BrowserWindow,
    state: ComputerUseSurfaceState,
  ): void {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(COMPUTER_USE_CHANNELS.stateChanged, state);
    }
  }

  private registerEscapeShortcut(): void {
    if (this.escapeRegistered) return;
    if (globalShortcut.isRegistered('Esc')) {
      this.state = { ...this.state, canStopWithEscape: false };
      return;
    }
    const registered = globalShortcut.register('Esc', () => {
      void this.stop();
    });
    if (registered) {
      this.escapeRegistered = true;
    } else {
      this.state = { ...this.state, canStopWithEscape: false };
    }
  }

  private unregisterEscapeShortcut(): void {
    if (!this.escapeRegistered) return;
    globalShortcut.unregister('Esc');
    this.escapeRegistered = false;
  }

  private async stop(): Promise<void> {
    if (!this.sessionId || !this.state.active || this.state.stopping) return;
    const runtime = this.options.getRuntime();
    if (!runtime) return;
    this.state = { ...this.state, stopping: true };
    this.emitState();
    try {
      const response = await fetch(
        `${runtime.baseUrl}/session/${encodeURIComponent(this.sessionId)}/cancel`,
        {
          headers: { Authorization: `Bearer ${runtime.token}` },
          method: 'POST',
        },
      );
      if (!response.ok) throw new Error(`cancel returned ${response.status}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.log(`Computer Use cancel failed: ${message}`);
      this.state = { ...this.state, stopping: false };
      this.emitState();
    }
  }

  private isTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    return [
      this.options.getMainWindow(),
      this.statusWindow,
      this.pictureInPictureWindow,
    ].some(
      (window) =>
        window &&
        !window.isDestroyed() &&
        event.sender.id === window.webContents.id,
    );
  }

  private requireTrustedSender(event: IpcMainInvokeEvent): void {
    if (!this.isTrustedSender(event)) {
      throw new Error('Untrusted desktop sender.');
    }
  }

  private stopObservation(): void {
    this.abort?.abort();
    this.abort = undefined;
  }

  private destroySurface(window: BrowserWindow | undefined): void {
    if (window && !window.isDestroyed()) window.destroy();
  }
}

function eventTypeOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const type = (value as Record<string, unknown>)['type'];
  return typeof type === 'string' ? type : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function sameActivitySnapshot(
  left: ComputerUseActivitySnapshot,
  right: ComputerUseActivitySnapshot,
): boolean {
  return (
    left.active === right.active &&
    left.args === right.args &&
    left.toolName === right.toolName
  );
}

async function abortableDelay(
  durationMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, durationMs);
    signal.addEventListener('abort', finish, { once: true });
  });
}

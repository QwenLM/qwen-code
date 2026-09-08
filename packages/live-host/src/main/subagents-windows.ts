import { BrowserWindow, ipcMain, screen } from 'electron';
import { join } from 'node:path';
import type { LiveLanguage } from '@qwen-code/qwen-live/i18n';
import type { SubagentsSnapshot } from '@qwen-code/qwen-live/subagents';
import type { SubagentsWindowState } from '../shared/subagents-api.ts';
import type { LiveTheme, ResolvedTheme } from '../shared/theme.ts';
import {
  fitSubagentsBounds,
  subagentsSidecarBounds,
  type SubagentsSide,
} from './subagents-position.ts';
import type { DisplayWorkArea } from './overlay-position.ts';

type Options = {
  baseDirectory: string;
  anchor: () => DisplayWorkArea | undefined;
  hoverRegions?: () => readonly DisplayWorkArea[];
};

export class SubagentsWindows {
  private window?: BrowserWindow;
  private snapshot?: SubagentsSnapshot;
  private language: LiveLanguage = 'en';
  private theme: LiveTheme = 'system';
  private appearance: ResolvedTheme = 'dark';
  private connected = false;
  private selectedId?: string;
  private mode: SubagentsWindowState['mode'] = 'summary';
  private side?: SubagentsSide;
  private orbHovered = false;
  private sideHovered = false;
  private orbKeyboardHeld = false;
  private sideKeyboardHeld = false;
  private blocked = false;
  private dragging = false;
  private cursorTimer?: ReturnType<typeof setTimeout>;
  private outsideSince?: number;
  private disposed = false;
  private instanceId?: string;

  constructor(private readonly options: Options) {
    ipcMain.handle('live:subagents:get-state', (event) =>
      this.stateFor(event.sender),
    );
    ipcMain.on('live:subagents:hover', (event, hovered: unknown) => {
      if (
        event.sender !== this.window?.webContents ||
        typeof hovered !== 'boolean'
      )
        return;
      this.sideHovered = hovered;
      this.noteHover();
    });
    ipcMain.on('live:subagents:keyboard', (event, held: unknown) => {
      if (
        event.sender !== this.window?.webContents ||
        typeof held !== 'boolean'
      )
        return;
      this.sideKeyboardHeld = held;
      this.noteHover();
    });
    ipcMain.handle('live:subagents:expand', (event) => {
      if (
        event.sender !== this.window?.webContents ||
        !this.snapshot ||
        !this.connected
      )
        return;
      this.openMode('list');
    });
    ipcMain.handle('live:subagents:back', (event) => {
      if (event.sender !== this.window?.webContents) return;
      this.selectedId = undefined;
      this.openMode('list');
    });
    ipcMain.on('live:subagents:close', (event) => {
      if (event.sender === this.window?.webContents) this.closePanel();
    });
    ipcMain.handle('live:subagents:detail', (event, id: unknown) => {
      if (event.sender !== this.window?.webContents)
        throw new Error('Untrusted subagent detail request');
      if (
        typeof id !== 'string' ||
        id.length > 128 ||
        !this.snapshot?.tasks.some((task) => task.id === id)
      )
        return;
      this.selectedId = id;
      this.openMode('detail');
    });
  }

  update(
    language: LiveLanguage,
    connected: boolean,
    snapshot?: SubagentsSnapshot,
    instanceId?: string,
  ): void {
    if (this.disposed) return;
    if (instanceId && this.instanceId !== instanceId) {
      this.selectedId = undefined;
      this.snapshot = undefined;
      this.instanceId = instanceId;
      this.closePanel();
    }
    this.language = language;
    this.connected = connected;
    if (snapshot) this.snapshot = snapshot;
    else if (connected) this.snapshot = undefined;
    if (!this.isPinned() && (!connected || !snapshot)) this.closePanel();
    this.publish();
    if (this.isPinned() || this.orbHovered) this.show();
  }

  setTheme(theme: LiveTheme, appearance: ResolvedTheme): void {
    if (this.theme === theme && this.appearance === appearance) return;
    this.theme = theme;
    this.appearance = appearance;
    if (this.window && !this.window.isDestroyed())
      this.window.setBackgroundColor(
        appearance === 'dark' ? '#1b1b29' : '#f7f7fc',
      );
    this.publish();
  }

  setOrbHovered(hovered: boolean): void {
    this.orbHovered = hovered;
    if (hovered) this.show();
    this.noteHover();
  }

  setOrbKeyboardHeld(held: boolean): void {
    this.orbKeyboardHeld = held;
    this.noteHover();
    if (held) this.show();
  }

  setBlocked(blocked: boolean): void {
    this.blocked = blocked;
    if (blocked && !this.isPinned()) this.closePanel();
  }
  setDragging(dragging: boolean): void {
    this.dragging = dragging;
    if (dragging && !this.isPinned()) this.closePanel();
  }
  dismissPeek(): void {
    if (!this.isPinned()) this.closePanel();
  }

  displaysChanged(): void {
    if (!this.isPinned()) {
      this.closePanel();
      return;
    }
    if (this.window && !this.window.isDestroyed()) {
      const bounds = this.window.getBounds();
      this.window.setBounds(
        fitSubagentsBounds(
          bounds,
          bounds,
          screen.getDisplayMatching(bounds).workArea,
        ),
        false,
      );
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopCursorWatch();
    this.window?.destroy();
    for (const channel of [
      'live:subagents:get-state',
      'live:subagents:expand',
      'live:subagents:back',
      'live:subagents:detail',
    ])
      ipcMain.removeHandler(channel);
    for (const channel of [
      'live:subagents:hover',
      'live:subagents:keyboard',
      'live:subagents:close',
    ])
      ipcMain.removeAllListeners(channel);
  }

  private isPinned(): boolean {
    return this.mode !== 'summary';
  }
  private isKeyboardHeld(): boolean {
    return this.orbKeyboardHeld || this.sideKeyboardHeld;
  }
  private stateFor(sender: Electron.WebContents): SubagentsWindowState {
    if (sender !== this.window?.webContents)
      throw new Error('Untrusted subagent window');
    return {
      language: this.language,
      theme: this.theme,
      resolvedTheme: this.appearance,
      connected: this.connected,
      mode: this.mode,
      ...(this.snapshot ? { snapshot: this.snapshot } : {}),
      ...(this.selectedId ? { selectedId: this.selectedId } : {}),
    };
  }
  private openMode(mode: 'list' | 'detail'): void {
    if (this.disposed || !this.window || this.window.isDestroyed()) return;
    const preservePosition = this.isPinned();
    this.mode = mode;
    this.stopCursorWatch();
    this.place(preservePosition);
    this.publish();
    this.window.show();
    this.window.focus();
  }
  private createWindow(): BrowserWindow {
    const window = new BrowserWindow({
      width: 132,
      height: 62,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      backgroundColor: this.appearance === 'dark' ? '#1b1b29' : '#f7f7fc',
      title: 'Subagents',
      webPreferences: {
        preload: join(this.options.baseDirectory, 'subagents-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.setAlwaysOnTop(true, 'floating');
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault();
        this.closePanel();
      }
    });
    window.on('blur', () => {
      this.sideKeyboardHeld = false;
      this.sideHovered = false;
      this.noteHover();
    });
    window.on('closed', () => {
      if (this.window === window) this.window = undefined;
    });
    window.webContents.on('did-finish-load', () => {
      if (this.disposed || window.isDestroyed()) return;
      if (
        this.isPinned() ||
        ((this.orbHovered || this.sideHovered || this.isKeyboardHeld()) &&
          !this.blocked &&
          !this.dragging &&
          this.connected)
      ) {
        this.place();
        this.publish();
        window.showInactive();
        this.watchCursor();
      }
    });
    void window
      .loadFile(join(this.options.baseDirectory, 'renderer', 'subagents.html'))
      .catch(() => {
        if (!window.isDestroyed()) window.close();
      });
    return window;
  }
  private show(): void {
    if (
      this.disposed ||
      !this.snapshot ||
      (!this.isPinned() &&
        (!this.connected || this.blocked || this.dragging)) ||
      !this.options.anchor()
    )
      return;
    if (!this.window || this.window.isDestroyed())
      this.window = this.createWindow();
    if (this.window.webContents.isLoadingMainFrame()) return;
    if (!this.window.isVisible()) {
      this.place();
      this.publish();
      this.window.showInactive();
    }
    this.watchCursor();
  }
  private place(preservePosition = false): void {
    const anchor = this.options.anchor();
    if (!anchor || !this.window || this.window.isDestroyed()) return;
    const size =
      this.mode === 'summary'
        ? { width: 132, height: 62 }
        : { width: 330, height: 430 };
    if (preservePosition) {
      const bounds = this.window.getBounds();
      this.window.setBounds(
        fitSubagentsBounds(
          bounds,
          size,
          screen.getDisplayMatching(bounds).workArea,
        ),
        false,
      );
      return;
    }
    const result = subagentsSidecarBounds(
      anchor,
      size,
      screen.getDisplayMatching(anchor).workArea,
      this.side,
    );
    this.side = result.side;
    this.window.setBounds(result.bounds, false);
  }
  private closePanel(): void {
    this.stopCursorWatch();
    this.mode = 'summary';
    this.selectedId = undefined;
    this.side = undefined;
    this.orbHovered =
      this.sideHovered =
      this.orbKeyboardHeld =
      this.sideKeyboardHeld =
        false;
    this.outsideSince = undefined;
    if (this.window && !this.window.isDestroyed()) this.window.hide();
  }
  private publish(): void {
    if (
      this.window &&
      !this.window.isDestroyed() &&
      !this.window.webContents.isDestroyed()
    )
      this.window.webContents.send(
        'live:subagents:state',
        this.stateFor(this.window.webContents),
      );
  }
  private noteHover(): void {
    if (this.orbHovered || this.sideHovered || this.isKeyboardHeld())
      this.outsideSince = undefined;
    this.watchCursor();
  }
  private stopCursorWatch(): void {
    if (this.cursorTimer) clearTimeout(this.cursorTimer);
    this.cursorTimer = undefined;
  }
  private watchCursor(): void {
    if (
      this.cursorTimer ||
      this.disposed ||
      this.isPinned() ||
      !this.window?.isVisible()
    )
      return;
    this.cursorTimer = setTimeout(() => {
      this.cursorTimer = undefined;
      if (this.disposed || this.isPinned() || !this.window?.isVisible()) return;
      const point = screen.getCursorScreenPoint();
      const contains = (r: DisplayWorkArea | undefined) =>
        Boolean(
          r &&
            point.x >= r.x &&
            point.x <= r.x + r.width &&
            point.y >= r.y &&
            point.y <= r.y + r.height,
        );
      if (
        (this.options.hoverRegions?.() ?? [this.options.anchor()]).some(
          contains,
        ) ||
        contains(this.window.getBounds()) ||
        this.isKeyboardHeld()
      )
        this.outsideSince = undefined;
      else {
        this.orbHovered = this.sideHovered = false;
        this.outsideSince ??= Date.now();
        if (Date.now() - this.outsideSince >= 1000) {
          this.closePanel();
          return;
        }
      }
      this.watchCursor();
    }, 100);
    this.cursorTimer.unref?.();
  }
}

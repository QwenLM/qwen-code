/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { BrowserWindow, screen } from 'electron';
import {
  DESKTOP_CHANNELS,
  type PetSettings,
  type PetState,
  type SessionChangeReport,
} from '../shared/desktop-api';
import { petStateForStreaming, petTransitionForSession } from './pet-activity';

const PET_WINDOW_WIDTH = 300;
const PET_WINDOW_HEIGHT = 340;

interface PetWindowOptions {
  onPositionChange: (position: { x: number; y: number }) => void;
  preloadPath: string;
  rendererPath: string;
}

interface DragState {
  pointerX: number;
  pointerY: number;
  windowX: number;
  windowY: number;
}

export class PetWindowController {
  private activityState: PetState = 'idle';
  private baseActivityState: PetState = 'idle';
  private dragState: DragState | undefined;
  private settings: PetSettings;
  private transientTimer: NodeJS.Timeout | undefined;
  private window: BrowserWindow | undefined;

  constructor(
    settings: PetSettings,
    private readonly options: PetWindowOptions,
  ) {
    this.settings = settings;
  }

  applySettings(settings: PetSettings): void {
    this.settings = settings;
    if (!settings.enabled) {
      this.destroyWindow();
      return;
    }
    const window = this.ensureWindow();
    if (!window.webContents.isLoading()) {
      window.webContents.send(
        DESKTOP_CHANNELS.petSettingsChanged,
        this.settings,
      );
    }
  }

  owns(webContentsId: number): boolean {
    return (
      this.window !== undefined &&
      !this.window.isDestroyed() &&
      this.window.webContents.id === webContentsId
    );
  }

  setIgnoreMouseEvents(ignore: boolean): void {
    this.liveWindow()?.setIgnoreMouseEvents(ignore, { forward: true });
  }

  beginDrag(screenX: number, screenY: number): void {
    const window = this.liveWindow();
    if (!window) return;
    const [windowX, windowY] = window.getPosition();
    this.dragState = {
      pointerX: screenX,
      pointerY: screenY,
      windowX,
      windowY,
    };
  }

  moveDrag(screenX: number, screenY: number): void {
    const window = this.liveWindow();
    const drag = this.dragState;
    if (!window || !drag) return;
    window.setPosition(
      Math.round(drag.windowX + screenX - drag.pointerX),
      Math.round(drag.windowY + screenY - drag.pointerY),
      false,
    );
  }

  endDrag(): void {
    this.dragState = undefined;
  }

  reportStreamingState(state: string): void {
    this.baseActivityState = petStateForStreaming(state);
    if (!this.transientTimer) this.setActivity(this.baseActivityState);
  }

  reportSessionChange(event: SessionChangeReport): void {
    const transition = petTransitionForSession(event);
    this.baseActivityState = transition.baseState;
    if (!transition.transientMs) {
      this.clearTransient();
      this.setActivity(transition.state);
      return;
    }
    this.showTransient(transition.state, transition.transientMs);
  }

  destroy(): void {
    this.clearTransient();
    this.destroyWindow();
  }

  private ensureWindow(): BrowserWindow {
    const existing = this.liveWindow();
    if (existing) return existing;

    const position = this.settings.position ?? this.defaultPosition();
    const window = new BrowserWindow({
      width: PET_WINDOW_WIDTH,
      height: PET_WINDOW_HEIGHT,
      x: position.x,
      y: position.y,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      title: 'Qwen Pet',
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    this.window = window;
    window.setAlwaysOnTop(true, 'floating');
    window.setIgnoreMouseEvents(true, { forward: true });
    if (process.platform === 'darwin') {
      window.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
    }
    window.once('ready-to-show', () => window.showInactive());
    window.webContents.once('did-finish-load', () => {
      window.webContents.send(
        DESKTOP_CHANNELS.petSettingsChanged,
        this.settings,
      );
      window.webContents.send(
        DESKTOP_CHANNELS.petActivityChanged,
        this.activityState,
      );
    });
    window.on('moved', () => {
      if (window.isDestroyed()) return;
      const [x, y] = window.getPosition();
      this.options.onPositionChange({ x, y });
    });
    window.on('closed', () => {
      if (this.window === window) this.window = undefined;
      this.dragState = undefined;
    });
    void window.loadFile(this.options.rendererPath);
    return window;
  }

  private defaultPosition(): { x: number; y: number } {
    const area = screen.getPrimaryDisplay().workArea;
    return {
      x: Math.round(area.x + area.width - PET_WINDOW_WIDTH - 24),
      y: Math.round(area.y + area.height - PET_WINDOW_HEIGHT - 24),
    };
  }

  private liveWindow(): BrowserWindow | undefined {
    if (!this.window || this.window.isDestroyed()) return undefined;
    return this.window;
  }

  private showTransient(state: PetState, duration: number): void {
    this.clearTransient();
    this.setActivity(state);
    this.transientTimer = setTimeout(() => {
      this.transientTimer = undefined;
      this.setActivity(this.baseActivityState);
    }, duration);
  }

  private setActivity(state: PetState): void {
    this.activityState = state;
    const window = this.liveWindow();
    if (!window || window.webContents.isLoading()) return;
    window.webContents.send(DESKTOP_CHANNELS.petActivityChanged, state);
  }

  private clearTransient(): void {
    if (this.transientTimer) clearTimeout(this.transientTimer);
    this.transientTimer = undefined;
  }

  private destroyWindow(): void {
    const window = this.liveWindow();
    this.window = undefined;
    this.dragState = undefined;
    if (window) window.destroy();
  }
}

export function petRendererPath(mainDir: string): string {
  return path.join(mainDir, '..', 'renderer', 'pet.html');
}

export function preloadPath(mainDir: string): string {
  return path.join(mainDir, '..', 'preload', 'index.cjs');
}

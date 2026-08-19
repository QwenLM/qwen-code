/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow, Rectangle } from 'electron';

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 820;
const MIN_WIDTH = 900;
const MIN_HEIGHT = 600;

export interface DesktopState {
  computerUse?: ComputerUseState;
  window?: WindowState;
  workspace?: string;
}

export interface ComputerUseState {
  alwaysHidePictureInPicture: boolean;
}

export interface WindowState extends Rectangle {
  maximized: boolean;
}

export function readDesktopState(file: string): DesktopState {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return normalizeDesktopState(value);
  } catch {
    return {};
  }
}

export function normalizeDesktopState(value: unknown): DesktopState {
  if (!value || typeof value !== 'object') return {};
  const candidate = value as Record<string, unknown>;
  const workspace =
    typeof candidate['workspace'] === 'string'
      ? candidate['workspace']
      : undefined;
  const legacyWindows = Array.isArray(candidate['chatWindows'])
    ? candidate['chatWindows']
    : [];
  const window =
    normalizeWindowState(candidate['window']) ??
    normalizeWindowState(legacyWindows[0]);
  const computerUse = normalizeComputerUseState(candidate['computerUse']);
  return {
    ...(computerUse ? { computerUse } : {}),
    ...(workspace ? { workspace } : {}),
    ...(window ? { window } : {}),
  };
}

function normalizeComputerUseState(
  value: unknown,
): ComputerUseState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const hidden = (value as Record<string, unknown>)[
    'alwaysHidePictureInPicture'
  ];
  return typeof hidden === 'boolean'
    ? { alwaysHidePictureInPicture: hidden }
    : undefined;
}

export function initialWindowBounds(
  saved: WindowState | undefined,
  displays: readonly Rectangle[],
): WindowState {
  if (saved && displays.some((display) => intersects(saved, display))) {
    return {
      ...saved,
      width: Math.max(saved.width, MIN_WIDTH),
      height: Math.max(saved.height, MIN_HEIGHT),
    };
  }
  const display = displays[0] ?? {
    x: 0,
    y: 0,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
  };
  return {
    width: Math.min(DEFAULT_WIDTH, display.width),
    height: Math.min(DEFAULT_HEIGHT, display.height),
    x: display.x + Math.max(0, Math.floor((display.width - DEFAULT_WIDTH) / 2)),
    y:
      display.y +
      Math.max(0, Math.floor((display.height - DEFAULT_HEIGHT) / 2)),
    maximized: false,
  };
}

export function saveDesktopState(file: string, state: DesktopState): void {
  if (process.env['QWEN_DESKTOP_DISABLE_SETTINGS_PERSISTENCE'] === '1') return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

export function captureWindowState(window: BrowserWindow): WindowState {
  const normal = window.getNormalBounds();
  return { ...normal, maximized: window.isMaximized() };
}

function normalizeWindowState(value: unknown): WindowState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  const numbers = ['x', 'y', 'width', 'height'] as const;
  if (numbers.some((key) => !Number.isFinite(candidate[key]))) return undefined;
  return {
    x: candidate['x'] as number,
    y: candidate['y'] as number,
    width: Math.max(candidate['width'] as number, MIN_WIDTH),
    height: Math.max(candidate['height'] as number, MIN_HEIGHT),
    maximized: candidate['maximized'] === true,
  };
}

function intersects(left: Rectangle, right: Rectangle): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

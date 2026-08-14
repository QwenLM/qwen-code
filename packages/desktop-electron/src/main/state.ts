/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow, Rectangle } from 'electron';
import {
  readChatNavigation,
  type ChatNavigationState,
} from '../shared/chat-navigation';

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 820;
const MIN_WIDTH = 900;
const MIN_HEIGHT = 600;
const MAX_RESTORED_CHAT_WINDOWS = 8;

export interface DesktopState {
  browser?: BrowserWindowState;
  chatWindows?: ChatWindowState[];
  /** Phase 1 migration field. */
  window?: WindowState;
  workspace?: string;
}

export interface BrowserWindowState {
  url: string;
  window: WindowState;
}

export interface ChatWindowState extends WindowState, ChatNavigationState {}

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
  const window = normalizeWindowState(candidate['window']);
  const chatWindows = Array.isArray(candidate['chatWindows'])
    ? candidate['chatWindows']
        .map(normalizeChatWindowState)
        .filter((item): item is ChatWindowState => item !== undefined)
        .slice(0, MAX_RESTORED_CHAT_WINDOWS)
    : undefined;
  const browser = normalizeBrowserWindowState(candidate['browser']);
  return {
    ...(workspace ? { workspace } : {}),
    ...(window ? { window } : {}),
    ...(chatWindows?.length ? { chatWindows } : {}),
    ...(browser ? { browser } : {}),
  };
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

export function captureChatWindowState(window: BrowserWindow): ChatWindowState {
  return {
    ...captureWindowState(window),
    ...readChatNavigation(window.webContents.getURL()),
  };
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

function normalizeChatWindowState(value: unknown): ChatWindowState | undefined {
  const window = normalizeWindowState(value);
  if (!window || !value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  return {
    ...window,
    ...readChatNavigation(
      writeNavigationCandidate(
        candidate['sessionId'],
        candidate['workspaceId'],
      ),
    ),
  };
}

function writeNavigationCandidate(
  sessionId: unknown,
  workspaceId: unknown,
): string {
  const url = new URL('qwen-desktop://app/index.html');
  if (typeof sessionId === 'string') url.searchParams.set('session', sessionId);
  if (typeof workspaceId === 'string') {
    url.searchParams.set('workspace', workspaceId);
  }
  return url.href;
}

function normalizeBrowserWindowState(
  value: unknown,
): BrowserWindowState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  const window = normalizeWindowState(candidate['window']);
  const url = candidate['url'];
  if (!window || typeof url !== 'string') return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return undefined;
    }
    return { url: parsed.href, window };
  } catch {
    return undefined;
  }
}

function intersects(left: Rectangle, right: Rectangle): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

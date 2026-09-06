/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Terminal theme auto-adaptation parity (OSC 10/11 + live switching).
 *
 * Ink's `auto` theme resolves the terminal's light/dark background through a
 * detection chain (COLORFGBG → OSC 11 → macOS appearance → dark) and picks
 * Qwen Light / Qwen Dark accordingly (`ThemeManager.resolveAutoTheme`).
 * OpenTUI's renderer performs the OSC 10/11 probe itself and emits
 * `theme_mode` on live changes, so this module combines both worlds: the
 * renderer's mode wins, the ink sync chain is the fallback, and the Qwen
 * light/dark pair selection matches the ink manager exactly.
 */

import type { ThemeMode } from '@opentui/core';
import type { Theme } from '../themes/theme.js';
import { QwenDark } from '../themes/qwen-dark.js';
import { QwenLight } from '../themes/qwen-light.js';
import {
  detectFromColorFgBg,
  detectMacOSTheme,
  OSC11_TIMEOUT_MS,
} from '../themes/detect-terminal-theme.js';

/** Ink's OSC 11 probe timeout — the shared constant, not a hand copy. */
export const THEME_MODE_WAIT_MS = OSC11_TIMEOUT_MS;

/** Structural view of the OpenTUI renderer's theme-mode query API. */
export interface OpenTuiThemeModeHost {
  themeMode: ThemeMode | null;
  waitForThemeMode(timeoutMs?: number): Promise<ThemeMode | null>;
}

/** Structural view of the OpenTUI renderer's `theme_mode` event API. */
export interface OpenTuiThemeModeEmitter {
  on(event: 'theme_mode', listener: (mode: ThemeMode) => void): unknown;
  off(event: 'theme_mode', listener: (mode: ThemeMode) => void): unknown;
}

/**
 * Normalises a probed mode to a definite value. Unknown / null stays dark —
 * the exact ink default (`detectTerminalTheme` ends in 'dark').
 */
export function resolveThemeMode(
  mode: ThemeMode | null | undefined,
): ThemeMode {
  return mode === 'light' ? 'light' : 'dark';
}

/**
 * Parity of `ThemeManager.resolveAutoTheme`: auto resolves to the Qwen pair,
 * light terminal → Qwen Light, otherwise Qwen Dark.
 */
export function resolveAutoTheme(mode: ThemeMode | null | undefined): Theme {
  return resolveThemeMode(mode) === 'light' ? QwenLight : QwenDark;
}

/**
 * Initial dark/light resolution for OpenTUI, in the exact order of ink's
 * async chain (`detectTerminalThemeAsync`): COLORFGBG first (instant), then
 * the OSC 10/11 probe — performed by the renderer here —, then macOS system
 * appearance, then the dark default.
 */
export async function detectInitialThemeMode(
  host?: OpenTuiThemeModeHost | null,
  timeoutMs: number = THEME_MODE_WAIT_MS,
): Promise<ThemeMode> {
  const colorFgBg = detectFromColorFgBg();
  if (colorFgBg) {
    return colorFgBg;
  }

  if (host) {
    if (host.themeMode) {
      return host.themeMode;
    }
    try {
      const waited = await host.waitForThemeMode(timeoutMs);
      if (waited) {
        return waited;
      }
    } catch {
      // A failing probe must degrade to the fallback chain, never crash.
    }
  }

  return detectMacOSTheme() ?? 'dark';
}

/**
 * Subscribes to live terminal theme changes (OSC 10/11 updates reported by
 * the renderer as `theme_mode`). Returns the unsubscribe function.
 */
export function subscribeThemeMode(
  emitter: OpenTuiThemeModeEmitter,
  onChange: (mode: ThemeMode) => void,
): () => void {
  emitter.on('theme_mode', onChange);
  return () => {
    emitter.off('theme_mode', onChange);
  };
}

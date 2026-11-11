/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { themeManager } from './themes/theme-manager.js';
import type { SemanticColors } from './themes/semantic-tokens.js';
import type { ThemeType } from './themes/theme.js';

/**
 * Returns the ThemeType of the currently active theme.
 */
export function getThemeType(): ThemeType {
  return themeManager.getThemeType();
}

/**
 * Returns the name of the currently active theme.
 */
export function getThemeName(): string {
  return themeManager.getThemeName();
}

export const theme: SemanticColors = {
  get text() {
    return themeManager.getSemanticColors().text;
  },
  get background() {
    return themeManager.getSemanticColors().background;
  },
  get border() {
    return themeManager.getSemanticColors().border;
  },
  get ui() {
    return themeManager.getSemanticColors().ui;
  },
  get status() {
    return themeManager.getSemanticColors().status;
  },
  get agent() {
    return themeManager.getSemanticColors().agent;
  },
};

/**
 * Resolve a semantic color path (e.g., 'status.error', 'text.accent') to an
 * actual theme color string. Used by permission-mode config so that color
 * values defined in core can be resolved against the runtime theme.
 */
export function resolveThemeColor(path: string): string {
  const [group, key] = path.split('.') as [string, string];
  const section = theme[group as keyof SemanticColors];
  if (section && typeof section === 'object' && key in section) {
    return (section as Record<string, string>)[key] ?? '';
  }
  return '';
}

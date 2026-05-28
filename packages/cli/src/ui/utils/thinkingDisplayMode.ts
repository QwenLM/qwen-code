/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import process from 'node:process';
import type { LoadedSettings } from '../../config/settings.js';

export const THINKING_DISPLAY_ENV = 'QWEN_TUI_THINKING_DISPLAY';

export type ThinkingDisplayMode = 'preview' | 'loading';

export const DEFAULT_THINKING_DISPLAY_MODE: ThinkingDisplayMode = 'preview';

export function normalizeThinkingDisplayMode(
  value: unknown,
): ThinkingDisplayMode | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === 'preview' || normalized === 'loading'
    ? normalized
    : undefined;
}

export function getThinkingDisplayMode(
  settings: LoadedSettings,
): ThinkingDisplayMode {
  return (
    normalizeThinkingDisplayMode(process.env[THINKING_DISPLAY_ENV]) ??
    normalizeThinkingDisplayMode(settings.merged.ui?.thinkingDisplayMode) ??
    DEFAULT_THINKING_DISPLAY_MODE
  );
}

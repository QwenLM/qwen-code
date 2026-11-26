/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LoadedSettings } from '../../config/settings.js';

export type InlineThinkingMode = 'off' | 'full';

export function getInlineThinkingMode(
  settings: LoadedSettings,
): InlineThinkingMode {
  return settings.merged.ui?.inlineThinkingMode ?? 'full';
}

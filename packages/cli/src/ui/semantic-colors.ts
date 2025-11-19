/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SemanticColors } from './themes/semantic-tokens.js';

// This file is deprecated. Use the useTheme hook from ThemeContext instead.
// The static exports will remain for backward compatibility during migration.
// To use the dynamic theme that updates when the theme changes, use the useTheme hook.

import { themeManager } from './themes/theme-manager.js';

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
};

/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type TerminalBackgroundColor,
  terminalCapabilityManager,
} from '../ui/utils/terminalCapabilityManager.js';
import {
  themeManager,
  isAutoThemeSetting,
} from '../ui/themes/theme-manager.js';
import type { LoadedSettings } from '../config/settings.js';
import { type Config, coreEvents, runLogger } from '@qwen-code/core';

/**
 * Detects terminal capabilities, loads themes, and sets the active theme.
 * @param config The application config.
 * @param settings The loaded settings.
 * @returns The detected terminal background color.
 */
export async function setupTerminalAndTheme(
  config: Config,
  settings: LoadedSettings,
): Promise<TerminalBackgroundColor> {
  // Load custom themes before the async terminal probe so startup can overlap
  // terminal capability detection with app initialization without causing
  // validateTheme() to miss user-defined themes.
  themeManager.loadCustomThemes(settings.merged.ui.customThemes);

  let terminalBackground: TerminalBackgroundColor = undefined;
  if (config.isInteractive() && process.stdin.isTTY) {
    // Windows cmd/PowerShell/ConPTY can deliver terminal probe responses through
    // the same raw-mode stdin path as user input before Ink owns stdin. Avoid
    // startup probes there so the first Enter is never consumed by detection.
    if (process.platform !== 'win32') {
      // Detect terminal capabilities (Kitty protocol, background color) in parallel.
      await terminalCapabilityManager.detectCapabilities();
    }
    terminalBackground = terminalCapabilityManager.getTerminalBackgroundColor();
  }

  // Resolving before the first frame is what makes 'auto' correct on startup
  // rather than 60 seconds later. A concrete theme name resolves to itself.
  const themeSetting = settings.merged.ui.theme;
  const resolvedTheme = themeManager.resolveThemeSetting(
    themeSetting,
    terminalBackground,
    settings.merged.ui.autoThemePair,
  );
  if (!themeManager.setActiveTheme(resolvedTheme)) {
    // If the theme is not found during initial load, log a warning and continue.
    // The useThemeCommand hook in AppContainer.tsx will handle opening the dialog.
    runLogger.warn(`Warning: Theme "${resolvedTheme}" not found.`);
  }

  config.setTerminalBackground(terminalBackground);
  themeManager.setTerminalBackground(terminalBackground);

  // Only a theme the user pinned can be "wrong" — auto mode already picked the
  // matching one, and telling users to run /theme to fix something the CLI just
  // handled is pure noise. The mismatch test uses the same hysteresis band the
  // follower switches on, so a warning always implies a fix is available.
  if (!isAutoThemeSetting(themeSetting) && terminalBackground !== undefined) {
    const currentTheme = themeManager.getActiveTheme();
    const backgroundType = themeManager.getMismatchedBackgroundType(
      currentTheme,
      terminalBackground,
    );
    if (backgroundType) {
      coreEvents.emitFeedback(
        'warning',
        `Theme '${currentTheme.name}' (${currentTheme.type}) might look incorrect on your ${backgroundType} terminal background. Type /theme to change theme, or pick 'Auto' to follow your terminal automatically.`,
      );
    }
  }

  return terminalBackground;
}

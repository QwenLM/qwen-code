/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';
import { parseColor } from '../themes/color-utils.js';
import { themeManager, isAutoThemeSetting } from '../themes/theme-manager.js';
import { useSettings } from '../contexts/SettingsContext.js';
import type { Config } from '@qwen-code/core';
import { useTerminalContext } from '../contexts/TerminalContext.js';

/**
 * Keeps the active theme in sync with the terminal background while
 * `ui.theme` is `auto` (or unset).
 *
 * The resolved theme is applied in memory only. Persisting it — as this hook
 * used to — collapses intent ("follow the terminal") into state ("I am dark"),
 * which is what made two terminals overwrite each other's global `ui.theme`.
 */
export function useTerminalTheme(config: Config, requestRender: () => void) {
  const settings = useSettings();
  const { subscribe, unsubscribe, queryTerminalBackground } =
    useTerminalContext();

  // The last theme name we resolved. Deliberately not read back from
  // themeManager.getThemeName(): that masks the active theme with NoColorTheme
  // when NO_COLOR is set, so the comparison would never match and we would
  // re-apply and re-render on every single poll.
  const appliedThemeRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (settings.merged.ui.autoThemeSwitching === false) {
      return;
    }

    // Only poll for changes to the terminal background if a terminal background was detected at startup.
    if (config.getTerminalBackground() === undefined) {
      return;
    }

    const themeSetting = settings.merged.ui.theme;
    const autoThemePair = settings.merged.ui.autoThemePair;
    const isAuto = isAutoThemeSetting(themeSetting);

    // Seed with the same resolution startup applied, so the first re-resolution
    // has a previous state to apply hysteresis against.
    appliedThemeRef.current = themeManager.resolveThemeSetting(
      themeSetting,
      config.getTerminalBackground(),
      autoThemePair,
    );

    // A theme the user pinned is never overridden, so there is nothing to poll
    // for. We still subscribe below: a background report triggered elsewhere
    // (opening /theme queries it) must still refresh the cached background that
    // theme blending reads.
    const pollIntervalId = isAuto
      ? setInterval(
          () => {
            void queryTerminalBackground();
          },
          settings.merged.ui.terminalBackgroundPollingInterval * 1000,
        )
      : undefined;

    const handleTerminalBackground = (colorStr: string) => {
      // Parse the response "rgb:rrrr/gggg/bbbb"
      const match =
        /^rgb:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})$/.exec(
          colorStr,
        );
      if (!match) return;

      const hexColor = parseColor(match[1], match[2], match[3]);
      if (!hexColor) return;

      const backgroundChanged = config.getTerminalBackground() !== hexColor;
      if (backgroundChanged) {
        config.setTerminalBackground(hexColor);
        themeManager.setTerminalBackground(hexColor);
      }

      if (isAuto) {
        const resolved = themeManager.resolveThemeSetting(
          themeSetting,
          hexColor,
          autoThemePair,
          appliedThemeRef.current,
        );
        if (appliedThemeRef.current !== resolved) {
          appliedThemeRef.current = resolved;
          themeManager.setActiveTheme(resolved);
          requestRender();
          return;
        }
      }

      if (backgroundChanged) {
        // The existing theme had its background changed so refresh because
        // there may be existing static UI rendered that relies on the old
        // background color.
        requestRender();
      }
    };

    subscribe(handleTerminalBackground);

    return () => {
      if (pollIntervalId !== undefined) {
        clearInterval(pollIntervalId);
      }
      unsubscribe(handleTerminalBackground);
    };
  }, [
    settings.merged.ui.theme,
    settings.merged.ui.autoThemePair,
    settings.merged.ui.autoThemeSwitching,
    settings.merged.ui.terminalBackgroundPollingInterval,
    config,
    subscribe,
    unsubscribe,
    queryTerminalBackground,
    requestRender,
  ]);
}

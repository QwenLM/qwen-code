/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useSettings } from '../contexts/SettingsContext.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useVimModeState } from '../contexts/VimModeContext.js';
import { useTerminalSize } from './useTerminalSize.js';
import { useStatusLineState } from './useStatusLine.js';

export function useStatusLine(
  keepAutomaticContextIndicator = false,
  availableWidth?: number,
) {
  const settings = useSettings();
  const state = useUIState();
  const config = useConfig();
  const { vimEnabled, vimMode } = useVimModeState();
  const { columns: terminalWidth } = useTerminalSize();
  return useStatusLineState(
    {
      settings,
      state,
      config,
      terminalWidth,
      vimMode: vimEnabled ? vimMode : undefined,
    },
    keepAutomaticContextIndicator,
    availableWidth,
  );
}

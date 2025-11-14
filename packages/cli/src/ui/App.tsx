/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, useIsScreenReaderEnabled } from 'ink';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import { lerp } from '../utils/math.js';
import { useUIState } from './contexts/UIStateContext.js';
import { StreamingContext } from './contexts/StreamingContext.js';
import { QuittingDisplay } from './components/QuittingDisplay.js';
import { ScreenReaderAppLayout } from './layouts/ScreenReaderAppLayout.js';
import { DefaultAppLayout } from './layouts/DefaultAppLayout.js';
import { SubagentFullscreenPanel } from './components/subagents/runtime/SubagentFullscreenPanel.js';

const getContainerWidth = (terminalWidth: number): string => {
  if (terminalWidth <= 80) {
    return '98%';
  }
  if (terminalWidth >= 132) {
    return '90%';
  }

  // Linearly interpolate between 80 columns (98%) and 132 columns (90%).
  const t = (terminalWidth - 80) / (132 - 80);
  const percentage = lerp(98, 90, t);

  return `${Math.round(percentage)}%`;
};

export const App = () => {
  const uiState = useUIState();
  const isScreenReaderEnabled = useIsScreenReaderEnabled();
  const { columns } = useTerminalSize();
  const containerWidth = getContainerWidth(columns);

  if (uiState.quittingMessages) {
    return <QuittingDisplay />;
  }

  const showFullscreen = Boolean(uiState.subagentFullscreenPanel);
  const mainLayout = isScreenReaderEnabled ? (
    <ScreenReaderAppLayout />
  ) : (
    <DefaultAppLayout width={containerWidth} />
  );

  return (
    <StreamingContext.Provider value={uiState.streamingState}>
      <Box display={showFullscreen ? 'none' : 'flex'}>{mainLayout}</Box>
      {showFullscreen && uiState.subagentFullscreenPanel && (
        <SubagentFullscreenPanel panel={uiState.subagentFullscreenPanel} />
      )}
    </StreamingContext.Provider>
  );
};

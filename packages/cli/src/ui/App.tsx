/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { Box, useIsScreenReaderEnabled } from 'ink';
import { useUIState } from './contexts/UIStateContext.js';
import { useSettings } from './contexts/SettingsContext.js';
import { StreamingContext } from './contexts/StreamingContext.js';
import { QuittingDisplay } from './components/QuittingDisplay.js';
import { SettingsCorruptedDialog } from './components/SettingsCorruptedDialog.js';
import { ScreenReaderAppLayout } from './layouts/ScreenReaderAppLayout.js';
import { DefaultAppLayout } from './layouts/DefaultAppLayout.js';
import fs from 'node:fs';

export const App = () => {
  const uiState = useUIState();
  const settings = useSettings();
  const isScreenReaderEnabled = useIsScreenReaderEnabled();
  const [dismissed, setDismissed] = useState(false);

  if (uiState.quittingMessages) {
    return <QuittingDisplay />;
  }

  // Render corrupted dialog at the top level, before any other UI
  if (settings.corruptedPath && !dismissed) {
    return (
      <StreamingContext.Provider value={uiState.streamingState}>
        <Box marginX={2}>
          <SettingsCorruptedDialog
            corruptedPath={settings.corruptedPath}
            wasRecovered={settings.wasRecovered}
            onExit={() => {
              try {
                const settingsPath = settings.corruptedPath!.replace(
                  /\.corrupted$/,
                  '',
                );
                fs.copyFileSync(settings.corruptedPath!, settingsPath);
              } catch {
                /* ignore */
              }
              process.exit(1);
            }}
            onContinue={() => {
              setDismissed(true);
            }}
          />
        </Box>
      </StreamingContext.Provider>
    );
  }

  return (
    <StreamingContext.Provider value={uiState.streamingState}>
      {isScreenReaderEnabled ? <ScreenReaderAppLayout /> : <DefaultAppLayout />}
    </StreamingContext.Provider>
  );
};

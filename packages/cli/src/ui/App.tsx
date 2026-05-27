/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { Box, useIsScreenReaderEnabled } from 'ink';
import { useUIState } from './contexts/UIStateContext.js';
import { useSettings } from './contexts/SettingsContext.js';
import { CORRUPTED_SUFFIX } from '../config/settings.js';
import { writeStderrLine } from '../utils/stdioHelpers.js';
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
              if (
                settings.corruptedPath &&
                fs.existsSync(settings.corruptedPath)
              ) {
                try {
                  const settingsPath = settings.corruptedPath.slice(
                    0,
                    -CORRUPTED_SUFFIX.length,
                  );
                  fs.copyFileSync(settings.corruptedPath, settingsPath);
                  fs.unlinkSync(settings.corruptedPath);
                } catch (e) {
                  writeStderrLine(
                    `Failed to restore corrupted file: ${e instanceof Error ? e.message : String(e)}`,
                  );
                }
              }
              process.exit(1);
            }}
            onContinue={() => {
              if (
                settings.corruptedPath &&
                fs.existsSync(settings.corruptedPath)
              ) {
                try {
                  fs.unlinkSync(settings.corruptedPath);
                } catch {
                  /* ignore */
                }
              }
              settings.corruptionDialogDismissed = true;
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

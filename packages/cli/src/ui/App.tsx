/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { memo, useEffect } from 'react';
import { startChangelogRefresh } from '../changelog/changelogRefresh.js';
import { releaseNotesCommand } from './commands/releaseNotesCommand.js';
import { useUIState } from './contexts/UIStateContext.js';
import { StreamingContext } from './contexts/StreamingContext.js';
import { DefaultAppLayout } from './layouts/DefaultAppLayout.js';

const AppComponent = () => {
  const uiState = useUIState();
  const usesCliReleaseNotes =
    uiState.slashCommands?.some(
      (command) => command.action === releaseNotesCommand.action,
    ) === true;
  useEffect(() => {
    if (!usesCliReleaseNotes) return undefined;
    return startChangelogRefresh();
  }, [usesCliReleaseNotes]);

  return (
    <StreamingContext.Provider value={uiState.streamingState}>
      <DefaultAppLayout />
    </StreamingContext.Provider>
  );
};

AppComponent.displayName = 'App';

export const App = memo(AppComponent);

/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../../colors.js';
import type { SessionBrowserState } from '../SessionBrowser.js';
import { InputFrame } from '../shared/InputFrame.js';
import { useI18nService } from '../../i18n/index.js';

/**
 * Search input display component.
 */
export const SearchModeDisplay = ({
  state,
}: {
  state: SessionBrowserState;
}): React.JSX.Element => {
  const i18n = useI18nService();
  return (
    <InputFrame active>
      <Text color={Colors.Gray}>{i18n.get('session.search.label')} </Text>
      <Text color={Colors.AccentPurple}>{state.searchQuery}</Text>
      <Text color={Colors.Gray}> ({i18n.get('session.search.cancel')})</Text>
    </InputFrame>
  );
};

/**
 * No results display component for empty search results.
 */
export const NoResultsDisplay = ({
  state,
}: {
  state: SessionBrowserState;
}): React.JSX.Element => {
  const i18n = useI18nService();
  return (
    <Box marginTop={1}>
      <Text color={Colors.Gray} dimColor>
        {i18n.get('session.search.noResults', {
          query: state.searchQuery,
          scope: i18n.get(
            state.projectScope === 'all-projects'
              ? 'session.scope.allProjects'
              : state.worktreeScope === 'current'
                ? 'session.scope.currentWorktreeSearch'
                : 'session.scope.allWorktrees',
          ),
        })}
      </Text>
    </Box>
  );
};

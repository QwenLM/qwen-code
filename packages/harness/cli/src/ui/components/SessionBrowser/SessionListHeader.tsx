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
import { useI18nService } from '../../i18n/index.js';

/**
 * Header component showing session count and sort information.
 */
export const SessionListHeader = ({
  state,
}: {
  state: SessionBrowserState;
}): React.JSX.Element => {
  const i18n = useI18nService();
  const scope = i18n.get(
    state.projectScope === 'all-projects'
      ? 'session.scope.allProjects'
      : state.worktreeScope === 'current'
        ? 'session.scope.currentWorktree'
        : 'session.scope.allWorktrees',
  );
  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Text color={Colors.AccentPurple}>
        {i18n.get('session.header', { count: state.totalSessions, scope })}
        {state.branchScope === 'current'
          ? i18n.get('session.header.currentBranch')
          : ''}
        {state.searchQuery ? i18n.get('session.header.filtered') : ''}
        {i18n.get('session.header.close')}
      </Text>
      <Text color={Colors.Gray}>
        {i18n.get('session.sorted', {
          field: i18n.get(
            state.sortOrder === 'date'
              ? 'session.sort.date'
              : state.sortOrder === 'messages'
                ? 'session.sort.messages'
                : 'session.sort.name',
          ),
          direction: i18n.get(
            state.sortReverse
              ? 'session.sort.direction.asc'
              : 'session.sort.direction.desc',
          ),
        })}
      </Text>
    </Box>
  );
};

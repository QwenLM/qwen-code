/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import { SessionService, getGitBranch } from '@qwen-code/qwen-code-core';
import { theme } from '../semantic-colors.js';
import { useDialogSessionPicker } from '../hooks/useDialogSessionPicker.js';
import { SessionListItemView } from './SessionListItem.js';
import { t } from '../../i18n/index.js';

export interface ResumeSessionDialogProps {
  cwd: string;
  onSelect: (sessionId: string) => void;
  onCancel: () => void;
  availableTerminalHeight?: number;
}

export function ResumeSessionDialog({
  cwd,
  onSelect,
  onCancel,
  availableTerminalHeight,
}: ResumeSessionDialogProps): React.JSX.Element {
  const sessionServiceRef = useRef<SessionService | null>(null);
  const [currentBranch, setCurrentBranch] = useState<string | undefined>();
  const [isReady, setIsReady] = useState(false);

  // Initialize session service
  useEffect(() => {
    sessionServiceRef.current = new SessionService(cwd);
    setCurrentBranch(getGitBranch(cwd));
    setIsReady(true);
  }, [cwd]);

  // Calculate visible items based on terminal height
  const maxVisibleItems = availableTerminalHeight
    ? Math.max(3, Math.floor((availableTerminalHeight - 6) / 3))
    : 5;

  const picker = useDialogSessionPicker({
    sessionService: sessionServiceRef.current,
    currentBranch,
    onSelect,
    onCancel,
    maxVisibleItems,
    centerSelection: false,
    isActive: isReady,
  });

  if (!isReady || picker.isLoading) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.border.default}
        padding={1}
      >
        <Text color={theme.text.primary} bold>
          {t('Resume Session')}
        </Text>
        <Box paddingY={1}>
          <Text color={theme.text.secondary}>{t('Loading sessions...')}</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border.default}
      padding={1}
    >
      {/* Header */}
      <Box marginBottom={1}>
        <Text color={theme.text.primary} bold>
          {t('Resume Session')}
        </Text>
        {picker.filterByBranch && currentBranch && (
          <Text color={theme.text.secondary}>
            {' '}
            {t('(branch: {{branch}})', { branch: currentBranch })}
          </Text>
        )}
      </Box>

      {/* Session List */}
      <Box flexDirection="column" paddingX={1}>
        {picker.filteredSessions.length === 0 ? (
          <Box paddingY={1}>
            <Text color={theme.text.secondary}>
              {picker.filterByBranch
                ? t('No sessions found for branch "{{branch}}"', {
                    branch: currentBranch ?? '',
                  })
                : t('No sessions found')}
            </Text>
          </Box>
        ) : (
          picker.visibleSessions.map((session, visibleIndex) => {
            const actualIndex = picker.scrollOffset + visibleIndex;
            return (
              <SessionListItemView
                key={session.sessionId}
                session={session}
                isSelected={actualIndex === picker.selectedIndex}
                isFirst={visibleIndex === 0}
                isLast={visibleIndex === picker.visibleSessions.length - 1}
                showScrollUp={picker.showScrollUp}
                showScrollDown={picker.showScrollDown}
                maxPromptWidth={(process.stdout.columns || 80) - 10}
              />
            );
          })
        )}
      </Box>

      {/* Footer */}
      <Box
        marginTop={1}
        borderStyle="single"
        borderTop
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
        paddingTop={1}
      >
        <Text color={theme.text.secondary}>
          {currentBranch && (
            <>
              <Text color={theme.text.accent} bold>
                B
              </Text>
              {t(' to toggle branch') + ' · '}
            </>
          )}
          {t('to navigate · Enter to select · Esc to cancel')}
        </Text>
      </Box>
    </Box>
  );
}

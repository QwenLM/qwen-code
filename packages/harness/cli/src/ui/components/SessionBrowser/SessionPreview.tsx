/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import type {
  SessionInfo,
  SessionSelectionResult,
} from '../../../utils/sessionUtils.js';
import { formatRelativeTime } from '../../../utils/sessionUtils.js';
import { Colors } from '../../colors.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { TranscriptHistoryView } from '../TranscriptHistoryView.js';
import { useI18nService } from '../../i18n/index.js';

export interface SessionPreviewProps {
  session: SessionInfo;
  loading: boolean;
  resolved?: SessionSelectionResult;
  error?: string;
}

export function SessionPreview({
  session,
  loading,
  resolved,
  error,
}: SessionPreviewProps): React.JSX.Element {
  const { columns } = useTerminalSize();
  const i18n = useI18nService();
  const { locale } = i18n;
  const messageCount =
    resolved?.sessionInfo.messageCount ??
    (session.isMetadataOnly ? undefined : session.messageCount);
  const metadata = [
    formatRelativeTime(session.lastUpdated, 'long', locale),
    messageCount === undefined
      ? undefined
      : i18n.get(
          messageCount === 1
            ? 'session.messageCount.one'
            : 'session.messageCount.other',
          { count: messageCount },
        ),
    session.gitBranch,
  ].filter((value): value is string => Boolean(value));

  return (
    <Box flexDirection="column">
      <Text color={Colors.AccentPurple} bold wrap="truncate-end">
        {session.displayName || i18n.get('session.noMessages')}
      </Text>
      <Text color={Colors.Gray}>{metadata.join(' · ')}</Text>

      <Box marginTop={1} flexDirection="column">
        {loading ? (
          <Text color={Colors.Gray}>{i18n.get('session.preview.loading')}</Text>
        ) : error ? (
          <Box flexDirection="column">
            <Text color={Colors.AccentRed}>
              {i18n.get('session.preview.failed')} {error}
            </Text>
            <Text color={Colors.Gray}>
              {i18n.get('session.preview.recovery')}
            </Text>
          </Box>
        ) : resolved ? (
          <TranscriptHistoryView
            conversationKey={`session-preview:${session.sessionPath ?? session.id}`}
            messages={resolved.messages}
            terminalWidth={columns}
            showAll
          />
        ) : null}
      </Box>
    </Box>
  );
}

/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import type {
  ResumedSessionData,
  SessionService,
} from '@qwen-code/qwen-code-core';
import { theme } from '../semantic-colors.js';
import { HistoryItemDisplay } from './HistoryItemDisplay.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { buildResumedHistoryItems } from '../utils/resumeHistoryUtils.js';
import { formatRelativeTime } from '../utils/formatters.js';
import { formatMessageCount } from '../utils/sessionPickerUtils.js';
import { t } from '../../i18n/index.js';

export interface SessionPreviewProps {
  sessionService: SessionService;
  sessionId: string;
  sessionTitle?: string;
  /** Message count from the session list entry, for the footer. */
  messageCount?: number;
  /** Last-modified time (ms epoch) from the session list entry, for the footer. */
  mtime?: number;
  /** Git branch from the session list entry, for the footer. */
  gitBranch?: string;
  onExit: () => void;
  onResume: (sessionId: string) => void;
}

export function SessionPreview(props: SessionPreviewProps) {
  const {
    sessionService,
    sessionId,
    sessionTitle,
    messageCount,
    mtime,
    gitBranch,
    onExit,
    onResume,
  } = props;
  const { columns } = useTerminalSize();
  const [data, setData] = useState<ResumedSessionData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    sessionService
      .loadSession(sessionId)
      .then((d: ResumedSessionData | undefined) => {
        if (cancelled) return;
        if (!d) {
          setError('Session not found');
          return;
        }
        setData(d);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionService, sessionId]);

  // Preview passes `null` config: tool_group entries degrade to name-only
  // (no description). Users can press Enter to resume for full fidelity.
  const items = useMemo(() => {
    if (!data) return [];
    return buildResumedHistoryItems(data, null);
  }, [data]);

  // `listSessions` omits `messageCount` for perf, so the prop is usually
  // undefined in practice. Compute the count from the loaded conversation
  // using the same unique-user/assistant-uuid semantics as
  // `SessionService.countSessionMessages` — the data is already in memory,
  // so this is free and avoids an extra disk read.
  const computedMessageCount = useMemo(() => {
    if (!data) return undefined;
    const seen = new Set<string>();
    for (const msg of data.conversation.messages) {
      if (msg.type === 'user' || msg.type === 'assistant') {
        seen.add(msg.uuid);
      }
    }
    return seen.size;
  }, [data]);
  const displayMessageCount = messageCount ?? computedMessageCount;

  useKeypress(
    (key) => {
      const { name, ctrl } = key;
      if (name === 'escape' || (ctrl && name === 'c')) {
        onExit();
        return;
      }
      if (name === 'return') {
        onResume(sessionId);
      }
    },
    { isActive: true },
  );

  // Clamp to a safe minimum: `'─'.repeat(boxWidth - 2)` would throw RangeError
  // in very narrow terminals (tmux splits, small panes) if boxWidth < 2.
  const boxWidth = Math.max(10, columns - 4);
  const separatorWidth = Math.max(0, boxWidth - 2);

  const metaParts: string[] = [];
  if (typeof displayMessageCount === 'number') {
    metaParts.push(formatMessageCount(displayMessageCount));
  }
  if (typeof mtime === 'number') {
    metaParts.push(formatRelativeTime(mtime));
  }
  if (gitBranch) {
    metaParts.push(gitBranch);
  }
  const metaLine = metaParts.join(' · ');

  return (
    <Box flexDirection="column" width={boxWidth}>
      {/* Header */}
      <Box paddingX={1}>
        <Text bold color={theme.text.primary}>
          {sessionTitle ?? t('Session Preview')}
        </Text>
      </Box>
      <Box>
        <Text color={theme.border.default}>{'─'.repeat(separatorWidth)}</Text>
      </Box>

      {/* Body: render all items, let the terminal's scrollback own overflow. */}
      {error ? (
        <Box paddingY={1} justifyContent="center">
          <Text color={theme.status.error}>{error}</Text>
        </Box>
      ) : !data ? (
        <Box paddingY={1} justifyContent="center">
          <Text color={theme.text.secondary}>
            {t('Loading session preview...')}
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {items.map((item) => (
            <HistoryItemDisplay
              key={item.id}
              item={item}
              terminalWidth={boxWidth}
              isPending={false}
            />
          ))}
        </Box>
      )}

      {/* Footer */}
      <Box>
        <Text color={theme.border.default}>{'─'.repeat(separatorWidth)}</Text>
      </Box>
      {metaLine && (
        <Box paddingX={1}>
          <Text color={theme.text.secondary}>{metaLine}</Text>
        </Box>
      )}
      <Box paddingX={1}>
        <Text color={theme.text.secondary}>
          {t('Enter to resume · Esc to back')}
        </Text>
      </Box>
    </Box>
  );
}

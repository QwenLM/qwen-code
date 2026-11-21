/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Static, Text } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ResumedSessionData,
  SessionService,
} from '@qwen-code/qwen-code-core';
import { theme } from '../semantic-colors.js';
import { HistoryItemDisplay } from './HistoryItemDisplay.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { useDialogSize } from '../contexts/DialogSizeContext.js';
import { buildResumedHistoryItems } from '../utils/resumeHistoryUtils.js';
import { formatRelativeTime } from '../utils/formatters.js';
import { formatMessageCount } from '../utils/sessionPickerUtils.js';
import { t } from '../../i18n/index.js';
import {
  ScrollableList,
  type ScrollableListRef,
} from './shared/ScrollableList.js';
import type { HistoryItem } from '../types.js';
import {
  TextSelectionController,
  type SelectionQuery,
} from '../selection/use-text-selection.js';
import { ContentMouseController } from '../context-menu/ContentMouseController.js';
import { useContextMenu } from '../context-menu/ContextMenuContext.js';

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
  const { columns, rows, isDialog } = useDialogSize();
  const [data, setData] = useState<ResumedSessionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollableListRef<HistoryItem>>(null);
  const selectionQueryRef = useRef<SelectionQuery | null>(null);
  const { menu, isMenuOpen } = useContextMenu();

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
      if (isMenuOpen()) return;
      const { name, ctrl } = key;
      if (name === 'escape' || (ctrl && name === 'c')) {
        onExit();
        return;
      }
      if (name === 'return') {
        onResume(sessionId);
      }
    },
    { isActive: menu === null },
  );

  // Clamp to a safe minimum: `'─'.repeat(boxWidth - 2)` would throw RangeError
  // in very narrow terminals (tmux splits, small panes) if boxWidth < 2.
  const boxWidth = Math.max(4, columns - (isDialog ? 0 : 4));
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

  const header = (
    <Box key="header" paddingX={1}>
      <Text
        bold
        color={theme.text.primary}
        wrap={isDialog ? 'truncate-end' : 'wrap'}
      >
        {sessionTitle ?? t('Session Preview')}
      </Text>
    </Box>
  );
  const topSeparator = (
    <Box key="top-separator">
      <Text color={theme.border.default}>{'─'.repeat(separatorWidth)}</Text>
    </Box>
  );
  const footerSeparator = (
    <Box key="footer-separator">
      <Text color={theme.border.default}>{'─'.repeat(separatorWidth)}</Text>
    </Box>
  );
  const meta = metaLine ? (
    <Box key="meta" paddingX={1}>
      <Text
        color={theme.text.secondary}
        wrap={isDialog ? 'truncate-end' : 'wrap'}
      >
        {metaLine}
      </Text>
    </Box>
  ) : null;
  const footer = (
    <Box key="footer" paddingX={1}>
      <Text
        color={theme.text.secondary}
        wrap={isDialog ? 'truncate-end' : 'wrap'}
      >
        {t('Enter to resume · Esc to back')}
      </Text>
    </Box>
  );

  if (isDialog) {
    return (
      <Box
        flexDirection="column"
        width={boxWidth}
        height={rows}
        borderStyle="round"
        borderColor={theme.border.default}
        overflow="hidden"
      >
        {header}
        {topSeparator}
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          {data && !error ? (
            <ScrollableList
              key={sessionId}
              ref={scrollRef}
              hasFocus={menu === null}
              data={items}
              containerHeight={Math.max(1, rows - (meta ? 7 : 6))}
              estimatedItemHeight={() => 3}
              keyExtractor={(item) => String(item.id)}
              stickToBottom={false}
              renderItem={({ item }) => (
                <HistoryItemDisplay
                  item={item}
                  terminalWidth={boxWidth - 2}
                  isPending={false}
                  isFocused={false}
                  thoughtExpanded={true}
                />
              )}
            />
          ) : (
            <Text color={error ? theme.status.error : theme.text.secondary}>
              {error ?? t('Loading session preview...')}
            </Text>
          )}
        </Box>
        <TextSelectionController
          key={`selection-${sessionId}`}
          isActive={data !== null && error === null}
          eventsPaused={menu !== null}
          getViewportRect={() => scrollRef.current?.getViewportRect() ?? null}
          getScrollState={() =>
            scrollRef.current?.getScrollState() ?? {
              scrollTop: 0,
              scrollHeight: 0,
              innerHeight: 0,
            }
          }
          hitTestScrollbar={(location) =>
            scrollRef.current?.hitTestScrollbar(location) ?? false
          }
          selectionQueryRef={selectionQueryRef}
        />
        <ContentMouseController
          isActive={data !== null && error === null}
          getViewportRect={() => scrollRef.current?.getViewportRect() ?? null}
          hitTestScrollbar={(location) =>
            scrollRef.current?.hitTestScrollbar(location) ?? false
          }
          selectionQueryRef={selectionQueryRef}
        />
        {footerSeparator}
        {meta}
        {footer}
      </Box>
    );
  }

  if (data && !error) {
    return (
      <Box flexDirection="column" width={boxWidth}>
        <Static
          key={sessionId}
          items={[
            header,
            topSeparator,
            ...items.map((item) => (
              <HistoryItemDisplay
                key={item.id}
                item={item}
                terminalWidth={boxWidth}
                isPending={false}
                thoughtExpanded={true}
              />
            )),
            footerSeparator,
            ...(meta ? [meta] : []),
            footer,
          ]}
        >
          {(item) => item}
        </Static>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={boxWidth}>
      {/* Header */}
      {header}
      {topSeparator}

      {/* Body */}
      {error ? (
        <Box paddingY={1} justifyContent="center">
          <Text color={theme.status.error}>{error}</Text>
        </Box>
      ) : (
        <Box paddingY={1} justifyContent="center">
          <Text color={theme.text.secondary}>
            {t('Loading session preview...')}
          </Text>
        </Box>
      )}

      {/* Footer */}
      {footerSeparator}
      {meta}
      {footer}
    </Box>
  );
}

/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useId, type FC } from 'react';
import { Box, Text } from 'ink';
import {
  AGENT_COLORS,
  parseTeammateMessage,
  type AgentColor,
} from '@qwen-code/core';
import type { HistoryItemCustomContent } from '../../types.js';
import { FEED_MARKER } from '../../constants/feedGrammar.js';
import { theme } from '../../semantic-colors.js';
import { resolveAgentColor } from '../../utils/agentColors.js';
import { useUIState } from '../../contexts/UIStateContext.js';
import { useOverflowActions } from '../../contexts/OverflowContext.js';
import { figures } from '../../utils/figures.js';

interface IdleNotification {
  type: 'idle_notification';
  idleReason?: 'available' | 'interrupted' | 'failed';
  failureReason?: string;
}

function isHiddenProtocolMessage(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as { type?: unknown };
    return (
      parsed.type === 'shutdown_approved' ||
      parsed.type === 'teammate_terminated'
    );
  } catch {
    return false;
  }
}

function parseIdleNotification(value: string): IdleNotification | null {
  try {
    const parsed = JSON.parse(value) as Partial<IdleNotification>;
    if (parsed.type !== 'idle_notification') return null;
    if (
      parsed.idleReason !== undefined &&
      parsed.idleReason !== 'available' &&
      parsed.idleReason !== 'interrupted' &&
      parsed.idleReason !== 'failed'
    ) {
      return null;
    }
    if (
      parsed.failureReason !== undefined &&
      typeof parsed.failureReason !== 'string'
    ) {
      return null;
    }
    return parsed as IdleNotification;
  } catch {
    return null;
  }
}

function toAgentColor(value: string | undefined): AgentColor | undefined {
  return AGENT_COLORS.find((color) => color === value);
}

export interface TeammateMessageProps {
  value: string;
  summary?: string;
  color?: string;
}

export const TeammateMessage: FC<TeammateMessageProps> = ({
  value,
  summary,
  color,
}) => {
  const message = parseTeammateMessage(value);
  const { constrainHeight } = useUIState();
  const overflowActions = useOverflowActions();
  const uniqueId = useId();
  const overflowId = `teammate-message-${uniqueId}`;
  const idle = message ? parseIdleNotification(message.text) : null;
  const hiddenProtocol = message
    ? isHiddenProtocolMessage(message.text)
    : false;

  useEffect(() => {
    if (!message || idle || hiddenProtocol || !overflowActions) return;
    overflowActions.addOverflowingId(overflowId);
    return () => overflowActions.removeOverflowingId(overflowId);
  }, [message, idle, hiddenProtocol, overflowActions, overflowId]);

  if (!message || hiddenProtocol) return null;

  const agentColor = resolveAgentColor(toAgentColor(color ?? message.color));
  if (idle) {
    const state =
      idle.idleReason === 'failed'
        ? 'failed'
        : idle.idleReason === 'interrupted'
          ? 'was interrupted'
          : 'finished';
    const markerColor =
      idle.idleReason === 'failed'
        ? theme.status.error
        : idle.idleReason === 'interrupted'
          ? theme.status.warning
          : theme.status.success;
    const failureReason =
      idle.idleReason === 'failed' && idle.failureReason
        ? idle.failureReason.replace(/\s+/g, ' ').trim().slice(0, 200)
        : '';
    return (
      <Box>
        <Text>
          <Text color={markerColor}>{FEED_MARKER.subagentCompleted}</Text>
          {' Teammate '}
          <Text bold color={agentColor ?? theme.ui.focus}>
            @{message.from}
          </Text>{' '}
          {state}
          {failureReason ? <Text dimColor>: {failureReason}</Text> : null}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={theme.ui.comment}>{FEED_MARKER.info}</Text>
        <Text color={agentColor ?? theme.ui.focus}>
          @{message.from} {figures.pointer}
        </Text>
        {constrainHeight && (summary ?? message.summary)
          ? ` ${summary ?? message.summary}`
          : ''}
      </Text>
      {!constrainHeight && message.text ? (
        <Box paddingLeft={2}>
          <Text>{message.text}</Text>
        </Box>
      ) : null}
    </Box>
  );
};

export function buildTeammateMessageHistoryItem(
  value: string,
  summary?: string,
  color?: string,
): HistoryItemCustomContent | null {
  const message = parseTeammateMessage(value);
  if (!message || isHiddenProtocolMessage(message.text)) return null;
  return {
    type: 'custom_content',
    content: <TeammateMessage value={value} summary={summary} color={color} />,
  };
}

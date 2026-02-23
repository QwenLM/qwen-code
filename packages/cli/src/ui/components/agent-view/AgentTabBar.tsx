/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview AgentTabBar — horizontal tab strip for in-process agent views.
 *
 * Rendered at the top of the terminal whenever in-process agents are registered.
 * Left/Right arrow keys cycle through tabs when the input buffer is empty.
 *
 * Tab indicators:  running,  idle/completed,  failed,  cancelled
 */

import { Box, Text } from 'ink';
import { useState, useEffect, useCallback } from 'react';
import { AgentStatus, AgentEventType } from '@qwen-code/qwen-code-core';
import {
  useAgentViewState,
  useAgentViewActions,
  type RegisteredAgent,
} from '../../contexts/AgentViewContext.js';
import { useKeypress } from '../../hooks/useKeypress.js';
import { useUIState } from '../../contexts/UIStateContext.js';
import { theme } from '../../semantic-colors.js';

// ─── Status Indicators ──────────────────────────────────────

function statusIndicator(agent: RegisteredAgent): {
  symbol: string;
  color: string;
} {
  const status = agent.interactiveAgent.getStatus();
  switch (status) {
    case AgentStatus.RUNNING:
    case AgentStatus.INITIALIZING:
      return { symbol: '\u25CF', color: theme.status.warning }; // ● running
    case AgentStatus.COMPLETED:
      return { symbol: '\u2713', color: theme.status.success }; // ✓ completed
    case AgentStatus.FAILED:
      return { symbol: '\u2717', color: theme.status.error }; // ✗ failed
    case AgentStatus.CANCELLED:
      return { symbol: '\u25CB', color: theme.text.secondary }; // ○ cancelled
    default:
      return { symbol: '\u25CB', color: theme.text.secondary }; // ○ fallback
  }
}

// ─── Component ──────────────────────────────────────────────

export const AgentTabBar: React.FC = () => {
  const { activeView, agents, agentShellFocused } = useAgentViewState();
  const { switchToNext, switchToPrevious } = useAgentViewActions();
  const { buffer, embeddedShellFocused } = useUIState();

  // Left/Right arrow keys switch tabs when the input buffer is empty
  // and no embedded shell (main or agent tab) has input focus.
  useKeypress(
    (key) => {
      if (buffer.text !== '' || embeddedShellFocused || agentShellFocused)
        return;
      if (key.name === 'left') {
        switchToPrevious();
      } else if (key.name === 'right') {
        switchToNext();
      }
    },
    { isActive: true },
  );

  // Subscribe to STATUS_CHANGE events from all agents so the tab bar
  // re-renders when an agent's status transitions (e.g. RUNNING → COMPLETED).
  // Without this, status indicators would be stale until the next unrelated render.
  const [, setTick] = useState(0);
  const forceRender = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    const cleanups: Array<() => void> = [];
    for (const [, agent] of agents) {
      const emitter = agent.interactiveAgent.getEventEmitter();
      if (emitter) {
        emitter.on(AgentEventType.STATUS_CHANGE, forceRender);
        cleanups.push(() =>
          emitter.off(AgentEventType.STATUS_CHANGE, forceRender),
        );
      }
    }
    return () => cleanups.forEach((fn) => fn());
  }, [agents, forceRender]);

  return (
    <Box flexDirection="row" paddingX={1}>
      {/* Main tab */}
      <Box marginRight={1}>
        <Text
          bold={activeView === 'main'}
          backgroundColor={
            activeView === 'main' ? theme.border.default : undefined
          }
          color={
            activeView === 'main' ? theme.text.primary : theme.text.secondary
          }
        >
          {' Main '}
        </Text>
      </Box>

      {/* Separator */}
      <Text color={theme.border.default}>{'\u2502'}</Text>

      {/* Agent tabs */}
      {[...agents.entries()].map(([agentId, agent]) => {
        const isActive = activeView === agentId;
        const { symbol, color: indicatorColor } = statusIndicator(agent);

        return (
          <Box key={agentId} marginLeft={1}>
            <Text
              bold={isActive}
              backgroundColor={isActive ? theme.border.default : undefined}
              color={isActive ? undefined : agent.color || theme.text.secondary}
            >
              {` ${agent.displayName} `}
            </Text>
            <Text color={indicatorColor}>{` ${symbol}`}</Text>
          </Box>
        );
      })}

      {/* Navigation hint */}
      <Box marginLeft={2}>
        <Text color={theme.text.secondary}>←/→</Text>
      </Box>
    </Box>
  );
};

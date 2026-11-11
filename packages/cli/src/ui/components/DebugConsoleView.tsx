/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo } from 'react';
import { Box, Text, useStdout } from 'ink';
import { theme } from '../semantic-colors.js';
import { useConsoleMessages } from '../hooks/useConsoleMessages.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { BaseTabDialog } from './shared/BaseTabDialog.js';
import { useActiveKeyboardContexts } from '../contexts/KeyboardContextRegistry.js';
import { useActionHandlerRegistry } from '../contexts/ActionHandlerRegistry.js';

interface DebugConsoleViewProps {
  onClose: () => void;
}

const iconBoxWidth = 3;

/**
 * DebugConsoleView - Full-screen debug console panel.
 *
 * Renders debug/error/log messages as flat Box/Text elements inside a
 * BaseTabDialog. Content flows into native terminal scrollback for unlimited
 * height — same pattern as DiffFileView. No ScrollableList, no VirtualizedList.
 *
 * Uses BaseTabDialog for consistent title/separator/footer/keyboard chrome.
 * ESC closes the panel (handled by BaseTabDialog's onClose).
 */
export const DebugConsoleView: React.FC<DebugConsoleViewProps> = ({
  onClose,
}) => {
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns ?? 80;

  const consoleMessages = useConsoleMessages();
  const config = useConfig();
  const activeContexts = useActiveKeyboardContexts();
  const actionRegistry = useActionHandlerRegistry();

  // Gather registered action handlers for each active context
  const registeredActions = useMemo(() => {
    if (!actionRegistry) return '';
    const parts: string[] = [];
    for (const ctx of activeContexts) {
      const actions = actionRegistry.getActionsForContext(ctx);
      if (actions.length > 0) {
        parts.push(`${ctx}: ${actions.join(', ')}`);
      }
    }
    return parts.length > 0 ? parts.join('\n') : '(none)';
  }, [activeContexts, actionRegistry]);

  const messages = useMemo(() => {
    if (config.getDebugMode()) {
      return consoleMessages;
    }
    return consoleMessages.filter((msg) => msg.type !== 'debug');
  }, [consoleMessages, config]);

  // BaseTabDialog paddingX=1 takes 2 columns each side
  const maxContentWidth = terminalWidth - 4;

  return (
    <BaseTabDialog title="Debug Console" onClose={onClose}>
      {/* Active keyboard contexts (Phase 1 debug) */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={theme.text.primary}>
          Active Keyboard Contexts:
        </Text>
        <Text
          color={
            activeContexts.size > 0
              ? theme.status.success
              : theme.text.secondary
          }
        >
          {activeContexts.size > 0 ? [...activeContexts].join(', ') : '(none)'}
        </Text>
      </Box>

      {/* Registered action handlers (Phase 2 debug) */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={theme.text.primary}>
          Registered Action Handlers:
        </Text>
        <Text
          color={
            registeredActions !== '(none)'
              ? theme.status.success
              : theme.text.secondary
          }
        >
          {registeredActions}
        </Text>
      </Box>

      {messages.length === 0 ? (
        <Text color={theme.text.secondary}>No messages to display.</Text>
      ) : (
        <Box flexDirection="column">
          {messages.map((msg, index) => {
            let textColor = theme.text.primary;
            let icon = '\u2139'; // Information source

            switch (msg.type) {
              case 'warn':
                textColor = theme.status.warning;
                icon = '\u26A0'; // Warning sign
                break;
              case 'error':
                textColor = theme.status.error;
                icon = '\u2716'; // Heavy multiplication x
                break;
              case 'debug':
                textColor = theme.text.secondary;
                icon = '\uD83D\uDD0D'; // Magnifying glass
                break;
              case 'log':
              default:
                break;
            }

            return (
              <Box
                key={`msg-${index}`}
                flexDirection="row"
                width={maxContentWidth}
              >
                <Box minWidth={iconBoxWidth} flexShrink={0}>
                  <Text color={textColor}>{icon}</Text>
                </Box>
                <Text color={textColor} wrap="wrap">
                  {msg.content}
                  {msg.count && msg.count > 1 && (
                    <Text color={theme.text.secondary}> (x{msg.count})</Text>
                  )}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      {/* Message count indicator */}
      <Box marginTop={0}>
        <Text color={theme.text.secondary} dimColor>
          {messages.length} message{messages.length !== 1 ? 's' : ''}
        </Text>
      </Box>
    </BaseTabDialog>
  );
};

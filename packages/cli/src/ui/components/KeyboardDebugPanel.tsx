/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * KeyboardDebugPanel — Phase 3, Step 3.4 debug panel.
 *
 * Renders a comprehensive view of the keyboard context routing system:
 * - All 15 contexts with their active/inactive state and layer priority
 * - Registered action handlers per active context
 * - Context bindings (key -> action) for each active context
 *
 * Rendered as a `custom_dialog` from `/keyboard-debug` and `/keyboard-contexts`.
 */

import type React from 'react';
import { useMemo } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import {
  KEYBOARD_CONTEXTS,
  CONTEXT_DECLARATION_ORDER,
  useActiveKeyboardContexts,
  type KeyboardContextName,
} from '../contexts/KeyboardContextRegistry.js';
import { useActionHandlerRegistry } from '../contexts/ActionHandlerRegistry.js';
import { defaultContextBindings } from '../key/contextBindings.js';
import { BaseTabDialog } from './shared/BaseTabDialog.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface KeyboardDebugPanelProps {
  onClose: () => void;
  /** 'full' shows contexts + handlers + bindings; 'contexts' shows only context states */
  mode: 'full' | 'contexts';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACTIVE_COLOR = theme.ui.focus;
const INACTIVE_COLOR = theme.text.secondary;

/**
 * Build a sorted list of all contexts with their state and priority.
 */
function useContextStates(
  activeContexts: ReadonlySet<KeyboardContextName>,
): Array<{ name: KeyboardContextName; active: boolean; priority: number }> {
  return useMemo(
    () =>
      KEYBOARD_CONTEXTS.map((name) => ({
        name,
        active: activeContexts.has(name),
        priority: CONTEXT_DECLARATION_ORDER[name],
      })),
    [activeContexts],
  );
}

/**
 * Build a map of context -> registered action names.
 */
function useRegisteredActions(
  activeContexts: ReadonlySet<KeyboardContextName>,
  actionRegistry: ReturnType<typeof useActionHandlerRegistry>,
): Map<KeyboardContextName, string[]> {
  return useMemo(() => {
    const map = new Map<KeyboardContextName, string[]>();
    if (!actionRegistry) return map;

    for (const ctx of activeContexts) {
      const actions = actionRegistry.getActionsForContext(ctx);
      if (actions.length > 0) {
        map.set(ctx, actions);
      }
    }
    return map;
  }, [activeContexts, actionRegistry]);
}

/**
 * Build a map of context -> binding entries from defaultContextBindings.
 */
function useContextBindingsMap(): Map<
  KeyboardContextName,
  Array<{ key: string; action: string; penetrate: boolean }>
> {
  return useMemo(() => {
    const map = new Map<
      KeyboardContextName,
      Array<{ key: string; action: string; penetrate: boolean }>
    >();

    for (const block of defaultContextBindings) {
      const { context, penetrate = false, bindings } = block;
      let list = map.get(context);
      if (!list) {
        list = [];
        map.set(context, list);
      }
      for (const [key, action] of Object.entries(bindings)) {
        if (action !== null) {
          list.push({ key, action, penetrate });
        }
      }
    }
    return map;
  }, []);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const ContextStateRow: React.FC<{
  name: string;
  active: boolean;
  priority: number;
}> = ({ name, active, priority }) => (
  <Box>
    <Box minWidth={2}>
      <Text color={active ? ACTIVE_COLOR : INACTIVE_COLOR}>
        {active ? '\u25CF' : '\u25CB'}
      </Text>
    </Box>
    <Box minWidth={18}>
      <Text color={active ? ACTIVE_COLOR : INACTIVE_COLOR} bold={active}>
        {name}
      </Text>
    </Box>
    <Box minWidth={8}>
      <Text color={theme.text.secondary}>#{priority}</Text>
    </Box>
    <Text color={active ? ACTIVE_COLOR : INACTIVE_COLOR}>
      {active ? 'ACTIVE' : 'inactive'}
    </Text>
  </Box>
);

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const KeyboardDebugPanel: React.FC<KeyboardDebugPanelProps> = ({
  onClose,
  mode,
}) => {
  const activeContexts = useActiveKeyboardContexts();
  const actionRegistry = useActionHandlerRegistry();

  const contextStates = useContextStates(activeContexts);
  const registeredActions = useRegisteredActions(
    activeContexts,
    actionRegistry,
  );
  const contextBindingsMap = useContextBindingsMap();

  const title = mode === 'full' ? 'Keyboard Debug' : 'Keyboard Contexts';

  return (
    <BaseTabDialog title={title} onClose={onClose}>
      {/* Section 1: Context states */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={theme.text.primary}>
          Keyboard Contexts ({activeContexts.size}/{KEYBOARD_CONTEXTS.length}{' '}
          active):
        </Text>
        <Box flexDirection="column" marginLeft={1} marginTop={0}>
          {contextStates.map((ctx) => (
            <ContextStateRow
              key={ctx.name}
              name={ctx.name}
              active={ctx.active}
              priority={ctx.priority}
            />
          ))}
        </Box>
      </Box>

      {/* Section 2: Registered action handlers (full mode only) */}
      {mode === 'full' && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={theme.text.primary}>
            Registered Action Handlers:
          </Text>
          <Box flexDirection="column" marginLeft={1} marginTop={0}>
            {registeredActions.size === 0 ? (
              <Text color={theme.text.secondary}>(none)</Text>
            ) : (
              Array.from(registeredActions.entries()).map(([ctx, actions]) => (
                <Box key={ctx} flexDirection="column">
                  <Text color={ACTIVE_COLOR} bold>
                    {ctx}:
                  </Text>
                  <Box marginLeft={2}>
                    <Text color={theme.text.primary}>{actions.join(', ')}</Text>
                  </Box>
                </Box>
              ))
            )}
            {actionRegistry && (
              <Box marginTop={0}>
                <Text color={theme.text.secondary} dimColor>
                  Fallbacks:{' '}
                  {[...activeContexts]
                    .filter((ctx) => actionRegistry.hasFallback(ctx))
                    .join(', ') || '(none)'}
                </Text>
              </Box>
            )}
          </Box>
        </Box>
      )}

      {/* Section 3: Context bindings (full mode only) */}
      {mode === 'full' && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={theme.text.primary}>
            Active Context Bindings:
          </Text>
          <Box flexDirection="column" marginLeft={1} marginTop={0}>
            {[...activeContexts].map((ctx) => {
              const bindings = contextBindingsMap.get(ctx);
              if (!bindings || bindings.length === 0) return null;

              return (
                <Box key={ctx} flexDirection="column" marginBottom={0}>
                  <Text color={ACTIVE_COLOR} bold>
                    {ctx}
                    {bindings.some((b) => b.penetrate) ? ' [penetrate]' : ''}:
                  </Text>
                  <Box marginLeft={2} flexDirection="column">
                    {bindings.map((b) => (
                      <Box key={`${ctx}-${b.key}-${b.action}`}>
                        <Box minWidth={20}>
                          <Text color={theme.text.secondary}>{b.key}</Text>
                        </Box>
                        <Text color={theme.text.primary}>{b.action}</Text>
                      </Box>
                    ))}
                  </Box>
                </Box>
              );
            })}
          </Box>
        </Box>
      )}

      {/* Footer hint */}
      <Box marginTop={0}>
        <Text color={theme.text.secondary} dimColor>
          Press ESC to close.{' '}
          {mode === 'contexts' ? 'Use /keyboard-debug for full details.' : ''}
        </Text>
      </Box>
    </BaseTabDialog>
  );
};

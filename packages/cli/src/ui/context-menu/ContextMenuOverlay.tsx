/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { useKeypress, type Key } from '../hooks/useKeypress.js';
import { useContextMenu } from './ContextMenuContext.js';

/**
 * Renders the right-click context menu as an absolutely-positioned overlay on
 * top of the transcript. Ink has no z-index; a `position="absolute"` box drawn
 * as a later sibling paints over earlier in-flow content, the overlay mechanism
 * validated for VP mode. Renders nothing while closed, so it costs zero cells
 * in the steady state.
 *
 * The outer guard returns before any keyboard subscription exists, so a closed
 * menu has no provider requirements at all — the inner component (and its
 * `useKeypress`, which needs KeypressProvider) mounts only while open.
 *
 * Keyboard: ↑/↓ move the highlight, Enter executes, Esc closes. Any other key
 * also dismisses the menu (click-away parity), but that key is the user's, not
 * the menu's — it must keep flowing through the normal pipeline (typing "x"
 * dismisses and types "x"; returning early would drop it into the bare
 * readline layer). Dismissal is therefore reported back to KeypressContext so
 * the same dispatch falls through to the ordinary handlers the moment the menu
 * is gone. While the menu is open the subscription is exclusive: keys are
 * routed here only, so the composer, approval dialogs, and tab bars cannot act
 * on the same keystroke. Mouse hover / click are handled by
 * {@link ContentMouseController}, which hit-tests with `contextMenuSize` —
 * the border/padding encoded below must stay in sync with that helper.
 */
export const ContextMenuOverlay: React.FC = () => {
  const { menu } = useContextMenu();
  if (!menu) {
    return null;
  }
  return <ActiveContextMenu />;
};

const ActiveContextMenu: React.FC = () => {
  const { menu, selectedIndex, closeMenu, setSelectedIndex, executeIndex } =
    useContextMenu();

  const handleKeypress = useCallback(
    (key: Key): boolean => {
      if (!menu) return true;
      if (key.name === 'escape') {
        closeMenu();
        return true;
      }
      // Claim the menu's keys only without modifiers: a modified Return or
      // arrow belongs to a composer binding (Shift+Enter / Ctrl+Enter are
      // Command.NEWLINE in keyBindings.ts), and consuming it here would
      // drop the newline while still firing the highlighted item.
      const unmodified = !key.ctrl && !key.shift && !key.meta;
      if (key.name === 'up' && unmodified) {
        setSelectedIndex(Math.max(0, selectedIndex - 1));
        return true;
      }
      if (key.name === 'down' && unmodified) {
        setSelectedIndex(Math.min(menu.items.length - 1, selectedIndex + 1));
        return true;
      }
      if (key.name === 'return' && unmodified) {
        executeIndex(selectedIndex);
        return true;
      }
      // Any other key dismisses the menu. Return false so this same
      // keystroke falls through to ordinary handlers — the key was aimed at
      // the app, not the menu, and swallowing it here would lose it.
      closeMenu();
      return false;
    },
    [menu, selectedIndex, closeMenu, setSelectedIndex, executeIndex],
  );

  useKeypress(handleKeypress, { isActive: menu !== null, exclusive: true });

  if (!menu) {
    return null;
  }

  // Pad every row to the longest label: an Ink absolute box only overwrites
  // the cells it paints, so short rows would let the transcript show through
  // the box interior and leave the selection highlight ragged.
  const longestLabel = menu.items.reduce(
    (max, item) => Math.max(max, item.label.length),
    0,
  );

  return (
    <Box
      position="absolute"
      top={menu.position.y}
      left={menu.position.x}
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border.focused}
      paddingX={0}
    >
      {menu.items.map((item, index) => {
        const selected = index === selectedIndex;
        return (
          <Box key={item.id}>
            <Text
              selectable={false}
              backgroundColor={selected ? theme.text.accent : undefined}
              color={selected ? theme.background.primary : theme.text.primary}
            >
              {` ${item.label.padEnd(longestLabel)} `}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
};

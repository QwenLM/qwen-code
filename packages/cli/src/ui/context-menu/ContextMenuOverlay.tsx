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
 * Keyboard: ↑/↓ move the highlight, Enter executes, Esc closes. Mouse
 * hover / click are handled by {@link ContentMouseController}, which
 * hit-tests with `contextMenuSize` — the border/padding encoded below must
 * stay in sync with that helper.
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
    (key: Key) => {
      if (!menu) return;
      if (key.name === 'escape') {
        closeMenu();
        return;
      }
      if (key.name === 'up') {
        setSelectedIndex(Math.max(0, selectedIndex - 1));
        return;
      }
      if (key.name === 'down') {
        setSelectedIndex(Math.min(menu.items.length - 1, selectedIndex + 1));
        return;
      }
      if (key.name === 'return') {
        executeIndex(selectedIndex);
        return;
      }
    },
    [menu, selectedIndex, closeMenu, setSelectedIndex, executeIndex],
  );

  useKeypress(handleKeypress, { isActive: menu !== null });

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

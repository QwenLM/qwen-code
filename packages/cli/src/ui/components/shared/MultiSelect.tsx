/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import { useSelectionList } from '../../hooks/useSelectionList.js';
import { useKeypress } from '../../hooks/useKeypress.js';
import type { SelectionListItem } from '../../hooks/useSelectionList.js';

export interface MultiSelectItem<T> extends SelectionListItem<T> {
  label: string;
}

export interface MultiSelectProps<T> {
  items: Array<MultiSelectItem<T>>;
  initialIndex?: number;
  initialSelectedKeys?: string[];
  onConfirm: (selectedValues: T[]) => void;
  onChange?: (selectedValues: T[]) => void;
  onHighlight?: (value: T) => void;
  isFocused?: boolean;
  showNumbers?: boolean;
  showScrollArrows?: boolean;
  maxItemsToShow?: number;
}

const EMPTY_SELECTED_KEYS: string[] = [];

function getSelectedValues<T>(
  items: Array<MultiSelectItem<T>>,
  selectedKeys: Set<string>,
): T[] {
  return items
    .filter((item) => selectedKeys.has(item.key))
    .map((item) => item.value);
}

export function MultiSelect<T>({
  items,
  initialIndex = 0,
  initialSelectedKeys = EMPTY_SELECTED_KEYS,
  onConfirm,
  onChange,
  onHighlight,
  isFocused = true,
  showNumbers = true,
  showScrollArrows = false,
  maxItemsToShow = 10,
}: MultiSelectProps<T>): React.JSX.Element {
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(
    () => new Set(initialSelectedKeys),
  );
  const [scrollOffset, setScrollOffset] = useState(0);

  useEffect(() => {
    setSelectedKeys((prev) => {
      const next = new Set(initialSelectedKeys);
      if (
        prev.size === next.size &&
        Array.from(next).every((key) => prev.has(key))
      ) {
        return prev;
      }
      return next;
    });
  }, [initialSelectedKeys]);

  const { activeIndex } = useSelectionList({
    items,
    initialIndex,
    isFocused,
    // Disable numeric quick-select in useSelectionList — in a multi-select
    // context, onSelect triggers onConfirm (submit), so numeric keys would
    // accidentally submit the dialog instead of toggling checkboxes.
    // Numbers are still rendered visually via the showNumbers prop below.
    showNumbers: false,
    onHighlight,
    onSelect: () => {
      onConfirm(getSelectedValues(items, selectedKeys));
    },
  });

  const toggleSelectionAtIndex = useCallback(
    (index: number) => {
      const item = items[index];
      if (!item || item.disabled) {
        return;
      }

      setSelectedKeys((prev) => {
        const next = new Set(prev);
        if (next.has(item.key)) {
          next.delete(item.key);
        } else {
          next.add(item.key);
        }
        return next;
      });
    },
    [items],
  );

  useEffect(() => {
    onChange?.(getSelectedValues(items, selectedKeys));
  }, [items, selectedKeys, onChange]);

  useKeypress(
    (key) => {
      if (key.name === 'space' || key.sequence === ' ') {
        toggleSelectionAtIndex(activeIndex);
      }
    },
    { isActive: isFocused },
  );

  useEffect(() => {
    const newScrollOffset = Math.max(
      0,
      Math.min(activeIndex - maxItemsToShow + 1, items.length - maxItemsToShow),
    );
    if (activeIndex < scrollOffset) {
      setScrollOffset(activeIndex);
    } else if (activeIndex >= scrollOffset + maxItemsToShow) {
      setScrollOffset(newScrollOffset);
    }
  }, [activeIndex, items.length, scrollOffset, maxItemsToShow]);

  const visibleItems = useMemo(
    () => items.slice(scrollOffset, scrollOffset + maxItemsToShow),
    [items, scrollOffset, maxItemsToShow],
  );
  const numberColumnWidth = String(items.length).length;
  const hasMoreAbove = scrollOffset > 0;
  const hasMoreBelow = scrollOffset + maxItemsToShow < items.length;
  const moreAboveCount = scrollOffset;
  const moreBelowCount = Math.max(
    0,
    items.length - (scrollOffset + maxItemsToShow),
  );

  return (
    <Box flexDirection="column">
      {showScrollArrows && hasMoreAbove && (
        <Text color={theme.text.secondary}>↑ {moreAboveCount} more above</Text>
      )}

      {visibleItems.map((item, index) => {
        const itemIndex = scrollOffset + index;
        const isActive = activeIndex === itemIndex;
        const isChecked = selectedKeys.has(item.key);

        const itemNumberText = `${String(itemIndex + 1).padStart(
          numberColumnWidth,
        )}.`;
        const checkboxText = item.disabled ? '[x]' : isChecked ? '[✓]' : '[ ]';

        let textColor = theme.text.primary;
        if (item.disabled) {
          textColor = theme.text.secondary;
        } else if (isActive) {
          textColor = theme.status.success;
        } else if (isChecked) {
          textColor = theme.text.accent;
        }

        return (
          <Box key={item.key} alignItems="flex-start">
            <Box minWidth={4} flexShrink={0}>
              <Text color={textColor}>{checkboxText}</Text>
            </Box>
            {showNumbers && (
              <Box marginRight={1} minWidth={itemNumberText.length}>
                <Text color={textColor}>{itemNumberText}</Text>
              </Box>
            )}
            <Box flexGrow={1}>
              <Text color={textColor}>{item.label}</Text>
            </Box>
          </Box>
        );
      })}

      {showScrollArrows && hasMoreBelow && (
        <Text color={theme.text.secondary}>↓ {moreBelowCount} more below</Text>
      )}
    </Box>
  );
}

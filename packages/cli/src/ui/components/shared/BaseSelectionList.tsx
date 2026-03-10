/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo } from 'react';
import { Text, Box } from 'ink';
import { theme } from '../../semantic-colors.js';
import { useSelectionList } from '../../hooks/useSelectionList.js';

import type { SelectionListItem } from '../../hooks/useSelectionList.js';

// Prefix characters for scroll indicators (aligned with SessionPicker)
const PREFIX_CHARS = {
  selected: '› ',
  scrollUp: '↑ ',
  scrollDown: '↓ ',
  normal: '  ',
};

export interface RenderItemContext {
  isSelected: boolean;
  titleColor: string;
  numberColor: string;
  prefixChar: string;
  prefixColor: string;
}

export interface BaseSelectionListProps<
  T,
  TItem extends SelectionListItem<T> = SelectionListItem<T>,
> {
  items: TItem[];
  initialIndex?: number;
  onSelect: (value: T) => void;
  onHighlight?: (value: T) => void;
  isFocused?: boolean;
  showNumbers?: boolean;
  showScrollArrows?: boolean;
  /** When true, keeps the selected item centered in the visible window */
  centerSelection?: boolean;
  maxItemsToShow?: number;
  /** Gap (in rows) between each item. */
  itemGap?: number;
  renderItem: (item: TItem, context: RenderItemContext) => React.ReactNode;
}

/**
 * Base component for selection lists that provides common UI structure
 * and keyboard navigation logic via the useSelectionList hook.
 *
 * This component handles:
 * - Radio button indicators
 * - Item numbering
 * - Scrolling for long lists
 * - Color theming based on selection/disabled state
 * - Keyboard navigation and numeric selection
 *
 * Specific components should use this as a base and provide
 * their own renderItem implementation for custom content.
 */
export function BaseSelectionList<
  T,
  TItem extends SelectionListItem<T> = SelectionListItem<T>,
>({
  items,
  initialIndex = 0,
  onSelect,
  onHighlight,
  isFocused = true,
  showNumbers = true,
  showScrollArrows = false,
  centerSelection = false,
  maxItemsToShow = 10,
  itemGap = 0,
  renderItem,
}: BaseSelectionListProps<T, TItem>): React.JSX.Element {
  const { activeIndex } = useSelectionList({
    items,
    initialIndex,
    onSelect,
    onHighlight,
    isFocused,
    showNumbers,
  });

  const hasMoreThanOnePage = items.length > maxItemsToShow;

  // Calculate scroll offset - use centered selection when centerSelection is enabled
  const scrollOffset = useMemo(() => {
    if (centerSelection && hasMoreThanOnePage) {
      // Center the selected item
      const halfVisible = Math.floor(maxItemsToShow / 2);
      let offset = activeIndex - halfVisible;
      // Clamp to valid range
      offset = Math.max(0, offset);
      offset = Math.min(items.length - maxItemsToShow, offset);
      return offset;
    }
    // Default: keep selection at the bottom of visible window (legacy behavior)
    return Math.max(
      0,
      Math.min(activeIndex - maxItemsToShow + 1, items.length - maxItemsToShow),
    );
  }, [
    activeIndex,
    items.length,
    maxItemsToShow,
    centerSelection,
    hasMoreThanOnePage,
  ]);

  const visibleItems = items.slice(scrollOffset, scrollOffset + maxItemsToShow);
  const numberColumnWidth = String(items.length).length;

  // Scroll indicator state (aligned with SessionPicker logic)
  const showScrollUp = scrollOffset > 0;
  const showScrollDown = scrollOffset + maxItemsToShow < items.length;

  return (
    <Box flexDirection="column" gap={itemGap}>
      {visibleItems.map((item, index) => {
        const itemIndex = scrollOffset + index;
        const isSelected = activeIndex === itemIndex;
        const isFirst = index === 0;
        const isLast = index === visibleItems.length - 1;

        // Determine prefix character based on scroll state (aligned with SessionPicker)
        let prefixChar = PREFIX_CHARS.normal;
        let prefixColor: string | undefined = undefined;

        if (showScrollArrows && hasMoreThanOnePage) {
          if (isSelected) {
            prefixChar = PREFIX_CHARS.selected;
            prefixColor = theme.text.accent;
          } else if (isFirst && showScrollUp) {
            prefixChar = PREFIX_CHARS.scrollUp;
            prefixColor = theme.text.secondary;
          } else if (isLast && showScrollDown) {
            prefixChar = PREFIX_CHARS.scrollDown;
            prefixColor = theme.text.secondary;
          }
        }

        // Determine colors based on selection and disabled state
        let titleColor = theme.text.primary;
        let numberColor = theme.text.primary;

        if (isSelected) {
          titleColor = theme.status.success;
          numberColor = theme.status.success;
        } else if (item.disabled) {
          titleColor = theme.text.secondary;
          numberColor = theme.text.secondary;
        }

        if (!isFocused && !item.disabled) {
          numberColor = theme.text.secondary;
        }

        if (!showNumbers) {
          numberColor = theme.text.secondary;
        }

        const itemNumberText = `${String(itemIndex + 1).padStart(
          numberColumnWidth,
        )}.`;

        return (
          <Box key={item.key} alignItems="flex-start">
            {/* Selection indicator prefix - always show for selected item when there's more than one item */}
            {isSelected && items.length > 1 && (
              <Box flexShrink={0} minWidth={2}>
                <Text color={theme.text.accent}>{PREFIX_CHARS.selected}</Text>
              </Box>
            )}

            {/* Scroll indicator prefix (aligned with SessionPicker) - only show when showScrollArrows is enabled */}
            {showScrollArrows && hasMoreThanOnePage && !isSelected && (
              <Box flexShrink={0} minWidth={2}>
                <Text color={prefixColor}>{prefixChar}</Text>
              </Box>
            )}

            {/* Item number - placed after prefix */}
            {showNumbers && (
              <Box
                marginRight={1}
                flexShrink={0}
                minWidth={itemNumberText.length}
                aria-state={{ checked: isSelected }}
              >
                <Text color={numberColor}>{itemNumberText}</Text>
              </Box>
            )}

            {/* Custom content via render prop */}
            <Box flexGrow={1}>
              {renderItem(item, {
                isSelected,
                titleColor,
                numberColor,
                prefixChar,
                prefixColor: prefixColor ?? theme.text.primary,
              })}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

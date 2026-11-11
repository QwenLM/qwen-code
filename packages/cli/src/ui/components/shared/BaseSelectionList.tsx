/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Text, Box } from 'ink';
import { theme } from '../../semantic-colors.js';
import {
  useSelectionList,
  type SelectionListItem,
} from '../../hooks/useSelectionList.js';
import { calculateCenteredWindow } from '../../utils/calculateCenteredWindow.js';
import { figures } from '../../utils/figures.js';

export interface RenderItemContext {
  isSelected: boolean;
  titleColor: string;
  numberColor: string;
}

/**
 * Visual variant for the selection list.
 * - 'arrow': Standard style with → indicator and color highlight (no background). Default.
 * - 'default': Legacy style with ● indicator and background highlight. Deprecated — do not use in new code.
 */
export type SelectionListVariant = 'default' | 'arrow';

export interface BaseSelectionListProps<
  T,
  TItem extends SelectionListItem<T> = SelectionListItem<T>,
> {
  items: TItem[];
  initialIndex?: number;
  onSelect: (value: T) => void;
  onCancel?: () => void;
  onHighlight?: (value: T) => void;
  isFocused?: boolean;
  showNumbers?: boolean;
  enableNumericSelection?: boolean;
  showScrollArrows?: boolean;
  maxItemsToShow?: number;
  wrapAround?: boolean;
  focusKey?: string;
  selectedIndicator?: string;
  /** Color for the selected row's title, number and indicator. */
  selectionColor?: string;
  /** Visual variant (default: 'arrow') */
  variant?: SelectionListVariant;
  /** Forwarded to {@link useSelectionList}. */
  suppressAccept?: boolean;
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
  onCancel,
  onHighlight,
  isFocused = true,
  showNumbers = true,
  enableNumericSelection = true,
  showScrollArrows: _showScrollArrows = false,
  maxItemsToShow = 5,
  wrapAround = false,
  focusKey,
  selectedIndicator,
  selectionColor,
  variant = 'arrow',
  suppressAccept,
  renderItem,
}: BaseSelectionListProps<T, TItem>): React.JSX.Element {
  // Resolve indicator based on variant (explicit prop takes precedence)
  const resolvedIndicator =
    selectedIndicator ??
    (variant === 'arrow' ? figures.pointer : figures.bullet);
  const { activeIndex } = useSelectionList({
    items,
    initialIndex,
    onSelect,
    onCancel,
    onHighlight,
    isFocused,
    showNumbers,
    enableNumericSelection,
    wrapAround,
    focusKey,
    suppressAccept,
  });

  // Use centered scroll window calculation – keeps the active item
  // in the middle of the visible window whenever possible.
  const centeredWindowStart = calculateCenteredWindow(
    activeIndex,
    items.length,
    maxItemsToShow,
  );

  const visibleItems = items.slice(
    centeredWindowStart,
    centeredWindowStart + maxItemsToShow,
  );

  // Build a mapping from array index to display number, skipping hideNumber items.
  // This ensures numbered items show sequential 1, 2, 3… even when headers are interspersed.
  const displayNumberMap = new Map<number, number>();
  let displayCount = 0;
  for (let i = 0; i < items.length; i++) {
    if (!items[i].hideNumber) {
      displayCount++;
      displayNumberMap.set(i, displayCount);
    }
  }
  const numberColumnWidth = String(displayCount).length;

  const canScrollUp = centeredWindowStart > 0;
  const canScrollDown = centeredWindowStart + maxItemsToShow < items.length;
  const showArrows = items.length > maxItemsToShow;

  return (
    <Box flexDirection="column">
      {visibleItems.map((item, index) => {
        const itemIndex = centeredWindowStart + index;
        const isSelected = activeIndex === itemIndex;
        const isFirstVisible = index === 0;
        const isLastVisible = index === visibleItems.length - 1;

        // Determine colors based on selection and disabled state
        let titleColor = theme.text.primary;
        let numberColor = theme.text.primary;

        const selectionAccent = selectionColor ?? theme.ui.focus;
        if (isSelected) {
          const accentColor = selectionAccent;
          titleColor = accentColor;
          numberColor = accentColor;
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

        const displayNumber = displayNumberMap.get(itemIndex) ?? itemIndex + 1;
        const itemNumberText = `${String(displayNumber).padStart(
          numberColumnWidth,
        )}.`;

        // Determine left-column indicator: scroll arrows on first/last row, or selection indicator
        let indicatorChar = ' ';
        let indicatorColor = theme.text.primary;

        if (showArrows && isFirstVisible && canScrollUp) {
          indicatorChar = '▲';
          indicatorColor = theme.text.secondary;
        } else if (showArrows && isLastVisible && canScrollDown) {
          indicatorChar = '▼';
          indicatorColor = theme.text.secondary;
        } else if (isSelected) {
          indicatorChar = resolvedIndicator;
          indicatorColor = selectionAccent;
        }

        return (
          <Box
            key={item.key}
            alignItems="flex-start"
            backgroundColor={
              isSelected && variant !== 'arrow'
                ? theme.background.focus
                : undefined
            }
          >
            {/* Left padding */}
            <Text> </Text>

            {/* Indicator column: arrows or selection indicator */}
            <Box minWidth={2} flexShrink={0}>
              <Text color={indicatorColor} aria-hidden>
                {indicatorChar}
              </Text>
            </Box>

            {/* Item number */}
            {showNumbers && !item.hideNumber && (
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
              })}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

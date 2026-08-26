/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared OpenTUI dialog primitives (PR1 slice 3): the dialog frame, tab bar,
 * footer hint, and the DialogSelect list. DialogSelect reproduces the ink
 * `shared/BaseSelectionList.tsx` row layout (radio `›` indicator, padded row
 * numbers, ▲/▼ scroll arrows) and pairs with `useDialogSelect`, which
 * reproduces the `ui/hooks/useSelectionList.ts` keyboard behavior (↑/↓/j/k
 * wrap-around navigation, Enter to select, numeric quick-select) by routing
 * keys through the ORIGINAL keybinding table via key-map.ts. Mouse support is
 * native to OpenTUI: hover highlights, left-click selects, wheel scrolls.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MouseButton } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { C } from './theme.js';
import { keyMatchers, Command } from '../keyMatchers.js';
import { toOriginalKey } from './key-map.js';
import {
  applyNumberSelectKey,
  computeInitialActiveIndex,
  findNextEnabledIndex,
  followScrollOffset,
  getSelectionScrollOffset,
  selectionWindow,
  NUMBER_SELECT_TIMEOUT_MS,
  type DialogListItem,
} from './dialogs-core.js';

export { type DialogListItem };

export const DEFAULT_MAX_ITEMS_TO_SHOW = 10;

/**
 * Dialog-level Tab/Esc bindings shared by the slice 3 dialog family
 * (ThemeDialog, SettingsDialog, and extensions all cycle views with Tab and
 * dismiss with Esc; the list rows own ↑/↓/Enter/digits).
 */
export function useDialogFrameKeys(handlers: {
  onTab?: (shift: boolean) => void;
  onEscape?: () => void;
}): void {
  useKeyboard((key) => {
    const original = toOriginalKey(key);
    if (original.name === 'tab') handlers.onTab?.(original.shift);
    if (original.name === 'escape') handlers.onEscape?.();
  });
}

/**
 * Dialog frame matching the ink dialogs' chrome: `borderStyle="round"` +
 * padding 1 (OpenTUI spells the rounded border style "rounded").
 */
export function DialogFrame(props: {
  children?: ReactNode;
  borderColor?: string;
}) {
  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      borderColor={props.borderColor ?? C.dim}
      padding={1}
    >
      {props.children}
    </box>
  );
}

/** Footer hint line — dim, one row of margin above. */
export function FooterHint(props: { text: string }) {
  return (
    <box marginTop={1}>
      <text fg={C.dim}>{props.text}</text>
    </box>
  );
}

export interface DialogTab {
  id: string;
  label: string;
}

/**
 * Tab bar parity (SettingsDialog ConfigTabBar / PermissionsDialog TabBar /
 * extensions TabBar): the active tab is a label on the accent background,
 * inactive tabs are dim, followed by a cycling hint.
 */
export function DialogTabBar(props: {
  tabs: readonly DialogTab[];
  activeId: string;
  hint?: string;
}) {
  return (
    <box flexDirection="row">
      {props.tabs.map((tab) => {
        const active = tab.id === props.activeId;
        return (
          <box key={tab.id} marginRight={2}>
            <text
              fg={active ? '#000000' : C.dim}
              bg={active ? C.accent : undefined}
              attributes={active ? 1 : undefined}
            >
              {` ${tab.label} `}
            </text>
          </box>
        );
      })}
      {props.hint ? <text fg={C.dim}> {props.hint}</text> : null}
    </box>
  );
}

export interface UseDialogSelectOptions<TItem extends DialogListItem<unknown>> {
  items: readonly TItem[];
  initialIndex?: number;
  /**
   * Re-apply initialIndex whenever this key changes. Dialogs that keep one
   * mounted hook for several views use it to re-sync the cursor on view
   * entry, matching ink's remounted selection components.
   */
  resyncKey?: string | number;
  /** Only react to keys while true (multiple lists share one keyboard). */
  focused?: boolean;
  /** Numeric quick-select (the numbered rows' "type the row number"). */
  numbers?: boolean;
  /** Rows kept visible at once; drives the scroll window. */
  maxItemsToShow?: number;
  onSelect?: (value: TItem['value']) => void;
  onHighlight?: (value: TItem['value'], index: number) => void;
}

export interface UseDialogSelectResult<TItem extends DialogListItem<unknown>> {
  activeIndex: number;
  scrollOffset: number;
  setScrollOffset: (offset: number) => void;
  setActiveIndex: (index: number) => void;
  /** Click-to-choose: highlight + select the row (disabled rows ignored). */
  selectIndex: (index: number) => void;
  highlightIndex: (index: number) => void;
  items: readonly TItem[];
}

/**
 * Keyboard + selection + scroll-window state for DialogSelect. Mirrors
 * useSelectionList: SELECTION_UP/SELECTION_DOWN wrap around and skip
 * disabled rows, Enter selects the highlighted row, digits quick-select by
 * row number with a NUMBER_SELECT_TIMEOUT_MS flush. The scroll window
 * follows the highlight with BaseSelectionList's rules.
 */
export function useDialogSelect<TItem extends DialogListItem<unknown>>(
  options: UseDialogSelectOptions<TItem>,
): UseDialogSelectResult<TItem> {
  const {
    items,
    initialIndex = 0,
    resyncKey,
    focused = true,
    numbers = true,
    maxItemsToShow = DEFAULT_MAX_ITEMS_TO_SHOW,
    onSelect,
    onHighlight,
  } = options;

  const [activeIndex, setActiveIndexState] = useState(() =>
    computeInitialActiveIndex(initialIndex, items),
  );
  const [scrollOffset, setScrollOffset] = useState(() =>
    getSelectionScrollOffset(
      computeInitialActiveIndex(initialIndex, items),
      items.length,
      maxItemsToShow,
    ),
  );

  // Resync during render when the key changes (React's adjust-state-during-
  // render pattern): consumers that swap views over one mounted hook get
  // the fresh initialIndex instead of the mount-time snapshot.
  const [appliedResyncKey, setAppliedResyncKey] = useState(resyncKey);
  if (appliedResyncKey !== resyncKey) {
    setAppliedResyncKey(resyncKey);
    const next = computeInitialActiveIndex(initialIndex, items);
    setActiveIndexState(next);
    setScrollOffset(
      getSelectionScrollOffset(next, items.length, maxItemsToShow),
    );
  }

  const numberBuffer = useRef('');
  const numberTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (numberTimer.current) clearTimeout(numberTimer.current);
    },
    [],
  );

  // BaseSelectionList scroll-follow: the window only moves when the
  // highlight would leave it.
  useEffect(() => {
    const next = followScrollOffset(
      activeIndex,
      scrollOffset,
      items.length,
      maxItemsToShow,
    );
    if (next !== scrollOffset) setScrollOffset(next);
  }, [activeIndex, scrollOffset, items.length, maxItemsToShow]);

  const highlightIndex = (index: number) => {
    if (index < 0 || index >= items.length || index === activeIndex) return;
    if (items[index]?.disabled) return;
    setActiveIndexState(index);
    const item = items[index];
    if (item) onHighlight?.(item.value, index);
  };

  const selectIndex = (index: number) => {
    const item = items[index];
    if (!item || item.disabled) return;
    setActiveIndexState(index);
    onSelect?.(item.value);
  };

  const clearNumberBuffer = () => {
    if (numberTimer.current) {
      clearTimeout(numberTimer.current);
      numberTimer.current = null;
    }
    numberBuffer.current = '';
  };

  useKeyboard((key) => {
    if (!focused || items.length === 0) return;
    const original = toOriginalKey(key);

    if (numbers && !original.ctrl && /^[0-9]$/.test(original.sequence)) {
      // The original hook clears the pending flush on every digit first —
      // an invalid digit (leading '0', out-of-range) must disarm it, or the
      // stale timer would later commit the pre-digit highlight.
      if (numberTimer.current) {
        clearTimeout(numberTimer.current);
        numberTimer.current = null;
      }
      const result = applyNumberSelectKey(
        { buffer: numberBuffer.current },
        original.sequence,
        items.length,
      );
      numberBuffer.current = result.buffer;
      if (result.activeIndex !== undefined) {
        setActiveIndexState(result.activeIndex);
        const item = items[result.activeIndex];
        if (item) onHighlight?.(item.value, result.activeIndex);
      }
      if (result.selectNow) {
        clearNumberBuffer();
        const item = items[result.activeIndex ?? activeIndex];
        if (item && !item.disabled) onSelect?.(item.value);
      } else if (result.pendingSelect) {
        numberTimer.current = setTimeout(() => {
          clearNumberBuffer();
          // Flush against the highlight at timeout time, not at digit time.
          setActiveIndexState((current) => {
            const item = items[current];
            if (item && !item.disabled) onSelect?.(item.value);
            return current;
          });
        }, NUMBER_SELECT_TIMEOUT_MS);
      }
      return;
    }

    // Any non-digit key abandons a number in progress, exactly like the
    // original hook clears its buffer on a non-numeric key.
    clearNumberBuffer();

    if (keyMatchers[Command.SELECTION_UP](original)) {
      highlightIndex(findNextEnabledIndex(items, activeIndex, 'up'));
      return;
    }
    if (keyMatchers[Command.SELECTION_DOWN](original)) {
      highlightIndex(findNextEnabledIndex(items, activeIndex, 'down'));
      return;
    }
    if (original.name === 'return') {
      const item = items[activeIndex];
      if (item && !item.disabled) onSelect?.(item.value);
    }
  });

  return {
    activeIndex,
    scrollOffset,
    setScrollOffset,
    setActiveIndex: highlightIndex,
    selectIndex,
    highlightIndex,
    items,
  };
}

export interface DialogSelectProps<TItem extends DialogListItem<unknown>> {
  items: readonly TItem[];
  activeIndex: number;
  scrollOffset: number;
  maxItemsToShow?: number;
  showNumbers?: boolean;
  /** Like BaseSelectionList, always render both arrows when enabled. */
  showScrollArrows?: boolean;
  focused?: boolean;
  onHover?: (index: number) => void;
  /** Wheel: move the highlight by one row per notch. */
  onWheel?: (direction: 'up' | 'down') => void;
  /** Click-to-choose (highlight + select in one gesture). */
  onSelectIndex?: (index: number) => void;
  renderLabel?: (
    item: TItem,
    context: { isSelected: boolean; titleColor: string },
  ) => ReactNode;
}

/**
 * Presentational selection list. Row anatomy is BaseSelectionList parity:
 * 2-wide `›` indicator, right-aligned `N.` number column, then the label;
 * selected rows use the success color, disabled rows dim.
 */
export function DialogSelect<TItem extends DialogListItem<unknown>>(
  props: DialogSelectProps<TItem>,
) {
  const {
    items,
    activeIndex,
    scrollOffset,
    maxItemsToShow = DEFAULT_MAX_ITEMS_TO_SHOW,
    showNumbers = true,
    showScrollArrows = false,
    focused = true,
    onHover,
    onWheel,
    onSelectIndex,
    renderLabel,
  } = props;

  const window_ = selectionWindow(scrollOffset, items.length, maxItemsToShow);
  const visible = items.slice(window_.start, window_.end);
  const numberColumnWidth = String(items.length).length;

  return (
    <box
      flexDirection="column"
      onMouseScroll={(e) => {
        const direction = e.scroll?.direction;
        if (direction === 'up' || direction === 'down') onWheel?.(direction);
      }}
    >
      {showScrollArrows && <text fg={window_.showUp ? C.text : C.dim}>▲</text>}
      {visible.map((item, rowIndex) => {
        const itemIndex = window_.start + rowIndex;
        const isSelected = focused && activeIndex === itemIndex;
        const titleColor = isSelected
          ? C.green
          : item.disabled
            ? C.dim
            : C.text;
        const numberColor =
          !showNumbers || (!focused && !item.disabled) ? C.dim : titleColor;
        const numberText = `${String(itemIndex + 1).padStart(numberColumnWidth)}.`;
        return (
          <box
            key={item.key}
            flexDirection="row"
            onMouseOver={() => {
              if (!item.disabled) onHover?.(itemIndex);
            }}
            onMouseUp={(e) => {
              if (e.button === MouseButton.LEFT && !item.disabled) {
                onSelectIndex?.(itemIndex);
              }
            }}
          >
            <box width={2} flexShrink={0}>
              <text fg={isSelected ? C.green : C.text}>
                {isSelected ? '›' : ' '}
              </text>
            </box>
            {showNumbers && (
              <box width={numberText.length + 1} flexShrink={0}>
                <text fg={numberColor}>{numberText}</text>
              </box>
            )}
            <box flexGrow={1}>
              {renderLabel ? (
                renderLabel(item, { isSelected, titleColor })
              ) : (
                <text fg={titleColor}>{String(item.value)}</text>
              )}
            </box>
          </box>
        );
      })}
      {showScrollArrows && (
        <text fg={window_.showDown ? C.text : C.dim}>▼</text>
      )}
    </box>
  );
}

/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import {
  useState,
  useMemo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react';
import { Box, Text, useStdout } from 'ink';
import chalk from 'chalk';
import { theme } from '../../semantic-colors.js';
import { SelectionGradient } from '../SelectionText.js';
import type {
  SettingsType,
  SettingsValue,
} from '../../../config/settingsSchema.js';
import { TOGGLE_TYPES } from '../../../config/settingsSchema.js';
import { InputField } from './InputField.js';
import type { TextBuffer } from './text-buffer.js';
import {
  cpSlice,
  cpLen,
  cpIndexToOffset,
  getCachedStringWidth,
} from '../../utils/textUtils.js';
import type { Key } from '../../hooks/useKeypress.js';
import { useSettingsNavigation } from '../../hooks/useSettingsNavigation.js';
import { useInlineEditBuffer } from '../../hooks/useInlineEditBuffer.js';
import { SHORTCUT_HINTS } from '../../constants/shortcuts.js';
import { useSearchBuffer } from '../../hooks/useSearchBuffer.js';
import { figures } from '../../utils/figures.js';
import {
  useRegisterActionHandlers,
  useRegisterFallbackHandler,
  type ActionHandler,
} from '../../contexts/ActionHandlerRegistry.js';
import { useRegisterHints } from '../../contexts/HintRegistryContext.js';

/**
 * Represents a single item in the settings list panel.
 */
export interface SettingsDialogItem {
  /** Non-selectable heading shared by contiguous rows. */
  groupLabel?: string;
  /** Unique identifier for the item */
  key: string;
  /** Display label */
  label: string;
  /**
   * Optional colored segments replacing the label text. The label string is
   * still used for filtering and width measurement.
   */
  labelSegments?: readonly SettingsSuffixSegment[];
  /** Optional label color when the item is not focused. */
  labelColor?: string;
  /** Optional product gradient for an active item's label. */
  labelGradient?: string[];
  /**
   * Optional colored icon/badge rendered right after the label (e.g. a promo
   * marker). Rendered in its own color, independent of the label color.
   */
  labelSuffix?: { text: string; color: string };
  /** Optional description below label */
  description?: string;
  /** Item type for determining interaction behavior */
  type: SettingsType;
  /** Pre-formatted display value (with * if modified) */
  displayValue: string;
  /**
   * Whether the display value should use the focus color when the row is
   * focused. Defaults to true.
   */
  highlightValueOnFocus?: boolean;
  /** Grey out value (at default) */
  isGreyedOut?: boolean;
  /** Scope message e.g., "(Modified in Workspace)" */
  scopeMessage?: string;
  /** Raw value for edit mode initialization */
  rawValue?: SettingsValue;
  /** Optional pre-formatted edit buffer value for complex types */
  editValue?: string;
  /**
   * Optional colored prefix rendered before displayValue.
   * Example: `{ text: "[Security Restricted]", color: "red" }`
   */
  displayValuePrefix?: { text: string; color: string };
  /**
   * Optional value rendered struck-through immediately before displayValue.
   */
  displayValueStrike?: string;
  /**
   * Optional warning text shown below the description when this item is focused.
   * Rendered in the specified color.
   */
  focusedWarning?: { text: string; color: string };
  /**
   * Optional inline detail appended right after the label regardless of focus.
   * Use it for state that should stay visible while navigating elsewhere.
   */
  suffix?: string;
  /** Optional suffix color. Defaults to secondary text. */
  suffixColor?: string;
  /**
   * Optional inline detail appended right after the label, but ONLY while this
   * item is focused. Use it for focus-only context (e.g. a model's default
   * thinking depth / context window). Rendered in the secondary text color.
   */
  focusedSuffix?: string;
  /**
   * Optional multi-segment replacement for `suffix` / `focusedSuffix`, drawn in
   * the same slot between the label and the value column. Each segment carries
   * its own color, which `suffix` cannot: it renders as a single `<Text>`.
   *
   * Use it when parts of one inline group need different emphasis — the model
   * picker highlights just the column the arrow keys currently drive, leaving
   * the rest dim. Segments are concatenated verbatim, so callers own their own
   * padding and spacing.
   */
  suffixSegments?: SettingsSuffixSegment[];
  /**
   * Focused-row variant of `suffixSegments`, mirroring how `focusedSuffix`
   * varies `suffix`. Used when the focused row must mark which part of the
   * group the keyboard is currently driving.
   */
  focusedSuffixSegments?: SettingsSuffixSegment[];
}

/**
 * One run of inline text after a row's label, styled independently.
 *
 * `dimColor` is separate from `color` because a control that has run out of
 * travel still needs its own hue — the model picker greys a caret at the end
 * of its range while the caret that can still move keeps the focus color.
 */
export interface SettingsSuffixSegment {
  text: string;
  color?: string;
  bold?: boolean;
  dimColor?: boolean;
}

/**
 * Props for SettingsListPanel component.
 *
 * SettingsListPanel is a pure content panel that renders a scrollable,
 * searchable, inline-editable settings list. It is designed to be placed
 * INSIDE a BaseTabDialog — it never wraps one itself.
 */
export interface SettingsListPanelProps {
  // Search (optional feature)
  /** Whether to show the search input. Default: true */
  searchEnabled?: boolean;
  /** Placeholder text for search input. Default: "Search to filter" */
  searchPlaceholder?: string;
  /** Message shown when filtering produces no items. */
  emptyMessage?: string;
  /**
   * External search buffer. When provided, the parent is responsible for
   * filtering `items` — SLP only renders the search input.
   * When omitted and `searchEnabled` is true, SLP creates its own buffer
   * and filters items internally using `filterFn` (or a default includes match
   * on label, description, and displayValue).
   */
  searchBuffer?: TextBuffer;
  /**
   * Custom filter predicate used by the built-in search.
   * Called for each item when the internal search query is non-empty.
   * Only used when `searchBuffer` is NOT provided (i.e. internal search mode).
   * Defaults to case-insensitive includes on label + description + displayValue.
   */
  filterFn?: (item: SettingsDialogItem, query: string) => boolean;

  /** Keep this action visible above the scrolling items and search. */
  pinnedItemKey?: string;
  /** Color for the focused row's indicator, label and value. */
  selectionColor?: string;
  selectionGradient?: string[];

  // Items - parent provides the list
  /** List of items to display */
  items: SettingsDialogItem[];

  // Layout
  /** Maximum number of items to show at once */
  maxItemsToShow: number;
  /** Fixed label width for cross-list alignment. */
  labelWidth?: number;
  /** Maximum label width for alignment */
  maxLabelWidth?: number;
  /**
   * Lines per item for height calculation and description rendering.
   * Default: 2 (1 label row + 1 description row).
   * Set to 3 for richer items (1 label row + 2 description rows), etc.
   */
  itemHeight?: number;

  // Action callbacks
  /** Called when a boolean/enum item is toggled */
  onItemToggle: (key: string, item: SettingsDialogItem) => void;
  /** Called when edit mode is committed with new value */
  onEditCommit: (
    key: string,
    newValue: string,
    item: SettingsDialogItem,
  ) => boolean | void;
  /** Called when Ctrl+C is pressed to clear/reset an item */
  onItemClear: (key: string, item: SettingsDialogItem) => void;
  /** Called when dialog should close */
  onClose: () => void;
  /**
   * When true, the list is read-only: Enter does not start inline editing,
   * and toggle/clear callbacks are never invoked from keyboard input.
   * Default: false.
   */
  readOnly?: boolean;
  /** Optional custom key handler for parent-specific keys. Return true if handled. */
  onKeyPress?: (
    key: Key,
    currentItem: SettingsDialogItem | undefined,
  ) => boolean;

  /** Optional P1-localized replacement for the default navigation hint. */
  navigationHint?: string;

  /**
   * Stable identity for the current search source. When provided, the
   * built-in search is cleared only when this value changes, rather than when
   * item keys change. This lets callers refresh a list in place without
   * discarding the user's query while still clearing it on tab/source changes.
   */
  searchResetKey?: string;

  /** Available terminal height for dynamic windowing */
  availableHeight?: number;

  /**
   * Stable item-slot count for the layout container height.
   * Set this to the maximum number of items across all tabs so
   * the container height stays constant when switching tabs.
   * Capped by terminal constraints and maxItemsToShow.
   * When omitted, falls back to items.length (height tracks current tab).
   */
  minItemSlots?: number;

  /** Optional footer configuration */
  footer?: {
    content:
      | React.ReactNode
      | ((currentItem: SettingsDialogItem | undefined) => React.ReactNode);
    height: number;
  };

  /**
   * Reserved height for the footer area.
   * When set, the items container always reserves this many lines for the
   * footer, even when `footer` is not yet visible. This prevents layout
   * height jumps when the footer dynamically appears.
   * Defaults to `footer.height` when footer is provided, 0 otherwise.
   */
  reservedFooterHeight?: number;

  /**
   * Whether the search input should be focused (receive keyboard input).
   * When false, the search box is still visible but unfocused — keystrokes
   * propagate to the container keyboard instead.
   * Only relevant when `searchEnabled` is true.
   * Default: true.
   */
  searchFocused?: boolean;

  /**
   * How the built-in search is entered.
   *
   * - `'always'` (default): the search input owns every printable key for as
   *   long as it is focused — the historical behavior.
   * - `'slash'`: the input starts unfocused and `/` activates it. Bare letters
   *   are then free for the panel's own shortcuts, which is what the model
   *   picker uses for `s` (apply for this session only). Slash mode also
   *   disables the bare-`c` toggle below, since in that mode single letters
   *   belong to the caller, not to this panel.
   *
   * Only meaningful when SLP owns the search (`searchEnabled` and no external
   * `searchBuffer`).
   */
  searchTrigger?: 'always' | 'slash';

  /**
   * Notified when slash-mode search is entered or left, and when the query goes
   * from empty to non-empty or back — including on unmount. Parents that render
   * their own footer (rather than letting BaseTabDialog compose hints) need
   * this to keep the footer honest.
   *
   * Deliberately not fired per keystroke: `hasQuery` is a flag, not the text,
   * so typing does not re-render the parent.
   */
  onSearchStateChange?: (state: { active: boolean; hasQuery: boolean }) => void;

  /**
   * Fires with the key of the row that currently has keyboard focus, and with
   * `undefined` when the panel unmounts.
   *
   * For a caller that renders a footer *outside* this panel and needs it to
   * describe the focused row — `footer.content` only reaches the panel's own
   * footer. It carries the key rather than the item because callers typically
   * rebuild `items` during render, so the object identity changes every frame
   * and would drive an endless render loop; a string lets React bail out.
   *
   * The unmount call matters on tab switches: each tab renders its own panel,
   * and without it the caller keeps pointing at the outgoing tab's row for a
   * frame, long enough for the footer to blank and come back.
   */
  onActiveKeyChange?: (key: string | undefined) => void;

  /**
   * Optional key of the item to focus initially.
   * If not found, falls back to the first item.
   */
  initialActiveKey?: string;

  /**
   * Optional search query string for highlighting matching text
   * in item labels and descriptions with a yellow background.
   * When omitted (the default), SLP automatically uses the current
   * search text (internal or external) for highlighting.
   * Pass an empty string to explicitly disable highlighting.
   */
  highlightQuery?: string;

  /**
   * Maximum fraction of terminal height the panel may occupy.
   * Overrides the built-in half-screen cap for callers that intentionally
   * take over the screen (e.g. `/settings`, which is a dedicated panel and
   * doesn't need to preserve conversation visibility like a popover).
   * Defaults to 0.5 (half-screen).
   */
  heightCapRatio?: number;

  /**
   * Horizontal placement of the value column.
   * - `'right'` (default): values are right-aligned against the panel edge.
   * - `'left'`: values start immediately after the label column, so they stay
   *   next to their label instead of being stranded across a wide terminal.
   */
  valueAlign?: 'left' | 'right';
}

/** Pad a string to a fixed width with trailing spaces. */
function padRight(s: string, width: number): string {
  const length = getCachedStringWidth(s);
  return length >= width ? s : s + ' '.repeat(width - length);
}

/**
 * Highlight all case-insensitive occurrences of `query` in `text`
 * with a yellow background. Returns a chalk-formatted string.
 *
 * Exported for direct unit testing — ink-testing-library's `lastFrame()`
 * strips ANSI escape codes from rendered output, so we cannot detect the
 * `\u001b[43m` (bgYellow) markers via component-level frame assertions.
 * Testing this function directly is the most reliable coverage.
 */
export function highlightText(text: string, query: string): string {
  if (!query || !text) return text;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (!lowerText.includes(lowerQuery)) return text;

  let result = '';
  let lastIdx = 0;
  let searchStart = 0;

  while (searchStart < lowerText.length) {
    const idx = lowerText.indexOf(lowerQuery, searchStart);
    if (idx === -1) break;

    result += text.slice(lastIdx, idx);
    result += chalk.bgYellow.black(text.slice(idx, idx + query.length));
    lastIdx = idx + query.length;
    searchStart = lastIdx;
  }

  result += text.slice(lastIdx);
  return result;
}

/**
 * Maximum half-screen height cap for the settings dialog.
 * The dialog never occupies more than half the terminal.
 */
const HALF_SCREEN_CAP_RATIO = 0.5;

/**
 * Columns between the label and value columns when `valueAlign` is `'left'`.
 * The label column is only as wide as the longest label, so without a gutter
 * that longest row would render its value flush against the label text.
 */
const LEFT_ALIGN_VALUE_GUTTER = 2;

/**
 * In left-aligned mode the label column may take at most this fraction of the
 * row, so the value column always keeps usable space on narrow terminals.
 */
const LEFT_ALIGN_LABEL_WIDTH_RATIO = 0.5;

/** Floor for the left-aligned label column on very narrow terminals. */
const MIN_LEFT_ALIGN_LABEL_WIDTH = 12;

/**
 * A settings list panel component that handles rendering, layout, and keyboard
 * navigation for a scrollable, searchable settings list with inline editing.
 *
 * This is a pure content panel — it must be placed inside a BaseTabDialog
 * (which provides the tab bar, title, separator, footer hints, and escape
 * handling). It never wraps a BaseTabDialog itself.
 */
export function SettingsListPanel({
  searchEnabled = true,
  searchPlaceholder = 'Search to filter',
  emptyMessage = 'No matches found.',
  searchBuffer: externalSearchBuffer,
  filterFn,
  items,
  pinnedItemKey,
  selectionColor,
  selectionGradient,
  maxItemsToShow,
  labelWidth,
  maxLabelWidth,
  itemHeight: itemHeightProp,
  onItemToggle,
  onEditCommit,
  onItemClear,
  onClose,
  readOnly = false,
  onKeyPress,
  navigationHint,
  searchResetKey,
  availableHeight,
  minItemSlots,
  footer,
  reservedFooterHeight,
  searchFocused = true,
  searchTrigger = 'always',
  onSearchStateChange,
  onActiveKeyChange,
  initialActiveKey,
  highlightQuery,
  heightCapRatio,
  valueAlign = 'right',
}: SettingsListPanelProps): React.JSX.Element {
  const focusedColor = selectionColor ?? theme.ui.focus;
  const { stdout } = useStdout();
  const terminalHeight = stdout?.rows ?? 40;
  const terminalWidth = stdout?.columns ?? 80;

  // ── Internal search state (used when parent does not supply searchBuffer) ──
  const [internalQuery, setInternalQuery] = useState('');
  const internalSearchBuffer = useSearchBuffer({
    initialText: '',
    onChange: setInternalQuery,
  });

  // Decide which buffer to render and whether SLP owns the filtering
  const isInternalSearch = searchEnabled && !externalSearchBuffer;
  const searchBuffer =
    externalSearchBuffer ?? (searchEnabled ? internalSearchBuffer : undefined);

  // ── Slash-mode search activation ──────────────────────────────────────────
  // Only meaningful when SLP owns the search. The ref mirrors the state so key
  // handlers decide synchronously: `/` and the next key can arrive in one stdin
  // chunk, before React commits, and a render-closure read would still say
  // "inactive" and fire the caller's letter shortcut mid-query.
  const slashSearch = isInternalSearch && searchTrigger === 'slash';
  const [searchActive, setSearchActive] = useState(false);
  const searchActiveRef = useRef(false);
  const hasQueryRef = useRef(false);
  const onSearchStateChangeRef = useRef(onSearchStateChange);
  onSearchStateChangeRef.current = onSearchStateChange;
  const onActiveKeyChangeRef = useRef(onActiveKeyChange);
  onActiveKeyChangeRef.current = onActiveKeyChange;

  const notifySearchState = useCallback(() => {
    onSearchStateChangeRef.current?.({
      active: searchActiveRef.current,
      hasQuery: hasQueryRef.current,
    });
  }, []);

  const setSearchActiveSynced = useCallback(
    (active: boolean) => {
      if (searchActiveRef.current === active) return;
      searchActiveRef.current = active;
      setSearchActive(active);
      notifySearchState();
    },
    [notifySearchState],
  );

  /**
   * Hands focus from the search box back to the list, keeping the query (and
   * therefore the filter) intact. Returns whether it did anything, so callers
   * can use it as a "was this key spent leaving search?" test.
   */
  const blurSearch = useCallback((): boolean => {
    if (!searchActiveRef.current) return false;
    setSearchActiveSynced(false);
    return true;
  }, [setSearchActiveSynced]);

  // Leaving search must also reach a parent that renders its own footer, even
  // when the panel goes away without an Escape (tab switch unmounts it).
  useEffect(
    () => () => {
      if (searchActiveRef.current || hasQueryRef.current) {
        searchActiveRef.current = false;
        hasQueryRef.current = false;
        onSearchStateChangeRef.current?.({ active: false, hasQuery: false });
      }
    },
    [],
  );

  // The search input owns printable keys only while it is actually focused.
  const effectiveSearchFocused =
    searchEnabled &&
    searchFocused &&
    (searchTrigger === 'always' || !isInternalSearch || searchActive);

  // Auto-derive highlight query from search text when not explicitly provided.
  // Internal search → internalQuery; external search → externalSearchBuffer.text.
  //
  // The filter is deliberately independent of focus: in slash mode, leaving the
  // search box keeps the list filtered (and the highlight rendered against it).
  // Only Escape and a source change clear the query.
  const effectiveHighlightQuery =
    highlightQuery !== undefined
      ? highlightQuery
      : isInternalSearch
        ? internalQuery
        : (externalSearchBuffer?.text ?? '');

  // Track "is a filter applied" as a flag rather than pushing the text up, so
  // the parent re-renders at most twice per search session instead of per key.
  useEffect(() => {
    const hasQuery = internalQuery.length > 0;
    if (hasQueryRef.current === hasQuery) return;
    hasQueryRef.current = hasQuery;
    notifySearchState();
  }, [internalQuery, notifySearchState]);

  // ── Auto-clear internal search when items source changes (e.g. tab switch) ──
  // We fingerprint items by their keys; when the set of keys changes, it
  // indicates a new data source (tab), so we clear the internal search text.
  // Use useLayoutEffect so the clear runs synchronously after the items prop
  // change and before the next render is committed to the terminal — this
  // avoids a single-frame flash where new items would be filtered by the
  // stale query (potentially showing an empty list for one frame).
  const itemKeysFingerprint = useMemo(
    () => items.map((i) => i.key).join('\0'),
    [items],
  );
  const searchSourceFingerprint = searchResetKey ?? itemKeysFingerprint;
  const prevSearchSourceFingerprintRef = useRef(searchSourceFingerprint);
  const internalSetText = internalSearchBuffer.setText;
  useLayoutEffect(() => {
    if (searchSourceFingerprint !== prevSearchSourceFingerprintRef.current) {
      prevSearchSourceFingerprintRef.current = searchSourceFingerprint;
      if (isInternalSearch && internalQuery) {
        internalSetText('');
        setInternalQuery('');
      }
      // Deliberately outside the query guard: `/` with nothing typed still
      // leaves search mode armed, and a tab switch must not carry it over.
      setSearchActiveSynced(false);
    }
  }, [
    searchSourceFingerprint,
    isInternalSearch,
    internalQuery,
    internalSetText,
    setSearchActiveSynced,
  ]);

  // Default filter: case-insensitive includes on label, displayValue, or description.
  // Note: we intentionally do NOT search item.key — keys are internal identifiers
  // that users don't see in the UI; searching them would produce confusing
  // "why did this appear?" results.
  const defaultFilter = useMemo(
    () =>
      (item: SettingsDialogItem, query: string): boolean => {
        const q = query.toLowerCase();
        return (
          item.label.toLowerCase().includes(q) ||
          item.displayValue.toLowerCase().includes(q) ||
          (item.description?.toLowerCase().includes(q) ?? false)
        );
      },
    [],
  );

  // Apply internal filtering when SLP owns the search, with label-priority
  // sorting: items matching on label/displayValue appear before items that
  // only match on description, so the most relevant result is always first.
  const filteredItems = useMemo(() => {
    if (!isInternalSearch || !internalQuery) return items;
    const fn = filterFn ?? defaultFilter;
    const matched = items.filter(
      (item) => item.key === pinnedItemKey || fn(item, internalQuery),
    );

    // When using the default filter, sort by match quality:
    // label/displayValue matches first, description-only matches after.
    if (!filterFn && !pinnedItemKey) {
      const q = internalQuery.toLowerCase();
      const labelMatches: SettingsDialogItem[] = [];
      const descriptionOnlyMatches: SettingsDialogItem[] = [];
      for (const item of matched) {
        if (
          item.label.toLowerCase().includes(q) ||
          item.displayValue.toLowerCase().includes(q)
        ) {
          labelMatches.push(item);
        } else {
          descriptionOnlyMatches.push(item);
        }
      }
      return [...labelMatches, ...descriptionOnlyMatches];
    }

    return matched;
  }, [
    isInternalSearch,
    internalQuery,
    items,
    filterFn,
    defaultFilter,
    pinnedItemKey,
  ]);

  const hasGroups = filteredItems.some((item) => item.groupLabel);
  const compactGroups =
    (hasGroups || Boolean(pinnedItemKey)) && terminalHeight <= 30;
  const groupRowHeight = compactGroups ? 1 : 2;
  const pinnedItem = items.find((item) => item.key === pinnedItemKey);

  // Replicate InputPrompt's background-color / line-fallback logic
  // Calculate effective max items based on terminal height
  // layoutMaxItems: stable upper bound for container height (ignores items.length)
  // effectiveMaxItemsToShow: actual window size for navigation (clamped to items.length)
  const { effectiveMaxItemsToShow, layoutMaxItems } = useMemo(() => {
    const ITEM_HEIGHT = itemHeightProp ?? 2;

    // Height cap: never exceed this fraction of the terminal height.
    // Callers can raise this (e.g. `/settings`) via `heightCapRatio`.
    const capRatio = heightCapRatio ?? HALF_SCREEN_CAP_RATIO;
    const cappedByRatio = Math.floor(terminalHeight * capRatio);
    const cappedAvailableHeight = availableHeight
      ? Math.min(availableHeight, cappedByRatio)
      : cappedByRatio;

    // Layout constants (compact, no border, no title):
    // Search: 3 lines (border-box) + 0 margin, or 0 if disabled
    const SEARCH_SECTION_HEIGHT = searchEnabled ? 3 : 0;
    // Scroll arrows: now inline with first/last item, no extra lines
    const SCROLL_ARROWS_HEIGHT = 0;
    // Footer hint line
    const HELP_TEXT_HEIGHT = 1;
    const FOOTER_CONTENT_HEIGHT = reservedFooterHeight ?? footer?.height ?? 0;

    const fixedHeight =
      SEARCH_SECTION_HEIGHT +
      SCROLL_ARROWS_HEIGHT +
      HELP_TEXT_HEIGHT +
      FOOTER_CONTENT_HEIGHT +
      (pinnedItem ? (compactGroups ? 1 : 3) : 0);

    const availableForItems = cappedAvailableHeight - fixedHeight;
    const maxItems = Math.max(
      1,
      Math.floor(
        availableForItems / (ITEM_HEIGHT + (hasGroups ? groupRowHeight : 0)),
      ),
    );

    // Upper bound from terminal constraints
    const terminalMax = Math.min(maxItems, maxItemsToShow);

    // Stable layout height across tab switches:
    // - If minItemSlots is provided, use the cross-tab max item count
    //   (capped by terminal constraints) so the container never resizes.
    //   Never let a stale/undercounted minimum collapse visible item rows.
    // - Otherwise, fall back to the current tab's item count.
    const currentSlots = Math.min(filteredItems.length, terminalMax);
    const stableSlots =
      minItemSlots === undefined
        ? currentSlots
        : Math.min(Math.max(minItemSlots, currentSlots), terminalMax);

    return {
      // Navigation window: clamped to actual item count
      effectiveMaxItemsToShow: Math.min(terminalMax, filteredItems.length),
      // Container height: stable across tab switches. Always keep at least one
      // row so the "No matches found." message isn't clipped on an empty list.
      layoutMaxItems: Math.max(1, stableSlots),
    };
  }, [
    hasGroups,
    groupRowHeight,
    compactGroups,
    pinnedItem,
    availableHeight,
    terminalHeight,
    maxItemsToShow,
    filteredItems.length,
    minItemSlots,
    searchEnabled,
    footer,
    reservedFooterHeight,
    itemHeightProp,
    heightCapRatio,
  ]);

  // Internal state
  const {
    activeItemKey,
    activeIndex,
    windowStart,
    moveUp,
    moveDown,
    resetToKey,
  } = useSettingsNavigation({
    items: filteredItems,
    maxItemsToShow: effectiveMaxItemsToShow,
    initialActiveKey,
  });

  // Reset active selection to the first item whenever search text changes.
  // This ensures the arrow always points to the highest-priority match
  // (e.g. label matches appear before description-only matches).
  const searchText = isInternalSearch
    ? internalQuery
    : (searchBuffer?.text ?? '');
  const firstFilteredKey =
    (searchText.length > 0
      ? filteredItems.find((item) => item.key !== pinnedItemKey)?.key
      : undefined) ??
    filteredItems[0]?.key ??
    null;
  const prevSearchStateRef = useRef({ searchText, firstFilteredKey });
  useEffect(() => {
    const previous = prevSearchStateRef.current;
    const searchChanged = searchText !== previous.searchText;
    const asyncResultsChanged =
      searchText.length > 0 && firstFilteredKey !== previous.firstFilteredKey;
    prevSearchStateRef.current = { searchText, firstFilteredKey };

    // Slash mode anchors instead: typing filters the list but must not drag
    // the arrow to the top on every keystroke. The row stays put as long as it
    // still matches, and `activeIndex` falls back to the first row while it
    // doesn't — see useSettingsNavigation.
    if (slashSearch) {
      // Pinned Add is an action, never the preferred result of a model search.
      if (
        pinnedItemKey &&
        searchText &&
        firstFilteredKey !== activeItemKey &&
        !filteredItems.some(
          (item) => item.key === activeItemKey && item.key !== pinnedItemKey,
        ) &&
        firstFilteredKey
      ) {
        resetToKey(firstFilteredKey);
      }
      return;
    }

    if ((searchChanged || asyncResultsChanged) && firstFilteredKey) {
      resetToKey(firstFilteredKey);
    }
  }, [
    searchText,
    firstFilteredKey,
    resetToKey,
    slashSearch,
    activeItemKey,
    filteredItems,
    pinnedItemKey,
  ]);

  const { editState, editDispatch, startEditing, commitEdit, cursorVisible } =
    useInlineEditBuffer({
      onCommit: (key, value) => {
        const itemToCommit = filteredItems.find((i) => i.key === key);
        if (itemToCommit) {
          return onEditCommit(key, value, itemToCommit);
        }
        return true;
      },
    });

  const {
    editingKey,
    buffer: editBuffer,
    cursorPos: editCursorPos,
  } = editState;

  // Calculate visible items based on scroll offset
  const visibleItems = filteredItems.slice(
    windowStart,
    windowStart +
      effectiveMaxItemsToShow +
      (windowStart === 0 && pinnedItem ? 1 : 0),
  );

  const visibleModelItems = visibleItems.filter(
    (item) => item.key !== pinnedItemKey,
  );
  const visibleGroupHeight =
    new Set(visibleModelItems.map((item) => item.groupLabel).filter(Boolean))
      .size * groupRowHeight;

  // Show scroll indicators if there are more items than can be displayed
  const canScrollUp =
    filteredItems.length > effectiveMaxItemsToShow &&
    windowStart > (pinnedItem ? 1 : 0);
  const canScrollDown =
    filteredItems.length > effectiveMaxItemsToShow &&
    windowStart + visibleItems.length < filteredItems.length;

  // Get current item
  const currentItem = filteredItems[activeIndex];

  // Report focus outward by key. Keyed on the string, not the item, so a caller
  // that rebuilds `items` every render doesn't get a fresh identity each frame
  // (and an endless setState loop with it).
  const reportedActiveItemKey = currentItem?.key;
  // Layout effects, not passive ones: a parent that renders the focused row's
  // keys in its own footer has to have the key before Ink flushes, or the hint
  // (and any line wrap it causes) pops in one frame late on open.
  useLayoutEffect(() => {
    onActiveKeyChangeRef.current?.(reportedActiveItemKey);
  }, [reportedActiveItemKey]);
  useLayoutEffect(
    () => () => {
      onActiveKeyChangeRef.current?.(undefined);
    },
    [],
  );
  const footerContent = footer
    ? typeof footer.content === 'function'
      ? footer.content(currentItem)
      : footer.content
    : undefined;

  // Max label name width for alignment (like ModelSelector's nameWidth)
  const nameWidth = useMemo(() => {
    if (labelWidth !== undefined) {
      return labelWidth;
    }
    const computed = Math.max(
      12,
      ...filteredItems.map((i) => getCachedStringWidth(i.label)),
    );
    const capped = maxLabelWidth ? Math.min(computed, maxLabelWidth) : computed;
    if (valueAlign !== 'left') {
      return capped;
    }
    // Left-aligned rows reserve the label column up front, so on narrow
    // terminals an unbounded label column squeezes the value out. Keep the
    // label to at most a fraction of the row.
    const terminalCap = Math.max(
      MIN_LEFT_ALIGN_LABEL_WIDTH,
      Math.floor(terminalWidth * LEFT_ALIGN_LABEL_WIDTH_RATIO),
    );
    return Math.min(capped, terminalCap);
  }, [filteredItems, labelWidth, maxLabelWidth, valueAlign, terminalWidth]);

  const valueColumnWidth = useMemo(() => {
    const widths = filteredItems.map((item) => {
      const prefix = item.displayValuePrefix
        ? `${item.displayValuePrefix.text} `
        : '';
      const strike = item.displayValueStrike
        ? `${item.displayValueStrike} `
        : '';
      const scope = item.scopeMessage ? ` ${item.scopeMessage}` : '';
      return getCachedStringWidth(
        `${prefix}${strike}${item.displayValue}${scope}`,
      );
    });
    return Math.max(0, ...widths);
  }, [filteredItems]);

  // --- Edit mode action handlers ---
  const editActionHandlers = useMemo((): Record<string, ActionHandler> => {
    if (!editingKey) return {};

    return {
      // Cursor movement (left/right rebound from dialog:navigate:left/right)
      'dialog:navigate:left': () => {
        editDispatch({ type: 'MOVE_LEFT' });
        return true;
      },
      'dialog:navigate:right': () => {
        editDispatch({ type: 'MOVE_RIGHT' });
        return true;
      },
      'cursor:home': () => {
        editDispatch({ type: 'HOME' });
        return true;
      },
      'cursor:end': () => {
        editDispatch({ type: 'END' });
        return true;
      },
      // Delete
      'edit:deleteLeft': () => {
        editDispatch({ type: 'DELETE_LEFT' });
        return true;
      },
      'edit:deleteRight': () => {
        editDispatch({ type: 'DELETE_RIGHT' });
        return true;
      },
      // Kill / word delete (ctrl+k / ctrl+u / ctrl+w)
      'edit:deleteRightAll': () => {
        editDispatch({ type: 'KILL_RIGHT' });
        return true;
      },
      'edit:deleteLeftAll': () => {
        editDispatch({ type: 'KILL_LEFT' });
        return true;
      },
      'edit:deleteWordLeft': () => {
        editDispatch({ type: 'DELETE_WORD_LEFT' });
        return true;
      },
      // Commit edit (Escape or Enter)
      'dialog:escape': () => {
        commitEdit();
        return true;
      },
      'dialog:confirm': () => {
        commitEdit();
        return true;
      },
      // Arrow up/down: commit and navigate
      'dialog:navigate:up': () => {
        if (!commitEdit()) return true;
        moveUp();
        return true;
      },
      'dialog:navigate:down': () => {
        if (!commitEdit()) return true;
        moveDown();
        return true;
      },
      // Tab switches: commit and let tab switch happen (return false to cascade)
      'dialog:tab:next': () => {
        if (!commitEdit()) return true;
        return false;
      },
      'dialog:tab:previous': () => {
        if (!commitEdit()) return true;
        return false;
      },
      // Ctrl+L: no-op in edit mode (don't clear while editing)
      'dialog:clearItem': () => true,
    };
  }, [editingKey, editDispatch, commitEdit, moveUp, moveDown]);

  // --- Navigation mode action handlers ---
  const navActionHandlers = useMemo((): Record<string, ActionHandler> => {
    if (editingKey) return {};

    return {
      'dialog:navigate:up': () => {
        // Arrows hand focus back to the list rather than moving within it —
        // the highlight is already somewhere, so the *next* press moves it.
        if (blurSearch()) return true;
        moveUp();
        return true;
      },
      'dialog:navigate:down': () => {
        if (blurSearch()) return true;
        moveDown();
        return true;
      },
      'dialog:confirm': (key) => {
        // Before the `currentItem` guard on purpose: with a filter matching
        // nothing there is no current item, and Enter still has to be a way
        // out of the search box.
        if (blurSearch()) return true;
        if (!currentItem) return false;
        // Enter 优先让父组件处理（如 drill-down 进详情页）
        if (onKeyPress?.(key, currentItem)) {
          return true;
        }
        // 父组件不处理，才做 toggle / edit
        if (TOGGLE_TYPES.has(currentItem.type)) {
          onItemToggle(currentItem.key, currentItem);
        } else if (!readOnly) {
          const rawVal = currentItem.rawValue;
          const initialValue =
            currentItem.editValue ??
            (rawVal !== undefined ? String(rawVal) : '');
          startEditing(currentItem.key, initialValue);
        } else {
          return false;
        }
        return true;
      },
      'dialog:clearItem': () => {
        if (readOnly || !currentItem) return false;
        onItemClear(currentItem.key, currentItem);
        return true;
      },
      // Slash mode: `/` opens the filter. Registered unconditionally — the
      // handler decides — because useRegisterActionHandlers re-registers (and
      // re-appends) the whole set whenever the action-name set changes, which
      // would push this panel's escape handler behind BaseTabDialog's closer.
      'dialog:search': () => {
        if (!slashSearch || searchActiveRef.current) return false;
        setSearchActiveSynced(true);
        return true;
      },
      'dialog:escape': () => {
        onClose();
        return true;
      },
    };
  }, [
    editingKey,
    readOnly,
    currentItem,
    moveUp,
    moveDown,
    startEditing,
    onItemToggle,
    onItemClear,
    onClose,
    onKeyPress,
    slashSearch,
    setSearchActiveSynced,
    blurSearch,
  ]);

  // Merge edit + nav handlers (only one set is non-empty at a time)
  const actionHandlers = useMemo(
    () => ({ ...navActionHandlers, ...editActionHandlers }),
    [navActionHandlers, editActionHandlers],
  );

  // Register all action handlers on the Dialog context
  useRegisterActionHandlers('Dialog', actionHandlers, true);

  // Cancelling the filter has to beat every enclosing Escape handler, and
  // registration order alone can't guarantee that: ModelSelector registers its
  // own closer while it is still on the loading view (before this panel
  // exists), and a tab switch remounts this panel behind BaseTabDialog's
  // closer. A prepended, single-action registration sits at the head of the
  // stack in both cases. Its action set never changes, so it is never
  // re-appended.
  /**
   * The arrows leave the search box, claimed before the buffer sees them.
   * Necessary because the focused input runs ahead of context routing, and the
   * buffer would otherwise spend them moving the cursor across the wrapped
   * visual rows of a long query instead of handing focus back.
   */
  const handleSearchKeyBeforeInput = useCallback(
    (key: Key): boolean => {
      if (!searchActiveRef.current) return false;
      if (key.name === 'up' || key.name === 'down') {
        return blurSearch();
      }
      return false;
    },
    [blurSearch],
  );

  const searchEscapeHandlers = useMemo(
    (): Record<string, ActionHandler> => ({
      'dialog:escape': () => {
        if (!searchActiveRef.current) return false;
        if (internalSearchBuffer.text.length > 0) {
          internalSetText('');
          setInternalQuery('');
        }
        setSearchActiveSynced(false);
        return true;
      },
    }),
    [internalSearchBuffer, internalSetText, setSearchActiveSynced],
  );
  useRegisterActionHandlers('Dialog', searchEscapeHandlers, slashSearch, {
    prepend: true,
  });

  // Fallback handler: printable character insertion (edit mode) + parent custom keys
  const fallbackHandler = useCallback(
    (key: Key): boolean | void => {
      if (editingKey) {
        // Printable character insertion in edit mode
        if (key.insertable && key.sequence && !key.ctrl && !key.cmd) {
          const item = filteredItems.find((i) => i.key === editingKey);
          const type = item?.type ?? 'string';
          editDispatch({
            type: 'INSERT_CHAR',
            char: key.sequence,
            isNumberType: type === 'number',
          });
          return true;
        }
        return false;
      }

      // With the filter open, it owns every printable key — nothing below may
      // reinterpret one as a shortcut. This has to come first: dispatch order
      // between this fallback and TextInput's own subscriber is not fixed
      // (it differs between the app and the test harness), so the guard, not
      // the ordering, is what keeps typing from triggering shortcuts.
      //
      // Scoped to slash mode on purpose. In 'always' mode the search box is
      // permanently focused, so this guard would disable the shortcuts below
      // outright — a behavior change no caller asked for.
      if (slashSearch && searchActiveRef.current && key.insertable) {
        return false;
      }

      // Left/Right belong to the filter's caret while it is up. TextInput
      // declines them on an empty buffer or at a boundary, so without this they
      // would fall through to whatever the parent (or the dialog's tab
      // navigation) does with arrows — silently switching tabs mid-search.
      // Consume them here instead. The ref, not the render closure, is what
      // makes this correct when `/` and an arrow arrive in one stdin chunk.
      if (
        slashSearch &&
        searchActiveRef.current &&
        (key.name === 'left' || key.name === 'right')
      ) {
        return true;
      }

      // Navigation mode: number keys for quick edit on number fields
      if (
        !readOnly &&
        currentItem?.type === 'number' &&
        /^[0-9]$/.test(key.sequence)
      ) {
        startEditing(currentItem.key, key.sequence);
        return true;
      }

      // 'c' key toggles boolean/enum items. Slash mode leaves bare letters to
      // the caller (see `searchTrigger`), so this panel must not claim one.
      if (
        !slashSearch &&
        key.sequence === 'c' &&
        key.name !== 'paste' &&
        !key.ctrl &&
        !key.alt &&
        !key.cmd &&
        currentItem &&
        TOGGLE_TYPES.has(currentItem.type)
      ) {
        onItemToggle(currentItem.key, currentItem);
        return true;
      }

      // Parent custom key handler
      if (onKeyPress?.(key, currentItem)) {
        return true;
      }

      return false;
    },
    [
      editingKey,
      filteredItems,
      readOnly,
      currentItem,
      editDispatch,
      startEditing,
      onItemToggle,
      onKeyPress,
      slashSearch,
    ],
  );

  useRegisterFallbackHandler('Dialog', fallbackHandler, true);

  // Navigation hints that this panel owns.
  // The Enter action's label varies by context (e.g. "Enter select", "Enter
  // details") so parents declare that via extraHints on the container BTD.
  const navigationHints = useMemo(
    () =>
      !editingKey
        ? [
            {
              label: navigationHint ?? SHORTCUT_HINTS.NAVIGATE,
              order: 20,
            },
          ]
        : [],
    [editingKey, navigationHint],
  );

  // Always bubble hints up to the parent's HintRegistryProvider so
  // they appear in the parent BTD footer.
  useRegisterHints('SettingsListPanel', navigationHints);

  return (
    <Box flexDirection="column">
      {pinnedItem && (
        <Box
          paddingLeft={1}
          paddingY={compactGroups ? 0 : 1}
          justifyContent="flex-start"
        >
          <SelectionGradient colors={selectionGradient}>
            <Text
              color={
                filteredItems[activeIndex]?.key === pinnedItem.key ||
                selectionGradient
                  ? focusedColor
                  : theme.status.success
              }
              bold
            >
              {filteredItems[activeIndex]?.key === pinnedItem.key
                ? `${figures.pointer} `
                : ''}
              {pinnedItem.label}
            </Text>
          </SelectionGradient>
        </Box>
      )}
      {/* Search input (if enabled) -- matches InputPrompt styling */}
      {searchEnabled && searchBuffer && (
        <InputField
          focus={!editingKey && effectiveSearchFocused}
          buffer={searchBuffer}
          placeholder={searchPlaceholder}
          onKeyBeforeInput={
            slashSearch ? handleSearchKeyBeforeInput : undefined
          }
        />
      )}

      {/* Items list -- fixed height to prevent layout jumps when switching tabs */}
      <Box
        flexDirection="column"
        height={
          (hasGroups ? Math.max(1, visibleModelItems.length) : layoutMaxItems) *
            (itemHeightProp ?? 2) +
          visibleGroupHeight
        }
      >
        {filteredItems.every((item) => item.key === pinnedItemKey) ? (
          <Box paddingLeft={1}>
            <Text color={theme.text.secondary}>{emptyMessage}</Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            {visibleItems.map((item, idx) => {
              if (item.key === pinnedItemKey) return null;
              const showGroup =
                Boolean(item.groupLabel) &&
                (idx === 0 ||
                  visibleItems[idx - 1]?.groupLabel !== item.groupLabel);
              const globalIndex = idx + windowStart;
              const isFocused = activeIndex === globalIndex;
              const isFirstVisible = idx === 0;
              const isLastVisible = idx === visibleItems.length - 1;

              // Compute display value with edit mode cursor
              let displayValue: string;
              if (editingKey === item.key) {
                // Show edit buffer with cursor highlighting
                if (cursorVisible && editCursorPos < cpLen(editBuffer)) {
                  const beforeCursor = cpSlice(editBuffer, 0, editCursorPos);
                  const atCursor = cpSlice(
                    editBuffer,
                    editCursorPos,
                    editCursorPos + 1,
                  );
                  const afterCursor = cpSlice(editBuffer, editCursorPos + 1);
                  displayValue =
                    beforeCursor + chalk.inverse(atCursor) + afterCursor;
                } else if (editCursorPos >= cpLen(editBuffer)) {
                  displayValue =
                    editBuffer + (cursorVisible ? chalk.inverse(' ') : ' ');
                } else {
                  displayValue = editBuffer;
                }
              } else {
                displayValue = item.displayValue;
              }

              // Determine left indicator: scroll arrows on first/last, or selection arrow
              let indicator: string;
              let indicatorColor: string;
              if (isFirstVisible && canScrollUp) {
                indicator = '▲';
                indicatorColor = theme.text.secondary;
              } else if (isLastVisible && canScrollDown) {
                indicator = '▼';
                indicatorColor = theme.text.secondary;
              } else if (isFocused) {
                indicator = figures.pointer;
                indicatorColor = focusedColor;
              } else {
                indicator = ' ';
                indicatorColor = theme.text.primary;
              }

              const paddedLabel = padRight(item.label, nameWidth);
              const valuePrefix = item.displayValuePrefix
                ? `${item.displayValuePrefix.text} `
                : '';
              const valueScope = item.scopeMessage
                ? ` ${item.scopeMessage}`
                : '';
              const valueTextForWidth =
                editingKey === item.key ? editBuffer : displayValue;
              // The struck-through original (e.g. "1.60x ") is rendered before
              // the value, so it must count toward the column width and the
              // right-align padding — otherwise the value wraps.
              const valueStrikeForWidth =
                editingKey === item.key || !item.displayValueStrike
                  ? ''
                  : `${item.displayValueStrike} `;
              const valueContentWidth = getCachedStringWidth(
                `${valuePrefix}${valueStrikeForWidth}${valueTextForWidth}${valueScope}`,
              );
              const rowValueColumnWidth = Math.max(
                valueColumnWidth,
                valueContentWidth,
              );
              const isValueLeftAligned = valueAlign === 'left';
              // Right-aligned rows pad the value out to the panel edge.
              // Left-aligned rows sit flush after the padded label column.
              const valueLeftPadding = isValueLeftAligned
                ? 0
                : Math.max(0, rowValueColumnWidth - valueContentWidth);

              // Number of description rows below the label line
              const descLineCount = (itemHeightProp ?? 2) - 1;
              const inlineSuffix =
                item.suffix ?? (isFocused ? item.focusedSuffix : undefined);
              const inlineSegments =
                (isFocused ? item.focusedSuffixSegments : undefined) ??
                item.suffixSegments;
              // A row with a labelSuffix renders its label unpadded (the badge
              // has to sit flush against the name), which would leave anything
              // after it starting at a different column on every badged row.
              // Pad past the badge so the inline slot lines up down the list.
              const labelSuffixPad = item.labelSuffix
                ? Math.max(
                    0,
                    nameWidth -
                      getCachedStringWidth(item.label) -
                      1 -
                      getCachedStringWidth(item.labelSuffix.text),
                  )
                : 0;
              const highlightValueOnFocus = item.highlightValueOnFocus ?? true;

              return (
                <Box key={item.key} flexDirection="column" marginBottom={0}>
                  {showGroup && (
                    <Box paddingLeft={1} marginTop={compactGroups ? 0 : 1}>
                      <Text color={theme.text.secondary}>
                        {item.groupLabel}
                      </Text>
                    </Box>
                  )}
                  {/* Main row: border + indicator + label + value */}
                  <Box flexDirection="row" width="100%">
                    <Box flexShrink={0} flexDirection="row">
                      <Text> </Text>
                      <Text color={indicatorColor} bold={isFocused}>
                        {`${indicator} `}
                      </Text>
                    </Box>
                    <Box
                      flexDirection="row"
                      flexGrow={isValueLeftAligned ? 0 : 1}
                      flexShrink={isValueLeftAligned ? 0 : 1}
                      overflow="hidden"
                      {...(isValueLeftAligned ? { width: nameWidth } : {})}
                    >
                      <SelectionGradient
                        colors={
                          effectiveHighlightQuery
                            ? undefined
                            : isFocused
                              ? selectionGradient
                              : item.labelGradient
                        }
                      >
                        <Text
                          color={
                            isFocused
                              ? focusedColor
                              : (item.labelColor ?? theme.text.primary)
                          }
                          bold={isFocused}
                          {...(isValueLeftAligned
                            ? { wrap: 'truncate-end' as const }
                            : {})}
                        >
                          {item.labelSegments && !effectiveHighlightQuery ? (
                            <>
                              {item.labelSegments.map(
                                (segment, segmentIndex) => (
                                  <Text
                                    key={`${item.key}-label-${segmentIndex}`}
                                    color={
                                      segment.color ??
                                      (isFocused
                                        ? focusedColor
                                        : (item.labelColor ??
                                          theme.text.primary))
                                    }
                                    bold={segment.bold}
                                  >
                                    {segment.text}
                                  </Text>
                                ),
                              )}
                            </>
                          ) : item.labelSuffix ? (
                            <>
                              {effectiveHighlightQuery
                                ? highlightText(
                                    item.label,
                                    effectiveHighlightQuery,
                                  )
                                : item.label}
                              <Text color={item.labelSuffix.color}>
                                {` ${item.labelSuffix.text}`}
                              </Text>
                              {labelSuffixPad > 0 && (
                                <Text>{' '.repeat(labelSuffixPad)}</Text>
                              )}
                            </>
                          ) : effectiveHighlightQuery ? (
                            highlightText(paddedLabel, effectiveHighlightQuery)
                          ) : (
                            paddedLabel
                          )}
                        </Text>
                      </SelectionGradient>
                      {inlineSegments && inlineSegments.length > 0 ? (
                        <Text>
                          {'  '}
                          {inlineSegments.map((segment, segmentIndex) => (
                            <Text
                              key={`${item.key}-seg-${segmentIndex}`}
                              color={segment.color ?? theme.text.secondary}
                              bold={segment.bold}
                              dimColor={segment.dimColor}
                            >
                              {segment.text}
                            </Text>
                          ))}
                        </Text>
                      ) : (
                        inlineSuffix && (
                          <Text
                            color={item.suffixColor ?? theme.text.secondary}
                          >
                            {`  ${inlineSuffix}`}
                          </Text>
                        )
                      )}
                    </Box>
                    <Box
                      {...(isValueLeftAligned
                        ? {
                            flexGrow: 1,
                            flexShrink: 1,
                            paddingLeft: LEFT_ALIGN_VALUE_GUTTER,
                          }
                        : { width: rowValueColumnWidth, flexShrink: 0 })}
                      overflow="hidden"
                    >
                      {valueLeftPadding > 0 && (
                        <Text>{' '.repeat(valueLeftPadding)}</Text>
                      )}
                      {item.displayValuePrefix && (
                        <Text
                          color={item.displayValuePrefix.color}
                          bold={isFocused}
                        >
                          {item.displayValuePrefix.text}{' '}
                        </Text>
                      )}
                      {item.displayValueStrike && editingKey !== item.key && (
                        <Text color={theme.text.secondary} strikethrough>
                          {item.displayValueStrike}{' '}
                        </Text>
                      )}
                      <Text
                        color={
                          isFocused && highlightValueOnFocus
                            ? theme.ui.focus
                            : item.isGreyedOut
                              ? theme.text.secondary
                              : theme.text.primary
                        }
                        bold={isFocused && highlightValueOnFocus}
                        {...(isValueLeftAligned && editingKey !== item.key
                          ? { wrap: 'truncate-end' as const }
                          : {})}
                        terminalCursorFocus={
                          editingKey === item.key && cursorVisible
                        }
                        terminalCursorPosition={cpIndexToOffset(
                          editBuffer,
                          editCursorPos,
                        )}
                      >
                        {displayValue}
                      </Text>
                      {item.scopeMessage && (
                        <Text
                          color={theme.text.secondary}
                          {...(isValueLeftAligned
                            ? { wrap: 'truncate-end' as const }
                            : {})}
                        >
                          {' '}
                          {item.scopeMessage}
                        </Text>
                      )}
                    </Box>
                  </Box>
                  {/* Description rows -- natural wrap then truncate */}
                  {descLineCount > 0 && (
                    <Box
                      height={descLineCount}
                      paddingLeft={3}
                      overflow="hidden"
                      flexDirection="column"
                    >
                      <Text color={theme.text.secondary} dimColor wrap="wrap">
                        {effectiveHighlightQuery
                          ? highlightText(
                              item.description ?? '',
                              effectiveHighlightQuery,
                            )
                          : (item.description ?? '')}
                      </Text>
                      {isFocused && item.focusedWarning && (
                        <Text color={item.focusedWarning.color} wrap="wrap">
                          ⚠ {item.focusedWarning.text}
                        </Text>
                      )}
                    </Box>
                  )}
                </Box>
              );
            })}
          </Box>
        )}
      </Box>

      {/* Footer content (e.g., restart prompt) */}
      {footer ? (
        <Box height={reservedFooterHeight ?? footer.height} overflow="hidden">
          {footerContent}
        </Box>
      ) : reservedFooterHeight ? (
        <Box height={reservedFooterHeight} />
      ) : null}
    </Box>
  );
}

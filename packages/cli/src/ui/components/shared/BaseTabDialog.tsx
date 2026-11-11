/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import {
  Fragment,
  useState,
  useCallback,
  useReducer,
  useRef,
  useEffect,
  useMemo,
  useLayoutEffect,
} from 'react';
import {
  Text,
  Box,
  ResizeObserver,
  type DOMElement,
  measureElement,
} from 'ink';
import { theme } from '../../semantic-colors.js';
import { getBorderStyle } from '../../utils/borderStyles.js';
import type { ShortcutHint } from '../../hooks/useContainerKeyboard.js';
import { useRegisterActionHandlers } from '../../contexts/ActionHandlerRegistry.js';
import { useRegisterKeyboardContext } from '../../contexts/KeyboardContextRegistry.js';
import {
  HintRegistryProvider,
  useRegisteredHints,
} from '../../contexts/HintRegistryContext.js';
import { SHORTCUT_HINTS } from '../../constants/shortcuts.js';
import { HorizontalLine } from './HorizontalLine.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';

/**
 * A single tab definition for BaseTabDialog.
 */
export interface TabItem {
  /** Unique identifier for this tab */
  key: string;
  /** Display label shown in the tab bar */
  label: string;
}

/**
 * Props for the BaseTabDialog component.
 */
export interface BaseTabDialogProps {
  /** Command title shown before the tabs (e.g. "Model", "Settings") */
  title?: string;
  /** Tab definitions (default: [] — no tab bar) */
  tabs?: TabItem[];
  /** Currently active tab key (default: '') */
  activeKey?: string;
  /** Called when the user switches tabs (default: no-op) */
  onTabChange?: (key: string) => void;
  /** Content to render below the tab bar (typically the active tab's body) */
  children: React.ReactNode;
  /**
   * Footer hint text.
   * - If a string is provided it renders directly.
   * - If omitted, hints are auto-collected from registered action handlers
   *   and the extraHints prop.
   */
  footer?: string;
  /** Whether the tab navigation is active (default: true) */
  isActive?: boolean;
  /** Whether to show the separator line below the tab bar (default: true) */
  showSeparator?: boolean;
  /** Whether to show the content area below the tab bar (default: true) */
  showContent?: boolean;
  /**
   * 开启后保留页签内容区高度，防止切换到较矮页签时布局收缩。
   *
   * 提供 `tabPanels` 时预先测量全部页签，并使用它代替 `children`。
   * 未提供时仅渲染活动页签的 `children`，保留当前终端尺寸下已显示内容的
   * 最大高度；更高内容仍可撑开容器，终端缩放后重新测量。
   *
   * (default: false)
   */
  equalizeTabHeight?: boolean;
  /**
   * Whether Left/Right also switch tabs. Default true.
   *
   * Set false when the dialog body needs the arrow keys for itself (the model
   * picker adjusts the focused row's reasoning effort with them). Tab /
   * Shift+Tab keep switching tabs either way, so there is always a way across.
   *
   * This is the opt-out rather than having the body out-prioritise BTD: a
   * parent that registers arrow handlers with `prepend` lands in front of the
   * *child* handlers too, which would steal Left/Right from the custom model wizard
   * inside the Custom tab.
   */
  arrowTabNavigation?: boolean;
  /**
   * Minimum number of terminal rows reserved for the footer hint.
   *
   * The footer renders outside the equalized tab panel, and its `<Text>` wraps
   * rather than truncates — so a caller whose hint string changes length as the
   * user navigates (the model picker names the focused row's adjustable
   * columns) would make the whole dialog grow and shrink by a row. Reserving
   * the tallest variant up front keeps the wrap without the jitter.
   */
  footerMinHeight?: number;
  /**
   * Map of tab key → panel ReactNode.
   * 配合 `equalizeTabHeight` 使用时，可预先测量所有页签。
   *
   * Example:
   * ```tsx
   * tabPanels={{
   *   usage: <UsageTabContent ... />,
   *   status: <StatusTabContent ... />,
   * }}
   * ```
   */
  tabPanels?: Record<string, React.ReactNode>;

  // ─── Unified keyboard behavior props ───

  /**
   * Optional close handler. When provided, Esc is automatically handled
   * so child components don't need to register their own Esc handler.
   */
  onClose?: () => void;

  /**
   * Separator character between the title and tabs (default: '·').
   */
  titleSeparator?: string;

  /**
   * When true, tabs represent ordered steps and are separated by '>'
   * between each tab (e.g. "Title · Content > Email > Submit").
   * Default: false — tabs are shown side by side without separators.
   */
  orderedTabs?: boolean;

  /**
   * Extra shortcut hints to display in the auto-generated footer.
   * Only used when `footer` prop is not provided.
   */
  extraHints?: ShortcutHint[];

  /** Optional P1-localized labels for the auto-generated tab/close hints. */
  defaultHintLabels?: {
    goBack?: string;
    tabSwitch?: string;
  };

  /**
   * Optional border color for the outer box.
   * When provided, the entire dialog is wrapped in a rounded border with this color.
   * Useful for warning/attention dialogs (e.g. borderColor={theme.status.warning}).
   */
  borderColor?: string;
  /** Whether keyboard tab navigation wraps at the endpoints. */
  wrapTabs?: boolean;
}

/**
 * Generic tabbed container component.
 *
 * Visual design:
 * - Title (if provided) shown before tabs: "Title > [ActiveTab]  InactiveTab"
 * - Selected tab: background-highlighted, bold, accent color
 * - Unselected tab: plain text, secondary color
 * - Separator line spans terminal width
 * - Optional footer for shortcut hints (dimColor + italic)
 *
 * Navigation:
 * - Left/Right arrow keys
 * - Tab / Shift+Tab
 * - Managed by inline tab navigation reducer + Dialog context action handlers
 *
 * Height equalization:
 * - When equalizeTabHeight + tabPanels are provided, all tab panels are
 *   rendered on the first frame to measure their natural heights.
 * - On subsequent frames only the active panel is shown, and the container
 *   height is locked to the tallest measured panel.
 * - 未提供 tabPanels 时，保留已显示活动内容的最大高度。
 */
export function BaseTabDialog({
  title,
  tabs = [],
  activeKey = '',
  onTabChange = () => {},
  children,
  footer,
  isActive = true,
  showSeparator = true,
  showContent = true,
  equalizeTabHeight = false,
  arrowTabNavigation = true,
  footerMinHeight,
  tabPanels,
  onClose,
  titleSeparator,
  orderedTabs,
  extraHints,
  defaultHintLabels,
  borderColor,
  wrapTabs = true,
}: BaseTabDialogProps): React.JSX.Element {
  return (
    <HintRegistryProvider>
      <BaseTabDialogInner
        title={title}
        tabs={tabs}
        activeKey={activeKey}
        onTabChange={onTabChange}
        footer={footer}
        isActive={isActive}
        showSeparator={showSeparator}
        showContent={showContent}
        equalizeTabHeight={equalizeTabHeight}
        arrowTabNavigation={arrowTabNavigation}
        footerMinHeight={footerMinHeight}
        tabPanels={tabPanels}
        onClose={onClose}
        titleSeparator={titleSeparator}
        orderedTabs={orderedTabs}
        extraHints={extraHints}
        defaultHintLabels={defaultHintLabels}
        borderColor={borderColor}
        wrapTabs={wrapTabs}
      >
        {children}
      </BaseTabDialogInner>
    </HintRegistryProvider>
  );
}

// ---------------------------------------------------------------------------
// Tab navigation reducer — manages tab index state for BTD.
// Inlined from the removed useTabNavigationBehavior hook since BTD is the
// only consumer and only needs goToNextTab / goToPrevTab callbacks.
// ---------------------------------------------------------------------------

interface TabNavState {
  currentIndex: number;
  tabCount: number;
  pendingTabChange: boolean;
}

type TabNavAction =
  | { type: 'NEXT_TAB'; wrapTabs: boolean }
  | { type: 'PREV_TAB'; wrapTabs: boolean }
  | { type: 'INITIALIZE'; payload: { tabCount: number; initialIndex: number } }
  | { type: 'CLEAR_PENDING' };

function tabNavReducer(state: TabNavState, action: TabNavAction): TabNavState {
  switch (action.type) {
    case 'NEXT_TAB': {
      const { tabCount, currentIndex } = state;
      if (tabCount === 0) return state;
      const next = action.wrapTabs
        ? (currentIndex + 1) % tabCount
        : Math.min(currentIndex + 1, tabCount - 1);
      if (next === currentIndex) return state;
      return { ...state, currentIndex: next, pendingTabChange: true };
    }
    case 'PREV_TAB': {
      const { tabCount, currentIndex } = state;
      if (tabCount === 0) return state;
      const next = action.wrapTabs
        ? (currentIndex - 1 + tabCount) % tabCount
        : Math.max(0, currentIndex - 1);
      if (next === currentIndex) return state;
      return { ...state, currentIndex: next, pendingTabChange: true };
    }
    case 'INITIALIZE': {
      const { tabCount, initialIndex } = action.payload;
      const valid = Math.max(0, Math.min(initialIndex, tabCount - 1));
      return {
        ...state,
        tabCount,
        currentIndex: tabCount > 0 ? valid : 0,
        pendingTabChange: false,
      };
    }
    case 'CLEAR_PENDING':
      return { ...state, pendingTabChange: false };
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// useBTDKeyboardHandlers — registers Dialog context + escape/tab-nav action
// handlers. Child components register their own action handlers and fallback
// handlers on the Dialog context via useRegisterActionHandlers /
// useRegisterFallbackHandler. BTD only handles:
// 1. Tab navigation (dialog:tab:next/previous, dialog:navigate:left/right)
// 2. Escape (dialog:escape → onClose, when provided)
// ---------------------------------------------------------------------------

function useBTDKeyboardHandlers({
  tabs,
  onClose,
  tabNavActions,
  isActive,
  defaultHintLabels,
  arrowTabNavigation,
}: {
  tabs: TabItem[];
  onClose?: () => void;
  arrowTabNavigation: boolean;
  tabNavActions: {
    goToNextTab: () => void;
    goToPrevTab: () => void;
  };
  isActive: boolean;
  defaultHintLabels?: BaseTabDialogProps['defaultHintLabels'];
}): { tabNavHints: ShortcutHint[] } {
  // Register Dialog keyboard context so context routing resolves Dialog
  // actions (escape, tab nav, etc.) when this dialog is active.
  useRegisterKeyboardContext('Dialog', isActive);

  // Build action handlers for tab navigation + optional escape
  const actionHandlers = useMemo(() => {
    const handlers: Record<string, () => boolean | void> = {};

    // Escape handling
    if (onClose) {
      handlers['dialog:escape'] = () => {
        onClose();
        return true;
      };
    }

    // Tab navigation (only when there are multiple tabs)
    if (tabs.length > 1) {
      handlers['dialog:tab:next'] = () => {
        tabNavActions.goToNextTab();
        return true;
      };
      handlers['dialog:tab:previous'] = () => {
        tabNavActions.goToPrevTab();
        return true;
      };
      // Arrow tab-switching is opt-out: a dialog body that needs Left/Right
      // for itself passes arrowTabNavigation={false}.
      if (arrowTabNavigation) {
        handlers['dialog:navigate:left'] = () => {
          tabNavActions.goToPrevTab();
          return true;
        };
        handlers['dialog:navigate:right'] = () => {
          tabNavActions.goToNextTab();
          return true;
        };
      }
    }

    return handlers;
  }, [onClose, tabs.length, tabNavActions, arrowTabNavigation]);

  useRegisterActionHandlers('Dialog', actionHandlers, isActive);

  // Collect hints
  const tabNavHints = useMemo<ShortcutHint[]>(() => {
    const hints: ShortcutHint[] = [];
    if (!isActive) return hints;
    if (onClose) {
      hints.push({
        label: defaultHintLabels?.goBack ?? SHORTCUT_HINTS.GO_BACK,
        order: 100,
      });
    }
    if (tabs.length > 1) {
      hints.push({
        label:
          defaultHintLabels?.tabSwitch ??
          // "Tab/<-> switch" would be a lie once the body owns the arrows.
          (arrowTabNavigation
            ? SHORTCUT_HINTS.TAB_SWITCH
            : SHORTCUT_HINTS.TAB_ONLY_SWITCH),
        order: 10,
      });
    }
    return hints;
  }, [defaultHintLabels, isActive, onClose, tabs.length, arrowTabNavigation]);

  return { tabNavHints };
}

function BaseTabDialogInner({
  title,
  tabs = [],
  activeKey = '',
  onTabChange = () => {},
  children,
  footer,
  isActive = true,
  showSeparator = true,
  showContent = true,
  equalizeTabHeight = false,
  arrowTabNavigation = true,
  footerMinHeight,
  tabPanels,
  onClose,
  titleSeparator = '·',
  orderedTabs = false,
  extraHints,
  defaultHintLabels,
  borderColor,
  wrapTabs = true,
}: BaseTabDialogProps): React.JSX.Element {
  // Track measured heights for each tab panel (used when equalizeTabHeight is on)
  const [tabHeights, setTabHeights] = useState<Record<string, number>>({});
  const [measured, setMeasured] = useState(false);

  const maxHeight =
    Object.values(tabHeights).length > 0
      ? Math.max(...Object.values(tabHeights))
      : undefined;

  const reportHeights = useCallback((heights: Record<string, number>) => {
    setTabHeights(heights);
    setMeasured(true);
  }, []);

  const useEqualization =
    equalizeTabHeight && tabPanels != null && tabs.length > 1;
  const retainActiveHeight =
    equalizeTabHeight && tabPanels == null && tabs.length > 1;
  const { columns, rows } = useTerminalSize();
  const layoutKey = `${columns}:${rows}`;
  const [activeHeight, setActiveHeight] = useState({ key: '', height: 0 });
  const activeHeightObserverRef = useRef<ResizeObserver | null>(null);

  // 保留内容区的高度下限，避免切到短页签时把头部再次写入原生滚屏历史。
  // 仅观察活动内容；高度只增不减，不会产生测量反馈循环，也不挂载隐藏页签。
  const activeContentRef = useCallback(
    (node: DOMElement | null) => {
      activeHeightObserverRef.current?.disconnect();
      activeHeightObserverRef.current = null;
      if (!node || !retainActiveHeight) return;
      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        const height = entry.contentRect.height;
        setActiveHeight((previous) => {
          const nextHeight =
            previous.key === layoutKey
              ? Math.max(previous.height, height)
              : height;
          return previous.key === layoutKey && previous.height === nextHeight
            ? previous
            : { key: layoutKey, height: nextHeight };
        });
      });
      observer.observe(node);
      activeHeightObserverRef.current = observer;
    },
    [retainActiveHeight, layoutKey],
  );
  useEffect(() => () => activeHeightObserverRef.current?.disconnect(), []);

  // --- Tab navigation state (inline reducer) ---

  const activeIndex = Math.max(
    0,
    tabs.findIndex((t) => t.key === activeKey),
  );

  const [tabNavState, tabNavDispatch] = useReducer(tabNavReducer, {
    currentIndex: Math.max(0, Math.min(activeIndex, tabs.length - 1)),
    tabCount: tabs.length,
    pendingTabChange: false,
  });

  // Re-initialise when tab count or active key changes
  const prevTabCountRef = useRef(tabs.length);
  const prevActiveIndexRef = useRef(activeIndex);

  useEffect(() => {
    if (
      prevTabCountRef.current !== tabs.length ||
      prevActiveIndexRef.current !== activeIndex
    ) {
      tabNavDispatch({
        type: 'INITIALIZE',
        payload: { tabCount: tabs.length, initialIndex: activeIndex },
      });
      prevTabCountRef.current = tabs.length;
      prevActiveIndexRef.current = activeIndex;
    }
  }, [tabs.length, activeIndex]);

  // Fire onTabChange after reducer state transitions
  useEffect(() => {
    if (tabNavState.pendingTabChange) {
      const tab = tabs[tabNavState.currentIndex];
      if (tab) {
        onTabChange(tab.key);
      }
      tabNavDispatch({ type: 'CLEAR_PENDING' });
    }
  }, [
    tabNavState.pendingTabChange,
    tabNavState.currentIndex,
    tabs,
    onTabChange,
  ]);

  const goToNextTab = useCallback(() => {
    tabNavDispatch({ type: 'NEXT_TAB', wrapTabs });
  }, [wrapTabs]);

  const goToPrevTab = useCallback(() => {
    tabNavDispatch({ type: 'PREV_TAB', wrapTabs });
  }, [wrapTabs]);

  const tabNavActions = useMemo(
    () => ({ goToNextTab, goToPrevTab }),
    [goToNextTab, goToPrevTab],
  );

  const { tabNavHints } = useBTDKeyboardHandlers({
    tabs,
    onClose,
    tabNavActions,
    isActive,
    defaultHintLabels,
    arrowTabNavigation,
  });

  // Read context-registered hints from child components (via HintRegistryProvider)
  const contextHints = useRegisteredHints();

  // Determine footer content: explicit string prop > auto-generated from hints
  const footerText = useMemo(() => {
    if (footer) return footer;
    // Merge tab-nav hints + context-registered hints + extra hints
    const allHints = [
      ...tabNavHints,
      ...contextHints,
      ...(extraHints ?? []),
    ].sort((a, b) => a.order - b.order);
    if (allHints.length === 0) return undefined;
    // Deduplicate by label
    const seen = new Set<string>();
    const unique: ShortcutHint[] = [];
    for (const h of allHints) {
      if (!seen.has(h.label)) {
        seen.add(h.label);
        unique.push(h);
      }
    }
    return unique.map((h) => h.label).join(' \u00b7 ');
  }, [footer, tabNavHints, contextHints, extraHints]);

  const innerContent = (
    <Box flexDirection="column" width="100%">
      {/* Tab bar: Title > [ActiveTab]  InactiveTab */}
      <Box flexDirection="row" gap={1}>
        {title && tabs.length > 0 && (
          <>
            <Text color={theme.text.primary} bold>
              {` ${title}`}
            </Text>
            <Text color={theme.text.secondary}>{titleSeparator}</Text>
          </>
        )}
        {title && tabs.length === 0 && (
          <Text color={theme.text.primary} bold>
            {` ${title}`}
          </Text>
        )}
        {tabs.map((tab, index) => {
          const isSelected = tab.key === activeKey;
          return (
            <Fragment key={tab.key}>
              {orderedTabs && index > 0 && (
                <Text color={theme.text.secondary}>{'>'}</Text>
              )}
              {isSelected ? (
                <Box>
                  <Text
                    color={theme.ui.focus}
                    bold
                    backgroundColor={theme.background.focus}
                  >
                    {` ${tab.label} `}
                  </Text>
                </Box>
              ) : (
                <Box>
                  <Text color={theme.text.secondary}>{` ${tab.label} `}</Text>
                </Box>
              )}
            </Fragment>
          );
        })}
      </Box>

      {showSeparator && <HorizontalLine />}

      {/* Content area */}
      {showContent && (
        <Box
          flexDirection="column"
          paddingLeft={1}
          paddingRight={1}
          ref={retainActiveHeight ? activeContentRef : undefined}
          {...(retainActiveHeight && activeHeight.key === layoutKey
            ? { minHeight: activeHeight.height }
            : {})}
          {...(useEqualization && measured && maxHeight !== undefined
            ? { height: maxHeight }
            : {})}
        >
          {useEqualization ? (
            <EqualizedPanels
              tabs={tabs}
              activeKey={activeKey}
              tabPanels={tabPanels}
              measured={measured}
              reportHeights={reportHeights}
            />
          ) : (
            children
          )}
        </Box>
      )}

      {/* Footer hint */}
      {footerText && (
        <Box
          paddingLeft={1}
          marginTop={1}
          width="100%"
          {...(footerMinHeight !== undefined
            ? { minHeight: footerMinHeight }
            : {})}
        >
          <Text color={theme.text.secondary} dimColor italic>
            {footerText}
          </Text>
        </Box>
      )}
    </Box>
  );

  // Wrap in border if borderColor is specified
  if (borderColor) {
    return (
      <Box flexDirection="column" width="100%">
        <Box
          flexDirection="column"
          borderStyle={getBorderStyle('dialog')}
          borderColor={borderColor}
          padding={1}
          marginLeft={1}
          marginRight={1}
        >
          {innerContent}
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width="100%">
      {innerContent}
    </Box>
  );
}

/**
 * Internal: renders all tab panels on the first frame to measure their natural
 * heights, then switches to showing only the active panel.
 *
 * Frame 1 (measuring): All panels render stacked in a column. Each panel is
 * wrapped in a ref'd Box so measureElement can read its natural height.
 * After layout, heights are reported to the parent and `measured` flips true.
 *
 * Frame 2+ (display): Only the active panel renders. The parent container's
 * height is locked to the tallest measured panel via the `height` prop.
 */
function EqualizedPanels({
  tabs,
  activeKey,
  tabPanels,
  measured,
  reportHeights,
}: {
  tabs: TabItem[];
  activeKey: string;
  tabPanels: Record<string, React.ReactNode>;
  measured: boolean;
  reportHeights: (heights: Record<string, number>) => void;
}): React.JSX.Element {
  const refsMap = useRef<Record<string, DOMElement | null>>({});

  // Measure all panel heights after layout (synchronously via useLayoutEffect)
  useLayoutEffect(() => {
    if (measured) return;

    const heights: Record<string, number> = {};
    let allReady = true;
    for (const tab of tabs) {
      const el = refsMap.current[tab.key];
      if (el) {
        heights[tab.key] = measureElement(el).height;
      } else {
        allReady = false;
      }
    }
    if (allReady) {
      reportHeights(heights);
    }
  }, [measured, tabs, tabPanels, reportHeights]);

  // Phase 1: render all panels stacked so we can measure each one's natural height.
  // This is visible for exactly one frame, then `measured` flips true.
  if (!measured) {
    return (
      <Box flexDirection="column">
        {tabs.map((tab) => (
          <Box
            key={tab.key}
            ref={(el: DOMElement | null) => {
              refsMap.current[tab.key] = el;
            }}
            flexDirection="column"
          >
            {tabPanels[tab.key]}
          </Box>
        ))}
      </Box>
    );
  }

  // Phase 2: only render the active panel. Parent container height is locked.
  return <Box flexDirection="column">{tabPanels[activeKey]}</Box>;
}

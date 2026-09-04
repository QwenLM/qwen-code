/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

/** One executable entry of the right-click context menu. */
export interface ContextMenuItem {
  id: string;
  label: string;
  onSelect: () => void;
}

/**
 * Open-menu state. `position` is the clamped composited-frame grid coordinate
 * where the menu's top-left border renders (same space `terminalToGrid`
 * produces), so the overlay and the mouse controller share one geometry.
 */
export interface ContextMenuState {
  items: ContextMenuItem[];
  position: { x: number; y: number };
}

export interface ContextMenuContextValue {
  menu: ContextMenuState | null;
  selectedIndex: number;
  openMenu: (
    items: ContextMenuItem[],
    position: { x: number; y: number },
  ) => void;
  closeMenu: () => void;
  setSelectedIndex: (index: number) => void;
  /** Runs item `index` (bounds-checked) and closes the menu. */
  executeIndex: (index: number) => void;
}

const ContextMenuContext = createContext<ContextMenuContextValue>({
  menu: null,
  selectedIndex: 0,
  openMenu: () => {},
  closeMenu: () => {},
  setSelectedIndex: () => {},
  executeIndex: () => {},
});

export const ContextMenuProvider: React.FC<{
  children: React.ReactNode;
  /**
   * Notified whenever the menu opens or closes. AppContainer mirrors the
   * state into a ref to gate its always-active global keypress handler
   * (which lives outside this provider's subtree and cannot consume keys).
   */
  onMenuChange?: (open: boolean) => void;
}> = ({ children, onMenuChange }) => {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [selectedIndex, setSelectedIndexState] = useState(0);

  // Mirror of the current menu for stable callbacks that must read the latest
  // state without re-creating on every change (and without running side
  // effects inside a state updater, which StrictMode double-invokes).
  const menuRef = useRef<ContextMenuState | null>(null);
  menuRef.current = menu;

  const openMenu = useCallback(
    (items: ContextMenuItem[], position: { x: number; y: number }) => {
      if (items.length === 0) return;
      setMenu({ items, position });
      setSelectedIndexState(0);
    },
    [],
  );

  const closeMenu = useCallback(() => {
    // Clear the mirror synchronously: KeypressContext can dispatch a whole
    // stdin chunk in one tick with no render between, so an executeIndex
    // landing right after a dismissal must not read the stale menu.
    menuRef.current = null;
    setMenu(null);
  }, []);

  useEffect(() => {
    onMenuChange?.(menu !== null);
  }, [menu, onMenuChange]);

  const setSelectedIndex = useCallback((index: number) => {
    setSelectedIndexState(index);
  }, []);

  const executeIndex = useCallback((index: number) => {
    const item = menuRef.current?.items[index];
    setMenu(null);
    if (item) item.onSelect();
  }, []);

  const value = useMemo(
    () => ({
      menu,
      selectedIndex,
      openMenu,
      closeMenu,
      setSelectedIndex,
      executeIndex,
    }),
    [menu, selectedIndex, openMenu, closeMenu, setSelectedIndex, executeIndex],
  );

  return (
    <ContextMenuContext.Provider value={value}>
      {children}
    </ContextMenuContext.Provider>
  );
};

/**
 * Menu state + actions. Safe outside a provider (tests): reports no menu and
 * no-op actions.
 */
export function useContextMenu(): ContextMenuContextValue {
  return useContext(ContextMenuContext);
}

/**
 * Outer size of the rendered menu box (border included) for a given item
 * list. Used by the mouse controller for hit-testing and the open-time clamp.
 * The overlay re-encodes this geometry itself (border + one-space padding per
 * row), so its row rendering must stay in sync with these constants by hand.
 */
export function contextMenuSize(items: ContextMenuItem[]): {
  width: number;
  height: number;
} {
  const longest = items.reduce(
    (max, item) => Math.max(max, item.label.length),
    0,
  );
  return { width: longest + 4, height: items.length + 2 };
}

/**
 * Clamp a desired top-left so the menu fits inside the terminal, flipping up
 * / left near the bottom / right edges. Grid coordinates.
 */
export function clampMenuPosition(
  desired: { x: number; y: number },
  size: { width: number; height: number },
  terminalColumns: number,
  terminalRows: number,
): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(desired.x, terminalColumns - size.width)),
    y: Math.max(0, Math.min(desired.y, terminalRows - size.height)),
  };
}

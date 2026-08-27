/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ContextMenuProvider,
  useContextMenu,
  contextMenuSize,
  clampMenuPosition,
  type ContextMenuItem,
  type ContextMenuContextValue,
} from './ContextMenuContext.js';

describe('contextMenuSize', () => {
  it('accounts for border (2) and one space of padding each side (2)', () => {
    const items: ContextMenuItem[] = [
      { id: 'a', label: 'Open Link', onSelect: vi.fn() },
    ];
    // 'Open Link' is 9 chars → width 9 + 4 = 13; 1 item + 2 border rows = 3.
    expect(contextMenuSize(items)).toEqual({ width: 13, height: 3 });
  });

  it('uses the longest label for width', () => {
    const items: ContextMenuItem[] = [
      { id: 'a', label: 'Copy Link Address', onSelect: vi.fn() },
      { id: 'b', label: 'Open', onSelect: vi.fn() },
    ];
    expect(contextMenuSize(items).width).toBe('Copy Link Address'.length + 4);
    expect(contextMenuSize(items).height).toBe(4);
  });
});

describe('clampMenuPosition', () => {
  const size = { width: 13, height: 3 };

  it('keeps the desired position when it fits', () => {
    expect(clampMenuPosition({ x: 5, y: 5 }, size, 80, 24)).toEqual({
      x: 5,
      y: 5,
    });
  });

  it('flips left near the right edge', () => {
    expect(clampMenuPosition({ x: 78, y: 5 }, size, 80, 24)).toEqual({
      x: 80 - 13,
      y: 5,
    });
  });

  it('flips up near the bottom edge', () => {
    expect(clampMenuPosition({ x: 5, y: 23 }, size, 80, 24)).toEqual({
      x: 5,
      y: 24 - 3,
    });
  });

  it('never goes negative even for oversized menus', () => {
    expect(
      clampMenuPosition({ x: 0, y: 0 }, { width: 100, height: 50 }, 80, 24),
    ).toEqual({ x: 0, y: 0 });
  });
});

describe('ContextMenuProvider', () => {
  afterEach(cleanup);

  function mountProbe(): ContextMenuContextValue {
    // Always return the LATEST captured value; each state change re-renders
    // the probe and refresh `latest`.
    let latest: ContextMenuContextValue | undefined;
    const Probe = () => {
      latest = useContextMenu();
      return null;
    };
    render(
      <ContextMenuProvider>
        <Probe />
      </ContextMenuProvider>,
    );
    const value = latest!;
    // Hand back an accessor that always reads the newest snapshot.
    return new Proxy(value, {
      get: (_target, prop) => latest![prop as keyof ContextMenuContextValue],
    });
  }

  it('starts closed', () => {
    const menu = mountProbe();
    expect(menu.menu).toBeNull();
    expect(menu.selectedIndex).toBe(0);
  });

  it('openMenu stores items and position; closeMenu clears', () => {
    const menu = mountProbe();
    const items: ContextMenuItem[] = [
      { id: 'a', label: 'Open Link', onSelect: vi.fn() },
    ];
    act(() => menu.openMenu(items, { x: 2, y: 3 }));
    expect(menu.menu).toEqual({ items, position: { x: 2, y: 3 } });
    expect(menu.selectedIndex).toBe(0);
    act(() => menu.closeMenu());
    expect(menu.menu).toBeNull();
  });

  it('ignores openMenu with an empty item list', () => {
    const menu = mountProbe();
    act(() => menu.openMenu([], { x: 0, y: 0 }));
    expect(menu.menu).toBeNull();
  });

  it('executeIndex runs the item and closes; out-of-bounds is a no-op close', () => {
    const menu = mountProbe();
    const onSelect = vi.fn();
    act(() =>
      menu.openMenu([{ id: 'a', label: 'Open Link', onSelect }], {
        x: 0,
        y: 0,
      }),
    );
    act(() => menu.executeIndex(5));
    expect(onSelect).not.toHaveBeenCalled();
    expect(menu.menu).toBeNull();

    act(() =>
      menu.openMenu([{ id: 'a', label: 'Open Link', onSelect }], {
        x: 0,
        y: 0,
      }),
    );
    act(() => menu.executeIndex(0));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(menu.menu).toBeNull();
  });

  it('executeIndex right after closeMenu in the same tick is a no-op', () => {
    const menu = mountProbe();
    const onSelect = vi.fn();
    act(() =>
      menu.openMenu([{ id: 'a', label: 'Open Link', onSelect }], {
        x: 0,
        y: 0,
      }),
    );
    // KeypressContext dispatches a whole stdin chunk with no render between,
    // so closeMenu must clear the ref mirror synchronously.
    act(() => {
      menu.closeMenu();
      menu.executeIndex(0);
    });
    expect(onSelect).not.toHaveBeenCalled();
    expect(menu.menu).toBeNull();
  });

  it('notifies onMenuChange when the menu opens and closes', () => {
    const onMenuChange = vi.fn();
    let latest: ContextMenuContextValue | undefined;
    const Probe = () => {
      latest = useContextMenu();
      return null;
    };
    render(
      <ContextMenuProvider onMenuChange={onMenuChange}>
        <Probe />
      </ContextMenuProvider>,
    );
    expect(onMenuChange).toHaveBeenLastCalledWith(false);
    act(() =>
      latest!.openMenu([{ id: 'a', label: 'Open Link', onSelect: vi.fn() }], {
        x: 0,
        y: 0,
      }),
    );
    expect(onMenuChange).toHaveBeenLastCalledWith(true);
    act(() => latest!.closeMenu());
    expect(onMenuChange).toHaveBeenLastCalledWith(false);
  });

  it('setSelectedIndex updates the highlighted row', () => {
    const menu = mountProbe();
    act(() =>
      menu.openMenu(
        [
          { id: 'a', label: 'One', onSelect: vi.fn() },
          { id: 'b', label: 'Two', onSelect: vi.fn() },
        ],
        { x: 0, y: 0 },
      ),
    );
    act(() => menu.setSelectedIndex(1));
    expect(menu.selectedIndex).toBe(1);
  });
});

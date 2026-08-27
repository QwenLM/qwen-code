/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, cleanup, render } from '@testing-library/react';
import type { ReadonlyFrame } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMouseEvents } from '../hooks/useMouseEvents.js';
import type { MouseEvent } from '../utils/mouse.js';
import { copyToClipboard } from '../utils/commandUtils.js';
import { openBrowserSecurely } from '@qwen-code/qwen-code-core';
import {
  getScreenBuffer,
  type ScreenBuffer,
} from '../selection/screen-buffer.js';
import { ContentMouseController } from './ContentMouseController.js';
import { ContextMenuProvider, useContextMenu } from './ContextMenuContext.js';

const mocks = vi.hoisted(() => ({
  stdout: { rows: 24 },
  warn: vi.fn(),
  size: { columns: 80, rows: 24 },
}));

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    useStdout: () => ({ stdout: mocks.stdout }),
  };
});

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    createDebugLogger: () => ({ warn: mocks.warn }),
    openBrowserSecurely: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../hooks/useMouseEvents.js', () => ({ useMouseEvents: vi.fn() }));
vi.mock('../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => mocks.size,
}));
vi.mock('../utils/commandUtils.js', () => ({ copyToClipboard: vi.fn() }));
vi.mock('../selection/screen-buffer.js', () => ({
  getScreenBuffer: vi.fn(),
}));

const LINK_URL = 'https://example.com/';

function makeCell(
  value: string,
  osc8Url?: string,
): ReadonlyFrame['cells'][number][number] {
  return {
    type: 'char',
    value,
    fullWidth: false,
    styles: osc8Url
      ? [
          {
            type: 'ansi',
            code: `\x1b]8;;${osc8Url}\x07`,
            endCode: '\x1b]8;;\x07',
          },
        ]
      : [],
    selectable: true,
    flowId: 1,
  };
}

/** Frame: row 0 = "link here", the word "link" (cols 0-3) is hyperlinked. */
function makeLinkFrame(): ReadonlyFrame {
  const text = 'link here';
  return {
    width: text.length,
    height: 1,
    cells: [
      [...text].map((ch, i) => makeCell(ch, i < 4 ? LINK_URL : undefined)),
    ],
    boundaries: [Array.from({ length: text.length }, () => null)],
  } as unknown as ReadonlyFrame;
}

const makeEvent = (
  name: MouseEvent['name'],
  col: number,
  row = 1,
  ctrl = false,
): MouseEvent => ({
  name,
  col,
  row,
  shift: false,
  meta: false,
  ctrl,
  button: name.startsWith('right') ? 'right' : 'left',
});

describe('ContentMouseController', () => {
  let frame: ReadonlyFrame;
  let viewportRect: { x: number; y: number; width: number; height: number };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.size = { columns: 80, rows: 24 };
    frame = makeLinkFrame();
    viewportRect = { x: 0, y: 0, width: frame.width, height: 1 };
    vi.mocked(copyToClipboard).mockResolvedValue(undefined);
    vi.mocked(getScreenBuffer).mockReturnValue({
      get frame() {
        return frame;
      },
      get dimensions() {
        return { width: frame.width, height: frame.height };
      },
      setSelection: vi.fn(),
      subscribe: () => vi.fn(),
    } as unknown as ScreenBuffer);
  });

  afterEach(cleanup);

  interface Mounted {
    fire: (event: MouseEvent) => void;
    getMenu: () => ReturnType<typeof useContextMenu>['menu'];
  }

  function mount(selectionRange?: {
    sx: number;
    sy: number;
    ex: number;
    ey: number;
  }): Mounted {
    let latestMenu: Mounted['getMenu'] extends () => infer R ? R : never = null;
    const MenuProbe = () => {
      latestMenu = useContextMenu().menu;
      return null;
    };
    const selectionQueryRef = {
      current: selectionRange ? { getRange: () => selectionRange } : null,
    };
    render(
      <ContextMenuProvider>
        <ContentMouseController
          isActive
          getViewportRect={() => viewportRect}
          hitTestScrollbar={() => false}
          selectionQueryRef={selectionQueryRef}
        />
        <MenuProbe />
      </ContextMenuProvider>,
    );
    return {
      // Always dispatch through the handler from the LATEST render so the
      // closure sees current menu state (useMouseEvents is re-invoked with a
      // fresh handler each render).
      fire: (event) =>
        act(() => {
          const handler = vi.mocked(useMouseEvents).mock.calls.at(-1)![0];
          handler(event);
        }),
      getMenu: () => latestMenu,
    };
  }

  describe('Ctrl+click opens links', () => {
    it('opens the URL under the pointer on Ctrl press+release in the same cell', () => {
      const { fire } = mount();
      fire(makeEvent('left-press', 2, 1, true));
      fire(makeEvent('left-release', 2, 1, true));
      expect(openBrowserSecurely).toHaveBeenCalledWith(LINK_URL);
    });

    it('does not open without Ctrl', () => {
      const { fire } = mount();
      fire(makeEvent('left-press', 2, 1));
      fire(makeEvent('left-release', 2, 1));
      expect(openBrowserSecurely).not.toHaveBeenCalled();
    });

    it('does not open when release lands on a different cell (drag)', () => {
      const { fire } = mount();
      fire(makeEvent('left-press', 2, 1, true));
      fire(makeEvent('move', 3, 1));
      fire(makeEvent('left-release', 3, 1, true));
      expect(openBrowserSecurely).not.toHaveBeenCalled();
    });

    it('does not open on plain cells', () => {
      const { fire } = mount();
      fire(makeEvent('left-press', 7, 1, true));
      fire(makeEvent('left-release', 7, 1, true));
      expect(openBrowserSecurely).not.toHaveBeenCalled();
    });

    it('falls back to clipboard when the launcher rejects a crafted http(s) URL', async () => {
      vi.mocked(openBrowserSecurely).mockRejectedValueOnce(
        new Error('Invalid URL: https://'),
      );
      frame = {
        ...frame,
        cells: [[...'link'].map(() => makeCell('l', 'https://'))],
      } as unknown as ReadonlyFrame;
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { fire } = mount();
      fire(makeEvent('left-press', 1, 1, true));
      fire(makeEvent('left-release', 1, 1, true));
      expect(openBrowserSecurely).toHaveBeenCalledWith('https://');
      // The .catch fallback runs on a microtask after the rejection settles.
      await Promise.resolve();
      await Promise.resolve();
      expect(copyToClipboard).toHaveBeenCalledWith('https://');
      warnSpy.mockRestore();
    });

    it('copies non-http(s) links to the clipboard instead', () => {
      frame = {
        ...frame,
        cells: [[...'mail'].map(() => makeCell('m', 'mailto:dev@example.com'))],
      } as unknown as ReadonlyFrame;
      const { fire } = mount();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      fire(makeEvent('left-press', 1, 1, true));
      fire(makeEvent('left-release', 1, 1, true));
      expect(openBrowserSecurely).not.toHaveBeenCalled();
      expect(copyToClipboard).toHaveBeenCalledWith('mailto:dev@example.com');
      warnSpy.mockRestore();
    });
  });

  describe('right-click context menu', () => {
    it('opens with link items over a hyperlink', () => {
      const { fire, getMenu } = mount();
      fire(makeEvent('right-press', 2, 1));
      const menu = getMenu();
      expect(menu).not.toBeNull();
      expect(menu!.items.map((item) => item.id)).toEqual([
        'open-link',
        'copy-link',
      ]);
    });

    it('opens with Copy Selection when a selection is active on plain text', () => {
      const { fire, getMenu } = mount({ sx: 5, sy: 0, ex: 8, ey: 0 });
      fire(makeEvent('right-press', 7, 1));
      const menu = getMenu();
      expect(menu!.items.map((item) => item.id)).toEqual(['copy-selection']);
    });

    it('does not open on plain text without a selection', () => {
      const { fire, getMenu } = mount();
      fire(makeEvent('right-press', 7, 1));
      expect(getMenu()).toBeNull();
    });

    it('does not open outside the viewport', () => {
      viewportRect = { x: 0, y: 5, width: frame.width, height: 1 };
      const { fire, getMenu } = mount();
      fire(makeEvent('right-press', 2, 1));
      expect(getMenu()).toBeNull();
    });

    it('clicking a menu item launches the browser and closes the menu', () => {
      const { fire, getMenu } = mount();
      fire(makeEvent('right-press', 2, 1)); // opens the menu at grid (1,0)
      expect(getMenu()).not.toBeNull();
      // Item 0 sits at grid row position.y+1=1 → terminal row 2, col 2.
      fire(makeEvent('left-press', 2, 2));
      expect(openBrowserSecurely).toHaveBeenCalledWith(LINK_URL);
      expect(getMenu()).toBeNull();
    });

    it('hovering a menu row updates the selected index', () => {
      const { fire, getMenu } = mount();
      fire(makeEvent('right-press', 2, 1)); // grid (1,0), 2 items
      // Item 1 at grid row 2 → terminal row 3.
      fire(makeEvent('move', 2, 3));
      const menu = getMenu();
      expect(menu).not.toBeNull();
      // selectedIndex lives in the provider; assert via a click on item 1.
      fire(makeEvent('left-press', 2, 3));
      expect(copyToClipboard).toHaveBeenCalledWith(LINK_URL);
      expect(getMenu()).toBeNull();
    });

    it('scroll closes the menu', () => {
      const { fire, getMenu } = mount();
      fire(makeEvent('right-press', 2, 1));
      expect(getMenu()).not.toBeNull();
      fire(makeEvent('scroll-down', 2, 1));
      expect(getMenu()).toBeNull();
    });
  });

  describe('menu lifetime', () => {
    const mountWithProbe = () => {
      let latestMenu: ReturnType<typeof useContextMenu>['menu'] = null;
      const MenuProbe = () => {
        latestMenu = useContextMenu().menu;
        return null;
      };
      // Build fresh elements on every render: React bails out of re-rendering
      // a subtree handed the same element reference, which would hide
      // terminal-size changes from the controller.
      const tree = (withController: boolean) => (
        <ContextMenuProvider>
          {withController ? (
            <ContentMouseController
              isActive
              getViewportRect={() => viewportRect}
              hitTestScrollbar={() => false}
            />
          ) : null}
          <MenuProbe />
        </ContextMenuProvider>
      );
      const result = render(tree(true));
      const rerenderWith = (withController: boolean) =>
        result.rerender(tree(withController));
      const openMenu = () =>
        act(() => {
          const handler = vi.mocked(useMouseEvents).mock.calls.at(-1)![0];
          handler(makeEvent('right-press', 2, 1));
        });
      return { latestMenu: () => latestMenu, rerenderWith, openMenu };
    };

    it('closes the menu when the controller unmounts while it is open', () => {
      const { latestMenu, rerenderWith, openMenu } = mountWithProbe();
      openMenu();
      expect(latestMenu()).not.toBeNull();

      // A view switch unmounts MainContent (and this controller) while the
      // provider-level menu would otherwise survive.
      rerenderWith(false);
      expect(latestMenu()).toBeNull();
    });

    it('closes the menu when terminal dimensions change while it is open', () => {
      const { latestMenu, rerenderWith, openMenu } = mountWithProbe();
      openMenu();
      expect(latestMenu()).not.toBeNull();

      mocks.size = { columns: 80, rows: 12 };
      rerenderWith(true);
      expect(latestMenu()).toBeNull();
    });
  });
});

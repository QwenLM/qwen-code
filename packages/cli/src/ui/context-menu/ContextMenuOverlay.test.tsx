// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, type ReactNode } from 'react';
import { Box, Text } from 'ink';
import { waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test-utils/render.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { ContextMenuOverlay } from './ContextMenuOverlay.js';
import {
  ContextMenuProvider,
  useContextMenu,
  type ContextMenuItem,
} from './ContextMenuContext.js';

const wait = () => new Promise((resolve) => setTimeout(resolve, 20));

function makeItems(handlers: {
  open: () => void;
  copy: () => void;
}): ContextMenuItem[] {
  return [
    { id: 'open-link', label: 'Open Link', onSelect: handlers.open },
    { id: 'copy-link', label: 'Copy Link Address', onSelect: handlers.copy },
  ];
}

/** Opens a menu on mount so the overlay has something to render. */
const ORIGIN = { x: 0, y: 0 };
function MenuOpener({
  items,
  position = ORIGIN,
}: {
  items: ContextMenuItem[];
  position?: { x: number; y: number };
}) {
  const { openMenu } = useContextMenu();
  useEffect(() => {
    openMenu(items, position);
  }, [openMenu, items, position]);
  return null;
}

/**
 * Stands in for the surfaces the issue measured: a key consumer that has no
 * idea the context menu exists (composer, tool-approval dialog, tab bar).
 * Records every key it receives so tests can assert what leaked under the
 * open menu.
 */
function InnocentBystander({ onKey }: { onKey: (key: string) => void }) {
  useKeypress(
    (key) => {
      onKey(key.sequence ?? key.name);
    },
    { isActive: true },
  );
  return null;
}

// The absolute overlay needs in-flow siblings to give the root a size (the
// transcript provides this in the real layout); replicate that here.
function Scene({ children }: { children: ReactNode }) {
  return (
    <Box flexDirection="column">
      <Text>AAAAAAAAAA</Text>
      <Text>AAAAAAAAAA</Text>
      <Text>AAAAAAAAAA</Text>
      <Text>AAAAAAAAAA</Text>
      {children}
    </Box>
  );
}

describe('ContextMenuOverlay', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing while the menu is closed', () => {
    const { lastFrame } = renderWithProviders(
      <Scene>
        <ContextMenuProvider>
          <ContextMenuOverlay />
        </ContextMenuProvider>
      </Scene>,
    );
    expect(lastFrame()).not.toContain('Open Link');
    expect(lastFrame()).toContain('AAAAAAAAAA');
  });

  it('renders the menu items when open', async () => {
    const handlers = { open: vi.fn(), copy: vi.fn() };
    const { lastFrame } = renderWithProviders(
      <Scene>
        <ContextMenuProvider>
          <MenuOpener items={makeItems(handlers)} />
          <ContextMenuOverlay />
        </ContextMenuProvider>
      </Scene>,
    );
    await waitFor(() => expect(lastFrame()).toContain('Open Link'));
    expect(lastFrame()).toContain('Copy Link Address');
  });

  it('Escape closes the menu', async () => {
    const handlers = { open: vi.fn(), copy: vi.fn() };
    const { lastFrame, stdin } = renderWithProviders(
      <Scene>
        <ContextMenuProvider>
          <MenuOpener items={makeItems(handlers)} />
          <ContextMenuOverlay />
        </ContextMenuProvider>
      </Scene>,
    );
    await waitFor(() => expect(lastFrame()).toContain('Open Link'));
    stdin.write('\u001b'); // Escape
    await waitFor(() => expect(lastFrame()).not.toContain('Open Link'));
    expect(handlers.open).not.toHaveBeenCalled();
  });

  it('Enter executes the highlighted (first) item', async () => {
    const handlers = { open: vi.fn(), copy: vi.fn() };
    const { lastFrame, stdin } = renderWithProviders(
      <Scene>
        <ContextMenuProvider>
          <MenuOpener items={makeItems(handlers)} />
          <ContextMenuOverlay />
        </ContextMenuProvider>
      </Scene>,
    );
    await waitFor(() => expect(lastFrame()).toContain('Open Link'));
    stdin.write('\r'); // Enter
    await waitFor(() => expect(handlers.open).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(lastFrame()).not.toContain('Open Link'));
  });

  it('ArrowDown + Enter executes the second item', async () => {
    const handlers = { open: vi.fn(), copy: vi.fn() };
    const { lastFrame, stdin } = renderWithProviders(
      <Scene>
        <ContextMenuProvider>
          <MenuOpener items={makeItems(handlers)} />
          <ContextMenuOverlay />
        </ContextMenuProvider>
      </Scene>,
    );
    await waitFor(() => expect(lastFrame()).toContain('Open Link'));
    stdin.write('\u001b[B'); // ArrowDown
    await wait();
    stdin.write('\r'); // Enter
    await waitFor(() => expect(handlers.copy).toHaveBeenCalledTimes(1));
    expect(handlers.open).not.toHaveBeenCalled();
  });

  // #11228: while the menu is open its overlay owns the keyboard. The
  // composer, approval dialog, and tab bar must not act on the same key.
  describe('key exclusivity', () => {
    function ExclusiveScene({
      items,
      onKey,
    }: {
      items: ContextMenuItem[];
      onKey: (key: string) => void;
    }) {
      return (
        <Scene>
          <ContextMenuProvider>
            <InnocentBystander onKey={onKey} />
            <MenuOpener items={items} />
            <ContextMenuOverlay />
          </ContextMenuProvider>
        </Scene>
      );
    }

    it('an ordinary handler does not receive Enter aimed at the open menu', async () => {
      const handlers = { open: vi.fn(), copy: vi.fn() };
      const bystanderKeys: string[] = [];
      const { lastFrame, stdin } = renderWithProviders(
        <ExclusiveScene
          items={makeItems(handlers)}
          onKey={(k) => bystanderKeys.push(k)}
        />,
      );
      await waitFor(() => expect(lastFrame()).toContain('Open Link'));

      stdin.write('\r'); // Enter — executes the menu item
      await waitFor(() => expect(handlers.open).toHaveBeenCalledTimes(1));

      expect(bystanderKeys).toEqual([]);
    });

    it('an ordinary handler does not receive Escape aimed at the open menu', async () => {
      const handlers = { open: vi.fn(), copy: vi.fn() };
      const bystanderKeys: string[] = [];
      const { lastFrame, stdin } = renderWithProviders(
        <ExclusiveScene
          items={makeItems(handlers)}
          onKey={(k) => bystanderKeys.push(k)}
        />,
      );
      await waitFor(() => expect(lastFrame()).toContain('Open Link'));

      stdin.write('\u001b'); // Escape — dismisses the menu
      await waitFor(() => expect(lastFrame()).not.toContain('Open Link'));

      expect(bystanderKeys).toEqual([]);
    });

    it('a dismissing key falls through to ordinary handlers in the same keystroke', async () => {
      const handlers = { open: vi.fn(), copy: vi.fn() };
      const bystanderKeys: string[] = [];
      const { lastFrame, stdin } = renderWithProviders(
        <ExclusiveScene
          items={makeItems(handlers)}
          onKey={(k) => bystanderKeys.push(k)}
        />,
      );
      await waitFor(() => expect(lastFrame()).toContain('Open Link'));

      // A printable key the menu does not handle: dismisses the menu AND
      // still reaches the ordinary handler (typing "x" dismisses and types
      // "x"). Swallowing it would drop the keystroke entirely.
      stdin.write('x');
      await waitFor(() => expect(lastFrame()).not.toContain('Open Link'));

      expect(bystanderKeys).toContain('x');
    });

    it('Shift+Enter dismisses the menu and falls through without firing the item', async () => {
      const handlers = { open: vi.fn(), copy: vi.fn() };
      const bystanderKeys: string[] = [];
      const { lastFrame, stdin } = renderWithProviders(
        <ExclusiveScene
          items={makeItems(handlers)}
          onKey={(k) => bystanderKeys.push(k)}
        />,
      );
      await waitFor(() => expect(lastFrame()).toContain('Open Link'));

      // Shift+Enter is Command.NEWLINE in the composer, not menu-execute.
      // Kitty CSI-u form (the provider enables the protocol): modifiers 2.
      // It must dismiss the menu, reach ordinary handlers, and never run
      // the highlighted item's onSelect.
      stdin.write('\u001b[13;2u');
      await waitFor(() => expect(lastFrame()).not.toContain('Open Link'));

      expect(handlers.open).not.toHaveBeenCalled();
      expect(handlers.copy).not.toHaveBeenCalled();
      expect(bystanderKeys.length).toBeGreaterThan(0);
    });

    it('ordinary handlers receive keys again after the menu closes', async () => {
      const handlers = { open: vi.fn(), copy: vi.fn() };
      const bystanderKeys: string[] = [];
      const { lastFrame, stdin } = renderWithProviders(
        <ExclusiveScene
          items={makeItems(handlers)}
          onKey={(k) => bystanderKeys.push(k)}
        />,
      );
      await waitFor(() => expect(lastFrame()).toContain('Open Link'));

      stdin.write('\u001b'); // Escape — close the menu
      await waitFor(() => expect(lastFrame()).not.toContain('Open Link'));
      expect(bystanderKeys).toEqual([]);

      // The next keystroke must reach ordinary handlers again.
      stdin.write('y');
      await waitFor(() => expect(bystanderKeys).toContain('y'));
    });
  });

  it('renders the box at the stored position, not in-flow', async () => {
    const handlers = { open: vi.fn(), copy: vi.fn() };
    const items = [
      { id: 'a', label: 'MMM', onSelect: handlers.open },
      { id: 'b', label: 'NNN', onSelect: handlers.copy },
    ];
    const { lastFrame } = renderWithProviders(
      <Scene>
        <ContextMenuProvider>
          <MenuOpener items={items} position={{ x: 2, y: 1 }} />
          <ContextMenuOverlay />
        </ContextMenuProvider>
      </Scene>,
    );
    await waitFor(() => expect(lastFrame()).toContain('MMM'));
    const lines = lastFrame()!.split('\n');
    // The border row lands on grid row 1 and the first label on row 2,
    // both offset two columns — an in-flow render would put them after the
    // four A rows (or flush left at the origin).
    expect(lines[1]).toContain('╭');
    expect(lines[2]).toContain('MMM');
    expect(lines[0]).not.toContain('╭');
    expect(lines[0]).not.toContain('MMM');
  });
});

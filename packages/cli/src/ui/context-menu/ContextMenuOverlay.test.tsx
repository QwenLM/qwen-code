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
      // Record the decoded identity, not the raw bytes: the kitty
      // provider decodes `\u001b[13;2u` into name='return' + shift=true,
      // and the assertions care about WHICH key leaked, not its bytes.
      const parts = [key.name];
      if (key.ctrl) parts.push('ctrl');
      if (key.meta) parts.push('meta');
      if (key.shift) parts.push('shift');
      onKey(parts.join('+'));
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

/**
 * The exclusivity fixture: ordinary key consumers listening while the menu
 * is open. Two bystanders, both ordinary subscribers — production always
 * has several live at once (global handler, composer input, focus hooks),
 * so a declined key must fan out to EVERY ordinary handler, not just the
 * first: the doubled exact-array assertions below pin that the declined
 * path delivers to all subscribers and a first-only truncation reddens.
 */
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
        <InnocentBystander onKey={onKey} />
        <MenuOpener items={items} />
        <ContextMenuOverlay />
      </ContextMenuProvider>
    </Scene>
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
    const bystanderKeys: string[] = [];
    const { lastFrame, stdin } = renderWithProviders(
      <ExclusiveScene
        items={makeItems(handlers)}
        onKey={(k) => bystanderKeys.push(k)}
      />,
    );
    await waitFor(() => expect(lastFrame()).toContain('Open Link'));
    stdin.write('\u001b[B'); // ArrowDown
    await wait();
    stdin.write('\r'); // Enter
    await waitFor(() => expect(handlers.copy).toHaveBeenCalledTimes(1));
    expect(handlers.open).not.toHaveBeenCalled();
    // R1-5: the arrows and the executing Return are CONSUMED by the open
    // menu — flipping any claim branch's `return true` to `false` leaks
    // the key to ordinary subscribers (the exact collision #11228
    // describes) and turns this red.
    expect(bystanderKeys).toEqual([]);
  });

  // #11228: while the menu is open its overlay owns the keyboard. The
  // composer, approval dialog, and tab bar must not act on the same key.
  describe('key exclusivity', () => {
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

    it('an unmodified ArrowUp is consumed by the open menu', async () => {
      const handlers = { open: vi.fn(), copy: vi.fn() };
      const bystanderKeys: string[] = [];
      const { lastFrame, stdin } = renderWithProviders(
        <ExclusiveScene
          items={makeItems(handlers)}
          onKey={(k) => bystanderKeys.push(k)}
        />,
      );
      await waitFor(() => expect(lastFrame()).toContain('Open Link'));

      // Legacy unparameterized form — the only Up that decodes as a bare
      // 'up' under the kitty protocol (KeypressContext matches \u001b[A but
      // not \u001b[1A), so this reaches the unmodified up claim branch.
      stdin.write('\u001b[A');
      await wait();

      expect(bystanderKeys).toEqual([]);
    });

    it('an unmodified ArrowUp at the top row clamps and keeps the menu usable', async () => {
      // Effect witness for the up branch: from index 0, `Math.max(0, -1)`
      // is the only thing keeping selectedIndex at a real row. A no-op, an
      // unclamped decrement, or a closeMenu-instead-of-move would each
      // leave the plain consumption test above green. The leading Up from
      // the clamped floor is the ONLY press that exposes a lost clamp —
      // Down-first ordering yields 0 with or without Math.max. Separate
      // chunks with a wait between: one stdin chunk dispatches in a single
      // tick and both arrows would compute from the same stale closure
      // index (the open R3-1 follow-up), proving nothing about navigation.
      const handlers = { open: vi.fn(), copy: vi.fn() };
      const bystanderKeys: string[] = [];
      const { lastFrame, stdin } = renderWithProviders(
        <ExclusiveScene
          items={makeItems(handlers)}
          onKey={(k) => bystanderKeys.push(k)}
        />,
      );
      await waitFor(() => expect(lastFrame()).toContain('Open Link'));

      stdin.write('\u001b[A'); // Up from index 0 — clamps to 0
      await wait();
      stdin.write('\u001b[B'); // Down -> item 2
      await wait();
      stdin.write('\u001b[A'); // Up -> back to item 1, menu stays open
      await wait();
      expect(lastFrame()).toContain('Open Link');

      stdin.write('\r');
      await waitFor(() => expect(handlers.open).toHaveBeenCalledTimes(1));
      expect(handlers.copy).not.toHaveBeenCalled();
      expect(bystanderKeys).toEqual([]);
    });

    it('an unmodified ArrowDown at the last row clamps and keeps the menu usable', async () => {
      // Mirror of the up-clamp witness for the down branch's Math.min:
      // from the last row, the clamp is the only thing keeping
      // selectedIndex on a real row. Without it a second Down lands past
      // the end, Enter bounds-checks to a no-op inside executeIndex while
      // the menu still closes — the chosen action silently drops and all
      // 17 committed tests stay green. The second Down (from the last row)
      // is the only press that discriminates the clamp: one chunk holding
      // both Downs would compute both from the same stale closure index
      // (the open R3-1 follow-up) and copy would fire either way. The
      // fixture has exactly 2 rows, so the boundary is one Down past
      // index 1.
      const handlers = { open: vi.fn(), copy: vi.fn() };
      const bystanderKeys: string[] = [];
      const { lastFrame, stdin } = renderWithProviders(
        <ExclusiveScene
          items={makeItems(handlers)}
          onKey={(k) => bystanderKeys.push(k)}
        />,
      );
      await waitFor(() => expect(lastFrame()).toContain('Open Link'));

      stdin.write('\u001b[B'); // Down -> item 2 (the last row)
      await wait();
      stdin.write('\u001b[B'); // Down from the last row — clamps to 1
      await wait();
      expect(lastFrame()).toContain('Open Link');

      stdin.write('\r');
      await waitFor(() => expect(handlers.copy).toHaveBeenCalledTimes(1));
      expect(handlers.open).not.toHaveBeenCalled();
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
      // still reaches every ordinary handler (typing "x" dismisses and
      // types "x"). Swallowing it would drop the keystroke entirely;
      // first-only fan-out would deliver it to just one subscriber.
      stdin.write('x');
      await waitFor(() => expect(lastFrame()).not.toContain('Open Link'));

      expect(bystanderKeys).toEqual(['x', 'x']);
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
      // The exact key must reach BOTH bystanders: fan-out on the declined
      // path is all-subscribers, and a first-only truncation would leave
      // the second recorder empty. If kitty decoding regressed, the
      // sequence would shred into an escape plus printables instead of
      // one decoded 'return+shift' per subscriber.
      expect(bystanderKeys).toEqual(['return+shift', 'return+shift']);
    });

    // R2-4: the claim predicate has three modifier axes; pin every cell
    // of the matrix that must fall through (modified keys reach ordinary
    // handlers instead of being consumed by the menu).
    it.each([
      ['Shift+Up', '\u001b[1;2A', 'up+shift'],
      ['Shift+Down', '\u001b[1;2B', 'down+shift'],
      ['Ctrl+Enter', '\u001b[13;5u', 'return+ctrl'],
      ['Alt+Enter', '\u001b[13;3u', 'return+meta'],
    ] as const)(
      '%s dismisses the menu and falls through without moving or firing',
      async (_label, sequence, expectedBystander) => {
        const handlers = { open: vi.fn(), copy: vi.fn() };
        const bystanderKeys: string[] = [];
        const { lastFrame, stdin } = renderWithProviders(
          <ExclusiveScene
            items={makeItems(handlers)}
            onKey={(k) => bystanderKeys.push(k)}
          />,
        );
        await waitFor(() => expect(lastFrame()).toContain('Open Link'));

        stdin.write(sequence);
        await waitFor(() => expect(lastFrame()).not.toContain('Open Link'));

        expect(handlers.open).not.toHaveBeenCalled();
        expect(handlers.copy).not.toHaveBeenCalled();
        // Delivered to BOTH ordinary bystanders — first-only fan-out on
        // the declined path would leave the array at length 1.
        expect(bystanderKeys).toEqual([expectedBystander, expectedBystander]);
      },
    );

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

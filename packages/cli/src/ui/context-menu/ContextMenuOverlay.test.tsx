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
function MenuOpener({ items }: { items: ContextMenuItem[] }) {
  const { openMenu } = useContextMenu();
  useEffect(() => {
    openMenu(items, { x: 0, y: 0 });
  }, [openMenu, items]);
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
});

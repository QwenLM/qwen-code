/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { act } from 'react';
import { render } from 'ink-testing-library';
import { Box } from 'ink';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import type { Config, Extension } from '@qwen-code/qwen-code-core';
import { InstalledTab } from './InstalledTab.js';
import type { StatusMessage } from '../ExtensionsManagerDialog.js';
import { DialogSizeProvider } from '../../../contexts/DialogSizeContext.js';

const mockUseKeypress = vi.hoisted(() => vi.fn());

vi.mock('../../../hooks/useKeypress.js', () => ({
  useKeypress: mockUseKeypress,
}));

vi.mock('../../../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ rows: 24, columns: 80 }),
}));

const extension = {
  id: 'demo-id',
  name: 'demo',
  version: '1.0.0',
  path: '/extensions/demo',
  isActive: true,
  mcpServers: {},
  commands: [],
  skills: [],
  agents: [],
  resolvedSettings: [],
  config: {},
  contextFiles: [],
} as unknown as Extension;

function createManager() {
  return {
    refreshCache: vi.fn().mockResolvedValue(undefined),
    getLoadedExtensions: vi.fn(() => [extension]),
    getFavorites: vi.fn(() => []),
    getExtensionScopes: vi.fn(() => ({ demo: 'user' as const })),
    disableExtension: vi.fn().mockResolvedValue({
      warnings: [
        { code: 'extension_runtime_refresh_failed', error: 'refresh failed' },
      ],
    }),
    enableExtension: vi.fn().mockResolvedValue({ warnings: [] }),
  };
}

describe('InstalledTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('R2-1 re-anchors a selected extension when the supplied row budget shrinks', async () => {
    const manager = createManager();
    manager.getLoadedExtensions.mockReturnValue(
      Array.from({ length: 24 }, (_, index) => ({
        ...extension,
        id: `shrink-${index}`,
        name: `shrink-${String(index).padStart(2, '0')}`,
      })),
    );
    const config = {
      getExtensionManager: () => manager,
      getMcpServers: () => ({}),
      getToolRegistry: () => undefined,
    } as unknown as Config;
    const tree = (rows: number) => (
      <DialogSizeProvider value={{ columns: 70, rows }}>
        <InstalledTab
          config={config}
          isActive
          onLockChange={vi.fn()}
          onStatus={vi.fn()}
          extensionsUpdateState={new Map()}
          reloadSignal={0}
        />
      </DialogSizeProvider>
    );
    const view = render(tree(10));
    await waitFor(() => expect(view.lastFrame()).toContain('shrink-00'));
    for (let index = 0; index < 16; index++) {
      const handle = mockUseKeypress.mock.calls.findLast(
        (call) => call[1]?.isActive,
      )?.[0];
      await act(async () => handle({ name: 'down', sequence: '' }));
    }
    await waitFor(() => expect(view.lastFrame()).toMatch(/●.*shrink-16/));
    view.rerender(tree(6));
    await waitFor(() => expect(view.lastFrame()).toMatch(/●.*shrink-16/));
    expect(view.lastFrame()?.split('\n').length).toBeLessThanOrEqual(6);
    expect(manager.refreshCache).toHaveBeenCalledOnce();
    view.unmount();
  });

  it('R3-5 keeps a selected installed entry with a wide version painted', async () => {
    const manager = createManager();
    manager.getLoadedExtensions.mockReturnValue(
      Array.from({ length: 16 }, (_, index) => ({
        ...extension,
        id: `wide-${index}`,
        name: `entry-${String(index).padStart(2, '0')}`,
        version: '版本'.repeat(30),
      })),
    );
    const config = {
      getExtensionManager: () => manager,
      getMcpServers: () => ({}),
      getToolRegistry: () => undefined,
    } as unknown as Config;
    const view = render(
      <DialogSizeProvider value={{ columns: 40, rows: 10 }}>
        <Box width={40} maxHeight={10} overflow="hidden" flexDirection="column">
          <InstalledTab
            config={config}
            isActive
            onLockChange={vi.fn()}
            onStatus={vi.fn()}
            extensionsUpdateState={new Map()}
            reloadSignal={0}
          />
        </Box>
      </DialogSizeProvider>,
    );
    await waitFor(() => expect(manager.refreshCache).toHaveBeenCalledOnce());
    await waitFor(() => expect(view.lastFrame()).toContain('Extension v'));
    expect(view.lastFrame()?.split('\n')[0]).toBe('User level (16)');
    for (let index = 0; index < 9; index++) {
      const handle = mockUseKeypress.mock.calls.findLast(
        (call) => call[1]?.isActive,
      )?.[0];
      await act(async () => handle({ name: 'down', sequence: '' }));
    }
    await waitFor(() => expect(view.lastFrame()).toMatch(/●.*entr/));
    expect(view.lastFrame()?.split('\n').length).toBeLessThanOrEqual(10);
    view.unmount();
  });

  it.each([3, 11])(
    'PR17541 R1-2 keeps arrow-key selection visible with %i dialog rows',
    async (rows) => {
      const manager = createManager();
      manager.getLoadedExtensions.mockReturnValue([
        extension,
        ...Array.from({ length: 23 }, (_, index) => ({
          ...extension,
          id: `sizing-${index}`,
          name: `sizing-${String(index + 1).padStart(2, '0')}`,
        })),
      ]);
      const config = {
        getExtensionManager: () => manager,
        getMcpServers: () => ({}),
        getToolRegistry: () => undefined,
      } as unknown as Config;
      const { lastFrame } = render(
        <DialogSizeProvider value={{ columns: 60, rows }}>
          <InstalledTab
            config={config}
            isActive
            onLockChange={vi.fn()}
            onStatus={vi.fn()}
            extensionsUpdateState={new Map()}
            reloadSignal={0}
          />
        </DialogSizeProvider>,
      );
      await waitFor(() => expect(manager.refreshCache).toHaveBeenCalledOnce());
      await waitFor(() => expect(lastFrame()).toContain('demo'));
      expect(lastFrame()?.split('\n').length).toBeLessThanOrEqual(rows);
      const navigate = async (name: string) => {
        const handler = mockUseKeypress.mock.calls
          .filter((call) => call[1]?.isActive === true)
          .at(-1)?.[0] as (key: { name: string; sequence: string }) => void;
        await act(async () => handler({ name, sequence: '' }));
      };
      await navigate('down');
      await waitFor(() => expect(lastFrame()).toMatch(/●.*sizing-01/));
      expect(lastFrame()?.split('\n').length).toBeLessThanOrEqual(rows);
      await navigate('up');
      await waitFor(() => expect(lastFrame()).toMatch(/●.*demo/));
    },
  );

  it('surfaces activation warnings and reloads the installed list', async () => {
    const manager = createManager();
    const config = {
      getExtensionManager: () => manager,
      getMcpServers: () => ({}),
      getToolRegistry: () => undefined,
    } as unknown as Config;
    const statuses: Array<StatusMessage | null> = [];

    const { lastFrame } = render(
      <InstalledTab
        config={config}
        isActive
        onLockChange={vi.fn()}
        onStatus={(status) => statuses.push(status)}
        extensionsUpdateState={new Map()}
        reloadSignal={0}
      />,
    );

    await waitFor(() => expect(manager.refreshCache).toHaveBeenCalledOnce());
    // refreshCache fires at the start of load(), before items are set; wait for
    // the loaded row to render so the handler grabbed below closes over
    // populated items instead of the initial empty-items render (flaky under
    // parallel load).
    await waitFor(() => expect(lastFrame()).toContain('demo'));
    const listHandler = mockUseKeypress.mock.calls
      .filter((call) => call[1]?.isActive === true)
      .at(-1)?.[0] as
      | ((key: { name: string; sequence: string }) => void)
      | undefined;

    await act(async () => {
      listHandler?.({ name: 'space', sequence: ' ' });
    });

    await waitFor(() =>
      expect(manager.disableExtension).toHaveBeenCalledOnce(),
    );
    await waitFor(() => expect(manager.refreshCache).toHaveBeenCalledTimes(2));
    expect(statuses).toContainEqual({
      type: 'warning',
      text: '"demo" changed with warnings: refresh failed',
    });
  });
});

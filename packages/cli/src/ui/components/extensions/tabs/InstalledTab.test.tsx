/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import type { Config, Extension } from '@qwen-code/qwen-code-core';
import { InstalledTab } from './InstalledTab.js';
import type { StatusMessage } from '../ExtensionsManagerDialog.js';

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

  it('surfaces activation warnings and reloads the installed list', async () => {
    const manager = createManager();
    const config = {
      getExtensionManager: () => manager,
      getMcpServers: () => ({}),
      getToolRegistry: () => undefined,
    } as unknown as Config;
    const statuses: Array<StatusMessage | null> = [];

    render(
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

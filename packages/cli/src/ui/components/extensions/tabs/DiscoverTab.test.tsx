/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import type { Config, DiscoveredPlugin } from '@qwen-code/qwen-code-core';
import type { Key } from '../../../hooks/useKeypress.js';
import { DiscoverTab } from './DiscoverTab.js';

const mockUseKeypress = vi.hoisted(() => vi.fn());
const mockRadioButtonSelect = vi.hoisted(() =>
  vi.fn((_props: unknown) => null),
);
const mockParseInstallSource = vi.hoisted(() =>
  vi.fn(async (source: string) => ({ type: 'git' as const, source })),
);

vi.mock('../../../hooks/useKeypress.js', () => ({
  useKeypress: mockUseKeypress,
}));

vi.mock('../../../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 100, rows: 40 }),
}));

vi.mock('../../shared/RadioButtonSelect.js', () => ({
  RadioButtonSelect: mockRadioButtonSelect,
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return { ...actual, parseInstallSource: mockParseInstallSource };
});

interface SelectProps<T> {
  onSelect: (value: T) => void;
}

function activeKeypress(): (key: Key) => void {
  const call = mockUseKeypress.mock.calls.findLast(
    (args) => (args[1] as { isActive: boolean }).isActive,
  );
  return call?.[0] as (key: Key) => void;
}

describe('DiscoverTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('installs the selected extension with workspace activation', async () => {
    const plugin = {
      name: 'demo',
      marketplaceName: 'market',
      installSource: 'owner/demo',
      installed: false,
    } as DiscoveredPlugin;
    const manager = {
      discoverPlugins: vi.fn().mockResolvedValue([plugin]),
      installExtension: vi.fn().mockResolvedValue({ name: 'demo' }),
      setExtensionScope: vi.fn(),
    };
    const config = {
      getExtensionManager: () => manager,
    } as unknown as Config;
    const onInstalled = vi.fn();

    render(
      <DiscoverTab
        config={config}
        isActive
        onLockChange={vi.fn()}
        onStatus={vi.fn()}
        onInstalled={onInstalled}
        reloadSignal={0}
      />,
    );
    await waitFor(() => expect(manager.discoverPlugins).toHaveBeenCalled());

    await act(async () => {
      activeKeypress()({ name: 'return' } as Key);
    });
    const detailSelect = mockRadioButtonSelect.mock.calls.at(-1)?.[0] as
      | SelectProps<'project'>
      | undefined;
    await act(async () => {
      detailSelect?.onSelect('project');
    });

    await waitFor(() => expect(manager.installExtension).toHaveBeenCalled());
    expect(manager.installExtension).toHaveBeenCalledWith(
      { type: 'git', source: 'owner/demo' },
      undefined,
      undefined,
      process.cwd(),
      undefined,
      { scope: 'workspace', workspacePath: process.cwd() },
    );
    expect(manager.setExtensionScope).toHaveBeenCalledWith('demo', 'project');
    expect(onInstalled).toHaveBeenCalledOnce();
  });

  it('surfaces a warning when saving scope preference fails after install', async () => {
    const plugin = {
      name: 'demo',
      marketplaceName: 'market',
      installSource: 'owner/demo',
      installed: false,
    } as DiscoveredPlugin;
    const manager = {
      discoverPlugins: vi.fn().mockResolvedValue([plugin]),
      installExtension: vi.fn().mockResolvedValue({ name: 'demo' }),
      setExtensionScope: vi.fn(() => {
        throw new Error('preference denied');
      }),
    };
    const onStatus = vi.fn();
    render(
      <DiscoverTab
        config={{ getExtensionManager: () => manager } as unknown as Config}
        isActive
        onLockChange={vi.fn()}
        onStatus={onStatus}
        onInstalled={vi.fn()}
        reloadSignal={0}
      />,
    );
    await waitFor(() => expect(manager.discoverPlugins).toHaveBeenCalled());
    await act(async () => {
      activeKeypress()({ name: 'return' } as Key);
    });
    const detailSelect = mockRadioButtonSelect.mock.calls.at(-1)?.[0] as
      | SelectProps<'project'>
      | undefined;

    await act(async () => {
      detailSelect?.onSelect('project');
    });

    await waitFor(() =>
      expect(onStatus).toHaveBeenCalledWith({
        type: 'warning',
        text: 'Installed 1 extension(s) with warnings: demo: preference denied',
      }),
    );
  });
});

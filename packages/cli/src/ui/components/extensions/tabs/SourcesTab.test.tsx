/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import type { Config } from '@qwen-code/qwen-code-core';
import type { Key } from '../../../hooks/useKeypress.js';
import type { StatusMessage } from '../ExtensionsManagerDialog.js';
import { SourcesTab } from './SourcesTab.js';

const mockUseKeypress = vi.hoisted(() => vi.fn());
const mockTextInput = vi.hoisted(() => vi.fn((_props: unknown) => null));
const mockParseInstallSource = vi.hoisted(() =>
  vi.fn(async (source: string) => ({ type: 'git' as const, source })),
);

vi.mock('../../../hooks/useKeypress.js', () => ({
  useKeypress: mockUseKeypress,
}));

vi.mock('../../shared/TextInput.js', () => ({ TextInput: mockTextInput }));

vi.mock('../../shared/RadioButtonSelect.js', () => ({
  RadioButtonSelect: vi.fn((_props: unknown) => null),
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return { ...actual, parseInstallSource: mockParseInstallSource };
});

interface TextInputProps {
  onChange: (value: string) => void;
  onSubmit: () => void;
}

function activeKeypress(): (key: Key) => void {
  const call = mockUseKeypress.mock.calls.findLast(
    (args) => (args[1] as { isActive: boolean }).isActive,
  );
  return call?.[0] as (key: Key) => void;
}

function committedWarning(): Error {
  return Object.assign(new Error('committed with warnings'), {
    code: 'extension_committed_with_warnings',
    committed: true,
    identity: { id: 'demo-id', name: 'demo' },
    warnings: [
      { code: 'extension_runtime_refresh_failed', error: 'refresh failed' },
    ],
  });
}

describe('SourcesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports a committed install warning without treating it as failure', async () => {
    const manager = {
      refreshCache: vi.fn().mockResolvedValue(undefined),
      getLoadedExtensions: vi.fn(() => []),
      getSources: vi.fn(() => []),
      installExtension: vi.fn().mockRejectedValue(committedWarning()),
    };
    const config = {
      getExtensionManager: () => manager,
    } as unknown as Config;
    const statuses: Array<StatusMessage | null> = [];
    const onChanged = vi.fn();

    render(
      <SourcesTab
        config={config}
        isActive
        onLockChange={vi.fn()}
        onStatus={(status) => statuses.push(status)}
        onChanged={onChanged}
        onBrowse={vi.fn()}
        onFooter={vi.fn()}
        reloadSignal={0}
      />,
    );
    await waitFor(() => expect(manager.refreshCache).toHaveBeenCalled());

    await act(async () => {
      activeKeypress()({ name: 'return' } as Key);
    });
    let input = mockTextInput.mock.calls.at(-1)?.[0] as
      | TextInputProps
      | undefined;
    await act(async () => {
      input?.onChange('owner/demo');
    });
    input = mockTextInput.mock.calls.at(-1)?.[0] as TextInputProps | undefined;
    await act(async () => {
      input?.onSubmit();
    });

    await waitFor(() =>
      expect(statuses).toContainEqual({
        type: 'info',
        text: 'committed with warnings',
      }),
    );
    expect(manager.installExtension).toHaveBeenCalledWith({
      type: 'git',
      source: 'owner/demo',
    });
    expect(onChanged).toHaveBeenCalledOnce();
    expect(manager.refreshCache).toHaveBeenCalledTimes(2);
  });
});

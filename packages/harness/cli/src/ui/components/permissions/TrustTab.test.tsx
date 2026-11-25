/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../../../test-utils/render.js';
import { SettingScope } from '../../../config/settings.js';

const mocks = vi.hoisted(() => ({
  updateValue: vi.fn(),
  addDirectory: vi.fn(),
  radioProps: undefined as
    | { onSelect: (value: string) => void }
    | undefined,
  addProps: undefined as
    | {
        onSubmit: (path: string, choice: 'memory' | 'persist') => void;
      }
    | undefined,
  removeProps: undefined as
    | { onConfirm: () => void }
    | undefined,
}));

vi.mock('../../contexts/SettingsContext.js', () => ({
  useSettingsStore: () => ({
    settings: {
      local: {
        settings: {
          permissions: { additionalDirectories: ['/persisted'] },
        },
      },
    },
  }),
  useSettings: () => ({
    local: { readOnly: false },
    updateValue: mocks.updateValue,
  }),
}));

vi.mock('../../contexts/ConfigContext.js', () => ({
  useConfig: () => ({
    getWorkspaceContext: () => ({ addDirectory: mocks.addDirectory }),
  }),
}));

vi.mock('../shared/RadioButtonSelect.js', () => ({
  RadioButtonSelect: (props: { onSelect: (value: string) => void }) => {
    mocks.radioProps = props;
    return null;
  },
}));

vi.mock('../../contexts/ActionHandlerRegistry.js', () => ({
  useRegisterFallbackHandler: vi.fn(),
}));

vi.mock('./AddWorkspaceDirectory.js', () => ({
  AddWorkspaceDirectory: (props: {
    onSubmit: (path: string, choice: 'memory' | 'persist') => void;
  }) => {
    mocks.addProps = props;
    return null;
  },
}));

vi.mock('./RemoveWorkspaceDirectory.js', () => ({
  RemoveWorkspaceDirectory: (props: { onConfirm: () => void }) => {
    mocks.removeProps = props;
    return null;
  },
}));

import { TrustTab } from './TrustTab.js';

describe('TrustTab persistence ordering', () => {
  const applyUpdates = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.radioProps = undefined;
    mocks.addProps = undefined;
    mocks.removeProps = undefined;
    mocks.updateValue.mockReturnValue(true);
  });

  async function renderTab() {
    return render(
      <TrustTab
        trustedDirectories={['/persisted']}
        applyUpdates={applyUpdates}
        onClose={vi.fn()}
      />,
    );
  }

  it('does not update the live permission state when a persisted add fails', async () => {
    mocks.updateValue.mockReturnValue(false);
    const view = await renderTab();

    act(() => mocks.radioProps?.onSelect('__add-workspace-directory__'));
    act(() => mocks.addProps?.onSubmit('/new', 'persist'));

    expect(mocks.updateValue).toHaveBeenCalledWith(
      SettingScope.Local,
      'permissions.additionalDirectories',
      expect.any(Function),
    );
    expect(mocks.addDirectory).not.toHaveBeenCalled();
    expect(applyUpdates).not.toHaveBeenCalled();
    view.unmount();
  });

  it('does not update the live permission state when a persisted delete fails', async () => {
    mocks.updateValue.mockReturnValue(false);
    const view = await renderTab();

    act(() => mocks.radioProps?.onSelect('/persisted'));
    act(() => mocks.removeProps?.onConfirm());

    expect(mocks.updateValue).toHaveBeenCalledWith(
      SettingScope.Local,
      'permissions.additionalDirectories',
      expect.any(Function),
    );
    expect(applyUpdates).not.toHaveBeenCalled();
    view.unmount();
  });
});

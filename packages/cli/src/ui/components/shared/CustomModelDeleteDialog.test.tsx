/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/core';
import { renderWithProviders } from '../../../test-utils/render.js';
import { waitFor } from '../../../test-utils/async.js';
import { BaseTabDialog } from './BaseTabDialog.js';
import { CustomModelDeleteDialog } from './CustomModelDeleteDialog.js';
const calls = vi.hoisted(() => ({
  remove: vi.fn().mockResolvedValue(undefined),
  block: vi.fn<() => 'shared' | 'source' | undefined>(() => undefined),
}));
vi.mock('../../utils/localCustomModels.js', () => ({
  deleteLocalProviderFromTui: calls.remove,
  getLocalProviderDeletionBlock: calls.block,
}));
const config = {
  getCustomProviderRegistry: () => ({
    getPublicProviders: () => [
      {
        providerId: 'gateway',
        models: [{ key: 'gateway/a' }, { key: 'gateway/b' }],
      },
    ],
  }),
} as unknown as Config;
describe('CustomModelDeleteDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.block.mockReturnValue(undefined);
  });
  it.each(['cancel', 'confirm', 'current', 'shared', 'source'])(
    'handles %s without silently deleting shared models',
    async (action) => {
      if (action === 'shared' || action === 'source')
        calls.block.mockReturnValue(action);
      const onClose = vi.fn();
      const onDeleted = vi.fn();
      const onDeleteLegacy = vi.fn();
      const result = await renderWithProviders(
        <BaseTabDialog isActive={false}>
          <CustomModelDeleteDialog
            config={config}
            modelKey="gateway/a"
            isLocalProvider={true}
            name="Endpoint model"
            currentModel={action === 'current' ? 'gateway/b' : 'auto'}
            onClose={onClose}
            onDeleted={onDeleted}
            onDeleteLegacy={onDeleteLegacy}
          />
        </BaseTabDialog>,
      );
      await result.waitUntilReady();
      if (action === 'shared')
        expect(result.lastFrame()).toContain('multiple models');
      if (action === 'source')
        expect(result.lastFrame()).toContain('source settings');
      const press = async (key: string) => {
        await act(async () => {
          result.stdin.write(key);
        });
        await result.waitUntilReady();
      };
      if (action !== 'cancel') await press('\u001b[B');
      await press('\r');
      if (action === 'confirm') {
        await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
        expect(calls.remove).toHaveBeenCalledWith(config, 'gateway/a');
      } else {
        expect(calls.remove).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledOnce();
      }
      expect(onDeleteLegacy).not.toHaveBeenCalled();
      result.unmount();
    },
  );
});

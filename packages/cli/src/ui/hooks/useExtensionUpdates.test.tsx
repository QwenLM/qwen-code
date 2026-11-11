/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '../../test-utils/render.js';
import type { ConfirmationRequest } from '../types.js';
import { useConfirmUpdateRequests } from './useExtensionUpdates.js';

describe('useConfirmUpdateRequests', () => {
  it('queues complete confirmation requests and removes the active request', async () => {
    const first: ConfirmationRequest = {
      prompt: 'Use recommended settings?',
      confirmLabel: 'Yes, use recommended settings',
      cancelLabel: 'No, maybe later',
      hideTitle: true,
      onConfirm: vi.fn(),
    };
    const second: ConfirmationRequest = {
      prompt: 'Second request',
      onConfirm: vi.fn(),
    };
    const { result, waitUntilReady, unmount } = await renderHook(() =>
      useConfirmUpdateRequests(),
    );

    await act(async () => {
      result.current.addConfirmUpdateExtensionRequest(first);
      result.current.addConfirmUpdateExtensionRequest(second);
    });
    await waitUntilReady();

    expect(result.current.confirmUpdateExtensionRequests).toEqual([
      first,
      second,
    ]);

    await act(async () => {
      result.current.addConfirmUpdateExtensionRequest(null);
    });
    await waitUntilReady();

    expect(result.current.confirmUpdateExtensionRequests).toEqual([second]);
    unmount();
  });

  it('stays empty when closing an empty queue', async () => {
    const { result, waitUntilReady, unmount } = await renderHook(() =>
      useConfirmUpdateRequests(),
    );

    await act(async () => {
      result.current.addConfirmUpdateExtensionRequest(null);
    });
    await waitUntilReady();

    expect(result.current.confirmUpdateExtensionRequests).toEqual([]);
    unmount();
  });
});

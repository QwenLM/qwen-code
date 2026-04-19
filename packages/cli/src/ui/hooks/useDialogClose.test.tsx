/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useDialogClose } from './useDialogClose.js';
import type { DialogCloseOptions } from './useDialogClose.js';

function createOptions(
  overrides: Partial<DialogCloseOptions> = {},
): DialogCloseOptions {
  return {
    isThemeDialogOpen: false,
    handleThemeSelect: vi.fn() as DialogCloseOptions['handleThemeSelect'],
    isApprovalModeDialogOpen: false,
    handleApprovalModeSelect:
      vi.fn() as DialogCloseOptions['handleApprovalModeSelect'],
    isAuthDialogOpen: false,
    handleAuthSelect: vi.fn(
      async () => undefined,
    ) as DialogCloseOptions['handleAuthSelect'],
    pendingAuthType: undefined,
    isEditorDialogOpen: false,
    exitEditorDialog: vi.fn(),
    isSettingsDialogOpen: false,
    closeSettingsDialog: vi.fn(),
    isMemoryDialogOpen: false,
    closeMemoryDialog: vi.fn(),
    isRewindDialogOpen: false,
    isRewindConfirmationOpen: false,
    closeRewindDialog: vi.fn(),
    closeRewindConfirmation: vi.fn(),
    activeArenaDialog: null,
    closeArenaDialog: vi.fn(),
    isFolderTrustDialogOpen: false,
    showWelcomeBackDialog: false,
    handleWelcomeBackClose: vi.fn(),
    ...overrides,
  };
}

describe('useDialogClose', () => {
  it('closes the rewind confirmation before the rewind picker', () => {
    const closeRewindDialog = vi.fn();
    const closeRewindConfirmation = vi.fn();

    const { result } = renderHook(() =>
      useDialogClose(
        createOptions({
          isRewindDialogOpen: true,
          isRewindConfirmationOpen: true,
          closeRewindDialog,
          closeRewindConfirmation,
        }),
      ),
    );

    expect(result.current.closeAnyOpenDialog()).toBe(true);
    expect(closeRewindConfirmation).toHaveBeenCalledTimes(1);
    expect(closeRewindDialog).not.toHaveBeenCalled();
  });

  it('closes the rewind picker through the global dialog close path', () => {
    const closeRewindDialog = vi.fn();

    const { result } = renderHook(() =>
      useDialogClose(
        createOptions({
          isRewindDialogOpen: true,
          closeRewindDialog,
        }),
      ),
    );

    expect(result.current.closeAnyOpenDialog()).toBe(true);
    expect(closeRewindDialog).toHaveBeenCalledTimes(1);
  });
});

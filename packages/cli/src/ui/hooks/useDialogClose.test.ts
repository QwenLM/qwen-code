/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useDialogClose, type DialogCloseOptions } from './useDialogClose.js';

describe('useDialogClose', () => {
  it('Ctrl+C on the skill-review dialog defers it (dismiss, not plain close)', () => {
    const dismiss = vi.fn();
    const { result } = renderHook(() =>
      useDialogClose({
        // arena guard uses `!== null`, so it must be explicitly null.
        activeArenaDialog: null,
        isSkillReviewDialogOpen: true,
        dismissSkillReviewDialog: dismiss,
      } as unknown as DialogCloseOptions),
    );
    const handled = result.current.closeAnyOpenDialog();
    expect(handled).toBe(true);
    // Must route through dismiss so the batch is recorded as dismissed and the
    // idle effect doesn't immediately reopen it.
    expect(dismiss).toHaveBeenCalledTimes(1);
  });
});

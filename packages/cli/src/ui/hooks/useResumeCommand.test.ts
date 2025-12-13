/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { useResumeCommand } from './useResumeCommand.js';

describe('useResumeCommand', () => {
  it('should initialize with dialog closed', () => {
    const { result } = renderHook(() => useResumeCommand());

    expect(result.current.isResumeDialogOpen).toBe(false);
  });

  it('should open the dialog when openResumeDialog is called', () => {
    const { result } = renderHook(() => useResumeCommand());

    act(() => {
      result.current.openResumeDialog();
    });

    expect(result.current.isResumeDialogOpen).toBe(true);
  });

  it('should close the dialog when closeResumeDialog is called', () => {
    const { result } = renderHook(() => useResumeCommand());

    // Open the dialog first
    act(() => {
      result.current.openResumeDialog();
    });

    expect(result.current.isResumeDialogOpen).toBe(true);

    // Close the dialog
    act(() => {
      result.current.closeResumeDialog();
    });

    expect(result.current.isResumeDialogOpen).toBe(false);
  });

  it('should maintain stable function references across renders', () => {
    const { result, rerender } = renderHook(() => useResumeCommand());

    const initialOpenFn = result.current.openResumeDialog;
    const initialCloseFn = result.current.closeResumeDialog;

    rerender();

    expect(result.current.openResumeDialog).toBe(initialOpenFn);
    expect(result.current.closeResumeDialog).toBe(initialCloseFn);
  });
});

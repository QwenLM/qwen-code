/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useManageModelsCommand } from './useManageModelsCommand.js';

describe('useManageModelsCommand', () => {
  it('should initialize with the dialog closed', () => {
    const { result } = renderHook(() => useManageModelsCommand());
    expect(result.current.isManageModelsDialogOpen).toBe(false);
  });

  it('should open the dialog when openManageModelsDialog is called', () => {
    const { result } = renderHook(() => useManageModelsCommand());

    act(() => {
      result.current.openManageModelsDialog();
    });

    expect(result.current.isManageModelsDialogOpen).toBe(true);
  });

  it('should close the dialog when closeManageModelsDialog is called', () => {
    const { result } = renderHook(() => useManageModelsCommand());

    act(() => {
      result.current.openManageModelsDialog();
    });
    expect(result.current.isManageModelsDialogOpen).toBe(true);

    act(() => {
      result.current.closeManageModelsDialog();
    });
    expect(result.current.isManageModelsDialogOpen).toBe(false);
  });
});

// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { STATUS_LINE_COMPOSER_ROWS } from '../status-line-model.js';
import { useStatusLinePreviewHeight } from './use-status-line-preview-height.js';

describe('status line composer reservation', () => {
  it('tracks chrome separately from the dialog and keeps the minimum floor', () => {
    const { result } = renderHook(() => useStatusLinePreviewHeight(true));
    act(() => result.current.measure(25, 12));
    expect(result.current.reservedRows).toBe(13);
    act(() => result.current.measure(13, 13));
    expect(result.current.reservedRows).toBe(STATUS_LINE_COMPOSER_ROWS);
    act(() => result.current.measure(16, 0));
    expect(result.current.reservedRows).toBe(16);
  });
  it('ignores measurements while inactive and reserves no rows', () => {
    const { result, rerender } = renderHook(
      ({ active }) => useStatusLinePreviewHeight(active),
      { initialProps: { active: true } },
    );
    act(() => result.current.measure(25, 12));
    rerender({ active: false });
    act(() => result.current.measure(100, 0));
    expect(result.current.reservedRows).toBe(0);
    rerender({ active: true });
    expect(result.current.reservedRows).toBe(13);
  });
});

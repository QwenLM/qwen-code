/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { KeypressProvider } from '../contexts/KeypressContext.js';
import { useSessionPicker } from './useSessionPicker.js';

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <KeypressProvider kittyProtocolEnabled={false}>{children}</KeypressProvider>
);

describe('useSessionPicker invariants', () => {
  it('throws when enableMultiSelect is on without onConfirmMulti', () => {
    // Without onConfirmMulti the Enter handler skips the multi-select
    // branch and silently falls through to single-select on the cursor
    // row — Space still toggles checkboxes and the footer reads
    // "N selected", so the user thinks N items will be deleted but only
    // one is. Refuse the misconfiguration loudly.
    const renderFn = () =>
      renderHook(
        () =>
          useSessionPicker({
            sessionService: null,
            onSelect: vi.fn(),
            onCancel: vi.fn(),
            maxVisibleItems: 5,
            enableMultiSelect: true,
            initialSessions: [],
          }),
        { wrapper },
      );

    expect(renderFn).toThrow(/onConfirmMulti/);
  });

  it('throws when enableMultiSelect and enablePreview both bind Space', () => {
    const renderFn = () =>
      renderHook(
        () =>
          useSessionPicker({
            sessionService: null,
            onSelect: vi.fn(),
            onCancel: vi.fn(),
            maxVisibleItems: 5,
            enableMultiSelect: true,
            enablePreview: true,
            onConfirmMulti: vi.fn(),
            initialSessions: [],
          }),
        { wrapper },
      );

    expect(renderFn).toThrow(/both bind Space/);
  });
});

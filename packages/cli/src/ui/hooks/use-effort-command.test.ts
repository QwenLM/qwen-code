/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { useEffortCommand } from './use-effort-command.js';

describe('useEffortCommand', () => {
  let setReasoningEffort: ReturnType<typeof vi.fn>;
  let setValue: ReturnType<typeof vi.fn>;
  let config: Config;
  let settings: LoadedSettings;

  beforeEach(() => {
    setReasoningEffort = vi.fn();
    setValue = vi.fn();
    config = { setReasoningEffort } as unknown as Config;
    settings = {
      setValue,
      isTrusted: true,
      user: { settings: {} },
      workspace: { settings: {} },
    } as unknown as LoadedSettings;
  });

  it('opens and closes the dialog', () => {
    const { result } = renderHook(() => useEffortCommand(settings, config));
    expect(result.current.isEffortDialogOpen).toBe(false);

    act(() => result.current.openEffortDialog());
    expect(result.current.isEffortDialogOpen).toBe(true);
  });

  it('applies and persists the selected tier, then closes', () => {
    const { result } = renderHook(() => useEffortCommand(settings, config));
    act(() => result.current.openEffortDialog());

    act(() => result.current.handleEffortSelect('xhigh'));

    expect(setReasoningEffort).toHaveBeenCalledWith('xhigh');
    expect(setValue).toHaveBeenCalledWith(
      expect.anything(),
      'model.reasoningEffort',
      'xhigh',
    );
    expect(result.current.isEffortDialogOpen).toBe(false);
  });

  it('cancels without mutating config or settings on undefined', () => {
    const { result } = renderHook(() => useEffortCommand(settings, config));
    act(() => result.current.openEffortDialog());

    act(() => result.current.handleEffortSelect(undefined));

    expect(setReasoningEffort).not.toHaveBeenCalled();
    expect(setValue).not.toHaveBeenCalled();
    expect(result.current.isEffortDialogOpen).toBe(false);
  });
});

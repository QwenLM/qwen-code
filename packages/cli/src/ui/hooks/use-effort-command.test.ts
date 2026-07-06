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

  it('confirms the requested tier in-chat on success', () => {
    const addItem = vi.fn();
    config = {
      setReasoningEffort,
      getReasoningEffort: vi.fn().mockReturnValue('xhigh'),
    } as unknown as Config;
    const { result } = renderHook(() =>
      useEffortCommand(settings, config, addItem),
    );

    act(() => result.current.handleEffortSelect('xhigh'));

    expect(addItem).toHaveBeenCalledTimes(1);
    const [item] = addItem.mock.calls[0];
    expect(item.type).toBe('info');
    expect(item.text).toContain('xhigh');
    expect(item.text).toContain('requested');
  });

  it('warns in-chat when thinking is disabled (tier did not take effect)', () => {
    const addItem = vi.fn();
    config = {
      setReasoningEffort,
      // Thinking disabled: setReasoningEffort is a no-op, so the read-back
      // returns something other than the requested tier.
      getReasoningEffort: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;
    const { result } = renderHook(() =>
      useEffortCommand(settings, config, addItem),
    );

    act(() => result.current.handleEffortSelect('high'));

    expect(addItem).toHaveBeenCalledTimes(1);
    const [item] = addItem.mock.calls[0];
    expect(item.type).toBe('info');
    expect(item.text).toContain('thinking is currently disabled');
  });
});

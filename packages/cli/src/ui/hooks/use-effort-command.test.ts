/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Config } from '@qwen-code/qwen-code-core';
import { SettingScope } from '../../config/settings.js';
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
    config = {
      getModel: vi.fn().mockReturnValue('unregistered-model'),
      setReasoningEffort,
    } as unknown as Config;
    settings = {
      setValue,
      isTrusted: true,
      user: { settings: {} },
      workspace: { settings: {} },
      merged: {},
      forScope: vi.fn().mockReturnValue({ settings: {} }),
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
      getModel: vi.fn().mockReturnValue('unregistered-model'),
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
      getModel: vi.fn().mockReturnValue('unregistered-model'),
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

  it('normalizes an unsupported tier for a registered model and persists reasoningPreferences', () => {
    const addItem = vi.fn();
    config = {
      getModel: vi.fn().mockReturnValue('qwen3.8-max'),
      setReasoningEffort,
      getReasoningEffort: vi.fn().mockReturnValue('xhigh'),
    } as unknown as Config;
    const { result } = renderHook(() =>
      useEffortCommand(settings, config, addItem),
    );

    act(() => result.current.handleEffortSelect('high'));

    expect(setReasoningEffort).toHaveBeenCalledWith('xhigh');
    expect(setValue).toHaveBeenCalledWith(
      expect.anything(),
      'model.reasoningPreferences',
      expect.objectContaining({
        'qwen3.8-max': { effort: 'xhigh' },
      }),
    );
    expect(setValue).not.toHaveBeenCalledWith(
      expect.anything(),
      'model.reasoningEffort',
      expect.anything(),
    );
    expect(addItem).toHaveBeenCalledTimes(1);
    const [item] = addItem.mock.calls[0];
    expect(item.type).toBe('info');
    expect(item.text).toContain('xhigh');
    expect(item.text).toContain('normalized from high');
  });

  it('does not apply registry tiers to an active runtime snapshot', () => {
    config = {
      getModel: vi.fn().mockReturnValue('qwen3.8-max'),
      getActiveRuntimeModelSnapshot: vi
        .fn()
        .mockReturnValue({ id: '$runtime|openai|qwen3.8-max' }),
      setReasoningEffort,
      getReasoningEffort: vi.fn().mockReturnValue('high'),
    } as unknown as Config;
    const { result } = renderHook(() => useEffortCommand(settings, config));

    act(() => result.current.handleEffortSelect('high'));

    expect(setReasoningEffort).toHaveBeenCalledWith('high');
    expect(setValue).toHaveBeenCalledWith(
      expect.anything(),
      'model.reasoningEffort',
      'high',
    );
    expect(setValue).not.toHaveBeenCalledWith(
      expect.anything(),
      'model.reasoningPreferences',
      expect.anything(),
    );
  });

  it('persists registered-model preferences to the scope owning the model key', () => {
    config = {
      getModel: vi.fn().mockReturnValue('qwen3.8-max'),
      setReasoningEffort,
      getReasoningEffort: vi.fn().mockReturnValue('medium'),
    } as unknown as Config;
    // Workspace owns `model` (reasoningPreferences) but no `modelProviders`;
    // the modelProviders fallback would write to the user scope and be
    // shadowed.
    const workspaceSettings = { model: { reasoningPreferences: {} } };
    const scopedSettings = {
      setValue,
      isTrusted: true,
      user: { settings: {} },
      workspace: { settings: workspaceSettings },
      merged: {},
      forScope: vi.fn((scope: SettingScope) => ({
        settings: scope === SettingScope.Workspace ? workspaceSettings : {},
      })),
    } as unknown as LoadedSettings;
    const { result } = renderHook(() =>
      useEffortCommand(scopedSettings, config),
    );

    act(() => result.current.handleEffortSelect('medium'));

    expect(setValue).toHaveBeenCalledWith(
      SettingScope.Workspace,
      'model.reasoningPreferences',
      expect.objectContaining({ 'qwen3.8-max': { effort: 'medium' } }),
    );
  });

  it('keeps a supported tier for a registered model and reports it as requested', () => {
    const addItem = vi.fn();
    config = {
      getModel: vi.fn().mockReturnValue('qwen3.8-max'),
      setReasoningEffort,
      getReasoningEffort: vi.fn().mockReturnValue('low'),
    } as unknown as Config;
    const { result } = renderHook(() =>
      useEffortCommand(settings, config, addItem),
    );

    act(() => result.current.handleEffortSelect('low'));

    expect(setReasoningEffort).toHaveBeenCalledWith('low');
    expect(setValue).toHaveBeenCalledWith(
      expect.anything(),
      'model.reasoningPreferences',
      expect.objectContaining({
        'qwen3.8-max': { effort: 'low' },
      }),
    );
    expect(setValue).not.toHaveBeenCalledWith(
      expect.anything(),
      'model.reasoningEffort',
      expect.anything(),
    );
    expect(addItem).toHaveBeenCalledTimes(1);
    const [item] = addItem.mock.calls[0];
    expect(item.type).toBe('info');
    expect(item.text).toContain('low');
    expect(item.text).toContain('requested');
    expect(item.text).not.toContain('normalized');
  });
});

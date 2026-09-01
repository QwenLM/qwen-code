/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { useOutputStyleCommand } from './use-output-style-command.js';

describe('useOutputStyleCommand', () => {
  let setOutputStyle: ReturnType<typeof vi.fn>;
  let refreshSystemInstruction: ReturnType<typeof vi.fn>;
  let setValue: ReturnType<typeof vi.fn>;
  let addItem: ReturnType<typeof vi.fn>;
  let config: Config;
  let settings: LoadedSettings;

  beforeEach(() => {
    setOutputStyle = vi.fn();
    refreshSystemInstruction = vi.fn().mockResolvedValue(undefined);
    setValue = vi.fn();
    addItem = vi.fn();
    config = {
      setOutputStyle,
      getOutputStyle: vi.fn().mockReturnValue(undefined),
      getLlmClient: () => ({ refreshSystemInstruction }),
      getSystemPrompt: vi.fn().mockReturnValue(undefined),
      getExperimentalZedIntegration: vi.fn().mockReturnValue(false),
      getInputFormat: vi.fn().mockReturnValue('text'),
      isInteractive: vi.fn().mockReturnValue(true),
    } as unknown as Config;
    settings = {
      setValue,
      isTrusted: true,
      user: { settings: {} },
      workspace: { settings: {} },
    } as unknown as LoadedSettings;
  });

  it('opens and closes the dialog', () => {
    const { result } = renderHook(() =>
      useOutputStyleCommand(settings, config),
    );
    expect(result.current.isOutputStyleDialogOpen).toBe(false);

    act(() => result.current.openOutputStyleDialog());
    expect(result.current.isOutputStyleDialogOpen).toBe(true);
  });

  it('applies and persists the selected style, then reports it', async () => {
    const { result } = renderHook(() =>
      useOutputStyleCommand(settings, config, addItem),
    );
    act(() => result.current.openOutputStyleDialog());

    await act(async () => result.current.handleOutputStyleSelect('Concise'));

    expect(setOutputStyle).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Concise' }),
    );
    expect(refreshSystemInstruction).toHaveBeenCalled();
    expect(setValue).toHaveBeenCalledWith(
      expect.anything(),
      'general.outputStyle',
      'Concise',
    );
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'info' }),
      expect.any(Number),
    );
    expect(result.current.isOutputStyleDialogOpen).toBe(false);
  });

  it('clears the style when "default" is chosen', async () => {
    const { result } = renderHook(() =>
      useOutputStyleCommand(settings, config),
    );
    act(() => result.current.openOutputStyleDialog());

    await act(async () => result.current.handleOutputStyleSelect('default'));

    expect(setOutputStyle).toHaveBeenCalledWith(undefined);
    expect(setValue).toHaveBeenCalledWith(
      expect.anything(),
      'general.outputStyle',
      'default',
    );
    expect(result.current.isOutputStyleDialogOpen).toBe(false);
  });

  it('cancels without mutating config or settings on undefined', async () => {
    const { result } = renderHook(() =>
      useOutputStyleCommand(settings, config),
    );
    act(() => result.current.openOutputStyleDialog());

    await act(async () => result.current.handleOutputStyleSelect(undefined));

    expect(setOutputStyle).not.toHaveBeenCalled();
    expect(setValue).not.toHaveBeenCalled();
    expect(result.current.isOutputStyleDialogOpen).toBe(false);
  });
});

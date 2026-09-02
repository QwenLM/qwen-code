/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Config, OutputStyleDefinition } from '@qwen-code/qwen-code-core';
import {
  BUILT_IN_OUTPUT_STYLES,
  loadOutputStyleCatalog,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { useOutputStyleCommand } from './use-output-style-command.js';

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return { ...actual, loadOutputStyleCatalog: vi.fn() };
});
const mockedLoadCatalog = vi.mocked(loadOutputStyleCatalog);

const CUSTOM_STYLE: OutputStyleDefinition = {
  name: 'Reviewer',
  source: 'project',
  description: 'Reviews without editing',
  keepCodingInstructions: false,
  prompt: 'Review only.',
};

describe('useOutputStyleCommand', () => {
  let setOutputStyle: ReturnType<typeof vi.fn>;
  let refreshSystemInstruction: ReturnType<typeof vi.fn>;
  let setValue: ReturnType<typeof vi.fn>;
  let addItem: ReturnType<typeof vi.fn>;
  let recordSlashCommand: ReturnType<typeof vi.fn>;
  let config: Config;
  let settings: LoadedSettings;

  beforeEach(() => {
    mockedLoadCatalog.mockReset();
    mockedLoadCatalog.mockResolvedValue([
      ...BUILT_IN_OUTPUT_STYLES,
      CUSTOM_STYLE,
    ]);
    setOutputStyle = vi.fn();
    refreshSystemInstruction = vi.fn().mockResolvedValue(undefined);
    setValue = vi.fn();
    addItem = vi.fn();
    recordSlashCommand = vi.fn();
    config = {
      setOutputStyle,
      getOutputStyle: vi.fn().mockReturnValue(undefined),
      getLlmClient: () => ({ refreshSystemInstruction }),
      getSystemPrompt: vi.fn().mockReturnValue(undefined),
      getExperimentalZedIntegration: vi.fn().mockReturnValue(false),
      getInputFormat: vi.fn().mockReturnValue('text'),
      isInteractive: vi.fn().mockReturnValue(true),
      getBareMode: vi.fn().mockReturnValue(false),
      isSafeMode: vi.fn().mockReturnValue(false),
      isTrustedFolder: vi.fn().mockReturnValue(true),
      getProjectRoot: vi.fn().mockReturnValue('/repo'),
      getChatRecordingService: vi.fn(() => ({ recordSlashCommand })),
    } as unknown as Config;
    settings = {
      setValue,
      isTrusted: true,
      user: { settings: {} },
      workspace: { settings: {} },
    } as unknown as LoadedSettings;
  });

  it('loads the catalog, then opens the dialog with it', async () => {
    const { result } = renderHook(() =>
      useOutputStyleCommand(settings, config),
    );
    expect(result.current.isOutputStyleDialogOpen).toBe(false);
    expect(result.current.outputStyleChoices).toEqual(BUILT_IN_OUTPUT_STYLES);

    act(() => result.current.openOutputStyleDialog());
    await waitFor(() =>
      expect(result.current.isOutputStyleDialogOpen).toBe(true),
    );
    expect(mockedLoadCatalog).toHaveBeenCalledWith({ projectRoot: '/repo' });
    expect(result.current.outputStyleChoices).toContainEqual(CUSTOM_STYLE);
  });

  it('opens with the built-ins when the catalog cannot be read', async () => {
    mockedLoadCatalog.mockRejectedValue(new Error('EACCES'));
    const { result } = renderHook(() =>
      useOutputStyleCommand(settings, config),
    );

    act(() => result.current.openOutputStyleDialog());
    await waitFor(() =>
      expect(result.current.isOutputStyleDialogOpen).toBe(true),
    );
    expect(result.current.outputStyleChoices).toEqual(BUILT_IN_OUTPUT_STYLES);
  });

  it('applies and persists the selected style, then reports it', async () => {
    const { result } = renderHook(() =>
      useOutputStyleCommand(settings, config, addItem),
    );
    act(() => result.current.openOutputStyleDialog());
    await waitFor(() =>
      expect(result.current.isOutputStyleDialogOpen).toBe(true),
    );

    await act(async () => result.current.handleOutputStyleSelect('Concise'));

    expect(setOutputStyle).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Concise' }),
    );
    expect(refreshSystemInstruction).toHaveBeenCalled();
    expect(setValue).toHaveBeenCalledWith(
      expect.anything(),
      'general.outputStyle',
      'Concise',
      undefined,
      { throwOnWriteFailure: true },
    );
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'info' }),
      expect.any(Number),
    );
    expect(result.current.isOutputStyleDialogOpen).toBe(false);
  });

  it('applies a custom style offered by the dialog', async () => {
    const { result } = renderHook(() =>
      useOutputStyleCommand(settings, config, addItem),
    );
    act(() => result.current.openOutputStyleDialog());
    await waitFor(() =>
      expect(result.current.isOutputStyleDialogOpen).toBe(true),
    );

    await act(async () => result.current.handleOutputStyleSelect('Reviewer'));

    expect(setOutputStyle).toHaveBeenCalledWith(CUSTOM_STYLE);
    expect(setValue).toHaveBeenCalledWith(
      expect.anything(),
      'general.outputStyle',
      'Reviewer',
      undefined,
      { throwOnWriteFailure: true },
    );
  });

  it('reports a name the dialog did not offer instead of applying it', async () => {
    const { result } = renderHook(() =>
      useOutputStyleCommand(settings, config, addItem),
    );

    await act(async () => result.current.handleOutputStyleSelect('Nope'));

    expect(setOutputStyle).not.toHaveBeenCalled();
    expect(setValue).not.toHaveBeenCalled();
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' }),
      expect.any(Number),
    );
  });

  it('clears the style when "default" is chosen', async () => {
    const { result } = renderHook(() =>
      useOutputStyleCommand(settings, config),
    );

    await act(async () => result.current.handleOutputStyleSelect('default'));

    expect(setOutputStyle).toHaveBeenCalledWith(undefined);
    expect(setValue).toHaveBeenCalledWith(
      expect.anything(),
      'general.outputStyle',
      'default',
      undefined,
      { throwOnWriteFailure: true },
    );
    expect(result.current.isOutputStyleDialogOpen).toBe(false);
  });

  it('cancels without mutating config or settings on undefined', async () => {
    const { result } = renderHook(() =>
      useOutputStyleCommand(settings, config),
    );
    act(() => result.current.openOutputStyleDialog());
    await waitFor(() =>
      expect(result.current.isOutputStyleDialogOpen).toBe(true),
    );

    await act(async () => result.current.handleOutputStyleSelect(undefined));

    expect(setOutputStyle).not.toHaveBeenCalled();
    expect(setValue).not.toHaveBeenCalled();
    expect(result.current.isOutputStyleDialogOpen).toBe(false);
  });

  it('records the feedback row for session replay', async () => {
    const { result } = renderHook(() =>
      useOutputStyleCommand(settings, config, addItem),
    );

    await act(async () => result.current.handleOutputStyleSelect('Concise'));

    const [item] = addItem.mock.calls[0];
    expect(recordSlashCommand).toHaveBeenCalledWith({
      phase: 'result',
      rawCommand: '/output-style',
      outputHistoryItems: [item],
    });
  });

  it('reports persistence failures in chat without applying the style', async () => {
    setValue.mockImplementation(() => {
      throw new Error('read-only settings');
    });
    const { result } = renderHook(() =>
      useOutputStyleCommand(settings, config, addItem),
    );

    await act(async () => result.current.handleOutputStyleSelect('Concise'));

    expect(setOutputStyle).not.toHaveBeenCalled();
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text: expect.stringContaining('read-only settings'),
      }),
      expect.any(Number),
    );
    const [item] = addItem.mock.calls[0];
    expect(recordSlashCommand).toHaveBeenCalledWith({
      phase: 'result',
      rawCommand: '/output-style',
      outputHistoryItems: [item],
    });
  });
});

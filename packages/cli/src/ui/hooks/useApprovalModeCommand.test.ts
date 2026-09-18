/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ApprovalMode, Config } from '@qwen-code/qwen-code-core';
import { SettingScope, type LoadedSettings } from '../../config/settings.js';
import { MessageType } from '../types.js';
import { useApprovalModeCommand } from './useApprovalModeCommand.js';

const TRUST_GATE_MESSAGE =
  'Cannot enable privileged approval modes in an untrusted folder.';

describe('useApprovalModeCommand', () => {
  let setApprovalMode: ReturnType<typeof vi.fn>;
  let setValue: ReturnType<typeof vi.fn>;
  let addItem: ReturnType<typeof vi.fn>;
  let config: Config;
  let settings: LoadedSettings;

  beforeEach(() => {
    setApprovalMode = vi.fn();
    setValue = vi.fn();
    addItem = vi.fn();
    config = { setApprovalMode } as unknown as Config;
    settings = {
      setValue,
      merged: { tools: {} },
    } as unknown as LoadedSettings;
  });

  const selectMode = (
    result: {
      current: {
        handleApprovalModeSelect: (
          m: ApprovalMode | undefined,
          s: SettingScope,
        ) => void;
      };
    },
    mode: ApprovalMode | undefined,
  ) =>
    act(() => result.current.handleApprovalModeSelect(mode, SettingScope.User));

  it('applies the mode at runtime before persisting it', () => {
    const { result } = renderHook(() =>
      useApprovalModeCommand(settings, config, addItem),
    );
    act(() => result.current.openApprovalModeDialog());

    selectMode(result, 'yolo' as ApprovalMode);

    expect(setApprovalMode).toHaveBeenCalledWith('yolo');
    expect(setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'tools.approvalMode',
      'yolo',
    );
    // The trust gate lives in setApprovalMode, so it has to rule first.
    expect(setApprovalMode.mock.invocationCallOrder[0]).toBeLessThan(
      setValue.mock.invocationCallOrder[0],
    );
    expect(result.current.isApprovalModeDialogOpen).toBe(false);
  });

  it('does not persist a mode the trust gate refuses, and reports it', () => {
    setApprovalMode.mockImplementation(() => {
      throw new Error(TRUST_GATE_MESSAGE);
    });
    const { result } = renderHook(() =>
      useApprovalModeCommand(settings, config, addItem),
    );
    act(() => result.current.openApprovalModeDialog());

    expect(() => selectMode(result, 'yolo' as ApprovalMode)).not.toThrow();

    // A refused escalation must not survive on disk: at User scope it would
    // arm the privileged mode in every workspace the user has trusted.
    expect(setValue).not.toHaveBeenCalled();
    expect(addItem).toHaveBeenCalledWith(
      { type: MessageType.ERROR, text: TRUST_GATE_MESSAGE },
      expect.any(Number),
    );
    expect(result.current.isApprovalModeDialogOpen).toBe(false);
  });

  it('leaves runtime and settings untouched when the dialog is cancelled', () => {
    const { result } = renderHook(() =>
      useApprovalModeCommand(settings, config, addItem),
    );
    act(() => result.current.openApprovalModeDialog());

    selectMode(result, undefined);

    expect(setApprovalMode).not.toHaveBeenCalled();
    expect(setValue).not.toHaveBeenCalled();
    expect(addItem).not.toHaveBeenCalled();
    expect(result.current.isApprovalModeDialogOpen).toBe(false);
  });
});

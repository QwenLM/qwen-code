/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { ApprovalMode } from '@qwen-code/qwen-code-core/config/approval-mode.js';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { SettingScope, type LoadedSettings } from '../../config/settings.js';
import { MessageType } from '../types.js';
import { useApprovalModeCommand } from './useApprovalModeCommand.js';

const TRUST_GATE_MESSAGE =
  'Cannot enable privileged approval modes in an untrusted folder.';

describe('useApprovalModeCommand', () => {
  let setApprovalMode: ReturnType<typeof vi.fn>;
  let isTrustedFolder: ReturnType<typeof vi.fn>;
  let setValue: ReturnType<typeof vi.fn>;
  let addItem: ReturnType<typeof vi.fn>;
  let config: Config;
  let settings: LoadedSettings;

  beforeEach(() => {
    setApprovalMode = vi.fn();
    isTrustedFolder = vi.fn(() => true);
    setValue = vi.fn();
    addItem = vi.fn();
    config = { setApprovalMode, isTrustedFolder } as unknown as Config;
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

  it('persists the choice before applying its effective mode', () => {
    const { result } = renderHook(() =>
      useApprovalModeCommand(settings, config, addItem),
    );
    act(() => result.current.openApprovalModeDialog());

    selectMode(result, ApprovalMode.YOLO);

    expect(setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'tools.approvalMode',
      ApprovalMode.YOLO,
    );
    expect(setApprovalMode).toHaveBeenCalledOnce();
    expect(setApprovalMode).toHaveBeenCalledWith(ApprovalMode.YOLO);
    expect(setValue.mock.invocationCallOrder[0]).toBeLessThan(
      setApprovalMode.mock.invocationCallOrder[0],
    );
    expect(result.current.isApprovalModeDialogOpen).toBe(false);
  });

  it('applies only the effective mode when a higher scope shadows the choice', () => {
    settings.merged.tools = { approvalMode: ApprovalMode.PLAN };
    const { result } = renderHook(() =>
      useApprovalModeCommand(settings, config, addItem),
    );

    selectMode(result, ApprovalMode.YOLO);

    expect(setApprovalMode.mock.calls).toEqual([[ApprovalMode.PLAN]]);
  });

  it('does not persist a mode the trust gate refuses, and reports it', () => {
    isTrustedFolder.mockReturnValue(false);
    const { result } = renderHook(() =>
      useApprovalModeCommand(settings, config, addItem),
    );
    act(() => result.current.openApprovalModeDialog());

    expect(() => selectMode(result, ApprovalMode.YOLO)).not.toThrow();

    expect(setApprovalMode).not.toHaveBeenCalled();
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

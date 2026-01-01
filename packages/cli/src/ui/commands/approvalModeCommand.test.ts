/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { approvalModeCommand } from './approvalModeCommand.js';
import {
  type CommandContext,
  CommandKind,
  type OpenDialogActionReturn,
  type MessageActionReturn,
} from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { LoadedSettings } from '../../config/settings.js';

describe('approvalModeCommand', () => {
  let mockContext: CommandContext;
  let mockSetValue: ReturnType<typeof vi.fn>;
  let mockSetApprovalMode: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSetValue = vi.fn();
    mockSetApprovalMode = vi.fn();
    mockContext = createMockCommandContext({
      services: {
        config: {
          getApprovalMode: () => 'default',
          setApprovalMode: mockSetApprovalMode,
        },
        settings: {
          // Use empty merged so ?? fallback triggers, allowing us to verify
          // the exact mode passed to setApprovalMode
          merged: {},
          setValue: mockSetValue,
          forScope: () => ({}),
        } as unknown as LoadedSettings,
      },
    });
  });

  it('should have correct metadata', () => {
    expect(approvalModeCommand.name).toBe('approval-mode');
    expect(approvalModeCommand.description).toBe(
      'View or change the approval mode for tool usage',
    );
    expect(approvalModeCommand.kind).toBe(CommandKind.BUILT_IN);
  });

  it('should open approval mode dialog when invoked without arguments', async () => {
    const result = (await approvalModeCommand.action?.(
      mockContext,
      '',
    )) as OpenDialogActionReturn;

    expect(result.type).toBe('dialog');
    expect(result.dialog).toBe('approval-mode');
  });

  it('should open approval mode dialog when invoked with whitespace only', async () => {
    const result = (await approvalModeCommand.action?.(
      mockContext,
      '   ',
    )) as OpenDialogActionReturn;

    expect(result.type).toBe('dialog');
    expect(result.dialog).toBe('approval-mode');
  });

  describe('direct mode setting', () => {
    it('should set approval mode to "plan" when argument is "plan"', async () => {
      const result = (await approvalModeCommand.action?.(
        mockContext,
        'plan',
      )) as MessageActionReturn;

      expect(result.type).toBe('message');
      expect(result.messageType).toBe('info');
      expect(result.content).toContain('plan');
      expect(mockSetValue).toHaveBeenCalledWith(
        'User',
        'tools.approvalMode',
        'plan',
      );
      expect(mockSetApprovalMode).toHaveBeenCalledWith('plan');
    });

    it('should set approval mode to "yolo" when argument is "yolo"', async () => {
      const result = (await approvalModeCommand.action?.(
        mockContext,
        'yolo',
      )) as MessageActionReturn;

      expect(result.type).toBe('message');
      expect(result.messageType).toBe('info');
      expect(result.content).toContain('yolo');
      expect(mockSetValue).toHaveBeenCalledWith(
        'User',
        'tools.approvalMode',
        'yolo',
      );
      expect(mockSetApprovalMode).toHaveBeenCalledWith('yolo');
    });

    it('should set approval mode to "auto-edit" when argument is "auto-edit"', async () => {
      const result = (await approvalModeCommand.action?.(
        mockContext,
        'auto-edit',
      )) as MessageActionReturn;

      expect(result.type).toBe('message');
      expect(result.messageType).toBe('info');
      expect(result.content).toContain('auto-edit');
      expect(mockSetValue).toHaveBeenCalledWith(
        'User',
        'tools.approvalMode',
        'auto-edit',
      );
      expect(mockSetApprovalMode).toHaveBeenCalledWith('auto-edit');
    });

    it('should set approval mode to "default" when argument is "default"', async () => {
      const result = (await approvalModeCommand.action?.(
        mockContext,
        'default',
      )) as MessageActionReturn;

      expect(result.type).toBe('message');
      expect(result.messageType).toBe('info');
      expect(result.content).toContain('default');
      expect(mockSetValue).toHaveBeenCalledWith(
        'User',
        'tools.approvalMode',
        'default',
      );
      expect(mockSetApprovalMode).toHaveBeenCalledWith('default');
    });

    it('should be case-insensitive for mode argument', async () => {
      const result = (await approvalModeCommand.action?.(
        mockContext,
        'YOLO',
      )) as MessageActionReturn;

      expect(result.type).toBe('message');
      expect(result.messageType).toBe('info');
      expect(mockSetValue).toHaveBeenCalledWith(
        'User',
        'tools.approvalMode',
        'yolo',
      );
      expect(mockSetApprovalMode).toHaveBeenCalledWith('yolo');
    });

    it('should handle argument with leading/trailing whitespace', async () => {
      const result = (await approvalModeCommand.action?.(
        mockContext,
        '  plan  ',
      )) as MessageActionReturn;

      expect(result.type).toBe('message');
      expect(result.messageType).toBe('info');
      expect(mockSetValue).toHaveBeenCalledWith(
        'User',
        'tools.approvalMode',
        'plan',
      );
      expect(mockSetApprovalMode).toHaveBeenCalledWith('plan');
    });
  });

  describe('invalid mode argument', () => {
    it('should return error for invalid mode', async () => {
      const result = (await approvalModeCommand.action?.(
        mockContext,
        'invalid-mode',
      )) as MessageActionReturn;

      expect(result.type).toBe('message');
      expect(result.messageType).toBe('error');
      expect(result.content).toContain('invalid-mode');
      expect(result.content).toContain('plan');
      expect(result.content).toContain('yolo');
      expect(mockSetValue).not.toHaveBeenCalled();
      expect(mockSetApprovalMode).not.toHaveBeenCalled();
    });
  });

  it('should not have subcommands', () => {
    expect(approvalModeCommand.subCommands).toBeUndefined();
  });

  describe('completion', () => {
    it('should have completion function', () => {
      expect(approvalModeCommand.completion).toBeDefined();
    });

    it('should return all modes when partial arg is empty', async () => {
      const completions = await approvalModeCommand.completion?.(
        mockContext,
        '',
      );

      expect(completions).toContain('plan');
      expect(completions).toContain('default');
      expect(completions).toContain('auto-edit');
      expect(completions).toContain('yolo');
    });

    it('should filter modes based on partial arg', async () => {
      const completions = await approvalModeCommand.completion?.(
        mockContext,
        'p',
      );

      expect(completions).toContain('plan');
      expect(completions).not.toContain('yolo');
    });

    it('should filter modes case-insensitively', async () => {
      const completions = await approvalModeCommand.completion?.(
        mockContext,
        'A',
      );

      expect(completions).toContain('auto-edit');
    });

    it('should return empty array when no modes match', async () => {
      const completions = await approvalModeCommand.completion?.(
        mockContext,
        'xyz',
      );

      expect(completions).toEqual([]);
    });
  });
});

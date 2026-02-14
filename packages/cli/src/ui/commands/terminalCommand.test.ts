/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { terminalCommand } from './terminalCommand.js';
import {
  type CommandContext,
  CommandKind,
  type MessageActionReturn,
} from './types.js';
import { SettingScope } from '../../config/settings.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

describe('terminalCommand', () => {
  let mockContext: CommandContext;
  let mockSetValue: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSetValue = vi.fn();
    mockContext = createMockCommandContext({
      services: {
        settings: {
          merged: {},
          setValue: mockSetValue,
        },
      },
    });
  });

  it('should have correct metadata', () => {
    expect(terminalCommand.name).toBe('terminal');
    expect(terminalCommand.description).toBe(
      'manage dedicated terminal for shell command display',
    );
    expect(terminalCommand.kind).toBe(CommandKind.BUILT_IN);
  });

  it('should have three subcommands', () => {
    expect(terminalCommand.subCommands).toHaveLength(3);
    expect(terminalCommand.subCommands?.[0].name).toBe('enable');
    expect(terminalCommand.subCommands?.[1].name).toBe('disable');
    expect(terminalCommand.subCommands?.[2].name).toBe('status');
  });

  describe('enable subcommand', () => {
    it('should have correct metadata', () => {
      const enableCommand = terminalCommand.subCommands?.[0];
      expect(enableCommand?.name).toBe('enable');
      expect(enableCommand?.description).toBe('enable dedicated terminal');
      expect(enableCommand?.kind).toBe(CommandKind.BUILT_IN);
    });

    it('should set ide.dedicatedTerminal to true', () => {
      const enableCommand = terminalCommand.subCommands?.[0];
      const result = enableCommand?.action?.(
        mockContext,
        '',
      ) as MessageActionReturn;

      expect(mockSetValue).toHaveBeenCalledWith(
        SettingScope.User,
        'ide.dedicatedTerminal',
        true,
      );
      expect(result.type).toBe('message');
      expect(result.messageType).toBe('info');
      expect(result.content).toContain('Dedicated terminal enabled');
    });
  });

  describe('disable subcommand', () => {
    it('should have correct metadata', () => {
      const disableCommand = terminalCommand.subCommands?.[1];
      expect(disableCommand?.name).toBe('disable');
      expect(disableCommand?.description).toBe('disable dedicated terminal');
      expect(disableCommand?.kind).toBe(CommandKind.BUILT_IN);
    });

    it('should set ide.dedicatedTerminal to false', () => {
      const disableCommand = terminalCommand.subCommands?.[1];
      const result = disableCommand?.action?.(
        mockContext,
        '',
      ) as MessageActionReturn;

      expect(mockSetValue).toHaveBeenCalledWith(
        SettingScope.User,
        'ide.dedicatedTerminal',
        false,
      );
      expect(result.type).toBe('message');
      expect(result.messageType).toBe('error');
      expect(result.content).toContain('Dedicated terminal disabled');
    });
  });

  describe('status subcommand', () => {
    it('should have correct metadata', () => {
      const statusCommand = terminalCommand.subCommands?.[2];
      expect(statusCommand?.name).toBe('status');
      expect(statusCommand?.description).toBe(
        'check dedicated terminal status',
      );
      expect(statusCommand?.kind).toBe(CommandKind.BUILT_IN);
    });

    it('should report enabled when ide.dedicatedTerminal is true', () => {
      mockContext = createMockCommandContext({
        services: {
          settings: {
            merged: { ide: { dedicatedTerminal: true } },
            setValue: mockSetValue,
          },
        },
      });

      const statusCommand = terminalCommand.subCommands?.[2];
      const result = statusCommand?.action?.(
        mockContext,
        '',
      ) as MessageActionReturn;

      expect(result.type).toBe('message');
      expect(result.messageType).toBe('info');
      expect(result.content).toBe('Dedicated terminal is currently enabled.');
    });

    it('should report disabled when ide.dedicatedTerminal is false', () => {
      mockContext = createMockCommandContext({
        services: {
          settings: {
            merged: { ide: { dedicatedTerminal: false } },
            setValue: mockSetValue,
          },
        },
      });

      const statusCommand = terminalCommand.subCommands?.[2];
      const result = statusCommand?.action?.(
        mockContext,
        '',
      ) as MessageActionReturn;

      expect(result.type).toBe('message');
      expect(result.messageType).toBe('info');
      expect(result.content).toBe('Dedicated terminal is currently disabled.');
    });

    it('should default to enabled when ide.dedicatedTerminal is not set', () => {
      mockContext = createMockCommandContext({
        services: {
          settings: {
            merged: {},
            setValue: mockSetValue,
          },
        },
      });

      const statusCommand = terminalCommand.subCommands?.[2];
      const result = statusCommand?.action?.(
        mockContext,
        '',
      ) as MessageActionReturn;

      expect(result.type).toBe('message');
      expect(result.messageType).toBe('info');
      expect(result.content).toBe('Dedicated terminal is currently enabled.');
    });

    it('should default to enabled when ide section exists but dedicatedTerminal is not set', () => {
      mockContext = createMockCommandContext({
        services: {
          settings: {
            merged: { ide: {} },
            setValue: mockSetValue,
          },
        },
      });

      const statusCommand = terminalCommand.subCommands?.[2];
      const result = statusCommand?.action?.(
        mockContext,
        '',
      ) as MessageActionReturn;

      expect(result.type).toBe('message');
      expect(result.messageType).toBe('info');
      expect(result.content).toBe('Dedicated terminal is currently enabled.');
    });
  });

  it('should not have a top-level action', () => {
    expect(terminalCommand.action).toBeUndefined();
  });
});

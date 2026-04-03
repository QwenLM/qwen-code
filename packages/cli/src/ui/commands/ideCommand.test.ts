/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ideCommand } from './ideCommand.js';
import { type CommandContext } from './types.js';
import { IDE_DEFINITIONS } from '@qwen-code/qwen-code-core';
import * as core from '@qwen-code/qwen-code-core';

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const original = await importOriginal<typeof core>();
  return {
    ...original,
    IdeClient: {
      getInstance: vi.fn(),
    },
  };
});

describe('ideCommand', () => {
  let mockContext: CommandContext;
  let mockIdeClient: core.IdeClient;

  beforeEach(() => {
    vi.resetAllMocks();

    mockIdeClient = {
      reconnect: vi.fn(),
      disconnect: vi.fn(),
      connect: vi.fn(),
      getCurrentIde: vi.fn(),
      getConnectionStatus: vi.fn(),
      getDetectedIdeDisplayName: vi.fn(),
    } as unknown as core.IdeClient;

    vi.mocked(core.IdeClient.getInstance).mockResolvedValue(mockIdeClient);
    vi.mocked(mockIdeClient.getDetectedIdeDisplayName).mockReturnValue(
      'VS Code',
    );

    mockContext = {
      ui: {
        addItem: vi.fn(),
      },
      services: {
        settings: {
          setValue: vi.fn(),
        },
        config: {
          getIdeMode: vi.fn(),
          setIdeMode: vi.fn(),
          getUsageStatisticsEnabled: vi.fn().mockReturnValue(false),
        },
      },
    } as unknown as CommandContext;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return the ide command', async () => {
    vi.mocked(mockIdeClient.getCurrentIde).mockReturnValue(
      IDE_DEFINITIONS.vscode,
    );
    vi.mocked(mockIdeClient.getConnectionStatus).mockReturnValue({
      status: core.IDEConnectionStatus.Disconnected,
    });
    const command = await ideCommand();
    expect(command).not.toBeNull();
    expect(command.name).toBe('ide');
    expect(command.subCommands).toHaveLength(2);
    expect(command.subCommands?.[0].name).toBe('enable');
    expect(command.subCommands?.[1].name).toBe('status');
  });

  it('should show disable command when connected', async () => {
    vi.mocked(mockIdeClient.getCurrentIde).mockReturnValue(
      IDE_DEFINITIONS.vscode,
    );
    vi.mocked(mockIdeClient.getConnectionStatus).mockReturnValue({
      status: core.IDEConnectionStatus.Connected,
    });
    const command = await ideCommand();
    expect(command).not.toBeNull();
    const subCommandNames = command.subCommands?.map((cmd) => cmd.name);
    expect(subCommandNames).toContain('disable');
    expect(subCommandNames).not.toContain('enable');
  });

  describe('status subcommand', () => {
    beforeEach(() => {
      vi.mocked(mockIdeClient.getCurrentIde).mockReturnValue(
        IDE_DEFINITIONS.vscode,
      );
    });

    it('should show connected status', async () => {
      vi.mocked(mockIdeClient.getConnectionStatus).mockReturnValue({
        status: core.IDEConnectionStatus.Connected,
      });
      const command = await ideCommand();
      const result = await command!.subCommands!.find(
        (c) => c.name === 'status',
      )!.action!(mockContext, '');
      expect(vi.mocked(mockIdeClient.getConnectionStatus)).toHaveBeenCalled();
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: '🟢 Connected to VS Code',
      });
    });

    it('should show connecting status', async () => {
      vi.mocked(mockIdeClient.getConnectionStatus).mockReturnValue({
        status: core.IDEConnectionStatus.Connecting,
      });
      const command = await ideCommand();
      const result = await command!.subCommands!.find(
        (c) => c.name === 'status',
      )!.action!(mockContext, '');
      expect(vi.mocked(mockIdeClient.getConnectionStatus)).toHaveBeenCalled();
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: `🟡 Connecting...`,
      });
    });
    it('should show disconnected status', async () => {
      vi.mocked(mockIdeClient.getConnectionStatus).mockReturnValue({
        status: core.IDEConnectionStatus.Disconnected,
      });
      const command = await ideCommand();
      const result = await command!.subCommands!.find(
        (c) => c.name === 'status',
      )!.action!(mockContext, '');
      expect(vi.mocked(mockIdeClient.getConnectionStatus)).toHaveBeenCalled();
      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: `🔴 Disconnected`,
      });
    });

    it('should show disconnected status with details', async () => {
      const details = 'Something went wrong';
      vi.mocked(mockIdeClient.getConnectionStatus).mockReturnValue({
        status: core.IDEConnectionStatus.Disconnected,
        details,
      });
      const command = await ideCommand();
      const result = await command!.subCommands!.find(
        (c) => c.name === 'status',
      )!.action!(mockContext, '');
      expect(vi.mocked(mockIdeClient.getConnectionStatus)).toHaveBeenCalled();
      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: `🔴 Disconnected: ${details}`,
      });
    });
  });
});

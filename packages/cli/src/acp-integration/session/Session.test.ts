/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Session } from './Session.js';
import type { Config, GeminiChat } from '@qwen-code/qwen-code-core';
import { ApprovalMode } from '@qwen-code/qwen-code-core';
import type * as acp from '../acp.js';
import type { LoadedSettings } from '../../config/settings.js';
import * as nonInteractiveCliCommands from '../../nonInteractiveCliCommands.js';

vi.mock('../../nonInteractiveCliCommands.js', () => ({
  getAvailableCommands: vi.fn(),
  handleSlashCommand: vi.fn(),
}));

describe('Session', () => {
  let mockChat: GeminiChat;
  let mockConfig: Config;
  let mockClient: acp.Client;
  let mockSettings: LoadedSettings;
  let session: Session;
  let currentModel: string;
  let setModelSpy: ReturnType<typeof vi.fn>;
  let getAvailableCommandsSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    currentModel = 'qwen3-code-plus';
    setModelSpy = vi.fn().mockImplementation(async (modelId: string) => {
      currentModel = modelId;
    });

    mockChat = {
      sendMessageStream: vi.fn(),
      addHistory: vi.fn(),
    } as unknown as GeminiChat;

    mockConfig = {
      setApprovalMode: vi.fn(),
      setModel: setModelSpy,
      getModel: vi.fn().mockImplementation(() => currentModel),
    } as unknown as Config;

    mockClient = {
      sessionUpdate: vi.fn().mockResolvedValue(undefined),
      requestPermission: vi.fn().mockResolvedValue({
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
      }),
      sendCustomNotification: vi.fn().mockResolvedValue(undefined),
    } as unknown as acp.Client;

    mockSettings = {
      merged: {},
    } as LoadedSettings;

    getAvailableCommandsSpy = vi.mocked(nonInteractiveCliCommands)
      .getAvailableCommands as unknown as ReturnType<typeof vi.fn>;
    getAvailableCommandsSpy.mockResolvedValue([]);

    session = new Session(
      'test-session-id',
      mockChat,
      mockConfig,
      mockClient,
      mockSettings,
    );
  });

  describe('setMode', () => {
    it.each([
      ['plan', ApprovalMode.PLAN],
      ['default', ApprovalMode.DEFAULT],
      ['auto-edit', ApprovalMode.AUTO_EDIT],
      ['yolo', ApprovalMode.YOLO],
    ] as const)('maps %s mode', async (modeId, expected) => {
      const result = await session.setMode({
        sessionId: 'test-session-id',
        modeId,
      });

      expect(mockConfig.setApprovalMode).toHaveBeenCalledWith(expected);
      expect(result).toEqual({ modeId });
    });
  });

  describe('setModel', () => {
    it('sets model via config and returns current model', async () => {
      const result = await session.setModel({
        sessionId: 'test-session-id',
        modelId: '  qwen3-coder-plus  ',
      });

      expect(mockConfig.setModel).toHaveBeenCalledWith('qwen3-coder-plus', {
        reason: 'user_request_acp',
        context: 'session/set_model',
      });
      expect(mockConfig.getModel).toHaveBeenCalled();
      expect(result).toEqual({ modelId: 'qwen3-coder-plus' });
    });

    it('rejects empty/whitespace model IDs', async () => {
      await expect(
        session.setModel({
          sessionId: 'test-session-id',
          modelId: '   ',
        }),
      ).rejects.toThrow('Invalid params');

      expect(mockConfig.setModel).not.toHaveBeenCalled();
    });

    it('propagates errors from config.setModel', async () => {
      const configError = new Error('Invalid model');
      setModelSpy.mockRejectedValueOnce(configError);

      await expect(
        session.setModel({
          sessionId: 'test-session-id',
          modelId: 'invalid-model',
        }),
      ).rejects.toThrow('Invalid model');
    });
  });

  describe('sendAvailableCommandsUpdate', () => {
    it('sends available_commands_update from getAvailableCommands()', async () => {
      getAvailableCommandsSpy.mockResolvedValueOnce([
        {
          name: 'init',
          description: 'Initialize project context',
        },
      ]);

      await session.sendAvailableCommandsUpdate();

      expect(getAvailableCommandsSpy).toHaveBeenCalledWith(
        mockConfig,
        expect.any(AbortSignal),
      );
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
        sessionId: 'test-session-id',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            {
              name: 'init',
              description: 'Initialize project context',
              input: null,
            },
          ],
        },
      });
    });

    it('swallows errors and does not throw', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      getAvailableCommandsSpy.mockRejectedValueOnce(
        new Error('Command discovery failed'),
      );

      await expect(
        session.sendAvailableCommandsUpdate(),
      ).resolves.toBeUndefined();
      expect(mockClient.sessionUpdate).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });
  });
});

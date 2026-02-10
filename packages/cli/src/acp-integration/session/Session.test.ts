/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Session } from './Session.js';
import type { Config, GeminiChat } from '@qwen-code/qwen-code-core';
import { ApprovalMode, AuthType } from '@qwen-code/qwen-code-core';
import * as core from '@qwen-code/qwen-code-core';
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
  let currentAuthType: AuthType;
  let switchModelSpy: ReturnType<typeof vi.fn>;
  let getAvailableCommandsSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    currentModel = 'qwen3-code-plus';
    currentAuthType = AuthType.USE_OPENAI;
    switchModelSpy = vi
      .fn()
      .mockImplementation(async (authType: AuthType, modelId: string) => {
        currentAuthType = authType;
        currentModel = modelId;
      });

    mockChat = {
      sendMessageStream: vi.fn(),
      addHistory: vi.fn(),
    } as unknown as GeminiChat;

    const toolRegistry = { getTool: vi.fn() };
    const fileService = { shouldGitIgnoreFile: vi.fn().mockReturnValue(false) };

    mockConfig = {
      setApprovalMode: vi.fn(),
      switchModel: switchModelSpy,
      getModel: vi.fn().mockImplementation(() => currentModel),
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      getTelemetryLogPromptsEnabled: vi.fn().mockReturnValue(false),
      getUsageStatisticsEnabled: vi.fn().mockReturnValue(false),
      getContentGeneratorConfig: vi.fn().mockReturnValue(undefined),
      getChatRecordingService: vi.fn().mockReturnValue({
        recordUserMessage: vi.fn(),
        recordUiTelemetryEvent: vi.fn(),
      }),
      getToolRegistry: vi.fn().mockReturnValue(toolRegistry),
      getFileService: vi.fn().mockReturnValue(fileService),
      getFileFilteringRespectGitIgnore: vi.fn().mockReturnValue(true),
      getEnableRecursiveFileSearch: vi.fn().mockReturnValue(false),
      getTargetDir: vi.fn().mockReturnValue(process.cwd()),
      getDebugMode: vi.fn().mockReturnValue(false),
      getAuthType: vi.fn().mockImplementation(() => currentAuthType),
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
      const requested = `qwen3-coder-plus(${AuthType.USE_OPENAI})`;
      const result = await session.setModel({
        sessionId: 'test-session-id',
        modelId: `  ${requested}  `,
      });

      expect(mockConfig.switchModel).toHaveBeenCalledWith(
        AuthType.USE_OPENAI,
        'qwen3-coder-plus',
        undefined,
      );
      expect(mockConfig.getModel).toHaveBeenCalled();
      expect(result).toEqual({
        modelId: `qwen3-coder-plus(${AuthType.USE_OPENAI})`,
      });
    });

    it('rejects empty/whitespace model IDs', async () => {
      await expect(
        session.setModel({
          sessionId: 'test-session-id',
          modelId: '   ',
        }),
      ).rejects.toThrow('Invalid params');

      expect(mockConfig.switchModel).not.toHaveBeenCalled();
    });

    it('propagates errors from config.switchModel', async () => {
      const configError = new Error('Invalid model');
      switchModelSpy.mockRejectedValueOnce(configError);

      await expect(
        session.setModel({
          sessionId: 'test-session-id',
          modelId: `invalid-model(${AuthType.USE_OPENAI})`,
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
      getAvailableCommandsSpy.mockRejectedValueOnce(
        new Error('Command discovery failed'),
      );

      await expect(
        session.sendAvailableCommandsUpdate(),
      ).resolves.toBeUndefined();
      expect(mockClient.sessionUpdate).not.toHaveBeenCalled();
    });
  });

  describe('prompt', () => {
    it('passes resolved paths to read_many_files tool', async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'qwen-acp-session-'),
      );
      const fileName = 'README.md';
      const filePath = path.join(tempDir, fileName);

      try {
        await fs.writeFile(filePath, '# Test\n', 'utf8');

        const readManyFilesSpy = vi
          .spyOn(core, 'readManyFiles')
          .mockResolvedValue({
            contentParts: 'file content',
            files: [],
          });

        mockConfig.getTargetDir = vi.fn().mockReturnValue(tempDir);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue((async function* () {})());

        const promptRequest: acp.PromptRequest = {
          sessionId: 'test-session-id',
          prompt: [
            { type: 'text', text: 'Check this file' },
            {
              type: 'resource_link',
              name: fileName,
              uri: `file://${fileName}`,
            },
          ],
        };

        await session.prompt(promptRequest);

        expect(readManyFilesSpy).toHaveBeenCalledWith(mockConfig, {
          paths: [fileName],
          signal: expect.any(AbortSignal),
        });
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});

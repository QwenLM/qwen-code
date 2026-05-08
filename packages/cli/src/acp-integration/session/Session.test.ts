/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Session } from './Session.js';
import type { Config, GeminiChat } from '@qwen-code/qwen-code-core';
import { ApprovalMode, AuthType } from '@qwen-code/qwen-code-core';
import * as core from '@qwen-code/qwen-code-core';
import { SettingScope } from '../../config/settings.js';
import type {
  AgentSideConnection,
  PromptRequest,
} from '@agentclientprotocol/sdk';
import type { LoadedSettings } from '../../config/settings.js';
import * as nonInteractiveCliCommands from '../../nonInteractiveCliCommands.js';

vi.mock('../../nonInteractiveCliCommands.js', () => ({
  ALLOWED_BUILTIN_COMMANDS_NON_INTERACTIVE: [
    'init',
    'summary',
    'compress',
    'bug',
  ],
  getAvailableCommands: vi.fn(),
  handleSlashCommand: vi.fn(),
}));

// Helper to create empty async generator (avoids memory leak from inline generators)
function createEmptyStream() {
  return (async function* () {})();
}

// Helper to create async generator with chunks (avoids memory leak)
function createStreamWithChunks(
  chunks: Array<{ type: unknown; value: unknown }>,
) {
  return (async function* () {
    for (const chunk of chunks) {
      yield chunk;
    }
  })();
}

function expectCompressBeforeSend(
  compressMock: ReturnType<typeof vi.fn>,
  sendMock: ReturnType<typeof vi.fn>,
  callIndex: number,
) {
  expect(compressMock.mock.invocationCallOrder.length).toBeGreaterThan(
    callIndex,
  );
  expect(sendMock.mock.invocationCallOrder.length).toBeGreaterThan(callIndex);
  expect(compressMock.mock.invocationCallOrder[callIndex]).toBeLessThan(
    sendMock.mock.invocationCallOrder[callIndex],
  );
}

describe('Session', () => {
  let mockChat: GeminiChat;
  let mockConfig: Config;
  let mockClient: AgentSideConnection;
  let mockSettings: LoadedSettings;
  let session: Session;
  let currentModel: string;
  let currentAuthType: AuthType;
  let switchModelSpy: ReturnType<typeof vi.fn>;
  let getAvailableCommandsSpy: ReturnType<typeof vi.fn>;
  let mockGeminiClient: {
    getChat: ReturnType<typeof vi.fn>;
    tryCompressChat: ReturnType<typeof vi.fn>;
  };
  let mockToolRegistry: {
    getTool: ReturnType<typeof vi.fn>;
    ensureTool: ReturnType<typeof vi.fn>;
  };
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
      getHistory: vi.fn().mockReturnValue([]),
    } as unknown as GeminiChat;
    mockGeminiClient = {
      getChat: vi.fn().mockReturnValue(mockChat),
      tryCompressChat: vi.fn().mockResolvedValue({
        originalTokenCount: 0,
        newTokenCount: 0,
        compressionStatus: core.CompressionStatus.NOOP,
      }),
    };

    mockToolRegistry = {
      getTool: vi.fn(),
      // #executePrompt → #buildInitialSystemReminders calls
      // getToolRegistry().ensureTool(ToolNames.AGENT) on every session.prompt(),
      // so the default mock must provide it (#1151 / #3479).
      ensureTool: vi.fn().mockResolvedValue(true),
    };
    const fileService = { shouldGitIgnoreFile: vi.fn().mockReturnValue(false) };

    mockConfig = {
      setApprovalMode: vi.fn(),
      // #buildInitialSystemReminders branches on ApprovalMode.PLAN on every
      // session.prompt(), so the default must be defined. Individual tests
      // that care override via `mockConfig.getApprovalMode = vi.fn()...`.
      getApprovalMode: vi.fn().mockReturnValue(ApprovalMode.DEFAULT),
      switchModel: switchModelSpy,
      getModel: vi.fn().mockImplementation(() => currentModel),
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      getWorkingDir: vi.fn().mockReturnValue(process.cwd()),
      getTelemetryLogPromptsEnabled: vi.fn().mockReturnValue(false),
      getUsageStatisticsEnabled: vi.fn().mockReturnValue(false),
      getContentGeneratorConfig: vi.fn().mockReturnValue(undefined),
      getChatRecordingService: vi.fn().mockReturnValue({
        recordUserMessage: vi.fn(),
        recordUiTelemetryEvent: vi.fn(),
        recordToolResult: vi.fn(),
        recordSlashCommand: vi.fn(),
      }),
      getToolRegistry: vi.fn().mockReturnValue(mockToolRegistry),
      // #buildInitialSystemReminders iterates listSubagents() on every
      // session.prompt(). Default to an empty list so tests that don't
      // exercise subagent reminders don't need to stub it (#1151 / #3479).
      getSubagentManager: vi.fn().mockReturnValue({
        listSubagents: vi.fn().mockResolvedValue([]),
      }),
      getFileService: vi.fn().mockReturnValue(fileService),
      getFileFilteringRespectGitIgnore: vi.fn().mockReturnValue(true),
      getEnableRecursiveFileSearch: vi.fn().mockReturnValue(false),
      getTargetDir: vi.fn().mockReturnValue(process.cwd()),
      getDebugMode: vi.fn().mockReturnValue(false),
      getAuthType: vi.fn().mockImplementation(() => currentAuthType),
      isCronEnabled: vi.fn().mockReturnValue(false),
      getSessionTokenLimit: vi.fn().mockReturnValue(0),
      getGeminiClient: vi.fn().mockReturnValue(mockGeminiClient),
    } as unknown as Config;

    mockClient = {
      sessionUpdate: vi.fn().mockResolvedValue(undefined),
      requestPermission: vi.fn().mockResolvedValue({
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
      }),
      extNotification: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentSideConnection;

    mockSettings = {
      merged: {},
      isTrusted: false,
      user: { settings: {} },
      workspace: { settings: {} },
      setValue: vi.fn(),
    } as unknown as LoadedSettings;

    getAvailableCommandsSpy = vi.mocked(nonInteractiveCliCommands)
      .getAvailableCommands as unknown as ReturnType<typeof vi.fn>;
    getAvailableCommandsSpy.mockResolvedValue([]);

    session = new Session(
      'test-session-id',
      mockConfig,
      mockClient,
      mockSettings,
    );
  });

  afterEach(() => {
    // Reset global runtime base dir state to prevent state leakage between tests
    core.Storage.setRuntimeBaseDir(null);
    // Clear session reference to allow garbage collection
    session = undefined as unknown as Session;
    mockChat = undefined as unknown as GeminiChat;
    mockConfig = undefined as unknown as Config;
    mockClient = undefined as unknown as AgentSideConnection;
    mockSettings = undefined as unknown as LoadedSettings;
    mockGeminiClient = undefined as unknown as typeof mockGeminiClient;
    mockToolRegistry = undefined as unknown as typeof mockToolRegistry;
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  describe('setMode', () => {
    it.each([
      ['plan', ApprovalMode.PLAN],
      ['default', ApprovalMode.DEFAULT],
      ['auto-edit', ApprovalMode.AUTO_EDIT],
      ['yolo', ApprovalMode.YOLO],
    ] as const)('maps %s mode', async (modeId, expected) => {
      await session.setMode({
        sessionId: 'test-session-id',
        modeId,
      });

      expect(mockConfig.setApprovalMode).toHaveBeenCalledWith(expected);
    });
  });

  describe('setModel', () => {
    it('sets model via config and returns current model', async () => {
      const requested = `qwen3-coder-plus(${AuthType.USE_OPENAI})`;
      await session.setModel({
        sessionId: 'test-session-id',
        modelId: `  ${requested}  `,
      });

      expect(mockConfig.switchModel).toHaveBeenCalledWith(
        AuthType.USE_OPENAI,
        'qwen3-coder-plus',
        undefined,
      );
      expect(mockSettings.setValue).toHaveBeenCalledWith(
        SettingScope.User,
        'model.name',
        'qwen3-coder-plus',
      );
      expect(mockSettings.setValue).toHaveBeenCalledWith(
        SettingScope.User,
        'security.auth.selectedType',
        AuthType.USE_OPENAI,
      );
    });

    it('rejects empty/whitespace model IDs', async () => {
      await expect(
        session.setModel({
          sessionId: 'test-session-id',
          modelId: '   ',
        }),
      ).rejects.toThrow('Invalid params');

      expect(mockConfig.switchModel).not.toHaveBeenCalled();
      expect(mockSettings.setValue).not.toHaveBeenCalled();
    });

    it('can switch the session model without persisting a new default', async () => {
      await session.setModel(
        {
          sessionId: 'test-session-id',
          modelId: `qwen3-coder-flash(${AuthType.USE_OPENAI})`,
        },
        { persistDefault: false },
      );

      expect(mockConfig.switchModel).toHaveBeenCalledWith(
        AuthType.USE_OPENAI,
        'qwen3-coder-flash',
        undefined,
      );
      expect(mockSettings.setValue).not.toHaveBeenCalled();
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
      expect(mockSettings.setValue).not.toHaveBeenCalled();
    });
  });

  describe('sendAvailableCommandsUpdate', () => {
    it('sends available_commands_update from getAvailableCommands()', async () => {
      getAvailableCommandsSpy.mockResolvedValueOnce([
        {
          name: 'init',
          description: 'Initialize project context',
          kind: 'built-in',
          argumentHint: '[path]',
        },
      ]);

      await session.sendAvailableCommandsUpdate();

      expect(getAvailableCommandsSpy).toHaveBeenCalledWith(
        mockConfig,
        expect.any(AbortSignal),
        'acp',
      );
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
        sessionId: 'test-session-id',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            {
              name: 'init',
              description: 'Initialize project context',
              input: { hint: '[path]' },
            },
          ],
        },
      });
    });

    it('sets input for built-in commands with subCommands', async () => {
      getAvailableCommandsSpy.mockResolvedValueOnce([
        {
          name: 'export',
          description: 'Export conversation history',
          kind: 'built-in',
          subCommands: [
            { name: 'md', description: 'Export as markdown', kind: 'built-in' },
          ],
        },
      ]);

      await session.sendAvailableCommandsUpdate();

      expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
        sessionId: 'test-session-id',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            {
              name: 'export',
              description: 'Export conversation history',
              input: { hint: '' },
            },
          ],
        },
      });
    });

    it('attaches available skills to available_commands_update metadata', async () => {
      getAvailableCommandsSpy.mockResolvedValueOnce([
        {
          name: 'init',
          description: 'Initialize project context',
          kind: 'built-in',
        },
      ]);
      mockConfig.getSkillManager = vi.fn().mockReturnValue({
        listSkills: vi
          .fn()
          .mockResolvedValue([
            { name: 'code-review-expert' },
            { name: 'verification-pack' },
          ]),
      });

      await session.sendAvailableCommandsUpdate();

      expect(mockClient.sessionUpdate).toHaveBeenCalledTimes(1);
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
          _meta: {
            availableSkills: ['code-review-expert', 'verification-pack'],
          },
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
    describe('auto-compress', () => {
      it('runs automatic compression before sending an ACP prompt', async () => {
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        });

        expect(mockGeminiClient.tryCompressChat).toHaveBeenCalledWith(
          'test-session-id########1',
          false,
          expect.any(AbortSignal),
        );

        const sendMessageStream = mockChat.sendMessageStream as ReturnType<
          typeof vi.fn
        >;
        expectCompressBeforeSend(
          mockGeminiClient.tryCompressChat,
          sendMessageStream,
          0,
        );
      });

      it('uses the current chat after automatic compression replaces it', async () => {
        const compressedChat = {
          sendMessageStream: vi.fn().mockResolvedValue(createEmptyStream()),
          addHistory: vi.fn(),
          getHistory: vi.fn().mockReturnValue([]),
        } as unknown as GeminiChat;

        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());
        mockGeminiClient.tryCompressChat.mockImplementation(async () => {
          mockGeminiClient.getChat.mockReturnValue(compressedChat);
          return {
            originalTokenCount: 1000,
            newTokenCount: 200,
            compressionStatus: core.CompressionStatus.COMPRESSED,
          };
        });

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        });

        expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
        expect(compressedChat.sendMessageStream).toHaveBeenCalledWith(
          'qwen3-code-plus',
          {
            message: expect.any(Array),
            config: { abortSignal: expect.any(AbortSignal) },
          },
          'test-session-id########1',
        );
      });

      it('emits an ACP-visible update when automatic compression succeeds', async () => {
        mockGeminiClient.tryCompressChat.mockResolvedValueOnce({
          originalTokenCount: 1200,
          newTokenCount: 450,
          compressionStatus: core.CompressionStatus.COMPRESSED,
        });
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        });

        expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text:
                'IMPORTANT: This conversation approached the input token limit for qwen3-code-plus. ' +
                'A compressed context will be sent for future messages (compressed from: 1200 to 450 tokens).',
            },
          },
        });
      });

      it('continues sending when automatic compression fails', async () => {
        mockGeminiClient.tryCompressChat.mockRejectedValueOnce(
          new Error('compression rate limited'),
        );
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        });

        expect(mockGeminiClient.tryCompressChat).toHaveBeenCalledWith(
          'test-session-id########1',
          false,
          expect.any(AbortSignal),
        );
        expect(mockChat.sendMessageStream).toHaveBeenCalledWith(
          'qwen3-code-plus',
          {
            message: expect.any(Array),
            config: { abortSignal: expect.any(AbortSignal) },
          },
          'test-session-id########1',
        );
      });

      it('does not use global UI telemetry when compression fails before local token counts exist', async () => {
        mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(100);
        vi.spyOn(
          core.uiTelemetryService,
          'getLastPromptTokenCount',
        ).mockReturnValue(101);
        mockGeminiClient.tryCompressChat.mockRejectedValueOnce(
          new Error('compression rate limited'),
        );
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          }),
        ).resolves.toEqual({ stopReason: 'end_turn' });

        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
        expect(mockClient.sessionUpdate).not.toHaveBeenCalledWith(
          expect.objectContaining({
            update: expect.objectContaining({
              sessionUpdate: 'agent_message_chunk',
              content: expect.objectContaining({
                text: expect.stringContaining('Session token limit exceeded'),
              }),
            }),
          }),
        );
      });

      it('returns cancelled when automatic compression is aborted', async () => {
        mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(100);
        mockGeminiClient.tryCompressChat.mockImplementation(
          async (_promptId: string, _force: boolean, signal: AbortSignal) =>
            new Promise((_, reject) => {
              signal.addEventListener('abort', () => {
                const abortError = new Error('aborted');
                abortError.name = 'AbortError';
                reject(abortError);
              });
            }),
        );
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        const promptPromise = session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        });
        await vi.waitFor(() => {
          expect(mockGeminiClient.tryCompressChat).toHaveBeenCalled();
        });

        await session.cancelPendingPrompt();

        await expect(promptPromise).resolves.toEqual({
          stopReason: 'cancelled',
        });
        expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
        expect(mockChat.addHistory).toHaveBeenCalledWith({
          role: 'user',
          parts: expect.any(Array),
        });
        expect(mockClient.sessionUpdate).not.toHaveBeenCalledWith({
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text:
                'Session token limit exceeded: 101 tokens > 100 limit. ' +
                'Please start a new session or increase the sessionTokenLimit in your settings.json.',
            },
          },
        });
      });

      it('uses compression token info instead of global UI telemetry for the session limit', async () => {
        mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(100);
        vi.spyOn(
          core.uiTelemetryService,
          'getLastPromptTokenCount',
        ).mockReturnValue(999);
        mockGeminiClient.tryCompressChat.mockResolvedValueOnce({
          originalTokenCount: 50,
          newTokenCount: 50,
          compressionStatus: core.CompressionStatus.NOOP,
        });
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        });

        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
      });

      it('falls back to the previous prompt token count when compression returns zero token info', async () => {
        mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(100);
        mockGeminiClient.tryCompressChat.mockResolvedValue({
          originalTokenCount: 0,
          newTokenCount: 0,
          compressionStatus: core.CompressionStatus.NOOP,
        });
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  usageMetadata: {
                    totalTokenCount: 101,
                    promptTokenCount: 101,
                  },
                },
              },
            ]),
          )
          .mockResolvedValueOnce(createEmptyStream());

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'first' }],
          }),
        ).resolves.toEqual({ stopReason: 'end_turn' });
        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'second' }],
          }),
        ).resolves.toEqual({ stopReason: 'max_tokens' });

        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
      });

      it('falls back to the previous prompt token count when compressed token info is zero', async () => {
        mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(100);
        mockGeminiClient.tryCompressChat
          .mockResolvedValueOnce({
            originalTokenCount: 50,
            newTokenCount: 50,
            compressionStatus: core.CompressionStatus.NOOP,
          })
          .mockResolvedValueOnce({
            originalTokenCount: 1200,
            newTokenCount: 0,
            compressionStatus: core.CompressionStatus.COMPRESSED,
          });
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  usageMetadata: {
                    totalTokenCount: 101,
                    promptTokenCount: 101,
                  },
                },
              },
            ]),
          )
          .mockResolvedValueOnce(createEmptyStream());

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'first' }],
          }),
        ).resolves.toEqual({ stopReason: 'end_turn' });
        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'second' }],
          }),
        ).resolves.toEqual({ stopReason: 'max_tokens' });

        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
      });

      it('records prompt token count instead of total token count for later session-limit checks', async () => {
        mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(100);
        mockGeminiClient.tryCompressChat
          .mockResolvedValueOnce({
            originalTokenCount: 0,
            newTokenCount: 0,
            compressionStatus: core.CompressionStatus.NOOP,
          })
          .mockRejectedValueOnce(new Error('compression unavailable'));
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  usageMetadata: {
                    totalTokenCount: 500,
                    promptTokenCount: 50,
                  },
                },
              },
            ]),
          )
          .mockResolvedValueOnce(createEmptyStream());

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'long response' }],
          }),
        ).resolves.toEqual({ stopReason: 'end_turn' });
        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'next prompt' }],
          }),
        ).resolves.toEqual({ stopReason: 'end_turn' });

        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
      });

      it('resets the session-local token count when the active chat instance changes', async () => {
        const clearedChat = {
          sendMessageStream: vi.fn().mockResolvedValue(createEmptyStream()),
          addHistory: vi.fn(),
          getHistory: vi.fn().mockReturnValue([]),
        } as unknown as GeminiChat;
        mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(100);
        mockGeminiClient.tryCompressChat
          .mockResolvedValueOnce({
            originalTokenCount: 50,
            newTokenCount: 50,
            compressionStatus: core.CompressionStatus.NOOP,
          })
          .mockRejectedValueOnce(new Error('compression unavailable'));
        mockChat.sendMessageStream = vi.fn().mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                usageMetadata: {
                  totalTokenCount: 500,
                  promptTokenCount: 101,
                },
              },
            },
          ]),
        );

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'before clear' }],
          }),
        ).resolves.toEqual({ stopReason: 'end_turn' });

        mockGeminiClient.getChat.mockReturnValue(clearedChat);

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'after clear' }],
          }),
        ).resolves.toEqual({ stopReason: 'end_turn' });

        expect(clearedChat.sendMessageStream).toHaveBeenCalledTimes(1);
      });

      it('continues sending when the compression notification fails', async () => {
        mockGeminiClient.tryCompressChat.mockResolvedValueOnce({
          originalTokenCount: 1200,
          newTokenCount: 450,
          compressionStatus: core.CompressionStatus.COMPRESSED,
        });
        mockClient.sessionUpdate = vi
          .fn()
          .mockRejectedValueOnce(new Error('client disconnected'));
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        });

        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
      });

      it('stops before sending when the compressed prompt exceeds the session token limit', async () => {
        mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(100);
        mockGeminiClient.tryCompressChat.mockResolvedValueOnce({
          originalTokenCount: 1200,
          newTokenCount: 101,
          compressionStatus: core.CompressionStatus.COMPRESSED,
        });
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          }),
        ).resolves.toEqual({ stopReason: 'max_tokens' });

        expect(mockGeminiClient.tryCompressChat).toHaveBeenCalled();
        expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
        expect(mockChat.addHistory).not.toHaveBeenCalled();
        expect(mockClient.sessionUpdate).not.toHaveBeenCalledWith({
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text:
                'IMPORTANT: This conversation approached the input token limit for qwen3-code-plus. ' +
                'A compressed context will be sent for future messages (compressed from: 1200 to 101 tokens).',
            },
          },
        });
        expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text:
                'Session token limit exceeded: 101 tokens > 100 limit. ' +
                'Please start a new session or increase the sessionTokenLimit in your settings.json.',
            },
          },
        });
      });

      it('stops without throwing when the token-limit diagnostic fails', async () => {
        mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(100);
        mockGeminiClient.tryCompressChat.mockResolvedValueOnce({
          originalTokenCount: 101,
          newTokenCount: 101,
          compressionStatus: core.CompressionStatus.NOOP,
        });
        mockClient.sessionUpdate = vi
          .fn()
          .mockRejectedValueOnce(new Error('client disconnected'));
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          }),
        ).resolves.toEqual({ stopReason: 'max_tokens' });

        expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
        expect(mockChat.addHistory).not.toHaveBeenCalled();
      });

      it('also runs automatic compression before tool response follow-up sends', async () => {
        const executeSpy = vi.fn().mockResolvedValue({
          llmContent: 'file contents',
          returnDisplay: 'file contents',
        });
        const tool = {
          name: 'read_file',
          kind: core.Kind.Read,
          build: vi.fn().mockReturnValue({
            params: { path: '/tmp/test.txt' },
            getDefaultPermission: vi.fn().mockResolvedValue('allow'),
            getDescription: vi.fn().mockReturnValue('Read file'),
            toolLocations: vi.fn().mockReturnValue([]),
            execute: executeSpy,
          }),
        };

        mockToolRegistry.getTool.mockReturnValue(tool);
        mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  functionCalls: [
                    {
                      id: 'call-1',
                      name: 'read_file',
                      args: { path: '/tmp/test.txt' },
                    },
                  ],
                },
              },
            ]),
          )
          .mockResolvedValueOnce(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'read file' }],
        });

        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
        expect(mockGeminiClient.tryCompressChat).toHaveBeenCalledTimes(2);
        expect(mockGeminiClient.tryCompressChat).toHaveBeenNthCalledWith(
          2,
          'test-session-id########1',
          false,
          expect.any(AbortSignal),
        );

        const sendMessageStream = mockChat.sendMessageStream as ReturnType<
          typeof vi.fn
        >;
        expectCompressBeforeSend(
          mockGeminiClient.tryCompressChat,
          sendMessageStream,
          1,
        );
      });

      it('stops tool response follow-up before sending when the session token limit is exceeded', async () => {
        const executeSpy = vi.fn().mockResolvedValue({
          llmContent: 'file contents',
          returnDisplay: 'file contents',
        });
        const tool = {
          name: 'read_file',
          kind: core.Kind.Read,
          build: vi.fn().mockReturnValue({
            params: { path: '/tmp/test.txt' },
            getDefaultPermission: vi.fn().mockResolvedValue('allow'),
            getDescription: vi.fn().mockReturnValue('Read file'),
            toolLocations: vi.fn().mockReturnValue([]),
            execute: executeSpy,
          }),
        };

        mockToolRegistry.getTool.mockReturnValue(tool);
        mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
        mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(100);
        mockGeminiClient.tryCompressChat
          .mockResolvedValueOnce({
            originalTokenCount: 50,
            newTokenCount: 50,
            compressionStatus: core.CompressionStatus.NOOP,
          })
          .mockResolvedValueOnce({
            originalTokenCount: 101,
            newTokenCount: 101,
            compressionStatus: core.CompressionStatus.NOOP,
          });
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  functionCalls: [
                    {
                      id: 'call-1',
                      name: 'read_file',
                      args: { path: '/tmp/test.txt' },
                    },
                  ],
                },
              },
            ]),
          )
          .mockResolvedValueOnce(createEmptyStream());

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'read file' }],
          }),
        ).resolves.toEqual({ stopReason: 'max_tokens' });

        expect(executeSpy).toHaveBeenCalledTimes(1);
        expect(mockGeminiClient.tryCompressChat).toHaveBeenCalledTimes(2);
        expect(mockGeminiClient.tryCompressChat).toHaveBeenNthCalledWith(
          2,
          'test-session-id########1',
          false,
          expect.any(AbortSignal),
        );
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
        expect(mockChat.addHistory).toHaveBeenCalledWith({
          role: 'user',
          parts: [
            expect.objectContaining({
              functionResponse: expect.objectContaining({
                id: 'call-1',
                name: 'read_file',
              }),
            }),
          ],
        });
        expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text:
                'Session token limit exceeded: 101 tokens > 100 limit. ' +
                'Please start a new session or increase the sessionTokenLimit in your settings.json.',
            },
          },
        });
      });

      it('runs automatic compression before Stop-hook continuation sends', async () => {
        const messageBus = {
          request: vi
            .fn()
            .mockResolvedValueOnce({
              success: true,
              output: {
                decision: 'block',
                reason: 'Continue after Stop hook',
              },
            })
            .mockResolvedValueOnce({
              success: true,
              output: {},
            }),
        };
        mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
        mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
        mockConfig.hasHooksForEvent = vi
          .fn()
          .mockImplementation((eventName: string) => eventName === 'Stop');
        mockChat.getHistory = vi
          .fn()
          .mockReturnValue([
            { role: 'model', parts: [{ text: 'response text' }] },
          ]);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        });

        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
        expect(mockGeminiClient.tryCompressChat).toHaveBeenNthCalledWith(
          2,
          'test-session-id########1_stop_hook_1',
          false,
          expect.any(AbortSignal),
        );

        const sendMessageStream = mockChat.sendMessageStream as ReturnType<
          typeof vi.fn
        >;
        expectCompressBeforeSend(
          mockGeminiClient.tryCompressChat,
          sendMessageStream,
          1,
        );
      });

      it('skips automatic compression after the first Stop-hook continuation', async () => {
        const messageBus = {
          request: vi
            .fn()
            .mockResolvedValueOnce({
              success: true,
              output: {
                decision: 'block',
                reason: 'Continue after first Stop hook',
              },
            })
            .mockResolvedValueOnce({
              success: true,
              output: {
                decision: 'block',
                reason: 'Continue after second Stop hook',
              },
            })
            .mockResolvedValueOnce({
              success: true,
              output: {},
            }),
        };
        mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
        mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
        mockConfig.hasHooksForEvent = vi
          .fn()
          .mockImplementation((eventName: string) => eventName === 'Stop');
        mockChat.getHistory = vi
          .fn()
          .mockReturnValue([
            { role: 'model', parts: [{ text: 'response text' }] },
          ]);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        });

        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(3);
        expect(mockGeminiClient.tryCompressChat).toHaveBeenCalledTimes(2);
        expect(mockGeminiClient.tryCompressChat).toHaveBeenNthCalledWith(
          2,
          'test-session-id########1_stop_hook_1',
          false,
          expect.any(AbortSignal),
        );
        expect(mockGeminiClient.tryCompressChat).not.toHaveBeenCalledWith(
          'test-session-id########1_stop_hook_2',
          false,
          expect.any(AbortSignal),
        );

        const sendMessageStream = mockChat.sendMessageStream as ReturnType<
          typeof vi.fn
        >;
        expect(sendMessageStream.mock.calls[2]?.[2]).toBe(
          'test-session-id########1_stop_hook_2',
        );
      });

      it('stops Stop-hook continuation before sending when the session token limit is exceeded', async () => {
        const messageBus = {
          request: vi
            .fn()
            .mockResolvedValueOnce({
              success: true,
              output: {
                decision: 'block',
                reason: 'Continue after Stop hook',
              },
            })
            .mockResolvedValueOnce({
              success: true,
              output: {},
            }),
        };
        mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
        mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
        mockConfig.hasHooksForEvent = vi
          .fn()
          .mockImplementation((eventName: string) => eventName === 'Stop');
        mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(100);
        mockGeminiClient.tryCompressChat
          .mockResolvedValueOnce({
            originalTokenCount: 50,
            newTokenCount: 50,
            compressionStatus: core.CompressionStatus.NOOP,
          })
          .mockResolvedValueOnce({
            originalTokenCount: 101,
            newTokenCount: 101,
            compressionStatus: core.CompressionStatus.NOOP,
          });
        mockChat.getHistory = vi
          .fn()
          .mockReturnValue([
            { role: 'model', parts: [{ text: 'response text' }] },
          ]);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          }),
        ).resolves.toEqual({ stopReason: 'max_tokens' });

        expect(mockGeminiClient.tryCompressChat).toHaveBeenCalledTimes(2);
        expect(mockGeminiClient.tryCompressChat).toHaveBeenNthCalledWith(
          2,
          'test-session-id########1_stop_hook_1',
          false,
          expect.any(AbortSignal),
        );
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
        expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text:
                'Session token limit exceeded: 101 tokens > 100 limit. ' +
                'Please start a new session or increase the sessionTokenLimit in your settings.json.',
            },
          },
        });
      });

      it('runs automatic compression before cron-fired ACP prompt sends', async () => {
        const scheduler = {
          size: 1,
          start: vi.fn((callback: (job: { prompt: string }) => void) => {
            callback({ prompt: 'scheduled prompt' });
          }),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        });

        await vi.waitFor(() => {
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
        });

        expect(scheduler.start).toHaveBeenCalledTimes(1);
        expect(mockGeminiClient.tryCompressChat).toHaveBeenNthCalledWith(
          1,
          'test-session-id########1',
          false,
          expect.any(AbortSignal),
        );
        expect(mockGeminiClient.tryCompressChat).toHaveBeenNthCalledWith(
          2,
          expect.stringMatching(/^test-session-id########cron\d+$/),
          false,
          expect.any(AbortSignal),
        );

        const sendMessageStream = mockChat.sendMessageStream as ReturnType<
          typeof vi.fn
        >;
        expectCompressBeforeSend(
          mockGeminiClient.tryCompressChat,
          sendMessageStream,
          1,
        );
      });

      it('stops cron-fired ACP prompt before sending when the session token limit is exceeded', async () => {
        let cronCallback: ((job: { prompt: string }) => void) | undefined;
        const scheduler = {
          size: 1,
          start: vi.fn((callback: (job: { prompt: string }) => void) => {
            cronCallback = callback;
            callback({ prompt: 'scheduled prompt' });
          }),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(100);
        mockGeminiClient.tryCompressChat
          .mockResolvedValueOnce({
            originalTokenCount: 50,
            newTokenCount: 50,
            compressionStatus: core.CompressionStatus.NOOP,
          })
          .mockResolvedValueOnce({
            originalTokenCount: 101,
            newTokenCount: 101,
            compressionStatus: core.CompressionStatus.NOOP,
          });
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        });

        await vi.waitFor(() => {
          expect(mockGeminiClient.tryCompressChat).toHaveBeenCalledTimes(2);
        });

        expect(scheduler.start).toHaveBeenCalledTimes(1);
        expect(mockGeminiClient.tryCompressChat).toHaveBeenNthCalledWith(
          2,
          expect.stringMatching(/^test-session-id########cron\d+$/),
          false,
          expect.any(AbortSignal),
        );
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
        expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text:
                'Session token limit exceeded: 101 tokens > 100 limit. ' +
                'Please start a new session or increase the sessionTokenLimit in your settings.json.',
            },
          },
        });
        expect(scheduler.stop).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => {
          expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
            sessionId: 'test-session-id',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Cron jobs disabled for the rest of this session due to token limit. Restart the session to re-enable.',
              },
            },
          });
        });

        const sessionUpdateMock = mockClient.sessionUpdate as ReturnType<
          typeof vi.fn
        >;
        const tokenLimitDiagnosticCount = () =>
          sessionUpdateMock.mock.calls.filter((call) => {
            const notification = call[0] as {
              update?: {
                sessionUpdate?: string;
                content?: { type?: string; text?: string };
              };
            };
            return (
              notification.update?.sessionUpdate === 'agent_message_chunk' &&
              notification.update.content?.type === 'text' &&
              notification.update.content.text?.includes(
                'Session token limit exceeded',
              )
            );
          }).length;
        const diagnosticCountBefore = tokenLimitDiagnosticCount();

        cronCallback?.({ prompt: 'scheduled prompt again' });
        await Promise.resolve();

        expect(mockGeminiClient.tryCompressChat).toHaveBeenCalledTimes(2);
        expect(tokenLimitDiagnosticCount()).toBe(diagnosticCountBefore);
      });

      it('does not auto-compress slash commands handled without a model send', async () => {
        vi.mocked(
          nonInteractiveCliCommands.handleSlashCommand,
        ).mockResolvedValueOnce({
          type: 'message',
          messageType: 'info',
          content: 'Already compressed.',
        });
        mockChat.sendMessageStream = vi.fn();

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: '/compress' }],
        });

        expect(mockGeminiClient.tryCompressChat).not.toHaveBeenCalled();
        expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
      });
    });

    it('passes resolved paths to read_many_files tool', async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'qwen-acp-session-'),
      );
      const fileName = 'README.md';
      const filePath = path.join(tempDir, fileName);

      const readManyFilesSpy = vi
        .spyOn(core, 'readManyFiles')
        .mockResolvedValue({
          contentParts: 'file content',
          files: [],
        });

      try {
        await fs.writeFile(filePath, '# Test\n', 'utf8');

        mockConfig.getTargetDir = vi.fn().mockReturnValue(tempDir);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        const promptRequest: PromptRequest = {
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
        readManyFilesSpy.mockRestore();
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('runs prompt inside runtime output dir context', async () => {
      const runtimeDir = path.resolve('runtime', 'from-settings');
      core.Storage.setRuntimeBaseDir(runtimeDir);
      session = new Session(
        'test-session-id',
        mockConfig,
        mockClient,
        mockSettings,
      );
      const runWithRuntimeBaseDirSpy = vi.spyOn(
        core.Storage,
        'runWithRuntimeBaseDir',
      );

      try {
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        const promptRequest: PromptRequest = {
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        };

        await session.prompt(promptRequest);

        expect(runWithRuntimeBaseDirSpy).toHaveBeenCalledWith(
          runtimeDir,
          process.cwd(),
          expect.any(Function),
        );
      } finally {
        runWithRuntimeBaseDirSpy.mockRestore();
      }
    });

    it('hides allow-always options when confirmation already forbids them', async () => {
      const executeSpy = vi.fn().mockResolvedValue({
        llmContent: 'ok',
        returnDisplay: 'ok',
      });
      const onConfirmSpy = vi.fn().mockResolvedValue(undefined);
      const invocation = {
        params: { path: '/tmp/file.txt' },
        getDefaultPermission: vi.fn().mockResolvedValue('ask'),
        getConfirmationDetails: vi.fn().mockResolvedValue({
          type: 'info',
          title: 'Need permission',
          prompt: 'Allow?',
          hideAlwaysAllow: true,
          onConfirm: onConfirmSpy,
        }),
        getDescription: vi.fn().mockReturnValue('Inspect file'),
        toolLocations: vi.fn().mockReturnValue([]),
        execute: executeSpy,
      };
      const tool = {
        name: 'read_file',
        kind: core.Kind.Read,
        build: vi.fn().mockReturnValue(invocation),
      };

      mockToolRegistry.getTool.mockReturnValue(tool);
      mockConfig.getApprovalMode = vi
        .fn()
        .mockReturnValue(ApprovalMode.DEFAULT);
      mockConfig.getPermissionManager = vi.fn().mockReturnValue(null);
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              functionCalls: [
                {
                  id: 'call-1',
                  name: 'read_file',
                  args: { path: '/tmp/file.txt' },
                },
              ],
            },
          },
        ]),
      );

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'run tool' }],
      });

      expect(mockClient.requestPermission).toHaveBeenCalledWith(
        expect.objectContaining({
          options: [
            expect.objectContaining({ kind: 'allow_once' }),
            expect.objectContaining({ kind: 'reject_once' }),
          ],
        }),
      );
      const options = (mockClient.requestPermission as ReturnType<typeof vi.fn>)
        .mock.calls[0][0].options as Array<{ kind: string }>;
      expect(options.some((option) => option.kind === 'allow_always')).toBe(
        false,
      );
    });

    it('allows info confirmation tools in plan mode', async () => {
      const executeSpy = vi.fn().mockResolvedValue({
        llmContent: 'ok',
        returnDisplay: 'ok',
      });
      const onConfirmSpy = vi.fn().mockResolvedValue(undefined);
      const invocation = {
        params: {
          url: 'https://example.com/docs',
          prompt: 'Summarize the docs',
        },
        getDefaultPermission: vi.fn().mockResolvedValue('ask'),
        getConfirmationDetails: vi.fn().mockResolvedValue({
          type: 'info',
          title: 'Confirm Web Fetch',
          prompt: 'Allow fetching docs?',
          urls: ['https://example.com/docs'],
          onConfirm: onConfirmSpy,
        }),
        getDescription: vi.fn().mockReturnValue('Fetch docs'),
        toolLocations: vi.fn().mockReturnValue([]),
        execute: executeSpy,
      };
      const tool = {
        name: 'web_fetch',
        kind: core.Kind.Fetch,
        build: vi.fn().mockReturnValue(invocation),
      };

      mockToolRegistry.getTool.mockReturnValue(tool);
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);
      mockConfig.getPermissionManager = vi.fn().mockReturnValue(null);
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              functionCalls: [
                {
                  id: 'call-info-plan',
                  name: 'web_fetch',
                  args: {
                    url: 'https://example.com/docs',
                    prompt: 'Summarize the docs',
                  },
                },
              ],
            },
          },
        ]),
      );

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'research the docs first' }],
      });

      expect(mockClient.requestPermission).toHaveBeenCalled();
      expect(onConfirmSpy).toHaveBeenCalledWith(
        core.ToolConfirmationOutcome.ProceedOnce,
        { answers: undefined },
      );
      expect(executeSpy).toHaveBeenCalled();
    });

    it('returns permission error for disabled tools (L1 isToolEnabled check)', async () => {
      const executeSpy = vi.fn();
      const invocation = {
        params: { path: '/tmp/file.txt' },
        getDefaultPermission: vi.fn().mockResolvedValue('ask'),
        getConfirmationDetails: vi.fn().mockResolvedValue({
          type: 'info',
          title: 'Need permission',
          prompt: 'Allow?',
          onConfirm: vi.fn(),
        }),
        getDescription: vi.fn().mockReturnValue('Write file'),
        toolLocations: vi.fn().mockReturnValue([]),
        execute: executeSpy,
      };
      const tool = {
        name: 'write_file',
        kind: core.Kind.Edit,
        build: vi.fn().mockReturnValue(invocation),
      };

      mockToolRegistry.getTool.mockReturnValue(tool);
      mockConfig.getApprovalMode = vi
        .fn()
        .mockReturnValue(ApprovalMode.DEFAULT);
      // Mock a PermissionManager that denies the tool
      mockConfig.getPermissionManager = vi.fn().mockReturnValue({
        isToolEnabled: vi.fn().mockResolvedValue(false),
      });
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              functionCalls: [
                {
                  id: 'call-denied',
                  name: 'write_file',
                  args: { path: '/tmp/file.txt' },
                },
              ],
            },
          },
        ]),
      );

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'write something' }],
      });

      // Tool should NOT have been executed
      expect(executeSpy).not.toHaveBeenCalled();
      // No permission dialog should have been opened
      expect(mockClient.requestPermission).not.toHaveBeenCalled();
    });

    it('respects permission-request hook allow decisions without opening ACP permission dialog', async () => {
      const hookSpy = vi
        .spyOn(core, 'firePermissionRequestHook')
        .mockResolvedValue({
          hasDecision: true,
          shouldAllow: true,
          updatedInput: { path: '/tmp/updated.txt' },
          denyMessage: undefined,
        });
      const executeSpy = vi.fn().mockResolvedValue({
        llmContent: 'ok',
        returnDisplay: 'ok',
      });
      const onConfirmSpy = vi.fn().mockResolvedValue(undefined);
      const invocation = {
        params: { path: '/tmp/original.txt' },
        getDefaultPermission: vi.fn().mockResolvedValue('ask'),
        getConfirmationDetails: vi.fn().mockResolvedValue({
          type: 'info',
          title: 'Need permission',
          prompt: 'Allow?',
          onConfirm: onConfirmSpy,
        }),
        getDescription: vi.fn().mockReturnValue('Inspect file'),
        toolLocations: vi.fn().mockReturnValue([]),
        execute: executeSpy,
      };
      const tool = {
        name: 'read_file',
        kind: core.Kind.Read,
        build: vi.fn().mockReturnValue(invocation),
      };

      mockToolRegistry.getTool.mockReturnValue(tool);
      mockConfig.getApprovalMode = vi
        .fn()
        .mockReturnValue(ApprovalMode.DEFAULT);
      mockConfig.getPermissionManager = vi.fn().mockReturnValue(null);
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
      mockConfig.getMessageBus = vi.fn().mockReturnValue({});
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              functionCalls: [
                {
                  id: 'call-2',
                  name: 'read_file',
                  args: { path: '/tmp/original.txt' },
                },
              ],
            },
          },
        ]),
      );

      try {
        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'run tool' }],
        });
      } finally {
        hookSpy.mockRestore();
      }

      expect(mockClient.requestPermission).not.toHaveBeenCalled();
      expect(onConfirmSpy).toHaveBeenCalledWith(
        core.ToolConfirmationOutcome.ProceedOnce,
      );
      expect(invocation.params).toEqual({ path: '/tmp/updated.txt' });
      expect(executeSpy).toHaveBeenCalled();
    });

    describe('hooks', () => {
      describe('UserPromptSubmit hook', () => {
        it('fires UserPromptSubmit hook before sending prompt', async () => {
          const messageBus = {
            request: vi.fn().mockResolvedValue({
              success: true,
              output: {},
            }),
          };
          mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.hasHooksForEvent = vi.fn().mockReturnValue(true);

          mockChat.sendMessageStream = vi.fn().mockResolvedValue(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  candidates: [{ content: { parts: [{ text: 'response' }] } }],
                },
              },
            ]),
          );

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          expect(messageBus.request).toHaveBeenCalledWith(
            expect.objectContaining({
              eventName: 'UserPromptSubmit',
              input: { prompt: 'hello' },
            }),
            expect.anything(),
          );
        });

        it('blocks prompt when UserPromptSubmit hook returns blocking decision', async () => {
          const messageBus = {
            request: vi.fn().mockResolvedValue({
              success: true,
              output: { decision: 'block', reason: 'Blocked by hook' },
            }),
          };
          mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.hasHooksForEvent = vi.fn().mockReturnValue(true);

          mockChat.sendMessageStream = vi.fn();

          const result = await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'blocked prompt' }],
          });

          expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
          expect(result.stopReason).toBe('end_turn');
        });
      });

      describe('Stop hook', () => {
        it('fires Stop hook after model response completes', async () => {
          const messageBus = {
            request: vi.fn().mockResolvedValue({
              success: true,
              output: {},
            }),
          };
          mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.hasHooksForEvent = vi.fn().mockReturnValue(true);
          mockChat.getHistory = vi
            .fn()
            .mockReturnValue([
              { role: 'model', parts: [{ text: 'response text' }] },
            ]);

          mockChat.sendMessageStream = vi.fn().mockResolvedValue(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  candidates: [{ content: { parts: [{ text: 'response' }] } }],
                },
              },
            ]),
          );

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          expect(messageBus.request).toHaveBeenCalledWith(
            expect.objectContaining({
              eventName: 'Stop',
              input: expect.objectContaining({
                stop_hook_active: true,
                last_assistant_message: 'response text',
              }),
            }),
            expect.anything(),
          );
        });
      });

      describe('PreToolUse hook', () => {
        it('fires PreToolUse hook before tool execution', async () => {
          const messageBus = {
            request: vi.fn().mockResolvedValue({
              success: true,
              output: {},
            }),
          };
          mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.getApprovalMode = vi
            .fn()
            .mockReturnValue(ApprovalMode.YOLO);

          const executeSpy = vi.fn().mockResolvedValue({
            llmContent: 'result',
            returnDisplay: 'done',
          });
          const tool = {
            name: 'read_file',
            kind: core.Kind.Read,
            build: vi.fn().mockReturnValue({
              params: { path: '/tmp/test.txt' },
              getDefaultPermission: vi.fn().mockResolvedValue('allow'),
              execute: executeSpy,
            }),
          };

          mockToolRegistry.getTool.mockReturnValue(tool);
          mockChat.sendMessageStream = vi.fn().mockResolvedValue(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  functionCalls: [
                    {
                      id: 'call-1',
                      name: 'read_file',
                      args: { path: '/tmp/test.txt' },
                    },
                  ],
                },
              },
            ]),
          );

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'read the file' }],
          });

          expect(messageBus.request).toHaveBeenCalledWith(
            expect.objectContaining({
              eventName: 'PreToolUse',
              input: expect.objectContaining({
                tool_name: 'read_file',
                tool_input: { path: '/tmp/test.txt' },
              }),
            }),
            expect.anything(),
          );
        });

        it('blocks tool execution when PreToolUse hook returns blocking decision', async () => {
          const messageBus = {
            request: vi.fn().mockResolvedValue({
              success: true,
              output: { decision: 'deny', reason: 'Tool blocked by hook' },
            }),
          };
          mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.getApprovalMode = vi
            .fn()
            .mockReturnValue(ApprovalMode.YOLO);

          const executeSpy = vi.fn();
          const tool = {
            name: 'read_file',
            kind: core.Kind.Read,
            build: vi.fn().mockReturnValue({
              params: { path: '/tmp/test.txt' },
              getDefaultPermission: vi.fn().mockResolvedValue('allow'),
              execute: executeSpy,
            }),
          };

          mockToolRegistry.getTool.mockReturnValue(tool);
          mockChat.sendMessageStream = vi.fn().mockResolvedValue(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  functionCalls: [
                    {
                      id: 'call-1',
                      name: 'read_file',
                      args: { path: '/tmp/test.txt' },
                    },
                  ],
                },
              },
            ]),
          );

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'read the file' }],
          });

          expect(executeSpy).not.toHaveBeenCalled();
        });
      });

      describe('PostToolUse hook', () => {
        it('fires PostToolUse hook after successful tool execution', async () => {
          const messageBus = {
            request: vi.fn().mockResolvedValue({
              success: true,
              output: {},
            }),
          };
          mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.getApprovalMode = vi
            .fn()
            .mockReturnValue(ApprovalMode.YOLO);

          const executeSpy = vi.fn().mockResolvedValue({
            llmContent: 'file contents',
            returnDisplay: 'success',
          });
          const tool = {
            name: 'read_file',
            kind: core.Kind.Read,
            build: vi.fn().mockReturnValue({
              params: { path: '/tmp/test.txt' },
              getDefaultPermission: vi.fn().mockResolvedValue('allow'),
              execute: executeSpy,
            }),
          };

          mockToolRegistry.getTool.mockReturnValue(tool);
          mockChat.sendMessageStream = vi.fn().mockResolvedValue(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  functionCalls: [
                    {
                      id: 'call-1',
                      name: 'read_file',
                      args: { path: '/tmp/test.txt' },
                    },
                  ],
                },
              },
            ]),
          );

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'read the file' }],
          });

          expect(messageBus.request).toHaveBeenCalledWith(
            expect.objectContaining({
              eventName: 'PostToolUse',
              input: expect.objectContaining({
                tool_name: 'read_file',
                tool_response: expect.objectContaining({
                  llmContent: 'file contents',
                  returnDisplay: 'success',
                }),
              }),
            }),
            expect.anything(),
          );
        });

        it('stops execution when PostToolUse hook returns shouldStop', async () => {
          const messageBus = {
            request: vi.fn().mockResolvedValue({
              success: true,
              output: { shouldStop: true, reason: 'Stopping per hook request' },
            }),
          };
          mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.getApprovalMode = vi
            .fn()
            .mockReturnValue(ApprovalMode.YOLO);

          const executeSpy = vi.fn().mockResolvedValue({
            llmContent: 'file contents',
            returnDisplay: 'success',
          });
          const tool = {
            name: 'read_file',
            kind: core.Kind.Read,
            build: vi.fn().mockReturnValue({
              params: { path: '/tmp/test.txt' },
              getDefaultPermission: vi.fn().mockResolvedValue('allow'),
              execute: executeSpy,
            }),
          };

          mockToolRegistry.getTool.mockReturnValue(tool);

          // Only one call expected since shouldStop prevents continuation
          mockChat.sendMessageStream = vi.fn().mockResolvedValue(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  functionCalls: [
                    {
                      id: 'call-1',
                      name: 'read_file',
                      args: { path: '/tmp/test.txt' },
                    },
                  ],
                },
              },
            ]),
          );

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'read the file' }],
          });

          // Tool should have been executed
          expect(executeSpy).toHaveBeenCalled();
          // PostToolUse hook should have been called
          expect(messageBus.request).toHaveBeenCalledWith(
            expect.objectContaining({
              eventName: 'PostToolUse',
            }),
            expect.anything(),
          );
        });
      });

      describe('PostToolUseFailure hook', () => {
        it('fires PostToolUseFailure hook when tool execution fails', async () => {
          const messageBus = {
            request: vi.fn().mockResolvedValue({
              success: true,
              output: {},
            }),
          };
          mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.getApprovalMode = vi
            .fn()
            .mockReturnValue(ApprovalMode.YOLO);

          const executeSpy = vi
            .fn()
            .mockRejectedValue(new Error('Tool failed'));
          const tool = {
            name: 'read_file',
            kind: core.Kind.Read,
            build: vi.fn().mockReturnValue({
              params: { path: '/tmp/test.txt' },
              getDefaultPermission: vi.fn().mockResolvedValue('allow'),
              execute: executeSpy,
            }),
          };

          mockToolRegistry.getTool.mockReturnValue(tool);
          mockChat.sendMessageStream = vi.fn().mockResolvedValue(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  functionCalls: [
                    {
                      id: 'call-1',
                      name: 'read_file',
                      args: { path: '/tmp/test.txt' },
                    },
                  ],
                },
              },
            ]),
          );

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'read the file' }],
          });

          expect(messageBus.request).toHaveBeenCalledWith(
            expect.objectContaining({
              eventName: 'PostToolUseFailure',
              input: expect.objectContaining({
                tool_name: 'read_file',
                error: 'Tool failed',
              }),
            }),
            expect.anything(),
          );
        });
      });

      describe('StopFailure hook', () => {
        it('fires StopFailure hook when API error occurs during sendMessageStream', async () => {
          const mockFireStopFailureEvent = vi.fn().mockResolvedValue({
            success: true,
          });
          mockConfig.getHookSystem = vi.fn().mockReturnValue({
            fireStopFailureEvent: mockFireStopFailureEvent,
          });
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.hasHooksForEvent = vi.fn().mockReturnValue(true);

          // Simulate API error (rate limit)
          const apiError = new Error('Rate limit exceeded') as Error & {
            status: number;
          };
          apiError.status = 429;

          mockChat.sendMessageStream = vi.fn().mockImplementation(async () => {
            throw apiError;
          });

          await expect(
            session.prompt({
              sessionId: 'test-session-id',
              prompt: [{ type: 'text', text: 'hello' }],
            }),
          ).rejects.toThrow();

          // StopFailure hook should be called with rate_limit error type
          expect(mockFireStopFailureEvent).toHaveBeenCalledWith(
            'rate_limit',
            'Rate limit exceeded',
          );
        });

        it('does not fire StopFailure hook when hooks are disabled', async () => {
          const mockFireStopFailureEvent = vi.fn();
          mockConfig.getHookSystem = vi.fn().mockReturnValue({
            fireStopFailureEvent: mockFireStopFailureEvent,
          });
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(true);

          const apiError = new Error('Rate limit exceeded') as Error & {
            status: number;
          };
          apiError.status = 429;

          mockChat.sendMessageStream = vi.fn().mockImplementation(async () => {
            throw apiError;
          });

          await expect(
            session.prompt({
              sessionId: 'test-session-id',
              prompt: [{ type: 'text', text: 'hello' }],
            }),
          ).rejects.toThrow();

          expect(mockFireStopFailureEvent).not.toHaveBeenCalled();
        });
      });
    });

    describe('tool call concurrency', () => {
      it('runs multiple Agent tool calls concurrently (issue #2516)', async () => {
        // Each Agent call has two controllable async boundaries:
        //   - `called`  — resolves *when* the test code reaches `execute()`
        //   - `result`  — the promise `execute()` returns, resolved by the
        //                 test after observing both `called` signals.
        //
        // Under the old sequential for-loop, call-b's `execute()` would
        // only run after call-a's `execute()` promise resolved — so the
        // `await Promise.all([called-a, called-b])` below deadlocks and
        // the test hits vitest's default per-test timeout. Under the
        // concurrent implementation both `called` signals fire before
        // either `result` is resolved.
        type Deferred<T> = {
          promise: Promise<T>;
          resolve: (v: T) => void;
        };
        const makeDeferred = <T>(): Deferred<T> => {
          let resolve!: (v: T) => void;
          const promise = new Promise<T>((r) => {
            resolve = r;
          });
          return { promise, resolve };
        };

        const called: Record<string, Deferred<void>> = {
          'call-a': makeDeferred<void>(),
          'call-b': makeDeferred<void>(),
        };
        const result: Record<string, Deferred<core.ToolResult>> = {
          'call-a': makeDeferred<core.ToolResult>(),
          'call-b': makeDeferred<core.ToolResult>(),
        };

        const agentTool = {
          name: core.ToolNames.AGENT,
          kind: core.Kind.Think,
          build: vi.fn().mockImplementation((args: Record<string, unknown>) => {
            const id = args['_test_id'] as string;
            return {
              params: args,
              eventEmitter: undefined,
              getDefaultPermission: vi.fn().mockResolvedValue('allow'),
              getDescription: vi.fn().mockReturnValue(`agent ${id}`),
              toolLocations: vi.fn().mockReturnValue([]),
              execute: vi.fn().mockImplementation(() => {
                called[id].resolve();
                return result[id].promise;
              }),
            };
          }),
        };

        mockToolRegistry.getTool.mockImplementation((name: string) =>
          name === core.ToolNames.AGENT ? agentTool : undefined,
        );
        mockConfig.getApprovalMode = vi
          .fn()
          .mockReturnValue(ApprovalMode.DEFAULT);
        mockConfig.getPermissionManager = vi.fn().mockReturnValue(null);

        // Model returns two Agent calls, then an empty stream once results
        // are fed back (to terminate the prompt loop).
        const sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  functionCalls: [
                    {
                      id: 'call-a',
                      name: core.ToolNames.AGENT,
                      args: { _test_id: 'call-a', subagent_type: 'explore' },
                    },
                    {
                      id: 'call-b',
                      name: core.ToolNames.AGENT,
                      args: { _test_id: 'call-b', subagent_type: 'explore' },
                    },
                  ],
                },
              },
            ]),
          )
          .mockResolvedValueOnce(createEmptyStream());
        mockChat.sendMessageStream = sendMessageStream;

        const promptPromise = session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'spawn two agents' }],
        });

        // Wait until both `execute()` bodies have been entered. Sequential
        // behaviour deadlocks here → vitest times out the test → failure.
        await Promise.all([called['call-a'].promise, called['call-b'].promise]);

        // Resolve out of order to also verify that final part ordering
        // follows the original functionCalls order, not resolution order.
        result['call-b'].resolve({ llmContent: 'B-done', returnDisplay: 'B' });
        result['call-a'].resolve({ llmContent: 'A-done', returnDisplay: 'A' });

        await promptPromise;

        // The second sendMessageStream invocation carries the tool responses
        // that will be fed back to the model — assert their order matches
        // the original function-call order (A before B).
        expect(sendMessageStream).toHaveBeenCalledTimes(2);
        const followUp = sendMessageStream.mock.calls[1][1] as {
          message: Array<{ functionResponse?: { id?: string } }>;
        };
        const ids = followUp.message
          .filter((p) => p.functionResponse)
          .map((p) => p.functionResponse?.id);
        expect(ids).toEqual(['call-a', 'call-b']);
      });
    });

    describe('system reminders', () => {
      // Captures the `message` parts fed into chat.sendMessageStream on the
      // first turn so individual tests can assert what the model saw.
      const captureFirstTurnMessage = () => {
        const capture: { parts: Array<{ text?: string }> } = { parts: [] };
        (mockChat.sendMessageStream as ReturnType<typeof vi.fn>) = vi
          .fn()
          .mockImplementation(async (_model, req) => {
            capture.parts = req.message ?? [];
            return createEmptyStream();
          });
        return capture;
      };

      const stubEmptySubagents = () => {
        (mockConfig as unknown as Record<string, unknown>)[
          'getSubagentManager'
        ] = vi.fn().mockReturnValue({
          listSubagents: vi.fn().mockResolvedValue([]),
        });
        // ensureTool is called on the result of getToolRegistry(); add it.
        (
          mockToolRegistry as unknown as { ensureTool: () => Promise<boolean> }
        ).ensureTool = vi.fn().mockResolvedValue(true);
      };

      it('prepends plan-mode reminder when approval mode is PLAN (#1151)', async () => {
        stubEmptySubagents();
        mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);
        const capture = captureFirstTurnMessage();

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'research this' }],
        });

        const reminderPart = capture.parts.find(
          (p) => p.text && p.text.includes('Plan mode is active'),
        );
        expect(reminderPart).toBeTruthy();
        expect(reminderPart!.text).toContain('exit_plan_mode');
        // Reminder comes before the user text, matching client.ts ordering.
        const reminderIdx = capture.parts.indexOf(reminderPart!);
        const userIdx = capture.parts.findIndex(
          (p) => p.text === 'research this',
        );
        expect(reminderIdx).toBeLessThan(userIdx);
      });

      it('does not prepend plan-mode reminder in default approval mode', async () => {
        stubEmptySubagents();
        mockConfig.getApprovalMode = vi
          .fn()
          .mockReturnValue(ApprovalMode.DEFAULT);
        const capture = captureFirstTurnMessage();

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hi' }],
        });

        const hasPlanReminder = capture.parts.some(
          (p) => p.text && p.text.includes('Plan mode is active'),
        );
        expect(hasPlanReminder).toBe(false);
      });

      it('prepends subagent reminder when user-level subagents exist', async () => {
        (mockConfig as unknown as Record<string, unknown>)[
          'getSubagentManager'
        ] = vi.fn().mockReturnValue({
          listSubagents: vi.fn().mockResolvedValue([
            { name: 'researcher', level: 'user' },
            { name: 'planner', level: 'project' },
            // builtin entries are filtered out, matching client.ts:853.
            { name: 'builtin-helper', level: 'builtin' },
          ]),
        });
        (
          mockToolRegistry as unknown as { ensureTool: () => Promise<boolean> }
        ).ensureTool = vi.fn().mockResolvedValue(true);
        mockConfig.getApprovalMode = vi
          .fn()
          .mockReturnValue(ApprovalMode.DEFAULT);
        const capture = captureFirstTurnMessage();

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hi' }],
        });

        const reminder = capture.parts.find(
          (p) =>
            p.text &&
            p.text.includes('researcher') &&
            p.text.includes('planner'),
        );
        expect(reminder).toBeTruthy();
        expect(reminder!.text).not.toContain('builtin-helper');
      });
    });
  });
});

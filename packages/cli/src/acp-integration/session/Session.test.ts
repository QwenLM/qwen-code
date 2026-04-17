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
import type {
  AgentSideConnection,
  PromptRequest,
} from '@agentclientprotocol/sdk';
import type { LoadedSettings } from '../../config/settings.js';
import * as nonInteractiveCliCommands from '../../nonInteractiveCliCommands.js';

vi.mock('../../nonInteractiveCliCommands.js', () => ({
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
  let mockToolRegistry: { getTool: ReturnType<typeof vi.fn> };

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

    mockToolRegistry = { getTool: vi.fn() };
    const fileService = { shouldGitIgnoreFile: vi.fn().mockReturnValue(false) };

    mockConfig = {
      setApprovalMode: vi.fn(),
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
      }),
      getToolRegistry: vi.fn().mockReturnValue(mockToolRegistry),
      getFileService: vi.fn().mockReturnValue(fileService),
      getFileFilteringRespectGitIgnore: vi.fn().mockReturnValue(true),
      getEnableRecursiveFileSearch: vi.fn().mockReturnValue(false),
      getTargetDir: vi.fn().mockReturnValue(process.cwd()),
      getDebugMode: vi.fn().mockReturnValue(false),
      getAuthType: vi.fn().mockImplementation(() => currentAuthType),
      isCronEnabled: vi.fn().mockReturnValue(false),
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

  afterEach(() => {
    // Reset global runtime base dir state to prevent state leakage between tests
    core.Storage.setRuntimeBaseDir(null);
    // Clear session reference to allow garbage collection
    session = undefined as unknown as Session;
    mockChat = undefined as unknown as GeminiChat;
    mockConfig = undefined as unknown as Config;
    mockClient = undefined as unknown as AgentSideConnection;
    mockSettings = undefined as unknown as LoadedSettings;
    mockToolRegistry = undefined as unknown as {
      getTool: ReturnType<typeof vi.fn>;
    };
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
        mockChat,
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
  });
});

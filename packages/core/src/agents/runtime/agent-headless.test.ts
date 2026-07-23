/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Content,
  FunctionCall,
  FunctionDeclaration,
  GenerateContentConfig,
  Part,
} from '@google/genai';
import { Type } from '@google/genai';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { Config, type ConfigParameters } from '../../config/config.js';
import { DEFAULT_QWEN_MODEL } from '../../config/models.js';
import {
  createContentGenerator,
  createContentGeneratorConfig,
  resolveContentGeneratorConfigWithSources,
  AuthType,
} from '../../core/contentGenerator.js';
import { GeminiChat } from '../../core/geminiChat.js';
import { normalizeModelToolCallIds } from '../../core/toolCallIdUtils.js';
import { executeToolCall } from '../../core/nonInteractiveToolExecutor.js';
import type { ToolRegistry } from '../../tools/tool-registry.js';
import { type AnyDeclarativeTool } from '../../tools/tools.js';
import {
  ContextState,
  AgentHeadless,
  templateString,
} from './agent-headless.js';
import {
  AgentEventEmitter,
  AgentEventType,
  type AgentRoundTextEvent,
  type AgentStreamTextEvent,
  type AgentToolCallEvent,
  type AgentToolResultEvent,
} from './agent-events.js';
import type {
  ModelConfig,
  PromptConfig,
  RunConfig,
  ToolConfig,
} from './agent-types.js';
import { AgentTerminateMode } from './agent-types.js';
import { WriteFileTool } from '../../tools/write-file.js';
import { getEnvironmentContext } from '../../utils/environmentContext.js';

vi.mock('../../core/geminiChat.js');
vi.mock('../../core/contentGenerator.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../core/contentGenerator.js')>();
  const { DEFAULT_QWEN_MODEL } = await import('../../config/models.js');
  return {
    ...actual,
    createContentGenerator: vi.fn().mockResolvedValue({
      generateContent: vi.fn(),
      generateContentStream: vi.fn(),
      countTokens: vi.fn().mockResolvedValue({ totalTokens: 100 }),
      embedContent: vi.fn(),
      useSummarizedThinking: vi.fn().mockReturnValue(false),
    }),
    createContentGeneratorConfig: vi.fn().mockReturnValue({
      model: DEFAULT_QWEN_MODEL,
      authType: actual.AuthType.USE_GEMINI,
    }),
    resolveContentGeneratorConfigWithSources: vi.fn().mockReturnValue({
      config: {
        model: DEFAULT_QWEN_MODEL,
        authType: actual.AuthType.USE_GEMINI,
        apiKey: 'test-api-key',
      },
      sources: {},
    }),
  };
});
vi.mock('../../utils/environmentContext.js', () => ({
  SYSTEM_REMINDER_OPEN: '<system-reminder>',
  getEnvironmentContext: vi.fn().mockResolvedValue([{ text: 'Env Context' }]),
  buildMcpServerInstructionsPrompt: vi.fn().mockReturnValue(null),
  buildDeferredToolsPrompt: vi.fn().mockReturnValue(null),
  buildAvailableSkillsPrompt: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../core/nonInteractiveToolExecutor.js');
vi.mock('../../ide/ide-client.js');
vi.mock('../../core/client.js');

vi.mock('../../skills/skill-manager.js', () => {
  const SkillManagerMock = vi.fn();
  SkillManagerMock.prototype.startWatching = vi
    .fn()
    .mockResolvedValue(undefined);
  SkillManagerMock.prototype.stopWatching = vi.fn();
  SkillManagerMock.prototype.addChangeListener = vi
    .fn()
    .mockReturnValue(() => {});
  // Path-conditional skill activation hook (called from
  // CoreToolScheduler.executeSingleToolCall whenever a tool's input names a
  // filesystem path). The unit tests in this file do not exercise
  // activation, but the hook fires unconditionally so the mock must expose
  // the methods or the scheduler crashes on every tool call.
  SkillManagerMock.prototype.matchAndActivateByPath = vi
    .fn()
    .mockResolvedValue([]);
  SkillManagerMock.prototype.matchAndActivateByPaths = vi
    .fn()
    .mockResolvedValue([]);
  return { SkillManager: SkillManagerMock };
});

vi.mock('../../subagents/subagent-manager.js', () => {
  const SubagentManagerMock = vi.fn();
  SubagentManagerMock.prototype.loadSessionSubagents = vi.fn();
  SubagentManagerMock.prototype.addChangeListener = vi
    .fn()
    .mockReturnValue(() => {});
  SubagentManagerMock.prototype.listSubagents = vi.fn().mockResolvedValue([]);
  return { SubagentManager: SubagentManagerMock };
});

async function createMockConfig(
  toolRegistryMocks = {},
): Promise<{ config: Config; toolRegistry: ToolRegistry }> {
  const configParams: ConfigParameters = {
    model: DEFAULT_QWEN_MODEL,
    targetDir: '.',
    debugMode: false,
    cwd: process.cwd(),
    // Avoid writing any chat recording records from tests (e.g. via tool-call telemetry).
    chatRecording: false,
  };
  const config = new Config(configParams);
  await config.initialize();
  await config.refreshAuth(AuthType.USE_GEMINI);

  // Mock ToolRegistry
  const mockToolRegistryBase = {
    warmAll: vi.fn().mockResolvedValue(undefined),
    getTool: vi.fn(),
    getFunctionDeclarations: vi.fn().mockReturnValue([]),
    getFunctionDeclarationsFiltered: vi.fn().mockReturnValue([]),
    getAllToolNames: vi.fn().mockReturnValue([]),
    getDeferredToolSummary: vi.fn().mockReturnValue([]),
    isDeferredToolRevealed: vi.fn().mockReturnValue(false),
    getMcpServerInstructions: vi.fn().mockReturnValue(new Map()),
  };
  const mockToolRegistry = {
    ...mockToolRegistryBase,
    ensureTool: vi.fn(async (name: string) => mockToolRegistry.getTool(name)),
    ...toolRegistryMocks,
  } as unknown as ToolRegistry;

  vi.spyOn(config, 'getToolRegistry').mockReturnValue(mockToolRegistry);

  // Mock getContentGeneratorConfig to return a valid config
  vi.spyOn(config, 'getContentGeneratorConfig').mockReturnValue({
    model: DEFAULT_QWEN_MODEL,
    authType: AuthType.USE_GEMINI,
  });

  // Mock setModel method
  vi.spyOn(config, 'setModel').mockResolvedValue();

  // Mock getSessionId method
  vi.spyOn(config, 'getSessionId').mockReturnValue('test-session');

  return { config, toolRegistry: mockToolRegistry };
}

// Helper to simulate LLM responses (sequence of tool calls over multiple turns)
const createMockStream = (
  functionCallsList: Array<FunctionCall[] | 'stop'>,
) => {
  let index = 0;
  // This mock now returns a Promise that resolves to the async generator,
  // matching the new signature for sendMessageStream.
  return vi.fn().mockImplementation(async () => {
    const response = functionCallsList[index] || 'stop';
    index++;

    return (async function* () {
      if (response === 'stop') {
        // When stopping, the model might return text, but the subagent logic primarily cares about the absence of functionCalls.
        yield {
          type: 'chunk',
          value: {
            candidates: [
              {
                content: {
                  parts: [{ text: 'Done.' }],
                },
              },
            ],
          },
        };
      } else if (response.length > 0) {
        yield {
          type: 'chunk',
          value: {
            functionCalls: response,
          },
        };
      } else {
        yield {
          type: 'chunk',
          value: {
            candidates: [
              {
                content: {
                  parts: [{ text: 'Done.' }],
                },
              },
            ],
          },
        }; // Handle empty array also as stop
      }
    })();
  });
};

describe('subagent.ts', () => {
  describe('ContextState', () => {
    it('should set and get values correctly', () => {
      const context = new ContextState();
      context.set('key1', 'value1');
      context.set('key2', 123);
      expect(context.get('key1')).toBe('value1');
      expect(context.get('key2')).toBe(123);
      expect(context.get_keys()).toEqual(['key1', 'key2']);
    });

    it('should return undefined for missing keys', () => {
      const context = new ContextState();
      expect(context.get('missing')).toBeUndefined();
    });
  });

  describe('templateString', () => {
    it('should replace valid identifier placeholders', () => {
      const context = new ContextState();
      context.set('name', 'Agent');
      context.set('task', 'Testing');
      const result = templateString(
        'Hello ${name}, your task is ${task}.',
        context,
      );
      expect(result).toBe('Hello Agent, your task is Testing.');
    });

    it('should treat ${0} as literal text, not as a placeholder', () => {
      const context = new ContextState();
      const result = templateString('Do not write ${0} in your code.', context);
      expect(result).toBe('Do not write ${0} in your code.');
    });

    it('should treat ${1} and ${2} as literal text', () => {
      const context = new ContextState();
      const result = templateString(
        'Use {0} and {1}, not ${0} or ${1}.',
        context,
      );
      expect(result).toBe('Use {0} and {1}, not ${0} or ${1}.');
    });

    it('should still throw for missing valid identifier placeholders', () => {
      const context = new ContextState();
      context.set('name', 'Agent');
      expect(() =>
        templateString('Hello ${name}, missing ${missing}.', context),
      ).toThrow('Missing context values for the following keys: missing');
    });

    it('should handle mixed numeric and identifier placeholders', () => {
      const context = new ContextState();
      context.set('var', 'value');
      // ${var} and ${_private} are valid identifiers; ${0} is literal
      // ${_private} is missing from context, so it should throw
      expect(() =>
        templateString('${var} and ${0} and ${_private}', context),
      ).toThrow('Missing context values for the following keys: _private');
    });

    it('should handle ${0} alongside valid placeholders without error', () => {
      const context = new ContextState();
      context.set('name', 'Agent');
      const result = templateString(
        'Hello ${name}. Do not write ${0} or ${1}.',
        context,
      );
      expect(result).toBe('Hello Agent. Do not write ${0} or ${1}.');
    });
  });

  describe('AgentHeadless', () => {
    let mockSendMessageStream: Mock;
    let mockGetHistoryFunctionResponseIds: Mock;

    const defaultModelConfig: ModelConfig = {
      model: 'qwen3-coder-plus',
    };

    const defaultRunConfig: RunConfig = {
      max_time_minutes: 5,
      max_turns: 10,
    };

    beforeEach(async () => {
      vi.clearAllMocks();
      vi.mocked(getEnvironmentContext).mockResolvedValue([
        { text: 'Env Context' },
      ]);

      vi.mocked(createContentGenerator).mockResolvedValue({
        getGenerativeModel: vi.fn(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      vi.mocked(createContentGeneratorConfig).mockReturnValue({
        model: DEFAULT_QWEN_MODEL,
        authType: undefined,
      });
      vi.mocked(resolveContentGeneratorConfigWithSources).mockReturnValue({
        config: {
          model: DEFAULT_QWEN_MODEL,
          authType: AuthType.USE_GEMINI,
          apiKey: 'test-api-key',
        },
        sources: {},
      });

      mockSendMessageStream = vi.fn();
      mockGetHistoryFunctionResponseIds = vi.fn(() => new Set<string>());
      vi.mocked(GeminiChat).mockImplementation(
        () =>
          ({
            sendMessageStream: mockSendMessageStream,
            setLastPromptTokenCount: vi.fn(),
            getHistoryFunctionResponseIds: mockGetHistoryFunctionResponseIds,
          }) as unknown as GeminiChat,
      );

      // Default mock for executeToolCall
      vi.mocked(executeToolCall).mockResolvedValue({
        callId: 'default-call',
        responseParts: [{ text: 'default response' }],
        resultDisplay: 'Default tool result',
        error: undefined,
        errorType: undefined,
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    // Helper to safely access generationConfig from mock calls
    const getGenerationConfigFromMock = (
      callIndex = 0,
    ): GenerateContentConfig & { systemInstruction?: string | Content } => {
      const callArgs = vi.mocked(GeminiChat).mock.calls[callIndex];
      const generationConfig = callArgs?.[1];
      // Ensure it's defined before proceeding
      expect(generationConfig).toBeDefined();
      if (!generationConfig) throw new Error('generationConfig is undefined');
      return generationConfig as GenerateContentConfig & {
        systemInstruction?: string | Content;
      };
    };

    describe('create (Tool Validation)', () => {
      const promptConfig: PromptConfig = { systemPrompt: 'Test prompt' };

      it('should create a AgentHeadless successfully with minimal config', async () => {
        const { config } = await createMockConfig();
        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
        );
        expect(scope).toBeInstanceOf(AgentHeadless);
      });

      it('should not block creation when a tool may require confirmation', async () => {
        const mockTool = {
          name: 'risky_tool',
          schema: { parametersJsonSchema: { type: 'object', properties: {} } },
          build: vi.fn().mockReturnValue({
            getDefaultPermission: vi.fn().mockResolvedValue('ask'),
            getConfirmationDetails: vi.fn().mockResolvedValue({
              type: 'exec',
              title: 'Confirm',
              command: 'rm -rf /',
            }),
          }),
        };

        const { config } = await createMockConfig({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getTool: vi.fn().mockReturnValue(mockTool as any),
        });

        const toolConfig: ToolConfig = { tools: ['risky_tool'] };

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
          toolConfig,
        );
        expect(scope).toBeInstanceOf(AgentHeadless);
      });

      it('should succeed if tools do not require confirmation', async () => {
        const mockTool = {
          name: 'safe_tool',
          schema: { parametersJsonSchema: { type: 'object', properties: {} } },
          build: vi.fn().mockReturnValue({
            getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          }),
        };
        const { config } = await createMockConfig({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getTool: vi.fn().mockReturnValue(mockTool as any),
        });

        const toolConfig: ToolConfig = { tools: ['safe_tool'] };

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
          toolConfig,
        );
        expect(scope).toBeInstanceOf(AgentHeadless);
      });

      it('should allow creation regardless of tool parameter requirements', async () => {
        const mockToolWithParams = {
          name: 'tool_with_params',
          schema: {
            parametersJsonSchema: {
              type: 'object',
              properties: {
                path: { type: 'string' },
              },
              required: ['path'],
            },
          },
          build: vi.fn(),
        };

        const { config } = await createMockConfig({
          getTool: vi.fn().mockReturnValue(mockToolWithParams),
          getAllTools: vi.fn().mockReturnValue([mockToolWithParams]),
        });

        const toolConfig: ToolConfig = { tools: ['tool_with_params'] };

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
          toolConfig,
        );

        expect(scope).toBeInstanceOf(AgentHeadless);
        // Ensure build was not called during creation
        expect(mockToolWithParams.build).not.toHaveBeenCalled();
      });
    });

    describe('execute - Initialization and Prompting', () => {
      it('should correctly template the system prompt and initialize GeminiChat', async () => {
        const { config } = await createMockConfig();

        vi.mocked(GeminiChat).mockClear();

        const promptConfig: PromptConfig = {
          systemPrompt: 'Hello ${name}, your task is ${task}.',
        };
        const context = new ContextState();
        context.set('name', 'Agent');
        context.set('task', 'Testing');

        // Model stops immediately
        mockSendMessageStream.mockImplementation(createMockStream(['stop']));

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
        );

        await scope.execute(context);

        // Check if GeminiChat was initialized correctly by the subagent
        expect(GeminiChat).toHaveBeenCalledTimes(1);
        const callArgs = vi.mocked(GeminiChat).mock.calls[0];

        // Check Generation Config
        const generationConfig = getGenerationConfigFromMock();

        expect(generationConfig.systemInstruction).toContain(
          'Hello Agent, your task is Testing.',
        );
        expect(generationConfig.systemInstruction).toContain(
          'Important Rules:',
        );

        // Environment context is part of the cached system prompt.
        const history = callArgs[2];
        expect(generationConfig.systemInstruction).toContain('Env Context');
        expect(history).toEqual([]);
      });

      it('should reuse chat and tools for sequential follow-up turns', async () => {
        const { config, toolRegistry } = await createMockConfig();
        mockSendMessageStream.mockImplementation(
          createMockStream(['stop', 'stop']),
        );

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          { systemPrompt: 'You are a test agent.' },
          defaultModelConfig,
          defaultRunConfig,
        );
        const externalMessages: string[] = [];
        scope.getEventEmitter().on(AgentEventType.EXTERNAL_MESSAGE, (event) => {
          externalMessages.push(event.text);
        });

        const initialContext = new ContextState();
        initialContext.set('task_prompt', 'Initial task');
        await scope.execute(initialContext);

        scope.getCore().recordToolCallStats('stale_tool', true, 25);
        scope.getCore().stats.recordTokens(100, 50);

        const followUpContext = new ContextState();
        followUpContext.set('task_prompt', 'Follow-up task');
        await scope.execute(followUpContext);

        expect(GeminiChat).toHaveBeenCalledTimes(1);
        expect(toolRegistry.warmAll).toHaveBeenCalledTimes(2);
        expect(mockSendMessageStream).toHaveBeenCalledTimes(2);
        expect(mockSendMessageStream.mock.calls[0][1].message).toEqual([
          { text: 'Initial task' },
        ]);
        expect(mockSendMessageStream.mock.calls[1][1].message).toEqual([
          { text: '[Message from parent agent]: Follow-up task' },
        ]);
        expect(mockSendMessageStream.mock.calls[0][2]).not.toBe(
          mockSendMessageStream.mock.calls[1][2],
        );
        expect(mockSendMessageStream.mock.calls[0][2]).toMatch(/#0$/);
        expect(mockSendMessageStream.mock.calls[1][2]).toMatch(/#1$/);
        expect(externalMessages).toEqual(['Follow-up task']);
        expect(scope.getExecutionSummary()).toMatchObject({
          rounds: 1,
          totalToolCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          toolUsage: [],
        });
        expect(scope.getStatistics()).toMatchObject({
          rounds: 1,
          totalToolCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          toolUsage: [],
        });
      });

      it('should continue with atomically claimed finishing inputs', async () => {
        const { config } = await createMockConfig();
        mockSendMessageStream.mockImplementation(
          createMockStream(['stop', 'stop']),
        );

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          { systemPrompt: 'You are a test agent.' },
          defaultModelConfig,
          defaultRunConfig,
        );
        const externalEvents: Array<{
          kind: string | undefined;
          text: string;
        }> = [];
        scope.getEventEmitter().on(AgentEventType.EXTERNAL_MESSAGE, (event) => {
          externalEvents.push({ kind: event.kind, text: event.text });
        });

        const initialContext = new ContextState();
        initialContext.set('task_prompt', 'Initial task');
        await scope.execute(initialContext);
        await scope.executeExternalInputs(
          ['late correction', { kind: 'notification', text: 'monitor fired' }],
          undefined,
          { resetStats: false },
        );

        expect(mockSendMessageStream.mock.calls[1][1].message).toEqual([
          { text: '[Message from parent agent]: late correction' },
          { text: 'monitor fired' },
        ]);
        expect(externalEvents).toEqual([
          { kind: 'message', text: 'late correction' },
          { kind: 'notification', text: 'monitor fired' },
        ]);
        expect(scope.getExecutionSummary()).toMatchObject({ rounds: 2 });
      });

      it('should preserve statistics for continuation work in the same logical turn', async () => {
        const { config } = await createMockConfig();
        mockSendMessageStream.mockImplementation(
          createMockStream(['stop', 'stop']),
        );

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          { systemPrompt: 'You are a test agent.' },
          defaultModelConfig,
          defaultRunConfig,
        );
        await scope.execute(new ContextState());
        scope.getCore().recordToolCallStats('first_attempt_tool', true, 25);
        scope.getCore().stats.recordTokens(100, 50);
        scope.getCore().executionStats.inputTokens = 100;
        scope.getCore().executionStats.outputTokens = 50;
        scope.getCore().executionStats.totalTokens = 150;
        const logicalTurnStart = Date.now() - 10_000;
        scope.getCore().executionStats.startTimeMs = logicalTurnStart;
        scope.getCore().stats.start(logicalTurnStart);

        const continuationContext = new ContextState();
        continuationContext.set('task_prompt', 'Address the stop-hook reason');
        await scope.execute(continuationContext, undefined, {
          resetStats: false,
        });

        expect(scope.getExecutionSummary()).toMatchObject({
          rounds: 2,
          totalToolCalls: 1,
          successfulToolCalls: 1,
          inputTokens: 100,
          outputTokens: 50,
        });
        expect(scope.getCore().executionStats.startTimeMs).toBe(
          logicalTurnStart,
        );
        expect(
          scope.getCore().executionStats.totalDurationMs,
        ).toBeGreaterThanOrEqual(10_000);
        expect(scope.getStatistics()).toMatchObject({
          rounds: 2,
          totalDurationMs: expect.any(Number),
          totalToolCalls: 1,
          successfulToolCalls: 1,
          inputTokens: 100,
          outputTokens: 50,
        });
      });

      it('should reject concurrent execute calls', async () => {
        const { config } = await createMockConfig();
        let releaseResponse: (() => void) | undefined;
        const responseGate = new Promise<void>((resolve) => {
          releaseResponse = resolve;
        });
        mockSendMessageStream.mockImplementation(async () =>
          (async function* () {
            await responseGate;
            yield {
              type: 'chunk',
              value: {
                candidates: [
                  {
                    content: {
                      parts: [{ text: 'Done.' }],
                    },
                  },
                ],
              },
            };
          })(),
        );

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          { systemPrompt: 'You are a test agent.' },
          defaultModelConfig,
          defaultRunConfig,
        );
        const firstExecution = scope.execute(new ContextState());
        await vi.waitFor(() =>
          expect(mockSendMessageStream).toHaveBeenCalledTimes(1),
        );

        await expect(scope.execute(new ContextState())).rejects.toThrow(
          'AgentHeadless does not support concurrent execute() calls.',
        );

        releaseResponse?.();
        await firstExecution;
        expect(mockSendMessageStream).toHaveBeenCalledTimes(1);
      });

      it('should clear the prior result before a failing follow-up turn', async () => {
        const { config } = await createMockConfig();
        mockSendMessageStream
          .mockImplementationOnce(createMockStream(['stop']))
          .mockRejectedValueOnce(new Error('follow-up failed'));

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          { systemPrompt: 'You are a test agent.' },
          defaultModelConfig,
          defaultRunConfig,
        );
        await scope.execute(new ContextState());
        expect(scope.getFinalText()).toBe('Done.');
        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.GOAL);

        const followUpContext = new ContextState();
        followUpContext.set('task_prompt', 'Follow-up task');
        await expect(scope.execute(followUpContext)).rejects.toThrow(
          'follow-up failed',
        );

        expect(scope.getFinalText()).toBe('');
        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.ERROR);
      });

      it('should append userMemory to the system prompt when available', async () => {
        const { config } = await createMockConfig();
        const userMemoryContent =
          '# Output language preference: English\nRespond in English.';
        vi.spyOn(config, 'getSystemPromptVolatileMemory').mockReturnValue(
          userMemoryContent,
        );

        vi.mocked(GeminiChat).mockClear();

        const promptConfig: PromptConfig = {
          systemPrompt: 'You are a test agent.',
        };
        const context = new ContextState();

        mockSendMessageStream.mockImplementation(createMockStream(['stop']));

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
        );

        await scope.execute(context);

        const generationConfig = getGenerationConfigFromMock();
        expect(generationConfig.systemInstruction).toContain(
          'You are a test agent.',
        );
        expect(generationConfig.systemInstruction).toContain(
          'Important Rules:',
        );
        expect(generationConfig.systemInstruction).toContain(
          '# Output language preference: English',
        );
        expect(generationConfig.systemInstruction).toContain(
          'Respond in English.',
        );
      });

      it('should not append volatile memory when it is empty', async () => {
        const { config } = await createMockConfig();
        vi.spyOn(config, 'getSystemPromptVolatileMemory').mockReturnValue('');

        vi.mocked(GeminiChat).mockClear();

        const promptConfig: PromptConfig = {
          systemPrompt: 'You are a test agent.',
        };
        const context = new ContextState();

        mockSendMessageStream.mockImplementation(createMockStream(['stop']));

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
        );

        await scope.execute(context);

        const generationConfig = getGenerationConfigFromMock();
        const sysPrompt = generationConfig.systemInstruction as string;
        expect(sysPrompt).toContain('You are a test agent.');
      });

      it('should not append volatile memory when it is whitespace-only', async () => {
        const { config } = await createMockConfig();
        vi.spyOn(config, 'getSystemPromptVolatileMemory').mockReturnValue(
          '   \n\n  ',
        );

        vi.mocked(GeminiChat).mockClear();

        const promptConfig: PromptConfig = {
          systemPrompt: 'You are a test agent.',
        };
        const context = new ContextState();

        mockSendMessageStream.mockImplementation(createMockStream(['stop']));

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
        );

        await scope.execute(context);

        const generationConfig = getGenerationConfigFromMock();
        const sysPrompt = generationConfig.systemInstruction as string;
        expect(sysPrompt).not.toContain('   \n\n  ');
      });

      it('should replace env history with initialMessages when both initialMessages and systemPrompt are set', async () => {
        const { config } = await createMockConfig();
        vi.mocked(GeminiChat).mockClear();

        const initialMessages: Content[] = [
          { role: 'user', parts: [{ text: 'prior user turn' }] },
          { role: 'model', parts: [{ text: 'prior model turn' }] },
        ];
        const promptConfig: PromptConfig = {
          systemPrompt: 'System ${name}.',
          initialMessages,
        };
        const context = new ContextState();
        context.set('name', 'Agent');

        // Model stops immediately
        mockSendMessageStream.mockImplementation(createMockStream(['stop']));

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
        );

        await scope.execute(context);

        const callArgs = vi.mocked(GeminiChat).mock.calls[0];
        const generationConfig = getGenerationConfigFromMock();
        const history = callArgs[2];

        // systemPrompt is templated normally.
        expect(generationConfig.systemInstruction).toContain('System Agent.');
        expect(generationConfig.systemInstruction).toContain(
          'Important Rules:',
        );
        // Env bootstrap is skipped; history is exactly initialMessages.
        expect(history).toEqual(initialMessages);
      });

      it('should skip env history when initialMessages is an empty array', async () => {
        const { config } = await createMockConfig();
        vi.mocked(GeminiChat).mockClear();

        const promptConfig: PromptConfig = {
          systemPrompt: 'System ${name}.',
          initialMessages: [],
        };
        const context = new ContextState();
        context.set('name', 'Agent');

        mockSendMessageStream.mockImplementation(createMockStream(['stop']));

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
        );

        await scope.execute(context);

        const callArgs = vi.mocked(GeminiChat).mock.calls[0];
        const generationConfig = getGenerationConfigFromMock();

        expect(generationConfig.systemInstruction).toContain('System Agent.');
        expect(generationConfig.systemInstruction).toContain('Env Context');
        expect(callArgs[2]).toEqual([]);
      });

      it('should use renderedSystemPrompt verbatim and bypass templating', async () => {
        const { config } = await createMockConfig();
        vi.mocked(GeminiChat).mockClear();

        const rendered = 'Verbatim parent system prompt ${name}';
        const promptConfig: PromptConfig = {
          renderedSystemPrompt: rendered,
          initialMessages: [
            { role: 'user', parts: [{ text: 'hi' }] },
            { role: 'model', parts: [{ text: 'ok' }] },
          ],
        };
        const context = new ContextState();

        mockSendMessageStream.mockImplementation(createMockStream(['stop']));

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
        );

        await scope.execute(context);

        const generationConfig = getGenerationConfigFromMock();
        // No ${name} substitution and no non-interactive rules appended.
        expect(generationConfig.systemInstruction).toBe(rendered);
      });

      it('should throw an error if template variables are missing', async () => {
        const { config } = await createMockConfig();
        const promptConfig: PromptConfig = {
          systemPrompt: 'Hello ${name}, you are missing ${missing}.',
        };
        const context = new ContextState();
        context.set('name', 'Agent');
        // 'missing' is not set

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
        );

        // The error from templating causes the execute to reject and the terminate_reason to be ERROR.
        await expect(scope.execute(context)).rejects.toThrow(
          'Missing context values for the following keys: missing',
        );
        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.ERROR);
      });

      it('should validate that systemPrompt and renderedSystemPrompt are mutually exclusive', async () => {
        const { config } = await createMockConfig();
        const promptConfig: PromptConfig = {
          systemPrompt: 'System',
          renderedSystemPrompt: 'Rendered',
        };
        const context = new ContextState();

        const agent = await AgentHeadless.create(
          'TestAgent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
        );

        await expect(agent.execute(context)).rejects.toThrow(
          'PromptConfig cannot have both `systemPrompt` and `renderedSystemPrompt` defined.',
        );
        expect(agent.getTerminateMode()).toBe(AgentTerminateMode.ERROR);
      });
    });

    describe('execute - Execution and Tool Use', () => {
      const promptConfig: PromptConfig = { systemPrompt: 'Execute task.' };

      it('should terminate with GOAL if no outputs are expected and model stops', async () => {
        const { config } = await createMockConfig();
        // Model stops immediately
        mockSendMessageStream.mockImplementation(createMockStream(['stop']));

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
          // No ToolConfig, No OutputConfig
        );

        await scope.execute(new ContextState());

        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
        expect(mockSendMessageStream).toHaveBeenCalledTimes(1);
        // Check the initial message
        expect(mockSendMessageStream.mock.calls[0][1].message).toEqual([
          { text: 'Get Started!' },
        ]);
      });

      it('should terminate with GOAL when model provides final text', async () => {
        const { config } = await createMockConfig();

        // Model stops immediately with text response
        mockSendMessageStream.mockImplementation(createMockStream(['stop']));

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
        );

        await scope.execute(new ContextState());

        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
        expect(mockSendMessageStream).toHaveBeenCalledTimes(1);
      });

      it('should wait for external notification after a no-tool response', async () => {
        const { config } = await createMockConfig();
        mockSendMessageStream.mockImplementation(
          createMockStream(['stop', 'stop']),
        );

        let resolveWait:
          | ((inputs: [{ kind: 'notification'; text: string }]) => void)
          | undefined;
        const waitForExternalMessages = vi.fn(
          (_signal: AbortSignal) =>
            new Promise<[{ kind: 'notification'; text: string }]>((resolve) => {
              resolveWait = resolve;
            }),
        );
        let shouldWait = true;

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
        );
        scope.setExternalMessageProvider(() => []);
        scope.setExternalMessageWaiter(waitForExternalMessages);
        scope.setExternalMessageWaitPredicate(() => shouldWait);

        const executePromise = scope.execute(new ContextState());
        await vi.waitFor(() =>
          expect(waitForExternalMessages).toHaveBeenCalled(),
        );

        shouldWait = false;
        resolveWait?.([
          {
            kind: 'notification',
            text: '<task-notification>event</task-notification>',
          },
        ]);

        await executePromise;

        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
        expect(mockSendMessageStream).toHaveBeenCalledTimes(2);
        expect(mockSendMessageStream.mock.calls[1][1].message).toEqual([
          { text: '<task-notification>event</task-notification>' },
        ]);
      });

      it('should finalize after an empty wake when no owner monitor remains running', async () => {
        const { config } = await createMockConfig();
        mockSendMessageStream.mockImplementation(createMockStream(['stop']));

        let shouldWait = true;
        const waitForExternalMessages = vi.fn(async () => {
          shouldWait = false;
          return [];
        });

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
        );
        scope.setExternalMessageProvider(() => []);
        scope.setExternalMessageWaiter(waitForExternalMessages);
        scope.setExternalMessageWaitPredicate(() => shouldWait);

        await scope.execute(new ContextState());

        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
        expect(scope.getFinalText()).toBe('Done.');
        expect(waitForExternalMessages).toHaveBeenCalledTimes(1);
        expect(mockSendMessageStream).toHaveBeenCalledTimes(1);
      });

      it('should skip idle wait when the predicate flips false before wait registration', async () => {
        const { config } = await createMockConfig();
        mockSendMessageStream.mockImplementation(createMockStream(['stop']));

        let predicateCalls = 0;
        const waitForExternalMessages = vi.fn(async () => [
          {
            kind: 'notification' as const,
            text: '<task-notification>late</task-notification>',
          },
        ]);

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
        );
        scope.setExternalMessageProvider(() => []);
        scope.setExternalMessageWaiter(waitForExternalMessages);
        scope.setExternalMessageWaitPredicate(() => {
          predicateCalls += 1;
          return predicateCalls === 1;
        });

        await scope.execute(new ContextState());

        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
        expect(scope.getFinalText()).toBe('Done.');
        expect(waitForExternalMessages).not.toHaveBeenCalled();
        expect(mockSendMessageStream).toHaveBeenCalledTimes(1);
      });

      it('should keep waiting after an empty wake while an owner monitor is still running', async () => {
        const { config } = await createMockConfig();
        mockSendMessageStream.mockImplementation(
          createMockStream(['stop', 'stop']),
        );

        let shouldWait = true;
        let waitCalls = 0;
        const waitForExternalMessages = vi.fn(async () => {
          waitCalls += 1;
          if (waitCalls === 1) {
            return [];
          }
          shouldWait = false;
          return [
            {
              kind: 'notification' as const,
              text: '<task-notification>event</task-notification>',
            },
          ];
        });

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
        );
        scope.setExternalMessageProvider(() => []);
        scope.setExternalMessageWaiter(waitForExternalMessages);
        scope.setExternalMessageWaitPredicate(() => shouldWait);

        await scope.execute(new ContextState());

        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
        expect(waitForExternalMessages).toHaveBeenCalledTimes(2);
        expect(mockSendMessageStream).toHaveBeenCalledTimes(2);
        expect(mockSendMessageStream.mock.calls[1][1].message).toEqual([
          { text: '<task-notification>event</task-notification>' },
        ]);
      });

      it('should drain queued external notification before finalizing', async () => {
        const { config } = await createMockConfig();
        mockSendMessageStream.mockImplementation(
          createMockStream(['stop', 'stop']),
        );
        const pendingInputs: Array<{ kind: 'notification'; text: string }> = [
          {
            kind: 'notification',
            text: '<task-notification>terminal</task-notification>',
          },
        ];

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
        );
        scope.setExternalMessageProvider(() => pendingInputs.splice(0));

        await scope.execute(new ContextState());

        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
        expect(mockSendMessageStream).toHaveBeenCalledTimes(2);
        expect(mockSendMessageStream.mock.calls[1][1].message).toEqual([
          { text: '<task-notification>terminal</task-notification>' },
        ]);
      });

      it('should not idle-wait when max turns prevents another round', async () => {
        const { config } = await createMockConfig();
        const runConfig: RunConfig = { ...defaultRunConfig, max_turns: 1 };
        const waitForExternalMessages = vi.fn(async () => []);
        mockSendMessageStream.mockImplementation(createMockStream(['stop']));

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          runConfig,
        );
        scope.setExternalMessageProvider(() => []);
        scope.setExternalMessageWaiter(waitForExternalMessages);
        scope.setExternalMessageWaitPredicate(() => true);

        await scope.execute(new ContextState());

        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.MAX_TURNS);
        expect(waitForExternalMessages).not.toHaveBeenCalled();
      });

      it('should execute external tools and provide the response to the model', async () => {
        const listFilesToolDef: FunctionDeclaration = {
          name: 'list_files',
          description: 'Lists files',
          parameters: { type: Type.OBJECT, properties: {} },
        };

        const { config } = await createMockConfig({
          getFunctionDeclarationsFiltered: vi
            .fn()
            .mockReturnValue([listFilesToolDef]),
          getTool: vi.fn().mockReturnValue(undefined),
        });
        const toolConfig: ToolConfig = { tools: ['list_files'] };

        // Turn 1: Model calls the external tool
        // Turn 2: Model stops
        mockSendMessageStream.mockImplementation(
          createMockStream([
            [
              {
                id: 'call_1',
                name: 'list_files',
                args: { path: '.' },
              },
            ],
            'stop',
          ]),
        );

        // Provide a mock tool via ToolRegistry that returns a successful result
        const listFilesInvocation = {
          params: { path: '.' },
          getDescription: vi.fn().mockReturnValue('List files'),
          toolLocations: vi.fn().mockReturnValue([]),
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          execute: vi.fn().mockResolvedValue({
            llmContent: 'file1.txt\nfile2.ts',
            returnDisplay: 'Listed 2 files',
          }),
        };
        const listFilesTool = {
          name: 'list_files',
          displayName: 'List Files',
          description: 'List files in directory',
          kind: 'READ' as const,
          schema: listFilesToolDef,
          build: vi.fn().mockImplementation(() => listFilesInvocation),
          canUpdateOutput: false,
          isOutputMarkdown: true,
        } as unknown as AnyDeclarativeTool;
        vi.mocked(
          (config.getToolRegistry() as unknown as ToolRegistry).getTool,
        ).mockImplementation((name: string) =>
          name === 'list_files' ? listFilesTool : undefined,
        );

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
          toolConfig,
        );

        await scope.execute(new ContextState());

        // Check the response sent back to the model (functionResponse part)
        const secondCallArgs = mockSendMessageStream.mock.calls[1][1];
        const parts = secondCallArgs.message as unknown[];
        expect(Array.isArray(parts)).toBe(true);
        const firstPart = parts[0] as Part;
        expect(firstPart.functionResponse?.response?.['output']).toBe(
          'file1.txt\nfile2.ts',
        );

        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
      });

      it('should ignore duplicate provider tool-call ids across rounds', async () => {
        const listFilesToolDef: FunctionDeclaration = {
          name: 'list_files',
          description: 'Lists files',
          parameters: { type: Type.OBJECT, properties: {} },
        };

        const { config } = await createMockConfig({
          getFunctionDeclarationsFiltered: vi
            .fn()
            .mockReturnValue([listFilesToolDef]),
          getTool: vi.fn().mockReturnValue(undefined),
        });
        const toolConfig: ToolConfig = { tools: ['list_files'] };
        const [duplicateNormalizedPart] = normalizeModelToolCallIds(
          [
            {
              functionCall: {
                id: 'call_1',
                name: 'list_files',
                args: { path: '.' },
              },
            },
          ],
          new Set(['call_1']),
          new Set<string>(),
        );

        mockSendMessageStream.mockImplementation(
          createMockStream([
            [
              {
                id: 'call_1',
                name: 'list_files',
                args: { path: '.' },
              },
            ],
            [duplicateNormalizedPart!.functionCall!],
            'stop',
          ]),
        );

        const listFilesInvocation = {
          params: { path: '.' },
          getDescription: vi.fn().mockReturnValue('List files'),
          toolLocations: vi.fn().mockReturnValue([]),
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          execute: vi.fn().mockResolvedValue({
            llmContent: 'file1.txt\nfile2.ts',
            returnDisplay: 'Listed 2 files',
          }),
        };
        const listFilesTool = {
          name: 'list_files',
          displayName: 'List Files',
          description: 'List files in directory',
          kind: 'READ' as const,
          schema: listFilesToolDef,
          build: vi.fn().mockImplementation(() => listFilesInvocation),
          canUpdateOutput: false,
          isOutputMarkdown: true,
        } as unknown as AnyDeclarativeTool;
        vi.mocked(
          (config.getToolRegistry() as unknown as ToolRegistry).getTool,
        ).mockImplementation((name: string) =>
          name === 'list_files' ? listFilesTool : undefined,
        );

        const toolCallEvents: AgentToolCallEvent[] = [];
        const toolResultEvents: AgentToolResultEvent[] = [];
        const eventEmitter = new AgentEventEmitter();
        eventEmitter.on(AgentEventType.TOOL_CALL, (event: unknown) => {
          toolCallEvents.push(event as AgentToolCallEvent);
        });
        eventEmitter.on(AgentEventType.TOOL_RESULT, (event: unknown) => {
          toolResultEvents.push(event as AgentToolResultEvent);
        });

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
          toolConfig,
          eventEmitter,
        );

        await scope.execute(new ContextState());

        expect(listFilesInvocation.execute).toHaveBeenCalledTimes(1);
        expect(toolCallEvents).toHaveLength(2);
        expect(toolResultEvents).toHaveLength(2);
        expect(toolCallEvents[0].callId).toBe('call_1');
        expect(toolResultEvents[0].callId).toBe('call_1');
        expect(toolCallEvents[1].callId).toMatch(
          /^call_1__qwen_dup_2:duplicate:/,
        );
        expect(toolResultEvents[1].callId).toBe(toolCallEvents[1].callId);
        expect(toolResultEvents[1].error).toContain(
          'Duplicate provider tool call id "call_1"',
        );

        const thirdCallArgs = mockSendMessageStream.mock.calls[2][1];
        const parts = thirdCallArgs.message as Part[];
        expect(parts[0].functionResponse?.id).toBe('call_1__qwen_dup_2');
        expect(parts[0].functionResponse?.response?.['error']).toContain(
          'Duplicate provider tool call id "call_1"',
        );
        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
      });

      it('should stop repeated duplicate provider tool-call responses', async () => {
        const listFilesToolDef: FunctionDeclaration = {
          name: 'list_files',
          description: 'Lists files',
          parameters: { type: Type.OBJECT, properties: {} },
        };

        const { config } = await createMockConfig({
          getFunctionDeclarationsFiltered: vi
            .fn()
            .mockReturnValue([listFilesToolDef]),
          getTool: vi.fn().mockReturnValue(undefined),
        });
        const toolConfig: ToolConfig = { tools: ['list_files'] };
        const [duplicateNormalizedPart] = normalizeModelToolCallIds(
          [
            {
              functionCall: {
                id: 'call_1',
                name: 'list_files',
                args: { path: '.' },
              },
            },
          ],
          new Set(['call_1']),
          new Set<string>(),
        );

        mockSendMessageStream.mockImplementation(
          createMockStream([
            [
              {
                id: 'call_1',
                name: 'list_files',
                args: { path: '.' },
              },
            ],
            [duplicateNormalizedPart!.functionCall!],
            [
              duplicateNormalizedPart!.functionCall!,
              {
                id: 'call_2',
                name: 'list_files',
                args: { path: './fresh' },
              },
            ],
          ]),
        );

        const listFilesInvocation = {
          params: { path: '.' },
          getDescription: vi.fn().mockReturnValue('List files'),
          toolLocations: vi.fn().mockReturnValue([]),
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          execute: vi.fn().mockResolvedValue({
            llmContent: 'file1.txt\nfile2.ts',
            returnDisplay: 'Listed 2 files',
          }),
        };
        const listFilesTool = {
          name: 'list_files',
          displayName: 'List Files',
          description: 'List files in directory',
          kind: 'READ' as const,
          schema: listFilesToolDef,
          build: vi.fn().mockImplementation(() => listFilesInvocation),
          canUpdateOutput: false,
          isOutputMarkdown: true,
        } as unknown as AnyDeclarativeTool;
        vi.mocked(
          (config.getToolRegistry() as unknown as ToolRegistry).getTool,
        ).mockImplementation((name: string) =>
          name === 'list_files' ? listFilesTool : undefined,
        );

        const toolResultEvents: AgentToolResultEvent[] = [];
        const eventEmitter = new AgentEventEmitter();
        eventEmitter.on(AgentEventType.TOOL_RESULT, (event: unknown) => {
          toolResultEvents.push(event as AgentToolResultEvent);
        });

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
          toolConfig,
          eventEmitter,
        );

        await scope.execute(new ContextState());

        expect(listFilesInvocation.execute).toHaveBeenCalledTimes(1);
        expect(mockSendMessageStream).toHaveBeenCalledTimes(3);
        expect(toolResultEvents).toHaveLength(2);
        expect(toolResultEvents[1].error).toContain(
          'Duplicate provider tool call id "call_1"',
        );

        const thirdCallArgs = mockSendMessageStream.mock.calls[2][1];
        const parts = thirdCallArgs.message as Part[];
        expect(parts[0].functionResponse?.id).toBe('call_1__qwen_dup_2');
        expect(parts[0].functionResponse?.response?.['error']).toContain(
          'Duplicate provider tool call id "call_1"',
        );
        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.LOOP_DETECTED);
      });

      it('should stop consecutive identical tool calls with fresh ids', async () => {
        const listDirectoryToolDef: FunctionDeclaration = {
          name: 'list_directory',
          description: 'Lists a directory',
          parameters: { type: Type.OBJECT, properties: {} },
        };

        const { config } = await createMockConfig({
          getFunctionDeclarationsFiltered: vi
            .fn()
            .mockReturnValue([listDirectoryToolDef]),
          getTool: vi.fn().mockReturnValue(undefined),
        });
        const toolConfig: ToolConfig = { tools: ['list_directory'] };
        const missingPath = '/workspace/project/missing-directory';

        mockSendMessageStream.mockImplementation(
          createMockStream([
            ...Array.from({ length: 5 }, (_, index) => [
              {
                id: `call_${index + 1}`,
                name: 'list_directory',
                args: { path: missingPath },
              },
            ]),
            'stop',
          ]),
        );

        const listDirectoryInvocation = {
          params: { path: missingPath },
          getDescription: vi.fn().mockReturnValue('List directory'),
          toolLocations: vi.fn().mockReturnValue([]),
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          execute: vi.fn().mockResolvedValue({
            llmContent:
              'Error: ENOENT: no such file or directory, scandir ' +
              missingPath,
            returnDisplay: 'Directory not found',
          }),
        };
        const listDirectoryTool = {
          name: 'list_directory',
          displayName: 'List Directory',
          description: 'List directory contents',
          kind: 'READ' as const,
          schema: listDirectoryToolDef,
          build: vi.fn().mockImplementation(() => listDirectoryInvocation),
          canUpdateOutput: false,
          isOutputMarkdown: true,
        } as unknown as AnyDeclarativeTool;
        vi.mocked(
          (config.getToolRegistry() as unknown as ToolRegistry).getTool,
        ).mockImplementation((name: string) =>
          name === 'list_directory' ? listDirectoryTool : undefined,
        );

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
          toolConfig,
        );

        await scope.execute(new ContextState());

        expect(mockSendMessageStream).toHaveBeenCalledTimes(5);
        expect(listDirectoryInvocation.execute).toHaveBeenCalledTimes(4);
        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.LOOP_DETECTED);
      });

      it('should ignore duplicate provider tool-call ids already present in chat history', async () => {
        const listFilesToolDef: FunctionDeclaration = {
          name: 'list_files',
          description: 'Lists files',
          parameters: { type: Type.OBJECT, properties: {} },
        };

        const { config } = await createMockConfig({
          getFunctionDeclarationsFiltered: vi
            .fn()
            .mockReturnValue([listFilesToolDef]),
          getTool: vi.fn().mockReturnValue(undefined),
        });
        const toolConfig: ToolConfig = { tools: ['list_files'] };
        const [duplicateNormalizedPart] = normalizeModelToolCallIds(
          [
            {
              functionCall: {
                id: 'call_1',
                name: 'list_files',
                args: { path: '.' },
              },
            },
          ],
          new Set(['call_1']),
          new Set<string>(),
        );
        mockGetHistoryFunctionResponseIds.mockReturnValue(new Set(['call_1']));

        mockSendMessageStream.mockImplementation(
          createMockStream([[duplicateNormalizedPart!.functionCall!], 'stop']),
        );

        const listFilesInvocation = {
          params: { path: '.' },
          getDescription: vi.fn().mockReturnValue('List files'),
          toolLocations: vi.fn().mockReturnValue([]),
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          execute: vi.fn().mockResolvedValue({
            llmContent: 'file1.txt\nfile2.ts',
            returnDisplay: 'Listed 2 files',
          }),
        };
        const listFilesTool = {
          name: 'list_files',
          displayName: 'List Files',
          description: 'List files in directory',
          kind: 'READ' as const,
          schema: listFilesToolDef,
          build: vi.fn().mockImplementation(() => listFilesInvocation),
          canUpdateOutput: false,
          isOutputMarkdown: true,
        } as unknown as AnyDeclarativeTool;
        vi.mocked(
          (config.getToolRegistry() as unknown as ToolRegistry).getTool,
        ).mockImplementation((name: string) =>
          name === 'list_files' ? listFilesTool : undefined,
        );

        const toolCallEvents: AgentToolCallEvent[] = [];
        const toolResultEvents: AgentToolResultEvent[] = [];
        const eventEmitter = new AgentEventEmitter();
        eventEmitter.on(AgentEventType.TOOL_CALL, (event: unknown) => {
          toolCallEvents.push(event as AgentToolCallEvent);
        });
        eventEmitter.on(AgentEventType.TOOL_RESULT, (event: unknown) => {
          toolResultEvents.push(event as AgentToolResultEvent);
        });

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
          toolConfig,
          eventEmitter,
        );

        await scope.execute(new ContextState());

        expect(listFilesInvocation.execute).not.toHaveBeenCalled();
        expect(toolCallEvents).toHaveLength(1);
        expect(toolResultEvents).toHaveLength(1);
        expect(toolCallEvents[0].callId).toMatch(
          /^call_1__qwen_dup_2:duplicate:/,
        );
        expect(toolResultEvents[0].callId).toBe(toolCallEvents[0].callId);
        expect(toolResultEvents[0].error).toContain(
          'Duplicate provider tool call id "call_1"',
        );

        const secondCallArgs = mockSendMessageStream.mock.calls[1][1];
        const parts = secondCallArgs.message as Part[];
        expect(parts[0].functionResponse?.id).toBe('call_1__qwen_dup_2');
        expect(parts[0].functionResponse?.response?.['error']).toContain(
          'Duplicate provider tool call id "call_1"',
        );
        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
      });

      it('should execute only the first duplicate functionCall id in one model turn', async () => {
        const listFilesToolDef: FunctionDeclaration = {
          name: 'list_files',
          description: 'Lists files',
          parameters: { type: Type.OBJECT, properties: {} },
        };

        const { config } = await createMockConfig({
          getFunctionDeclarationsFiltered: vi
            .fn()
            .mockReturnValue([listFilesToolDef]),
          getTool: vi.fn().mockReturnValue(undefined),
        });
        const toolConfig: ToolConfig = { tools: ['list_files'] };

        mockSendMessageStream.mockImplementation(
          createMockStream([
            [
              {
                id: 'dup_id_0001',
                name: 'list_files',
                args: { path: 'a' },
              },
              {
                id: 'dup_id_0001',
                name: 'list_files',
                args: { path: 'b' },
              },
            ],
            'stop',
          ]),
        );

        const listFilesInvocation = {
          params: { path: 'a' },
          getDescription: vi.fn().mockReturnValue('List files'),
          toolLocations: vi.fn().mockReturnValue([]),
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          execute: vi.fn().mockResolvedValue({
            llmContent: 'file1.txt',
            returnDisplay: 'Listed 1 file',
          }),
        };
        const listFilesTool = {
          name: 'list_files',
          displayName: 'List Files',
          description: 'List files in directory',
          kind: 'READ' as const,
          schema: listFilesToolDef,
          build: vi.fn().mockImplementation(() => listFilesInvocation),
          canUpdateOutput: false,
          isOutputMarkdown: true,
        } as unknown as AnyDeclarativeTool;
        vi.mocked(
          (config.getToolRegistry() as unknown as ToolRegistry).getTool,
        ).mockImplementation((name: string) =>
          name === 'list_files' ? listFilesTool : undefined,
        );

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
          toolConfig,
        );

        await scope.execute(new ContextState());

        expect(listFilesInvocation.execute).toHaveBeenCalledOnce();
        const secondCallArgs = mockSendMessageStream.mock.calls[1][1];
        const parts = secondCallArgs.message as Part[];
        expect(
          parts
            .map((part) => part.functionResponse?.id)
            .filter((id): id is string => Boolean(id)),
        ).toEqual(['dup_id_0001']);
      });

      it('should report unauthorized tool names before duplicate provider ids', async () => {
        const listFilesToolDef: FunctionDeclaration = {
          name: 'list_files',
          description: 'Lists files',
          parameters: { type: Type.OBJECT, properties: {} },
        };

        const { config } = await createMockConfig({
          getFunctionDeclarationsFiltered: vi
            .fn()
            .mockReturnValue([listFilesToolDef]),
          getTool: vi.fn().mockReturnValue(undefined),
        });
        const toolConfig: ToolConfig = { tools: ['list_files'] };

        mockSendMessageStream.mockImplementation(
          createMockStream([
            [
              {
                id: 'call_reused',
                name: 'list_files',
                args: { path: '.' },
              },
            ],
            [
              {
                id: 'call_reused',
                name: 'write_file',
                args: { path: 'x.txt', content: 'x' },
              },
            ],
            'stop',
          ]),
        );

        const listFilesInvocation = {
          params: { path: '.' },
          getDescription: vi.fn().mockReturnValue('List files'),
          toolLocations: vi.fn().mockReturnValue([]),
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          execute: vi.fn().mockResolvedValue({
            llmContent: 'file1.txt\nfile2.ts',
            returnDisplay: 'Listed 2 files',
          }),
        };
        const listFilesTool = {
          name: 'list_files',
          displayName: 'List Files',
          description: 'List files in directory',
          kind: 'READ' as const,
          schema: listFilesToolDef,
          build: vi.fn().mockImplementation(() => listFilesInvocation),
          canUpdateOutput: false,
          isOutputMarkdown: true,
        } as unknown as AnyDeclarativeTool;
        vi.mocked(
          (config.getToolRegistry() as unknown as ToolRegistry).getTool,
        ).mockImplementation((name: string) =>
          name === 'list_files' ? listFilesTool : undefined,
        );

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
          toolConfig,
        );

        await scope.execute(new ContextState());

        expect(listFilesInvocation.execute).toHaveBeenCalledTimes(1);
        const thirdCallArgs = mockSendMessageStream.mock.calls[2][1];
        const parts = thirdCallArgs.message as Part[];
        expect(parts[0].functionResponse?.id).toBe('call_reused');
        expect(parts[0].functionResponse?.name).toBe('write_file');
        expect(parts[0].functionResponse?.response?.['error']).toContain(
          'Tool "write_file" not found',
        );
        expect(parts[0].functionResponse?.response?.['error']).not.toContain(
          'Duplicate provider tool call id',
        );
        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
      });
    });

    describe('execute - Termination and Recovery', () => {
      const promptConfig: PromptConfig = { systemPrompt: 'Execute task.' };

      it('should terminate with MAX_TURNS if the limit is reached', async () => {
        const { config } = await createMockConfig();
        const runConfig: RunConfig = { ...defaultRunConfig, max_turns: 2 };

        // Model keeps calling tools repeatedly
        mockSendMessageStream.mockImplementation(
          createMockStream([
            [
              {
                name: 'list_files',
                args: { path: '/test' },
              },
            ],
            [
              {
                name: 'list_files',
                args: { path: '/test2' },
              },
            ],
            // This turn should not happen
            [
              {
                name: 'list_files',
                args: { path: '/test3' },
              },
            ],
          ]),
        );

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          runConfig,
        );

        await scope.execute(new ContextState());

        expect(mockSendMessageStream).toHaveBeenCalledTimes(2);
        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.MAX_TURNS);
      });

      it('should terminate with TIMEOUT if the time limit is reached during an LLM call', async () => {
        // Use fake timers to reliably test timeouts
        vi.useFakeTimers();

        try {
          const { config } = await createMockConfig();
          const runConfig: RunConfig = { max_time_minutes: 5, max_turns: 100 };

          // We need to control the resolution of the sendMessageStream promise to advance the timer during execution.
          let resolveStream: (
            value: AsyncGenerator<unknown, void, unknown>,
          ) => void;
          const streamPromise = new Promise<
            AsyncGenerator<unknown, void, unknown>
          >((resolve) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            resolveStream = resolve as any;
          });

          // The LLM call will hang until we resolve the promise.
          mockSendMessageStream.mockReturnValue(streamPromise);

          const scope = await AgentHeadless.create(
            'test-agent',
            config,
            promptConfig,
            defaultModelConfig,
            runConfig,
          );

          const runPromise = scope.execute(new ContextState());

          // Advance time beyond the limit (6 minutes) while the agent is awaiting the LLM response.
          await vi.advanceTimersByTimeAsync(6 * 60 * 1000);

          // Now resolve the stream. The model returns 'stop'.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          resolveStream!(createMockStream(['stop'])() as any);

          await runPromise;

          expect(scope.getTerminateMode()).toBe(AgentTerminateMode.TIMEOUT);
          expect(mockSendMessageStream).toHaveBeenCalledTimes(1);
        } finally {
          vi.useRealTimers();
        }
      });

      it('should terminate with ERROR if the model call throws', async () => {
        const { config } = await createMockConfig();
        mockSendMessageStream.mockRejectedValue(new Error('API Failure'));

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
        );

        await expect(scope.execute(new ContextState())).rejects.toThrow(
          'API Failure',
        );
        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.ERROR);
      });
    });

    describe('execute - Streaming and Thought Handling', () => {
      const promptConfig: PromptConfig = { systemPrompt: 'Execute task.' };

      // Helper to create a mock stream that yields specific parts
      const createMockStreamWithParts = (parts: Part[]) =>
        vi.fn().mockImplementation(async () =>
          (async function* () {
            yield {
              type: 'chunk',
              value: {
                candidates: [
                  {
                    content: { parts },
                  },
                ],
              },
            };
          })(),
        );

      it('should emit STREAM_TEXT events with thought flag', async () => {
        const { config } = await createMockConfig();

        mockSendMessageStream = createMockStreamWithParts([
          { text: 'Let me think...' as string, thought: true },
          { text: 'Here is the answer.' as string },
        ]);
        vi.mocked(GeminiChat).mockImplementation(
          () =>
            ({
              sendMessageStream: mockSendMessageStream,
              setLastPromptTokenCount: vi.fn(),
              getHistoryFunctionResponseIds: vi.fn(() => new Set<string>()),
            }) as unknown as GeminiChat,
        );

        const eventEmitter = new AgentEventEmitter();
        const events: AgentStreamTextEvent[] = [];
        eventEmitter.on(AgentEventType.STREAM_TEXT, (...args: unknown[]) => {
          events.push(args[0] as AgentStreamTextEvent);
        });

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
          undefined,
          eventEmitter,
        );

        await scope.execute(new ContextState());

        expect(events).toHaveLength(2);
        expect(events[0]!.text).toBe('Let me think...');
        expect(events[0]!.thought).toBe(true);
        expect(events[1]!.text).toBe('Here is the answer.');
        expect(events[1]!.thought).toBe(false);
      });

      it('should emit usage for a tool-call-only model round', async () => {
        const { config } = await createMockConfig();
        const usageMetadata = {
          promptTokenCount: 100,
          candidatesTokenCount: 10,
          cachedContentTokenCount: 5,
          totalTokenCount: 110,
        };
        mockSendMessageStream.mockImplementation(async () =>
          (async function* () {
            yield {
              type: 'chunk',
              value: {
                functionCalls: [
                  {
                    id: 'call-1',
                    name: 'missing_tool',
                    args: {},
                  },
                ],
                usageMetadata,
              },
            };
          })(),
        );

        const eventEmitter = new AgentEventEmitter();
        const events: AgentRoundTextEvent[] = [];
        eventEmitter.on(AgentEventType.ROUND_TEXT, (event) => {
          events.push(event);
        });
        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          { ...defaultRunConfig, max_turns: 1 },
          undefined,
          eventEmitter,
        );

        await scope.execute(new ContextState());

        expect(events).toEqual([
          expect.objectContaining({
            round: 1,
            text: '',
            thoughtText: '',
            usageMetadata,
          }),
        ]);
      });

      it('should exclude thought text from finalText', async () => {
        const { config } = await createMockConfig();

        mockSendMessageStream = createMockStreamWithParts([
          { text: 'Internal reasoning here.' as string, thought: true },
          { text: 'The final answer.' as string },
        ]);
        vi.mocked(GeminiChat).mockImplementation(
          () =>
            ({
              sendMessageStream: mockSendMessageStream,
              setLastPromptTokenCount: vi.fn(),
              getHistoryFunctionResponseIds: vi.fn(() => new Set<string>()),
            }) as unknown as GeminiChat,
        );

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
        );

        await scope.execute(new ContextState());

        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
        expect(scope.getFinalText()).toBe('The final answer.');
      });

      it('should not set finalText from thought-only response', async () => {
        const { config } = await createMockConfig();

        // First call: only thought text (no regular text → nudge)
        // Second call: regular text response
        let callIndex = 0;
        mockSendMessageStream = vi.fn().mockImplementation(async () => {
          const idx = callIndex++;
          return (async function* () {
            if (idx === 0) {
              yield {
                type: 'chunk',
                value: {
                  candidates: [
                    {
                      content: {
                        parts: [
                          {
                            text: 'Just thinking...' as string,
                            thought: true,
                          },
                        ],
                      },
                    },
                  ],
                },
              };
            } else {
              yield {
                type: 'chunk',
                value: {
                  candidates: [
                    {
                      content: {
                        parts: [{ text: 'Actual output.' as string }],
                      },
                    },
                  ],
                },
              };
            }
          })();
        });
        vi.mocked(GeminiChat).mockImplementation(
          () =>
            ({
              sendMessageStream: mockSendMessageStream,
              setLastPromptTokenCount: vi.fn(),
              getHistoryFunctionResponseIds: vi.fn(() => new Set<string>()),
            }) as unknown as GeminiChat,
        );

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
        );

        await scope.execute(new ContextState());

        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
        expect(scope.getFinalText()).toBe('Actual output.');
        // Should have been called twice: first with thought-only, then nudged
        expect(mockSendMessageStream).toHaveBeenCalledTimes(2);
      });
    });

    describe('execute - Tool Restriction Enforcement (Issue #1121)', () => {
      const promptConfig: PromptConfig = { systemPrompt: 'Execute task.' };

      it('should NOT execute tools that are not in the allowed tools list', async () => {
        // Define two tools: one allowed (read_file), one not allowed (edit_file)
        const readFileToolDef: FunctionDeclaration = {
          name: 'read_file',
          description: 'Reads a file',
          parameters: { type: Type.OBJECT, properties: {} },
        };
        const editFileToolDef: FunctionDeclaration = {
          name: 'edit_file',
          description: 'Edits a file',
          parameters: { type: Type.OBJECT, properties: {} },
        };

        // Track which tools were executed
        const executedTools: string[] = [];

        const readFileInvocation = {
          params: { path: 'test.txt' },
          getDescription: vi.fn().mockReturnValue('Read file'),
          toolLocations: vi.fn().mockReturnValue([]),
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          execute: vi.fn().mockImplementation(async () => {
            executedTools.push('read_file');
            return {
              llmContent: 'file contents',
              returnDisplay: 'Read file contents',
            };
          }),
        };

        const editFileInvocation = {
          params: { path: 'test.txt', content: 'malicious content' },
          getDescription: vi.fn().mockReturnValue('Edit file'),
          toolLocations: vi.fn().mockReturnValue([]),
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          execute: vi.fn().mockImplementation(async () => {
            executedTools.push('edit_file');
            return {
              llmContent: 'file edited',
              returnDisplay: 'Edited file',
            };
          }),
        };

        const readFileTool = {
          name: 'read_file',
          displayName: 'Read File',
          description: 'Read file contents',
          kind: 'READ' as const,
          schema: readFileToolDef,
          build: vi.fn().mockImplementation(() => readFileInvocation),
          canUpdateOutput: false,
          isOutputMarkdown: true,
        } as unknown as AnyDeclarativeTool;

        const editFileTool = {
          name: 'edit_file',
          displayName: 'Edit File',
          description: 'Edit file contents',
          kind: 'WRITE' as const,
          schema: editFileToolDef,
          build: vi.fn().mockImplementation(() => editFileInvocation),
          canUpdateOutput: false,
          isOutputMarkdown: true,
        } as unknown as AnyDeclarativeTool;

        const { config } = await createMockConfig({
          // Only return read_file in the filtered list (this is what the subagent should see)
          getFunctionDeclarationsFiltered: vi
            .fn()
            .mockReturnValue([readFileToolDef]),
          // But the full registry has both tools (simulating the bug)
          getFunctionDeclarations: vi
            .fn()
            .mockReturnValue([readFileToolDef, editFileToolDef]),
          getTool: vi.fn().mockImplementation((name: string) => {
            if (name === 'read_file') return readFileTool;
            if (name === 'edit_file') return editFileTool;
            return undefined;
          }),
        });

        // Only allow read_file in the subagent's tool config
        const toolConfig: ToolConfig = { tools: ['read_file'] };

        // Model calls BOTH read_file (allowed) AND edit_file (NOT allowed)
        // This simulates the bug where the model hallucinates an unauthorized tool call
        mockSendMessageStream.mockImplementation(
          createMockStream([
            [
              {
                id: 'call_read',
                name: 'read_file',
                args: { path: 'test.txt' },
              },
              {
                id: 'call_edit',
                name: 'edit_file', // This tool is NOT in the allowed list!
                args: { path: 'test.txt', content: 'malicious content' },
              },
            ],
            'stop',
          ]),
        );

        // Track emitted events
        const toolCallEvents: AgentToolCallEvent[] = [];
        const toolResultEvents: AgentToolResultEvent[] = [];

        // Create event emitter BEFORE the scope and subscribe to events
        const eventEmitter = new AgentEventEmitter();
        eventEmitter.on(AgentEventType.TOOL_CALL, (event: unknown) => {
          toolCallEvents.push(event as AgentToolCallEvent);
        });
        eventEmitter.on(AgentEventType.TOOL_RESULT, (event: unknown) => {
          toolResultEvents.push(event as AgentToolResultEvent);
        });

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
          toolConfig,
          eventEmitter,
        );

        await scope.execute(new ContextState());

        // 1. Only allowed tool should be executed
        expect(executedTools).toContain('read_file');
        expect(executedTools).not.toContain('edit_file');
        expect(editFileInvocation.execute).not.toHaveBeenCalled();

        // 2. TOOL_CALL events should be emitted for BOTH tools (for visibility)
        expect(toolCallEvents).toHaveLength(2);
        expect(toolCallEvents.map((e) => e.name)).toContain('read_file');
        expect(toolCallEvents.map((e) => e.name)).toContain('edit_file');

        // 3. TOOL_RESULT events should be emitted for both
        expect(toolResultEvents).toHaveLength(2);

        // 4. Verify blocked tool result has success=false and error message
        const editResult = toolResultEvents.find((e) => e.name === 'edit_file');
        expect(editResult).toBeDefined();
        expect(editResult!.success).toBe(false);
        expect(editResult!.error).toContain('not found');
        expect(editResult!.callId).toBe('call_edit');

        // 5. Verify allowed tool result has success=true
        const readResult = toolResultEvents.find((e) => e.name === 'read_file');
        expect(readResult).toBeDefined();
        expect(readResult!.success).toBe(true);
      });

      it('should mark truncated subagent write_file calls as output-truncated errors', async () => {
        const writeFileToolDef: FunctionDeclaration = {
          name: WriteFileTool.Name,
          description: 'Writes a file',
          parameters: { type: Type.OBJECT, properties: {} },
        };

        const { config } = await createMockConfig({
          getFunctionDeclarationsFiltered: vi
            .fn()
            .mockReturnValue([writeFileToolDef]),
          getTool: vi.fn().mockImplementation((name: string) => {
            if (name === WriteFileTool.Name) {
              return new WriteFileTool(config);
            }
            return undefined;
          }),
        });

        const toolConfig: ToolConfig = { tools: [WriteFileTool.Name] };
        const toolResultEvents: AgentToolResultEvent[] = [];
        const eventEmitter = new AgentEventEmitter();
        eventEmitter.on(AgentEventType.TOOL_RESULT, (event: unknown) => {
          toolResultEvents.push(event as AgentToolResultEvent);
        });

        mockSendMessageStream.mockImplementation(async () =>
          (async function* () {
            yield {
              type: 'chunk',
              value: {
                functionCalls: [
                  {
                    id: 'call_write',
                    name: WriteFileTool.Name,
                    args: { file_path: '/tmp/truncated.txt' },
                  },
                ],
              },
            };
            yield {
              type: 'chunk',
              value: {
                candidates: [
                  {
                    finishReason: 'MAX_TOKENS',
                    content: { parts: [] },
                  },
                ],
              },
            };
            yield {
              type: 'chunk',
              value: {
                candidates: [
                  {
                    content: {
                      parts: [{ text: 'done' }],
                    },
                  },
                ],
              },
            };
          })(),
        );

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
          toolConfig,
          eventEmitter,
        );

        await scope.execute(new ContextState());

        const writeResult = toolResultEvents.find(
          (event) => event.name === WriteFileTool.Name,
        );
        expect(writeResult).toBeDefined();
        expect(writeResult!.success).toBe(false);
        expect(writeResult!.error).toContain(
          'truncated due to max_tokens limit',
        );
        expect(writeResult!.error).toContain(
          'rejected to prevent writing truncated content',
        );
        expect(writeResult!.error).not.toContain(
          "params must have required property 'content'",
        );
      });

      it('should NOT reject write_file when truncated attempt is followed by successful retry', async () => {
        const writeFileToolDef: FunctionDeclaration = {
          name: WriteFileTool.Name,
          description: 'Writes a file',
          parameters: { type: Type.OBJECT, properties: {} },
        };

        const { config } = await createMockConfig({
          getFunctionDeclarationsFiltered: vi
            .fn()
            .mockReturnValue([writeFileToolDef]),
          getTool: vi.fn().mockImplementation((name: string) => {
            if (name === WriteFileTool.Name) {
              return new WriteFileTool(config);
            }
            return undefined;
          }),
        });

        const toolConfig: ToolConfig = { tools: [WriteFileTool.Name] };
        const toolResultEvents: AgentToolResultEvent[] = [];
        const eventEmitter = new AgentEventEmitter();
        eventEmitter.on(AgentEventType.TOOL_RESULT, (event: unknown) => {
          toolResultEvents.push(event as AgentToolResultEvent);
        });

        // First call: truncated (MAX_TOKENS). Retry resets state, second call:
        // complete write_file. The scheduler should see wasOutputTruncated=false
        // for the retried response and allow the tool to proceed.
        let callCount = 0;
        mockSendMessageStream.mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            // First round: truncated response with incomplete write_file args
            return (async function* () {
              yield {
                type: 'chunk',
                value: {
                  functionCalls: [
                    {
                      id: 'call_write_truncated',
                      name: WriteFileTool.Name,
                      args: { file_path: '/tmp/retry-test.txt' },
                    },
                  ],
                },
              };
              yield {
                type: 'retry',
              };
              // After retry, complete response with all required args
              yield {
                type: 'chunk',
                value: {
                  functionCalls: [
                    {
                      id: 'call_write_complete',
                      name: WriteFileTool.Name,
                      args: {
                        file_path: '/tmp/retry-test.txt',
                        content: 'hello',
                      },
                    },
                  ],
                },
              };
              yield {
                type: 'chunk',
                value: {
                  candidates: [
                    { finishReason: 'STOP', content: { parts: [] } },
                  ],
                },
              };
            })();
          }
          // Second round: plain text response to end the agent loop
          return (async function* () {
            yield {
              type: 'chunk',
              value: {
                candidates: [
                  {
                    finishReason: 'STOP',
                    content: { parts: [{ text: 'done' }] },
                  },
                ],
              },
            };
          })();
        });

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
          toolConfig,
          eventEmitter,
        );

        await scope.execute(new ContextState());

        const writeResult = toolResultEvents.find(
          (event) => event.name === WriteFileTool.Name,
        );
        expect(writeResult).toBeDefined();
        // After retry the wasOutputTruncated flag must have been cleared, so
        // the call should NOT be rejected with a truncation error — even if
        // execution fails for unrelated reasons (e.g. mock filesystem).
        expect(writeResult!.error).not.toContain(
          'truncated due to max_tokens limit',
        );
        expect(writeResult!.error).not.toContain(
          'rejected to prevent writing truncated content',
        );
      });

      it('keeps automatic max token escalation warm for the next agent round', async () => {
        const writeFileToolDef: FunctionDeclaration = {
          name: WriteFileTool.Name,
          description: 'Writes a file',
          parameters: { type: Type.OBJECT, properties: {} },
        };

        const { config } = await createMockConfig({
          getFunctionDeclarationsFiltered: vi
            .fn()
            .mockReturnValue([writeFileToolDef]),
          getTool: vi.fn().mockImplementation((name: string) => {
            if (name === WriteFileTool.Name) {
              return new WriteFileTool(config);
            }
            return undefined;
          }),
        });

        const toolConfig: ToolConfig = { tools: [WriteFileTool.Name] };
        let callCount = 0;
        mockSendMessageStream.mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            return (async function* () {
              yield {
                type: 'retry',
                maxOutputTokensEscalated: 65_536,
              };
              yield {
                type: 'chunk',
                value: {
                  functionCalls: [
                    {
                      id: 'call_write_complete',
                      name: WriteFileTool.Name,
                      args: {
                        file_path: '/tmp/sticky-escalation.txt',
                        content: 'hello',
                      },
                    },
                  ],
                },
              };
              yield {
                type: 'chunk',
                value: {
                  candidates: [
                    { finishReason: 'STOP', content: { parts: [] } },
                  ],
                },
              };
            })();
          }

          return (async function* () {
            yield {
              type: 'chunk',
              value: {
                candidates: [
                  {
                    finishReason: 'STOP',
                    content: { parts: [{ text: 'done' }] },
                  },
                ],
              },
            };
          })();
        });

        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
          toolConfig,
        );

        await scope.execute(new ContextState());

        expect(mockSendMessageStream).toHaveBeenCalledTimes(2);
        expect(
          mockSendMessageStream.mock.calls[0][1].config.maxOutputTokens,
        ).toBeUndefined();
        expect(
          mockSendMessageStream.mock.calls[1][1].config.maxOutputTokens,
        ).toBe(65_536);
      });
    });
  });
});

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
import { Config, type ConfigParameters } from '../config/config.js';
import { DEFAULT_GEMINI_MODEL } from '../config/models.js';
import {
  createContentGenerator,
  createContentGeneratorConfig,
  AuthType,
} from '../core/contentGenerator.js';
import { GeminiChat } from '../core/geminiChat.js';
import { executeToolCall } from '../core/nonInteractiveToolExecutor.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { type AnyDeclarativeTool } from '../tools/tools.js';
import { getEnvironmentContext } from '../utils/environmentContext.js';
import { ContextState, SubAgentScope } from './subagent.js';
import type {
  ModelConfig,
  PromptConfig,
  RunConfig,
  ToolConfig,
} from './types.js';
import { SubagentTerminateMode } from './types.js';
import { GeminiClient } from '../core/client.js';

vi.mock('../core/geminiChat.js');
vi.mock('../core/contentGenerator.js');
vi.mock('../utils/environmentContext.js');
vi.mock('../core/nonInteractiveToolExecutor.js');
vi.mock('../ide/ide-client.js');
vi.mock('../core/client.js');

async function createMockConfig(
  toolRegistryMocks = {},
): Promise<{ config: Config; toolRegistry: ToolRegistry }> {
  const configParams: ConfigParameters = {
    sessionId: 'test-session',
    model: DEFAULT_GEMINI_MODEL,
    targetDir: '.',
    debugMode: false,
    cwd: process.cwd(),
  };
  const config = new Config(configParams);
  await config.initialize();
  await config.refreshAuth(AuthType.USE_GEMINI);

  // Mock ToolRegistry
  const mockToolRegistry = {
    getTool: vi.fn(),
    getFunctionDeclarations: vi.fn().mockReturnValue([]),
    getFunctionDeclarationsFiltered: vi.fn().mockReturnValue([]),
    getAllToolNames: vi.fn().mockReturnValue([]),
    ...toolRegistryMocks,
  } as unknown as ToolRegistry;

  vi.spyOn(config, 'getToolRegistry').mockReturnValue(mockToolRegistry);

  // Mock getContentGeneratorConfig to return a valid config
  vi.spyOn(config, 'getContentGeneratorConfig').mockReturnValue({
    model: DEFAULT_GEMINI_MODEL,
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

  describe('SubAgentScope', () => {
    let mockSendMessageStream: Mock;

    const defaultModelConfig: ModelConfig = {
      model: 'gemini-1.5-flash-latest',
      temp: 0.5, // Specific temp to test override
      top_p: 1,
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
        model: DEFAULT_GEMINI_MODEL,
        authType: undefined,
      });

      mockSendMessageStream = vi.fn();
      // We mock the implementation of the constructor.
      vi.mocked(GeminiChat).mockImplementation(
        () =>
          ({
            sendMessageStream: mockSendMessageStream,
          }) as unknown as GeminiChat,
      );

      // Mock GeminiClient constructor to return a properly mocked client
      const mockGeminiChat = {
        setTools: vi.fn(),
        getHistory: vi.fn().mockReturnValue([]),
        setHistory: vi.fn(),
        sendMessageStream: vi.fn(),
      };

      const mockGeminiClient = {
        getChat: vi.fn().mockReturnValue(mockGeminiChat),
        setTools: vi.fn().mockResolvedValue(undefined),
        isInitialized: vi.fn().mockReturnValue(true),
        getHistory: vi.fn().mockReturnValue([]),
        initialize: vi.fn().mockResolvedValue(undefined),
        setHistory: vi.fn(),
      };

      // Mock the GeminiClient constructor
      vi.mocked(GeminiClient).mockImplementation(
        () => mockGeminiClient as unknown as GeminiClient,
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
      const generationConfig = callArgs?.[2];
      // Ensure it's defined before proceeding
      expect(generationConfig).toBeDefined();
      if (!generationConfig) throw new Error('generationConfig is undefined');
      return generationConfig as GenerateContentConfig & {
        systemInstruction?: string | Content;
      };
    };

    describe('create (Tool Validation)', () => {
      const promptConfig: PromptConfig = { systemPrompt: 'Test prompt' };

      it('should create a SubAgentScope successfully with minimal config', async () => {
        const { config } = await createMockConfig();
        const scope = await SubAgentScope.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
        );
        expect(scope).toBeInstanceOf(SubAgentScope);
      });

      it('should not block creation when a tool may require confirmation', async () => {
        const mockTool = {
          name: 'risky_tool',
          schema: { parametersJsonSchema: { type: 'object', properties: {} } },
          build: vi.fn().mockReturnValue({
            shouldConfirmExecute: vi.fn().mockResolvedValue({
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

        const scope = await SubAgentScope.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
          toolConfig,
        );
        expect(scope).toBeInstanceOf(SubAgentScope);
      });

      it('should succeed if tools do not require confirmation', async () => {
        const mockTool = {
          name: 'safe_tool',
          schema: { parametersJsonSchema: { type: 'object', properties: {} } },
          build: vi.fn().mockReturnValue({
            shouldConfirmExecute: vi.fn().mockResolvedValue(null),
          }),
        };
        const { config } = await createMockConfig({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getTool: vi.fn().mockReturnValue(mockTool as any),
        });

        const toolConfig: ToolConfig = { tools: ['safe_tool'] };

        const scope = await SubAgentScope.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
          toolConfig,
        );
        expect(scope).toBeInstanceOf(SubAgentScope);
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

        const scope = await SubAgentScope.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
          toolConfig,
        );

        expect(scope).toBeInstanceOf(SubAgentScope);
        // Ensure build was not called during creation
        expect(mockToolWithParams.build).not.toHaveBeenCalled();
      });
    });

    describe('runNonInteractive - Initialization and Prompting', () => {
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

        const scope = await SubAgentScope.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
        );

        await scope.runNonInteractive(context);

        // Check if GeminiChat was initialized correctly by the subagent
        expect(GeminiChat).toHaveBeenCalledTimes(1);
        const callArgs = vi.mocked(GeminiChat).mock.calls[0];

        // Check Generation Config
        const generationConfig = getGenerationConfigFromMock();

        // Check temperature override
        expect(generationConfig.temperature).toBe(defaultModelConfig.temp);
        expect(generationConfig.systemInstruction).toContain(
          'Hello Agent, your task is Testing.',
        );
        expect(generationConfig.systemInstruction).toContain(
          'Important Rules:',
        );

        // Check History (should include environment context)
        const history = callArgs[3];
        expect(history).toEqual([
          { role: 'user', parts: [{ text: 'Env Context' }] },
          {
            role: 'model',
            parts: [{ text: 'Got it. Thanks for the context!' }],
          },
        ]);
      });

      it('should use initialMessages instead of systemPrompt if provided', async () => {
        const { config } = await createMockConfig();
        vi.mocked(GeminiChat).mockClear();

        const initialMessages: Content[] = [
          { role: 'user', parts: [{ text: 'Hi' }] },
        ];
        const promptConfig: PromptConfig = { initialMessages };
        const context = new ContextState();

        // Model stops immediately
        mockSendMessageStream.mockImplementation(createMockStream(['stop']));

        const scope = await SubAgentScope.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
        );

        await scope.runNonInteractive(context);

        const callArgs = vi.mocked(GeminiChat).mock.calls[0];
        const generationConfig = getGenerationConfigFromMock();
        const history = callArgs[3];

        expect(generationConfig.systemInstruction).toBeUndefined();
        expect(history).toEqual([
          { role: 'user', parts: [{ text: 'Env Context' }] },
          {
            role: 'model',
            parts: [{ text: 'Got it. Thanks for the context!' }],
          },
          ...initialMessages,
        ]);
      });

      it('should throw an error if template variables are missing', async () => {
        const { config } = await createMockConfig();
        const promptConfig: PromptConfig = {
          systemPrompt: 'Hello ${name}, you are missing ${missing}.',
        };
        const context = new ContextState();
        context.set('name', 'Agent');
        // 'missing' is not set

        const scope = await SubAgentScope.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
        );

        // The error from templating causes the runNonInteractive to reject and the terminate_reason to be ERROR.
        await expect(scope.runNonInteractive(context)).rejects.toThrow(
          'Missing context values for the following keys: missing',
        );
        expect(scope.getTerminateMode()).toBe(SubagentTerminateMode.ERROR);
      });

      it('should validate that systemPrompt and initialMessages are mutually exclusive', async () => {
        const { config } = await createMockConfig();
        const promptConfig: PromptConfig = {
          systemPrompt: 'System',
          initialMessages: [{ role: 'user', parts: [{ text: 'Hi' }] }],
        };
        const context = new ContextState();

        const agent = await SubAgentScope.create(
          'TestAgent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
        );

        await expect(agent.runNonInteractive(context)).rejects.toThrow(
          'PromptConfig cannot have both `systemPrompt` and `initialMessages` defined.',
        );
        expect(agent.getTerminateMode()).toBe(SubagentTerminateMode.ERROR);
      });
    });

    describe('runNonInteractive - Execution and Tool Use', () => {
      const promptConfig: PromptConfig = { systemPrompt: 'Execute task.' };

      it('should terminate with GOAL if no outputs are expected and model stops', async () => {
        const { config } = await createMockConfig();
        // Model stops immediately
        mockSendMessageStream.mockImplementation(createMockStream(['stop']));

        const scope = await SubAgentScope.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
          // No ToolConfig, No OutputConfig
        );

        await scope.runNonInteractive(new ContextState());

        expect(scope.getTerminateMode()).toBe(SubagentTerminateMode.GOAL);
        expect(mockSendMessageStream).toHaveBeenCalledTimes(1);
        // Check the initial message
        expect(mockSendMessageStream.mock.calls[0][0].message).toEqual([
          { text: 'Get Started!' },
        ]);
      });

      it('should terminate with GOAL when model provides final text', async () => {
        const { config } = await createMockConfig();

        // Model stops immediately with text response
        mockSendMessageStream.mockImplementation(createMockStream(['stop']));

        const scope = await SubAgentScope.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
        );

        await scope.runNonInteractive(new ContextState());

        expect(scope.getTerminateMode()).toBe(SubagentTerminateMode.GOAL);
        expect(mockSendMessageStream).toHaveBeenCalledTimes(1);
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
          shouldConfirmExecute: vi.fn().mockResolvedValue(false),
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

        const scope = await SubAgentScope.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
          toolConfig,
        );

        await scope.runNonInteractive(new ContextState());

        // Check the response sent back to the model (functionResponse part)
        const secondCallArgs = mockSendMessageStream.mock.calls[1][0];
        const parts = secondCallArgs.message as unknown[];
        expect(Array.isArray(parts)).toBe(true);
        const firstPart = parts[0] as Part;
        expect(firstPart.functionResponse?.response?.['output']).toBe(
          'file1.txt\nfile2.ts',
        );

        expect(scope.getTerminateMode()).toBe(SubagentTerminateMode.GOAL);
      });
    });

    describe('runNonInteractive - Termination and Recovery', () => {
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

        const scope = await SubAgentScope.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          runConfig,
        );

        await scope.runNonInteractive(new ContextState());

        expect(mockSendMessageStream).toHaveBeenCalledTimes(2);
        expect(scope.getTerminateMode()).toBe(SubagentTerminateMode.MAX_TURNS);
      });

      it('should terminate with TIMEOUT if the time limit is reached during an LLM call', async () => {
        // Use fake timers to reliably test timeouts
        vi.useFakeTimers();

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

        const scope = await SubAgentScope.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          runConfig,
        );

        const runPromise = scope.runNonInteractive(new ContextState());

        // Advance time beyond the limit (6 minutes) while the agent is awaiting the LLM response.
        await vi.advanceTimersByTimeAsync(6 * 60 * 1000);

        // Now resolve the stream. The model returns 'stop'.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        resolveStream!(createMockStream(['stop'])() as any);

        await runPromise;

        expect(scope.getTerminateMode()).toBe(SubagentTerminateMode.TIMEOUT);
        expect(mockSendMessageStream).toHaveBeenCalledTimes(1);

        vi.useRealTimers();
      });

      it('should terminate with ERROR if the model call throws', async () => {
        const { config } = await createMockConfig();
        mockSendMessageStream.mockRejectedValue(new Error('API Failure'));

        const scope = await SubAgentScope.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          defaultRunConfig,
        );

        await expect(
          scope.runNonInteractive(new ContextState()),
        ).rejects.toThrow('API Failure');
        expect(scope.getTerminateMode()).toBe(SubagentTerminateMode.ERROR);
      });
    });
  });
});

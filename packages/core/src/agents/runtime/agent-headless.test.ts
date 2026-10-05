/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FunctionCall, FunctionDeclaration, Part } from '@google/genai';
import { Type } from '@google/genai';
import {
  getHookExecutionOwner,
  runWithHookExecutionOwner,
} from '../../hooks/hook-execution-context.js';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import {
  ApprovalMode,
  Config,
  deriveApprovalModeConfig,
  deriveConfig,
  deriveWorktreeConfig,
} from '../../config/config.js';
import type { ExecutionEnvironment } from '../../services/execution-environment.js';
import { DEFAULT_QWEN_MODEL } from '../../config/models.js';
import {
  createContentGenerator,
  createContentGeneratorConfig,
  resolveContentGeneratorConfigWithSources,
  AuthType,
} from '../../core/contentGenerator.js';
import { LlmChat } from '../../core/llm-chat.js';
import { LlmEventType } from '../../core/turn.js';
import {
  getToolCallFingerprint,
  normalizeModelToolCallIds,
} from '../../core/toolCallIdUtils.js';
import { executeToolCall } from '../../core/nonInteractiveToolExecutor.js';
import { getInitialChatHistory } from '../../core/environmentContext.js';
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
  type AgentEventMap,
} from './agent-events.js';
import type {
  ModelConfig,
  PromptConfig,
  RunConfig,
  ToolConfig,
} from './agent-types.js';
import { AgentTerminateMode } from './agent-types.js';
import { beginRetryWait } from '../../utils/retry-wait.js';
import { DEFAULT_STALL_MS, runStallResilient } from './workflow-stall.js';
import {
  isWorkflowAgentFailedError,
  WorkflowAgentFailedError,
} from './workflow-agent-failure.js';
import { WriteFileTool } from '../../tools/write-file.js';
import { ToolNames } from '../../tools/tool-names.js';
import { normalizeToolNameForProvider } from '../../utils/tool-name-utils.js';
import { LoopDetectionService } from '../../services/loopDetectionService.js';
import { logSubagentExecution } from '../../telemetry/loggers.js';
import type { SubagentExecutionEvent } from '../../telemetry/types.js';
import {
  fnCall,
  modelText,
  streamOf,
  userText,
} from '../../test-utils/model-fixtures.js';

vi.mock('../../core/llm-chat.js');
vi.mock('../../core/contentGenerator.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../core/contentGenerator.js')>();
  const { DEFAULT_QWEN_MODEL } = await import('../../config/models.js');
  return {
    ...actual,
    createContentGenerator: vi.fn().mockResolvedValue({
      generateContent: vi.fn(),
      generateContentStream: vi.fn(),
      embedContent: vi.fn(),
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
vi.mock('../../core/environmentContext.js', () => ({
  SYSTEM_REMINDER_OPEN: '<system-reminder>',
  getEnvironmentContext: vi.fn().mockResolvedValue([{ text: 'Env Context' }]),
  getInitialChatHistory: vi.fn(async (_config, extraHistory) => [
    [
      {
        role: 'user',
        parts: [{ text: '<system-reminder>\nEnv Context\n</system-reminder>' }],
      },
      ...(extraHistory ?? []),
    ],
    [],
  ]),
}));
vi.mock('../../core/nonInteractiveToolExecutor.js');
vi.mock('../../ide/ide-client.js');
vi.mock('../../core/client.js');
vi.mock('../../telemetry/loggers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../telemetry/loggers.js')>()),
  logSubagentExecution: vi.fn(),
}));

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
  SubagentManagerMock.prototype.getAvailableModelGrades = () => new Map();
  return { SubagentManager: SubagentManagerMock };
});

async function createMockConfig(
  toolRegistryMocks = {},
): Promise<{ config: Config; toolRegistry: ToolRegistry }> {
  const config = new Config({
    model: DEFAULT_QWEN_MODEL,
    targetDir: '.',
    debugMode: false,
    cwd: process.cwd(),
    // Avoid writing any chat recording records from tests (e.g. via tool-call telemetry).
    chatRecording: false,
  });
  await config.initialize();
  await config.refreshAuth(AuthType.USE_GEMINI);

  const mockToolRegistry = {
    warmAll: vi.fn().mockResolvedValue(undefined),
    getTool: vi.fn(),
    getFunctionDeclarations: vi.fn().mockReturnValue([]),
    getFunctionDeclarationsFiltered: vi.fn().mockReturnValue([]),
    getAllToolNames: vi.fn().mockReturnValue([]),
    ensureTool: vi.fn(async (name: string) => mockToolRegistry.getTool(name)),
    ...toolRegistryMocks,
  } as unknown as ToolRegistry;
  vi.spyOn(config, 'getToolRegistry').mockReturnValue(mockToolRegistry);
  vi.spyOn(config, 'getContentGeneratorConfig').mockReturnValue({
    model: DEFAULT_QWEN_MODEL,
    authType: AuthType.USE_GEMINI,
  });
  vi.spyOn(config, 'setModel').mockResolvedValue();
  vi.spyOn(config, 'getSessionId').mockReturnValue('test-session');

  return { config, toolRegistry: mockToolRegistry };
}

// Stream events as LlmChat.sendMessageStream yields them. Candidate content
// carries no role, so modelChunk (which adds one) does not fit.
const partsChunk = (parts: Part[], finishReason?: string) => ({
  type: 'chunk',
  value: {
    candidates: [
      {
        ...(finishReason !== undefined ? { finishReason } : {}),
        content: { parts },
      },
    ],
  },
});
const callsChunk = (functionCalls: FunctionCall[], extra: object = {}) => ({
  type: 'chunk',
  value: { functionCalls, ...extra },
});
/** A bare FunctionCall (fnCall wraps one in a Part); `id` only when given. */
const call = (
  name: string,
  args: Record<string, unknown>,
  id?: string,
): FunctionCall => ({ ...(id !== undefined ? { id } : {}), name, args });

// Simulates LLM responses, one entry per round: tool calls or 'stop'. 'stop',
// an empty list and rounds past the end all answer with text, since the
// subagent only cares that no functionCalls arrive. Resolves to the
// generator, matching sendMessageStream's signature.
const createMockStream = (
  functionCallsList: Array<FunctionCall[] | 'stop'>,
) => {
  let index = 0;
  return vi.fn().mockImplementation(async () => {
    const response = functionCallsList[index++] || 'stop';
    return streamOf(
      response === 'stop' || response.length === 0
        ? partsChunk([{ text: 'Done.' }])
        : callsChunk(response),
    );
  });
};

const contextWith = (values: Record<string, unknown> = {}) => {
  const context = new ContextState();
  for (const [key, value] of Object.entries(values)) context.set(key, value);
  return context;
};

// Tool fixtures. Each builder emits exactly the keys the hand-written
// literals had; display fields, MCP identity and output flags are absent
// unless passed.
const decl = (name: string, description: string): FunctionDeclaration => ({
  name,
  description,
  parameters: { type: Type.OBJECT, properties: {} },
});
const invocation = (
  params: object,
  description: string,
  execute: Mock = vi.fn(),
  permission = 'allow',
) => ({
  params,
  getDescription: vi.fn().mockReturnValue(description),
  toolLocations: vi.fn().mockReturnValue([]),
  getDefaultPermission: vi.fn().mockResolvedValue(permission),
  execute,
});
const toolResult = (llmContent: string, returnDisplay = llmContent) =>
  vi.fn().mockResolvedValue({ llmContent, returnDisplay });
/** A registry tool named after its schema; `build` returns `inv` if given. */
const mockTool = (
  schema: FunctionDeclaration,
  inv?: object,
  fields: object = {},
) =>
  ({
    name: schema.name,
    ...fields,
    schema,
    build: inv ? vi.fn().mockReturnValue(inv) : vi.fn(),
  }) as unknown as AnyDeclarativeTool;
const OUTPUT_FLAGS = { canUpdateOutput: false, isOutputMarkdown: true };
const builtin = (
  displayName: string,
  description: string,
  kind = 'READ',
  isOutputMarkdown = true,
) => ({
  displayName,
  description,
  kind,
  canUpdateOutput: false,
  isOutputMarkdown,
});
const mcp = (serverName: string, serverToolName: string, flags = true) => ({
  serverName,
  serverToolName,
  ...(flags ? OUTPUT_FLAGS : {}),
});
const byName =
  (...tools: AnyDeclarativeTool[]) =>
  (name: string) =>
    tools.find((tool) => tool.name === name);

/** Records every `type` event the emitter fires, in order. */
function recordEvents<E extends keyof AgentEventMap>(
  emitter: AgentEventEmitter,
  type: E,
) {
  const events: Array<AgentEventMap[E]> = [];
  emitter.on(type, (event) => events.push(event));
  return events;
}
/** A fresh emitter, then one recorded-events array per requested type. */
function eventLog<T extends Array<keyof AgentEventMap>>(...types: T) {
  const emitter = new AgentEventEmitter();
  const logs = types.map((type) => recordEvents(emitter, type));
  return [emitter, ...logs] as [
    AgentEventEmitter,
    ...{
      [K in keyof T]: T[K] extends keyof AgentEventMap
        ? Array<AgentEventMap[T[K]]>
        : never;
    },
  ];
}

// A registry whose only tool is a built-in READ tool: `def` is the whole
// filtered declaration list and getTool resolves the tool by name.
async function setupReadTool<I extends object>(
  def: FunctionDeclaration,
  inv: I,
  displayName: string,
  description: string,
  isOutputMarkdown = true,
) {
  const tool = mockTool(
    def,
    inv,
    builtin(displayName, description, 'READ', isOutputMarkdown),
  );
  const { config } = await createMockConfig({
    getFunctionDeclarationsFiltered: vi.fn().mockReturnValue([def]),
    getTool: vi.fn(byName(tool)),
  });
  return { config, inv, toolConfig: { tools: [def.name!] } };
}
const setupListFiles = (
  params = { path: '.' },
  llmContent = 'file1.txt\nfile2.ts',
  returnDisplay = 'Listed 2 files',
) =>
  setupReadTool(
    decl('list_files', 'Lists files'),
    invocation(params, 'List files', toolResult(llmContent, returnDisplay)),
    'List Files',
    'List files in directory',
  );

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
    it.each([
      [
        'should replace valid identifier placeholders',
        'Hello ${name}, your task is ${task}.',
        { name: 'Agent', task: 'Testing' },
        'Hello Agent, your task is Testing.',
      ],
      [
        'should treat ${0} as literal text, not as a placeholder',
        'Do not write ${0} in your code.',
        {},
        'Do not write ${0} in your code.',
      ],
      [
        'should treat ${1} and ${2} as literal text',
        'Use {0} and {1}, not ${0} or ${1}.',
        {},
        'Use {0} and {1}, not ${0} or ${1}.',
      ],
      [
        'should handle ${0} alongside valid placeholders without error',
        'Hello ${name}. Do not write ${0} or ${1}.',
        { name: 'Agent' },
        'Hello Agent. Do not write ${0} or ${1}.',
      ],
    ])('%s', (_title, template, values, expected) => {
      expect(templateString(template, contextWith(values))).toBe(expected);
    });

    it('should still throw for missing valid identifier placeholders', () => {
      expect(() =>
        templateString(
          'Hello ${name}, missing ${missing}.',
          contextWith({ name: 'Agent' }),
        ),
      ).toThrow('Missing context values for the following keys: missing');
    });

    it('should handle mixed numeric and identifier placeholders', () => {
      // ${var} and ${_private} are valid identifiers; ${0} is literal
      // ${_private} is missing from context, so it should throw
      expect(() =>
        templateString(
          '${var} and ${0} and ${_private}',
          contextWith({ var: 'value' }),
        ),
      ).toThrow('Missing context values for the following keys: _private');
    });
  });

  describe('AgentHeadless', () => {
    let mockSendMessageStream: Mock;
    let mockGetHistoryToolCallFingerprints: Mock;

    const defaultModelConfig: ModelConfig = { model: 'qwen3-coder-plus' };
    const defaultRunConfig: RunConfig = { max_time_minutes: 5, max_turns: 10 };

    beforeEach(async () => {
      vi.clearAllMocks();

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
      mockGetHistoryToolCallFingerprints = vi.fn(
        () => new Map<string, string>(),
      );
      vi.mocked(LlmChat).mockImplementation(
        () =>
          ({
            sendMessageStream: mockSendMessageStream,
            setLastPromptTokenCount: vi.fn(),
            getHistoryToolCallFingerprints: mockGetHistoryToolCallFingerprints,
          }) as unknown as LlmChat,
      );

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

    const EXECUTE_PROMPT: PromptConfig = { systemPrompt: 'Execute task.' };
    const FORK_PROMPT: PromptConfig = { systemPrompt: 'Test prompt' };
    type AgentOptions = {
      prompt?: PromptConfig;
      run?: RunConfig;
      tools?: ToolConfig;
      emitter?: AgentEventEmitter;
      name?: string;
    };
    const createAgent = (config: Config, o: AgentOptions = {}) =>
      AgentHeadless.create(
        o.name ?? 'test-agent',
        config,
        o.prompt ?? EXECUTE_PROMPT,
        defaultModelConfig,
        o.run ?? defaultRunConfig,
        o.tools,
        o.emitter,
      );
    // Creates the agent, lets `setup` configure it, then runs one execute().
    const runAgent = async (
      config: Config,
      {
        context,
        setup,
        ...o
      }: AgentOptions & {
        context?: ContextState;
        setup?: (scope: AgentHeadless) => void;
      } = {},
    ) => {
      const scope = await createAgent(config, o);
      setup?.(scope);
      await scope.execute(context ?? new ContextState());
      return scope;
    };
    // Answers each model round in turn (see createMockStream).
    const respond = (...rounds: Array<FunctionCall[] | 'stop'>) =>
      mockSendMessageStream.mockImplementation(createMockStream(rounds));
    /** The message parts sent to the model on call `n` (0-based). */
    const sentParts = (n: number) =>
      mockSendMessageStream.mock.calls[n][1].message as Part[];
    const expectExecuteError = async (
      scope: AgentHeadless,
      message: string,
      context = new ContextState(),
    ) => {
      await expect(scope.execute(context)).rejects.toThrow(message);
      expect(scope.getTerminateMode()).toBe(AgentTerminateMode.ERROR);
    };

    describe('create (Tool Validation)', () => {
      const prompt = FORK_PROMPT;
      const containerConfig = () =>
        new Config({
          model: DEFAULT_QWEN_MODEL,
          targetDir: process.cwd(),
          cwd: process.cwd(),
          debugMode: false,
          agentExecutionBackend: 'container',
        });
      // Creates the agent with `tool` as its only registry tool and tool name.
      const createWithTool = async (
        tool: Record<string, unknown> & { name: string },
        registry = {},
      ) => {
        const { config } = await createMockConfig({
          getTool: vi.fn().mockReturnValue(tool),
          ...registry,
        });
        return createAgent(config, { prompt, tools: { tools: [tool.name] } });
      };

      it('rejects a container requirement through real worktree and approval overlays', async () => {
        const scoped = deriveApprovalModeConfig(
          deriveWorktreeConfig(containerConfig(), process.cwd()),
          ApprovalMode.DEFAULT,
        );
        try {
          await expect(
            createAgent(scoped.config, {
              prompt,
              name: 'unsupported-direct-agent',
            }),
          ).rejects.toThrow('has no execution environment');
          expect(LlmChat).not.toHaveBeenCalled();
          expect(executeToolCall).not.toHaveBeenCalled();
        } finally {
          scoped.cleanup();
        }
      });

      it('allows a required container with its injected environment and no factory', async () => {
        const environment = {} as ExecutionEnvironment;
        const scoped = deriveConfig(containerConfig(), {
          getExecutionEnvironment: () => environment,
        });
        expect(scoped.getExecutionEnvironmentFactory()).toBeUndefined();
        await expect(
          createAgent(scoped, { prompt, name: 'contained-agent' }),
        ).resolves.toBeInstanceOf(AgentHeadless);
      });

      it('should create a AgentHeadless successfully with minimal config', async () => {
        const { config } = await createMockConfig();
        expect(await createAgent(config, { prompt })).toBeInstanceOf(
          AgentHeadless,
        );
      });

      it('should not block creation when a tool may require confirmation', async () => {
        const scope = await createWithTool({
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
        });
        expect(scope).toBeInstanceOf(AgentHeadless);
      });

      it('should succeed if tools do not require confirmation', async () => {
        const scope = await createWithTool({
          name: 'safe_tool',
          schema: { parametersJsonSchema: { type: 'object', properties: {} } },
          build: vi.fn().mockReturnValue({
            getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          }),
        });
        expect(scope).toBeInstanceOf(AgentHeadless);
      });

      it('should allow creation regardless of tool parameter requirements', async () => {
        const mockToolWithParams = {
          name: 'tool_with_params',
          schema: {
            parametersJsonSchema: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
            },
          },
          build: vi.fn(),
        };
        const scope = await createWithTool(mockToolWithParams, {
          getAllTools: vi.fn().mockReturnValue([mockToolWithParams]),
        });

        expect(scope).toBeInstanceOf(AgentHeadless);
        expect(mockToolWithParams.build).not.toHaveBeenCalled();
      });
    });

    describe('execute - Initialization and Prompting', () => {
      it('owns createChat and prepareTools before entering the reasoning loop', async () => {
        const { config } = await createMockConfig();
        vi.spyOn(config, 'getHookSystem').mockReturnValue({
          runtimeId: 'headless-runtime',
        } as unknown as ReturnType<Config['getHookSystem']>);
        const scope = await AgentHeadless.create(
          'A',
          config,
          { systemPrompt: '' },
          defaultModelConfig,
          defaultRunConfig,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          'explicit-A',
        );
        const expected = {
          runtimeId: 'headless-runtime',
          sessionId: config.getSessionId(),
          agentId: scope.getCore().subagentId,
        };
        const stages: string[] = [];
        vi.spyOn(scope.getCore(), 'createChat').mockImplementation(async () => {
          stages.push('chat');
          expect(getHookExecutionOwner()).toEqual(expected);
          return {} as LlmChat;
        });
        vi.spyOn(scope.getCore(), 'prepareTools').mockImplementation(
          async () => {
            stages.push('prepare');
            expect(getHookExecutionOwner()).toEqual(expected);
            throw new Error('stop after preparation');
          },
        );
        const foreign = {
          runtimeId: 'other',
          sessionId: 'other',
          agentId: 'B',
        };
        await runWithHookExecutionOwner(foreign, async () => {
          await expect(scope.execute(new ContextState())).rejects.toThrow(
            'stop after preparation',
          );
          expect(getHookExecutionOwner()).toEqual(foreign);
        });
        expect(stages).toEqual(['chat', 'prepare']);
      });

      it('sends an explicit empty tools list for a no-tool agent', async () => {
        const { config } = await createMockConfig();
        mockSendMessageStream.mockImplementation(createMockStream(['stop']));
        const scope = await AgentHeadless.create(
          'metadata-only-agent',
          config,
          { systemPrompt: 'Return metadata.' },
          defaultModelConfig,
          defaultRunConfig,
          { tools: [] },
        );
        await scope.execute(new ContextState());
        expect(mockSendMessageStream.mock.calls[0][1].config.tools).toEqual([]);
      });

      const prompt: PromptConfig = { systemPrompt: 'You are a test agent.' };

      // Runs `promptConfig` against a model that stops at once; returns the
      // system instruction and history LlmChat was built with.
      const runPrompt = async (
        config: Config,
        promptConfig: PromptConfig,
        context = new ContextState(),
      ) => {
        vi.mocked(LlmChat).mockClear();
        respond('stop');
        await runAgent(config, { prompt: promptConfig, context });
        const [, generationConfig, history] =
          vi.mocked(LlmChat).mock.calls[0] ?? [];
        expect(generationConfig).toBeDefined();
        return {
          system: generationConfig!.systemInstruction as string,
          history,
        };
      };
      // A config with stubbed user memory and, when given, auto-memory prompt.
      const memoryConfig = async (userMemory: string, autoMemory?: string) => {
        const { config } = await createMockConfig();
        vi.spyOn(config, 'getUserMemory').mockReturnValue(userMemory);
        if (autoMemory !== undefined)
          vi.spyOn(config, 'getAutoMemoryPrompt').mockReturnValue(autoMemory);
        return config;
      };

      it('should correctly template the system prompt and initialize LlmChat', async () => {
        const { config } = await createMockConfig();
        const { system, history } = await runPrompt(
          config,
          { systemPrompt: 'Hello ${name}, your task is ${task}.' },
          contextWith({ name: 'Agent', task: 'Testing' }),
        );

        expect(LlmChat).toHaveBeenCalledTimes(1);
        expect(system).toContain('Hello Agent, your task is Testing.');
        expect(system).toContain('Important Rules:');
        // History should include the environment context.
        expect(getInitialChatHistory).toHaveBeenCalledWith(config, undefined, {
          includeDeferredToolsReminder: false,
          includeAvailableSkillsReminder: true,
        });
        expect(history).toEqual([
          userText('<system-reminder>\nEnv Context\n</system-reminder>'),
        ]);
      });

      it('withholds the skills reminder from an agent whose policy denies Skill', async () => {
        // Pins the consumer wiring, not just the predicate. The skill-gate
        // suite calls `willHaveSkillTool()` directly, so hardcoding `true` at
        // the `includeAvailableSkillsReminder` call site keeps that suite green
        // while every skill-denied subagent receives an `<available_skills>`
        // listing it cannot act on — the listing-versus-capability
        // disagreement #12424 exists to remove. A finite allowlist omitting
        // `skill` is one of the two shapes in #12424's measured scope.
        const { config } = await createMockConfig();

        vi.mocked(LlmChat).mockClear();
        vi.mocked(getInitialChatHistory).mockClear();
        mockSendMessageStream.mockImplementation(createMockStream(['stop']));

        const toolConfig: ToolConfig = { tools: [ToolNames.READ_FILE] };
        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          { systemPrompt: 'Test prompt' },
          defaultModelConfig,
          defaultRunConfig,
          toolConfig,
        );

        await scope.execute(new ContextState());

        expect(getInitialChatHistory).toHaveBeenCalledWith(config, undefined, {
          includeDeferredToolsReminder: false,
          includeAvailableSkillsReminder: false,
        });
      });

      it('should reuse chat and tools for sequential follow-up turns', async () => {
        const { config, toolRegistry } = await createMockConfig();
        respond('stop', 'stop');
        const scope = await createAgent(config, { prompt });
        const externalMessages = recordEvents(
          scope.getEventEmitter(),
          AgentEventType.EXTERNAL_MESSAGE,
        );

        await scope.execute(contextWith({ task_prompt: 'Initial task' }));
        scope.getCore().recordToolCallStats('stale_tool', true, 25);
        scope.getCore().stats.recordTokens(100, 50);
        await scope.execute(contextWith({ task_prompt: 'Follow-up task' }));

        expect(LlmChat).toHaveBeenCalledTimes(1);
        expect(toolRegistry.warmAll).toHaveBeenCalledTimes(1);
        expect(mockSendMessageStream).toHaveBeenCalledTimes(2);
        expect(sentParts(0)).toEqual([{ text: 'Initial task' }]);
        expect(sentParts(1)).toEqual([
          { text: '[Message from parent agent]: Follow-up task' },
        ]);
        const [firstId, secondId] = mockSendMessageStream.mock.calls.map(
          (args) => args[2],
        );
        expect(firstId).not.toBe(secondId);
        expect(firstId).toMatch(/#0$/);
        expect(secondId).toMatch(/#1$/);
        expect(externalMessages.map((event) => event.text)).toEqual([
          'Follow-up task',
        ]);
        const freshStats = {
          rounds: 1,
          totalToolCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          toolUsage: [],
        };
        expect(scope.getExecutionSummary()).toMatchObject(freshStats);
        expect(scope.getStatistics()).toMatchObject(freshStats);
      });

      it('should continue with atomically claimed finishing inputs', async () => {
        const { config } = await createMockConfig();
        respond('stop', 'stop');
        const scope = await createAgent(config, { prompt });
        const externalEvents = recordEvents(
          scope.getEventEmitter(),
          AgentEventType.EXTERNAL_MESSAGE,
        );

        await scope.execute(contextWith({ task_prompt: 'Initial task' }));
        await scope.executeExternalInputs(
          ['late correction', { kind: 'notification', text: 'monitor fired' }],
          undefined,
          { resetStats: false },
        );

        expect(sentParts(1)).toEqual([
          { text: '[Message from parent agent]: late correction' },
          { text: 'monitor fired' },
        ]);
        expect(
          externalEvents.map(({ kind, text }) => ({ kind, text })),
        ).toEqual([
          { kind: 'message', text: 'late correction' },
          { kind: 'notification', text: 'monitor fired' },
        ]);
        expect(scope.getExecutionSummary()).toMatchObject({ rounds: 2 });
      });

      it('should keep usage rounds unique across finishing input segments', async () => {
        const { config } = await createMockConfig();
        const chunk = partsChunk([{ text: 'Done.' }]);
        mockSendMessageStream.mockImplementation(async () =>
          streamOf({
            ...chunk,
            value: { ...chunk.value, usageMetadata: { totalTokenCount: 1 } },
          }),
        );
        const scope = await createAgent(config, { prompt });
        const usage = recordEvents(
          scope.getEventEmitter(),
          AgentEventType.USAGE_METADATA,
        );

        await scope.execute(new ContextState());
        await scope.executeExternalInputs(['late correction'], undefined, {
          resetStats: false,
        });

        expect(usage.map((event) => event.round)).toEqual([1, 2]);
      });

      it('should preserve statistics for continuation work in the same logical turn', async () => {
        const { config } = await createMockConfig();
        respond('stop', 'stop');
        const scope = await runAgent(config, { prompt });
        const core = scope.getCore();
        core.recordToolCallStats('first_attempt_tool', true, 25);
        core.stats.recordTokens(100, 50);
        const logicalTurnStart = Date.now() - 10_000;
        Object.assign(core.executionStats, {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          startTimeMs: logicalTurnStart,
        });
        core.stats.start(logicalTurnStart);

        await scope.execute(
          contextWith({ task_prompt: 'Address the stop-hook reason' }),
          undefined,
          { resetStats: false },
        );

        const carried = {
          rounds: 2,
          totalToolCalls: 1,
          successfulToolCalls: 1,
          inputTokens: 100,
          outputTokens: 50,
        };
        expect(scope.getExecutionSummary()).toMatchObject(carried);
        expect(core.executionStats.startTimeMs).toBe(logicalTurnStart);
        expect(core.executionStats.totalDurationMs).toBeGreaterThanOrEqual(
          10_000,
        );
        expect(scope.getStatistics()).toMatchObject({
          ...carried,
          totalDurationMs: expect.any(Number),
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
            yield partsChunk([{ text: 'Done.' }]);
          })(),
        );

        const scope = await createAgent(config, { prompt });
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

        const scope = await runAgent(config, { prompt });
        expect(scope.getFinalText()).toBe('Done.');
        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.GOAL);

        await expectExecuteError(
          scope,
          'follow-up failed',
          contextWith({ task_prompt: 'Follow-up task' }),
        );
        expect(scope.getFinalText()).toBe('');
      });

      it('should append userMemory to the system prompt when available', async () => {
        const { system } = await runPrompt(
          await memoryConfig(
            '# Output language preference: English\nRespond in English.',
          ),
          prompt,
        );
        expect(system).toContain('You are a test agent.');
        expect(system).toContain('Important Rules:');
        expect(system).toContain('# Output language preference: English');
        expect(system).toContain('Respond in English.');
      });

      it('should not append userMemory separator when userMemory is empty', async () => {
        const { system } = await runPrompt(await memoryConfig('', ''), prompt);
        expect(system).toContain('You are a test agent.');
        expect(system).not.toContain('---');
      });

      it('should not append userMemory separator when userMemory is whitespace-only', async () => {
        const { system } = await runPrompt(
          await memoryConfig('   \n\n  ', ''),
          prompt,
        );
        expect(system).not.toContain('---');
      });

      it('should append the auto-memory section to the system prompt when available', async () => {
        const autoMemoryContent = '# auto memory\nMEMORY_INDEX_MARKER';
        const { system } = await runPrompt(
          await memoryConfig('', autoMemoryContent),
          prompt,
        );
        expect(system).toContain('You are a test agent.');
        // The volatile auto-memory section must be present as the trailing
        // block, separated by the `---` suffix separator.
        expect(system).toContain('MEMORY_INDEX_MARKER');
        expect(system).toContain('---');
        expect(system.trimEnd().endsWith(autoMemoryContent)).toBe(true);
      });

      it('should replace env history with initialMessages when both initialMessages and systemPrompt are set', async () => {
        const { config } = await createMockConfig();
        const initialMessages = [
          userText('prior user turn'),
          modelText('prior model turn'),
        ];
        const { system, history } = await runPrompt(
          config,
          { systemPrompt: 'System ${name}.', initialMessages },
          contextWith({ name: 'Agent' }),
        );

        // systemPrompt is templated normally.
        expect(system).toContain('System Agent.');
        expect(system).toContain('Important Rules:');
        // Env bootstrap is skipped; history is exactly initialMessages.
        expect(history).toEqual(initialMessages);
      });

      it('should skip env history when initialMessages is an empty array', async () => {
        const { config } = await createMockConfig();
        vi.mocked(getInitialChatHistory).mockClear();
        const { system, history } = await runPrompt(
          config,
          { systemPrompt: 'System ${name}.', initialMessages: [] },
          contextWith({ name: 'Agent' }),
        );

        expect(system).toContain('System Agent.');
        expect(history).toEqual([]);
        expect(getInitialChatHistory).not.toHaveBeenCalled();
      });

      it('should use renderedSystemPrompt verbatim and bypass templating', async () => {
        const { config } = await createMockConfig();
        const rendered = 'Verbatim parent system prompt ${name}';
        const { system } = await runPrompt(config, {
          renderedSystemPrompt: rendered,
          initialMessages: [userText('hi'), modelText('ok')],
        });
        // No ${name} substitution and no non-interactive rules appended.
        expect(system).toBe(rendered);
      });

      it('should throw an error if template variables are missing', async () => {
        const { config } = await createMockConfig();
        const scope = await createAgent(config, {
          prompt: {
            systemPrompt: 'Hello ${name}, you are missing ${missing}.',
          },
        });
        // 'missing' is not set: templating fails, execute rejects and the
        // terminate reason is ERROR.
        await expectExecuteError(
          scope,
          'Missing context values for the following keys: missing',
          contextWith({ name: 'Agent' }),
        );
      });

      it('should validate that systemPrompt and renderedSystemPrompt are mutually exclusive', async () => {
        const { config } = await createMockConfig();
        const agent = await createAgent(config, {
          name: 'TestAgent',
          prompt: { systemPrompt: 'System', renderedSystemPrompt: 'Rendered' },
        });
        await expectExecuteError(
          agent,
          'PromptConfig cannot have both `systemPrompt` and `renderedSystemPrompt` defined.',
        );
      });
    });

    describe('execute - Execution and Tool Use', () => {
      type Waiter = Parameters<AgentHeadless['setExternalMessageWaiter']>[0];
      // Idle-wait wiring: no queued inputs, `waiter` delivers wake-ups and
      // `predicate` decides whether to wait at all.
      const idleWaiter =
        (waiter: Waiter, predicate: () => boolean) =>
        (scope: AgentHeadless) => {
          scope.setExternalMessageProvider(() => []);
          scope.setExternalMessageWaiter(waiter);
          scope.setExternalMessageWaitPredicate(predicate);
        };
      const notification = (tag: string) => ({
        kind: 'notification' as const,
        text: `<task-notification>${tag}</task-notification>`,
      });
      const DUP_CALL_1 = 'Duplicate provider tool call id "call_1"';
      // A list_files call reusing provider id 'call_1', normalized as the chat
      // would with `usedIds` already taken.
      const collidingCall = (
        args: Record<string, unknown>,
        usedIds = new Set(['call_1']),
      ) =>
        normalizeModelToolCallIds(
          [fnCall('list_files', args, 'call_1')],
          usedIds,
          new Set<string>(),
        )[0]!.functionCall!;
      const historyHasCall1 = () =>
        mockGetHistoryToolCallFingerprints.mockReturnValue(
          new Map([
            ['call_1', getToolCallFingerprint('list_files', { path: '.' })],
          ]),
        );
      // The first part sent on model call `n` is the duplicate-id error for `id`.
      const expectDuplicateResponse = (n: number, id: string) => {
        const response = sentParts(n)[0].functionResponse;
        expect(response?.id).toBe(id);
        expect(response?.response?.['error']).toContain(DUP_CALL_1);
      };
      const responseFor = (parts: Part[], id: string) =>
        parts.find((part) => part.functionResponse?.id === id)
          ?.functionResponse;
      const errorFor = (parts: Part[], id: string) =>
        responseFor(parts, id)?.response?.['error'];
      // Runs a 'fork' agent over one round of `calls` then a stop, with getTool
      // backed by `getTool`; returns the parts sent back on the second call.
      const runFork = async (
        getTool: (name: string) => unknown,
        calls: FunctionCall[],
        tools: ToolConfig,
        options: Parameters<typeof runAgent>[1] = {},
      ) => {
        const { config } = await createMockConfig({ getTool: vi.fn(getTool) });
        respond(calls, 'stop');
        await runAgent(config, {
          name: 'fork',
          prompt: FORK_PROMPT,
          tools,
          ...options,
        });
        return sentParts(1);
      };
      // A fork whose only tool is read_file, called once on README.md.
      const runReadFileFork = async (executionAllowedTools: string[]) => {
        const toolDef = decl(ToolNames.READ_FILE, 'Reads a file');
        const tool = mockTool(toolDef);
        const parts = await runFork(
          () => tool,
          [call(ToolNames.READ_FILE, { path: 'README.md' }, 'call_read')],
          { tools: [toolDef], executionAllowedTools },
        );
        return { tool, response: parts[0]?.functionResponse };
      };
      /** `count` single-call rounds with ids `${prefix}_1`, `${prefix}_2`, ... */
      const rounds = (
        count: number,
        name: string,
        args: Record<string, unknown>,
        prefix: string,
      ) =>
        Array.from({ length: count }, (_, index) => [
          call(name, args, `${prefix}_${index + 1}`),
        ]);
      const setupTaskList = async (execute: Mock) => {
        const args = { status: 'in_progress', owner: 'peer-a', blockedBy: '' };
        const setup = await setupReadTool(
          decl('task_list', 'Lists team tasks'),
          invocation(args, 'List tasks', execute),
          'Task List',
          'List tasks in the team task list',
          false,
        );
        return {
          ...setup,
          args,
          polls: (count: number) => rounds(count, 'task_list', args, 'poll'),
        };
      };
      const frozenBoard = () =>
        toolResult('#7 [in_progress] @peer-a — task', 'Listed tasks');

      it('should terminate with GOAL if no outputs are expected and model stops', async () => {
        const { config } = await createMockConfig();
        respond('stop');
        const scope = await runAgent(config); // No ToolConfig, No OutputConfig

        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
        expect(mockSendMessageStream).toHaveBeenCalledTimes(1);
        expect(sentParts(0)).toEqual([{ text: 'Get Started!' }]);
      });

      it('should terminate with GOAL when model provides final text', async () => {
        const { config } = await createMockConfig();
        respond('stop');
        const scope = await runAgent(config);

        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
        expect(mockSendMessageStream).toHaveBeenCalledTimes(1);
      });

      it('should wait for external notification after a no-tool response', async () => {
        const { config } = await createMockConfig();
        respond('stop', 'stop');
        type Wake = Array<ReturnType<typeof notification>>;
        let resolveWait: ((inputs: Wake) => void) | undefined;
        const waitForExternalMessages = vi.fn(
          (_signal: AbortSignal) =>
            new Promise<Wake>((resolve) => {
              resolveWait = resolve;
            }),
        );
        let shouldWait = true;
        const scope = await createAgent(config);
        idleWaiter(waitForExternalMessages, () => shouldWait)(scope);

        const executePromise = scope.execute(new ContextState());
        await vi.waitFor(() =>
          expect(waitForExternalMessages).toHaveBeenCalled(),
        );
        shouldWait = false;
        resolveWait?.([notification('event')]);
        await executePromise;

        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
        expect(mockSendMessageStream).toHaveBeenCalledTimes(2);
        expect(sentParts(1)).toEqual([{ text: notification('event').text }]);
      });

      it('should finalize after an empty wake when no owner monitor remains running', async () => {
        const { config } = await createMockConfig();
        respond('stop');
        let shouldWait = true;
        const waitForExternalMessages = vi.fn(async () => {
          shouldWait = false;
          return [];
        });
        const scope = await runAgent(config, {
          setup: idleWaiter(waitForExternalMessages, () => shouldWait),
        });

        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
        expect(scope.getFinalText()).toBe('Done.');
        expect(waitForExternalMessages).toHaveBeenCalledTimes(1);
        expect(mockSendMessageStream).toHaveBeenCalledTimes(1);
      });

      it('should skip idle wait when the predicate flips false before wait registration', async () => {
        const { config } = await createMockConfig();
        respond('stop');
        let predicateCalls = 0;
        const waitForExternalMessages = vi.fn(async () => [
          notification('late'),
        ]);
        const scope = await runAgent(config, {
          setup: idleWaiter(
            waitForExternalMessages,
            () => ++predicateCalls === 1,
          ),
        });

        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
        expect(scope.getFinalText()).toBe('Done.');
        expect(waitForExternalMessages).not.toHaveBeenCalled();
        expect(mockSendMessageStream).toHaveBeenCalledTimes(1);
      });

      it('should keep waiting after an empty wake while an owner monitor is still running', async () => {
        const { config } = await createMockConfig();
        respond('stop', 'stop');
        let shouldWait = true;
        let waitCalls = 0;
        const waitForExternalMessages = vi.fn(async () => {
          if (++waitCalls === 1) return [];
          shouldWait = false;
          return [notification('event')];
        });
        const scope = await runAgent(config, {
          setup: idleWaiter(waitForExternalMessages, () => shouldWait),
        });

        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
        expect(waitForExternalMessages).toHaveBeenCalledTimes(2);
        expect(mockSendMessageStream).toHaveBeenCalledTimes(2);
        expect(sentParts(1)).toEqual([{ text: notification('event').text }]);
      });

      it('should drain queued external notification before finalizing', async () => {
        const { config } = await createMockConfig();
        respond('stop', 'stop');
        const pendingInputs = [notification('terminal')];
        const scope = await runAgent(config, {
          setup: (s) =>
            s.setExternalMessageProvider(() => pendingInputs.splice(0)),
        });

        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
        expect(mockSendMessageStream).toHaveBeenCalledTimes(2);
        expect(sentParts(1)).toEqual([{ text: notification('terminal').text }]);
      });

      it('should not idle-wait when max turns prevents another round', async () => {
        const { config } = await createMockConfig();
        const waitForExternalMessages = vi.fn(async () => []);
        respond('stop');
        const scope = await runAgent(config, {
          run: { ...defaultRunConfig, max_turns: 1 },
          setup: idleWaiter(waitForExternalMessages, () => true),
        });

        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.MAX_TURNS);
        expect(waitForExternalMessages).not.toHaveBeenCalled();
      });

      it('should execute external tools and provide the response to the model', async () => {
        const { config, inv, toolConfig } = await setupListFiles();
        // Turn 1: the model calls the external tool. Turn 2: it stops.
        respond([call('list_files', { path: '.' }, 'call_1')], 'stop');
        const scope = await runAgent(config, { tools: toolConfig });

        // The tool output goes back to the model as a functionResponse part.
        const parts = sentParts(1);
        expect(Array.isArray(parts)).toBe(true);
        expect(parts[0].functionResponse?.response?.['output']).toBe(
          'file1.txt\nfile2.ts',
        );
        expect(inv.execute).toHaveBeenCalledTimes(1);
        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
      });

      it('keeps declarations unchanged while enforcing the execution allowlist', async () => {
        const readFileToolDef = decl(ToolNames.READ_FILE, 'Reads a file');
        const editFileToolDef = decl(ToolNames.EDIT, 'Edits a file');
        const readFileInvocation = invocation(
          { path: 'README.md' },
          'Read README.md',
          toolResult('file contents'),
        );
        const editFileInvocation = invocation(
          { path: 'README.md' },
          'Edit README.md',
          vi.fn(),
          'ask',
        );
        const readFileTool = mockTool(
          readFileToolDef,
          readFileInvocation,
          builtin('Read File', 'Reads a file'),
        );
        const editFileTool = mockTool(
          editFileToolDef,
          editFileInvocation,
          builtin('Edit File', 'Edits a file', 'EDIT'),
        );
        const [emitter, toolCallEvents, toolResultEvents, approvalEvents] =
          eventLog(
            AgentEventType.TOOL_CALL,
            AgentEventType.TOOL_RESULT,
            AgentEventType.TOOL_WAITING_APPROVAL,
          );

        const executionAllowedTools: string[] = [ToolNames.READ_FILE];
        const secondRoundParts = await runFork(
          byName(readFileTool, editFileTool),
          [
            call(ToolNames.READ_FILE, { path: 'README.md' }, 'call_read'),
            call(
              ToolNames.EDIT,
              { path: 'README.md', old_string: 'a', new_string: 'b' },
              'call_edit',
            ),
          ],
          { tools: [readFileToolDef, editFileToolDef], executionAllowedTools },
          {
            emitter,
            // Widening the caller's array after create must not take effect.
            setup: () => executionAllowedTools.push(ToolNames.EDIT),
          },
        );

        const sentDeclarations =
          mockSendMessageStream.mock.calls[0][1].config.tools[0]
            .functionDeclarations;
        expect(sentDeclarations).toStrictEqual([
          readFileToolDef,
          editFileToolDef,
        ]);
        expect(JSON.stringify(sentDeclarations)).toBe(
          JSON.stringify([readFileToolDef, editFileToolDef]),
        );
        expect(readFileTool.build).toHaveBeenCalled();
        expect(readFileInvocation.execute).toHaveBeenCalledTimes(1);
        expect(editFileTool.build).not.toHaveBeenCalled();
        expect(editFileInvocation.execute).not.toHaveBeenCalled();
        expect(approvalEvents).toHaveLength(0);

        expect(
          secondRoundParts.map((part) => part.functionResponse?.id),
        ).toEqual(['call_read', 'call_edit']);
        const deniedResponse = responseFor(secondRoundParts, 'call_edit');
        expect(deniedResponse?.name).toBe(ToolNames.EDIT);
        expect(deniedResponse?.response?.['error']).toContain(
          'execution allowlist',
        );
        expect(deniedResponse?.response?.['error']).not.toContain('fork_tools');
        expect(deniedResponse?.response?.['error']).not.toContain('not found');
        expect(toolCallEvents.map((event) => event.callId).sort()).toEqual([
          'call_edit',
          'call_read',
        ]);
        expect(
          toolResultEvents
            .map(({ callId, success }) => ({ callId, success }))
            .sort((left, right) => left.callId.localeCompare(right.callId)),
        ).toEqual([
          { callId: 'call_edit', success: false },
          { callId: 'call_read', success: true },
        ]);
      });

      it('treats an empty execution allowlist as deny-all', async () => {
        const { tool, response } = await runReadFileFork([]);

        expect(tool.build).not.toHaveBeenCalled();
        expect(response?.id).toBe('call_read');
        expect(response?.response?.['error']).toContain('No tools are allowed');
      });

      it('caps and decouples the execution allowlist denial message', async () => {
        const { tool, response } = await runReadFileFork(
          Array.from(
            { length: 12 },
            (_, index) => `tool_${index}_${'x'.repeat(50)}`,
          ),
        );

        const error = response?.response?.['error'];
        expect(error).toContain('execution allowlist');
        expect(error).toContain('(+4 more)');
        expect(error).not.toContain('fork_tools');
        expect(String(error).length).toBeLessThan(400);
        expect(tool.build).not.toHaveBeenCalled();
      });

      it('matches an exact MCP server allowlist entry without crossing server boundaries', async () => {
        const githubName = normalizeToolNameForProvider('mcp__github__search');
        const enterpriseName = normalizeToolNameForProvider(
          'mcp__github-enterprise__search',
        );
        const githubDef = decl(githubName, 'Search GitHub');
        const enterpriseDef = decl(enterpriseName, 'Search GitHub Enterprise');
        const githubInvocation = invocation(
          {},
          'Search GitHub',
          toolResult('github result'),
        );
        const enterpriseTool = mockTool(
          enterpriseDef,
          undefined,
          mcp('github-enterprise', 'search'),
        );
        const responses = await runFork(
          byName(
            mockTool(githubDef, githubInvocation, mcp('github', 'search')),
            enterpriseTool,
          ),
          [
            call(githubName, {}, 'call_github'),
            call(enterpriseName, {}, 'call_enterprise'),
          ],
          {
            tools: [githubDef, enterpriseDef],
            executionAllowedTools: ['mcp__github'],
          },
        );

        expect(githubInvocation.execute).toHaveBeenCalledTimes(1);
        expect(enterpriseTool.build).not.toHaveBeenCalled();
        expect(errorFor(responses, 'call_enterprise')).toContain(
          'execution allowlist',
        );
      });

      it('lets mcp__* match MCP tools without matching built-in tools', async () => {
        const mcpName = normalizeToolNameForProvider('mcp__github__search');
        const mcpDef = decl(mcpName, 'Search GitHub');
        const builtinDef = decl(ToolNames.READ_FILE, 'Read a file');
        const mcpInvocation = invocation(
          {},
          'Search GitHub',
          toolResult('github result'),
        );
        const builtinTool = mockTool(builtinDef);
        const responses = await runFork(
          byName(
            mockTool(mcpDef, mcpInvocation, mcp('github', 'search')),
            builtinTool,
          ),
          [
            call(mcpName, {}, 'call_mcp'),
            call(ToolNames.READ_FILE, { path: 'README.md' }, 'call_builtin'),
          ],
          { tools: [mcpDef, builtinDef], executionAllowedTools: ['mcp__*'] },
        );

        expect(mcpInvocation.execute).toHaveBeenCalledTimes(1);
        expect(builtinTool.build).not.toHaveBeenCalled();
        expect(errorFor(responses, 'call_builtin')).toContain(
          'execution allowlist',
        );
      });

      it('matches long MCP wildcard patterns by raw server identity and boundary', async () => {
        const serverSuffix = 'a'.repeat(80);
        const allowedServer = `repo.${serverSuffix}`;
        const deniedServer = `repo/${serverSuffix}`;
        const boundaryDeniedServer = `${allowedServer}__evil`;
        const readToolOf = (server: string) =>
          normalizeToolNameForProvider(`mcp__${server}__read`);
        const allowedName = readToolOf(allowedServer);
        const deniedName = readToolOf(deniedServer);
        const boundaryDeniedName = readToolOf(boundaryDeniedServer);
        const allowedDef = decl(allowedName, 'Reads from repo.bad');
        const deniedDef = decl(deniedName, 'Reads from repo/bad');
        const boundaryDeniedDef = decl(
          boundaryDeniedName,
          'Reads from a server with a shared raw prefix',
        );
        const allowedInvocation = invocation(
          {},
          'Read from repo.bad',
          toolResult('repo result'),
        );
        const deniedTool = mockTool(
          deniedDef,
          undefined,
          mcp(deniedServer, 'read', false),
        );
        const boundaryDeniedTool = mockTool(
          boundaryDeniedDef,
          undefined,
          mcp(boundaryDeniedServer, 'read', false),
        );
        const responses = await runFork(
          byName(
            mockTool(allowedDef, allowedInvocation, mcp(allowedServer, 'read')),
            deniedTool,
            boundaryDeniedTool,
          ),
          [
            call(allowedName, {}, 'call_repo'),
            call(deniedName, {}, 'call_repo2'),
            call(boundaryDeniedName, {}, 'call_boundary'),
          ],
          {
            tools: [allowedDef, deniedDef, boundaryDeniedDef],
            executionAllowedTools: [`mcp__${allowedServer}__*`],
          },
        );

        expect(allowedName).not.toBe(deniedName);
        expect(allowedInvocation.execute).toHaveBeenCalledTimes(1);
        expect(deniedTool.build).not.toHaveBeenCalled();
        expect(boundaryDeniedTool.build).not.toHaveBeenCalled();
        expect(errorFor(responses, 'call_repo2')).toContain(
          'execution allowlist',
        );
        expect(errorFor(responses, 'call_boundary')).toContain(
          'execution allowlist',
        );
      });

      it('should ignore duplicate provider tool-call ids across rounds', async () => {
        const { config, inv, toolConfig } = await setupListFiles();
        respond(
          [call('list_files', { path: '.' }, 'call_1')],
          [collidingCall({ path: '.' })],
          'stop',
        );
        const [emitter, toolCallEvents, toolResultEvents] = eventLog(
          AgentEventType.TOOL_CALL,
          AgentEventType.TOOL_RESULT,
        );
        const scope = await runAgent(config, { tools: toolConfig, emitter });

        expect(inv.execute).toHaveBeenCalledTimes(1);
        expect(toolCallEvents).toHaveLength(2);
        expect(toolResultEvents).toHaveLength(2);
        expect(toolCallEvents[0].callId).toBe('call_1');
        expect(toolResultEvents[0].callId).toBe('call_1');
        expect(toolCallEvents[1].callId).toMatch(
          /^call_1__qwen_dup_2:duplicate:/,
        );
        expect(toolResultEvents[1].callId).toBe(toolCallEvents[1].callId);
        expect(toolResultEvents[1].error).toContain(DUP_CALL_1);
        expectDuplicateResponse(2, 'call_1__qwen_dup_2');
        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
      });

      it('should stop repeated duplicate provider tool-call responses', async () => {
        const { config, inv, toolConfig } = await setupListFiles();
        const duplicate = collidingCall({ path: '.' });
        respond(
          [call('list_files', { path: '.' }, 'call_1')],
          [duplicate],
          [duplicate, call('list_files', { path: './fresh' }, 'call_2')],
        );
        const [emitter, toolResultEvents] = eventLog(
          AgentEventType.TOOL_RESULT,
        );
        const scope = await runAgent(config, { tools: toolConfig, emitter });

        expect(inv.execute).toHaveBeenCalledTimes(1);
        expect(mockSendMessageStream).toHaveBeenCalledTimes(3);
        expect(toolResultEvents).toHaveLength(2);
        expect(toolResultEvents[1].error).toContain(DUP_CALL_1);
        expectDuplicateResponse(2, 'call_1__qwen_dup_2');
        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.LOOP_DETECTED);
      });

      it('should stop consecutive identical tool calls with fresh ids', async () => {
        const missingPath = '/workspace/project/missing-directory';
        const { config, inv, toolConfig } = await setupReadTool(
          decl('list_directory', 'Lists a directory'),
          invocation(
            { path: missingPath },
            'List directory',
            toolResult(
              'Error: ENOENT: no such file or directory, scandir ' +
                missingPath,
              'Directory not found',
            ),
          ),
          'List Directory',
          'List directory contents',
        );
        respond(
          ...rounds(5, 'list_directory', { path: missingPath }, 'call'),
          'stop',
        );
        const scope = await runAgent(config, { tools: toolConfig });

        expect(mockSendMessageStream).toHaveBeenCalledTimes(5);
        expect(inv.execute).toHaveBeenCalledTimes(4);
        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.LOOP_DETECTED);
      });

      it('keeps polling task_list while the task board changes (issue #9450)', async () => {
        // Identical task_list arguments do not imply an identical result:
        // teammates mutate the shared board between calls. The agent must
        // not be halted while the observed results keep changing.
        let boardVersion = 0;
        const { config, inv, toolConfig, polls } = await setupTaskList(
          // A peer completes/claims a task between polls, so every result
          // differs even though the arguments are identical.
          vi.fn(async () => {
            boardVersion += 1;
            const status = boardVersion % 2 === 0 ? 'completed' : 'in_progress';
            return {
              llmContent: `#7 [${status}] @peer-a — task (v${boardVersion})`,
              returnDisplay: 'Listed tasks',
            };
          }),
        );
        const pollCount = 8; // well past the consecutive-identical threshold
        respond(...polls(pollCount), 'stop');
        const scope = await runAgent(config, { tools: toolConfig });

        expect(inv.execute).toHaveBeenCalledTimes(pollCount);
        expect(mockSendMessageStream).toHaveBeenCalledTimes(pollCount + 1);
        expect(scope.getTerminateMode()).not.toBe(
          AgentTerminateMode.LOOP_DETECTED,
        );
      });

      it('still halts task_list polling when the board is frozen (issue #9450)', async () => {
        // No teammate activity: every poll returns the identical board.
        const { config, inv, toolConfig, polls } =
          await setupTaskList(frozenBoard());
        respond(...polls(5), 'stop');
        const [emitter, finishEvents] = eventLog(AgentEventType.FINISH);
        const scope = await runAgent(config, { tools: toolConfig, emitter });

        expect(mockSendMessageStream).toHaveBeenCalledTimes(5);
        expect(inv.execute).toHaveBeenCalledTimes(4);
        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.LOOP_DETECTED);
        // The exact detector is attributable in the finish event (#9450).
        expect(finishEvents).toHaveLength(1);
        expect(finishEvents[0].loopType).toBe(
          'consecutive_identical_tool_calls',
        );
        // The telemetry completion record carries the same attribution; a
        // SubagentExecutionEvent without loop_type would silently drop the
        // spread and journal the stop as unattributable.
        const completionEvents = vi
          .mocked(logSubagentExecution)
          .mock.calls.map((args) => args[1])
          .filter(
            (event): event is SubagentExecutionEvent =>
              event.status !== 'started',
          );
        expect(completionEvents).toHaveLength(1);
        expect(completionEvents[0]?.loop_type).toBe(
          'consecutive_identical_tool_calls',
        );
      });

      it('counts a provider-duplicate call id once so result evidence stays in sync (issue #9450)', async () => {
        // A provider can stream the SAME call id twice in one response — the
        // exact pathology dedupeToolCallsById exists for. Execution collapses
        // the pair to one call (one recorded result), so the loop guard must
        // also count one request; otherwise the request counter runs one
        // ahead of the result evidence and the result-aware exemption
        // fails safe, halting a fully productive poller.
        let boardVersion = 0;
        const { config, inv, toolConfig, args, polls } = await setupTaskList(
          // Every executed poll returns a changed board.
          vi.fn(async () => ({
            llmContent: `#7 [in_progress] @peer-a — task (v${++boardVersion})`,
            returnDisplay: 'Listed tasks',
          })),
        );
        // Round 1 emits the same call id twice (the provider duplicate); the
        // remaining rounds emit one call each, the board changing every time.
        const duplicateId = 'dup_call_0';
        respond(
          [
            call('task_list', args, duplicateId),
            call('task_list', args, duplicateId),
          ],
          ...polls(5),
          'stop',
        );
        const scope = await runAgent(config, {
          tools: toolConfig,
          run: { ...defaultRunConfig, max_turns: 20 },
        });

        // The duplicate id executes once (dedupeToolCallsById), so 6 executed
        // polls across 7 model turns; the changed board must carry the agent
        // to goal instead of a false loop halt.
        expect(inv.execute).toHaveBeenCalledTimes(6);
        expect(mockSendMessageStream).toHaveBeenCalledTimes(7);
        expect(scope.getTerminateMode()).not.toBe(
          AgentTerminateMode.LOOP_DETECTED,
        );
      });

      it('does not carry a stale loop attribution into a re-executed run (issue #9450)', async () => {
        const { config, toolConfig, polls } =
          await setupTaskList(frozenBoard());
        respond(...polls(5), 'stop');
        const [emitter, finishEvents] = eventLog(AgentEventType.FINISH);
        emitter.on(AgentEventType.ERROR, () => undefined);

        // Run 1 halts on the frozen board with an attribution.
        const scope = await runAgent(config, { tools: toolConfig, emitter });
        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.LOOP_DETECTED);

        // Run 2 on the same instance (stop-hook continuation / resident
        // turns) errors before any loop fires: it must not carry run 1's
        // loopType into its FINISH/telemetry.
        mockSendMessageStream.mockRejectedValueOnce(
          new Error('simulated model error'),
        );
        await expectExecuteError(scope, 'simulated model error');

        expect(finishEvents).toHaveLength(2);
        expect(finishEvents[0].loopType).toBe(
          'consecutive_identical_tool_calls',
        );
        expect(finishEvents[1].loopType).toBeUndefined();
      });

      it('should ignore duplicate provider tool-call ids already present in chat history', async () => {
        const { config, inv, toolConfig } = await setupListFiles();
        historyHasCall1();
        respond([collidingCall({ path: '.' })], 'stop');
        const [emitter, toolCallEvents, toolResultEvents] = eventLog(
          AgentEventType.TOOL_CALL,
          AgentEventType.TOOL_RESULT,
        );
        const scope = await runAgent(config, { tools: toolConfig, emitter });

        expect(inv.execute).not.toHaveBeenCalled();
        expect(toolCallEvents).toHaveLength(1);
        expect(toolResultEvents).toHaveLength(1);
        expect(toolCallEvents[0].callId).toMatch(
          /^call_1__qwen_dup_2:duplicate:/,
        );
        expect(toolResultEvents[0].callId).toBe(toolCallEvents[0].callId);
        expect(toolResultEvents[0].error).toContain(DUP_CALL_1);
        expectDuplicateResponse(1, 'call_1__qwen_dup_2');
        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
      });

      it('should execute an id-colliding tool call whose args differ from the handled call', async () => {
        const { config, inv, toolConfig } = await setupListFiles(
          { path: 'src' },
          'src/main.ts',
          'Listed 1 file',
        );
        historyHasCall1();
        respond([collidingCall({ path: 'src' })], 'stop');
        const [emitter, toolResultEvents] = eventLog(
          AgentEventType.TOOL_RESULT,
        );
        const scope = await runAgent(config, { tools: toolConfig, emitter });

        expect(inv.execute).toHaveBeenCalledTimes(1);
        expect(toolResultEvents).toHaveLength(1);
        expect(toolResultEvents[0].callId).toBe('call_1__qwen_dup_2');
        expect(toolResultEvents[0].error).toBeUndefined();
        const response = sentParts(1)[0].functionResponse;
        expect(response?.id).toBe('call_1__qwen_dup_2');
        expect(response?.response?.['error']).toBeUndefined();
        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
      });

      it('should keep suppressing replays of the original call after an id-colliding execution', async () => {
        const { config, inv, toolConfig } = await setupListFiles(
          { path: '.' },
          'file1.txt',
          'Listed 1 file',
        );
        // Rounds share one usedIds set so the collisions get _2 and _3
        // suffixes, mirroring how normalization accumulates across rounds.
        const usedIds = new Set(['call_1']);
        const round2Call = collidingCall({ path: 'src' }, usedIds);
        const round3Call = collidingCall({ path: '.' }, usedIds);
        respond(
          [call('list_files', { path: '.' }, 'call_1')],
          [round2Call],
          [round3Call],
          'stop',
        );
        const scope = await runAgent(config, { tools: toolConfig });

        // Round 1 (original) and round 2 (different-args collision) execute;
        // round 3 replays the ORIGINAL call under the reused id and must be
        // suppressed — first-occurrence recording keeps the id naming the
        // round-1 call even after the collision executed.
        expect(inv.execute).toHaveBeenCalledTimes(2);
        expect(mockSendMessageStream).toHaveBeenCalledTimes(4);
        expectDuplicateResponse(3, 'call_1__qwen_dup_3');
        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
      });

      it('should execute only the first duplicate functionCall id in one model turn', async () => {
        const { config, inv, toolConfig } = await setupListFiles(
          { path: 'a' },
          'file1.txt',
          'Listed 1 file',
        );
        respond(
          [
            call('list_files', { path: 'a' }, 'dup_id_0001'),
            call('list_files', { path: 'b' }, 'dup_id_0001'),
          ],
          'stop',
        );
        await runAgent(config, { tools: toolConfig });

        expect(inv.execute).toHaveBeenCalledOnce();
        expect(
          sentParts(1)
            .map((part) => part.functionResponse?.id)
            .filter((id): id is string => Boolean(id)),
        ).toEqual(['dup_id_0001']);
      });

      it('should report unauthorized tool names before duplicate provider ids', async () => {
        const { config, inv, toolConfig } = await setupListFiles();
        respond(
          [call('list_files', { path: '.' }, 'call_reused')],
          [call('write_file', { path: 'x.txt', content: 'x' }, 'call_reused')],
          'stop',
        );
        const scope = await runAgent(config, { tools: toolConfig });

        expect(inv.execute).toHaveBeenCalledTimes(1);
        const response = sentParts(2)[0].functionResponse;
        expect(response?.id).toBe('call_reused');
        expect(response?.name).toBe('write_file');
        expect(response?.response?.['error']).toContain(
          'Tool "write_file" not found',
        );
        expect(response?.response?.['error']).not.toContain(
          'Duplicate provider tool call id',
        );
        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
      });
    });

    describe('execute - Termination and Recovery', () => {
      const promptConfig: PromptConfig = { systemPrompt: 'Execute task.' };

      it('should terminate with MAX_TURNS if the limit is reached', async () => {
        const { config } = await createMockConfig();
        // Model keeps calling tools repeatedly
        respond(
          [call('list_files', { path: '/test' })],
          [call('list_files', { path: '/test2' })],
          // This turn should not happen
          [call('list_files', { path: '/test3' })],
        );
        const scope = await runAgent(config, {
          run: { ...defaultRunConfig, max_turns: 2 },
        });

        expect(mockSendMessageStream).toHaveBeenCalledTimes(2);
        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.MAX_TURNS);
      });

      it('should treat max_turns 0 as an unlimited turn budget', async () => {
        const { config } = await createMockConfig();
        respond(
          [call('list_files', { path: '/test' })],
          [call('list_files', { path: '/test2' })],
          'stop',
        );
        const scope = await runAgent(config, {
          run: { ...defaultRunConfig, max_turns: 0 },
        });

        expect(mockSendMessageStream).toHaveBeenCalledTimes(3);
        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
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
        await expectExecuteError(await createAgent(config), 'API Failure');
      });
    });

    describe('execute - retry waits', () => {
      const promptConfig: PromptConfig = { systemPrompt: 'Execute task.' };
      const doneChunk = {
        type: 'chunk',
        value: { candidates: [{ content: { parts: [{ text: 'Done.' }] } }] },
      };

      // Mirrors a retry layer's abortable backoff: announces the wait, sleeps,
      // and rejects (ending the wait) when the round's signal aborts.
      let onBackoff: (() => void) | undefined;
      const backoffStarted = () =>
        new Promise<void>((resolve) => (onBackoff = resolve));
      const backoff = (delayMs: number, signal: AbortSignal) => {
        const endWait = beginRetryWait(delayMs);
        onBackoff?.();
        return new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            endWait();
            resolve();
          }, delayMs);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              endWait();
              reject(new Error('Retry aborted by signal'));
            },
            { once: true },
          );
        });
      };
      const signalOf = (params: unknown) =>
        (params as { config: { abortSignal: AbortSignal } }).config.abortSignal;

      const createScope = async (
        runConfig: RunConfig,
        emitter = new AgentEventEmitter(),
      ) => {
        const { config } = await createMockConfig();
        const scope = await AgentHeadless.create(
          'test-agent',
          config,
          promptConfig,
          defaultModelConfig,
          runConfig,
          undefined,
          emitter,
        );
        const waits: Array<{ phase: string; round: number; promptId: string }> =
          [];
        emitter.on(AgentEventType.RETRY_WAIT, (e) => waits.push(e));
        return { scope, emitter, waits };
      };

      it('publishes waits from send-time work and from the lazy stream with the round identity', async () => {
        vi.useFakeTimers();
        try {
          mockSendMessageStream.mockImplementation(async (_m, params) => {
            await backoff(1_000, signalOf(params)); // e.g. send-time compaction
            return (async function* () {
              await backoff(2_000, signalOf(params)); // the request's retry
              yield doneChunk;
            })();
          });
          const { scope, waits } = await createScope({ max_turns: 5 });
          const run = scope.execute(new ContextState(), undefined, {
            enforceTimeLimitDuringRetryWait: true,
          });
          await vi.advanceTimersByTimeAsync(3_000);
          await run;
          expect(scope.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
          expect(waits.map((w) => w.phase)).toEqual([
            'start',
            'end',
            'start',
            'end',
          ]);
          expect(new Set(waits.map((w) => w.round))).toEqual(new Set([1]));
          expect(waits[0]!.promptId).toMatch(/#0$/);
        } finally {
          vi.useRealTimers();
        }
      });

      it('releases a wait the stream left open when the round ends, and drops late callbacks', async () => {
        let lateEnd: (() => void) | undefined;
        let call = 0;
        mockSendMessageStream.mockImplementation(async () => {
          call++;
          return (async function* () {
            if (call === 1) lateEnd = beginRetryWait(60_000);
            yield doneChunk;
          })();
        });
        const { scope, waits } = await createScope({ max_turns: 5 });
        await scope.execute(new ContextState());
        expect(waits.map((w) => w.phase)).toEqual(['start', 'end']);
        lateEnd!();
        expect(waits).toHaveLength(2);
      });

      it('keeps waits of parallel agents on the same config apart', async () => {
        vi.useFakeTimers();
        try {
          mockSendMessageStream.mockImplementation(async (_m, params) =>
            (async function* () {
              await backoff(
                (params as { message: Part[] }).message.some((p) =>
                  p.text?.includes('A'),
                )
                  ? 1_000
                  : 5_000,
                signalOf(params),
              );
              yield doneChunk;
            })(),
          );
          const a = await createScope({ max_turns: 5 });
          const b = await createScope({ max_turns: 5 });
          const ctxA = new ContextState();
          ctxA.set('task_prompt', 'task A');
          const ctxB = new ContextState();
          ctxB.set('task_prompt', 'task B');
          const runs = Promise.all([
            a.scope.execute(ctxA),
            b.scope.execute(ctxB),
          ]);
          await vi.advanceTimersByTimeAsync(5_000);
          await runs;
          const delays = (w: Array<{ phase: string }>) =>
            w.flatMap((e) => ('delayMs' in e ? [e.delayMs] : []));
          expect(delays(a.waits)).toEqual([1_000]);
          expect(delays(b.waits)).toEqual([5_000]);
        } finally {
          vi.useRealTimers();
        }
      });

      describe('under the workflow stall watchdog', () => {
        // The single-attempt shape of a workflow dispatch: a fresh agent on
        // the attempt's emitter, failing on any non-GOAL terminate mode.
        const dispatch = (runConfig: RunConfig, stallMs: number) => {
          let attempts = 0;
          const result = runStallResilient(
            async (signal, emitter) => {
              attempts++;
              const { scope } = await createScope(runConfig, emitter);
              await scope.execute(new ContextState(), signal, {
                enforceTimeLimitDuringRetryWait: true,
              });
              const mode = scope.getTerminateMode();
              if (mode === AgentTerminateMode.TIMEOUT) {
                throw new WorkflowAgentFailedError('timed out', 'timeout');
              }
              if (mode !== AgentTerminateMode.GOAL) {
                throw new Error(`did not complete (terminate mode: ${mode})`);
              }
              return 'ok';
            },
            { stallMs },
          );
          return { result, attempts: () => attempts };
        };

        it('keeps a backoff longer than stallMs on one attempt', async () => {
          vi.useFakeTimers();
          try {
            mockSendMessageStream.mockImplementation(async (_m, params) =>
              (async function* () {
                await backoff(240_000, signalOf(params));
                yield doneChunk;
              })(),
            );
            const started = backoffStarted();
            const run = dispatch({ max_turns: 5 }, DEFAULT_STALL_MS);
            await started;
            await vi.advanceTimersByTimeAsync(240_000);
            await expect(run.result).resolves.toBe('ok');
            expect(run.attempts()).toBe(1);
            expect(mockSendMessageStream).toHaveBeenCalledTimes(1);
          } finally {
            vi.useRealTimers();
          }
        });

        it('still retries a request that hangs after the backoff', async () => {
          vi.useFakeTimers();
          try {
            let call = 0;
            mockSendMessageStream.mockImplementation(async (_m, params) => {
              call++;
              return (async function* () {
                if (call === 1) {
                  await backoff(2_000, signalOf(params));
                  await new Promise((_, reject) =>
                    signalOf(params).addEventListener('abort', () =>
                      reject(new Error('aborted')),
                    ),
                  );
                }
                yield doneChunk;
              })();
            });
            const started = backoffStarted();
            const run = dispatch({ max_turns: 5 }, 500);
            await started;
            await vi.advanceTimersByTimeAsync(2_499);
            expect(run.attempts()).toBe(1);
            await vi.advanceTimersByTimeAsync(1);
            await expect(run.result).resolves.toBe('ok');
            expect(run.attempts()).toBe(2);
          } finally {
            vi.useRealTimers();
          }
        });

        it('reports a backoff past the agent time limit as timeout, not a stall', async () => {
          vi.useFakeTimers();
          try {
            mockSendMessageStream.mockImplementation(async (_m, params) =>
              (async function* () {
                await backoff(7_200_000, signalOf(params));
                yield doneChunk;
              })(),
            );
            const started = backoffStarted();
            const run = dispatch({ max_turns: 5, max_time_minutes: 10 }, 500);
            const settled = run.result.catch((e: unknown) => e);
            await started;
            await vi.advanceTimersByTimeAsync(600_000);
            const error = await settled;
            expect(isWorkflowAgentFailedError(error)).toBe(true);
            expect((error as WorkflowAgentFailedError).kind).toBe('timeout');
            expect(run.attempts()).toBe(1);
            expect(mockSendMessageStream).toHaveBeenCalledTimes(1);
          } finally {
            vi.useRealTimers();
          }
        });

        it('keeps the time limit guard with the watchdog disabled', async () => {
          vi.useFakeTimers();
          try {
            mockSendMessageStream.mockImplementation(async (_m, params) =>
              (async function* () {
                await backoff(7_200_000, signalOf(params));
                yield doneChunk;
              })(),
            );
            const started = backoffStarted();
            const run = dispatch({ max_turns: 5, max_time_minutes: 1 }, 0);
            const settled = run.result.catch((e: unknown) => e);
            await started;
            await vi.advanceTimersByTimeAsync(60_000);
            expect(((await settled) as WorkflowAgentFailedError).kind).toBe(
              'timeout',
            );
          } finally {
            vi.useRealTimers();
          }
        });
      });

      describe('agent time limit during a wait', () => {
        // Each variant waits 2h after spending 30s of a 1-minute budget, so
        // the limit passes 30s into the wait.
        const variants = {
          'the stream rejects': (params: unknown) =>
            (async function* () {
              await backoff(7_200_000, signalOf(params));
              yield doneChunk;
            })(),
          'the stream yields after the abort': (params: unknown) =>
            (async function* () {
              await backoff(7_200_000, signalOf(params)).catch(() => {});
              yield doneChunk;
            })(),
        };

        it.each(Object.keys(variants))(
          'ends with TIMEOUT when %s',
          async (name) => {
            vi.useFakeTimers();
            try {
              mockSendMessageStream.mockImplementation(async (_m, params) => {
                await new Promise((r) => setTimeout(r, 30_000));
                return variants[name as keyof typeof variants](params);
              });
              const { scope } = await createScope({
                max_turns: 5,
                max_time_minutes: 1,
              });
              let settled = false;
              const run = scope
                .execute(new ContextState(), undefined, {
                  enforceTimeLimitDuringRetryWait: true,
                })
                .finally(() => (settled = true));
              await vi.advanceTimersByTimeAsync(59_999);
              expect(settled).toBe(false);
              await vi.advanceTimersByTimeAsync(1);
              await run;
              expect(scope.getTerminateMode()).toBe(AgentTerminateMode.TIMEOUT);
              expect(mockSendMessageStream).toHaveBeenCalledTimes(1);
              expect(vi.getTimerCount()).toBe(0);
            } finally {
              vi.useRealTimers();
            }
          },
        );

        it('ends with TIMEOUT when the send itself rejects during the wait', async () => {
          vi.useFakeTimers();
          try {
            mockSendMessageStream.mockImplementation(async (_m, params) => {
              await new Promise((r) => setTimeout(r, 30_000));
              await backoff(7_200_000, signalOf(params));
              return (async function* () {
                yield doneChunk;
              })();
            });
            const { scope } = await createScope({
              max_turns: 5,
              max_time_minutes: 1,
            });
            const run = scope.execute(new ContextState(), undefined, {
              enforceTimeLimitDuringRetryWait: true,
            });
            await vi.advanceTimersByTimeAsync(60_000);
            await run;
            expect(scope.getTerminateMode()).toBe(AgentTerminateMode.TIMEOUT);
          } finally {
            vi.useRealTimers();
          }
        });

        it('times out at once when the limit already passed as the wait starts', async () => {
          vi.useFakeTimers();
          try {
            mockSendMessageStream.mockImplementation(async (_m, params) =>
              (async function* () {
                // Spent the whole budget inside the round before the retry.
                await new Promise((r) => setTimeout(r, 61_000));
                await backoff(7_200_000, signalOf(params));
                yield doneChunk;
              })(),
            );
            const { scope } = await createScope({
              max_turns: 5,
              max_time_minutes: 1,
            });
            const run = scope.execute(new ContextState(), undefined, {
              enforceTimeLimitDuringRetryWait: true,
            });
            await vi.advanceTimersByTimeAsync(61_000);
            // The guard fires on the next tick, not after the 2h backoff.
            await vi.advanceTimersByTimeAsync(1);
            await run;
            expect(scope.getTerminateMode()).toBe(AgentTerminateMode.TIMEOUT);
          } finally {
            vi.useRealTimers();
          }
        });

        it('measures the limit from the original start and shares it across waits', async () => {
          vi.useFakeTimers();
          try {
            mockSendMessageStream.mockImplementation(async (_m, params) =>
              (async function* () {
                for (let i = 0; i < 10; i++) {
                  await backoff(20_000, signalOf(params));
                }
                yield doneChunk;
              })(),
            );
            const { scope, waits } = await createScope({
              max_turns: 5,
              max_time_minutes: 1,
            });
            const run = scope.execute(new ContextState(), undefined, {
              enforceTimeLimitDuringRetryWait: true,
            });
            await vi.advanceTimersByTimeAsync(60_001);
            await run;
            expect(scope.getTerminateMode()).toBe(AgentTerminateMode.TIMEOUT);
            // The third wait is cut as the minute passes: no wait renewed the
            // limit, and no fourth request or wait followed.
            expect(waits.filter((w) => w.phase === 'start')).toHaveLength(3);
          } finally {
            vi.useRealTimers();
          }
        });

        it('clears the guard when the last wait ends early', async () => {
          vi.useFakeTimers();
          try {
            let release!: () => void;
            mockSendMessageStream.mockImplementation(async (_m, params) =>
              (async function* () {
                await backoff(1_000, signalOf(params));
                await new Promise<void>((r) => (release = r));
                yield doneChunk;
              })(),
            );
            const { scope } = await createScope({
              max_turns: 5,
              max_time_minutes: 1,
            });
            const run = scope.execute(new ContextState(), undefined, {
              enforceTimeLimitDuringRetryWait: true,
            });
            await vi.advanceTimersByTimeAsync(1_000);
            expect(vi.getTimerCount()).toBe(0);
            // Past the limit with no active wait: only the loop's own
            // cooperative checks apply, so the round is not aborted.
            await vi.advanceTimersByTimeAsync(120_000);
            release();
            await run;
            expect(scope.getTerminateMode()).toBe(AgentTerminateMode.TIMEOUT);
            expect(mockSendMessageStream).toHaveBeenCalledTimes(1);
          } finally {
            vi.useRealTimers();
          }
        });

        it('lets a parent cancel during the wait win as CANCELLED', async () => {
          vi.useFakeTimers();
          try {
            mockSendMessageStream.mockImplementation(async (_m, params) =>
              (async function* () {
                await backoff(7_200_000, signalOf(params));
                yield doneChunk;
              })(),
            );
            const { scope } = await createScope({
              max_turns: 5,
              max_time_minutes: 1,
            });
            const parent = new AbortController();
            const run = scope.execute(new ContextState(), parent.signal, {
              enforceTimeLimitDuringRetryWait: true,
            });
            await vi.advanceTimersByTimeAsync(10_000);
            parent.abort();
            await run.catch(() => {});
            expect(scope.getTerminateMode()).not.toBe(
              AgentTerminateMode.TIMEOUT,
            );
            await vi.advanceTimersByTimeAsync(120_000);
            expect(mockSendMessageStream).toHaveBeenCalledTimes(1);
          } finally {
            vi.useRealTimers();
          }
        });

        it('leaves agents without the opt-in on their between-round checks', async () => {
          vi.useFakeTimers();
          try {
            mockSendMessageStream.mockImplementation(async (_m, params) =>
              (async function* () {
                await backoff(7_200_000, signalOf(params));
                yield doneChunk;
              })(),
            );
            const { scope } = await createScope({
              max_turns: 5,
              max_time_minutes: 1,
            });
            let settled = false;
            const run = scope
              .execute(new ContextState())
              .finally(() => (settled = true));
            await vi.advanceTimersByTimeAsync(7_199_000);
            expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(1_000);
            await run;
            // Checked after the round, as before.
            expect(scope.getTerminateMode()).toBe(AgentTerminateMode.TIMEOUT);
          } finally {
            vi.useRealTimers();
          }
        });
      });
    });

    describe('execute - Streaming and Thought Handling', () => {
      const respondWithParts = (parts: Part[]) =>
        mockSendMessageStream.mockImplementation(async () =>
          streamOf(partsChunk(parts)),
        );

      it('should emit STREAM_TEXT events with thought flag', async () => {
        const { config } = await createMockConfig();
        respondWithParts([
          { text: 'Let me think...', thought: true },
          { text: 'Here is the answer.' },
        ]);
        const [emitter, events] = eventLog(AgentEventType.STREAM_TEXT);
        await runAgent(config, { emitter });

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
          streamOf(
            callsChunk([call('missing_tool', {}, 'call-1')], { usageMetadata }),
          ),
        );
        const [emitter, events] = eventLog(AgentEventType.ROUND_TEXT);
        await runAgent(config, {
          run: { ...defaultRunConfig, max_turns: 1 },
          emitter,
        });

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
        respondWithParts([
          { text: 'Internal reasoning here.', thought: true },
          { text: 'The final answer.' },
        ]);
        const scope = await runAgent(config);

        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
        expect(scope.getFinalText()).toBe('The final answer.');
      });

      it('should not set finalText from thought-only response', async () => {
        const { config } = await createMockConfig();
        // First call: only thought text (no regular text → nudge)
        // Second call: regular text response
        mockSendMessageStream
          .mockImplementationOnce(async () =>
            streamOf(partsChunk([{ text: 'Just thinking...', thought: true }])),
          )
          .mockImplementation(async () =>
            streamOf(partsChunk([{ text: 'Actual output.' }])),
          );
        const scope = await runAgent(config);

        expect(scope.getTerminateMode()).toBe(AgentTerminateMode.GOAL);
        expect(scope.getFinalText()).toBe('Actual output.');
        // Should have been called twice: first with thought-only, then nudged
        expect(mockSendMessageStream).toHaveBeenCalledTimes(2);
      });
    });

    describe('execute - Tool Restriction Enforcement (Issue #1121)', () => {
      // A registry whose only tool is a real WriteFileTool (fresh per lookup).
      const setupWriteFile = async () => {
        const { config } = await createMockConfig({
          getFunctionDeclarationsFiltered: vi
            .fn()
            .mockReturnValue([decl(WriteFileTool.Name, 'Writes a file')]),
          getTool: vi.fn((name: string) =>
            name === WriteFileTool.Name ? new WriteFileTool(config) : undefined,
          ),
        });
        return { config, toolConfig: { tools: [WriteFileTool.Name] } };
      };
      // Runs the write_file agent; returns its TOOL_RESULT (asserted present).
      const runWrite = async (config: Config, toolConfig: ToolConfig) => {
        const [emitter, results] = eventLog(AgentEventType.TOOL_RESULT);
        await runAgent(config, { tools: toolConfig, emitter });
        const writeResult = results.find(
          (event) => event.name === WriteFileTool.Name,
        );
        expect(writeResult).toBeDefined();
        return writeResult!;
      };
      const writeCall = (id: string, args: Record<string, unknown>) =>
        callsChunk([call(WriteFileTool.Name, args, id)]);

      it('should NOT execute tools that are not in the allowed tools list', async () => {
        // Two tools: read_file is allowed, edit_file is not.
        const readFileToolDef = decl('read_file', 'Reads a file');
        const editFileToolDef = decl('edit_file', 'Edits a file');
        // Track which tools were executed
        const executedTools: string[] = [];
        const tracked = (
          name: string,
          llmContent: string,
          returnDisplay: string,
        ) =>
          vi.fn(async () => {
            executedTools.push(name);
            return { llmContent, returnDisplay };
          });
        const editFileInvocation = invocation(
          { path: 'test.txt', content: 'malicious content' },
          'Edit file',
          tracked('edit_file', 'file edited', 'Edited file'),
        );
        const readFileTool = mockTool(
          readFileToolDef,
          invocation(
            { path: 'test.txt' },
            'Read file',
            tracked('read_file', 'file contents', 'Read file contents'),
          ),
          builtin('Read File', 'Read file contents'),
        );
        const editFileTool = mockTool(
          editFileToolDef,
          editFileInvocation,
          builtin('Edit File', 'Edit file contents', 'WRITE'),
        );
        const { config } = await createMockConfig({
          // Only read_file is in the filtered list (what the subagent should see)
          getFunctionDeclarationsFiltered: vi
            .fn()
            .mockReturnValue([readFileToolDef]),
          // But the full registry has both tools (simulating the bug)
          getFunctionDeclarations: vi
            .fn()
            .mockReturnValue([readFileToolDef, editFileToolDef]),
          getTool: vi.fn(byName(readFileTool, editFileTool)),
        });
        // The model calls BOTH read_file (allowed) AND edit_file (NOT
        // allowed), simulating a hallucinated unauthorized tool call.
        respond(
          [
            call('read_file', { path: 'test.txt' }, 'call_read'),
            call(
              'edit_file',
              { path: 'test.txt', content: 'malicious content' },
              'call_edit',
            ),
          ],
          'stop',
        );
        // Subscribe to events BEFORE the scope exists.
        const [emitter, toolCallEvents, toolResultEvents] = eventLog(
          AgentEventType.TOOL_CALL,
          AgentEventType.TOOL_RESULT,
        );
        // Only read_file is allowed in the subagent's tool config.
        await runAgent(config, { tools: { tools: ['read_file'] }, emitter });

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
        const { config, toolConfig } = await setupWriteFile();
        mockSendMessageStream.mockImplementation(async () =>
          streamOf<object>(
            writeCall('call_write', { file_path: '/tmp/truncated.txt' }),
            partsChunk([], 'MAX_TOKENS'),
            partsChunk([{ text: 'done' }]),
          ),
        );
        const writeResult = await runWrite(config, toolConfig);

        expect(writeResult.success).toBe(false);
        expect(writeResult.error).toContain(
          'truncated due to max_tokens limit',
        );
        expect(writeResult.error).toContain(
          'rejected to prevent writing truncated content',
        );
        expect(writeResult.error).not.toContain(
          "params must have required property 'content'",
        );
      });

      it('should NOT reject write_file when truncated attempt is followed by successful retry', async () => {
        const { config, toolConfig } = await setupWriteFile();
        // First call: truncated (MAX_TOKENS). Retry resets state, second call:
        // complete write_file. The scheduler should see wasOutputTruncated=false
        // for the retried response and allow the tool to proceed. The second
        // round's plain text ends the agent loop.
        mockSendMessageStream
          .mockImplementationOnce(async () =>
            streamOf<object>(
              // Truncated response with incomplete write_file args
              writeCall('call_write_truncated', {
                file_path: '/tmp/retry-test.txt',
              }),
              { type: 'retry' },
              // After retry, complete response with all required args
              writeCall('call_write_complete', {
                file_path: '/tmp/retry-test.txt',
                content: 'hello',
              }),
              partsChunk([], 'STOP'),
            ),
          )
          .mockImplementation(async () =>
            streamOf(partsChunk([{ text: 'done' }], 'STOP')),
          );
        const writeResult = await runWrite(config, toolConfig);

        // After retry the wasOutputTruncated flag must have been cleared, so
        // the call should NOT be rejected with a truncation error — even if
        // execution fails for unrelated reasons (e.g. mock filesystem).
        expect(writeResult.error).not.toContain(
          'truncated due to max_tokens limit',
        );
        expect(writeResult.error).not.toContain(
          'rejected to prevent writing truncated content',
        );
      });

      it.each([
        { retry: { type: 'retry' as const, isContinuation: true } },
        { retry: { type: 'retry' as const } },
      ])(
        'forwards retry events to subagent loop detection',
        async ({ retry }) => {
          const loopSpy = vi
            .spyOn(LoopDetectionService.prototype, 'addAndCheckHeuristicLoops')
            .mockReturnValue(false);

          const { config } = await createMockConfig();
          mockSendMessageStream.mockResolvedValue(
            streamOf<object>(
              { ...retry },
              partsChunk([{ text: 'done' }], 'STOP'),
            ),
          );
          await runAgent(config, {
            tools: { tools: [] },
            emitter: new AgentEventEmitter(),
          });

          const retryArg = loopSpy.mock.calls.find(
            ([event]) => event.type === LlmEventType.Retry,
          )?.[0] as { type: LlmEventType; isContinuation?: boolean };
          expect(retryArg).toEqual(
            expect.objectContaining({ type: LlmEventType.Retry }),
          );
          if ('isContinuation' in retry) {
            expect(retryArg.isContinuation).toBe(true);
          } else {
            expect(retryArg).not.toHaveProperty('isContinuation');
          }
        },
      );

      it('keeps automatic max token escalation warm for the next agent round', async () => {
        const { config, toolConfig } = await setupWriteFile();
        mockSendMessageStream
          .mockImplementationOnce(async () =>
            streamOf<object>(
              { type: 'retry', maxOutputTokensEscalated: 65_536 },
              writeCall('call_write_complete', {
                file_path: '/tmp/sticky-escalation.txt',
                content: 'hello',
              }),
              partsChunk([], 'STOP'),
            ),
          )
          .mockImplementation(async () =>
            streamOf(partsChunk([{ text: 'done' }], 'STOP')),
          );
        await runAgent(config, { tools: toolConfig });

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

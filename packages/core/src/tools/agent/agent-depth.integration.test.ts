/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CountTokensParameters,
  CountTokensResponse,
  EmbedContentParameters,
  EmbedContentResponse,
  FunctionCall,
  FunctionDeclaration,
  GenerateContentParameters,
  GenerateContentResponse,
  PartListUnion,
} from '@google/genai';
import { FinishReason } from '@google/genai';
import { AgentTool, type AgentParams } from './agent.js';
import { ApprovalMode, type Config } from '../../config/config.js';
import {
  AuthType,
  type ContentGenerator,
  type ContentGeneratorConfig,
} from '../../core/contentGenerator.js';
import { AgentHeadless } from '../../agents/runtime/agent-headless.js';
import type { SubagentConfig } from '../../subagents/types.js';
import type { SubagentManager } from '../../subagents/subagent-manager.js';
import type { ToolResultDisplay } from '../tools.js';
import { partToString } from '../../utils/partUtils.js';
import type {
  AgentCompletionStats,
  BackgroundTaskEntry,
} from '../../agents/background-tasks.js';

type AgentToolInvocation = {
  execute: (
    signal?: AbortSignal,
    updateOutput?: (output: ToolResultDisplay) => void,
  ) => Promise<{
    llmContent: PartListUnion;
    returnDisplay: ToolResultDisplay;
  }>;
};

type AgentToolWithProtectedMethods = AgentTool & {
  createInvocation: (params: AgentParams) => AgentToolInvocation;
};

class ScriptedContentGenerator implements ContentGenerator {
  readonly requests: GenerateContentParameters[] = [];
  private readonly callsByDepth = new Map<string, number>();

  async generateContentStream(
    request: GenerateContentParameters,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    this.requests.push(request);
    const depth = request.config?.labels?.['agent_depth'] ?? 'missing';
    const nextCall = (this.callsByDepth.get(depth) ?? 0) + 1;
    this.callsByDepth.set(depth, nextCall);

    if (depth === '1' && nextCall === 1) {
      return this.streamToolCall({
        id: 'nested-agent-call',
        name: 'agent',
        args: {
          description: 'Nested worker',
          prompt: 'Run the nested worker',
          subagent_type: 'worker',
        },
      });
    }

    return this.streamText(`done at depth ${depth}`);
  }

  async generateContent(): Promise<GenerateContentResponse> {
    throw new Error('generateContent is not used by this integration test');
  }

  async countTokens(
    _request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    return { totalTokens: 1 } as CountTokensResponse;
  }

  async embedContent(
    _request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    return { embeddings: [] } as EmbedContentResponse;
  }

  useSummarizedThinking(): boolean {
    return false;
  }

  private async *streamToolCall(
    functionCall: FunctionCall,
  ): AsyncGenerator<GenerateContentResponse> {
    yield {
      functionCalls: [functionCall],
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ functionCall }],
          },
        },
      ],
    } as unknown as GenerateContentResponse;
  }

  private async *streamText(
    text: string,
  ): AsyncGenerator<GenerateContentResponse> {
    yield {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ text }],
          },
          finishReason: FinishReason.STOP,
        },
      ],
    } as unknown as GenerateContentResponse;
  }
}

class IntegrationToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  constructor(tool: AgentTool) {
    this.tools.set(tool.name, tool);
  }

  async warmAll(): Promise<void> {}

  copyDiscoveredToolsFrom(): void {}

  getTool(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  async ensureTool(name: string): Promise<AgentTool | undefined> {
    return this.getTool(name);
  }

  getAllToolNames(): string[] {
    return [...this.tools.keys()];
  }

  getAllTools(): AgentTool[] {
    return [...this.tools.values()];
  }

  getFunctionDeclarations(): FunctionDeclaration[] {
    return this.getAllTools().map((tool) => tool.schema);
  }

  getFunctionDeclarationsFiltered(names: string[]): FunctionDeclaration[] {
    const allowed = new Set(names);
    return this.getAllTools()
      .filter((tool) => allowed.has(tool.name))
      .map((tool) => tool.schema);
  }

  async stop(): Promise<void> {
    for (const tool of this.tools.values()) {
      tool.dispose();
    }
  }
}

describe('AgentTool nesting depth integration', () => {
  const workerConfig: SubagentConfig = {
    name: 'worker',
    description: 'Integration worker agent',
    systemPrompt: 'You are an integration test worker.',
    level: 'session',
  };

  let contentGenerator: ScriptedContentGenerator;
  let rootTool: AgentTool;
  let backgroundEntries: Map<string, BackgroundTaskEntry>;

  beforeEach(() => {
    contentGenerator = new ScriptedContentGenerator();
    backgroundEntries = new Map();
  });

  afterEach(() => {
    rootTool?.dispose();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function createHarness(): Promise<{
    config: Config;
    rootTool: AgentTool;
  }> {
    const contentGeneratorConfig: ContentGeneratorConfig = {
      model: 'test-model',
      authType: AuthType.USE_OPENAI,
    };

    const refs: {
      config?: Config;
      rootRegistry?: IntegrationToolRegistry;
    } = {};
    const createRegistry = async () => {
      const tool = new AgentTool(refs.config!);
      await tool.refreshSubagents();
      return new IntegrationToolRegistry(tool);
    };

    const subagentManager = {
      listSubagents: vi.fn().mockResolvedValue([workerConfig]),
      loadSubagent: vi.fn().mockResolvedValue(workerConfig),
      addChangeListener: vi.fn().mockReturnValue(() => {}),
      createAgentHeadless: vi.fn(
        async (
          subagentConfig: SubagentConfig,
          runtimeContext: Config,
          options?: {
            eventEmitter?: Parameters<typeof AgentHeadless.create>[6];
            agentDepth?: number;
            executionMode?: Parameters<typeof AgentHeadless.create>[10];
          },
        ) =>
          AgentHeadless.create(
            subagentConfig.name,
            runtimeContext,
            {
              systemPrompt: subagentConfig.systemPrompt,
              initialMessages: [
                { role: 'user', parts: [{ text: 'bootstrap' }] },
                { role: 'model', parts: [{ text: 'ready' }] },
              ],
            },
            { model: 'test-model' },
            { max_turns: 4, max_time_minutes: 1 },
            { tools: ['*'] },
            options?.eventEmitter,
            undefined,
            undefined,
            options?.agentDepth,
            options?.executionMode,
          ),
      ),
    } as unknown as SubagentManager;

    const backgroundRegistry = {
      register: vi.fn((entry: BackgroundTaskEntry) => {
        backgroundEntries.set(entry.agentId, entry);
      }),
      unregisterForeground: vi.fn(),
      get: vi.fn((agentId: string) => backgroundEntries.get(agentId)),
      complete: vi.fn(
        (agentId: string, result?: string, stats?: AgentCompletionStats) => {
          const entry = backgroundEntries.get(agentId);
          if (!entry) return;
          entry.status = 'completed';
          entry.result = result;
          entry.stats = stats;
        },
      ),
      fail: vi.fn(
        (agentId: string, error?: string, stats?: AgentCompletionStats) => {
          const entry = backgroundEntries.get(agentId);
          if (!entry) return;
          entry.status = 'failed';
          entry.error = error;
          entry.stats = stats;
        },
      ),
      finalizeCancelled: vi.fn(),
      appendActivity: vi.fn(),
      queueExternalInput: vi.fn(),
      wakeExternalInputWaiters: vi.fn(),
      drainMessages: vi.fn().mockReturnValue([]),
      waitForMessages: vi.fn().mockResolvedValue([]),
    };
    const monitorRegistry = {
      setAgentNotificationCallback: vi.fn(),
      setAgentLifecycleCallback: vi.fn(),
      cancelRunningForOwner: vi.fn(),
      hasRunningForOwner: vi.fn().mockReturnValue(false),
    };
    const debugLogger = {
      debug: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };

    const config = {
      getSubagentManager: () => subagentManager,
      getGeminiClient: () => undefined,
      getHookSystem: () => undefined,
      getTranscriptPath: () => '/tmp/transcript.jsonl',
      getApprovalMode: () => ApprovalMode.DEFAULT,
      isTrustedFolder: () => true,
      getToolRegistry: () => refs.rootRegistry,
      createToolRegistry: createRegistry,
      getContentGenerator: () => contentGenerator,
      getContentGeneratorConfig: () => contentGeneratorConfig,
      getModel: () => 'test-model',
      getUserMemory: () => '',
      getChatCompression: () => undefined,
      getChatRecordingService: () => undefined,
      getSessionId: () => 'test-session',
      getProjectRoot: () => '/tmp',
      getCliVersion: () => 'test-version',
      getUsageStatisticsEnabled: () => false,
      storage: {
        getProjectDir: () => '/tmp/qwen-agent-depth-integration',
      },
      getDebugLogger: () => debugLogger,
      getBackgroundTaskRegistry: () => backgroundRegistry,
      getMonitorRegistry: () => monitorRegistry,
      getDisableAllHooks: () => false,
      getMessageBus: () => undefined,
      getPermissionsDeny: () => undefined,
      getShellExecutionConfig: () => undefined,
      getFileReadCache: () => ({ clear: vi.fn() }),
    } as unknown as Config;

    refs.config = config;
    const rootRegistry = await createRegistry();
    refs.rootRegistry = rootRegistry;
    rootTool = rootRegistry.getTool('agent')!;
    return { config, rootTool };
  }

  function createInvocation(tool: AgentTool): AgentToolInvocation {
    return (tool as AgentToolWithProtectedMethods).createInvocation({
      description: 'Run worker',
      prompt: 'Run the worker',
      subagent_type: 'worker',
    });
  }

  function toolNamesForRequest(
    request: GenerateContentParameters | undefined,
  ): Array<string | undefined> {
    return (
      request?.config?.tools?.flatMap((tool) => {
        const declarations = (
          tool as { functionDeclarations?: FunctionDeclaration[] }
        ).functionDeclarations;
        return declarations?.map((declaration) => declaration.name) ?? [];
      }) ?? []
    );
  }

  it('blocks nested agent calls at the default max depth and labels depth-1 requests', async () => {
    const { rootTool } = await createHarness();

    const result = await createInvocation(rootTool).execute();

    expect(partToString(result.llmContent)).toBe('done at depth 1');
    expect(
      contentGenerator.requests.map((request) => request.config?.labels),
    ).toEqual([{ agent_depth: '1' }, { agent_depth: '1' }]);
    expect(toolNamesForRequest(contentGenerator.requests[0])).not.toContain(
      'agent',
    );
  });

  it('allows one nested foreground agent when QWEN_AGENT_MAX_DEPTH=2', async () => {
    vi.stubEnv('QWEN_AGENT_MAX_DEPTH', '2');
    const { rootTool } = await createHarness();

    const result = await createInvocation(rootTool).execute();

    expect(partToString(result.llmContent)).toBe('done at depth 1');
    expect(
      contentGenerator.requests.map(
        (request) => request.config?.labels?.['agent_depth'],
      ),
    ).toEqual(['1', '2', '1']);
    expect(toolNamesForRequest(contentGenerator.requests[0])).toContain(
      'agent',
    );
  });

  it('does not expose agent tool declarations to background agents', async () => {
    vi.stubEnv('QWEN_AGENT_MAX_DEPTH', '2');
    const { rootTool } = await createHarness();

    const invocation = (
      rootTool as AgentToolWithProtectedMethods
    ).createInvocation({
      description: 'Run background worker',
      prompt: 'Run the worker in the background',
      subagent_type: 'worker',
      run_in_background: true,
    });

    const result = await invocation.execute();

    expect(partToString(result.llmContent)).toContain(
      'The agent is working in the background',
    );
    await vi.waitFor(() => {
      expect(contentGenerator.requests.length).toBeGreaterThan(0);
    });
    expect(
      contentGenerator.requests.map((request) => request.config?.labels),
    ).toEqual(expect.arrayContaining([{ agent_depth: '1' }]));
    expect(toolNamesForRequest(contentGenerator.requests[0])).not.toContain(
      'agent',
    );
  });
});

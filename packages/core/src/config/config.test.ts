/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  attachTestPermission,
  setTestSessionPermission,
} from '../test-utils/config.js';
import { createPermissionManager } from '../test-utils/config.js';
import { createCheckerDepsForConfig } from '../permissions/config-checker-deps.js';
import type { ConfigService } from '../config-service/config-service.js';

import { getModelRequestRetryConfig } from '../model-request/retry-context.js';
import { ENV_USE_POWERSHELL_TOOL } from '../tools/powerShellFeatureGate.js';

import { createEmptyLoadedSettings } from '../test-utils/config.js';
import { QueryTurn } from '../core/query-turn.js';
import { ResourceService, SettingsService } from '@qwen-code/resource';
import {
  initializeBuiltinPlugins,
  getBuiltinPluginRegistry,
} from '../test-utils/builtinPluginLifecycle.js';
import type { BuiltinPluginContext } from '../builtin-plugins/types.js';

async function prepareBuiltinPlugins(
  mode: 'interactive' | 'headless' = 'headless',
  context: Partial<BuiltinPluginContext> = {},
) {
  await initializeBuiltinPlugins({
    mode,
    isSettingSourceAllowed: () => true,
    notifyChanged: async () => {},
    whenReady: async () => {},
    ...context,
  });
  return {
    builtinPlugins: getBuiltinPluginRegistry(),
    builtinPluginsInitialization: Promise.resolve(),
  };
}
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
  type MockInstance,
} from 'vitest';
import {
  Config,
  DEFAULT_CHAT_MODEL_MAX_ATTEMPTS,
  DEFAULT_FILE_FILTERING_OPTIONS,
  NON_INTERACTIVE_MCP_BUDGET_MS,
  type ConfigParameters,
  type ContentGeneratorConfig,
} from './config.js';
import { runLogger } from '../utils/runLogger.js';
import {
  type PermissionPolicySnapshot,
} from '../permissions/manager/policy.js';
import {
  HookType,
  HookEventName,
  type HookDefinition,
} from '../hooks/types.js';
import { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import { uiTelemetryService } from '../services/session-stats.js';
import type { FileSystemService } from '../services/fileSystemService.js';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fsPromises from 'node:fs/promises';
import { DEFAULT_CONTEXT_FILENAME } from '../tools/memoryTool.js';

import { AuthType } from '@qwen-code/resource';
import { ShellTool } from '../tools/shell.js';
import type { AnyDeclarativeTool } from '../tools/tools.js';
import { MockTool } from '../test-utils/mock-tool.js';
import { ReadFileTool } from '../tools/read-file.js';
import { ENV_ENABLE_BASH_PTY_TOOLS } from '../tools/bash-pty-feature-gate.js';
import { ENV_MCP_INIT_BUDGET_MS } from './brand.js';
import { RipGrepTool } from '../tools/ripGrep.js';

import { ToolRegistry } from '../tools/tool-registry.js';
import { SKILL_TOOL_NAME, WORKFLOW_TOOL_NAME } from '../tools/tool-names.js';
import * as codeModeSettings from '../codemode/settings.js';
import {
  CODE_MODE_FEATURE_ENV,
  CODE_MODE_FEATURE_GATE,
} from '../config-service/features/codeMode.js';
const configSourceMocks = vi.hoisted(() => ({
  getConfigValue: vi.fn(),
  initializeConfigService: vi.fn(async () => {}),
  ensureConfigReadyForRequest: vi.fn(async () => {}),
}));

vi.mock('../config-service/index.js', () => ({
  getConfigValue: configSourceMocks.getConfigValue,
  subscribeConfigValue: vi.fn(),
  initializeConfigService: configSourceMocks.initializeConfigService,
  ensureConfigReadyForRequest: configSourceMocks.ensureConfigReadyForRequest,
}));

function setConfigClient(
  client: { getValue(namespace: string, key: string): unknown } | null,
): void {
  configSourceMocks.getConfigValue.mockImplementation((key: string) =>
    client?.getValue('', key),
  );
}
import {
  LoadedSettings,
  ProjectResource,
  UserResource,
  type MergedSettings,
  type Settings,
  type SkillDefinition,
} from '@qwen-code/resource';
import type { LoadedPlugin } from '../plugins/types.js';
import type { SessionMcpManager } from '../mcp/sessionMcpManager/index.js';
import { createUserMessage } from '../protocol/transcript/conversions.js';
import { Storage } from './storage.js';
import { CONFIG_DIR } from '../utils/paths.js';
import { getSessionTranscriptPath } from '../services/transcript-paths.js';
import type { AgentLoopContext } from './agent-loop-context.js';
import type { ListedModelEntryFixture } from '../test-utils/listed-model-entry.js';
import {
  mockListedEntries,
  mockListedModels,
  testListedModel,
} from '../test-utils/listed-model.js';
import {
  AUTO_MODE_UNSUPPORTED_MESSAGE,
  BYPASS_PERMISSIONS_DISABLED_MESSAGE,
} from '../permissions/permission-modes/index.js';
import { resolveDreamConfig } from '../services/autoDream/config.js';
import { createPromptRenderInputs } from '../prompts/render-inputs.js';
import { SystemPromptAssembler } from '../prompts/system-prompt-assembler.js';
import {
  ENV_MODEL,
  ENV_DREAM,
  ENV_MEMORY_HEADLESS,
  ENV_MEMORY_PROJECT,
  ENV_MEMORY_USER,
} from './brand.js';
import type { Model, ModelConfig } from '../provider/model/model.js';
import type { ModelProvider } from '../provider/modelProvider.js';
import { CustomModelProvider } from '../provider/impl/customModelProvider.js';
import { CustomProviderConfig } from '../provider/impl/customProviderConfig.js';
import { ModelTransportManager } from '../provider/transport/modelTransportManager.js';
import {
  OPENAI_CHAT_COMPLETIONS,
  OPENAI_RESPONSES,
  ANTHROPIC_MESSAGES,
} from '../provider/transport/modelProtocol.js';
import { ChatCompletionsTransport } from '../provider/transport/impl/chatCompletionsTransport.js';
import { MessagesTransport } from '../provider/transport/impl/messagesTransport.js';
import { ResponsesTransport } from '../provider/transport/impl/responsesTransport.js';
import type { CustomClient } from '../client/customClient.js';

const DEFAULT_MODEL = 'qwen-max';
const PREVIEW_3_1_MODEL = 'qwen-coder';
const DEFAULT_MODEL_AUTO = 'auto';
const PREVIEW_MODEL_AUTO = 'auto';
const originalBashPtyToolsEnv = process.env[ENV_ENABLE_BASH_PTY_TOOLS];

const resourceManagerMockState = vi.hoisted(() => ({
  outputStyles: [] as Array<
    import('../prompts/outputStyles/types.js').OutputStyleConfig
  >,
  reloadOutputStyles: vi.fn(
    async (_options?: {
      notify?: boolean;
      projectConfigDirOverride?: string;
    }) => undefined,
  ),
  userReloadOutputStyles: vi.fn(async () => undefined),
  projectSkills: [] as SkillDefinition[],
  userSkills: [] as SkillDefinition[],
  projectSkillErrors: [] as Array<
    import('@qwen-code/resource').SkillLoadError
  >,
  userSkillErrors: [] as Array<
    import('@qwen-code/resource').SkillLoadError
  >,
  listeners: new Set<
    Parameters<
      import('@qwen-code/resource').SkillResourceView['onDidChange']
    >[0]
  >(),
  userSkillListeners: new Set<
    Parameters<
      import('@qwen-code/resource').SkillResourceView['onDidChange']
    >[0]
  >(),
  reloadSkills: vi.fn(async () => undefined),
  userReloadSkills: vi.fn(async () => undefined),
  reloadAgents: vi.fn(async () => undefined),
  userReloadAgents: vi.fn(async () => undefined),
  watcherReady: Promise.resolve() as Promise<void>,
  updateWorkspaceContext: vi.fn(
    async (_context: {
      isTrusted?: boolean;
      additionalDirectories: readonly string[];
    }) => undefined,
  ),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({
      isDirectory: () => true,
    })),
    realpathSync: vi.fn((path) => path),
  };
});

// Mock dependencies that might be called during Config construction or createServerConfig
vi.mock('../tools/tool-registry', () => {
  const ToolRegistryMock = vi.fn();
  ToolRegistryMock.prototype.registerTool = vi.fn();
  ToolRegistryMock.prototype.unregisterTool = vi.fn();
  ToolRegistryMock.prototype.sortTools = vi.fn();
  ToolRegistryMock.prototype.getAllTools = vi.fn(() => []); // Mock methods if needed
  ToolRegistryMock.prototype.getTool = vi.fn();
  ToolRegistryMock.prototype.getKnownTool = vi.fn();
  ToolRegistryMock.prototype.getAllToolNames = vi.fn(() => []);
  ToolRegistryMock.prototype.getFunctionDeclarations = vi.fn(() => []);
  ToolRegistryMock.prototype.dispose = vi.fn();
  return { ToolRegistry: ToolRegistryMock };
});

vi.mock('../mcp/sessionMcpManager/index.js', () => ({
  SessionMcpManager: vi.fn().mockImplementation(() => ({
    initialize: vi.fn(),
    getMcpInstructions: vi.fn().mockReturnValue('MCP Instructions'),
    getInjectedMcpTools: () => ({ tools: [], includeMetaTools: false }),
    dispose: vi.fn(async () => {}),
  })),
}));

// Config tests exercise startup ordering, not filesystem discovery. Keep the
// resource facade synchronous here so real directory I/O/watch startup cannot
// distort the MCP/skills scheduling assertions.
vi.mock('@qwen-code/resource', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/resource')>();

  class MockUserSkillsView {
    readonly ready = Promise.resolve();
    readonly watcherReady = resourceManagerMockState.watcherReady;
    getAllDiscoveredSkills() {
      return [...resourceManagerMockState.userSkills];
    }
    getLoadErrors() {
      return [...resourceManagerMockState.userSkillErrors];
    }
    onDidChange(
      listener: Parameters<
        import('@qwen-code/resource').SkillResourceView['onDidChange']
      >[0],
    ) {
      resourceManagerMockState.userSkillListeners.add(listener);
      return () => resourceManagerMockState.userSkillListeners.delete(listener);
    }
  }

  class MockUserResource {
    readonly ready = Promise.resolve();
    readonly watcherReady = resourceManagerMockState.watcherReady;
    readonly skills = new MockUserSkillsView();
    getSkills(_options: { loadFromAgentsDirectory: boolean }) {
      return this.skills;
    }
    readonly dispose = vi.fn(async () => {});
    readonly agents = {
      getAllDiscoveredAgents: () => [],
      getLoadErrors: () => [],
      onDidChange: () => () => undefined,
    };
    readonly outputStyles = {
      getAllDiscoveredOutputStyles: () =>
        [] as Array<
          import('../prompts/outputStyles/types.js').OutputStyleConfig
        >,
      getLoadErrors: () => [],
      onDidChange: () => () => undefined,
    };
    async reloadSkills(options?: { notify?: boolean }): Promise<void> {
      await resourceManagerMockState.userReloadSkills();
      if (options?.notify === false) return;
      await Promise.all(
        [...resourceManagerMockState.userSkillListeners].map((listener) =>
          listener(undefined, {
            discoveredSkills: [...resourceManagerMockState.userSkills],
            loadErrors: [...resourceManagerMockState.userSkillErrors],
          }),
        ),
      );
    }
    async reloadAgents(): Promise<void> {
      await resourceManagerMockState.userReloadAgents();
    }
    async reloadOutputStyles(): Promise<void> {
      await resourceManagerMockState.userReloadOutputStyles();
    }
  }

  class MockProjectResource {
    readonly ready = Promise.resolve();
    readonly watcherReady = resourceManagerMockState.watcherReady;
    readonly outputStyles = {
      getAllDiscoveredOutputStyles: () =>
        resourceManagerMockState.outputStyles.map((style) => ({ ...style })),
      getLoadErrors: () => [],
    };
    async reloadOutputStyles(options?: {
      notify?: boolean;
      projectConfigDirOverride?: string;
    }): Promise<void> {
      await resourceManagerMockState.reloadOutputStyles(options);
    }
    readonly skills = {
      getAllDiscoveredSkills: () => [...resourceManagerMockState.projectSkills],
      getLoadErrors: () => [...resourceManagerMockState.projectSkillErrors],
      onDidChange: (
        listener: Parameters<
          import('@qwen-code/resource').SkillResourceView['onDidChange']
        >[0],
      ) => {
        resourceManagerMockState.listeners.add(listener);
        return () => resourceManagerMockState.listeners.delete(listener);
      },
      agents: {
        getAllDiscoveredAgents: () => [],
        getLoadErrors: () => [],
        onDidChange: () => () => undefined,
      },
    };

    async updateWorkspaceContext(context: {
      isTrusted?: boolean;
      additionalDirectories: readonly string[];
    }): Promise<void> {
      await resourceManagerMockState.updateWorkspaceContext(context);
    }
    async reloadSkills(options?: { notify?: boolean }): Promise<void> {
      await resourceManagerMockState.reloadSkills();
      if (options?.notify === false) return;
      await Promise.all(
        [...resourceManagerMockState.listeners].map((listener) =>
          listener(undefined, {
            discoveredSkills: [...resourceManagerMockState.projectSkills],
            loadErrors: [...resourceManagerMockState.projectSkillErrors],
          }),
        ),
      );
    }
    async reloadAgents(): Promise<void> {
      await resourceManagerMockState.reloadAgents();
    }
    async dispose(): Promise<void> {}
  }

  class MockResourceService {
    private loadFlag: boolean | undefined;
    get loadFromAgentsDirectory() {
      return this.loadFlag;
    }
    private readonly contexts = new Map<
      string,
      { project: MockProjectResource; userSkills: MockUserSkillsView }
    >();
    private readonly userResource = new MockUserResource();
    getUserResource(options?: { loadFromAgentsDirectory?: boolean }) {
      this.loadFlag ??= options?.loadFromAgentsDirectory ?? false;
      return this.userResource;
    }
    getProjectResource(options: unknown) {
      const key = JSON.stringify(options);
      let context = this.contexts.get(key);
      if (!context) {
        context = {
          project: new MockProjectResource(),
          userSkills: new MockUserSkillsView(),
        };
        this.contexts.set(key, context);
      }
      return {
        project: context.project,
        get ready() {
          return Promise.resolve();
        },
        get watcherReady() {
          return Promise.resolve().then(
            () => resourceManagerMockState.watcherReady,
          );
        },
        isForContext: (nextOptions: unknown) =>
          JSON.stringify(nextOptions) === key,
        release: async () => {},
      };
    }
    async dispose(): Promise<void> {}
  }

  return {
    ...actual,
    ProjectResource: MockProjectResource,
    UserResource: MockUserResource,
    ResourceService: MockResourceService,
  };
});

async function publishMockSkillResourceChange(
  name: string,
  events?: ReadonlyArray<
    import('@qwen-code/resource').ResourceChangeEvent
  >,
): Promise<void> {
  const skillRoot = `/repo/.qwen/skills/${name}`;
  resourceManagerMockState.projectSkills = [
    {
      name,
      description: `${name} description`,
      location: `${skillRoot}/SKILL.md`,
      skillRoot,
      body: `${name} body`,
      source: 'project',
    },
  ];
  const snapshot = {
    discoveredSkills: [...resourceManagerMockState.projectSkills],
    loadErrors: [],
  };
  await Promise.all(
    [...resourceManagerMockState.listeners].map((listener) =>
      listener(events, snapshot),
    ),
  );
}

// Mock individual tools if their constructors are complex or have side effects
vi.mock('../tools/ls');
vi.mock('../tools/read-file');
vi.mock('../tools/ripGrep.js', () => ({
  RipGrepTool: class MockRipGrepTool {},
}));
vi.mock('../tools/glob');
vi.mock('../tools/edit');
vi.mock('../tools/shell');
vi.mock('../tools/write-file');
vi.mock('../tools/web-fetch');
vi.mock('../tools/read-many-files');

vi.mock('../services/fileDiscoveryService.js');

vi.mock('../agents/registry/agentRegistry.js', () => {
  const AgentRegistryMock = vi.fn();
  AgentRegistryMock.prototype.initialize = vi.fn().mockResolvedValue(undefined);
  AgentRegistryMock.prototype.dispose = vi.fn();
  AgentRegistryMock.prototype.getAllDefinitions = vi.fn(() => []);
  AgentRegistryMock.prototype.getAllDiscoveredAgentNames = vi.fn(() => []);
  AgentRegistryMock.prototype.getDefinition = vi.fn();
  return { AgentRegistry: AgentRegistryMock };
});

vi.mock('../agents/subagent-tool.js', () => ({
  AgentTool: vi.fn(),
}));

const mockCoreEvents = vi.hoisted(() => ({
  emit: vi.fn(),
  emitFeedback: vi.fn(),
  emitModelChanged: vi.fn(),
  emitModelInfoChanged: vi.fn(),
  emitReasoningEffortChanged: vi.fn(),
  emitContextWindowChanged: vi.fn(),
  emitFunctionSwitchSelectionsChanged: vi.fn(),
  emitPermissionModeChanged: vi.fn(),
  emitSessionTitleChanged: vi.fn(),
  emitTrustChanged: vi.fn(),
  emitConsoleLog: vi.fn(),
  emitQuotaChanged: vi.fn(),
  on: vi.fn(),
  onSessionEvent: vi.fn(() => vi.fn()),
  off: vi.fn(),
}));

vi.mock('../utils/events.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/events.js')>();
  return {
    ...actual,
    coreEvents: mockCoreEvents,
  };
});

vi.mock('../context/memoryContextManager.js', () => ({
  MemoryContextManager: vi.fn().mockImplementation(() => ({
    refresh: vi.fn().mockResolvedValue(undefined),
    getGlobalMemory: vi.fn().mockReturnValue(''),
    getPluginMemory: vi.fn().mockReturnValue(''),
    getEnvironmentMemory: vi.fn().mockReturnValue(''),
    getLocalMemory: vi.fn().mockReturnValue(''),
    getJitMemory: vi.fn().mockReturnValue(''),
    getLoadedPaths: vi.fn().mockReturnValue(new Set()),
  })),
}));

import { tokenLimit } from '../core/tokenLimits.js';
import { MemoryContextManager } from '../context/memoryContextManager.js';

vi.mock('../core/tokenLimits.js', () => ({
  tokenLimit: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  if (originalBashPtyToolsEnv === undefined) {
    delete process.env[ENV_ENABLE_BASH_PTY_TOOLS];
  } else {
    process.env[ENV_ENABLE_BASH_PTY_TOOLS] = originalBashPtyToolsEnv;
  }
  setConfigClient(null);
  resourceManagerMockState.outputStyles = [];
  resourceManagerMockState.reloadOutputStyles.mockReset();
  resourceManagerMockState.projectSkills = [];
  resourceManagerMockState.userSkills = [];
  resourceManagerMockState.projectSkillErrors = [];
  resourceManagerMockState.userSkillErrors = [];
  resourceManagerMockState.userSkillListeners.clear();
  resourceManagerMockState.listeners.clear();
  resourceManagerMockState.reloadSkills.mockClear();
  resourceManagerMockState.reloadAgents.mockClear();
  resourceManagerMockState.watcherReady = Promise.resolve();
  resourceManagerMockState.updateWorkspaceContext.mockClear();
});

/**
 * A permission object that actually remembers its mode, so a test can assert
 * what a mode transition did rather than what was written into a context.
 */
const makePermissionStub = (
  rules: {
    allow?: Record<string, string[]>;
    deny?: Record<string, string[]>;
    ask?: Record<string, string[]>;
  } = {},
) => {
  let mode = 'default';
  return {
    getPermissionMode: () => mode,
    setPermissionMode: (next: string) => {
      mode = next;
    },
    getRules: () => ({
      allow: rules.allow ?? {},
      deny: rules.deny ?? {},
      ask: rules.ask ?? {},
    }),
    setRules: vi.fn(),
    getAdditionalDirectories: () => [],
    setAdditionalDirectories: vi.fn(),
  } as unknown as NonNullable<Config['permission']>;
};

describe('Server Config (config.ts)', () => {
  const MODEL = DEFAULT_MODEL;
  const TARGET_DIR = '/path/to/target';
  const DEBUG_MODE = false;
  const QUESTION = 'test question';
  const USER_MEMORY = 'Test User Memory';
  const EMBEDDING_MODEL = 'gemini-embedding';
  const SESSION_ID = 'test-session-id';
  const baseParams: ConfigParameters = {
    modelTransportManager: new ModelTransportManager([]),
    loadedSettings: createEmptyLoadedSettings(),
    cwd: '/tmp',
    embeddingModel: EMBEDDING_MODEL,
    targetDir: TARGET_DIR,
    debugMode: DEBUG_MODE,
    question: QUESTION,
    userMemory: USER_MEMORY,
    sessionId: SESSION_ID,
    model: MODEL,
  };

  describe('transport manager 缺省装配', () => {
    it('省略入参时提供三种通用协议，实例供本 Config 复用', async () => {
      const config = new Config({
        ...baseParams,
        modelTransportManager: undefined,
      });
      try {
        const transports = config.getModelTransportManager();
        expect(config.getModelTransportManager()).toBe(transports);
        expect(transports.resolve(OPENAI_CHAT_COMPLETIONS)).toBeInstanceOf(
          ChatCompletionsTransport,
        );
        expect(transports.resolve(OPENAI_RESPONSES)).toBeInstanceOf(
          ResponsesTransport,
        );
        expect(transports.resolve(ANTHROPIC_MESSAGES)).toBeInstanceOf(
          MessagesTransport,
        );
      } finally {
        await config.dispose();
      }
    });

    it('显式注入时保留原实例，不补注册未声明的协议', async () => {
      const transports = new ModelTransportManager([]);
      const config = new Config({
        ...baseParams,
        modelTransportManager: transports,
      });
      try {
        expect(config.getModelTransportManager()).toBe(transports);
        expect(() => transports.resolve(OPENAI_CHAT_COMPLETIONS)).toThrow(
          'protocol not supported',
        );
      } finally {
        await config.dispose();
      }
    });

    it.each(['openai', 'openai-responses', 'anthropic'])(
      '未传 transport 时仍创建项目 Custom Provider（%s）',
      async (protocol) => {
        const settingsService = new SettingsService();
        vi.spyOn(settingsService, 'getProjectSettingsSources').mockReturnValue({
          project: {
            read: () =>
              JSON.stringify({
                providers: {
                  local: {
                    baseUrl: 'https://unused.invalid',
                    apiKey: '',
                    model: 'helper',
                    protocol,
                  },
                },
              }),
          },
          local: { read: () => undefined },
        } as never);
        const config = new Config({
          ...baseParams,
          settingsService,
          modelTransportManager: undefined,
        });
        try {
          const manager = config.getModelProviderManager();
          await manager.start();
          const target = await manager.getModel('local/helper');
          expect(target).toBeDefined();
          manager.setMainModel(target!, false);
          expect((await manager.select({ purpose: 'main' })).model).toBe(
            target,
          );
        } finally {
          await config.dispose();
        }
      },
    );
  });

  it('provider 工厂绑定所属会话的重试配置，构造后不泄露上下文', () => {
    const captured: Array<ReturnType<typeof getModelRequestRetryConfig>> = [];
    const factory = () => { captured.push(getModelRequestRetryConfig()); return []; };
    const first = new Config({ ...baseParams, maxAttempts: 1, retryFetchErrors: false, modelProviderFactory: factory });
    const second = new Config({ ...baseParams, maxAttempts: 7, retryFetchErrors: true, modelProviderFactory: factory });
    expect(captured).toEqual([first, second]);
    expect(captured[0]?.getMaxAttempts()).toBe(1);
    expect(captured[0]?.getRetryFetchErrors()).toBe(false);
    expect(captured[1]?.getMaxAttempts()).toBe(7);
    expect(captured[1]?.getRetryFetchErrors()).toBe(true);
    expect(getModelRequestRetryConfig()).toBeUndefined();
  });

  it('isolates explicit shell progress counting between sessions', () => {
    const enabled = new Config(baseParams);
    const legacy = new Config({ ...baseParams, sessionId: 'legacy' });
    expect(
      enabled.getShellExecutionConfig().exactOutputLineCount,
    ).toBeUndefined();
    enabled.setShellProgressEnabled(true);
    expect(enabled.getShellExecutionConfig().exactOutputLineCount).toBe(true);
    expect(
      legacy.getShellExecutionConfig().exactOutputLineCount,
    ).toBeUndefined();
    enabled.setShellProgressEnabled(false);
    expect(
      enabled.getShellExecutionConfig().exactOutputLineCount,
    ).toBeUndefined();
  });

  it('执行 hook 工厂延迟访问管理器，并隔离同会话各轮及不同会话的领取状态', () => {
    const first = new Config(baseParams);
    const second = new Config({ ...baseParams, sessionId: 'second-session' });
    const firstManager = first.getCronManager();
    const secondManager = second.getCronManager();
    const getFirst = vi.spyOn(first, 'getCronManager');
    const getSecond = vi.spyOn(second, 'getCronManager');
    const claimFirst = vi.spyOn(firstManager, 'claimPendingFires');
    const claimSecond = vi
      .spyOn(secondManager, 'claimPendingFires')
      .mockReturnValue([]);
    claimFirst
      .mockReturnValueOnce([
        { registeredAt: Date.now(), taskId: 'task', isWakeup: true },
      ])
      .mockReturnValue([]);
    const createTurn = (config: Config, turnId: string) =>
      new QueryTurn({
        turnId,
        sessionId: config.getSessionId(),
        signal: new AbortController().signal,
        modules: config.turnHookFactories.map((createModule) => createModule()),
      });
    try {
      const scheduled = createTurn(first, 'scheduled');
      const ordinary = createTurn(first, 'ordinary');
      const otherSession = createTurn(second, 'other');
      expect(getFirst).not.toHaveBeenCalled();
      expect(getSecond).not.toHaveBeenCalled();
      const input = {
        taskId: 'task',
        promptText: 'prompt',
        isSubagent: false,
        isWorkflow: false,
        isRemoteWorker: false,
      };
      expect(scheduled.runStart(input).trigger).toBe('scheduled');
      expect(ordinary.runStart(input).trigger).toBe('unknown');
      expect(otherSession.runStart(input).trigger).toBe('unknown');
      const result = { index: 0, model: 'model', outcome: 'complete' as const };
      ordinary.stepResult(result);
      otherSession.stepResult(result);
      scheduled.stepResult(result);
      expect(claimFirst).toHaveBeenCalledTimes(2);
      expect(claimSecond).toHaveBeenCalledOnce();
    } finally {
      for (const spy of [
        getFirst,
        getSecond,
        claimFirst,
        claimSecond,
      ])
        spy.mockRestore();
    }
  });

  it('MCP lazy 配置在初始化前可设置，初始化后同步通知管理器', async () => {
    const setLazyMode = vi.fn();
    const { SessionMcpManager } = await import(
      '../mcp/sessionMcpManager/index.js'
    );
    vi.mocked(SessionMcpManager).mockImplementationOnce(
      () =>
        ({
          initialize: vi.fn(),
          getMcpInstructions: vi.fn(),
          getInjectedMcpTools: () => ({ tools: [], includeMetaTools: false }),
          setLazyMode,
          dispose: vi.fn(),
        }) as unknown as SessionMcpManager,
    );
    const config = new Config(baseParams);
    config.setMcpLazyLoad(true);
    expect(config.getMcpLazyLoad()).toBe(true);
    await config.initialize();
    config.setMcpLazyLoad(false);
    expect(setLazyMode).toHaveBeenCalledWith(false);
  });

  it('keeps the MCP lazy preference unchanged under CodeMode only; the manager decides registration', () => {
    const config = new Config({
      ...baseParams,
      mcpLazyLoad: true,
      getSetting: (section) =>
        section === 'codeMode' ? { mode: 'only' } : undefined,
    });
    expect(config.getMcpLazyLoad()).toBe(true);
  });

  it('keeps session artifacts anchored to originalCwd while the worktree is active', () => {
    const originalCwd = '/repo/apps/desktop';
    const worktreePath = '/repo/.qwen/worktrees/session-a';
    const worktreeCwd = `${worktreePath}/apps/desktop`;
    const config = new Config({
      ...baseParams,
      cwd: worktreeCwd,
      targetDir: worktreeCwd,
    });

    config.setWorktreeSettings({
      name: 'session-a',
      path: worktreePath,
      worktreeCwd,
      baseSha: 'base-sha',
      originalCwd,
      lifecycle: 'attached',
    });

    expect(config.getProjectRoot()).toBe(worktreeCwd);
    expect(config.getSessionArtifactProjectRoot()).toBe(originalCwd);
  });

  it('prefers the active writer path over the worktree artifact fallback', () => {
    const originalCwd = '/repo/apps/desktop';
    const worktreePath = '/repo/.qwen/worktrees/session-a';
    const worktreeCwd = `${worktreePath}/apps/desktop`;
    const config = new Config({
      ...baseParams,
      cwd: worktreeCwd,
      targetDir: worktreeCwd,
      sessionId: 'session-a',
    });
    config.setWorktreeSettings({
      name: 'session-a',
      path: worktreePath,
      worktreeCwd,
      baseSha: 'base-sha',
      originalCwd,
      lifecycle: 'attached',
    });

    expect(config.getActiveSessionTranscriptPath()).toBe(
      getSessionTranscriptPath(originalCwd, 'session-a'),
    );

    const livePath = '/legacy-project/session-a.jsonl';
    config.registerSessionRuntimeBinding({
      refreshRuntimeContext: vi.fn(),
      getTranscriptPath: () => livePath,
    });

    expect(config.getActiveSessionTranscriptPath()).toBe(livePath);
  });

  describe('maxAttempts', () => {
    it('should default to DEFAULT_CHAT_MODEL_MAX_ATTEMPTS', () => {
      const config = new Config(baseParams);
      expect(config.getMaxAttempts()).toBe(DEFAULT_CHAT_MODEL_MAX_ATTEMPTS);
    });

    it('should use a provided positive maxAttempts value', () => {
      const config = new Config({
        ...baseParams,
        maxAttempts: 7,
      });
      expect(config.getMaxAttempts()).toBe(7);
    });

    it('should not impose a product-level maxAttempts ceiling', () => {
      const config = new Config({
        ...baseParams,
        maxAttempts: 20,
      });
      expect(config.getMaxAttempts()).toBe(20);
    });

    it('should treat a non-positive maxAttempts as one attempt without retry', () => {
      const config = new Config({
        ...baseParams,
        maxAttempts: 0,
      });
      expect(config.getMaxAttempts()).toBe(1);
    });
  });

  describe('UltraCode session state', () => {
    it('uses the startup setting until a session override is applied or cleared', () => {
      const config = new Config({ ...baseParams, ultracode: true });

      expect(config.getUltracode()).toBe(true);
      config.setUltracode(false);
      expect(config.getUltracode()).toBe(false);
      config.clearUltracodeOverride();
      expect(config.getUltracode()).toBe(true);
    });

    it('requires the stored xhigh effort without changing the UltraCode request', () => {
      const config = new Config({ ...baseParams, ultracode: true });
      vi.spyOn(config, 'isUltracodeAvailable').mockReturnValue(true);
      const getModelConfig = vi
        .spyOn(config.getModelProviderManager(), 'getModelConfig')
        .mockReturnValue({ reasoning: { effort: 'high' } });

      const model = testListedModel(config.getModel());
      expect(config.isUltracodeActive(model)).toBe(false);
      expect(config.getUltracode()).toBe(true);

      getModelConfig.mockReturnValue({ reasoning: { effort: 'xhigh' } });
      expect(config.isUltracodeActive(model)).toBe(true);
      expect(config.isUltracodeActive(undefined)).toBe(false);
      expect(getModelConfig).toHaveBeenLastCalledWith(model);
    });

    it('defaults the local keyword trigger to enabled', () => {
      const enabled = new Config(baseParams);
      const disabled = new Config({
        ...baseParams,
        workflowKeywordTriggerEnabled: false,
      });

      expect(enabled.getWorkflowKeywordTriggerEnabled()).toBe(true);
      expect(disabled.getWorkflowKeywordTriggerEnabled()).toBe(false);
    });
  });

  describe('turn interrupt slot', () => {
    it('invokes the installed interrupt', () => {
      const config = new Config(baseParams);
      const interrupt = vi.fn();

      config.setTurnInterrupt(interrupt);
      config.invokeTurnInterrupt();

      expect(interrupt).toHaveBeenCalledTimes(1);
    });

    it('does nothing before an interrupt is installed or after it is cleared', () => {
      const config = new Config(baseParams);
      expect(() => config.invokeTurnInterrupt()).not.toThrow();

      const interrupt = vi.fn();
      config.setTurnInterrupt(interrupt);
      config.setTurnInterrupt(undefined);

      config.invokeTurnInterrupt();
      expect(interrupt).not.toHaveBeenCalled();
    });

    /**
     * The reason the slot is per-session: a process can host several sessions,
     * and a process-wide holder is last-installer-wins, so one session's hook
     * deny would abort whichever session installed most recently.
     */
    it('keeps one session interrupt from reaching another session', () => {
      const first = new Config(baseParams);
      const second = new Config({ ...baseParams, sessionId: 'other-session' });
      const firstInterrupt = vi.fn();
      const secondInterrupt = vi.fn();
      first.setTurnInterrupt(firstInterrupt);
      second.setTurnInterrupt(secondInterrupt);

      first.invokeTurnInterrupt();

      expect(firstInterrupt).toHaveBeenCalledTimes(1);
      expect(secondInterrupt).not.toHaveBeenCalled();
    });

    /**
     * A TUI project rebuild swaps Config while the outgoing tree is still
     * mounted. Its cleanup must clear its own slot rather than disarm the bridge
     * the incoming tree is already using.
     */
    it('clears only the session that installed when an outgoing host unmounts', () => {
      const outgoing = new Config(baseParams);
      const incoming = new Config({ ...baseParams, sessionId: 'rebuilt' });
      const live = vi.fn();
      incoming.setTurnInterrupt(live);

      outgoing.setTurnInterrupt(vi.fn());
      outgoing.setTurnInterrupt(undefined);
      incoming.invokeTurnInterrupt();

      expect(live).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * The PTY output cache used to be a module-level singleton keyed by pid.
   * A process hosting several sessions must keep it per-Config, so one
   * session can never read another session's terminal output.
   */
  describe('per-session PTY output cache', () => {
    it('gives each session its own PTY output cache', () => {
      const first = new Config(baseParams);
      const second = new Config({ ...baseParams, sessionId: 'other-session' });
      first.getPtyLastOutputs().set(4242, 'first-session-screen');

      expect(second.getPtyLastOutputs().has(4242)).toBe(false);
      expect(first.getPtyLastOutputs().get(4242)).toBe('first-session-screen');
    });
  });

  it('Config 初始化、模型校验与释放只启停本会话的 provider', async () => {
    const target = testListedModel(MODEL);
    const makeProvider = (): ModelProvider => ({
      providerId: target.source,
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      listModels: vi.fn(async () => [target]),
      getModel: vi.fn(async (key) =>
        key === target.key ? target : undefined,
      ),
      getModelConfig: vi.fn(() => undefined),
      setModelConfig: vi.fn(() => true),
      select: vi.fn(),
      inference: vi.fn(),
    });
    const provider = makeProvider();
    const otherProvider = makeProvider();
    const first = new Config({
      ...baseParams,
      modelProviderFactory: () => [provider],
    });
    const second = new Config({
      ...baseParams,
      sessionId: 'other-provider-session',
      modelProviderFactory: () => [otherProvider],
    });
    const manager = first.getModelProviderManager();
    const start = vi.spyOn(manager, 'start');
    const stop = vi.spyOn(manager, 'stop');
    try {
      expect(start).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      expect(provider.start).not.toHaveBeenCalled();
      await first.initialize();
      expect(start).toHaveBeenCalledOnce();
      expect(provider.start).toHaveBeenCalledOnce();
      start.mockClear();
      await first.reconcileModelWithListedModels();
      await first.reconcileModelWithListedModels();
      expect(first.getModel()).toBe(target.key);
      expect(start).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      await first.dispose();
      expect(start).not.toHaveBeenCalled();
      expect(stop).toHaveBeenCalledOnce();
      expect(provider.stop).toHaveBeenCalledOnce();
      expect(otherProvider.start).not.toHaveBeenCalled();
      expect(otherProvider.stop).not.toHaveBeenCalled();
      expect(await second.getModelProviderManager().getModel(MODEL)).toBe(
        target,
      );
    } finally {
      await first.dispose();
      await second.dispose();
    }
    expect(otherProvider.stop).not.toHaveBeenCalled();
  });

  describe('SettingsService ownership', () => {
    it('detaches its watch without closing sources reused by a project replacement', async () => {
      const previous = new Config(baseParams);
      const settings = previous.getSettingsService();
      const unwatch = vi.fn();
      Object.assign(previous, { settingsUnwatch: unwatch });
      const dispose = vi.spyOn(settings, 'dispose');
      await previous.dispose();
      expect(unwatch).toHaveBeenCalledOnce();
      expect(dispose).not.toHaveBeenCalled();
      const replacement = new Config({
        ...baseParams,
        settingsService: settings,
      });
      expect(replacement.getSettingsService()).toBe(settings);
      expect(settings.peekUserSettingsSource()).toBeUndefined();
      await replacement.dispose();
      expect(dispose).not.toHaveBeenCalled();
      await settings.dispose();
    });

    it('does not dispose the settings service borrowed by another session', async () => {
      const settingsService = new SettingsService();
      const first = new Config({ ...baseParams, settingsService });
      const second = new Config({
        ...baseParams,
        sessionId: 'other-settings',
        settingsService,
      });
      const dispose = vi.spyOn(settingsService, 'requestDispose');
      expect(first.getSettingsService()).toBe(second.getSettingsService());
      await first.dispose();
      expect(dispose).not.toHaveBeenCalled();
      expect(
        second.getSettingsService().peekUserSettingsSource(),
      ).toBeUndefined();
      await second.dispose();
      expect(dispose).not.toHaveBeenCalled();
      await settingsService.dispose();
    });
  });

  /** Plugin resources share one stable owner per Config, with live session values. */
  describe('per-session plugin runtime context', () => {
    it('keeps live session values and releases plugin resources on disposal', async () => {
      const config = new Config(baseParams);
      const owner = config.getBuiltinSessionContext();
      const dispose = vi.fn();
      owner.onDispose(dispose);
      config.setSessionId('rotated-session');
      expect(owner.sessionId).toBe('rotated-session');
      expect(config.getBuiltinSessionContext()).toBe(owner);
      await config.dispose();
      expect(dispose).toHaveBeenCalledOnce();
      expect(owner.disposed).toBe(true);
    });

    it('isolates disposal notifications, supports unsubscribe and notifies late subscribers', async () => {
      const first = new Config(baseParams);
      const second = new Config({ ...baseParams, sessionId: 'other' });
      const owner = first.getBuiltinSessionContext();
      const removed = vi.fn();
      owner.onDispose(removed)();
      owner.onDispose(() => {
        throw new Error('plugin cleanup failed');
      });
      const notified = vi.fn();
      owner.onDispose(notified);
      const other = vi.fn();
      second.getBuiltinSessionContext().onDispose(other);
      await first.dispose();
      await first.dispose();
      expect(notified).toHaveBeenCalledTimes(1);
      expect(removed).not.toHaveBeenCalled();
      expect(other).not.toHaveBeenCalled();
      expect(second.getBuiltinSessionContext().disposed).toBe(false);
      const late = vi.fn();
      owner.onDispose(late);
      expect(late).toHaveBeenCalledTimes(1);
      await second.dispose();
      expect(other).toHaveBeenCalledTimes(1);
    });

    it('exposes restored sidecar and runtime artifact directories without rereading the transcript', async () => {
      const config = new Config(baseParams);
      const owner = config.getBuiltinSessionContext();
      const worktreeCwd = path.resolve(
        owner.projectRoot,
        'legacy checkout',
        'app',
      );
      config.setSessionArtifactWorktreeStates([
        {
          sessionId: owner.sessionId,
          originalCwd: owner.projectRoot,
          worktreePath: path.dirname(worktreeCwd),
          worktreeCwd,
          worktreeName: 'legacy',
          lifecycle: 'attached',
        },
      ]);
      expect(await owner.getArtifactProjectRoots()).toEqual([
        path.resolve(owner.projectRoot),
        worktreeCwd,
        path.dirname(worktreeCwd),
      ]);
    });

    it('gives each session its own plugin runtime context', () => {
      const first = new Config(baseParams);
      const second = new Config({ ...baseParams, sessionId: 'other-session' });

      expect(first.getBuiltinSessionContext()).toBe(
        first.getBuiltinSessionContext(),
      );
      expect(first.getBuiltinSessionContext()).not.toBe(
        second.getBuiltinSessionContext(),
      );
    });
  });

  describe('loadFromAgentsDirectory', () => {
    it('defaults legacy .agents skill loading to disabled', () => {
      const config = new Config(baseParams);

      expect(config.shouldLoadSkillsFromAgentsDirectory()).toBe(false);
    });

    it('enables legacy .agents skill loading when configured', () => {
      const config = new Config({
        ...baseParams,
        loadSkillsFromAgentsDirectory: true,
      });

      expect(config.shouldLoadSkillsFromAgentsDirectory()).toBe(true);
    });

    it.each([false, true])(
      'uses the session setting when it differs from the process preload setting %s',
      async (processSetting) => {
        const resourceService = new ResourceService();
        resourceService.getUserResource({
          homeDir: process.cwd(),
          loadFromAgentsDirectory: processSetting,
        });
        const getUserResource = vi.spyOn(resourceService, 'getUserResource');
        const getProjectResource = vi.spyOn(
          resourceService,
          'getProjectResource',
        );
        const config = new Config({
          ...baseParams,
          resourceService,
          loadSkillsFromAgentsDirectory: !processSetting,
        });

        await config.prepareResourceView();
        expect(config.shouldLoadUserSkillsFromAgentsDirectory()).toBe(
          !processSetting,
        );
        expect(config.shouldLoadSkillsFromAgentsDirectory()).toBe(
          !processSetting,
        );
        expect(getUserResource).toHaveBeenCalledWith();
        expect(getProjectResource).toHaveBeenCalledWith(
          expect.objectContaining({
            loadFromAgentsDirectory: !processSetting,
          }),
        );
        await config.dispose();
      },
    );
  });

  describe('auto memory settings', () => {
    beforeEach(() => {
      vi.stubEnv(ENV_MEMORY_HEADLESS, '');
      vi.stubEnv(ENV_MEMORY_PROJECT, '');
      vi.stubEnv(ENV_MEMORY_USER, '');
      vi.stubEnv(ENV_DREAM, '');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('uses the QCS auto_memory rollout for both omitted TUI scopes', () => {
      setConfigClient({
        getValue: vi.fn((_namespace: string, key: string) =>
          key === 'auto_memory'
            ? { project_enabled: false, user_enabled: false }
            : undefined,
        ),
      } as never);
      const disabled = new Config({
        ...baseParams,
        interactive: true,
      });

      expect(disabled.isAutoMemoryEnabled()).toBe(false);
      expect(disabled.isAutoMemoryProjectScopeEnabled()).toBe(false);
      expect(disabled.isAutoMemoryUserScopeEnabled()).toBe(false);
      expect(resolveDreamConfig(disabled).enabled).toBe(false);

      setConfigClient({
        getValue: vi.fn((_namespace: string, key: string) =>
          key === 'auto_memory'
            ? { project_enabled: true, user_enabled: true }
            : undefined,
        ),
      } as never);
      const enabled = new Config({
        ...baseParams,
        interactive: true,
      });

      expect(enabled.isAutoMemoryEnabled()).toBe(true);
      expect(enabled.isAutoMemoryProjectScopeEnabled()).toBe(true);
      expect(enabled.isAutoMemoryUserScopeEnabled()).toBe(true);
      expect(resolveDreamConfig(enabled).enabled).toBe(false);
    });

    it('lets explicit TUI scope settings override an enabled QCS default', () => {
      setConfigClient({
        getValue: vi.fn((_namespace: string, key: string) =>
          key === 'auto_memory'
            ? { project_enabled: true, user_enabled: true }
            : undefined,
        ),
      } as never);
      const userOnly = new Config({
        ...baseParams,
        interactive: true,
        autoMemoryEnabled: false,
        autoMemoryUserScopeEnabled: true,
      });
      expect(userOnly.isAutoMemoryEnabled()).toBe(true);
      expect(userOnly.isAutoMemoryProjectScopeEnabled()).toBe(false);
      expect(userOnly.isAutoMemoryUserScopeEnabled()).toBe(true);

      const projectOnly = new Config({
        ...baseParams,
        interactive: true,
        autoMemoryEnabled: true,
        autoMemoryUserScopeEnabled: false,
      });
      expect(projectOnly.isAutoMemoryEnabled()).toBe(true);
      expect(projectOnly.isAutoMemoryProjectScopeEnabled()).toBe(true);
      expect(projectOnly.isAutoMemoryUserScopeEnabled()).toBe(false);

      const disabled = new Config({
        ...baseParams,
        interactive: true,
        autoMemoryEnabled: false,
        autoMemoryUserScopeEnabled: false,
      });
      expect(disabled.isAutoMemoryEnabled()).toBe(false);
      expect(disabled.isAutoMemoryProjectScopeEnabled()).toBe(false);
      expect(disabled.isAutoMemoryUserScopeEnabled()).toBe(false);
    });

    it('resolves each omitted TUI scope from QCS independently', () => {
      setConfigClient({
        getValue: vi.fn((_namespace: string, key: string) =>
          key === 'auto_memory'
            ? { project_enabled: false, user_enabled: true }
            : undefined,
        ),
      } as never);
      const userFromQcs = new Config({
        ...baseParams,
        interactive: true,
      });
      expect(userFromQcs.isAutoMemoryProjectScopeEnabled()).toBe(false);
      expect(userFromQcs.isAutoMemoryUserScopeEnabled()).toBe(true);

      setConfigClient({
        getValue: vi.fn((_namespace: string, key: string) =>
          key === 'auto_memory'
            ? { project_enabled: true, user_enabled: false }
            : undefined,
        ),
      } as never);
      const projectFromQcs = new Config({
        ...baseParams,
        interactive: true,
      });
      expect(projectFromQcs.isAutoMemoryProjectScopeEnabled()).toBe(true);
      expect(projectFromQcs.isAutoMemoryUserScopeEnabled()).toBe(false);
    });

    it('enables auto-memory from settings in interactive mode', () => {
      const config = new Config({
        ...baseParams,
        interactive: true,
        autoMemoryEnabled: true,
      });

      expect(config.isAutoMemoryEnabled()).toBe(true);
      expect(config.isAutoMemoryManuallyEnabled()).toBe(true);
    });

    it('keeps settings-based auto-memory disabled outside interactive mode by default', () => {
      vi.stubEnv(ENV_MEMORY_HEADLESS, '0');

      const config = new Config({
        ...baseParams,
        interactive: false,
        autoMemoryEnabled: true,
      });

      expect(config.isAutoMemoryEnabled()).toBe(false);
    });

    it('keeps headless auto-memory disabled when its master switch is absent', () => {
      const originalHeadlessValue = process.env[ENV_MEMORY_HEADLESS];
      delete process.env[ENV_MEMORY_HEADLESS];

      try {
        const config = new Config({
          ...baseParams,
          interactive: false,
          autoMemoryEnabled: true,
        });

        expect(config.isAutoMemoryEnabled()).toBe(false);
        expect(config.isAutoMemoryManuallyEnabled()).toBe(false);
        expect(config.isAutoMemoryProjectScopeEnabled()).toBe(false);
        expect(config.isAutoMemoryUserScopeEnabled()).toBe(false);
        expect(resolveDreamConfig(config).enabled).toBe(false);
      } finally {
        if (originalHeadlessValue === undefined) {
          delete process.env[ENV_MEMORY_HEADLESS];
        } else {
          process.env[ENV_MEMORY_HEADLESS] = originalHeadlessValue;
        }
      }
    });

    it.each(['1', 'true', 'yes', 'on'])(
      'enables auto-memory in headless mode when its master is %s',
      (value) => {
        vi.stubEnv(ENV_MEMORY_HEADLESS, value);

        const config = new Config({
          ...baseParams,
          interactive: false,
          autoMemoryEnabled: true,
          autoMemoryUserScopeEnabled: true,
        });

        expect(config.isAutoMemoryEnabled()).toBe(true);
        expect(config.isAutoMemoryManuallyEnabled()).toBe(true);
        expect(config.isAutoMemoryProjectScopeEnabled()).toBe(true);
        expect(config.isAutoMemoryUserScopeEnabled()).toBe(true);
        expect(resolveDreamConfig(config).enabled).toBe(true);
      },
    );

    it('uses headless defaults instead of TUI settings', () => {
      vi.stubEnv(ENV_MEMORY_HEADLESS, '1');

      const config = new Config({
        ...baseParams,
        interactive: false,
        autoMemoryEnabled: false,
        autoMemoryUserScopeEnabled: false,
        dream: { enabled: false },
      });

      expect(config.isAutoMemoryEnabled()).toBe(true);
      expect(config.isAutoMemoryProjectScopeEnabled()).toBe(true);
      expect(config.isAutoMemoryUserScopeEnabled()).toBe(true);
      expect(resolveDreamConfig(config).enabled).toBe(true);
    });

    it('lets headless independently disable Project, User, and Dream', () => {
      vi.stubEnv(ENV_MEMORY_HEADLESS, '1');
      vi.stubEnv(ENV_MEMORY_PROJECT, '0');

      const projectDisabled = new Config({
        ...baseParams,
        interactive: false,
      });
      expect(projectDisabled.isAutoMemoryEnabled()).toBe(true);
      expect(projectDisabled.isAutoMemoryProjectScopeEnabled()).toBe(false);
      expect(projectDisabled.isAutoMemoryUserScopeEnabled()).toBe(true);

      vi.stubEnv(ENV_MEMORY_PROJECT, '1');
      vi.stubEnv(ENV_MEMORY_USER, '0');
      const userDisabled = new Config({
        ...baseParams,
        interactive: false,
      });
      expect(userDisabled.isAutoMemoryProjectScopeEnabled()).toBe(true);
      expect(userDisabled.isAutoMemoryUserScopeEnabled()).toBe(false);

      vi.stubEnv(ENV_DREAM, '0');
      expect(resolveDreamConfig(userDisabled).enabled).toBe(false);

      vi.stubEnv(ENV_MEMORY_PROJECT, '0');
      expect(userDisabled.isAutoMemoryEnabled()).toBe(false);
      expect(userDisabled.isAutoMemoryProjectScopeEnabled()).toBe(false);
      expect(userDisabled.isAutoMemoryUserScopeEnabled()).toBe(false);
    });

    it('lets SDK memory independently override PROJECT and USER scopes per Query', () => {
      vi.stubEnv(ENV_MEMORY_HEADLESS, '0');

      const config = new Config({
        ...baseParams,
        interactive: false,
      });
      config.configureSdkMemory({
        active: true,
        generationEnabled: true,
        consumptionEnabled: true,
        projectScope: true,
        userScope: true,
      });
      expect(config.isAutoMemoryProjectScopeEnabled()).toBe(true);
      expect(config.isAutoMemoryUserScopeEnabled()).toBe(true);

      config.configureSdkMemory({
        active: true,
        generationEnabled: true,
        consumptionEnabled: true,
        projectScope: true,
        userScope: false,
      });
      expect(config.isAutoMemoryProjectScopeEnabled()).toBe(true);
      expect(config.isAutoMemoryUserScopeEnabled()).toBe(false);

      config.configureSdkMemory({
        active: true,
        generationEnabled: true,
        consumptionEnabled: true,
        projectScope: false,
        userScope: true,
      });
      expect(config.isAutoMemoryProjectScopeEnabled()).toBe(false);
      expect(config.isAutoMemoryUserScopeEnabled()).toBe(true);
    });

    it('enables both native scopes by default for SDK memory requests', () => {
      vi.stubEnv(ENV_MEMORY_HEADLESS, '0');

      const config = new Config({
        ...baseParams,
        interactive: false,
        autoMemoryEnabled: false,
        autoMemoryUserScopeEnabled: false,
      });
      config.configureSdkMemory({
        active: true,
        generationEnabled: true,
        consumptionEnabled: true,
      });

      expect(config.isAutoMemoryProjectScopeEnabled()).toBe(true);
      expect(config.isAutoMemoryUserScopeEnabled()).toBe(true);
      expect(resolveDreamConfig(config).enabled).toBe(false);
    });

    it('treats SDK skill evolution as a managed review without enabling memory', () => {
      const config = new Config({ ...baseParams, interactive: false });
      config.configureSdkSkillEvolution(true);
      expect(config.isSdkManagedReviewActive()).toBe(true);
      expect(config.isAutoMemoryEnabled()).toBe(false);
    });
  });

  describe('proxy', () => {
    it('should normalize supported socks5h proxy URLs', () => {
      const config = new Config({
        ...baseParams,
        proxy: 'socks5h://127.0.0.1:1080',
      });

      expect(config.getProxy()).toBe('socks5://127.0.0.1:1080');
    });

    it('should ignore unsupported proxy URL protocols', () => {
      const invalidConfig = new Config({
        ...baseParams,
        proxy: 'socks4://127.0.0.1:1080',
      });
      expect(invalidConfig.getProxy()).toBeUndefined();
      expect(invalidConfig.isProxyRequestIgnored()).toBe(true);

      const config = new Config({
        ...baseParams,
        proxy: 'http://proxy.example.com:8080',
      });
      config.setProxy('ftp://proxy.example.com:21');
      expect(config.getProxy()).toBeUndefined();
    });

    it('should ignore a malformed proxy URL', () => {
      const config = new Config({
        ...baseParams,
        proxy: 'not-a-url',
      });

      expect(config.getProxy()).toBeUndefined();
      config.setProxy('still-not-a-url');
      expect(config.getProxy()).toBeUndefined();
    });
  });

  beforeEach(() => {
    // Reset mocks if necessary
    vi.clearAllMocks();
  });

  describe('external settings changes', () => {
    it('re-reads Settings for explicit hook reloads but keeps event-approved snapshots', async () => {
      const onManualSettingsReload = vi.fn();
      const config = new Config({
        ...baseParams,
        onManualSettingsReload,
        onReload: async () => ({ hooks: {} }),
      });
      await config.reloadHooks('settings-event');
      expect(onManualSettingsReload).not.toHaveBeenCalled();
      await config.reloadHooks();
      expect(onManualSettingsReload).toHaveBeenCalledOnce();
    });

    it('adopts a saved model written by another process', async () => {
      let diskSettings: Settings = {};
      const host = {
        merge: (
          user: Settings,
          project: Settings,
          trusted: boolean,
          local: Settings,
          flag: Settings,
        ) =>
          ({
            ...user,
            ...(trusted ? project : {}),
            ...(trusted ? local : {}),
            ...flag,
          }) as MergedSettings,
        runtimeValues: (value: Settings) => value,
        normalizeOriginal: () => {},
        resolveEnvironment: (value: Settings) => value,
        normalizeDisplaySettings: () => {},
        readFile: () => ({
          settings: structuredClone(diskSettings),
          originalSettings: {},
        }),
      };
      const settingsFile = () => ({
        path: '/tmp/test-user-settings.json',
        settings: {} as Settings,
        originalSettings: {} as Settings,
        readOnly: false,
      });
      const loadedSettings = new LoadedSettings(
        host,
        settingsFile(),
        { ...settingsFile(), path: '', readOnly: true },
        { ...settingsFile(), path: '', readOnly: true },
        false,
      );
      const config = new Config({
        ...baseParams,
        loadedSettings,
        model: 'test-model',
        onManualSettingsReload: () => loadedSettings.reload(),
      });
      const modelKey = 'feedback-local/direct-model';
      vi.spyOn(config.getModelProviderManager(), 'getModel').mockImplementation(
        async (key) =>
          key === modelKey ? testListedModel(modelKey) : undefined,
      );
      vi.spyOn(
        config.getModelProviderManager(),
        'getModelConfig',
      ).mockReturnValue(undefined);
      diskSettings = { model: { name: modelKey } } as unknown as Settings;

      try {
        await config.reloadModelConfigFromDisk();

        expect(config.getModel()).toBe(modelKey);
      } finally {
        await config.dispose();
        await config.getResourceService().dispose();
      }
    });

    it('refreshes flag hook definitions from the session settings projection', async () => {
      const flagHooks = { PreToolUse: [{ matcher: 'Bash', hooks: [] }] };
      const config = new Config({
        ...baseParams,
        onReload: async () => ({ flagHooks }),
      });

      await config.reloadHooks('settings-event');

      expect(config.getFlagHooks()).toEqual(flagHooks);
    });

    it('subscribes to the session Settings manager and releases it with Config', async () => {
      let callbacks:
        | Parameters<
            NonNullable<
              ConfigParameters['sessionSettingsManager']
            >['watchChanges']
          >[0]
        | undefined;
      const unwatch = vi.fn();
      const config = new Config({
        ...baseParams,
        sessionSettingsManager: {
          watchChanges: vi.fn(async (registered) => {
            callbacks = registered;
            return unwatch;
          }),
        },
      });
      const reload = vi
        .spyOn(config as never, 'reloadAfterExternalSettingsChange')
        .mockResolvedValue(undefined);
      try {
        (
          config as unknown as { initializeSettingsWatcher: () => void }
        ).initializeSettingsWatcher();
        await vi.waitFor(() => expect(callbacks).toBeDefined());
        expect(
          await callbacks!.acceptChange('user_settings', '/tmp/settings.json'),
        ).toMatchObject({ accepted: true });
        callbacks!.onChange('userSettings');
        expect(reload).toHaveBeenCalledWith('userSettings');
      } finally {
        await config.dispose();
        await config.getResourceService().dispose();
      }
      expect(unwatch).toHaveBeenCalledOnce();
    });

    it('retries settings watcher startup after a transient failure', async () => {
      vi.useFakeTimers();
      const unwatch = vi.fn();
      const watchChanges = vi
        .fn()
        .mockRejectedValueOnce(new Error('watch unavailable'))
        .mockResolvedValueOnce(unwatch);
      const config = new Config({
        ...baseParams,
        sessionSettingsManager: { watchChanges },
      });
      try {
        (
          config as unknown as { initializeSettingsWatcher: () => void }
        ).initializeSettingsWatcher();
        await vi.waitFor(() => expect(watchChanges).toHaveBeenCalledOnce());
        await vi.advanceTimersByTimeAsync(1000);
        await vi.waitFor(() => expect(watchChanges).toHaveBeenCalledTimes(2));
      } finally {
        await config.dispose();
        await config.getResourceService().dispose();
        vi.useRealTimers();
      }
      expect(unwatch).toHaveBeenCalledOnce();
    });

    it('bounds repeated settings watcher startup retries with backoff', async () => {
      vi.useFakeTimers();
      const watchChanges = vi.fn().mockRejectedValue(new Error('EMFILE'));
      const config = new Config({
        ...baseParams,
        sessionSettingsManager: { watchChanges },
      });
      try {
        (
          config as unknown as { initializeSettingsWatcher: () => void }
        ).initializeSettingsWatcher();
        await vi.waitFor(() => expect(watchChanges).toHaveBeenCalledOnce());

        for (const [index, delay] of [
          1_000, 2_000, 5_000, 10_000, 30_000,
        ].entries()) {
          await vi.advanceTimersByTimeAsync(delay);
          await vi.waitFor(() =>
            expect(watchChanges).toHaveBeenCalledTimes(index + 2),
          );
        }

        await vi.advanceTimersByTimeAsync(60_000);
        expect(watchChanges).toHaveBeenCalledTimes(6);
      } finally {
        await config.dispose();
        await config.getResourceService().dispose();
        vi.useRealTimers();
      }
    });

    it('refreshes caller-owned settings before reloading hooks and skills', async () => {
      const order: string[] = [];
      const config = new Config({
        ...baseParams,
        onExternalSettingsChange: vi.fn(async () => {
          order.push('settings');
        }),
      });
      vi.spyOn(config, 'reloadHooks').mockImplementation(async () => {
        order.push('hooks');
      });
      vi.spyOn(config, 'reloadSkills').mockImplementation(async () => {
        order.push('skills');
      });

      await (
        config as unknown as {
          reloadAfterExternalSettingsChange: (source: string) => Promise<void>;
        }
      ).reloadAfterExternalSettingsChange('userSettings');

      expect(order).toEqual(['settings', 'hooks', 'skills']);
    });

    it('keeps resource sharing unchanged when ConfigChange hooks are added and removed', async () => {
      let enabled = false;
      const config = new Config({
        ...baseParams,
        skillsSupport: true,
        onReload: async () => ({
          hooks: enabled
            ? {
                ConfigChange: [
                  { hooks: [{ type: HookType.Command, command: 'echo hook' }] },
                ],
              }
            : {},
          projectHooks: {},
          localHooks: {},
          userHooks: {},
        }),
      });
      vi.spyOn(config.getSkillManager(), 'discoverSkills').mockResolvedValue(
        undefined,
      );
      await config.initialize();
      const getUserResource = vi.spyOn(
        config.getResourceService(),
        'getUserResource',
      );
      const getProjectResource = vi.spyOn(
        config.getResourceService(),
        'getProjectResource',
      );
      try {
        enabled = true;
        await config.reloadHooks();
        enabled = false;
        await config.reloadHooks();
        expect(getUserResource).not.toHaveBeenCalled();
        expect(getProjectResource).not.toHaveBeenCalled();
      } finally {
        await config.dispose();
        await config.getResourceService().dispose();
      }
    });

    it('coalesces concurrent hook reloads into one follow-up reload', async () => {
      let resolveFirstReload: (() => void) | undefined;
      const firstReloadBlocker = new Promise<void>((resolve) => {
        resolveFirstReload = resolve;
      });
      let reloadCount = 0;
      const onReload = vi.fn(async () => {
        reloadCount += 1;
        if (reloadCount === 1) {
          await firstReloadBlocker;
        }
        return {
          hooks: {},
          projectHooks: {},
          localHooks: {},
          userHooks: {},
        };
      });
      const config = new Config({
        ...baseParams,
        onReload,
      });
      const initializeHooks = vi
        .spyOn(config.getHookSystem()!, 'initialize')
        .mockResolvedValue(undefined);

      const first = config.reloadHooks();
      const second = config.reloadHooks();
      const third = config.reloadHooks();

      expect(onReload).toHaveBeenCalledTimes(1);
      resolveFirstReload?.();
      await Promise.all([first, second, third]);

      expect(onReload).toHaveBeenCalledTimes(2);
      expect(initializeHooks).toHaveBeenCalledTimes(2);
    });
  });

  describe('output style startup', () => {
    it('keeps project output style loading, definitions and reset bound to originalCwd in a worktree', async () => {
      const fixtureRoot = await fsPromises.mkdtemp(
        path.join(os.tmpdir(), 'config-output-style-worktree-'),
      );
      const originalCwd = path.join(fixtureRoot, 'original');
      const worktreeCwd = path.join(fixtureRoot, 'checkout');
      try {
        for (const [directory, label] of [
          [originalCwd, 'original'],
          [worktreeCwd, 'worktree'],
        ]) {
          const styleDir = path.join(directory, CONFIG_DIR, 'output-styles');
          await fsPromises.mkdir(styleDir, { recursive: true });
          await fsPromises.writeFile(
            path.join(styleDir, 'ProjectStyle.md'),
            `${label} style instructions`,
          );
        }
        resourceManagerMockState.reloadOutputStyles.mockImplementation(
          async (options) => {
            if (!options?.projectConfigDirOverride)
              throw new Error('Missing project config directory');
            const { loadOutputStylesFromDir } = await import(
              '@qwen-code/resource'
            );
            resourceManagerMockState.outputStyles =
              await loadOutputStylesFromDir(
                path.join(options.projectConfigDirOverride, 'output-styles'),
                'projectSettings',
              );
          },
        );
        const config = new Config({
          ...baseParams,
          cwd: originalCwd,
          targetDir: originalCwd,
        });
        config.setWorktreeSettings({
          name: 'checkout',
          path: worktreeCwd,
          worktreeCwd,
          originalCwd,
          baseSha: '',
          lifecycle: 'attached',
        });
        config.setTargetDir(worktreeCwd);
        config.setWorkingDir(worktreeCwd);

        await config.initializeOutputStyle('ProjectStyle');
        const available = await config.getAvailableOutputStyles();

        expect(config.getOutputStyle()?.prompt).toBe(
          'original style instructions',
        );
        expect(available['ProjectStyle']?.prompt).toBe(
          'original style instructions',
        );
        const definitions = await config.getAvailableOutputStyleDefinitions();
        expect
          .soft(
            definitions.find((style) => style.name === 'ProjectStyle')?.prompt,
          )
          .toBe('original style instructions');

        await config.resetOutputStyleForNewSession();
        expect(config.getOutputStyle()?.prompt).toBe(
          'original style instructions',
        );
      } finally {
        await fsPromises.rm(fixtureRoot, { recursive: true, force: true });
      }
    });
    const learningStyle = {
      name: 'Learning',
      prompt: 'LEARNING_ONLY',
      keepCodingInstructions: true,
    };

    it('resolves the requested output style without full initialization', async () => {
      const config = new Config(baseParams);

      await config.initializeOutputStyle('Explanatory');

      expect(config.isInitialized()).toBe(false);
      expect(config.getOutputStyle()).toEqual(
        expect.objectContaining({
          name: 'Explanatory',
          keepCodingInstructions: true,
        }),
      );
    });

    it('uses Resource candidates for catalogs and applies refreshed definitions only at session reset', async () => {
      resourceManagerMockState.outputStyles = [
        {
          name: 'Custom',
          description: 'From Resource',
          prompt: 'OLD',
          source: 'projectSettings',
        },
      ];
      const config = new Config(baseParams);
      await config.initializeOutputStyle('Custom');
      expect(config.getOutputStyle()?.prompt).toBe('OLD');
      expect((await config.getAvailableOutputStyles())['Custom']?.prompt).toBe(
        'OLD',
      );
      expect(await config.getAvailableOutputStyleDefinitions()).toContainEqual(
        expect.objectContaining({ name: 'Custom' }),
      );
      expect(resourceManagerMockState.reloadOutputStyles).toHaveBeenCalledTimes(
        1,
      );
      resourceManagerMockState.reloadOutputStyles.mockImplementationOnce(
        async () => {
          resourceManagerMockState.outputStyles[0].prompt = 'NEW';
        },
      );
      expect(config.getOutputStyle()?.prompt).toBe('OLD');
      config.setWorkingDir('/new-worktree');
      await config.resetOutputStyleForNewSession();
      expect(
        resourceManagerMockState.reloadOutputStyles,
      ).toHaveBeenLastCalledWith({
        projectConfigDirOverride: path.join(baseParams.targetDir, CONFIG_DIR),
      });
      expect(resourceManagerMockState.reloadOutputStyles).toHaveBeenCalledTimes(
        2,
      );
      expect(config.getOutputStyle()?.prompt).toBe('NEW');
    });

    it('deduplicates repeated output style initialization', async () => {
      const config = new Config(baseParams);

      const first = config.initializeOutputStyle('Explanatory');
      const concurrent = config.initializeOutputStyle('Learning');

      expect(concurrent).toBe(first);
      await first;

      const repeated = config.initializeOutputStyle('Learning');
      expect(repeated).toBe(first);
      await repeated;
      expect(config.getOutputStyle()?.name).toBe('Explanatory');
    });

    it('keeps the active style and prompt caches unchanged until a conversation reset', async () => {
      const config = new Config({ ...baseParams, outputStyle: learningStyle });
      const clearCache = vi.fn();
      const refreshRuntimeContext = vi.fn();
      config.setPromptAssembler({ clearCache } as never);
      config.registerSessionRuntimeBinding({ refreshRuntimeContext });

      config.setRequestedOutputStyleName('Explanatory');

      expect(config.getOutputStyle()).toEqual(learningStyle);
      expect(clearCache).not.toHaveBeenCalled();
      expect(refreshRuntimeContext).not.toHaveBeenCalled();

      // An unrelated prompt-cache invalidation must keep using the original
      // style; only an explicit conversation reset applies the pending name.
      clearCache();
      expect(config.getOutputStyle()).toEqual(learningStyle);
      clearCache.mockClear();

      await config.resetOutputStyleForNewSession();
      expect(config.getOutputStyle()?.name).toBe('Explanatory');
      // The shared /clear and /new lifecycle invalidates prompt caches after
      // this method resolves the pending style.
      expect(clearCache).not.toHaveBeenCalled();
      expect(refreshRuntimeContext).not.toHaveBeenCalled();
    });

    it('applies only the latest selection, including default, on reset', async () => {
      const config = new Config({ ...baseParams, outputStyle: learningStyle });
      config.setRequestedOutputStyleName('Explanatory');
      config.setRequestedOutputStyleName('default');
      expect(config.getOutputStyle()).toEqual(learningStyle);

      await config.resetOutputStyleForNewSession();
      expect(config.getOutputStyle()).toBeUndefined();
    });

    it('logs and falls back when the pending style is no longer available', async () => {
      const log = vi.spyOn(runLogger, 'log').mockImplementation(() => {});
      try {
        const config = new Config({
          ...baseParams,
          outputStyle: learningStyle,
        });
        config.setRequestedOutputStyleName('removed-style');

        await config.resetOutputStyleForNewSession();

        expect(config.getOutputStyle()).toBeUndefined();
        expect(log).toHaveBeenCalledWith(
          '[output-style] Unknown output style "removed-style"; falling back to default.',
        );
      } finally {
        log.mockRestore();
      }
    });

    it('changes the rendered system prompt only after a conversation reset', async () => {
      const config = new Config({ ...baseParams, outputStyle: learningStyle });
      const assembler = new SystemPromptAssembler({
        sessionId: 'output-style-reset',
      });
      config.setPromptAssembler(assembler);
      const build = async () => {
        const { outputStyle } = createPromptRenderInputs(
          {
            config,
            toolRegistry: {
              getAllToolNames: () => [],
              getTool: () => undefined,
            },
          } as unknown as AgentLoopContext,
          'default',
          'local_tui',
        );
        return (
          await assembler.build({
            source: 'default',
            bundle: 'full',
            surface: 'local_tui',
            enabledSectionGates: [],
            renderInputs: {
              hostCapabilities: [],
              usingTools: { cacheVariant: 'none', compute: () => null },
              outputStyle,
            },
          })
        ).join('\n\n');
      };

      const before = await build();
      expect(before).toContain('# Output Style: Learning');
      config.setRequestedOutputStyleName('Explanatory');
      expect(await build()).toBe(before);
      assembler.clearCache();
      expect(await build()).toBe(before);

      await config.resetOutputStyleForNewSession();
      const after = await build();
      expect(after).toContain('# Output Style: Explanatory');
      expect(after).not.toContain('# Output Style: Learning');

      config.setRequestedOutputStyleName('default');
      expect(await build()).toBe(after);
      await config.resetOutputStyleForNewSession();
      expect(await build()).not.toContain('# Output Style:');
    });

    it('resolves forced output styles from the Config-owned plugin set', async () => {
      const pluginDir = await fsPromises.mkdtemp(
        path.join(os.tmpdir(), 'config-output-style-plugin-'),
      );
      const outputStylesPath = path.join(pluginDir, 'output-styles');
      await fsPromises.mkdir(outputStylesPath);
      await fsPromises.writeFile(
        path.join(outputStylesPath, 'Forced.md'),
        '---\nname: Forced\nforce-for-plugin: true\n---\nforced body',
      );
      const plugin = {
        name: 'force-plugin',
        manifest: {
          name: 'force-plugin',
          version: 'local',
          description: '',
        },
        path: pluginDir,
        source: 'local',
        repository: 'local',
        enabled: true,
        outputStylesPath,
      } as LoadedPlugin;

      try {
        const config = new Config({ ...baseParams, plugins: [plugin] });

        await config.initializeOutputStyle('Learning');

        expect(config.getOutputStyle()?.name).toBe('force-plugin:Forced');
        config.setPlugins([]);
        expect(config.getOutputStyle()?.name).toBe('force-plugin:Forced');
        await config.resetOutputStyleForNewSession();
        expect(config.getOutputStyle()?.name).toBe('Learning');
      } finally {
        await fsPromises.rm(pluginDir, { recursive: true, force: true });
      }
    });
  });

  describe('initialize', () => {
    it('keeps the selected output style when shared user candidates change until explicit session reset', async () => {
      resourceManagerMockState.outputStyles = [
        {
          name: 'UserStyle',
          description: '',
          prompt: 'BEFORE',
          source: 'userSettings',
        },
      ];
      const config = new Config({
        ...baseParams,
        outputStyleName: 'UserStyle',
      });
      try {
        await config.initialize();
        resourceManagerMockState.outputStyles = [
          {
            name: 'UserStyle',
            description: '',
            prompt: 'AFTER',
            source: 'userSettings',
          },
        ];
        expect(
          (await config.getAvailableOutputStyles())['UserStyle']?.prompt,
        ).toBe('AFTER');
        expect(config.getOutputStyle()?.prompt).toBe('BEFORE');
        await config.resetOutputStyleForNewSession();
        expect(config.getOutputStyle()?.prompt).toBe('AFTER');
      } finally {
        await config.dispose();
      }
    });

    it('reuses the initial output style snapshot during full initialization', async () => {
      resourceManagerMockState.outputStyles = [
        {
          name: 'Initial',
          description: 'Initial snapshot',
          prompt: 'INITIAL_SNAPSHOT',
          source: 'projectSettings',
        },
      ];
      const config = new Config({ ...baseParams, outputStyleName: 'Initial' });
      try {
        await config.initialize();
        expect(config.getOutputStyle()?.prompt).toBe('INITIAL_SNAPSHOT');
        expect(
          resourceManagerMockState.reloadOutputStyles,
        ).not.toHaveBeenCalled();
        await config.resetOutputStyleForNewSession();
        expect(
          resourceManagerMockState.reloadOutputStyles,
        ).toHaveBeenCalledOnce();
      } finally {
        await config.dispose();
      }
    });

    it('keeps original-project styles private when the initial resource root differs', async () => {
      const original = await fsPromises.mkdtemp(
        path.join(os.tmpdir(), 'original-styles-'),
      );
      const worktree = path.join(original, 'checkout');
      const stylesDir = path.join(original, CONFIG_DIR, 'output-styles');
      await fsPromises.mkdir(stylesDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(stylesDir, 'Project.md'),
        '---\nname: Project\ndescription: Original\n---\nORIGINAL',
      );
      resourceManagerMockState.outputStyles = [
        {
          name: 'Project',
          description: '',
          prompt: 'WORKTREE',
          source: 'projectSettings',
        },
      ];
      const config = new Config({
        ...baseParams,
        targetDir: worktree,
        outputStyleName: 'Project',
      });
      config.setWorktreeSettings({
        name: 'checkout',
        path: worktree,
        worktreeCwd: worktree,
        originalCwd: original,
        baseSha: '',
        lifecycle: 'attached',
      });
      try {
        await config.initialize();
        expect(config.getOutputStyle()?.prompt).toBe('ORIGINAL');
        expect(
          resourceManagerMockState.reloadOutputStyles,
        ).not.toHaveBeenCalled();
        expect(resourceManagerMockState.outputStyles[0].prompt).toBe(
          'WORKTREE',
        );
      } finally {
        await config.dispose();
        await fsPromises.rm(original, { recursive: true, force: true });
      }
    });

    it('resolves the requested output style after workspace resources are ready', async () => {
      const config = new Config({
        ...baseParams,
        includeDirectories: ['/additional-project'],
        outputStyleName: 'Explanatory',
      });
      resourceManagerMockState.reloadOutputStyles.mockImplementation(
        async () => {
          expect(config.getWorkspaceContext().getDirectories()).toContain(
            '/additional-project',
          );
          expect(
            resourceManagerMockState.updateWorkspaceContext,
          ).toHaveBeenCalled();
        },
      );

      try {
        expect(config.getOutputStyle()).toBeUndefined();
        await config.initialize();
        expect(config.getOutputStyle()?.name).toBe('Explanatory');
      } finally {
        await config.dispose();
      }
    });

    it('preserves an embedder-provided output style during initialization', async () => {
      const outputStyle = { name: 'Embedder', prompt: 'Custom instructions' };
      const config = new Config({
        ...baseParams,
        outputStyle,
        outputStyleName: 'Explanatory',
      });

      try {
        await config.initialize();
        expect(config.getOutputStyle()).toEqual(outputStyle);
        expect(
          resourceManagerMockState.reloadOutputStyles,
        ).not.toHaveBeenCalled();
      } finally {
        await config.dispose();
      }
    });

    it('skips builtin initialization, hook rebuilding and cleanup with an empty list', async () => {
      const builtin = await import('../test-utils/builtinPluginLifecycle.js');
      const tools = await import('../builtin-plugins/tool.js');
      builtin.registerBuiltinPlugins([]);
      const initialize = vi.spyOn(builtin, 'initializeBuiltinPlugins');
      const dispose = vi.spyOn(builtin, 'disposeBuiltinPlugins');
      const syncTools = vi.spyOn(tools, 'syncBuiltinPluginTools');
      const config = new Config(baseParams);
      config.enableBuiltinPluginsForTui();
      const hooks = vi.spyOn(config.getHookSystem()!, 'initialize');
      try {
        await config.initialize();
        expect(initialize).not.toHaveBeenCalled();
        expect(hooks).not.toHaveBeenCalled();
        expect(syncTools).not.toHaveBeenCalled();
        expect(config.getToolRegistry().registerTool).toHaveBeenCalled();
        await config.dispose();
        expect(dispose).not.toHaveBeenCalled();
      } finally {
        initialize.mockRestore();
        dispose.mockRestore();
        syncTools.mockRestore();
        hooks.mockRestore();
        await builtin.disposeBuiltinPlugins();
      }
    });

    it.each(['interactive', 'headless'] as const)(
      'initializes opted-in builtin plugins in %s mode, refreshes and disposes them',
      async (mode) => {
        const { registerBuiltinPlugins, disposeBuiltinPlugins } = await import(
          '../test-utils/builtinPluginLifecycle.js'
        );
        let host!: import('../builtin-plugins/types.js').BuiltinPluginContext;
        const initialize = vi.fn(async (context: typeof host) => {
          host = context;
        });
        const dispose = vi.fn(async () => {});
        let tools: AnyDeclarativeTool[] = [
          new MockTool({ name: 'ExampleConfigTool', description: 'Example' }),
        ];
        registerBuiltinPlugins([
          {
            apiVersion: 1,
            id: 'example-config',
            initialize,
            dispose,
            getSkillDefinitions: () => [],
            getHooks: () => [],
            getTools: () => tools,
          },
        ]);
        const getSetting = vi.fn((section: string) =>
          section === 'example' ? { enabled: true } : undefined,
        );
        const getLaunchSetting = vi.fn((section: string) =>
          section === 'launch-example' ? { enabled: true } : undefined,
        );
        const dependencies = await prepareBuiltinPlugins(mode, {
          getLaunchSetting,
          isSettingSourceAllowed: (source) => source === 'project',
          runtime: {
            prepare: async () => {},
            getSetting: async (workspace, section) =>
              workspace === baseParams.targetDir
                ? getSetting(section)
                : undefined,
          },
        });
        const config = new Config({
          ...baseParams,
          ...dependencies,
          settingSources: ['project'],
          getSetting,
          getLaunchSetting,
        });
        if (mode === 'interactive') config.enableBuiltinPluginsForTui();
        else config.enableBuiltinPluginsForHeadless();
        try {
          await config.initialize();
          dependencies.builtinPlugins.markHostReady();
          await host.whenReady();
          expect(initialize).toHaveBeenCalledOnce();
          expect(host.mode).toBe(mode);
          expect(host.isSettingSourceAllowed('user')).toBe(false);
          expect(host.isSettingSourceAllowed('project')).toBe(true);
          await expect(
            host.runtime!.getSetting(config.getTargetDir(), 'example'),
          ).resolves.toEqual({ enabled: true });
          await expect(
            host.runtime!.getSetting('/another-workspace', 'example'),
          ).resolves.toBeUndefined();
          expect(
            getSetting.mock.calls.filter(([section]) => section === 'example'),
          ).toEqual([['example']]);
          expect(host.getLaunchSetting('launch-example')).toEqual({
            enabled: true,
          });
          expect(getLaunchSetting).toHaveBeenCalledOnce();
          const registry = config.getToolRegistry();
          expect(registry.registerTool).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'ExampleConfigTool' }),
          );
          const reload = vi.spyOn(config, 'reloadSkills').mockResolvedValue();
          const hooks = vi
            .spyOn(config.getHookSystem()!, 'initialize')
            .mockResolvedValue();
          tools = [];
          await host.notifyChanged();
          expect(registry.unregisterTool).toHaveBeenCalledWith(
            'ExampleConfigTool',
          );
          expect(reload).toHaveBeenCalledOnce();
          expect(hooks).toHaveBeenCalledOnce();
          await config.dispose();
          expect(dispose).not.toHaveBeenCalled();
        } finally {
          await disposeBuiltinPlugins();
          registerBuiltinPlugins([]);
        }
      },
    );

    it('does not initialize builtin plugins without an explicit opt-in', async () => {
      const { registerBuiltinPlugins } = await import(
        '../test-utils/builtinPluginLifecycle.js'
      );
      const initialize = vi.fn(async () => {});
      registerBuiltinPlugins([
        {
          apiVersion: 1,
          id: 'headless-example',
          initialize,
          dispose: async () => {},
          getSkillDefinitions: () => [],
          getHooks: () => [],
        },
      ]);
      try {
        await new Config(baseParams).initialize();
        expect(initialize).not.toHaveBeenCalled();
      } finally {
        registerBuiltinPlugins([]);
      }
    });

    it('initializes builtin plugins with explicit headless mode', async () => {
      const { registerBuiltinPlugins, disposeBuiltinPlugins } = await import(
        '../test-utils/builtinPluginLifecycle.js'
      );
      const initialize = vi.fn(
        async (
          context: import('../builtin-plugins/types.js').BuiltinPluginContext,
        ) => {
          expect(context.mode).toBe('headless');
        },
      );
      registerBuiltinPlugins([
        {
          apiVersion: 1,
          id: 'headless-example',
          initialize,
          dispose: async () => {},
          getSkillDefinitions: () => [],
          getHooks: () => [],
        },
      ]);
      const config = new Config({
        ...baseParams,
        ...(await prepareBuiltinPlugins()),
      });
      config.enableBuiltinPluginsForHeadless();
      try {
        await config.initialize();
        expect(initialize).toHaveBeenCalledOnce();
      } finally {
        await config.dispose();
        await disposeBuiltinPlugins();
        registerBuiltinPlugins([]);
      }
    });

    it('creates HookSystem for builtin runtime hooks when user hooks are disabled', async () => {
      const { registerBuiltinPlugins, disposeBuiltinPlugins } = await import(
        '../test-utils/builtinPluginLifecycle.js'
      );
      registerBuiltinPlugins([
        {
          apiVersion: 1,
          id: 'internal-runtime-example',
          initialize: async () => {},
          dispose: async () => {},
          getSkillDefinitions: () => [],
          getHooks: () => [
            {
              event: 'QueryEnd',
              type: 'runtime' as const,
              name: 'internal-runtime-example',
              action: async () => {},
            },
          ],
        },
      ]);
      const config = new Config({
        ...baseParams,
        ...(await prepareBuiltinPlugins()),
        enableHooks: false,
      });
      // 注入应用 Registry 已明确启用内置能力，即使用户 hooks 关闭仍需运行时 Hook。
      config.enableBuiltinPluginsForHeadless();
      expect(config.getHookSystem()).toBeDefined();
      try {
        await config.initialize();
        expect(
          config
            .getHookSystem()!
            .getAllHooks()
            .some((entry) => entry.config.type === 'runtime'),
        ).toBe(true);
      } finally {
        await config.dispose();
        await disposeBuiltinPlugins();
        registerBuiltinPlugins([]);
      }
    });

    it('keeps process-owned builtin plugins active when one Config is disposed', async () => {
      const { registerBuiltinPlugins, disposeBuiltinPlugins } = await import(
        '../test-utils/builtinPluginLifecycle.js'
      );
      const dispose = vi.fn(async () => {});
      registerBuiltinPlugins([
        {
          apiVersion: 1,
          id: 'shared-runtime-example',
          initialize: async () => {},
          dispose,
          getSkillDefinitions: () => [],
          getHooks: () => [
            {
              event: 'QueryEnd',
              type: 'runtime' as const,
              name: 'shared-runtime-example',
              action: async () => {},
            },
          ],
        },
      ]);
      const shared = await prepareBuiltinPlugins();
      const first = new Config({ ...baseParams, ...shared });
      const second = new Config({
        ...baseParams,
        ...shared,
        sessionId: 'second-session',
      });
      first.enableBuiltinPluginsForHeadless();
      second.enableBuiltinPluginsForHeadless();
      try {
        await first.initialize();
        await second.initialize();
        await first.dispose();
        expect(dispose).not.toHaveBeenCalled();
        expect(
          second
            .getHookSystem()!
            .getAllHooks()
            .some(
              (entry) =>
                entry.config.type === 'runtime' &&
                entry.config.name === 'shared-runtime-example',
            ),
        ).toBe(true);
      } finally {
        await second.dispose();
        await disposeBuiltinPlugins();
        registerBuiltinPlugins([]);
      }
    });

    it('fans changes out to both live Configs and unsubscribes only the closed session', async () => {
      const { BuiltinPluginRegistry } = await import(
        '../builtin-plugins/registry.js'
      );
      let context!: BuiltinPluginContext;
      const dispose = vi.fn(async () => {});
      const registry = new BuiltinPluginRegistry(
        [
          {
            apiVersion: 1,
            id: 'shared-changes',
            initialize: async (value) => {
              context = value;
            },
            dispose,
          },
        ],
        {
          mode: 'headless',
          getLaunchSetting: () => undefined,
          isSettingSourceAllowed: () => true,
        },
      );
      const initializing = registry.initialize();
      const shared = {
        builtinPlugins: registry,
        builtinPluginsInitialization: initializing,
      };
      const first = new Config({
        ...baseParams,
        ...shared,
        sessionId: 'changes-a',
      });
      const second = new Config({
        ...baseParams,
        ...shared,
        sessionId: 'changes-b',
      });
      try {
        await Promise.all([first.initialize(), second.initialize()]);
        const refreshA = vi.spyOn(first, 'reloadSkills').mockResolvedValue();
        const refreshB = vi.spyOn(second, 'reloadSkills').mockResolvedValue();
        await context.notifyChanged();
        expect(refreshA).toHaveBeenCalledOnce();
        expect(refreshB).toHaveBeenCalledOnce();
        await first.dispose();
        await context.notifyChanged();
        expect(refreshA).toHaveBeenCalledOnce();
        expect(refreshB).toHaveBeenCalledTimes(2);
        expect(registry.isReady()).toBe(true);
        expect(dispose).not.toHaveBeenCalled();
      } finally {
        await first.dispose();
        await second.dispose();
        await registry.dispose();
      }
      expect(dispose).toHaveBeenCalledOnce();
    });

    it('uses ResourceService resources and releases only its resource handle', async () => {
      const resourceService = new ResourceService();
      const service = resourceService;
      const user = new UserResource({});
      const project = new ProjectResource({ cwd: baseParams.targetDir });
      const release = vi.fn(async () => {});
      const projectDispose = vi.spyOn(project, 'dispose');
      const getUserResource = vi
        .spyOn(service, 'getUserResource')
        .mockReturnValue(user);
      const getProjectResource = vi
        .spyOn(service, 'getProjectResource')
        .mockReturnValue({
          project,
          ready: Promise.resolve(),
          watcherReady: Promise.resolve(),
          release,
          isForContext: () => true,
        });
      const config = new Config({ ...baseParams, resourceService });
      try {
        await config.initialize();
        expect(config.getResourceService()).toBe(resourceService);
        expect(getUserResource).toHaveBeenCalled();
        expect(getProjectResource).toHaveBeenCalledWith(
          expect.objectContaining({
            cwd: config.getTargetDir(),
          }),
        );
        await config.dispose();
        expect(release).toHaveBeenCalledOnce();
        expect(user.dispose).not.toHaveBeenCalled();
        expect(projectDispose).not.toHaveBeenCalled();
      } finally {
        await user.dispose();
        await service.dispose();
      }
    });

    describe('global permissions', () => {
      function fixture(
        initial: PermissionPolicySnapshot | undefined,
        ensureReady?: ConfigService['ensureReady'],
      ) {
        let policy = initial;
        const source: ConfigService = {
          start: async () => {}, stop: async () => {},
          getValue: <T>() => policy as T,
          onValueChange: () => () => {}, onError: () => () => {},
          ensureReady,
        };
        const create = (params: Partial<ConfigParameters> = {}) => {
          const config = new Config({
            ...baseParams,
            loadedSettings: createEmptyLoadedSettings(),
            trustedFolder: true,
            ...params,
          });
          setTestSessionPermission(
            config,
            createPermissionManager({
              cwd: config.getTargetDir(),
              permissionMode: params.permissionMode,
              organizationPolicy: source,
              checkerDeps: createCheckerDepsForConfig(config),
            }),
          );
          return config;
        };
        return { create, publish(next: PermissionPolicySnapshot | undefined) { policy = next; } };
      }

      it('reads global constraints through permissions without attaching settings sources', async () => {
        const { create } = fixture({ disabledModes: ['auto'] });
        const loadedSettings = createEmptyLoadedSettings();
        const attach = vi.spyOn(loadedSettings, 'attachSettingsService');
        const config = create({ loadedSettings });
        try {
          expect(attach).not.toHaveBeenCalled();
          expect(config.getPermissionModeRestriction('auto')).toBeDefined();
        } finally {
          await config.dispose();
        }
      });

      it('keeps an unconfigured global source unrestricted', async () => {
        const config = new Config({
          ...baseParams,
          loadedSettings: createEmptyLoadedSettings(),
        });
        try {
          await config.initialize();
          expect(
            config.getPermissionModeRestriction('yolo'),
          ).toBeUndefined();
        } finally {
          await config.dispose();
        }
      });

      it.each([false, true])(
        'shares the permission source across active, new and closed sessions (interactive=%s)',
        async (interactive) => {
          const { create, publish } = fixture({
            disabledModes: [],
          });
          const first = create({ interactive });
          const second = create({ interactive });
          let added: Config | undefined;
          try {
            await Promise.all([first.initialize(), second.initialize()]);
            publish({ disabledModes: ['auto'] });
            expect(first.getPermissionModeRestriction('auto')).toContain(
              'disabled',
            );
            expect(second.getPermissionModeRestriction('auto')).toContain(
              'disabled',
            );
            await first.dispose();
            publish({ disabledModes: ['yolo'] });
            added = create();
            await added.initialize();
            expect(second.getPermissionModeRestriction('yolo')).toContain(
              'disabled',
            );
          } finally {
            await first.dispose();
            await second.dispose();
            await added?.dispose();
          }
        },
      );

      it.each(['auto', 'yolo'] as const)(
        'allows selecting restricted %s without clearing the restriction',
        async (mode) => {
          const message = `企业管理员已禁用${mode}模式，如需开启，请联系您所在企业的管理员`;
          const { create, publish } = fixture({
            disabledModes: [mode], disabledModeMessages: { [mode]: message },
          });
          const config = create();
          try {
            await config.initialize();
            expect(() => config.setPermissionMode(mode)).not.toThrow();
            expect(config.getPermissionMode()).toBe(mode);
            expect(config.getPermissionModeRestriction(mode)).toBe(message);
            publish({ disabledModes: [] });
            expect(config.getPermissionModeRestriction(mode)).toBeUndefined();
            expect(config.getPermissionMode()).toBe(mode);
          } finally { await config.dispose(); }
        },
      );

      it.each(['auto', 'yolo'] as const)(
        'rejects initializing disabled %s in interactive and headless configurations',
        async (mode) => {
          for (const interactive of [true, false]) {
            const { create } = fixture({ disabledModes: [mode] });
            const config = create({ permissionMode: mode, interactive });
            try {
              await expect(config.initialize()).rejects.toThrow(
                'disabled by global policy',
              );
            } finally {
              await config.dispose();
            }
          }
        },
      );

      it('keeps missing global policies unrestricted and applies later explicit restrictions', async () => {
        const { create, publish } = fixture(undefined);
        const config = create();
        try {
          await config.initialize();
          expect(
            config.getPermissionModeRestriction('default'),
          ).toBeUndefined();
          expect(config.getPermissionModeRestriction('auto')).toBeUndefined();
          expect(config.getPermissionModeRestriction('yolo')).toBeUndefined();
          publish({ disabledModes: [] });
          expect(
            config.getPermissionModeRestriction('yolo'),
          ).toBeUndefined();
          publish({ disabledModes: ['yolo'] });
          expect(config.getPermissionModeRestriction('yolo')).toContain(
            'disabled',
          );
        } finally {
          await config.dispose();
        }
      });

      it.each(['auto', 'yolo'] as const)(
        'starts in %s when policy loading succeeds without a configuration',
        async (mode) => {
          const { create } = fixture(undefined, async () => ({
            status: 'ready', source: 'remote', revision: 'empty',
          }));
          const config = create({ permissionMode: mode });
          try {
            await config.initialize();
            expect(config.getPermissionMode()).toBe(mode);
            expect(config.getPermissionModeRestriction(mode)).toBeUndefined();
          } finally {
            await config.dispose();
          }
        },
      );

      it('waits for host preparation before checking the requested mode', async () => {
        let finish!: () => void;
        const loading = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const { create, publish } = fixture(undefined, async () => {
          await loading;
          return { status: 'ready', source: 'remote', revision: '1' };
        });
        const config = create({ permissionMode: 'yolo' });
        const initialized = config.initialize();
        try {
          publish({ disabledModes: [] });
          finish();
          await initialized;
          expect(config.getPermissionMode()).toBe('yolo');
        } finally {
          finish();
          await config.dispose();
        }
      });

      it('allows skipped startup identity preparation without inventing a mode restriction', async () => {
        const { create } = fixture(undefined, async () => ({
          status: 'skipped',
          reason: 'no-identity',
        }));
        const config = create({ permissionMode: 'yolo', interactive: true });
        try {
          await config.initializeForInteractiveStartup();
          expect(config.getPermissionModeRestriction('yolo')).toBeUndefined();
        } finally {
          await config.dispose();
        }
      });

      it('does not initialize after closure while shared readiness is pending', async () => {
        let finish!: () => void;
        const pending = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const { create } = fixture(undefined, async () => {
          await pending;
          return { status: 'ready', source: 'remote', revision: '1' };
        });
        const config = create();
        const initialized = config.initialize();
        try {
          await config.dispose();
          finish();
          await expect(initialized).rejects.toThrow(
            'disposed while loading global permissions',
          );
        } finally {
          finish();
          await config.dispose();
        }
      });
    });

    it('leaves ResourceService disposal to the caller', async () => {
      const owned = new Config(baseParams);
      const ownedDispose = vi.spyOn(owned.getResourceService(), 'dispose');
      await owned.dispose();
      expect(ownedDispose).not.toHaveBeenCalled();
      await owned.getResourceService().dispose();
      const resourceService = new ResourceService();
      const externalDispose = vi.spyOn(resourceService, 'dispose');
      const borrowed = new Config({ ...baseParams, resourceService });
      await borrowed.dispose();
      expect(externalDispose).not.toHaveBeenCalled();
      await resourceService.dispose();
    });

    it('logs initialization stages and resource snapshot duration', async () => {
      const logSpy = vi.spyOn(runLogger, 'log');
      const config = new Config(baseParams);

      await config.initialize();
      expect(logSpy).toHaveBeenCalledWith('[Config] Initializing storage');
      expect(logSpy).toHaveBeenCalledWith('[Config] Initializing resources');
      expect(logSpy).toHaveBeenCalledWith(
        '[Config] Initializing agent registry',
      );
      expect(logSpy).toHaveBeenCalledWith(
        '[Config] Initializing tool registry',
      );
      expect(logSpy).toHaveBeenCalledWith('[Config] Initializing agent team');
      expect(logSpy).toHaveBeenCalledWith(
        '[Config] Initial resource snapshot completed',
        expect.objectContaining({
          sessionId: SESSION_ID,
          pid: process.pid,
          durationMs: expect.any(Number),
        }),
      );
      expect(logSpy).toHaveBeenCalledWith(
        '[Config] Base initialization completed',
        expect.objectContaining({
          sessionId: SESSION_ID,
          pid: process.pid,
          durationMs: expect.any(Number),
        }),
      );
      logSpy.mockRestore();
    });

    it('closes resource acquisition diagnostics when the resource service throws', async () => {
      const resourceService = new ResourceService();
      const error = new Error('resource unavailable');
      vi.spyOn(resourceService, 'getProjectResource').mockImplementation(() => {
        throw error;
      });
      const log = vi.spyOn(runLogger, 'log').mockImplementation(() => {});
      const config = new Config({ ...baseParams, resourceService });
      try {
        await expect(config.prepareResourceView()).rejects.toBe(error);
        expect(log).toHaveBeenCalledWith(
          '[startup-trace] step=resources.acquire_view state=finished',
          expect.objectContaining({ status: 'rejected' }),
        );
      } finally {
        await config.dispose();
      }
    });

    it('observes snapshot waits without waiting for background watchers', async () => {
      const log = vi.spyOn(runLogger, 'log').mockImplementation(() => {});
      let resolveWatcher!: () => void;
      resourceManagerMockState.watcherReady = new Promise<void>((resolve) => {
        resolveWatcher = resolve;
      });
      const config = new Config(baseParams);
      try {
        await config.prepareResourceView();
        const events = () =>
          log.mock.calls
            .filter(([message]) => message === '[startup.diagnostic]')
            .map(([, event]) => event);
        expect(events()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: 'resources.snapshot.project_wait',
              event: 'finished',
              status: 'resolved',
            }),
            expect.objectContaining({
              name: 'resources.background.project_watcher_wait',
              event: 'started',
            }),
          ]),
        );
        expect(events()).not.toContainEqual(
          expect.objectContaining({
            name: 'resources.background.project_watcher_wait',
            event: 'finished',
          }),
        );
        const views = (
          config as unknown as {
            resourceViews: { watcherReady: Promise<void> };
          }
        ).resourceViews;
        const repeatedWait = views.watcherReady;
        await Promise.resolve();
        await Promise.resolve();
        expect(
          events().filter(
            (event) =>
              (event as { name: string; event: string }).name ===
                'resources.background.project_watcher_wait' &&
              (event as { event: string }).event === 'started',
          ),
        ).toHaveLength(1);
        resolveWatcher();
        await repeatedWait;
        await views.watcherReady;
        expect(
          events().filter(
            (event) =>
              (event as { name: string; event: string }).name ===
                'resources.background.project_watcher_wait' &&
              (event as { event: string }).event === 'started',
          ),
        ).toHaveLength(1);
        await vi.waitFor(() =>
          expect(events()).toContainEqual(
            expect.objectContaining({
              name: 'resources.background.project_watcher_wait',
              event: 'finished',
              status: 'resolved',
            }),
          ),
        );
      } finally {
        resolveWatcher();
        await config.dispose();
      }
    });

    it('logs background Resource watcher startup degradation', async () => {
      const warnSpy = vi.spyOn(runLogger, 'warn');
      let rejectWatcherReady!: (error: unknown) => void;
      resourceManagerMockState.watcherReady = new Promise<void>(
        (_resolve, reject) => {
          rejectWatcherReady = reject;
        },
      );
      const config = new Config(baseParams);
      const startupError = Object.assign(new Error('watcher timed out'), {
        code: 'ETIMEDOUT',
      });

      try {
        await config.initialize();
        rejectWatcherReady(startupError);

        await vi.waitFor(() =>
          expect(warnSpy).toHaveBeenCalledWith(
            '[Config] Resource watcher startup degraded; continuing with initial snapshots',
            expect.objectContaining({
              sessionId: SESSION_ID,
              pid: process.pid,
              code: 'ETIMEDOUT',
              error: 'watcher timed out',
            }),
          ),
        );
      } finally {
        await config.dispose();
        warnSpy.mockRestore();
      }
    });

    it('propagates the .agents compatibility switch to initial and reload discovery', async () => {
      const config = new Config({
        ...baseParams,
        skillsSupport: true,
        loadSkillsFromAgentsDirectory: true,
      });
      const discover = vi
        .spyOn(config.getSkillManager(), 'discoverSkills')
        .mockResolvedValue(undefined);

      await config.initialize();

      expect(discover).toHaveBeenCalledWith(
        expect.objectContaining({
          plugins: expect.any(Array),
          resourceSkills: expect.any(Array),
          resourceSkillLoadErrors: expect.any(Array),
          config,
        }),
      );

      discover.mockClear();
      await config.reloadSkills();

      expect(discover).toHaveBeenCalledWith(
        expect.objectContaining({
          plugins: expect.any(Array),
          emitToFeed: false,
          resourceSkills: expect.any(Array),
          resourceSkillLoadErrors: expect.any(Array),
          config,
        }),
      );
    });

    it('preserves shadowed resource skill candidates for the Skill browser', async () => {
      const projectSkill: SkillDefinition = {
        name: 'shared-skill',
        description: 'project version',
        location: '/repo/.qwen/skills/shared-skill/SKILL.md',
        skillRoot: '/repo/.qwen/skills/shared-skill',
        body: 'project body',
        source: 'project',
      };
      const userSkill: SkillDefinition = {
        ...projectSkill,
        description: 'user version',
        location: '/home/user/.qwen/skills/shared-skill/SKILL.md',
        skillRoot: '/home/user/.qwen/skills/shared-skill',
        body: 'user body',
        source: 'user',
      };
      resourceManagerMockState.projectSkills = [projectSkill];
      resourceManagerMockState.userSkills = [userSkill];

      const config = new Config({
        ...baseParams,
        skillsSupport: true,
      });
      const discover = vi
        .spyOn(config.getSkillManager(), 'discoverSkills')
        .mockResolvedValue(undefined);

      await config.initialize();

      expect(discover).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceSkills: [projectSkill, userSkill],
        }),
      );
    });

    it('excludes user Skill load errors when only project sources are allowed', async () => {
      const projectError = {
        filePath: '/repo/.qwen/skills/broken/SKILL.md',
        message: 'Project Skill failed to load',
        configType: 'skill' as const,
      };
      const userError = {
        filePath: '/home/user/.qwen/skills/broken/SKILL.md',
        message: 'User Skill failed to load',
        configType: 'skill' as const,
      };
      resourceManagerMockState.projectSkillErrors = [projectError];
      resourceManagerMockState.userSkillErrors = [userError];
      const config = new Config({
        ...baseParams,
        skillsSupport: true,
        allowedAgentSources: ['project'],
      });
      const discover = vi
        .spyOn(config.getSkillManager(), 'discoverSkills')
        .mockResolvedValue(undefined);

      try {
        await config.initialize();
        expect(discover).toHaveBeenLastCalledWith(
          expect.objectContaining({ resourceSkillLoadErrors: [projectError] }),
        );

        await config.reloadSkills();
        expect(discover).toHaveBeenLastCalledWith(
          expect.objectContaining({ resourceSkillLoadErrors: [projectError] }),
        );
      } finally {
        await config.dispose();
      }
    });

    it('acquires the updated context before reloading Skill resources', async () => {
      const config = new Config({ ...baseParams, skillsSupport: true });
      vi.spyOn(config.getSkillManager(), 'discoverSkills').mockResolvedValue(
        undefined,
      );
      await config.initialize();
      const getProjectResource = vi.spyOn(
        config.getResourceService(),
        'getProjectResource',
      );
      resourceManagerMockState.reloadSkills.mockClear();
      const additionalDirectory = path.resolve('/runtime-extra');
      config.getWorkspaceContext().addDirectory(additionalDirectory);
      await config.reloadSkills();
      expect(getProjectResource).toHaveBeenCalledWith(
        expect.objectContaining({
          isTrusted: true,
          additionalDirectories: [additionalDirectory],
        }),
      );
      expect(resourceManagerMockState.reloadSkills).toHaveBeenCalledOnce();
      expect(getProjectResource.mock.invocationCallOrder[0]).toBeLessThan(
        resourceManagerMockState.reloadSkills.mock.invocationCallOrder[0],
      );
      await config.dispose();
    });

    it('keeps the current Skill subscription when acquiring a new context fails', async () => {
      const config = new Config({ ...baseParams, skillsSupport: true });
      vi.spyOn(config.getSkillManager(), 'discoverSkills').mockResolvedValue(
        undefined,
      );
      await config.initialize();
      const listeners = [...resourceManagerMockState.listeners];
      const getProjectResource = vi
        .spyOn(config.getResourceService(), 'getProjectResource')
        .mockImplementationOnce(() => {
          throw new Error('acquire failed');
        });
      config
        .getWorkspaceContext()
        .addDirectory(path.resolve('/failed-context'));
      await expect(config.reloadSkills()).rejects.toThrow('acquire failed');
      expect([...resourceManagerMockState.listeners]).toEqual(listeners);
      getProjectResource.mockRestore();
      await config.dispose();
    });

    it('applies an explicit Skill reload once through the resource notification', async () => {
      const config = new Config({ ...baseParams, skillsSupport: true });
      const discover = vi
        .spyOn(config.getSkillManager(), 'discoverSkills')
        .mockResolvedValue(undefined);
      await config.initialize();
      discover.mockClear();
      const changed = vi.fn();
      config.onSkillChange(changed, { replay: false });
      try {
        await config.reloadSkills();
        expect(discover).toHaveBeenCalledOnce();
        expect(changed).toHaveBeenCalledOnce();
      } finally {
        await config.dispose();
      }
    });

    it('applies resource skill changes before broadcasting runtime Skill changes', async () => {
      const config = new Config({
        ...baseParams,
        skillsSupport: true,
      });
      const discover = vi
        .spyOn(config.getSkillManager(), 'discoverSkills')
        .mockResolvedValue(undefined);
      await config.initialize();
      discover.mockClear();

      const runtimeListener = vi.fn();
      config.onSkillChange(runtimeListener, { replay: false });
      publishMockSkillResourceChange('changed-skill');

      await vi.waitFor(() => expect(discover).toHaveBeenCalledOnce());
      expect(discover.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          resourceSkills: [expect.objectContaining({ name: 'changed-skill' })],
        }),
      );
      await vi.waitFor(() => expect(runtimeListener).toHaveBeenCalledOnce());
    });

    it('runs a ConfigChange hook registered after initialization before adopting Skill changes', async () => {
      const config = new Config({ ...baseParams, skillsSupport: true });
      const discover = vi
        .spyOn(config.getSkillManager(), 'discoverSkills')
        .mockResolvedValue(undefined);
      await config.initialize();
      await publishMockSkillResourceChange('accepted');
      discover.mockClear();
      const action = vi.fn(async () => ({
        decision: 'deny' as const,
        reason: 'keep old skills',
      }));
      const fire = vi.spyOn(config.getHookSystem()!, 'fireConfigChangeEvent');
      config
        .getHookSystem()!
        .registerHook(
          { type: HookType.Runtime, name: 'block-skill-change', action },
          HookEventName.ConfigChange,
        );
      try {
        await publishMockSkillResourceChange('rejected', [
          {
            kind: 'skill',
            path: '/repo/.qwen/skills/rejected/SKILL.md',
            operation: 'change',
          },
        ]);
        expect(await fire.mock.results[0].value).toMatchObject({ errors: [] });
        expect(action).toHaveBeenCalledOnce();
        expect(discover).not.toHaveBeenCalled();
        // A settings-only rebuild must not adopt the rejected resource snapshot.
        await (
          config as unknown as {
            reloadSkillsFromResourceSnapshot(): Promise<void>;
          }
        ).reloadSkillsFromResourceSnapshot();
        expect(discover).toHaveBeenLastCalledWith(
          expect.objectContaining({
            resourceSkills: [expect.objectContaining({ name: 'accepted' })],
          }),
        );
        // Explicit reload preserves its original behavior and bypasses the file-change hook.
        await config.reloadSkills();
        expect(action).toHaveBeenCalledOnce();
        expect(discover).toHaveBeenLastCalledWith(
          expect.objectContaining({
            resourceSkills: [expect.objectContaining({ name: 'rejected' })],
          }),
        );
        config.getHookSystem()!.removeEntry('block-skill-change');
        await publishMockSkillResourceChange('after-removal', [
          {
            kind: 'skill',
            path: '/repo/.qwen/skills/after-removal/SKILL.md',
            operation: 'change',
          },
        ]);
        expect(action).toHaveBeenCalledOnce();
        expect(discover).toHaveBeenLastCalledWith(
          expect.objectContaining({
            resourceSkills: [
              expect.objectContaining({ name: 'after-removal' }),
            ],
          }),
        );
      } finally {
        await config.dispose();
      }
    });

    it('lets each session independently accept the same candidate Skill snapshot', async () => {
      const resourceService = new ResourceService();
      const getProjectResource = vi.spyOn(
        resourceService,
        'getProjectResource',
      );
      const first = new Config({
        ...baseParams,
        resourceService,
        sessionId: 'first',
        skillsSupport: true,
      });
      const second = new Config({
        ...baseParams,
        resourceService,
        sessionId: 'second',
        skillsSupport: true,
      });
      const firstDiscover = vi
        .spyOn(first.getSkillManager(), 'discoverSkills')
        .mockResolvedValue(undefined);
      const secondDiscover = vi
        .spyOn(second.getSkillManager(), 'discoverSkills')
        .mockResolvedValue(undefined);
      await first.initialize();
      await second.initialize();
      expect(getProjectResource.mock.results[0].value.project).toBe(
        getProjectResource.mock.results[1].value.project,
      );
      await publishMockSkillResourceChange('old');
      firstDiscover.mockClear();
      secondDiscover.mockClear();
      const deny = vi.fn(async () => ({ decision: 'deny' as const }));
      second
        .getHookSystem()!
        .registerHook(
          { type: HookType.Runtime, name: 'deny-change', action: deny },
          HookEventName.ConfigChange,
        );
      try {
        await publishMockSkillResourceChange('new', [
          {
            kind: 'skill',
            path: '/repo/.qwen/skills/new/SKILL.md',
            operation: 'change',
          },
        ]);
        expect(firstDiscover).toHaveBeenLastCalledWith(
          expect.objectContaining({
            resourceSkills: [expect.objectContaining({ name: 'new' })],
          }),
        );
        expect(deny).toHaveBeenCalledOnce();
        expect(secondDiscover).not.toHaveBeenCalled();
      } finally {
        await first.dispose();
        await second.dispose();
        await resourceService.dispose();
      }
    });

    it('allows Skill changes when ConfigChange fails and rejects failed explicit reloads', async () => {
      const config = new Config({ ...baseParams, skillsSupport: true });
      await config.initialize();
      const fire = vi
        .spyOn(config.getHookSystem()!, 'fireConfigChangeEvent')
        .mockRejectedValue(new Error('hook failed'));
      const discover = vi
        .spyOn(config.getSkillManager(), 'discoverSkills')
        .mockResolvedValue(undefined);
      const log = vi.spyOn(runLogger, 'error');
      try {
        await publishMockSkillResourceChange('allowed', [
          {
            kind: 'skill',
            path: '/repo/.qwen/skills/allowed/SKILL.md',
            operation: 'change',
          },
        ]);
        expect(discover).toHaveBeenCalledOnce();
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining('hook failed'),
        );
        discover.mockRejectedValueOnce(new Error('projection failed'));
        await expect(config.reloadSkills()).rejects.toThrow(
          'projection failed',
        );
        expect(fire).toHaveBeenCalledOnce();
      } finally {
        await config.dispose();
      }
    });

    it('does not overwrite an explicit reload performed inside a ConfigChange hook', async () => {
      const config = new Config({ ...baseParams, skillsSupport: true });
      const discover = vi
        .spyOn(config.getSkillManager(), 'discoverSkills')
        .mockResolvedValue(undefined);
      await config.initialize();
      discover.mockClear();
      config.getHookSystem()!.registerHook(
        {
          type: HookType.Runtime,
          name: 'reload-during-change',
          action: async () => {
            resourceManagerMockState.projectSkills = [
              {
                ...resourceManagerMockState.projectSkills[0],
                name: 'explicit-newer',
              },
            ];
            await config.reloadSkills();
            return {};
          },
        },
        HookEventName.ConfigChange,
      );
      try {
        await publishMockSkillResourceChange('candidate-older', [
          { kind: 'skill', path: '/repo/SKILL.md', operation: 'change' },
        ]);
        expect(discover).toHaveBeenCalledOnce();
        expect(discover).toHaveBeenLastCalledWith(
          expect.objectContaining({
            resourceSkills: [
              expect.objectContaining({ name: 'explicit-newer' }),
            ],
          }),
        );
      } finally {
        await config.dispose();
      }
    });

    it.each(['older-first', 'newer-first'])(
      'keeps the newest accepted Skill snapshot when hooks finish %s',
      async (order) => {
        const config = new Config({ ...baseParams, skillsSupport: true });
        const discover = vi
          .spyOn(config.getSkillManager(), 'discoverSkills')
          .mockResolvedValue(undefined);
        await config.initialize();
        discover.mockClear();
        const result = {
          success: true,
          allOutputs: [],
          errors: [],
          totalDuration: 0,
        };
        let releaseOlder!: () => void;
        let releaseNewer!: () => void;
        const olderHook = new Promise<typeof result>((resolve) => {
          releaseOlder = () => resolve(result);
        });
        const newerHook = new Promise<typeof result>((resolve) => {
          releaseNewer = () => resolve(result);
        });
        const fire = vi
          .spyOn(config.getHookSystem()!, 'fireConfigChangeEvent')
          .mockImplementationOnce(() => olderHook)
          .mockImplementationOnce(() => newerHook);
        const events = [
          {
            kind: 'skill' as const,
            path: '/repo/SKILL.md',
            operation: 'change' as const,
          },
        ];
        const older = publishMockSkillResourceChange('older', events);
        await vi.waitFor(() => expect(fire).toHaveBeenCalledOnce());
        const newer = publishMockSkillResourceChange('newer', events);
        await vi.waitFor(() => expect(fire).toHaveBeenCalledTimes(2));
        try {
          if (order === 'older-first') {
            releaseOlder();
            await older;
            expect(discover).toHaveBeenLastCalledWith(
              expect.objectContaining({
                resourceSkills: [expect.objectContaining({ name: 'older' })],
              }),
            );
            releaseNewer();
            await newer;
            expect(discover).toHaveBeenCalledTimes(2);
          } else {
            releaseNewer();
            await newer;
            releaseOlder();
            await older;
            expect(discover).toHaveBeenCalledOnce();
          }
          expect(discover).toHaveBeenLastCalledWith(
            expect.objectContaining({
              resourceSkills: [expect.objectContaining({ name: 'newer' })],
            }),
          );
        } finally {
          releaseOlder();
          releaseNewer();
          await Promise.all([older, newer]);
          await config.dispose();
        }
      },
    );

    it('keeps Resource change delivery pending until the runtime Skill projection completes', async () => {
      const config = new Config({
        ...baseParams,
        skillsSupport: true,
      });
      await config.initialize();

      let releaseProjection: (() => void) | undefined;
      const projectionBlocker = new Promise<void>((resolve) => {
        releaseProjection = resolve;
      });
      const discover = vi
        .spyOn(config.getSkillManager(), 'discoverSkills')
        .mockImplementationOnce(() => projectionBlocker);

      const delivery = publishMockSkillResourceChange('changed-skill');
      let deliverySettled = false;
      void delivery.then(() => {
        deliverySettled = true;
      });

      await vi.waitFor(() => expect(discover).toHaveBeenCalledOnce());
      await Promise.resolve();
      expect(deliverySettled).toBe(false);

      releaseProjection?.();
      await delivery;
      expect(deliverySettled).toBe(true);
    });

    it.each([false, true])(
      'keeps rejected Skill changes out of initial discovery (interactive=%s)',
      async (interactive) => {
        await publishMockSkillResourceChange('initial-skill');
        const config = new Config({
          ...baseParams,
          skillsSupport: true,
          interactive,
        });
        const discover = vi
          .spyOn(config.getSkillManager(), 'discoverSkills')
          .mockResolvedValue(undefined);
        const action = vi.fn(async () => ({ decision: 'deny' as const }));
        config
          .getHookSystem()!
          .registerHook(
            { type: HookType.Runtime, name: 'block-startup-change', action },
            HookEventName.ConfigChange,
          );
        const startup = config as unknown as {
          createToolRegistry(): Promise<ToolRegistry>;
        };
        const createToolRegistry = startup.createToolRegistry.bind(config);
        vi.spyOn(startup, 'createToolRegistry').mockImplementationOnce(
          async () => {
            // Resources are ready, but initial Skill discovery has not started.
            await publishMockSkillResourceChange('rejected-skill', [
              {
                kind: 'skill',
                path: '/repo/.qwen/skills/rejected-skill/SKILL.md',
                operation: 'change',
              },
            ]);
            return createToolRegistry();
          },
        );
        try {
          if (interactive) await config.initializeForInteractiveStartup();
          await config.initialize();
          expect(action).toHaveBeenCalledOnce();
          expect(discover).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              resourceSkills: [
                expect.objectContaining({ name: 'initial-skill' }),
              ],
            }),
          );
        } finally {
          await config.dispose();
        }
      },
    );

    it('defers resource skill changes until initial Skill projection settles', async () => {
      const config = new Config({
        ...baseParams,
        skillsSupport: true,
      });
      let releaseInitialDiscovery: (() => void) | undefined;
      const initialDiscoveryBlocker = new Promise<void>((resolve) => {
        releaseInitialDiscovery = resolve;
      });
      const discover = vi
        .spyOn(config.getSkillManager(), 'discoverSkills')
        .mockImplementationOnce(() => initialDiscoveryBlocker)
        .mockResolvedValue(undefined);

      const initialization = config.initialize();
      await vi.waitFor(() => expect(discover).toHaveBeenCalledOnce());

      publishMockSkillResourceChange('newer-skill');

      await Promise.resolve();
      expect(discover).toHaveBeenCalledOnce();

      releaseInitialDiscovery?.();
      await initialization;
      await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(2));
      expect(discover.mock.calls[1]?.[0]).toEqual(
        expect.objectContaining({
          resourceSkills: [expect.objectContaining({ name: 'newer-skill' })],
        }),
      );
    });

    it('should deduplicate multiple calls to initialize', async () => {
      const config = new Config({
        ...baseParams,
        fileCheckpointing: true,
      });

      const storageSpy = vi.spyOn(Storage.prototype, 'initialize');

      await Promise.all([
        config.initialize(),
        config.initialize(),
        config.initialize(),
      ]);

      expect(storageSpy).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])(
      'starts enabled plugin MCP after folder trust without refresh (plugin MCP enabled=%s)',
      async (pluginMcpServersEnabled) => {
        const startPlugin = vi.fn().mockResolvedValue(undefined);
        const initialize = vi.fn().mockResolvedValue(undefined);
        const { SessionMcpManager } = await import(
          '../mcp/sessionMcpManager/index.js'
        );
        vi.mocked(SessionMcpManager).mockImplementation(
          () =>
            ({
              initialize,
              startPlugin,
              getMcpInstructions: vi.fn(),
              getInjectedMcpTools: () => ({
                tools: [],
                includeMetaTools: false,
              }),
              dispose: vi.fn(async () => {}),
            }) as Partial<SessionMcpManager> as SessionMcpManager,
        );
        const plugin = {
          name: 'test-plugin',
          manifest: { name: 'test-plugin', version: '1.0.0' },
          path: '/tmp/test-plugin',
          source: 'test',
          repository: 'test',
          enabled: true,
          mcpServers: { 'test-server': { command: 'node' } },
        };
        const config = new Config({
          ...baseParams,
          folderTrust: true,
          trustedFolder: false,
          pluginMcpServersEnabled,
          plugins: [
            plugin,
            { ...plugin, name: 'disabled-plugin', enabled: false },
          ],
        });
        await config.initialize();
        // 初始化时的尝试受 manager 的信任门禁阻止；这里验证用户授权后的重新装配。
        startPlugin.mockClear();
        initialize.mockClear();
        config.setTrustedFolder(false);
        expect(startPlugin).not.toHaveBeenCalled();
        config.setTrustedFolder(true);
        await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce());
        if (pluginMcpServersEnabled) {
          await vi.waitFor(() =>
            expect(startPlugin).toHaveBeenCalledExactlyOnceWith(
              expect.objectContaining({
                name: 'test-plugin',
                mcpServers: plugin.mcpServers,
              }),
            ),
          );
        } else {
          expect(startPlugin).not.toHaveBeenCalled();
        }
        const attempts = startPlugin.mock.calls.length;
        config.setTrustedFolder(true);
        expect(startPlugin).toHaveBeenCalledTimes(attempts);
      },
    );

    it.each([false, true])(
      'respects plugin MCP enablement independently of settings sources (plugin enabled=%s)',
      async (pluginMcpServersEnabled) => {
        const initialize = vi.fn().mockResolvedValue(undefined);
        const startPlugin = vi.fn().mockResolvedValue(undefined);
        const { SessionMcpManager } = await import(
          '../mcp/sessionMcpManager/index.js'
        );
        vi.mocked(SessionMcpManager).mockImplementation(
          () =>
            ({
              initialize,
              startPlugin,
              getMcpInstructions: vi.fn(),
              getInjectedMcpTools: () => ({
                tools: [],
                includeMetaTools: false,
              }),
              dispose: vi.fn(async () => {}),
            }) as Partial<SessionMcpManager> as SessionMcpManager,
        );
        const config = new Config({
          ...baseParams,
          mcpSettingsSourcesEnabled: false,
          pluginMcpServersEnabled,
          plugins: [
            {
              name: 'test-plugin',
              manifest: { name: 'test-plugin', version: '1.0.0' },
              path: '/tmp/test-plugin',
              source: 'test',
              repository: 'test',
              enabled: true,
              mcpServers: {
                'test-server': { command: 'node' },
              },
            },
          ],
        });

        await config.initialize();

        expect(initialize).toHaveBeenCalledOnce();
        if (pluginMcpServersEnabled) {
          expect(startPlugin).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              name: 'test-plugin',
              mcpServers: { 'test-server': { command: 'node' } },
            }),
          );
        } else {
          expect(startPlugin).not.toHaveBeenCalled();
        }
      },
    );

    it('should await MCP initialization in non-interactive mode', async () => {
      const config = new Config({
        ...baseParams,
        fileCheckpointing: true,
        // interactive defaults to false
      });

      const { SessionMcpManager } = await import(
        '../mcp/sessionMcpManager/index.js'
      );
      let mcpStarted = false;

      vi.mocked(SessionMcpManager).mockImplementation(
        () =>
          ({
            initialize: vi.fn().mockImplementation(async () => {
              await new Promise((resolve) => setTimeout(resolve, 50));
              mcpStarted = true;
            }),
            getMcpInstructions: vi.fn(),
            getInjectedMcpTools: () => ({ tools: [], includeMetaTools: false }),
            dispose: vi.fn(async () => {}),
          }) as Partial<SessionMcpManager> as SessionMcpManager,
      );

      await config.initialize();

      // Should wait for MCP to finish
      expect(mcpStarted).toBe(true);
    });

    it('should start skill discovery while non-interactive MCP initialization is still running', async () => {
      const config = new Config({
        ...baseParams,
        fileCheckpointing: true,
        skillsSupport: true,
        // interactive defaults to false
      });
      const skillManager = config.getSkillManager();
      let discoverSkillsStarted = false;
      vi.spyOn(skillManager, 'discoverSkills').mockImplementation(async () => {
        discoverSkillsStarted = true;
      });

      const { SessionMcpManager } = await import(
        '../mcp/sessionMcpManager/index.js'
      );
      let resolveMcp: (value: unknown) => void;
      const mcpPromise = new Promise((resolve) => {
        resolveMcp = resolve;
      });
      let initializeSettled = false;

      vi.mocked(SessionMcpManager).mockImplementation(
        () =>
          ({
            initialize: vi.fn().mockReturnValue(mcpPromise),
            getMcpInstructions: vi.fn(),
            getInjectedMcpTools: () => ({ tools: [], includeMetaTools: false }),
            dispose: vi.fn(async () => {}),
          }) as Partial<SessionMcpManager> as SessionMcpManager,
      );

      const initializePromise = config.initialize().then(() => {
        initializeSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(discoverSkillsStarted).toBe(true);
      expect(initializeSettled).toBe(false);

      resolveMcp!(undefined);
      await initializePromise;
      expect(initializeSettled).toBe(true);
    });

    it('marks memory ready before the MCP initialization wait completes', async () => {
      // Memory discovery depends only on `base`, so it must resolve without
      // waiting on MCP server startup. Regression guard for the ordering fix.
      const config = new Config({
        ...baseParams,
        fileCheckpointing: true,
        mcpInitializationWaitStrategy: 'full',
      });

      const { SessionMcpManager } = await import(
        '../mcp/sessionMcpManager/index.js'
      );
      // Never-resolving MCP: under `full` this holds initialize() open forever.
      const neverResolves = new Promise(() => {});
      (SessionMcpManager as unknown as Mock).mockImplementation(
        () =>
          ({
            initialize: vi.fn().mockReturnValue(neverResolves),
            getMcpInstructions: vi.fn(),
            getInjectedMcpTools: () => ({ tools: [], includeMetaTools: false }),
            dispose: vi.fn(async () => {}),
          }) as Partial<SessionMcpManager> as SessionMcpManager,
      );

      let initializeSettled = false;
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      config.initialize().then(() => {
        initializeSettled = true;
      });

      // Let base init + the (local, fast) memory refresh drain.
      await config.waitForStartupGate('memory');

      expect(config.getStartupReadinessSnapshot()['memory'].status).toBe(
        'ready',
      );
      // MCP is still pending, so initialize() must not have settled.
      expect(initializeSettled).toBe(false);
    });

    it('marks the MCP budget degraded when MCP initialization fails', async () => {
      const config = new Config({
        ...baseParams,
        fileCheckpointing: true,
        mcpInitializationWaitStrategy: 'full',
      });

      const { SessionMcpManager } = await import(
        '../mcp/sessionMcpManager/index.js'
      );
      (SessionMcpManager as unknown as Mock).mockImplementation(
        () =>
          ({
            initialize: vi.fn().mockRejectedValue(new Error('mcp boom')),
            getMcpInstructions: vi.fn(),
            getInjectedMcpTools: () => ({ tools: [], includeMetaTools: false }),
            dispose: vi.fn(async () => {}),
          }) as Partial<SessionMcpManager> as SessionMcpManager,
      );

      await config.initialize();

      expect(config.getStartupReadinessSnapshot()['mcp-budget']).toEqual({
        status: 'degraded',
        reasons: [
          expect.objectContaining({
            code: 'mcp-initialization-failed',
            message: 'mcp boom',
          }),
        ],
      });
      await expect(config.waitForStartupGate('mcp-budget')).resolves.toEqual({
        status: 'degraded',
        reasons: expect.arrayContaining([
          expect.objectContaining({
            code: 'mcp-initialization-failed',
            message: 'mcp boom',
          }),
        ]),
      });
    });

    it('keeps the MCP budget degraded after a startup timeout even if MCP finishes later', async () => {
      vi.useFakeTimers();
      const config = new Config({
        ...baseParams,
        fileCheckpointing: true,
        mcpInitializationWaitStrategy: 'budget',
      });

      const { SessionMcpManager } = await import(
        '../mcp/sessionMcpManager/index.js'
      );
      let resolveMcp: (value: unknown) => void;
      const mcpPromise = new Promise((resolve) => {
        resolveMcp = resolve;
      });
      (SessionMcpManager as unknown as Mock).mockImplementation(
        () =>
          ({
            initialize: vi.fn().mockReturnValue(mcpPromise),
            getMcpInstructions: vi.fn(),
            getInjectedMcpTools: () => ({ tools: [], includeMetaTools: false }),
            dispose: vi.fn(async () => {}),
          }) as Partial<SessionMcpManager> as SessionMcpManager,
      );

      const initializePromise = config.initialize();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(NON_INTERACTIVE_MCP_BUDGET_MS);
      await initializePromise;

      expect(config.getStartupReadinessSnapshot()['mcp-budget']).toEqual({
        status: 'degraded',
        reasons: [
          expect.objectContaining({
            code: 'mcp-budget-timeout',
          }),
        ],
      });

      resolveMcp!(undefined);
      await Promise.resolve();
      await Promise.resolve();

      expect(config.getStartupReadinessSnapshot()['mcp-budget']).toEqual({
        status: 'degraded',
        reasons: [
          expect.objectContaining({
            code: 'mcp-budget-timeout',
          }),
        ],
      });
    });

    it('honors the branded MCP initialization budget override', async () => {
      vi.useFakeTimers();
      vi.stubEnv(ENV_MCP_INIT_BUDGET_MS, '250');
      try {
        const config = new Config({
          ...baseParams,
          fileCheckpointing: true,
          mcpInitializationWaitStrategy: 'budget',
        });

        const { SessionMcpManager } = await import(
          '../mcp/sessionMcpManager/index.js'
        );
        const mcpPromise = new Promise(() => {});
        (SessionMcpManager as unknown as Mock).mockImplementation(
          () =>
            ({
              initialize: vi.fn().mockReturnValue(mcpPromise),
              getMcpInstructions: vi.fn(),
              getInjectedMcpTools: () => ({
                tools: [],
                includeMetaTools: false,
              }),
            }) as Partial<SessionMcpManager> as SessionMcpManager,
        );

        const initializePromise = config.initialize();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(250);
        await initializePromise;

        expect(config.getStartupReadinessSnapshot()['mcp-budget']).toEqual({
          status: 'degraded',
          reasons: [
            expect.objectContaining({
              code: 'mcp-budget-timeout',
            }),
          ],
        });
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('records the MCP wait outcome and session MCP counts on mcp.wait', async () => {
      vi.useFakeTimers();
      vi.stubEnv(ENV_MCP_INIT_BUDGET_MS, '250');
      const log = vi.spyOn(runLogger, 'log').mockImplementation(() => {});
      try {
        const config = new Config({
          ...baseParams,
          fileCheckpointing: true,
          mcpInitializationWaitStrategy: 'budget',
        });
        const { SessionMcpManager } = await import(
          '../mcp/sessionMcpManager/index.js'
        );
        const getStartupSnapshot = vi
          .fn()
          .mockReturnValueOnce({ active: 2, pending: 2, tools: 0 })
          .mockReturnValue({ active: 2, pending: 1, tools: 3 });
        (SessionMcpManager as unknown as Mock).mockImplementation(
          () =>
            ({
              initialize: vi.fn().mockReturnValue(new Promise(() => {})),
              getMcpInstructions: vi.fn(),
              getInjectedMcpTools: () => ({
                tools: [],
                includeMetaTools: false,
              }),
              getStartupSnapshot,
            }) as Partial<SessionMcpManager> as SessionMcpManager,
        );

        const initializePromise = config.initialize();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(250);
        await initializePromise;

        const finished = log.mock.calls
          .filter(([tag]) => tag === '[startup.diagnostic]')
          .map(([, fields]) => fields as Record<string, unknown>)
          .find((fields) => fields['name'] === 'mcp.wait' && fields['event'] === 'finished');
        expect(finished).toMatchObject({
          strategy: 'budget',
          budget_ms: 250,
          outcome: 'budget_exhausted',
          elapsed_since_start_ms: expect.any(Number),
          active_before: 2,
          pending_before: 2,
          tools_before: 0,
          pending_after: 1,
          tools_after: 3,
          status: 'resolved',
        });
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('treats a zero MCP initialization budget as no wait', async () => {
      vi.useFakeTimers();
      vi.stubEnv(ENV_MCP_INIT_BUDGET_MS, '0');
      try {
        const config = new Config({
          ...baseParams,
          fileCheckpointing: true,
          mcpInitializationWaitStrategy: 'budget',
        });

        const { SessionMcpManager } = await import(
          '../mcp/sessionMcpManager/index.js'
        );
        const mcpPromise = new Promise(() => {});
        (SessionMcpManager as unknown as Mock).mockImplementation(
          () =>
            ({
              initialize: vi.fn().mockReturnValue(mcpPromise),
              getMcpInstructions: vi.fn(),
              getInjectedMcpTools: () => ({
                tools: [],
                includeMetaTools: false,
              }),
            }) as Partial<SessionMcpManager> as SessionMcpManager,
        );

        const initializePromise = config.initialize();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
        await initializePromise;

        expect(config.getStartupReadinessSnapshot()['mcp-budget']).toEqual({
          status: 'degraded',
          reasons: [
            expect.objectContaining({
              code: 'mcp-budget-timeout',
            }),
          ],
        });
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('falls back to the default when the MCP initialization budget is invalid', async () => {
      vi.useFakeTimers();
      vi.stubEnv(ENV_MCP_INIT_BUDGET_MS, '999999999');
      try {
        const config = new Config({
          ...baseParams,
          fileCheckpointing: true,
          mcpInitializationWaitStrategy: 'budget',
        });

        const { SessionMcpManager } = await import(
          '../mcp/sessionMcpManager/index.js'
        );
        const mcpPromise = new Promise(() => {});
        (SessionMcpManager as unknown as Mock).mockImplementation(
          () =>
            ({
              initialize: vi.fn().mockReturnValue(mcpPromise),
              getMcpInstructions: vi.fn(),
              getInjectedMcpTools: () => ({
                tools: [],
                includeMetaTools: false,
              }),
            }) as Partial<SessionMcpManager> as SessionMcpManager,
        );

        const initializePromise = config.initialize();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(NON_INTERACTIVE_MCP_BUDGET_MS);
        await initializePromise;

        expect(config.getStartupReadinessSnapshot()['mcp-budget']).toEqual({
          status: 'degraded',
          reasons: [
            expect.objectContaining({
              code: 'mcp-budget-timeout',
            }),
          ],
        });
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('should not await MCP initialization in interactive mode', async () => {
      const config = new Config({
        ...baseParams,
        fileCheckpointing: true,
        interactive: true,
      });

      const { SessionMcpManager } = await import(
        '../mcp/sessionMcpManager/index.js'
      );
      let mcpStarted = false;
      let resolveMcp: (value: unknown) => void;
      const mcpPromise = new Promise((resolve) => {
        resolveMcp = resolve;
      });

      (SessionMcpManager as unknown as Mock).mockImplementation(
        () =>
          ({
            initialize: vi.fn().mockImplementation(async () => {
              await mcpPromise;
              mcpStarted = true;
            }),
            getMcpInstructions: vi.fn(),
            getInjectedMcpTools: () => ({ tools: [], includeMetaTools: false }),
            dispose: vi.fn(async () => {}),
          }) as Partial<SessionMcpManager> as SessionMcpManager,
      );

      await config.initialize();

      // Should return immediately, before MCP finishes
      expect(mcpStarted).toBe(false);

      // Now let it finish
      resolveMcp!(undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mcpStarted).toBe(true);
    });

    it('should return interactive startup before MCP and skills hydration settle', async () => {
      const logSpy = vi.spyOn(runLogger, 'log');
      const config = new Config({
        ...baseParams,
        fileCheckpointing: true,
        interactive: true,
        skillsSupport: true,
      });
      const skillManager = config.getSkillManager();
      let skillsStarted = false;
      let resolveSkills: (value: unknown) => void;
      const skillsPromise = new Promise((resolve) => {
        resolveSkills = resolve;
      });
      vi.spyOn(skillManager, 'discoverSkills').mockImplementation(async () => {
        skillsStarted = true;
        await skillsPromise;
      });

      const { SessionMcpManager } = await import(
        '../mcp/sessionMcpManager/index.js'
      );
      let mcpStarted = false;
      let resolveMcp: (value: unknown) => void;
      const mcpPromise = new Promise((resolve) => {
        resolveMcp = resolve;
      });

      (SessionMcpManager as unknown as Mock).mockImplementation(
        () =>
          ({
            initialize: vi.fn().mockImplementation(async () => {
              await mcpPromise;
              mcpStarted = true;
            }),
            getMcpInstructions: vi.fn(),
            getInjectedMcpTools: () => ({ tools: [], includeMetaTools: false }),
            dispose: vi.fn(async () => {}),
          }) as Partial<SessionMcpManager> as SessionMcpManager,
      );

      await config.initializeForInteractiveStartup();

      expect(config.isInitialized()).toBe(true);
      expect(skillsStarted).toBe(true);
      expect(mcpStarted).toBe(false);

      resolveSkills!(undefined);
      resolveMcp!(undefined);
      await config.hydrateAfterFirstRender();
      expect(mcpStarted).toBe(true);
      const events = logSpy.mock.calls
        .filter(([tag]) => tag === '[startup.diagnostic]')
        .map(([, event]) => event);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'skills.initialize',
            event: 'started',
          }),
          expect.objectContaining({
            name: 'memory.refresh',
            event: 'finished',
            status: 'resolved',
          }),
          expect.objectContaining({
            name: 'mcp.wait',
            event: 'finished',
            status: 'resolved',
          }),
          expect.objectContaining({
            name: 'skills.wait',
            event: 'finished',
            status: 'resolved',
          }),
        ]),
      );
      logSpy.mockRestore();
    });

    it('keeps base readiness aligned with isInitialized during interactive startup', async () => {
      const config = new Config({
        ...baseParams,
        fileCheckpointing: true,
        interactive: true,
        skillsSupport: true,
      });
      const skillManager = config.getSkillManager();
      let resolveSkills: (value: unknown) => void;
      const skillsPromise = new Promise((resolve) => {
        resolveSkills = resolve;
      });
      vi.spyOn(skillManager, 'discoverSkills').mockImplementation(async () => {
        await skillsPromise;
      });

      await config.initializeForInteractiveStartup();

      expect(config.isInitialized()).toBe(true);
      expect(config.getStartupReadinessSnapshot().base.status).toBe('ready');
      expect(config.getStartupReadinessSnapshot().commands.status).toBe(
        'pending',
      );

      // Memory discovery depends only on `base`, so it becomes ready during
      // background hydration even while skill discovery is still blocked — it is
      // no longer serialized behind the MCP wait and skills await.
      await config.waitForStartupGate('memory');
      expect(config.getStartupReadinessSnapshot().memory.status).toBe('ready');
      expect(config.getStartupReadinessSnapshot().commands.status).toBe(
        'pending',
      );

      resolveSkills!(undefined);
      await config.hydrateAfterFirstRender();

      expect(config.getStartupReadinessSnapshot().commands.status).toBe(
        'ready',
      );
      expect(config.getStartupReadinessSnapshot().memory.status).toBe('ready');
    });

    it('fails startup gates when base initialization throws', async () => {
      const config = new Config({
        ...baseParams,
        fileCheckpointing: true,
        interactive: true,
      });
      vi.spyOn(
        config as unknown as { createToolRegistry: () => Promise<unknown> },
        'createToolRegistry',
      ).mockRejectedValue(new Error('tool registry boom'));

      await expect(config.initializeForInteractiveStartup()).rejects.toThrow(
        'tool registry boom',
      );

      const snapshot = config.getStartupReadinessSnapshot();
      expect(snapshot.base).toEqual({
        status: 'failed',
        reasons: [
          expect.objectContaining({
            code: 'config-initialization-failed',
            message: 'tool registry boom',
          }),
        ],
      });
      await expect(config.waitForStartupGate('commands')).rejects.toThrow(
        'tool registry boom',
      );
    });

    it('replays skill change subscriptions registered after initial discovery', async () => {
      const config = new Config({
        ...baseParams,
        fileCheckpointing: true,
        mcpInitializationWaitStrategy: 'none',
        skillsSupport: true,
      });
      vi.spyOn(config.getSkillManager(), 'discoverSkills').mockResolvedValue(
        undefined,
      );

      await config.initialize();

      const listener = vi.fn();
      const unsubscribe = config.onSkillChange(listener);
      await Promise.resolve();
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      await config.reloadSkills();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    // slashCommandProcessor reloads the slash-command catalog by subscribing
    // to startupRuntime.onChange('skills'), not to onSkillChange. Without this
    // test, removing the emitChange('skills') call in emitSkillChange would
    // silently kill skill-driven command reloads with no failing test.
    it('emits the skills startup-change event when skills reload', async () => {
      const config = new Config({
        ...baseParams,
        fileCheckpointing: true,
        mcpInitializationWaitStrategy: 'none',
        skillsSupport: true,
      });
      vi.spyOn(config.getSkillManager(), 'discoverSkills').mockResolvedValue(
        undefined,
      );

      await config.initialize();

      const listener = vi.fn();
      const unsubscribe = config
        .getStartupRuntime()
        .onChange('skills', listener);

      await config.reloadSkills();
      await vi.waitFor(() => expect(listener).toHaveBeenCalled());

      unsubscribe();
    });

    it('emits the skills startup-change event for in-memory skill updates', async () => {
      const config = new Config({
        ...baseParams,
        fileCheckpointing: true,
        mcpInitializationWaitStrategy: 'none',
        skillsSupport: true,
      });
      vi.spyOn(config.getSkillManager(), 'discoverSkills').mockResolvedValue(
        undefined,
      );

      await config.initialize();

      const listener = vi.fn();
      const unsubscribe = config
        .getStartupRuntime()
        .onChange('skills', listener);

      config.notifySkillsChanged();
      await vi.waitFor(() => expect(listener).toHaveBeenCalled());

      unsubscribe();
    });

    it('does not double-fire late skill-change subscribers during queued dispatch', async () => {
      const config = new Config({
        ...baseParams,
        fileCheckpointing: true,
        mcpInitializationWaitStrategy: 'none',
        skillsSupport: true,
      });
      vi.spyOn(config.getSkillManager(), 'discoverSkills').mockResolvedValue(
        undefined,
      );

      await config.initialize();

      const listener = vi.fn();
      (config as unknown as { emitSkillChange: () => void }).emitSkillChange();
      config.onSkillChange(listener);
      await Promise.resolve();

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('marks commands degraded when initial skill discovery fails', async () => {
      const config = new Config({
        ...baseParams,
        fileCheckpointing: true,
        mcpInitializationWaitStrategy: 'none',
        skillsSupport: true,
      });
      vi.spyOn(config.getSkillManager(), 'discoverSkills').mockRejectedValue(
        new Error('skill boom'),
      );

      await config.initialize();

      const commandsState = config.getStartupReadinessSnapshot().commands;
      expect(commandsState.status).toBe('degraded');
      expect(commandsState.reasons).toEqual([
        expect.objectContaining({
          code: 'skills-discovery-failed',
          message: 'skill boom',
        }),
      ]);
      await expect(config.waitForStartupGate('commands')).resolves.toEqual({
        status: 'degraded',
        reasons: commandsState.reasons,
      });
    });

    it('should let startup strategy skip MCP wait for non-interactive config', async () => {
      const config = new Config({
        ...baseParams,
        fileCheckpointing: true,
        mcpInitializationWaitStrategy: 'none',
      });

      const { SessionMcpManager } = await import(
        '../mcp/sessionMcpManager/index.js'
      );
      let mcpStarted = false;
      let resolveMcp: (value: unknown) => void;
      const mcpPromise = new Promise((resolve) => {
        resolveMcp = resolve;
      });

      (SessionMcpManager as unknown as Mock).mockImplementation(
        () =>
          ({
            initialize: vi.fn().mockImplementation(async () => {
              await mcpPromise;
              mcpStarted = true;
            }),
            getMcpInstructions: vi.fn(),
            getInjectedMcpTools: () => ({ tools: [], includeMetaTools: false }),
            dispose: vi.fn(async () => {}),
          }) as Partial<SessionMcpManager> as SessionMcpManager,
      );

      await config.initialize();

      expect(config.getMcpInitializationWaitStrategy()).toBe('none');
      expect(mcpStarted).toBe(false);

      resolveMcp!(undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mcpStarted).toBe(true);
    });

    it('should let startup strategy wait for MCP in interactive config', async () => {
      const config = new Config({
        ...baseParams,
        fileCheckpointing: true,
        interactive: true,
        mcpInitializationWaitStrategy: 'full',
      });

      const { SessionMcpManager } = await import(
        '../mcp/sessionMcpManager/index.js'
      );
      let mcpStarted = false;

      (SessionMcpManager as unknown as Mock).mockImplementation(
        () =>
          ({
            initialize: vi.fn().mockImplementation(async () => {
              await new Promise((resolve) => setTimeout(resolve, 0));
              mcpStarted = true;
            }),
            getMcpInstructions: vi.fn(),
            getInjectedMcpTools: () => ({ tools: [], includeMetaTools: false }),
            dispose: vi.fn(async () => {}),
          }) as Partial<SessionMcpManager> as SessionMcpManager,
      );

      await config.initialize();

      expect(config.getMcpInitializationWaitStrategy()).toBe('full');
      expect(mcpStarted).toBe(true);
    });

    describe('getGen31LaunchedSync', () => {
      it.each([
        AuthType.QODER_BROWSER,
        AuthType.QODER_PAT,
        AuthType.QODER_BROWSER,
      ])('should return true for %s', async (authType) => {
        const config = new Config(baseParams);
        await config.refreshAuth(authType);
        expect(config.getGen31LaunchedSync()).toBe(true);
      });

      it('preserves model defaults before authentication', async () => {
        const config = new Config(baseParams);
        expect(config.getGen31LaunchedSync()).toBe(true);
        expect(await config.getGen31Launched()).toBe(true);
        expect(config.getGen31FlashLiteLaunchedSync()).toBe(true);
        expect(await config.getGen31FlashLiteLaunched()).toBe(true);
        expect(config.getProModelNoAccessSync()).toBe(false);
        expect(await config.getProModelNoAccess()).toBe(false);
        expect(config.getUseCustomToolModelSync()).toBe(true);
        expect(await config.getUseCustomToolModel()).toBe(true);
      });
    });

    describe('getGen31FlashLiteLaunchedSync', () => {
      it.each([
        AuthType.QODER_BROWSER,
        AuthType.QODER_PAT,
        AuthType.QODER_BROWSER,
      ])('should return true for %s', async (authType) => {
        const config = new Config(baseParams);
        await config.refreshAuth(authType);
        expect(config.getGen31FlashLiteLaunchedSync()).toBe(true);
      });
    });
  });

  describe('refreshAuth', () => {
    describe('CLI model anchor', () => {
      beforeEach(() => {
        vi.stubEnv(ENV_MODEL, '');
      });

      afterEach(() => vi.unstubAllEnvs());

      function setup() {
        const selected: Model = {
          key: 'auto',
          source: 'qoder',
          displayName: 'Auto',
          capabilities: {
            tools: true,
            vision: true,
            reasoning: { supported: false, supportedEfforts: [] },
            contextWindows: [],
          },
          limits: { maxContextTokens: 128000 },
        };
        const mutate = vi.fn();
        const settingsService = new SettingsService();
        vi.spyOn(settingsService, 'peekUserSettingsSource').mockReturnValue({
          read: () => JSON.stringify({ model: { name: 'cmodel' } }),
          mutate,
        } as unknown as ReturnType<SettingsService['peekUserSettingsSource']>);
        const provider = {
          providerId: 'qoder',
          start: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
          getModel: vi.fn(async (key: string) =>
            key === selected.key ? selected : undefined,
          ),
          listModels: vi.fn(async () => [selected]),
          getModelConfig: () => undefined,
          setModelConfig: () => true,
          select: vi.fn(async () => {
            const mainModel: Model = await config
              .getModelProviderManager()
              .getMainModel();
            return {
              model: mainModel,
              config: {
                reasoning: { effort: 'none' as const },
                contextWindow: 128000,
              },
            };
          }),
          inference: vi.fn(),
        } satisfies ModelProvider;
        const config = new Config({
          ...baseParams,
          model: 'auto',
          modelSource: 'cli',
          settingsService,
          modelProviderFactory: () => [provider],
        });
        return {
          config,
          manager: config.getModelProviderManager(),
          provider,
          selected,
          mutate,
        };
      }

      it('Config 构造时调用工厂一次，dispose 关闭本会话 provider', async () => {
        const { config, provider } = setup();
        const modelProviderFactory = vi.fn(() => [
          {
            ...provider,
            start: vi.fn(async () => {}),
            stop: vi.fn(async () => {}),
          },
        ]);
        const first = new Config({ ...baseParams, modelProviderFactory });
        const second = new Config({ ...baseParams, modelProviderFactory });
        expect(modelProviderFactory).toHaveBeenCalledTimes(2);
        expect(first.getModelProviderFactory()).toBe(modelProviderFactory);
        const [firstProvider] = modelProviderFactory.mock.results[0]!.value!;
        const [secondProvider] = modelProviderFactory.mock.results[1]!.value!;
        expect(firstProvider).not.toBe(secondProvider);
        try {
          await first.getModelProviderManager().start();
          await second.getModelProviderManager().start();
          await first.dispose();
          expect(firstProvider.stop).toHaveBeenCalledOnce();
          expect(secondProvider.stop).not.toHaveBeenCalled();
        } finally {
          await first.dispose();
          await second.dispose();
          await config.dispose();
        }
        expect(firstProvider.stop).toHaveBeenCalledOnce();
        expect(secondProvider.stop).toHaveBeenCalledOnce();
      });

      it('keeps explicit fake-response sessions independent of live providers', async () => {
        const modelProviderFactory = vi.fn(() => {
          throw new Error('Replay must not construct live providers');
        });
        const config = new Config({
          ...baseParams,
          model: 'offline-smoke',
          fakeResponses: '/unused/replay.jsonl',
          modelProviderFactory,
        });
        try {
          await config.refreshAuth(AuthType.QODER_BROWSER);
          const manager = config.getModelProviderManager();
          await manager.start();
          const models = await manager.listModels();
          expect(models.map((model) => model.key)).toEqual(['offline-smoke']);
          manager.setMainModel(models[0]!);
          const selection = await manager.select({ purpose: 'main' });
          expect(selection.model.key).toBe('offline-smoke');
          expect(modelProviderFactory).not.toHaveBeenCalled();
        } finally {
          await config.dispose();
        }
      });

      it.each([true, false])(
        'anchors the CLI model instead of a missing saved model (manager started: %s)',
        async (started) => {
          const { config, manager, selected, mutate } = setup();
          if (started) await manager.start();
          try {
            await config.refreshAuth(AuthType.QODER_BROWSER);
            await manager.start();

            expect(config.getModel()).toBe('auto');
            expect(await manager.getMainModel()).toEqual(selected);
            expect((await manager.select({ purpose: 'main' })).model).toEqual(
              selected,
            );
            expect(mutate).not.toHaveBeenCalled();
          } finally {
            await config.dispose();
          }
        },
      );

      it('does not overwrite a newer session model while resolving the CLI model', async () => {
        const { config, manager, provider, selected, mutate } = setup();
        const next = { ...selected, key: 'lite' };
        let finishLookup!: (model: Model) => void;
        let lookupStarted!: () => void;
        const pending = new Promise<Model>((resolve) => {
          finishLookup = resolve;
        });
        const started = new Promise<void>((resolve) => {
          lookupStarted = resolve;
        });
        provider.getModel.mockImplementation(async (key) =>
          key === next.key ? next : key === selected.key ? selected : undefined,
        );
        provider.getModel.mockImplementationOnce(async () => {
          lookupStarted();
          return pending;
        });
        try {
          const refreshing = config.refreshAuth(AuthType.QODER_BROWSER);
          await started;
          await config.setModel(next.key);
          manager.setMainModel(next);
          finishLookup(selected);
          await refreshing;
          await manager.start();

          expect(await manager.getMainModel()).toEqual(next);
          expect(mutate).not.toHaveBeenCalled();
        } finally {
          await config.dispose();
        }
      });
    });

    it('should refresh auth and update config', async () => {
      const config = new Config(baseParams);
      const authType = AuthType.QODER_BROWSER;

      await config.refreshAuth(authType);

      // Verify that the auth snapshot is updated
      expect(config.getContentGeneratorConfig()?.authType).toBe(authType);
    });

    it('should reset model availability status', async () => {
      const config = new Config(baseParams);
      const service = config.getModelAvailabilityService();
      const spy = vi.spyOn(service, 'reset');

      await config.refreshAuth(AuthType.QODER_BROWSER);

      expect(spy).toHaveBeenCalled();
    });

    it('should strip thoughts when switching from GenAI to Vertex with an active session runtime', async () => {
      const config = new Config(baseParams);
      const loopContext: AgentLoopContext = config;
      const stripSpy = vi.spyOn(
        loopContext,
        'stripThoughtsFromConversationHistory',
      );
      config.registerSessionRuntimeBinding({
        refreshRuntimeContext: vi.fn(),
        stripThoughtsFromConversationHistory: vi.fn(),
      });

      await config.refreshAuth(AuthType.QODER_BROWSER);
      await config.refreshAuth(AuthType.QODER_BROWSER);

      expect(stripSpy).toHaveBeenCalledWith();
    });

    it('should strip thoughts when switching from GenAI to Vertex AI with an active session runtime', async () => {
      const config = new Config(baseParams);
      const loopContext: AgentLoopContext = config;
      const stripSpy = vi.spyOn(
        loopContext,
        'stripThoughtsFromConversationHistory',
      );
      config.registerSessionRuntimeBinding({
        refreshRuntimeContext: vi.fn(),
        stripThoughtsFromConversationHistory: vi.fn(),
      });

      await config.refreshAuth(AuthType.QODER_BROWSER);
      await config.refreshAuth(AuthType.QODER_PAT);

      expect(stripSpy).toHaveBeenCalledWith();
    });

    it('should not strip thoughts when switching from Vertex to GenAI even with an active session runtime', async () => {
      const config = new Config(baseParams);
      const loopContext: AgentLoopContext = config;
      const stripSpy = vi.spyOn(
        loopContext,
        'stripThoughtsFromConversationHistory',
      );
      config.registerSessionRuntimeBinding({
        refreshRuntimeContext: vi.fn(),
        stripThoughtsFromConversationHistory: vi.fn(),
      });

      await config.refreshAuth(AuthType.QODER_PAT);
      await config.refreshAuth(AuthType.QODER_BROWSER);

      expect(stripSpy).not.toHaveBeenCalled();
    });

    it('should not strip thoughts without an active session runtime', async () => {
      const config = new Config(baseParams);
      const loopContext: AgentLoopContext = config;
      const stripSpy = vi.spyOn(
        loopContext,
        'stripThoughtsFromConversationHistory',
      );

      await config.refreshAuth(AuthType.QODER_BROWSER);
      await expect(config.refreshAuth(AuthType.QODER_BROWSER)).resolves.toBe(
        undefined,
      );

      expect(stripSpy).not.toHaveBeenCalled();
    });

    it('should keep Qoder auto model after authentication', async () => {
      const config = new Config({
        ...baseParams,
        model: PREVIEW_MODEL_AUTO,
      });
      await config.getModelProviderManager().start();

      await config.refreshAuth(AuthType.QODER_BROWSER);

      expect(config.getModel()).toBe(PREVIEW_MODEL_AUTO);
    });

    it('should NOT switch to flash model if user has Pro access and model is auto', async () => {
      const config = new Config({
        ...baseParams,
        model: PREVIEW_MODEL_AUTO,
      });
      await config.getModelProviderManager().start();

      await config.refreshAuth(AuthType.QODER_BROWSER);

      expect(config.getModel()).toBe(PREVIEW_MODEL_AUTO);
    });
  });

  it('Config constructor should store userMemory correctly', () => {
    const config = new Config(baseParams);

    expect(config.getUserMemory()).toBe(USER_MEMORY);
    // Verify other getters if needed
    expect(config.getTargetDir()).toBe(path.resolve(TARGET_DIR)); // Check resolved path
  });

  it('Config constructor should default userMemory to empty string if not provided', () => {
    const paramsWithoutMemory: ConfigParameters = { ...baseParams };
    delete paramsWithoutMemory.userMemory;
    const config = new Config(paramsWithoutMemory);

    expect(config.getUserMemory()).toBe('');
  });

  it('Config constructor should expose contextFileName when provided', () => {
    const paramsWithContextFile: ConfigParameters = {
      ...baseParams,
      contextFileName: 'CUSTOM_AGENTS.md',
    };
    const config = new Config(paramsWithContextFile);

    expect(config.getCurrentContextFileName()).toBe('CUSTOM_AGENTS.md');
    expect(config.getAllContextFileNames()).toEqual(['CUSTOM_AGENTS.md']);
    expect(config.getAllLocalContextFileNames()).toEqual([
      'CUSTOM_AGENTS.local.md',
    ]);
  });

  it('Config constructor should keep every name of an array contextFileName', () => {
    const config = new Config({
      ...baseParams,
      contextFileName: ['PRIMARY.md', 'SECONDARY.md'],
    });

    expect(config.getCurrentContextFileName()).toBe('PRIMARY.md');
    expect(config.getAllContextFileNames()).toEqual([
      'PRIMARY.md',
      'SECONDARY.md',
    ]);
    expect(config.getAllLocalContextFileNames()).toEqual([
      'PRIMARY.local.md',
      'SECONDARY.local.md',
    ]);
  });

  it('Config constructor should default the context filename when not provided', () => {
    const config = new Config(baseParams); // baseParams has no contextFileName

    expect(config.getCurrentContextFileName()).toBe(DEFAULT_CONTEXT_FILENAME);
    expect(config.getAllContextFileNames()).toEqual([DEFAULT_CONTEXT_FILENAME]);
  });

  it('keeps two sessions in one process on their own context filename', () => {
    // The regression this member exists to prevent: the filename used to live in
    // a module-level variable that every Config constructor overwrote, so a
    // second session in the same process silently retargeted the first one's
    // memory discovery — and a session that configured nothing inherited
    // whatever the previous session had left behind.
    const custom = new Config({
      ...baseParams,
      contextFileName: 'CUSTOM_AGENTS.md',
    });
    const fallback = new Config(baseParams);

    expect(custom.getCurrentContextFileName()).toBe('CUSTOM_AGENTS.md');
    expect(custom.getAllContextFileNames()).toEqual(['CUSTOM_AGENTS.md']);
    expect(fallback.getCurrentContextFileName()).toBe(DEFAULT_CONTEXT_FILENAME);
  });

  it('should set default file filtering settings when not provided', () => {
    const config = new Config(baseParams);
    expect(config.getFileFilteringRespectGitIgnore()).toBe(
      DEFAULT_FILE_FILTERING_OPTIONS.respectGitIgnore,
    );
  });

  it('should set custom file filtering settings when provided', () => {
    const paramsWithFileFiltering: ConfigParameters = {
      ...baseParams,
      fileFiltering: {
        respectGitIgnore: false,
      },
    };
    const config = new Config(paramsWithFileFiltering);
    expect(config.getFileFilteringRespectGitIgnore()).toBe(false);
  });

  it('should set customIgnoreFilePaths from params', () => {
    const params: ConfigParameters = {
      ...baseParams,
      fileFiltering: {
        customIgnoreFilePaths: ['/path/to/ignore/file'],
      },
    };
    const config = new Config(params);
    expect(config.getCustomIgnoreFilePaths()).toStrictEqual([
      '/path/to/ignore/file',
    ]);
  });

  it('should set customIgnoreFilePaths to empty array if not provided', () => {
    const params: ConfigParameters = {
      ...baseParams,
      fileFiltering: {
        respectGitIgnore: true,
      },
    };
    const config = new Config(params);
    expect(config.getCustomIgnoreFilePaths()).toStrictEqual([]);
  });

  it('should initialize WorkspaceContext with includeDirectories', () => {
    const includeDirectories = ['dir1', 'dir2'];
    const paramsWithIncludeDirs: ConfigParameters = {
      ...baseParams,
      includeDirectories,
    };
    const config = new Config(paramsWithIncludeDirs);
    const workspaceContext = config.getWorkspaceContext();
    const directories = workspaceContext.getDirectories();

    // Should include only the target directory initially
    expect(directories).toHaveLength(1);
    expect(directories).toContain(path.resolve(baseParams.targetDir));

    // The other directories should be in the pending list
    expect(config.getPendingIncludeDirectories()).toEqual(includeDirectories);
  });

  it('should have a getFileService method that returns FileDiscoveryService', () => {
    const config = new Config(baseParams);
    const fileService = config.getFileService();
    expect(fileService).toBeDefined();
  });

  it('should pass file filtering options to FileDiscoveryService', () => {
    const configParams = {
      ...baseParams,
      fileFiltering: {
        respectGitIgnore: false,
        respectBrandIgnore: false,
        customIgnoreFilePaths: ['.myignore'],
      },
    };

    const config = new Config(configParams);
    config.getFileService();

    expect(FileDiscoveryService).toHaveBeenCalledWith(
      path.resolve(TARGET_DIR),
      {
        respectGitIgnore: false,
        respectBrandIgnore: false,
        customIgnoreFilePaths: ['.myignore'],
      },
    );
  });

  it('refreshes file discovery without replacing the file system after switching checkouts', () => {
    const config = new Config(baseParams);
    const initialFileService = config.getFileService();
    const initialFileSystemService = config.getFileSystemService();

    config.setTargetDir('/worktree/apps/desktop');
    config.setWorkingDir('/worktree/apps/desktop');
    config.refreshRuntimeWorkspaceServices();

    const worktreeFileService = config.getFileService();
    const worktreeFileSystemService = config.getFileSystemService();

    expect(worktreeFileService).not.toBe(initialFileService);
    expect(worktreeFileSystemService).toBe(initialFileSystemService);
    expect(FileDiscoveryService).toHaveBeenLastCalledWith(
      '/worktree/apps/desktop',
      expect.any(Object),
    );
  });

  it('preserves a custom file system service while switching checkouts', () => {
    const config = new Config(baseParams);
    const customFileSystemService = {} as FileSystemService;
    config.setFileSystemService(customFileSystemService);

    config.setTargetDir('/worktree/apps/desktop');
    config.setWorkingDir('/worktree/apps/desktop');
    config.refreshRuntimeWorkspaceServices();

    expect(config.getFileSystemService()).toBe(customFileSystemService);
  });


  describe('Plan Settings', () => {
    const testCases = [
      {
        name: 'should pass custom plan directory to storage',
        planSettings: { directory: 'custom-plans' },
        expected: 'custom-plans',
      },
      {
        name: 'should call setCustomPlansDir with undefined if directory is not provided',
        planSettings: {},
        expected: undefined,
      },
      {
        name: 'should call setCustomPlansDir with undefined if planSettings is not provided',
        planSettings: undefined,
        expected: undefined,
      },
    ];

    testCases.forEach(({ name, planSettings, expected }) => {
      it(`${name}`, () => {
        const setCustomPlansDirSpy = vi.spyOn(
          Storage.prototype,
          'setCustomPlansDir',
        );
        new Config({
          ...baseParams,
          planSettings,
        });

        expect(setCustomPlansDirSpy).toHaveBeenCalledWith(expected);
        setCustomPlansDirSpy.mockRestore();
      });
    });
  });


  describe('UseRipgrep Configuration', () => {
    it('should default useRipgrep to true when not provided', () => {
      const config = new Config(baseParams);
      expect(config.getUseRipgrep()).toBe(true);
    });

    it('should set useRipgrep to false when provided as false', () => {
      const paramsWithRipgrep: ConfigParameters = {
        ...baseParams,
        useRipgrep: false,
      };
      const config = new Config(paramsWithRipgrep);
      expect(config.getUseRipgrep()).toBe(false);
    });

    it('should set useRipgrep to true when explicitly provided as true', () => {
      const paramsWithRipgrep: ConfigParameters = {
        ...baseParams,
        useRipgrep: true,
      };
      const config = new Config(paramsWithRipgrep);
      expect(config.getUseRipgrep()).toBe(true);
    });

    it('should default useRipgrep to true when undefined', () => {
      const paramsWithUndefinedRipgrep: ConfigParameters = {
        ...baseParams,
        useRipgrep: undefined,
      };
      const config = new Config(paramsWithUndefinedRipgrep);
      expect(config.getUseRipgrep()).toBe(true);
    });
  });

  describe('UseAlternateBuffer Configuration', () => {
    it('should default useAlternateBuffer to false when not provided', () => {
      const config = new Config(baseParams);
      expect(config.getUseAlternateBuffer()).toBe(false);
    });

    it('should set useAlternateBuffer to true when provided as true', () => {
      const paramsWithAlternateBuffer: ConfigParameters = {
        ...baseParams,
        useAlternateBuffer: true,
      };
      const config = new Config(paramsWithAlternateBuffer);
      expect(config.getUseAlternateBuffer()).toBe(true);
    });

    it('should set useAlternateBuffer to false when explicitly provided as false', () => {
      const paramsWithAlternateBuffer: ConfigParameters = {
        ...baseParams,
        useAlternateBuffer: false,
      };
      const config = new Config(paramsWithAlternateBuffer);
      expect(config.getUseAlternateBuffer()).toBe(false);
    });
  });

  describe('Event Driven Scheduler Configuration', () => {
    it('should default enableEventDrivenScheduler to true when not provided', () => {
      const config = new Config(baseParams);
      expect(config.isEventDrivenSchedulerEnabled()).toBe(true);
    });

    it('should set enableEventDrivenScheduler to false when provided as false', () => {
      const params: ConfigParameters = {
        ...baseParams,
        enableEventDrivenScheduler: false,
      };
      const config = new Config(params);
      expect(config.isEventDrivenSchedulerEnabled()).toBe(false);
    });
  });

  describe('Shell Tool Inactivity Timeout', () => {
    it('should default to 300000ms (300 seconds) when not provided', () => {
      const config = new Config(baseParams);
      expect(config.getShellToolInactivityTimeout()).toBe(300000);
    });

    it('should convert provided seconds to milliseconds', () => {
      const params: ConfigParameters = {
        ...baseParams,
        shellToolInactivityTimeout: 10, // 10 seconds
      };
      const config = new Config(params);
      expect(config.getShellToolInactivityTimeout()).toBe(10000);
    });
  });

  describe('ContinueOnFailedApiCall Configuration', () => {
    it('should default continueOnFailedApiCall to false when not provided', () => {
      const config = new Config(baseParams);
      expect(config.getContinueOnFailedApiCall()).toBe(true);
    });

    it('should set continueOnFailedApiCall to true when provided as true', () => {
      const paramsWithContinueOnFailedApiCall: ConfigParameters = {
        ...baseParams,
        continueOnFailedApiCall: true,
      };
      const config = new Config(paramsWithContinueOnFailedApiCall);
      expect(config.getContinueOnFailedApiCall()).toBe(true);
    });

    it('should set continueOnFailedApiCall to false when explicitly provided as false', () => {
      const paramsWithContinueOnFailedApiCall: ConfigParameters = {
        ...baseParams,
        continueOnFailedApiCall: false,
      };
      const config = new Config(paramsWithContinueOnFailedApiCall);
      expect(config.getContinueOnFailedApiCall()).toBe(false);
    });
  });

  describe('createToolRegistry', () => {
    describe('CodeMode feature gate', () => {
      beforeEach(() => {
        vi.stubEnv(CODE_MODE_FEATURE_ENV, undefined);
      });

      afterEach(() => {
        vi.mocked(codeModeSettings.isCodeModeSupported).mockRestore();
        configSourceMocks.ensureConfigReadyForRequest.mockReset();
        vi.unstubAllEnvs();
      });

      it.each([
        { gate: undefined, mode: 'on', supported: true, expected: undefined },
        { gate: false, mode: 'only', supported: true, expected: undefined },
        { gate: 'invalid', mode: 'on', supported: true, expected: undefined },
        { gate: true, mode: 'off', supported: true, expected: undefined },
        { gate: true, mode: undefined, supported: true, expected: undefined },
        { gate: true, mode: 'on', supported: true, expected: 'on' },
        { gate: true, mode: 'only', supported: true, expected: 'only' },
        { gate: true, mode: 'on', supported: false, expected: undefined },
        {
          gate: { enabled: true, defaultMode: 'on' },
          mode: undefined,
          supported: true,
          expected: 'on',
        },
        {
          gate: { enabled: true, defaultMode: 'only' },
          mode: undefined,
          supported: true,
          expected: 'only',
        },
        {
          gate: { enabled: true, defaultMode: 'off' },
          mode: undefined,
          supported: true,
          expected: undefined,
        },
        {
          gate: { enabled: true, defaultMode: 'invalid' },
          mode: undefined,
          supported: true,
          expected: undefined,
        },
        {
          gate: { enabled: true, defaultMode: 'on' },
          mode: 'off',
          supported: true,
          expected: undefined,
        },
        {
          gate: { enabled: true, defaultMode: 'on' },
          mode: 'only',
          supported: true,
          expected: 'only',
        },
        {
          gate: { enabled: true, defaultMode: 'only' },
          mode: 'on',
          supported: true,
          expected: 'on',
        },
        {
          gate: { enabled: true, defaultMode: 'off' },
          mode: 'on',
          supported: true,
          expected: 'on',
        },
        {
          gate: { enabled: false, defaultMode: 'on' },
          mode: undefined,
          supported: true,
          expected: undefined,
        },
        {
          gate: { enabled: false, defaultMode: 'on' },
          mode: 'on',
          supported: true,
          expected: undefined,
        },
        {
          gate: { enabled: true, defaultMode: 'on' },
          mode: 'invalid',
          supported: true,
          expected: undefined,
        },
        {
          gate: { enabled: true, defaultMode: 'on' },
          mode: undefined,
          supported: false,
          expected: undefined,
        },
        {
          env: '1',
          gate: undefined,
          mode: undefined,
          supported: true,
          expected: 'on',
        },
        {
          env: '1',
          gate: undefined,
          mode: 'off',
          supported: true,
          expected: undefined,
        },
        {
          env: '1',
          gate: undefined,
          mode: 'only',
          supported: true,
          expected: 'only',
        },
        {
          env: '1',
          gate: undefined,
          mode: undefined,
          supported: false,
          expected: undefined,
        },
        {
          env: '1',
          gate: { enabled: false },
          mode: 'on',
          supported: true,
          expected: 'on',
        },
        {
          env: '1',
          gate: { enabled: true },
          mode: undefined,
          supported: true,
          expected: 'on',
        },
        {
          env: '1',
          gate: { enabled: true, defaultMode: 'off' },
          mode: undefined,
          supported: true,
          expected: undefined,
        },
        {
          env: '0',
          gate: { enabled: true, defaultMode: 'only' },
          mode: 'on',
          supported: true,
          expected: undefined,
        },
        {
          env: 'false',
          gate: { enabled: true, defaultMode: 'only' },
          mode: 'on',
          supported: true,
          expected: undefined,
        },
      ])(
        'gates registration and exposure together: %j',
        async ({ env, gate, mode, supported, expected }) => {
          vi.stubEnv(CODE_MODE_FEATURE_ENV, env);
          vi.spyOn(codeModeSettings, 'isCodeModeSupported').mockReturnValue(
            supported,
          );
          setConfigClient({
            getValue: (_namespace, key) =>
              key === CODE_MODE_FEATURE_GATE ? gate : undefined,
          });
          const config = new Config({
            ...baseParams,
            getSetting: (section) =>
              section === 'codeMode' ? { mode } : undefined,
          });

          expect(config.getCodeModeExposure()).toBe(expected);
          await config.initialize();

          const registered = vi
            .mocked(ToolRegistry.prototype.registerTool)
            .mock.calls.map(([tool]) => tool.name);
          expect(registered.includes('CodeMode')).toBe(expected !== undefined);
          expect(registered.includes('CodeModeWait')).toBe(expected !== undefined);
          expect(config.getCodeModeExposure()).toBe(expected);
          expect(
            configSourceMocks.ensureConfigReadyForRequest,
          ).toHaveBeenCalledTimes(
            supported && (mode === undefined || mode === 'on' || mode === 'only')
              ? 1
              : 0,
          );
        },
      );

      it.each(['on', undefined])(
        'waits for the initial gate value before registering CodeMode with local mode %s',
        async (mode) => {
          vi.spyOn(codeModeSettings, 'isCodeModeSupported').mockReturnValue(true);
          let release!: () => void;
          configSourceMocks.ensureConfigReadyForRequest.mockImplementationOnce(
            () =>
              new Promise<void>((resolve) => {
                release = resolve;
              }),
          );
          const config = new Config({
            ...baseParams,
            getSetting: (section) =>
              section === 'codeMode' && mode !== undefined ? { mode } : undefined,
          });
          const initializing = config.initialize();
          await vi.waitFor(() => expect(release).toBeDefined());
          const register = vi.mocked(ToolRegistry.prototype.registerTool);
          expect(
            register.mock.calls.some(([tool]) => tool.name === 'CodeMode'),
          ).toBe(false);
          setConfigClient({
            getValue: (_namespace, key) =>
              key === CODE_MODE_FEATURE_GATE
                ? { enabled: true, defaultMode: 'on' }
                : undefined,
          });
          release();
          await initializing;
          expect(
            register.mock.calls.some(([tool]) => tool.name === 'CodeMode'),
          ).toBe(true);
          expect(config.getCodeModeExposure()).toBe('on');
        },
      );

      it('exposes the current gate for settings independently of a locally disabled mode', async () => {
        vi.spyOn(codeModeSettings, 'isCodeModeSupported').mockReturnValue(true);
        let enabled: boolean | undefined;
        setConfigClient({
          getValue: (_namespace, key) =>
            key === CODE_MODE_FEATURE_GATE ? enabled : undefined,
        });
        const config = new Config({
          ...baseParams,
          getSetting: (section) =>
            section === 'codeMode' ? { mode: 'off' } : undefined,
        });
        await config.initialize();
        expect(config.isCodeModeFeatureGateEnabled()).toBe(false);
        enabled = true;
        expect(config.isCodeModeFeatureGateEnabled()).toBe(true);
        expect(config.getCodeModeExposure()).toBeUndefined();
        enabled = false;
        expect(config.isCodeModeFeatureGateEnabled()).toBe(false);
        vi.stubEnv(CODE_MODE_FEATURE_ENV, '1');
        expect(config.isCodeModeFeatureGateEnabled()).toBe(true);
        enabled = true;
        vi.stubEnv(CODE_MODE_FEATURE_ENV, '0');
        expect(config.isCodeModeFeatureGateEnabled()).toBe(false);
      });

      it('reports what an unset local mode resolves to on the next start', async () => {
        const supported = vi
          .spyOn(codeModeSettings, 'isCodeModeSupported')
          .mockReturnValue(true);
        let gate: unknown;
        setConfigClient({
          getValue: (_namespace, key) =>
            key === CODE_MODE_FEATURE_GATE ? gate : undefined,
        });
        const config = new Config({
          ...baseParams,
          getSetting: (section) =>
            section === 'codeMode' ? { mode: 'off' } : undefined,
        });
        await config.initialize();
        expect(config.getCodeModeDefaultMode()).toBe('off');
        gate = { enabled: true, defaultMode: 'only' };
        expect(config.getCodeModeDefaultMode()).toBe('only');
        gate = { enabled: false, defaultMode: 'only' };
        expect(config.getCodeModeDefaultMode()).toBe('off');
        vi.stubEnv(CODE_MODE_FEATURE_ENV, '1');
        gate = undefined;
        expect(config.getCodeModeDefaultMode()).toBe('on');
        supported.mockReturnValue(false);
        expect(config.getCodeModeDefaultMode()).toBe('off');
      });

      it('keeps CodeMode disabled if configuration readiness fails', async () => {
        vi.spyOn(codeModeSettings, 'isCodeModeSupported').mockReturnValue(true);
        setConfigClient({ getValue: () => true });
        configSourceMocks.ensureConfigReadyForRequest.mockRejectedValueOnce(
          new Error('unavailable'),
        );
        const config = new Config({
          ...baseParams,
          getSetting: (section) =>
            section === 'codeMode' ? { mode: 'only' } : undefined,
        });
        await config.initialize();
        expect(config.getCodeModeExposure()).toBeUndefined();
        expect(
          vi
            .mocked(ToolRegistry.prototype.registerTool)
            .mock.calls.some(
              ([tool]) => tool.name === 'CodeMode' || tool.name === 'CodeModeWait',
            ),
        ).toBe(false);
      });

      it.each([false, true])(
        'keeps the gate snapshot %s for this session and reads updates in new sessions',
        async (initial) => {
          vi.spyOn(codeModeSettings, 'isCodeModeSupported').mockReturnValue(true);
          let enabled = initial;
          setConfigClient({
            getValue: (_namespace, key) =>
              key === CODE_MODE_FEATURE_GATE ? enabled : undefined,
          });
          const params = {
            ...baseParams,
            getSetting: (section: string) =>
              section === 'codeMode' ? { mode: 'only' } : undefined,
          };
          const first = new Config(params);
          await first.initialize();
          enabled = !initial;
          expect(first.getCodeModeExposure()).toBe(initial ? 'only' : undefined);
          const register = vi.mocked(ToolRegistry.prototype.registerTool);
          register.mockClear();
          await first.createToolRegistry();
          expect(
            register.mock.calls.some(([tool]) => tool.name === 'CodeMode'),
          ).toBe(initial);
          const second = new Config(params);
          await second.initialize();
          expect(second.getCodeModeExposure()).toBe(initial ? undefined : 'only');
          expect(first.getCodeModeExposure()).toBe(initial ? 'only' : undefined);
        },
      );

      it('keeps the remote default stable in existing sessions when it changes', async () => {
        vi.spyOn(codeModeSettings, 'isCodeModeSupported').mockReturnValue(true);
        let defaultMode = 'on';
        setConfigClient({
          getValue: (_namespace, key) =>
            key === CODE_MODE_FEATURE_GATE
              ? { enabled: true, defaultMode }
              : undefined,
        });
        const first = new Config(baseParams);
        await first.initialize();
        expect(first.getCodeModeExposure()).toBe('on');
        defaultMode = 'only';
        const second = new Config(baseParams);
        await second.initialize();
        expect(second.getCodeModeExposure()).toBe('only');
        expect(first.getCodeModeExposure()).toBe('on');
      });
    });

    it('keeps shell capabilities isolated across interleaved Config initialization and registry rebuilds', async () => {
      const gates = await import('../tools/powerShellFeatureGate.js');
      const runtime = await import('../utils/shell/powerShell.js');
      const resolve = vi
        .spyOn(gates, 'resolveShellCapabilitySnapshot')
        .mockResolvedValueOnce({
          platform: 'windows',
          hasGitBash: false,
          override: undefined,
          qcsEnabled: true,
          exposeBash: false,
          exposePowerShell: true,
          defaultShell: 'powershell',
        })
        .mockResolvedValueOnce({
          platform: 'windows',
          hasGitBash: true,
          override: undefined,
          qcsEnabled: false,
          exposeBash: true,
          exposePowerShell: false,
          defaultShell: 'bash',
        });
      const probe = vi
        .spyOn(runtime, 'getPowerShellRuntime')
        .mockResolvedValue({ executable: '/test/pwsh', edition: 'core' });
      try {
        const first = new Config({ ...baseParams, interactive: true });
        const second = new Config({ ...baseParams, interactive: true });
        await first.initialize();
        await second.initialize();
        expect(first.getDefaultShellToolName()).toBe('PowerShell');
        expect(second.getDefaultShellToolName()).toBe('Bash');
        const { ToolRegistry } = await vi.importMock<
          typeof import('../tools/tool-registry.js')
        >('../tools/tool-registry');
        const register = vi.mocked(ToolRegistry.prototype.registerTool);
        register.mockClear();
        await first.createToolRegistry();
        const firstNames = register.mock.calls.map(([tool]) => tool.name);
        expect(firstNames).toContain('PowerShell');
        expect(
          register.mock.calls.some(
            ([tool]) => tool instanceof vi.mocked(ShellTool),
          ),
        ).toBe(false);
        register.mockClear();
        await second.createToolRegistry();
        const secondNames = register.mock.calls.map(([tool]) => tool.name);
        expect(
          register.mock.calls.some(
            ([tool]) => tool instanceof vi.mocked(ShellTool),
          ),
        ).toBe(true);
        expect(secondNames).not.toContain('PowerShell');
        expect(resolve).toHaveBeenCalledTimes(2);
      } finally {
        resolve.mockRestore();
        probe.mockRestore();
      }
    });

    it.each([
      { interactive: true, acpMode: true, enabled: true },
      { interactive: true, acpMode: true, enabled: false },
      { interactive: true, acpMode: false, enabled: true },
      { interactive: true, acpMode: false, enabled: false },
      { interactive: false, acpMode: false, enabled: true },
      { interactive: false, acpMode: false, enabled: false },
    ])(
      'honors QCS without Bash for every Windows host: %j',
      async ({ enabled, ...host }) => {
        const qcs = await import(
          '../config-service/features/powerShellTool.js'
        );
        const gate = vi
          .spyOn(qcs, 'isPowerShellToolQcsEnabled')
          .mockReturnValue(enabled);
        const gates = await import('../tools/powerShellFeatureGate.js');
        const platform = await import('../utils/platform.js');
        const windowsPaths = await import('../utils/windowsPaths.js');
        const runtime = await import('../utils/shell/powerShell.js');
        const oldOverride = process.env[ENV_USE_POWERSHELL_TOOL];
        delete process.env[ENV_USE_POWERSHELL_TOOL];
        const snapshot = vi.spyOn(gates, 'resolveShellCapabilitySnapshot');
        const os = vi.spyOn(platform, 'getPlatform').mockReturnValue('windows');
        const bash = vi
          .spyOn(windowsPaths, 'probeGitBashPathSync')
          .mockReturnValue(null);
        const ps = vi
          .spyOn(runtime, 'getPowerShellRuntime')
          .mockResolvedValue({ executable: '/test/pwsh', edition: 'core' });
        try {
          const config = new Config({ ...baseParams, ...host });
          await config.initialize();
          expect(snapshot).toHaveBeenCalledWith();
          expect(config.getDefaultShellToolName()).toBe(
            enabled ? 'PowerShell' : 'Bash',
          );
          const { ToolRegistry } = await vi.importMock<
            typeof import('../tools/tool-registry.js')
          >('../tools/tool-registry');
          expect(
            vi
              .mocked(ToolRegistry.prototype.registerTool)
              .mock.calls.some(([tool]) => tool.name === 'PowerShell'),
          ).toBe(enabled);
          expect(
            vi
              .mocked(ToolRegistry.prototype.registerTool)
              .mock.calls.some(
                ([tool]) => tool instanceof vi.mocked(ShellTool),
              ),
          ).toBe(!enabled);
          if (!enabled) expect(ps).not.toHaveBeenCalled();
        } finally {
          gate.mockRestore();
          snapshot.mockRestore();
          os.mockRestore();
          bash.mockRestore();
          ps.mockRestore();
          if (oldOverride === undefined)
            delete process.env[ENV_USE_POWERSHELL_TOOL];
          else process.env[ENV_USE_POWERSHELL_TOOL] = oldOverride;
        }
      },
    );

    it.each([
      { acpMode: false, interactive: false, override: '', enabled: false },
      { acpMode: false, interactive: false, override: 'false', enabled: false },
      { acpMode: false, interactive: false, override: 'true', enabled: true },
      { acpMode: true, interactive: true, override: '', enabled: false },
      { acpMode: true, interactive: true, override: 'false', enabled: false },
      { acpMode: true, interactive: true, override: 'true', enabled: true },
    ])(
      'registers the PowerShell protocol schema on explicit non-Windows opt-in: $acpMode / $override',
      async ({ override, enabled, ...host }) => {
        const runtime = await import('../utils/shell/powerShell.js');
        const platform = await import('../utils/platform.js');
        const oldOverride = process.env[ENV_USE_POWERSHELL_TOOL];
        process.env[ENV_USE_POWERSHELL_TOOL] = override;
        const probe = vi
          .spyOn(runtime, 'getPowerShellRuntime')
          .mockResolvedValue({ executable: '/test/pwsh', edition: 'core' });
        const platformProbe = vi
          .spyOn(platform, 'getPlatform')
          .mockReturnValue('macos');
        try {
          const config = new Config({ ...baseParams, ...host });
          await config.initialize();
          const { ToolRegistry } = await vi.importMock<
            typeof import('../tools/tool-registry.js')
          >('../tools/tool-registry');
          const registered = vi
            .mocked(ToolRegistry.prototype.registerTool)
            .mock.calls.map(([tool]) => tool)
            .find((tool) => tool.name === 'PowerShell');
          expect(Boolean(registered)).toBe(enabled);
          if (enabled) {
            const schema = JSON.parse(JSON.stringify(registered!.getSchema()));
            expect(schema).toMatchObject({
              name: 'PowerShell',
              parametersJsonSchema: {
                required: ['command'],
                additionalProperties: false,
              },
            });
            expect(Object.keys(schema.parametersJsonSchema.properties)).toEqual(
              ['command', 'timeout', 'description', 'run_in_background'],
            );
            expect(schema.description).toContain('PowerShell 7+');
          } else {
            expect(probe).not.toHaveBeenCalled();
          }
        } finally {
          probe.mockRestore();
          platformProbe.mockRestore();
          if (oldOverride === undefined)
            delete process.env[ENV_USE_POWERSHELL_TOOL];
          else process.env[ENV_USE_POWERSHELL_TOOL] = oldOverride;
        }
      },
    );

    it.each(['bash', 'powershell'] as const)(
      'handles a missing PowerShell runtime with default shell %s',
      async (defaultShell) => {
        const gates = await import('../tools/powerShellFeatureGate.js');
        const runtime = await import('../utils/shell/powerShell.js');
        const capabilities = {
          platform: 'windows' as const,
          hasGitBash: defaultShell === 'bash',
          override: true as const,
          qcsEnabled: false,
          exposeBash: defaultShell === 'bash',
          exposePowerShell: true,
          defaultShell,
        };
        const snapshot = vi
          .spyOn(gates, 'resolveShellCapabilitySnapshot')
          .mockResolvedValue(capabilities);
        const probe = vi
          .spyOn(runtime, 'getPowerShellRuntime')
          .mockResolvedValue(null);
        try {
          const config = new Config({ ...baseParams, interactive: true });
          await config.initialize();
          const { ToolRegistry } = await vi.importMock<
            typeof import('../tools/tool-registry.js')
          >('../tools/tool-registry');
          const calls = vi.mocked(ToolRegistry.prototype.registerTool).mock
            .calls;
          expect(calls.some(([tool]) => tool.name === 'PowerShell')).toBe(
            false,
          );
          expect(
            calls.some(([tool]) => tool instanceof vi.mocked(ShellTool)),
          ).toBe(true);
          expect(config.getDefaultShellToolName()).toBe('Bash');
          expect(capabilities.exposePowerShell).toBe(false);
          expect(capabilities.exposeBash).toBe(true);
        } finally {
          snapshot.mockRestore();
          probe.mockRestore();
        }
      },
    );

    it('should register all tools unconditionally (deny handled by permission context)', async () => {
      const params: ConfigParameters = {
        ...baseParams,
        coreTools: ['ShellTool(git status)'],
      };
      const config = new Config(params);
      await config.initialize();

      const registerToolMock = (
        (await vi.importMock('../tools/tool-registry')) as {
          ToolRegistry: { prototype: { registerTool: Mock } };
        }
      ).ToolRegistry.prototype.registerTool;

      const wasShellToolRegistered = registerToolMock.mock.calls.some(
        (call) => call[0] instanceof vi.mocked(ShellTool),
      );
      expect(wasShellToolRegistered).toBe(true);

      const wasReadFileToolRegistered = registerToolMock.mock.calls.some(
        (call) => call[0] instanceof vi.mocked(ReadFileTool),
      );
      expect(wasReadFileToolRegistered).toBe(true);

      // Product tools must come from qoder, never the base Core registry.
      const registeredNames = registerToolMock.mock.calls.map(
        (call) => call[0].name,
      );
      expect(registeredNames).not.toContain('ImageSearch');
      expect(registeredNames).not.toContain('VideoGenRetrieve');
      expect(registeredNames).not.toContain('VideoGen');
      expect(registeredNames).not.toContain('WebSearch');
      expect(registeredNames).not.toContain('ImageGen');
    });

    it('should not register Bash PTY tools unless the feature gate is enabled', async () => {
      delete process.env[ENV_ENABLE_BASH_PTY_TOOLS];
      const config = new Config(baseParams);
      await config.initialize();

      const registerToolMock = (
        (await vi.importMock('../tools/tool-registry')) as {
          ToolRegistry: { prototype: { registerTool: Mock } };
        }
      ).ToolRegistry.prototype.registerTool;

      const registeredTools = registerToolMock.mock.calls.map(
        (call) => call[0].constructor.name,
      );
      expect(registeredTools).not.toContain('BashInputTool');
      expect(registeredTools).not.toContain('BashOutputTool');
      expect(registeredTools).not.toContain('BashResizeTool');
    });

    it('should register Bash PTY tools when the feature gate is enabled', async () => {
      process.env[ENV_ENABLE_BASH_PTY_TOOLS] = '1';
      const config = new Config(baseParams);
      await config.initialize();

      const registerToolMock = (
        (await vi.importMock('../tools/tool-registry')) as {
          ToolRegistry: { prototype: { registerTool: Mock } };
        }
      ).ToolRegistry.prototype.registerTool;

      const registeredTools = registerToolMock.mock.calls.map(
        (call) => call[0].constructor.name,
      );
      expect(registeredTools).toContain('BashInputTool');
      expect(registeredTools).toContain('BashOutputTool');
      expect(registeredTools).toContain('BashResizeTool');
    });

    it('should register WorkflowTool unconditionally', async () => {
      const config = new Config(baseParams);
      await config.initialize();

      const registerToolMock = (
        (await vi.importMock('../tools/tool-registry')) as {
          ToolRegistry: { prototype: { registerTool: Mock } };
        }
      ).ToolRegistry.prototype.registerTool;

      const registeredToolNames = registerToolMock.mock.calls.map(
        (call) => call[0].name,
      );
      expect(registeredToolNames).toContain(WORKFLOW_TOOL_NAME);
    });

    it('should register EnterPlanModeTool and ExitPlanModeTool when plan is enabled', async () => {
      const params: ConfigParameters = {
        ...baseParams,
        plan: true,
      };
      const config = new Config(params);

      await config.initialize();

      const registerToolMock = (
        (await vi.importMock('../tools/tool-registry')) as {
          ToolRegistry: { prototype: { registerTool: Mock } };
        }
      ).ToolRegistry.prototype.registerTool;

      const registeredTools = registerToolMock.mock.calls.map(
        (call) => call[0].constructor.name,
      );
      expect(registeredTools).toContain('EnterPlanModeTool');
      expect(registeredTools).toContain('ExitPlanModeTool');
    });
  });

  describe('getTruncateToolOutputThreshold', () => {
    let tokenCountSpy: MockInstance<() => number>;

    beforeEach(() => {
      vi.clearAllMocks();
      tokenCountSpy = vi.spyOn(uiTelemetryService, 'getLastPromptTokenCount');
    });

    afterEach(() => {
      tokenCountSpy.mockRestore();
    });

    it('should return the calculated threshold when it is smaller than the default', () => {
      const config = new Config(baseParams);
      vi.mocked(tokenLimit).mockReturnValue(32000);
      tokenCountSpy.mockReturnValue(
        1000,
      );
      // 4 * (32000 - 1000) = 4 * 31000 = 124000
      // default is 40_000, so min(124000, 40000) = 40000
      expect(config.getTruncateToolOutputThreshold(undefined)).toBe(40_000);
    });

    it('should return the default threshold when the calculated value is larger', () => {
      const config = new Config(baseParams);
      vi.mocked(tokenLimit).mockReturnValue(2_000_000);
      tokenCountSpy.mockReturnValue(
        500_000,
      );
      // 4 * (2_000_000 - 500_000) = 4 * 1_500_000 = 6_000_000
      // default is 40_000
      expect(config.getTruncateToolOutputThreshold(undefined)).toBe(40_000);
    });

    it('should use a custom truncateToolOutputThreshold if provided', () => {
      const customParams = {
        ...baseParams,
        truncateToolOutputThreshold: 50000,
      };
      const config = new Config(customParams);
      vi.mocked(tokenLimit).mockReturnValue(8000);
      tokenCountSpy.mockReturnValue(
        2000,
      );
      // 4 * (8000 - 2000) = 4 * 6000 = 24000
      // custom threshold is 50000
      expect(config.getTruncateToolOutputThreshold(undefined)).toBe(24000);

      vi.mocked(tokenLimit).mockReturnValue(32000);
      tokenCountSpy.mockReturnValue(
        1000,
      );
      // 4 * (32000 - 1000) = 124000
      // custom threshold is 50000
      expect(config.getTruncateToolOutputThreshold(undefined)).toBe(50000);
    });
  });

  it('should have independent TopicState across instances', () => {
    const config1 = new Config(baseParams);
    const config2 = new Config(baseParams);

    config1.topicState.setTopic('Topic 1');
    config2.topicState.setTopic('Topic 2');

    expect(config1.topicState.getTopic()).toBe('Topic 1');
    expect(config2.topicState.getTopic()).toBe('Topic 2');
  });
});

describe('setPermissionMode with folder trust', () => {
  const baseParams: ConfigParameters = {
    loadedSettings: createEmptyLoadedSettings(),
    sessionId: 'test',
    targetDir: '.',
    debugMode: false,
    model: 'test-model',
    cwd: '.',
  };

  it('should throw an error when setting bypass permissions mode in an untrusted folder', () => {
    const config = new Config(baseParams);
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(false);
    expect(() => config.setPermissionMode('yolo')).toThrow(
      'Cannot enable privileged permission modes in an untrusted folder.',
    );
  });

  it('should throw an error when setting AUTO_EDIT mode in an untrusted folder', () => {
    const config = new Config(baseParams);
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(false);
    expect(() => config.setPermissionMode('acceptEdits')).toThrow(
      'Cannot enable privileged permission modes in an untrusted folder.',
    );
  });

  it('should NOT throw an error when setting DEFAULT mode in an untrusted folder', () => {
    const config = new Config(baseParams);
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(false);
    expect(() => config.setPermissionMode('default')).not.toThrow();
  });

  it('should NOT throw an error when setting any mode in a trusted folder', () => {
    const config = new Config(baseParams);
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
    expect(() => config.setPermissionMode('yolo')).not.toThrow();
    expect(() => config.setPermissionMode('acceptEdits')).not.toThrow();
    expect(() => config.setPermissionMode('default')).not.toThrow();
  });

  it('should throw when setting bypass permissions mode if disableYoloMode is true', () => {
    const params = { ...baseParams, loadedSettings: createEmptyLoadedSettings() };
    params.loadedSettings.merged.security = {
      ...params.loadedSettings.merged.security,
      disableYoloMode: true,
    };
    const config = new Config(params);
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
    expect(() => config.setPermissionMode('yolo')).toThrow(
      BYPASS_PERMISSIONS_DISABLED_MESSAGE,
    );
    expect(config.getPermissionMode()).toBe('default');
  });

  it('should throw when constructed with bypass permissions mode and disableYoloMode', () => {
    const params = { ...baseParams, loadedSettings: createEmptyLoadedSettings() };
    params.loadedSettings.merged.security = {
      ...params.loadedSettings.merged.security,
      disableYoloMode: true,
    };
    expect(
      () => new Config({ ...params, permissionMode: 'yolo' }),
    ).toThrow(BYPASS_PERMISSIONS_DISABLED_MESSAGE);
  });

  it('refuses auto mode when the classifier model cannot be resolved', () => {
    const config = new Config(baseParams);
    attachTestPermission(config);
    vi.spyOn(config.permission!, 'getAutoJudgmentSettings').mockReturnValue({
      classifier: 'llm',
    });
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
    vi.spyOn(config, 'getModel').mockReturnValue('');

    expect(() => config.setPermissionMode('auto')).toThrow(
      AUTO_MODE_UNSUPPORTED_MESSAGE,
    );
    expect(config.getPermissionMode()).toBe('default');
  });

  it('allows a configured Jev without resolving the LLM classifier alias', () => {
    setConfigClient({
      getValue: (_namespace, key) =>
        key === 'auto_mode_jev' ? { enabled: true } : undefined,
    });
    const config = new Config(baseParams);
    attachTestPermission(config);
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
    vi.spyOn(config.permission!, 'getAutoJudgmentSettings').mockReturnValue({
      classifier: 'jev',
      judgment: {
        backend: 'typesafe',
        model: 'jev-1.13.0',
        baseUrl: 'https://api.typesafe.ai',
        apiKey: 'test-key',
      },
    });
    vi.spyOn(config, 'getModel').mockReturnValue('');
    expect(() => config.setPermissionMode('auto')).not.toThrow();
  });

  it('refuses unavailable Jev even when the LLM alias exists', () => {
    setConfigClient({
      getValue: (_namespace, key) =>
        key === 'auto_mode_jev' ? { enabled: true } : undefined,
    });
    const config = new Config(baseParams);
    attachTestPermission(config);
    vi.spyOn(config.permission!, 'getAutoJudgmentSettings').mockReturnValue({
      classifier: 'jev',
    });
    expect(() => config.setPermissionMode('auto')).toThrow(
      AUTO_MODE_UNSUPPORTED_MESSAGE,
    );
  });

  it('allows auto mode when the classifier model resolves', () => {
    const config = new Config(baseParams);
    attachTestPermission(config);
    vi.spyOn(config.permission!, 'getAutoJudgmentSettings').mockReturnValue({
      classifier: 'llm',
    });
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
    vi.spyOn(config, 'getModel').mockReturnValue('smodel');

    expect(() => config.setPermissionMode('auto')).not.toThrow();
    expect(config.getPermissionMode()).toBe('auto');
  });

  it('uses LLM availability while the Jev gate is off, even with invalid Judge settings', () => {
    setConfigClient(null);
    const config = new Config(baseParams);
    attachTestPermission(config);
    vi.spyOn(config.permission!, 'isAutoModeJevEnabled').mockReturnValue(false);
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
    vi.spyOn(config.permission!, 'getAutoJudgmentSettings').mockReturnValue({
      classifier: 'jev',
    });
    vi.spyOn(config, 'getModel').mockReturnValue('smodel');
    expect(() => config.setPermissionMode('auto')).not.toThrow();
  });

  it('does not use configured Jev availability to bypass an unavailable LLM when QCS is off', () => {
    setConfigClient(null);
    const config = new Config(baseParams);
    attachTestPermission(config);
    vi.spyOn(config.permission!, 'isAutoModeJevEnabled').mockReturnValue(false);
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
    vi.spyOn(config.permission!, 'getAutoJudgmentSettings').mockReturnValue({
      classifier: 'jev',
      judgment: { backend: 'bailian', model: 'pre-dashscope-jev-kev' },
    });
    vi.spyOn(config, 'getModel').mockReturnValue('');
    expect(() => config.setPermissionMode('auto')).toThrow(
      AUTO_MODE_UNSUPPORTED_MESSAGE,
    );
  });


  it('should reload hooks when trust is granted (so project hooks activate without restart)', async () => {
    const refreshedProjectHooks = {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: './after-trust.sh' }],
        },
      ],
    };
    const mockOnReload = vi.fn().mockResolvedValue({
      projectHooks: refreshedProjectHooks,
      localHooks: undefined,
      userHooks: undefined,
      hooks: undefined,
    });

    const config = new Config({
      ...baseParams,
      folderTrust: true,
      trustedFolder: false,
      permissionMode: 'default',
      onReload: mockOnReload,
    });
    setTestSessionPermission(config, makePermissionStub());

    expect(config.getProjectHooks()).toBeUndefined();

    config.setTrustedFolder(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockOnReload).toHaveBeenCalled();
    expect(config.getProjectHooks()).toEqual(refreshedProjectHooks);
  });

  it('should reload skills when folder trust is revoked', () => {
    const config = new Config({
      ...baseParams,
      folderTrust: true,
      trustedFolder: true,
      skillsSupport: true,
    });
    const reloadSkills = vi
      .spyOn(config, 'reloadSkills')
      .mockResolvedValue(undefined);

    config.setTrustedFolder(false);

    expect(reloadSkills).toHaveBeenCalledOnce();
  });

  it('should NOT throw an error when setting any mode if trustedFolder is undefined', () => {
    const config = new Config(baseParams);
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true); // isTrustedFolder defaults to true
    expect(() => config.setPermissionMode('yolo')).not.toThrow();
    expect(() => config.setPermissionMode('acceptEdits')).not.toThrow();
    expect(() => config.setPermissionMode('default')).not.toThrow();
  });

  it('should update system instruction when entering bypass permissions mode', async () => {
    const config = new Config(baseParams);
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
    vi.spyOn(config, 'getToolRegistry').mockReturnValue({
      getTool: vi.fn().mockReturnValue(undefined),
      unregisterTool: vi.fn(),
      registerTool: vi.fn(),
    } as Partial<ToolRegistry> as ToolRegistry);
    const updateSpy = vi.spyOn(config, 'updateSystemInstructionIfInitialized');

    config.setPermissionMode('yolo');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(updateSpy).toHaveBeenCalled();
  });

  it('should not update system instruction when switching between non-Plan/non-bypassPermissions modes', async () => {
    const config = new Config(baseParams);
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
    const updateSpy = vi.spyOn(config, 'updateSystemInstructionIfInitialized');

    config.setPermissionMode('acceptEdits');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('should return empty conversation messages without an active session owner', () => {
    const config = new Config(baseParams);

    expect(config.getConversationMessages()).toEqual([]);
  });

  it('should expose the registered conversation messages accessor', () => {
    const config = new Config(baseParams);
    const messages = [createUserMessage('hello')];

    config.registerForkContextAccessors({
      getConversationMessages: () => messages,
      getPromptBuildResult: () => undefined,
    });

    expect(config.getConversationMessages()).toBe(messages);
  });

  it('should route tool refresh through the registered session runtime binding', async () => {
    const config = new Config(baseParams);
    const refreshRuntimeContext = vi.fn();

    config.registerSessionRuntimeBinding({
      refreshRuntimeContext,
    });

    await config.refreshSessionToolsIfInitialized({
      resetModelRouting: true,
    });

    expect(refreshRuntimeContext).toHaveBeenCalledWith({
      refreshTools: true,
      resetModelRouting: true,
    });
  });

  it('should route thought stripping through the registered session runtime binding', () => {
    const config = new Config(baseParams);
    const stripThoughtsFromConversationHistory = vi.fn();

    config.registerSessionRuntimeBinding({
      refreshRuntimeContext: vi.fn(),
      stripThoughtsFromConversationHistory,
    });

    config.stripThoughtsFromConversationHistory();

    expect(stripThoughtsFromConversationHistory).toHaveBeenCalledWith();
  });

  it('should route session title persistence through the registered session runtime binding', async () => {
    const config = new Config(baseParams);
    const persistSessionTitle = vi.fn();

    config.registerSessionRuntimeBinding({
      refreshRuntimeContext: vi.fn(),
      persistSessionTitle,
    });

    await config.persistSessionTitle('Plan approved title');

    expect(persistSessionTitle).toHaveBeenCalledWith('Plan approved title');
  });

  it('should route worktree state appends through the registered session runtime binding', async () => {
    const config = new Config(baseParams);
    const recordWorktreeState = vi.fn();
    const state = {
      originalCwd: '/workspace/demo',
      worktreePath: '/workspace/demo/.qwen/worktrees/feature',
      worktreeCwd: '/workspace/demo/.qwen/worktrees/feature/apps/desktop',
      worktreeName: 'feature',
      sessionId: 'session-wt-1',
    };

    config.registerSessionRuntimeBinding({
      refreshRuntimeContext: vi.fn(),
      recordWorktreeState,
    });

    await config.recordWorktreeState(state);
    await config.recordWorktreeState(null);

    expect(recordWorktreeState).toHaveBeenNthCalledWith(1, state);
    expect(recordWorktreeState).toHaveBeenNthCalledWith(2, null);
  });


  describe('registerCoreTools', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should always register RipGrepTool', async () => {
      const config = new Config({ ...baseParams, useRipgrep: true });
      await config.initialize();

      const calls = vi.mocked(ToolRegistry.prototype.registerTool).mock.calls;
      const wasRipGrepRegistered = calls.some(
        (call) => call[0] instanceof vi.mocked(RipGrepTool),
      );

      expect(wasRipGrepRegistered).toBe(true);
    });

    it('should register RipGrepTool even when useRipgrep is false', async () => {
      const config = new Config({ ...baseParams, useRipgrep: false });
      await config.initialize();

      const calls = vi.mocked(ToolRegistry.prototype.registerTool).mock.calls;
      const wasRipGrepRegistered = calls.some(
        (call) => call[0] instanceof vi.mocked(RipGrepTool),
      );

      expect(wasRipGrepRegistered).toBe(true);
    });
  });
});

describe('isYoloModeDisabled', () => {
  const baseParams: ConfigParameters = {
    loadedSettings: createEmptyLoadedSettings(),
    sessionId: 'test',
    targetDir: '.',
    debugMode: false,
    model: 'test-model',
    cwd: '.',
  };

  it('should return false when bypass permissions mode is not disabled and folder is trusted', () => {
    const config = new Config(baseParams);
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
    expect(config.isYoloModeDisabled()).toBe(false);
  });

  it('should return true when bypass permissions mode is disabled by settings', () => {
    const params = { ...baseParams, loadedSettings: createEmptyLoadedSettings() };
    params.loadedSettings.merged.security = {
      ...params.loadedSettings.merged.security,
      disableYoloMode: true,
    };
    const config = new Config(params);
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
    expect(config.isYoloModeDisabled()).toBe(true);
  });

  it('should return true when folder is untrusted', () => {
    const config = new Config(baseParams);
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(false);
    expect(config.isYoloModeDisabled()).toBe(true);
  });

  it('should return true when bypass permissions is disabled and folder is untrusted', () => {
    const params = { ...baseParams, loadedSettings: createEmptyLoadedSettings() };
    params.loadedSettings.merged.security = {
      ...params.loadedSettings.merged.security,
      disableYoloMode: true,
    };
    const config = new Config(params);
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(false);
    expect(config.isYoloModeDisabled()).toBe(true);
  });
});

describe('Config getHooks', () => {
  const baseParams: ConfigParameters = {
    loadedSettings: createEmptyLoadedSettings(),
    cwd: '/tmp',
    targetDir: '/path/to/target',
    debugMode: false,
    sessionId: 'test-session-id',
    model: 'gemini-pro',
  };

  it('should return undefined when no hooks are provided', () => {
    const config = new Config(baseParams);
    expect(config.getHooks()).toBeUndefined();
  });

  it('should return empty object when empty hooks are provided', () => {
    const configWithEmptyHooks = new Config({
      ...baseParams,
      hooks: {},
    });
    expect(configWithEmptyHooks.getHooks()).toEqual({});
  });

  it('should return the hooks configuration when provided', () => {
    const mockHooks = {
      PreToolUse: [
        {
          hooks: [{ type: HookType.Command, command: 'echo 1' } as const],
        },
      ],
    };
    const config = new Config({ ...baseParams, hooks: mockHooks });
    const retrievedHooks = config.getHooks();
    expect(retrievedHooks).toEqual(mockHooks);
  });

  it('should return hooks with all supported event types', () => {
    const allEventHooks: { [K in HookEventName]?: HookDefinition[] } = {
      [HookEventName.SubagentStart]: [
        { hooks: [{ type: HookType.Command, command: 'test1' }] },
      ],
      [HookEventName.SubagentStop]: [
        { hooks: [{ type: HookType.Command, command: 'test2' }] },
      ],
      [HookEventName.PreToolUse]: [
        { hooks: [{ type: HookType.Command, command: 'test3' }] },
      ],
      [HookEventName.PostToolUse]: [
        { hooks: [{ type: HookType.Command, command: 'test4' }] },
      ],
      [HookEventName.Notification]: [
        { hooks: [{ type: HookType.Command, command: 'test8' }] },
      ],
      [HookEventName.SessionStart]: [
        { hooks: [{ type: HookType.Command, command: 'test9' }] },
      ],
      [HookEventName.SessionEnd]: [
        { hooks: [{ type: HookType.Command, command: 'test10' }] },
      ],
      [HookEventName.PreCompact]: [
        { hooks: [{ type: HookType.Command, command: 'test11' }] },
      ],
    };

    const config = new Config({
      ...baseParams,
      hooks: allEventHooks,
    });

    const retrievedHooks = config.getHooks();
    expect(retrievedHooks).toEqual(allEventHooks);
    expect(Object.keys(retrievedHooks!)).toHaveLength(8); // All hook event types
  });

  describe('setModel', () => {
    it('reports persistence failure while keeping the session model and allows retry', async () => {
      const onModelChange = vi.fn().mockReturnValue(false);
      const config = new Config({ ...baseParams, onModelChange });
      await config.getModelProviderManager().start();
      expect(await config.setModel('ultimate', false)).toBe(false);
      expect(config.getModel()).toBe('ultimate');
      expect(config.getActiveModel()).toBe('ultimate');
      onModelChange.mockReturnValue(true);
      expect(await config.setModel('ultimate', false)).toBe(true);
      onModelChange.mockClear();
      expect(await config.setModel('auto', true)).toBe(true);
      expect(onModelChange).not.toHaveBeenCalled();
    });
    it('should allow setting a pro (any) model and reset availability', async () => {
      const config = new Config(baseParams);
      await config.getModelProviderManager().start();
      const service = config.getModelAvailabilityService();
      const spy = vi.spyOn(service, 'reset');

      const proModel = 'gemini-2.5-pro';
      await config.setModel(proModel);

      expect(config.getModel()).toBe(proModel);
      expect(mockCoreEvents.emitModelChanged).toHaveBeenCalledWith(
        expect.any(String),
        proModel,
      );
      expect(spy).toHaveBeenCalled();
    });

    it('should allow setting auto model from non-auto model and reset availability', async () => {
      const config = new Config(baseParams);
      await config.getModelProviderManager().start();
      const service = config.getModelAvailabilityService();
      const spy = vi.spyOn(service, 'reset');

      await config.setModel('auto');

      expect(config.getModel()).toBe('auto');
      expect(mockCoreEvents.emitModelChanged).toHaveBeenCalledWith(
        expect.any(String),
        'auto',
      );
      expect(spy).toHaveBeenCalled();
    });

    it('should allow setting auto model from auto model and reset availability', async () => {
      const config = new Config({
        loadedSettings: createEmptyLoadedSettings(),
        cwd: '/tmp',
        targetDir: '/path/to/target',
        debugMode: false,
        sessionId: 'test-session-id',
        model: 'auto',
      });
      await config.getModelProviderManager().start();
      const service = config.getModelAvailabilityService();
      const spy = vi.spyOn(service, 'reset');

      await config.setModel('auto');

      expect(config.getModel()).toBe('auto');
      expect(spy).toHaveBeenCalled();
    });

    it('should reset active model when setModel is called with the current model after a fallback', async () => {
      const config = new Config(baseParams);
      const originalModel = config.getModel();
      const fallbackModel = 'fallback-model';

      config.setActiveModel(fallbackModel);
      expect(config.getActiveModel()).toBe(fallbackModel);

      await config.setModel(originalModel);

      expect(config.getModel()).toBe(originalModel);
      expect(config.getActiveModel()).toBe(originalModel);
    });

    it('should call onModelChange when a new model is set and should persist', async () => {
      const onModelChange = vi.fn();
      const config = new Config({
        ...baseParams,
        onModelChange,
      });

      await config.setModel(DEFAULT_MODEL, false);

      expect(onModelChange).toHaveBeenCalledWith(DEFAULT_MODEL);
    });

    it('should NOT call onModelChange when a new model is temporary', async () => {
      const onModelChange = vi.fn();
      const config = new Config({
        ...baseParams,
        onModelChange,
      });

      await config.setModel(DEFAULT_MODEL, true);

      expect(onModelChange).not.toHaveBeenCalled();
    });

    it('should call onModelChange when persisting a model that was previously temporary', async () => {
      const onModelChange = vi.fn();
      const config = new Config({
        ...baseParams,
        model: 'some-other-model',
        onModelChange,
      });

      // Temporary selection
      await config.setModel(DEFAULT_MODEL, true);
      expect(onModelChange).not.toHaveBeenCalled();

      // Persist selection of the same model
      await config.setModel(DEFAULT_MODEL, false);
      expect(onModelChange).toHaveBeenCalledWith(DEFAULT_MODEL);
    });
  });

  describe('provider-owned preferences', () => {
    const configs: Config[] = [];
    afterEach(async () => {
      await Promise.all(configs.splice(0).map((config) => config.dispose()));
      vi.unstubAllEnvs();
    });
    function setup(
      overrides: Partial<ConfigParameters> = {},
      preferences: Record<string, unknown> = {
        'local/main': {
          reasoning: { effort: 'low' },
          temperature: 0.2,
          contextWindow: 64000,
        },
      },
    ) {
      const settingsService = new SettingsService();
      const source = {
        read: () => JSON.stringify({ model: { preferences } }),
        mutate: vi.fn(),
      };
      vi.spyOn(settingsService, 'peekUserSettingsSource').mockReturnValue(
        source as never,
      );
      const main: Model = {
        key: 'local/main',
        source: 'local',
        displayName: 'Main',
        capabilities: {
          tools: true,
          vision: false,
          reasoning: {
            supported: true,
            supportedEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
          },
          contextWindows: [{ tokens: 64000 }, { tokens: 128000 }],
        },
        limits: { maxContextTokens: 128000 },
        defaultModelConfig: { reasoning: { effort: 'medium' } },
      };
      const other = { ...main, key: 'local/other', displayName: 'Other' };
      const transportManager = new ModelTransportManager([
        { protocol: OPENAI_CHAT_COMPLETIONS, stream: vi.fn() },
      ]);
      const providerConfig = new CustomProviderConfig({
        providerId: 'local',
        baseUrl: 'https://unused.invalid',
        protocol: OPENAI_CHAT_COMPLETIONS,
        models: [main, other],
        routing: {},
      });
      const providers: CustomModelProvider[] = [];
      const factory = () => {
        const provider = new CustomModelProvider({
          transportManager,
          config: providerConfig,
          client: {} as CustomClient,
          settingsService,
          scope: 'user',
        });
        providers.push(provider);
        return [provider];
      };
      const createConfig = () => {
        const config = new Config({
          ...baseParams,
          model: main.key,
          settingsService,
          modelProviderFactory: factory,
          ...overrides,
        });
        configs.push(config);
        return config;
      };
      return {
        config: createConfig(),
        createConfig,
        providers,
        main,
        other,
        source,
      };
    }
    async function listed(config: Config, key: string): Promise<Model> {
      const model = await config.getModelProviderManager().getModel(key);
      if (!model) throw new Error(`model ${key} not listed`);
      return model;
    }

    it('共享 SettingsService 的项目 provider 按各 Config 的 cwd 装配', () => {
      const settingsService = new SettingsService();
      const sources = vi
        .spyOn(settingsService, 'getProjectSettingsSources')
        .mockReturnValue({
          project: { read: () => undefined },
          local: { read: () => undefined },
        } as never);
      const modelTransportManager = new ModelTransportManager([]);
      for (const cwd of [
        '/tmp/provider-session-a',
        '/tmp/provider-session-b',
      ]) {
        const config = new Config({
          ...baseParams,
          cwd,
          settingsService,
          modelTransportManager,
        });
        configs.push(config);
        const storage = new Storage(cwd);
        expect(sources).toHaveBeenLastCalledWith(
          storage.getWorkspaceSettingsPath(),
          storage.getWorkspaceLocalSettingsPath(),
        );
      }
    });

    it('启动参数以会话偏好写入主模型，一次请求覆盖不污染会话偏好', async () => {
      const { config, providers, main, source } = setup({
        launchModelConfig: {
          reasoning: { effort: 'high' },
          sampling: { temperature: 0.5 },
          context: { contextWindow: 128000 },
        },
      });
      await config.initialize();
      await config.reconcileModelWithListedModels();
      const manager = config.getModelProviderManager();
      expect((await manager.select({ purpose: 'main' })).config).toMatchObject({
        reasoning: { effort: 'high' },
        sampling: { temperature: 0.5 },
        context: { contextWindow: 128000 },
      });
      await manager.select({
        purpose: 'main',
        overrideSelection: {
          model: main,
          config: { sampling: { temperature: 0.9 } },
        },
      });
      expect(providers[0].getModelConfig(main)?.sampling?.temperature).toBe(
        0.5,
      );
      expect(source.mutate).not.toHaveBeenCalled();
    });

    it('启动参数中模型不支持的字段被丢弃，其余字段照常写入', async () => {
      const { config } = setup({
        launchModelConfig: {
          reasoning: { effort: 'max' },
          context: { contextWindow: 128000 },
        },
      });
      await config.initialize();
      await config.reconcileModelWithListedModels();
      const preference = config
        .getModelProviderManager()
        .getModelConfig(await listed(config, 'local/main'));
      expect(preference?.reasoning?.effort).toBe('low');
      expect(preference?.context?.contextWindow).toBe(128000);
    });

    it('settings.ultracode 在主模型无已存 effort 时补 xhigh', async () => {
      const { config, main } = setup({ ultracode: true }, {});
      await config.initialize();
      await config.reconcileModelWithListedModels();
      const preference = config
        .getModelProviderManager()
        .getModelConfig(await listed(config, main.key));
      expect(preference?.reasoning?.effort).toBe('xhigh');
      expect(config.getUltracode()).toBe(true);
    });

    it('settings.ultracode 让位于主模型已存的 effort', async () => {
      const { config, main } = setup({ ultracode: true });
      await config.initialize();
      await config.reconcileModelWithListedModels();
      const preference = config
        .getModelProviderManager()
        .getModelConfig(await listed(config, main.key));
      expect(preference?.reasoning?.effort).toBe('low');
      expect(config.getUltracode()).toBe(false);
    });

    it('启动时关闭思考的偏好不被模型默认档位覆盖', async () => {
      const { config, other } = setup(
        {},
        { 'local/other': { reasoning: { enabled: false } } },
      );
      await config.initialize();
      await config.setModel(other.key);
      const result = await config.getModelProviderManager().select({
        purpose: 'main',
      });
      expect(result.config.reasoning?.effort).toBe('none');
    });

    it('两个 Config 的会话偏好、切模和关闭互不影响', async () => {
      const { config, createConfig, providers, main, other } = setup();
      const second = createConfig();
      await config.initialize();
      await second.initialize();
      const manager = config.getModelProviderManager();
      manager.setModelConfig(await listed(config, main.key), {
        reasoning: { effort: 'high' },
        context: { contextWindow: 128000 },
      });
      manager.setModelConfig(await listed(config, other.key), {
        reasoning: { effort: 'low' },
        context: { contextWindow: 64000 },
      });
      await config.setModel(other.key);
      expect(
        (await manager.select({ purpose: 'main' })).config.reasoning?.effort,
      ).toBe('low');
      await config.setModel(main.key);
      expect(
        (await manager.select({ purpose: 'main' })).config.reasoning?.effort,
      ).toBe('high');
      expect(
        (await second.getModelProviderManager().select({ purpose: 'main' }))
          .config.reasoning?.effort,
      ).toBe('low');
      await config.dispose();
      expect(providers[1].getModelConfig(main)?.context?.contextWindow).toBe(
        64000,
      );
    });

    it('显式 undefined 清除偏好后实际选择恢复默认', async () => {
      const { config, providers, main } = setup();
      await config.initialize();
      const manager = config.getModelProviderManager();
      const model = await listed(config, main.key);
      providers[0].setModelConfig(model, { sampling: { temperature: 0.8 } });
      manager.setModelConfig(model, { reasoning: { effort: 'high' } });
      expect(manager.getModelConfig(model)?.sampling?.temperature).toBe(0.8);
      manager.setModelConfig(model, {
        reasoning: { effort: undefined },
        sampling: undefined,
        context: undefined,
      });
      const result = await manager.select({ purpose: 'main' });
      expect(result.config.reasoning?.effort).toBe('medium');
      expect(result.config.sampling?.temperature).toBeUndefined();
      expect(result.config.context?.contextWindow).toBe(128000);
    });

    it('模型目录晚于 initialize 到达时由 reconcile 补写启动参数，且不重放', async () => {
      const { config, providers } = setup({
        launchModelConfig: {
          reasoning: { effort: 'high' },
          sampling: { temperature: 0.5 },
          context: { contextWindow: 128000 },
        },
      });
      const listing = vi
        .spyOn(providers[0], 'listModels')
        .mockResolvedValue([]);
      await config.initialize();
      listing.mockRestore();
      await config.reconcileModelWithListedModels();
      const manager = config.getModelProviderManager();
      expect((await manager.select({ purpose: 'main' })).config).toMatchObject({
        reasoning: { effort: 'high' },
        sampling: { temperature: 0.5 },
        context: { contextWindow: 128000 },
      });
      manager.setModelConfig(await listed(config, 'local/main'), {
        context: { contextWindow: 64000 },
      });
      await config.reconcileModelWithListedModels();
      expect(
        (await manager.select({ purpose: 'main' })).config.context
          ?.contextWindow,
      ).toBe(64000);
    });

    it('窗口开关关闭时已灌入的磁盘偏好不参与选模且不改磁盘', async () => {
      configSourceMocks.getConfigValue.mockImplementation((key: string) =>
        key === 'context_window_selection' ? false : undefined,
      );
      const { config, source } = setup();
      try {
        await config.initialize();
        await config.reconcileModelWithListedModels();
        expect(
          (await config.getModelProviderManager().select({ purpose: 'main' }))
            .config.context?.contextWindow,
        ).toBe(128000);
        expect(source.mutate).not.toHaveBeenCalled();
      } finally {
        configSourceMocks.getConfigValue.mockImplementation((key: string) =>
          key === 'context_window_selection' ? true : undefined,
        );
      }
    });

    it('关闭思考后恢复 Default 清除关闭意图并保留其他偏好', async () => {
      const { config, main } = setup();
      await config.initialize();
      const manager = config.getModelProviderManager();
      const model = await listed(config, main.key);
      manager.setModelConfig(model, { reasoning: { effort: 'none' } });
      expect(
        (await manager.select({ purpose: 'main' })).config.reasoning?.effort,
      ).toBe('none');
      manager.setModelConfig(model, { reasoning: { effort: undefined } });
      const result = await manager.select({ purpose: 'main' });
      expect(result.config.reasoning?.effort).toBe('medium');
      expect(result.config.reasoning?.thinking).toBeUndefined();
      expect(result.config.sampling?.temperature).toBe(0.2);
    });

    it('persist 时把 patch 写入 user settings', async () => {
      const { config, main, source } = setup();
      await config.initialize();
      const manager = config.getModelProviderManager();
      manager.setModelConfig(await listed(config, main.key), {
        reasoning: { effort: 'high' },
      });
      expect(source.mutate).not.toHaveBeenCalled();
      manager.setModelConfig(
        await listed(config, main.key),
        { reasoning: { effort: 'high' }, context: { contextWindow: 128000 } },
        true,
      );
      expect(source.mutate).toHaveBeenCalledOnce();
    });

    it('偏好变更经 Config 以事件通知', async () => {
      const { config, main } = setup();
      await config.initialize();
      mockCoreEvents.emitReasoningEffortChanged.mockClear();
      config
        .getModelProviderManager()
        .setModelConfig(await listed(config, main.key), {
          reasoning: { effort: 'high' },
        });
      expect(mockCoreEvents.emitReasoningEffortChanged).toHaveBeenCalledWith(
        expect.any(String),
        'high',
        main.key,
      );
    });
  });
});

describe('Availability Service Integration', () => {
  const baseModel = 'test-model';
  const baseParams: ConfigParameters = {
    loadedSettings: createEmptyLoadedSettings(),
    sessionId: 'test',
    targetDir: '.',
    debugMode: false,
    model: baseModel,
    cwd: '.',
  };

  it('setActiveModel updates active model', async () => {
    const config = new Config(baseParams);
    const model1 = 'model1';
    const model2 = 'model2';

    config.setActiveModel(model1);
    expect(config.getActiveModel()).toBe(model1);

    config.setActiveModel(model2);
    expect(config.getActiveModel()).toBe(model2);
  });

  it('getActiveModel defaults to configured model if not set', () => {
    const config = new Config(baseParams);
    expect(config.getActiveModel()).toBe(baseModel);
  });

  it('getActiveModel uses the restored model when no startup model was supplied', async () => {
    const savedModel = 'gateway/saved-model';
    const loadedSettings = createEmptyLoadedSettings();
    loadedSettings.merged.model = {
      ...loadedSettings.merged.model,
      name: savedModel,
    };
    const settingsService = new SettingsService();
    vi.spyOn(settingsService, 'resolve').mockReturnValue(loadedSettings);
    const config = new Config({
      ...baseParams,
      loadedSettings,
      settingsService,
      model: '',
    });

    try {
      await config.getModelProviderManager().start();
      expect(config.getModel()).toBe(savedModel);
      expect(config.getActiveModel()).toBe(savedModel);
    } finally {
      await config.dispose();
    }
  });

  it('resetTurn delegates to availability service', () => {
    const config = new Config(baseParams);
    const service = config.getModelAvailabilityService();
    const spy = vi.spyOn(service, 'resetTurn');

    config.resetTurn();
    expect(spy).toHaveBeenCalled();
  });
});

describe('Config Quota & Preview Model Access', () => {
  describe('Config Quota & Preview Model Access', () => {
    const baseParams: ConfigParameters = {
      loadedSettings: createEmptyLoadedSettings(),
      cwd: '/tmp',
      targetDir: '/tmp',
      debugMode: false,
      sessionId: 'test-session',
      model: 'gemini-pro',
      embeddingModel: 'gemini-embedding',
    };

    beforeEach(() => {
      vi.clearAllMocks();
    });

    describe('isPlanEnabled', () => {
      it('should return true by default', () => {
        const config = new Config(baseParams);
        expect(config.isPlanEnabled()).toBe(true);
      });

      it('should return true when plan is enabled', () => {
        const config = new Config({
          ...baseParams,
          plan: true,
        });
        expect(config.isPlanEnabled()).toBe(true);
      });

      it('should return false when plan is explicitly disabled', () => {
        const config = new Config({
          ...baseParams,
          plan: false,
        });
        expect(config.isPlanEnabled()).toBe(false);
      });
    });
  });
  let config: Config;
  let mockMemoryContextManager: MemoryContextManager;

  beforeEach(() => {
    mockMemoryContextManager = {
      refresh: vi.fn(),
      getGlobalMemory: vi.fn().mockReturnValue('Global Memory'),
      getPluginMemory: vi.fn().mockReturnValue('Plugin Memory'),
      getEnvironmentMemory: vi
        .fn()
        .mockReturnValue('Environment Memory\n\nMCP Instructions'),
      getLocalMemory: vi.fn().mockReturnValue(''),
      getJitMemory: vi.fn().mockReturnValue(''),
      getLoadedPaths: vi.fn().mockReturnValue(new Set(['/path/to/AGENTS.md'])),
    } as unknown as MemoryContextManager;
    (MemoryContextManager as unknown as Mock).mockImplementation(
      () => mockMemoryContextManager,
    );
  });

  it('suppresses only the size notification for MCP and auto-memory context refreshes', async () => {
    config = new Config({
      loadedSettings: createEmptyLoadedSettings(),
      sessionId: 'test-session',
      targetDir: '/tmp/test',
      debugMode: false,
      model: 'test-model',
      cwd: '/tmp/test',
      interactive: true,
    });
    const runtime = config as unknown as {
      memoryContextManager: MemoryContextManager;
      initialized: boolean;
      handleAutoMemoryFeatureGateChange(): void;
    };
    runtime.memoryContextManager = mockMemoryContextManager;
    await config.refreshMcpContext();
    expect(mockMemoryContextManager.refresh).toHaveBeenLastCalledWith(
      'session_start',
      undefined,
      { notifyAgentsMdSizeWarning: false },
    );
    runtime.initialized = true;
    runtime.handleAutoMemoryFeatureGateChange();
    expect(mockMemoryContextManager.refresh).toHaveBeenCalledTimes(2);
    expect(mockMemoryContextManager.refresh).toHaveBeenLastCalledWith(
      'session_start',
      undefined,
      { notifyAgentsMdSizeWarning: false },
    );
    // Flush the background handler before tearing down its mocks.
    await Promise.resolve();
  });

  it('should delegate memory to MemoryContextManager after initialization', async () => {
    config = new Config({
      loadedSettings: createEmptyLoadedSettings(),
      sessionId: 'test-session',
      targetDir: '/tmp/test',
      debugMode: false,
      model: 'test-model',
      userMemory: 'Initial Memory',
      cwd: '/tmp/test',
    });

    // Manually set the memoryContextManager to simulate post-initialization state
    // (avoids calling initialize() in a test that only verifies memory access)
    (config as unknown as Record<string, unknown>)['memoryContextManager'] =
      mockMemoryContextManager;

    expect(config.getUserMemory()).toEqual({
      global: 'Global Memory',
      plugin: 'Plugin Memory',
      project: 'Environment Memory\n\nMCP Instructions',
      local: '',
      jit: '',
    });

    // Tier 1: system instruction gets only global memory
    expect(config.getSystemInstructionMemory()).toBe('Global Memory');

    // Tier 2: session memory gets plugin + project formatted with XML tags
    const sessionMemory = config.getSessionMemory();
    expect(sessionMemory).toContain('<loaded_context>');
    expect(sessionMemory).toContain('<plugin_context>');
    expect(sessionMemory).toContain('Plugin Memory');
    expect(sessionMemory).toContain('</plugin_context>');
    expect(sessionMemory).toContain('<project_context>');
    expect(sessionMemory).toContain('Environment Memory');
    expect(sessionMemory).toContain('MCP Instructions');
    expect(sessionMemory).toContain('</project_context>');
    expect(sessionMemory).toContain('</loaded_context>');

    // Verify state update (delegated to MemoryContextManager)
    expect(config.getMemoryMdFileCount()).toBe(1);
    expect(config.getMemoryMdFilePaths()).toEqual(['/path/to/AGENTS.md']);
  });

  describe('reloadSkills', () => {
    it('should refresh disabledSkills without rebuilding the static Skill tool', async () => {
      const mockOnReload = vi.fn().mockResolvedValue({
        disabledSkills: ['skill2'],
      });
      const params: ConfigParameters = {
        loadedSettings: createEmptyLoadedSettings(),
        sessionId: 'test-session',
        targetDir: '/tmp/test',
        debugMode: false,
        model: 'test-model',
        cwd: '/tmp/test',
        skillsSupport: true,
        onReload: mockOnReload,
      };

      config = new Config(params);
      await config.initialize();

      const skillManager = config.getSkillManager();
      const loopContext: AgentLoopContext = config;
      const toolRegistry = loopContext.toolRegistry;
      const originalSkillTool = toolRegistry.getTool(SKILL_TOOL_NAME);
      const originalToolOrder = toolRegistry
        .getFunctionDeclarations()
        .map((declaration) => declaration.name);

      vi.spyOn(skillManager, 'discoverSkills').mockResolvedValue(undefined);
      vi.spyOn(skillManager, 'setDisabledSkills');
      vi.spyOn(toolRegistry, 'registerTool');
      vi.spyOn(toolRegistry, 'unregisterTool');

      const mockSkills = [{ name: 'skill1' }];
      vi.spyOn(skillManager, 'getSkills').mockReturnValue(
        mockSkills as SkillDefinition[],
      );

      await config.reloadSkills();

      expect(mockOnReload).toHaveBeenCalled();
      expect(skillManager.setDisabledSkills).toHaveBeenCalledWith(['skill2']);
      expect(toolRegistry.registerTool).not.toHaveBeenCalled();
      expect(toolRegistry.unregisterTool).not.toHaveBeenCalled();
      expect(toolRegistry.getTool(SKILL_TOOL_NAME)).toBe(originalSkillTool);
      expect(
        toolRegistry
          .getFunctionDeclarations()
          .map((declaration) => declaration.name),
      ).toEqual(originalToolOrder);
    });

    it('should keep the static Skill tool when no skills exist after reload', async () => {
      const params: ConfigParameters = {
        loadedSettings: createEmptyLoadedSettings(),
        sessionId: 'test-session',
        targetDir: '/tmp/test',
        debugMode: false,
        model: 'test-model',
        cwd: '/tmp/test',
        skillsSupport: true,
      };

      config = new Config(params);
      await config.initialize();

      const skillManager = config.getSkillManager();
      const loopContext: AgentLoopContext = config;
      const toolRegistry = loopContext.toolRegistry;
      const originalSkillTool = toolRegistry.getTool(SKILL_TOOL_NAME);

      vi.spyOn(skillManager, 'discoverSkills').mockResolvedValue(undefined);
      vi.spyOn(toolRegistry, 'registerTool');
      vi.spyOn(toolRegistry, 'unregisterTool');

      vi.spyOn(skillManager, 'getSkills').mockReturnValue([]);

      await config.reloadSkills();

      expect(toolRegistry.registerTool).not.toHaveBeenCalled();
      expect(toolRegistry.unregisterTool).not.toHaveBeenCalled();
      expect(toolRegistry.getTool(SKILL_TOOL_NAME)).toBe(originalSkillTool);
    });

    it('should clear disabledSkills when onReload returns undefined for them', async () => {
      const mockOnReload = vi.fn().mockResolvedValue({
        disabledSkills: undefined,
      });
      const params: ConfigParameters = {
        loadedSettings: createEmptyLoadedSettings(),
        sessionId: 'test-session',
        targetDir: '/tmp/test',
        debugMode: false,
        model: 'test-model',
        cwd: '/tmp/test',
        skillsSupport: true,
        onReload: mockOnReload,
      };

      config = new Config(params);
      // Initially set some disabled skills
      // @ts-expect-error - accessing private
      config.disabledSkills = ['skill1'];
      await config.initialize();

      const skillManager = config.getSkillManager();
      vi.spyOn(skillManager, 'discoverSkills').mockResolvedValue(undefined);
      vi.spyOn(skillManager, 'setDisabledSkills');

      await config.reloadSkills();

      expect(skillManager.setDisabledSkills).toHaveBeenCalledWith([]);
    });

    it('should update admin settings from onReload', async () => {
      const mockOnReload = vi.fn().mockResolvedValue({
        adminSkillsEnabled: false,
      });
      const params: ConfigParameters = {
        loadedSettings: createEmptyLoadedSettings(),
        sessionId: 'test-session',
        targetDir: '/tmp/test',
        debugMode: false,
        model: 'test-model',
        cwd: '/tmp/test',
        skillsSupport: true,
        onReload: mockOnReload,
      };

      config = new Config(params);
      await config.initialize();

      const skillManager = config.getSkillManager();
      vi.spyOn(skillManager, 'setAdminSettings');

      await config.reloadSkills();

      expect(skillManager.setAdminSettings).toHaveBeenCalledWith(false);
    });
  });
});

describe('Context window configuration', () => {
  const baseParams: ConfigParameters = {
    loadedSettings: createEmptyLoadedSettings(),
    sessionId: 'test',
    targetDir: '.',
    debugMode: false,
    model: 'large-context',
    cwd: '.',
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function loadLargeContextModel(): void {
    mockListedModels([
      testListedModel('large-context', {
        display_name: 'Large Context',
        max_input_tokens: 180_000,
        max_output_tokens: 8_192,
        price_factor: 1,
        original_price_factor: 1,
        available_context_windows: [200_000, 400_000, 1_000_000],
        default_context_window: 200_000,
      }),
    ]);
  }

  function stubPreferredContextWindow(
    config: Config,
    contextWindow: number | undefined,
  ): void {
    vi.spyOn(
      config.getModelProviderManager(),
      'getModelConfig',
    ).mockReturnValue(
      contextWindow === undefined ? undefined : { context: { contextWindow } },
    );
  }

  it('does not clamp a configured explicit context window to tokenLimit', async () => {
    vi.mocked(tokenLimit).mockReturnValue(180_000);
    loadLargeContextModel();

    const config = new Config(baseParams);
    stubPreferredContextWindow(config, 1_000_000);

    expect(
      config.getEffectiveContextWindow(
        await config.getModelProviderManager().getModel('large-context'),
        'large-context',
      ),
    ).toBe(1_000_000);
  });

  it('uses the catalog default context window when no explicit window is configured', async () => {
    vi.mocked(tokenLimit).mockReturnValue(180_000);
    loadLargeContextModel();

    const config = new Config(baseParams);
    stubPreferredContextWindow(config, undefined);

    expect(
      config.getEffectiveContextWindow(
        await config.getModelProviderManager().getModel('large-context'),
        'large-context',
      ),
    ).toBe(200_000);
  });

  it('falls back to the default window when the configured window is not a valid option', async () => {
    vi.mocked(tokenLimit).mockReturnValue(180_000);
    loadLargeContextModel();

    const config = new Config(baseParams);
    stubPreferredContextWindow(config, 300_000);

    expect(
      config.getEffectiveContextWindow(
        await config.getModelProviderManager().getModel('large-context'),
        'large-context',
      ),
    ).toBe(200_000);
  });
});

describe('Custom Provider activation', () => {
  const baseParams: ConfigParameters = {
    loadedSettings: createEmptyLoadedSettings(),
    sessionId: 'custom-provider-test',
    customProviderAccessMode: 'local',
    targetDir: '.',
    debugMode: false,
    model: 'gateway/main-model',
    cwd: '.',
    customProviderSettings: {
      gateway: {
        baseUrl: 'https://models.example.com/v1',
        apiKey: 'top-secret',
        model: 'main-model',
      },
    },
  };

  const configs: Config[] = [];
  async function authorizedConfig(params: ConfigParameters): Promise<Config> {
    const config = new Config(params);
    configs.push(config);
    await config.getModelProviderManager().start();
    await config.ensureCustomProvidersAccess();
    return config;
  }
  afterEach(async () => {
    for (const config of configs.splice(0)) await config.dispose();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  const publicModel = (config: Config, key: string) =>
    config
      .getCustomProviderRegistry()
      .getPublicModels()
      .find((model) => model.key === key);

  const providerCount = (config: Config) =>
    config.getCustomProviderRegistry().getPublicProviders().length;

  it('parses and projects provider settings only when explicitly activated', async () => {
    const config = await authorizedConfig(baseParams);

    expect(providerCount(config)).toBe(0);
    expect(publicModel(config, 'gateway/main-model')).toBeUndefined();

    expect(await config.activateCustomProvidersFromSettings()).toEqual({
      status: 'active',
      providerCount: 1,
      modelCount: 1,
    });
    expect(providerCount(config)).toBe(1);
    expect(publicModel(config, 'gateway/main-model')).toMatchObject({
      providerId: 'gateway',
    });
  });

  it('projects the selected Alibaba model without a models metadata entry', async () => {
    const config = await authorizedConfig({
      ...baseParams,
      model: 'alibaba/qwen-plus',
      customProviderSettings: {
        alibaba: {
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          apiKey: 'top-secret',
        },
      },
    });

    expect(await config.activateCustomProvidersFromSettings()).toEqual({
      status: 'active',
      providerCount: 1,
      modelCount: 2,
    });
    expect(publicModel(config, 'alibaba/qwen-plus')).toMatchObject({
      providerId: 'alibaba',
      modelId: 'qwen-plus',
      contextWindow: 200_000,
    });
    expect(
      config.getCustomProviderRegistry().getProviderForModel('alibaba/qwen-plus'),
    ).toMatchObject({
      providerId: 'alibaba',
      apiKey: 'top-secret',
    });
  });

  it('honors an explicit context window for an implicit Alibaba model', async () => {
    const config = await authorizedConfig({
      ...baseParams,
      model: 'alibaba/qwen-plus',
      customProviderSettings: {
        alibaba: {
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          apiKey: 'top-secret',
        },
      },
    });

    await config.activateCustomProvidersFromSettings();
    const model = testListedModel(config.getModel(), {
      source: 'custom',
      provider: 'alibaba',
    });
    vi.spyOn(config.getModelProviderManager(), 'getModel').mockResolvedValue(
      model,
    );
    vi.spyOn(
      config.getModelProviderManager(),
      'getModelConfig',
    ).mockReturnValue({ context: { contextWindow: 1_000_000 } });

    expect(
      config.getEffectiveContextWindow(
        await config.getModelProviderManager().getModel(config.getModel()),
      ),
    ).toBe(1_000_000);
  });

  it('rejects removed provider image configuration with a migration warning', async () => {
    const config = await authorizedConfig({
      ...baseParams,
      customProviderSettings: {
        gateway: {
          baseUrl: 'https://models.example.com/v1',
          apiKey: 'top-secret',
          model: 'main-model',
          image: {
            type: 'openai-compatible',
            model: 'image-model',
            baseUrl: 'invalid-image-url',
            apiKey: 'image-secret',
          },
        },
      },
    });

    expect(await config.activateCustomProvidersFromSettings()).toMatchObject({
      status: 'invalid_configuration',
      issues: [expect.objectContaining({ field: 'image' })],
    });
    expect(providerCount(config)).toBe(0);
    expect(mockCoreEvents.emitFeedback).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('use tools.imageGen'),
    );
  });

  it('keeps provider settings inert in remote-worker mode', async () => {
    const config = await authorizedConfig({
      ...baseParams,
      customProviderAccessMode: 'disabled',
    });

    expect(await config.activateCustomProvidersFromSettings()).toEqual({
      status: 'inactive',
      reason: 'remote_worker',
    });
    expect(providerCount(config)).toBe(1);
    expect(
      config.getCustomProviderRegistry().getProviderForModel('gateway/main-model')
        ?.apiKey,
    ).toBe('');
  });

  it('rejects collisions with an already loaded direct-connection model', async () => {
    const config = await authorizedConfig(baseParams);
    mockListedModels([
      testListedModel('gateway/main-model', {
        display_name: 'Direct model',
        source: 'user',
        provider: 'openai',
        model: 'main-model',
        max_input_tokens: 128_000,
      }),
    ]);

    expect(await config.activateCustomProvidersFromSettings()).toMatchObject({
      status: 'invalid_configuration',
      issues: [
        expect.objectContaining({
          field: 'models',
          message: expect.stringContaining('conflicts'),
        }),
      ],
    });
    expect(providerCount(config)).toBe(0);
  });

  it('clears credentials while retaining inert local declarations when deactivated', async () => {
    const config = await authorizedConfig(baseParams);
    await config.activateCustomProvidersFromSettings();

    config.deactivateCustomProviders('not_authenticated');

    expect(providerCount(config)).toBe(1);
    expect(
      config.getCustomProviderRegistry().getProviderForModel('gateway/main-model')
        ?.apiKey,
    ).toBe('');
    expect(config.getCustomProvidersState()).toEqual({
      status: 'inactive',
      reason: 'not_authenticated',
    });
  });
});

describe('CLI model validation', () => {
  const baseParams: ConfigParameters = {
    loadedSettings: createEmptyLoadedSettings(),
    sessionId: 'test',
    targetDir: '.',
    debugMode: false,
    model: 'bailian/glm5',
    modelSource: 'cli',
    cwd: '.',
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('displayName CLI regression', () => {
    beforeEach(() => vi.clearAllMocks());
    const auto = testListedModel('auto', { is_default: true });
    const newModels = [
      'Qwen3.8-Max',
      'Qwen3.8-Flash',
      'Sonus',
      'Cantus',
      'GLM-5.3',
    ].map((displayName, index) =>
      testListedModel(`new-model-${index}`, {
        display_name: displayName,
        is_new: true,
        is_reasoning: true,
        efforts: ['low', 'high'],
      }),
    );

    async function setup(
      input: string,
      models: Model[] = newModels,
      overrides: Partial<ConfigParameters> = {},
      providerId = 'qoder',
    ) {
      let catalog = [auto, ...models];
      const preferences = new Map<string, ModelConfig>();
      const provider: ModelProvider = {
        providerId,
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        listModels: vi.fn(async () => catalog),
        getModel: vi.fn(async (key: string) =>
          catalog.find((model) => model.key === key),
        ),
        getModelConfig: (model: Model) => preferences.get(model.key),
        setModelConfig: (model: Model, patch: ModelConfig) => {
          preferences.set(model.key, patch);
          return true;
        },
        select: vi.fn(async () => {
          const model = await manager.getMainModel();
          return { model, config: preferences.get(model.key) ?? {} };
        }),
        inference: vi.fn(),
      };
      const config = new Config({
        ...baseParams,
        model: input,
        modelSource: 'cli',
        modelTransportManager: new ModelTransportManager([]),
        modelProviderFactory: () => [provider],
        ...overrides,
      });
      const manager = config.getModelProviderManager();
      await manager.start();
      manager.setMainModel(auto, false);
      return {
        config,
        manager,
        provider,
        setCatalog: (models: Model[]) => {
          catalog = [auto, ...models];
        },
      };
    }

    it.each(
      newModels.flatMap(
        (model) =>
          [
            [model.displayName, model],
            [model.displayName.toLowerCase(), model],
            [model.key, model],
          ] as const,
      ),
    )(
      'New 模型 %s 归一为 canonical key，实际主模型选择不走 auto',
      async (input, expected) => {
        const { config, manager, provider } = await setup(input);
        try {
          await config.reconcileModelWithListedModels({
            modelsWereAwaited: false,
            onInvalidCliModel: 'fallback',
          });
          await config.reconcileModelWithListedModels({
            modelsWereAwaited: true,
          });
          expect(config.getModel()).toBe(expected.key);
          expect(config.getActiveModel()).toBe(expected.key);
          expect(await manager.getMainModel()).toEqual(expected);
          const selection = await manager.select({ purpose: 'main' });
          expect(selection.model).toEqual(expected);
          await manager.inference({ resolution: selection } as Parameters<
            typeof manager.inference
          >[0]);
          expect(provider.inference).toHaveBeenCalledWith(
            expect.objectContaining({ resolution: selection }),
          );
          expect(mockCoreEvents.emitFeedback).not.toHaveBeenCalled();
        } finally {
          await config.dispose();
        }
      },
    );

    it.each(
      ['auto', 'bucunzai'].flatMap((initialModel) =>
        ([undefined, 'fallback'] as const).map((onInvalidCliModel) => ({
          initialModel,
          onInvalidCliModel,
        })),
      ),
    )(
      '不存在的 CLI 模型回退 auto，实际选模和推理使用 auto：%j',
      async ({ initialModel, onInvalidCliModel }) => {
        const onModelChange = vi.fn();
        const { config, manager, provider } = await setup('bucunzai', newModels, {
          onModelChange,
        });
        manager.setMainModelKey(initialModel, false);
        try {
          await config.reconcileModelWithListedModels({
            modelsWereAwaited: true,
            onInvalidCliModel,
          });
          expect(config.getModel()).toBe('auto');
          expect(config.getActiveModel()).toBe('auto');
          expect(await manager.getMainModel()).toEqual(auto);
          const selection = await manager.select({ purpose: 'main' });
          expect(selection.model).toEqual(auto);
          await manager.inference({ resolution: selection } as Parameters<
            typeof manager.inference
          >[0]);
          expect(provider.inference).toHaveBeenCalledWith(
            expect.objectContaining({ resolution: selection }),
          );
          expect(onModelChange).not.toHaveBeenCalled();
          expect(mockCoreEvents.emitFeedback).toHaveBeenCalledWith(
            'warning',
            expect.stringContaining('using "auto" instead'),
          );
          await config.reconcileModelWithListedModels();
          expect(mockCoreEvents.emitFeedback).toHaveBeenCalledTimes(1);
          await config.setModel(newModels[0].key, true);
          await config.reconcileModelWithListedModels();
          expect(config.getModel()).toBe(newModels[0].key);
        } finally {
          await config.dispose();
        }
      },
    );

    it.each(['auto', 'bucunzai'])(
      'onInvalidCliModel=throw 拒绝非法输入，保留 %s',
      async (initialModel) => {
        const { config, manager } = await setup('bucunzai', newModels);
        manager.setMainModelKey(initialModel, false);
        try {
          await expect(
            config.reconcileModelWithListedModels({
              modelsWereAwaited: true,
              onInvalidCliModel: 'throw',
            }),
          ).rejects.toMatchObject({ name: 'FatalInputError' });
          expect(config.getModel()).toBe(initialModel);
          expect(mockCoreEvents.emitFeedback).not.toHaveBeenCalled();
        } finally {
          await config.dispose();
        }
      },
    );

    it('目录未就绪时保留不存在的 CLI 输入，权威校正后回退 auto', async () => {
      const { config, manager } = await setup('bucunzai', []);
      manager.setMainModelKey('bucunzai', false);
      try {
        await config.reconcileModelWithListedModels({
          modelsWereAwaited: false,
          onInvalidCliModel: 'fallback',
        });
        expect(config.getModel()).toBe('bucunzai');
        expect(mockCoreEvents.emitFeedback).not.toHaveBeenCalled();
        await config.reconcileModelWithListedModels({ modelsWereAwaited: true });
        expect(config.getModel()).toBe('auto');
        expect(await manager.getMainModel()).toEqual(auto);
      } finally {
        await config.dispose();
      }
    });

    it('SDK defer 策略保留模型，交给后续 policy 路由', async () => {
      const { config, manager } = await setup('bucunzai');
      manager.setMainModelKey('bucunzai', false);
      try {
        await expect(
          config.reconcileModelWithListedModels({
            modelsWereAwaited: true,
            onInvalidCliModel: 'defer',
          }),
        ).resolves.toBeUndefined();
        expect(config.getModel()).toBe('bucunzai');
        expect(mockCoreEvents.emitFeedback).not.toHaveBeenCalled();
      } finally {
        await config.dispose();
      }
    });

    it.each([
      { autoModels: [] },
      { autoModels: [{ ...auto, enabled: false }] },
      { autoModels: [{ ...auto, source: 'custom' }] },
    ])(
      '不检查 auto 是否列出、启用或属于平台，直接回退 auto：%j',
      async ({ autoModels }) => {
        const { config, manager, provider } = await setup(
          'bucunzai',
          newModels,
          {},
          autoModels[0]?.source ?? 'qoder',
        );
        manager.setMainModelKey('bucunzai', false);
        const catalog = [
          { ...newModels[0], isDefault: true },
          ...autoModels,
        ];
        vi.mocked(provider.listModels).mockResolvedValue(catalog);
        vi.mocked(provider.getModel).mockImplementation(async (key) =>
          catalog.find((model) => model.key === key),
        );
        try {
          await expect(
            config.reconcileModelWithListedModels(),
          ).resolves.toBeUndefined();
          expect(config.getModel()).toBe('auto');
          expect(config.getActiveModel()).toBe('auto');
          expect(mockCoreEvents.emitFeedback).toHaveBeenCalledWith(
            'warning',
            expect.stringContaining('using "auto" instead'),
          );
        } finally {
          await config.dispose();
        }
      },
    );

    it('已配置 Custom Provider 的不存在模型也直接回退 auto', async () => {
      const input = 'gateway/bucunzai';
      const { config, manager } = await setup(input, newModels, {
        customProviderSettings: {
          gateway: {
            baseUrl: 'https://models.example.com/v1',
            model: 'known-model',
          },
        },
      });
      manager.setMainModelKey(input, false);
      try {
        expect(config.isConfiguredCustomProviderModelKey(input)).toBe(true);
        await expect(
          config.reconcileModelWithListedModels(),
        ).resolves.toBeUndefined();
        expect(config.getModel()).toBe('auto');
        expect(await manager.getMainModel()).toEqual(auto);
        expect(mockCoreEvents.emitFeedback).toHaveBeenCalledWith(
          'warning',
          expect.stringContaining('using "auto" instead'),
        );
      } finally {
        await config.dispose();
      }
    });

    it('缓存目录只有 auto 时保留启动输入，目标模型到达后仍能选中', async () => {
      const target = newModels[0];
      const { config, setCatalog } = await setup(target.displayName, []);
      try {
        await config.reconcileModelWithListedModels({
          modelsWereAwaited: false,
          onInvalidCliModel: 'fallback',
        });
        expect(config.getModel()).toBe('auto');
        expect(mockCoreEvents.emitFeedback).not.toHaveBeenCalled();
        setCatalog([target]);
        await config.reconcileModelWithListedModels({
          modelsWereAwaited: true,
        });
        expect(config.getModel()).toBe(target.key);
      } finally {
        await config.dispose();
      }
    });

    it.each([newModels[0].key, newModels[0].displayName])(
      '禁用模型 %s 报参数错误，不锚定目标',
      async (input) => {
        const { config } = await setup(input, [
          { ...newModels[0], enabled: false },
        ]);
        try {
          await expect(
            config.reconcileModelWithListedModels({ modelsWereAwaited: true }),
          ).rejects.toThrow('not available');
          expect(config.getModel()).toBe('auto');
        } finally {
          await config.dispose();
        }
      },
    );

    it('展示名重名报错；显式 key 不受重名展示名影响', async () => {
      const first = newModels[0];
      const other = {
        ...first,
        key: 'other',
        displayName: first.displayName.toLowerCase(),
      };
      const { config, manager } = await setup(first.displayName, [
        first,
        other,
      ]);
      try {
        await expect(
          config.reconcileModelWithListedModels({ modelsWereAwaited: true }),
        ).rejects.toThrow('Ambiguous model');
        expect(config.getModel()).toBe('auto');
        manager.setMainModel(first, false);
      } finally {
        await config.dispose();
      }
      const keyed = await setup(first.key, [first, other]);
      try {
        await keyed.config.reconcileModelWithListedModels({
          modelsWereAwaited: true,
        });
        expect(keyed.config.getModel()).toBe(first.key);
      } finally {
        await keyed.config.dispose();
      }
    });

    it('展示名应用后，目录更新不再按原始输入重新选模', async () => {
      const target = newModels[0];
      const other = newModels[1];
      const { config, setCatalog } = await setup(target.displayName);
      try {
        await config.reconcileModelWithListedModels();
        setCatalog([
          { ...target, displayName: 'Renamed target' },
          { ...other, displayName: target.displayName },
        ]);
        await config.reconcileModelWithListedModels();
        expect(config.getModel()).toBe(target.key);
      } finally {
        await config.dispose();
      }
    });

    it('展示名覆盖初始恢复模型，启动 effort 写到最终模型，后续切模不重放', async () => {
      const target = newModels[0];
      const resumed = newModels[1];
      const { config, manager } = await setup(target.displayName, newModels, {
        launchModelConfig: { reasoning: { effort: 'high' } },
      });
      try {
        manager.setMainModel(resumed, false);
        await config.reconcileModelWithListedModels();
        expect(config.getModel()).toBe(target.key);
        expect(manager.getModelConfig(target)?.reasoning?.effort).toBe('high');
        expect(manager.getModelConfig(resumed)).toBeUndefined();
        await config.setModel(resumed.key, true);
        await config.reconcileModelWithListedModels();
        expect(config.getModel()).toBe(resumed.key);
      } finally {
        await config.dispose();
      }
    });

    it.each(['qa-test888', 'QA-TEST888', 'My Custom Model high'])(
      'Custom CLI 展示名 %s 保持 provider 归属并只写会话偏好',
      async (input) => {
        const target = {
          ...newModels[0],
          key: 'custom-provider/qwen3.8-flash',
          source: 'custom-provider',
          displayName: input.toLowerCase(),
        };
        const onModelChange = vi.fn();
        const { config, manager } = await setup(
          input,
          [target],
          {
            onModelChange,
            launchModelConfig: { reasoning: { effort: 'high' } },
          },
          'custom-provider',
        );
        try {
          await config.reconcileModelWithListedModels({
            modelsWereAwaited: true,
          });
          const selection = await manager.select({ purpose: 'main' });
          expect(config.getModel()).toBe(target.key);
          expect(selection.model).toBe(target);
          expect(selection.model.source).toBe('custom-provider');
          expect(selection.config.reasoning?.effort).toBe('high');
          expect(onModelChange).not.toHaveBeenCalled();
          expect(mockCoreEvents.emitFeedback).not.toHaveBeenCalled();
        } finally {
          await config.dispose();
        }
      },
    );

    it('已保存模型不新增展示名解析', async () => {
      const { config } = await setup(newModels[0].displayName, newModels, {
        modelSource: 'config',
      });
      try {
        await expect(config.reconcileModelWithListedModels()).rejects.toThrow(
          'Invalid model',
        );
        expect(config.getModel()).toBe('auto');
      } finally {
        await config.dispose();
      }
    });
  });

  it('exposes the model specified by the CLI flag', () => {
    const config = new Config(baseParams);

    expect(config.getCliModel()).toBe('bailian/glm5');
  });

  it('exposes CLI runtime config overrides', () => {
    const config = new Config({
      ...baseParams,
      cliReasoningEffort: 'high',
      cliContextWindow: '256000',
    });

    expect(config.getCliReasoningEffort()).toBe('high');
    expect(config.getCliContextWindow()).toBe('256000');
  });

  it('passes the CLI model through when catalog initialization produced no models', async () => {
    const config = new Config(baseParams);
    await config.getModelProviderManager().start();
    const originalModel = config.getModel();
    await expect(
      config.reconcileModelWithListedModels({ modelsWereAwaited: false }),
    ).resolves.toBeUndefined();
    expect(config.getModel()).toBe(originalModel);
  });

  it('falls back to auto when the CLI model is not listed and no direct-connection models exist', async () => {
    mockListedEntries([
      {
        key: 'qwen-max',
        display_name: 'Qwen Max',
        enable: true,
        is_default: true,
        is_reasoning: true,
        is_vl: true,
        is_new: false,
        max_input_tokens: 128000,
        max_output_tokens: 8192,
        price_factor: 1,
        original_price_factor: 1,
        source: 'server',
        format: 'qoder',
        tags: [],
      },
    ]);

    const config = new Config(baseParams);
    await config.getModelProviderManager().start();

    await expect(
      config.reconcileModelWithListedModels({ modelsWereAwaited: true }),
    ).resolves.toBeUndefined();
    expect(config.getModel()).toBe('auto');
    expect(mockCoreEvents.emitFeedback).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('using "auto" instead'),
    );
  });

  it('空目录时保留已保存模型，交给请求路由校验', async () => {
    const config = new Config({ ...baseParams, modelSource: 'config' });
    await config.getModelProviderManager().start();
    await config.setModel('saved-direct-model');
    await expect(
      config.reconcileModelWithListedModels({
        modelsWereAwaited: true,
        onInvalidCliModel: 'defer',
      }),
    ).resolves.toBeUndefined();
    expect(config.getModel()).toBe('saved-direct-model');
  });

  it('defers an unknown CLI model for later model policy routing', async () => {
    mockListedEntries([
      {
        key: 'qwen-max',
        display_name: 'Qwen Max',
        enable: true,
        is_default: true,
        is_reasoning: true,
        is_vl: true,
        is_new: false,
        max_input_tokens: 128000,
        max_output_tokens: 8192,
        price_factor: 1,
        original_price_factor: 1,
        source: 'server',
        format: 'qoder',
        tags: [],
      },
    ]);
    const config = new Config(baseParams);
    const manager = config.getModelProviderManager();
    await manager.start();
    manager.setMainModelKey(baseParams.model, false);
    try {
      await expect(
        config.reconcileModelWithListedModels({
          modelsWereAwaited: true,
          onInvalidCliModel: 'defer',
        }),
      ).resolves.toBeUndefined();
      expect(config.getModel()).toBe('bailian/glm5');
    } finally {
      await config.dispose();
    }
  });

  it('未等待目录时保留无效 CLI 输入，权威目录没有 auto 时仍直接回退', async () => {
    mockListedEntries([
      {
        key: 'qwen-max',
        display_name: 'Qwen Max',
        enable: true,
        is_default: true,
        is_reasoning: true,
        is_vl: true,
        is_new: false,
        max_input_tokens: 128000,
        max_output_tokens: 8192,
        price_factor: 1,
        original_price_factor: 1,
        source: 'server',
        format: 'qoder',
        tags: [],
        provider: 'qoder',
        model: 'qwen-max',
      },
    ] as ListedModelEntryFixture[]);

    const config = new Config(baseParams);
    await config.getModelProviderManager().start();
    const originalModel = config.getModel();
    try {
      await expect(
        config.reconcileModelWithListedModels({
          modelsWereAwaited: false,
          onInvalidCliModel: 'fallback',
        }),
      ).resolves.toBeUndefined();
      expect(config.getModel()).toBe(originalModel);
      await expect(
        config.reconcileModelWithListedModels({
          modelsWereAwaited: true,
          onInvalidCliModel: 'fallback',
        }),
      ).resolves.toBeUndefined();
      expect(config.getModel()).toBe('auto');
      expect(mockCoreEvents.emitFeedback).toHaveBeenCalledWith(
        'warning',
        expect.stringContaining('using "auto" instead'),
      );
    } finally {
      await config.dispose();
    }
  });

  it('目录仅有服务端直连模型时仍回退 auto', async () => {
    mockListedEntries([
      {
        key: 'enterprise-direct',
        display_name: 'Enterprise Direct',
        enable: true,
        is_default: false,
        is_reasoning: true,
        is_vl: false,
        is_new: false,
        max_input_tokens: 180000,
        max_output_tokens: 8192,
        price_factor: 1,
        original_price_factor: 1,
        source: 'user',
        format: 'openai',
        tags: [],
        server_scene: 'organization_models',
      },
    ]);

    const config = new Config(baseParams);
    await config.getModelProviderManager().start();

    await expect(
      config.reconcileModelWithListedModels({ modelsWereAwaited: true }),
    ).resolves.toBeUndefined();
    expect(config.getModel()).toBe('auto');
  });

  it('目录中的禁用直连模型不阻断无效 CLI 模型回退 auto', async () => {
    const listedModels = mockListedEntries([
      {
        key: 'qwen-max',
        display_name: 'Qwen Max',
        enable: true,
        is_default: true,
        is_reasoning: true,
        is_vl: true,
        is_new: false,
        max_input_tokens: 128000,
        max_output_tokens: 8192,
        price_factor: 1,
        original_price_factor: 1,
        source: 'server',
        format: 'qoder',
        tags: [],
      },
      {
        key: 'bailian/glm5-cp',
        display_name: 'GLM-5',
        enable: true,
        is_default: false,
        is_reasoning: true,
        is_vl: false,
        is_new: false,
        max_input_tokens: 180000,
        max_output_tokens: 8192,
        price_factor: 1,
        original_price_factor: 1,
        source: 'user',
        format: 'openai',
        tags: [],
      },
    ]);

    const config = new Config(baseParams);
    await config.getModelProviderManager().start();
    const models = await config.getModelProviderManager().listModels();
    listedModels.mockResolvedValue(
      models.map((model) =>
        model.key === 'bailian/glm5-cp' ? { ...model, enabled: false } : model,
      ),
    );
    await expect(
      config.reconcileModelWithListedModels({ modelsWereAwaited: true }),
    ).resolves.toBeUndefined();
    expect(config.getModel()).toBe('auto');
    expect(mockCoreEvents.emitFeedback).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('using "auto" instead'),
    );
  });

  it('目录中的可用直连模型不改变无效 CLI 模型回退目标 auto', async () => {
    mockListedEntries([
      {
        key: 'qwen-max',
        display_name: 'Qwen Max',
        enable: true,
        is_default: true,
        is_reasoning: true,
        is_vl: true,
        is_new: false,
        max_input_tokens: 128000,
        max_output_tokens: 8192,
        price_factor: 1,
        original_price_factor: 1,
        source: 'server',
        format: 'qoder',
        tags: [],
      },
      {
        key: 'bailian/glm5-cp',
        display_name: 'GLM-5',
        enable: true,
        is_default: false,
        is_reasoning: true,
        is_vl: false,
        is_new: false,
        max_input_tokens: 180000,
        max_output_tokens: 8192,
        price_factor: 1,
        original_price_factor: 1,
        source: 'user',
        format: 'openai',
        tags: [],
      },
    ]);

    const config = new Config(baseParams);
    await config.getModelProviderManager().start();

    await expect(
      config.reconcileModelWithListedModels({ modelsWereAwaited: true }),
    ).resolves.toBeUndefined();
    expect(config.getModel()).toBe('auto');
  });
});

describe('Model Persistence Bug Fix (#19864)', () => {
  const baseParams: ConfigParameters = {
    loadedSettings: createEmptyLoadedSettings(),
    sessionId: 'test-session',
    cwd: '/tmp',
    targetDir: '/path/to/target',
    debugMode: false,
    model: PREVIEW_3_1_MODEL, // User saved preview model
  };

  /**
   * Pins the catalog list as non-authoritative.
   *
   * `refreshAuth()` runs the real runtime-ready pipeline, which may load a
   * model catalog from the machine's local cache. Since catalog trustworthiness
   * now decides whether an unavailable saved model is preserved or degraded,
   * pin it explicitly so these assertions do not depend on the developer's
   * `~/.qwen` cache. No restore is needed: `afterEach` destroys the catalog
   * singleton, so the spied instance is discarded with it.
   */
  function pinCatalogListUntrusted() {
    mockListedModels([]);
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should NOT reset preview model when preview access is unknown', async () => {
    // hasAccessToPreviewModel stays null; reset only when === false, so we don't reset.
    pinCatalogListUntrusted();
    const config = new Config(baseParams);
    await config.getModelProviderManager().start();

    // Verify initial model is the preview model
    expect(config.getModel()).toBe(PREVIEW_3_1_MODEL);

    // Call refreshAuth to simulate restart
    await config.refreshAuth(AuthType.QODER_BROWSER);

    // Verify the model was NOT reset (bug fix)
    expect(config.getModel()).toBe(PREVIEW_3_1_MODEL);
    expect(config.getModel()).not.toBe(DEFAULT_MODEL_AUTO);
  });

  it('shows the same available model hint for an unavailable saved Qoder model', async () => {
    mockListedEntries([
      {
        key: DEFAULT_MODEL_AUTO,
        display_name: 'Auto',
        is_default: true,
        enable: true,
        is_reasoning: false,
        is_vl: true,
        is_new: false,
        max_input_tokens: 128000,
        max_output_tokens: 8192,
        price_factor: 1,
        original_price_factor: 1,
        source: 'server',
        format: 'qoder',
        tags: [],
        provider: 'qoder',
        model: DEFAULT_MODEL_AUTO,
      },
    ]);

    const config = new Config(baseParams);
    await config.getModelProviderManager().start();
    (
      config as unknown as {
        contentGeneratorConfig: ContentGeneratorConfig;
      }
    ).contentGeneratorConfig = {
      authType: AuthType.QODER_BROWSER,
    } as ContentGeneratorConfig;

    await expect(
      config.reconcileModelWithListedModels({ modelsWereAwaited: true }),
    ).rejects.toThrowError(
      [
        'Invalid model "qwen-coder".',
        'Available models:',
        '  - Auto',
        'Use /model to see available models.',
      ].join('\n'),
    );

    expect(
      (config as unknown as { hasAccessToPreviewModel: boolean | null })
        .hasAccessToPreviewModel,
    ).toBeNull();
  });

  describe('unavailable saved Qoder model with preview access', () => {
    const defaultModel = {
      key: DEFAULT_MODEL_AUTO,
      display_name: 'Auto',
      is_default: true,
      enable: true,
      is_reasoning: false,
      is_vl: true,
      is_new: false,
      max_input_tokens: 128000,
      max_output_tokens: 8192,
      price_factor: 1,
      original_price_factor: 1,
      source: 'server',
      format: 'qoder',
      tags: [],
      provider: 'qoder',
      model: DEFAULT_MODEL_AUTO,
    };

    /** Parse a server model list into the catalog, as a cache/API load would. */
    function seedListedModels(...models: Array<typeof defaultModel>) {
      mockListedEntries(models);
    }

    async function makeQoderConfig() {
      const config = new Config(baseParams);
      await config.getModelProviderManager().start();
      (
        config as unknown as {
          contentGeneratorConfig: ContentGeneratorConfig;
        }
      ).contentGeneratorConfig = {
        authType: AuthType.QODER_BROWSER,
      } as ContentGeneratorConfig;
      config.setHasAccessToPreviewModel(true);
      return config;
    }

    it('falls back to the catalog default once the catalog list is trustworthy', async () => {
      seedListedModels(defaultModel);
      const config = await makeQoderConfig();

      expect(config.getModel()).toBe(PREVIEW_3_1_MODEL);
      await expect(
        config.reconcileModelWithListedModels({ modelsWereAwaited: true }),
      ).resolves.toBeUndefined();

      // Preserving the key would make QoderCatalogStrategy reject every
      // request with ModelNotFoundError for the whole session.
      expect(config.getModel()).toBe(DEFAULT_MODEL_AUTO);
      // The swap must never be silent.
      expect(mockCoreEvents.emitFeedback).toHaveBeenCalledWith(
        'warning',
        expect.stringContaining(PREVIEW_3_1_MODEL),
      );
      expect(mockCoreEvents.emitFeedback).toHaveBeenCalledWith(
        'warning',
        expect.stringContaining('/model'),
      );
    });

    it('does not fall back from Qoder to a local provider model', async () => {
      seedListedModels(
        {
          ...defaultModel,
          key: 'disabled-qoder-model',
          is_default: false,
          enable: false,
        },
        {
          ...defaultModel,
          key: 'local-direct',
          is_default: false,
          source: 'user',
        },
      );
      const config = await makeQoderConfig();

      await expect(
        config.reconcileModelWithListedModels({ modelsWereAwaited: true }),
      ).resolves.toBeUndefined();

      expect(config.getModel()).toBe(PREVIEW_3_1_MODEL);
      expect(mockCoreEvents.emitFeedback).toHaveBeenCalledWith(
        'warning',
        expect.stringContaining('no default model can be selected'),
      );
    });
  });

  it('should NOT reset preview model for USE_GEMINI (hasAccessToPreviewModel is set to true)', async () => {
    pinCatalogListUntrusted();

    const config = new Config(baseParams);
    await config.getModelProviderManager().start();

    // Verify initial model is the preview model
    expect(config.getModel()).toBe(PREVIEW_3_1_MODEL);

    // Call refreshAuth
    await config.refreshAuth(AuthType.QODER_BROWSER);

    // For USE_GEMINI, hasAccessToPreviewModel should be set to true
    // So the model should NOT be reset
    expect(config.getModel()).toBe(PREVIEW_3_1_MODEL);
    expect(config.getHasAccessToPreviewModel()).toBe(true);
  });

  it('should persist model when user selects it with persistMode=true', async () => {
    const onModelChange = vi.fn();
    const config = new Config({
      ...baseParams,
      model: DEFAULT_MODEL_AUTO, // Initial model
      onModelChange,
    });
    await config.getModelProviderManager().start();

    // User selects preview model with persist mode enabled
    await config.setModel(PREVIEW_3_1_MODEL, false); // isTemporary = false

    // Verify onModelChange was called to persist the model
    expect(onModelChange).toHaveBeenCalledWith(PREVIEW_3_1_MODEL);
    expect(config.getModel()).toBe(PREVIEW_3_1_MODEL);
  });
});

describe('ADKSettings', () => {
  const baseParams: ConfigParameters = {
    loadedSettings: createEmptyLoadedSettings(),
    sessionId: 'test',
    targetDir: '.',
    debugMode: false,
    model: 'test-model',
    cwd: '.',
  };

  it('should default agentSessionNoninteractiveEnabled to false', () => {
    const config = new Config(baseParams);
    expect(config.getAgentSessionNoninteractiveEnabled()).toBe(false);
  });

  it('should return provided agentSessionNoninteractiveEnabled', () => {
    const params: ConfigParameters = {
      ...baseParams,
      adk: {
        agentSessionNoninteractiveEnabled: true,
      },
    };
    const config = new Config(params);
    expect(config.getAgentSessionNoninteractiveEnabled()).toBe(true);
  });
});

describe('getExcludeTools deny rules', () => {
  const baseParams: ConfigParameters = {
    loadedSettings: createEmptyLoadedSettings(),
    sessionId: 'test',
    targetDir: '.',
    debugMode: false,
    model: 'test-model',
    cwd: '.',
  };

  const permissionWithDenyRules = (deny: Record<string, string[]>) =>
    makePermissionStub({ deny });

  it.each([
    ['bare tool name', 'Read'],
    ['empty content', 'Read()'],
    ['wildcard content', 'Read(*)'],
  ])(
    'excludes the tool for a tool-wide cliArg deny rule (%s)',
    (_desc, rule) => {
      const config = new Config(baseParams);
      setTestSessionPermission(
        config,
        permissionWithDenyRules({ cliArg: [rule] }),
      );

      expect(config.getExcludeTools()).toContain('Read');
    },
  );

  it.each([
    ['bare tool name', 'Read'],
    ['empty content', 'Read()'],
    ['wildcard content', 'Read(*)'],
  ])(
    'excludes the tool for a tool-wide settings deny rule (%s)',
    (_desc, rule) => {
      const config = new Config(baseParams);
      setTestSessionPermission(
        config,
        permissionWithDenyRules({ projectSettings: [rule] }),
      );

      expect(config.getExcludeTools()).toContain('Read');
    },
  );

  it('does not exclude the tool for a content-scoped deny rule', () => {
    const config = new Config(baseParams);
    setTestSessionPermission(
      config,
      permissionWithDenyRules({ cliArg: ['Bash(rm -rf:*)'] }),
    );

    const excluded = config.getExcludeTools();
    expect(excluded).not.toContain('Bash');
    expect(excluded).not.toContain('Bash(rm -rf:*)');
  });

  it('keeps Agent(name) expressions verbatim so agent types stay excludable', () => {
    const config = new Config(baseParams);
    setTestSessionPermission(
      config,
      permissionWithDenyRules({ cliArg: ['Agent(Explore)'] }),
    );

    expect(config.getExcludeTools()).toContain('Agent(Explore)');
  });

  describe('MCP deny rules', () => {
    const registeredToolNames = new Set([
      'mcp__test1__ping',
      'mcp__test3__alpha',
      'mcp__test3__beta',
      'Bash',
      'Read',
    ]);

    const excludedFor = (rules: string[]): Set<string> => {
      const config = new Config(baseParams);
      setTestSessionPermission(config, permissionWithDenyRules({ cliArg: rules }));
      return config.getExcludeTools(undefined, registeredToolNames)!;
    };

    it('excludes the exact MCP tool named by a deny rule (baseline)', () => {
      const excluded = excludedFor(['mcp__test1__ping']);

      expect(excluded).toContain('mcp__test1__ping');
      expect(excluded).not.toContain('mcp__test3__alpha');
      expect(excluded).not.toContain('mcp__test3__beta');
    });

    it('excludes every tool of a server denied via mcp__server__*', () => {
      const excluded = excludedFor(['mcp__test3__*']);

      expect(excluded).toContain('mcp__test3__alpha');
      expect(excluded).toContain('mcp__test3__beta');
      expect(excluded).not.toContain('mcp__test1__ping');
      expect(excluded).not.toContain('Bash');
      expect(excluded).not.toContain('Read');
    });

    it('excludes all MCP tools for the global mcp__* deny rule', () => {
      const excluded = excludedFor(['mcp__*']);

      expect(excluded).toContain('mcp__test1__ping');
      expect(excluded).toContain('mcp__test3__alpha');
      expect(excluded).toContain('mcp__test3__beta');
      expect(excluded).not.toContain('Bash');
      expect(excluded).not.toContain('Read');
    });

    it('excludes every tool of a server denied via the bare server name', () => {
      const excluded = excludedFor(['mcp__test3']);

      expect(excluded).toContain('mcp__test3__alpha');
      expect(excluded).toContain('mcp__test3__beta');
      expect(excluded).not.toContain('mcp__test1__ping');
    });

    it('does not exclude any tool when only a content-scoped MCP rule matches', () => {
      const excluded = excludedFor(['mcp__test3__alpha(path:/etc/**)']);

      expect(excluded).not.toContain('mcp__test3__alpha');
      expect(excluded).not.toContain('mcp__test3__beta');
    });

    it('keeps non-MCP deny rule behavior unchanged while expanding MCP rules', () => {
      const excluded = excludedFor(['Bash', 'Read(/x/**)', 'mcp__test3__*']);

      // Tool-wide non-MCP deny still hides the tool.
      expect(excluded).toContain('Bash');
      // Content-scoped non-MCP deny must not touch the tool listing.
      expect(excluded).not.toContain('Read');
      // MCP expansion still applies alongside.
      expect(excluded).toContain('mcp__test3__alpha');
      expect(excluded).toContain('mcp__test3__beta');
    });
  });
});

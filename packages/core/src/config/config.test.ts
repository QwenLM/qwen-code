/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  captureHookExecutionOwner,
  getHookExecutionOwner,
} from '../hooks/hook-execution-context.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import { mkdir, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import type {
  ConfigParameters,
  SandboxConfig,
  SkillSettingsLists,
} from './config.js';
import {
  bareDisablementBlocksQualifiedGrantWarnings,
  bareEnabledGrantWarnings,
  Config,
  ApprovalMode,
  APPROVAL_MODES,
  APPROVAL_MODE_INFO,
  MCPServerConfig,
  deriveAgentConfig,
  deriveApprovalModeConfig,
  deriveConfig,
  deriveWorktreeConfig,
  TrustGateError,
  matchesServerPattern,
  matchesAnyServerPattern,
  GOAL_MAX_ACTIVE_MINUTES_CAP,
  GOAL_MAX_TURNS_CAP,
  GOAL_TOKEN_BUDGET_CAP,
  normalizeGoalMaxActiveMinutes,
  normalizeGoalMaxTurns,
  normalizeGoalTokenBudget,
  isValidGoalTokenBudget,
  installSessionWorkflowRevisionWriteThrough,
} from './config.js';
import { GOAL_DEFAULT_TOKEN_BUDGET } from '../goals/goal-protocol.js';
import { Storage } from './storage.js';
import { SshExecutionEnvironment } from '../services/ssh-execution-environment.js';
import { DEFAULT_MAX_TOOL_CALLS_PER_TURN } from '../services/loopDetectionService.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setMemoryFilename as mockSetMemoryFilename } from '../utils/memory-constants.js';
import {
  DEFAULT_TELEMETRY_TARGET,
  DEFAULT_OTLP_ENDPOINT,
  SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH_LIMIT,
  QwenLogger,
  initializeTelemetry,
  isTelemetrySdkInitialized,
  shutdownTelemetry,
  refreshSessionContext,
  logStartSession,
  logSessionEnd,
} from '../telemetry/index.js';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../core/contentGenerator.js';
import { InputFormat } from '../output/types.js';
import { DEFAULT_DASHSCOPE_BASE_URL } from '../core/openaiContentGenerator/constants.js';
import {
  AuthType,
  createContentGenerator,
  createContentGeneratorConfig,
  resetPreloadedContentGenerator,
  resolveContentGeneratorConfigWithSources,
} from '../core/contentGenerator.js';
import { DEFAULT_TOKEN_LIMIT } from '../core/tokenLimits.js';
import { LlmClient } from '../core/client.js';
import { runWithAgentContext } from '../agents/runtime/agent-context.js';
import { buildSessionAgentToolConfig } from '../agents/workspace-agents/capability.js';
import { ShellTool } from '../tools/shell.js';
import { canUseRipgrep } from '../utils/ripgrepUtils.js';
import {
  getSessionProjectDir,
  sessionIdContext,
} from '../utils/sessionIdContext.js';
import {
  createDebugLogger,
  resetDebugLoggingState,
  setDebugLogSession,
} from '../utils/debugLogger.js';
import { logGoalState, logRipgrepFallback } from '../telemetry/loggers.js';
import { RipgrepFallbackEvent } from '../telemetry/types.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { ToolNames } from '../tools/tool-names.js';
import { applySkillSideEffects } from '../tools/skill-utils.js';
import { fireNotificationHook } from '../core/toolHookTriggers.js';
import { AgentType, HookEventName } from '../hooks/types.js';
import { MessageBus } from '../confirmation-bus/message-bus.js';
import {
  MessageBusType,
  type HookExecutionRequest,
  type HookExecutionResponse,
} from '../confirmation-bus/types.js';
import { loadServerHierarchicalMemory } from '../memory/memoryDiscovery.js';
import type { LoadServerHierarchicalMemoryOptions } from '../memory/memoryDiscovery.js';
import {
  readAutoMemoryIndexWithStats,
  readUserAutoMemoryIndexWithStats,
} from '../memory/store.js';
import {
  clearAutoMemoryRootCache,
  getAutoMemoryIndexPath,
  getUserAutoMemoryIndexPath,
} from '../memory/paths.js';
import {
  rebuildTeamAutoMemoryIndex,
  rebuildUserAutoMemoryIndex,
  TeamMemoryRootSecurityError,
} from '../memory/indexer.js';
import { syncTeamMemory } from '../memory/team-memory-sync.js';
import { getTeamMemoryShareabilityWarning } from '../memory/team-memory-git-status.js';
import * as runtimeStatus from '../utils/runtimeStatus.js';
import * as sessionRegistry from '../services/session-registry.js';

/**
 * A settled registration for the shared record, the shape
 * `registerSession` reports. Every test here models a process holding one
 * session; the slot only differs for a process hosting several.
 */
function sharedRegistration(
  registered = true,
): Promise<sessionRegistry.SessionRegistration> {
  return Promise.resolve({
    registered,
    slot: sessionRegistry.SHARED_RECORD_SLOT,
  });
}
import {
  ExtensionManager,
  type Extension,
} from '../extension/extensionManager.js';
import { SkillManager } from '../skills/skill-manager.js';
import * as sandboxPolicy from '../sandbox/runtime-shell-policy.js';
import type { SkillConfig } from '../skills/types.js';
import { createSkillScopedAgentConfig } from '../memory/skillReviewAgentPlanner.js';
import { maybeRunAutoSkillCurator } from '../skills/skill-curator.js';
import { createHookOutput, HookSystem } from '../hooks/index.js';
import { HookRegistry } from '../hooks/hookRegistry.js';
import { HookPlanner } from '../hooks/hookPlanner.js';
import type { FileHistorySnapshot } from '../services/fileHistoryService.js';
import type {
  ChatRecord,
  ChatRecordingFailureEvent,
} from '../services/chatRecordingService.js';
import type { ResumedSessionData } from '../services/sessionService.js';
import { GoalPersistenceUnavailableError } from '../goals/goal-runtime.js';
import type { GoalTurnPermit } from '../goals/goal-protocol.js';
import {
  getSessionWriterLockPath,
  SessionTranscriptChangedError,
  SessionWriterLease,
  SessionWriterUnavailableError,
} from '../services/session-writer-lease.js';
import * as jsonl from '../utils/jsonl-utils.js';
import { checkPriorRead } from '../tools/priorReadEnforcement.js';
import { ToolErrorType } from '../tools/tool-error.js';
import { scanMemoryMetadataCorpusStatus } from '../memory/metadata-migration.js';

function createToolMock(toolName: string) {
  const ToolMock = vi.fn();
  Object.defineProperty(ToolMock.prototype, 'name', { value: toolName });
  Object.defineProperty(ToolMock, 'Name', {
    value: toolName,
    writable: true,
  });
  return ToolMock;
}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const mocked = {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    readdirSync: vi.fn().mockReturnValue([]),
    statSync: vi.fn().mockReturnValue({
      isDirectory: vi.fn().mockReturnValue(true),
    }),
    realpathSync: vi.fn((path) => path),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    copyFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    readFileSync: vi.fn(),
  };
  return {
    ...mocked,
    default: mocked, // Required for ESM default imports (import fs from 'node:fs')
  };
});

vi.mock('../memory/metadata-migration.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../memory/metadata-migration.js')>()),
  scanMemoryMetadataCorpusStatus: vi.fn().mockResolvedValue({
    ready: false,
    revision: 'legacy-revision',
    files: 1,
    legacyFiles: 1,
    legacyByScope: { project: 1, user: 0, team: 0 },
  }),
}));

vi.mock('../memory/scan.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../memory/scan.js')>()),
  scanAutoMemorySnapshot: vi.fn().mockResolvedValue({
    docs: [],
    sourceStatus: {
      requestedScopes: ['project', 'user'],
      searchedScopes: ['project', 'user'],
      unavailableScopes: [],
      complete: true,
      incompleteScopes: [],
    },
  }),
}));

// Mock dependencies that might be called during Config construction or createServerConfig
vi.mock('../tools/tool-registry', () => {
  const ToolRegistryMock = vi.fn();
  ToolRegistryMock.prototype.registerTool = vi.fn();
  ToolRegistryMock.prototype.registerFactory = vi.fn();
  ToolRegistryMock.prototype.unregisterTool = vi.fn();
  ToolRegistryMock.prototype.registerPermissionDeferredFactory = vi.fn();
  ToolRegistryMock.prototype.ensureTool = vi.fn();
  ToolRegistryMock.prototype.warmAll = vi.fn();
  ToolRegistryMock.prototype.discoverAllTools = vi.fn();
  ToolRegistryMock.prototype.getAllTools = vi.fn(() => []); // Mock methods if needed
  ToolRegistryMock.prototype.getAllToolNames = vi.fn(() => []);
  ToolRegistryMock.prototype.getTool = vi.fn();
  ToolRegistryMock.prototype.getFunctionDeclarations = vi.fn(() => []);
  // PR 14b fix (codex round 4): per-instance manager stub so the
  // `setMcpBudgetEventCallback → createToolRegistry → manager.setOnBudgetEvent`
  // integration test can observe each instance's callback wiring.
  // The mock constructor stamps a fresh `__mcpManagerMock` onto each
  // ToolRegistry instance so tests can inspect it via
  // `(registry as unknown as { __mcpManagerMock }).__mcpManagerMock`
  // (escape hatch — production code reads it via `getMcpClientManager`).
  ToolRegistryMock.mockImplementation(function (this: {
    __mcpManagerMock: {
      setOnBudgetEvent: Mock;
      discoverAllMcpToolsIncremental: Mock;
    };
  }) {
    this.__mcpManagerMock = {
      setOnBudgetEvent: vi.fn(),
      // Stubbed so `Config.startMcpDiscoveryInBackground` (kicked off
      // at the tail of `initialize`) doesn't crash on missing method.
      // Test cares only about the `setOnBudgetEvent` wiring; discovery
      // itself is a no-op here.
      discoverAllMcpToolsIncremental: vi.fn().mockResolvedValue(undefined),
    };
    return this;
  });
  ToolRegistryMock.prototype.getMcpClientManager = function (this: {
    __mcpManagerMock: { setOnBudgetEvent: Mock };
  }) {
    return this.__mcpManagerMock;
  };
  return { ToolRegistry: ToolRegistryMock };
});

vi.mock('../memory/memoryDiscovery.js', () => ({
  loadServerHierarchicalMemory: vi.fn().mockResolvedValue({
    memoryContent: '',
    fileCount: 0,
    contextFilePaths: [],
    ruleCount: 0,
    conditionalRules: [],
    projectRoot: '/tmp',
  }),
}));

vi.mock('../memory/store.js', () => ({
  readAutoMemoryIndexWithStats: vi.fn().mockResolvedValue(null),
  readUserAutoMemoryIndexWithStats: vi.fn().mockResolvedValue(null),
}));
vi.mock('../memory/indexer.js', async (importActual) => ({
  // Keep the real exports (notably TeamMemoryRootSecurityError, which the sync
  // gate distinguishes via instanceof) and override only the rebuild.
  ...(await importActual<typeof import('../memory/indexer.js')>()),
  rebuildAutoMemoryIndexAtRoot: vi.fn().mockResolvedValue(null),
  rebuildManagedAutoMemoryIndex: vi.fn().mockResolvedValue(null),
  rebuildTeamAutoMemoryIndex: vi.fn().mockResolvedValue(null),
  rebuildUserAutoMemoryIndex: vi.fn().mockResolvedValue(null),
}));
vi.mock('../memory/team-memory-sync.js', () => ({
  syncTeamMemory: vi
    .fn()
    .mockResolvedValue({ committed: false, pulled: false, pushed: false }),
}));
vi.mock('../agents/forkedAgent.js', () => ({
  runForkedAgent: vi.fn(),
}));
vi.mock('../skills/skill-curator.js', () => ({
  maybeRunAutoSkillCurator: vi.fn().mockResolvedValue({ status: 'not_due' }),
}));
vi.mock('../memory/team-memory-git-status.js', () => ({
  getTeamMemoryShareabilityWarning: vi.fn().mockReturnValue(null),
}));

vi.mock('../hooks/index.js', () => {
  const HookSystemMock = vi.fn();
  HookSystemMock.prototype.runtimeId = 'test-hook-runtime';
  HookSystemMock.prototype.initialize = vi.fn().mockResolvedValue(undefined);
  HookSystemMock.prototype.hasHooksForEvent = vi.fn().mockReturnValue(false);
  HookSystemMock.prototype.isManaged = vi.fn().mockReturnValue(false);
  HookSystemMock.prototype.getAllHooks = vi.fn().mockReturnValue([]);
  return {
    HookSystem: HookSystemMock,
    createHookOutput: vi.fn(),
    createInstructionsLoadedCallback:
      (
        getHookSystem: () => {
          fireInstructionsLoadedEvent?: (...args: unknown[]) => unknown;
        },
        signal?: AbortSignal,
      ) =>
      async (notification: {
        filePath: string;
        memoryType: string;
        loadReason: string;
        triggerFilePath?: string;
        parentFilePath?: string;
      }) => {
        await getHookSystem()?.fireInstructionsLoadedEvent?.(
          notification.filePath,
          notification.memoryType,
          notification.loadReason,
          {
            triggerFilePath: notification.triggerFilePath,
            parentFilePath: notification.parentFilePath,
          },
          signal,
        );
      },
  };
});

// Mock individual tools if their constructors are complex or have side effects
vi.mock('../tools/ls', () => ({ LSTool: createToolMock('list_directory') }));
vi.mock('../tools/read-file', () => ({
  ReadFileTool: createToolMock('read_file'),
}));
vi.mock('../tools/grep.js', () => ({
  GrepTool: createToolMock('grep_search'),
}));
vi.mock('../tools/ripGrep.js', () => ({
  RipGrepTool: createToolMock('grep_search'),
}));
vi.mock('../utils/ripgrepUtils.js', () => ({ canUseRipgrep: vi.fn() }));
vi.mock('../tools/glob', () => ({ GlobTool: createToolMock('glob') }));
vi.mock('../tools/edit', () => ({ EditTool: createToolMock('edit') }));
vi.mock('../tools/shell', () => ({
  ShellTool: createToolMock('run_shell_command'),
}));
vi.mock('../tools/write-file', () => ({
  WriteFileTool: createToolMock('write_file'),
}));
vi.mock('../tools/web-fetch', () => ({
  WebFetchTool: createToolMock('web_fetch'),
}));
vi.mock('../tools/read-many-files', () => ({
  ReadManyFilesTool: createToolMock('read_many_files'),
}));
vi.mock('../utils/memory-constants.js', () => ({
  setMemoryFilename: vi.fn(),
  getCurrentMemoryFilename: vi.fn(() => 'QWEN.md'), // Mock the original filename
  getAllMemoryFilenames: vi.fn(() => ['QWEN.md', 'AGENTS.md']),
  DEFAULT_CONTEXT_FILENAME: 'QWEN.md',
}));
vi.mock('../tools/memory-config', () => ({
  setMemoryFilename: vi.fn(),
  getCurrentMemoryFilename: vi.fn(() => 'QWEN.md'),
  getAllMemoryFilenames: vi.fn(() => ['QWEN.md', 'AGENTS.md']),
  DEFAULT_CONTEXT_FILENAME: 'QWEN.md',
  AGENT_CONTEXT_FILENAME: 'AGENTS.md',
  MEMORY_SECTION_HEADER: '## Qwen Added Memories',
}));

vi.mock('../core/contentGenerator.js');

vi.mock('../core/client.js', () => ({
  LlmClient: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    isInitialized: vi.fn().mockReturnValue(true),
    setTools: vi.fn(),
  })),
}));

vi.mock('../telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../telemetry/index.js')>();
  return {
    ...actual,
    initializeTelemetry: vi.fn(),
    isTelemetrySdkInitialized: vi.fn(() => false),
    shutdownTelemetry: vi.fn().mockResolvedValue(undefined),
    refreshSessionContext: vi.fn(),
    uiTelemetryService: {
      getLastPromptTokenCount: vi.fn(),
    },
  };
});

vi.mock('../telemetry/loggers.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../telemetry/loggers.js')>();
  return {
    ...actual,
    logRipgrepFallback: vi.fn(),
    logGoalState: vi.fn(),
    logStartSession: vi.fn(actual.logStartSession),
    logSessionEnd: vi.fn(actual.logSessionEnd),
  };
});

vi.mock('../skills/skill-manager.js', () => {
  const SkillManagerMock = vi.fn();
  SkillManagerMock.prototype.startWatching = vi
    .fn()
    .mockResolvedValue(undefined);
  SkillManagerMock.prototype.refreshCache = vi
    .fn()
    .mockResolvedValue(undefined);
  SkillManagerMock.prototype.stopWatching = vi.fn();
  SkillManagerMock.prototype.listSkills = vi.fn().mockResolvedValue([]);
  SkillManagerMock.prototype.addChangeListener = vi.fn();
  SkillManagerMock.prototype.removeChangeListener = vi.fn();
  // Path-conditional skill activation hook (called from
  // CoreToolScheduler.executeSingleToolCall on every tool invocation).
  // Mocks return empty so no activation-side effects fire in tests that
  // exercise the scheduler.
  SkillManagerMock.prototype.matchAndActivateByPath = vi
    .fn()
    .mockResolvedValue([]);
  SkillManagerMock.prototype.matchAndActivateByPaths = vi
    .fn()
    .mockResolvedValue([]);
  return { SkillManager: SkillManagerMock };
});

vi.mock('../subagents/subagent-manager.js', () => {
  const SubagentManagerMock = vi.fn();
  SubagentManagerMock.prototype.loadSessionSubagents = vi.fn();
  SubagentManagerMock.prototype.addChangeListener = vi
    .fn()
    .mockReturnValue(() => {});
  SubagentManagerMock.prototype.listSubagents = vi.fn().mockResolvedValue([]);
  return { SubagentManager: SubagentManagerMock };
});

vi.mock('../ide/ide-client.js', () => ({
  IdeClient: {
    getInstance: vi.fn().mockResolvedValue({
      getConnectionStatus: vi.fn(),
      initialize: vi.fn(),
      shutdown: vi.fn(),
    }),
  },
}));

import { BaseLlmClient } from '../core/baseLlmClient.js';

const MEMORY_PRESSURE_ENV_KEYS = [
  'QWEN_MEMORY_PRESSURE_SOFT',
  'QWEN_MEMORY_PRESSURE_HARD',
  'QWEN_MEMORY_PRESSURE_CRITICAL',
];

let mockAutoMemoryInode = 1;
function mockAutoMemoryIndexRead(content: string) {
  return {
    content,
    stats: {
      dev: 1,
      ino: mockAutoMemoryInode++,
      mtimeMs: 1,
      size: Buffer.byteLength(content),
    } as fs.Stats,
  };
}

vi.mock('../core/baseLlmClient.js');
vi.mock('../core/toolHookTriggers.js', () => ({
  fireNotificationHook: vi.fn().mockResolvedValue({}),
}));

type MemoryLoad = Awaited<ReturnType<typeof loadServerHierarchicalMemory>>;
const PROJECT_RULES = '--- Context from: QWEN.md ---\nProject rules';
/** A loadServerHierarchicalMemory result that loaded nothing unless overridden. */
const memoryLoad = (overrides: Partial<MemoryLoad> = {}): MemoryLoad => ({
  memoryContent: '',
  fileCount: 0,
  contextFilePaths: [],
  ruleCount: 0,
  conditionalRules: [],
  projectRoot: '/tmp',
  ...overrides,
});

/** Tool names handed to the mocked registry's eager registration, in order. */
const registeredToolNames = () =>
  vi
    .mocked(ToolRegistry.prototype.registerFactory)
    .mock.calls.map(([name]) => name);
/** Tool names handed to the mocked registry's permission-deferred registration. */
const deferredToolNames = () =>
  vi
    .mocked(ToolRegistry.prototype.registerPermissionDeferredFactory)
    .mock.calls.map(([name]) => name);
/** `names` holds every tool in `has` and none in `lacks`. */
const expectTools = (
  names: string[],
  has: readonly string[],
  lacks: readonly string[] = [],
) => {
  for (const name of has) expect(names).toContain(name);
  for (const name of lacks) expect(names).not.toContain(name);
};

/** The per-instance MCP manager stub the ToolRegistry mock stamps on a registry. */
const mcpManagerOf = (config: Config) =>
  (
    config.getToolRegistry() as unknown as {
      __mcpManagerMock: {
        setOnBudgetEvent: Mock;
        discoverAllMcpToolsIncremental: Mock;
      };
    }
  ).__mcpManagerMock;

/**
 * Typed view of the private Config members tests reach into directly, so each
 * site does not spell out its own `as unknown as { ... }` cast. Fields that
 * tests only ever assign are `unknown` so any stand-in object is accepted.
 */
type ConfigInternals = {
  initialized: boolean;
  toolRegistry: unknown;
  chatRecordingService: unknown;
  permissionManager: unknown;
  llmClient: unknown;
  hookSystem: unknown;
  contentGenerator: unknown;
  contentGeneratorConfig: ContentGeneratorConfig;
  pendingSessionWriterLease: unknown;
  sessionWriterHandoffRequested: boolean;
  mcpServers: Record<string, MCPServerConfig>;
  modelsConfig: { getGenerationConfig(): { reasoning?: unknown } };
  initializeInternal: (options?: { signal?: AbortSignal }) => Promise<void>;
  handleModelChange: (
    authType: AuthType,
    requiresRefresh: boolean,
  ) => Promise<void>;
  activateChatRecording: () => Promise<void>;
  startPendingGoalRestore: () => void;
  notifyChatRecordingFailure: (failure: ChatRecordingFailureEvent) => void;
  teamManager: unknown;
  arenaManager: unknown;
  approvalMode: ApprovalMode;
};
const internals = (config: Config) => config as unknown as ConfigInternals;

/** initialize() options that skip every optional subsystem. */
const SKIP_LLM_INIT = { skipLlmInitialization: true } as const;
const SKIP_ALL_INIT = {
  skipLlmInitialization: true,
  skipHooks: true,
  skipMcpDiscovery: true,
  skipSkillManager: true,
  skipFileCheckpointing: true,
} as const;

/** Snapshot the named env vars; the returned function restores them. */
function stashEnv(...keys: string[]): () => void {
  const saved = keys.map((key) => [key, process.env[key]] as const);
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
/** The smallest parameter set the standalone describes below build from. */
const MINIMAL_PARAMS: ConfigParameters = {
  targetDir: '.',
  debugMode: false,
  model: 'test-model',
  cwd: '.',
  chatRecording: false,
};
/** SKIP_ALL_INIT spelled with the deprecated Gemini option. */
const LEGACY_SKIP_ALL_INIT = {
  skipGeminiInitialization: true,
  skipHooks: true,
  skipMcpDiscovery: true,
  skipSkillManager: true,
  skipFileCheckpointing: true,
} as const;
/** shutdown() options that touch neither telemetry nor the session writer. */
const QUIET_SHUTDOWN = { shutdownTelemetry: false, skipSessionWriter: true };
const STRICT_SHUTDOWN = { ...QUIET_SHUTDOWN, strictResourceCleanup: true };
type ModelProviders = NonNullable<ConfigParameters['modelProvidersConfig']>;

/**
 * Report `dir` (after an optional first `initialDir` read) as the process
 * cwd while keeping the test process in its original directory.
 */
function mockProcessCwd(dir: string, initialDir?: string) {
  const chdirSpy = vi.spyOn(process, 'chdir').mockImplementation(() => {});
  const cwdSpy = vi.spyOn(process, 'cwd');
  if (initialDir !== undefined) cwdSpy.mockReturnValueOnce(initialDir);
  cwdSpy.mockReturnValue(dir);
  return {
    chdirSpy,
    cwdSpy,
    restore: () => {
      chdirSpy.mockRestore();
      cwdSpy.mockRestore();
    },
  };
}

/** Send a hook execution request over the Config's message bus. */
const hookRequest = (
  config: Config,
  eventName: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
) =>
  config.getMessageBus()!.request<HookExecutionRequest, HookExecutionResponse>(
    {
      type: MessageBusType.HOOK_EXECUTION_REQUEST,
      owner: captureHookExecutionOwner(config),
      eventName,
      input,
      ...(signal ? { signal } : {}),
    },
    MessageBusType.HOOK_EXECUTION_RESPONSE,
  );

type GeneratorSources = ReturnType<
  typeof resolveContentGeneratorConfigWithSources
>['sources'];
/** Make the content generator resolver hand back `config` verbatim. */
const resolveGeneratorTo = (
  config: Partial<ContentGeneratorConfig>,
  sources: GeneratorSources = {},
) =>
  vi.mocked(resolveContentGeneratorConfigWithSources).mockReturnValue({
    config: config as ContentGeneratorConfig,
    sources,
  });
/** Make the resolver echo the requested auth type and generation config as `model`. */
const resolveGeneratorModel = (model: string) =>
  vi
    .mocked(resolveContentGeneratorConfigWithSources)
    .mockImplementation((_config, authType, generationConfig) => ({
      config: { ...generationConfig, model, authType },
      sources: {},
    }));
type ModelRoute = NonNullable<
  ConfigParameters['modelProvidersConfig']
>[string][number];
const DASHSCOPE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const IDEALAB_URL = 'https://idealab.alibaba-inc.com/api/anthropic';
const OPENAI_URL = 'https://api.openai.com/v1';
/** A modelProviders route; `name` defaults to the id. */
const route = (
  id: string,
  baseUrl: string,
  envKey: string,
  extra: Partial<ModelRoute> = {},
): ModelRoute => ({ id, name: id, baseUrl, envKey, ...extra });
const dashscopeRoute = (id: string, extra?: Partial<ModelRoute>) =>
  route(id, DASHSCOPE_URL, 'DASHSCOPE_API_KEY', extra);
const idealabRoute = (id: string, extra?: Partial<ModelRoute>) =>
  route(id, IDEALAB_URL, 'IDEALAB_OPUS_API_KEY', extra);
const openaiRoute = (id: string, extra?: Partial<ModelRoute>) =>
  route(id, OPENAI_URL, 'OPENAI_API_KEY', extra);
/** A promise plus its settle functions, for holding an async step open. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
/** Skill settings lists from plain name arrays. */
const skillLists = (
  enabled: string[],
  defaultDisabled: string[] = [],
  hardDisabled: string[] = [],
): SkillSettingsLists => ({
  enabled: new Set(enabled),
  defaultDisabled: new Set(defaultDisabled),
  hardDisabled: new Set(hardDisabled),
});
/** A loaded, active extension named `name` carrying `skills`. */
const extensionFixture = (
  name: string,
  skills: SkillConfig[] = [],
): Extension => ({
  id: 'a'.repeat(64),
  name,
  version: '1.0.0',
  isActive: true,
  path: `/extensions/${name}`,
  config: { name, version: '1.0.0' },
  contextFiles: [],
  skills,
});
/** Record one full, cacheable read of `file` with fixed fake stats. */
const recordFakeRead = (
  cache: ReturnType<Config['getFileReadCache']>,
  file: string,
) =>
  cache.recordRead(
    file,
    { dev: 1, ino: 100, mtimeMs: 1_000_000, size: 42 } as unknown as Stats,
    { full: true, cacheable: true },
  );
describe('bareEnabledGrantWarnings', () => {
  const rustPdf = { name: 'rust:pdf', authoredName: 'pdf' };
  const otherPdf = { name: 'other:pdf', authoredName: 'pdf' };
  const lists = skillLists;
  const rustOff = new Set(['rust:pdf']);
  const joined = (
    skillLists: SkillSettingsLists,
    skills: Array<{ name: string; authoredName?: string }> = [rustPdf],
    defaultOff?: ReadonlySet<string>,
  ) => bareEnabledGrantWarnings(skillLists, skills, defaultOff).join('\n');
  const warning =
    "Warning: skills.enabled lists 'pdf' by bare name, which no longer " +
    "enables the extension skill 'rust:pdf'. Replace it with 'rust:pdf'.";
  const pairWarning =
    "Warning: skills.enabled and skills.defaultDisabled both list 'pdf' " +
    'by bare name. The pair cancels the disablement but no longer ' +
    "enables the extension skill 'rust:pdf', which defaults off. " +
    "Replace the bare 'pdf' with 'rust:pdf' in both skills.enabled " +
    'and skills.defaultDisabled to enable it.';

  it('names the qualified replacement for a stale bare grant', () => {
    expect(bareEnabledGrantWarnings(lists(['pdf']), [rustPdf])).toEqual([
      warning,
    ]);
  });

  it('stays silent for qualified entries, registry-identity entries, non-extension skills, and an empty enabled set', () => {
    expect(bareEnabledGrantWarnings(lists(['rust:pdf']), [rustPdf])).toEqual(
      [],
    );
    // A bare entry that owns some registry identity enables that skill.
    expect(
      bareEnabledGrantWarnings(lists(['pdf']), [rustPdf, { name: 'pdf' }]),
    ).toEqual([]);
    expect(
      bareEnabledGrantWarnings(lists(['commit']), [{ name: 'commit' }]),
    ).toEqual([]);
    expect(bareEnabledGrantWarnings(lists([]), [rustPdf])).toEqual([]);
  });

  it('stays silent for a load-bearing bare entry that cancels a defaultDisabled entry', () => {
    expect(
      bareEnabledGrantWarnings(lists(['pdf'], ['pdf']), [rustPdf]),
    ).toEqual([]);
  });

  it('names every same-authored skill for one shared bare entry', () => {
    expect(
      bareEnabledGrantWarnings(lists(['pdf']), [rustPdf, otherPdf]),
    ).toEqual([
      "Warning: skills.enabled lists 'pdf' by bare name, which no longer " +
        "enables the extension skills 'rust:pdf', 'other:pdf'. Replace it " +
        "with 'rust:pdf', 'other:pdf'.",
    ]);
  });

  it('names the hard block that defeats the replacement', () => {
    expect(joined(lists(['pdf'], [], ['pdf']))).toContain(
      'remove that entry too',
    );
  });

  it('warns when a load-bearing pair targets a default-off extension skill', () => {
    expect(
      bareEnabledGrantWarnings(lists(['pdf'], ['pdf']), [rustPdf], rustOff),
    ).toEqual([pairWarning]);
  });

  it('names only the same-authored members that really default off', () => {
    const skills = [rustPdf, otherPdf];
    expect(
      bareEnabledGrantWarnings(lists(['pdf'], ['pdf']), skills, new Set()),
    ).toEqual([]);
    expect(
      bareEnabledGrantWarnings(lists(['pdf'], ['pdf']), skills, rustOff),
    ).toEqual([pairWarning]);
  });

  it('keeps the replacement advice while a qualified grant coexists with the bare pair', () => {
    expect(
      joined(lists(['pdf', 'rust:pdf'], ['pdf']), [rustPdf], rustOff),
    ).toContain("Replace the bare 'pdf' with 'rust:pdf' in both");
  });

  it('drops the off-state claim when a qualified grant already enables the skill', () => {
    const text = joined(
      lists(['pdf', 'rust:pdf'], ['pdf']),
      [rustPdf],
      rustOff,
    );
    expect(text).toContain('already enables it');
    expect(text).not.toContain('which defaults off');
  });

  it('names granted and ungranted default-off members in separate warnings', () => {
    const text = joined(
      lists(['pdf', 'rust:pdf'], ['pdf']),
      [rustPdf, otherPdf],
      new Set(['rust:pdf', 'other:pdf']),
    );
    expect(text).toContain(
      "enables the extension skill 'other:pdf', which defaults off",
    );
    expect(text).toContain(
      "the qualified grant 'rust:pdf' in skills.enabled already enables",
    );
  });

  it.each([
    ['a hard entry', 'pdf'],
    ['a qualified hard entry', 'rust:pdf'],
  ])(
    'keeps the off-state claim when %s defeats the qualified grant',
    (_label, hardEntry) => {
      const text = joined(
        lists(['pdf', 'rust:pdf'], ['pdf'], [hardEntry]),
        [rustPdf],
        rustOff,
      );
      expect(text).toContain('which defaults off');
      expect(text).not.toContain('already enables');
    },
  );

  it('names the bare hard entry the pair replacement cannot out-enable', () => {
    const text = joined(lists(['pdf'], ['pdf'], ['pdf']), [rustPdf], rustOff);
    expect(text).toContain('which defaults off');
    expect(text).toContain("A bare 'pdf' in skills.disabled also blocks");
    expect(text).toContain('remove that entry too');
  });

  it('names a qualified hard entry the pair replacement cannot out-enable', () => {
    const text = joined(
      lists(['pdf'], ['pdf'], ['rust:pdf']),
      [rustPdf],
      rustOff,
    );
    expect(text).toContain('which defaults off');
    expect(text).toContain("'rust:pdf' in skills.disabled also blocks");
    expect(text).not.toContain('already enables');
  });

  it('pluralizes the grant noun when several qualified grants carry the pair', () => {
    expect(
      joined(
        lists(['pdf', 'rust:pdf', 'other:pdf'], ['pdf']),
        [rustPdf, otherPdf],
        new Set(['rust:pdf', 'other:pdf']),
      ),
    ).toContain(
      "the qualified grants 'rust:pdf', 'other:pdf' in skills.enabled " +
        'already enable them',
    );
  });
});

describe('bareDisablementBlocksQualifiedGrantWarnings', () => {
  const rustPdf = { name: 'rust:pdf', authoredName: 'pdf' };
  const lists = (
    enabled: string[],
    hardDisabled: string[] = [],
  ): SkillSettingsLists => ({
    enabled: new Set(enabled),
    defaultDisabled: new Set(),
    hardDisabled: new Set(hardDisabled),
  });
  const warn = (
    enabled: string[],
    disabledNames: string[],
    hardDisabled: string[] = [],
    skills: Array<{ name: string; authoredName?: string }> = [rustPdf],
  ) =>
    bareDisablementBlocksQualifiedGrantWarnings(
      lists(enabled, hardDisabled),
      new Set(disabledNames),
      skills,
    );
  const defaultAdvice =
    "Warning: skills.enabled opts in 'rust:pdf' but a bare 'pdf' entry " +
    'still blocks it — disable entries match under either spelling; a ' +
    'skills.defaultDisabled entry is cancelled only by the identical ' +
    "spelling. Write 'rust:pdf' in both lists, or remove 'pdf'.";
  const hardAdvice =
    "Warning: skills.enabled opts in 'rust:pdf' but 'pdf' in " +
    'skills.disabled still blocks it — hard entries are never cancelled ' +
    "by skills.enabled. Remove 'pdf' from skills.disabled to enable the " +
    'skill.';

  it('advises both lists for a bare defaultDisabled block', () => {
    expect(warn(['rust:pdf'], ['pdf'])).toEqual([defaultAdvice]);
  });

  it('names the siblings a hard-entry removal re-enables', () => {
    expect(
      warn(
        ['rust:pdf'],
        ['pdf'],
        ['pdf'],
        [rustPdf, { name: 'other:pdf', authoredName: 'pdf' }],
      ).join('\n'),
    ).toContain("The removal also re-enables 'other:pdf'");
  });

  it('never advises re-adding a skill whose registry identity is the bare entry', () => {
    // Following an add-back advice for the local skill would re-block the
    // opt-in under either-spelling matching and reprint this same warning,
    // so the advice must name the limitation instead of the entry.
    const advice = warn(
      ['rust:pdf'],
      ['pdf'],
      ['pdf'],
      [rustPdf, { name: 'pdf' }],
    ).join('\n');

    expect(advice).toContain(
      "'pdf' cannot be blocked on its own while 'rust:pdf' stays enabled",
    );
    expect(advice).not.toContain("Add 'pdf' to skills.disabled");
  });

  it('advises removal for a hard block, since rewriting it would silence the warning without unblocking', () => {
    expect(warn(['rust:pdf'], ['pdf'], ['pdf'])).toEqual([hardAdvice]);
  });

  it('still warns when a same-named skill owns the bare spelling', () => {
    expect(warn(['rust:pdf'], ['pdf'], [], [rustPdf, { name: 'pdf' }])).toEqual(
      [defaultAdvice],
    );
  });

  it('still warns when the bare name is also enabled, if the block is hard', () => {
    expect(warn(['pdf', 'rust:pdf'], ['pdf'], ['pdf'])).toEqual([hardAdvice]);
  });

  it('stays silent for qualified disables, bare enables, and missing pairs', () => {
    expect(warn(['rust:pdf'], ['rust:pdf'])).toEqual([]);
    expect(warn(['pdf'], ['pdf'])).toEqual([]);
    expect(warn([], ['pdf'])).toEqual([]);
    expect(warn(['rust:pdf'], [])).toEqual([]);
  });
});

describe('matchesServerPattern', () => {
  const exact = 'exact match when no glob characters';
  const star = '* matches any sequence including empty';
  const question = '? matches exactly one character';
  const escapes = 'escapes regex special characters';
  const mixed = 'combines glob with exact segments';
  const empty = 'handles empty name';
  const doubleStar = 'handles consecutive * in pattern';
  const boundary = 'handles ? at pattern boundaries';
  const longer = 'rejects when pattern is longer than name';
  it.each([
    [exact, 'puppeteer', 'puppeteer', true],
    [exact, 'puppeteer', 'playwright', false],
    [star, 'puppeteer', '*puppeteer*', true],
    [star, 'my-puppeteer-server', '*puppeteer*', true],
    [star, 'playwright', '*puppeteer*', false],
    [star, 'anything', '*', true],
    [star, 'prefix-suffix', 'prefix*', true],
    [star, 'prefix-suffix', '*suffix', true],
    [question, 'abc', 'a?c', true],
    [question, 'ac', 'a?c', false],
    [question, 'axc', 'a?c', true],
    [escapes, 'my.server', 'my.server', true],
    [escapes, 'myXserver', 'my.server', false],
    [escapes, 'a+b', 'a+b', true],
    [escapes, 'a^b', 'a^b', true],
    [escapes, 'a$b', 'a$b', true],
    [escapes, 'aXb', 'a$b', false],
    [mixed, 'foo-bar-baz', 'foo-*-baz', true],
    [mixed, 'foo-bar-qux', 'foo-*-baz', false],
    [empty, '', '*', true],
    [empty, '', '?', false],
    [empty, '', '', true],
    [doubleStar, 'puppeteer', '**puppeteer**', true],
    [doubleStar, 'abc', 'a**c', true],
    [boundary, 'abc', '?bc', true],
    [boundary, 'abc', 'ab?', true],
    [boundary, 'abc', '???', true],
    [boundary, 'ab', '???', false],
    [longer, 'ab', 'a*b*c', false],
    [longer, 'abc', 'a*b*c', true],
  ])('%s: %j against %j is %s', (_label, name, pattern, expected) => {
    expect(matchesServerPattern(name, pattern)).toBe(expected);
  });
});

describe('matchesAnyServerPattern', () => {
  const emptyList = 'returns false for undefined or empty list';
  const anyMatch = 'matches if any pattern matches';
  const mixed = 'works with mixed exact and glob patterns';
  const patterns = ['playwright', '*puppeteer*'];
  it.each([
    [emptyList, 'puppeteer', undefined, false],
    [emptyList, 'puppeteer', [], false],
    [anyMatch, 'puppeteer', patterns, true],
    [anyMatch, 'chrome', patterns, false],
    [mixed, 'playwright', patterns, true],
    [mixed, 'my-puppeteer', patterns, true],
  ])('%s: %j against %j is %s', (_label, name, list, expected) => {
    expect(matchesAnyServerPattern(name, list)).toBe(expected);
  });
});

describe('Server Config (config.ts)', () => {
  const MODEL = 'qwen3-coder-plus';

  // Default mock for canUseRipgrep to return true (tests that care about ripgrep will override this)
  beforeEach(() => {
    vi.mocked(canUseRipgrep).mockResolvedValue(true);
  });
  const SANDBOX: SandboxConfig = {
    command: 'docker',
    image: 'qwen-code-sandbox',
  };
  const TARGET_DIR = '/path/to/target';
  const DEBUG_MODE = false;
  const QUESTION = 'test question';
  const USER_MEMORY = 'Test User Memory';
  const TELEMETRY_SETTINGS = { enabled: false };
  const EMBEDDING_MODEL = 'gemini-embedding';
  const baseParams: ConfigParameters = {
    cwd: '/tmp',
    embeddingModel: EMBEDDING_MODEL,
    sandbox: SANDBOX,
    targetDir: TARGET_DIR,
    debugMode: DEBUG_MODE,
    question: QUESTION,
    userMemory: USER_MEMORY,
    telemetry: TELEMETRY_SETTINGS,
    model: MODEL,
    chatRecording: false,
    usageStatisticsEnabled: false,
    overrideExtensions: [],
  };
  /** A Config built from baseParams with the given parameter overrides. */
  const makeConfig = (overrides: Partial<ConfigParameters> = {}) =>
    new Config({ ...baseParams, ...overrides });
  /** makeConfig with the given overrides, already initialized with `options`. */
  const initConfig = async (
    overrides: Partial<ConfigParameters> = {},
    options?: Parameters<Config['initialize']>[0],
  ) => {
    const config = makeConfig(overrides);
    await config.initialize(options);
    return config;
  };
  /** A recording Config in an ACP session opted in to the writer lease. */
  const leasedConfig = (overrides: Partial<ConfigParameters> = {}) =>
    makeConfig({
      chatRecording: true,
      experimentalZedIntegration: true,
      sessionWriterLeaseEnabled: true,
      ...overrides,
    });
  const recordingConfig = (overrides: Partial<ConfigParameters> = {}) =>
    makeConfig({ chatRecording: true, ...overrides });
  /** Rebuild the registry the way a subagent override does. */
  const rebuildForSubAgent = (config: Config) =>
    config.createToolRegistry(undefined, {
      skipDiscovery: true,
      forSubAgent: true,
    });
  const systemHooks = {
    SessionStart: [{ hooks: [{ type: 'command', command: 'echo system' }] }],
  };
  const userHooks = {
    PreToolUse: [{ hooks: [{ type: 'command', command: 'echo user' }] }],
  };
  const projectHooks = {
    PostToolUse: [{ hooks: [{ type: 'command', command: 'echo project' }] }],
  };
  /** Make createContentGenerator resolve a bare stub generator. */
  const stubContentGenerator = () =>
    vi.mocked(createContentGenerator).mockResolvedValue({
      generateContent: vi.fn(),
      generateContentStream: vi.fn(),
      embedContent: vi.fn(),
    } as unknown as ContentGenerator);
  /** A running background task entry for the background task registry. */
  const backgroundTask = (
    agentId: string,
    description: string,
    model?: string,
  ) => ({
    agentId,
    description,
    ...(model ? { model } : {}),
    isBackgrounded: true,
    status: 'running' as const,
    startTime: Date.now(),
    abortController: new AbortController(),
    outputFile: `/tmp/${agentId}.jsonl`,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(scanMemoryMetadataCorpusStatus).mockResolvedValue({
      ready: false,
      revision: 'legacy-revision',
      files: 1,
      legacyFiles: 1,
      legacyByScope: { project: 1, user: 0, team: 0 },
    });
    mockAutoMemoryInode = 1;
    for (const envName of MEMORY_PRESSURE_ENV_KEYS) {
      delete process.env[envName];
    }
    (fs.existsSync as Mock).mockReturnValue(true);
    (fs.readdirSync as Mock).mockReturnValue([]);
    (fs.statSync as Mock).mockReturnValue({
      isDirectory: vi.fn().mockReturnValue(true),
    });
    vi.mocked(fs.realpathSync).mockImplementation((path) => path.toString());
    (fs.mkdirSync as Mock).mockImplementation(() => undefined);
    (fs.writeFileSync as Mock).mockImplementation(() => undefined);
    (fs.renameSync as Mock).mockImplementation(() => undefined);
    (fs.copyFileSync as Mock).mockImplementation(() => undefined);
    (fs.unlinkSync as Mock).mockImplementation(() => undefined);
    (fs.readFileSync as Mock).mockImplementation(() => undefined);
    vi.mocked(isTelemetrySdkInitialized).mockReturnValue(false);
    vi.spyOn(QwenLogger.prototype, 'logStartSessionEvent').mockImplementation(
      async () => undefined,
    );

    vi.mocked(resolveContentGeneratorConfigWithSources).mockImplementation(
      (_config, authType, generationConfig) => ({
        config: {
          ...generationConfig,
          authType,
          model: generationConfig?.model || MODEL,
          apiKey: 'test-key',
        } as ContentGeneratorConfig,
        sources: {},
      }),
    );
  });

  it('forwards usageStatisticsEnabled and proxy to the extension manager', () => {
    // installProxyDispatcher: false keeps this test from pinning a
    // process-global undici dispatcher; the wiring under test (the two
    // constructor options reaching ExtensionManager) is unaffected.
    const config = new Config({
      ...baseParams,
      usageStatisticsEnabled: false,
      proxy: 'http://127.0.0.1:8080',
      installProxyDispatcher: false,
    });

    const manager = config.getExtensionManager() as unknown as {
      usageStatisticsEnabled?: boolean;
      proxy?: string;
    };
    expect(manager.usageStatisticsEnabled).toBe(false);
    expect(manager.proxy).toBe('http://127.0.0.1:8080');
  });

  it('installs the proxy dispatcher by default when a proxy resolves', async () => {
    // Every pre-existing session Config takes this arm: it passes no
    // `installProxyDispatcher`, so the default is what honours `settings.proxy`
    // for LLM and MCP traffic. Both callers that pass the flag pass `false`
    // (the telemetry-only Config), so without this case inverting the default
    // to `false` leaves the suite green while session traffic silently goes
    // direct (#12770 follow-up).
    const { getGlobalDispatcher, setGlobalDispatcher, EnvHttpProxyAgent } =
      await import('undici');
    const { resetDispatcherCache } = await import(
      '../utils/runtimeFetchOptions.js'
    );
    const originalDispatcher = getGlobalDispatcher();
    try {
      const config = new Config({
        ...baseParams,
        proxy: 'http://127.0.0.1:8080',
      });
      // undici loads behind a dynamic import, so the install settles
      // asynchronously; `initialize()` awaits this same promise.
      await (config as unknown as { proxyDispatcherReady?: Promise<void> })
        .proxyDispatcherReady;

      const installed = getGlobalDispatcher();
      expect(installed).not.toBe(originalDispatcher);
      expect(installed).toBeInstanceOf(EnvHttpProxyAgent);
    } finally {
      setGlobalDispatcher(originalDispatcher);
      resetDispatcherCache();
    }
  });

  describe('setHooksFromSettings', () => {
    it.each([
      [
        'replaces the user hooks captured at construction',
        { userHooks: { Stop: [] } },
        { userHooks },
        userHooks,
        undefined,
      ],
      [
        'replaces project hooks without leaking them into user hooks',
        {},
        { projectHooks },
        undefined,
        projectHooks,
      ],
      [
        'keeps the safe mode gate after replacing hooks',
        { safeMode: true },
        { userHooks, projectHooks, hooks: userHooks },
        undefined,
        undefined,
      ],
    ])('%s', (_title, params, settings, user, project) => {
      const config = makeConfig(params);

      config.setHooksFromSettings(settings);

      expect(config.getUserHooks()).toBe(user);
      expect(config.getProjectHooks()).toBe(project);
    });

    it('replaces the legacy merged hooks so a removed hook cannot return through the fallback', () => {
      const config = makeConfig({ hooks: userHooks });
      expect(config.getUserHooks()).toBe(userHooks);

      config.setHooksFromSettings({});

      expect(config.getUserHooks()).toBeUndefined();
      expect(config.getProjectHooks()).toBeUndefined();
    });

    it.each([false, undefined])(
      'keeps the project hook gate when folder trust is %s',
      (trustedFolder) => {
        const config = makeConfig({ folderTrust: true, trustedFolder });

        config.setHooksFromSettings({ userHooks, projectHooks });

        expect(config.getProjectHooks()).toBeUndefined();
        expect(config.getUserHooks()).toBe(userHooks);
      },
    );

    it('replaces system hooks together with the other fields', () => {
      const config = makeConfig({ systemHooks });

      config.setHooksFromSettings({ userHooks });

      expect(config.getSystemHooks()).toBeUndefined();
      expect(config.getUserHooks()).toBe(userHooks);
    });
  });

  describe('per-scope hooks and the legacy merged fallback', () => {
    const mergedHooks = { ...systemHooks, ...userHooks, ...projectHooks };

    it.each([
      [
        'does not read the merged hooks as project hooks when only user hooks are supplied',
        { userHooks },
        userHooks,
        undefined,
      ],
      [
        'does not read the merged hooks as user hooks when only project hooks are supplied',
        { projectHooks },
        undefined,
        projectHooks,
      ],
      [
        'still serves the merged hooks as user and project hooks when no scope is supplied',
        {},
        mergedHooks,
        mergedHooks,
      ],
    ])('%s', (_title, params, user, project) => {
      const config = makeConfig({ ...params, hooks: mergedHooks });

      expect(config.getUserHooks()).toBe(user);
      expect(config.getProjectHooks()).toBe(project);
    });

    it('serves system hooks without promoting the merged hooks to system hooks', () => {
      const withSystem = makeConfig({ systemHooks, hooks: mergedHooks });

      expect(withSystem.getSystemHooks()).toBe(systemHooks);
      expect(withSystem.getUserHooks()).toBeUndefined();
      expect(withSystem.getProjectHooks()).toBeUndefined();
    });

    it.each([
      ['safe mode', { safeMode: true }],
      ['bare mode', { bareMode: true }],
    ])('loads no system hooks in %s', (_label, mode) => {
      const config = makeConfig({ ...mode, systemHooks });

      expect(config.getSystemHooks()).toBeUndefined();
    });

    describe('registration through the hook registry', () => {
      // What the CLI handed Config before system hooks had their own channel:
      // a user settings hook, no workspace hooks, and the merged settings
      // (which then held only that user hook) as the legacy field.
      const lintHook = {
        PreToolUse: [
          {
            hooks: [{ type: 'command', command: './lint.sh', name: 'lint' }],
          },
        ],
      };

      async function registryFor(params: Partial<ConfigParameters>) {
        const config = makeConfig({ ...params });
        const registry = new HookRegistry(config);
        await registry.initialize();
        return registry;
      }

      it('registers a user settings hook once, under the user source', async () => {
        const registry = await registryFor({
          userHooks: lintHook,
          hooks: lintHook,
        });

        expect(
          registry.getAllHooks().map(({ eventName, source }) => ({
            eventName,
            source,
          })),
        ).toEqual([{ eventName: HookEventName.PreToolUse, source: 'user' }]);
      });

      it('runs that hook once per event, as it did while it was registered twice', async () => {
        // The planner dedups by hook identity regardless of source, so the
        // double registration never doubled execution; this pins that the
        // change above does not alter how many times the hook runs.
        const registry = await registryFor({
          userHooks: lintHook,
          hooks: lintHook,
        });

        const plan = new HookPlanner(registry).createExecutionPlan(
          HookEventName.PreToolUse,
          { toolName: 'read_file' },
        );

        expect(plan?.hookConfigs).toHaveLength(1);
      });

      it('runs a hook registered under two sources once, because the planner dedups by identity', async () => {
        // A Config built from merged settings alone still registers the hook
        // under both the user and project sources. The planner is what keeps
        // that from running it twice.
        const registry = await registryFor({ hooks: lintHook });
        expect(registry.getAllHooks().map(({ source }) => source)).toEqual([
          'user',
          'project',
        ]);

        const plan = new HookPlanner(registry).createExecutionPlan(
          HookEventName.PreToolUse,
          { toolName: 'read_file' },
        );

        expect(plan?.hookConfigs).toHaveLength(1);
      });
    });

    it('loads system hooks in an untrusted folder, where project hooks are withheld', () => {
      const config = makeConfig({
        trustedFolder: false,
        systemHooks,
        projectHooks,
      });

      expect(config.getSystemHooks()).toBe(systemHooks);
      expect(config.getProjectHooks()).toBeUndefined();
    });
  });

  describe('onMessageBusChange', () => {
    it('calls a listener at once when a bus already exists', () => {
      const config = makeConfig();
      const bus = new MessageBus();
      config.setMessageBus(bus);
      const listener = vi.fn();

      config.onMessageBusChange(listener);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(config.getMessageBus());
    });

    it('waits for initialize when no bus exists yet', async () => {
      const config = makeConfig();
      const listener = vi.fn();

      config.onMessageBusChange(listener);
      expect(listener).not.toHaveBeenCalled();

      await config.initialize();

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(config.getMessageBus());
    });

    it('announces the bus only once it can run hooks', async () => {
      const config = makeConfig();
      const requestListenerCounts: number[] = [];
      config.onMessageBusChange((bus) => {
        requestListenerCounts.push(
          bus.listenerCount(MessageBusType.HOOK_EXECUTION_REQUEST),
        );
      });

      await config.initialize();

      expect(requestListenerCounts).toHaveLength(1);
      expect(requestListenerCounts[0]).toBeGreaterThanOrEqual(1);
    });

    it('stops notifying a disposed listener', () => {
      const config = makeConfig();
      const listener = vi.fn();
      const dispose = config.onMessageBusChange(listener);

      dispose();
      config.setMessageBus(new MessageBus());

      expect(listener).not.toHaveBeenCalled();
    });

    it('keeps initializing and notifying others when a listener throws', async () => {
      const config = makeConfig();
      config.onMessageBusChange(() => {
        throw new Error('observer broke');
      });
      const other = vi.fn();
      config.onMessageBusChange(other);

      await expect(config.initialize()).resolves.toBeUndefined();

      expect(other).toHaveBeenCalledTimes(1);
    });

    it('handles a rejection from an async listener', async () => {
      const config = makeConfig();
      let catchSpy: ReturnType<typeof vi.fn> | undefined;
      config.onMessageBusChange(() => {
        // Created while notified, so the only chance to handle it is the
        // caller's: nothing else attaches a handler before it settles.
        const rejection = Promise.reject(new Error('async observer broke'));
        catchSpy = vi.spyOn(rejection, 'catch') as unknown as ReturnType<
          typeof vi.fn
        >;
        return rejection;
      });

      await expect(config.initialize()).resolves.toBeUndefined();

      expect(catchSpy).toHaveBeenCalledTimes(1);
    });

    it('lets a listener dispose itself while it is notified', () => {
      const config = makeConfig();
      const calls: string[] = [];
      const dispose = config.onMessageBusChange(() => {
        calls.push('self-disposing');
        dispose();
      });
      config.onMessageBusChange(() => {
        calls.push('other');
      });

      expect(() => config.setMessageBus(new MessageBus())).not.toThrow();
      config.setMessageBus(new MessageBus());

      expect(calls).toEqual(['self-disposing', 'other', 'other']);
    });

    it('notifies a listener added during notification exactly once', () => {
      const config = makeConfig();
      const late = vi.fn();
      const dispose = config.onMessageBusChange(() => {
        dispose();
        config.onMessageBusChange(late);
      });

      config.setMessageBus(new MessageBus());

      // Once from its own registration, which sees the bus already set; the
      // announcement in progress must not reach it a second time.
      expect(late).toHaveBeenCalledTimes(1);
    });

    it('does not re-announce the bus it already has', () => {
      const config = makeConfig();
      const bus = new MessageBus();
      config.setMessageBus(bus);
      const listener = vi.fn();
      config.onMessageBusChange(listener);

      config.setMessageBus(bus);

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('announces nothing when all hooks are disabled', async () => {
      const config = makeConfig({ disableAllHooks: true });
      const listener = vi.fn();
      config.onMessageBusChange(listener);

      await config.initialize();

      expect(config.getMessageBus()).toBeUndefined();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('skill settings migration warnings at initialize', () => {
    // The pure generators are unit-tested above; these pin the wiring —
    // initialize() must consume the provider and surface its warnings, or a
    // refactor that drops the block stays green.
    const initializeWithLists = async (
      lists: SkillSettingsLists,
      disabledSkillNamesProvider: () => ReadonlySet<string> = () =>
        lists.hardDisabled,
    ) => {
      vi.mocked(SkillManager.prototype.listSkills).mockResolvedValueOnce([
        { name: 'rust:pdf', authoredName: 'pdf' } as SkillConfig,
      ]);
      return initConfig({
        skillSettingsListsProvider: () => lists,
        disabledSkillNamesProvider,
      });
    };
    const warningsOf = (config: Config) => config.getWarnings().join('\n');

    it('surfaces the stale bare grant warning from the provider lists', async () => {
      expect(
        warningsOf(await initializeWithLists(skillLists(['pdf']))),
      ).toContain("no longer enables the extension skill 'rust:pdf'");
    });

    it('surfaces the bare disablement blocking a qualified grant', async () => {
      const config = await initializeWithLists(
        skillLists(['rust:pdf'], [], ['pdf']),
      );
      expect(warningsOf(config)).toContain('still blocks it');
    });

    it('warns with the default-entry advice when the resolved disable set exceeds the hard list', async () => {
      const config = await initializeWithLists(
        skillLists(['rust:pdf'], ['pdf']),
        () => new Set(['pdf']),
      );
      expect(warningsOf(config)).toContain(
        'cancelled only by the identical spelling',
      );
    });

    it('surfaces the default-off pair warning named by registry identity', async () => {
      // The pure function is pinned above; this pins the caller half: the
      // default-off set initialize() collects must carry registry names,
      // or the pair warning goes silent while the skill stays off.
      vi.mocked(SkillManager.prototype.listSkills).mockResolvedValueOnce([
        {
          name: 'rust:pdf',
          authoredName: 'pdf',
          level: 'extension',
          extensionName: 'rust',
        } as SkillConfig,
      ]);
      const config = makeConfig({
        // baseParams pins overrideExtensions to []; lift it so the mocked
        // loaded extension reaches getExtensions() and feeds the caller.
        overrideExtensions: undefined,
        skillSettingsListsProvider: () => skillLists(['pdf'], ['pdf']),
      });
      const manager = config.getExtensionManager();
      vi.spyOn(manager, 'getLoadedExtensions').mockReturnValue([
        extensionFixture('rust'),
      ]);
      vi.spyOn(manager, 'getExtensionSkillState').mockReturnValue({
        defaultEnabled: false,
        workspaceEnabled: null,
      });
      await config.initialize();

      expect(warningsOf(config)).toContain(
        "enables the extension skill 'rust:pdf', which defaults off",
      );
    });

    it('stays silent without a provider', async () => {
      expect(warningsOf(await initConfig())).not.toContain(
        'skills.enabled lists',
      );
    });
  });

  it('resolves live skill settings without reviving an inactive or removed owner', () => {
    const disabled = new Set<string>();
    const enabled = new Set<string>();
    const config = makeConfig({
      disabledSkillNamesProvider: () => disabled,
      enabledSkillNamesProvider: () => enabled,
      overrideExtensions: undefined,
    });
    const skill: SkillConfig = {
      name: 'Review',
      description: 'Review changes',
      level: 'extension',
      filePath: '/extensions/suite/skills/review/SKILL.md',
      body: 'Review instructions',
      extensionName: 'suite',
    };
    const extension = extensionFixture('suite', [skill]);
    const manager = config.getExtensionManager();
    vi.spyOn(manager, 'getLoadedExtensions').mockReturnValue([extension]);
    const state = {
      defaultEnabled: true,
      workspaceEnabled: null as boolean | null,
    };
    vi.spyOn(manager, 'getExtensionSkillState').mockReturnValue(state);

    for (const [declared, workspace, blocked, optedIn, expected] of [
      [true, null, false, false, true],
      [false, null, false, false, false],
      [true, false, false, false, false],
      [false, true, false, false, true],
      [true, true, true, false, false],
      [false, false, false, true, true],
      [true, true, true, true, false],
    ] as const) {
      state.defaultEnabled = declared;
      state.workspaceEnabled = workspace;
      blocked ? disabled.add('review') : disabled.clear();
      optedIn ? enabled.add('review') : enabled.clear();
      expect(config.isSkillEnabled(skill)).toBe(expected);
    }

    disabled.clear();
    enabled.add('review');
    extension.isActive = false;
    expect(config.isSkillEnabled(skill)).toBe(false);
    extension.isActive = true;
    extension.skills = [];
    expect(config.isSkillEnabled(skill)).toBe(false);
    extension.skills = [skill];
    expect(config.isSkillEnabled({ ...skill, extensionName: 'other' })).toBe(
      false,
    );
    expect(
      config.isSkillEnabled({ ...skill, filePath: '/unowned/SKILL.md' }),
    ).toBe(false);
    expect(config.isSkillEnabled({ ...skill, level: 'project' })).toBe(true);
    expect(config.getDisabledSkillNames()).toEqual(new Set());

    // A renamed extension skill: the registry spells it with its owner, the
    // manifest and the workspace extension-skill store still spell it as
    // authored. Both views must resolve to the same skill.
    const qualified = {
      ...skill,
      name: 'suite:Review',
      authoredName: 'Review',
    };
    disabled.clear();
    enabled.clear();
    state.defaultEnabled = true;
    state.workspaceEnabled = null;
    expect(config.isSkillEnabled(qualified)).toBe(true);

    // Restriction: either spelling blocks it.
    disabled.add('review');
    expect(config.isSkillEnabled(qualified)).toBe(false);
    disabled.clear();
    disabled.add('suite:review');
    expect(config.isSkillEnabled(qualified)).toBe(false);

    // Grant: only the registry identity opens it. A legacy bare entry does
    // not, because an unrelated rename must not hand out capability.
    disabled.clear();
    state.defaultEnabled = false;
    enabled.add('review');
    expect(config.isSkillEnabled(qualified)).toBe(false);
    enabled.add('suite:review');
    expect(config.isSkillEnabled(qualified)).toBe(true);

    // The store is keyed by the authored name, so a default declared by the
    // extension author still applies to the renamed skill.
    enabled.clear();
    state.defaultEnabled = false;
    state.workspaceEnabled = null;
    expect(config.isSkillEnabled(qualified)).toBe(false);
    state.workspaceEnabled = true;
    expect(config.isSkillEnabled(qualified)).toBe(true);

    const stateSpy = vi.mocked(manager.getExtensionSkillState);
    stateSpy.mockClear();
    config.isSkillEnabled(qualified);
    expect(stateSpy).toHaveBeenCalledWith(extension.id, 'Review');
  });

  describe('project-dir registry lifecycle', () => {
    it('drops its session entry on shutdown — no daemon leak', async () => {
      const sessionId = 'cfg-shutdown-test-session';
      const config = makeConfig({ sessionId });
      expect(getSessionProjectDir(sessionId)).toBeUndefined();
      await config.initialize(SKIP_ALL_INIT);
      expect(getSessionProjectDir(sessionId)).toBeDefined();
      await config.shutdown();
      // In daemon mode this is what stops the map growing per session.
      expect(getSessionProjectDir(sessionId)).toBeUndefined();
    });

    it('accepts the deprecated Gemini initialization option', async () => {
      const config = await initConfig({}, LEGACY_SKIP_ALL_INIT);
      expect(config.getGeminiClient()).toBe(config.getLlmClient());
      await config.shutdown();
    });
  });

  // Shared isolation for the debug-fallback tests. The module-level
  // vi.mock('node:fs') overrides only the sync fs API, so an un-spied
  // fs.promises call would write into the real global debug dir: spy the whole
  // fallback/alias surface (mkdir, appendFile, unlink, symlink, readlink) in
  // one place so the tests can't drift apart, and restore env + logger state
  // afterwards. Bodies read the spy back via vi.mocked(fs.promises.appendFile):
  // vi.spyOn's generic-overload return type is not assignable to a typed
  // callback argument (TS2345). `logFile` turns the debug log file on first.
  async function withDebugFallbackIsolation(
    run: () => Promise<void>,
    logFile = false,
  ): Promise<void> {
    const restoreEnv = stashEnv('QWEN_DEBUG_LOG_FILE', 'QWEN_CODE_SESSION_ID');
    const spies = [
      vi.spyOn(fs.promises, 'mkdir').mockResolvedValue(undefined),
      vi.spyOn(fs.promises, 'appendFile').mockResolvedValue(undefined),
      vi.spyOn(fs.promises, 'unlink').mockResolvedValue(undefined),
      vi.spyOn(fs.promises, 'symlink').mockResolvedValue(undefined),
      vi.spyOn(fs.promises, 'readlink').mockResolvedValue(''),
    ];
    try {
      delete process.env['QWEN_DEBUG_LOG_FILE'];
      resetDebugLoggingState();
      if (logFile) {
        process.env['QWEN_DEBUG_LOG_FILE'] = '1';
        resetDebugLoggingState();
      }
      await run();
    } finally {
      for (const spy of spies) spy.mockRestore();
      resetDebugLoggingState();
      setDebugLogSession(null);
      restoreEnv();
    }
  }
  /** Log `message` under `tag`; it must land in `toId`'s debug log, not `notToId`'s. */
  async function expectDebugRouted(
    tag: string,
    message: string,
    toId: string,
    notToId: string,
  ) {
    process.env['QWEN_DEBUG_LOG_FILE'] = '1';
    createDebugLogger(tag).info(message);
    const line = () => expect.stringContaining(`[${tag}] ${message}`);
    const appendFile = vi.mocked(fs.promises.appendFile);
    await vi.waitFor(() =>
      expect(appendFile).toHaveBeenCalledWith(
        Storage.getDebugLogPath(toId),
        line(),
        'utf8',
      ),
    );
    expect(appendFile).not.toHaveBeenCalledWith(
      Storage.getDebugLogPath(notToId),
      line(),
      'utf8',
    );
  }

  it('does not replace the global debug fallback during daemon Config creation or rotation', async () => {
    await withDebugFallbackIsolation(async () => {
      const bootstrapSessionId = '550e8400-e29b-41d4-a716-446655440000';
      const daemonSessionId = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
      const rotatedSessionId = '7ba7b810-9dad-11d1-80b4-00c04fd430c8';
      makeConfig({ sessionId: bootstrapSessionId });
      const daemonConfig = sessionIdContext.run(daemonSessionId, () =>
        makeConfig({ sessionId: daemonSessionId }),
      );
      sessionIdContext.run(daemonSessionId, () => {
        daemonConfig.startNewSession(rotatedSessionId);
      });

      await expectDebugRouted(
        'DAEMON_FALLBACK',
        'process-scoped message',
        bootstrapSessionId,
        rotatedSessionId,
      );
    });
  });

  it('claims the global debug fallback on un-contexted rotation (single-session CLI)', async () => {
    // The other direction of the guard above: a single-session CLI /clear
    // rotates the Config OUTSIDE any sessionIdContext, and the process-wide
    // debug session must follow the rotated id, or post-rotation logs keep
    // landing in the pre-rotation file. Rotating the SAME Config would reroute
    // anyway (the fallback holds a live reference); the claim is load-bearing
    // for RE-claiming after another Config (transcript replay, bootstrap) took
    // the fallback.
    await withDebugFallbackIsolation(async () => {
      const rotatedSessionId = '7ba7b810-9dad-11d1-80b4-00c04fd430c8';
      const cliConfig = makeConfig({
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
      });
      const interloperSessionId = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
      makeConfig({ sessionId: interloperSessionId });

      cliConfig.startNewSession(rotatedSessionId);

      await expectDebugRouted(
        'CLI_ROTATION',
        'post-rotation message',
        rotatedSessionId,
        interloperSessionId,
      );
    });
  });

  describe('shell execution config', () => {
    it.each([
      [
        'allows explicitly clearing the configured pager',
        { pager: undefined },
        undefined,
      ],
      [
        'preserves the existing pager when an update omits the pager key',
        { terminalWidth: 120 },
        'less',
      ],
    ])('%s', (_title, update, expected) => {
      const config = makeConfig();
      config.setShellExecutionConfig({ pager: 'less' });
      expect(config.getShellExecutionConfig().pager).toBe('less');
      config.setShellExecutionConfig(update);
      expect(config.getShellExecutionConfig().pager).toBe(expected);
    });
  });

  /** Settings values the omni budget getters must treat as unset. */
  const badBudgets = () =>
    [
      ['unset', undefined],
      ['zero', 0],
      ['negative', -1],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
    ] as Array<[string, number | undefined]>;

  describe('omni quarantine budget getters', () => {
    it('passes through positive settings', () => {
      const config = makeConfig({
        omniQuarantineRetentionDays: 3,
        omniQuarantineMaxBytes: 1024,
      });
      expect(config.getOmniQuarantineRetentionDays()).toBe(3);
      expect(config.getOmniQuarantineMaxBytes()).toBe(1024);
    });

    it.each(badBudgets())(
      'falls back to defaults on a %s setting (a bad value must not expire the whole quarantine)',
      (_label, bad) => {
        const config = makeConfig({
          omniQuarantineRetentionDays: bad,
          omniQuarantineMaxBytes: bad,
        });
        expect(config.getOmniQuarantineRetentionDays()).toBe(7);
        expect(config.getOmniQuarantineMaxBytes()).toBe(5 * 1024 * 1024 * 1024);
      },
    );
  });

  describe('omni storage GC getters (settings → sweep knobs)', () => {
    it('passes through valid settings', () => {
      const config = makeConfig({
        omniStorageRetentionDays: 3,
        omniStorageMaxTotalBytes: 1024,
      });
      expect(config.getOmniStorageRetentionDays()).toBe(3);
      expect(config.getOmniStorageMaxTotalBytes()).toBe(1024);
    });

    it.each([
      ...badBudgets(),
      // Sub-day retention would gut the multi-process grace window the
      // GC's safety argument leans on — the schema promises minimum 1.
      ['sub-day', 0.5],
    ])('retentionDays falls back to 14 on a %s setting', (_label, bad) => {
      const config = makeConfig({ omniStorageRetentionDays: bad });
      expect(config.getOmniStorageRetentionDays()).toBe(14);
    });

    it.each(badBudgets())(
      'maxTotalBytes falls back to 20 GiB on a %s setting',
      (_label, bad) => {
        const config = makeConfig({ omniStorageMaxTotalBytes: bad });
        expect(config.getOmniStorageMaxTotalBytes()).toBe(
          20 * 1024 * 1024 * 1024,
        );
      },
    );
  });

  describe('memory file count compatibility', () => {
    it('keeps the legacy parameter and accessors until a future major release', () => {
      const config = makeConfig({ geminiMdFileCount: 2 });

      expect(config.getMemoryFileCount()).toBe(2);
      expect(config.getGeminiMdFileCount()).toBe(2);

      config.setGeminiMdFileCount(3);
      expect(config.getMemoryFileCount()).toBe(3);
    });

    it('prefers the renamed parameter when both names are present', () => {
      const config = makeConfig({
        geminiMdFileCount: 2,
        memoryFileCount: 4,
      });

      expect(config.getMemoryFileCount()).toBe(4);
    });
  });

  describe('getMemoryAgentTimeoutMinutes', () => {
    it.each`
      title                                                                        | params                               | expected
      ${'returns undefined when unset'}                                            | ${{}}                                | ${undefined}
      ${'passes through non-negative values, including 0 (no time limit)'}         | ${{ memoryAgentTimeoutMinutes: 30 }} | ${30}
      ${'passes through non-negative values, including 0 (no time limit)'}         | ${{ memoryAgentTimeoutMinutes: 0 }}  | ${0}
      ${'treats negative values as unset (schema validation is bypassed on load)'} | ${{ memoryAgentTimeoutMinutes: -5 }} | ${undefined}
    `('%s', ({ params, expected }) => {
      expect(makeConfig(params).getMemoryAgentTimeoutMinutes()).toBe(expected);
    });
  });

  describe('getMemoryAgentMaxTurns', () => {
    it.each`
      title                                                | params                          | expected
      ${'returns undefined when unset'}                    | ${{}}                           | ${undefined}
      ${'passes through non-negative values, including 0'} | ${{ memoryAgentMaxTurns: 25 }}  | ${25}
      ${'passes through non-negative values, including 0'} | ${{ memoryAgentMaxTurns: 0 }}   | ${0}
      ${'treats negative values as unset'}                 | ${{ memoryAgentMaxTurns: -1 }}  | ${undefined}
      ${'treats fractional values as unset'}               | ${{ memoryAgentMaxTurns: 2.5 }} | ${undefined}
    `('%s', ({ params, expected }) => {
      expect(makeConfig(params).getMemoryAgentMaxTurns()).toBe(expected);
    });
  });

  describe('restorable ask_user_question preservation', () => {
    it('defaults to off when the restore switch is unset', () => {
      const config = makeConfig();
      expect(config.getRestoreAskUserQuestion()).toBe(false);
      expect(config.getPreserveRestorableAskUserQuestion()).toBe(false);
    });

    it('preserves by default when the restore switch is on', () => {
      const config = makeConfig({ restoreAskUserQuestion: true });
      expect(config.getRestoreAskUserQuestion()).toBe(true);
      expect(config.getPreserveRestorableAskUserQuestion()).toBe(true);
    });

    it('stops preserving after suppression, without touching the restore switch', () => {
      const config = makeConfig({ restoreAskUserQuestion: true });
      config.suppressRestorableAskUserQuestionPreservation();
      expect(config.getPreserveRestorableAskUserQuestion()).toBe(false);
      expect(config.getRestoreAskUserQuestion()).toBe(true);
    });
  });

  describe('getVisionBridgeTimeoutMs', () => {
    // The "rejects" rows pass the number-typed schema's `minimum: 1` via
    // /config but would make AbortSignal.timeout throw RangeError or degrade
    // to a 1ms timer.
    const rejects =
      'rejects values AbortSignal.timeout cannot take (fractional, over 2^31-1, non-finite)';
    const nonPositive =
      'treats non-positive values as unset (schema validation is bypassed on load)';
    it.each`
      title                                              | params                                                 | expected
      ${'returns undefined when unset'}                  | ${{}}                                                  | ${undefined}
      ${'passes through positive values'}                | ${{ visionBridgeTimeoutMs: 120_000 }}                  | ${120_000}
      ${nonPositive}                                     | ${{ visionBridgeTimeoutMs: 0 }}                        | ${undefined}
      ${nonPositive}                                     | ${{ visionBridgeTimeoutMs: -5000 }}                    | ${undefined}
      ${rejects}                                         | ${{ visionBridgeTimeoutMs: 30_000.5 }}                 | ${undefined}
      ${rejects}                                         | ${{ visionBridgeTimeoutMs: 2_147_483_648 }}            | ${undefined}
      ${rejects}                                         | ${{ visionBridgeTimeoutMs: 4_294_967_296 }}            | ${undefined}
      ${rejects}                                         | ${{ visionBridgeTimeoutMs: 1e300 }}                    | ${undefined}
      ${rejects}                                         | ${{ visionBridgeTimeoutMs: Number.NaN }}               | ${undefined}
      ${rejects}                                         | ${{ visionBridgeTimeoutMs: Number.POSITIVE_INFINITY }} | ${undefined}
      ${'accepts the maximum supported integer timeout'} | ${{ visionBridgeTimeoutMs: 2_147_483_647 }}            | ${2_147_483_647}
    `('%s', ({ params, expected }) => {
      expect(makeConfig(params).getVisionBridgeTimeoutMs()).toBe(expected);
    });
  });

  describe('getShellDefaultTimeoutMs', () => {
    // The "rejects" rows: a hand-edited settings.json bypasses the schema and
    // can reach AbortSignal.timeout, which would throw RangeError or degrade
    // to a 1ms timer on these. Coerce to undefined → built-in default.
    const rejects =
      'rejects values AbortSignal.timeout cannot take (fractional, over 2^31-1, non-finite)';
    it.each`
      title                                                                        | params                                                 | expected
      ${'returns undefined when unset'}                                            | ${{}}                                                  | ${undefined}
      ${'passes through positive values'}                                          | ${{ shellDefaultTimeoutMs: 300_000 }}                  | ${300_000}
      ${'accepts 0 (disables the timeout — unlike the vision bridge)'}             | ${{ shellDefaultTimeoutMs: 0 }}                        | ${0}
      ${'treats negative values as unset (schema validation is bypassed on load)'} | ${{ shellDefaultTimeoutMs: -5000 }}                    | ${undefined}
      ${rejects}                                                                   | ${{ shellDefaultTimeoutMs: 30_000.5 }}                 | ${undefined}
      ${rejects}                                                                   | ${{ shellDefaultTimeoutMs: 2_147_483_648 }}            | ${undefined}
      ${rejects}                                                                   | ${{ shellDefaultTimeoutMs: 4_294_967_296 }}            | ${undefined}
      ${rejects}                                                                   | ${{ shellDefaultTimeoutMs: 1e300 }}                    | ${undefined}
      ${rejects}                                                                   | ${{ shellDefaultTimeoutMs: Number.NaN }}               | ${undefined}
      ${rejects}                                                                   | ${{ shellDefaultTimeoutMs: Number.POSITIVE_INFINITY }} | ${undefined}
      ${'accepts the maximum supported integer timeout'}                           | ${{ shellDefaultTimeoutMs: 2_147_483_647 }}            | ${2_147_483_647}
    `('%s', ({ params, expected }) => {
      expect(makeConfig(params).getShellDefaultTimeoutMs()).toBe(expected);
    });
  });

  describe('getMaxSubagentDepth', () => {
    // Non-finite rows: JSON `1e309` parses to Infinity — must not disable the
    // recursion cap; NaN comparisons are always false — must not silently
    // block nesting.
    it.each`
      title                                                          | params                            | expected
      ${'defaults to 5 when unset'}                                  | ${{}}                             | ${5}
      ${'respects an explicit value'}                                | ${{ maxSubagentDepth: 3 }}        | ${3}
      ${'clamps values below 1 up to 1 (never disables sub-agents)'} | ${{ maxSubagentDepth: 0 }}        | ${1}
      ${'clamps values below 1 up to 1 (never disables sub-agents)'} | ${{ maxSubagentDepth: -4 }}       | ${1}
      ${'floors fractional values'}                                  | ${{ maxSubagentDepth: 3.9 }}      | ${3}
      ${'falls back to the default on non-finite values'}            | ${{ maxSubagentDepth: Infinity }} | ${5}
      ${'falls back to the default on non-finite values'}            | ${{ maxSubagentDepth: NaN }}      | ${5}
      ${'caps absurdly large values at 100'}                         | ${{ maxSubagentDepth: 5000 }}     | ${100}
    `('%s', ({ params, expected }) => {
      expect(makeConfig(params).getMaxSubagentDepth()).toBe(expected);
    });
  });

  describe('setAutoSkillEnabled', () => {
    it('flips the live value read by getAutoSkillEnabled', () => {
      const config = makeConfig({ enableAutoSkill: true });
      expect(config.getAutoSkillEnabled()).toBe(true);
      config.setAutoSkillEnabled(false);
      expect(config.getAutoSkillEnabled()).toBe(false);
      config.setAutoSkillEnabled(true);
      expect(config.getAutoSkillEnabled()).toBe(true);
    });
  });

  describe('session workflow gate and plan revision', () => {
    const revision = () => ({
      planId: 'plan-1',
      sourceCallId: 'call-1',
      todoIds: ['todo-1'],
    });
    const planConfig = () =>
      makeConfig({
        sessionWorkflowEnabled: true,
        approvalMode: ApprovalMode.PLAN,
      });

    it('defaults off and clears the revision when disabled', () => {
      const config = makeConfig();
      expect(config.isSessionWorkflowEnabled()).toBe(false);
      config.setSessionWorkflowPlanRevision(revision());
      expect(config.getSessionWorkflowPlanRevision()).toBeUndefined();
    });

    it('hot-reloads the gate through its provider and clears context on disable', () => {
      let enabled = true;
      const config = makeConfig({ sessionWorkflowEnabled: true });
      config.setSessionWorkflowEnabledProvider(() => enabled);
      const twoTodos = { ...revision(), todoIds: ['todo-1', 'todo-2'] };
      config.setSessionWorkflowPlanRevision(twoTodos);
      expect(config.getSessionWorkflowPlanRevision()).toEqual(twoTodos);

      enabled = false;
      expect(config.isSessionWorkflowEnabled()).toBe(false);
      expect(config.getSessionWorkflowPlanRevision()).toBeUndefined();
    });

    it('keeps gate reads pure so prototype wrappers never shadow the base revision', () => {
      let enabled = false;
      const config = makeConfig();
      config.setSessionWorkflowEnabledProvider(() => enabled);
      // Subagent/teammate runtimes wrap the session Config in
      // Object.create(base) prototypes.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wrapper = Object.create(config) as any;

      // A gate-off read through the wrapper must not materialize an OWN
      // sessionWorkflowPlanRevision on it — that would permanently shadow
      // the session-global base value once the gate flips on and a revision
      // is approved.
      expect(wrapper.isSessionWorkflowEnabled()).toBe(false);
      expect(
        Object.prototype.hasOwnProperty.call(
          wrapper,
          'sessionWorkflowPlanRevision',
        ),
      ).toBe(false);

      enabled = true;
      config.setSessionWorkflowPlanRevision(revision());
      expect(wrapper.getSessionWorkflowPlanRevision()).toEqual(revision());
      expect(wrapper.isSessionWorkflowTodoContextActive()).toBe(true);
    });

    it('accepts planning mode as workflow context before approval', () => {
      expect(planConfig().isSessionWorkflowTodoContextActive()).toBe(true);
    });

    it('stamps the bound revision approved on an approved plan exit', () => {
      const config = planConfig();
      config.setSessionWorkflowPlanRevision(revision());
      // A revision bound while drafting carries no approval stamp.
      expect(config.getSessionWorkflowPlanRevision()?.approved).toBeUndefined();

      config.setApprovalMode(ApprovalMode.DEFAULT, {
        fromApprovedPlanExit: true,
      });
      expect(config.getSessionWorkflowPlanRevision()).toEqual({
        ...revision(),
        approved: true,
      });
    });

    it('does not stamp the revision on a manual PLAN exit', () => {
      const config = planConfig();
      config.setSessionWorkflowPlanRevision(revision());
      config.setApprovalMode(ApprovalMode.DEFAULT);
      expect(config.getSessionWorkflowPlanRevision()?.approved).toBeUndefined();
    });

    it('does not let a derived config approve the session revision', () => {
      const config = planConfig();
      config.setSessionWorkflowPlanRevision(revision());
      const wrapper = Object.create(config) as Config;
      Object.defineProperties(wrapper, {
        approvalMode: { value: ApprovalMode.PLAN, writable: true },
        setApprovalMode: { value: Config.prototype.setApprovalMode },
      });
      installSessionWorkflowRevisionWriteThrough(wrapper, config);

      wrapper.setApprovalMode(ApprovalMode.DEFAULT, {
        fromApprovedPlanExit: true,
      });

      expect(config.getSessionWorkflowPlanRevision()?.approved).toBeUndefined();
    });

    it('reads an approved revision as approved through a PLAN-mode wrapper', () => {
      // Per-agent Config wrappers carry their OWN approvalMode (e.g. an
      // `approvalMode: plan` subagent) while the revision is session-global.
      // Approval must come from the revision's stamp, not the wrapper's mode.
      const config = planConfig();
      config.setSessionWorkflowPlanRevision(revision());
      config.setApprovalMode(ApprovalMode.DEFAULT, {
        fromApprovedPlanExit: true,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wrapper = Object.create(config) as any;
      wrapper.approvalMode = ApprovalMode.PLAN;
      expect(wrapper.getApprovalMode()).toBe(ApprovalMode.PLAN);
      // The wrapper reads the session-global revision through the prototype
      // and sees the approval stamp despite its own PLAN mode.
      expect(wrapper.getSessionWorkflowPlanRevision()?.approved).toBe(true);
    });
  });

  describe('agents.maxParallelAgents', () => {
    it('configures the background task registry concurrency cap', () => {
      const registry = makeConfig({
        agents: { maxParallelAgents: 1 },
      }).getBackgroundTaskRegistry();

      registry.register(backgroundTask('bg-1', 'one'));

      expect(() => registry.register(backgroundTask('bg-2', 'two'))).toThrow(
        'maximum concurrent background agents (1) reached',
      );
    });
  });

  describe('agents.maxParallelAgentsByModel', () => {
    it('configures a per-model background task concurrency cap', () => {
      const registry = makeConfig({
        agents: { maxParallelAgentsByModel: { 'weak-model': 1 } },
      }).getBackgroundTaskRegistry();

      registry.register(backgroundTask('bg-1', 'one', 'weak-model'));

      expect(() =>
        registry.register(backgroundTask('bg-2', 'two', 'weak-model')),
      ).toThrow('for model "weak-model" (1) reached');
    });
  });

  describe('getTeamMemoryEnabled', () => {
    afterEach(stashEnv('QWEN_CODE_MEMORY_TEAM'));
    const teamEnabled = (params: Partial<ConfigParameters> = {}) =>
      makeConfig(params).getTeamMemoryEnabled();

    it('is off by default and follows the enableTeamMemory setting', () => {
      delete process.env['QWEN_CODE_MEMORY_TEAM'];
      expect(teamEnabled()).toBe(false);
      expect(teamEnabled({ enableTeamMemory: true })).toBe(true);
    });

    it('QWEN_CODE_MEMORY_TEAM overrides the setting', () => {
      process.env['QWEN_CODE_MEMORY_TEAM'] = '1';
      expect(teamEnabled()).toBe(true);
      process.env['QWEN_CODE_MEMORY_TEAM'] = '0';
      expect(teamEnabled({ enableTeamMemory: true })).toBe(false);
    });

    it('bareMode forces off even with the setting and env both on', () => {
      process.env['QWEN_CODE_MEMORY_TEAM'] = '1';
      expect(teamEnabled({ bareMode: true, enableTeamMemory: true })).toBe(
        false,
      );
    });
  });

  describe('getStructuredMemoryRecallEnabled', () => {
    const prevEnv = process.env['QWEN_CODE_MEMORY_STRUCTURED_RECALL'];
    afterEach(() => {
      if (prevEnv === undefined) {
        delete process.env['QWEN_CODE_MEMORY_STRUCTURED_RECALL'];
      } else {
        process.env['QWEN_CODE_MEMORY_STRUCTURED_RECALL'] = prevEnv;
      }
    });

    it('is off by default and follows the enableStructuredMemoryRecall setting', () => {
      delete process.env['QWEN_CODE_MEMORY_STRUCTURED_RECALL'];
      expect(new Config(baseParams).getStructuredMemoryRecallEnabled()).toBe(
        false,
      );
      expect(
        new Config({
          ...baseParams,
          enableStructuredMemoryRecall: true,
        }).getStructuredMemoryRecallEnabled(),
      ).toBe(true);
    });

    it('QWEN_CODE_MEMORY_STRUCTURED_RECALL overrides the setting', () => {
      process.env['QWEN_CODE_MEMORY_STRUCTURED_RECALL'] = '1';
      expect(new Config(baseParams).getStructuredMemoryRecallEnabled()).toBe(
        true,
      );
      process.env['QWEN_CODE_MEMORY_STRUCTURED_RECALL'] = '0';
      expect(
        new Config({
          ...baseParams,
          enableStructuredMemoryRecall: true,
        }).getStructuredMemoryRecallEnabled(),
      ).toBe(false);
    });

    it('bareMode forces off even with the setting and env both on', () => {
      process.env['QWEN_CODE_MEMORY_STRUCTURED_RECALL'] = '1';
      expect(
        new Config({
          ...baseParams,
          bareMode: true,
          enableStructuredMemoryRecall: true,
        }).getStructuredMemoryRecallEnabled(),
      ).toBe(false);
    });
  });

  describe('getCronRecurringMaxAgeDays', () => {
    afterEach(stashEnv('QWEN_CODE_CRON_MAX_AGE_DAYS'));
    const maxAge = (cronRecurringMaxAgeDays?: number) =>
      makeConfig({ cronRecurringMaxAgeDays }).getCronRecurringMaxAgeDays();

    it('defaults to 7 days and follows the setting', () => {
      delete process.env['QWEN_CODE_CRON_MAX_AGE_DAYS'];
      expect(makeConfig().getCronRecurringMaxAgeDays()).toBe(7);
      expect(maxAge(30)).toBe(30);
    });

    it('maps 0 to Infinity (no expiry)', () => {
      delete process.env['QWEN_CODE_CRON_MAX_AGE_DAYS'];
      expect(maxAge(0)).toBe(Infinity);
    });

    it('QWEN_CODE_CRON_MAX_AGE_DAYS overrides the setting', () => {
      process.env['QWEN_CODE_CRON_MAX_AGE_DAYS'] = '90';
      expect(maxAge(30)).toBe(90);
      process.env['QWEN_CODE_CRON_MAX_AGE_DAYS'] = '0';
      expect(makeConfig().getCronRecurringMaxAgeDays()).toBe(Infinity);
    });

    it('falls back to the default on invalid values', () => {
      process.env['QWEN_CODE_CRON_MAX_AGE_DAYS'] = 'not-a-number';
      expect(makeConfig().getCronRecurringMaxAgeDays()).toBe(7);
      delete process.env['QWEN_CODE_CRON_MAX_AGE_DAYS'];
      expect(maxAge(-3)).toBe(7);
    });

    it('warns on the console once at construction for an invalid value', () => {
      process.env['QWEN_CODE_CRON_MAX_AGE_DAYS'] = 'not-a-number';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const config = makeConfig();
        // The warning fires during construction, before any getter call,
        // and repeated getter calls do not re-emit it.
        expect(config.getCronRecurringMaxAgeDays()).toBe(7);
        expect(config.getCronRecurringMaxAgeDays()).toBe(7);
        const cronWarnings = warnSpy.mock.calls.filter((call) =>
          String(call[0]).includes('QWEN_CODE_CRON_MAX_AGE_DAYS'),
        );
        expect(cronWarnings).toHaveLength(1);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('resolves once at construction, ignoring later env changes (requiresRestart)', () => {
      process.env['QWEN_CODE_CRON_MAX_AGE_DAYS'] = '90';
      const config = makeConfig();
      process.env['QWEN_CODE_CRON_MAX_AGE_DAYS'] = '3';
      expect(config.getCronRecurringMaxAgeDays()).toBe(90);
      delete process.env['QWEN_CODE_CRON_MAX_AGE_DAYS'];
      expect(config.getCronRecurringMaxAgeDays()).toBe(90);
    });
  });

  describe('getTeamMemorySyncEnabled', () => {
    afterEach(stashEnv('QWEN_CODE_MEMORY_TEAM_SYNC'));
    const syncEnabled = (params: Partial<ConfigParameters> = {}) =>
      makeConfig(params).getTeamMemorySyncEnabled();

    it('is off by default and follows the enableTeamMemorySync setting', () => {
      delete process.env['QWEN_CODE_MEMORY_TEAM_SYNC'];
      expect(syncEnabled()).toBe(false);
      expect(syncEnabled({ enableTeamMemorySync: true })).toBe(true);
    });

    it('QWEN_CODE_MEMORY_TEAM_SYNC overrides the setting', () => {
      process.env['QWEN_CODE_MEMORY_TEAM_SYNC'] = '1';
      expect(syncEnabled()).toBe(true);
      process.env['QWEN_CODE_MEMORY_TEAM_SYNC'] = '0';
      expect(syncEnabled({ enableTeamMemorySync: true })).toBe(false);
    });

    it('stays off in bare mode even with the setting and env both on', () => {
      process.env['QWEN_CODE_MEMORY_TEAM_SYNC'] = '1';
      expect(syncEnabled({ bareMode: true, enableTeamMemorySync: true })).toBe(
        false,
      );
    });
  });

  it('should store a system prompt override', () => {
    const config = makeConfig({
      systemPrompt: 'You are a custom system prompt.',
    });

    expect(config.getSystemPrompt()).toBe('You are a custom system prompt.');
    expect(config.getAppendSystemPrompt()).toBeUndefined();
  });

  it('should store an appended system prompt', () => {
    const config = makeConfig({
      appendSystemPrompt: 'Be extra concise.',
    });

    expect(config.getAppendSystemPrompt()).toBe('Be extra concise.');
    expect(config.getSystemPrompt()).toBeUndefined();
  });

  describe('getDefaultVisionBridgeModel', () => {
    const PRIMARY_URL = 'https://primary.example.com';
    const ANTHROPIC_URL = 'https://api.anthropic.com';
    const TOKEN_PLAN_URL = 'https://token-plan.example.com/v1';
    // Same id/provider/endpoint as the primary.
    const primaryRow = {
      id: 'text-primary',
      authType: AuthType.USE_OPENAI,
      baseUrl: PRIMARY_URL,
    };
    const openaiVl = (id: string, baseUrl = PRIMARY_URL) => ({
      id,
      authType: AuthType.USE_OPENAI,
      baseUrl,
      isVision: true,
    });
    const vlSameProvider = openaiVl('vl-same-provider');
    const sameProviderRoute = {
      id: 'openai:vl-same-provider',
      baseUrl: PRIMARY_URL,
    };
    // Primary is text-only and lives on the 'openai' provider.
    const stubProvider = (config: Config, models: unknown[]) => {
      vi.spyOn(config, 'getModel').mockReturnValue('text-primary');
      vi.spyOn(config, 'getContentGeneratorConfig').mockReturnValue({
        authType: AuthType.USE_OPENAI,
        baseUrl: PRIMARY_URL,
      } as ContentGeneratorConfig);
      vi.spyOn(config, 'getAllConfiguredModels').mockReturnValue(
        models as never,
      );
    };
    /** A Config pinned to `visionModel` (or unpinned) over the given routes. */
    const bridgeFor = (visionModel: string | undefined, models: unknown[]) => {
      const config = makeConfig(
        visionModel === undefined ? {} : { visionModel },
      );
      stubProvider(config, models);
      return config;
    };

    it('keeps a bare cross-provider namesake on its exact agent route', () => {
      const config = bridgeFor('text-primary', [
        primaryRow,
        {
          id: 'text-primary',
          authType: AuthType.USE_ANTHROPIC,
          isVision: true,
          capabilities: { vision: true, agent: true },
        },
      ]);
      expect(config.getDefaultVisionBridgeModel()).toEqual({
        id: 'anthropic:text-primary',
        agentCapable: true,
      });
    });

    it('falls back to same-provider auto-select when the explicit model is not configured', () => {
      // 'ghost-model' isn't configured, so the explicit pin is ignored and the
      // same-provider candidate is auto-picked instead.
      expect(
        bridgeFor('ghost-model', [
          vlSameProvider,
        ]).getDefaultVisionBridgeModel(),
      ).toEqual(sameProviderRoute);
    });

    it('auto-selects a same-provider vision model when no explicit model is set', () => {
      expect(
        bridgeFor(undefined, [vlSameProvider]).getDefaultVisionBridgeModel(),
      ).toEqual(sameProviderRoute);
    });

    it('honors an authType-qualified visionModel against the matching provider only', () => {
      // Same model id on two providers; the 'anthropic:' qualifier must bind to
      // the anthropic row, not the same-provider openai one.
      const config = bridgeFor('anthropic:vl-shared', [
        openaiVl('vl-shared'),
        {
          id: 'vl-shared',
          authType: AuthType.USE_ANTHROPIC,
          baseUrl: ANTHROPIC_URL,
          isVision: true,
        },
      ]);
      expect(config.getDefaultVisionBridgeModel()).toEqual({
        id: 'anthropic:vl-shared',
        baseUrl: ANTHROPIC_URL,
      });
    });

    it('uses the visionModel selector baseUrl to disambiguate duplicate same-provider vision models', () => {
      const config = bridgeFor(`openai:qwen3.7-plus\0${TOKEN_PLAN_URL}`, [
        openaiVl('qwen3.7-plus', DASHSCOPE_URL),
        openaiVl('qwen3.7-plus', TOKEN_PLAN_URL),
      ]);
      expect(config.getDefaultVisionBridgeModel()).toEqual({
        id: 'openai:qwen3.7-plus',
        baseUrl: TOKEN_PLAN_URL,
      });
    });

    it.each([false, true])(
      'honors an exact visionModel route with ignored fast-only namesakes (reversed=%s)',
      (reversed) => {
        const baseUrl = 'https://vision.example.com/v1';
        const routeEntries = [
          {
            ...openaiVl('vision-agent', baseUrl),
            capabilities: { vision: true, agent: true },
          },
          {
            id: 'vision-agent',
            authType: AuthType.USE_OPENAI,
            baseUrl,
            fastOnly: true,
          },
        ];
        const config = bridgeFor(
          `openai:vision-agent\0${baseUrl}`,
          reversed ? routeEntries.reverse() : routeEntries,
        );

        expect(config.getDefaultVisionBridgeModel()).toEqual({
          id: 'openai:vision-agent',
          baseUrl,
          agentCapable: true,
        });
      },
    );

    it('falls back to auto-select when a legacy visionModel matches multiple endpoints', () => {
      const config = bridgeFor('openai:qwen3.7-plus', [
        openaiVl('qwen3.7-plus', DASHSCOPE_URL),
        openaiVl('qwen3.7-plus', TOKEN_PLAN_URL),
        vlSameProvider,
      ]);
      expect(config.getDefaultVisionBridgeModel()).toEqual(sameProviderRoute);
    });

    it('falls back to auto-select on a malformed visionModel selector instead of throwing', () => {
      // 'openai:' is a known authType with no model id — resolveModelId throws,
      // and the guard must swallow it rather than take down every image request.
      const config = bridgeFor('openai:', [vlSameProvider]);
      expect(() => config.getDefaultVisionBridgeModel()).not.toThrow();
      expect(config.getDefaultVisionBridgeModel()).toEqual(sameProviderRoute);
    });

    it('falls back to auto-select on a visionModel with no selector before the baseUrl delimiter', () => {
      const config = makeConfig({ visionModel: '\0https://example.com/v1' });
      const warn = vi.spyOn(config.getDebugLogger(), 'warn');
      stubProvider(config, [vlSameProvider]);

      expect(config.getDefaultVisionBridgeModel()).toEqual(sameProviderRoute);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("'\\0https://example.com/v1'"),
      );
    });

    it('drops a pin that points at the current primary model and auto-selects a same-provider VL model instead', () => {
      // Pinning the primary itself is a dead pin: the bridge exists to work
      // around the text-only primary, so routing back at it would defeat the
      // purpose. The provider-aware primary guard must drop the pin and hand off
      // to same-provider auto-select rather than ever returning the primary.
      // Without the guard the pin would resolve straight back to primaryRow.
      const config = bridgeFor('text-primary', [primaryRow, vlSameProvider]);
      expect(config.getDefaultVisionBridgeModel()).toEqual(sameProviderRoute);
    });

    it('setVisionModel("") clears the pin and reverts to same-provider auto-select', () => {
      const config = bridgeFor('vl-anthropic', [
        {
          id: 'vl-anthropic',
          authType: AuthType.USE_ANTHROPIC,
          baseUrl: ANTHROPIC_URL,
          isVision: true,
        },
        vlSameProvider,
      ]);
      // Pinned first.
      expect(config.getDefaultVisionBridgeModel()).toEqual({
        id: 'anthropic:vl-anthropic',
        baseUrl: ANTHROPIC_URL,
      });
      // Cleared with '' — JSDoc promises a fall back to auto-select.
      config.setVisionModel('');
      expect(config.getDefaultVisionBridgeModel()).toEqual(sameProviderRoute);
      // undefined clears too.
      config.setVisionModel('vl-anthropic');
      config.setVisionModel(undefined);
      expect(config.getDefaultVisionBridgeModel()).toEqual(sameProviderRoute);
    });
  });

  describe('getModelFallbacks', () => {
    // 'returns a readonly array': the returned array should be readonly
    // (TypeScript enforces this, but verify the reference is stable).
    it.each`
      title                                                | params                                                                                 | expected
      ${'returns empty array by default when unset'}       | ${{}}                                                                                  | ${[]}
      ${'returns empty array when set to undefined'}       | ${{ modelFallbacks: undefined }}                                                       | ${[]}
      ${'returns empty array when set to empty array'}     | ${{ modelFallbacks: [] }}                                                              | ${[]}
      ${'accepts an array of model IDs'}                   | ${{ modelFallbacks: ['qwen-plus', 'qwen-turbo'] }}                                     | ${['qwen-plus', 'qwen-turbo']}
      ${'caps at 3 entries'}                               | ${{ modelFallbacks: ['model-a', 'model-b', 'model-c', 'model-d', 'model-e'] }}         | ${['model-a', 'model-b', 'model-c']}
      ${'deduplicates entries'}                            | ${{ modelFallbacks: ['qwen-plus', 'qwen-turbo', 'qwen-plus'] }}                        | ${['qwen-plus', 'qwen-turbo']}
      ${'trims whitespace from entries'}                   | ${{ modelFallbacks: ['  qwen-plus  ', ' qwen-turbo '] }}                               | ${['qwen-plus', 'qwen-turbo']}
      ${'removes blank entries'}                           | ${{ modelFallbacks: ['', '  ', 'qwen-plus', '', 'qwen-turbo'] }}                       | ${['qwen-plus', 'qwen-turbo']}
      ${'deduplicates after trimming'}                     | ${{ modelFallbacks: ['qwen-plus', ' qwen-plus ', 'qwen-turbo'] }}                      | ${['qwen-plus', 'qwen-turbo']}
      ${'returns a readonly array'}                        | ${{ modelFallbacks: ['qwen-plus'] }}                                                   | ${['qwen-plus']}
      ${'caps at 3 after deduplication and blank removal'} | ${{ modelFallbacks: ['', 'model-a', 'model-a', '', 'model-b', 'model-c', 'model-d'] }} | ${['model-a', 'model-b', 'model-c']}
    `('%s', ({ params, expected }) => {
      expect(makeConfig(params).getModelFallbacks()).toEqual(expected);
    });
  });

  /**
   * Run `body` against a checkpointing Config in a temp project whose chat
   * recorder only captures file history snapshots (cloned into `recorded`).
   */
  async function withFileHistory(
    params: Partial<ConfigParameters>,
    body: (fixture: {
      config: Config;
      trackedFile: string;
      record: Mock;
      recorded: FileHistorySnapshot[];
    }) => Promise<void>,
  ) {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), 'qwen-config-'));
    const storageDir = await mkdtemp(path.join(os.tmpdir(), 'qwen-storage-'));
    const config = makeConfig({
      cwd: projectDir,
      fileCheckpointingEnabled: true,
      ...params,
    });
    const recorded: FileHistorySnapshot[] = [];
    const record = vi.fn((snapshot: FileHistorySnapshot) => {
      recorded.push(structuredClone(snapshot));
    });
    vi.spyOn(config, 'getChatRecordingService').mockReturnValue({
      recordFileHistorySnapshot: record,
    } as unknown as ReturnType<Config['getChatRecordingService']>);
    const getGlobalQwenDirSpy = vi
      .spyOn(Storage, 'getGlobalQwenDir')
      .mockReturnValue(storageDir);
    try {
      const trackedFile = path.join(projectDir, 'a.txt');
      await writeFile(trackedFile, 'original');
      await body({ config, trackedFile, record, recorded });
    } finally {
      getGlobalQwenDirSpy.mockRestore();
      await rm(projectDir, { recursive: true, force: true });
      await rm(storageDir, { recursive: true, force: true });
    }
  }

  it('wires file history snapshot updates to chat recording', () =>
    withFileHistory(
      { chatRecording: true },
      async ({ config, trackedFile, record, recorded }) => {
        const fileHistoryService = config.getFileHistoryService();
        await fileHistoryService.makeSnapshot('p1');
        await fileHistoryService.trackEdit(trackedFile);

        expect(record).toHaveBeenCalledTimes(1);
        expect(recorded[0].trackedFileBackups['a.txt']).toEqual(
          expect.objectContaining({
            backupFileName: expect.any(String),
            version: 1,
          }),
        );
      },
    ));

  it('drops stale file history callbacks after session switch', () =>
    withFileHistory({}, async ({ config, trackedFile, record }) => {
      const oldFileHistoryService = config.getFileHistoryService();
      await oldFileHistoryService.makeSnapshot('p1');
      config.startNewSession('new-session-id');
      await oldFileHistoryService.trackEdit(trackedFile);

      expect(record).not.toHaveBeenCalled();
    }));

  describe('tool sandbox initialization', () => {
    const parameters = () => ({
      ...baseParams,
      sandbox: undefined,
      cwd: TARGET_DIR,
      interactive: true,
      bareMode: false,
      enableAutoSkill: true,
      shellExecutionSandbox: {
        workspace: path.resolve(TARGET_DIR),
        installation: path.resolve('/installation'),
        state: path.resolve('/sandbox-state'),
        filesystem: 'workspace-write' as const,
        network: 'closed' as const,
      },
    });
    /** The tools a sandboxed session admits, in registration order. */
    const ADMITTED_TOOLS = [
      ToolNames.SHELL,
      ToolNames.TASK_STOP,
      ToolNames.READ_FILE,
      ToolNames.WRITE_FILE,
      ToolNames.EDIT,
      ToolNames.MONITOR,
      ToolNames.AGENT,
      ToolNames.GLOB,
      ToolNames.LS,
    ];
    /** Run `body` with the sandbox probe rejecting with `failure` (or resolving). */
    async function withProbe(failure: Error, body: () => Promise<void>) {
      const probe = vi
        .spyOn(sandboxPolicy, 'probeShellSandbox')
        .mockRejectedValue(failure);
      try {
        await body();
      } finally {
        probe.mockRestore();
      }
    }

    it('stops before recording, hooks, skills and registry setup when probing fails', () =>
      withProbe(new Error('probe unavailable'), async () => {
        const config = new Config(parameters());
        const record = vi.spyOn(internals(config), 'activateChatRecording');
        await expect(config.initialize()).rejects.toThrow('probe unavailable');
        expect(record).not.toHaveBeenCalled();
        expect(HookSystem).not.toHaveBeenCalled();
        expect(SkillManager.prototype.startWatching).not.toHaveBeenCalled();
        expect(ToolRegistry.prototype.registerFactory).not.toHaveBeenCalled();
      }));

    it('keeps pure skill reads and registers only admitted tools after a successful probe', async () => {
      const resolvedPolicy = {
        ...parameters().shellExecutionSandbox,
        effectiveBackend: 'bwrap' as const,
        enforcement: 'full' as const,
      };
      const probe = vi
        .spyOn(sandboxPolicy, 'probeShellSandbox')
        .mockResolvedValue(resolvedPolicy);
      try {
        const config = new Config(parameters());
        const admittedPolicy = config.getShellExecutionSandbox();
        const refreshExtensions = vi.spyOn(
          config.getExtensionManager(),
          'refreshCache',
        );
        await config.initialize();
        expect(probe).toHaveBeenCalledWith(admittedPolicy, undefined);
        expect(config.getShellExecutionSandbox()).toBe(resolvedPolicy);
        expect(HookSystem).not.toHaveBeenCalled();
        expect(maybeRunAutoSkillCurator).not.toHaveBeenCalled();
        expect(refreshExtensions).not.toHaveBeenCalled();
        expect(SkillManager.prototype.startWatching).not.toHaveBeenCalled();
        expect(SkillManager.prototype.refreshCache).toHaveBeenCalled();
        expect(registeredToolNames()).toEqual([
          ...ADMITTED_TOOLS,
          ToolNames.ASK_USER_QUESTION,
        ]);
        expect(ToolRegistry.prototype.discoverAllTools).not.toHaveBeenCalled();
      } finally {
        probe.mockRestore();
      }
    });

    it('omits user-interaction tools from the admitted headless registry', async () => {
      const probe = vi
        .spyOn(sandboxPolicy, 'probeShellSandbox')
        .mockResolvedValue({
          ...parameters().shellExecutionSandbox,
          effectiveBackend: 'bwrap',
          enforcement: 'full',
        });
      try {
        const config = new Config({
          ...parameters(),
          interactive: false,
          bareMode: true,
        });
        await config.initialize();
        expect(registeredToolNames()).toEqual(ADMITTED_TOOLS);
      } finally {
        probe.mockRestore();
      }
    });
  });

  describe('derived Config ownership', () => {
    it('preserves the shell sandbox ceiling and rejects relocation before state mutation', async () => {
      const policy = {
        workspace: path.resolve(TARGET_DIR),
        installation: path.resolve('/installation'),
        state: path.resolve('/sandbox-state'),
        filesystem: 'workspace-write' as const,
        network: 'closed' as 'closed' | 'open',
      };
      const parent = makeConfig({
        sandbox: undefined,
        cwd: TARGET_DIR,
        bareMode: false,
        interactive: true,
        fileCheckpointingEnabled: true,
        ideMode: true,
        enableManagedAutoMemory: true,
        enableManagedAutoDream: true,
        enableTeamMemory: true,
        enableTeamMemorySync: true,
        agentTeamEnabled: true,
        workflowsEnabled: true,
        sessionWorkflowEnabled: true,
        cronEnabled: true,
        shellExecutionSandbox: policy,
      });
      const snapshot = parent.getShellExecutionSandbox();
      policy.network = 'open';
      expect(snapshot?.network).toBe('closed');
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(parent.getCoreTools()).toEqual([
        ToolNames.SHELL,
        ToolNames.TASK_STOP,
        ToolNames.READ_FILE,
        ToolNames.WRITE_FILE,
        ToolNames.EDIT,
        ToolNames.MONITOR,
        ToolNames.AGENT,
        ToolNames.EXEC,
        ToolNames.GLOB,
        ToolNames.LS,
        ToolNames.ASK_USER_QUESTION,
        ToolNames.STRUCTURED_OUTPUT,
      ]);
      expect(parent.getBareMode()).toBe(false);
      expect(parent.getIdeMode()).toBe(false);
      expect(() => parent.setIdeMode(true)).toThrow('does not support IDE');
      expect(parent.getDisableAllHooks()).toBe(true);
      expect(parent.getHookSystem()).toBeUndefined();
      expect(parent.getManagedAutoMemoryEnabled()).toBe(false);
      expect(parent.isManagedMemoryAvailable()).toBe(false);
      expect(parent.getManagedAutoDreamEnabled()).toBe(false);
      expect(parent.getTeamMemoryEnabled()).toBe(false);
      expect(parent.getTeamMemorySyncEnabled()).toBe(false);
      expect(parent.getAutoSkillEnabled()).toBe(false);
      expect(parent.isAgentTeamEnabled()).toBe(false);
      expect(parent.isWorkflowsEnabled()).toBe(false);
      expect(parent.isSessionWorkflowEnabled()).toBe(false);
      expect(parent.isCronEnabled()).toBe(false);
      expect(parent.isLspEnabled()).toBe(false);
      expect(parent.getFileCheckpointingEnabled()).toBe(false);
      expect(() => parent.enableFileCheckpointing()).toThrow('unavailable');
      expect(() =>
        parent.addMcpServers({ remote: { command: 'node' } }),
      ).toThrow('does not support MCP');
      expect(() =>
        parent.addRuntimeMcpServer('remote', { command: 'node' }),
      ).toThrow('does not support MCP');
      await expect(
        parent.reinitializeMcpServers({ remote: { command: 'node' } }),
      ).rejects.toThrow('does not support MCP');
      expect(parent.getMcpServers()).toEqual({});
      expect(parent.getExtensions()).toEqual([]);
      const fileService = parent.getFileSystemService();
      expect(() => parent.setFileSystemService(fileService)).toThrow(
        'delegated filesystem',
      );
      expect(parent.getFileSystemService()).toBe(fileService);
      const child = deriveWorktreeConfig(
        parent,
        path.join(TARGET_DIR, 'child'),
      );
      expect(child.getShellExecutionSandbox()).toBe(snapshot);
      expect(() => deriveWorktreeConfig(parent, '/other')).toThrow(
        'admitted workspace',
      );
      await expect(parent.relocateWorkingDirectory('/other')).rejects.toThrow(
        'admitted workspace',
      );
      expect(parent.getTargetDir()).toBe(path.resolve(TARGET_DIR));
    });
    it('keeps session approval independent of nested agent and worktree modes', () => {
      const parent = makeConfig({ approvalMode: ApprovalMode.DEFAULT });
      const child = deriveConfig(parent, {
        getApprovalMode: () => ApprovalMode.AUTO_EDIT,
      });
      const nested = deriveWorktreeConfig(
        child,
        '/tmp/native-permission-worktree',
      );
      const wrapper = Object.create(nested) as Config;
      expect(wrapper.getApprovalMode()).toBe(ApprovalMode.AUTO_EDIT);
      expect(wrapper.getSessionApprovalMode()).toBe(ApprovalMode.DEFAULT);
      vi.spyOn(parent, 'getApprovalMode').mockReturnValue(ApprovalMode.YOLO);
      expect(wrapper.getSessionApprovalMode()).toBe(ApprovalMode.YOLO);
      expect(wrapper.getApprovalMode()).toBe(ApprovalMode.AUTO_EDIT);
    });

    it('applies public getter overrides without mutating the parent', () => {
      const parent = makeConfig();
      const child = deriveConfig(parent, { getCwd: () => '/tmp/derived' });

      expect(child.getCwd()).toBe('/tmp/derived');
      // The constructor resolves targetDir, so on win32 the POSIX fixture
      // spelling comes back drive-qualified — compare the resolved form.
      expect(parent.getCwd()).toBe(path.resolve(baseParams.targetDir));
      expect(Object.getPrototypeOf(child)).toBe(parent);
    });

    it('ignores undefined getter overrides', () => {
      const parent = makeConfig();
      const child = deriveConfig(parent, { getCwd: undefined });

      expect(child.getCwd()).toBe(parent.getCwd());
      expect(Object.hasOwn(child, 'getCwd')).toBe(false);
    });

    const ignoreFiles = () => ({ customIgnoreFiles: ['.cursorignore'] });
    /** `child` rebinds every workspace read to `dir`; `parent` keeps its own. */
    const expectRebound = (child: Config, parent: Config, dir: string) => {
      expect(child.getTargetDir()).toBe(dir);
      expect(child.getCwd()).toBe(dir);
      expect(child.getWorkingDir()).toBe(dir);
      expect(child.getProjectRoot()).toBe(dir);
      expect([...child.getWorkspaceContext().getDirectories()]).toEqual([dir]);
      expect(child.getFileService()).not.toBe(parent.getFileService());
      expect(child.getFileService().getQwenIgnoreFileNamesDisplay()).toBe(
        '.qwenignore, .cursorignore',
      );
      const workspaceState = child as unknown as Record<string, unknown>;
      expect(workspaceState['targetDir']).toBe(dir);
      expect(workspaceState['cwd']).toBe(dir);
      expect(Object.hasOwn(child, 'workspaceContext')).toBe(true);
      expect(Object.hasOwn(child, 'fileDiscoveryService')).toBe(true);
      expect(parent.getTargetDir()).toBe(path.resolve(TARGET_DIR));
      // getWorkingDir() returns the raw stored cwd (the constructor resolves
      // only targetDir), so this must NOT path.resolve(): that broke both
      // tests on windows-latest, where resolve('/tmp') is drive-qualified.
      expect(parent.getWorkingDir()).toBe('/tmp');
    };

    it('rebinds worktree getters and private field reads together', () => {
      const worktreeDir = path.resolve('/tmp/worktree');
      const parent = makeConfig({ fileFiltering: ignoreFiles() });
      const child = deriveWorktreeConfig(parent, worktreeDir, ignoreFiles());

      expectRebound(child, parent, worktreeDir);
    });

    it('rebinds agent workspace getters and private field reads together', () => {
      const agentWorkspace = path.resolve('/tmp/agent-workspace');
      const parent = makeConfig({ fileFiltering: ignoreFiles() });
      const agentPlanPath = path.join('/tmp/plans', 'session-agent-1.md');
      const {
        config: child,
        fileService,
        workspaceContext,
      } = deriveAgentConfig(parent, agentWorkspace, {
        ...ignoreFiles(),
        getPlanFilePath: () => agentPlanPath,
      });

      expectRebound(child, parent, agentWorkspace);
      expect(child.getPlanFilePath()).toBe(agentPlanPath);
      expect(child.getWorkspaceContext()).toBe(workspaceContext);
      expect(child.getFileService()).toBe(fileService);
    });

    const OWNERSHIP_ERROR = 'Session write ownership could not be verified.';
    /** Spies for parent-owned resources a derived Config must never touch. */
    const resourceSpies = () => ({
      stop: vi.fn().mockResolvedValue(undefined),
      beginClose: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      finalize: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      teamCleanup: vi.fn().mockResolvedValue(undefined),
      arenaCleanup: vi.fn().mockResolvedValue(undefined),
    });
    const expectUntouched = (...spies: Mock[]) => {
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    };
    /** Every canonical lifecycle operation refuses to run on `child`. */
    const expectLifecycleRefused = async (child: Config) => {
      expect(() => child.startNewSession()).toThrow(
        'Derived Configs cannot start new sessions',
      );
      await expect(
        child.relocateWorkingDirectory(baseParams.targetDir),
      ).rejects.toThrow('Derived Configs cannot relocate working directories');
      await expect(child.cleanupTeamRuntime()).rejects.toThrow(
        'Derived Configs cannot clean up Team runtime',
      );
      await expect(child.cleanupArenaRuntime(true)).rejects.toThrow(
        'Derived Configs cannot clean up Arena runtime',
      );
    };

    it('prohibits inherited session-writer lifecycle access', async () => {
      const parent = makeConfig();
      const { beginClose, close } = resourceSpies();
      const assertCanStartTurn = vi.fn().mockResolvedValue(undefined);
      internals(parent).chatRecordingService = {
        hasWriteOwnership: () => true,
        beginClose,
        close,
        assertCanStartTurn,
      };
      const child = deriveConfig(parent);

      expect(child.hasSessionWriteOwnership()).toBe(false);
      expect(() => child.setSessionWriterReclaimPolicy('never')).toThrow(
        OWNERSHIP_ERROR,
      );
      expect(() => child.setSessionWriterTakeoverPolicy('certified')).toThrow(
        OWNERSHIP_ERROR,
      );
      expect(() => child.closeSessionWriter()).toThrow(OWNERSHIP_ERROR);
      await expect(child.assertCanStartTurn()).resolves.toBeUndefined();
      expectUntouched(assertCanStartTurn, beginClose, close);
      expect(parent.hasSessionWriteOwnership()).toBe(true);
    });

    it('prohibits initializing a derived Config', async () => {
      await expect(deriveConfig(makeConfig()).initialize()).rejects.toThrow(
        'Derived Configs cannot be initialized',
      );
    });

    it('prohibits canonical lifecycle operations on derived Configs', async () => {
      const parent = makeConfig();
      const { finalize, flush, teamCleanup, arenaCleanup } = resourceSpies();
      const internal = internals(parent);
      internal.chatRecordingService = {
        hasWriteOwnership: () => false,
        finalize,
        flush,
      };
      internal.teamManager = { cleanup: teamCleanup };
      internal.arenaManager = { cleanup: arenaCleanup };

      await expectLifecycleRefused(deriveConfig(parent));

      expectUntouched(finalize, flush, teamCleanup, arenaCleanup);
    });

    it('preserves ownership guards through nested prototype wrappers', async () => {
      const parent = makeConfig();
      const spies = resourceSpies();
      const { stop, beginClose, close, finalize, flush } = spies;
      const internal = internals(parent);
      internal.initialized = true;
      internal.toolRegistry = { stop };
      internal.chatRecordingService = {
        hasWriteOwnership: () => false,
        beginClose,
        close,
        finalize,
        flush,
      };
      internal.teamManager = { cleanup: spies.teamCleanup };
      internal.arenaManager = { cleanup: spies.arenaCleanup };
      const wrapped = Object.create(deriveConfig(parent)) as Config;

      expect(wrapped.hasSessionWriteOwnership()).toBe(false);
      expect(() => wrapped.closeSessionWriter()).toThrow(OWNERSHIP_ERROR);
      await expectLifecycleRefused(wrapped);
      await expect(
        wrapped.shutdown({ shutdownTelemetry: false }),
      ).resolves.toBeUndefined();

      expectUntouched(...Object.values(spies));
    });

    it('prohibits derived approval changes from mutating parent permissions', () => {
      const parent = makeConfig();
      const restoreDangerousRules = vi.fn();
      internals(parent).approvalMode = ApprovalMode.AUTO;
      internals(parent).permissionManager = {
        stripDangerousRulesForAutoMode: vi.fn(),
        restoreDangerousRules,
      };
      const child = deriveConfig(parent);

      expect(() => child.setApprovalMode(ApprovalMode.DEFAULT)).toThrow(
        'Derived Configs cannot change approval mode',
      );
      expect(restoreDangerousRules).not.toHaveBeenCalled();
      expect(parent.getApprovalMode()).toBe(ApprovalMode.AUTO);
    });

    it('does not shut down resources inherited from the parent', async () => {
      const parent = makeConfig();
      const { stop, finalize, flush, beginClose, close } = resourceSpies();
      const internal = internals(parent);
      internal.initialized = true;
      internal.toolRegistry = { stop };
      internal.chatRecordingService = { finalize, flush, beginClose, close };
      const child = deriveConfig(parent);

      await expect(
        child.shutdown({ shutdownTelemetry: false }),
      ).resolves.toBeUndefined();

      expectUntouched(stop, finalize, flush, beginClose, close);
    });

    it('returns a distinct file-read cache for derived Configs', () => {
      const parent = makeConfig();
      const child = deriveConfig(parent);

      const parentCache = parent.getFileReadCache();
      const childCache = child.getFileReadCache();

      expect(parentCache).toBeDefined();
      expect(childCache).toBeDefined();
      expect(childCache).not.toBe(parentCache);

      recordFakeRead(parentCache, '/tmp/parent.ts');

      expect(parentCache.size()).toBe(1);
      expect(childCache.size()).toBe(0);
    });

    it('returns the same cache instance on repeated getter calls within one Config', () => {
      const config = makeConfig();
      expect(config.getFileReadCache()).toBe(config.getFileReadCache());
    });
  });

  describe('MCP hot-reload (sub-task 3)', () => {
    const srvA: MCPServerConfig = { command: 'a' };
    const srvB: MCPServerConfig = { command: 'b' };
    /** An initialized Config serving `a`, with its reconcile passes cleared. */
    const initializedWithA = async () => {
      const config = makeConfig({ mcpServers: { a: srvA } });
      await config.initialize();
      const passes = mcpManagerOf(config).discoverAllMcpToolsIncremental;
      passes.mockClear();
      return { config, passes };
    };
    /** A Config configured with `servers` and reconciled once against them. */
    const reconciledWith = async (servers: Record<string, MCPServerConfig>) => {
      const config = makeConfig({ mcpServers: servers });
      await config.reinitializeMcpServers({ ...servers });
      return config;
    };

    it('setMcpServers REPLACES (not merges) and works post-init', async () => {
      const config = await initConfig({ mcpServers: { a: srvA } });

      // addMcpServers would throw post-init; setMcpServers must not.
      config.setMcpServers({ b: srvB });

      const settingsLayer = config.getSettingsMcpServers();
      expect(settingsLayer).toEqual({ b: srvB });
      expect(settingsLayer).not.toHaveProperty('a');
    });

    it('reinitializeMcpServers is a safe no-op before initialize()', async () => {
      const config = makeConfig();
      // No tool registry yet — must not throw and must not connect.
      await expect(
        config.reinitializeMcpServers({ a: srvA }),
      ).resolves.toBeUndefined();
      expect(config.getSettingsMcpServers()).toEqual({ a: srvA });
    });

    it('records MCP servers removed by a reconcile and self-heals on re-add', async () => {
      const config = makeConfig({ mcpServers: { a: srvA, b: srvB } });

      // Drop `a` → tracked as recently removed.
      await config.reinitializeMcpServers({ b: srvB });
      expect(config.getRecentlyRemovedMcpServers()).toEqual(['a']);

      // Drop `b` too → both tracked.
      await config.reinitializeMcpServers({});
      expect(config.getRecentlyRemovedMcpServers().sort()).toEqual(['a', 'b']);

      // Re-add `a` → it self-heals out of the set; `b` stays removed.
      await config.reinitializeMcpServers({ a: srvA });
      expect(config.getRecentlyRemovedMcpServers()).toEqual(['b']);
    });

    it('classifies a server filtered by a narrowed allow-list as not_allowed (not removed)', async () => {
      const config = await reconciledWith({ a: srvA, b: srvB });

      // Narrowing the allow-list to `a` (mirrors editing mcp.allowed) filters
      // out `b`, which is still configured: not "removed", so the
      // tool-not-found path can name the right recovery (adjust mcp.allowed,
      // not "re-add the server").
      config.setAllowedMcpServers(['a']);

      expect(config.getRecentlyRemovedMcpServers()).not.toContain('b');
      expect(config.getMcpServerUnavailableReason('b')).toBe('not_allowed');
      expect(config.getMcpServerUnavailableReason('a')).toBeUndefined();
    });

    it('classifies excluded / pending / removed servers with the right reason', async () => {
      const config = await reconciledWith({ a: srvA, b: srvB, c: srvA });

      config.setExcludedMcpServers(['b']);
      config.setPendingMcpServers(['c']);
      expect(config.getMcpServerUnavailableReason('b')).toBe('excluded');
      expect(config.getMcpServerUnavailableReason('c')).toBe(
        'pending_approval',
      );

      // Delete `a` from config → removed this session.
      await config.reinitializeMcpServers({ b: srvB, c: srvA });
      expect(config.getMcpServerUnavailableReason('a')).toBe('removed');
      // A never-configured name has no reason (falls through to generic).
      expect(config.getMcpServerUnavailableReason('ghost')).toBeUndefined();
    });

    it('reinitializeMcpServers replaces config then drives incremental reconcile', async () => {
      const { config, passes } = await initializedWithA();

      await config.reinitializeMcpServers({ b: srvB });

      expect(config.getSettingsMcpServers()).toEqual({ b: srvB });
      expect(passes).toHaveBeenCalledTimes(1);
      expect(passes).toHaveBeenCalledWith(config);
    });

    it('coalesces a reconcile request that arrives mid-flight into one extra pass', async () => {
      const { config, passes } = await initializedWithA();
      // The first pass hangs until released, so the second call lands
      // mid-flight → coalesced, not a third pass.
      const pass = deferred();
      passes.mockImplementationOnce(() => pass.promise);

      const first = config.reinitializeMcpServers({ b: srvB });
      const second = config.reinitializeMcpServers({ a: srvA, b: srvB });
      pass.resolve();
      await Promise.all([first, second]);

      // One in-flight pass + one drained follow-up = exactly 2 passes.
      expect(passes).toHaveBeenCalledTimes(2);
    });

    it('rethrows a failed reconcile and resets the in-progress guard so the next call still runs', async () => {
      const { config, passes } = await initializedWithA();

      // First pass fails — reinitialize must surface the error.
      passes.mockRejectedValueOnce(new Error('reconcile boom'));
      await expect(config.reinitializeMcpServers({ b: srvB })).rejects.toThrow(
        'reconcile boom',
      );

      // The guard must have been reset in `finally`: the next call runs a
      // fresh pass instead of being silently coalesced/dropped.
      await config.reinitializeMcpServers({ a: srvA });
      expect(passes).toHaveBeenCalledTimes(2);
    });

    it('clears the coalesce flag when a reconcile throws, so the next call runs exactly one pass', async () => {
      const { config, passes } = await initializedWithA();
      // Pass 1 hangs until rejected; the second call arrives mid-flight and
      // is coalesced (sets the pending flag).
      const pass = deferred();
      passes.mockImplementationOnce(() => pass.promise);
      const first = config.reinitializeMcpServers({ b: srvB });
      const second = config.reinitializeMcpServers({ a: srvA, b: srvB });
      pass.reject(new Error('reconcile boom'));
      await expect(first).rejects.toThrow('reconcile boom');
      // The coalesced caller awaits the shared in-flight pass, so it observes
      // the SAME failure rather than resolving before its change was applied.
      await expect(second).rejects.toThrow('reconcile boom');

      // The throw must have cleared the pending flag too: a later unrelated
      // reconcile runs EXACTLY ONE pass, not a stale drain pass left over from
      // the coalesced-then-aborted request.
      passes.mockClear();
      await config.reinitializeMcpServers({ a: srvA });
      expect(passes).toHaveBeenCalledTimes(1);
    });

    it('a coalesced reconcile awaits the in-flight pass + its drain (does not resolve early)', async () => {
      const { config, passes } = await initializedWithA();
      // Pass 1 hangs until released; the second call lands mid-flight.
      const pass = deferred();
      passes.mockImplementationOnce(() => pass.promise);

      let secondResolved = false;
      const first = config.reinitializeMcpServers({ b: srvB });
      const second = config
        .reinitializeMcpServers({ a: srvA, b: srvB })
        .then(() => {
          secondResolved = true;
        });

      // While pass 1 is in flight the coalesced caller must NOT have resolved:
      // it is chained onto the shared reconcile, so its change is not applied.
      await Promise.resolve();
      expect(secondResolved).toBe(false);

      pass.resolve();
      await Promise.all([first, second]);
      expect(secondResolved).toBe(true);
      // pass 1 + exactly one drain (for the coalesced change) = 2 passes.
      expect(passes).toHaveBeenCalledTimes(2);
    });

    it('admission-list setters and getMcpGating round-trip', () => {
      const config = makeConfig();
      config.setExcludedMcpServers(['x']);
      config.setAllowedMcpServers(['y']);
      config.setPendingMcpServers(['z']);
      expect(config.getMcpGating()).toEqual({
        excluded: ['x'],
        allowed: ['y'],
        pending: ['z'],
      });
      expect(config.getAllowedMcpServers()).toEqual(['y']);
    });

    it('getMcpServers filters by glob pattern in allowedMcpServers', async () => {
      const config = makeConfig({
        mcpServers: {
          puppeteer: srvA,
          'my-puppeteer-server': srvB,
          playwright: srvA,
        },
      });
      config.setAllowedMcpServers(['*puppeteer*']);
      const names = Object.keys(config.getMcpServers()!);
      expect(names).toEqual(['puppeteer', 'my-puppeteer-server']);
      expect(names).not.toContain('playwright');
    });

    it('getMcpServers does not stamp cwd — cwd binding happens in populateMcpServerCommand', () => {
      const explicitCwd = path.resolve('/explicit/mcp');
      const config = makeConfig({
        targetDir: path.resolve('/session/worktree'),
        mcpServers: {
          implicit: { command: 'node', args: ['server.js'] },
          explicit: { command: 'node', cwd: explicitCwd },
          remote: { httpUrl: 'https://example.test/mcp' },
          sdk: { type: 'sdk', command: 'placeholder' },
          tcpWithCommand: { tcp: 'tcp://example.test:9000', command: 'node' },
        },
      });

      const servers = config.getMcpServers()!;
      expect(servers['implicit']?.cwd).toBeUndefined();
      expect(servers['explicit']?.cwd).toBe(explicitCwd);
      expect(servers['remote']?.cwd).toBeUndefined();
      expect(servers['sdk']?.cwd).toBeUndefined();
      expect(servers['tcpWithCommand']?.cwd).toBeUndefined();
    });

    it('isMcpServerDisabled supports glob patterns in excludedMcpServers', () => {
      const config = makeConfig({
        mcpServers: { puppeteer: srvA, 'my-puppeteer': srvA, playwright: srvB },
      });
      config.setExcludedMcpServers(['*puppeteer*']);
      expect(config.isMcpServerDisabled('puppeteer')).toBe(true);
      expect(config.isMcpServerDisabled('my-puppeteer')).toBe(true);
      expect(config.isMcpServerDisabled('playwright')).toBe(false);
      expect(config.getMcpServers()!['puppeteer']).toBeDefined();
      expect(config.getMcpServers()!['my-puppeteer']).toBeDefined();
    });

    it('getMcpServerUnavailableReason classifies by glob match', async () => {
      const config = await reconciledWith({
        puppeteer: srvA,
        playwright: srvB,
        chrome: srvA,
      });

      config.setAllowedMcpServers(['play*']);
      expect(config.getMcpServerUnavailableReason('puppeteer')).toBe(
        'not_allowed',
      );
      expect(
        config.getMcpServerUnavailableReason('playwright'),
      ).toBeUndefined();

      // Clear allow-list so the excluded check is reached.
      config.setAllowedMcpServers(undefined);
      config.setExcludedMcpServers(['*chrome*']);
      expect(config.getMcpServerUnavailableReason('chrome')).toBe('excluded');
    });

    it('exclude takes precedence over allow with glob patterns', async () => {
      const config = await reconciledWith({
        puppeteer: srvA,
        playwright: srvB,
      });

      config.setAllowedMcpServers(['*']);
      config.setExcludedMcpServers(['puppeteer']);
      expect(config.getMcpServerUnavailableReason('puppeteer')).toBe(
        'excluded',
      );
      expect(
        config.getMcpServerUnavailableReason('playwright'),
      ).toBeUndefined();
    });

    it('exclude takes precedence when both lists use globs', async () => {
      const config = await reconciledWith({
        puppeteer: srvA,
        playwright: srvB,
      });

      config.setAllowedMcpServers(['*puppeteer*']);
      config.setExcludedMcpServers(['puppeteer']);
      expect(config.getMcpServerUnavailableReason('puppeteer')).toBe(
        'excluded',
      );
      expect(config.isMcpServerDisabled('puppeteer')).toBe(true);
    });

    it('getBlockedMcpServers returns servers not matching allowed glob', () => {
      const config = makeConfig({
        mcpServers: { puppeteer: srvA, 'my-puppeteer': srvA, playwright: srvB },
      });
      config.setAllowedMcpServers(['*puppeteer*']);
      const blockedNames = config.getBlockedMcpServers().map((s) => s.name);
      expect(blockedNames).toContain('playwright');
      expect(blockedNames).not.toContain('puppeteer');
      expect(blockedNames).not.toContain('my-puppeteer');
    });
  });

  describe('MemoryPressureMonitor isolation', () => {
    it('returns a distinct monitor for child Configs created via deriveConfig', async () => {
      const parent = await initConfig({}, SKIP_LLM_INIT);
      const child = deriveConfig(parent);

      const parentMonitor = parent.getMemoryPressureMonitor();
      const childMonitor = child.getMemoryPressureMonitor();

      expect(parentMonitor).toBeDefined();
      expect(childMonitor).toBeDefined();
      expect(childMonitor).not.toBe(parentMonitor);
      expect(child.getMemoryPressureMonitor()).toBe(childMonitor);
    });

    it('resets monitor cleanup state when starting a new session', async () => {
      const config = await initConfig({}, SKIP_LLM_INIT);
      const monitor = config.getMemoryPressureMonitor();
      expect(monitor).toBeDefined();
      const resetSpy = vi.spyOn(monitor!, 'resetForNewSession');

      config.startNewSession();

      expect(resetSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('MemoryPressure configuration environment', () => {
    const restorers: Array<() => void> = [];
    const restoreEnv = stashEnv(...MEMORY_PRESSURE_ENV_KEYS);

    beforeEach(() => {
      for (const envName of MEMORY_PRESSURE_ENV_KEYS) {
        delete process.env[envName];
      }
    });

    afterEach(() => {
      while (restorers.length > 0) {
        restorers.pop()?.();
      }
      restoreEnv();
    });

    /** Set the soft, hard and critical threshold env vars, in that order. */
    const setPressureEnv = (...ratios: string[]) =>
      ratios.forEach((ratio, i) => {
        process.env[MEMORY_PRESSURE_ENV_KEYS[i]] = ratio;
      });

    function mockMemoryRatio(rssRatio: number, heapUsedBytes = 0): void {
      const spy = vi.spyOn(process, 'memoryUsage').mockReturnValue({
        rss: Math.ceil(os.totalmem() * rssRatio),
        heapTotal: 512 * 1024 * 1024,
        heapUsed: heapUsedBytes,
        external: 0,
        arrayBuffers: 0,
      });
      restorers.push(() => spy.mockRestore());
    }

    function mockStderrWrite(): Mock {
      const spy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      restorers.push(() => spy.mockRestore());
      return spy as unknown as Mock;
    }

    it('applies valid memory pressure env overrides', async () => {
      setPressureEnv('0.3', '0.6', '0.9');

      const config = await initConfig({}, SKIP_LLM_INIT);
      mockMemoryRatio(0.35);

      expect(config.getMemoryPressureMonitor()?.getPressureLevel()).toBe(
        'soft',
      );
    });

    it('falls back to defaults and warns on strict env parse failures', async () => {
      const stderrSpy = mockStderrWrite();
      setPressureEnv('0.3extra', '0.6', '0.9');

      const config = await initConfig({}, SKIP_LLM_INIT);
      mockMemoryRatio(0.35);

      expect(config.getMemoryPressureMonitor()?.getPressureLevel()).toBe(
        'normal',
      );
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid memory pressure config'),
      );
    });

    it('falls back to defaults and warns on invalid threshold ordering', async () => {
      const stderrSpy = mockStderrWrite();
      setPressureEnv('0.7');

      const config = await initConfig({}, SKIP_LLM_INIT);

      expect(config.getMemoryPressureMonitor()).toBeDefined();
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'softPressureRatio must be < hardPressureRatio',
        ),
      );
    });

    it.each(['NaN', 'Infinity', '0'])(
      'falls back to defaults for invalid soft threshold %s',
      async (value) => {
        const stderrSpy = mockStderrWrite();
        setPressureEnv(value);

        const config = await initConfig({}, SKIP_LLM_INIT);
        mockMemoryRatio(0.35);

        expect(config.getMemoryPressureMonitor()?.getPressureLevel()).toBe(
          'normal',
        );
        expect(stderrSpy).toHaveBeenCalledWith(
          expect.stringContaining('Invalid memory pressure config'),
        );
      },
    );

    it('explicit GC is enabled by default', async () => {
      const globalWithGc = global as typeof global & { gc?: () => void };
      const originalGc = globalWithGc.gc;
      const gcSpy = vi.fn();
      const setGc = (value: () => void) =>
        Object.defineProperty(globalWithGc, 'gc', {
          value,
          configurable: true,
        });
      setGc(gcSpy);
      restorers.push(() => {
        if (originalGc) setGc(originalGc);
        else delete globalWithGc.gc;
      });

      const config = await initConfig({}, SKIP_LLM_INIT);
      mockMemoryRatio(0.85);

      config.getMemoryPressureMonitor()?.performCheck();
      // Critical tier has 4 async steps, need enough microtask drains
      for (let i = 0; i < 6; i++) await Promise.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await Promise.resolve();

      expect(gcSpy).toHaveBeenCalledTimes(1);
    });

    it('child Config monitors inherit the parent memory pressure config snapshot', async () => {
      setPressureEnv('0.3', '0.6', '0.9');
      const parent = await initConfig({}, SKIP_LLM_INIT);

      setPressureEnv('0.9', '0.95', '0.97');
      const child = deriveConfig(parent);
      mockMemoryRatio(0.35);

      expect(child.getMemoryPressureMonitor()?.getPressureLevel()).toBe('soft');
    });
  });

  describe('startNewSession', () => {
    /** Stub the registry's Skill tool; returns its clearLoadedSkills spy. */
    const stubSkillTool = (config: Config) => {
      const clearLoadedSkills = vi.fn();
      vi.spyOn(config.getToolRegistry(), 'getTool').mockImplementation(
        (name: string) =>
          name === ToolNames.SKILL
            ? ({ clearLoadedSkills } as never)
            : undefined,
      );
      return clearLoadedSkills;
    };
    const clearLifecycleLogs = () => {
      vi.mocked(logSessionEnd).mockClear();
      vi.mocked(logStartSession).mockClear();
    };
    const emptyResume = () =>
      ({ conversation: { messages: [] } }) as unknown as ResumedSessionData;

    it('clears loaded Skill state at the session boundary', async () => {
      const config = await initConfig({}, LEGACY_SKIP_ALL_INIT);
      const clearLoadedSkills = stubSkillTool(config);

      config.startNewSession('replacement-session');

      expect(clearLoadedSkills).toHaveBeenCalledOnce();
    });

    it.each([
      {
        title: 'clears reviewed deferred declarations at the session boundary',
        nextSessionId: 'replacement-session',
        survives: false,
      },
      {
        title: 'keeps reviewed deferred declarations on a same-id restart',
        nextSessionId: undefined,
        survives: true,
      },
    ])('$title', async ({ nextSessionId, survives }) => {
      const config = await initConfig({}, SKIP_ALL_INIT);
      // The registry class is mocked in this file, so attach a stateful
      // review-map trio: the production site calls them optionally and the
      // assertion below observes the map, not the calls.
      const registry = config.getToolRegistry()!;
      const reviews = new Map<string, string>();
      Object.assign(registry, {
        recordReviewedDeclaration: (tool: {
          schema: { name?: string };
        }): void => {
          reviews.set(tool.schema.name ?? '', 'fingerprint');
        },
        getReviewedDeclaration: (name: string) => reviews.get(name),
        clearReviewedDeclarations: (): void => reviews.clear(),
      });
      registry.recordReviewedDeclaration({
        schema: {
          name: 'cron_list',
          parametersJsonSchema: { type: 'object', properties: {} },
        },
      } as never);
      expect(registry.getReviewedDeclaration('cron_list')).toBeDefined();

      config.startNewSession(
        nextSessionId ?? config.getSessionId(),
        nextSessionId === undefined ? emptyResume() : undefined,
      );

      if (survives) {
        expect(registry.getReviewedDeclaration('cron_list')).toBeDefined();
      } else {
        expect(registry.getReviewedDeclaration('cron_list')).toBeUndefined();
      }
    });

    it("drops a skill's session allow rules at the session boundary", async () => {
      // `PermissionManager` outlives the swap, so without the purge a skill's
      // grant would keep auto-approving in a session that never loaded it.
      const config = await initConfig({}, SKIP_ALL_INIT);
      const permissionManager = config.getPermissionManager()!;
      const gitPush = {
        toolName: ToolNames.SHELL,
        command: 'git push origin main',
      };

      await applySkillSideEffects(config, {
        name: 'gated-skill',
        description: 'Gated',
        level: 'user',
        filePath: '/skills/gated-skill/SKILL.md',
        body: 'Body.',
        allowedTools: ['Bash(git *)'],
      } as unknown as SkillConfig);
      expect(await permissionManager.evaluate(gitPush)).toBe('allow');

      config.startNewSession('replacement-session');

      expect(await permissionManager.evaluate(gitPush)).toBe('ask');
    });

    // Subagents and every web_search call share the budget counter; a new
    // session starts with the full budget.
    it.each([
      [
        'resets the web search session budget at the session boundary',
        () => 'replacement-session',
        0,
      ],
      [
        'keeps the web search session budget when the same session id restarts',
        (config: Config) => config.getSessionId(),
        7,
      ],
    ])('%s', async (_title, nextSessionId, expected) => {
      const config = await initConfig({}, SKIP_ALL_INIT);
      config.getWebSearchSessionUsage().calls = 7;

      config.startNewSession(nextSessionId(config));

      expect(config.getWebSearchSessionUsage().calls).toBe(expected);
    });

    it('shares the web search session budget with derived configs', () => {
      // A derived Config is `Object.create(base)`: counting on it must reach
      // the base counter instead of shadowing it with an own property.
      const config = makeConfig();
      const derived = deriveConfig(config);

      derived.getWebSearchSessionUsage().calls++;

      expect(config.getWebSearchSessionUsage().calls).toBe(1);
      expect(Object.hasOwn(derived, 'webSearchSessionUsage')).toBe(false);
    });

    it('records no lifecycle transition when resuming the current session id', async () => {
      const sessionId = 'same-session-id';
      const config = await initConfig({ sessionId }, SKIP_ALL_INIT);
      clearLifecycleLogs();
      const clearLoadedSkills = stubSkillTool(config);

      config.startNewSession(sessionId, emptyResume());

      expect(logSessionEnd).not.toHaveBeenCalled();
      expect(clearLoadedSkills).not.toHaveBeenCalled();
      expect(logStartSession).toHaveBeenCalledWith(
        config,
        expect.anything(),
        undefined,
      );
    });

    it('pins the outgoing chat recorder to the outgoing session id', async () => {
      const config = await initConfig({ chatRecording: true }, SKIP_ALL_INIT);
      const outgoingSessionId = config.getSessionId();
      const outgoingRecorder = config.getChatRecordingService();
      expect(outgoingRecorder).toBeDefined();
      const pinSpy = vi.spyOn(outgoingRecorder!, 'pinSessionIdentity');

      config.startNewSession('replacement-session');

      expect(pinSpy).toHaveBeenCalledWith(outgoingSessionId);
      expect(config.getChatRecordingService()).not.toBe(outgoingRecorder);
    });

    it('ends the outgoing session before starting a replacement without continuation', async () => {
      const config = await initConfig({}, SKIP_ALL_INIT);
      const outgoingSessionId = config.getSessionId();
      const endedSessionIds: string[] = [];
      clearLifecycleLogs();
      vi.mocked(logSessionEnd).mockImplementationOnce((cfg: Config) => {
        endedSessionIds.push(cfg.getSessionId());
      });

      config.startNewSession('replacement-session');

      expect(endedSessionIds).toEqual([outgoingSessionId]);
      expect(logStartSession).toHaveBeenCalledWith(
        config,
        expect.anything(),
        undefined,
      );
      expect(vi.mocked(logSessionEnd).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(logStartSession).mock.invocationCallOrder[0],
      );
    });

    it('carries the outgoing session id when resuming a different persisted session', async () => {
      const config = await initConfig({}, SKIP_ALL_INIT);
      const outgoingSessionId = config.getSessionId();
      vi.mocked(logStartSession).mockClear();

      config.startNewSession('resumed-session-id', emptyResume());

      expect(logStartSession).toHaveBeenCalledWith(
        config,
        expect.anything(),
        outgoingSessionId,
      );
    });

    it('rejects a session switch while the current recorder owns the writer lease', () => {
      const config = recordingConfig();
      const originalSessionId = config.getSessionId();
      const finalize = vi.fn();
      const flush = vi.fn().mockResolvedValue(undefined);
      const recorder = { finalize, flush, hasWriteOwnership: () => true };
      internals(config).chatRecordingService = recorder;
      clearLifecycleLogs();

      expect(() => config.startNewSession('replacement-session')).toThrow(
        expect.objectContaining({
          name: 'SessionWriterUnavailableError',
          errorKind: 'session_writer_unavailable',
        }),
      );
      expect(config.getSessionId()).toBe(originalSessionId);
      expect(config.getChatRecordingService()).toBe(recorder);
      expect(finalize).not.toHaveBeenCalled();
      expect(flush).not.toHaveBeenCalled();
      // A rejected switch must leave the live session's lifecycle untouched.
      expect(logSessionEnd).not.toHaveBeenCalled();
      expect(logStartSession).not.toHaveBeenCalled();
    });

    const goalRecord = (
      uuid: string,
      cause: 'create' | 'pause',
      goal: Record<string, unknown>,
    ) =>
      ({
        uuid,
        parentUuid: null,
        sessionId: 'resumed-session',
        timestamp: new Date(0).toISOString(),
        type: 'system',
        subtype: 'goal_state',
        provenance: 'goal_control',
        cwd: '/tmp',
        version: 'test',
        systemPayload: {
          v: 2,
          cause,
          snapshot: { v: 2, activity: 'idle', goal },
        },
      }) as unknown as ChatRecord;
    const sessionOf = (record: ChatRecord): ResumedSessionData => ({
      conversation: {
        sessionId: 'resumed-session',
        projectHash: 'test',
        startTime: new Date(0).toISOString(),
        lastUpdated: new Date(0).toISOString(),
        messages: [record],
      },
      filePath: '/tmp/resumed-session.jsonl',
      lastCompletedUuid: record.uuid,
    });
    const resumedGoalSession = (status: 'active' | 'paused') =>
      sessionOf(
        goalRecord(`goal-${status}`, status === 'active' ? 'create' : 'pause', {
          goalId: 'g-resumed',
          revision: 1,
          objective: 'resume me',
          status,
          evidenceCursor: { recordId: 'goal-active' },
          turnCount: 1,
          activeTimeMs: 10,
          tokensUsed: 0,
          createdAt: 1,
          updatedAt: 2,
        }),
      );

    // A transcript whose newest Goal record is a paused Goal. Restoring it
    // reads the record and writes nothing; what the deferred restore has to
    // get right is the ordering against the session writer.
    const pausedGoalSession = () =>
      sessionOf(
        goalRecord('paused-goal', 'pause', {
          goalId: 'goal-1',
          revision: 1,
          objective: 'ship the thing',
          status: 'paused',
          evidenceCursor: { recordId: 'paused-goal' },
          turnCount: 0,
          activeTimeMs: 0,
          tokensUsed: 0,
          createdAt: 1,
          updatedAt: 1,
        }),
      );

    /** A selective-restore projection whose only runtime record is an active Goal. */
    const activeGoalProjection = () => {
      const record = resumedGoalSession('active').conversation.messages[0]!;
      return {
        sessionId: 'resumed-session',
        filePath: '/tmp/resumed-session.jsonl',
        startTime: new Date(0).toISOString(),
        lastUpdated: new Date(0).toISOString(),
        runtime: {
          apiHistory: [],
          uiTelemetryEvents: [],
          recording: { lastCompletedUuid: record.uuid, turnParentUuids: [] },
          goalRecords: [record],
          initialTurn: 0,
          backgroundNotificationTaskIds: [],
        },
      };
    };
    /** Bind a Goal host that logs every started permit; returns the log. */
    const bindRecordingHost = (config: Config) => {
      const started: GoalTurnPermit[] = [];
      config.bindGoalTurnHost({
        startGoalTurn: vi.fn(async ({ permit }) => {
          started.push(permit);
        }),
        preemptGoalTurn: vi.fn(),
      });
      return started;
    };
    const goalIds = (permits: GoalTurnPermit[]) =>
      permits.map((permit) => permit.goalId);
    /** Create the 'ship' Goal on the session runtime; returns the runtime. */
    const shipGoal = async (config: Config) => {
      const runtime = config.getGoalRuntime();
      await runtime.dispatch({ action: 'create', objective: 'ship' });
      return runtime;
    };
    const shippedGoal = async (config: Config) =>
      (await shipGoal(config)).getSnapshot().goal;
    const proposal = (objective: string, turnKey: string) => ({
      objective,
      turnKey,
      reviewedGoal: null,
    });

    // Under a writer lease the recorder is `inactive`, rejecting every write,
    // until it is handed the lease. Restore waits for the lease so a restored
    // active Goal's first turn does not write into that guard, and so
    // `restore()` cannot latch a lease-timing failure as `recoveryError` for
    // the whole session. Ordering is the deciding variable: the deferred
    // restore must land the goal rather than brick the runtime.
    it('waits for the session writer before restoring a Goal', async () => {
      const config = leasedConfig({ sessionData: pausedGoalSession() });
      const recorder = config.getChatRecordingService();
      if (!recorder) throw new Error('expected a chat recording service');
      expect(recorder.hasWriteOwnership()).toBe(false);

      let settled = false;
      const ready = config.getGoalRuntimeReady().then(
        (runtime) => {
          settled = true;
          return runtime;
        },
        (error: unknown) => {
          settled = true;
          throw error;
        },
      );
      // Flush microtasks: the pre-fix code had already rejected by here.
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);

      const recordGoalState = vi
        .spyOn(recorder, 'recordGoalState')
        .mockResolvedValue({} as ChatRecord);
      // Stands in for `activateChatRecording()` handing over the lease.
      vi.spyOn(recorder, 'hasWriteOwnership').mockReturnValue(true);
      internals(config).startPendingGoalRestore();

      const runtime = await ready;
      // Restoring reads the journal and writes nothing to it.
      expect(recordGoalState).not.toHaveBeenCalled();
      expect(runtime.getSnapshot().goal).toMatchObject({
        objective: 'ship the thing',
        status: 'paused',
      });
      // Usable, not latched on `recoveryError`, which `assertOperational()`
      // would rethrow from every later beginTurn/dispatch/finishTurn.
      expect(() => runtime.beginTurn('turn-1')).not.toThrow();
    });

    it('fails a deferred Goal restore instead of hanging when the writer never arrives', async () => {
      const config = leasedConfig({ sessionData: pausedGoalSession() });
      const ready = config.getGoalRuntimeReady();
      config.startNewSession('replacement-session');

      await expect(ready).rejects.toBeInstanceOf(
        GoalPersistenceUnavailableError,
      );
    });

    it('parks one approved proposal and hands it to the client once', () => {
      const config = recordingConfig();

      expect(config.setPendingGoalProposal(proposal('first', 'turn-1'))).toBe(
        true,
      );
      expect(config.setPendingGoalProposal(proposal('second', 'turn-1'))).toBe(
        false,
      );
      expect(config.hasPendingGoalProposal()).toBe(true);
      expect(config.takePendingGoalProposal('turn-2')).toBeUndefined();
      expect(config.hasPendingGoalProposal()).toBe(true);
      expect(config.takePendingGoalProposal('turn-1')).toEqual({
        ...proposal('first', 'turn-1'),
        approvalSignal: expect.any(AbortSignal),
      });
      expect(config.hasPendingGoalProposal()).toBe(false);
      expect(config.takePendingGoalProposal()).toBeUndefined();

      const cleared = proposal('explicitly cleared', 'turn-3');
      expect(config.setPendingGoalProposal(cleared)).toBe(true);
      expect(config.takePendingGoalProposal()).toEqual({
        ...cleared,
        approvalSignal: expect.any(AbortSignal),
      });
      expect(config.hasPendingGoalProposal()).toBe(false);
    });

    it('clears a parked proposal when the session Goal runtime is replaced', () => {
      const config = recordingConfig();
      config.setPendingGoalProposal(proposal('stale approval', 'turn-1'));

      config.startNewSession('replacement-session');

      expect(config.takePendingGoalProposal()).toBeUndefined();
    });

    it('restores the complete resumed-session Goal before exposing readiness', async () => {
      const config = recordingConfig({
        sessionData: resumedGoalSession('paused'),
      });

      const initial = await config.getGoalRuntimeReady();
      expect(initial.getSnapshot().goal).toMatchObject({
        objective: 'resume me',
        status: 'paused',
      });

      config.startNewSession(
        'replacement-session',
        resumedGoalSession('active'),
      );
      const replacement = await config.getGoalRuntimeReady();
      expect(replacement).not.toBe(initial);
      expect(replacement.getSnapshot().goal?.status).toBe('active');
    });

    it('reports a committed Goal transition to telemetry', async () => {
      vi.mocked(logGoalState).mockClear();
      const config = recordingConfig();

      await shipGoal(config);

      expect(logGoalState).toHaveBeenCalledTimes(1);
      expect(logGoalState).toHaveBeenCalledWith(
        config,
        expect.objectContaining({
          cause: 'create',
          status: 'active',
          revision: 1,
        }),
      );
    });

    it("does not report a resumed session's recovered Goal again", async () => {
      // The restore broadcast names the recovered record's cause. Reporting it
      // would count this paused Goal as paused a second time.
      vi.mocked(logGoalState).mockClear();
      const config = recordingConfig({
        sessionData: resumedGoalSession('paused'),
      });

      const runtime = await config.getGoalRuntimeReady();
      expect(logGoalState).not.toHaveBeenCalled();

      await runtime.dispatch({
        action: 'resume',
        expectedGoalId: 'g-resumed',
        expectedRevision: 1,
      });
      expect(logGoalState).toHaveBeenCalledTimes(1);
      expect(logGoalState).toHaveBeenCalledWith(
        config,
        expect.objectContaining({ cause: 'resume', goal_id: 'g-resumed' }),
      );

      expect(runtime.getRecoveryCause?.()).toBe('pause');
      await runtime.dispatch({
        action: 'pause',
        expectedGoalId: 'g-resumed',
        expectedRevision: runtime.getSnapshot().goal!.revision,
      });
      expect(logGoalState).toHaveBeenCalledTimes(2);
      expect(logGoalState).toHaveBeenLastCalledWith(
        config,
        expect.objectContaining({ cause: 'pause', goal_id: 'g-resumed' }),
      );
    });

    it('holds selective Goal readiness and autonomous work until finalization', async () => {
      const config = recordingConfig({
        sessionRestoreProjection: activeGoalProjection(),
      });
      const started = bindRecordingHost(config);
      let ready = false;
      void config.getGoalRuntimeReady().then(() => {
        ready = true;
      });

      await Promise.resolve();
      expect(ready).toBe(false);
      expect(started).toEqual([]);

      config.finalizeSessionRestore();

      await expect(config.getGoalRuntimeReady()).resolves.toBe(
        config.getGoalRuntime(),
      );
      await vi.waitFor(() => expect(goalIds(started)).toEqual(['g-resumed']));
    });

    it('rejects selective Goal readiness when restore is abandoned', async () => {
      const config = recordingConfig({
        sessionRestoreProjection: activeGoalProjection(),
      });
      const readiness = config.getGoalRuntimeReady();

      config.startNewSession('replacement-session');

      await expect(readiness).rejects.toThrow('Session restore was abandoned');
    });

    it('owns one durable Goal runtime per canonical session', async () => {
      const config = recordingConfig();
      const first = config.getGoalRuntime();

      expect(config.getGoalRuntime()).toBe(first);
      config.startNewSession('replacement-session');
      const replacement = config.getGoalRuntime();

      expect(replacement).not.toBe(first);
      await expect(
        first.dispatch({ action: 'create', objective: 'stale' }),
      ).rejects.toThrow('Goal runtime has been disposed');
    });

    it('arms each new Goal with the configured token budget', async () => {
      // The only production constructor never passed a grant before, so
      // every session ran on the built-in default with no operator control.
      const config = recordingConfig({ goalTokenBudget: 1_234 });
      expect(config.getGoalTokenBudgetGrant()).toBe(1_234);

      expect(await shippedGoal(config)).toMatchObject({ tokenBudget: 1_234 });
    });

    it.each([
      ['0', 0],
      ['-1', -1],
    ] as const)(
      'runs Goals with no budget when goalTokenBudget is %s',
      async (_label, goalTokenBudget) => {
        // 0 and its -1 alias map to the runtime's non-finite opt-out: the
        // created Goal carries no `tokenBudget` field at all, so nothing
        // non-finite is persisted.
        const config = recordingConfig({ goalTokenBudget });
        expect(config.getGoalTokenBudgetGrant()).toBe(Number.POSITIVE_INFINITY);

        expect(await shippedGoal(config)).not.toHaveProperty('tokenBudget');
      },
    );

    it('accepts the cap itself and rejects one token more', () => {
      // The cap is a typo guard: an extra zero on the default must not
      // silently widen the runaway-spend window tenfold.
      expect(isValidGoalTokenBudget(GOAL_TOKEN_BUDGET_CAP)).toBe(true);
      expect(normalizeGoalTokenBudget(GOAL_TOKEN_BUDGET_CAP)).toBe(
        GOAL_TOKEN_BUDGET_CAP,
      );
      expect(isValidGoalTokenBudget(GOAL_TOKEN_BUDGET_CAP + 1)).toBe(false);
      expect(normalizeGoalTokenBudget(GOAL_TOKEN_BUDGET_CAP + 1)).toBe(
        GOAL_DEFAULT_TOKEN_BUDGET,
      );
    });

    it.each([
      ['absent', undefined],
      ['negative', -5],
      ['fractional', 1.5],
      ['NaN', Number.NaN],
    ] as const)(
      'arms the built-in default when goalTokenBudget is %s',
      async (_label, goalTokenBudget) => {
        const config = recordingConfig({ goalTokenBudget });
        expect(config.getGoalTokenBudgetGrant()).toBe(
          GOAL_DEFAULT_TOKEN_BUDGET,
        );

        expect(await shippedGoal(config)).toMatchObject({
          tokenBudget: GOAL_DEFAULT_TOKEN_BUDGET,
        });
      },
    );

    it('normalizes the goalTokenBudget setting', () => {
      expect(normalizeGoalTokenBudget(400_000)).toBe(400_000);
      expect(normalizeGoalTokenBudget(0)).toBe(Number.POSITIVE_INFINITY);
      // -1 is the opt-out alias for 0, matching the sibling budget
      // settings where -1 means unlimited.
      expect(normalizeGoalTokenBudget(-1)).toBe(Number.POSITIVE_INFINITY);
      expect(isValidGoalTokenBudget(-1)).toBe(true);
      for (const invalid of [
        undefined,
        null,
        -2,
        1.5,
        Number.NaN,
        '12',
        Number.POSITIVE_INFINITY,
      ]) {
        expect(normalizeGoalTokenBudget(invalid)).toBe(
          GOAL_DEFAULT_TOKEN_BUDGET,
        );
        expect(isValidGoalTokenBudget(invalid)).toBe(false);
      }
      expect(isValidGoalTokenBudget(0)).toBe(true);
      expect(isValidGoalTokenBudget(30_000_000)).toBe(true);
    });

    it('arms each new Goal with the configured cadence ceilings', async () => {
      const config = recordingConfig({
        goalMaxTurns: 20,
        goalMaxActiveMinutes: 30,
      });
      expect(config.getGoalTurnBudgetGrant()).toBe(20);
      expect(config.getGoalActiveTimeBudgetGrantMs()).toBe(1_800_000);

      expect(await shippedGoal(config)).toMatchObject({
        turnBudget: 20,
        activeTimeBudgetMs: 1_800_000,
      });
    });

    it('runs Goals with no cadence ceiling by default', async () => {
      // Unlike the token budget, the default is nothing: a cadence is what an
      // operator asks for, not a guard every Goal needs.
      const config = recordingConfig();
      expect(config.getGoalTurnBudgetGrant()).toBe(Number.POSITIVE_INFINITY);
      expect(config.getGoalActiveTimeBudgetGrantMs()).toBe(
        Number.POSITIVE_INFINITY,
      );

      const goal = await shippedGoal(config);
      expect(goal).not.toHaveProperty('turnBudget');
      expect(goal).not.toHaveProperty('activeTimeBudgetMs');
    });

    it.each([
      ['-1 for no ceiling', -1],
      ['0', 0],
      ['above the cap', GOAL_MAX_TURNS_CAP + 1],
      ['fractional', 1.5],
      ['not a number', '20' as unknown as number],
    ])('runs Goals with no turn ceiling when goalMaxTurns is %s', (_l, v) => {
      expect(
        recordingConfig({ goalMaxTurns: v }).getGoalTurnBudgetGrant(),
      ).toBe(Number.POSITIVE_INFINITY);
    });

    it.each([
      ['-1 for no ceiling', -1],
      ['0', 0],
      ['above the cap', GOAL_MAX_ACTIVE_MINUTES_CAP + 1],
      ['fractional', 0.5],
    ])(
      'runs Goals with no time ceiling when goalMaxActiveMinutes is %s',
      (_l, v) => {
        expect(
          recordingConfig({
            goalMaxActiveMinutes: v,
          }).getGoalActiveTimeBudgetGrantMs(),
        ).toBe(Number.POSITIVE_INFINITY);
      },
    );

    it('accepts each cadence cap itself and rejects one past it', () => {
      expect(normalizeGoalMaxTurns(GOAL_MAX_TURNS_CAP)).toBe(
        GOAL_MAX_TURNS_CAP,
      );
      expect(normalizeGoalMaxTurns(GOAL_MAX_TURNS_CAP + 1)).toBe(
        Number.POSITIVE_INFINITY,
      );
      expect(normalizeGoalMaxActiveMinutes(GOAL_MAX_ACTIVE_MINUTES_CAP)).toBe(
        GOAL_MAX_ACTIVE_MINUTES_CAP * 60_000,
      );
      expect(
        normalizeGoalMaxActiveMinutes(GOAL_MAX_ACTIVE_MINUTES_CAP + 1),
      ).toBe(Number.POSITIVE_INFINITY);
    });

    /** Debug-log lines written so far that mention `text`. */
    const debugLinesWith = (text: string) =>
      vi
        .mocked(fs.promises.appendFile)
        .mock.calls.filter((call) => String(call[1]).includes(text));

    it('logs invalid cadence settings and stays silent for accepted values', async () => {
      const sessionId = 'goal-cadence-warning-session';
      await withDebugFallbackIsolation(async () => {
        const appendFileSpy = vi.mocked(fs.promises.appendFile);

        makeConfig({
          sessionId,
          goalMaxTurns: 1.5,
          goalMaxActiveMinutes: '30' as unknown as number,
        });

        await vi.waitFor(() => {
          const warnings = appendFileSpy.mock.calls.map((call) =>
            String(call[1]),
          );
          expect(warnings).toEqual(
            expect.arrayContaining([
              expect.stringContaining('Ignoring invalid goalMaxTurns 1.5'),
              expect.stringContaining(
                'Ignoring invalid goalMaxActiveMinutes 30',
              ),
            ]),
          );
        });

        appendFileSpy.mockClear();
        for (const [goalMaxTurns, goalMaxActiveMinutes] of [
          [undefined, undefined],
          [0, 0],
          [-1, -1],
          [20, 30],
        ] as const) {
          makeConfig({ sessionId, goalMaxTurns, goalMaxActiveMinutes });
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(debugLinesWith('Ignoring invalid goalMax')).toHaveLength(0);
      }, true);
    });

    it('records the invalid-goalTokenBudget fallback in the debug log', async () => {
      // The fallback notice lives in the debug log file (enabled via
      // QWEN_DEBUG_LOG_FILE / --debug), not on a user-visible channel.
      const sessionId = 'goal-budget-warning-session';
      await withDebugFallbackIsolation(async () => {
        makeConfig({ sessionId, goalTokenBudget: -5 });

        await vi.waitFor(() =>
          expect(vi.mocked(fs.promises.appendFile)).toHaveBeenCalledWith(
            Storage.getDebugLogPath(sessionId),
            expect.stringMatching(
              /Ignoring invalid goalTokenBudget -5:.*using the default of 30000000/,
            ),
            'utf8',
          ),
        );
      }, true);
    });

    it('keeps the goalTokenBudget debug warning silent for absent, valid, and opt-out values', async () => {
      const sessionId = 'goal-budget-warning-session';
      await withDebugFallbackIsolation(async () => {
        for (const goalTokenBudget of [undefined, 0, 1_234, -1]) {
          makeConfig({ sessionId, goalTokenBudget });
          // Let any fire-and-forget debug write settle before the next case.
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(debugLinesWith('Ignoring invalid goalTokenBudget')).toHaveLength(
          0,
        );

        // Control case: the channel is live in this test, so the silence
        // above is meaningful.
        makeConfig({ sessionId, goalTokenBudget: -5 });
        await vi.waitFor(() =>
          expect(vi.mocked(fs.promises.appendFile)).toHaveBeenCalledWith(
            Storage.getDebugLogPath(sessionId),
            expect.stringContaining('Ignoring invalid goalTokenBudget -5'),
            'utf8',
          ),
        );
      }, true);
    });

    it('bills Goal turns through the canonical chat recorder', async () => {
      const config = recordingConfig();
      const started = bindRecordingHost(config);
      const runtime = await shipGoal(config);
      const permit = started[0]!;

      config.getChatRecordingService()!.recordAssistantTurn({
        model: 'test-model',
        tokens: { totalTokenCount: 4_500 },
        goalContext: permit,
      });
      await runtime.finishTurn(permit);

      expect(runtime.getSnapshot().goal).toMatchObject({ tokensUsed: 4_500 });
    });

    it('measures no-progress turns through the canonical chat recorder', async () => {
      const config = recordingConfig();
      const started = bindRecordingHost(config);
      const runtime = config.getGoalRuntime();
      await runtime.dispatch({ action: 'create', objective: 'ship' });

      for (let turn = 0; turn < 3; turn++) {
        await vi.waitFor(() => expect(started).toHaveLength(turn + 1));
        const permit = started[turn]!;
        runtime.markTurnDelivered(`goal-runtime:${permit.turnId}`);
        await runtime.finishTurn(permit);
      }

      expect(runtime.getSnapshot().goal).toMatchObject({
        status: 'paused',
        noProgressTurns: 3,
      });
    });

    it('rebinds the current Goal host to every replacement runtime', async () => {
      const config = recordingConfig({
        sessionData: resumedGoalSession('active'),
      });

      const started = bindRecordingHost(config);
      await config.getGoalRuntimeReady();
      await vi.waitFor(() => expect(goalIds(started)).toEqual(['g-resumed']));

      config.startNewSession(
        'replacement-session',
        resumedGoalSession('active'),
      );
      await config.getGoalRuntimeReady();
      await vi.waitFor(() =>
        expect(goalIds(started)).toEqual(['g-resumed', 'g-resumed']),
      );
    });

    it('does not expose volatile Goal state when chat recording is disabled', () => {
      expect(() =>
        makeConfig({ chatRecording: false }).getGoalRuntime(),
      ).toThrow(GoalPersistenceUnavailableError);
    });

    it('rejects readiness when chat recording is disabled instead of throwing synchronously', async () => {
      const config = makeConfig({ chatRecording: false });

      await expect(config.getGoalRuntimeReady()).rejects.toBeInstanceOf(
        GoalPersistenceUnavailableError,
      );
      await expect(config.getGoalRuntimePrepared()).rejects.toBeInstanceOf(
        GoalPersistenceUnavailableError,
      );
    });

    it('does not leak the canonical Goal runtime through subagent prototypes', async () => {
      const config = recordingConfig();
      const canonical = config.getGoalRuntime();
      const child = deriveConfig(config);

      expect(() => child.getGoalRuntime()).toThrow(
        GoalPersistenceUnavailableError,
      );
      expect(() =>
        child.bindGoalTurnHost({
          startGoalTurn: vi.fn(),
          preemptGoalTurn: vi.fn(),
        }),
      ).toThrow(GoalPersistenceUnavailableError);
      await expect(
        child.rebaseGoalRuntimeFromActiveTranscript(),
      ).rejects.toThrow(GoalPersistenceUnavailableError);
      await child.shutdown();
      expect(() => canonical.getSnapshot()).not.toThrow();
      expect(config.getGoalRuntime()).toBe(canonical);
    });

    it('clears the FileReadCache so a new session does not inherit prior reads', () => {
      // Regression guard: the cache backs ReadFile's file_unchanged
      // placeholder, which is only correct if the model saw the prior read
      // earlier in the *current* conversation. /clear and resume both go
      // through startNewSession(), so it must drop entries the new session
      // has never seen.
      const config = makeConfig();
      const cache = config.getFileReadCache();
      recordFakeRead(cache, '/tmp/whatever.ts');
      expect(cache.size()).toBe(1);

      config.startNewSession();
      expect(cache.size()).toBe(0);
    });

    it('refreshes the telemetry session context with the new session ID', () => {
      const config = makeConfig();
      vi.mocked(refreshSessionContext).mockClear();

      const newSessionId = config.startNewSession();

      expect(refreshSessionContext).toHaveBeenCalledWith(newSessionId);
    });

    it('flushes the outgoing chat recording service when switching sessions', () => {
      const config = recordingConfig();
      const finalize = vi.fn();
      const flush = vi.fn().mockResolvedValue(undefined);
      const pinSessionIdentity = vi.fn();
      internals(config).chatRecordingService = {
        finalize,
        flush,
        hasWriteOwnership: () => false,
        pinSessionIdentity,
      };

      const outgoingSessionId = config.getSessionId();
      config.startNewSession();

      expect(finalize).toHaveBeenCalledTimes(1);
      expect(flush).toHaveBeenCalledTimes(1);
      expect(pinSessionIdentity).toHaveBeenCalledWith(outgoingSessionId);
    });
  });

  describe('chat recording failure listeners', () => {
    const notify = (config: Config, event: ChatRecordingFailureEvent) =>
      internals(config).notifyChatRecordingFailure(event);

    it('notifies multiple listeners and disposes them independently', () => {
      const config = new Config(baseParams);
      const first = vi.fn();
      const second = vi.fn();
      const disposeFirst = config.onChatRecordingFailure(first);
      config.onChatRecordingFailure(second);
      const event = { sessionId: 's-1', error: new Error('write failed') };

      notify(config, event);
      disposeFirst();
      notify(config, event);

      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(2);
    });

    it('keeps a subscription wired to a replacement session recorder', async () => {
      const config = makeConfig({ chatRecording: true });
      const listener = vi.fn();
      config.onChatRecordingFailure(listener);
      const sessionId = '11111111-1111-1111-1111-111111111111';
      config.startNewSession(sessionId);
      const error = new Error('replacement write failed');
      const writeLine = vi
        .spyOn(jsonl, 'writeLine')
        .mockRejectedValueOnce(error);

      try {
        const recorder = config.getChatRecordingService()!;
        recorder.recordUserMessage([{ text: 'new session' }]);
        await expect(recorder.flush()).rejects.toBe(error);

        expect(listener).toHaveBeenCalledOnce();
        await expect(config.assertCanStartTurn()).resolves.toBeUndefined();
        expect(listener).toHaveBeenCalledWith({ sessionId, error });
      } finally {
        writeLine.mockRestore();
      }
    });

    it('isolates synchronous throws and asynchronous listener rejections', async () => {
      const config = new Config(baseParams);
      const unhandled: unknown[] = [];
      const onUnhandled = (error: unknown) => unhandled.push(error);
      process.on('unhandledRejection', onUnhandled);
      try {
        config.onChatRecordingFailure(() => {
          throw new Error('listener threw');
        });
        config.onChatRecordingFailure(async () => {
          throw new Error('listener rejected');
        });

        notify(config, {
          sessionId: 's-1',
          error: new Error('write failed'),
        });
        await new Promise((resolve) => setImmediate(resolve));

        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    it('keeps listeners through shutdown flush and clears them afterward', async () => {
      const config = new Config(baseParams);
      const listener = vi.fn();
      config.onChatRecordingFailure(listener);
      const event = { sessionId: 's-1', error: new Error('write failed') };
      internals(config).initialized = true;
      internals(config).chatRecordingService = {
        finalize: vi.fn(),
        flush: async () => {
          notify(config, event);
        },
        beginClose: vi.fn(),
        close: async () => {},
      };

      await config.shutdown();
      notify(config, event);

      expect(listener).toHaveBeenCalledOnce();
    });
  });

  /** A Config with LSP enabled and, when given, the stand-in client. */
  const lspConfig = (lspClient?: object) =>
    makeConfig({
      lsp: { enabled: true },
      ...(lspClient
        ? { lspClient: lspClient as unknown as ConfigParameters['lspClient'] }
        : {}),
    });
  const noServers = {
    enabled: true,
    configuredServers: 0,
    readyServers: 0,
    failedServers: 0,
    inProgressServers: 0,
    notStartedServers: 0,
    servers: [],
  };
  /** A reinitializeLsp result with the named reconcile buckets filled in. */
  const reconcile = (
    buckets: Partial<
      Record<
        'added' | 'removed' | 'restarted' | 'unchanged' | 'failed',
        string[]
      >
    >,
  ) => ({
    reconcile: {
      added: [],
      removed: [],
      restarted: [],
      unchanged: [],
      failed: [],
      ...buckets,
    },
    skipped: [],
  });
  it('should expose LSP status from the configured client', () => {
    const snapshot = {
      ...noServers,
      configuredServers: 1,
      readyServers: 1,
      servers: [
        {
          name: 'clangd',
          status: 'READY',
          languages: ['cpp'],
          transport: 'stdio',
        },
      ],
    };
    const getStatusSnapshot = vi.fn().mockReturnValue(snapshot);
    const config = lspConfig({ getStatusSnapshot });

    expect(config.getLspStatusSnapshot()).toEqual(snapshot);
    expect(getStatusSnapshot).toHaveBeenCalledTimes(1);
  });

  describe('isWorkflowNameOnly', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('is off by default, and on from the setting or the environment', () => {
      vi.stubEnv('QWEN_CODE_WORKFLOW_NAME_ONLY', '');
      const nameOnly = (workflowNameOnly?: boolean) =>
        makeConfig({ workflowNameOnly }).isWorkflowNameOnly();
      expect(nameOnly()).toBe(false);
      expect(nameOnly(true)).toBe(true);
      vi.stubEnv('QWEN_CODE_WORKFLOW_NAME_ONLY', '1');
      expect(nameOnly()).toBe(true);
      // The environment only turns the lock on.
      expect(nameOnly(false)).toBe(true);
    });

    // Notifications read the lock from the registry the config owns, so the
    // two cannot disagree about which resume call to offer.
    it('hands the lock to its workflow run registry', () => {
      vi.stubEnv('QWEN_CODE_WORKFLOW_NAME_ONLY', '');
      for (const workflowNameOnly of [true, false]) {
        const registry = makeConfig({
          workflowNameOnly,
        }).getWorkflowRunRegistry();
        const completion = vi.fn();
        registry.setCompletionCallback(completion);
        const entry = registry.register({
          runId: 'wf_lock',
          meta: null,
          status: 'running',
          startTime: 1,
          outputFile: '',
          abortController: new AbortController(),
          isBackgrounded: true,
          scriptPath: '/runtime/workflows/generated/inline/wf_lock.js',
          // A resume call is offered only beside a journal to replay.
          journalPath: '/runtime/workflows/wf_lock/journal.jsonl',
        } as never);
        registry.fail(entry.runId, 'boom', 2);
        const text = completion.mock.calls[0][1] as string;
        expect(text.includes('only whoever started it')).toBe(workflowNameOnly);
        expect(text.includes('Workflow({ scriptPath')).toBe(!workflowNameOnly);
      }
    });

    it('is decided when the session starts', () => {
      vi.stubEnv('QWEN_CODE_WORKFLOW_NAME_ONLY', '');
      const config = new Config(baseParams);
      vi.stubEnv('QWEN_CODE_WORKFLOW_NAME_ONLY', '1');
      expect(config.isWorkflowNameOnly()).toBe(false);
    });
  });

  it('keeps project-derived features disabled for a provisional workspace', () => {
    const config = makeConfig({
      provisionalWorkspace: true,
      lsp: { enabled: true },
      workflowsEnabled: true,
      enableTeamMemory: true,
      enableTeamMemorySync: true,
      enableAutoSkill: true,
    });

    expect(config.isLspEnabled()).toBe(false);
    expect(config.isWorkflowsEnabled()).toBe(false);
    expect(config.getTeamMemoryEnabled()).toBe(false);
    expect(config.getTeamMemorySyncEnabled()).toBe(false);
    expect(config.getAutoSkillEnabled()).toBe(false);
  });

  it('should report unavailable LSP status when client lacks a status snapshot API', () => {
    expect(lspConfig({}).getLspStatusSnapshot()).toEqual({
      ...noServers,
      statusUnavailable: true,
    });
  });

  it('should merge initialization errors into the client LSP status snapshot', () => {
    const config = lspConfig({
      getStatusSnapshot: vi.fn().mockReturnValue({
        ...noServers,
        configuredServers: 1,
        failedServers: 1,
        initializationError: 'client failed',
      }),
    });

    config.setLspInitializationError('discovery failed');

    expect(config.getLspStatusSnapshot()).toMatchObject({
      enabled: true,
      initializationError: 'discovery failed',
    });
  });

  it('should report an initialization error when LSP is enabled without a client', () => {
    expect(lspConfig().getLspStatusSnapshot()).toEqual({
      ...noServers,
      initializationError: 'LSP client is not initialized',
    });
  });

  it('should no-op LSP reinitialize when disabled or unavailable', async () => {
    const disabledConfig = makeConfig({ lsp: { enabled: false } });
    await expect(disabledConfig.reinitializeLsp()).resolves.toBeUndefined();

    await expect(lspConfig().reinitializeLsp()).resolves.toBeUndefined();
  });

  it('should delegate LSP reinitialize to the configured client', async () => {
    const result = reconcile({ added: ['tsserver'] });
    const reinitialize = vi.fn().mockResolvedValue(result);
    const config = lspConfig({ reinitialize });

    await expect(config.reinitializeLsp()).resolves.toBe(result);
    expect(reinitialize).toHaveBeenCalledOnce();
  });

  it('should surface partial LSP reinitialize failures in status snapshot', async () => {
    const result = reconcile({ added: ['tsserver'], failed: ['clangd'] });
    const config = lspConfig({
      reinitialize: vi.fn().mockResolvedValue(result),
    });

    await expect(config.reinitializeLsp()).resolves.toBe(result);
    expect(config.getLspStatusSnapshot()).toMatchObject({
      initializationError: 'LSP reload partially failed: clangd',
    });
  });

  it('should surface LSP reinitialize failures in status snapshot', async () => {
    const config = lspConfig({
      reinitialize: vi.fn().mockRejectedValue(new Error('invalid lsp json')),
    });

    await expect(config.reinitializeLsp()).rejects.toThrow('invalid lsp json');
    expect(config.getLspStatusSnapshot()).toMatchObject({
      initializationError: 'invalid lsp json',
    });
  });

  it('should clear previous LSP reinitialize failures after recovery', async () => {
    const result = reconcile({ unchanged: ['tsserver'] });
    const reinitialize = vi
      .fn()
      .mockRejectedValueOnce(new Error('invalid lsp json'))
      .mockResolvedValueOnce(result);
    const config = lspConfig({ reinitialize });

    await expect(config.reinitializeLsp()).rejects.toThrow('invalid lsp json');
    expect(config.getLspStatusSnapshot()).toMatchObject({
      initializationError: 'invalid lsp json',
    });

    await expect(config.reinitializeLsp()).resolves.toBe(result);
    expect(config.getLspStatusSnapshot().initializationError).toBeUndefined();
  });

  it('should clear partial LSP reinitialize failures after full recovery', async () => {
    const partialFailure = reconcile({ failed: ['clangd'] });
    const success = reconcile({ unchanged: ['clangd'] });
    const reinitialize = vi
      .fn()
      .mockResolvedValueOnce(partialFailure)
      .mockResolvedValueOnce(success);
    const config = lspConfig({ reinitialize });

    await expect(config.reinitializeLsp()).resolves.toBe(partialFailure);
    expect(config.getLspStatusSnapshot()).toMatchObject({
      initializationError: 'LSP reload partially failed: clangd',
    });

    await expect(config.reinitializeLsp()).resolves.toBe(success);
    expect(config.getLspStatusSnapshot().initializationError).toBeUndefined();
  });

  describe('initialize', () => {
    it('accepts managed handoff only after certified takeover is configured', async () => {
      const standalone = makeConfig();
      await standalone.closeSessionWriter({ handoff: true });
      expect(internals(standalone).sessionWriterHandoffRequested).toBe(false);

      const managed = makeConfig();
      managed.setSessionWriterTakeoverPolicy('certified');
      await managed.closeSessionWriter({ handoff: true });
      expect(internals(managed).sessionWriterHandoffRequested).toBe(true);
    });

    it.each([
      [
        'an ACP session without an opt-in',
        { experimentalZedIntegration: true },
      ],
      [
        'a non-ACP session with the setting enabled',
        { sessionWriterLeaseEnabled: true },
      ],
      [
        'an ACP session with an invalid truthy opt-in',
        {
          experimentalZedIntegration: true,
          sessionWriterLeaseEnabled: 'true' as unknown as boolean,
        },
      ],
    ])(
      'uses the legacy recorder without acquiring a writer lease for %s',
      async (_name, params) => {
        const acquire = vi.spyOn(SessionWriterLease, 'acquire');
        const config = recordingConfig(params);

        await internals(config).activateChatRecording();

        expect(acquire).not.toHaveBeenCalled();
        expect(config.isSessionWriterLeaseEnabled()).toBe(false);
        expect(config.hasSessionWriteOwnership()).toBe(false);
        await expect(
          config
            .getChatRecordingService()
            ?.runWithWriteBarrier(async () => 'legacy'),
        ).resolves.toBe('legacy');
        acquire.mockRestore();
      },
    );

    it('adopts the active transcript when writer activation sees both states', async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440099';
      const sessionData = {
        conversation: {
          sessionId,
          projectHash: 'test',
          startTime: new Date(0).toISOString(),
          lastUpdated: new Date(0).toISOString(),
          messages: [],
        },
        filePath: `/tmp/${sessionId}.jsonl`,
        lastCompletedUuid: null,
      } as ResumedSessionData;
      const config = leasedConfig({ sessionId });
      const service = config.getSessionService();
      vi.spyOn(service, 'getSessionLocation').mockResolvedValue('conflict');
      const loadSession = vi
        .spyOn(service, 'loadSession')
        .mockResolvedValue(sessionData);
      const lease = {
        sessionId,
        transcriptExistedAtAcquire: true,
        isReleased: false,
        assertOwnedAndUnchanged: vi.fn().mockResolvedValue(undefined),
        release: vi.fn().mockResolvedValue(undefined),
      } as unknown as SessionWriterLease;
      const acquire = vi
        .spyOn(SessionWriterLease, 'acquire')
        .mockResolvedValue(lease);

      await internals(config).activateChatRecording();

      expect(loadSession).toHaveBeenCalledWith(sessionId);
      expect(config.hasSessionWriteOwnership()).toBe(true);
      acquire.mockRestore();
    });

    it('releases a pending lease while a real baseline read is gated', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'qwen-config-writer-'));
      const runtimeBaseDir = path.join(root, 'runtime');
      const projectDir = path.join(root, 'project');
      await mkdir(projectDir, { recursive: true });
      Storage.setRuntimeBaseDir(runtimeBaseDir);
      const config = leasedConfig({
        sessionId: 'pending-baseline',
        cwd: projectDir,
        targetDir: projectDir,
      });
      const transcriptPath = config.getTranscriptPath();
      await mkdir(path.dirname(transcriptPath), { recursive: true });
      const transcript = Buffer.alloc(2 * 1024 * 1024, 0x20);
      transcript[transcript.byteLength - 1] = 0x0a;
      await writeFile(transcriptPath, transcript);
      const lockPath = getSessionWriterLockPath(
        runtimeBaseDir,
        'pending-baseline',
      );
      const probe = await open(transcriptPath, 'r');
      const fileHandlePrototype = Object.getPrototypeOf(probe) as {
        read: typeof probe.read;
      };
      await probe.close();
      const originalRead = fileHandlePrototype.read;
      const readGate = deferred();
      const readStarted = deferred();
      let gated = false;
      const read = vi
        .spyOn(fileHandlePrototype, 'read')
        .mockImplementation(async function (
          this: fs.promises.FileHandle,
          ...args
        ) {
          const result = await originalRead.apply(this, args);
          const values = args as readonly unknown[];
          if (!gated && values[2] === 1024 * 1024) {
            gated = true;
            readStarted.resolve();
            await readGate.promise;
          }
          return result;
        });
      const actualFs =
        await vi.importActual<typeof import('node:fs')>('node:fs');
      (fs.readFileSync as Mock).mockImplementation(
        (pathOrDescriptor: unknown) =>
          typeof pathOrDescriptor === 'number'
            ? actualFs.readFileSync(pathOrDescriptor, 'utf8')
            : undefined,
      );

      try {
        const initialize = config.initialize();
        await readStarted.promise;
        await expect(stat(lockPath)).resolves.toBeDefined();
        const close = config.closeSessionWriter();

        await vi.waitFor(
          () =>
            expect(stat(lockPath)).rejects.toMatchObject({
              code: 'ENOENT',
            }),
          { timeout: 1_000 },
        );
        expect(gated).toBe(true);
        readGate.resolve();
        await expect(close).resolves.toBeUndefined();
        await expect(initialize).rejects.toMatchObject({
          name: 'SessionWriterUnavailableError',
        });
        expect(config.hasSessionWriteOwnership()).toBe(false);
        expect(config.getChatRecordingService()?.hasWriteOwnership()).toBe(
          false,
        );
      } finally {
        readGate.resolve();
        read.mockRestore();
        Storage.setRuntimeBaseDir(null);
        await rm(root, { recursive: true, force: true });
      }
    });

    it('treats managed shutdown during writer acquisition as a clean terminal', async () => {
      const config = leasedConfig();
      const acquireGate = deferred<SessionWriterLease>();
      let released = false;
      const release = vi.fn().mockImplementation(async () => {
        released = true;
      });
      const lease = {
        transcriptExistedAtAcquire: false,
        release,
        get isReleased() {
          return released;
        },
      } as unknown as SessionWriterLease;
      const acquire = vi
        .spyOn(SessionWriterLease, 'acquire')
        .mockReturnValue(acquireGate.promise);

      const initialize = config.initialize();
      await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
      const close = config.closeSessionWriter();
      acquireGate.resolve(lease);

      await expect(close).resolves.toBeUndefined();
      await expect(initialize).rejects.toMatchObject({
        name: 'SessionWriterUnavailableError',
      });
      expect(release).toHaveBeenCalledOnce();
      expect(config.hasSessionWriteOwnership()).toBe(false);
      acquire.mockRestore();
    });

    it('retries pending lease durability without reporting stale ownership', async () => {
      const config = leasedConfig();
      const cleanupFailure = new SessionWriterUnavailableError();
      let released = false;
      let durabilityPending = false;
      const release = vi
        .fn()
        .mockImplementationOnce(async () => {
          released = true;
          durabilityPending = true;
          throw cleanupFailure;
        })
        .mockImplementationOnce(async () => {
          durabilityPending = false;
        });
      const lease = {
        release,
        get isReleased() {
          return released;
        },
        get isReleaseDurabilityPending() {
          return durabilityPending;
        },
      } as unknown as SessionWriterLease;
      internals(config).pendingSessionWriterLease = lease;

      await expect(config.closeSessionWriter()).rejects.toBe(cleanupFailure);
      expect(config.hasSessionWriteOwnership()).toBe(false);

      await expect(config.closeSessionWriter()).resolves.toBeUndefined();
      expect(release).toHaveBeenCalledTimes(2);
      expect(config.hasSessionWriteOwnership()).toBe(false);
    });

    it('preserves activation and lease release failures', async () => {
      const config = leasedConfig();
      expect(config.isSessionWriterLeaseEnabled()).toBe(true);
      const activationError = new SessionTranscriptChangedError();
      const releaseError = new Error('lease release failed');
      const release = vi.fn().mockRejectedValue(releaseError);
      const acquire = vi
        .spyOn(SessionWriterLease, 'acquire')
        .mockResolvedValue({
          transcriptExistedAtAcquire: false,
          release,
        } as unknown as SessionWriterLease);
      vi.spyOn(
        config.getSessionService(),
        'getSessionLocation',
      ).mockRejectedValue(activationError);

      const result = await config.initialize().catch((error: unknown) => error);

      expect(result).toMatchObject({
        name: 'SessionWriterUnavailableError',
        errorKind: 'session_writer_unavailable',
        rpcCode: -32023,
        httpStatus: 503,
        cause: expect.any(AggregateError),
      });
      expect(
        (result as Error & { cause: AggregateError }).cause.errors,
      ).toEqual([activationError, releaseError]);
      expect(release).toHaveBeenCalledOnce();
      acquire.mockRestore();
    });

    it('does not report the same acquisition release failure twice', async () => {
      const config = leasedConfig();
      const activationError = new SessionTranscriptChangedError();
      const releaseError = new Error('lease release failed');
      const acquisitionFailure = new SessionWriterUnavailableError({
        cause: new AggregateError([activationError, releaseError]),
      });
      const release = vi.fn().mockRejectedValue(releaseError);
      const lease = {
        release,
        isReleased: false,
      } as unknown as SessionWriterLease;
      const acquire = vi
        .spyOn(SessionWriterLease, 'acquire')
        .mockImplementation(async (options) => {
          options.onOwnershipAcquired?.(lease);
          throw acquisitionFailure;
        });

      const result = await config.initialize().catch((error: unknown) => error);

      expect(result).toBe(acquisitionFailure);
      expect(release).toHaveBeenCalledOnce();
      acquire.mockRestore();
    });

    it('does not duplicate a concurrent activation and close failure', async () => {
      const config = leasedConfig();
      const activationError = new SessionTranscriptChangedError();
      const acquireGate = deferred<SessionWriterLease>();
      const acquire = vi
        .spyOn(SessionWriterLease, 'acquire')
        .mockReturnValue(acquireGate.promise);

      const initialize = config.initialize().catch((error: unknown) => error);
      await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
      const close = config
        .closeSessionWriter()
        .catch((error: unknown) => error);
      acquireGate.reject(activationError);

      expect(await close).toBe(activationError);
      expect(await initialize).toBe(activationError);
      acquire.mockRestore();
    });

    it('preserves initialization and recording close failures', async () => {
      const config = makeConfig();
      const initializationError = new Error('initialization failed');
      const closeError = new Error('recording close failed');
      vi.spyOn(internals(config), 'initializeInternal').mockRejectedValue(
        initializationError,
      );
      internals(config).chatRecordingService = {
        beginClose: vi.fn(),
        close: vi.fn().mockRejectedValue(closeError),
      };

      const result = await config.initialize().catch((error: unknown) => error);

      expect(result).toMatchObject({
        name: 'SessionWriterUnavailableError',
        cause: expect.any(AggregateError),
      });
      expect(
        (result as Error & { cause: AggregateError }).cause.errors,
      ).toEqual([initializationError, closeError]);
    });

    it('preserves initialization cancellation when recording close fails', async () => {
      const config = makeConfig();
      const controller = new AbortController();
      const abortReason = new Error('session initialization deadline exceeded');
      const closeError = new Error('recording close failed');
      vi.spyOn(internals(config), 'initializeInternal').mockImplementation(
        async (options) => {
          controller.abort(abortReason);
          options?.signal?.throwIfAborted();
        },
      );
      const close = vi
        .spyOn(config, 'closeSessionWriter')
        .mockRejectedValue(closeError);

      const result = await config
        .initialize({ signal: controller.signal })
        .catch((error: unknown) => error);

      expect(result).toBe(abortReason);
      expect(close).toHaveBeenCalledOnce();
    });

    it('runs due auto-skill curation before loading skills when enabled', async () => {
      await initConfig({ enableAutoSkill: true });

      expect(maybeRunAutoSkillCurator).toHaveBeenCalledWith(
        path.resolve(TARGET_DIR),
      );
      expect(
        vi.mocked(maybeRunAutoSkillCurator).mock.invocationCallOrder[0],
      ).toBeLessThan(vi.mocked(SkillManager).mock.invocationCallOrder[0]);
    });

    it.each([
      [
        'does not run auto-skill curation when auto-skill is disabled',
        { enableAutoSkill: false },
      ],
      [
        'does not run auto-skill curation in an untrusted folder',
        { enableAutoSkill: true, trustedFolder: false },
      ],
    ])('%s', async (_title, params) => {
      await initConfig(params);

      expect(maybeRunAutoSkillCurator).not.toHaveBeenCalled();
    });

    it('continues loading skills when auto-skill curation fails', async () => {
      vi.mocked(maybeRunAutoSkillCurator).mockRejectedValueOnce(
        new Error('corrupt curator state'),
      );

      const config = makeConfig({ enableAutoSkill: true });

      await expect(config.initialize()).resolves.toBeUndefined();
      expect(SkillManager).toHaveBeenCalledTimes(1);
    });

    /**
     * Stub initializeInternal to install a tool registry whose stop is `stop`,
     * after `gate` settles and before throwing `failure`, when given.
     */
    const stubInitRegistry = (
      config: Config,
      {
        stop = vi.fn().mockResolvedValue(undefined),
        gate,
        failure,
      }: { stop?: Mock; gate?: Promise<void>; failure?: Error } = {},
    ) => {
      const internal = internals(config);
      const initializeInternal = vi
        .spyOn(internal, 'initializeInternal')
        .mockImplementation(async () => {
          if (gate) await gate;
          internal.toolRegistry = { stop };
          if (failure) throw failure;
        });
      return { stop, initializeInternal };
    };
    const failingOnceStop = () =>
      vi
        .fn()
        .mockRejectedValueOnce(new Error('stop failed'))
        .mockResolvedValue(undefined);
    const nextMacrotask = () =>
      new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

    it('waits for in-flight initialization before cleaning late resources', async () => {
      const config = makeConfig();
      const gate = deferred();
      const { stop, initializeInternal } = stubInitRegistry(config, {
        gate: gate.promise,
      });

      const initialize = config.initialize();
      await vi.waitFor(() => expect(initializeInternal).toHaveBeenCalledOnce());
      let shutdownSettled = false;
      const shutdown = config.shutdown(STRICT_SHUTDOWN).then(() => {
        shutdownSettled = true;
      });

      await nextMacrotask();
      expect(shutdownSettled).toBe(false);
      expect(stop).not.toHaveBeenCalled();

      gate.resolve();
      await expect(initialize).resolves.toBeUndefined();
      await expect(shutdown).resolves.toBeUndefined();
      expect(stop).toHaveBeenCalledOnce();
    });

    it('does not let incomplete initialization block best-effort shutdown', async () => {
      const config = makeConfig();
      const gate = deferred();
      const { stop, initializeInternal } = stubInitRegistry(config, {
        gate: gate.promise,
      });

      const initialize = config.initialize();
      await vi.waitFor(() => expect(initializeInternal).toHaveBeenCalledOnce());

      await expect(config.shutdown(QUIET_SHUTDOWN)).resolves.toBeUndefined();
      expect(stop).not.toHaveBeenCalled();

      gate.resolve();
      await expect(initialize).resolves.toBeUndefined();
      await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    });

    it('keeps strict shutdown waiting when best-effort shutdown starts first', async () => {
      const config = makeConfig();
      const gate = deferred();
      const { stop } = stubInitRegistry(config, { gate: gate.promise });

      const initialize = config.initialize();
      const bestEffortShutdown = config.shutdown(QUIET_SHUTDOWN);
      let strictShutdownSettled = false;
      const strictShutdown = config.shutdown(STRICT_SHUTDOWN).then(() => {
        strictShutdownSettled = true;
      });

      await bestEffortShutdown;
      await nextMacrotask();
      expect(strictShutdownSettled).toBe(false);

      gate.resolve();
      await initialize;
      await strictShutdown;
      expect(stop).toHaveBeenCalledOnce();
    });

    it('runs resource cleanup once across concurrent shutdown calls', async () => {
      const config = makeConfig();
      const { stop } = stubInitRegistry(config);
      await config.initialize();

      await Promise.all([
        config.shutdown(QUIET_SHUTDOWN),
        config.shutdown(QUIET_SHUTDOWN),
      ]);

      expect(stop).toHaveBeenCalledOnce();
    });

    it('aborts active workflows during shutdown', async () => {
      const config = makeConfig();
      stubInitRegistry(config);
      await config.initialize();
      const abortController = new AbortController();
      const registry = config.getWorkflowRunRegistry();
      registry.register({
        runId: 'wf_1234',
        meta: null,
        status: 'running',
        startTime: Date.now(),
        outputFile: '/tmp/wf_1234.jsonl',
        abortController,
      });

      await config.shutdown(STRICT_SHUTDOWN);

      expect(abortController.signal.aborted).toBe(true);
      expect(registry.get('wf_1234')?.status).toBe('cancelled');
    });

    it('allows a later shutdown to retry incomplete resource cleanup', async () => {
      const config = makeConfig();
      const { stop } = stubInitRegistry(config, { stop: failingOnceStop() });
      await config.initialize();

      await config.shutdown(QUIET_SHUTDOWN);
      await config.shutdown(QUIET_SHUTDOWN);

      expect(stop).toHaveBeenCalledTimes(2);
    });

    it('propagates resource cleanup failures in strict mode and allows retry', async () => {
      const config = makeConfig();
      const { stop } = stubInitRegistry(config, { stop: failingOnceStop() });
      await config.initialize();

      await expect(config.shutdown(STRICT_SHUTDOWN)).rejects.toThrow(
        'stop failed',
      );
      await expect(config.shutdown(STRICT_SHUTDOWN)).resolves.toBeUndefined();

      expect(stop).toHaveBeenCalledTimes(2);
    });

    it('cleans partial resources after initialization fails', async () => {
      const config = makeConfig();
      const initializationError = new Error('late initialization failure');
      const { stop } = stubInitRegistry(config, {
        failure: initializationError,
      });

      const result = await config.initialize().catch((error: unknown) => error);
      await config.shutdown(QUIET_SHUTDOWN);

      expect(result).toBe(initializationError);
      expect(stop).toHaveBeenCalledOnce();
    });

    it('closes the writer before waiting for incomplete initialization', async () => {
      const config = makeConfig();
      const gate = deferred();
      const initializeInternal = vi
        .spyOn(internals(config), 'initializeInternal')
        .mockImplementation(() => gate.promise);
      const beginClose = vi.fn();
      const close = vi.fn().mockResolvedValue(undefined);
      const finalize = vi.fn();
      const flush = vi.fn().mockResolvedValue(undefined);
      internals(config).chatRecordingService = {
        beginClose,
        close,
        finalize,
        flush,
      };

      const initialize = config.initialize();
      await vi.waitFor(() => expect(initializeInternal).toHaveBeenCalledOnce());
      const shutdown = config.shutdown({ shutdownTelemetry: false });

      expect(beginClose).toHaveBeenCalledOnce();
      expect(finalize).not.toHaveBeenCalled();
      expect(flush).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());

      gate.resolve();
      await expect(initialize).resolves.toBeUndefined();
      await expect(shutdown).resolves.toBeUndefined();
    });

    it('rejects initialization after shutdown has started', async () => {
      const config = makeConfig();

      await config.shutdown(QUIET_SHUTDOWN);

      await expect(config.initialize()).rejects.toThrow(
        'Config is shutting down',
      );
    });

    it('rejects a pre-aborted initialization without consuming the Config', async () => {
      const config = makeConfig();
      const controller = new AbortController();
      const abortReason = new Error('initialization cancelled before start');
      controller.abort(abortReason);

      await expect(
        config.initialize({ signal: controller.signal }),
      ).rejects.toBe(abortReason);

      const initializeInternal = vi
        .spyOn(internals(config), 'initializeInternal')
        .mockResolvedValue(undefined);
      await expect(config.initialize()).resolves.toBeUndefined();
      expect(initializeInternal).toHaveBeenCalledOnce();
      await config.shutdown({ shutdownTelemetry: false });
    });

    it('forwards cancellation into Gemini client initialization', async () => {
      const config = makeConfig();
      const controller = new AbortController();
      const abortReason = new Error('initialization deadline exceeded');
      const refreshHierarchicalMemory = vi.spyOn(
        config,
        'refreshHierarchicalMemory',
      );
      const geminiEntered = deferred();
      const geminiInitialize = vi
        .spyOn(config.getGeminiClient(), 'initialize')
        .mockImplementation(async (_source, signal) => {
          expect(signal).toBe(controller.signal);
          geminiEntered.resolve();
          await new Promise<void>((_resolve, reject) => {
            if (signal?.aborted) {
              reject(signal.reason);
              return;
            }
            signal?.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          });
        });

      const initialization = config.initialize({ signal: controller.signal });
      await geminiEntered.promise;
      controller.abort(abortReason);

      await expect(initialization).rejects.toBe(abortReason);
      expect(geminiInitialize).toHaveBeenCalledWith(
        undefined,
        controller.signal,
      );
      expect(refreshHierarchicalMemory).toHaveBeenCalledWith(
        'session_start',
        controller.signal,
      );
      await config.shutdown({ shutdownTelemetry: false });
    });

    it('preserves graceful writer finalization after successful initialization', async () => {
      const config = makeConfig();
      vi.spyOn(internals(config), 'initializeInternal').mockResolvedValue(
        undefined,
      );
      await config.initialize();
      const order: string[] = [];
      const log = (step: string) => () => {
        order.push(step);
      };
      internals(config).chatRecordingService = {
        beginClose: vi.fn(log('beginClose')),
        close: vi.fn(async () => log('close')()),
        finalize: vi.fn(log('finalize')),
        flush: vi.fn(async () => log('flush')()),
      };

      await config.shutdown({ shutdownTelemetry: false });

      expect(order).toEqual(['finalize', 'flush', 'beginClose', 'close']);
    });

    const ALREADY_INITIALIZED = 'Config was already initialized';

    it('should throw an error if initialized more than once', async () => {
      const config = makeConfig();

      await expect(config.initialize()).resolves.toBeUndefined();
      await expect(config.initialize()).rejects.toThrow(ALREADY_INITIALIZED);
    });

    it('makes a concurrent caller join the in-flight initialization', async () => {
      const config = makeConfig();
      // The first flight hangs until released, so the second call arrives
      // while initialization is still running and joins it instead of
      // bouncing off the already-set flag.
      const gate = deferred();
      const initializeInternal = vi
        .spyOn(internals(config), 'initializeInternal')
        .mockImplementation(() => gate.promise);

      const first = config.initialize();
      const second = config.initialize();

      // While the first flight is gated the joiner must stay unsettled. A join
      // branch that drops the `await` resolves `second` at once, passes every
      // other assertion here, and reproduces #11002 (the joiner proceeds
      // before initialization completes and dies on "Chat not initialized").
      const settled: string[] = [];
      first.then(() => settled.push('first'));
      second.then(() => settled.push('second'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toEqual([]);

      gate.resolve();
      await Promise.all([first, second]);
      expect(initializeInternal).toHaveBeenCalledOnce();

      await expect(config.initialize()).rejects.toThrow(ALREADY_INITIALIZED);
    });

    it('rejects a joining caller whose signal is already aborted', async () => {
      const config = makeConfig();
      const gate = deferred();
      vi.spyOn(internals(config), 'initializeInternal').mockImplementation(
        () => gate.promise,
      );

      const first = config.initialize();
      const controller = new AbortController();
      const abortReason = new Error('joining caller already aborted');
      controller.abort(abortReason);
      // A joiner's options cannot be honored, so an already-aborted signal
      // fails fast instead of blocking on the first flight. Assert while the
      // gate is held: settling the first flight first would let a guard
      // placed after the `await` reject with the same reason and pass.
      const joining = config.initialize({ signal: controller.signal });
      await expect(joining).rejects.toBe(abortReason);
      gate.resolve();
      await expect(first).resolves.toBeUndefined();
    });

    it('shares a failed in-flight initialization with concurrent callers', async () => {
      const config = makeConfig();
      vi.spyOn(internals(config), 'initializeInternal').mockRejectedValue(
        new Error('startup discovery exploded'),
      );

      const [firstError, secondError] = await Promise.all([
        config.initialize().catch((error: unknown) => error),
        config.initialize().catch((error: unknown) => error),
      ]);
      expect(firstError).toBeInstanceOf(Error);
      expect(secondError).toBe(firstError);

      // A failed-and-settled first flight still flips `initializationSettled`,
      // so a later call must throw rather than re-join the stale rejection.
      await expect(config.initialize()).rejects.toThrow(ALREADY_INITIALIZED);
    });

    it('should skip implicit startup discovery in bare mode', async () => {
      const extensionRefreshSpy = vi
        .spyOn(ExtensionManager.prototype, 'refreshCache')
        .mockResolvedValue(undefined);

      const config = makeConfig({ bareMode: true });

      await expect(config.initialize()).resolves.toBeUndefined();

      expect(extensionRefreshSpy).not.toHaveBeenCalled();
      expect(HookSystem).not.toHaveBeenCalled();
      expect(SkillManager.prototype.startWatching).not.toHaveBeenCalled();
      expect(SkillManager.prototype.refreshCache).toHaveBeenCalledTimes(1);
      expect(ToolRegistry.prototype.discoverAllTools).not.toHaveBeenCalled();
      expect(registeredToolNames()).toEqual([
        ToolNames.READ_FILE,
        ToolNames.EDIT,
        ToolNames.NOTEBOOK_EDIT,
        ToolNames.SHELL,
        ToolNames.GET_GOAL,
        ToolNames.UPDATE_GOAL,
      ]);
    });

    it('should skip hook, skill, and file checkpointing side effects when requested', async () => {
      const config = makeConfig({ fileCheckpointingEnabled: true });

      await expect(
        config.initialize({
          skipMcpDiscovery: true,
          skipHooks: true,
          skipSkillManager: true,
          skipFileCheckpointing: true,
        }),
      ).resolves.toBeUndefined();

      expect(HookSystem).not.toHaveBeenCalled();
      expect(config.getHookSystem()).toBeUndefined();
      expect(SkillManager).not.toHaveBeenCalled();
      expect(config.getSkillManager()).toBeNull();
      expect(config.getFileCheckpointingEnabled()).toBe(false);
    });

    it('installs a managed dispatcher while ambient Hook discovery is disabled', async () => {
      const config = new Config({ ...baseParams });
      const dispatcher = {
        hasHooksForEvent: () => false,
        execute: vi.fn(),
      };
      await config.initialize({
        skipHooks: true,
        skipMcpDiscovery: true,
        skipSkillManager: true,
        managedHookDispatcher: dispatcher,
      });
      expect(HookSystem).toHaveBeenCalledWith(config, dispatcher);
      expect(config.getHookSystem()).toBeDefined();
    });

    it('warms tools strictly by default and leniently when lenientToolWarmup is set', async () => {
      // Regression guard for the read-only transcript-replay path: a Config
      // that skips the SkillManager must warm tools leniently, or warmAll()
      // aborts initialize() when SkillTool's constructor throws.
      const warmAll = vi.mocked(ToolRegistry.prototype.warmAll);

      warmAll.mockClear();
      await makeConfig().initialize();
      expect(warmAll).toHaveBeenLastCalledWith({ strict: true });

      warmAll.mockClear();
      await makeConfig().initialize({
        skipSkillManager: true,
        lenientToolWarmup: true,
      });
      expect(warmAll).toHaveBeenLastCalledWith({ strict: false });
    });

    it('defers cwd-sensitive initialization for a provisional workspace', async () => {
      const config = makeConfig({ provisionalWorkspace: true });
      const llmClient = vi.mocked(LlmClient).mock.results.at(-1)?.value as
        | { initialize: Mock }
        | undefined;
      const warmAll = vi.mocked(ToolRegistry.prototype.warmAll);

      await config.initialize();

      expect(config.isProvisionalWorkspace()).toBe(true);
      expect(loadServerHierarchicalMemory).not.toHaveBeenCalled();
      expect(maybeRunAutoSkillCurator).not.toHaveBeenCalled();
      expect(warmAll).not.toHaveBeenCalled();
      expect(llmClient?.initialize).not.toHaveBeenCalled();

      await Promise.all([
        config.activateProvisionalWorkspace(),
        config.activateProvisionalWorkspace(),
      ]);

      expect(llmClient?.initialize).toHaveBeenCalledOnce();
      expect(warmAll).toHaveBeenCalledOnce();
      expect(warmAll).toHaveBeenCalledWith({ strict: true });
    });

    const USER_INTERACTION_TOOLS = [
      ToolNames.ASK_USER_QUESTION,
      ToolNames.ENTER_PLAN_MODE,
      ToolNames.EXIT_PLAN_MODE,
    ];
    const PLAN_TOOLS = [ToolNames.ENTER_PLAN_MODE, ToolNames.EXIT_PLAN_MODE];
    const GOAL_WORKER_TOOLS = [ToolNames.GET_GOAL, ToolNames.UPDATE_GOAL];
    const ARTIFACT_TOOLS = [ToolNames.ARTIFACT, ToolNames.RECORD_ARTIFACT];
    const HEADLESS = {
      interactive: false,
      experimentalZedIntegration: false,
      inputFormat: InputFormat.TEXT,
    };
    const DAEMON = { interactive: false, sdkMode: false };

    // SDK mode with interaction support: ask_user_question is gated only by
    // the resolved interaction mode, while enter_plan_mode/exit_plan_mode are
    // additionally gated by !sdkMode. Guard this asymmetry so a future
    // symmetric `!this.sdkMode` on the question gate cannot silently drop the
    // tool from SDK-mode interactive sessions.
    it.each`
      title                                                                                               | params                                                         | has                                               | lacks
      ${'registers loop_wakeup when cron is enabled'}                                                     | ${{ cronEnabled: true }}                                       | ${[ToolNames.LOOP_WAKEUP]}                        | ${[]}
      ${'does not register loop_wakeup when cron is disabled'}                                            | ${{ cronEnabled: false }}                                      | ${[]}                                             | ${[ToolNames.LOOP_WAKEUP]}
      ${'registers read_mcp_resource so the model can read MCP resources'}                                | ${{}}                                                          | ${[ToolNames.READ_MCP_RESOURCE]}                  | ${[]}
      ${'registers user-interaction tools in interactive sessions'}                                       | ${{ interactive: true }}                                       | ${USER_INTERACTION_TOOLS}                         | ${[]}
      ${'registers user-interaction tools in ACP sessions'}                                               | ${{ experimentalZedIntegration: true }}                        | ${USER_INTERACTION_TOOLS}                         | ${[]}
      ${'registers user-interaction tools in stream-json sessions'}                                       | ${{ inputFormat: InputFormat.STREAM_JSON }}                    | ${USER_INTERACTION_TOOLS}                         | ${[]}
      ${'registers ask_user_question but not plan tools in SDK mode with interaction support'}            | ${{ interactive: true, sdkMode: true }}                        | ${[ToolNames.ASK_USER_QUESTION]}                  | ${PLAN_TOOLS}
      ${'registers propose_goal beside the Goal worker tools in interactive sessions'}                    | ${{ interactive: true }}                                       | ${[...GOAL_WORKER_TOOLS, ToolNames.PROPOSE_GOAL]} | ${[]}
      ${'does not register propose_goal without a turn-boundary settlement path in ACP sessions'}         | ${{ experimentalZedIntegration: true, interactive: true }}     | ${GOAL_WORKER_TOOLS}                              | ${[ToolNames.PROPOSE_GOAL]}
      ${'does not register propose_goal without a turn-boundary settlement path in stream-json sessions'} | ${{ inputFormat: InputFormat.STREAM_JSON, interactive: true }} | ${GOAL_WORKER_TOOLS}                              | ${[ToolNames.PROPOSE_GOAL]}
      ${'does not register user-interaction tools in plain headless sessions'}                            | ${HEADLESS}                                                    | ${[]}                                             | ${USER_INTERACTION_TOOLS}
      ${'does not register artifact tools when artifacts are disabled'}                                   | ${{ artifactEnabled: false }}                                  | ${[]}                                             | ${ARTIFACT_TOOLS}
      ${'registers both artifact tools by default for interactive sessions'}                              | ${{ interactive: true, sdkMode: false }}                       | ${ARTIFACT_TOOLS}                                 | ${[]}
      ${'registers only record_artifact by default for daemon artifact metadata'}                         | ${DAEMON}                                                      | ${[ToolNames.RECORD_ARTIFACT]}                    | ${[ToolNames.ARTIFACT]}
      ${'registers report_findings even in headless sessions — review run depends on it'}                 | ${DAEMON}                                                      | ${[ToolNames.REPORT_FINDINGS]}                    | ${[]}
    `('%s', async ({ params, has, lacks }) => {
      await makeConfig(params).initialize();
      expectTools(registeredToolNames(), has, lacks);
    });

    it.each(['alwaysAsk', 'disabled'] as const)(
      'honors %s for an ACP host with explicit Goal proposal support',
      async (modelProposedGoals) => {
        const config = makeConfig({
          experimentalZedIntegration: true,
          modelProposedGoals,
        });
        config.setGoalProposalHostSupported(true);
        await config.initialize();
        expect(registeredToolNames().includes(ToolNames.PROPOSE_GOAL)).toBe(
          modelProposedGoals === 'alwaysAsk',
        );
      },
    );

    it.each([
      [
        'does not register propose_goal when goals.modelProposed is disabled',
        { interactive: true, modelProposedGoals: 'disabled' as const },
        'disabled',
      ],
      [
        'does not register propose_goal in plain headless sessions',
        HEADLESS,
        'alwaysAsk',
      ],
    ])('%s', async (_title, params, proposedGoals) => {
      const config = await initConfig(params);

      expect(config.getModelProposedGoals()).toBe(proposedGoals);
      expect(registeredToolNames()).toContain(ToolNames.GET_GOAL);
      expect(registeredToolNames()).not.toContain(ToolNames.PROPOSE_GOAL);
    });

    it('keeps exit_plan_mode available for plan-required teammate filtering', async () => {
      const config = await initConfig(HEADLESS);
      vi.mocked(ToolRegistry.prototype.registerFactory).mockClear();

      await rebuildForSubAgent(config);

      const registeredNames = registeredToolNames();
      expect(registeredNames).not.toContain(ToolNames.ASK_USER_QUESTION);
      expect(registeredNames).not.toContain(ToolNames.ENTER_PLAN_MODE);
      expect(registeredNames).toContain(ToolNames.EXIT_PLAN_MODE);
    });

    const advisorFactory = [ToolNames.ADVISOR, expect.any(Function)] as const;

    it('registers and removes Advisor with the runtime model setting', async () => {
      const config = await initConfig();
      const setTools = vi.fn().mockResolvedValue(undefined);
      internals(config).llmClient = { setTools };
      const registry = config.getToolRegistry();

      await config.setAdvisorModel('advisor-model');

      expect(config.getAdvisorModel()).toBe('advisor-model');
      expect(registry.unregisterTool).toHaveBeenCalledWith(ToolNames.ADVISOR);
      expect(registry.registerFactory).toHaveBeenCalledWith(...advisorFactory);
      expect(setTools).toHaveBeenCalledTimes(1);

      await config.setAdvisorModel('off');

      expect(config.getAdvisorModel()).toBeUndefined();
      expect(registry.unregisterTool).toHaveBeenLastCalledWith(
        ToolNames.ADVISOR,
      );
      expect(setTools).toHaveBeenCalledTimes(2);
    });

    it('does not disturb Advisor registration while the tool is disabled', async () => {
      const config = await initConfig({ disabledTools: [ToolNames.ADVISOR] });
      const registry = config.getToolRegistry();
      vi.mocked(registry.unregisterTool).mockClear();
      vi.mocked(registry.registerFactory).mockClear();

      const applied = await config.setAdvisorModel('advisor-model');

      expect(applied).toBe(false);
      expect(config.getAdvisorModel()).toBeUndefined();
      expect(registry.unregisterTool).not.toHaveBeenCalled();
      expect(registry.registerFactory).not.toHaveBeenCalled();
    });

    it('does not register Advisor in safe mode', async () => {
      await initConfig({ advisorModel: 'advisor-model', safeMode: true });

      expect(ToolRegistry.prototype.registerFactory).not.toHaveBeenCalledWith(
        ...advisorFactory,
      );
    });

    it('shares the Advisor limit across derived configs and does not reset on toggle', async () => {
      const config = new Config({
        ...baseParams,
        advisorModel: 'advisor-model',
        advisorMaxUses: 1,
      });
      const child = Object.create(config) as Config;
      expect(child.tryConsumeAdvisorUse()).toBe(true);
      expect(config.tryConsumeAdvisorUse()).toBe(false);
      await config.setAdvisorModel('off');
      await config.setAdvisorModel('advisor-model');
      expect(config.tryConsumeAdvisorUse()).toBe(false);
      expect(config.getAdvisorUseCount()).toBe(1);
    });

    it('treats an Advisor limit of 0 as unlimited', () => {
      const config = new Config({
        ...baseParams,
        advisorModel: 'advisor-model',
        advisorMaxUses: 0,
      });
      for (let i = 0; i < 3; i++) {
        expect(config.tryConsumeAdvisorUse()).toBe(true);
      }
      expect(config.getAdvisorUseCount()).toBe(3);
    });

    it('resets the Advisor count when a new session starts', () => {
      const config = new Config({
        ...baseParams,
        advisorModel: 'advisor-model',
        advisorMaxUses: 1,
      });
      expect(config.tryConsumeAdvisorUse()).toBe(true);
      expect(config.tryConsumeAdvisorUse()).toBe(false);
      config.startNewSession('next-advisor-session');
      expect(config.getAdvisorUseCount()).toBe(0);
      expect(config.tryConsumeAdvisorUse()).toBe(true);
    });

    it('registers configured Advisor for ordinary subagent registries', async () => {
      const config = new Config({
        ...baseParams,
        advisorModel: 'advisor-model',
      });
      await config.createToolRegistry(undefined, {
        skipDiscovery: true,
        forSubAgent: true,
      });
      expect(ToolRegistry.prototype.registerFactory).toHaveBeenCalledWith(
        ToolNames.ADVISOR,
        expect.any(Function),
      );
    });

    it.each([-1, 1.5, NaN, Infinity, '5'])(
      'falls back to unlimited for invalid Advisor limit %s',
      (advisorMaxUses) => {
        const config = new Config({
          ...baseParams,
          advisorMaxUses: advisorMaxUses as number,
        });
        expect(config.getAdvisorMaxUses()).toBe(0);
      },
    );

    it('defers Advisor when tools.eager omits it', async () => {
      const config = await initConfig({
        advisorModel: 'advisor-model',
        eagerTools: [],
      });
      const registry = config.getToolRegistry();
      expect(registry.registerPermissionDeferredFactory).toHaveBeenCalledWith(
        ...advisorFactory,
      );
      expect(registry.registerFactory).not.toHaveBeenCalledWith(
        ...advisorFactory,
      );
      expect(registry.ensureTool).toHaveBeenCalledWith(ToolNames.ADVISOR);
      await config.setAdvisorModel('off');
      expect(registry.unregisterTool).toHaveBeenLastCalledWith(
        ToolNames.ADVISOR,
      );
    });

    const IMAGE_URL = 'https://images.example.com/api/v1';
    const IMAGE_KEY = 'TEST_IMAGE_GENERATION_KEY';
    /** An openai route at IMAGE_URL keyed by IMAGE_KEY, plus `extra`. */
    const imageRoute = (id: string, extra: Partial<ModelRoute> = {}) => ({
      id,
      baseUrl: IMAGE_URL,
      envKey: IMAGE_KEY,
      ...extra,
    });
    const openaiRoutes = (...openai: Array<Partial<ModelRoute>>) => ({
      modelProvidersConfig: { openai } as ModelProviders,
    });
    /** modelProviders with a single openai image-only route at IMAGE_URL. */
    const qwenImageProviders = () =>
      openaiRoutes(imageRoute('qwen-image-2.0', { imageOnly: true }));
    const QWEN_IMAGE_SELECTION = `openai:qwen-image-2.0\0${IMAGE_URL}`;
    /** The image generation config resolved for `model` at IMAGE_URL. */
    const imageConfig = (model: string) => ({
      model,
      baseUrl: IMAGE_URL,
      apiKeyEnv: IMAGE_KEY,
    });
    const dualRole = { supportsImageGeneration: true };

    it('registers image_gen when a dual-role model is selected', async () => {
      const config = await initConfig({
        authType: AuthType.USE_OPENAI,
        model: 'dual-role-model',
        ...openaiRoutes(imageRoute('dual-role-model', dualRole)),
        imageModel: `openai:dual-role-model\0${IMAGE_URL}`,
      });

      expect(registeredToolNames()).toContain(ToolNames.IMAGE_GEN);
      expect(config.getModel()).toBe('dual-role-model');
      expect(config.getImageGenerationConfig()).toEqual(
        imageConfig('dual-role-model'),
      );
    });

    it('registers image_gen for a legacy image-and-vision-only route', async () => {
      const config = await initConfig({
        ...openaiRoutes(
          imageRoute('qwen-image-2.0', { imageOnly: true, visionOnly: true }),
        ),
        imageModel: QWEN_IMAGE_SELECTION,
      });

      expect(registeredToolNames()).toContain(ToolNames.IMAGE_GEN);
      expect(config.getImageGenerationConfig()).toEqual(
        imageConfig('qwen-image-2.0'),
      );
    });

    it('does not register image_gen without an image model selection', async () => {
      await initConfig(qwenImageProviders());

      expect(registeredToolNames()).not.toContain(ToolNames.IMAGE_GEN);
    });

    it('does not use a protocol default as the image generation endpoint', () => {
      const config = makeConfig({
        ...openaiRoutes({
          id: 'qwen-image-2.0',
          envKey: IMAGE_KEY,
          imageOnly: true,
        }),
        imageModel: 'openai:qwen-image-2.0',
      });

      expect(config.getImageGenerationConfig()).toBeUndefined();
    });

    it('rejects a route without image generation capability', () => {
      const config = makeConfig(openaiRoutes(imageRoute('chat-model')));

      expect(
        config.resolveImageGenerationModel(`openai:chat-model\0${IMAGE_URL}`),
      ).toBeUndefined();
    });

    it('resolves a vision-only image generation route with explicit capability', () => {
      const config = makeConfig(
        openaiRoutes(
          imageRoute('vision-only-model', { visionOnly: true, ...dualRole }),
        ),
      );

      expect(
        config.resolveImageGenerationModel(
          `openai:vision-only-model\0${IMAGE_URL}`,
        ),
      ).toEqual(imageConfig('vision-only-model'));
    });

    it('rejects an image generation route without an environment key', () => {
      const config = makeConfig(
        openaiRoutes({
          id: 'dual-role-model',
          baseUrl: IMAGE_URL,
          supportsImageGeneration: true,
        }),
      );

      expect(
        config.resolveImageGenerationModel(
          `openai:dual-role-model\0${IMAGE_URL}`,
        ),
      ).toBeUndefined();
    });

    it('rejects an ambiguous image generation route', () => {
      const config = makeConfig(
        openaiRoutes(
          ...['a', 'b'].map((host) =>
            imageRoute('dual-role-model', {
              baseUrl: `https://images-${host}.example.com/api/v1`,
              ...dualRole,
            }),
          ),
        ),
      );

      expect(
        config.resolveImageGenerationModel('openai:dual-role-model'),
      ).toBeUndefined();
    });

    it('retains an image selection while the tool registry is still initializing', async () => {
      const config = makeConfig(qwenImageProviders());
      const registryGate = deferred<ToolRegistry>();
      const createRegistry = vi
        .spyOn(config, 'createToolRegistry')
        .mockReturnValue(registryGate.promise);
      const initializing = config.initialize();
      await vi.waitFor(() => expect(createRegistry).toHaveBeenCalled());
      try {
        await expect(
          config.setImageModel(QWEN_IMAGE_SELECTION),
        ).resolves.toBeUndefined();
      } finally {
        registryGate.resolve(new ToolRegistry(config));
        await initializing;
      }
      expect(config.getImageGenerationConfig()).toMatchObject({
        model: 'qwen-image-2.0',
        baseUrl: IMAGE_URL,
      });
      await config.setImageModel(QWEN_IMAGE_SELECTION);
      expect(ToolRegistry.prototype.ensureTool).toHaveBeenCalledWith(
        ToolNames.IMAGE_GEN,
      );
    });

    it('registers image_gen immediately when the image model changes at runtime', async () => {
      const config = await initConfig(qwenImageProviders());
      vi.mocked(ToolRegistry.prototype.registerFactory).mockClear();

      const refreshTools = vi
        .spyOn(config.getLlmClient(), 'setTools')
        .mockResolvedValue(undefined);
      await config.setImageModel(QWEN_IMAGE_SELECTION);

      expect(ToolRegistry.prototype.registerFactory).toHaveBeenCalledWith(
        ToolNames.IMAGE_GEN,
        expect.any(Function),
      );
      expect(ToolRegistry.prototype.ensureTool).toHaveBeenCalledWith(
        ToolNames.IMAGE_GEN,
      );
      expect(refreshTools).toHaveBeenCalledOnce();
      await config.setImageModel('');
      expect(config.isImageGenerationEnabled()).toBe(false);
      expect(refreshTools).toHaveBeenCalledTimes(2);
    });

    it('does not register image_gen when the permission manager disables it', async () => {
      const config = await initConfig(qwenImageProviders());
      vi.mocked(ToolRegistry.prototype.registerFactory).mockClear();
      internals(config).permissionManager = {
        isToolEnabled: vi.fn().mockResolvedValue(false),
      };

      await config.setImageModel(QWEN_IMAGE_SELECTION);

      expect(ToolRegistry.prototype.registerFactory).not.toHaveBeenCalledWith(
        ToolNames.IMAGE_GEN,
        expect.any(Function),
      );
    });

    it.each([true, false])(
      'registers saved-page publishing only for recorded managed sessions (%s)',
      async (chatRecording) => {
        const config = makeConfig({
          interactive: false,
          sdkMode: false,
          chatRecording,
        });
        config.setArtifactSnapshotsEnabled(true);
        await config.initialize();
        expect(registeredToolNames().includes(ToolNames.ARTIFACT)).toBe(
          chatRecording,
        );
        if (chatRecording) expect(config.shouldAutoOpenArtifact()).toBe(false);
      },
    );

    it('registers display_image only for the main interactive TUI', async () => {
      const interactive = await initConfig({
        interactive: true,
        sdkMode: false,
      });
      const registerToolMock = vi.mocked(
        ToolRegistry.prototype.registerFactory,
      );
      expect(registeredToolNames()).toContain(ToolNames.DISPLAY_IMAGE);

      const tui = { interactive: true, sdkMode: false };
      for (const params of [
        { interactive: false, sdkMode: false },
        { interactive: true, sdkMode: true },
        { ...tui, inputFormat: InputFormat.STREAM_JSON },
        { ...tui, accessibility: { screenReader: true } },
      ]) {
        registerToolMock.mockClear();
        await makeConfig(params).initialize();
        expect(registeredToolNames()).not.toContain(ToolNames.DISPLAY_IMAGE);
      }

      registerToolMock.mockClear();
      await rebuildForSubAgent(interactive);
      expect(registeredToolNames()).not.toContain(ToolNames.DISPLAY_IMAGE);
    });

    it('forwards terminal image renderer support to the display tool', async () => {
      const unavailable = (reason: string) => ({ available: false, reason });
      const provider = vi
        .fn()
        .mockResolvedValue(unavailable('renderer unavailable'));
      const config = makeConfig({
        terminalImageRenderSupportProvider: provider,
      });

      await expect(config.getTerminalImageRenderSupport()).resolves.toEqual(
        unavailable('renderer unavailable'),
      );
      expect(provider).toHaveBeenCalledWith();

      await expect(
        makeConfig().getTerminalImageRenderSupport(),
      ).resolves.toEqual(
        unavailable('No terminal image renderer is configured.'),
      );
    });

    describe('bundled review workflow activation', () => {
      beforeEach(() => {
        vi.stubEnv('QWEN_CODE_ENABLE_WORKFLOWS', undefined);
        vi.stubEnv('QWEN_CODE_DISABLE_WORKFLOWS', undefined);
      });
      afterEach(() => vi.unstubAllEnvs());
      /** An initialized Config whose registry lists only the workflow tool. */
      const workflowConfig = async (params: Partial<ConfigParameters> = {}) => {
        const config = await initConfig(params);
        vi.spyOn(config.getToolRegistry(), 'getAllToolNames').mockReturnValue([
          ToolNames.WORKFLOW,
        ]);
        return config;
      };

      it.each([undefined, false, true])(
        'preserves the configured workflow preference %s on review activation',
        async (workflowsEnabled) => {
          const config = await workflowConfig({ workflowsEnabled });
          const getRegistry = vi.spyOn(config, 'getToolRegistry');
          const refresh = vi.spyOn(config.getLlmClient(), 'setTools');
          await config.enableReviewWorkflow();
          const activations = workflowsEnabled === false ? 0 : 1;
          expect(config.isWorkflowsEnabled()).toBe(workflowsEnabled !== false);
          expect(getRegistry).toHaveBeenCalledTimes(activations);
          expect(refresh).toHaveBeenCalledTimes(activations);
        },
      );

      it('restores review auto-activation when an explicit opt-out is removed', async () => {
        const config = await workflowConfig({ workflowsEnabled: false });
        config.setWorkflowsEnabled(undefined);
        expect(config.isWorkflowsEnabled()).toBe(false);
        await config.enableReviewWorkflow();
        expect(config.isWorkflowsEnabled()).toBe(true);
      });

      it.each(['registered', 'deferred', 'disabled'] as const)(
        'uses the existing registry with %s permissions',
        async (status) => {
          const config = await initConfig();
          const registry = config.getToolRegistry();
          const names = new Set<string>();
          vi.spyOn(registry, 'getAllToolNames').mockImplementation(() => [
            ...names,
          ]);
          const record = (name: string) => {
            names.add(name);
          };
          const eager = vi
            .spyOn(registry, 'registerFactory')
            .mockImplementation(record);
          const deferred = vi
            .spyOn(registry, 'registerPermissionDeferredFactory')
            .mockImplementation(record);
          eager.mockClear();
          deferred.mockClear();
          vi.spyOn(
            config.getPermissionManager()!,
            'getToolRegistrationStatus',
          ).mockResolvedValue(status);
          const expectRegistrations = () => {
            expect(eager).toHaveBeenCalledTimes(
              status === 'registered' ? 1 : 0,
            );
            expect(deferred).toHaveBeenCalledTimes(
              status === 'deferred' ? 1 : 0,
            );
          };
          expect(config.isWorkflowsEnabled()).toBe(false);
          await config.enableReviewWorkflow();
          expect(config.getToolRegistry()).toBe(registry);
          expectRegistrations();
          expect(config.isWorkflowsEnabled()).toBe(status !== 'disabled');
          await config.enableReviewWorkflow();
          expectRegistrations();
        },
      );

      it('waits for the live chat tool declarations to refresh', async () => {
        const config = makeConfig();
        await config.initialize();
        vi.spyOn(config.getToolRegistry(), 'getAllToolNames').mockReturnValue([
          ToolNames.WORKFLOW,
        ]);
        const refresh = deferred();
        const setTools = vi
          .spyOn(config.getLlmClient(), 'setTools')
          .mockReturnValue(refresh.promise);
        let completed = false;
        const activation = config.enableReviewWorkflow().then(() => {
          completed = true;
        });
        await vi.waitFor(() => expect(setTools).toHaveBeenCalledOnce());
        expect(completed).toBe(false);
        refresh.resolve();
        await activation;
        expect(completed).toBe(true);
      });

      it.each([{ bareMode: true }, { provisionalWorkspace: true }])(
        'keeps restricted sessions disabled: %j',
        async (restriction) => {
          const config = makeConfig({ ...restriction });
          const registration = vi.spyOn(config, 'getPermissionManager');
          await config.enableReviewWorkflow();
          expect(config.isWorkflowsEnabled()).toBe(false);
          expect(registration).not.toHaveBeenCalled();
        },
      );

      it('does not activate workflows or refresh the parent chat from a subagent', async () => {
        const config = makeConfig();
        const registry = vi.spyOn(config, 'getToolRegistry');
        const refresh = vi.spyOn(config.getLlmClient(), 'setTools');
        await runWithAgentContext('review-child', () =>
          config.enableReviewWorkflow(),
        );
        expect(registry).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
        expect(config.isWorkflowsEnabled()).toBe(false);
      });

      it('honors the explicit workflow kill switch before registering', async () => {
        const config = makeConfig();
        vi.stubEnv('QWEN_CODE_DISABLE_WORKFLOWS', '1');
        const registration = vi.spyOn(config, 'getPermissionManager');
        await config.enableReviewWorkflow();
        expect(config.isWorkflowsEnabled()).toBe(false);
        expect(registration).not.toHaveBeenCalled();
      });
    });

    /** The session source service factory the CLI would wire for `config`. */
    const sourceServiceFactory = async (config: Config) => {
      const { SessionSourceService } = await import(
        '../services/session-sources.js'
      );
      return () =>
        new SessionSourceService({
          sessionId: config.getSessionId(),
          workspaceCwd: () => config.getTargetDir(),
          load: async () => ({}),
          persist: async () => undefined,
        });
    };
    it('binds record_source only for a supported top-level session and refreshes it after session rotation', async () => {
      const config = makeConfig(DAEMON);
      const factory = vi.fn(await sourceServiceFactory(config));
      config.setSessionSourceServiceFactory(factory);
      const original = config.getSessionSourceService();
      await config.initialize();
      expect(registeredToolNames()).toContain(ToolNames.RECORD_SOURCE);
      const child = Object.create(config) as Config;
      expect(child.getSessionSourceService()).toBeUndefined();
      config.startNewSession('replacement-source-session');
      expect(factory).toHaveBeenCalledTimes(2);
      expect(config.getSessionSourceService()).not.toBe(original);
    });

    it.each(['registered', 'deferred', 'disabled'] as const)(
      'registers a source tool bound after initialization with %s permissions',
      async (status) => {
        const config = await initConfig({ sdkMode: false });
        const existingRegistry = config.getToolRegistry();
        vi.mocked(ToolRegistry.prototype.registerFactory).mockClear();
        vi.mocked(
          ToolRegistry.prototype.registerPermissionDeferredFactory,
        ).mockClear();
        vi.spyOn(
          config.getPermissionManager()!,
          'getToolRegistrationStatus',
        ).mockResolvedValue(status);
        config.setSessionSourceServiceFactory(
          await sourceServiceFactory(config),
        );
        await config.registerSessionSourceTool();
        expect(config.getToolRegistry()).toBe(existingRegistry);
        expect(registeredToolNames().includes(ToolNames.RECORD_SOURCE)).toBe(
          status === 'registered',
        );
        expect(deferredToolNames().includes(ToolNames.RECORD_SOURCE)).toBe(
          status === 'deferred',
        );
      },
    );

    it('does not register record_source without a bound service or in SDK sessions', async () => {
      for (const sdkMode of [false, true]) {
        vi.mocked(ToolRegistry.prototype.registerFactory).mockClear();
        const config = makeConfig({ interactive: false, sdkMode });
        if (sdkMode) {
          config.setSessionSourceServiceFactory(
            await sourceServiceFactory(config),
          );
        }
        await config.initialize();
        expect(registeredToolNames()).not.toContain(ToolNames.RECORD_SOURCE);
      }
    });

    it('enables historical artifact snapshots only when a managed caller opts in', () => {
      const config = recordingConfig();
      expect(config.isArtifactSnapshotsEnabled()).toBe(false);
      config.setArtifactSnapshotsEnabled(true);
      expect(config.isArtifactSnapshotsEnabled()).toBe(true);
      const unrecorded = makeConfig({ chatRecording: false });
      unrecorded.setArtifactSnapshotsEnabled(true);
      expect(unrecorded.isArtifactSnapshotsEnabled()).toBe(false);
    });

    describe('isArtifactEnabled', () => {
      const restoreEnv = stashEnv(
        'QWEN_CODE_ENABLE_ARTIFACT',
        'QWEN_CODE_DISABLE_ARTIFACT',
      );
      beforeEach(() => {
        delete process.env['QWEN_CODE_ENABLE_ARTIFACT'];
        delete process.env['QWEN_CODE_DISABLE_ARTIFACT'];
      });
      afterEach(restoreEnv);

      const interactiveCli = { interactive: true, sdkMode: false };
      // `record` is the expected isRecordArtifactEnabled(), where asserted.
      it.each`
        title                                                                              | env                                                                    | params                                           | artifact | record
        ${'enables metadata recording by default without publishing from daemon sessions'} | ${{}}                                                                  | ${{}}                                            | ${false} | ${true}
        ${'is enabled by default when interactive and not in SDK mode'}                    | ${{}}                                                                  | ${interactiveCli}                                | ${true}  | ${undefined}
        ${'honors settings that disable artifacts'}                                        | ${{}}                                                                  | ${{ ...interactiveCli, artifactEnabled: false }} | ${false} | ${false}
        ${'lets QWEN_CODE_DISABLE_ARTIFACT override settings and env enablement'}          | ${{ QWEN_CODE_DISABLE_ARTIFACT: '1', QWEN_CODE_ENABLE_ARTIFACT: '1' }} | ${{ ...interactiveCli, artifactEnabled: true }}  | ${false} | ${undefined}
        ${'stays disabled in SDK mode even when force-enabled'}                            | ${{ QWEN_CODE_ENABLE_ARTIFACT: '1' }}                                  | ${{ interactive: true, sdkMode: true }}          | ${false} | ${undefined}
        ${'keeps the Artifact tool disabled for daemon CLI env enablement'}                | ${{ QWEN_CODE_ENABLE_ARTIFACT: '1' }}                                  | ${DAEMON}                                        | ${false} | ${true}
        ${'lets daemon sessions record metadata by default without publishing'}            | ${{}}                                                                  | ${DAEMON}                                        | ${false} | ${true}
        ${'lets QWEN_CODE_ENABLE_ARTIFACT force-enable interactive CLI use'}               | ${{ QWEN_CODE_ENABLE_ARTIFACT: '1' }}                                  | ${{ ...interactiveCli, artifactEnabled: false }} | ${true}  | ${undefined}
      `('%s', ({ env, params, artifact, record }) => {
        Object.assign(process.env, env);
        const config = makeConfig(params);
        expect(config.isArtifactEnabled()).toBe(artifact);
        if (record !== undefined) {
          expect(config.isRecordArtifactEnabled()).toBe(record);
        }
      });
    });

    describe('shouldAutoOpenArtifact', () => {
      const browserEnvKeys = [
        'QWEN_ARTIFACT_NO_AUTO_OPEN',
        'BROWSER',
        'CI',
        'DEBIAN_FRONTEND',
        'SSH_CONNECTION',
        'DISPLAY',
        'WAYLAND_DISPLAY',
        'MIR_SOCKET',
      ];
      const restoreEnv = stashEnv(...browserEnvKeys);
      beforeEach(() => {
        for (const key of browserEnvKeys) delete process.env[key];
        process.env['DISPLAY'] = ':0';
      });
      afterEach(restoreEnv);

      it.each`
        title                                                  | env                                    | params                                         | expected
        ${'auto-opens artifacts by default'}                   | ${{}}                                  | ${{}}                                          | ${true}
        ${'honors artifact.autoOpen=false from settings'}      | ${{}}                                  | ${{ artifactAutoOpen: false }}                 | ${false}
        ${'lets QWEN_ARTIFACT_NO_AUTO_OPEN override settings'} | ${{ QWEN_ARTIFACT_NO_AUTO_OPEN: '1' }} | ${{ artifactAutoOpen: true }}                  | ${false}
        ${'honors global browser launch suppression'}          | ${{}}                                  | ${{ artifactAutoOpen: true, noBrowser: true }} | ${false}
        ${'honors CI browser launch suppression'}              | ${{ CI: 'true' }}                      | ${{ artifactAutoOpen: true }}                  | ${false}
      `('%s', ({ env, params, expected }) => {
        Object.assign(process.env, env);
        expect(makeConfig(params).shouldAutoOpenArtifact()).toBe(expected);
      });
    });

    it('skips inline MCP discovery by default (progressive availability)', async () => {
      // The default path passes `skipDiscovery: true` to createToolRegistry,
      // so the synchronous registry construction must NOT invoke
      // discoverAllTools; MCP starts in the background instead.
      await initConfig();
      expect(ToolRegistry.prototype.discoverAllTools).not.toHaveBeenCalled();
    });

    it('honors QWEN_CODE_LEGACY_MCP_BLOCKING=1 by running MCP discovery inline', async () => {
      const restoreEnv = stashEnv('QWEN_CODE_LEGACY_MCP_BLOCKING');
      process.env['QWEN_CODE_LEGACY_MCP_BLOCKING'] = '1';
      try {
        await initConfig();

        // Legacy escape hatch: calls back into the synchronous discover path
        // the cli relied on prior to PR-A.
        expect(ToolRegistry.prototype.discoverAllTools).toHaveBeenCalledTimes(
          1,
        );
      } finally {
        restoreEnv();
      }
    });

    it('waitForMcpReady resolves immediately when no MCP discovery was started', async () => {
      // No MCP servers + non-bare + default mode: startMcpDiscoveryInBackground
      // runs but the registry mock returns no manager, so the discovery
      // promise stays undefined and waitForMcpReady is a no-op.
      const config = await initConfig();
      await expect(config.waitForMcpReady()).resolves.toBeUndefined();
    });

    it('getFailedMcpServerNames returns an empty array when no MCP servers are configured', () => {
      // It backs the non-interactive "Warning: MCP server(s) failed to start";
      // with nothing to warn about it must be empty, or every --prompt run
      // without MCP config would emit a spurious warning.
      expect(makeConfig().getFailedMcpServerNames()).toEqual([]);
    });

    it('getFailedMcpServerNames skips disabled servers', () => {
      // A user-disabled server (tracked via `excludedMcpServers`, see
      // `isMcpServerDisabled`) is not "failed"; treating it so would add
      // noise to every non-interactive run.
      const config = makeConfig({
        mcpServers: { off: new MCPServerConfig() },
        excludedMcpServers: ['off'],
      });
      expect(config.getFailedMcpServerNames()).toEqual([]);
    });

    it('isMcpServerDisabled consults extension preferences only for the contributing extension', () => {
      const config = makeConfig({
        // baseParams pins overrideExtensions to []; lift it so the mocked
        // loaded extension is visible to getActiveExtensions().
        overrideExtensions: undefined,
        // A user-configured server that shadows the extension's same-named one.
        mcpServers: { foo: new MCPServerConfig() },
      });
      const manager = config.getExtensionManager();
      vi.spyOn(manager, 'getLoadedExtensions').mockReturnValue([
        {
          name: 'my-ext',
          isActive: true,
          config: { name: 'my-ext', mcpServers: { bar: {}, foo: {} } },
        } as unknown as ReturnType<typeof manager.getLoadedExtensions>[number],
      ]);
      vi.spyOn(manager, 'getDisabledMcpServers').mockImplementation(
        (extensionName: string) =>
          extensionName === 'my-ext' ? ['bar', 'foo'] : [],
      );
      // `bar` is contributed by the extension and disabled in its preferences.
      expect(config.isMcpServerDisabled('bar')).toBe(true);
      // `foo` is shadowed by the user config (no extensionName on the merged
      // entry), so the extension's disable record must not affect it.
      expect(config.isMcpServerDisabled('foo')).toBe(false);
      // The global exclusion list still applies to anything.
      config.setExcludedMcpServers(['foo']);
      expect(config.isMcpServerDisabled('foo')).toBe(true);
    });

    it('getFailedMcpServerNames skips pending approval servers', () => {
      const config = makeConfig({
        mcpServers: { pending: new MCPServerConfig() },
        pendingMcpServers: ['pending'],
      });
      expect(config.getFailedMcpServerNames()).toEqual([]);
    });

    it('approveMcpServerForSession drops only the approved pending server', () => {
      const config = makeConfig({ pendingMcpServers: ['a', 'b'] });

      config.approveMcpServerForSession('a');

      expect(config.isMcpServerPendingApproval('a')).toBe(false);
      expect(config.isMcpServerPendingApproval('b')).toBe(true);

      config.approveMcpServerForSession('not-pending');
      expect(config.isMcpServerPendingApproval('b')).toBe(true);
    });
  });

  describe('reasoning effort override', () => {
    it('reports static overrides for the resolved configured tiered route', () => {
      const config = makeConfig();
      const cfg: ContentGeneratorConfig = {
        model: 'qwen3.8-flash',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        reasoning: { effort: 'low' },
        extra_body: { thinking_budget: 4096 },
      };
      vi.spyOn(config, 'getContentGeneratorConfig').mockReturnValue(cfg);
      const resolve = vi
        .spyOn(config, 'getResolvedModelConfig')
        .mockReturnValue({
          id: cfg.model,
          name: cfg.model,
          authType: AuthType.USE_OPENAI,
          baseUrl: cfg.baseUrl!,
          generationConfig: {},
          capabilities: {
            reasoning: {
              thinking: true,
              efforts: ['low', 'medium', 'xhigh'],
              defaultEffort: 'xhigh',
              disableField: 'reasoning_effort',
            },
          },
        });
      expect(config.getReasoningEffortOverride()).toEqual({
        source: 'extra_body',
        field: 'thinking_budget',
      });
      expect(resolve).toHaveBeenCalledWith(
        cfg.authType,
        cfg.model,
        cfg.baseUrl,
      );
      resolve.mockReturnValue(undefined);
      expect(config.getReasoningEffortOverride()).toBeUndefined();
    });
    /** A Config whose live generator is qwen3.8-max at effort max, plus `extra`. */
    const maxEffortConfig = (extra: Partial<ContentGeneratorConfig> = {}) => {
      const config = makeConfig();
      internals(config).contentGeneratorConfig = {
        model: 'qwen3.8-max',
        authType: AuthType.QWEN_OAUTH,
        reasoning: { effort: 'max' },
        ...extra,
      };
      return config;
    };

    it('reports a higher-priority DashScope knob that shadows reasoning effort', () => {
      const config = maxEffortConfig({
        extra_body: { thinking_budget: 4096 },
      });

      expect(config.getReasoningEffortOverride()).toEqual({
        source: 'extra_body',
        field: 'thinking_budget',
      });
    });

    it('does not report an identical static effort or a non-tiered model', () => {
      const config = maxEffortConfig({
        extra_body: { reasoning_effort: 'max' },
      });
      expect(config.getReasoningEffortOverride()).toBeUndefined();

      config.getContentGeneratorConfig().model = 'qwen3.7-max';
      config.getContentGeneratorConfig().extra_body = {
        thinking_budget: 4096,
      };
      expect(config.getReasoningEffortOverride()).toBeUndefined();
    });

    it.each([
      {
        name: 'extra_body enable_thinking disable',
        extra_body: { enable_thinking: false },
        expected: { source: 'extra_body', field: 'enable_thinking' },
      },
      {
        name: 'different extra_body effort',
        extra_body: { reasoning_effort: 'high' },
        expected: { source: 'extra_body', field: 'reasoning_effort' },
      },
      {
        name: 'samplingParams enable_thinking disable',
        samplingParams: { enable_thinking: false },
        expected: { source: 'samplingParams', field: 'enable_thinking' },
      },
      {
        name: 'samplingParams budget',
        samplingParams: { thinking_budget: 2048 },
        expected: { source: 'samplingParams', field: 'thinking_budget' },
      },
      {
        name: 'different samplingParams effort',
        samplingParams: { reasoning_effort: 'high' },
        expected: { source: 'samplingParams', field: 'reasoning_effort' },
      },
      {
        name: 'identical samplingParams effort',
        samplingParams: { reasoning_effort: 'max' },
        expected: undefined,
      },
      {
        name: 'extra_body enable_thinking on-switch',
        extra_body: { enable_thinking: true },
        expected: undefined,
      },
      {
        name: 'extra_body enable_thinking on-switch over a samplingParams disable',
        extra_body: { enable_thinking: true },
        samplingParams: { enable_thinking: false },
        expected: undefined,
      },
      {
        name: 'samplingParams enable_thinking on-switch',
        samplingParams: { enable_thinking: true },
        expected: undefined,
      },
      {
        name: 'samplingParams effort under an extra_body enable_thinking on-switch',
        extra_body: { enable_thinking: true },
        samplingParams: { reasoning_effort: 'high' },
        expected: { source: 'samplingParams', field: 'reasoning_effort' },
      },
      {
        name: 'samplingParams budget under an extra_body enable_thinking on-switch',
        extra_body: { enable_thinking: true },
        samplingParams: { thinking_budget: 2048 },
        expected: { source: 'samplingParams', field: 'thinking_budget' },
      },
    ])('resolves $name', ({ extra_body, samplingParams, expected }) => {
      const config = maxEffortConfig({ extra_body, samplingParams });

      expect(config.getReasoningEffortOverride()).toEqual(expected);
    });

    it('does not report an override for a non-DashScope endpoint', () => {
      const config = maxEffortConfig({
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://api.openai.com/v1',
        samplingParams: { thinking_budget: 2048 },
      });

      expect(config.getReasoningEffortOverride()).toBeUndefined();
    });
  });

  describe('refreshAuth', () => {
    /** A USE_GEMINI generator config for `model`. */
    const geminiGenerator = (model = 'qwen3-coder-plus') => ({
      apiKey: 'test-key',
      model,
      authType: AuthType.USE_GEMINI,
    });
    const failNextGenerator = (message: string) =>
      vi
        .mocked(createContentGenerator)
        .mockRejectedValueOnce(new Error(message));
    /** The last generator was created for `config` with `fields`, as initial auth. */
    const expectLastGenerator = (
      config: Config,
      fields: Record<string, unknown>,
    ) =>
      expect(createContentGenerator).toHaveBeenLastCalledWith(
        expect.objectContaining(fields),
        config,
        true,
      );

    it('creates the initial generator with the model API resolved from raw OpenAI settings', async () => {
      const config = makeConfig({
        authType: AuthType.USE_OPENAI,
        model: 'responses-model',
        modelProvidersConfig: {
          openai: [{ id: 'responses-model', wireApi: 'responses' }],
        },
      });
      resolveGeneratorModel('responses-model');

      await config.refreshAuth(AuthType.USE_OPENAI, true);

      expect(resolveContentGeneratorConfigWithSources).toHaveBeenLastCalledWith(
        config,
        AuthType.USE_OPENAI_RESPONSES,
        expect.objectContaining({ model: 'responses-model' }),
        expect.anything(),
        expect.anything(),
      );
      expectLastGenerator(config, { authType: AuthType.USE_OPENAI_RESPONSES });
      expect(config.getAuthType()).toBe(AuthType.USE_OPENAI_RESPONSES);
    });

    it.each(['retry', 'install', 'switch', 'invalid-switch'] as const)(
      'honors %s after initial Responses authentication fails',
      async (action) => {
        const baseUrl = 'https://gateway.example/v1';
        const config = makeConfig({
          authType: AuthType.USE_OPENAI,
          model: 'same',
          modelProvidersConfig: {
            openai: [{ id: 'same', baseUrl, wireApi: 'responses' }],
          },
        });
        resolveGeneratorModel('same');
        failNextGenerator('missing key');
        await expect(
          config.refreshAuth(AuthType.USE_OPENAI, true),
        ).rejects.toThrow('missing key');
        config.reloadModelProvidersConfig({
          openai: [
            { id: 'same', baseUrl },
            { id: 'same', baseUrl, wireApi: 'responses' },
          ],
        });
        if (action === 'install') {
          config.syncModelSelection(AuthType.USE_OPENAI, 'same', baseUrl);
        } else if (action === 'switch') {
          await config.switchModel(AuthType.USE_OPENAI, 'same', { baseUrl });
        } else if (action === 'invalid-switch') {
          await expect(
            config.switchModel(AuthType.USE_OPENAI, 'missing', { baseUrl }),
          ).rejects.toThrow();
        }
        await config.refreshAuth(AuthType.USE_OPENAI, true);
        const expectedAuth =
          action === 'install' || action === 'switch'
            ? AuthType.USE_OPENAI
            : AuthType.USE_OPENAI_RESPONSES;
        expectLastGenerator(config, { model: 'same', authType: expectedAuth });
        expect(config.getAuthType()).toBe(expectedAuth);
      },
    );

    it('does not redirect an OpenAI retry after the first Gemini refresh fails', async () => {
      const config = makeConfig({ authType: AuthType.USE_OPENAI });
      resolveGeneratorModel('test-model');
      failNextGenerator('test generator failure');
      await expect(config.refreshAuth(AuthType.USE_GEMINI)).rejects.toThrow(
        'test generator failure',
      );
      await config.refreshAuth(AuthType.USE_OPENAI, true);
      expectLastGenerator(config, { authType: AuthType.USE_OPENAI });
      expect(config.getAuthType()).toBe(AuthType.USE_OPENAI);
    });

    it('requires explicit selection after hot reload removes the selected API route', async () => {
      const config = makeConfig({
        authType: AuthType.USE_OPENAI_RESPONSES,
        model: 'shared',
        modelProvidersConfig: {
          openai: [{ id: 'shared', wireApi: 'responses' }],
        },
      });
      resolveGeneratorModel('shared');
      await config.refreshAuth(AuthType.USE_OPENAI_RESPONSES);
      vi.mocked(createContentGenerator).mockClear();
      config.reloadModelProvidersConfig({ openai: [{ id: 'shared' }] });

      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(
          config.refreshAuth(AuthType.USE_OPENAI_RESPONSES, true),
        ).rejects.toThrow('is no longer configured');
      }
      expect(createContentGenerator).not.toHaveBeenCalled();
      expect(config.getAuthType()).toBe(AuthType.USE_OPENAI_RESPONSES);
      expect(config.getModel()).toBe('shared');
    });

    it('should refresh auth and update config', async () => {
      const config = makeConfig();
      const mockContentConfig = geminiGenerator();
      resolveGeneratorTo(mockContentConfig);

      await config.refreshAuth(AuthType.USE_GEMINI);

      expect(resolveContentGeneratorConfigWithSources).toHaveBeenCalledWith(
        config,
        AuthType.USE_GEMINI,
        expect.objectContaining({ model: MODEL }),
        expect.anything(),
        expect.anything(),
      );
      expect(config.getContentGeneratorConfig()).toEqual(mockContentConfig);
      expect(LlmClient).toHaveBeenCalledWith(config);
    });

    it.each([false, true])(
      'preserves thinking off through repeated auth with mandatory thinking %s',
      async (thinkingMandatory) => {
        const config = makeConfig({
          generationConfig: { reasoning: false },
        });
        vi.mocked(resolveContentGeneratorConfigWithSources).mockImplementation(
          () => ({
            config: {
              model: 'kimi-k2.6',
              authType: AuthType.USE_OPENAI,
              thinkingMandatory,
              reasoning: { effort: 'high' },
            },
            sources: {},
          }),
        );

        for (const initial of [true, undefined]) {
          await config.refreshAuth(AuthType.USE_OPENAI, initial);
          expect(config.getContentGeneratorConfig().reasoning).toEqual(
            thinkingMandatory ? { effort: 'high' } : false,
          );
        }
        if (!thinkingMandatory) {
          expect(config.getModelsConfig().getGenerationConfig().reasoning).toBe(
            false,
          );
        }

        config.getModelsConfig().getGenerationConfig().reasoning = undefined;
        await config.refreshAuth(AuthType.USE_OPENAI);
        expect(config.getContentGeneratorConfig().reasoning).toEqual({
          effort: 'high',
        });
      },
    );

    it('preserves the user reasoning effort across an auth refresh that wipes it', async () => {
      // Regression: the provider sync (applyResolvedModelDefaults) overwrites
      // `reasoning` with the provider preset's undefined value, dropping the
      // user-global effort on every restart. refreshAuth must re-apply it.
      const config = makeConfig({
        generationConfig: { reasoning: { effort: 'max' } },
      });
      // The rebuilt config comes back WITHOUT reasoning (simulating the wipe).
      resolveGeneratorTo(geminiGenerator());

      await config.refreshAuth(AuthType.USE_GEMINI);

      expect(config.getReasoningEffort()).toBe('max');
      expect(config.getContentGeneratorConfig().reasoning).toEqual({
        effort: 'max',
      });
    });

    it('re-applies the reasoning effort on a full-refresh model switch that wiped modelsConfig', async () => {
      // Regression for the model-switch path: switchModel() runs
      // applyResolvedModelDefaults() (overwriting modelsConfig's `reasoning`
      // with the new model's preset) BEFORE onModelChange -> handleModelChange
      // fires, so refreshAuth's own capture reads undefined on the full-refresh
      // path. handleModelChange must re-apply the tier from the live
      // contentGeneratorConfig captured before the rebuild.
      const config = makeConfig({
        generationConfig: { reasoning: { effort: 'high' } },
      });
      // Initial auth seeds the live config with the effort.
      resolveGeneratorTo(geminiGenerator('gemini-a'));
      await config.refreshAuth(AuthType.USE_GEMINI);
      expect(config.getReasoningEffort()).toBe('high');

      // Simulate switchModel()'s pre-callback wipe of modelsConfig's reasoning.
      delete internals(config).modelsConfig.getGenerationConfig().reasoning;
      // The new model resolves with no reasoning preset (the common case).
      resolveGeneratorTo(geminiGenerator('gemini-b'));

      await internals(config).handleModelChange(AuthType.USE_GEMINI, true);

      // Effort survives the switch (previously silently dropped to undefined).
      expect(config.getContentGeneratorConfig().model).toBe('gemini-b');
      expect(config.getReasoningEffort()).toBe('high');
    });

    it('should fire auth_success notification hook when hooks are enabled', async () => {
      const mockMessageBus = { request: vi.fn() };
      const config = makeConfig({ disableAllHooks: false });
      config.setMessageBus(mockMessageBus as unknown as MessageBus);
      vi.spyOn(config, 'getHookSystem').mockReturnValue({
        runtimeId: 'auth-runtime',
      } as unknown as NonNullable<ReturnType<Config['getHookSystem']>>);
      resolveGeneratorTo(geminiGenerator());

      await config.refreshAuth(AuthType.USE_GEMINI);

      expect(fireNotificationHook).toHaveBeenCalledWith(
        mockMessageBus,
        `Successfully authenticated with ${AuthType.USE_GEMINI}`,
        'auth_success',
        'Authentication successful',
        undefined,
        {
          runtimeId: 'auth-runtime',
          sessionId: config.getSessionId(),
          agentId: null,
        },
      );
    });

    it('should not fire notification hook when hooks are disabled', async () => {
      const config = makeConfig({ disableAllHooks: true });
      resolveGeneratorTo(geminiGenerator());
      vi.mocked(fireNotificationHook).mockClear();

      await config.refreshAuth(AuthType.USE_GEMINI);

      expect(fireNotificationHook).not.toHaveBeenCalled();
    });

    it('should not strip thoughts when switching from Vertex to GenAI', async () => {
      const config = makeConfig();

      vi.mocked(createContentGeneratorConfig).mockImplementation(
        (_: Config, authType: AuthType | undefined) =>
          ({ authType }) as unknown as ContentGeneratorConfig,
      );

      await config.refreshAuth(AuthType.USE_VERTEX_AI);

      await config.refreshAuth(AuthType.USE_GEMINI);
    });
  });

  describe('model switching optimization (QWEN_OAUTH)', () => {
    /** A Config whose initial qwen-oauth content generator is established. */
    const qwenOauthConfig = async () => {
      const config = makeConfig();
      const mockContentConfig: ContentGeneratorConfig = {
        authType: AuthType.QWEN_OAUTH,
        model: 'coder-model',
        apiKey: 'QWEN_OAUTH_DYNAMIC_TOKEN',
        baseUrl: DEFAULT_DASHSCOPE_BASE_URL,
        timeout: 60000,
        maxRetries: 3,
      } as ContentGeneratorConfig;

      vi.mocked(resolveContentGeneratorConfigWithSources).mockImplementation(
        (_config, authType, generationConfig) => ({
          config: {
            ...mockContentConfig,
            authType,
            model: generationConfig?.model ?? mockContentConfig.model,
          } as ContentGeneratorConfig,
          sources: {},
        }),
      );
      stubContentGenerator();

      await config.refreshAuth(AuthType.QWEN_OAUTH);
      return config;
    };

    it('should switch qwen-oauth model in-place without refreshing auth when safe', async () => {
      const config = await qwenOauthConfig();
      // Spy after the initial refresh: the switch must not re-trigger it.
      const refreshSpy = vi.spyOn(config, 'refreshAuth');
      vi.mocked(resetPreloadedContentGenerator).mockClear();

      await config.switchModel(AuthType.QWEN_OAUTH, 'coder-model');

      expect(config.getModel()).toBe('coder-model');
      expect(refreshSpy).not.toHaveBeenCalled();
      // Once during the initial refreshAuth + once in handleModelChange diffing.
      expect(
        vi.mocked(resolveContentGeneratorConfigWithSources),
      ).toHaveBeenCalledTimes(2);
      expect(vi.mocked(createContentGenerator)).toHaveBeenCalledTimes(1);
      expect(resetPreloadedContentGenerator).toHaveBeenCalledOnce();
      expect(resetPreloadedContentGenerator).toHaveBeenCalledWith(
        config.getContentGenerator(),
      );
    });

    it('should preserve thoughts from history on model switch', async () => {
      const config = await qwenOauthConfig();

      await config.switchModel(AuthType.QWEN_OAUTH, 'coder-model');
    });

    it('should notify model change listeners after switchModel', async () => {
      const config = await qwenOauthConfig();
      const listener = vi.fn();
      const unsubscribe = config.onModelChange(listener);

      await config.switchModel(AuthType.QWEN_OAUTH, 'coder-model');

      expect(listener).toHaveBeenCalledWith('coder-model');
      unsubscribe();
    });
  });

  describe('getEffectiveInputModalities', () => {
    // Mirrors exactly what fileUtils uses to decide media support, so the file
    // reader's strip decision and the vision-bridge gate can never disagree.
    it.each([
      [
        'returns the resolved modalities from the content generator config',
        { model: 'custom-model', modalities: { image: true } },
        { image: true },
      ],
      [
        'treats a model with no resolved modalities as text-only',
        { model: 'custom-unknown-model' },
        {},
      ],
    ])('%s', (_title, generatorConfig, expected) => {
      const config = makeConfig();
      internals(config).contentGeneratorConfig =
        generatorConfig as ContentGeneratorConfig;

      expect(config.getEffectiveInputModalities()).toEqual(expected);
    });
  });

  describe('model switching with different credentials (OpenAI)', () => {
    const OPENAI = AuthType.USE_OPENAI;
    const ANTHROPIC = AuthType.USE_ANTHROPIC;
    const modelParams = (
      authType: AuthType,
      model: string,
      modelProvidersConfig: ModelProviders,
      extra: Partial<ConfigParameters> = {},
    ) => ({ authType, model, modelProvidersConfig, ...extra });
    const opus = idealabRoute('claude-opus-4-7');

    // `refresh` rows establish the content generator for `params.authType`
    // before reading the fast model.
    it.each`
      title                                                                                    | params                                                                                                                                                                                                                                            | refresh  | expected
      ${'returns undefined for bare Qwen OAuth fast models under active OpenAI auth'}          | ${modelParams(OPENAI, 'qwen3.7-max', { [OPENAI]: [dashscopeRoute('qwen3.7-max')] }, { fastModel: 'coder-model' })}                                                                                                                                | ${true}  | ${undefined}
      ${'returns an authType-qualified fast model selector'}                                   | ${modelParams(ANTHROPIC, 'shared-model', { [OPENAI]: [dashscopeRoute('shared-model', { name: 'OpenAI shared model' })], [ANTHROPIC]: [idealabRoute('shared-model', { name: 'Anthropic shared model' })] }, { fastModel: 'openai:shared-model' })} | ${false} | ${'openai:shared-model'}
      ${'preserves authType-qualified fast model selectors across auth types'}                 | ${modelParams(OPENAI, 'qwen3.7-max', { [OPENAI]: [dashscopeRoute('qwen3.7-max')] }, { fastModel: 'qwen-oauth:coder-model' })}                                                                                                                     | ${false} | ${'qwen-oauth:coder-model'}
      ${'resolves a bare fast model under the current auth type'}                              | ${modelParams(OPENAI, 'qwen3.7-max', { [OPENAI]: [dashscopeRoute('qwen3.7-max'), dashscopeRoute('fast-model')] }, { fastModel: 'fast-model' })}                                                                                                   | ${true}  | ${'fast-model'}
      ${'keeps authType-qualified selectors when the auth type matches the current auth type'} | ${modelParams(OPENAI, 'gpt-4', { [OPENAI]: [dashscopeRoute('deepseek-v4-flash')] }, { fastModel: 'openai:deepseek-v4-flash' })}                                                                                                                   | ${false} | ${'openai:deepseek-v4-flash'}
      ${'returns undefined when no active auth type is available for a bare fast model'}       | ${modelParams(ANTHROPIC, 'claude-opus-4-7', { [ANTHROPIC]: [opus] }, { fastModel: 'missing-fast-model' })}                                                                                                                                        | ${false} | ${undefined}
      ${'returns undefined when the fast model is not configured for the current auth type'}   | ${modelParams(ANTHROPIC, 'claude-opus-4-7', { [ANTHROPIC]: [opus] }, { fastModel: 'missing-fast-model' })}                                                                                                                                        | ${true}  | ${undefined}
      ${'returns undefined when the fast model selector is malformed'}                         | ${modelParams(ANTHROPIC, 'claude-opus-4-7', { [OPENAI]: [dashscopeRoute('deepseek-v4-flash')] }, { fastModel: 'openai:' })}                                                                                                                       | ${false} | ${undefined}
      ${'returns undefined when fastModel points back to the fast selector'}                   | ${modelParams(ANTHROPIC, 'claude-opus-4-7', { [ANTHROPIC]: [opus] }, { fastModel: 'fast' })}                                                                                                                                                      | ${false} | ${undefined}
    `('%s', async ({ params, refresh, expected }) => {
      const config = makeConfig(params);
      if (refresh) await config.refreshAuth(params.authType);
      expect(config.getFastModel()).toBe(expected);
    });

    const readAuxModel = (
      config: Config,
      key: 'fastModel' | 'compactionModel',
    ) =>
      key === 'fastModel' ? config.getFastModel() : config.getCompactionModel();

    it.each(['fastModel', 'compactionModel'] as const)(
      'drops a stale auxiliary endpoint instead of unconfiguring %s',
      (key) => {
        const config = makeConfig({
          authType: AuthType.USE_OPENAI,
          model: 'main',
          [key]: 'openai:shared\0https://removed.example/v1',
          modelProvidersConfig: {
            openai: [{ id: 'shared', baseUrl: 'https://moved.example/v1' }],
          },
        });
        // The pin no longer names a configured endpoint, so the selector falls
        // back to the bare form and the registry's first same-id match — the
        // pre-#12760 behaviour — instead of reporting the model as unset.
        expect(readAuxModel(config, key)).toBe('openai:shared');
      },
    );

    it.each(['fastModel', 'compactionModel'] as const)(
      'warns when a stale auxiliary endpoint pin is dropped (%s)',
      (key) => {
        const config = makeConfig({
          authType: AuthType.USE_OPENAI,
          model: 'main',
          [key]: 'openai:shared\0https://removed.example/v1',
          modelProvidersConfig: {
            openai: [{ id: 'shared', baseUrl: 'https://moved.example/v1' }],
          },
        });
        const warn = vi.spyOn(config.getDebugLogger(), 'warn');
        expect(readAuxModel(config, key)).toBe('openai:shared');
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('Aux endpoint pin dropped for "shared"'),
        );
        // The escaped form must reach the log, never a raw NUL byte.
        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('\0'));
      },
    );

    it('keeps the pin when a same-id sibling declares the colliding default URL (#12760)', () => {
      // The first row declares no baseUrl, so its effective URL is the
      // provider default — the same URL the second row declares. Matching the
      // pin on effective baseUrl with first-hit semantics would return the
      // first row's undefined registryBaseUrl and silently drop the pin,
      // rebinding every fast-model call to the personal key.
      const config = makeConfig({
        authType: AuthType.USE_OPENAI,
        model: 'main',
        fastModel: 'openai:gpt-4o\0https://api.openai.com/v1',
        modelProvidersConfig: {
          openai: [
            { id: 'gpt-4o', envKey: 'OPENAI_API_KEY_PERSONAL' },
            {
              id: 'gpt-4o',
              baseUrl: 'https://api.openai.com/v1',
              envKey: 'OPENAI_API_KEY_WORK',
            },
          ],
        },
      });

      expect(config.getFastModel()).toBe(
        'openai:gpt-4o\0https://api.openai.com/v1',
      );
    });

    it.each(['fastModel', 'compactionModel'] as const)(
      'keeps %s bare when the pinned entry declares no endpoint of its own',
      (key) => {
        const config = makeConfig({
          authType: AuthType.USE_OPENAI,
          model: 'main',
          // What the picker persists for a row whose provider entry has no
          // `baseUrl`: the registry's effective (default) URL.
          [key]: 'openai:shared\0https://api.openai.com/v1',
          modelProvidersConfig: { openai: [{ id: 'shared' }] },
        });
        // Such an entry is registered under the plain id, which a bare
        // selector already resolves to; re-attaching the effective URL would
        // hand consumers a registry key that does not exist.
        expect(readAuxModel(config, key)).toBe('openai:shared');
      },
    );

    it('keeps the endpoint disambiguator on a persisted fast model selector (#12760)', () => {
      // Two providers expose the same model id over the openai protocol; the
      // picker pins the second one as `authType:id\0baseUrl`. Dropping the
      // suffix would rebind the fast model to the first registered endpoint
      // (registry first-match fallback) — e.g. an exhausted token plan.
      const config = makeConfig({
        authType: AuthType.USE_OPENAI,
        model: 'qwen3.7-max',
        fastModel: 'openai:shared-fast\0https://free-quota.example.com/v1',
        modelProvidersConfig: {
          [AuthType.USE_OPENAI]: [
            {
              id: 'qwen3.7-max',
              name: 'qwen3.7-max',
              baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
              envKey: 'DASHSCOPE_API_KEY',
            },
            {
              id: 'shared-fast',
              name: 'shared-fast (token plan)',
              baseUrl: 'https://exhausted-plan.example.com/v1',
              envKey: 'TOKEN_PLAN_API_KEY',
            },
            {
              id: 'shared-fast',
              name: 'shared-fast (free quota)',
              baseUrl: 'https://free-quota.example.com/v1',
              envKey: 'FREE_QUOTA_API_KEY',
            },
          ],
        },
      });

      expect(config.getFastModel()).toBe(
        'openai:shared-fast\0https://free-quota.example.com/v1',
      );
    });

    it('accepts runtime fast models for authType-qualified selectors', () => {
      const config = makeConfig({
        authType: AuthType.USE_OPENAI,
        model: 'runtime-fast-model',
        fastModel: 'openai:runtime-fast-model',
        generationConfig: {
          apiKey: 'sk-runtime-key',
          baseUrl: 'https://runtime.example.com/v1',
        },
        generationConfigSources: {
          model: { kind: 'programmatic', detail: 'test' },
          apiKey: { kind: 'programmatic', detail: 'test' },
          baseUrl: { kind: 'programmatic', detail: 'test' },
        },
        modelProvidersConfig: {
          [AuthType.USE_OPENAI]: [
            openaiRoute('registry-model', { name: 'Registry Model' }),
          ],
        },
      });
      config.getModelsConfig().detectAndCaptureRuntimeModel();

      expect(config.getFastModel()).toBe('openai:runtime-fast-model');
    });
    describe('getCompactionModel', () => {
      const gpt4 = openaiRoute('gpt-4', { name: 'GPT-4' });
      const compaction = openaiRoute('compaction-model', {
        name: 'Compaction Model',
      });

      it('keeps the endpoint disambiguator on a persisted compaction model selector (#12760)', async () => {
        // Twin of the getFastModel case: the picker pins the second of two
        // same-id endpoints and runSideQuery's resolveForModel consumes the
        // suffix. Dropping it would rebind compaction to the first registered
        // endpoint (registry first-match fallback).
        const config = makeConfig({
          authType: AuthType.USE_OPENAI,
          model: 'qwen3.7-max',
          compactionModel:
            'openai:shared-compact\0https://free-quota.example.com/v1',
          modelProvidersConfig: {
            [AuthType.USE_OPENAI]: [
              {
                id: 'qwen3.7-max',
                name: 'qwen3.7-max',
                baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
                envKey: 'DASHSCOPE_API_KEY',
              },
              {
                id: 'shared-compact',
                name: 'shared-compact (token plan)',
                baseUrl: 'https://exhausted-plan.example.com/v1',
                envKey: 'TOKEN_PLAN_API_KEY',
              },
              {
                id: 'shared-compact',
                name: 'shared-compact (free quota)',
                baseUrl: 'https://free-quota.example.com/v1',
                envKey: 'FREE_QUOTA_API_KEY',
              },
            ],
          },
        });

        await config.refreshAuth(AuthType.USE_OPENAI);

        expect(config.getCompactionModel()).toBe(
          'openai:shared-compact\0https://free-quota.example.com/v1',
        );
      });

      // 'falls back to the main model when compactionModel is not set':
      // fastModel is intentionally ignored — compaction falls back to main.
      it.each`
        title                                                                                        | params                                                                                                                                                              | refresh  | expected
        ${'returns the compaction model when set'}                                                   | ${modelParams(OPENAI, 'gpt-4', { [OPENAI]: [gpt4, compaction] }, { compactionModel: 'compaction-model' })}                                                          | ${true}  | ${'compaction-model'}
        ${'resolves an authType-qualified compaction model selector'}                                | ${modelParams(ANTHROPIC, 'claude-opus-4-7', { [OPENAI]: [compaction], [ANTHROPIC]: [opus] }, { compactionModel: 'openai:compaction-model' })}                       | ${true}  | ${'openai:compaction-model'}
        ${'falls back to the main model when compactionModel is not set'}                            | ${modelParams(OPENAI, 'gpt-4', { [OPENAI]: [gpt4, openaiRoute('fast-model', { name: 'Fast Model' })] }, { fastModel: 'fast-model' })}                               | ${true}  | ${'gpt-4'}
        ${'falls back to main model when neither compactionModel nor fastModel is set'}              | ${modelParams(OPENAI, 'gpt-4', { [OPENAI]: [gpt4] })}                                                                                                               | ${false} | ${'gpt-4'}
        ${'returns undefined when the compaction model is voiceOnly'}                                | ${modelParams(OPENAI, 'gpt-4', { [OPENAI]: [gpt4, openaiRoute('voice-model', { name: 'Voice Model', voiceOnly: true })] }, { compactionModel: 'voice-model' })}     | ${true}  | ${undefined}
        ${'returns undefined when the compaction model is visionOnly'}                               | ${modelParams(OPENAI, 'gpt-4', { [OPENAI]: [gpt4, openaiRoute('vision-model', { name: 'Vision Model', visionOnly: true })] }, { compactionModel: 'vision-model' })} | ${true}  | ${undefined}
        ${'falls back to the main model when the compaction model selector is malformed'}            | ${modelParams(ANTHROPIC, 'claude-opus-4-7', { [OPENAI]: [dashscopeRoute('deepseek-v4-flash')] }, { compactionModel: 'openai:' })}                                   | ${true}  | ${'claude-opus-4-7'}
        ${'returns undefined when the compaction model is not configured for the current auth type'} | ${modelParams(ANTHROPIC, 'claude-opus-4-7', { [ANTHROPIC]: [idealabRoute('claude-opus-4-7', { name: 'Claude Opus 4' })] }, { compactionModel: 'missing-model' })}   | ${true}  | ${undefined}
      `('%s', async ({ params, refresh, expected }) => {
        const config = makeConfig(params);
        if (refresh) await config.refreshAuth(params.authType);
        expect(config.getCompactionModel()).toBe(expected);
      });
    });
    it('should refresh auth when switching to model with different envKey', async () => {
      // Guards switching between modelProvider models with different envKeys
      // (e.g. deepseek-chat with DEEPSEEK_API_KEY).
      const baseUrl = 'https://api.example.com/v1';
      const config = makeConfig({
        authType: AuthType.USE_OPENAI,
        modelProvidersConfig: {
          openai: [
            route('model-a', baseUrl, 'API_KEY_A', { name: 'Model A' }),
            route('model-b', baseUrl, 'API_KEY_B', { name: 'Model B' }),
          ],
        },
      });
      const [configA, configB] = [
        ['model-a', 'key-a'],
        ['model-b', 'key-b'],
      ].map(
        ([model, apiKey]) =>
          ({
            authType: AuthType.USE_OPENAI,
            model,
            apiKey,
            baseUrl,
          }) as ContentGeneratorConfig,
      );
      vi.mocked(resolveContentGeneratorConfigWithSources).mockImplementation(
        (_config, _authType, generationConfig) => ({
          config: generationConfig?.model === 'model-b' ? configB : configA,
          sources: {},
        }),
      );
      stubContentGenerator();
      await config.refreshAuth(AuthType.USE_OPENAI);
      const refreshSpy = vi.spyOn(config, 'refreshAuth');

      await config.switchModel(AuthType.USE_OPENAI, 'model-b');

      // The envKey changed, so the switch must take the full refresh path.
      expect(refreshSpy).toHaveBeenCalledWith(AuthType.USE_OPENAI);
      expect(config.getModel()).toBe('model-b');
    });
  });

  it('Config constructor should store userMemory correctly', () => {
    const config = makeConfig();

    expect(config.getUserMemory()).toBe(USER_MEMORY);
    expect(config.getTargetDir()).toBe(path.resolve(TARGET_DIR));
  });

  it('Config constructor should default userMemory to empty string if not provided', () => {
    const paramsWithoutMemory: ConfigParameters = { ...baseParams };
    delete paramsWithoutMemory.userMemory;
    const config = new Config(paramsWithoutMemory);

    expect(config.getUserMemory()).toBe('');
  });

  it('Config constructor should enable runtime sleep prevention by default', () => {
    expect(makeConfig().getPreventSystemSleepEnabled()).toBe(true);
  });

  it('Config constructor should store runtime sleep prevention override', () => {
    expect(
      makeConfig({ preventSystemSleep: false }).getPreventSystemSleepEnabled(),
    ).toBe(false);
  });

  /** Make every memory load return PROJECT_RULES from one context file. */
  const loadProjectRules = () =>
    vi
      .mocked(loadServerHierarchicalMemory)
      .mockResolvedValue(
        memoryLoad({ memoryContent: PROJECT_RULES, fileCount: 1 }),
      );
  const ALWAYS_ON_CONTEXT =
    'Loaded always-on context (QWEN.md context files + auto-memory)';
  const expectWarning = (config: Config, text: string) =>
    expect(config.getWarnings()).toContainEqual(expect.stringContaining(text));

  it('refreshHierarchicalMemory should build the managed auto-memory prompt when present', async () => {
    const config = makeConfig();
    loadProjectRules();
    vi.mocked(readAutoMemoryIndexWithStats).mockResolvedValue(
      mockAutoMemoryIndexRead(
        '# Managed Auto-Memory Index\n\n- [Project Memory](project.md)',
      ),
    );

    await config.refreshHierarchicalMemory();

    // Context files stay in userMemory; the volatile auto-memory section is
    // kept separate so prompt assembly can order stable → context → volatile.
    expect(config.getUserMemory()).toContain('Project rules');
    expect(config.getUserMemory()).not.toContain('# auto memory');
    expect(config.getAutoMemoryPrompt()).toContain('# auto memory');
    expect(config.getAutoMemoryPrompt()).toContain(
      '[Project Memory](project.md)',
    );
  });

  /**
   * A temp project whose auto-memory base dir is redirected under it, with the
   * managed index directory created; `cleanup` restores env and removes it.
   */
  async function autoMemoryWorkspace(prefix: string) {
    const restoreEnv = stashEnv('QWEN_CODE_MEMORY_BASE_DIR');
    const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
    const projectRoot = path.join(tempDir, 'project');
    await mkdir(projectRoot, { recursive: true });
    process.env['QWEN_CODE_MEMORY_BASE_DIR'] = path.join(
      tempDir,
      'memory-base',
    );
    clearAutoMemoryRootCache();
    const managedIndexPath = getAutoMemoryIndexPath(projectRoot);
    await mkdir(path.dirname(managedIndexPath), { recursive: true });
    return {
      managedIndexPath,
      /** A Config rooted at the project whose memory load reports it. */
      config: () => {
        const config = makeConfig({ cwd: projectRoot, targetDir: projectRoot });
        vi.mocked(loadServerHierarchicalMemory).mockResolvedValueOnce(
          memoryLoad({
            memoryContent: PROJECT_RULES,
            fileCount: 1,
            projectRoot,
          }),
        );
        return config;
      },
      cleanup: async () => {
        restoreEnv();
        clearAutoMemoryRootCache();
        await rm(tempDir, { recursive: true, force: true });
      },
    };
  }

  it('refreshHierarchicalMemory seeds the FileReadCache for project and user MEMORY.md indexes', async (ctx) => {
    const workspace = await autoMemoryWorkspace('auto-memory-cache-');
    const { managedIndexPath } = workspace;
    const userIndexPath = getUserAutoMemoryIndexPath();
    await mkdir(path.dirname(userIndexPath), { recursive: true });
    await writeFile(managedIndexPath, '# managed memory\n', 'utf-8');
    await writeFile(userIndexPath, '# user memory\n', 'utf-8');

    // FileReadCache keys entries by dev:ino. Where distinct files report the
    // same inode, the two index records collide and the managed index would
    // be checked against the user index's stats, so the seeding pinned here
    // only makes sense where inode identity is real; skip elsewhere.
    const [managedStats, userStats] = await Promise.all([
      stat(managedIndexPath),
      stat(userIndexPath),
    ]);
    if (
      Number(managedStats.ino) === 0 ||
      Number(userStats.ino) === 0 ||
      (managedStats.dev === userStats.dev && managedStats.ino === userStats.ino)
    ) {
      await workspace.cleanup();
      ctx.skip();
      return;
    }

    try {
      const config = workspace.config();
      vi.mocked(readAutoMemoryIndexWithStats).mockResolvedValueOnce({
        content: '# managed memory\n',
        stats: await stat(managedIndexPath),
      });
      vi.mocked(readUserAutoMemoryIndexWithStats).mockResolvedValueOnce({
        content: '# user memory\n',
        stats: await stat(userIndexPath),
      });

      await config.refreshHierarchicalMemory();

      for (const indexPath of [managedIndexPath, userIndexPath]) {
        await expect(
          checkPriorRead(config.getFileReadCache(), indexPath, 'overwriting'),
        ).resolves.toEqual({ ok: true });
      }
    } finally {
      await workspace.cleanup();
    }
  });

  it('refreshHierarchicalMemory records the stats captured with the auto-memory index read', async () => {
    const workspace = await autoMemoryWorkspace('auto-memory-cache-race-');
    const { managedIndexPath } = workspace;
    await writeFile(managedIndexPath, '# old managed memory\n', 'utf-8');
    const oldStats = await stat(managedIndexPath);
    await writeFile(
      managedIndexPath,
      '# newer managed memory with extra bytes\n',
      'utf-8',
    );

    try {
      const config = workspace.config();
      vi.mocked(readAutoMemoryIndexWithStats).mockResolvedValueOnce({
        content: '# old managed memory\n',
        stats: oldStats,
      });

      await config.refreshHierarchicalMemory();

      await expect(
        checkPriorRead(
          config.getFileReadCache(),
          managedIndexPath,
          'overwriting',
        ),
      ).resolves.toMatchObject({
        ok: false,
        type: ToolErrorType.FILE_CHANGED_SINCE_READ,
      });
    } finally {
      await workspace.cleanup();
    }
  });

  it('refreshHierarchicalMemory should not load team memory from untrusted workspaces', async () => {
    const config = makeConfig({ enableTeamMemory: true });
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(false);
    loadProjectRules();
    vi.mocked(rebuildTeamAutoMemoryIndex).mockResolvedValue(
      '# Team Memory\n\n- [Shared](shared.md)',
    );

    await config.refreshHierarchicalMemory();

    expect(rebuildTeamAutoMemoryIndex).not.toHaveBeenCalled();
    expect(config.getUserMemory()).not.toContain('Team Memory');
    // The shareability check is gated on the active tier, so an inactive
    // (untrusted) tier must never probe git.
    expect(getTeamMemoryShareabilityWarning).not.toHaveBeenCalled();
  });

  /** Run `body` on a trusted team-memory Config with sync on in settings and env. */
  async function withTeamSync(body: (config: Config) => Promise<void>) {
    const restoreEnv = stashEnv('QWEN_CODE_MEMORY_TEAM_SYNC');
    process.env['QWEN_CODE_MEMORY_TEAM_SYNC'] = '1';
    try {
      const config = makeConfig({
        enableTeamMemory: true,
        enableTeamMemorySync: true,
      });
      vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
      loadProjectRules();
      await body(config);
    } finally {
      restoreEnv();
    }
  }

  it('refreshHierarchicalMemory must not sync when the team-root safety check rejects', () =>
    // The indexer THROWS when the team root is a symlink that could redirect
    // the committed index outside the repo; sync must never git
    // add/commit/push a dir that failed that check.
    withTeamSync(async (config) => {
      // The indexer's symlink-escape rejection: a SECURITY failure, the only
      // class that blocks sync (see indexer.ts).
      vi.mocked(rebuildTeamAutoMemoryIndex).mockRejectedValueOnce(
        new TeamMemoryRootSecurityError(
          'Refusing to write team memory index: /tmp/.qwen/team-memory is a ' +
            'symlink, which could redirect the committed index outside the repository.',
        ),
      );

      await config.refreshHierarchicalMemory();

      // Gate proof: sync is enabled, yet the security rejection skips it; stop
      // treating TeamMemoryRootSecurityError as blocking and this fails.
      expect(rebuildTeamAutoMemoryIndex).toHaveBeenCalledTimes(1);
      expect(syncTeamMemory).not.toHaveBeenCalled();
    }));

  it('still syncs when the team-index rebuild fails for an OPERATIONAL reason', () =>
    // An EACCES/ENOSPC/EPERM rebuild failure is not a security escape, so it
    // must NOT permanently gate legitimate sync; it self-corrects on the next
    // successful rebuild.
    withTeamSync(async (config) => {
      vi.mocked(rebuildTeamAutoMemoryIndex).mockRejectedValueOnce(
        Object.assign(new Error('EACCES: permission denied, lstat'), {
          code: 'EACCES',
        }),
      );

      await config.refreshHierarchicalMemory();

      expect(rebuildTeamAutoMemoryIndex).toHaveBeenCalledTimes(1);
      expect(syncTeamMemory).toHaveBeenCalledTimes(1);
    }));

  it('syncs when the rebuild succeeds and sync is enabled (positive gate)', () =>
    // Complement to the negative branches: inverting or removing the sync
    // condition is caught here.
    withTeamSync(async (config) => {
      vi.mocked(rebuildTeamAutoMemoryIndex).mockResolvedValueOnce(
        '# Team Memory\n\n- [Shared](shared.md)',
      );

      await config.refreshHierarchicalMemory();

      expect(rebuildTeamAutoMemoryIndex).toHaveBeenCalledTimes(1);
      expect(syncTeamMemory).toHaveBeenCalledTimes(1);
    }));

  it('refreshHierarchicalMemory surfaces a one-time warning when team memory is not git-shareable', async () => {
    const config = makeConfig({ enableTeamMemory: true });
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
    loadProjectRules();
    vi.mocked(getTeamMemoryShareabilityWarning).mockReturnValue(
      'Team memory is enabled, but /tmp/.qwen/team-memory is git-ignored',
    );

    await config.refreshHierarchicalMemory();
    // A second refresh must not re-emit the warning (latched once per process).
    await config.refreshHierarchicalMemory();

    expect(getTeamMemoryShareabilityWarning).toHaveBeenCalledTimes(1);
    expectWarning(config, 'is git-ignored');
  });

  // #12029: the ratio alone means a large window never warns. 15% of a 1M
  // window is 150,000 tokens of always-on context — an absolute ceiling is what
  // makes the warning fire where the cost is actually paid.
  it('warns about a large always-on context on a large window, naming the token bound', async () => {
    const config = makeConfig({
      userMemory: 'a'.repeat(48_000), // ~12,000 tokens
      generationConfig: { contextWindowSize: 1_000_000 },
    });

    expectWarning(config, 'uses about 12,000 tokens');
    // The bound that actually fired leads, and the window is still named so a
    // reader can see how the budget was derived.
    expectWarning(
      config,
      "more than 10,000 tokens — the smaller of that and 15% of this model's 1,000,000 token context window",
    );
    expect(config.getWarnings().join('\n')).not.toContain('more than 15%');
  });

  it('keeps naming the percentage when the ratio is the binding bound', async () => {
    const config = makeConfig({
      userMemory: 'a'.repeat(800), // 200 tokens, against 15% of 1,000
      generationConfig: { contextWindowSize: 1_000 },
    });

    expectWarning(config, "more than 15% of this model's 1,000 token");
  });

  // The author of an extension rule that was dropped has to be told, or the
  // documented mechanism silently does nothing for them (#12030).
  it('warns for each extension rule skipped for having no paths', async () => {
    const config = makeConfig();
    vi.mocked(loadServerHierarchicalMemory).mockResolvedValue(
      memoryLoad({ ignoredExtensionRules: ['charts:rules/always.md'] }),
    );

    await config.refreshHierarchicalMemory();

    expectWarning(
      config,
      'Extension rule charts:rules/always.md has no `paths:` and was skipped',
    );
  });

  // A refresh replaces the list rather than appending to it, or a session that
  // reloads memory a few times shows the same warning several times over.
  it('does not accumulate the same extension-rule warning across refreshes', async () => {
    const config = makeConfig();
    vi.mocked(loadServerHierarchicalMemory).mockResolvedValue(
      memoryLoad({ ignoredExtensionRules: ['charts:rules/always.md'] }),
    );

    await config.refreshHierarchicalMemory();
    await config.refreshHierarchicalMemory();

    expect(
      config
        .getWarnings()
        .filter((warning) => warning.includes('charts:rules/always.md')),
    ).toHaveLength(1);
  });

  it('refreshHierarchicalMemory should expose loaded context file paths', async () => {
    const config = makeConfig();
    vi.mocked(loadServerHierarchicalMemory).mockResolvedValue(
      memoryLoad({
        memoryContent: PROJECT_RULES,
        fileCount: 1,
        contextFilePaths: ['QWEN.md'],
      }),
    );

    await config.refreshHierarchicalMemory();
    expect(config.getContextFilePaths()).toEqual(['QWEN.md']);

    vi.mocked(loadServerHierarchicalMemory).mockResolvedValue(memoryLoad());

    await config.refreshHierarchicalMemory();
    expect(config.getContextFilePaths()).toEqual([]);
  });

  it('guards and rolls back the memory recall mode transition by revision', async () => {
    const config = Object.create(Config.prototype) as Config;
    Object.assign(config, {
      memoryRecallMode: 'legacy',
      memoryRecallModeInitialized: true,
      memoryCorpusRevision: 'legacy-revision',
      autoMemoryPrompt: 'legacy prompt',
    });
    vi.spyOn(config, 'isManagedMemoryAvailable').mockReturnValue(true);
    vi.spyOn(config, 'getManagedAutoMemoryEnabled').mockReturnValue(true);
    vi.spyOn(config, 'getStructuredMemoryRecallEnabled').mockReturnValue(true);
    vi.spyOn(config, 'getProjectRoot').mockReturnValue('/tmp/project');
    vi.spyOn(config, 'getTeamMemoryEnabled').mockReturnValue(true);
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(false);
    const scan = vi
      .fn()
      .mockResolvedValue({ ready: true, revision: 'structured-revision' });
    Object.assign(config, { scanMemoryRecallCorpusStatus: scan });

    scan.mockResolvedValueOnce({
      ready: false,
      revision: 'not-ready-revision',
    });
    await expect(config.prepareMemoryRecallTransition()).resolves.toBe(
      undefined,
    );
    expect(config.getMemoryRecallMode()).toBe('legacy');

    const transition = await config.prepareMemoryRecallTransition();
    expect(transition).toMatchObject({
      from: 'legacy',
      to: 'structured',
      revision: 'structured-revision',
      previousRevision: 'not-ready-revision',
      previousAutoMemoryPrompt: 'legacy prompt',
    });
    expect(transition?.autoMemoryPrompt).toContain(
      'Use the complete tree and focused metadata for routing.',
    );
    expect(transition?.autoMemoryPrompt).not.toContain('TEAM:');
    expect(rebuildTeamAutoMemoryIndex).not.toHaveBeenCalled();
    await expect(
      config.confirmMemoryRecallTransition(transition!),
    ).resolves.toBe(true);

    config.commitMemoryRecallTransition(transition!);
    expect(config.getMemoryRecallMode()).toBe('structured');
    expect(config.getAutoMemoryPrompt()).toBe(transition?.autoMemoryPrompt);

    config.rollbackMemoryRecallTransition(transition!);
    expect(config.getMemoryRecallMode()).toBe('legacy');
    expect(config.getAutoMemoryPrompt()).toBe('legacy prompt');

    scan.mockResolvedValueOnce({ ready: true, revision: 'changed-revision' });
    await expect(
      config.confirmMemoryRecallTransition(transition!),
    ).resolves.toBe(false);
  });

  it('prepareMemoryRecallTransition tolerates a failed tier index rebuild', async () => {
    // A tier that cannot be read or written (EACCES, a rejected root) leaves
    // its legacy MEMORY.md stale, but the structured prompt is built from
    // scans — the rebuild must not block the protocol transition.
    const config = Object.create(Config.prototype) as Config;
    Object.assign(config, {
      memoryRecallMode: 'legacy',
      memoryRecallModeInitialized: true,
      memoryCorpusRevision: 'legacy-revision',
      autoMemoryPrompt: 'legacy prompt',
      debugLogger: createDebugLogger('TEST'),
    });
    vi.spyOn(config, 'getManagedAutoMemoryEnabled').mockReturnValue(true);
    vi.spyOn(config, 'getStructuredMemoryRecallEnabled').mockReturnValue(true);
    vi.spyOn(config, 'getProjectRoot').mockReturnValue('/tmp/project');
    vi.spyOn(config, 'getTeamMemoryEnabled').mockReturnValue(false);
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
    Object.assign(config, {
      scanMemoryRecallCorpusStatus: vi
        .fn()
        .mockResolvedValue({ ready: true, revision: 'structured-revision' }),
    });
    vi.mocked(rebuildUserAutoMemoryIndex).mockRejectedValueOnce(
      new Error('EACCES: cannot read user root'),
    );

    const transition = await config.prepareMemoryRecallTransition();

    expect(transition).toMatchObject({
      from: 'legacy',
      to: 'structured',
      revision: 'structured-revision',
    });
    expect(transition?.autoMemoryPrompt).toContain(
      'Use the complete tree and focused metadata for routing.',
    );
  });

  it('prepareMemoryRecallTransition stays inert in safe mode', async () => {
    const config = Object.create(Config.prototype) as Config;
    Object.assign(config, {
      memoryRecallMode: 'legacy',
      memoryRecallModeInitialized: true,
      memoryCorpusRevision: 'legacy-revision',
      autoMemoryPrompt: '',
    });
    vi.spyOn(config, 'isManagedMemoryAvailable').mockReturnValue(true);
    // The production predicate adds `&& !isSafeMode()`; keep the mock pointed
    // at it so the gate being exercised is the one client.ts relies on.
    vi.spyOn(config, 'getManagedAutoMemoryEnabled').mockReturnValue(false);
    vi.spyOn(config, 'getProjectRoot').mockReturnValue('/tmp/project');
    const scan = vi
      .fn()
      .mockResolvedValue({ ready: true, revision: 'structured-revision' });
    Object.assign(config, { scanMemoryRecallCorpusStatus: scan });

    await expect(config.prepareMemoryRecallTransition()).resolves.toBe(
      undefined,
    );
    expect(scan).not.toHaveBeenCalled();
    expect(config.getMemoryRecallMode()).toBe('legacy');
  });

  it('prepareMemoryRecallTransition stays inert while the structured protocol is opted out', async () => {
    // A ready corpus must not flip the protocol on by itself: activation is
    // opt-in, so the readiness scan is never even consulted.
    const config = Object.create(Config.prototype) as Config;
    Object.assign(config, {
      memoryRecallMode: 'legacy',
      memoryRecallModeInitialized: true,
      memoryCorpusRevision: 'legacy-revision',
      autoMemoryPrompt: 'legacy prompt',
    });
    vi.spyOn(config, 'getManagedAutoMemoryEnabled').mockReturnValue(true);
    vi.spyOn(config, 'getStructuredMemoryRecallEnabled').mockReturnValue(false);
    vi.spyOn(config, 'getProjectRoot').mockReturnValue('/tmp/project');
    const scan = vi
      .fn()
      .mockResolvedValue({ ready: true, revision: 'structured-revision' });
    Object.assign(config, { scanMemoryRecallCorpusStatus: scan });

    await expect(config.prepareMemoryRecallTransition()).resolves.toBe(
      undefined,
    );
    expect(scan).not.toHaveBeenCalled();
    expect(config.getMemoryRecallMode()).toBe('legacy');
  });

  it('runs the corpus readiness scan once, not on every refresh', async () => {
    // The scan walks the frontmatter of every memory file, and its result is
    // consumed only while the mode is still uninitialized. Since
    // refreshHierarchicalMemory runs per user query, re-walking the whole
    // corpus after the mode has settled would put a full-corpus read on the
    // prompt critical path and then throw the result away.
    const previousEnv = process.env['QWEN_CODE_MEMORY_STRUCTURED_RECALL'];
    process.env['QWEN_CODE_MEMORY_STRUCTURED_RECALL'] = '1';
    try {
      const config = new Config(baseParams);
      vi.spyOn(config, 'isManagedMemoryAvailable').mockReturnValue(true);
      vi.mocked(loadServerHierarchicalMemory).mockResolvedValue({
        memoryContent: '',
        fileCount: 0,
        contextFilePaths: [],
        ruleCount: 0,
        conditionalRules: [],
        projectRoot: '/tmp',
      });
      vi.mocked(scanMemoryMetadataCorpusStatus).mockResolvedValue({
        ready: true,
        revision: 'structured-revision',
        files: 1,
        legacyFiles: 0,
        legacyByScope: { project: 0, user: 0, team: 0 },
      });

      await config.refreshHierarchicalMemory();
      expect(config.getMemoryRecallMode()).toBe('structured');
      expect(scanMemoryMetadataCorpusStatus).toHaveBeenCalledTimes(1);

      await config.refreshHierarchicalMemory();
      await config.refreshHierarchicalMemory();

      // Settled: the mode is not re-derived, so the scan must not re-run.
      expect(scanMemoryMetadataCorpusStatus).toHaveBeenCalledTimes(1);
      expect(config.getMemoryRecallMode()).toBe('structured');
    } finally {
      if (previousEnv === undefined) {
        delete process.env['QWEN_CODE_MEMORY_STRUCTURED_RECALL'];
      } else {
        process.env['QWEN_CODE_MEMORY_STRUCTURED_RECALL'] = previousEnv;
      }
    }
  });

  const smallWindow = () => ({ generationConfig: { contextWindowSize: 1000 } });

  it('refreshHierarchicalMemory should include appended auto-memory in the context warning estimate', async () => {
    const config = makeConfig(smallWindow());
    vi.mocked(loadServerHierarchicalMemory).mockResolvedValue(
      memoryLoad({ memoryContent: 'short project rules', fileCount: 1 }),
    );
    vi.mocked(readAutoMemoryIndexWithStats).mockResolvedValueOnce(
      mockAutoMemoryIndexRead(
        '# Managed Auto-Memory Index\n\n' + 'remember this '.repeat(80),
      ),
    );

    await config.refreshHierarchicalMemory();

    expectWarning(config, ALWAYS_ON_CONTEXT);
  });

  it('refreshHierarchicalMemory should warn when always-loaded context is large for the model window', async () => {
    const config = makeConfig(smallWindow());
    vi.mocked(loadServerHierarchicalMemory).mockResolvedValueOnce(
      memoryLoad({ memoryContent: 'a'.repeat(800), fileCount: 1 }),
    );

    await config.refreshHierarchicalMemory();

    expectWarning(config, ALWAYS_ON_CONTEXT);
    expectWarning(config, "model's 1,000 token context window");
    expectWarning(config, 'more than 15%');
  });

  it('getWarnings should include oversized context before initialize refresh runs', () => {
    expectWarning(
      makeConfig({ userMemory: 'a'.repeat(800), ...smallWindow() }),
      ALWAYS_ON_CONTEXT,
    );
  });

  it('getWarnings should use the model token limit when no contextWindowSize is configured', () => {
    const warningThresholdTokens = Math.floor(DEFAULT_TOKEN_LIMIT * 0.15);
    const config = makeConfig({
      model: 'unknown-model-for-context-warning-test',
      userMemory: 'a'.repeat((warningThresholdTokens + 1) * 4),
    });

    expectWarning(
      config,
      `model's ${DEFAULT_TOKEN_LIMIT.toLocaleString()} token context window`,
    );
  });

  it('refreshHierarchicalMemory should not warn for small always-loaded context', async () => {
    const config = makeConfig({ bareMode: true, ...smallWindow() });
    vi.mocked(loadServerHierarchicalMemory).mockResolvedValueOnce(
      memoryLoad({ memoryContent: 'short project context', fileCount: 1 }),
    );
    vi.mocked(readAutoMemoryIndexWithStats).mockResolvedValueOnce(null);

    await config.refreshHierarchicalMemory();

    expect(
      config
        .getWarnings()
        .some((warning) => warning.includes(ALWAYS_ON_CONTEXT)),
    ).toBe(false);
  });

  const NEW_DIR = path.resolve('/path/to/other');
  const spyPatch = () => vi.spyOn(sessionRegistry, 'patchSessionRecord');
  const spyUnregister = () => vi.spyOn(sessionRegistry, 'unregisterSession');
  const spyWriteStatus = () => vi.spyOn(runtimeStatus, 'writeRuntimeStatus');
  // The relocation and registry cases below spy on the process cwd, the
  // session registry and the runtime status sidecar: restore after each case.
  afterEach(() => {
    for (const spied of [
      process.chdir,
      process.cwd,
      sessionRegistry.patchSessionRecord,
      sessionRegistry.unregisterSession,
      runtimeStatus.writeRuntimeStatus,
    ]) {
      if (vi.isMockFunction(spied)) spied.mockRestore();
    }
  });
  /** The runtime status sidecar paths before and after a move to NEW_DIR. */
  const runtimeStatusPaths = (config: Config) => ({
    oldRuntimeStatusPath: new Storage(
      config.getTargetDir(),
    ).getRuntimeStatusPath(config.getSessionId()),
    newRuntimeStatusPath: new Storage(NEW_DIR).getRuntimeStatusPath(
      config.getSessionId(),
    ),
  });
  /** Chats-dir paths of `config`'s session artifacts, old root and NEW_DIR. */
  const sessionArtifacts = (config: Config, suffixes: string[]) => {
    const chatsDir = (root: string) =>
      path.join(new Storage(root).getProjectDir(), 'chats');
    const inDir = (dir: string) =>
      suffixes.map((suffix) =>
        path.join(dir, `${config.getSessionId()}${suffix}`),
      );
    return {
      newChatsDir: chatsDir(NEW_DIR),
      from: inDir(chatsDir(config.getTargetDir())),
      to: inDir(chatsDir(NEW_DIR)),
    };
  };
  /** Report only `paths` and NEW_DIR as existing on disk. */
  const existingPaths = (...paths: string[]) =>
    vi
      .mocked(fs.existsSync)
      .mockImplementation((pathToCheck) =>
        [...paths, NEW_DIR].includes(pathToCheck.toString()),
      );
  /** The registry patch a move to NEW_DIR writes for `sessionId`. */
  const movedPatch = (sessionId: string) =>
    [
      {
        cwd: NEW_DIR,
        name: sessionRegistry.deriveSessionName(NEW_DIR, sessionId),
      },
      sessionRegistry.SHARED_RECORD_SLOT,
    ] as const;
  /** The registry patch a session switch to `sessionId` writes. */
  const switchedPatch = (config: Config, sessionId: string) =>
    [
      { sessionId, cwd: config.getTargetDir() },
      sessionRegistry.SHARED_RECORD_SLOT,
    ] as const;
  /** A Config whose shared session record registration has settled. */
  const registeredConfig = async () => {
    const config = makeConfig();
    config.trackSessionRegistration(sharedRegistration());
    await expect(config.whenSessionRegistered()).resolves.toBe(true);
    return config;
  };
  /** A Config with the runtime sidecar and/or registry armed as at startup. */
  const sidecarConfig = ({ sidecar = true, registered = true } = {}) => {
    const config = makeConfig();
    if (sidecar) config.markRuntimeStatusEnabled();
    if (registered) config.trackSessionRegistration(sharedRegistration());
    return config;
  };
  /** An initialized Config serving `server`, with MCP discovery settled. */
  const mcpReadyConfig = async (server: MCPServerConfig) => {
    const config = await initConfig({ mcpServers: { local: server } });
    const passes = mcpManagerOf(config).discoverAllMcpToolsIncremental;
    await config.waitForMcpReady();
    return { config, passes };
  };
  const SKIP_MOVE_SIDE_EFFECTS = {
    skipProcessChdir: true,
    skipArtifactMigration: true,
  };

  it('relocateWorkingDirectory should update the session working roots', async () => {
    const config = makeConfig();
    Object.assign(config, {
      memoryRecallMode: 'structured',
      memoryRecallModeInitialized: true,
      memoryCorpusRevision: 'old-project-revision',
    });
    vi.mocked(scanMemoryMetadataCorpusStatus).mockResolvedValueOnce({
      ready: false,
      revision: 'new-project-revision',
      files: 1,
      legacyFiles: 1,
      legacyByScope: { project: 1, user: 0, team: 0 },
    });
    const disposeResidentAgents = vi.spyOn(
      config.getBackgroundTaskRegistry(),
      'disposeResidentAgents',
    );
    const workspaceContext = config.getWorkspaceContext();
    const directoriesChanged = vi.fn();
    workspaceContext.onDirectoriesChanged(directoriesChanged);
    const cwd = mockProcessCwd(NEW_DIR);

    await config.relocateWorkingDirectory(NEW_DIR);

    expect(cwd.chdirSpy).toHaveBeenCalledWith(NEW_DIR);
    expect(config.getTargetDir()).toBe(NEW_DIR);
    expect(config.getProjectRoot()).toBe(NEW_DIR);
    expect(config.getCwd()).toBe(NEW_DIR);
    expect(config.getWorkingDir()).toBe(NEW_DIR);
    expect(config.getMemoryRecallMode()).toBe('legacy');
    expect(config.getWorkspaceContext()).toBe(workspaceContext);
    expect(config.getWorkspaceContext().getDirectories()[0]).toBe(NEW_DIR);
    expect(config.storage.getProjectRoot()).toBe(NEW_DIR);
    expect(disposeResidentAgents).toHaveBeenCalledOnce();
    expect(directoriesChanged).toHaveBeenCalled();
    expect(loadServerHierarchicalMemory).toHaveBeenCalledWith(
      NEW_DIR,
      expect.any(Array),
      expect.any(Object),
      expect.any(Array),
      expect.any(Boolean),
      expect.any(String),
      expect.any(Array),
      expect.any(Object),
    );
  });

  it('relocateWorkingDirectory should preserve leased storage for an ACP cwd change', async () => {
    const config = makeConfig();
    const generator = {} as ContentGenerator;
    internals(config).contentGenerator = generator;
    const originalStorage = config.storage;
    const originalPersistenceRoot = originalStorage.getProjectRoot();
    internals(config).chatRecordingService = { hasWriteOwnership: () => true };

    await expect(
      config.relocateWorkingDirectory(NEW_DIR, NEW_DIR, SKIP_MOVE_SIDE_EFFECTS),
    ).resolves.toEqual({});

    expect(config.getTargetDir()).toBe(NEW_DIR);
    expect(resetPreloadedContentGenerator).toHaveBeenCalledWith(generator);
    expect(config.storage).toBe(originalStorage);
    expect(config.getSessionService().getProjectRoot()).toBe(
      originalPersistenceRoot,
    );
    await expect(
      config.relocateWorkingDirectory(NEW_DIR),
    ).rejects.toMatchObject({
      errorKind: 'session_writer_unavailable',
    });
  });

  it('relocateWorkingDirectory should carry the session pr-bound callback to the fresh SessionService', async () => {
    // The callback is registered once at session init; relocation resets
    // sessionService, so a later `gh pr create` must still reach it.
    const config = makeConfig();
    const seen: Array<{ sessionId: string; number: number }> = [];
    config.getSessionService().setSessionPrBoundCallback((sessionId, pr) => {
      seen.push({ sessionId, number: pr.number });
    });

    await config.relocateWorkingDirectory(
      NEW_DIR,
      NEW_DIR,
      SKIP_MOVE_SIDE_EFFECTS,
    );

    config
      .getSessionService()
      .emitSessionPrBound('s1', { number: 2, url: 'https://x.y/o/r/pull/2' });

    expect(seen).toEqual([{ sessionId: 's1', number: 2 }]);
  });

  it('relocateWorkingDirectory should recreate cwd-derived file service', async () => {
    const config = makeConfig();
    mockProcessCwd(NEW_DIR);
    const fileServiceBefore = config.getFileService();

    await config.relocateWorkingDirectory(NEW_DIR);

    expect(config.getFileService()).not.toBe(fileServiceBefore);
  });

  it('relocateWorkingDirectory should reconcile MCP servers with the new session cwd', async () => {
    const { config, passes } = await mcpReadyConfig({
      command: 'node',
      args: ['server.js'],
    });
    passes.mockClear();
    mockProcessCwd(NEW_DIR);

    await expect(config.relocateWorkingDirectory(NEW_DIR)).resolves.toEqual({});

    expect(passes).toHaveBeenCalledOnce();
    expect(passes).toHaveBeenCalledWith(config);
  });

  it('relocateWorkingDirectory should report MCP reconcile failures after moving', async () => {
    const { config, passes } = await mcpReadyConfig({ command: 'node' });
    passes.mockRejectedValueOnce(new Error('MCP failed'));
    mockProcessCwd(NEW_DIR);

    const result = await config.relocateWorkingDirectory(NEW_DIR);

    expect(config.getTargetDir()).toBe(NEW_DIR);
    expect(result.mcpRefreshError).toEqual(new Error('MCP failed'));
  });

  it('relocateWorkingDirectory should continue after recording flush fails', async () => {
    const config = makeConfig();
    const finalize = vi.fn();
    const flush = vi.fn().mockRejectedValue(new Error('recording failed'));
    const resetStoragePaths = vi.fn();
    internals(config).chatRecordingService = {
      finalize,
      flush,
      resetStoragePaths,
      hasWriteOwnership: () => false,
    };
    mockProcessCwd(NEW_DIR);

    await expect(config.relocateWorkingDirectory(NEW_DIR)).resolves.toEqual({});

    expect(finalize).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledOnce();
    expect(resetStoragePaths).toHaveBeenCalledOnce();
    expect(config.getTargetDir()).toBe(NEW_DIR);
  });

  it('relocateWorkingDirectory should move current session artifacts to the new workspace', async () => {
    const config = recordingConfig();
    const { newChatsDir, from, to } = sessionArtifacts(config, [
      '.jsonl',
      '.runtime.json',
      '.worktree.json',
      '.pr.json',
    ]);
    mockProcessCwd(NEW_DIR);
    existingPaths(...from);

    await config.relocateWorkingDirectory(NEW_DIR);

    expect(fs.mkdirSync).toHaveBeenCalledWith(newChatsDir, {
      recursive: true,
    });
    from.forEach((oldPath, i) =>
      expect(fs.renameSync).toHaveBeenCalledWith(oldPath, to[i]),
    );
    expect(config.getTranscriptPath()).toBe(to[0]);
  });

  it('relocateWorkingDirectory should refresh runtime status after moving session artifacts', async () => {
    const config = sidecarConfig();
    const sessionId = config.getSessionId();
    const { oldRuntimeStatusPath, newRuntimeStatusPath } =
      runtimeStatusPaths(config);
    mockProcessCwd(NEW_DIR);
    const statusSpy = spyWriteStatus().mockResolvedValue(newRuntimeStatusPath);
    existingPaths(oldRuntimeStatusPath);

    // The registry patch rides its own chain and `/cd` deliberately does not
    // await it: the patch writes the HOME filesystem, and awaiting it would
    // hang `/cd` whenever HOME stalls while the project directory is healthy.
    // The settlement log pins that contract: `/cd` returns first, `ps`
    // settles a tick later.
    const settled: string[] = [];
    const patchSpy = spyPatch().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      settled.push('patch');
      return true;
    });

    await config.relocateWorkingDirectory(NEW_DIR);
    settled.push('relocated');

    expect(fs.renameSync).toHaveBeenCalledWith(
      oldRuntimeStatusPath,
      newRuntimeStatusPath,
    );
    expect(statusSpy).toHaveBeenCalledWith(newRuntimeStatusPath, {
      sessionId,
      workDir: NEW_DIR,
      qwenVersion: null,
    });
    // The registry's DIRECTORY column is how a user tells two live sessions
    // apart; the switch must reach it (and the directory-derived name) or
    // `qwen sessions ps` keeps showing the folder that was left.
    await vi.waitFor(() => {
      expect(patchSpy).toHaveBeenCalledWith(...movedPatch(sessionId));
      expect(settled).toContain('patch');
    });
    expect(settled[0]).toBe('relocated');
  });

  it('relocateWorkingDirectory should patch the registry even when the sidecar write failed at startup', async () => {
    // Mirror of the startNewSession divergence pin: registration writes to
    // the global dir, the sidecar to the project's chats/ dir — independent
    // failure domains, so registered-but-sidecar-off is reachable and the /cd
    // patch must survive it. No markRuntimeStatusEnabled(): the failed write.
    const config = sidecarConfig({ sidecar: false });
    const sessionId = config.getSessionId();
    mockProcessCwd(NEW_DIR);
    const statusSpy = spyWriteStatus().mockResolvedValue('unused');
    existingPaths();
    const patchSpy = spyPatch().mockResolvedValue(true);

    await config.relocateWorkingDirectory(NEW_DIR);

    // The patch rides its own fire-and-forget chain; let it settle.
    await vi.waitFor(() =>
      expect(patchSpy).toHaveBeenCalledWith(...movedPatch(sessionId)),
    );
    expect(statusSpy).not.toHaveBeenCalled();
  });

  it('relocateWorkingDirectory should refresh the sidecar even when registration failed', async () => {
    // The opposite divergence: the sidecar write succeeded at startup but
    // registerSession returned false (foreign-identity refusal, unwritable
    // global dir), so only the sidecar gate is armed. A gate regressed to
    // `if (!this.sessionRegistryActive) return;` would silently stop
    // refreshing runtime.json on /cd for these sessions.
    const config = sidecarConfig({ registered: false });
    const sessionId = config.getSessionId();
    const { oldRuntimeStatusPath, newRuntimeStatusPath } =
      runtimeStatusPaths(config);
    mockProcessCwd(NEW_DIR);
    const statusSpy = spyWriteStatus().mockResolvedValue(newRuntimeStatusPath);
    existingPaths(oldRuntimeStatusPath);
    const patchSpy = spyPatch().mockResolvedValue(true);

    await config.relocateWorkingDirectory(NEW_DIR);

    expect(statusSpy).toHaveBeenCalledWith(newRuntimeStatusPath, {
      sessionId,
      workDir: NEW_DIR,
      qwenVersion: null,
    });
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it('startNewSession patches the registry even when the sidecar write rejects', async () => {
    // The sidecar (project-local chats/) and the registry (global dir) are
    // independent failure domains: a sidecar write rejecting on a read-only
    // or full project filesystem must not skip the registry patch, or `ps`
    // advertises the pre-/clear session id until process exit.
    const config = sidecarConfig();
    spyWriteStatus().mockRejectedValue(new Error('read-only project fs'));
    const patchSpy = spyPatch().mockResolvedValue(true);

    const newSessionId = config.startNewSession('replacement-session');

    await vi.waitFor(() =>
      expect(patchSpy).toHaveBeenCalledWith(
        ...switchedPatch(config, newSessionId),
      ),
    );
  });

  it('serializes pending registration, transitions, and unregister', async () => {
    const config = makeConfig();
    const registration = deferred<sessionRegistry.SessionRegistration>();
    const patch = deferred<boolean>();
    const patchSpy = spyPatch().mockImplementation(() => patch.promise);
    const unregisterSpy = spyUnregister().mockResolvedValue(undefined);

    config.trackSessionRegistration(registration.promise);
    const newSessionId = config.startNewSession('replacement-session');
    const cleanup = config.unregisterSessionRegistry();

    expect(patchSpy).not.toHaveBeenCalled();
    expect(unregisterSpy).not.toHaveBeenCalled();

    registration.resolve({
      registered: true,
      slot: sessionRegistry.SHARED_RECORD_SLOT,
    });
    await vi.waitFor(() => {
      expect(patchSpy).toHaveBeenCalledWith(
        ...switchedPatch(config, newSessionId),
      );
    });
    expect(unregisterSpy).not.toHaveBeenCalled();

    patch.resolve(true);
    await cleanup;
    expect(unregisterSpy).toHaveBeenCalledTimes(1);
  });

  it('serializes the peer inbox address with session transitions', async () => {
    const config = await registeredConfig();
    const ipcPatch = deferred();
    const calls: Array<Record<string, unknown>> = [];
    spyPatch().mockImplementation(async (patch) => {
      calls.push(patch);
      if ('ipcPath' in patch) await ipcPatch.promise;
      return true;
    });

    const advertise = config.updateSessionRegistryIpcPath('/tmp/peer.sock');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const newSessionId = config.startNewSession('replacement-session');

    await Promise.resolve();
    expect(calls).toEqual([{ ipcPath: '/tmp/peer.sock' }]);

    ipcPatch.resolve();
    await advertise;
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual(switchedPatch(config, newSessionId)[0]);
  });

  /** A registered Config whose first registry patch is skipped. */
  const skippingOnceConfig = async () => {
    const config = await registeredConfig();
    const patchSpy = spyPatch()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    return { config, patchSpy };
  };

  it('retries the peer inbox advertise when the registry patch skips', async () => {
    // The advertise is one-shot: no later /clear or /cd re-asserts ipcPath,
    // so a patch skipped on transient fd pressure must retry itself or the
    // inbox stays undiscoverable until restart.
    const { config, patchSpy } = await skippingOnceConfig();

    await config.updateSessionRegistryIpcPath('/tmp/peer.sock');

    expect(patchSpy).toHaveBeenCalledTimes(2);
    expect(patchSpy).toHaveBeenCalledWith(
      { ipcPath: '/tmp/peer.sock' },
      sessionRegistry.SHARED_RECORD_SLOT,
    );
  });

  it('names the minted record a hosted session registered under, on every write', async () => {
    // A process hosting several sessions owns one record each. Every patch
    // and the final removal must name the right one: the default slot would
    // resolve to a `<pid>.json` such a process never wrote, so a hosted
    // session's record would never be updated nor removed.
    const config = makeConfig();
    config.trackSessionRegistration(
      Promise.resolve({ registered: true, slot: 'a1b2c3d4' }),
    );
    await expect(config.whenSessionRegistered()).resolves.toBe(true);
    expect(config.getSessionRegistrySlot()).toBe('a1b2c3d4');

    const patchSpy = spyPatch().mockResolvedValue(true);
    const unregisterSpy = spyUnregister().mockResolvedValue(undefined);

    await config.updateSessionRegistryIpcPath('/tmp/acp.sock', 'tok');
    expect(patchSpy).toHaveBeenLastCalledWith(
      { ipcPath: '/tmp/acp.sock', ipcToken: 'tok' },
      'a1b2c3d4',
    );

    config.startNewSession('replacement-session');
    await vi.waitFor(() =>
      expect(patchSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ sessionId: 'replacement-session' }),
        'a1b2c3d4',
      ),
    );

    await config.unregisterSessionRegistry();
    expect(unregisterSpy).toHaveBeenCalledWith('a1b2c3d4');
  });

  it('re-asserts the registry record with the current session id, retrying a skipped patch', async () => {
    // A peer message pinned to an id this process does not hold means the
    // record may be the stale side (a /clear patch skipped under fd
    // pressure); re-asserting is the fix, and it retries like the advertise.
    const { config, patchSpy } = await skippingOnceConfig();

    await config.reassertSessionRegistryRecord();

    expect(patchSpy).toHaveBeenCalledTimes(2);
    expect(patchSpy).toHaveBeenLastCalledWith(
      ...switchedPatch(config, config.getSessionId()),
    );
  });

  it('bounds the re-assert retry and is a no-op with no registration', async () => {
    const config = await registeredConfig();
    const patchSpy = spyPatch().mockResolvedValue(false);
    await expect(
      config.reassertSessionRegistryRecord(),
    ).resolves.toBeUndefined();
    expect(patchSpy).toHaveBeenCalledTimes(3);

    patchSpy.mockClear();
    await makeConfig().reassertSessionRegistryRecord();
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it('retries the /clear session-id patch when the registry skips it', async () => {
    const { config, patchSpy } = await skippingOnceConfig();

    const before = config.getSessionId();
    config.startNewSession();
    await config.unregisterSessionRegistry();

    expect(config.getSessionId()).not.toBe(before);
    const sessionPatches = patchSpy.mock.calls.filter(
      ([patch]) => 'sessionId' in (patch as object),
    );
    expect(sessionPatches).toHaveLength(2);
    expect(sessionPatches[1]?.[0]).toMatchObject({
      sessionId: config.getSessionId(),
    });
  });

  it('carries the inbox token into the record, on the first patch and the retry', async () => {
    // `toMatchObject`/`toEqual` treat { ipcPath } and { ipcPath, ipcToken:
    // undefined } as equal, so the one-arg call sites pass whether or not the
    // token is forwarded. Dropping ipcToken from either patch would publish
    // an address peers cannot authenticate to (sends read as 'sent' and are
    // silently dropped) with the suite still green. The first patch is
    // skipped, so the retry path carries the token too.
    const { config, patchSpy } = await skippingOnceConfig();

    await config.updateSessionRegistryIpcPath('/tmp/peer.sock', 'tok-xyz');

    expect(patchSpy).toHaveBeenCalledTimes(2);
    for (const [patch] of patchSpy.mock.calls) {
      expect(patch).toEqual({ ipcPath: '/tmp/peer.sock', ipcToken: 'tok-xyz' });
    }
  });

  it('gives up on the peer inbox advertise after a bounded retry', async () => {
    const config = await registeredConfig();
    const patchSpy = spyPatch().mockResolvedValue(false);

    await expect(
      config.updateSessionRegistryIpcPath('/tmp/peer.sock'),
    ).resolves.toBeUndefined();

    expect(patchSpy).toHaveBeenCalledTimes(3);
  });

  it('does not unregister when initial registration was refused', async () => {
    const config = makeConfig();
    const unregisterSpy = spyUnregister().mockResolvedValue(undefined);

    config.trackSessionRegistration(sharedRegistration(false));
    await config.unregisterSessionRegistry();

    expect(unregisterSpy).not.toHaveBeenCalled();
  });

  it('relocateWorkingDirectory patches the registry even when the sidecar write rejects', async () => {
    // The /cd-side mirror of the /clear pin: a rejecting sidecar write must
    // not skip the directory patch, nor surface through
    // relocateWorkingDirectory.
    const config = sidecarConfig();
    const sessionId = config.getSessionId();
    mockProcessCwd(NEW_DIR);
    spyWriteStatus().mockRejectedValue(new Error('read-only project fs'));
    existingPaths();
    const patchSpy = spyPatch().mockResolvedValue(true);

    await config.relocateWorkingDirectory(NEW_DIR);

    await vi.waitFor(() =>
      expect(patchSpy).toHaveBeenCalledWith(...movedPatch(sessionId)),
    );
  });

  it('relocateWorkingDirectory should reject and roll back when session artifact migration fails', async () => {
    const config = recordingConfig();
    const disposeResidentAgents = vi.spyOn(
      config.getBackgroundTaskRegistry(),
      'disposeResidentAgents',
    );
    const oldDir = config.getTargetDir();
    const {
      from: [oldTranscriptPath, oldRuntimeStatusPath],
      to: [newTranscriptPath, newRuntimeStatusPath],
    } = sessionArtifacts(config, ['.jsonl', '.runtime.json']);
    const moveError = new Error('move failed');
    const cwd = mockProcessCwd(NEW_DIR, oldDir);
    existingPaths(oldTranscriptPath, oldRuntimeStatusPath);
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (from === oldRuntimeStatusPath && to === newRuntimeStatusPath) {
        throw moveError;
      }
    });

    await expect(config.relocateWorkingDirectory(NEW_DIR)).rejects.toThrow(
      moveError,
    );

    expect(fs.renameSync).toHaveBeenCalledWith(
      oldTranscriptPath,
      newTranscriptPath,
    );
    expect(fs.renameSync).toHaveBeenCalledWith(
      newTranscriptPath,
      oldTranscriptPath,
    );
    expect(cwd.chdirSpy).toHaveBeenCalledWith(NEW_DIR);
    expect(cwd.chdirSpy).toHaveBeenCalledWith(oldDir);
    expect(config.getTargetDir()).toBe(oldDir);
    expect(config.storage.getProjectRoot()).toBe(oldDir);
    expect(config.getTranscriptPath()).toBe(oldTranscriptPath);
    expect(disposeResidentAgents).not.toHaveBeenCalled();
  });

  it('relocateWorkingDirectory should remove a partial EXDEV copy when source cleanup fails', async () => {
    const config = makeConfig();
    const oldDir = config.getTargetDir();
    const { oldRuntimeStatusPath, newRuntimeStatusPath } =
      runtimeStatusPaths(config);
    const cleanupError = new Error('cleanup failed');
    const exdevError = Object.assign(new Error('cross device'), {
      code: 'EXDEV',
    });
    const cwd = mockProcessCwd(NEW_DIR, oldDir);
    existingPaths(oldRuntimeStatusPath);
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (from === oldRuntimeStatusPath && to === newRuntimeStatusPath) {
        throw exdevError;
      }
    });
    vi.mocked(fs.unlinkSync).mockImplementation((pathToUnlink) => {
      if (pathToUnlink === oldRuntimeStatusPath) {
        throw cleanupError;
      }
    });

    await expect(config.relocateWorkingDirectory(NEW_DIR)).rejects.toThrow(
      cleanupError,
    );

    expect(fs.copyFileSync).toHaveBeenCalledWith(
      oldRuntimeStatusPath,
      newRuntimeStatusPath,
    );
    expect(fs.unlinkSync).toHaveBeenCalledWith(newRuntimeStatusPath);
    expect(cwd.chdirSpy).toHaveBeenCalledWith(oldDir);
    expect(config.getTargetDir()).toBe(oldDir);
  });

  it('relocateWorkingDirectory should reject and roll back when the final cwd differs from the expected path', async () => {
    const config = makeConfig();
    const oldDir = config.getTargetDir();
    const expectedDir = path.resolve('/path/to/confirmed');
    const cwd = mockProcessCwd(NEW_DIR, oldDir);

    await expect(
      config.relocateWorkingDirectory(NEW_DIR, expectedDir),
    ).rejects.toThrow(
      `Changed directory to ${NEW_DIR}, expected ${expectedDir}.`,
    );

    expect(cwd.chdirSpy).toHaveBeenCalledWith(NEW_DIR);
    expect(cwd.chdirSpy).toHaveBeenCalledWith(oldDir);
    expect(config.getTargetDir()).toBe(oldDir);
    expect(config.storage.getProjectRoot()).toBe(oldDir);
  });

  it('relocateWorkingDirectory should reject before mutating config when include directories are stale', async () => {
    const staleIncludeDir = path.resolve('/path/to/stale-include');
    const config = makeConfig({ includeDirectories: [staleIncludeDir] });
    const oldDir = config.getTargetDir();
    const cwd = mockProcessCwd(oldDir);
    vi.mocked(fs.existsSync).mockImplementation(
      (pathToCheck) => pathToCheck !== staleIncludeDir,
    );

    await expect(config.relocateWorkingDirectory(NEW_DIR)).rejects.toThrow(
      `Directory does not exist: ${staleIncludeDir}`,
    );

    expect(cwd.chdirSpy).not.toHaveBeenCalled();
    expect(config.getTargetDir()).toBe(oldDir);
    expect(config.storage.getProjectRoot()).toBe(oldDir);
    expect(config.getWorkspaceContext().getDirectories()[0]).toBe(oldDir);
  });

  it('relocateWorkingDirectory should return memory refresh failures after moving', async () => {
    const config = makeConfig();
    mockProcessCwd(NEW_DIR);
    vi.mocked(loadServerHierarchicalMemory).mockRejectedValueOnce(
      new Error('memory failed'),
    );

    const result = await config.relocateWorkingDirectory(NEW_DIR);

    expect(config.getTargetDir()).toBe(NEW_DIR);
    expect(result.memoryRefreshError).toEqual(new Error('memory failed'));
  });

  it('relocateWorkingDirectory should drop the stale structured memory prompt when the refresh fails', async () => {
    // The reset below clears the recall mode; the prompt paired with it must
    // go too, or a failed refresh leaves the session routing to search_memory
    // while the legacy mode leaves that tool undeclared.
    const config = new Config(baseParams);
    const newDir = path.resolve('/path/to/other');
    const chdirSpy = vi.spyOn(process, 'chdir').mockImplementation(() => {
      // Keep the test process in its original directory.
    });
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(newDir);
    Object.assign(config, {
      autoMemoryPrompt: 'structured prompt naming the old workspace',
      memoryRecallMode: 'structured',
    });
    vi.mocked(loadServerHierarchicalMemory).mockRejectedValueOnce(
      new Error('memory failed'),
    );

    const result = await config.relocateWorkingDirectory(newDir);

    expect(result.memoryRefreshError).toEqual(new Error('memory failed'));
    expect(config.getMemoryRecallMode()).toBe('legacy');
    expect(config.getAutoMemoryPrompt()).toBe('');

    chdirSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('relocateWorkingDirectory should report both memory and MCP refresh failures after moving', async () => {
    const { config, passes } = await mcpReadyConfig({ command: 'node' });
    passes.mockRejectedValueOnce(new Error('MCP failed'));
    vi.mocked(loadServerHierarchicalMemory).mockRejectedValueOnce(
      new Error('memory failed'),
    );
    mockProcessCwd(NEW_DIR);

    const result = await config.relocateWorkingDirectory(NEW_DIR);

    expect(config.getTargetDir()).toBe(NEW_DIR);
    expect(result.memoryRefreshError).toEqual(new Error('memory failed'));
    expect(result.mcpRefreshError).toEqual(new Error('MCP failed'));
  });

  it.each([
    [
      'refreshHierarchicalMemory should include empty memory prompt when no managed auto-memory index exists',
      true,
    ],
    [
      'refreshHierarchicalMemory should omit managed auto-memory prompt when disabled',
      false,
    ],
  ])('%s', async (_title, managed) => {
    const config = makeConfig(
      managed ? {} : { enableManagedAutoMemory: false },
    );
    loadProjectRules();
    vi.mocked(readAutoMemoryIndexWithStats).mockResolvedValue(null);

    await config.refreshHierarchicalMemory();

    expect(config.getUserMemory()).toContain('Project rules');
    expect(config.getUserMemory()).not.toContain('# auto memory');
    if (!managed) {
      expect(config.getAutoMemoryPrompt()).toBe('');
      expect(readAutoMemoryIndexWithStats).not.toHaveBeenCalled();
    } else {
      expect(config.getAutoMemoryPrompt()).toContain('# auto memory');
      expect(config.getAutoMemoryPrompt()).toContain(
        'MEMORY.md is currently empty',
      );
    }
  });

  /** The arguments of the most recent memory load. */
  const lastMemoryLoad = () =>
    vi.mocked(loadServerHierarchicalMemory).mock.calls.at(-1);

  it('refreshHierarchicalMemory should only use explicit inputs in bare mode', async () => {
    const config = makeConfig({ bareMode: true });
    loadProjectRules();

    await config.refreshHierarchicalMemory();

    const lastCall = lastMemoryLoad();
    expect(lastCall?.at(-1)).toMatchObject({ explicitOnly: true });
    expect(lastCall?.[1]).toEqual([]);
    expect(readAutoMemoryIndexWithStats).not.toHaveBeenCalled();
    expect(config.getUserMemory()).toContain('Project rules');
    expect(config.getAutoMemoryPrompt()).toBe('');
  });

  describe('isManagedMemoryAvailable', () => {
    it.each`
      title                                                    | params                                                 | expected
      ${'returns true when bareMode is false'}                 | ${{ bareMode: false }}                                 | ${true}
      ${'returns false when bareMode is true'}                 | ${{ bareMode: true }}                                  | ${false}
      ${'returns false when enableManagedAutoMemory is false'} | ${{ enableManagedAutoMemory: false, bareMode: false }} | ${false}
    `('%s', ({ params, expected }) => {
      expect(makeConfig(params).isManagedMemoryAvailable()).toBe(expected);
    });
  });

  it('refreshHierarchicalMemory should exclude implicit cwd from bare include-directories', async () => {
    const explicitDir = '/tmp/explicit';
    const config = makeConfig({
      bareMode: true,
      includeDirectories: [explicitDir],
      loadMemoryFromIncludeDirectories: true,
    });
    loadProjectRules();

    await config.refreshHierarchicalMemory();

    const lastCall = lastMemoryLoad();
    expect(lastCall?.[1]).toEqual([explicitDir]);
    expect(lastCall?.at(-1)).toMatchObject({ explicitOnly: true });
  });

  it('refreshHierarchicalMemory should fire InstructionsLoaded hooks from memory notifications', async () => {
    const config = makeConfig();
    const fireInstructionsLoadedEvent = vi.fn().mockResolvedValue(undefined);
    const signal = new AbortController().signal;
    internals(config).hookSystem = {
      runtimeId: 'test-hook-runtime',
      fireInstructionsLoadedEvent,
    };
    loadProjectRules();

    await config.refreshHierarchicalMemory('session_start', signal);

    const options = lastMemoryLoad()?.at(-1) as
      | LoadServerHierarchicalMemoryOptions
      | undefined;
    expect(options?.onInstructionsLoaded).toEqual(expect.any(Function));

    const related = {
      triggerFilePath: '/tmp/project/AGENTS.md',
      parentFilePath: '/tmp/project/AGENTS.md',
    };
    await options?.onInstructionsLoaded?.({
      filePath: '/tmp/project/QWEN.md',
      memoryType: 'project',
      loadReason: 'include',
      ...related,
    });

    expect(fireInstructionsLoadedEvent).toHaveBeenCalledWith(
      '/tmp/project/QWEN.md',
      'project',
      'include',
      related,
      signal,
    );
  });

  it('Config constructor should call setMemoryFilename with contextFileName if provided', () => {
    makeConfig({ contextFileName: 'CUSTOM_AGENTS.md' });
    expect(mockSetMemoryFilename).toHaveBeenCalledWith('CUSTOM_AGENTS.md');
  });

  it('Config constructor should not call setMemoryFilename if contextFileName is not provided', () => {
    new Config(baseParams); // baseParams does not have contextFileName
    expect(mockSetMemoryFilename).not.toHaveBeenCalled();
  });

  it('should set default file filtering settings when not provided', () => {
    const config = makeConfig();
    expect(config.getFileFilteringRespectGitIgnore()).toBe(true);
    expect(config.getFileFilteringOptions().customIgnoreFiles).toEqual([
      '.agentignore',
      '.aiignore',
    ]);
  });

  it('should set custom file filtering settings when provided', () => {
    const config = makeConfig({
      fileFiltering: {
        respectGitIgnore: false,
        customIgnoreFiles: ['.cursorignore'],
      },
    });
    expect(config.getFileFilteringRespectGitIgnore()).toBe(false);
    expect(config.getFileFilteringOptions().customIgnoreFiles).toEqual([
      '.cursorignore',
    ]);
    expect(config.getFileService().getQwenIgnoreFileNamesDisplay()).toBe(
      '.qwenignore, .cursorignore',
    );
  });

  it('should initialize WorkspaceContext with includeDirectories', () => {
    const directories = makeConfig({
      includeDirectories: ['/path/to/dir1', '/path/to/dir2'],
    })
      .getWorkspaceContext()
      .getDirectories();

    // The target directory plus the included directories.
    expect(directories).toHaveLength(3);
    expect(directories).toContain(path.resolve(baseParams.targetDir));
    expect(directories).toContain('/path/to/dir1');
    expect(directories).toContain('/path/to/dir2');
  });

  /** A Config whose parameters carry no `telemetry` key at all. */
  const withoutTelemetry = () => {
    const params: ConfigParameters = { ...baseParams };
    delete params.telemetry;
    return new Config(params);
  };
  const telemetryOn = () => ({ telemetry: { enabled: true } });
  it('Config constructor should set telemetry to true when provided as true', () => {
    const config = makeConfig(telemetryOn());
    expect(config.getTelemetryEnabled()).toBe(true);
    expect(config.isTelemetryInitializationDeferred()).toBe(false);
    expect(initializeTelemetry).toHaveBeenCalledWith(config);
  });

  it('Config constructor should defer telemetry initialization when requested', () => {
    const config = makeConfig({
      ...telemetryOn(),
      deferTelemetryInitialization: true,
    });

    expect(config.getTelemetryEnabled()).toBe(true);
    expect(config.isTelemetryInitializationDeferred()).toBe(true);
    expect(initializeTelemetry).not.toHaveBeenCalled();
  });

  it.each([
    ['flush telemetry when SDK is initialized', true, 1],
    ['skip telemetry shutdown before SDK initialization', false, 0],
  ])('Config shutdown should %s', async (_label, sdkInitialized, calls) => {
    vi.mocked(isTelemetrySdkInitialized).mockReturnValue(sdkInitialized);
    const config = makeConfig(telemetryOn());

    await config.shutdown();

    expect(shutdownTelemetry).toHaveBeenCalledTimes(calls);
  });

  it('Config constructor should set telemetry to false when provided as false', () => {
    expect(
      makeConfig({ telemetry: { enabled: false } }).getTelemetryEnabled(),
    ).toBe(false);
  });

  it('Config constructor should default telemetry to default value if not provided', () => {
    expect(withoutTelemetry().getTelemetryEnabled()).toBe(
      TELEMETRY_SETTINGS.enabled,
    );
  });

  it('Config exposes the telemetry user ID', () => {
    expect(
      makeConfig({
        telemetry: { enabled: true, userId: '  user-079458  ' },
      }).getTelemetryUserId(),
    ).toBe('user-079458');
  });

  it('Config omits the telemetry user ID by default', () => {
    expect(makeConfig(telemetryOn()).getTelemetryUserId()).toBeUndefined();
  });

  it('should have a getFileService method that returns FileDiscoveryService', () => {
    expect(makeConfig().getFileService()).toBeDefined();
  });

  describe('Usage Statistics', () => {
    it('defaults usage statistics to enabled if not specified', () => {
      const config = makeConfig({ usageStatisticsEnabled: undefined });

      expect(config.getUsageStatisticsEnabled()).toBe(true);
    });

    it.each([{ enabled: true }, { enabled: false }])(
      'sets usage statistics based on the provided value (enabled: $enabled)',
      ({ enabled }) => {
        const config = makeConfig({ usageStatisticsEnabled: enabled });
        expect(config.getUsageStatisticsEnabled()).toBe(enabled);
      },
    );

    it('logs the session start event', async () => {
      await initConfig({ usageStatisticsEnabled: true });

      expect(QwenLogger.prototype.logStartSessionEvent).toHaveBeenCalledOnce();
    });
  });

  describe('GitCoAuthor Settings', () => {
    /** getGitCoAuthor() for the given setting resolves to `commit` and `pr`. */
    const expectCoAuthor = (
      gitCoAuthor: ConfigParameters['gitCoAuthor'],
      commit: boolean,
      pr = commit,
    ) => {
      const settings = makeConfig({ gitCoAuthor }).getGitCoAuthor();
      expect(settings.commit).toBe(commit);
      expect(settings.pr).toBe(pr);
    };

    it('defaults both commit and pr to true when not specified', () => {
      expectCoAuthor(undefined, true);
    });

    it('accepts an object with independent commit and pr toggles', () => {
      expectCoAuthor({ commit: true, pr: false }, true, false);
    });

    // Legacy shape: before commit and PR attribution were split, this setting
    // was a single boolean governing both, so existing preferences carry over.
    it.each([true, false])(
      'coerces legacy boolean %s to { commit, pr } with the same value',
      (value) => {
        expectCoAuthor(value, value);
      },
    );

    // settings.json is hand-editable: without intent-aware string parsing a
    // hand-edited `{ commit: "false" }` would inflate to `commit: true` (the
    // old "default-to-true on mismatch" policy). Honor common disable-intent
    // strings and fall through to disabled on unrecognisable input — safer
    // than turning attribution on against the user's clear opt-out.
    it.each([
      // Disable-intent strings.
      ['string "false"', 'false', false],
      ['string "FALSE"', 'FALSE', false],
      ['string "no"', 'no', false],
      ['string "off"', 'off', false],
      ['string "0"', '0', false],
      ['empty string', '', false],
      // Enable-intent strings.
      ['string "true"', 'true', true],
      ['string "yes"', 'yes', true],
      ['string "on"', 'on', true],
      ['string "1"', '1', true],
      // Numbers.
      ['number 1', 1, true],
      ['number 0', 0, false],
      ['number 42', 42, false],
      // Other types fall through to disabled.
      ['null', null, false],
      ['object', {}, false],
      ['array', [], false],
      // Unknown strings → disabled (don't quietly enable).
      ['unknown string', 'maybe', false],
    ])(
      'parses %s as %s for both commit and pr',
      (_label, badValue, expected) => {
        const value = badValue as unknown as boolean;
        expectCoAuthor({ commit: value, pr: value }, expected);
      },
    );

    // A genuinely-absent sub-field still defaults to true (schema default).
    it('defaults absent commit/pr to true', () => {
      expectCoAuthor({} as { commit?: boolean; pr?: boolean }, true);
    });
  });

  describe('Telemetry Settings', () => {
    const withTelemetry = (telemetry: ConfigParameters['telemetry']) =>
      makeConfig({ telemetry });
    it.each`
      title                                                                | telemetry                                                               | read                                                              | expected
      ${'should return default telemetry target if not provided'}          | ${{ enabled: true }}                                                    | ${(c: Config) => c.getTelemetryTarget()}                          | ${DEFAULT_TELEMETRY_TARGET}
      ${'should return provided OTLP endpoint'}                            | ${{ enabled: true, otlpEndpoint: 'http://custom.otel.collector:4317' }} | ${(c: Config) => c.getTelemetryOtlpEndpoint()}                    | ${'http://custom.otel.collector:4317'}
      ${'should return default OTLP endpoint if not provided'}             | ${{ enabled: true }}                                                    | ${(c: Config) => c.getTelemetryOtlpEndpoint()}                    | ${DEFAULT_OTLP_ENDPOINT}
      ${'should return provided logPrompts setting'}                       | ${{ enabled: true, logPrompts: false }}                                 | ${(c: Config) => c.getTelemetryLogPromptsEnabled()}               | ${false}
      ${'should return default logPrompts setting (true) if not provided'} | ${{ enabled: true }}                                                    | ${(c: Config) => c.getTelemetryLogPromptsEnabled()}               | ${true}
      ${'should return provided includeSensitiveSpanAttributes setting'}   | ${{ enabled: true, includeSensitiveSpanAttributes: true }}              | ${(c: Config) => c.getTelemetryIncludeSensitiveSpanAttributes()}  | ${true}
      ${'should default includeSensitiveSpanAttributes to false'}          | ${{ enabled: true }}                                                    | ${(c: Config) => c.getTelemetryIncludeSensitiveSpanAttributes()}  | ${false}
      ${'should return provided sensitiveSpanAttributeMaxLength setting'}  | ${{ enabled: true, sensitiveSpanAttributeMaxLength: 65_536 }}           | ${(c: Config) => c.getTelemetrySensitiveSpanAttributeMaxLength()} | ${65_536}
      ${'should default sensitiveSpanAttributeMaxLength to 1MiB'}          | ${{ enabled: true }}                                                    | ${(c: Config) => c.getTelemetrySensitiveSpanAttributeMaxLength()} | ${1024 * 1024}
      ${'should return provided OTLP protocol'}                            | ${{ enabled: true, otlpProtocol: 'http' }}                              | ${(c: Config) => c.getTelemetryOtlpProtocol()}                    | ${'http'}
      ${'should return default OTLP protocol if not provided'}             | ${{ enabled: true }}                                                    | ${(c: Config) => c.getTelemetryOtlpProtocol()}                    | ${'grpc'}
    `('%s', ({ telemetry, read, expected }) => {
      expect(read(withTelemetry(telemetry))).toBe(expected);
    });

    it.each`
      title                                                                                    | read                                                              | expected
      ${'should return default logPrompts setting (true) if telemetry object is not provided'} | ${(c: Config) => c.getTelemetryLogPromptsEnabled()}               | ${true}
      ${'should default includeSensitiveSpanAttributes to false'}                              | ${(c: Config) => c.getTelemetryIncludeSensitiveSpanAttributes()}  | ${false}
      ${'should default sensitiveSpanAttributeMaxLength to 1MiB'}                              | ${(c: Config) => c.getTelemetrySensitiveSpanAttributeMaxLength()} | ${1024 * 1024}
      ${'should return default telemetry target if telemetry object is not provided'}          | ${(c: Config) => c.getTelemetryTarget()}                          | ${DEFAULT_TELEMETRY_TARGET}
      ${'should return default OTLP endpoint if telemetry object is not provided'}             | ${(c: Config) => c.getTelemetryOtlpEndpoint()}                    | ${DEFAULT_OTLP_ENDPOINT}
      ${'should return default OTLP protocol if telemetry object is not provided'}             | ${(c: Config) => c.getTelemetryOtlpProtocol()}                    | ${'grpc'}
    `('%s (no telemetry object)', ({ read, expected }) => {
      expect(read(withoutTelemetry())).toBe(expected);
    });

    it('should reject invalid sensitiveSpanAttributeMaxLength values', () => {
      for (const [value, label] of [
        [0, '0'],
        [Number.NaN, 'NaN'],
        [Number.POSITIVE_INFINITY, 'Infinity'],
        [
          SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH_LIMIT + 1,
          String(SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH_LIMIT + 1),
        ],
      ] as const) {
        expect(() =>
          withTelemetry({
            enabled: true,
            sensitiveSpanAttributeMaxLength: value,
          }),
        ).toThrow(
          new RegExp(
            `Invalid telemetry\\.sensitiveSpanAttributeMaxLength.*got ${label}`,
          ),
        );
      }
    });
  });

  describe('Per-Signal OTLP Endpoint Configuration', () => {
    it('should return per-signal endpoints when provided', () => {
      const traces = 'http://traces:4318/v1/traces';
      const logs = 'http://logs:4318/v1/logs';
      const metrics = 'http://metrics:4318/v1/metrics';
      const config = makeConfig({
        telemetry: {
          enabled: true,
          otlpTracesEndpoint: traces,
          otlpLogsEndpoint: logs,
          otlpMetricsEndpoint: metrics,
        },
      });
      expect(config.getTelemetryOtlpTracesEndpoint()).toBe(traces);
      expect(config.getTelemetryOtlpLogsEndpoint()).toBe(logs);
      expect(config.getTelemetryOtlpMetricsEndpoint()).toBe(metrics);
    });

    it('should return undefined when per-signal endpoints are not provided', () => {
      const config = makeConfig({ telemetry: { enabled: true } });
      expect(config.getTelemetryOtlpTracesEndpoint()).toBeUndefined();
      expect(config.getTelemetryOtlpLogsEndpoint()).toBeUndefined();
      expect(config.getTelemetryOtlpMetricsEndpoint()).toBeUndefined();
    });
  });

  describe('OutboundCorrelation Configuration', () => {
    // Default-to-false is security-relevant — controls whether
    // `traceparent` is written onto outbound LLM/fetch request streams.
    it.each<{
      label: string;
      outboundCorrelation: ConfigParameters['outboundCorrelation'];
      expected: boolean;
    }>([
      { label: 'omitted', outboundCorrelation: undefined, expected: false },
      { label: 'empty object', outboundCorrelation: {}, expected: false },
      {
        label: 'explicit true',
        outboundCorrelation: { propagateTraceContext: true },
        expected: true,
      },
      {
        label: 'explicit false',
        outboundCorrelation: { propagateTraceContext: false },
        expected: false,
      },
    ])(
      'propagateTraceContext resolves to $expected when $label',
      ({ outboundCorrelation, expected }) => {
        const config = makeConfig({ outboundCorrelation });
        expect(config.getOutboundCorrelationPropagateTraceContext()).toBe(
          expected,
        );
      },
    );

    it('only enables dynamic header values for boolean true', () => {
      for (const value of [undefined, false, 'false', 1, {}, []]) {
        const outboundCorrelation = {
          allowDynamicHeaderValues: value,
        } as unknown as ConfigParameters['outboundCorrelation'];
        const config = makeConfig({ outboundCorrelation });
        expect(config.getOutboundAllowDynamicHeaderValues()).toBe(false);
      }

      const config = makeConfig({
        outboundCorrelation: { allowDynamicHeaderValues: true },
      });
      expect(config.getOutboundAllowDynamicHeaderValues()).toBe(true);
    });
  });

  describe('UseRipgrep Configuration', () => {
    it.each`
      title                                                               | params                       | expected
      ${'should default useRipgrep to true when not provided'}            | ${{}}                        | ${true}
      ${'should set useRipgrep to false when provided as false'}          | ${{ useRipgrep: false }}     | ${false}
      ${'should set useRipgrep to true when explicitly provided as true'} | ${{ useRipgrep: true }}      | ${true}
      ${'should default useRipgrep to true when undefined'}               | ${{ useRipgrep: undefined }} | ${true}
    `('%s', ({ params, expected }) => {
      expect(makeConfig(params).getUseRipgrep()).toBe(expected);
    });
  });

  describe('UseBuiltinRipgrep Configuration', () => {
    it.each`
      title                                                                      | params                              | expected
      ${'should default useBuiltinRipgrep to true when not provided'}            | ${{}}                               | ${true}
      ${'should set useBuiltinRipgrep to false when provided as false'}          | ${{ useBuiltinRipgrep: false }}     | ${false}
      ${'should set useBuiltinRipgrep to true when explicitly provided as true'} | ${{ useBuiltinRipgrep: true }}      | ${true}
      ${'should default useBuiltinRipgrep to true when undefined'}               | ${{ useBuiltinRipgrep: undefined }} | ${true}
    `('%s', ({ params, expected }) => {
      expect(makeConfig(params).getUseBuiltinRipgrep()).toBe(expected);
    });
  });

  describe('Response tokens/sec display configuration', () => {
    it.each`
      title                                                             | params                                   | expected
      ${'should default to false when not provided'}                    | ${{}}                                    | ${false}
      ${'should set showResponseTokensPerSecond when provided as true'} | ${{ showResponseTokensPerSecond: true }} | ${true}
    `('%s', ({ params, expected }) => {
      expect(makeConfig(params).getShowResponseTokensPerSecond()).toBe(
        expected,
      );
    });
  });

  describe('createToolRegistry', () => {
    const registerFactory = () =>
      vi.mocked(ToolRegistry.prototype.registerFactory);
    const registerDeferred = () =>
      vi.mocked(ToolRegistry.prototype.registerPermissionDeferredFactory);
    const BARE_TOOLS = [
      ToolNames.READ_FILE,
      ToolNames.EDIT,
      ToolNames.NOTEBOOK_EDIT,
      ToolNames.SHELL,
    ];
    const BARE_REGISTRY = [
      ...BARE_TOOLS,
      ToolNames.GET_GOAL,
      ToolNames.UPDATE_GOAL,
    ];
    const jsonSchema = {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
    };
    const sshEnvironment = () =>
      new SshExecutionEnvironment(
        { host: 'host', directory: '/srv/project' },
        '/local/anchor',
      );
    /** Built-ins without a Grep override, with tools.eager set to `eagerTools`. */
    const eagerParams = (
      eagerTools: string[],
      extra: Partial<ConfigParameters> = {},
    ) => ({ useRipgrep: false, coreTools: undefined, ...extra, eagerTools });

    it('uses a main-session execution environment and disposes it once', async () => {
      const environment = sshEnvironment();
      const dispose = vi
        .spyOn(environment, 'dispose')
        .mockResolvedValue(undefined);
      const config = makeConfig({
        executionEnvironment: environment,
        jsonSchema,
        todoWriteEnabled: true,
        mcpServers: { local: { command: 'must-not-start' } },
      });
      expect(config.getExecutionEnvironment()).toBe(environment);
      expect(config.getMcpServers()).toEqual({});
      await config.createToolRegistry();
      expectTools(
        registeredToolNames(),
        [
          ToolNames.READ_FILE,
          ToolNames.SHELL,
          ToolNames.STRUCTURED_OUTPUT,
          ToolNames.WEB_FETCH,
          ToolNames.GET_GOAL,
          ToolNames.UPDATE_GOAL,
          ToolNames.TODO_WRITE,
        ],
        [
          ToolNames.TASK_STOP,
          ToolNames.NOTEBOOK_EDIT,
          ToolNames.CREATE_SUB_SESSION,
        ],
      );
      await config.shutdownExecutionEnvironments();
      await config.shutdownExecutionEnvironments();
      expect(dispose).toHaveBeenCalledOnce();
    });
    it('skips host project hooks, skills, extensions and memory during SSH initialization', async () => {
      const config = makeConfig({
        executionEnvironment: sshEnvironment(),
        enableAutoSkill: true,
      });
      const refreshExtensions = vi.spyOn(
        config.getExtensionManager(),
        'refreshCache',
      );
      await config.initialize(SKIP_LLM_INIT);
      await config.refreshHierarchicalMemory();
      expect(HookSystem).not.toHaveBeenCalled();
      expect(SkillManager.prototype.startWatching).not.toHaveBeenCalled();
      expect(SkillManager.prototype.refreshCache).not.toHaveBeenCalled();
      expect(refreshExtensions).not.toHaveBeenCalled();
      expect(loadServerHierarchicalMemory).not.toHaveBeenCalled();
      await config.shutdown();
    });

    it('registers zoom_image unconditionally so it survives model switches', async () => {
      const config = makeConfig();
      // A first-run / text-only session reports no image modality, yet the tool
      // must still register: the gate moved to execute time so a hot /model
      // switch to an image model picks it up without re-running initialize().
      vi.spyOn(config, 'getEffectiveInputModalities').mockReturnValue({});

      await config.initialize();

      expect(registeredToolNames()).toContain(ToolNames.ZOOM_IMAGE);
    });

    it('does not register create_sub_session without a wired spawner', async () => {
      // The tool only works under `qwen serve`, where the ACP session wires a
      // spawner; declaring it everywhere polluted interactive/headless action
      // spaces with a tool that can never succeed there.
      await initConfig();

      // Both entry points: a regression re-adding the tool eagerly via
      // `registry.registerTool(new CreateSubSessionTool(this))` never touches
      // `registerFactory`.
      expect(registeredToolNames()).not.toContain(ToolNames.CREATE_SUB_SESSION);
      expect(
        vi
          .mocked(ToolRegistry.prototype.registerTool)
          .mock.calls.map(([tool]) => tool?.name),
      ).not.toContain(ToolNames.CREATE_SUB_SESSION);
    });

    it('registers create_sub_session on a subagent registry rebuilt after the spawner is wired', async () => {
      // The daemon ACP session wires the spawner only after its own registry
      // exists, so a later subagent rebuild must pick the tool up here
      // (`copyDiscoveredToolsFrom` never carries built-ins). The rebuild runs
      // on an `Object.create(base)` override, reaching the spawner through
      // prototype delegation.
      const config = await initConfig();
      expect(registeredToolNames()).not.toContain(ToolNames.CREATE_SUB_SESSION);

      config.setSubSessionSpawner(async () => ({ sessionId: 'sub' }));
      registerFactory().mockClear();
      await rebuildForSubAgent(Object.create(config) as Config);

      expect(registeredToolNames()).toContain(ToolNames.CREATE_SUB_SESSION);
    });

    // 'does not register list_directory just because a permission rule covers
    // it (#10075)' pins the reverted #9829 side effect: `permissions.allow` /
    // `ask` used to opt this tool in at registration. They are pure
    // auto-approval now, so only `tools.listDirectory.enabled` or `coreTools`
    // can open the opt-in gate. The #9827 row: without an allowlist ordinary
    // built-ins are not gated at registry level, but opt-in tools stay off.
    it.each`
      title                                                                                            | params                                                                                 | has                                                                                      | lacks
      ${'does not register list_directory by default (opt-in tool)'}                                   | ${{}}                                                                                  | ${[]}                                                                                    | ${[ToolNames.LS]}
      ${'registers list_directory when lsToolEnabled is true'}                                         | ${{ lsToolEnabled: true }}                                                             | ${[ToolNames.LS]}                                                                        | ${[]}
      ${'does not register todo_write by default'}                                                     | ${{}}                                                                                  | ${[]}                                                                                    | ${[ToolNames.TODO_WRITE]}
      ${'registers todo_write when todoWriteEnabled is true'}                                          | ${{ todoWriteEnabled: true }}                                                          | ${[ToolNames.TODO_WRITE]}                                                                | ${[]}
      ${'registers list_directory when listed in coreTools via the canonical name'}                    | ${{ coreTools: [ToolNames.READ_FILE, ToolNames.LS] }}                                  | ${[ToolNames.LS]}                                                                        | ${[]}
      ${'registers list_directory when listed in coreTools via an alias'}                              | ${{ coreTools: [ToolNames.READ_FILE, 'ListFiles'] }}                                   | ${[ToolNames.LS]}                                                                        | ${[]}
      ${'registers list_directory when listed in coreTools via a path specifier'}                      | ${{ coreTools: [ToolNames.READ_FILE, `${ToolNames.LS}(/src)`] }}                       | ${[ToolNames.LS]}                                                                        | ${[]}
      ${'does not register list_directory just because a permission rule covers it (#10075)'}          | ${{ coreTools: undefined, permissions: { allow: ['ListFiles'], ask: ['ListFiles'] } }} | ${[]}                                                                                    | ${[ToolNames.LS]}
      ${'should register a tool if coreTools contains an argument-specific pattern'}                   | ${{ coreTools: ['Shell(git status)'] }}                                                | ${[ToolNames.SHELL]}                                                                     | ${[ToolNames.READ_FILE]}
      ${'should register a tool if coreTools contains the displayName'}                                | ${{ coreTools: ['Shell'] }}                                                            | ${[ToolNames.SHELL]}                                                                     | ${[]}
      ${'should register a tool if coreTools contains the displayName with argument-specific pattern'} | ${{ coreTools: ['Shell(git status)'] }}                                                | ${[ToolNames.SHELL]}                                                                     | ${[]}
      ${'should register a tool if coreTools contains a legacy tool name alias'}                       | ${{ useRipgrep: false, coreTools: ['search_file_content'] }}                           | ${[ToolNames.GREP]}                                                                      | ${[]}
      ${'should not register a tool if excludeTools contains a legacy display name alias'}             | ${{ useRipgrep: false, coreTools: undefined, excludeTools: ['SearchFiles'] }}          | ${[]}                                                                                    | ${[ToolNames.GREP]}
      ${'registers the full built-in set when no permissionsAllow is set (#9827 regression guard)'}    | ${{ useRipgrep: false, coreTools: undefined }}                                         | ${[ToolNames.SEND_MESSAGE, ToolNames.UPDATE_GOAL, ToolNames.AGENT, ToolNames.READ_FILE]} | ${[ToolNames.TODO_WRITE]}
    `('%s', async ({ params, has, lacks }) => {
      await initConfig(params);
      expectTools(registeredToolNames(), has, lacks);
    });

    it('should ignore coreTools overrides in bare mode', async () => {
      const config = await initConfig({
        bareMode: true,
        coreTools: [ToolNames.WEB_FETCH],
      });

      expect(config.getCoreTools()).toEqual(BARE_TOOLS);
      expect(registeredToolNames()).toEqual(BARE_REGISTRY);
      expect(registeredToolNames()).not.toContain(ToolNames.SEARCH_MEMORY);
    });

    it('should register structured memory tools in the normal tool registry', async () => {
      const config = new Config(baseParams);
      await config.initialize();

      const registerToolMock = (
        (await vi.importMock('../tools/tool-registry')) as {
          ToolRegistry: { prototype: { registerFactory: Mock } };
        }
      ).ToolRegistry.prototype.registerFactory;

      const registeredNames = (registerToolMock as Mock).mock.calls.map(
        (call) => call[0],
      );
      expect(registeredNames).toContain(ToolNames.SEARCH_MEMORY);
      expect(registeredNames).toContain(ToolNames.MANAGE_MEMORY);
    });

    it('registers structured_output in bare mode when jsonSchema is set', async () => {
      // Bare mode strips the toolset to READ_FILE/EDIT/NOTEBOOK_EDIT/SHELL, but
      // the synthetic structured_output tool is the terminal contract for
      // --json-schema runs: without it the model loops until maxSessionTurns
      // and exits via the "plain text" failure path, expensive in tokens for
      // what is almost always a CI use case.
      await initConfig({ bareMode: true, jsonSchema });

      expect(registeredToolNames()).toEqual([
        ...BARE_REGISTRY,
        ToolNames.STRUCTURED_OUTPUT,
      ]);
    });

    it('does NOT register structured_output when createToolRegistry is called with forSubAgent=true', async () => {
      // Subagent overrides reuse the parent Config via prototype delegation
      // (createApprovalModeOverride / buildSubagentContextOverride →
      // Object.create(base)) and rebuild with `forSubAgent: true`. Although
      // `this.jsonSchema` propagates, the synthetic tool MUST NOT register
      // there: only runNonInteractive's main / drain loops treat a successful
      // structured_output call as terminal, so a subagent would get "Session
      // will end now" and keep running — wasted tokens, no payload on stdout.
      const config = await initConfig({ bareMode: true, jsonSchema });
      // Reset so only the forSubAgent rebuild's calls are observed.
      registerFactory().mockClear();

      await rebuildForSubAgent(config);

      const registeredNames = registeredToolNames();
      expect(registeredNames).not.toContain(ToolNames.STRUCTURED_OUTPUT);
      // The bare tools still register so the subagent has its toolset.
      expect(registeredNames).toEqual(BARE_TOOLS);
    });

    // The leader-only property of request_shutdown is "enforced by absence":
    // a teammate's registry never contains it, so the call cannot be formed.
    // That only holds if the skip actually fires, which nothing asserted.
    it('registers request_shutdown for a leader but not for a subagent', async () => {
      const config = await initConfig({ agentTeamEnabled: true });
      expect(registeredToolNames()).toContain(ToolNames.REQUEST_SHUTDOWN);

      registerFactory().mockClear();
      await rebuildForSubAgent(config);

      const subagentNames = registeredToolNames();
      expect(subagentNames).not.toContain(ToolNames.REQUEST_SHUTDOWN);
      // The rest of the team surface still registers — only the leader-only
      // control tool is withheld.
      expect(subagentNames).toContain(ToolNames.SEND_MESSAGE);
    });

    const qwenPlusOnDashscope = {
      id: 'qwen3.6-plus',
      baseUrl: DASHSCOPE_URL,
      envKey: 'DASHSCOPE_API_KEY',
    };
    const webSearchNotices = (config: Config) =>
      config.getWarnings().filter((w) => w.includes('WebSearch'));

    // The env-only DashScope row has no modelProviders entry: the endpoint
    // comes from OPENAI_BASE_URL and the key variable is the auth type's
    // default (what the CLI resolver builds from OPENAI_BASE_URL /
    // OPENAI_API_KEY). The runtime model snapshot is captured only after the
    // registry is built, so the gate must read the resolved generation config.
    it.each`
      title                                                                                                     | env                                        | params                                                                                                                                                                                                                                                                 | registered
      ${'registers web_search when enabled with a usable env-declared backend'}                                 | ${{ WEB_SEARCH_GATE_TEST_KEY: 'sk-test' }} | ${{ webSearch: { enabled: true, model: 'qwen3.6-plus', baseUrl: DASHSCOPE_URL, apiKeyEnv: 'WEB_SEARCH_GATE_TEST_KEY' } }}                                                                                                                                              | ${true}
      ${'does not register web_search or push a notice when nothing is configured and no provider can back it'} | ${{}}                                      | ${{}}                                                                                                                                                                                                                                                                  | ${false}
      ${'registers web_search with no configuration when the primary model runs on a ModelStudio provider'}     | ${{ DASHSCOPE_API_KEY: 'sk-test' }}        | ${{ authType: AuthType.USE_OPENAI, model: 'qwen3.6-plus', modelProvidersConfig: { openai: [qwenPlusOnDashscope] } }}                                                                                                                                                   | ${true}
      ${'registers web_search for an env-only configuration pointing at a DashScope host'}                      | ${{ OPENAI_API_KEY: 'sk-env-only' }}       | ${{ authType: AuthType.USE_OPENAI, model: 'qwen3.6-plus', generationConfig: { authType: AuthType.USE_OPENAI, model: 'qwen3.6-plus', baseUrl: DASHSCOPE_URL, apiKey: 'sk-env-only' }, generationConfigSources: { apiKey: { kind: 'env', envKey: 'OPENAI_API_KEY' } } }} | ${true}
      ${'leaves web_search off for an env-only configuration on a non-DashScope host'}                          | ${{ OPENAI_API_KEY: 'sk-env-only' }}       | ${{ authType: AuthType.USE_OPENAI, model: 'gpt-5', generationConfig: { authType: AuthType.USE_OPENAI, model: 'gpt-5', baseUrl: OPENAI_URL } }}                                                                                                                         | ${false}
      ${'leaves web_search off without a notice when the primary model runs on a provider that cannot back it'} | ${{ OPENROUTER_API_KEY: 'sk-or-test' }}    | ${{ authType: AuthType.USE_OPENAI, model: 'z-ai/glm-4.5-air:free', modelProvidersConfig: { openai: [{ id: 'z-ai/glm-4.5-air:free', baseUrl: 'https://openrouter.ai/api/v1', envKey: 'OPENROUTER_API_KEY' }] } }}                                                       | ${false}
      ${'does not register web_search when it is turned off explicitly'}                                        | ${{ DASHSCOPE_API_KEY: 'sk-test' }}        | ${{ authType: AuthType.USE_OPENAI, model: 'qwen3.6-plus', modelProvidersConfig: { openai: [qwenPlusOnDashscope] }, webSearch: { enabled: false } }}                                                                                                                    | ${false}
    `('%s', async ({ env, params, registered }) => {
      for (const [key, value] of Object.entries(env)) {
        vi.stubEnv(key, value as string);
      }
      try {
        const config = await initConfig(params);

        if (registered) {
          expect(registeredToolNames()).toContain(ToolNames.WEB_SEARCH);
        } else {
          expect(registeredToolNames()).not.toContain(ToolNames.WEB_SEARCH);
        }
        expect(webSearchNotices(config)).toEqual([]);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('does not activate a legacy model-only web search configuration', async () => {
      vi.stubEnv('DASHSCOPE_API_KEY', 'sk-test');
      try {
        await initConfig({
          authType: AuthType.USE_OPENAI,
          model: 'qwen3.6-plus',
          modelProvidersConfig: { openai: [qwenPlusOnDashscope] },
          webSearch: { model: 'qwen3.6-plus' },
        });
        expect(registeredToolNames()).not.toContain(ToolNames.WEB_SEARCH);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('pushes a one-time notice when web_search is enabled but misconfigured', async () => {
      // Enabled without a model: the tool must stay off with a diagnostic
      // notice, pushed exactly once across registry rebuilds.
      const config = await initConfig({ webSearch: { enabled: true } });
      expect(registeredToolNames()).not.toContain(ToolNames.WEB_SEARCH);

      expect(webSearchNotices(config)).toHaveLength(1);
      expect(webSearchNotices(config)[0]).toContain('no search model');

      // A registry rebuild must not duplicate the notice.
      await config.createToolRegistry(undefined, { skipDiscovery: true });
      expect(webSearchNotices(config)).toHaveLength(1);
    });

    // ── #9827 / #10075: tools.eager keeps unlisted schemas out of the eager
    // model request, but demotes (not removes) the unlisted tools ──
    it('registers tools.eager entries eagerly and demotes the rest to deferred (#9827, #10075)', async () => {
      // Mirrors the CLI wiring. `permissions.allow` is deliberately unset: the
      // eager/deferred split is driven solely by tools.eager (#10075).
      await initConfig(
        eagerParams(
          [
            'ReadFile',
            'WriteFile',
            'Edit',
            'Grep',
            'Glob',
            'ListFiles',
            'Shell',
            'WebFetch',
          ],
          { todoWriteEnabled: true },
        ),
      );

      const registered = registeredToolNames();
      const deferred = deferredToolNames();
      // Unlisted built-ins never reach the eager request (#9827), but since
      // #10075 they are demoted to deferred rather than dropped: still listed
      // in /tools and reachable via ToolSearch + ToolCall.
      const demoted = [
        ToolNames.SEND_MESSAGE,
        ToolNames.UPDATE_GOAL,
        ToolNames.GET_GOAL,
        ToolNames.LOOP_WAKEUP,
        ToolNames.READ_MCP_RESOURCE,
        ToolNames.AGENT,
        ToolNames.TODO_WRITE,
      ];

      expectTools(
        registered,
        [
          ToolNames.READ_FILE,
          ToolNames.WRITE_FILE,
          ToolNames.EDIT,
          ToolNames.GREP,
          ToolNames.GLOB,
          ToolNames.SHELL,
          ToolNames.WEB_FETCH,
        ],
        demoted,
      );
      expectTools(deferred, [...demoted, ToolNames.SKILL]);
      // monitor stays eager: the "Shell" allow rule covers it so the shell
      // tool cannot be bypassed by switching to monitor.
      expect(registered).toContain(ToolNames.MONITOR);
      // tools.eager never promotes a disabled tool into existence: LS is
      // listed, but its registration stays gated on isLsToolEnabled()
      // (tools.listDirectory.enabled / coreTools), off here, so the eager path
      // must neither register nor defer it.
      expect(registered).not.toContain(ToolNames.LS);
      expect(deferred).not.toContain(ToolNames.LS);
    });

    it('demotes an enabled LS to deferred when tools.eager omits it (#9827, #10075)', async () => {
      // Companion to the test above: LS enabled via tools.listDirectory.enabled
      // but omitted from the eager list (and covered by no listed
      // meta-category — only "Shell" is listed) must be demoted via
      // registerPermissionDeferredFactory, never promoted to eager.
      await initConfig(eagerParams(['Shell'], { lsToolEnabled: true }));

      expect(registeredToolNames()).not.toContain(ToolNames.LS);
      expect(deferredToolNames()).toContain(ToolNames.LS);
    });

    it('registers an enabled LS eagerly when tools.eager covers it (#10400)', async () => {
      // Third cell of the LS x tools.eager matrix: enabled AND covered by the
      // allowlist (via the ListFiles alias) → eager via registerFactory. Guards
      // a registerLazy mutant that demotes LS whenever an eager list is active,
      // ignoring entry coverage (#10400).
      await initConfig(
        eagerParams(['Shell', 'ListFiles'], { lsToolEnabled: true }),
      );

      expect(registeredToolNames()).toContain(ToolNames.LS);
      expect(deferredToolNames()).not.toContain(ToolNames.LS);
    });

    it('tools.eager keeps the --exclude-tools (deny) path working (#9827)', async () => {
      await initConfig(
        eagerParams(['ReadFile', 'Shell'], {
          permissions: { deny: ['Shell'] },
        }),
      );

      const registered = registeredToolNames();
      const deferred = deferredToolNames();

      expect(registered).toContain(ToolNames.READ_FILE);
      // deny wins over allowlist membership: a denied tool is hard-disabled —
      // neither registered eagerly nor deferred.
      expect(registered).not.toContain(ToolNames.SHELL);
      expect(deferred).not.toContain(ToolNames.SHELL);
      // An unlisted (not denied) tool is deferred, not dropped (#10075).
      expect(registered).not.toContain(ToolNames.SEND_MESSAGE);
      expect(deferred).toContain(ToolNames.SEND_MESSAGE);
    });

    it('derived getPermissionManager overrides reach the registration gate (scoped agent shims, #10075)', async () => {
      // The skill-review fork wraps the base Config with
      // createSkillScopedAgentConfig, whose scoped PermissionManager promises
      // 'registered' for its file tools, while the BASE manager's active
      // tools.eager allowlist demotes them. createToolRegistry must resolve
      // the manager via getPermissionManager() (where the override lives),
      // not the `permissionManager` field, which the Object.create chain
      // resolves to the base manager: with the field, the rebuild registers
      // the file tools as deferred and prepareTools' eager filter strips them
      // from the forked agent's explicit tools list — the silent-disappearance
      // class #10075 set out to eliminate.
      const config = await initConfig(eagerParams([]));
      registerFactory().mockClear();
      registerDeferred().mockClear();

      // Mirrors runSkillReviewByAgent → createApprovalModeOverride →
      // rebuildToolRegistryOnOverride on the scoped wrapper.
      await rebuildForSubAgent(
        createSkillScopedAgentConfig(config, TARGET_DIR),
      );

      const fileTools = [
        ToolNames.READ_FILE,
        ToolNames.WRITE_FILE,
        ToolNames.EDIT,
      ];
      expectTools(registeredToolNames(), fileTools);
      expectTools(deferredToolNames(), [], fileTools);
    });

    describe('with minified tool class names', () => {
      beforeEach(() => {
        Object.defineProperty(
          vi.mocked(ShellTool).prototype.constructor,
          'name',
          { value: '_ShellTool', configurable: true },
        );
      });

      afterEach(() => {
        Object.defineProperty(
          vi.mocked(ShellTool).prototype.constructor,
          'name',
          { value: 'ShellTool' },
        );
      });

      // Display names stand in for the (minified) class names in coreTools
      // and excludeTools; `coreTools: undefined` enables every tool by default.
      it.each`
        title                                                                                                           | params                                               | shellRegistered
        ${'should register a tool if coreTools contains the non-minified class name'}                                   | ${{ coreTools: ['Shell'] }}                          | ${true}
        ${'should register a tool if coreTools contains the displayName'}                                               | ${{ coreTools: ['Shell'] }}                          | ${true}
        ${'should not register a tool if excludeTools contains the non-minified class name'}                            | ${{ coreTools: undefined, excludeTools: ['Shell'] }} | ${false}
        ${'should not register a tool if excludeTools contains the displayName'}                                        | ${{ coreTools: undefined, excludeTools: ['Shell'] }} | ${false}
        ${'should register a tool if coreTools contains an argument-specific pattern with the non-minified class name'} | ${{ coreTools: ['Shell(git status)'] }}              | ${true}
        ${'should register a tool if coreTools contains an argument-specific pattern with the displayName'}             | ${{ coreTools: ['Shell(git status)'] }}              | ${true}
      `('%s', async ({ params, shellRegistered }) => {
        await initConfig(params);

        expect(registeredToolNames().includes(ToolNames.SHELL)).toBe(
          shellRegistered,
        );
      });
    });

    describe('omni media-memory recall exposure (D10)', () => {
      /** Register a fresh omni-enabled registry and report what it holds.
       * `createToolRegistry` (not `initialize`) is the unit under test: it
       * is where the mode decision happens, and it runs before the omni
       * normalization block in startup. */
      async function omniToolNames(
        omniMemory?: Record<string, unknown>,
      ): Promise<string[]> {
        const config = makeConfig({
          omniEnabled: true,
          ...(omniMemory !== undefined ? { omniMemory } : {}),
        });
        await config.createToolRegistry(undefined, { skipDiscovery: true });
        return registeredToolNames();
      }

      it('exposes the recall tool in active mode', async () => {
        const names = await omniToolNames({ recall: { mode: 'active' } });
        expect(names).toContain(ToolNames.OMNI_RECALL_MEDIA_MEMORY);
      });

      it('withholds the recall tool in sideQuery mode', async () => {
        // The two recall surfaces are mutually exclusive: in sideQuery mode
        // the harness injects recall before every request, so a registered
        // tool would let the model spend a call re-fetching memory it was
        // already handed — and registration is decided once, here.
        const names = await omniToolNames({ recall: { mode: 'sideQuery' } });
        expect(names).not.toContain(ToolNames.OMNI_RECALL_MEDIA_MEMORY);
        // The rest of the omni toolset still registered — proof the tool is
        // missing because of the mode, not because omni was off.
        expect(names).toContain(ToolNames.OMNI_DOWNSAMPLE_IMAGE);
      });

      it('aborts startup on an invalid omni.memory setting', async () => {
        // A rejected `omni.memory` must never degrade to defaults: the
        // default is `active`, so a typo in the mode would silently hand the
        // model a recall tool in a session the user configured for passive
        // injection — the exact silent fallback the normalizer forbids.
        await expect(
          omniToolNames({ recall: { mode: 'passive' } }),
        ).rejects.toThrow(/omni\.memory\.recall\.mode/);
      });
    });
  });
  describe('getTruncateToolOutputThreshold', () => {
    // `explicit` is the expected isTruncateToolOutputThresholdExplicit(),
    // where asserted.
    it.each`
      title                                                            | params                                                        | threshold                   | explicit
      ${'should return the default threshold'}                         | ${{}}                                                         | ${25_000}                   | ${false}
      ${'treats a null runtime threshold as unset'}                    | ${{ truncateToolOutputThreshold: null as unknown as number }} | ${25_000}                   | ${false}
      ${'should use a custom truncateToolOutputThreshold if provided'} | ${{ truncateToolOutputThreshold: 50000 }}                     | ${50000}                    | ${undefined}
      ${'should return infinity when threshold is zero or negative'}   | ${{ truncateToolOutputThreshold: 0 }}                         | ${Number.POSITIVE_INFINITY} | ${undefined}
      ${'tracks an explicit threshold of 25000'}                       | ${{ truncateToolOutputThreshold: 25_000 }}                    | ${25_000}                   | ${true}
      ${'tracks an explicit threshold of 10000'}                       | ${{ truncateToolOutputThreshold: 10_000 }}                    | ${10_000}                   | ${true}
      ${'tracks an explicit threshold of 100000'}                      | ${{ truncateToolOutputThreshold: 100_000 }}                   | ${100_000}                  | ${true}
      ${'tracks an explicit threshold of -1'}                          | ${{ truncateToolOutputThreshold: -1 }}                        | ${Number.POSITIVE_INFINITY} | ${true}
    `('%s', ({ params, threshold, explicit }) => {
      const config = makeConfig(params);
      expect(config.getTruncateToolOutputThreshold()).toBe(threshold);
      if (explicit !== undefined) {
        expect(config.isTruncateToolOutputThresholdExplicit()).toBe(explicit);
      }
    });
  });

  describe('getMaxToolCallsPerTurn', () => {
    it('should return the default cap when unset', () => {
      expect(makeConfig().getMaxToolCallsPerTurn()).toBe(
        DEFAULT_MAX_TOOL_CALLS_PER_TURN,
      );
    });

    it('should use a custom maxToolCallsPerTurn if provided', () => {
      const config = makeConfig({ maxToolCallsPerTurn: 42 });
      expect(config.getMaxToolCallsPerTurn()).toBe(42);
    });

    it('tracks whether maxToolCallsPerTurn was explicitly set', () => {
      expect(makeConfig().isMaxToolCallsPerTurnExplicit()).toBe(false);
      expect(
        makeConfig({ maxToolCallsPerTurn: 42 }).isMaxToolCallsPerTurnExplicit(),
      ).toBe(true);
    });

    it.each([0, -1])(
      'should return infinity (cap disabled) when set to %d',
      (capValue) => {
        const config = makeConfig({ maxToolCallsPerTurn: capValue });
        expect(config.getMaxToolCallsPerTurn()).toBe(Number.POSITIVE_INFINITY);
      },
    );

    it.each([0.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'should reject an invalid maxToolCallsPerTurn value: %s',
      (capValue) => {
        expect(() => makeConfig({ maxToolCallsPerTurn: capValue })).toThrow(
          /maxToolCallsPerTurn: must be an integer/,
        );
      },
    );
  });

  describe('getMaxSessionTurns', () => {
    it.each([-42, -1, 0, 42])('should accept %d', (maxSessionTurns) => {
      const config = makeConfig({ maxSessionTurns });
      expect(config.getMaxSessionTurns()).toBe(maxSessionTurns);
    });

    it.each([0.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'should reject an invalid value: %s',
      (maxSessionTurns) => {
        expect(() => makeConfig({ maxSessionTurns })).toThrow(
          /maxSessionTurns: must be an integer/,
        );
      },
    );
  });

  describe('getClearContextOnIdle', () => {
    it.each`
      title                                                                                  | clearContextOnIdle                             | expected
      ${'should default the cumulative tool result threshold to 500000 chars'}               | ${undefined}                                   | ${{ toolResultsThresholdMinutes: 60, toolResultsNumToKeep: 5, toolResultsTotalCharsThreshold: 500_000 }}
      ${'should use a custom cumulative tool result threshold if provided'}                  | ${{ toolResultsTotalCharsThreshold: 123_456 }} | ${{ toolResultsTotalCharsThreshold: 123_456 }}
      ${'should preserve an explicit disabled cumulative tool result threshold'}             | ${{ toolResultsTotalCharsThreshold: -1 }}      | ${{ toolResultsThresholdMinutes: 60, toolResultsNumToKeep: 5, toolResultsTotalCharsThreshold: -1 }}
      ${'should keep legacy disabled idle cleanup disabled for the size trigger too'}        | ${{ toolResultsThresholdMinutes: -1 }}         | ${{ toolResultsThresholdMinutes: -1, toolResultsNumToKeep: 5, toolResultsTotalCharsThreshold: -1 }}
      ${'should treat any negative legacy idle threshold as disabling the size trigger too'} | ${{ toolResultsThresholdMinutes: -2 }}         | ${{ toolResultsThresholdMinutes: -2, toolResultsNumToKeep: 5, toolResultsTotalCharsThreshold: -1 }}
    `('%s', ({ clearContextOnIdle, expected }) => {
      const config = makeConfig(
        clearContextOnIdle === undefined ? {} : { clearContextOnIdle },
      );
      expect(config.getClearContextOnIdle()).toMatchObject(expected);
    });
  });

  // PR 14b fix (codex round 4): the `Config.setMcpBudgetEventCallback →
  // pendingMcpBudgetCallback → createToolRegistry →
  // registry.getMcpClientManager().setOnBudgetEvent` boundary had NO test. The
  // acpAgent test stubs the setter and the manager tests bypass Config, so
  // neither covers the stash + apply path inside Config — the safety net that
  // keeps startup-window MCP guardrail events from being dropped under legacy
  // blocking discovery and closes the progressive-mode race. These cover both
  // call orderings (pre-init and late-call).
  describe('setMcpBudgetEventCallback handoff to McpClientManager', () => {
    it('applies pending callback when registry is created during initialize()', async () => {
      const config = makeConfig();
      const cb = vi.fn();
      // Called BEFORE initialize: stashed on `pendingMcpBudgetCallback` and
      // applied inside `createToolRegistry` once the manager exists, BEFORE
      // `discoverAllTools` / background discovery fires.
      config.setMcpBudgetEventCallback(cb);
      await config.initialize();

      const manager = mcpManagerOf(config);
      expect(manager.setOnBudgetEvent).toHaveBeenCalledWith(cb);
      // Exactly once per `createToolRegistry` invocation.
      expect(manager.setOnBudgetEvent.mock.calls).toHaveLength(1);
    });

    it('applies callback directly to existing manager when called after initialize()', async () => {
      // Initialized WITHOUT a pending callback, so the createToolRegistry
      // apply branch is a no-op.
      const config = await initConfig();
      const manager = mcpManagerOf(config);
      expect(manager.setOnBudgetEvent).not.toHaveBeenCalled();

      // Late-call path: the setter dispatches DIRECTLY to the existing manager
      // via its `if (this.toolRegistry)` branch, the path adapters use when
      // they find the manager only after Config is up.
      const cb = vi.fn();
      config.setMcpBudgetEventCallback(cb);
      expect(manager.setOnBudgetEvent).toHaveBeenCalledWith(cb);

      // `undefined` clears the registration on the manager (parity with the
      // constructor-time `off`-mode strip in McpClientManager).
      config.setMcpBudgetEventCallback(undefined);
      expect(manager.setOnBudgetEvent).toHaveBeenLastCalledWith(undefined);
    });

    it('does NOT stash the callback when called after initialize() (codex round 7 fix — subagent isolation)', async () => {
      // Codex round 7: pre-fix, the late-call path also assigned
      // `pendingMcpBudgetCallback`, so a later `createToolRegistry` (subagent
      // override via `createApprovalModeOverride` /
      // `buildSubagentContextOverride`) inherited the stash and wired the
      // parent session's ACP push callback into the subagent's manager,
      // routing subagent telemetry through the wrong session. The late call
      // now applies directly and clears the stash; the pre-init path still
      // stashes (the only way to reach a manager that doesn't exist yet).
      const config = await initConfig();
      const manager = mcpManagerOf(config);

      const cb = vi.fn();
      config.setMcpBudgetEventCallback(cb);
      expect(manager.setOnBudgetEvent).toHaveBeenCalledWith(cb);

      // A subagent-override rebuild must NOT receive the parent's callback.
      const subagentRegistry = (await rebuildForSubAgent(
        config,
      )) as unknown as {
        __mcpManagerMock: { setOnBudgetEvent: Mock };
      };
      expect(
        subagentRegistry.__mcpManagerMock.setOnBudgetEvent,
      ).not.toHaveBeenCalled();
    });
  });
});

describe('setApprovalMode with folder trust', () => {
  const baseParams = MINIMAL_PARAMS;
  /** A Config whose folder trust decision is pinned to `trusted`. */
  const trustedConfig = (trusted = true) => {
    const config = new Config(baseParams);
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(trusted);
    return config;
  };
  /** A Config built from baseParams with the given parameter overrides. */
  const makeConfig = (overrides: Partial<ConfigParameters> = {}) =>
    new Config({ ...baseParams, ...overrides });
  const initConfig = async (overrides: Partial<ConfigParameters> = {}) => {
    const config = makeConfig(overrides);
    await config.initialize();
    return config;
  };
  const UNTRUSTED_ERROR =
    'Cannot enable privileged approval modes in an untrusted folder.';
  /** Apply `modes` to `config` in order. */
  const setModes = (config: Config, ...modes: ApprovalMode[]) => {
    for (const mode of modes) config.setApprovalMode(mode);
  };
  const expectEveryModeAllowed = (config: Config) => {
    for (const mode of [
      ApprovalMode.YOLO,
      ApprovalMode.AUTO_EDIT,
      ApprovalMode.DEFAULT,
      ApprovalMode.PLAN,
    ]) {
      expect(() => config.setApprovalMode(mode)).not.toThrow();
    }
  };

  it.each([
    ['YOLO', ApprovalMode.YOLO],
    ['AUTO_EDIT', ApprovalMode.AUTO_EDIT],
  ])(
    'should throw a TrustGateError when setting %s mode in an untrusted folder',
    (_label, mode) => {
      // #4297 fold-in 1 (16:32:44-round S3): assert on the typed class, not
      // just the message: the 403 mapping in `serve/server.ts` matches
      // `err instanceof TrustGateError`, and a revert to `throw new Error(...)`
      // would silently downgrade to 500 while the message test kept passing.
      const config = trustedConfig(false);
      expect(() => config.setApprovalMode(mode)).toThrow(TrustGateError);
      expect(() => config.setApprovalMode(mode)).toThrow(UNTRUSTED_ERROR);
    },
  );

  it('should NOT throw an error when setting DEFAULT mode in an untrusted folder', () => {
    const config = trustedConfig(false);
    expect(() => config.setApprovalMode(ApprovalMode.DEFAULT)).not.toThrow();
  });

  it('should NOT throw an error when setting PLAN mode in an untrusted folder', () => {
    const config = new Config({
      targetDir: '.',
      debugMode: false,
      model: 'test-model',
      cwd: '.',
      trustedFolder: false, // Untrusted
    });
    expect(() => config.setApprovalMode(ApprovalMode.PLAN)).not.toThrow();
  });

  it('should NOT throw an error when setting any mode in a trusted folder', () => {
    expectEveryModeAllowed(trustedConfig());
  });

  it('allows privileged modes when folder trust is disabled and no decision is supplied', () => {
    expectEveryModeAllowed(new Config(baseParams));
  });

  it('rejects privileged modes before an enabled folder trust decision', () => {
    const config = makeConfig({ folderTrust: true });
    expect(() => config.setApprovalMode(ApprovalMode.YOLO)).toThrow(
      TrustGateError,
    );
  });

  describe('DAC plan workflow', () => {
    it('notifies after a Plan execution mode is selected or changed', () => {
      const config = new Config(baseParams);
      vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
      config.setApprovalMode(ApprovalMode.YOLO);
      const states: Array<{
        mode: ApprovalMode;
        prePlanMode: ApprovalMode;
        executionMode: ApprovalMode | undefined;
      }> = [];
      config.onApprovalModeChange((mode, prePlanMode) => {
        states.push({
          mode,
          prePlanMode: prePlanMode ?? ApprovalMode.DEFAULT,
          executionMode: config.getPlanExecutionMode(),
        });
      });

      config.setPlanMode(true, ApprovalMode.YOLO);
      config.setPlanMode(true, ApprovalMode.AUTO_EDIT);
      config.setPlanMode(true, ApprovalMode.AUTO_EDIT);

      expect(states).toEqual([
        {
          mode: ApprovalMode.PLAN,
          prePlanMode: ApprovalMode.YOLO,
          executionMode: ApprovalMode.YOLO,
        },
        {
          mode: ApprovalMode.PLAN,
          prePlanMode: ApprovalMode.YOLO,
          executionMode: ApprovalMode.AUTO_EDIT,
        },
      ]);
    });

    it.each([
      ApprovalMode.DEFAULT,
      ApprovalMode.AUTO_EDIT,
      ApprovalMode.AUTO,
      ApprovalMode.YOLO,
    ])('keeps planning while selecting %s for execution', (mode) => {
      const config = trustedConfig();
      config.setApprovalMode(ApprovalMode.YOLO);
      config.setPlanMode(true, ApprovalMode.YOLO);
      const revision = config.getApprovalModeRevision();

      config.setPlanMode(true, mode);

      expect(config.getApprovalMode()).toBe(ApprovalMode.PLAN);
      expect(config.getPlanExecutionMode()).toBe(mode);
      expect(config.getPrePlanMode()).toBe(ApprovalMode.YOLO);
      expect(config.getApprovalModeRevision()).toBe(revision);
      expect(config.consumePendingManualPlanExitNotice()).toBe(false);
      config.setPlanMode(false, mode);
      expect(config.getApprovalMode()).toBe(mode);
      expect(config.getPlanExecutionMode()).toBeUndefined();
      expect(config.consumePendingManualPlanExitNotice()).toBe(true);
    });

    it('clears the selected policy on approved or legacy exits', () => {
      const config = trustedConfig();
      config.setPlanMode(true, ApprovalMode.YOLO);
      config.setApprovalMode(ApprovalMode.YOLO, {
        fromApprovedPlanExit: true,
      });
      expect(config.getPlanExecutionMode()).toBeUndefined();
      config.setPlanMode(true, ApprovalMode.AUTO_EDIT);
      config.setApprovalMode(ApprovalMode.DEFAULT);
      expect(config.getPlanExecutionMode()).toBeUndefined();
    });

    it('rejects privileged policies before changing an untrusted config', () => {
      const config = new Config(baseParams);
      config.setApprovalMode(ApprovalMode.DEFAULT);
      vi.spyOn(config, 'isTrustedFolder').mockReturnValue(false);
      expect(() => config.setPlanMode(true, ApprovalMode.YOLO)).toThrow(
        TrustGateError,
      );
      expect(config.getApprovalMode()).toBe(ApprovalMode.DEFAULT);
      expect(config.getPlanExecutionMode()).toBeUndefined();
      config.setPlanMode(true, ApprovalMode.DEFAULT);
      expect(() => config.setPlanMode(true, ApprovalMode.AUTO_EDIT)).toThrow(
        TrustGateError,
      );
      expect(config.getApprovalMode()).toBe(ApprovalMode.PLAN);
      expect(config.getPlanExecutionMode()).toBe(ApprovalMode.DEFAULT);
    });

    it('rejects Plan as an execution policy and isolates derived configs', () => {
      const config = trustedConfig();
      expect(() => config.setPlanMode(true, ApprovalMode.PLAN)).toThrow(
        'Plan is not an execution approval mode',
      );
      config.setPlanMode(true, ApprovalMode.YOLO);
      const child = deriveConfig(config);
      expect(child.getPlanExecutionMode()).toBeUndefined();
      expect(() => child.setPlanMode(false, ApprovalMode.DEFAULT)).toThrow(
        'Derived Configs cannot change plan workflow mode',
      );
      expect(config.getApprovalMode()).toBe(ApprovalMode.PLAN);
      expect(config.getPlanExecutionMode()).toBe(ApprovalMode.YOLO);
    });
  });

  describe('prePlanMode tracking', () => {
    it('notifies canonical listeners after approval state changes', () => {
      const config = new Config(baseParams);
      vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
      const listener = vi.fn();
      const unsubscribe = config.onApprovalModeChange(listener);

      config.setApprovalMode(ApprovalMode.YOLO);
      config.setApprovalMode(ApprovalMode.PLAN);
      config.setApprovalMode(ApprovalMode.PLAN);
      unsubscribe();
      config.setApprovalMode(ApprovalMode.DEFAULT);

      expect(listener).toHaveBeenNthCalledWith(1, ApprovalMode.YOLO, undefined);
      expect(listener).toHaveBeenNthCalledWith(
        2,
        ApprovalMode.PLAN,
        ApprovalMode.YOLO,
      );
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it('does not notify when trust rejects a mode or a derived config changes', () => {
      const config = new Config(baseParams);
      const listener = vi.fn();
      config.onApprovalModeChange(listener);
      vi.spyOn(config, 'isTrustedFolder').mockReturnValue(false);

      expect(() => config.setApprovalMode(ApprovalMode.YOLO)).toThrow(
        TrustGateError,
      );
      const derived = deriveApprovalModeConfig(config, ApprovalMode.PLAN);
      derived.config.setApprovalMode(ApprovalMode.DEFAULT);

      expect(listener).not.toHaveBeenCalled();
      derived.cleanup();
    });

    // 'should not update pre-plan mode when already in plan mode': setting
    // PLAN again should not overwrite prePlanMode. 'records prePlanMode=yolo
    // for a Shift+Tab cycle into plan mode' simulates the Shift+Tab cycle
    // order default → auto-edit → auto → yolo → plan.
    it.each`
      title                                                              | modes                                                                                | expected
      ${'should save pre-plan mode when entering plan mode'}             | ${[ApprovalMode.AUTO_EDIT, ApprovalMode.PLAN]}                                       | ${ApprovalMode.AUTO_EDIT}
      ${'should clear pre-plan mode when leaving plan mode'}             | ${[ApprovalMode.AUTO_EDIT, ApprovalMode.PLAN, ApprovalMode.DEFAULT]}                 | ${ApprovalMode.DEFAULT}
      ${'should not update pre-plan mode when already in plan mode'}     | ${[ApprovalMode.YOLO, ApprovalMode.PLAN, ApprovalMode.PLAN]}                         | ${ApprovalMode.YOLO}
      ${'records prePlanMode=yolo for a Shift+Tab cycle into plan mode'} | ${[ApprovalMode.AUTO_EDIT, ApprovalMode.AUTO, ApprovalMode.YOLO, ApprovalMode.PLAN]} | ${ApprovalMode.YOLO}
    `('%s', ({ modes, expected }) => {
      const config = trustedConfig();
      setModes(config, ...modes);
      expect(config.getPrePlanMode()).toBe(expected);
    });

    it('should default to DEFAULT when no pre-plan mode was recorded', () => {
      expect(new Config(baseParams).getPrePlanMode()).toBe(
        ApprovalMode.DEFAULT,
      );
    });

    it('increments the approval mode revision only for actual changes', () => {
      const config = trustedConfig();

      const initialRevision = config.getApprovalModeRevision();
      config.setApprovalMode(ApprovalMode.PLAN);
      expect(config.getApprovalModeRevision()).toBe(initialRevision + 1);
      config.setApprovalMode(ApprovalMode.PLAN);
      config.setApprovalMode(ApprovalMode.PLAN, { enteredByModel: true });
      expect(config.getApprovalModeRevision()).toBe(initialRevision + 1);
      config.setApprovalMode(ApprovalMode.DEFAULT);
      expect(config.getApprovalModeRevision()).toBe(initialRevision + 2);
    });

    it('queues a one-shot manual plan-exit notice on a manual exit', () => {
      const config = trustedConfig();
      setModes(config, ApprovalMode.PLAN, ApprovalMode.DEFAULT);

      expect(config.consumePendingManualPlanExitNotice()).toBe(true);
      // One-shot: consumed on first read.
      expect(config.consumePendingManualPlanExitNotice()).toBe(false);
    });

    it('does not queue the exit notice for an approved plan exit', () => {
      const config = trustedConfig();
      config.setApprovalMode(ApprovalMode.PLAN);
      config.setApprovalMode(ApprovalMode.DEFAULT, {
        fromApprovedPlanExit: true,
      });

      expect(config.consumePendingManualPlanExitNotice()).toBe(false);
    });

    it.each([
      [
        'clears a stale exit notice when plan mode is re-entered',
        [ApprovalMode.PLAN, ApprovalMode.DEFAULT, ApprovalMode.PLAN],
      ],
      [
        'does not queue the exit notice for non-plan mode changes',
        [ApprovalMode.AUTO_EDIT, ApprovalMode.DEFAULT],
      ],
    ])('%s', (_title, modes) => {
      const config = trustedConfig();
      setModes(config, ...modes);

      expect(config.consumePendingManualPlanExitNotice()).toBe(false);
    });

    /** Latest notice's current mode for `config`, claiming it. */
    const noticeMode = (config: Config) =>
      config.takePendingManualPlanExitNotice()?.currentMode;

    it('claims the latest non-plan mode and supports a matching restore', () => {
      const config = trustedConfig();
      setModes(
        config,
        ApprovalMode.PLAN,
        ApprovalMode.DEFAULT,
        ApprovalMode.YOLO,
      );

      const notice = config.takePendingManualPlanExitNotice();
      expect(notice).toEqual({
        version: expect.any(Number),
        currentMode: ApprovalMode.YOLO,
      });
      expect(config.takePendingManualPlanExitNotice()).toBeUndefined();

      config.restorePendingManualPlanExitNotice(notice!.version);
      expect(config.takePendingManualPlanExitNotice()).toEqual(notice);
    });

    it('ignores a restore after a newer mode event', () => {
      const config = trustedConfig();
      setModes(config, ApprovalMode.PLAN, ApprovalMode.DEFAULT);
      const staleNotice = config.takePendingManualPlanExitNotice()!;

      setModes(config, ApprovalMode.PLAN, ApprovalMode.AUTO_EDIT);
      config.restorePendingManualPlanExitNotice(staleNotice.version);

      const currentNotice = config.takePendingManualPlanExitNotice();
      expect(currentNotice?.version).toBeGreaterThan(staleNotice.version);
      expect(currentNotice?.currentMode).toBe(ApprovalMode.AUTO_EDIT);
      expect(config.takePendingManualPlanExitNotice()).toBeUndefined();
    });

    it('delivers the same inherited event once to each conversation', () => {
      const parent = trustedConfig();
      const child = Object.create(parent) as Config;
      setModes(parent, ApprovalMode.PLAN, ApprovalMode.DEFAULT);

      const parentNotice = parent.takePendingManualPlanExitNotice();
      const childNotice = child.takePendingManualPlanExitNotice();
      expect(parentNotice).toEqual(childNotice);
      expect(parent.takePendingManualPlanExitNotice()).toBeUndefined();
      expect(child.takePendingManualPlanExitNotice()).toBeUndefined();
    });

    it('lets a newly created conversation claim the latest inherited event', () => {
      const parent = trustedConfig();
      setModes(parent, ApprovalMode.PLAN, ApprovalMode.DEFAULT);
      const parentNotice = parent.takePendingManualPlanExitNotice();
      const child = Object.create(parent) as Config;

      expect(child.takePendingManualPlanExitNotice()).toEqual(parentNotice);
    });

    it('copies the event when a child first owns its approval mode', () => {
      const parent = trustedConfig();
      const child = Object.create(parent) as Config;
      setModes(parent, ApprovalMode.PLAN, ApprovalMode.DEFAULT);
      child.setApprovalMode(ApprovalMode.AUTO_EDIT);

      expect(noticeMode(child)).toBe(ApprovalMode.AUTO_EDIT);

      setModes(parent, ApprovalMode.PLAN, ApprovalMode.DEFAULT);
      expect(child.takePendingManualPlanExitNotice()).toBeUndefined();
      expect(noticeMode(parent)).toBe(ApprovalMode.DEFAULT);

      setModes(child, ApprovalMode.PLAN, ApprovalMode.YOLO);
      expect(noticeMode(child)).toBe(ApprovalMode.YOLO);
      expect(parent.takePendingManualPlanExitNotice()).toBeUndefined();
    });

    it('isolates an inherited event when approval mode is owned directly', () => {
      const parent = trustedConfig();
      setModes(parent, ApprovalMode.PLAN, ApprovalMode.DEFAULT);

      const child = Object.create(parent) as Config;
      Object.defineProperty(child, 'approvalMode', {
        value: ApprovalMode.AUTO_EDIT,
        writable: true,
        configurable: true,
      });

      expect(noticeMode(child)).toBe(ApprovalMode.AUTO_EDIT);

      setModes(parent, ApprovalMode.PLAN, ApprovalMode.DEFAULT);
      expect(child.takePendingManualPlanExitNotice()).toBeUndefined();
      expect(noticeMode(parent)).toBe(ApprovalMode.DEFAULT);
    });

    it('only exposes the latest event after rapid Plan round trips', () => {
      const config = trustedConfig();
      setModes(
        config,
        ApprovalMode.PLAN,
        ApprovalMode.DEFAULT,
        ApprovalMode.PLAN,
        ApprovalMode.YOLO,
      );

      expect(noticeMode(config)).toBe(ApprovalMode.YOLO);
      expect(config.takePendingManualPlanExitNotice()).toBeUndefined();
    });

    it('does not partially apply plan exit bookkeeping when transition work fails', () => {
      const config = trustedConfig();
      setModes(config, ApprovalMode.AUTO, ApprovalMode.PLAN);
      const revision = config.getApprovalModeRevision();
      internals(config).permissionManager = {
        stripDangerousRulesForAutoMode: () => {
          throw new Error('strip failed');
        },
        restoreDangerousRules: vi.fn(),
      };

      expect(() => config.setApprovalMode(ApprovalMode.AUTO)).toThrow(
        'strip failed',
      );
      expect(config.getApprovalMode()).toBe(ApprovalMode.PLAN);
      expect(config.getPrePlanMode()).toBe(ApprovalMode.AUTO);
      expect(config.getApprovalModeRevision()).toBe(revision);
    });
  });

  describe('AUTO mode', () => {
    /** Auto-mode denial counters: consecutive/total block and unavailable. */
    const denials = (block = 0, unavailable = 0, totalBlock = block) => ({
      consecutiveBlock: block,
      consecutiveUnavailable: unavailable,
      totalBlock,
      totalUnavailable: unavailable,
    });
    it('should throw an error when setting AUTO mode in an untrusted folder', () => {
      const config = trustedConfig(false);
      expect(() => config.setApprovalMode(ApprovalMode.AUTO)).toThrow(
        UNTRUSTED_ERROR,
      );
    });

    it('should NOT throw when setting AUTO mode in a trusted folder', () => {
      const config = trustedConfig();
      expect(() => config.setApprovalMode(ApprovalMode.AUTO)).not.toThrow();
    });

    it('should persist AUTO as the active mode', () => {
      const config = trustedConfig();
      config.setApprovalMode(ApprovalMode.AUTO);
      expect(config.getApprovalMode()).toBe(ApprovalMode.AUTO);
    });

    it('setApprovalMode resets the denial-tracking counters', () => {
      const config = trustedConfig();
      // Enter AUTO with accumulated denial counters.
      config.setApprovalMode(ApprovalMode.AUTO);
      config.setAutoModeDenialState(denials(3, 2, 5));

      // Switch away and back; the counters must be wiped clean.
      config.setApprovalMode(ApprovalMode.DEFAULT);
      expect(config.getAutoModeDenialState()).toEqual(denials());

      // And entering AUTO again should also start fresh (no leftover state).
      config.setAutoModeDenialState(denials(1));
      config.setApprovalMode(ApprovalMode.AUTO);
      expect(config.getAutoModeDenialState()).toEqual(denials());
    });

    it('setApprovalMode(sameMode) does NOT reset counters', () => {
      const config = trustedConfig();
      config.setApprovalMode(ApprovalMode.AUTO);
      const populated = denials(2);
      config.setAutoModeDenialState(populated);

      // No-op mode set — state should be preserved.
      config.setApprovalMode(ApprovalMode.AUTO);
      expect(config.getAutoModeDenialState()).toEqual(populated);
    });

    it('should track AUTO as prePlanMode when entering PLAN from AUTO', () => {
      const config = trustedConfig();
      setModes(config, ApprovalMode.AUTO, ApprovalMode.PLAN);
      expect(config.getPrePlanMode()).toBe(ApprovalMode.AUTO);
    });

    it('AUTO appears in APPROVAL_MODES between AUTO_EDIT and YOLO', () => {
      const autoEditIdx = APPROVAL_MODES.indexOf(ApprovalMode.AUTO_EDIT);
      const autoIdx = APPROVAL_MODES.indexOf(ApprovalMode.AUTO);
      const yoloIdx = APPROVAL_MODES.indexOf(ApprovalMode.YOLO);
      expect(autoIdx).toBeGreaterThan(autoEditIdx);
      expect(autoIdx).toBeLessThan(yoloIdx);
    });

    it('APPROVAL_MODE_INFO has an entry for AUTO', () => {
      expect(APPROVAL_MODE_INFO[ApprovalMode.AUTO]).toEqual({
        id: ApprovalMode.AUTO,
        name: 'Auto',
        description: expect.stringContaining('classifier'),
      });
    });
  });

  describe('getAutoModeSettings', () => {
    it('returns an empty object when no autoMode settings are provided', () => {
      expect(new Config(baseParams).getAutoModeSettings()).toEqual({});
    });

    it('returns the provided autoMode classifier settings, hints, and environment', () => {
      const autoMode = () => ({
        classifier: {
          timeouts: { stage1Ms: 12_345, stage2Ms: 67_890 },
          thinking: { stage2Enabled: true },
        },
        hints: {
          allow: ['Allow xyz commands'],
          deny: ['Block intranet calls'],
        },
        environment: ['Open-source monorepo'],
      });
      const config = makeConfig({ permissions: { autoMode: autoMode() } });
      expect(config.getAutoModeSettings()).toEqual(autoMode());
    });
  });

  describe('plan file persistence', () => {
    const TARGET = path.resolve(baseParams.targetDir);
    const PLANS_DIR = path.join(TARGET, 'project-plans');
    const PLAN_FILE = path.join(PLANS_DIR, 'test-session-123.md');
    const PLAN_TMP = `${PLAN_FILE}.tmp`;
    const OUTSIDE_PLAN_FILE = path.resolve(
      path.dirname(TARGET),
      'outside-plans',
      'test-session-123.md',
    );
    const CONTAINMENT_ERROR =
      'plansDirectory must resolve within the project root';
    /** A Config writing plans for test-session-123 under ./project-plans. */
    const plansConfig = () =>
      makeConfig({
        sessionId: 'test-session-123',
        plansDirectory: './project-plans',
      });
    const errnoError = (code: string): NodeJS.ErrnoException =>
      Object.assign(new Error(code), { code });
    /** Back the fs write/rename/read mocks with an in-memory file store. */
    const mockPlanFileStore = () => {
      const storedFiles = new Map<string, string>();
      (fs.writeFileSync as Mock).mockImplementation((pathToWrite, contents) => {
        storedFiles.set(pathToWrite.toString(), contents.toString());
      });
      (fs.renameSync as Mock).mockImplementation((fromPath, toPath) => {
        const contents = storedFiles.get(fromPath.toString());
        if (contents === undefined) {
          throw new Error(`missing temp file: ${fromPath.toString()}`);
        }
        storedFiles.set(toPath.toString(), contents);
        storedFiles.delete(fromPath.toString());
      });
      (fs.readFileSync as Mock).mockImplementation((pathToRead) => {
        const contents = storedFiles.get(pathToRead.toString());
        if (contents === undefined) throw errnoError('ENOENT');
        return contents;
      });
    };
    /** realpathSync maps the given paths and resolves all others to themselves. */
    const mapRealpath = (mapped: Record<string, string>) =>
      vi
        .mocked(fs.realpathSync)
        .mockImplementation(
          (pathToResolve) =>
            mapped[pathToResolve.toString()] ?? pathToResolve.toString(),
        );
    const restoreRealpath = () =>
      vi
        .mocked(fs.realpathSync)
        .mockImplementation((pathToResolve) => pathToResolve.toString());
    /** readdirSync lists `entries` for the given directories and nothing elsewhere. */
    const mapReaddir = (entries: Record<string, string[]>) =>
      (fs.readdirSync as Mock).mockImplementation(
        (pathToCheck) => entries[pathToCheck.toString()] ?? [],
      );

    const failReads = (code: string) =>
      (fs.readFileSync as Mock).mockImplementation(() => {
        throw errnoError(code);
      });
    /** '# My Plan' went through the configured plans dir's atomic write. */
    const expectPlanWritten = () => {
      expect(fs.mkdirSync).toHaveBeenCalledWith(PLANS_DIR, { recursive: true });
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        PLAN_TMP,
        '# My Plan',
        'utf-8',
      );
      expect(fs.renameSync).toHaveBeenCalledWith(PLAN_TMP, PLAN_FILE);
    };
    /** Run `body` after `mockReaddir`, resetting readdirSync afterwards. */
    const withReaddir = (mockReaddir: () => void, body: () => void) => {
      mockReaddir();
      try {
        body();
      } finally {
        (fs.readdirSync as Mock).mockReturnValue([]);
      }
    };

    it('should save plan to disk atomically', () => {
      new Config(baseParams).savePlan('# My Plan\n1. Step one\n2. Step two');

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('plans'),
        { recursive: true },
      );
      // Writes to a temp file first, then atomically renames to the final path.
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        '# My Plan\n1. Step one\n2. Step two',
        'utf-8',
      );
      expect(fs.renameSync).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        expect.stringContaining('.md'),
      );
    });

    it('should load plan from disk', () => {
      const config = new Config(baseParams);
      (fs.readFileSync as Mock).mockReturnValue('# Saved Plan');

      expect(config.loadPlan()).toBe('# Saved Plan');
    });

    it('should return undefined when no plan file exists', () => {
      const config = new Config(baseParams);
      failReads('ENOENT');

      expect(config.loadPlan()).toBeUndefined();
    });

    it('should rethrow non-ENOENT errors from loadPlan', () => {
      const config = new Config(baseParams);
      failReads('EACCES');

      expect(() => config.loadPlan()).toThrow('EACCES');
    });

    it('should use session ID in plan file path', () => {
      const filePath = makeConfig({
        sessionId: 'test-session-123',
      }).getPlanFilePath();
      expect(filePath).toContain('test-session-123');
      expect(filePath).toMatch(/\.md$/);
    });

    it('should sanitize session ID when building plan file path', () => {
      const config = makeConfig({
        sessionId: '../../../escape',
        plansDirectory: './project-plans',
      });

      expect(config.getPlanFilePath()).toBe(path.join(PLANS_DIR, 'escape.md'));
    });

    it('should use configured plansDirectory for plan file path', () => {
      const config = plansConfig();

      expect(config.getPlansDir()).toBe(PLANS_DIR);
      expect(config.getPlanFilePath()).toBe(PLAN_FILE);
    });

    it('should save and load plan from configured plansDirectory', () => {
      const config = plansConfig();
      mockPlanFileStore();

      config.savePlan('# My Plan');

      expectPlanWritten();
      expect(config.loadPlan()).toBe('# My Plan');
      expect(fs.readFileSync).toHaveBeenCalledWith(PLAN_FILE, 'utf-8');
    });

    it('saves a plan on a derived agent config whose cwd differs from the project root', () => {
      const config = plansConfig();
      // A teammate's working directory outside the parent project root. The
      // plan file still belongs to the parent's configured plans directory,
      // so containment must anchor at the plans-owning base Config, not at
      // the agent's workspace.
      const { config: agentConfig } = deriveAgentConfig(
        config,
        '/elsewhere/agent-cwd',
      );
      mockPlanFileStore();

      expect(() => agentConfig.savePlan('# My Plan')).not.toThrow();

      expectPlanWritten();
      expect(agentConfig.loadPlan()).toBe('# My Plan');
      expect(config.getTargetDir()).toBe(TARGET);
    });

    it('should fall back to copyFileSync when renameSync hits EXDEV', () => {
      const config = plansConfig();
      (fs.renameSync as Mock).mockImplementation(() => {
        throw errnoError('EXDEV');
      });

      config.savePlan('# My Plan');

      expect(fs.copyFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        expect.stringContaining('project-plans'),
      );
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
      );
    });

    it('should remove plan file when post-write containment check fails', () => {
      const config = plansConfig();
      mapRealpath({ [PLAN_FILE]: OUTSIDE_PLAN_FILE });

      try {
        expect(() => config.savePlan('# My Plan')).toThrow(CONTAINMENT_ERROR);
        expect(fs.unlinkSync).toHaveBeenCalledWith(PLAN_FILE);
      } finally {
        restoreRealpath();
      }
    });

    it('should reject loading a plan when final file path escapes targetDir', () => {
      const config = plansConfig();
      vi.mocked(fs.readFileSync).mockClear();
      mapRealpath({ [PLAN_FILE]: OUTSIDE_PLAN_FILE });

      try {
        expect(() => config.loadPlan()).toThrow(CONTAINMENT_ERROR);
        expect(fs.readFileSync).not.toHaveBeenCalled();
      } finally {
        restoreRealpath();
      }
    });

    const configuredPlansWarnings = () =>
      makeConfig({ plansDirectory: './project-plans' }).getWarnings();

    it('should warn when configured plansDirectory hides a legacy plan file', () => {
      const legacyPlansDir = Storage.getPlansDir();
      withReaddir(
        () => mapReaddir({ [legacyPlansDir]: ['other-session.md'] }),
        () => {
          const warnings = configuredPlansWarnings();
          expect(warnings).toContainEqual(
            expect.stringContaining(legacyPlansDir),
          );
          expect(warnings).toContainEqual(
            expect.stringContaining('plansDirectory is configured'),
          );
        },
      );
    });

    it('should warn when configured plansDirectory has only some legacy plan files', () => {
      const legacyPlansDir = Storage.getPlansDir();
      withReaddir(
        () =>
          mapReaddir({
            [PLANS_DIR]: ['migrated-session.md'],
            [legacyPlansDir]: ['migrated-session.md', 'hidden-session.md'],
          }),
        () =>
          expect(configuredPlansWarnings()).toContainEqual(
            expect.stringContaining(legacyPlansDir),
          ),
      );
    });

    it('should surface legacy plan directory read failures as warnings', () => {
      withReaddir(
        () =>
          (fs.readdirSync as Mock).mockImplementation((pathToCheck) => {
            if (pathToCheck.toString() === PLANS_DIR) return [];
            throw errnoError('EACCES');
          }),
        () => {
          expect(configuredPlansWarnings()).toContainEqual(
            expect.stringContaining('Failed to read plan directory'),
          );
        },
      );
    });

    it('should reject configured plansDirectory outside targetDir', () => {
      expect(() => makeConfig({ plansDirectory: '../project-plans' })).toThrow(
        CONTAINMENT_ERROR,
      );
    });

    it('should revalidate configured plansDirectory before plan I/O', () => {
      const config = makeConfig({ plansDirectory: './project-plans' });
      vi.mocked(fs.mkdirSync).mockClear();
      vi.mocked(fs.readFileSync).mockClear();
      mapRealpath({
        [PLANS_DIR]: path.resolve(path.dirname(TARGET), 'outside-plans'),
      });

      try {
        expect(() => config.savePlan('# My Plan')).toThrow(CONTAINMENT_ERROR);
        expect(() => config.loadPlan()).toThrow(CONTAINMENT_ERROR);
        expect(fs.mkdirSync).not.toHaveBeenCalled();
        expect(fs.readFileSync).not.toHaveBeenCalled();
      } finally {
        restoreRealpath();
      }
    });
  });

  describe('registerCoreTools', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });
    const grepRegistrations = () =>
      registeredToolNames().filter((name) => name === ToolNames.GREP);
    const fallbackError = () =>
      (vi.mocked(logRipgrepFallback).mock.calls[0][1] as RipgrepFallbackEvent)
        .error;

    it('registers the background-agent roster tool', async () => {
      await initConfig();

      expect(registeredToolNames()).toContain(ToolNames.LIST_AGENTS);
    });

    it('should register grep tool when useRipgrep is true and it is available', async () => {
      vi.mocked(canUseRipgrep).mockResolvedValue(true);
      await initConfig({ useRipgrep: true });

      // Exactly one grep tool is registered.
      expect(grepRegistrations().length).toBe(1);
      expect(canUseRipgrep).toHaveBeenCalledWith(true);
    });

    it('should register grep tool with system ripgrep when useBuiltinRipgrep is false', async () => {
      vi.mocked(canUseRipgrep).mockResolvedValue(true);
      await initConfig({ useRipgrep: true, useBuiltinRipgrep: false });

      expect(grepRegistrations().length).toBe(1);
      expect(canUseRipgrep).toHaveBeenCalledWith(false);
    });

    it.each([
      [
        'useBuiltinRipgrep is false but system ripgrep is not available',
        { useRipgrep: true, useBuiltinRipgrep: false },
        false,
      ],
      [
        'useRipgrep is true and builtin ripgrep is not available',
        { useRipgrep: true },
        true,
      ],
    ])(
      'should fall back to GrepTool and log error when %s',
      async (_label, params, builtin) => {
        vi.mocked(canUseRipgrep).mockResolvedValue(false);
        const config = await initConfig({ ...params });

        expect(grepRegistrations().length).toBe(1);
        expect(canUseRipgrep).toHaveBeenCalledWith(builtin);
        expect(logRipgrepFallback).toHaveBeenCalledWith(
          config,
          expect.any(RipgrepFallbackEvent),
        );
        expect(fallbackError()).toContain('ripgrep is not available');
      },
    );

    it('should fall back to GrepTool and log error when canUseRipgrep throws an error', async () => {
      const error = new Error('ripGrep check failed');
      vi.mocked(canUseRipgrep).mockRejectedValue(error);
      const config = await initConfig({ useRipgrep: true });

      expect(grepRegistrations().length).toBe(1);
      expect(logRipgrepFallback).toHaveBeenCalledWith(
        config,
        expect.any(RipgrepFallbackEvent),
      );
      expect(fallbackError()).toBe(`ripGrep check failed`);
    });

    it('should register GrepTool when useRipgrep is false', async () => {
      await initConfig({ useRipgrep: false });

      expect(grepRegistrations().length).toBe(1);
      expect(canUseRipgrep).not.toHaveBeenCalled();
    });
  });
});

describe('disabledTools runtime sync (#4282 fold-in 5 P2-2 / #4297 fold-in 5)', () => {
  const baseParams = MINIMAL_PARAMS;
  const withDisabled = (disabledTools: string[]) =>
    new Config({ ...baseParams, disabledTools });

  it('initializes from `disabledTools` ConfigParameters', () => {
    expect(withDisabled(['Foo', 'Bar']).getDisabledTools()).toEqual(
      new Set(['Foo', 'Bar']),
    );
  });

  it('defaults to an empty set when `disabledTools` is omitted', () => {
    expect(new Config(baseParams).getDisabledTools()).toEqual(new Set());
  });

  it('setDisabledTools replaces the live snapshot for runtime sync', () => {
    // The daemon's `acpAgent` MCP-restart handler calls
    // `setDisabledTools(new Set(disabledList))` after re-reading workspace
    // settings, so a `tools.disabled` toggle since construction applies on the
    // next `ToolRegistry.registerTool`. A regression dropping the setter (or
    // re-freezing the field) would silently re-enable just-disabled tools.
    const config = withDisabled(['A', 'B']);
    expect(config.getDisabledTools()).toEqual(new Set(['A', 'B']));
    config.setDisabledTools(new Set(['B', 'C']));
    expect(config.getDisabledTools()).toEqual(new Set(['B', 'C']));
  });

  it('setDisabledTools copies the input — caller mutations do not leak', () => {
    // The setter copies its input (`new Set(disabled)`), so a caller mutating
    // its own set later cannot retroactively change the live snapshot.
    const config = new Config(baseParams);
    const liveInput = new Set(['X']);
    config.setDisabledTools(liveInput);
    liveInput.add('Y');
    expect(config.getDisabledTools()).toEqual(new Set(['X']));
    expect(config.getDisabledTools().has('Y')).toBe(false);
  });

  it('setDisabledTools accepts an empty set (clears the live snapshot)', () => {
    const config = withDisabled(['A', 'B']);
    config.setDisabledTools(new Set());
    expect(config.getDisabledTools()).toEqual(new Set());
  });
});

describe('visibleTools', () => {
  const baseParams = MINIMAL_PARAMS;
  const withVisible = (visibleTools: string[]) =>
    new Config({ ...baseParams, visibleTools });

  it('initializes from `visibleTools` ConfigParameters', () => {
    expect(withVisible(['Foo', 'Bar']).getVisibleTools()).toEqual(
      new Set(['Foo', 'Bar']),
    );
  });

  it('defaults to an empty set when `visibleTools` is omitted', () => {
    expect(new Config(baseParams).getVisibleTools()).toEqual(new Set());
  });

  it('filters out non-string entries', () => {
    const config = withVisible([
      'tool_a',
      42 as unknown as string,
      null as unknown as string,
      'tool_b',
    ]);
    expect(config.getVisibleTools()).toEqual(new Set(['tool_a', 'tool_b']));
  });

  it('is readonly — returned set preserves config state', () => {
    const config = withVisible(['web_fetch']);
    const set = config.getVisibleTools();
    expect(set.has('web_fetch')).toBe(true);
    // always returns the same reference
    expect(config.getVisibleTools()).toBe(set);
  });
});

describe('BaseLlmClient Lifecycle', () => {
  const baseParams: ConfigParameters = {
    cwd: '/tmp',
    embeddingModel: 'gemini-embedding',
    sandbox: { command: 'docker', image: 'gemini-cli-sandbox' },
    targetDir: '/path/to/target',
    debugMode: false,
    question: 'test question',
    userMemory: 'Test User Memory',
    telemetry: { enabled: false },
    model: 'gemini-pro',
    chatRecording: false,
    usageStatisticsEnabled: false,
  };

  it('should throw an error if getBaseLlmClient is called before refreshAuth', () => {
    const config = new Config(baseParams);
    expect(() => config.getBaseLlmClient()).toThrow(
      'BaseLlmClient not initialized. Ensure authentication has occurred and ContentGenerator is ready.',
    );
  });

  it('should successfully initialize BaseLlmClient after refreshAuth is called', async () => {
    const config = new Config(baseParams);
    resolveGeneratorTo({ model: 'gemini-flash', apiKey: 'test-key' });

    await config.refreshAuth(AuthType.USE_GEMINI);

    expect(config.getBaseLlmClient()).toBeDefined();
    expect(BaseLlmClient).toHaveBeenCalledWith(
      config.getContentGenerator(),
      config,
    );
  });

  it('reads current provider protocols through the reloaded model registry', () => {
    const providers = { alternate: [{ id: 'test-model' }] };
    const config = new Config({
      ...baseParams,
      modelProvidersConfig: providers,
      providerProtocolConfig: { alternate: 'openai' },
    });
    expect(config.getProviderProtocolConfig()).toEqual({ alternate: 'openai' });
    config.reloadModelProvidersConfig(providers, { alternate: 'gemini' });
    expect(config.getProviderProtocolConfig()).toEqual({ alternate: 'gemini' });
    config.reloadModelProvidersConfig({});
    expect(config.getProviderProtocolConfig()).toEqual({ alternate: 'gemini' });
    expect(config.getModelProvidersConfig()).toEqual({});
    config.reloadModelProvidersConfig(providers, {});
    expect(config.getProviderProtocolConfig()).toEqual({});
    expect(config.getModelProvidersConfig()).toEqual(providers);
  });

  it('clears per-model generators when provider config is reloaded', async () => {
    const config = new Config(baseParams);
    resolveGeneratorTo({ model: 'gemini-flash', apiKey: 'test-key' });
    await config.refreshAuth(AuthType.USE_GEMINI);

    const llmService = config.getBaseLlmClient();
    const activeGenerator = config.getContentGenerator();
    config.reloadModelProvidersConfig({});

    expect(llmService.clearPerModelGeneratorCache).toHaveBeenCalledOnce();
    expect(config.getContentGenerator()).toBe(activeGenerator);
  });
});

describe('Model Switching and Config Updates', () => {
  const baseParams: ConfigParameters = {
    cwd: '/tmp',
    targetDir: '/path/to/target',
    debugMode: false,
    model: 'qwen3-coder-plus',
    chatRecording: false,
    usageStatisticsEnabled: false,
    telemetry: { enabled: false },
  };
  /** A Config built from baseParams with the given parameter overrides. */
  const makeConfig = (overrides: Partial<ConfigParameters> = {}) =>
    new Config({ ...baseParams, ...overrides });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** A qwen-oauth generator config for `model`, plus `extra`. */
  const qwenGenerator = (
    model: string,
    extra: Partial<ContentGeneratorConfig> = {},
  ): ContentGeneratorConfig => ({
    model,
    authType: AuthType.QWEN_OAUTH,
    apiKey: 'test-key',
    ...extra,
  });
  /** A Config authenticated as qwen-oauth against `initial`. */
  const authenticated = async (
    initial: ContentGeneratorConfig,
    sources?: GeneratorSources,
  ) => {
    const config = new Config(baseParams);
    resolveGeneratorTo(initial, sources);
    await config.refreshAuth(AuthType.QWEN_OAUTH);
    return config;
  };
  /** Hot-switch `config` to `next`, the way ModelsConfig.switchModel does. */
  const switchTo = (
    config: Config,
    next: ContentGeneratorConfig,
    sources?: GeneratorSources,
    authType = AuthType.QWEN_OAUTH,
    requiresRefresh = false,
  ) => {
    resolveGeneratorTo(next, sources);
    return internals(config).handleModelChange(authType, requiresRefresh);
  };

  it('should update contextWindowSize when switching models with hot-update', async () => {
    const config = await authenticated(
      qwenGenerator('qwen3-coder-plus', {
        contextWindowSize: 1_000_000,
        samplingParams: { temperature: 0.7 },
        enableCacheControl: true,
        forceGlobalCacheScope: true,
      }),
      {
        model: { kind: 'settings' },
        contextWindowSize: { kind: 'computed', detail: 'auto' },
      },
    );
    const contentGenConfig = config.getContentGeneratorConfig();
    expect(contentGenConfig['model']).toBe('qwen3-coder-plus');
    expect(contentGenConfig['contextWindowSize']).toBe(1_000_000);

    // Switch to a model with different token limits.
    await switchTo(
      config,
      qwenGenerator('qwen-max', {
        contextWindowSize: 128_000,
        samplingParams: { temperature: 0.8 },
        enableCacheControl: false,
        forceGlobalCacheScope: false,
        toolResultContentFormat: 'string',
        modalities: { image: true },
      }),
      {
        model: { kind: 'programmatic', detail: 'user' },
        contextWindowSize: { kind: 'computed', detail: 'auto' },
        samplingParams: { kind: 'settings' },
        enableCacheControl: { kind: 'settings' },
        forceGlobalCacheScope: { kind: 'settings' },
        toolResultContentFormat: { kind: 'settings' },
        modalities: { kind: 'computed', detail: 'auto' },
      },
    );

    const updatedConfig = config.getContentGeneratorConfig();
    expect(updatedConfig['model']).toBe('qwen-max');
    expect(updatedConfig['contextWindowSize']).toBe(128_000);
    expect(updatedConfig['samplingParams']?.temperature).toBe(0.8);
    expect(updatedConfig['enableCacheControl']).toBe(false);
    expect(updatedConfig['forceGlobalCacheScope']).toBe(false);
    expect(updatedConfig['toolResultContentFormat']).toBe('string');
    // Modalities are model-derived; a hot switch must refresh them so the
    // vision-bridge gate (getEffectiveInputModalities()) sees the new model.
    expect(updatedConfig['modalities']).toEqual({ image: true });
    expect(config.getEffectiveInputModalities()).toEqual({ image: true });

    const sources = config.getContentGeneratorConfigSources();
    expect(sources['model']?.kind).toBe('programmatic');
    expect(sources['model']?.detail).toBe('user');
    expect(sources['contextWindowSize']?.kind).toBe('computed');
    expect(sources['contextWindowSize']?.detail).toBe('auto');
    expect(sources['samplingParams']?.kind).toBe('settings');
    expect(sources['enableCacheControl']?.kind).toBe('settings');
    expect(sources['forceGlobalCacheScope']?.kind).toBe('settings');
    expect(sources['toolResultContentFormat']?.kind).toBe('settings');
    expect(sources['modalities']?.kind).toBe('computed');
  });

  it('carries enableRequestMetadata across a qwen-oauth hot model switch', async () => {
    // The DashScope provider reads enableRequestMetadata off its own
    // contentGeneratorConfig, which on the main route is this same object. A
    // hot switch rebuilds it field by field, so a per-model override that is
    // not copied would leave the gate reading the previous model's value.
    const config = await authenticated(
      qwenGenerator('qwen3-coder-plus', { enableRequestMetadata: false }),
      {
        model: { kind: 'settings' },
        enableRequestMetadata: { kind: 'settings' },
      },
    );
    expect(config.getContentGeneratorConfig()['enableRequestMetadata']).toBe(
      false,
    );

    await switchTo(
      config,
      qwenGenerator('qwen-max', { enableRequestMetadata: true }),
      {
        model: { kind: 'programmatic', detail: 'user' },
        enableRequestMetadata: { kind: 'settings', detail: 'model' },
      },
    );

    expect(config.getContentGeneratorConfig()['enableRequestMetadata']).toBe(
      true,
    );
    const sources = config.getContentGeneratorConfigSources();
    expect(sources['enableRequestMetadata']?.kind).toBe('settings');
    expect(sources['enableRequestMetadata']?.detail).toBe('model');
  });

  it('should trigger full refresh when switching to non-qwen-oauth provider', async () => {
    const config = await authenticated(
      qwenGenerator('qwen3-coder-plus', { contextWindowSize: 1_000_000 }),
    );
    const refreshAuthSpy = vi.spyOn(config, 'refreshAuth');

    // A different auth type takes the full refresh path.
    await switchTo(
      config,
      qwenGenerator('gemini-flash', {
        authType: AuthType.USE_GEMINI,
        apiKey: 'gemini-key',
        contextWindowSize: 32_000,
      }),
      undefined,
      AuthType.USE_GEMINI,
      true,
    );

    expect(refreshAuthSpy).toHaveBeenCalledWith(AuthType.USE_GEMINI);
  });

  it('should handle model switch when contextWindowSize is undefined', async () => {
    const config = await authenticated(
      qwenGenerator('qwen3-coder-plus', { contextWindowSize: undefined }),
    );

    await switchTo(
      config,
      qwenGenerator('qwen-max', { contextWindowSize: 128_000 }),
    );

    // Limits are now defined.
    expect(config.getContentGeneratorConfig()['contextWindowSize']).toBe(
      128_000,
    );
  });

  describe('hasHooksForEvent', () => {
    it('should return false when hookSystem is not initialized', () => {
      expect(new Config(baseParams).hasHooksForEvent('Stop')).toBe(false);
    });

    it.each([
      [
        'should delegate to hookSystem.hasHooksForEvent when hookSystem exists',
        'UserPromptSubmit',
        true,
      ],
      [
        'should return false when hookSystem has no hooks for the event',
        'Stop',
        false,
      ],
    ])('%s', (_title, eventName, hasHooks) => {
      const config = new Config(baseParams);
      const hasHooksForEvent = vi.fn().mockReturnValue(hasHooks);
      internals(config).hookSystem = { hasHooksForEvent };

      expect(config.hasHooksForEvent(eventName)).toBe(hasHooks);
      expect(hasHooksForEvent).toHaveBeenCalledWith(
        eventName,
        expect.any(String),
      );
    });
  });

  describe('runtime ContentGenerator view (AsyncLocalStorage)', () => {
    // The Config getters consult the per-run ALS view published by the agent
    // runtime when a sub-agent runs on a different model than the parent:
    // tools that captured the parent Config at construction must still
    // resolve to the agent's values inside the agent's runtime frame.
    const generator = () =>
      ({ generateContentStream: vi.fn() }) as unknown as ContentGenerator;
    /** A Config whose instance fields hold `contentGenerator` and `generatorConfig`. */
    function configWithInstanceFields(
      contentGenerator: ContentGenerator,
      generatorConfig: ContentGeneratorConfig,
    ): Config {
      const config = new Config(baseParams);
      internals(config).contentGenerator = contentGenerator;
      internals(config).contentGeneratorConfig = generatorConfig;
      return config;
    }

    it('resolves getters to the runtime view inside the frame, instance fields outside', async () => {
      const { runWithRuntimeContentGenerator } = await import(
        '../agents/runtime/agent-context.js'
      );
      const parentGenerator = generator();
      const parentGeneratorConfig: ContentGeneratorConfig = {
        model: 'parent-model',
        authType: AuthType.QWEN_OAUTH,
        apiKey: 'parent-key',
      };
      const config = configWithInstanceFields(
        parentGenerator,
        parentGeneratorConfig,
      );
      const agentGenerator = generator();
      const agentGeneratorConfig: ContentGeneratorConfig = {
        model: 'agent-model',
        authType: AuthType.USE_OPENAI,
        apiKey: 'agent-key',
      };

      // Outside the frame, getters resolve to the parent's instance fields.
      expect(config.getContentGenerator()).toBe(parentGenerator);
      expect(config.getContentGeneratorConfig()).toBe(parentGeneratorConfig);
      expect(config.getModel()).toBe('parent-model');
      expect(config.getAuthType()).toBe(AuthType.QWEN_OAUTH);

      // Inside the frame, every getter resolves to the agent's view.
      await runWithRuntimeContentGenerator(
        {
          contentGenerator: agentGenerator,
          contentGeneratorConfig: agentGeneratorConfig,
        },
        async () => {
          expect(config.getContentGenerator()).toBe(agentGenerator);
          expect(config.getContentGeneratorConfig()).toBe(agentGeneratorConfig);
          expect(config.getModel()).toBe('agent-model');
          expect(config.getAuthType()).toBe(AuthType.USE_OPENAI);
        },
      );

      // Frame exit restores resolution to the parent's instance fields.
      expect(config.getContentGenerator()).toBe(parentGenerator);
      expect(config.getModel()).toBe('parent-model');
    });

    it('falls back to the parent model id when the runtime view config has no model', async () => {
      const { runWithRuntimeContentGenerator } = await import(
        '../agents/runtime/agent-context.js'
      );
      const config = configWithInstanceFields(generator(), {
        model: 'parent-model',
        authType: AuthType.QWEN_OAUTH,
      } as ContentGeneratorConfig);

      await runWithRuntimeContentGenerator(
        {
          contentGenerator: generator(),
          contentGeneratorConfig: {
            model: '',
            authType: AuthType.USE_OPENAI,
          } as ContentGeneratorConfig,
        },
        async () => {
          // Empty model on the runtime view falls through to modelsConfig.
          expect(config.getModel()).toBe(baseParams.model);
        },
      );
    });
  });

  /** An initialized-looking Config with `mcpServers` in its settings layer. */
  const liveMcpConfig = (mcpServers?: Record<string, MCPServerConfig>) => {
    const config = makeConfig(mcpServers ? { mcpServers } : {});
    internals(config).initialized = true;
    return config;
  };

  describe('Config runtime MCP overlay', () => {
    it('addRuntimeMcpServer does not mutate this.mcpServers', () => {
      // Post-init state, so the runtime overlay is what gets written.
      const config = liveMcpConfig({
        'settings-server': new MCPServerConfig('cmd-a'),
      });
      config.addRuntimeMcpServer(
        'runtime-server',
        new MCPServerConfig('cmd-b'),
      );
      const settingsLayer = internals(config).mcpServers;
      expect(Object.keys(settingsLayer)).toEqual(['settings-server']);
      expect(settingsLayer['runtime-server']).toBeUndefined();
    });

    it('removeRuntimeMcpServer returns false when name not present', () => {
      expect(
        new Config(baseParams).removeRuntimeMcpServer('does-not-exist'),
      ).toBe(false);
    });

    it('removeRuntimeMcpServer returns true and drops the entry', () => {
      const config = liveMcpConfig();
      config.addRuntimeMcpServer('x', new MCPServerConfig('cmd'));
      expect(config.removeRuntimeMcpServer('x')).toBe(true);
      expect(config.removeRuntimeMcpServer('x')).toBe(false);
    });
  });

  describe('getMcpServers cascade with runtime overlay', () => {
    /** Settings `shared` runs settings-cmd; the runtime overlay runs runtime-cmd. */
    const overlaidShared = () => {
      const config = liveMcpConfig({
        shared: new MCPServerConfig('settings-cmd'),
      });
      config.addRuntimeMcpServer('shared', new MCPServerConfig('runtime-cmd'));
      return config;
    };

    it('runtime layer overlays settings layer (last write wins)', () => {
      expect(overlaidShared().getMcpServers()!['shared'].command).toBe(
        'runtime-cmd',
      );
    });

    it('runtime-only entries appear in cascade', () => {
      const config = liveMcpConfig({});
      config.addRuntimeMcpServer('only-runtime', new MCPServerConfig('cmd'));
      expect(config.getMcpServers()!['only-runtime']).toBeDefined();
    });

    it('removing runtime entry restores settings entry', () => {
      const config = overlaidShared();
      expect(config.getMcpServers()!['shared'].command).toBe('runtime-cmd');
      config.removeRuntimeMcpServer('shared');
      expect(config.getMcpServers()!['shared'].command).toBe('settings-cmd');
    });

    it('isMcpServerDisabled still flags runtime entries when excluded', () => {
      const config = liveMcpConfig();
      config.addRuntimeMcpServer('blocked', new MCPServerConfig('cmd'));
      config.setExcludedMcpServers(['blocked']);
      // The entry appears in getMcpServers (UI layer filters via isMcpServerDisabled)
      expect(config.getMcpServers()!['blocked']).toBeDefined();
      expect(config.isMcpServerDisabled('blocked')).toBe(true);
    });
  });

  describe('getModelDisplayName', () => {
    const gpt4oRegistry = (model: string) =>
      makeConfig({
        authType: AuthType.USE_OPENAI,
        model,
        modelProvidersConfig: {
          [AuthType.USE_OPENAI]: [
            route(
              'gpt-4o',
              'https://api.openai.example.com/v1',
              'OPENAI_API_KEY',
              {
                name: 'GPT-4o',
              },
            ),
          ],
        },
      });

    it('should return resolved name when model is in registry', () => {
      expect(gpt4oRegistry('gpt-4o').getModelDisplayName()).toBe('GPT-4o');
    });

    it('should return raw modelId when model is not in registry', () => {
      expect(gpt4oRegistry('custom-runtime-model').getModelDisplayName()).toBe(
        'custom-runtime-model',
      );
    });

    it('should return raw modelId when currentAuthType is falsy', () => {
      // No authType: getModel() returns 'some-model' and getModelDisplayName
      // returns it as-is.
      expect(makeConfig({ model: 'some-model' }).getModelDisplayName()).toBe(
        'some-model',
      );
    });
  });

  describe('getAutoSkillConfirmEnabled', () => {
    it.each([
      ['defaults to true when autoSkillConfirm is unset', {}, true],
      [
        'returns false when autoSkillConfirm is explicitly disabled',
        { autoSkillConfirm: false },
        false,
      ],
      [
        'is forced false in bare mode even when autoSkillConfirm is true',
        { autoSkillConfirm: true, bareMode: true },
        false,
      ],
    ])('%s', (_title, params, expected) => {
      expect(makeConfig(params).getAutoSkillConfirmEnabled()).toBe(expected);
    });
  });

  describe('MCP Stop dispatch with context usage data', () => {
    it('buildContextUsage handles MCP input patterns with runtime validation', async () => {
      // buildContextUsage backs MCP Stop dispatch; this pins its runtime type
      // coercion and edge cases.
      const { buildContextUsage } = await import('../hooks/context-usage.js');

      expect(buildContextUsage(128000, 64000)).toEqual({
        context_usage: 0.5,
        context_limit: 128000,
        input_tokens: 64000,
      });
      // Missing context_limit, zero input_tokens (the default), or both.
      expect(buildContextUsage(undefined, 64000)).toBeUndefined();
      expect(buildContextUsage(128000, 0)).toBeUndefined();
      expect(buildContextUsage(undefined, 0)).toBeUndefined();
      // Strings (MCP might send them) fail Number.isFinite, valid or not.
      // @ts-expect-error - testing runtime validation
      expect(buildContextUsage('128000', 64000)).toBeUndefined();
      // @ts-expect-error - testing runtime validation
      expect(buildContextUsage('invalid', 64000)).toBeUndefined();
      // Negative values and a zero context_limit.
      expect(buildContextUsage(-128000, 64000)).toBeUndefined();
      expect(buildContextUsage(128000, -64000)).toBeUndefined();
      expect(buildContextUsage(0, 64000)).toBeUndefined();
    });
  });

  /**
   * An initialized Config whose hook system is replaced by `hookSystem`, with
   * a test runtime id unless the double declares its own.
   */
  const withHookSystem = async (hookSystem: object) => {
    const config = makeConfig();
    await config.initialize();
    if (!('runtimeId' in hookSystem)) {
      Object.assign(hookSystem, { runtimeId: 'test-hook-runtime' });
    }
    internals(config).hookSystem = hookSystem;
    return config;
  };

  describe('UserPromptSubmit dispatch through the hook execution bridge', () => {
    it.each([
      {
        name: 'forwards a string submitted prompt',
        submittedPrompt: 'submitted prompt',
        expected: 'submitted prompt',
      },
      {
        name: 'preserves surrounding whitespace on a non-empty prompt',
        submittedPrompt: '  submitted prompt  ',
        expected: '  submitted prompt  ',
      },
      {
        name: 'drops an empty submitted prompt',
        submittedPrompt: '',
        expected: undefined,
      },
      {
        name: 'drops a whitespace-only submitted prompt',
        submittedPrompt: ' \t\n ',
        expected: undefined,
      },
      {
        name: 'drops a numeric submitted prompt',
        submittedPrompt: 42,
        expected: undefined,
      },
      {
        name: 'drops an object submitted prompt',
        submittedPrompt: { text: 'submitted prompt' },
        expected: undefined,
      },
      {
        name: 'drops a null submitted prompt',
        submittedPrompt: null,
        expected: undefined,
      },
      {
        name: 'handles a missing submitted prompt',
        submittedPrompt: undefined,
        expected: undefined,
      },
    ])('$name', async ({ submittedPrompt, expected }) => {
      const fireUserPromptSubmitEvent = vi.fn().mockResolvedValue(undefined);
      const config = await withHookSystem({ fireUserPromptSubmitEvent });

      const response = await hookRequest(config, 'UserPromptSubmit', {
        prompt: 'model prompt',
        submitted_prompt: submittedPrompt,
      });

      expect(fireUserPromptSubmitEvent).toHaveBeenCalledWith(
        'model prompt',
        undefined,
        expected,
      );
      expect(response.success).toBe(true);
    });
  });

  describe('hook execution bridge ownership', () => {
    it.each(['missing', 'runtime', 'session', 'agent'] as const)(
      'rejects %s ownership before dispatch',
      async (invalid) => {
        const fire = vi.fn();
        const config = await withHookSystem({
          runtimeId: 'runtime-A',
          firePreToolUseEvent: fire,
        });
        const owner = captureHookExecutionOwner(config)!;
        const invalidOwner =
          invalid === 'missing'
            ? undefined
            : {
                ...owner,
                ...(invalid === 'runtime' ? { runtimeId: 'runtime-B' } : {}),
                ...(invalid === 'session' ? { sessionId: 'old-session' } : {}),
                ...(invalid === 'agent' ? { agentId: '' } : {}),
              };
        const response = await config
          .getMessageBus()!
          .request<HookExecutionRequest, HookExecutionResponse>(
            {
              type: MessageBusType.HOOK_EXECUTION_REQUEST,
              owner: invalidOwner,
              eventName: 'PreToolUse',
              input: { tool_name: 'read_file' },
            },
            MessageBusType.HOOK_EXECUTION_RESPONSE,
          );
        expect(response.success).toBe(false);
        expect(response.error?.message).toContain('owner');
        expect(fire).not.toHaveBeenCalled();
      },
    );

    it('dispatches with the captured owner rather than untrusted input metadata', async () => {
      const observed: unknown[] = [];
      const fire = vi.fn(async () => {
        observed.push(getHookExecutionOwner());
        return undefined;
      });
      const config = await withHookSystem({
        runtimeId: 'runtime-A',
        firePreToolUseEvent: fire,
      });
      const owner = captureHookExecutionOwner(config, 'A');
      const response = await config
        .getMessageBus()!
        .request<HookExecutionRequest, HookExecutionResponse>(
          {
            type: MessageBusType.HOOK_EXECUTION_REQUEST,
            owner,
            eventName: 'PreToolUse',
            input: {
              tool_name: 'read_file',
              agent_id: 'B',
              session_id: 'other-session',
            },
          },
          MessageBusType.HOOK_EXECUTION_RESPONSE,
        );
      expect(response.success).toBe(true);
      expect(observed).toEqual([owner]);
      expect(getHookExecutionOwner()).toBeUndefined();
    });
  });

  describe('every hook event through the hook execution bridge', () => {
    // The schema side has a drift guard derived from HookEventName; this is
    // the bus side. `eventName` is an open string on the wire, so the compiler
    // cannot catch a missing case, and `default:` replies with the same empty
    // success a real no-op produces.
    it.each(Object.values(HookEventName))(
      'routes %s to a hook system method instead of the unknown-event default',
      async (eventName) => {
        const called: string[] = [];
        // Every fire method resolves an empty aggregate, which each arm accepts.
        const hookSystem = new Proxy(
          {},
          {
            get: (_target, prop) => {
              if (prop === 'runtimeId') return 'test-hook-runtime';
              if (typeof prop !== 'string' || prop === 'then') {
                return undefined;
              }
              return vi.fn(async () => {
                called.push(prop);
                return {
                  success: true,
                  allOutputs: [],
                  errors: [],
                  totalDuration: 0,
                  finalOutput: undefined,
                };
              });
            },
          },
        );
        const config = await withHookSystem(hookSystem);
        const warn = vi.spyOn(config.getDebugLogger(), 'warn');

        const response = await hookRequest(config, eventName, {});

        expect(warn).not.toHaveBeenCalledWith(
          expect.stringContaining('Unknown hook event'),
        );
        expect(called.some((method) => method.startsWith('fire'))).toBe(true);
        expect(response.success).toBe(true);
      },
    );
  });

  describe('direct-call hook events through the hook execution bridge', () => {
    const dispatch = async (
      method: string,
      fire: ReturnType<typeof vi.fn>,
      eventName: string,
      input: Record<string, unknown>,
      signal: AbortSignal,
    ) =>
      hookRequest(
        await withHookSystem({ [method]: fire }),
        eventName,
        input,
        signal,
      );

    // Events whose fire method returns the hook output itself, or undefined
    // when no hook is configured.
    const directOutputRows = [
      {
        eventName: 'SessionStart',
        method: 'fireSessionStartEvent',
        input: {
          source: 'resume',
          model: 'qwen-max',
          permission_mode: 'plan',
          agent_type: 'Custom',
        },
        args: ['resume', 'qwen-max', 'plan', 'Custom'],
      },
      {
        eventName: 'SessionEnd',
        method: 'fireSessionEndEvent',
        input: { reason: 'clear' },
        args: ['clear'],
      },
      {
        eventName: 'SessionDelete',
        method: 'fireSessionDeleteEvent',
        input: { deleted_session_id: 'old-session' },
        args: ['old-session'],
      },
      {
        eventName: 'PreCompact',
        method: 'firePreCompactEvent',
        input: { trigger: 'manual', custom_instructions: 'keep todos' },
        args: ['manual', 'keep todos'],
      },
      {
        eventName: 'PostCompact',
        method: 'firePostCompactEvent',
        input: { trigger: 'auto', compact_summary: 'summary' },
        args: ['auto', 'summary'],
      },
      {
        eventName: 'InstructionsLoaded',
        method: 'fireInstructionsLoadedEvent',
        input: {
          file_path: '/repo/QWEN.md',
          memory_type: 'project',
          load_reason: 'session_start',
          trigger_file_path: '/repo/src/a.ts',
          parent_file_path: '/repo/QWEN.md',
        },
        args: [
          '/repo/QWEN.md',
          'project',
          'session_start',
          {
            triggerFilePath: '/repo/src/a.ts',
            parentFilePath: '/repo/QWEN.md',
          },
        ],
      },
    ];

    it('uses a declared AgentType in the SessionStart wire example', () => {
      // The wire carries a raw string and nothing downstream validates it, so
      // this row is the example an out-of-process producer copies.
      const row = directOutputRows.find(
        ({ eventName }) => eventName === 'SessionStart',
      )!;
      expect(Object.values(AgentType)).toContain(row.input['agent_type']);
    });

    it.each(directOutputRows)(
      'forwards $eventName to $method',
      async ({ eventName, method, input, args }) => {
        const output = { systemMessage: `${eventName} ran` };
        const fire = vi.fn().mockResolvedValue(output);
        const { signal } = new AbortController();

        const response = await dispatch(method, fire, eventName, input, signal);

        expect(fire).toHaveBeenCalledWith(...args, signal);
        expect(response.success).toBe(true);
        expect(response.output).toEqual(output);
      },
    );

    it.each(directOutputRows)(
      'replies with no output when no $eventName hook is configured',
      async ({ eventName, method, input, args }) => {
        const fire = vi.fn().mockResolvedValue(undefined);
        const { signal } = new AbortController();

        const response = await dispatch(method, fire, eventName, input, signal);

        // The call assertion also tells this arm apart from `default:`, which
        // publishes the same empty success reply without calling anything.
        expect(fire).toHaveBeenCalledWith(...args, signal);
        expect(response.success).toBe(true);
        expect(response.output).toBeUndefined();
      },
    );

    it.each([
      {
        eventName: 'TodoCreated',
        method: 'fireTodoCreatedEvent',
        input: {
          todo_id: '1',
          todo_content: 'write tests',
          todo_status: 'pending',
          all_todos: [],
          phase: 'validation',
        },
        args: ['1', 'write tests', 'pending', [], 'validation'],
      },
      {
        eventName: 'TodoCompleted',
        method: 'fireTodoCompletedEvent',
        input: {
          todo_id: '1',
          todo_content: 'write tests',
          previous_status: 'in_progress',
          all_todos: [],
          phase: 'postWrite',
        },
        args: ['1', 'write tests', 'in_progress', [], 'postWrite'],
      },
    ])(
      'forwards $eventName to $method and returns its final output',
      async ({ eventName, method, input, args }) => {
        // Two distinct outputs whose merge differs from the first, so
        // replying with one hook's output instead of the merged result fails.
        const finalOutput = { decision: 'block', reason: 'not yet' };
        const fire = vi.fn().mockResolvedValue({
          success: true,
          allOutputs: [{ decision: 'allow' }, finalOutput],
          errors: [],
          totalDuration: 1,
          finalOutput,
        });
        const { signal } = new AbortController();

        const response = await dispatch(method, fire, eventName, input, signal);

        expect(fire).toHaveBeenCalledWith(...args, signal);
        expect(response.success).toBe(true);
        expect(response.output).toEqual(finalOutput);
      },
    );

    it('awaits StopFailure hooks but replies with no output', async () => {
      // The shape HookAggregator returns for StopFailure: fire-and-forget,
      // outputs and errors dropped, no final output.
      const fire = vi.fn().mockResolvedValue({
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 3,
        finalOutput: undefined,
      });
      const { signal } = new AbortController();

      const response = await dispatch(
        'fireStopFailureEvent',
        fire,
        'StopFailure',
        {
          error: 'rate_limit',
          error_details: '429 Too Many Requests',
          last_assistant_message: 'partial',
        },
        signal,
      );

      expect(fire).toHaveBeenCalledWith(
        'rate_limit',
        '429 Too Many Requests',
        'partial',
        signal,
      );
      expect(response.success).toBe(true);
      expect(response.output).toBeUndefined();
    });
  });

  describe('Stop dispatch through the hook execution bridge', () => {
    // The goal-specific half of this suite went with the two response fields
    // it asserted. What remains is the only exercise of the surviving
    // `case 'Stop':` branch: without it, deleting that branch or throwing
    // inside it leaves the whole package green while every configured Stop
    // hook silently stops blocking.
    it('forwards the request input positionally, wraps the output, and counts the hooks that ran', async () => {
      const blockingOutput = {
        decision: 'block' as const,
        reason: 'Policy review is still required',
      };
      const secondOutput = { continue: true };
      const fireStopEvent = vi.fn().mockResolvedValue({
        finalOutput: blockingOutput,
        allOutputs: [blockingOutput, secondOutput],
      });
      const config = await withHookSystem({ fireStopEvent });

      const { signal } = new AbortController();
      const response = await hookRequest(
        config,
        'Stop',
        {
          stop_hook_active: true,
          last_assistant_message: 'last response',
          context_limit: 1_000,
          input_tokens: 250,
        },
        signal,
      );

      expect(response.error).toBeUndefined();
      expect(response.success).toBe(true);
      // Positional, so swapping the two strings is caught here rather than by
      // a consumer that happens to read only one of them.
      expect(fireStopEvent).toHaveBeenCalledWith(
        true,
        'last response',
        { context_usage: 0.25, context_limit: 1_000, input_tokens: 250 },
        signal,
      );
      // Read off the bridge response rather than through a consumer: both
      // consumers mask a missing value with `?? 1`, so an assertion made
      // through them would still pass if the producer stopped setting it.
      expect(response.stopHookCount).toBe(2);
      // The `createHookOutput('Stop', ...)` wrap: a plain object would carry
      // the same fields but none of the methods every consumer calls, so
      // without it no consumer can ask the output whether it blocks. Asserted
      // on the call, since this file's bare hooks mock returns undefined.
      expect(vi.mocked(createHookOutput)).toHaveBeenCalledWith(
        'Stop',
        blockingOutput,
      );
    });

    it('reports no output when every Stop hook declines to act', async () => {
      const fireStopEvent = vi.fn().mockResolvedValue({
        finalOutput: undefined,
        allOutputs: [],
      });
      const config = await withHookSystem({ fireStopEvent });

      const response = await hookRequest(config, 'Stop', {
        stop_hook_active: false,
      });

      expect(response.success).toBe(true);
      expect(response.output).toBeUndefined();
      expect(response.stopHookCount).toBe(0);
      // No final output means nothing to wrap.
      expect(vi.mocked(createHookOutput)).not.toHaveBeenCalled();
      // An absent last message is forwarded as the empty string, and usage
      // figures that cannot be computed are forwarded as undefined.
      expect(fireStopEvent).toHaveBeenCalledWith(
        false,
        '',
        undefined,
        undefined,
      );
    });
  });

  describe('MessageDisplay dispatch through the hook execution bridge', () => {
    const displayConfig = async () => {
      const fireMessageDisplayEvent = vi
        .fn()
        .mockResolvedValue({ finalOutput: undefined, allOutputs: [] });
      const config = await withHookSystem({ fireMessageDisplayEvent });
      return { config, fireMessageDisplayEvent };
    };

    it('extracts message_id/displayed_text/is_final from the request input and forwards them positionally', async () => {
      const { config, fireMessageDisplayEvent } = await displayConfig();
      expect(config.getMessageBus()).toBeDefined();

      const response = await hookRequest(config, 'MessageDisplay', {
        message_id: 'msg-123',
        displayed_text: 'Hello, world',
        is_final: true,
      });

      expect(fireMessageDisplayEvent).toHaveBeenCalledWith(
        'msg-123',
        'Hello, world',
        true,
        undefined,
      );
      expect(response.success).toBe(true);
    });

    it('defaults missing fields (empty message_id/text, is_final false) rather than throwing', async () => {
      const { config, fireMessageDisplayEvent } = await displayConfig();

      const response = await hookRequest(config, 'MessageDisplay', {});

      expect(fireMessageDisplayEvent).toHaveBeenCalledWith(
        '',
        '',
        false,
        undefined,
      );
      expect(response.success).toBe(true);
    });
  });

  /** A constructor-less Config, enough for the Todo reminder bookkeeping. */
  const bareConfig = () => Object.create(Config.prototype) as Config;

  it('moves only the continued work chain Todo reminder', () => {
    const config = bareConfig();
    const reminder = (id: string) => config.getActiveTodoReminder(id);
    config.setActiveTodoReminder('prompt-user', 'unfinished user work');
    config.setActiveTodoReminder('prompt-cron', 'unfinished cron work');

    config.startActiveTodoWorkChain('prompt-retry', 'prompt-user');

    expect(reminder('prompt-retry')).toBe('unfinished user work');
    expect(reminder('prompt-user')).toBe('unfinished user work');
    expect(reminder('prompt-cron')).toBeUndefined();
  });

  it('clears stale Todo reminders when a new ordinary work chain starts', () => {
    const config = bareConfig();
    config.startActiveTodoWorkChain('prompt-old');
    config.setActiveTodoReminder('prompt-old', 'old work');

    config.startActiveTodoWorkChain('prompt-new');

    expect(config.getActiveTodoReminder('prompt-new')).toBeUndefined();
    expect(config.getActiveTodoReminder('prompt-old')).toBeUndefined();
  });

  it('re-issues the active Todo reminder only every third tool turn', () => {
    const config = bareConfig();
    const take = (force?: boolean) =>
      config.takeActiveTodoReminder('prompt-user', force);
    config.startActiveTodoWorkChain('prompt-user');
    config.setActiveTodoReminder('prompt-user', 'unfinished work');

    expect(take()).toBeUndefined();
    expect(take()).toBeUndefined();
    expect(take()).toBe('unfinished work');
    expect(take()).toBeUndefined();

    expect(take(true)).toBe('unfinished work');
    expect(take()).toBeUndefined();
    expect(take()).toBeUndefined();
    expect(take()).toBe('unfinished work');

    config.setActiveTodoReminder('prompt-user', 'updated work');
    expect(take()).toBeUndefined();
  });

  it('moves related automatic work without clearing unrelated reminders', () => {
    const config = bareConfig();
    const reminder = (id: string) => config.getActiveTodoReminder(id);
    config.startActiveTodoWorkChain('prompt-user');
    config.setActiveTodoReminder('prompt-user', 'unfinished user work');
    config.startAutomaticActiveTodoWorkChain('prompt-unrelated');
    config.setActiveTodoReminder('prompt-unrelated', 'other work');

    config.startAutomaticActiveTodoWorkChain('prompt-cron');
    config.startAutomaticActiveTodoWorkChain(
      'prompt-related-notification',
      'prompt-user',
    );

    expect(reminder('prompt-user')).toBe('unfinished user work');
    expect(reminder('prompt-cron')).toBeUndefined();
    expect(reminder('prompt-related-notification')).toBe(
      'unfinished user work',
    );
    expect(
      config.getActiveTodoWorkChainOwner(
        'prompt-related-notification',
        'stale-owner',
      ),
    ).toBe('prompt-user');
    expect(
      config.getActiveTodoWorkChainOwner('prompt-unmapped', 'inherited-owner'),
    ).toBe('inherited-owner');
    expect(reminder('prompt-unrelated')).toBe('other work');

    config.endAutomaticActiveTodoWorkChain('prompt-cron');
    config.endAutomaticActiveTodoWorkChain('prompt-related-notification');

    expect(reminder('prompt-cron')).toBeUndefined();
    expect(reminder('prompt-user')).toBe('unfinished user work');

    config.startAutomaticActiveTodoWorkChain(
      'prompt-stale-notification',
      'prompt-stale-owner',
    );
    config.setActiveTodoReminder(
      'prompt-stale-notification',
      'stale automatic work',
    );
    config.endAutomaticActiveTodoWorkChain('prompt-stale-notification');

    expect(reminder('prompt-stale-owner')).toBeUndefined();
  });

  it('isolates active Todo reminders inherited through child Configs', () => {
    const parent = bareConfig();
    const child = deriveConfig(parent);
    parent.setActiveTodoReminder('parent-prompt', 'parent work');

    child.setActiveTodoReminder('child-prompt', 'child work');
    child.startActiveTodoWorkChain('child-retry', 'child-prompt');

    expect(parent.getActiveTodoReminder('parent-prompt')).toBe('parent work');
    expect(parent.getActiveTodoReminder('child-retry')).toBeUndefined();
    expect(child.getActiveTodoReminder('parent-prompt')).toBeUndefined();
    expect(child.getActiveTodoReminder('child-retry')).toBe('child work');
  });

  it('clears active Todo reminders for a new session', () => {
    const config = new Config(baseParams);
    config.setActiveTodoReminder('old-prompt', 'unfinished old work');
    config.startActiveTodoWorkChain('old-retry', 'old-prompt');

    config.startNewSession('new-session-id');

    expect(config.getActiveTodoReminder('old-prompt')).toBeUndefined();
    expect(config.getActiveTodoWorkChainOwner('old-retry')).toBe('old-retry');
  });

  /** A chain `prompt-user` → `prompt-user-2` with a live related automatic turn. */
  const continuedChainWithAutomaticTurn = (reminder: string) => {
    const config = bareConfig();
    config.startActiveTodoWorkChain('prompt-user');
    config.setActiveTodoReminder('prompt-user', reminder);
    config.startAutomaticActiveTodoWorkChain('prompt-auto', 'prompt-user');
    // The branch an ordinary turn routes through when a reminder is
    // registered (#10953): it must re-point the chain without orphaning the
    // live automatic turn's mapping.
    config.startActiveTodoWorkChain('prompt-user-2', 'prompt-user');
    return config;
  };

  it('keeps live related automatic-turn mappings when continuing a chain', () => {
    const config = continuedChainWithAutomaticTurn('R');

    // The automatic turn completes the whole plan: its todo_write must reach
    // the shared owner and delete the finished plan's reminder.
    config.setActiveTodoReminder('prompt-auto', undefined);

    expect(config.getActiveTodoReminder('prompt-user-2')).toBeUndefined();
  });

  it('keeps a live related automatic-turn mapping for a non-completing plan update', () => {
    // A related automatic turn's NON-completing todo_write (still unfinished
    // items) must resolve to the shared owner, so the updated plan lands under
    // the foreground chain instead of a stale copy stranded under the orphaned
    // automatic prompt id. The completing write in the sibling test clears
    // session-wide regardless of ownership, so only this write discriminates
    // the retention loop: `owners.clear()` would orphan `prompt-auto` to
    // itself and leave the superseded plan re-injected.
    const config = continuedChainWithAutomaticTurn('R1');

    config.setActiveTodoReminder('prompt-auto', 'R2');

    expect(config.getActiveTodoReminder('prompt-user-2')).toBe('R2');
  });

  it('clears the foreground reminder when an unrelated automatic turn completes the shared plan', () => {
    // An isolated cron/notification turn has no `continuedFrom`, so its
    // completion todo_write resolves to its own prompt id and, before the
    // session-wide clear, would leave the foreground reminder behind. The
    // plan file is session-scoped, so completion must clear every reminder.
    const config = bareConfig();
    config.startActiveTodoWorkChain('p1');
    config.setActiveTodoReminder('p1', 'R');
    config.startAutomaticActiveTodoWorkChain('p-cron');

    config.setActiveTodoReminder('p-cron', undefined);

    expect(config.getActiveTodoReminder('p1')).toBeUndefined();
  });

  it('does not carry the foreground reminder when the plan was last written by a foreign owner', () => {
    // The continuation guard carries a registered reminder only when the
    // foreground head still owns the session plan file. A real write from the
    // foreground records that ownership; an isolated cron/notification turn
    // that rewrites the plan under its own owner must flip the predicate off.
    const config = bareConfig();
    const carriesForeground = () =>
      config.getActiveTodoReminder('p1') !== undefined &&
      config.getActiveTodoWorkChainOwner('p1') ===
        config.getActiveTodoPlanWriterOwner();
    config.startActiveTodoWorkChain('p1');
    config.setActiveTodoReminder('p1', 'R1');
    config.recordActiveTodoPlanWriter('p1');

    expect(carriesForeground()).toBe(true);

    config.startAutomaticActiveTodoWorkChain('p-cron');
    config.recordActiveTodoPlanWriter('p-cron');
    config.setActiveTodoReminder('p-cron', 'R2');

    expect(carriesForeground()).toBe(false);
  });

  it('prunes the superseded foreground head when continuing a chain', () => {
    const config = bareConfig();
    config.startActiveTodoWorkChain('prompt-user-1');
    config.setActiveTodoReminder('prompt-user-1', 'R');

    config.startActiveTodoWorkChain('prompt-user-2', 'prompt-user-1');

    // The old head must no longer resolve to the shared owner; it falls back
    // to itself so the owners map does not grow one entry per continuation.
    expect(config.getActiveTodoWorkChainOwner('prompt-user-2', 'stale')).toBe(
      'prompt-user-1',
    );
    expect(config.getActiveTodoWorkChainOwner('prompt-user-1', 'stale')).toBe(
      'stale',
    );
  });

  it('clearActiveTodoReminders clears reminders, owners, and cadence counters', () => {
    const config = bareConfig();
    config.startActiveTodoWorkChain('prompt-user');
    config.setActiveTodoReminder('prompt-user', 'R');
    config.startAutomaticActiveTodoWorkChain('prompt-auto', 'prompt-user');

    config.clearActiveTodoReminders();

    expect(config.getActiveTodoReminder('prompt-user')).toBeUndefined();
    expect(config.getActiveTodoWorkChainOwner('prompt-user')).toBe(
      'prompt-user',
    );
    expect(config.getActiveTodoWorkChainOwner('prompt-auto')).toBe(
      'prompt-auto',
    );
    expect(config.takeActiveTodoReminder('prompt-user', true)).toBeUndefined();
  });
});

describe('applyWorkspaceAgentPersona', () => {
  const baseParams: ConfigParameters = {
    targetDir: '.',
    debugMode: false,
    model: 'test-model',
    cwd: '.',
    chatRecording: false,
  };

  const agentSession = () => {
    // The opt-in as well as the source type. Collaboration is off by default,
    // and `sourceType: 'agent'` alone deliberately does not open the surface —
    // these cases are about what an opted-in agent session gets, so they have
    // to say so.
    const config = new Config({
      ...baseParams,
      agentCollaborationEnabled: true,
    });
    config.setSessionSource('agent', 'ag_alice');
    return config;
  };

  it('puts the persona where the main session prompt is read from', () => {
    // The whole reason no new machinery was needed: the prompt path already
    // prefers an override over the core prompt.
    const config = agentSession();

    config.applyWorkspaceAgentPersona('You are alice.', 'alice');

    expect(config.getSystemPrompt()).toBe('You are alice.');
    expect(config.getWorkspaceAgentName()).toBe('alice');
  });

  it('is a workspace-agent session only with the opt-in and the agent source', () => {
    expect(agentSession().isWorkspaceAgentSession()).toBe(true);
    const optedOut = new Config(baseParams);
    optedOut.setSessionSource('agent', 'ag_alice');
    expect(optedOut.isWorkspaceAgentSession()).toBe(false);
    expect(new Config(baseParams).isWorkspaceAgentSession()).toBe(false);
  });

  it('registers collaboration tools for top-level agents, not ordinary sessions', async () => {
    // `registerFactory` is a single mock on the prototype, so every registry
    // shares one call log. Snapshot and clear between the two, or the ordinary
    // session inherits the agent's registrations and the negative half of this
    // test can never fail.
    const factory = ToolRegistry.prototype.registerFactory as unknown as Mock;
    factory.mockClear();
    await agentSession().createToolRegistry(undefined, { skipDiscovery: true });
    const agentTools = factory.mock.calls.map(([name]) => name as string);

    factory.mockClear();
    await new Config(baseParams).createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    const ordinaryTools = factory.mock.calls.map(([name]) => name as string);
    // Asserted against the recorded registrations, not `getAllToolNames`:
    // that method is stubbed to `[]` at module scope, so the positive half
    // could never pass and the negative half could never fail.
    for (const name of [
      'thread_post',
      'thread_read',
      'thread_create',
      'thread_wait',
      'thread_block',
      'thread_review',
    ]) {
      expect(agentTools).toContain(name);
      expect(ordinaryTools).not.toContain(name);
    }
  });

  it('registers no thread tools for a session-agents session', async () => {
    // Both collaboration surfaces coexist for now: a session the session-agents
    // orchestrator drives has no thread behind it, so its thread tools could
    // only ever throw "requires an active agent run context".
    const factory = ToolRegistry.prototype.registerFactory as unknown as Mock;
    factory.mockClear();
    const config = agentSession();
    config.markSessionAgentSession();
    await config.createToolRegistry(undefined, { skipDiscovery: true });
    const registered = factory.mock.calls.map(([name]) => name as string);
    for (const name of [
      'thread_post',
      'thread_read',
      'thread_create',
      'thread_wait',
      'thread_block',
      'thread_review',
    ]) {
      expect(registered).not.toContain(name);
    }
  });

  it('pins a session-agents session to default approval', () => {
    // Every write or command a session agent runs asks the person in the chat
    // session, whatever the settings say (session-multi-agent design §8-1).
    const config = new Config({
      ...baseParams,
      agentCollaborationEnabled: true,
      approvalMode: ApprovalMode.YOLO,
    });
    config.setSessionSource('agent', 'ag_alice');
    expect(config.getApprovalMode()).toBe(ApprovalMode.YOLO);
    config.markSessionAgentSession();
    expect(config.getApprovalMode()).toBe(ApprovalMode.DEFAULT);

    for (const mode of [
      ApprovalMode.YOLO,
      ApprovalMode.AUTO_EDIT,
      ApprovalMode.AUTO,
    ]) {
      expect(() => config.setApprovalMode(mode)).toThrow(/stays "default"/);
      expect(config.getApprovalMode()).toBe(ApprovalMode.DEFAULT);
    }
    expect(() => config.setPlanMode(true, ApprovalMode.AUTO_EDIT)).toThrow(
      /stays "default"/,
    );
    config.setApprovalMode(ApprovalMode.PLAN);
    expect(config.getApprovalMode()).toBe(ApprovalMode.PLAN);
    config.setApprovalMode(ApprovalMode.DEFAULT);
    expect(config.getApprovalMode()).toBe(ApprovalMode.DEFAULT);
    // A subagent it starts cannot widen it either.
    expect(
      deriveApprovalModeConfig(
        config,
        ApprovalMode.YOLO,
      ).config.getApprovalMode(),
    ).toBe(ApprovalMode.DEFAULT);
  });

  it('refuses on a session that is not an agent', () => {
    // Otherwise any session could be handed a persona and post under a name
    // that is not its own.
    expect(() =>
      new Config(baseParams).applyWorkspaceAgentPersona('x', 'alice'),
    ).toThrow(/only be applied to an agent session/);
  });

  it('enforces the persona tool subset without widening the read-only ceiling', async () => {
    const config = agentSession();
    config.applyWorkspaceAgentPersona('Read only', 'alice', [
      'read_file',
      'thread_review',
      'write_file',
    ]);
    const guard = config.getToolInvocationGuard()!;
    for (const toolName of [
      'read_file',
      'thread_review',
      'write_file',
      'glob',
    ]) {
      const result = await guard({
        callId: 'guard-check',
        toolName,
        args: {},
        signal: new AbortController().signal,
      });
      expect(result.allowed).toBe(
        toolName === 'read_file' || toolName === 'thread_review',
      );
    }
  });

  it("enforces a session agent's deny-only definition", async () => {
    const config = agentSession();
    config.markSessionAgentSession();
    const toolConfig = buildSessionAgentToolConfig({
      tools: ['*'],
      disallowedTools: ['write_file'],
    });
    config.applyWorkspaceAgentPersona(
      'You are alice.',
      'alice',
      toolConfig.executionAllowedTools,
      toolConfig.disallowedTools,
    );
    const guard = config.getToolInvocationGuard()!;
    for (const [toolName, allowed] of [
      ['write_file', false],
      ['read_file', true],
    ] as const) {
      const result = await guard({
        callId: 'guard-check',
        toolName,
        args: {},
        signal: new AbortController().signal,
      });
      expect(result.allowed).toBe(allowed);
    }
  });

  it('keeps agent-host sessions read-only without collaboration tools', async () => {
    const config = new Config(baseParams);
    config.setSessionSource('agent-host', 'host_1');
    const guard = config.getToolInvocationGuard()!;

    for (const [toolName, args, allowed] of [
      [ToolNames.READ_FILE, { file_path: path.resolve('package.json') }, true],
      ['mcp__trusted__write', {}, false],
      ['unknown_tool', {}, false],
      [ToolNames.WRITE_FILE, {}, false],
      [ToolNames.SHELL, {}, false],
    ] as const) {
      const result = await guard({
        callId: 'host-guard-check',
        toolName,
        args,
        signal: new AbortController().signal,
      });
      expect(result.allowed).toBe(allowed);
    }

    const factory = ToolRegistry.prototype.registerFactory as unknown as Mock;
    factory.mockClear();
    await config.createToolRegistry(undefined, { skipDiscovery: true });
    const registered = factory.mock.calls.map(([name]) => name as string);
    for (const toolName of [
      'thread_post',
      'thread_read',
      'thread_create',
      'thread_wait',
      'thread_block',
      'thread_review',
    ]) {
      expect(registered).not.toContain(toolName);
    }
  });

  it('confines agent-host reads to the canonical workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-host-guard-'));
    const workspace = path.join(root, 'workspace');
    const outside = path.join(root, 'outside');
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(path.join(workspace, 'inside.txt'), 'inside');
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    const escape = path.join(workspace, 'escape');
    fs.symlinkSync(
      outside,
      escape,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    // The file-wide node:fs mock resolves realpathSync to the identity, so the
    // symlink is only followed when this test maps it to its real target.
    vi.mocked(fs.realpathSync).mockImplementation((pathToResolve) => {
      const resolvedPath = pathToResolve.toString();
      if (resolvedPath === escape) {
        return outside;
      }
      if (resolvedPath.startsWith(escape + path.sep)) {
        return path.join(outside, resolvedPath.slice(escape.length + 1));
      }
      return resolvedPath;
    });

    try {
      const config = new Config({
        ...baseParams,
        targetDir: workspace,
        cwd: workspace,
      });
      config.setSessionSource('agent-host', 'host_1');
      const guard = config.getToolInvocationGuard()!;
      const check = (toolName: string, args: Record<string, unknown>) =>
        guard({
          callId: 'host-path-check',
          toolName,
          args,
          signal: new AbortController().signal,
          cwd: workspace,
        });

      await expect(
        check(ToolNames.READ_FILE, {
          file_path: path.join(workspace, 'inside.txt'),
        }),
      ).resolves.toEqual({ allowed: true });
      await expect(
        check(ToolNames.GREP, { pattern: 'inside' }),
      ).resolves.toEqual({ allowed: true });
      await expect(
        check(ToolNames.READ_FILE, {
          file_path: path.join(
            os.homedir(),
            '.qwen',
            'agent-hosts',
            'host.json',
          ),
        }),
      ).resolves.toEqual(expect.objectContaining({ allowed: false }));
      await expect(
        check(ToolNames.READ_FILE, {
          file_path: path.join(workspace, 'escape', 'secret.txt'),
        }),
      ).resolves.toEqual(expect.objectContaining({ allowed: false }));
      await expect(check(ToolNames.LS, { path: outside })).resolves.toEqual(
        expect.objectContaining({ allowed: false }),
      );
      await expect(
        check(ToolNames.GREP, { pattern: 'secret', glob: '../outside/**' }),
      ).resolves.toEqual(expect.objectContaining({ allowed: false }));
      await expect(
        check(ToolNames.GLOB, {
          pattern: '**/*',
          path: workspace,
        }),
      ).resolves.toEqual(expect.objectContaining({ allowed: false }));
      await expect(
        check(ToolNames.ZOOM_IMAGE, {
          file_path: path.join(workspace, 'inside.txt'),
        }),
      ).resolves.toEqual(expect.objectContaining({ allowed: false }));
    } finally {
      vi.mocked(fs.realpathSync).mockImplementation((pathToResolve) =>
        pathToResolve.toString(),
      );
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses on a session belonging to another source', () => {
    const config = new Config(baseParams);
    config.setSessionSource('agent-host', 'ws_1');

    expect(() => config.applyWorkspaceAgentPersona('x', 'alice')).toThrow(
      /only be applied to an agent session/,
    );
  });

  it('refuses a second persona rather than changing one in place', () => {
    // A session's prompt is part of what its transcript means; swapping it
    // under a running conversation would make the record a lie.
    const config = agentSession();
    config.applyWorkspaceAgentPersona('You are alice.', 'alice');

    expect(() =>
      config.applyWorkspaceAgentPersona('You are bob.', 'bob'),
    ).toThrow(/already has a persona/);
    expect(config.getSystemPrompt()).toBe('You are alice.');
    expect(config.getWorkspaceAgentName()).toBe('alice');
  });

  it('names no agent on a session that never had a persona applied', () => {
    expect(new Config(baseParams).getWorkspaceAgentName()).toBeUndefined();
  });
});

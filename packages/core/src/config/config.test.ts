/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import { mkdir, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import type { ConfigParameters, SandboxConfig } from './config.js';
import {
  Config,
  ApprovalMode,
  APPROVAL_MODES,
  APPROVAL_MODE_INFO,
  MCPServerConfig,
  deriveAgentConfig,
  deriveConfig,
  deriveWorktreeConfig,
  TrustGateError,
  matchesServerPattern,
  matchesAnyServerPattern,
  GOAL_TOKEN_BUDGET_CAP,
  normalizeGoalTokenBudget,
  isValidGoalTokenBudget,
  installSessionWorkflowRevisionWriteThrough,
} from './config.js';
import { GOAL_DEFAULT_TOKEN_BUDGET } from '../goals/goal-protocol.js';
import { Storage } from './storage.js';
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
import { logRipgrepFallback } from '../telemetry/loggers.js';
import { RipgrepFallbackEvent } from '../telemetry/types.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { ToolNames } from '../tools/tool-names.js';
import { fireNotificationHook } from '../core/toolHookTriggers.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
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
  TeamMemoryRootSecurityError,
} from '../memory/indexer.js';
import { syncTeamMemory } from '../memory/team-memory-sync.js';
import { getTeamMemoryShareabilityWarning } from '../memory/team-memory-git-status.js';
import * as runtimeStatus from '../utils/runtimeStatus.js';
import * as sessionRegistry from '../services/session-registry.js';
import {
  ExtensionManager,
  type Extension,
} from '../extension/extensionManager.js';
import { SkillManager } from '../skills/skill-manager.js';
import type { SkillConfig } from '../skills/types.js';
import { createSkillScopedAgentConfig } from '../memory/skillReviewAgentPlanner.js';
import { maybeRunAutoSkillCurator } from '../skills/skill-curator.js';
import { HookSystem } from '../hooks/index.js';
import { GOAL_HOOK_ID_OUTPUT_KEY } from '../goals/goalHook.js';
import type { FileHistorySnapshot } from '../services/fileHistoryService.js';
import type {
  ChatRecord,
  ChatRecordingFailureEvent,
} from '../services/chatRecordingService.js';
import type { ResumedSessionData } from '../services/sessionService.js';
import {
  GoalPersistenceUnavailableError,
  type GoalTurnHost,
} from '../goals/goal-runtime.js';
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

function createToolMock(toolName: string) {
  const ToolMock = vi.fn();
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

// Mock dependencies that might be called during Config construction or createServerConfig
vi.mock('../tools/tool-registry', () => {
  const ToolRegistryMock = vi.fn();
  ToolRegistryMock.prototype.registerTool = vi.fn();
  ToolRegistryMock.prototype.registerFactory = vi.fn();
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
  rebuildTeamAutoMemoryIndex: vi.fn().mockResolvedValue(null),
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
  HookSystemMock.prototype.initialize = vi.fn().mockResolvedValue(undefined);
  HookSystemMock.prototype.hasHooksForEvent = vi.fn().mockReturnValue(false);
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
vi.mock('../tools/ls', () => ({
  LSTool: createToolMock('list_directory'),
}));
vi.mock('../tools/read-file', () => ({
  ReadFileTool: createToolMock('read_file'),
}));
vi.mock('../tools/grep.js', () => ({
  GrepTool: createToolMock('grep_search'),
}));
vi.mock('../tools/ripGrep.js', () => ({
  RipGrepTool: createToolMock('grep_search'),
}));
vi.mock('../utils/ripgrepUtils.js', () => ({
  canUseRipgrep: vi.fn(),
}));
vi.mock('../tools/glob', () => ({
  GlobTool: createToolMock('glob'),
}));
vi.mock('../tools/edit', () => ({
  EditTool: createToolMock('edit'),
}));
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
// Mock fireNotificationHook from toolHookTriggers
vi.mock('../core/toolHookTriggers.js', () => ({
  fireNotificationHook: vi.fn().mockResolvedValue({}),
}));

describe('matchesServerPattern', () => {
  it('exact match when no glob characters', () => {
    expect(matchesServerPattern('puppeteer', 'puppeteer')).toBe(true);
    expect(matchesServerPattern('puppeteer', 'playwright')).toBe(false);
  });

  it('* matches any sequence including empty', () => {
    expect(matchesServerPattern('puppeteer', '*puppeteer*')).toBe(true);
    expect(matchesServerPattern('my-puppeteer-server', '*puppeteer*')).toBe(
      true,
    );
    expect(matchesServerPattern('playwright', '*puppeteer*')).toBe(false);
    expect(matchesServerPattern('anything', '*')).toBe(true);
    expect(matchesServerPattern('prefix-suffix', 'prefix*')).toBe(true);
    expect(matchesServerPattern('prefix-suffix', '*suffix')).toBe(true);
  });

  it('? matches exactly one character', () => {
    expect(matchesServerPattern('abc', 'a?c')).toBe(true);
    expect(matchesServerPattern('ac', 'a?c')).toBe(false);
    expect(matchesServerPattern('axc', 'a?c')).toBe(true);
  });

  it('escapes regex special characters', () => {
    expect(matchesServerPattern('my.server', 'my.server')).toBe(true);
    expect(matchesServerPattern('myXserver', 'my.server')).toBe(false);
    expect(matchesServerPattern('a+b', 'a+b')).toBe(true);
    expect(matchesServerPattern('a^b', 'a^b')).toBe(true);
    expect(matchesServerPattern('a$b', 'a$b')).toBe(true);
    expect(matchesServerPattern('aXb', 'a$b')).toBe(false);
  });

  it('combines glob with exact segments', () => {
    expect(matchesServerPattern('foo-bar-baz', 'foo-*-baz')).toBe(true);
    expect(matchesServerPattern('foo-bar-qux', 'foo-*-baz')).toBe(false);
  });

  it('handles empty name', () => {
    expect(matchesServerPattern('', '*')).toBe(true);
    expect(matchesServerPattern('', '?')).toBe(false);
    expect(matchesServerPattern('', '')).toBe(true);
  });

  it('handles consecutive * in pattern', () => {
    expect(matchesServerPattern('puppeteer', '**puppeteer**')).toBe(true);
    expect(matchesServerPattern('abc', 'a**c')).toBe(true);
  });

  it('handles ? at pattern boundaries', () => {
    expect(matchesServerPattern('abc', '?bc')).toBe(true);
    expect(matchesServerPattern('abc', 'ab?')).toBe(true);
    expect(matchesServerPattern('abc', '???')).toBe(true);
    expect(matchesServerPattern('ab', '???')).toBe(false);
  });

  it('rejects when pattern is longer than name', () => {
    expect(matchesServerPattern('ab', 'a*b*c')).toBe(false);
    expect(matchesServerPattern('abc', 'a*b*c')).toBe(true);
  });
});

describe('matchesAnyServerPattern', () => {
  it('returns false for undefined or empty list', () => {
    expect(matchesAnyServerPattern('puppeteer', undefined)).toBe(false);
    expect(matchesAnyServerPattern('puppeteer', [])).toBe(false);
  });

  it('matches if any pattern matches', () => {
    expect(
      matchesAnyServerPattern('puppeteer', ['playwright', '*puppeteer*']),
    ).toBe(true);
    expect(
      matchesAnyServerPattern('chrome', ['playwright', '*puppeteer*']),
    ).toBe(false);
  });

  it('works with mixed exact and glob patterns', () => {
    expect(
      matchesAnyServerPattern('playwright', ['playwright', '*puppeteer*']),
    ).toBe(true);
    expect(
      matchesAnyServerPattern('my-puppeteer', ['playwright', '*puppeteer*']),
    ).toBe(true);
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

  beforeEach(() => {
    // Reset mocks if necessary
    vi.clearAllMocks();
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

    // Setup default mock for resolveContentGeneratorConfigWithSources
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

  it('resolves live skill settings without reviving an inactive or removed owner', () => {
    const disabled = new Set<string>();
    const enabled = new Set<string>();
    const config = new Config({
      ...baseParams,
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
    const extension: Extension = {
      id: 'a'.repeat(64),
      name: 'suite',
      version: '1.0.0',
      isActive: true,
      path: '/extensions/suite',
      config: { name: 'suite', version: '1.0.0' },
      contextFiles: [],
      skills: [skill],
    };
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
  });

  describe('project-dir registry lifecycle', () => {
    it('drops its session entry on shutdown — no daemon leak', async () => {
      const sessionId = 'cfg-shutdown-test-session';
      const config = new Config({ ...baseParams, sessionId });
      expect(getSessionProjectDir(sessionId)).toBeUndefined();
      await config.initialize({
        skipLlmInitialization: true,
        skipHooks: true,
        skipMcpDiscovery: true,
        skipSkillManager: true,
        skipFileCheckpointing: true,
      });
      expect(getSessionProjectDir(sessionId)).toBeDefined();
      await config.shutdown();
      // In daemon mode this is what stops the map growing per session.
      expect(getSessionProjectDir(sessionId)).toBeUndefined();
    });

    it('accepts the deprecated Gemini initialization option', async () => {
      const config = new Config(baseParams);
      await config.initialize({
        skipGeminiInitialization: true,
        skipHooks: true,
        skipMcpDiscovery: true,
        skipSkillManager: true,
        skipFileCheckpointing: true,
      });

      expect(config.getGeminiClient()).toBe(config.getLlmClient());
      await config.shutdown();
    });
  });

  // Shared isolation for the debug-fallback tests below. The module-level
  // vi.mock('node:fs') factory overrides only the sync fs API, so any
  // un-spied fs.promises call the debug logger makes would hit the real
  // filesystem (writing into the actual global debug dir). Spy the full
  // surface the fallback/alias path touches — mkdir, appendFile, unlink,
  // symlink AND readlink — in one place so the two tests can't drift out of
  // lockstep, then restore env + logger state on the way out. The body reads
  // the appendFile spy back via vi.mocked(fs.promises.appendFile) — passing it
  // as a typed callback argument runs into vi.spyOn's generic-overload return
  // type, which the concrete spy is not assignable to (TS2345).
  async function withDebugFallbackIsolation(
    run: () => Promise<void>,
  ): Promise<void> {
    const previousDebugLogFileEnv = process.env['QWEN_DEBUG_LOG_FILE'];
    const previousSessionIdEnv = process.env['QWEN_CODE_SESSION_ID'];
    const spies = [
      vi.spyOn(fs.promises, 'mkdir').mockResolvedValue(undefined),
      vi.spyOn(fs.promises, 'appendFile').mockResolvedValue(undefined),
      vi.spyOn(fs.promises, 'unlink').mockResolvedValue(undefined),
      vi.spyOn(fs.promises, 'symlink').mockResolvedValue(undefined),
      vi.spyOn(fs.promises, 'readlink').mockResolvedValue(''),
    ];
    const restoreEnv = (key: string, previous: string | undefined) => {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    };
    try {
      delete process.env['QWEN_DEBUG_LOG_FILE'];
      resetDebugLoggingState();
      await run();
    } finally {
      for (const spy of spies) spy.mockRestore();
      resetDebugLoggingState();
      setDebugLogSession(null);
      restoreEnv('QWEN_DEBUG_LOG_FILE', previousDebugLogFileEnv);
      restoreEnv('QWEN_CODE_SESSION_ID', previousSessionIdEnv);
    }
  }

  it('does not replace the global debug fallback during daemon Config creation or rotation', async () => {
    await withDebugFallbackIsolation(async () => {
      const bootstrapSessionId = '550e8400-e29b-41d4-a716-446655440000';
      const daemonSessionId = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
      const rotatedSessionId = '7ba7b810-9dad-11d1-80b4-00c04fd430c8';
      new Config({ ...baseParams, sessionId: bootstrapSessionId });
      const daemonConfig = sessionIdContext.run(
        daemonSessionId,
        () => new Config({ ...baseParams, sessionId: daemonSessionId }),
      );
      sessionIdContext.run(daemonSessionId, () => {
        daemonConfig.startNewSession(rotatedSessionId);
      });

      process.env['QWEN_DEBUG_LOG_FILE'] = '1';
      createDebugLogger('DAEMON_FALLBACK').info('process-scoped message');

      await vi.waitFor(() =>
        expect(vi.mocked(fs.promises.appendFile)).toHaveBeenCalledWith(
          Storage.getDebugLogPath(bootstrapSessionId),
          expect.stringContaining('[DAEMON_FALLBACK] process-scoped message'),
          'utf8',
        ),
      );
      expect(vi.mocked(fs.promises.appendFile)).not.toHaveBeenCalledWith(
        Storage.getDebugLogPath(rotatedSessionId),
        expect.stringContaining('[DAEMON_FALLBACK] process-scoped message'),
        'utf8',
      );
    });
  });

  it('claims the global debug fallback on un-contexted rotation (single-session CLI)', async () => {
    // The other direction of the guard above: a single-session CLI /clear
    // rotates the Config OUTSIDE any sessionIdContext, and the process-wide
    // debug session must follow the rotated id — otherwise post-rotation
    // logs keep landing in the pre-rotation session's file.
    await withDebugFallbackIsolation(async () => {
      const initialSessionId = '550e8400-e29b-41d4-a716-446655440000';
      const rotatedSessionId = '7ba7b810-9dad-11d1-80b4-00c04fd430c8';
      // The fallback holds a live Config reference, so rotating the SAME
      // Config reroutes writes even without the rotation-time claim. The
      // claim is load-bearing for RE-claiming: another Config (transcript
      // replay, bootstrap) may have taken the fallback since, and an
      // un-contexted rotation must hand it back to the rotating CLI Config.
      const cliConfig = new Config({
        ...baseParams,
        sessionId: initialSessionId,
      });
      const interloperSessionId = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
      new Config({ ...baseParams, sessionId: interloperSessionId });

      cliConfig.startNewSession(rotatedSessionId);

      process.env['QWEN_DEBUG_LOG_FILE'] = '1';
      createDebugLogger('CLI_ROTATION').info('post-rotation message');

      await vi.waitFor(() =>
        expect(vi.mocked(fs.promises.appendFile)).toHaveBeenCalledWith(
          Storage.getDebugLogPath(rotatedSessionId),
          expect.stringContaining('[CLI_ROTATION] post-rotation message'),
          'utf8',
        ),
      );
      expect(vi.mocked(fs.promises.appendFile)).not.toHaveBeenCalledWith(
        Storage.getDebugLogPath(interloperSessionId),
        expect.stringContaining('[CLI_ROTATION] post-rotation message'),
        'utf8',
      );
    });
  });

  describe('shell execution config', () => {
    it('allows explicitly clearing the configured pager', () => {
      const config = new Config(baseParams);

      config.setShellExecutionConfig({ pager: 'less' });
      expect(config.getShellExecutionConfig().pager).toBe('less');

      config.setShellExecutionConfig({ pager: undefined });
      expect(config.getShellExecutionConfig().pager).toBeUndefined();
    });

    it('preserves the existing pager when an update omits the pager key', () => {
      const config = new Config(baseParams);

      config.setShellExecutionConfig({ pager: 'less' });
      expect(config.getShellExecutionConfig().pager).toBe('less');

      config.setShellExecutionConfig({ terminalWidth: 120 });
      expect(config.getShellExecutionConfig().pager).toBe('less');
    });
  });

  describe('memory file count compatibility', () => {
    it('keeps the legacy parameter and accessors until a future major release', () => {
      const config = new Config({ ...baseParams, geminiMdFileCount: 2 });

      expect(config.getMemoryFileCount()).toBe(2);
      expect(config.getGeminiMdFileCount()).toBe(2);

      config.setGeminiMdFileCount(3);
      expect(config.getMemoryFileCount()).toBe(3);
    });

    it('prefers the renamed parameter when both names are present', () => {
      const config = new Config({
        ...baseParams,
        geminiMdFileCount: 2,
        memoryFileCount: 4,
      });

      expect(config.getMemoryFileCount()).toBe(4);
    });
  });

  describe('getMemoryAgentTimeoutMinutes', () => {
    it('returns undefined when unset', () => {
      expect(
        new Config(baseParams).getMemoryAgentTimeoutMinutes(),
      ).toBeUndefined();
    });

    it('passes through non-negative values, including 0 (no time limit)', () => {
      expect(
        new Config({
          ...baseParams,
          memoryAgentTimeoutMinutes: 30,
        }).getMemoryAgentTimeoutMinutes(),
      ).toBe(30);
      expect(
        new Config({
          ...baseParams,
          memoryAgentTimeoutMinutes: 0,
        }).getMemoryAgentTimeoutMinutes(),
      ).toBe(0);
    });

    it('treats negative values as unset (schema validation is bypassed on load)', () => {
      expect(
        new Config({
          ...baseParams,
          memoryAgentTimeoutMinutes: -5,
        }).getMemoryAgentTimeoutMinutes(),
      ).toBeUndefined();
    });
  });

  describe('getMemoryAgentMaxTurns', () => {
    it('returns undefined when unset', () => {
      expect(new Config(baseParams).getMemoryAgentMaxTurns()).toBeUndefined();
    });

    it('passes through non-negative values, including 0', () => {
      expect(
        new Config({
          ...baseParams,
          memoryAgentMaxTurns: 25,
        }).getMemoryAgentMaxTurns(),
      ).toBe(25);
      expect(
        new Config({
          ...baseParams,
          memoryAgentMaxTurns: 0,
        }).getMemoryAgentMaxTurns(),
      ).toBe(0);
    });

    it('treats negative values as unset', () => {
      expect(
        new Config({
          ...baseParams,
          memoryAgentMaxTurns: -1,
        }).getMemoryAgentMaxTurns(),
      ).toBeUndefined();
    });

    it('treats fractional values as unset', () => {
      expect(
        new Config({
          ...baseParams,
          memoryAgentMaxTurns: 2.5,
        }).getMemoryAgentMaxTurns(),
      ).toBeUndefined();
    });
  });

  describe('restorable ask_user_question preservation', () => {
    it('defaults to off when the restore switch is unset', () => {
      const config = new Config(baseParams);
      expect(config.getRestoreAskUserQuestion()).toBe(false);
      expect(config.getPreserveRestorableAskUserQuestion()).toBe(false);
    });

    it('preserves by default when the restore switch is on', () => {
      const config = new Config({
        ...baseParams,
        restoreAskUserQuestion: true,
      });
      expect(config.getRestoreAskUserQuestion()).toBe(true);
      expect(config.getPreserveRestorableAskUserQuestion()).toBe(true);
    });

    it('stops preserving after suppression, without touching the restore switch', () => {
      const config = new Config({
        ...baseParams,
        restoreAskUserQuestion: true,
      });
      config.suppressRestorableAskUserQuestionPreservation();
      expect(config.getPreserveRestorableAskUserQuestion()).toBe(false);
      expect(config.getRestoreAskUserQuestion()).toBe(true);
    });
  });

  describe('getVisionBridgeTimeoutMs', () => {
    it('returns undefined when unset', () => {
      expect(new Config(baseParams).getVisionBridgeTimeoutMs()).toBeUndefined();
    });

    it('passes through positive values', () => {
      expect(
        new Config({
          ...baseParams,
          visionBridgeTimeoutMs: 120_000,
        }).getVisionBridgeTimeoutMs(),
      ).toBe(120_000);
    });

    it('treats non-positive values as unset (schema validation is bypassed on load)', () => {
      expect(
        new Config({
          ...baseParams,
          visionBridgeTimeoutMs: 0,
        }).getVisionBridgeTimeoutMs(),
      ).toBeUndefined();
      expect(
        new Config({
          ...baseParams,
          visionBridgeTimeoutMs: -5000,
        }).getVisionBridgeTimeoutMs(),
      ).toBeUndefined();
    });

    it('rejects values AbortSignal.timeout cannot take (fractional, over 2^31-1, non-finite)', () => {
      // These pass the number-typed schema's `minimum: 1` via /config but would
      // make AbortSignal.timeout throw RangeError or degrade to a 1ms timer.
      for (const bad of [
        30_000.5,
        2_147_483_648,
        4_294_967_296,
        1e300,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ]) {
        expect(
          new Config({
            ...baseParams,
            visionBridgeTimeoutMs: bad,
          }).getVisionBridgeTimeoutMs(),
        ).toBeUndefined();
      }
    });

    it('accepts the maximum supported integer timeout', () => {
      expect(
        new Config({
          ...baseParams,
          visionBridgeTimeoutMs: 2_147_483_647,
        }).getVisionBridgeTimeoutMs(),
      ).toBe(2_147_483_647);
    });
  });

  describe('getShellDefaultTimeoutMs', () => {
    it('returns undefined when unset', () => {
      expect(new Config(baseParams).getShellDefaultTimeoutMs()).toBeUndefined();
    });

    it('passes through positive values', () => {
      expect(
        new Config({
          ...baseParams,
          shellDefaultTimeoutMs: 300_000,
        }).getShellDefaultTimeoutMs(),
      ).toBe(300_000);
    });

    it('accepts 0 (disables the timeout — unlike the vision bridge)', () => {
      expect(
        new Config({
          ...baseParams,
          shellDefaultTimeoutMs: 0,
        }).getShellDefaultTimeoutMs(),
      ).toBe(0);
    });

    it('treats negative values as unset (schema validation is bypassed on load)', () => {
      expect(
        new Config({
          ...baseParams,
          shellDefaultTimeoutMs: -5000,
        }).getShellDefaultTimeoutMs(),
      ).toBeUndefined();
    });

    it('rejects values AbortSignal.timeout cannot take (fractional, over 2^31-1, non-finite)', () => {
      // A hand-edited settings.json bypasses the schema and can reach
      // AbortSignal.timeout, which would throw RangeError or degrade to a
      // 1ms timer on these. Coerce to undefined → built-in default.
      for (const bad of [
        30_000.5,
        2_147_483_648,
        4_294_967_296,
        1e300,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ]) {
        expect(
          new Config({
            ...baseParams,
            shellDefaultTimeoutMs: bad,
          }).getShellDefaultTimeoutMs(),
        ).toBeUndefined();
      }
    });

    it('accepts the maximum supported integer timeout', () => {
      expect(
        new Config({
          ...baseParams,
          shellDefaultTimeoutMs: 2_147_483_647,
        }).getShellDefaultTimeoutMs(),
      ).toBe(2_147_483_647);
    });
  });

  describe('getMaxSubagentDepth', () => {
    it('defaults to 5 when unset', () => {
      expect(new Config(baseParams).getMaxSubagentDepth()).toBe(5);
    });

    it('respects an explicit value', () => {
      expect(
        new Config({
          ...baseParams,
          maxSubagentDepth: 3,
        }).getMaxSubagentDepth(),
      ).toBe(3);
    });

    it('clamps values below 1 up to 1 (never disables sub-agents)', () => {
      expect(
        new Config({
          ...baseParams,
          maxSubagentDepth: 0,
        }).getMaxSubagentDepth(),
      ).toBe(1);
      expect(
        new Config({
          ...baseParams,
          maxSubagentDepth: -4,
        }).getMaxSubagentDepth(),
      ).toBe(1);
    });

    it('floors fractional values', () => {
      expect(
        new Config({
          ...baseParams,
          maxSubagentDepth: 3.9,
        }).getMaxSubagentDepth(),
      ).toBe(3);
    });

    it('falls back to the default on non-finite values', () => {
      // JSON `1e309` parses to Infinity — must not disable the recursion cap.
      expect(
        new Config({
          ...baseParams,
          maxSubagentDepth: Infinity,
        }).getMaxSubagentDepth(),
      ).toBe(5);
      // NaN comparisons are always false — must not silently block nesting.
      expect(
        new Config({
          ...baseParams,
          maxSubagentDepth: NaN,
        }).getMaxSubagentDepth(),
      ).toBe(5);
    });

    it('caps absurdly large values at 100', () => {
      expect(
        new Config({
          ...baseParams,
          maxSubagentDepth: 5000,
        }).getMaxSubagentDepth(),
      ).toBe(100);
    });
  });

  describe('setAutoSkillEnabled', () => {
    it('flips the live value read by getAutoSkillEnabled', () => {
      const config = new Config({ ...baseParams, enableAutoSkill: true });
      expect(config.getAutoSkillEnabled()).toBe(true);
      config.setAutoSkillEnabled(false);
      expect(config.getAutoSkillEnabled()).toBe(false);
      config.setAutoSkillEnabled(true);
      expect(config.getAutoSkillEnabled()).toBe(true);
    });
  });

  describe('session workflow gate and plan revision', () => {
    it('defaults off and clears the revision when disabled', () => {
      const config = new Config({ ...baseParams });
      expect(config.isSessionWorkflowEnabled()).toBe(false);
      config.setSessionWorkflowPlanRevision({
        planId: 'plan-1',
        sourceCallId: 'call-1',
        todoIds: ['todo-1'],
      });
      expect(config.getSessionWorkflowPlanRevision()).toBeUndefined();
    });

    it('hot-reloads the gate through its provider and clears context on disable', () => {
      let enabled = true;
      const config = new Config({
        ...baseParams,
        sessionWorkflowEnabled: true,
      });
      config.setSessionWorkflowEnabledProvider(() => enabled);
      config.setSessionWorkflowPlanRevision({
        planId: 'plan-1',
        sourceCallId: 'call-1',
        todoIds: ['todo-1', 'todo-2'],
      });
      expect(config.getSessionWorkflowPlanRevision()).toEqual({
        planId: 'plan-1',
        sourceCallId: 'call-1',
        todoIds: ['todo-1', 'todo-2'],
      });

      enabled = false;
      expect(config.isSessionWorkflowEnabled()).toBe(false);
      expect(config.getSessionWorkflowPlanRevision()).toBeUndefined();
    });

    it('keeps gate reads pure so prototype wrappers never shadow the base revision', () => {
      let enabled = false;
      const config = new Config({ ...baseParams });
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
      config.setSessionWorkflowPlanRevision({
        planId: 'plan-1',
        sourceCallId: 'call-1',
        todoIds: ['todo-1'],
      });
      expect(wrapper.getSessionWorkflowPlanRevision()).toEqual({
        planId: 'plan-1',
        sourceCallId: 'call-1',
        todoIds: ['todo-1'],
      });
      expect(wrapper.isSessionWorkflowTodoContextActive()).toBe(true);
    });

    it('accepts planning mode as workflow context before approval', () => {
      const config = new Config({
        ...baseParams,
        sessionWorkflowEnabled: true,
        approvalMode: ApprovalMode.PLAN,
      });
      expect(config.isSessionWorkflowTodoContextActive()).toBe(true);
    });

    it('stamps the bound revision approved on an approved plan exit', () => {
      const config = new Config({
        ...baseParams,
        sessionWorkflowEnabled: true,
        approvalMode: ApprovalMode.PLAN,
      });
      config.setSessionWorkflowPlanRevision({
        planId: 'plan-1',
        sourceCallId: 'call-1',
        todoIds: ['todo-1'],
      });
      // A revision bound while drafting carries no approval stamp.
      expect(config.getSessionWorkflowPlanRevision()?.approved).toBeUndefined();

      config.setApprovalMode(ApprovalMode.DEFAULT, {
        fromApprovedPlanExit: true,
      });
      expect(config.getSessionWorkflowPlanRevision()).toEqual({
        planId: 'plan-1',
        sourceCallId: 'call-1',
        todoIds: ['todo-1'],
        approved: true,
      });
    });

    it('does not stamp the revision on a manual PLAN exit', () => {
      const config = new Config({
        ...baseParams,
        sessionWorkflowEnabled: true,
        approvalMode: ApprovalMode.PLAN,
      });
      config.setSessionWorkflowPlanRevision({
        planId: 'plan-1',
        sourceCallId: 'call-1',
        todoIds: ['todo-1'],
      });
      config.setApprovalMode(ApprovalMode.DEFAULT);
      expect(config.getSessionWorkflowPlanRevision()?.approved).toBeUndefined();
    });

    it('does not let a derived config approve the session revision', () => {
      const config = new Config({
        ...baseParams,
        sessionWorkflowEnabled: true,
        approvalMode: ApprovalMode.PLAN,
      });
      config.setSessionWorkflowPlanRevision({
        planId: 'plan-1',
        sourceCallId: 'call-1',
        todoIds: ['todo-1'],
      });
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
      const config = new Config({
        ...baseParams,
        sessionWorkflowEnabled: true,
        approvalMode: ApprovalMode.PLAN,
      });
      config.setSessionWorkflowPlanRevision({
        planId: 'plan-1',
        sourceCallId: 'call-1',
        todoIds: ['todo-1'],
      });
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
      const config = new Config({
        ...baseParams,
        agents: {
          maxParallelAgents: 1,
        },
      });
      const registry = config.getBackgroundTaskRegistry();

      registry.register({
        agentId: 'bg-1',
        description: 'one',
        isBackgrounded: true,
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
        outputFile: '/tmp/bg-1.jsonl',
      });

      expect(() =>
        registry.register({
          agentId: 'bg-2',
          description: 'two',
          isBackgrounded: true,
          status: 'running',
          startTime: Date.now(),
          abortController: new AbortController(),
          outputFile: '/tmp/bg-2.jsonl',
        }),
      ).toThrow('maximum concurrent background agents (1) reached');
    });
  });

  describe('agents.maxParallelAgentsByModel', () => {
    it('configures a per-model background task concurrency cap', () => {
      const config = new Config({
        ...baseParams,
        agents: {
          maxParallelAgentsByModel: { 'weak-model': 1 },
        },
      });
      const registry = config.getBackgroundTaskRegistry();

      registry.register({
        agentId: 'bg-1',
        description: 'one',
        model: 'weak-model',
        isBackgrounded: true,
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
        outputFile: '/tmp/bg-1.jsonl',
      });

      expect(() =>
        registry.register({
          agentId: 'bg-2',
          description: 'two',
          model: 'weak-model',
          isBackgrounded: true,
          status: 'running',
          startTime: Date.now(),
          abortController: new AbortController(),
          outputFile: '/tmp/bg-2.jsonl',
        }),
      ).toThrow('for model "weak-model" (1) reached');
    });
  });

  describe('getTeamMemoryEnabled', () => {
    const prevEnv = process.env['QWEN_CODE_MEMORY_TEAM'];
    afterEach(() => {
      if (prevEnv === undefined) {
        delete process.env['QWEN_CODE_MEMORY_TEAM'];
      } else {
        process.env['QWEN_CODE_MEMORY_TEAM'] = prevEnv;
      }
    });

    it('is off by default and follows the enableTeamMemory setting', () => {
      delete process.env['QWEN_CODE_MEMORY_TEAM'];
      expect(new Config(baseParams).getTeamMemoryEnabled()).toBe(false);
      expect(
        new Config({
          ...baseParams,
          enableTeamMemory: true,
        }).getTeamMemoryEnabled(),
      ).toBe(true);
    });

    it('QWEN_CODE_MEMORY_TEAM overrides the setting', () => {
      process.env['QWEN_CODE_MEMORY_TEAM'] = '1';
      expect(new Config(baseParams).getTeamMemoryEnabled()).toBe(true);
      process.env['QWEN_CODE_MEMORY_TEAM'] = '0';
      expect(
        new Config({
          ...baseParams,
          enableTeamMemory: true,
        }).getTeamMemoryEnabled(),
      ).toBe(false);
    });

    it('bareMode forces off even with the setting and env both on', () => {
      process.env['QWEN_CODE_MEMORY_TEAM'] = '1';
      expect(
        new Config({
          ...baseParams,
          bareMode: true,
          enableTeamMemory: true,
        }).getTeamMemoryEnabled(),
      ).toBe(false);
    });
  });

  describe('getCronRecurringMaxAgeDays', () => {
    const prevEnv = process.env['QWEN_CODE_CRON_MAX_AGE_DAYS'];
    afterEach(() => {
      if (prevEnv === undefined) {
        delete process.env['QWEN_CODE_CRON_MAX_AGE_DAYS'];
      } else {
        process.env['QWEN_CODE_CRON_MAX_AGE_DAYS'] = prevEnv;
      }
    });

    it('defaults to 7 days and follows the setting', () => {
      delete process.env['QWEN_CODE_CRON_MAX_AGE_DAYS'];
      expect(new Config(baseParams).getCronRecurringMaxAgeDays()).toBe(7);
      expect(
        new Config({
          ...baseParams,
          cronRecurringMaxAgeDays: 30,
        }).getCronRecurringMaxAgeDays(),
      ).toBe(30);
    });

    it('maps 0 to Infinity (no expiry)', () => {
      delete process.env['QWEN_CODE_CRON_MAX_AGE_DAYS'];
      expect(
        new Config({
          ...baseParams,
          cronRecurringMaxAgeDays: 0,
        }).getCronRecurringMaxAgeDays(),
      ).toBe(Infinity);
    });

    it('QWEN_CODE_CRON_MAX_AGE_DAYS overrides the setting', () => {
      process.env['QWEN_CODE_CRON_MAX_AGE_DAYS'] = '90';
      expect(
        new Config({
          ...baseParams,
          cronRecurringMaxAgeDays: 30,
        }).getCronRecurringMaxAgeDays(),
      ).toBe(90);
      process.env['QWEN_CODE_CRON_MAX_AGE_DAYS'] = '0';
      expect(new Config(baseParams).getCronRecurringMaxAgeDays()).toBe(
        Infinity,
      );
    });

    it('falls back to the default on invalid values', () => {
      process.env['QWEN_CODE_CRON_MAX_AGE_DAYS'] = 'not-a-number';
      expect(new Config(baseParams).getCronRecurringMaxAgeDays()).toBe(7);
      delete process.env['QWEN_CODE_CRON_MAX_AGE_DAYS'];
      expect(
        new Config({
          ...baseParams,
          cronRecurringMaxAgeDays: -3,
        }).getCronRecurringMaxAgeDays(),
      ).toBe(7);
    });

    it('warns on the console once at construction for an invalid value', () => {
      process.env['QWEN_CODE_CRON_MAX_AGE_DAYS'] = 'not-a-number';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const config = new Config(baseParams);
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
      const config = new Config(baseParams);
      process.env['QWEN_CODE_CRON_MAX_AGE_DAYS'] = '3';
      expect(config.getCronRecurringMaxAgeDays()).toBe(90);
      delete process.env['QWEN_CODE_CRON_MAX_AGE_DAYS'];
      expect(config.getCronRecurringMaxAgeDays()).toBe(90);
    });
  });

  describe('getTeamMemorySyncEnabled', () => {
    const prevEnv = process.env['QWEN_CODE_MEMORY_TEAM_SYNC'];
    afterEach(() => {
      if (prevEnv === undefined) {
        delete process.env['QWEN_CODE_MEMORY_TEAM_SYNC'];
      } else {
        process.env['QWEN_CODE_MEMORY_TEAM_SYNC'] = prevEnv;
      }
    });

    it('is off by default and follows the enableTeamMemorySync setting', () => {
      delete process.env['QWEN_CODE_MEMORY_TEAM_SYNC'];
      expect(new Config(baseParams).getTeamMemorySyncEnabled()).toBe(false);
      expect(
        new Config({
          ...baseParams,
          enableTeamMemorySync: true,
        }).getTeamMemorySyncEnabled(),
      ).toBe(true);
    });

    it('QWEN_CODE_MEMORY_TEAM_SYNC overrides the setting', () => {
      process.env['QWEN_CODE_MEMORY_TEAM_SYNC'] = '1';
      expect(new Config(baseParams).getTeamMemorySyncEnabled()).toBe(true);
      process.env['QWEN_CODE_MEMORY_TEAM_SYNC'] = '0';
      expect(
        new Config({
          ...baseParams,
          enableTeamMemorySync: true,
        }).getTeamMemorySyncEnabled(),
      ).toBe(false);
    });

    it('stays off in bare mode even with the setting and env both on', () => {
      process.env['QWEN_CODE_MEMORY_TEAM_SYNC'] = '1';
      expect(
        new Config({
          ...baseParams,
          bareMode: true,
          enableTeamMemorySync: true,
        }).getTeamMemorySyncEnabled(),
      ).toBe(false);
    });
  });

  it('should store a system prompt override', () => {
    const config = new Config({
      ...baseParams,
      systemPrompt: 'You are a custom system prompt.',
    });

    expect(config.getSystemPrompt()).toBe('You are a custom system prompt.');
    expect(config.getAppendSystemPrompt()).toBeUndefined();
  });

  it('should store an appended system prompt', () => {
    const config = new Config({
      ...baseParams,
      appendSystemPrompt: 'Be extra concise.',
    });

    expect(config.getAppendSystemPrompt()).toBe('Be extra concise.');
    expect(config.getSystemPrompt()).toBeUndefined();
  });

  describe('getDefaultVisionBridgeModel', () => {
    // Primary is text-only and lives on the 'openai' provider.
    const stubProvider = (config: Config, models: unknown[]) => {
      vi.spyOn(config, 'getModel').mockReturnValue('text-primary');
      vi.spyOn(config, 'getContentGeneratorConfig').mockReturnValue({
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://primary.example.com',
      } as ContentGeneratorConfig);
      vi.spyOn(config, 'getAllConfiguredModels').mockReturnValue(
        models as never,
      );
    };

    it('keeps a bare cross-provider namesake on its exact agent route', () => {
      const config = new Config({ ...baseParams, visionModel: 'text-primary' });
      stubProvider(config, [
        {
          id: 'text-primary',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://primary.example.com',
        },
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
      const config = new Config({ ...baseParams, visionModel: 'ghost-model' });
      stubProvider(config, [
        {
          id: 'vl-same-provider',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://primary.example.com',
          isVision: true,
        },
      ]);
      // 'ghost-model' isn't configured, so the explicit pin is ignored and the
      // same-provider candidate is auto-picked instead.
      expect(config.getDefaultVisionBridgeModel()).toEqual({
        id: 'openai:vl-same-provider',
        baseUrl: 'https://primary.example.com',
      });
    });

    it('auto-selects a same-provider vision model when no explicit model is set', () => {
      const config = new Config({ ...baseParams });
      stubProvider(config, [
        {
          id: 'vl-same-provider',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://primary.example.com',
          isVision: true,
        },
      ]);
      expect(config.getDefaultVisionBridgeModel()).toEqual({
        id: 'openai:vl-same-provider',
        baseUrl: 'https://primary.example.com',
      });
    });

    it('honors an authType-qualified visionModel against the matching provider only', () => {
      // Same model id on two providers; the 'anthropic:' qualifier must bind to
      // the anthropic row, not the same-provider openai one.
      const config = new Config({
        ...baseParams,
        visionModel: 'anthropic:vl-shared',
      });
      stubProvider(config, [
        {
          id: 'vl-shared',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://primary.example.com',
          isVision: true,
        },
        {
          id: 'vl-shared',
          authType: AuthType.USE_ANTHROPIC,
          baseUrl: 'https://api.anthropic.com',
          isVision: true,
        },
      ]);
      expect(config.getDefaultVisionBridgeModel()).toEqual({
        id: 'anthropic:vl-shared',
        baseUrl: 'https://api.anthropic.com',
      });
    });

    it('uses the visionModel selector baseUrl to disambiguate duplicate same-provider vision models', () => {
      const config = new Config({
        ...baseParams,
        visionModel: 'openai:qwen3.7-plus\0https://token-plan.example.com/v1',
      });
      stubProvider(config, [
        {
          id: 'qwen3.7-plus',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          isVision: true,
        },
        {
          id: 'qwen3.7-plus',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://token-plan.example.com/v1',
          isVision: true,
        },
      ]);
      expect(config.getDefaultVisionBridgeModel()).toEqual({
        id: 'openai:qwen3.7-plus',
        baseUrl: 'https://token-plan.example.com/v1',
      });
    });

    it.each([false, true])(
      'honors an exact visionModel route with ignored fast-only namesakes (reversed=%s)',
      (reversed) => {
        const baseUrl = 'https://vision.example.com/v1';
        const routeEntries = [
          {
            id: 'vision-agent',
            authType: AuthType.USE_OPENAI,
            baseUrl,
            isVision: true,
            capabilities: { vision: true, agent: true },
          },
          {
            id: 'vision-agent',
            authType: AuthType.USE_OPENAI,
            baseUrl,
            fastOnly: true,
          },
        ];
        const config = new Config({
          ...baseParams,
          visionModel: `openai:vision-agent\0${baseUrl}`,
        });
        stubProvider(config, reversed ? routeEntries.reverse() : routeEntries);

        expect(config.getDefaultVisionBridgeModel()).toEqual({
          id: 'openai:vision-agent',
          baseUrl,
          agentCapable: true,
        });
      },
    );

    it('falls back to auto-select when a legacy visionModel matches multiple endpoints', () => {
      const config = new Config({
        ...baseParams,
        visionModel: 'openai:qwen3.7-plus',
      });
      stubProvider(config, [
        {
          id: 'qwen3.7-plus',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          isVision: true,
        },
        {
          id: 'qwen3.7-plus',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://token-plan.example.com/v1',
          isVision: true,
        },
        {
          id: 'vl-same-provider',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://primary.example.com',
          isVision: true,
        },
      ]);
      expect(config.getDefaultVisionBridgeModel()).toEqual({
        id: 'openai:vl-same-provider',
        baseUrl: 'https://primary.example.com',
      });
    });

    it('falls back to auto-select on a malformed visionModel selector instead of throwing', () => {
      // 'openai:' is a known authType with no model id — resolveModelId throws,
      // and the guard must swallow it rather than take down every image request.
      const config = new Config({ ...baseParams, visionModel: 'openai:' });
      stubProvider(config, [
        {
          id: 'vl-same-provider',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://primary.example.com',
          isVision: true,
        },
      ]);
      expect(() => config.getDefaultVisionBridgeModel()).not.toThrow();
      expect(config.getDefaultVisionBridgeModel()).toEqual({
        id: 'openai:vl-same-provider',
        baseUrl: 'https://primary.example.com',
      });
    });

    it('falls back to auto-select on a visionModel with no selector before the baseUrl delimiter', () => {
      const config = new Config({
        ...baseParams,
        visionModel: '\0https://example.com/v1',
      });
      const warn = vi.spyOn(config.getDebugLogger(), 'warn');
      stubProvider(config, [
        {
          id: 'vl-same-provider',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://primary.example.com',
          isVision: true,
        },
      ]);

      expect(config.getDefaultVisionBridgeModel()).toEqual({
        id: 'openai:vl-same-provider',
        baseUrl: 'https://primary.example.com',
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("'\\0https://example.com/v1'"),
      );
    });

    it('drops a pin that points at the current primary model and auto-selects a same-provider VL model instead', () => {
      // Pinning the primary itself is a dead pin: the bridge exists to work
      // around the text-only primary, so routing back at it would defeat the
      // purpose. The provider-aware primary guard must drop the pin and hand off
      // to same-provider auto-select rather than ever returning the primary.
      const config = new Config({ ...baseParams, visionModel: 'text-primary' });
      stubProvider(config, [
        {
          // Same id/provider/endpoint as the primary — without the guard the
          // pin would resolve straight back to this row.
          id: 'text-primary',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://primary.example.com',
        },
        {
          id: 'vl-same-provider',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://primary.example.com',
          isVision: true,
        },
      ]);
      expect(config.getDefaultVisionBridgeModel()).toEqual({
        id: 'openai:vl-same-provider',
        baseUrl: 'https://primary.example.com',
      });
    });

    it('setVisionModel("") clears the pin and reverts to same-provider auto-select', () => {
      const config = new Config({ ...baseParams, visionModel: 'vl-anthropic' });
      stubProvider(config, [
        {
          id: 'vl-anthropic',
          authType: AuthType.USE_ANTHROPIC,
          baseUrl: 'https://api.anthropic.com',
          isVision: true,
        },
        {
          id: 'vl-same-provider',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://primary.example.com',
          isVision: true,
        },
      ]);
      // Pinned first.
      expect(config.getDefaultVisionBridgeModel()).toEqual({
        id: 'anthropic:vl-anthropic',
        baseUrl: 'https://api.anthropic.com',
      });
      // Cleared with '' — JSDoc promises a fall back to auto-select.
      config.setVisionModel('');
      expect(config.getDefaultVisionBridgeModel()).toEqual({
        id: 'openai:vl-same-provider',
        baseUrl: 'https://primary.example.com',
      });
      // undefined clears too.
      config.setVisionModel('vl-anthropic');
      config.setVisionModel(undefined);
      expect(config.getDefaultVisionBridgeModel()).toEqual({
        id: 'openai:vl-same-provider',
        baseUrl: 'https://primary.example.com',
      });
    });
  });

  describe('getModelFallbacks', () => {
    it('returns empty array by default when unset', () => {
      expect(new Config(baseParams).getModelFallbacks()).toEqual([]);
    });

    it('returns empty array when set to undefined', () => {
      expect(
        new Config({
          ...baseParams,
          modelFallbacks: undefined,
        }).getModelFallbacks(),
      ).toEqual([]);
    });

    it('returns empty array when set to empty array', () => {
      expect(
        new Config({
          ...baseParams,
          modelFallbacks: [],
        }).getModelFallbacks(),
      ).toEqual([]);
    });

    it('accepts an array of model IDs', () => {
      expect(
        new Config({
          ...baseParams,
          modelFallbacks: ['qwen-plus', 'qwen-turbo'],
        }).getModelFallbacks(),
      ).toEqual(['qwen-plus', 'qwen-turbo']);
    });

    it('caps at 3 entries', () => {
      expect(
        new Config({
          ...baseParams,
          modelFallbacks: [
            'model-a',
            'model-b',
            'model-c',
            'model-d',
            'model-e',
          ],
        }).getModelFallbacks(),
      ).toEqual(['model-a', 'model-b', 'model-c']);
    });

    it('deduplicates entries', () => {
      expect(
        new Config({
          ...baseParams,
          modelFallbacks: ['qwen-plus', 'qwen-turbo', 'qwen-plus'],
        }).getModelFallbacks(),
      ).toEqual(['qwen-plus', 'qwen-turbo']);
    });

    it('trims whitespace from entries', () => {
      expect(
        new Config({
          ...baseParams,
          modelFallbacks: ['  qwen-plus  ', ' qwen-turbo '],
        }).getModelFallbacks(),
      ).toEqual(['qwen-plus', 'qwen-turbo']);
    });

    it('removes blank entries', () => {
      expect(
        new Config({
          ...baseParams,
          modelFallbacks: ['', '  ', 'qwen-plus', '', 'qwen-turbo'],
        }).getModelFallbacks(),
      ).toEqual(['qwen-plus', 'qwen-turbo']);
    });

    it('deduplicates after trimming', () => {
      expect(
        new Config({
          ...baseParams,
          modelFallbacks: ['qwen-plus', ' qwen-plus ', 'qwen-turbo'],
        }).getModelFallbacks(),
      ).toEqual(['qwen-plus', 'qwen-turbo']);
    });

    it('returns a readonly array', () => {
      const config = new Config({
        ...baseParams,
        modelFallbacks: ['qwen-plus'],
      });
      const fallbacks = config.getModelFallbacks();
      // The returned array should be readonly (TypeScript enforces this,
      // but verify the reference is stable)
      expect(fallbacks).toEqual(['qwen-plus']);
    });

    it('caps at 3 after deduplication and blank removal', () => {
      expect(
        new Config({
          ...baseParams,
          modelFallbacks: [
            '',
            'model-a',
            'model-a', // duplicate
            '',
            'model-b',
            'model-c',
            'model-d', // 4th unique, should be dropped
          ],
        }).getModelFallbacks(),
      ).toEqual(['model-a', 'model-b', 'model-c']);
    });
  });

  it('wires file history snapshot updates to chat recording', async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), 'qwen-config-'));
    const storageDir = await mkdtemp(path.join(os.tmpdir(), 'qwen-storage-'));
    const config = new Config({
      ...baseParams,
      cwd: projectDir,
      fileCheckpointingEnabled: true,
      chatRecording: true,
    });
    const recordedSnapshots: FileHistorySnapshot[] = [];
    const recordFileHistorySnapshot = vi.fn((snapshot: FileHistorySnapshot) => {
      recordedSnapshots.push(structuredClone(snapshot));
    });
    vi.spyOn(config, 'getChatRecordingService').mockReturnValue({
      recordFileHistorySnapshot,
    } as unknown as ReturnType<Config['getChatRecordingService']>);
    const getGlobalQwenDirSpy = vi
      .spyOn(Storage, 'getGlobalQwenDir')
      .mockReturnValue(storageDir);

    try {
      const trackedFile = path.join(projectDir, 'a.txt');
      await writeFile(trackedFile, 'original');

      const fileHistoryService = config.getFileHistoryService();
      await fileHistoryService.makeSnapshot('p1');
      await fileHistoryService.trackEdit(trackedFile);

      expect(recordFileHistorySnapshot).toHaveBeenCalledTimes(1);
      expect(recordedSnapshots[0].trackedFileBackups['a.txt']).toEqual(
        expect.objectContaining({
          backupFileName: expect.any(String),
          version: 1,
        }),
      );
    } finally {
      getGlobalQwenDirSpy.mockRestore();
      await rm(projectDir, { recursive: true, force: true });
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  it('drops stale file history callbacks after session switch', async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), 'qwen-config-'));
    const storageDir = await mkdtemp(path.join(os.tmpdir(), 'qwen-storage-'));
    const config = new Config({
      ...baseParams,
      cwd: projectDir,
      fileCheckpointingEnabled: true,
    });
    const recordFileHistorySnapshot = vi.fn();
    vi.spyOn(config, 'getChatRecordingService').mockReturnValue({
      recordFileHistorySnapshot,
    } as unknown as ReturnType<Config['getChatRecordingService']>);
    const getGlobalQwenDirSpy = vi
      .spyOn(Storage, 'getGlobalQwenDir')
      .mockReturnValue(storageDir);

    try {
      const trackedFile = path.join(projectDir, 'a.txt');
      await writeFile(trackedFile, 'original');

      const oldFileHistoryService = config.getFileHistoryService();
      await oldFileHistoryService.makeSnapshot('p1');
      config.startNewSession('new-session-id');
      await oldFileHistoryService.trackEdit(trackedFile);

      expect(recordFileHistorySnapshot).not.toHaveBeenCalled();
    } finally {
      getGlobalQwenDirSpy.mockRestore();
      await rm(projectDir, { recursive: true, force: true });
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  describe('derived Config ownership', () => {
    it('applies public getter overrides without mutating the parent', () => {
      const parent = new Config(baseParams);
      const child = deriveConfig(parent, {
        getCwd: () => '/tmp/derived',
      });

      expect(child.getCwd()).toBe('/tmp/derived');
      // The constructor resolves targetDir, so on win32 the POSIX fixture
      // spelling comes back drive-qualified — compare the resolved form.
      expect(parent.getCwd()).toBe(path.resolve(baseParams.targetDir));
      expect(Object.getPrototypeOf(child)).toBe(parent);
    });

    it('ignores undefined getter overrides', () => {
      const parent = new Config(baseParams);
      const child = deriveConfig(parent, { getCwd: undefined });

      expect(child.getCwd()).toBe(parent.getCwd());
      expect(Object.hasOwn(child, 'getCwd')).toBe(false);
    });

    it('rebinds worktree getters and private field reads together', () => {
      const worktreeDir = path.resolve('/tmp/worktree');
      const parent = new Config({
        ...baseParams,
        fileFiltering: { customIgnoreFiles: ['.cursorignore'] },
      });
      const child = deriveWorktreeConfig(parent, worktreeDir, {
        customIgnoreFiles: ['.cursorignore'],
      });

      expect(child.getTargetDir()).toBe(worktreeDir);
      expect(child.getCwd()).toBe(worktreeDir);
      expect(child.getWorkingDir()).toBe(worktreeDir);
      expect(child.getProjectRoot()).toBe(worktreeDir);
      expect([...child.getWorkspaceContext().getDirectories()]).toEqual([
        worktreeDir,
      ]);
      expect(child.getFileService()).not.toBe(parent.getFileService());
      expect(child.getFileService().getQwenIgnoreFileNamesDisplay()).toBe(
        '.qwenignore, .cursorignore',
      );
      const workspaceState = child as unknown as Record<string, unknown>;
      expect(workspaceState['targetDir']).toBe(worktreeDir);
      expect(workspaceState['cwd']).toBe(worktreeDir);
      expect(Object.hasOwn(child, 'workspaceContext')).toBe(true);
      expect(Object.hasOwn(child, 'fileDiscoveryService')).toBe(true);
      expect(parent.getTargetDir()).toBe(path.resolve(TARGET_DIR));
      // getWorkingDir() returns the raw stored cwd: the constructor resolves
      // only targetDir (config.ts stores `params.cwd` verbatim), so this
      // assertion must NOT path.resolve() — that re-broke both tests on the
      // windows-latest lane, where resolve('/tmp') is drive-qualified.
      expect(parent.getWorkingDir()).toBe('/tmp');
    });

    it('rebinds agent workspace getters and private field reads together', () => {
      const agentWorkspace = path.resolve('/tmp/agent-workspace');
      const parent = new Config({
        ...baseParams,
        fileFiltering: { customIgnoreFiles: ['.cursorignore'] },
      });
      const agentPlanPath = path.join('/tmp/plans', 'session-agent-1.md');
      const {
        config: child,
        fileService,
        workspaceContext,
      } = deriveAgentConfig(parent, agentWorkspace, {
        customIgnoreFiles: ['.cursorignore'],
        getPlanFilePath: () => agentPlanPath,
      });

      expect(child.getTargetDir()).toBe(agentWorkspace);
      expect(child.getCwd()).toBe(agentWorkspace);
      expect(child.getWorkingDir()).toBe(agentWorkspace);
      expect(child.getProjectRoot()).toBe(agentWorkspace);
      expect(child.getPlanFilePath()).toBe(agentPlanPath);
      expect(child.getWorkspaceContext()).toBe(workspaceContext);
      expect([...child.getWorkspaceContext().getDirectories()]).toEqual([
        agentWorkspace,
      ]);
      expect(child.getFileService()).toBe(fileService);
      expect(child.getFileService()).not.toBe(parent.getFileService());
      expect(child.getFileService().getQwenIgnoreFileNamesDisplay()).toBe(
        '.qwenignore, .cursorignore',
      );
      const workspaceState = child as unknown as Record<string, unknown>;
      expect(workspaceState['targetDir']).toBe(agentWorkspace);
      expect(workspaceState['cwd']).toBe(agentWorkspace);
      expect(Object.hasOwn(child, 'workspaceContext')).toBe(true);
      expect(Object.hasOwn(child, 'fileDiscoveryService')).toBe(true);
      expect(parent.getTargetDir()).toBe(path.resolve(TARGET_DIR));
      // getWorkingDir() returns the raw stored cwd: the constructor resolves
      // only targetDir (config.ts stores `params.cwd` verbatim), so this
      // assertion must NOT path.resolve() — that re-broke both tests on the
      // windows-latest lane, where resolve('/tmp') is drive-qualified.
      expect(parent.getWorkingDir()).toBe('/tmp');
    });

    it('prohibits inherited session-writer lifecycle access', async () => {
      const parent = new Config(baseParams);
      const beginClose = vi.fn();
      const close = vi.fn().mockResolvedValue(undefined);
      const assertCanStartTurn = vi.fn().mockResolvedValue(undefined);
      (
        parent as unknown as {
          chatRecordingService: {
            hasWriteOwnership: () => boolean;
            beginClose: () => void;
            close: () => Promise<void>;
            assertCanStartTurn: () => Promise<void>;
          };
        }
      ).chatRecordingService = {
        hasWriteOwnership: () => true,
        beginClose,
        close,
        assertCanStartTurn,
      };
      const child = deriveConfig(parent);

      expect(child.hasSessionWriteOwnership()).toBe(false);
      expect(() => child.setSessionWriterReclaimPolicy('never')).toThrow(
        'Session write ownership could not be verified.',
      );
      expect(() => child.setSessionWriterTakeoverPolicy('certified')).toThrow(
        'Session write ownership could not be verified.',
      );
      expect(() => child.closeSessionWriter()).toThrow(
        'Session write ownership could not be verified.',
      );
      await expect(child.assertCanStartTurn()).resolves.toBeUndefined();
      expect(assertCanStartTurn).not.toHaveBeenCalled();
      expect(beginClose).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(parent.hasSessionWriteOwnership()).toBe(true);
    });

    it('prohibits initializing a derived Config', async () => {
      const parent = new Config(baseParams);
      const child = deriveConfig(parent);

      await expect(child.initialize()).rejects.toThrow(
        'Derived Configs cannot be initialized',
      );
    });

    it('prohibits canonical lifecycle operations on derived Configs', async () => {
      const parent = new Config(baseParams);
      const finalize = vi.fn();
      const flush = vi.fn().mockResolvedValue(undefined);
      const teamCleanup = vi.fn().mockResolvedValue(undefined);
      const arenaCleanup = vi.fn().mockResolvedValue(undefined);
      const internal = parent as unknown as {
        chatRecordingService: {
          hasWriteOwnership: () => boolean;
          finalize: () => void;
          flush: () => Promise<void>;
        };
        teamManager: { cleanup: () => Promise<void> };
        arenaManager: { cleanup: () => Promise<void> };
      };
      internal.chatRecordingService = {
        hasWriteOwnership: () => false,
        finalize,
        flush,
      };
      internal.teamManager = { cleanup: teamCleanup };
      internal.arenaManager = { cleanup: arenaCleanup };
      const child = deriveConfig(parent);

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

      expect(finalize).not.toHaveBeenCalled();
      expect(flush).not.toHaveBeenCalled();
      expect(teamCleanup).not.toHaveBeenCalled();
      expect(arenaCleanup).not.toHaveBeenCalled();
    });

    it('preserves ownership guards through nested prototype wrappers', async () => {
      const parent = new Config(baseParams);
      const beginClose = vi.fn();
      const close = vi.fn().mockResolvedValue(undefined);
      const finalize = vi.fn();
      const flush = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      const teamCleanup = vi.fn().mockResolvedValue(undefined);
      const arenaCleanup = vi.fn().mockResolvedValue(undefined);
      const internal = parent as unknown as {
        initialized: boolean;
        toolRegistry: ToolRegistry;
        chatRecordingService: {
          hasWriteOwnership: () => boolean;
          beginClose: () => void;
          close: () => Promise<void>;
          finalize: () => void;
          flush: () => Promise<void>;
        };
        teamManager: { cleanup: () => Promise<void> };
        arenaManager: { cleanup: () => Promise<void> };
      };
      internal.initialized = true;
      internal.toolRegistry = { stop } as unknown as ToolRegistry;
      internal.chatRecordingService = {
        hasWriteOwnership: () => false,
        beginClose,
        close,
        finalize,
        flush,
      };
      internal.teamManager = { cleanup: teamCleanup };
      internal.arenaManager = { cleanup: arenaCleanup };
      const wrapped = Object.create(deriveConfig(parent)) as Config;

      expect(wrapped.hasSessionWriteOwnership()).toBe(false);
      expect(() => wrapped.closeSessionWriter()).toThrow(
        'Session write ownership could not be verified.',
      );
      expect(() => wrapped.startNewSession()).toThrow(
        'Derived Configs cannot start new sessions',
      );
      await expect(
        wrapped.relocateWorkingDirectory(baseParams.targetDir),
      ).rejects.toThrow('Derived Configs cannot relocate working directories');
      await expect(wrapped.cleanupTeamRuntime()).rejects.toThrow(
        'Derived Configs cannot clean up Team runtime',
      );
      await expect(wrapped.cleanupArenaRuntime(true)).rejects.toThrow(
        'Derived Configs cannot clean up Arena runtime',
      );
      await expect(
        wrapped.shutdown({ shutdownTelemetry: false }),
      ).resolves.toBeUndefined();

      expect(stop).not.toHaveBeenCalled();
      expect(beginClose).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(finalize).not.toHaveBeenCalled();
      expect(flush).not.toHaveBeenCalled();
      expect(teamCleanup).not.toHaveBeenCalled();
      expect(arenaCleanup).not.toHaveBeenCalled();
    });

    it('prohibits derived approval changes from mutating parent permissions', () => {
      const parent = new Config(baseParams);
      const restoreDangerousRules = vi.fn();
      const internal = parent as unknown as {
        approvalMode: ApprovalMode;
        permissionManager: {
          stripDangerousRulesForAutoMode: () => void;
          restoreDangerousRules: () => void;
        };
      };
      internal.approvalMode = ApprovalMode.AUTO;
      internal.permissionManager = {
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
      const parent = new Config(baseParams);
      const stop = vi.fn().mockResolvedValue(undefined);
      const finalize = vi.fn();
      const flush = vi.fn().mockResolvedValue(undefined);
      const beginClose = vi.fn();
      const close = vi.fn().mockResolvedValue(undefined);
      const internal = parent as unknown as {
        initialized: boolean;
        toolRegistry: ToolRegistry;
        chatRecordingService: {
          finalize: () => void;
          flush: () => Promise<void>;
          beginClose: () => void;
          close: () => Promise<void>;
        };
      };
      internal.initialized = true;
      internal.toolRegistry = { stop } as unknown as ToolRegistry;
      internal.chatRecordingService = {
        finalize,
        flush,
        beginClose,
        close,
      };
      const child = deriveConfig(parent);

      await expect(
        child.shutdown({ shutdownTelemetry: false }),
      ).resolves.toBeUndefined();

      expect(stop).not.toHaveBeenCalled();
      expect(finalize).not.toHaveBeenCalled();
      expect(flush).not.toHaveBeenCalled();
      expect(beginClose).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    });

    it('returns a distinct file-read cache for derived Configs', () => {
      const parent = new Config(baseParams);
      const child = deriveConfig(parent);

      const parentCache = parent.getFileReadCache();
      const childCache = child.getFileReadCache();

      expect(parentCache).toBeDefined();
      expect(childCache).toBeDefined();
      expect(childCache).not.toBe(parentCache);

      parentCache.recordRead(
        '/tmp/parent.ts',
        {
          dev: 1,
          ino: 100,
          mtimeMs: 1_000_000,
          size: 42,
        } as unknown as Stats,
        { full: true, cacheable: true },
      );

      expect(parentCache.size()).toBe(1);
      expect(childCache.size()).toBe(0);
    });

    it('returns the same cache instance on repeated getter calls within one Config', () => {
      const config = new Config(baseParams);
      expect(config.getFileReadCache()).toBe(config.getFileReadCache());
    });
  });

  describe('MCP hot-reload (sub-task 3)', () => {
    const srvA: MCPServerConfig = { command: 'a' };
    const srvB: MCPServerConfig = { command: 'b' };

    it('setMcpServers REPLACES (not merges) and works post-init', async () => {
      const config = new Config({
        ...baseParams,
        mcpServers: { a: srvA },
      });
      await config.initialize();

      // addMcpServers would throw post-init; setMcpServers must not.
      config.setMcpServers({ b: srvB });

      const settingsLayer = config.getSettingsMcpServers();
      expect(settingsLayer).toEqual({ b: srvB });
      expect(settingsLayer).not.toHaveProperty('a');
    });

    it('reinitializeMcpServers is a safe no-op before initialize()', async () => {
      const config = new Config({ ...baseParams });
      // No tool registry yet — must not throw and must not connect.
      await expect(
        config.reinitializeMcpServers({ a: srvA }),
      ).resolves.toBeUndefined();
      expect(config.getSettingsMcpServers()).toEqual({ a: srvA });
    });

    it('records MCP servers removed by a reconcile and self-heals on re-add', async () => {
      const config = new Config({
        ...baseParams,
        mcpServers: { a: srvA, b: srvB },
      });

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
      const config = new Config({
        ...baseParams,
        mcpServers: { a: srvA, b: srvB },
      });
      await config.reinitializeMcpServers({ a: srvA, b: srvB });

      // Narrow the allow-list to just `a` (mirrors editing mcp.allowed). `b` is
      // still configured (merged map) but filtered out of the effective map.
      config.setAllowedMcpServers(['a']);

      // `b` is NOT "removed" — it's still in config, just not allowed. The
      // tool-not-found path can still explain it precisely, with the right
      // recovery action (adjust mcp.allowed, not "re-add the server").
      expect(config.getRecentlyRemovedMcpServers()).not.toContain('b');
      expect(config.getMcpServerUnavailableReason('b')).toBe('not_allowed');
      expect(config.getMcpServerUnavailableReason('a')).toBeUndefined();
    });

    it('classifies excluded / pending / removed servers with the right reason', async () => {
      const config = new Config({
        ...baseParams,
        mcpServers: { a: srvA, b: srvB, c: srvA },
      });
      await config.reinitializeMcpServers({ a: srvA, b: srvB, c: srvA });

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
      const config = new Config({ ...baseParams, mcpServers: { a: srvA } });
      await config.initialize();
      const manager = (
        config.getToolRegistry() as unknown as {
          __mcpManagerMock: { discoverAllMcpToolsIncremental: Mock };
        }
      ).__mcpManagerMock;
      manager.discoverAllMcpToolsIncremental.mockClear();

      await config.reinitializeMcpServers({ b: srvB });

      expect(config.getSettingsMcpServers()).toEqual({ b: srvB });
      expect(manager.discoverAllMcpToolsIncremental).toHaveBeenCalledTimes(1);
      expect(manager.discoverAllMcpToolsIncremental).toHaveBeenCalledWith(
        config,
      );
    });

    it('coalesces a reconcile request that arrives mid-flight into one extra pass', async () => {
      const config = new Config({ ...baseParams, mcpServers: { a: srvA } });
      await config.initialize();
      const manager = (
        config.getToolRegistry() as unknown as {
          __mcpManagerMock: { discoverAllMcpToolsIncremental: Mock };
        }
      ).__mcpManagerMock;
      manager.discoverAllMcpToolsIncremental.mockClear();

      // Make the first pass hang until we release it, so the second call
      // arrives while the first is in flight.
      let release!: () => void;
      manager.discoverAllMcpToolsIncremental.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );

      const first = config.reinitializeMcpServers({ b: srvB });
      // Second call lands mid-flight → coalesced, not a third pass.
      const second = config.reinitializeMcpServers({ a: srvA, b: srvB });
      release();
      await Promise.all([first, second]);

      // One in-flight pass + one drained follow-up = exactly 2 passes.
      expect(manager.discoverAllMcpToolsIncremental).toHaveBeenCalledTimes(2);
    });

    it('rethrows a failed reconcile and resets the in-progress guard so the next call still runs', async () => {
      const config = new Config({ ...baseParams, mcpServers: { a: srvA } });
      await config.initialize();
      const manager = (
        config.getToolRegistry() as unknown as {
          __mcpManagerMock: { discoverAllMcpToolsIncremental: Mock };
        }
      ).__mcpManagerMock;
      manager.discoverAllMcpToolsIncremental.mockClear();

      // First pass fails — reinitialize must surface the error.
      manager.discoverAllMcpToolsIncremental.mockRejectedValueOnce(
        new Error('reconcile boom'),
      );
      await expect(config.reinitializeMcpServers({ b: srvB })).rejects.toThrow(
        'reconcile boom',
      );

      // Guard must have been reset in `finally`; a subsequent call must not be
      // silently coalesced/dropped — it runs a fresh pass.
      await config.reinitializeMcpServers({ a: srvA });
      expect(manager.discoverAllMcpToolsIncremental).toHaveBeenCalledTimes(2);
    });

    it('clears the coalesce flag when a reconcile throws, so the next call runs exactly one pass', async () => {
      const config = new Config({ ...baseParams, mcpServers: { a: srvA } });
      await config.initialize();
      const manager = (
        config.getToolRegistry() as unknown as {
          __mcpManagerMock: { discoverAllMcpToolsIncremental: Mock };
        }
      ).__mcpManagerMock;
      manager.discoverAllMcpToolsIncremental.mockClear();

      // Pass 1 hangs until we reject it; while it is in flight a second call
      // arrives and is coalesced (sets the pending flag).
      let reject!: (e: Error) => void;
      manager.discoverAllMcpToolsIncremental.mockImplementationOnce(
        () =>
          new Promise<void>((_, rej) => {
            reject = rej;
          }),
      );
      const first = config.reinitializeMcpServers({ b: srvB });
      const second = config.reinitializeMcpServers({ a: srvA, b: srvB });
      reject(new Error('reconcile boom'));
      await expect(first).rejects.toThrow('reconcile boom');
      // The coalesced caller awaits the shared in-flight pass, so it observes
      // the SAME failure rather than resolving before its change was applied.
      await expect(second).rejects.toThrow('reconcile boom');

      // The throw must have cleared the pending flag too. A subsequent
      // unrelated reconcile must run EXACTLY ONE pass — not an extra stale
      // drain pass left over from the coalesced-then-aborted request.
      manager.discoverAllMcpToolsIncremental.mockClear();
      await config.reinitializeMcpServers({ a: srvA });
      expect(manager.discoverAllMcpToolsIncremental).toHaveBeenCalledTimes(1);
    });

    it('a coalesced reconcile awaits the in-flight pass + its drain (does not resolve early)', async () => {
      const config = new Config({ ...baseParams, mcpServers: { a: srvA } });
      await config.initialize();
      const manager = (
        config.getToolRegistry() as unknown as {
          __mcpManagerMock: { discoverAllMcpToolsIncremental: Mock };
        }
      ).__mcpManagerMock;
      manager.discoverAllMcpToolsIncremental.mockClear();

      // Pass 1 hangs until released; the second call lands mid-flight.
      let release!: () => void;
      manager.discoverAllMcpToolsIncremental.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );

      let secondResolved = false;
      const first = config.reinitializeMcpServers({ b: srvB });
      const second = config
        .reinitializeMcpServers({ a: srvA, b: srvB })
        .then(() => {
          secondResolved = true;
        });

      // While pass 1 is still in flight the coalesced caller must NOT have
      // resolved — it is chained onto the shared in-flight reconcile, so its
      // change has not been applied yet.
      await Promise.resolve();
      expect(secondResolved).toBe(false);

      release();
      await Promise.all([first, second]);
      expect(secondResolved).toBe(true);
      // pass 1 + exactly one drain (for the coalesced change) = 2 passes.
      expect(manager.discoverAllMcpToolsIncremental).toHaveBeenCalledTimes(2);
    });

    it('admission-list setters and getMcpGating round-trip', () => {
      const config = new Config({ ...baseParams });
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
      const config = new Config({
        ...baseParams,
        mcpServers: {
          puppeteer: srvA,
          'my-puppeteer-server': srvB,
          playwright: srvA,
        },
      });
      config.setAllowedMcpServers(['*puppeteer*']);
      const result = config.getMcpServers();
      expect(Object.keys(result!)).toEqual([
        'puppeteer',
        'my-puppeteer-server',
      ]);
      expect(Object.keys(result!)).not.toContain('playwright');
    });

    it('getMcpServers does not stamp cwd — cwd binding happens in populateMcpServerCommand', () => {
      const explicitCwd = path.resolve('/explicit/mcp');
      const config = new Config({
        ...baseParams,
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
      const config = new Config({
        ...baseParams,
        mcpServers: {
          puppeteer: srvA,
          'my-puppeteer': srvA,
          playwright: srvB,
        },
      });
      config.setExcludedMcpServers(['*puppeteer*']);
      expect(config.isMcpServerDisabled('puppeteer')).toBe(true);
      expect(config.isMcpServerDisabled('my-puppeteer')).toBe(true);
      expect(config.isMcpServerDisabled('playwright')).toBe(false);
      expect(config.getMcpServers()!['puppeteer']).toBeDefined();
      expect(config.getMcpServers()!['my-puppeteer']).toBeDefined();
    });

    it('getMcpServerUnavailableReason classifies by glob match', async () => {
      const config = new Config({
        ...baseParams,
        mcpServers: {
          puppeteer: srvA,
          playwright: srvB,
          chrome: srvA,
        },
      });
      await config.reinitializeMcpServers({
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
      const config = new Config({
        ...baseParams,
        mcpServers: { puppeteer: srvA, playwright: srvB },
      });
      await config.reinitializeMcpServers({
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
      const config = new Config({
        ...baseParams,
        mcpServers: { puppeteer: srvA, playwright: srvB },
      });
      await config.reinitializeMcpServers({
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
      const config = new Config({
        ...baseParams,
        mcpServers: {
          puppeteer: srvA,
          'my-puppeteer': srvA,
          playwright: srvB,
        },
      });
      config.setAllowedMcpServers(['*puppeteer*']);
      const blocked = config.getBlockedMcpServers();
      const blockedNames = blocked.map((s) => s.name);
      expect(blockedNames).toContain('playwright');
      expect(blockedNames).not.toContain('puppeteer');
      expect(blockedNames).not.toContain('my-puppeteer');
    });
  });

  describe('MemoryPressureMonitor isolation', () => {
    it('returns a distinct monitor for child Configs created via deriveConfig', async () => {
      const parent = new Config(baseParams);
      await parent.initialize({ skipLlmInitialization: true });
      const child = deriveConfig(parent);

      const parentMonitor = parent.getMemoryPressureMonitor();
      const childMonitor = child.getMemoryPressureMonitor();

      expect(parentMonitor).toBeDefined();
      expect(childMonitor).toBeDefined();
      expect(childMonitor).not.toBe(parentMonitor);
      expect(child.getMemoryPressureMonitor()).toBe(childMonitor);
    });

    it('resets monitor cleanup state when starting a new session', async () => {
      const config = new Config(baseParams);
      await config.initialize({ skipLlmInitialization: true });
      const monitor = config.getMemoryPressureMonitor();
      expect(monitor).toBeDefined();
      const resetSpy = vi.spyOn(monitor!, 'resetForNewSession');

      config.startNewSession();

      expect(resetSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('MemoryPressure configuration environment', () => {
    const restorers: Array<() => void> = [];
    const originalEnv = new Map<string, string | undefined>();

    beforeEach(() => {
      originalEnv.clear();
      for (const envName of MEMORY_PRESSURE_ENV_KEYS) {
        originalEnv.set(envName, process.env[envName]);
        delete process.env[envName];
      }
    });

    afterEach(() => {
      while (restorers.length > 0) {
        restorers.pop()?.();
      }
      for (const [envName, value] of originalEnv) {
        if (value === undefined) {
          delete process.env[envName];
        } else {
          process.env[envName] = value;
        }
      }
      originalEnv.clear();
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
      process.env['QWEN_MEMORY_PRESSURE_SOFT'] = '0.3';
      process.env['QWEN_MEMORY_PRESSURE_HARD'] = '0.6';
      process.env['QWEN_MEMORY_PRESSURE_CRITICAL'] = '0.9';

      const config = new Config(baseParams);
      await config.initialize({ skipLlmInitialization: true });
      mockMemoryRatio(0.35);

      expect(config.getMemoryPressureMonitor()?.getPressureLevel()).toBe(
        'soft',
      );
    });

    it('falls back to defaults and warns on strict env parse failures', async () => {
      const stderrSpy = mockStderrWrite();
      process.env['QWEN_MEMORY_PRESSURE_SOFT'] = '0.3extra';
      process.env['QWEN_MEMORY_PRESSURE_HARD'] = '0.6';
      process.env['QWEN_MEMORY_PRESSURE_CRITICAL'] = '0.9';

      const config = new Config(baseParams);
      await config.initialize({ skipLlmInitialization: true });
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
      process.env['QWEN_MEMORY_PRESSURE_SOFT'] = '0.7';

      const config = new Config(baseParams);
      await config.initialize({ skipLlmInitialization: true });

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
        process.env['QWEN_MEMORY_PRESSURE_SOFT'] = value;

        const config = new Config(baseParams);
        await config.initialize({ skipLlmInitialization: true });
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
      Object.defineProperty(globalWithGc, 'gc', {
        value: gcSpy,
        configurable: true,
      });
      restorers.push(() => {
        if (originalGc) {
          Object.defineProperty(globalWithGc, 'gc', {
            value: originalGc,
            configurable: true,
          });
        } else {
          delete globalWithGc.gc;
        }
      });

      const config = new Config(baseParams);
      await config.initialize({ skipLlmInitialization: true });
      mockMemoryRatio(0.85);

      config.getMemoryPressureMonitor()?.performCheck();
      // Critical tier has 4 async steps, need enough microtask drains
      for (let i = 0; i < 6; i++) await Promise.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await Promise.resolve();

      expect(gcSpy).toHaveBeenCalledTimes(1);
    });

    it('child Config monitors inherit the parent memory pressure config snapshot', async () => {
      process.env['QWEN_MEMORY_PRESSURE_SOFT'] = '0.3';
      process.env['QWEN_MEMORY_PRESSURE_HARD'] = '0.6';
      process.env['QWEN_MEMORY_PRESSURE_CRITICAL'] = '0.9';
      const parent = new Config(baseParams);
      await parent.initialize({ skipLlmInitialization: true });

      process.env['QWEN_MEMORY_PRESSURE_SOFT'] = '0.9';
      process.env['QWEN_MEMORY_PRESSURE_HARD'] = '0.95';
      process.env['QWEN_MEMORY_PRESSURE_CRITICAL'] = '0.97';
      const child = deriveConfig(parent);
      mockMemoryRatio(0.35);

      expect(child.getMemoryPressureMonitor()?.getPressureLevel()).toBe('soft');
    });
  });

  describe('startNewSession', () => {
    it('clears loaded Skill state at the session boundary', async () => {
      const config = new Config({ ...baseParams });
      await config.initialize({
        skipGeminiInitialization: true,
        skipHooks: true,
        skipMcpDiscovery: true,
        skipSkillManager: true,
        skipFileCheckpointing: true,
      });
      const clearLoadedSkills = vi.fn();
      vi.spyOn(config.getToolRegistry(), 'getTool').mockImplementation(
        (name: string) =>
          name === ToolNames.SKILL
            ? ({ clearLoadedSkills } as never)
            : undefined,
      );

      config.startNewSession('replacement-session');

      expect(clearLoadedSkills).toHaveBeenCalledOnce();
    });

    it('records no lifecycle transition when resuming the current session id', async () => {
      const sessionId = 'same-session-id';
      const config = new Config({ ...baseParams, sessionId });
      await config.initialize({
        skipLlmInitialization: true,
        skipHooks: true,
        skipMcpDiscovery: true,
        skipSkillManager: true,
        skipFileCheckpointing: true,
      });
      vi.mocked(logSessionEnd).mockClear();
      vi.mocked(logStartSession).mockClear();
      const clearLoadedSkills = vi.fn();
      vi.spyOn(config.getToolRegistry(), 'getTool').mockImplementation(
        (name: string) =>
          name === ToolNames.SKILL
            ? ({ clearLoadedSkills } as never)
            : undefined,
      );

      config.startNewSession(sessionId, {
        conversation: { messages: [] },
      } as unknown as ResumedSessionData);

      expect(logSessionEnd).not.toHaveBeenCalled();
      expect(clearLoadedSkills).not.toHaveBeenCalled();
      expect(logStartSession).toHaveBeenCalledWith(
        config,
        expect.anything(),
        undefined,
      );
    });

    it('pins the outgoing chat recorder to the outgoing session id', async () => {
      const config = new Config({ ...baseParams, chatRecording: true });
      await config.initialize({
        skipLlmInitialization: true,
        skipHooks: true,
        skipMcpDiscovery: true,
        skipSkillManager: true,
        skipFileCheckpointing: true,
      });
      const outgoingSessionId = config.getSessionId();
      const outgoingRecorder = config.getChatRecordingService();
      expect(outgoingRecorder).toBeDefined();
      const pinSpy = vi.spyOn(outgoingRecorder!, 'pinSessionIdentity');

      config.startNewSession('replacement-session');

      expect(pinSpy).toHaveBeenCalledWith(outgoingSessionId);
      expect(config.getChatRecordingService()).not.toBe(outgoingRecorder);
    });

    it('ends the outgoing session before starting a replacement without continuation', async () => {
      const config = new Config({ ...baseParams });
      await config.initialize({
        skipLlmInitialization: true,
        skipHooks: true,
        skipMcpDiscovery: true,
        skipSkillManager: true,
        skipFileCheckpointing: true,
      });
      const outgoingSessionId = config.getSessionId();
      const endedSessionIds: string[] = [];
      vi.mocked(logSessionEnd).mockClear();
      vi.mocked(logStartSession).mockClear();
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
      const config = new Config({ ...baseParams });
      await config.initialize({
        skipLlmInitialization: true,
        skipHooks: true,
        skipMcpDiscovery: true,
        skipSkillManager: true,
        skipFileCheckpointing: true,
      });
      const outgoingSessionId = config.getSessionId();
      vi.mocked(logStartSession).mockClear();

      config.startNewSession('resumed-session-id', {
        conversation: { messages: [] },
      } as unknown as ResumedSessionData);

      expect(logStartSession).toHaveBeenCalledWith(
        config,
        expect.anything(),
        outgoingSessionId,
      );
    });

    it('rejects a session switch while the current recorder owns the writer lease', () => {
      const config = new Config({ ...baseParams, chatRecording: true });
      const originalSessionId = config.getSessionId();
      const finalize = vi.fn();
      const flush = vi.fn().mockResolvedValue(undefined);
      const recorder = {
        finalize,
        flush,
        hasWriteOwnership: () => true,
      };
      (
        config as unknown as {
          chatRecordingService: typeof recorder;
        }
      ).chatRecordingService = recorder;

      vi.mocked(logSessionEnd).mockClear();
      vi.mocked(logStartSession).mockClear();

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

    const resumedGoalSession = (
      status: 'active' | 'paused',
    ): ResumedSessionData => {
      const record: ChatRecord = {
        uuid: `goal-${status}`,
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
          cause: status === 'active' ? 'create' : 'pause',
          snapshot: {
            v: 2,
            activity: 'idle',
            goal: {
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
            },
          },
        },
      };
      return {
        conversation: {
          sessionId: 'resumed-session',
          projectHash: 'test',
          startTime: new Date(0).toISOString(),
          lastUpdated: new Date(0).toISOString(),
          messages: [record],
        },
        filePath: '/tmp/resumed-session.jsonl',
        lastCompletedUuid: record.uuid,
      };
    };

    // A pre-canonical transcript whose newest Goal record is a legacy
    // `goal_status` card. Recovering it is the one restore path that has to
    // *write*: it journals a migrated `goal_state` record.
    const legacyGoalSession = (): ResumedSessionData => {
      const record = {
        uuid: 'legacy-goal',
        parentUuid: null,
        sessionId: 'resumed-session',
        timestamp: new Date(0).toISOString(),
        type: 'system',
        subtype: 'slash_command',
        provenance: 'goal_control',
        cwd: '/tmp',
        version: 'test',
        systemPayload: {
          phase: 'result',
          outputHistoryItems: [
            { type: 'goal_status', kind: 'set', condition: 'ship the thing' },
          ],
        },
      } as unknown as ChatRecord;
      return {
        conversation: {
          sessionId: 'resumed-session',
          projectHash: 'test',
          startTime: new Date(0).toISOString(),
          lastUpdated: new Date(0).toISOString(),
          messages: [record],
        },
        filePath: '/tmp/resumed-session.jsonl',
        lastCompletedUuid: record.uuid,
      };
    };

    // Under a writer lease the recorder is `inactive` until it is handed the
    // lease, and rejects every write until then. Kicking the legacy
    // migration off from the constructor drove that write into the guard,
    // and `restore()` latches the failure as `recoveryError` permanently:
    // the migrated goal was dropped and the whole resumed session lost goal
    // persistence. Ordering is the deciding variable, so this asserts the
    // deferred restore lands the goal rather than bricking the runtime.
    it('waits for the session writer before migrating a legacy Goal', async () => {
      const config = new Config({
        ...baseParams,
        chatRecording: true,
        experimentalZedIntegration: true,
        sessionWriterLeaseEnabled: true,
        sessionData: legacyGoalSession(),
      });
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
      (
        config as unknown as { startPendingGoalRestore(): void }
      ).startPendingGoalRestore();

      const runtime = await ready;
      expect(recordGoalState).toHaveBeenCalledTimes(1);
      expect(runtime.getSnapshot().goal).toMatchObject({
        objective: 'ship the thing',
        status: 'paused',
      });
      // The runtime is usable, not latched on `recoveryError` — which is
      // what `assertOperational()` would rethrow from every later
      // beginTurn/dispatch/finishTurn.
      expect(() => runtime.beginTurn('turn-1')).not.toThrow();
    });

    it('fails a deferred Goal restore instead of hanging when the writer never arrives', async () => {
      const config = new Config({
        ...baseParams,
        chatRecording: true,
        experimentalZedIntegration: true,
        sessionWriterLeaseEnabled: true,
        sessionData: legacyGoalSession(),
      });
      const ready = config.getGoalRuntimeReady();
      config.startNewSession('replacement-session');

      await expect(ready).rejects.toBeInstanceOf(
        GoalPersistenceUnavailableError,
      );
    });

    it('parks one approved proposal and hands it to the client once', () => {
      const config = new Config({ ...baseParams, chatRecording: true });

      expect(
        config.setPendingGoalProposal({
          objective: 'first',
          turnKey: 'turn-1',
        }),
      ).toBe(true);
      expect(
        config.setPendingGoalProposal({
          objective: 'second',
          turnKey: 'turn-1',
        }),
      ).toBe(false);
      expect(config.hasPendingGoalProposal()).toBe(true);
      expect(config.takePendingGoalProposal('turn-2')).toBeUndefined();
      expect(config.hasPendingGoalProposal()).toBe(true);
      expect(config.takePendingGoalProposal('turn-1')).toEqual({
        objective: 'first',
        turnKey: 'turn-1',
      });
      expect(config.hasPendingGoalProposal()).toBe(false);
      expect(config.takePendingGoalProposal()).toBeUndefined();

      expect(
        config.setPendingGoalProposal({
          objective: 'explicitly cleared',
          turnKey: 'turn-3',
        }),
      ).toBe(true);
      expect(config.takePendingGoalProposal()).toEqual({
        objective: 'explicitly cleared',
        turnKey: 'turn-3',
      });
      expect(config.hasPendingGoalProposal()).toBe(false);
    });

    it('clears a parked proposal when the session Goal runtime is replaced', () => {
      const config = new Config({ ...baseParams, chatRecording: true });
      config.setPendingGoalProposal({
        objective: 'stale approval',
        turnKey: 'turn-1',
      });

      config.startNewSession('replacement-session');

      expect(config.takePendingGoalProposal()).toBeUndefined();
    });

    it('restores the complete resumed-session Goal before exposing readiness', async () => {
      const config = new Config({
        ...baseParams,
        chatRecording: true,
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

    it('holds selective Goal readiness and autonomous work until finalization', async () => {
      const record = resumedGoalSession('active').conversation.messages[0]!;
      const config = new Config({
        ...baseParams,
        chatRecording: true,
        sessionRestoreProjection: {
          sessionId: 'resumed-session',
          filePath: '/tmp/resumed-session.jsonl',
          startTime: new Date(0).toISOString(),
          lastUpdated: new Date(0).toISOString(),
          runtime: {
            apiHistory: [],
            uiTelemetryEvents: [],
            recording: {
              lastCompletedUuid: record.uuid,
              turnParentUuids: [],
            },
            goalRecords: [record],
            initialTurn: 0,
            backgroundNotificationTaskIds: [],
          },
        },
      });
      const started: string[] = [];
      config.bindGoalTurnHost({
        startGoalTurn: vi.fn(async ({ permit }) => {
          started.push(permit.goalId);
        }),
        preemptGoalTurn: vi.fn(),
      });
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
      await vi.waitFor(() => expect(started).toEqual(['g-resumed']));
    });

    it('rejects selective Goal readiness when restore is abandoned', async () => {
      const record = resumedGoalSession('active').conversation.messages[0]!;
      const config = new Config({
        ...baseParams,
        chatRecording: true,
        sessionRestoreProjection: {
          sessionId: 'resumed-session',
          filePath: '/tmp/resumed-session.jsonl',
          startTime: new Date(0).toISOString(),
          lastUpdated: new Date(0).toISOString(),
          runtime: {
            apiHistory: [],
            uiTelemetryEvents: [],
            recording: {
              lastCompletedUuid: record.uuid,
              turnParentUuids: [],
            },
            goalRecords: [record],
            initialTurn: 0,
            backgroundNotificationTaskIds: [],
          },
        },
      });
      const readiness = config.getGoalRuntimeReady();

      config.startNewSession('replacement-session');

      await expect(readiness).rejects.toThrow('Session restore was abandoned');
    });

    it('owns one durable Goal runtime per canonical session', async () => {
      const config = new Config({ ...baseParams, chatRecording: true });
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
      const config = new Config({
        ...baseParams,
        chatRecording: true,
        goalTokenBudget: 1_234,
      });
      expect(config.getGoalTokenBudgetGrant()).toBe(1_234);

      const runtime = config.getGoalRuntime();
      await runtime.dispatch({ action: 'create', objective: 'ship' });

      expect(runtime.getSnapshot().goal).toMatchObject({ tokenBudget: 1_234 });
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
        const config = new Config({
          ...baseParams,
          chatRecording: true,
          goalTokenBudget,
        });
        expect(config.getGoalTokenBudgetGrant()).toBe(Number.POSITIVE_INFINITY);

        const runtime = config.getGoalRuntime();
        await runtime.dispatch({ action: 'create', objective: 'ship' });

        expect(runtime.getSnapshot().goal).not.toHaveProperty('tokenBudget');
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
        const config = new Config({
          ...baseParams,
          chatRecording: true,
          goalTokenBudget,
        });
        expect(config.getGoalTokenBudgetGrant()).toBe(
          GOAL_DEFAULT_TOKEN_BUDGET,
        );

        const runtime = config.getGoalRuntime();
        await runtime.dispatch({ action: 'create', objective: 'ship' });

        expect(runtime.getSnapshot().goal).toMatchObject({
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

    it('records the invalid-goalTokenBudget fallback in the debug log', async () => {
      // The fallback notice lives in the debug log file (enabled via
      // QWEN_DEBUG_LOG_FILE / --debug), not on a user-visible channel.
      const previousDebugLogFileEnv = process.env['QWEN_DEBUG_LOG_FILE'];
      const sessionId = 'goal-budget-warning-session';
      const mkdirSpy = vi
        .spyOn(fs.promises, 'mkdir')
        .mockResolvedValue(undefined);
      const appendFileSpy = vi
        .spyOn(fs.promises, 'appendFile')
        .mockResolvedValue(undefined);

      try {
        process.env['QWEN_DEBUG_LOG_FILE'] = '1';
        resetDebugLoggingState();

        new Config({ ...baseParams, sessionId, goalTokenBudget: -5 });

        await vi.waitFor(() =>
          expect(appendFileSpy).toHaveBeenCalledWith(
            Storage.getDebugLogPath(sessionId),
            expect.stringMatching(
              /Ignoring invalid goalTokenBudget -5:.*using the default of 30000000/,
            ),
            'utf8',
          ),
        );
      } finally {
        mkdirSpy.mockRestore();
        appendFileSpy.mockRestore();
        resetDebugLoggingState();
        setDebugLogSession(null);
        if (previousDebugLogFileEnv === undefined) {
          delete process.env['QWEN_DEBUG_LOG_FILE'];
        } else {
          process.env['QWEN_DEBUG_LOG_FILE'] = previousDebugLogFileEnv;
        }
      }
    });

    it('keeps the goalTokenBudget debug warning silent for absent, valid, and opt-out values', async () => {
      const previousDebugLogFileEnv = process.env['QWEN_DEBUG_LOG_FILE'];
      const sessionId = 'goal-budget-warning-session';
      const mkdirSpy = vi
        .spyOn(fs.promises, 'mkdir')
        .mockResolvedValue(undefined);
      const appendFileSpy = vi
        .spyOn(fs.promises, 'appendFile')
        .mockResolvedValue(undefined);

      try {
        process.env['QWEN_DEBUG_LOG_FILE'] = '1';
        resetDebugLoggingState();

        for (const goalTokenBudget of [undefined, 0, 1_234, -1]) {
          new Config({ ...baseParams, sessionId, goalTokenBudget });
          // Let any fire-and-forget debug write settle before the next case.
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(
          appendFileSpy.mock.calls.filter((call) =>
            String(call[1]).includes('Ignoring invalid goalTokenBudget'),
          ),
        ).toHaveLength(0);

        // Control case: the channel is live in this test, so the silence
        // above is meaningful.
        new Config({ ...baseParams, sessionId, goalTokenBudget: -5 });
        await vi.waitFor(() =>
          expect(appendFileSpy).toHaveBeenCalledWith(
            Storage.getDebugLogPath(sessionId),
            expect.stringContaining('Ignoring invalid goalTokenBudget -5'),
            'utf8',
          ),
        );
      } finally {
        mkdirSpy.mockRestore();
        appendFileSpy.mockRestore();
        resetDebugLoggingState();
        setDebugLogSession(null);
        if (previousDebugLogFileEnv === undefined) {
          delete process.env['QWEN_DEBUG_LOG_FILE'];
        } else {
          process.env['QWEN_DEBUG_LOG_FILE'] = previousDebugLogFileEnv;
        }
      }
    });

    it('bills Goal turns through the canonical chat recorder', async () => {
      const config = new Config({ ...baseParams, chatRecording: true });
      const started: GoalTurnPermit[] = [];
      config.bindGoalTurnHost({
        startGoalTurn: vi.fn(async ({ permit }) => {
          started.push(permit);
        }),
        preemptGoalTurn: vi.fn(),
      });
      const runtime = config.getGoalRuntime();
      await runtime.dispatch({ action: 'create', objective: 'ship' });
      const permit = started[0]!;

      config.getChatRecordingService()!.recordAssistantTurn({
        model: 'test-model',
        tokens: { totalTokenCount: 4_500 },
        goalContext: permit,
      });
      await runtime.finishTurn(permit);

      expect(runtime.getSnapshot().goal).toMatchObject({ tokensUsed: 4_500 });
    });

    it('rebinds the current Goal host to every replacement runtime', async () => {
      const config = new Config({
        ...baseParams,
        chatRecording: true,
        sessionData: resumedGoalSession('active'),
      });
      const started: string[] = [];
      const host: GoalTurnHost = {
        startGoalTurn: vi.fn(async ({ permit }) => {
          started.push(permit.goalId);
        }),
        preemptGoalTurn: vi.fn(),
      };

      config.bindGoalTurnHost(host);
      await config.getGoalRuntimeReady();
      await vi.waitFor(() => expect(started).toEqual(['g-resumed']));

      config.startNewSession(
        'replacement-session',
        resumedGoalSession('active'),
      );
      await config.getGoalRuntimeReady();
      await vi.waitFor(() =>
        expect(started).toEqual(['g-resumed', 'g-resumed']),
      );
    });

    it('does not expose volatile Goal state when chat recording is disabled', () => {
      const config = new Config({ ...baseParams, chatRecording: false });

      expect(() => config.getGoalRuntime()).toThrow(
        GoalPersistenceUnavailableError,
      );
    });

    it('does not leak the canonical Goal runtime through subagent prototypes', async () => {
      const config = new Config({ ...baseParams, chatRecording: true });
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
      // Regression guard: the file-read cache backs ReadFile's
      // file_unchanged placeholder, whose correctness depends on the
      // model having seen the prior read earlier in the *current*
      // conversation. /clear and resume both go through
      // startNewSession(), so it must drop cache entries the new
      // session has never seen.
      const config = new Config(baseParams);
      const cache = config.getFileReadCache();
      cache.recordRead(
        '/tmp/whatever.ts',
        {
          dev: 1,
          ino: 100,
          mtimeMs: 1_000_000,
          size: 42,
        } as unknown as import('node:fs').Stats,
        { full: true, cacheable: true },
      );
      expect(cache.size()).toBe(1);

      config.startNewSession();
      expect(cache.size()).toBe(0);
    });

    it('refreshes the telemetry session context with the new session ID', () => {
      const config = new Config(baseParams);
      vi.mocked(refreshSessionContext).mockClear();

      const newSessionId = config.startNewSession();

      expect(refreshSessionContext).toHaveBeenCalledWith(newSessionId);
    });

    it('flushes the outgoing chat recording service when switching sessions', () => {
      const config = new Config({
        ...baseParams,
        chatRecording: true,
      });
      const finalize = vi.fn();
      const flush = vi.fn().mockResolvedValue(undefined);
      const pinSessionIdentity = vi.fn();
      (
        config as unknown as {
          chatRecordingService?: {
            finalize: () => void;
            flush: () => Promise<void>;
            hasWriteOwnership: () => boolean;
            pinSessionIdentity: (sessionId: string) => void;
          };
        }
      ).chatRecordingService = {
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
    const notify = (config: Config, event: ChatRecordingFailureEvent) => {
      (
        config as unknown as {
          notifyChatRecordingFailure: (
            failure: ChatRecordingFailureEvent,
          ) => void;
        }
      ).notifyChatRecordingFailure(event);
    };

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
      const config = new Config({ ...baseParams, chatRecording: true });
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
      (
        config as unknown as {
          initialized: boolean;
          chatRecordingService: {
            finalize: () => void;
            flush: () => Promise<void>;
            beginClose: () => void;
            close: () => Promise<void>;
          };
        }
      ).initialized = true;
      (
        config as unknown as {
          chatRecordingService: {
            finalize: () => void;
            flush: () => Promise<void>;
            beginClose: () => void;
            close: () => Promise<void>;
          };
        }
      ).chatRecordingService = {
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

  it('should expose LSP status from the configured client', () => {
    const getStatusSnapshot = vi.fn().mockReturnValue({
      enabled: true,
      configuredServers: 1,
      readyServers: 1,
      failedServers: 0,
      inProgressServers: 0,
      notStartedServers: 0,
      servers: [
        {
          name: 'clangd',
          status: 'READY',
          languages: ['cpp'],
          transport: 'stdio',
        },
      ],
    });
    const config = new Config({
      ...baseParams,
      lsp: { enabled: true },
      lspClient: {
        getStatusSnapshot,
      } as unknown as ConfigParameters['lspClient'],
    });

    expect(config.getLspStatusSnapshot()).toEqual({
      enabled: true,
      configuredServers: 1,
      readyServers: 1,
      failedServers: 0,
      inProgressServers: 0,
      notStartedServers: 0,
      servers: [
        {
          name: 'clangd',
          status: 'READY',
          languages: ['cpp'],
          transport: 'stdio',
        },
      ],
    });
    expect(getStatusSnapshot).toHaveBeenCalledTimes(1);
  });

  it('keeps project-derived features disabled for a provisional workspace', () => {
    const config = new Config({
      ...baseParams,
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
    const config = new Config({
      ...baseParams,
      lsp: { enabled: true },
      lspClient: {} as unknown as ConfigParameters['lspClient'],
    });

    expect(config.getLspStatusSnapshot()).toEqual({
      enabled: true,
      configuredServers: 0,
      readyServers: 0,
      failedServers: 0,
      inProgressServers: 0,
      notStartedServers: 0,
      servers: [],
      statusUnavailable: true,
    });
  });

  it('should merge initialization errors into the client LSP status snapshot', () => {
    const config = new Config({
      ...baseParams,
      lsp: { enabled: true },
      lspClient: {
        getStatusSnapshot: vi.fn().mockReturnValue({
          enabled: true,
          configuredServers: 1,
          readyServers: 0,
          failedServers: 1,
          inProgressServers: 0,
          notStartedServers: 0,
          servers: [],
          initializationError: 'client failed',
        }),
      } as unknown as ConfigParameters['lspClient'],
    });

    config.setLspInitializationError('discovery failed');

    expect(config.getLspStatusSnapshot()).toMatchObject({
      enabled: true,
      initializationError: 'discovery failed',
    });
  });

  it('should report an initialization error when LSP is enabled without a client', () => {
    const config = new Config({
      ...baseParams,
      lsp: { enabled: true },
    });

    expect(config.getLspStatusSnapshot()).toEqual({
      enabled: true,
      configuredServers: 0,
      readyServers: 0,
      failedServers: 0,
      inProgressServers: 0,
      notStartedServers: 0,
      servers: [],
      initializationError: 'LSP client is not initialized',
    });
  });

  it('should no-op LSP reinitialize when disabled or unavailable', async () => {
    const disabledConfig = new Config({
      ...baseParams,
      lsp: { enabled: false },
    });
    await expect(disabledConfig.reinitializeLsp()).resolves.toBeUndefined();

    const noClientConfig = new Config({
      ...baseParams,
      lsp: { enabled: true },
    });
    await expect(noClientConfig.reinitializeLsp()).resolves.toBeUndefined();
  });

  it('should delegate LSP reinitialize to the configured client', async () => {
    const result = {
      reconcile: {
        added: ['tsserver'],
        removed: [],
        restarted: [],
        unchanged: [],
        failed: [],
      },
      skipped: [],
    };
    const reinitialize = vi.fn().mockResolvedValue(result);
    const config = new Config({
      ...baseParams,
      lsp: { enabled: true },
      lspClient: {
        reinitialize,
      } as unknown as ConfigParameters['lspClient'],
    });

    await expect(config.reinitializeLsp()).resolves.toBe(result);
    expect(reinitialize).toHaveBeenCalledOnce();
  });

  it('should surface partial LSP reinitialize failures in status snapshot', async () => {
    const result = {
      reconcile: {
        added: ['tsserver'],
        removed: [],
        restarted: [],
        unchanged: [],
        failed: ['clangd'],
      },
      skipped: [],
    };
    const config = new Config({
      ...baseParams,
      lsp: { enabled: true },
      lspClient: {
        reinitialize: vi.fn().mockResolvedValue(result),
      } as unknown as ConfigParameters['lspClient'],
    });

    await expect(config.reinitializeLsp()).resolves.toBe(result);
    expect(config.getLspStatusSnapshot()).toMatchObject({
      initializationError: 'LSP reload partially failed: clangd',
    });
  });

  it('should surface LSP reinitialize failures in status snapshot', async () => {
    const config = new Config({
      ...baseParams,
      lsp: { enabled: true },
      lspClient: {
        reinitialize: vi.fn().mockRejectedValue(new Error('invalid lsp json')),
      } as unknown as ConfigParameters['lspClient'],
    });

    await expect(config.reinitializeLsp()).rejects.toThrow('invalid lsp json');
    expect(config.getLspStatusSnapshot()).toMatchObject({
      initializationError: 'invalid lsp json',
    });
  });

  it('should clear previous LSP reinitialize failures after recovery', async () => {
    const result = {
      reconcile: {
        added: [],
        removed: [],
        restarted: [],
        unchanged: ['tsserver'],
        failed: [],
      },
      skipped: [],
    };
    const reinitialize = vi
      .fn()
      .mockRejectedValueOnce(new Error('invalid lsp json'))
      .mockResolvedValueOnce(result);
    const config = new Config({
      ...baseParams,
      lsp: { enabled: true },
      lspClient: {
        reinitialize,
      } as unknown as ConfigParameters['lspClient'],
    });

    await expect(config.reinitializeLsp()).rejects.toThrow('invalid lsp json');
    expect(config.getLspStatusSnapshot()).toMatchObject({
      initializationError: 'invalid lsp json',
    });

    await expect(config.reinitializeLsp()).resolves.toBe(result);
    expect(config.getLspStatusSnapshot().initializationError).toBeUndefined();
  });

  it('should clear partial LSP reinitialize failures after full recovery', async () => {
    const partialFailure = {
      reconcile: {
        added: [],
        removed: [],
        restarted: [],
        unchanged: [],
        failed: ['clangd'],
      },
      skipped: [],
    };
    const success = {
      reconcile: {
        added: [],
        removed: [],
        restarted: [],
        unchanged: ['clangd'],
        failed: [],
      },
      skipped: [],
    };
    const reinitialize = vi
      .fn()
      .mockResolvedValueOnce(partialFailure)
      .mockResolvedValueOnce(success);
    const config = new Config({
      ...baseParams,
      lsp: { enabled: true },
      lspClient: {
        reinitialize,
      } as unknown as ConfigParameters['lspClient'],
    });

    await expect(config.reinitializeLsp()).resolves.toBe(partialFailure);
    expect(config.getLspStatusSnapshot()).toMatchObject({
      initializationError: 'LSP reload partially failed: clangd',
    });

    await expect(config.reinitializeLsp()).resolves.toBe(success);
    expect(config.getLspStatusSnapshot().initializationError).toBeUndefined();
  });

  describe('initialize', () => {
    it('accepts managed handoff only after certified takeover is configured', async () => {
      const standalone = new Config(baseParams);
      await standalone.closeSessionWriter({ handoff: true });
      expect(
        (
          standalone as unknown as {
            sessionWriterHandoffRequested: boolean;
          }
        ).sessionWriterHandoffRequested,
      ).toBe(false);

      const managed = new Config(baseParams);
      managed.setSessionWriterTakeoverPolicy('certified');
      await managed.closeSessionWriter({ handoff: true });
      expect(
        (
          managed as unknown as {
            sessionWriterHandoffRequested: boolean;
          }
        ).sessionWriterHandoffRequested,
      ).toBe(true);
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
        const config = new Config({
          ...baseParams,
          ...params,
          chatRecording: true,
        });

        await (
          config as unknown as { activateChatRecording(): Promise<void> }
        ).activateChatRecording();

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
      const config = new Config({
        ...baseParams,
        sessionId,
        chatRecording: true,
        experimentalZedIntegration: true,
        sessionWriterLeaseEnabled: true,
      });
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

      await (
        config as unknown as { activateChatRecording(): Promise<void> }
      ).activateChatRecording();

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
      const config = new Config({
        ...baseParams,
        sessionId: 'pending-baseline',
        cwd: projectDir,
        targetDir: projectDir,
        chatRecording: true,
        experimentalZedIntegration: true,
        sessionWriterLeaseEnabled: true,
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
      let releaseRead!: () => void;
      const readGate = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      let notifyReadStarted!: () => void;
      const readStarted = new Promise<void>((resolve) => {
        notifyReadStarted = resolve;
      });
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
            notifyReadStarted();
            await readGate;
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
        await readStarted;
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
        releaseRead();
        await expect(close).resolves.toBeUndefined();
        await expect(initialize).rejects.toMatchObject({
          name: 'SessionWriterUnavailableError',
        });
        expect(config.hasSessionWriteOwnership()).toBe(false);
        expect(config.getChatRecordingService()?.hasWriteOwnership()).toBe(
          false,
        );
      } finally {
        releaseRead();
        read.mockRestore();
        Storage.setRuntimeBaseDir(null);
        await rm(root, { recursive: true, force: true });
      }
    });

    it('treats managed shutdown during writer acquisition as a clean terminal', async () => {
      const config = new Config({
        ...baseParams,
        chatRecording: true,
        experimentalZedIntegration: true,
        sessionWriterLeaseEnabled: true,
      });
      let resolveAcquire!: (lease: SessionWriterLease) => void;
      const acquireGate = new Promise<SessionWriterLease>((resolve) => {
        resolveAcquire = resolve;
      });
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
        .mockReturnValue(acquireGate);

      const initialize = config.initialize();
      await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
      const close = config.closeSessionWriter();
      resolveAcquire(lease);

      await expect(close).resolves.toBeUndefined();
      await expect(initialize).rejects.toMatchObject({
        name: 'SessionWriterUnavailableError',
      });
      expect(release).toHaveBeenCalledOnce();
      expect(config.hasSessionWriteOwnership()).toBe(false);
      acquire.mockRestore();
    });

    it('retries pending lease durability without reporting stale ownership', async () => {
      const config = new Config({
        ...baseParams,
        chatRecording: true,
        experimentalZedIntegration: true,
        sessionWriterLeaseEnabled: true,
      });
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
      (
        config as unknown as {
          pendingSessionWriterLease: SessionWriterLease;
        }
      ).pendingSessionWriterLease = lease;

      await expect(config.closeSessionWriter()).rejects.toBe(cleanupFailure);
      expect(config.hasSessionWriteOwnership()).toBe(false);

      await expect(config.closeSessionWriter()).resolves.toBeUndefined();
      expect(release).toHaveBeenCalledTimes(2);
      expect(config.hasSessionWriteOwnership()).toBe(false);
    });

    it('preserves activation and lease release failures', async () => {
      const config = new Config({
        ...baseParams,
        chatRecording: true,
        experimentalZedIntegration: true,
        sessionWriterLeaseEnabled: true,
      });
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
      const config = new Config({
        ...baseParams,
        chatRecording: true,
        experimentalZedIntegration: true,
        sessionWriterLeaseEnabled: true,
      });
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
      const config = new Config({
        ...baseParams,
        chatRecording: true,
        experimentalZedIntegration: true,
        sessionWriterLeaseEnabled: true,
      });
      const activationError = new SessionTranscriptChangedError();
      let rejectAcquire!: (error: Error) => void;
      const acquireGate = new Promise<SessionWriterLease>(
        (_resolve, reject) => {
          rejectAcquire = reject;
        },
      );
      const acquire = vi
        .spyOn(SessionWriterLease, 'acquire')
        .mockReturnValue(acquireGate);

      const initialize = config.initialize().catch((error: unknown) => error);
      await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
      const close = config
        .closeSessionWriter()
        .catch((error: unknown) => error);
      rejectAcquire(activationError);

      expect(await close).toBe(activationError);
      expect(await initialize).toBe(activationError);
      acquire.mockRestore();
    });

    it('preserves initialization and recording close failures', async () => {
      const config = new Config(baseParams);
      const initializationError = new Error('initialization failed');
      const closeError = new Error('recording close failed');
      vi.spyOn(
        config as unknown as {
          initializeInternal: () => Promise<void>;
        },
        'initializeInternal',
      ).mockRejectedValue(initializationError);
      (
        config as unknown as {
          chatRecordingService: {
            beginClose: () => void;
            close: () => Promise<void>;
          };
        }
      ).chatRecordingService = {
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
      const config = new Config(baseParams);
      const controller = new AbortController();
      const abortReason = new Error('session initialization deadline exceeded');
      const closeError = new Error('recording close failed');
      vi.spyOn(
        config as unknown as {
          initializeInternal: (options?: {
            signal?: AbortSignal;
          }) => Promise<void>;
        },
        'initializeInternal',
      ).mockImplementation(async (options) => {
        controller.abort(abortReason);
        options?.signal?.throwIfAborted();
      });
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
      const config = new Config({ ...baseParams, enableAutoSkill: true });

      await config.initialize();

      expect(maybeRunAutoSkillCurator).toHaveBeenCalledWith(
        path.resolve(TARGET_DIR),
      );
      expect(
        vi.mocked(maybeRunAutoSkillCurator).mock.invocationCallOrder[0],
      ).toBeLessThan(vi.mocked(SkillManager).mock.invocationCallOrder[0]);
    });

    it('does not run auto-skill curation when auto-skill is disabled', async () => {
      await new Config({ ...baseParams, enableAutoSkill: false }).initialize();

      expect(maybeRunAutoSkillCurator).not.toHaveBeenCalled();
    });

    it('does not run auto-skill curation in an untrusted folder', async () => {
      await new Config({
        ...baseParams,
        enableAutoSkill: true,
        trustedFolder: false,
      }).initialize();

      expect(maybeRunAutoSkillCurator).not.toHaveBeenCalled();
    });

    it('continues loading skills when auto-skill curation fails', async () => {
      vi.mocked(maybeRunAutoSkillCurator).mockRejectedValueOnce(
        new Error('corrupt curator state'),
      );

      const config = new Config({ ...baseParams, enableAutoSkill: true });

      await expect(config.initialize()).resolves.toBeUndefined();
      expect(SkillManager).toHaveBeenCalledTimes(1);
    });

    it('waits for in-flight initialization before cleaning late resources', async () => {
      const config = new Config(baseParams);
      let releaseInitialization!: () => void;
      const initializationGate = new Promise<void>((resolve) => {
        releaseInitialization = resolve;
      });
      const stop = vi.fn().mockResolvedValue(undefined);
      const internal = config as unknown as {
        initializeInternal: () => Promise<void>;
        toolRegistry: ToolRegistry;
      };
      const initializeInternal = vi
        .spyOn(internal, 'initializeInternal')
        .mockImplementation(async () => {
          await initializationGate;
          internal.toolRegistry = { stop } as unknown as ToolRegistry;
        });

      const initialize = config.initialize();
      await vi.waitFor(() => expect(initializeInternal).toHaveBeenCalledOnce());
      let shutdownSettled = false;
      const shutdown = config
        .shutdown({
          shutdownTelemetry: false,
          skipSessionWriter: true,
          strictResourceCleanup: true,
        })
        .then(() => {
          shutdownSettled = true;
        });

      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(shutdownSettled).toBe(false);
      expect(stop).not.toHaveBeenCalled();

      releaseInitialization();
      await expect(initialize).resolves.toBeUndefined();
      await expect(shutdown).resolves.toBeUndefined();
      expect(stop).toHaveBeenCalledOnce();
    });

    it('does not let incomplete initialization block best-effort shutdown', async () => {
      const config = new Config(baseParams);
      let releaseInitialization!: () => void;
      const initializationGate = new Promise<void>((resolve) => {
        releaseInitialization = resolve;
      });
      const stop = vi.fn().mockResolvedValue(undefined);
      const internal = config as unknown as {
        initializeInternal: () => Promise<void>;
        toolRegistry: ToolRegistry;
      };
      const initializeInternal = vi
        .spyOn(internal, 'initializeInternal')
        .mockImplementation(async () => {
          await initializationGate;
          internal.toolRegistry = { stop } as unknown as ToolRegistry;
        });

      const initialize = config.initialize();
      await vi.waitFor(() => expect(initializeInternal).toHaveBeenCalledOnce());

      await expect(
        config.shutdown({
          shutdownTelemetry: false,
          skipSessionWriter: true,
        }),
      ).resolves.toBeUndefined();
      expect(stop).not.toHaveBeenCalled();

      releaseInitialization();
      await expect(initialize).resolves.toBeUndefined();
      await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    });

    it('keeps strict shutdown waiting when best-effort shutdown starts first', async () => {
      const config = new Config(baseParams);
      let releaseInitialization!: () => void;
      const initializationGate = new Promise<void>((resolve) => {
        releaseInitialization = resolve;
      });
      const stop = vi.fn().mockResolvedValue(undefined);
      const internal = config as unknown as {
        initializeInternal: () => Promise<void>;
        toolRegistry: ToolRegistry;
      };
      vi.spyOn(internal, 'initializeInternal').mockImplementation(async () => {
        await initializationGate;
        internal.toolRegistry = { stop } as unknown as ToolRegistry;
      });

      const initialize = config.initialize();
      const bestEffortShutdown = config.shutdown({
        shutdownTelemetry: false,
        skipSessionWriter: true,
      });
      let strictShutdownSettled = false;
      const strictShutdown = config
        .shutdown({
          shutdownTelemetry: false,
          skipSessionWriter: true,
          strictResourceCleanup: true,
        })
        .then(() => {
          strictShutdownSettled = true;
        });

      await bestEffortShutdown;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(strictShutdownSettled).toBe(false);

      releaseInitialization();
      await initialize;
      await strictShutdown;
      expect(stop).toHaveBeenCalledOnce();
    });

    it('runs resource cleanup once across concurrent shutdown calls', async () => {
      const config = new Config(baseParams);
      const stop = vi.fn().mockResolvedValue(undefined);
      const internal = config as unknown as {
        initializeInternal: () => Promise<void>;
        toolRegistry: ToolRegistry;
      };
      vi.spyOn(internal, 'initializeInternal').mockImplementation(async () => {
        internal.toolRegistry = { stop } as unknown as ToolRegistry;
      });
      await config.initialize();

      await Promise.all([
        config.shutdown({
          shutdownTelemetry: false,
          skipSessionWriter: true,
        }),
        config.shutdown({
          shutdownTelemetry: false,
          skipSessionWriter: true,
        }),
      ]);

      expect(stop).toHaveBeenCalledOnce();
    });

    it('aborts active workflows during shutdown', async () => {
      const config = new Config(baseParams);
      const stop = vi.fn().mockResolvedValue(undefined);
      const internal = config as unknown as {
        initializeInternal: () => Promise<void>;
        toolRegistry: ToolRegistry;
      };
      vi.spyOn(internal, 'initializeInternal').mockImplementation(async () => {
        internal.toolRegistry = { stop } as unknown as ToolRegistry;
      });
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

      await config.shutdown({
        shutdownTelemetry: false,
        skipSessionWriter: true,
        strictResourceCleanup: true,
      });

      expect(abortController.signal.aborted).toBe(true);
      expect(registry.get('wf_1234')?.status).toBe('cancelled');
    });

    it('allows a later shutdown to retry incomplete resource cleanup', async () => {
      const config = new Config(baseParams);
      const stop = vi
        .fn()
        .mockRejectedValueOnce(new Error('stop failed'))
        .mockResolvedValue(undefined);
      const internal = config as unknown as {
        initializeInternal: () => Promise<void>;
        toolRegistry: ToolRegistry;
      };
      vi.spyOn(internal, 'initializeInternal').mockImplementation(async () => {
        internal.toolRegistry = { stop } as unknown as ToolRegistry;
      });
      await config.initialize();

      await config.shutdown({
        shutdownTelemetry: false,
        skipSessionWriter: true,
      });
      await config.shutdown({
        shutdownTelemetry: false,
        skipSessionWriter: true,
      });

      expect(stop).toHaveBeenCalledTimes(2);
    });

    it('propagates resource cleanup failures in strict mode and allows retry', async () => {
      const config = new Config(baseParams);
      const stop = vi
        .fn()
        .mockRejectedValueOnce(new Error('stop failed'))
        .mockResolvedValue(undefined);
      const internal = config as unknown as {
        initializeInternal: () => Promise<void>;
        toolRegistry: ToolRegistry;
      };
      vi.spyOn(internal, 'initializeInternal').mockImplementation(async () => {
        internal.toolRegistry = { stop } as unknown as ToolRegistry;
      });
      await config.initialize();

      await expect(
        config.shutdown({
          shutdownTelemetry: false,
          skipSessionWriter: true,
          strictResourceCleanup: true,
        }),
      ).rejects.toThrow('stop failed');
      await expect(
        config.shutdown({
          shutdownTelemetry: false,
          skipSessionWriter: true,
          strictResourceCleanup: true,
        }),
      ).resolves.toBeUndefined();

      expect(stop).toHaveBeenCalledTimes(2);
    });

    it('cleans partial resources after initialization fails', async () => {
      const config = new Config(baseParams);
      const initializationError = new Error('late initialization failure');
      const stop = vi.fn().mockResolvedValue(undefined);
      const internal = config as unknown as {
        initializeInternal: () => Promise<void>;
        toolRegistry: ToolRegistry;
      };
      vi.spyOn(internal, 'initializeInternal').mockImplementation(async () => {
        internal.toolRegistry = { stop } as unknown as ToolRegistry;
        throw initializationError;
      });

      const result = await config.initialize().catch((error: unknown) => error);
      await config.shutdown({
        shutdownTelemetry: false,
        skipSessionWriter: true,
      });

      expect(result).toBe(initializationError);
      expect(stop).toHaveBeenCalledOnce();
    });

    it('closes the writer before waiting for incomplete initialization', async () => {
      const config = new Config(baseParams);
      let releaseInitialization!: () => void;
      const initializationGate = new Promise<void>((resolve) => {
        releaseInitialization = resolve;
      });
      const initializeInternal = vi
        .spyOn(
          config as unknown as {
            initializeInternal: () => Promise<void>;
          },
          'initializeInternal',
        )
        .mockImplementation(() => initializationGate);
      const beginClose = vi.fn();
      const close = vi.fn().mockResolvedValue(undefined);
      const finalize = vi.fn();
      const flush = vi.fn().mockResolvedValue(undefined);
      (
        config as unknown as {
          chatRecordingService: {
            beginClose: () => void;
            close: () => Promise<void>;
            finalize: () => void;
            flush: () => Promise<void>;
          };
        }
      ).chatRecordingService = {
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

      releaseInitialization();
      await expect(initialize).resolves.toBeUndefined();
      await expect(shutdown).resolves.toBeUndefined();
    });

    it('rejects initialization after shutdown has started', async () => {
      const config = new Config(baseParams);

      await config.shutdown({
        shutdownTelemetry: false,
        skipSessionWriter: true,
      });

      await expect(config.initialize()).rejects.toThrow(
        'Config is shutting down',
      );
    });

    it('rejects a pre-aborted initialization without consuming the Config', async () => {
      const config = new Config(baseParams);
      const controller = new AbortController();
      const abortReason = new Error('initialization cancelled before start');
      controller.abort(abortReason);

      await expect(
        config.initialize({ signal: controller.signal }),
      ).rejects.toBe(abortReason);

      const initializeInternal = vi
        .spyOn(
          config as unknown as {
            initializeInternal: () => Promise<void>;
          },
          'initializeInternal',
        )
        .mockResolvedValue(undefined);
      await expect(config.initialize()).resolves.toBeUndefined();
      expect(initializeInternal).toHaveBeenCalledOnce();
      await config.shutdown({ shutdownTelemetry: false });
    });

    it('forwards cancellation into Gemini client initialization', async () => {
      const config = new Config(baseParams);
      const controller = new AbortController();
      const abortReason = new Error('initialization deadline exceeded');
      const refreshHierarchicalMemory = vi.spyOn(
        config,
        'refreshHierarchicalMemory',
      );
      let markGeminiEntered!: () => void;
      const geminiEntered = new Promise<void>((resolve) => {
        markGeminiEntered = resolve;
      });
      const geminiInitialize = vi
        .spyOn(config.getGeminiClient(), 'initialize')
        .mockImplementation(async (_source, signal) => {
          expect(signal).toBe(controller.signal);
          markGeminiEntered();
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
      await geminiEntered;
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
      const config = new Config(baseParams);
      vi.spyOn(
        config as unknown as {
          initializeInternal: () => Promise<void>;
        },
        'initializeInternal',
      ).mockResolvedValue(undefined);
      await config.initialize();
      const order: string[] = [];
      (
        config as unknown as {
          chatRecordingService: {
            beginClose: () => void;
            close: () => Promise<void>;
            finalize: () => void;
            flush: () => Promise<void>;
          };
        }
      ).chatRecordingService = {
        beginClose: vi.fn(() => order.push('beginClose')),
        close: vi.fn(async () => {
          order.push('close');
        }),
        finalize: vi.fn(() => order.push('finalize')),
        flush: vi.fn(async () => {
          order.push('flush');
        }),
      };

      await config.shutdown({ shutdownTelemetry: false });

      expect(order).toEqual(['finalize', 'flush', 'beginClose', 'close']);
    });

    it('should throw an error if initialized more than once', async () => {
      const config = new Config({
        ...baseParams,
      });

      await expect(config.initialize()).resolves.toBeUndefined();
      await expect(config.initialize()).rejects.toThrow(
        'Config was already initialized',
      );
    });

    it('should skip implicit startup discovery in bare mode', async () => {
      const extensionRefreshSpy = vi
        .spyOn(ExtensionManager.prototype, 'refreshCache')
        .mockResolvedValue(undefined);

      const config = new Config({
        ...baseParams,
        bareMode: true,
      });

      await expect(config.initialize()).resolves.toBeUndefined();

      expect(extensionRefreshSpy).not.toHaveBeenCalled();
      expect(HookSystem).not.toHaveBeenCalled();
      expect(SkillManager.prototype.startWatching).not.toHaveBeenCalled();
      expect(SkillManager.prototype.refreshCache).toHaveBeenCalledTimes(1);
      expect(ToolRegistry.prototype.discoverAllTools).not.toHaveBeenCalled();
      expect(
        (ToolRegistry.prototype.registerFactory as Mock).mock.calls.map(
          (call) => call[0],
        ),
      ).toEqual([
        ToolNames.READ_FILE,
        ToolNames.EDIT,
        ToolNames.NOTEBOOK_EDIT,
        ToolNames.SHELL,
        ToolNames.GET_GOAL,
        ToolNames.UPDATE_GOAL,
      ]);
    });

    it('should skip hook, skill, and file checkpointing side effects when requested', async () => {
      const config = new Config({
        ...baseParams,
        fileCheckpointingEnabled: true,
      });

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

    it('warms tools strictly by default and leniently when lenientToolWarmup is set', async () => {
      // Regression guard for the read-only transcript-replay path: a Config that
      // skips the SkillManager must warm tools leniently, otherwise warmAll()
      // aborts initialize() when SkillTool's constructor throws.
      const warmAll = vi.mocked(ToolRegistry.prototype.warmAll);

      warmAll.mockClear();
      await new Config({ ...baseParams }).initialize();
      expect(warmAll).toHaveBeenLastCalledWith({ strict: true });

      warmAll.mockClear();
      await new Config({ ...baseParams }).initialize({
        skipSkillManager: true,
        lenientToolWarmup: true,
      });
      expect(warmAll).toHaveBeenLastCalledWith({ strict: false });
    });

    it('defers cwd-sensitive initialization for a provisional workspace', async () => {
      const config = new Config({
        ...baseParams,
        provisionalWorkspace: true,
      });
      const llmClient = vi.mocked(LlmClient).mock.results.at(-1)?.value as
        | { initialize: Mock }
        | undefined;

      await config.initialize();

      expect(config.isProvisionalWorkspace()).toBe(true);
      expect(loadServerHierarchicalMemory).not.toHaveBeenCalled();
      expect(maybeRunAutoSkillCurator).not.toHaveBeenCalled();
      expect(ToolRegistry.prototype.warmAll).not.toHaveBeenCalled();
      expect(llmClient?.initialize).not.toHaveBeenCalled();

      await Promise.all([
        config.activateProvisionalWorkspace(),
        config.activateProvisionalWorkspace(),
      ]);

      expect(llmClient?.initialize).toHaveBeenCalledOnce();
      expect(ToolRegistry.prototype.warmAll).toHaveBeenCalledOnce();
      expect(ToolRegistry.prototype.warmAll).toHaveBeenCalledWith({
        strict: true,
      });
    });

    it('registers loop_wakeup when cron is enabled', async () => {
      const config = new Config({ ...baseParams, cronEnabled: true });
      await config.initialize();

      const registeredNames = (
        ToolRegistry.prototype.registerFactory as Mock
      ).mock.calls.map((call) => call[0]);
      expect(registeredNames).toContain(ToolNames.LOOP_WAKEUP);
    });

    it('does not register loop_wakeup when cron is disabled', async () => {
      const config = new Config({ ...baseParams, cronEnabled: false });
      await config.initialize();

      const registeredNames = (
        ToolRegistry.prototype.registerFactory as Mock
      ).mock.calls.map((call) => call[0]);
      expect(registeredNames).not.toContain(ToolNames.LOOP_WAKEUP);
    });

    it('keeps Agent View opt-in', () => {
      expect(new Config({ ...baseParams }).isAgentViewEnabled()).toBe(false);
      expect(
        new Config({
          ...baseParams,
          agentViewEnabled: true,
        }).isAgentViewEnabled(),
      ).toBe(true);
    });

    it('registers read_mcp_resource so the model can read MCP resources', async () => {
      const config = new Config({ ...baseParams });
      await config.initialize();

      const registeredNames = (
        ToolRegistry.prototype.registerFactory as Mock
      ).mock.calls.map((call) => call[0]);
      expect(registeredNames).toContain(ToolNames.READ_MCP_RESOURCE);
    });

    it.each([
      ['interactive', { interactive: true }],
      ['ACP', { experimentalZedIntegration: true }],
      ['stream-json', { inputFormat: InputFormat.STREAM_JSON }],
    ] as const)(
      'registers user-interaction tools in %s sessions',
      async (_mode, params) => {
        const config = new Config({ ...baseParams, ...params });
        await config.initialize();

        const registeredNames = (
          ToolRegistry.prototype.registerFactory as Mock
        ).mock.calls.map((call) => call[0]);
        expect(registeredNames).toContain(ToolNames.ASK_USER_QUESTION);
        expect(registeredNames).toContain(ToolNames.ENTER_PLAN_MODE);
        expect(registeredNames).toContain(ToolNames.EXIT_PLAN_MODE);
      },
    );

    it('registers ask_user_question but not plan tools in SDK mode with interaction support', async () => {
      // ask_user_question is gated only by the resolved interaction mode, while
      // enter_plan_mode/exit_plan_mode are additionally gated by !sdkMode. Guard
      // this asymmetry so a future symmetric `!this.sdkMode` on the question gate
      // cannot silently drop the tool from SDK-mode interactive sessions.
      const config = new Config({
        ...baseParams,
        interactive: true,
        sdkMode: true,
      });
      await config.initialize();

      const registeredNames = (
        ToolRegistry.prototype.registerFactory as Mock
      ).mock.calls.map((call) => call[0]);
      expect(registeredNames).toContain(ToolNames.ASK_USER_QUESTION);
      expect(registeredNames).not.toContain(ToolNames.ENTER_PLAN_MODE);
      expect(registeredNames).not.toContain(ToolNames.EXIT_PLAN_MODE);
    });

    it('registers propose_goal beside the Goal worker tools in interactive sessions', async () => {
      const config = new Config({ ...baseParams, interactive: true });
      await config.initialize();

      const registeredNames = (
        ToolRegistry.prototype.registerFactory as Mock
      ).mock.calls.map((call) => call[0]);
      expect(registeredNames).toContain(ToolNames.GET_GOAL);
      expect(registeredNames).toContain(ToolNames.UPDATE_GOAL);
      expect(registeredNames).toContain(ToolNames.PROPOSE_GOAL);
    });
    it.each([
      ['ACP', { experimentalZedIntegration: true, interactive: true }],
      [
        'stream-json',
        { inputFormat: InputFormat.STREAM_JSON, interactive: true },
      ],
    ] as const)(
      'does not register propose_goal without a turn-boundary settlement path in %s sessions',
      async (_mode, params) => {
        const config = new Config({ ...baseParams, ...params });
        await config.initialize();

        const registeredNames = (
          ToolRegistry.prototype.registerFactory as Mock
        ).mock.calls.map((call) => call[0]);
        expect(registeredNames).toContain(ToolNames.GET_GOAL);
        expect(registeredNames).toContain(ToolNames.UPDATE_GOAL);
        expect(registeredNames).not.toContain(ToolNames.PROPOSE_GOAL);
      },
    );
    it('does not register propose_goal when goals.modelProposed is disabled', async () => {
      const config = new Config({
        ...baseParams,
        interactive: true,
        modelProposedGoals: 'disabled',
      });
      await config.initialize();

      const registeredNames = (
        ToolRegistry.prototype.registerFactory as Mock
      ).mock.calls.map((call) => call[0]);
      expect(config.getModelProposedGoals()).toBe('disabled');
      expect(registeredNames).toContain(ToolNames.GET_GOAL);
      expect(registeredNames).not.toContain(ToolNames.PROPOSE_GOAL);
    });
    it('does not register propose_goal in plain headless sessions', async () => {
      const config = new Config({
        ...baseParams,
        interactive: false,
        experimentalZedIntegration: false,
        inputFormat: InputFormat.TEXT,
      });
      await config.initialize();

      const registeredNames = (
        ToolRegistry.prototype.registerFactory as Mock
      ).mock.calls.map((call) => call[0]);
      expect(config.getModelProposedGoals()).toBe('alwaysAsk');
      expect(registeredNames).toContain(ToolNames.GET_GOAL);
      expect(registeredNames).not.toContain(ToolNames.PROPOSE_GOAL);
    });
    it('does not register user-interaction tools in plain headless sessions', async () => {
      const config = new Config({
        ...baseParams,
        interactive: false,
        experimentalZedIntegration: false,
        inputFormat: InputFormat.TEXT,
      });
      await config.initialize();

      const registeredNames = (
        ToolRegistry.prototype.registerFactory as Mock
      ).mock.calls.map((call) => call[0]);
      expect(registeredNames).not.toContain(ToolNames.ASK_USER_QUESTION);
      expect(registeredNames).not.toContain(ToolNames.ENTER_PLAN_MODE);
      expect(registeredNames).not.toContain(ToolNames.EXIT_PLAN_MODE);
    });

    it('keeps exit_plan_mode available for plan-required teammate filtering', async () => {
      const config = new Config({
        ...baseParams,
        interactive: false,
        experimentalZedIntegration: false,
        inputFormat: InputFormat.TEXT,
      });
      await config.initialize();
      vi.mocked(ToolRegistry.prototype.registerFactory).mockClear();

      await config.createToolRegistry(undefined, {
        skipDiscovery: true,
        forSubAgent: true,
      });

      const registeredNames = (
        ToolRegistry.prototype.registerFactory as Mock
      ).mock.calls.map((call) => call[0]);
      expect(registeredNames).not.toContain(ToolNames.ASK_USER_QUESTION);
      expect(registeredNames).not.toContain(ToolNames.ENTER_PLAN_MODE);
      expect(registeredNames).toContain(ToolNames.EXIT_PLAN_MODE);
    });

    it('does not register artifact tools when artifacts are disabled', async () => {
      const config = new Config({ ...baseParams, artifactEnabled: false });
      await config.initialize();

      const registeredNames = (
        ToolRegistry.prototype.registerFactory as Mock
      ).mock.calls.map((call) => call[0]);
      expect(registeredNames).not.toContain(ToolNames.ARTIFACT);
      expect(registeredNames).not.toContain(ToolNames.RECORD_ARTIFACT);
    });

    it('registers image_gen when a dual-role model is selected', async () => {
      const baseUrl = 'https://images.example.com/api/v1';
      const config = new Config({
        ...baseParams,
        authType: AuthType.USE_OPENAI,
        model: 'dual-role-model',
        modelProvidersConfig: {
          openai: [
            {
              id: 'dual-role-model',
              baseUrl,
              envKey: 'TEST_IMAGE_GENERATION_KEY',
              supportsImageGeneration: true,
            },
          ],
        },
        imageModel: `openai:dual-role-model\0${baseUrl}`,
      });
      await config.initialize();

      const registeredNames = (
        ToolRegistry.prototype.registerFactory as Mock
      ).mock.calls.map((call) => call[0]);
      expect(registeredNames).toContain(ToolNames.IMAGE_GEN);
      expect(config.getModel()).toBe('dual-role-model');
      expect(config.getImageGenerationConfig()).toEqual({
        model: 'dual-role-model',
        baseUrl,
        apiKeyEnv: 'TEST_IMAGE_GENERATION_KEY',
      });
    });

    it('registers image_gen for a legacy image-and-vision-only route', async () => {
      const baseUrl = 'https://images.example.com/api/v1';
      const config = new Config({
        ...baseParams,
        modelProvidersConfig: {
          openai: [
            {
              id: 'qwen-image-2.0',
              baseUrl,
              envKey: 'TEST_IMAGE_GENERATION_KEY',
              imageOnly: true,
              visionOnly: true,
            },
          ],
        },
        imageModel: `openai:qwen-image-2.0\0${baseUrl}`,
      });
      await config.initialize();

      const registeredNames = (
        ToolRegistry.prototype.registerFactory as Mock
      ).mock.calls.map((call) => call[0]);
      expect(registeredNames).toContain(ToolNames.IMAGE_GEN);
      expect(config.getImageGenerationConfig()).toEqual({
        model: 'qwen-image-2.0',
        baseUrl,
        apiKeyEnv: 'TEST_IMAGE_GENERATION_KEY',
      });
    });

    it('does not register image_gen without an image model selection', async () => {
      const config = new Config({
        ...baseParams,
        modelProvidersConfig: {
          openai: [
            {
              id: 'qwen-image-2.0',
              baseUrl: 'https://images.example.com/api/v1',
              envKey: 'TEST_IMAGE_GENERATION_KEY',
              imageOnly: true,
            },
          ],
        },
      });
      await config.initialize();

      const registeredNames = (
        ToolRegistry.prototype.registerFactory as Mock
      ).mock.calls.map((call) => call[0]);
      expect(registeredNames).not.toContain(ToolNames.IMAGE_GEN);
    });

    it('does not use a protocol default as the image generation endpoint', () => {
      const config = new Config({
        ...baseParams,
        modelProvidersConfig: {
          openai: [
            {
              id: 'qwen-image-2.0',
              envKey: 'TEST_IMAGE_GENERATION_KEY',
              imageOnly: true,
            },
          ],
        },
        imageModel: 'openai:qwen-image-2.0',
      });

      expect(config.getImageGenerationConfig()).toBeUndefined();
    });

    it('rejects a route without image generation capability', () => {
      const baseUrl = 'https://images.example.com/api/v1';
      const config = new Config({
        ...baseParams,
        modelProvidersConfig: {
          openai: [
            {
              id: 'chat-model',
              baseUrl,
              envKey: 'TEST_IMAGE_GENERATION_KEY',
            },
          ],
        },
      });

      expect(
        config.resolveImageGenerationModel(`openai:chat-model\0${baseUrl}`),
      ).toBeUndefined();
    });

    it('resolves a vision-only image generation route with explicit capability', () => {
      const baseUrl = 'https://images.example.com/api/v1';
      const config = new Config({
        ...baseParams,
        modelProvidersConfig: {
          openai: [
            {
              id: 'vision-only-model',
              baseUrl,
              envKey: 'TEST_IMAGE_GENERATION_KEY',
              visionOnly: true,
              supportsImageGeneration: true,
            },
          ],
        },
      });

      expect(
        config.resolveImageGenerationModel(
          `openai:vision-only-model\0${baseUrl}`,
        ),
      ).toEqual({
        model: 'vision-only-model',
        baseUrl,
        apiKeyEnv: 'TEST_IMAGE_GENERATION_KEY',
      });
    });

    it('rejects an image generation route without an environment key', () => {
      const baseUrl = 'https://images.example.com/api/v1';
      const config = new Config({
        ...baseParams,
        modelProvidersConfig: {
          openai: [
            {
              id: 'dual-role-model',
              baseUrl,
              supportsImageGeneration: true,
            },
          ],
        },
      });

      expect(
        config.resolveImageGenerationModel(
          `openai:dual-role-model\0${baseUrl}`,
        ),
      ).toBeUndefined();
    });

    it('rejects an ambiguous image generation route', () => {
      const config = new Config({
        ...baseParams,
        modelProvidersConfig: {
          openai: [
            {
              id: 'dual-role-model',
              baseUrl: 'https://images-a.example.com/api/v1',
              envKey: 'TEST_IMAGE_GENERATION_KEY',
              supportsImageGeneration: true,
            },
            {
              id: 'dual-role-model',
              baseUrl: 'https://images-b.example.com/api/v1',
              envKey: 'TEST_IMAGE_GENERATION_KEY',
              supportsImageGeneration: true,
            },
          ],
        },
      });

      expect(
        config.resolveImageGenerationModel('openai:dual-role-model'),
      ).toBeUndefined();
    });

    it('registers image_gen immediately when the image model changes at runtime', async () => {
      const baseUrl = 'https://images.example.com/api/v1';
      const config = new Config({
        ...baseParams,
        modelProvidersConfig: {
          openai: [
            {
              id: 'qwen-image-2.0',
              baseUrl,
              envKey: 'TEST_IMAGE_GENERATION_KEY',
              imageOnly: true,
            },
          ],
        },
      });
      await config.initialize();
      vi.mocked(ToolRegistry.prototype.registerFactory).mockClear();

      await config.setImageModel(`openai:qwen-image-2.0\0${baseUrl}`);

      expect(ToolRegistry.prototype.registerFactory).toHaveBeenCalledWith(
        ToolNames.IMAGE_GEN,
        expect.any(Function),
      );
      expect(ToolRegistry.prototype.ensureTool).toHaveBeenCalledWith(
        ToolNames.IMAGE_GEN,
      );
    });

    it('does not register image_gen when the permission manager disables it', async () => {
      const baseUrl = 'https://images.example.com/api/v1';
      const config = new Config({
        ...baseParams,
        modelProvidersConfig: {
          openai: [
            {
              id: 'qwen-image-2.0',
              baseUrl,
              envKey: 'TEST_IMAGE_GENERATION_KEY',
              imageOnly: true,
            },
          ],
        },
      });
      await config.initialize();
      vi.mocked(ToolRegistry.prototype.registerFactory).mockClear();
      (
        config as unknown as {
          permissionManager: { isToolEnabled: () => Promise<boolean> };
        }
      ).permissionManager = {
        isToolEnabled: vi.fn().mockResolvedValue(false),
      };

      await config.setImageModel(`openai:qwen-image-2.0\0${baseUrl}`);

      expect(ToolRegistry.prototype.registerFactory).not.toHaveBeenCalledWith(
        ToolNames.IMAGE_GEN,
        expect.any(Function),
      );
    });

    it('registers both artifact tools by default for interactive sessions', async () => {
      const config = new Config({
        ...baseParams,
        interactive: true,
        sdkMode: false,
      });
      await config.initialize();

      const registeredNames = (
        ToolRegistry.prototype.registerFactory as Mock
      ).mock.calls.map((call) => call[0]);
      expect(registeredNames).toContain(ToolNames.ARTIFACT);
      expect(registeredNames).toContain(ToolNames.RECORD_ARTIFACT);
    });

    it('registers display_image only for the main interactive TUI', async () => {
      const interactive = new Config({
        ...baseParams,
        interactive: true,
        sdkMode: false,
      });
      await interactive.initialize();

      const registerToolMock = ToolRegistry.prototype.registerFactory as Mock;
      expect(registerToolMock.mock.calls.map((call) => call[0])).toContain(
        ToolNames.DISPLAY_IMAGE,
      );

      for (const params of [
        { interactive: false, sdkMode: false },
        { interactive: true, sdkMode: true },
        {
          interactive: true,
          sdkMode: false,
          inputFormat: InputFormat.STREAM_JSON,
        },
        {
          interactive: true,
          sdkMode: false,
          accessibility: { screenReader: true },
        },
      ]) {
        registerToolMock.mockClear();
        const config = new Config({ ...baseParams, ...params });
        await config.initialize();
        expect(
          registerToolMock.mock.calls.map((call) => call[0]),
        ).not.toContain(ToolNames.DISPLAY_IMAGE);
      }

      registerToolMock.mockClear();
      await interactive.createToolRegistry(undefined, {
        skipDiscovery: true,
        forSubAgent: true,
      });
      expect(registerToolMock.mock.calls.map((call) => call[0])).not.toContain(
        ToolNames.DISPLAY_IMAGE,
      );
    });

    it('forwards terminal image renderer support to the display tool', async () => {
      const provider = vi.fn().mockResolvedValue({
        available: false,
        reason: 'renderer unavailable',
      });
      const config = new Config({
        ...baseParams,
        terminalImageRenderSupportProvider: provider,
      });

      await expect(config.getTerminalImageRenderSupport()).resolves.toEqual({
        available: false,
        reason: 'renderer unavailable',
      });
      expect(provider).toHaveBeenCalledWith();

      await expect(
        new Config(baseParams).getTerminalImageRenderSupport(),
      ).resolves.toEqual({
        available: false,
        reason: 'No terminal image renderer is configured.',
      });
    });

    it('registers only record_artifact by default for daemon artifact metadata', async () => {
      const config = new Config({
        ...baseParams,
        interactive: false,
        sdkMode: false,
      });
      await config.initialize();

      const registeredNames = (
        ToolRegistry.prototype.registerFactory as Mock
      ).mock.calls.map((call) => call[0]);
      expect(registeredNames).not.toContain(ToolNames.ARTIFACT);
      expect(registeredNames).toContain(ToolNames.RECORD_ARTIFACT);
    });

    it('registers report_findings even in headless sessions — review run depends on it', async () => {
      const config = new Config({
        ...baseParams,
        interactive: false,
        sdkMode: false,
      });
      await config.initialize();

      const registeredNames = (
        ToolRegistry.prototype.registerFactory as Mock
      ).mock.calls.map((call) => call[0]);
      expect(registeredNames).toContain(ToolNames.REPORT_FINDINGS);
    });

    describe('isArtifactEnabled', () => {
      const originalForceEnable = process.env['QWEN_CODE_ENABLE_ARTIFACT'];
      const originalDisable = process.env['QWEN_CODE_DISABLE_ARTIFACT'];

      beforeEach(() => {
        delete process.env['QWEN_CODE_ENABLE_ARTIFACT'];
        delete process.env['QWEN_CODE_DISABLE_ARTIFACT'];
      });

      afterEach(() => {
        if (originalForceEnable === undefined) {
          delete process.env['QWEN_CODE_ENABLE_ARTIFACT'];
        } else {
          process.env['QWEN_CODE_ENABLE_ARTIFACT'] = originalForceEnable;
        }
        if (originalDisable === undefined) {
          delete process.env['QWEN_CODE_DISABLE_ARTIFACT'];
        } else {
          process.env['QWEN_CODE_DISABLE_ARTIFACT'] = originalDisable;
        }
      });

      it('enables metadata recording by default without publishing from daemon sessions', () => {
        const config = new Config(baseParams);
        expect(config.isArtifactEnabled()).toBe(false);
        expect(config.isRecordArtifactEnabled()).toBe(true);
      });

      it('is enabled by default when interactive and not in SDK mode', () => {
        const config = new Config({
          ...baseParams,
          interactive: true,
          sdkMode: false,
        });
        expect(config.isArtifactEnabled()).toBe(true);
      });

      it('honors settings that disable artifacts', () => {
        const config = new Config({
          ...baseParams,
          artifactEnabled: false,
          interactive: true,
          sdkMode: false,
        });
        expect(config.isArtifactEnabled()).toBe(false);
        expect(config.isRecordArtifactEnabled()).toBe(false);
      });

      it('lets QWEN_CODE_DISABLE_ARTIFACT override settings and env enablement', () => {
        process.env['QWEN_CODE_DISABLE_ARTIFACT'] = '1';
        process.env['QWEN_CODE_ENABLE_ARTIFACT'] = '1';

        const config = new Config({
          ...baseParams,
          artifactEnabled: true,
          interactive: true,
          sdkMode: false,
        });

        expect(config.isArtifactEnabled()).toBe(false);
      });

      it('stays disabled in SDK mode even when force-enabled', () => {
        process.env['QWEN_CODE_ENABLE_ARTIFACT'] = '1';

        const config = new Config({
          ...baseParams,
          interactive: true,
          sdkMode: true,
        });

        expect(config.isArtifactEnabled()).toBe(false);
      });

      it('keeps the Artifact tool disabled for daemon CLI env enablement', () => {
        process.env['QWEN_CODE_ENABLE_ARTIFACT'] = '1';

        const config = new Config({
          ...baseParams,
          interactive: false,
          sdkMode: false,
        });

        expect(config.isArtifactEnabled()).toBe(false);
        expect(config.isRecordArtifactEnabled()).toBe(true);
      });

      it('lets daemon sessions record metadata by default without publishing', () => {
        const config = new Config({
          ...baseParams,
          interactive: false,
          sdkMode: false,
        });

        expect(config.isArtifactEnabled()).toBe(false);
        expect(config.isRecordArtifactEnabled()).toBe(true);
      });

      it('lets QWEN_CODE_ENABLE_ARTIFACT force-enable interactive CLI use', () => {
        process.env['QWEN_CODE_ENABLE_ARTIFACT'] = '1';

        const config = new Config({
          ...baseParams,
          artifactEnabled: false,
          interactive: true,
          sdkMode: false,
        });

        expect(config.isArtifactEnabled()).toBe(true);
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
      ] as const;
      const originalEnv: Partial<
        Record<(typeof browserEnvKeys)[number], string>
      > = {};

      beforeEach(() => {
        for (const key of browserEnvKeys) {
          originalEnv[key] = process.env[key];
          delete process.env[key];
        }
        process.env['DISPLAY'] = ':0';
      });

      afterEach(() => {
        for (const key of browserEnvKeys) {
          if (originalEnv[key] === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = originalEnv[key];
          }
        }
      });

      it('auto-opens artifacts by default', () => {
        const config = new Config(baseParams);
        expect(config.shouldAutoOpenArtifact()).toBe(true);
      });

      it('honors artifact.autoOpen=false from settings', () => {
        const config = new Config({
          ...baseParams,
          artifactAutoOpen: false,
        });
        expect(config.shouldAutoOpenArtifact()).toBe(false);
      });

      it('lets QWEN_ARTIFACT_NO_AUTO_OPEN override settings', () => {
        process.env['QWEN_ARTIFACT_NO_AUTO_OPEN'] = '1';
        const config = new Config({
          ...baseParams,
          artifactAutoOpen: true,
        });
        expect(config.shouldAutoOpenArtifact()).toBe(false);
      });

      it('honors global browser launch suppression', () => {
        const config = new Config({
          ...baseParams,
          artifactAutoOpen: true,
          noBrowser: true,
        });
        expect(config.shouldAutoOpenArtifact()).toBe(false);
      });

      it('honors CI browser launch suppression', () => {
        process.env['CI'] = 'true';
        const config = new Config({
          ...baseParams,
          artifactAutoOpen: true,
        });
        expect(config.shouldAutoOpenArtifact()).toBe(false);
      });
    });

    it('skips inline MCP discovery by default (progressive availability)', async () => {
      const config = new Config({ ...baseParams });
      await config.initialize();

      // Default path passes `skipDiscovery: true` to createToolRegistry,
      // so the synchronous tool-registry construction must NOT invoke
      // discoverAllTools. MCP is started in the background instead.
      expect(ToolRegistry.prototype.discoverAllTools).not.toHaveBeenCalled();
    });

    it('honors QWEN_CODE_LEGACY_MCP_BLOCKING=1 by running MCP discovery inline', async () => {
      const originalLegacy = process.env['QWEN_CODE_LEGACY_MCP_BLOCKING'];
      process.env['QWEN_CODE_LEGACY_MCP_BLOCKING'] = '1';
      try {
        const config = new Config({ ...baseParams });
        await config.initialize();

        // Legacy escape hatch must call back into the synchronous discover
        // path the cli relied on prior to PR-A.
        expect(ToolRegistry.prototype.discoverAllTools).toHaveBeenCalledTimes(
          1,
        );
      } finally {
        if (originalLegacy === undefined) {
          delete process.env['QWEN_CODE_LEGACY_MCP_BLOCKING'];
        } else {
          process.env['QWEN_CODE_LEGACY_MCP_BLOCKING'] = originalLegacy;
        }
      }
    });

    it('waitForMcpReady resolves immediately when no MCP discovery was started', async () => {
      // No MCP servers + non-bare + default mode: startMcpDiscoveryInBackground
      // is called but the registry mock returns no manager, so the discovery
      // promise stays undefined and waitForMcpReady is a no-op.
      const config = new Config({ ...baseParams });
      await config.initialize();
      await expect(config.waitForMcpReady()).resolves.toBeUndefined();
    });

    it('getFailedMcpServerNames returns an empty array when no MCP servers are configured', () => {
      // The helper underpins the non-interactive "Warning: MCP server(s)
      // failed to start" emission. Must be a no-op when there's nothing
      // to warn about, otherwise --prompt runs with no MCP config would
      // emit a spurious warning every time.
      const config = new Config({ ...baseParams });
      expect(config.getFailedMcpServerNames()).toEqual([]);
    });

    it('getFailedMcpServerNames skips disabled servers', () => {
      // A user-disabled server is not "failed" — the user explicitly
      // turned it off. Treating it as failed would generate noise on
      // every non-interactive run. Disablement is tracked via
      // `excludedMcpServers` (see `isMcpServerDisabled`).
      const config = new Config({
        ...baseParams,
        mcpServers: { off: new MCPServerConfig() },
        excludedMcpServers: ['off'],
      } as ConfigParameters);
      expect(config.getFailedMcpServerNames()).toEqual([]);
    });

    it('isMcpServerDisabled consults extension preferences only for the contributing extension', () => {
      const config = new Config({
        ...baseParams,
        checkpointing: false,
        // baseParams pins overrideExtensions to []; lift it so the mocked
        // loaded extension is visible to getActiveExtensions().
        overrideExtensions: undefined,
        // A user-configured server that shadows the extension's same-named one.
        mcpServers: { foo: new MCPServerConfig() },
      } as ConfigParameters);
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
      const config = new Config({
        ...baseParams,
        checkpointing: false,
        mcpServers: { pending: new MCPServerConfig() },
        pendingMcpServers: ['pending'],
      } as ConfigParameters);
      expect(config.getFailedMcpServerNames()).toEqual([]);
    });

    it('approveMcpServerForSession drops only the approved pending server', () => {
      const config = new Config({
        ...baseParams,
        checkpointing: false,
        pendingMcpServers: ['a', 'b'],
      } as ConfigParameters);

      config.approveMcpServerForSession('a');

      expect(config.isMcpServerPendingApproval('a')).toBe(false);
      expect(config.isMcpServerPendingApproval('b')).toBe(true);

      config.approveMcpServerForSession('not-pending');
      expect(config.isMcpServerPendingApproval('b')).toBe(true);
    });
  });

  describe('reasoning effort override', () => {
    it('reports a higher-priority DashScope knob that shadows reasoning effort', () => {
      const config = new Config({
        ...baseParams,
      });
      (
        config as unknown as {
          contentGeneratorConfig: ContentGeneratorConfig;
        }
      ).contentGeneratorConfig = {
        model: 'qwen3.8-max',
        authType: AuthType.QWEN_OAUTH,
        reasoning: { effort: 'max' },
        extra_body: { thinking_budget: 4096 },
      };

      expect(config.getReasoningEffortOverride()).toEqual({
        source: 'extra_body',
        field: 'thinking_budget',
      });
    });

    it('does not report an identical static effort or a non-tiered model', () => {
      const config = new Config({
        ...baseParams,
      });
      (
        config as unknown as {
          contentGeneratorConfig: ContentGeneratorConfig;
        }
      ).contentGeneratorConfig = {
        model: 'qwen3.8-max',
        authType: AuthType.QWEN_OAUTH,
        reasoning: { effort: 'max' },
        extra_body: { reasoning_effort: 'max' },
      };
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
      const config = new Config({
        ...baseParams,
      });
      (
        config as unknown as {
          contentGeneratorConfig: ContentGeneratorConfig;
        }
      ).contentGeneratorConfig = {
        model: 'qwen3.8-max',
        authType: AuthType.QWEN_OAUTH,
        reasoning: { effort: 'max' },
        extra_body,
        samplingParams,
      };

      expect(config.getReasoningEffortOverride()).toEqual(expected);
    });

    it('does not report an override for a non-DashScope endpoint', () => {
      const config = new Config({
        ...baseParams,
      });
      (
        config as unknown as {
          contentGeneratorConfig: ContentGeneratorConfig;
        }
      ).contentGeneratorConfig = {
        model: 'qwen3.8-max',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://api.openai.com/v1',
        reasoning: { effort: 'max' },
        samplingParams: { thinking_budget: 2048 },
      };

      expect(config.getReasoningEffortOverride()).toBeUndefined();
    });
  });

  describe('refreshAuth', () => {
    it('should refresh auth and update config', async () => {
      const config = new Config(baseParams);
      const authType = AuthType.USE_GEMINI;
      const mockContentConfig = {
        apiKey: 'test-key',
        model: 'qwen3-coder-plus',
        authType,
      };

      vi.mocked(resolveContentGeneratorConfigWithSources).mockReturnValue({
        config: mockContentConfig as ContentGeneratorConfig,
        sources: {},
      });

      await config.refreshAuth(authType);

      expect(resolveContentGeneratorConfigWithSources).toHaveBeenCalledWith(
        config,
        authType,
        expect.objectContaining({
          model: MODEL,
        }),
        expect.anything(),
        expect.anything(),
      );
      // Verify that contentGeneratorConfig is updated
      expect(config.getContentGeneratorConfig()).toEqual(mockContentConfig);
      expect(LlmClient).toHaveBeenCalledWith(config);
    });

    it('preserves the user reasoning effort across an auth refresh that wipes it', async () => {
      // Regression: the provider sync (applyResolvedModelDefaults) overwrites
      // `reasoning` with the provider preset's undefined value, dropping the
      // user-global effort on every restart. refreshAuth must re-apply it.
      const config = new Config({
        ...baseParams,
        generationConfig: { reasoning: { effort: 'max' } },
      });
      const authType = AuthType.USE_GEMINI;

      // The rebuilt config comes back WITHOUT reasoning (simulating the wipe).
      vi.mocked(resolveContentGeneratorConfigWithSources).mockReturnValue({
        config: {
          apiKey: 'test-key',
          model: 'qwen3-coder-plus',
          authType,
        } as ContentGeneratorConfig,
        sources: {},
      });

      await config.refreshAuth(authType);

      expect(config.getReasoningEffort()).toBe('max');
      expect(config.getContentGeneratorConfig().reasoning).toEqual({
        effort: 'max',
      });
    });

    it('re-applies the reasoning effort on a full-refresh model switch that wiped modelsConfig', async () => {
      // Regression for the model-switch path: switchModel() runs
      // applyResolvedModelDefaults() (which overwrites modelsConfig's
      // `reasoning` with the new model's preset) BEFORE onModelChange ->
      // handleModelChange fires. So by the time the full-refresh path calls
      // refreshAuth, refreshAuth's own capture reads undefined and cannot
      // restore the tier. handleModelChange must re-apply it from the live
      // contentGeneratorConfig captured before the rebuild.
      const config = new Config({
        ...baseParams,
        generationConfig: { reasoning: { effort: 'high' } },
      });
      const authType = AuthType.USE_GEMINI;

      // Initial auth seeds the live config with the effort.
      vi.mocked(resolveContentGeneratorConfigWithSources).mockReturnValue({
        config: {
          apiKey: 'test-key',
          model: 'gemini-a',
          authType,
        } as ContentGeneratorConfig,
        sources: {},
      });
      await config.refreshAuth(authType);
      expect(config.getReasoningEffort()).toBe('high');

      // Simulate switchModel()'s pre-callback wipe of modelsConfig's reasoning.
      const genConfig = (
        config as unknown as {
          modelsConfig: { getGenerationConfig(): { reasoning?: unknown } };
        }
      ).modelsConfig.getGenerationConfig();
      delete genConfig.reasoning;

      // The new model resolves with no reasoning preset (the common case).
      vi.mocked(resolveContentGeneratorConfigWithSources).mockReturnValue({
        config: {
          apiKey: 'test-key',
          model: 'gemini-b',
          authType,
        } as ContentGeneratorConfig,
        sources: {},
      });

      await (
        config as unknown as {
          handleModelChange: (
            authType: AuthType,
            requiresRefresh: boolean,
          ) => Promise<void>;
        }
      ).handleModelChange(authType, true);

      // Effort survives the switch (previously silently dropped to undefined).
      expect(config.getContentGeneratorConfig().model).toBe('gemini-b');
      expect(config.getReasoningEffort()).toBe('high');
    });

    it('should fire auth_success notification hook when hooks are enabled', async () => {
      const mockMessageBus = { request: vi.fn() };
      const config = new Config({
        ...baseParams,
        disableAllHooks: false,
      });
      // Set messageBus using the setter
      config.setMessageBus(mockMessageBus as unknown as MessageBus);

      const authType = AuthType.USE_GEMINI;
      const mockContentConfig = {
        apiKey: 'test-key',
        model: 'qwen3-coder-plus',
        authType,
      };

      vi.mocked(resolveContentGeneratorConfigWithSources).mockReturnValue({
        config: mockContentConfig as ContentGeneratorConfig,
        sources: {},
      });

      await config.refreshAuth(authType);

      // Verify that fireNotificationHook was called with correct parameters
      expect(fireNotificationHook).toHaveBeenCalledWith(
        mockMessageBus,
        `Successfully authenticated with ${authType}`,
        'auth_success',
        'Authentication successful',
      );
    });

    it('should not fire notification hook when hooks are disabled', async () => {
      const config = new Config({
        ...baseParams,
        disableAllHooks: true,
      });
      const authType = AuthType.USE_GEMINI;
      const mockContentConfig = {
        apiKey: 'test-key',
        model: 'qwen3-coder-plus',
        authType,
      };

      vi.mocked(resolveContentGeneratorConfigWithSources).mockReturnValue({
        config: mockContentConfig as ContentGeneratorConfig,
        sources: {},
      });

      // Clear any previous calls
      vi.mocked(fireNotificationHook).mockClear();

      await config.refreshAuth(authType);

      // Verify that fireNotificationHook was not called
      expect(fireNotificationHook).not.toHaveBeenCalled();
    });

    it('should not strip thoughts when switching from Vertex to GenAI', async () => {
      const config = new Config(baseParams);

      vi.mocked(createContentGeneratorConfig).mockImplementation(
        (_: Config, authType: AuthType | undefined) =>
          ({ authType }) as unknown as ContentGeneratorConfig,
      );

      await config.refreshAuth(AuthType.USE_VERTEX_AI);

      await config.refreshAuth(AuthType.USE_GEMINI);
    });
  });

  describe('model switching optimization (QWEN_OAUTH)', () => {
    it('should switch qwen-oauth model in-place without refreshing auth when safe', async () => {
      const config = new Config(baseParams);

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
      vi.mocked(createContentGenerator).mockResolvedValue({
        generateContent: vi.fn(),
        generateContentStream: vi.fn(),
        embedContent: vi.fn(),
      } as unknown as ContentGenerator);

      // Establish initial qwen-oauth content generator config/content generator.
      await config.refreshAuth(AuthType.QWEN_OAUTH);

      // Spy after initial refresh to ensure model switch does not re-trigger refreshAuth.
      const refreshSpy = vi.spyOn(config, 'refreshAuth');
      vi.mocked(resetPreloadedContentGenerator).mockClear();

      await config.switchModel(AuthType.QWEN_OAUTH, 'coder-model');

      expect(config.getModel()).toBe('coder-model');
      expect(refreshSpy).not.toHaveBeenCalled();
      // Called once during initial refreshAuth + once during handleModelChange diffing.
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
      const config = new Config(baseParams);

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
      vi.mocked(createContentGenerator).mockResolvedValue({
        generateContent: vi.fn(),
        generateContentStream: vi.fn(),
        embedContent: vi.fn(),
      } as unknown as ContentGenerator);

      await config.refreshAuth(AuthType.QWEN_OAUTH);

      await config.switchModel(AuthType.QWEN_OAUTH, 'coder-model');
    });

    it('should notify model change listeners after switchModel', async () => {
      const config = new Config(baseParams);

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
      vi.mocked(createContentGenerator).mockResolvedValue({
        generateContent: vi.fn(),
        generateContentStream: vi.fn(),
        embedContent: vi.fn(),
      } as unknown as ContentGenerator);

      await config.refreshAuth(AuthType.QWEN_OAUTH);

      const listener = vi.fn();
      const unsubscribe = config.onModelChange(listener);

      await config.switchModel(AuthType.QWEN_OAUTH, 'coder-model');

      expect(listener).toHaveBeenCalledWith('coder-model');

      unsubscribe();
    });
  });

  describe('getEffectiveInputModalities', () => {
    type MutableConfigInternals = {
      contentGeneratorConfig: ContentGeneratorConfig;
    };

    // Mirrors exactly what fileUtils uses to decide media support, so the file
    // reader's strip decision and the vision-bridge gate can never disagree.
    it('returns the resolved modalities from the content generator config', () => {
      const config = new Config(baseParams);
      const internals = config as unknown as MutableConfigInternals;
      internals.contentGeneratorConfig = {
        model: 'custom-model',
        modalities: { image: true },
      } as ContentGeneratorConfig;

      expect(config.getEffectiveInputModalities()).toEqual({ image: true });
    });

    it('treats a model with no resolved modalities as text-only', () => {
      const config = new Config(baseParams);
      const internals = config as unknown as MutableConfigInternals;
      internals.contentGeneratorConfig = {
        model: 'custom-unknown-model',
      } as ContentGeneratorConfig;

      expect(config.getEffectiveInputModalities()).toEqual({});
    });
  });

  describe('model switching with different credentials (OpenAI)', () => {
    it('returns undefined for bare Qwen OAuth fast models under active OpenAI auth', async () => {
      const config = new Config({
        ...baseParams,
        authType: AuthType.USE_OPENAI,
        model: 'qwen3.7-max',
        fastModel: 'coder-model',
        modelProvidersConfig: {
          [AuthType.USE_OPENAI]: [
            {
              id: 'qwen3.7-max',
              name: 'qwen3.7-max',
              baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
              envKey: 'DASHSCOPE_API_KEY',
            },
          ],
        },
      });

      await config.refreshAuth(AuthType.USE_OPENAI);

      expect(config.getFastModel()).toBeUndefined();
    });

    it('returns an authType-qualified fast model selector', () => {
      const config = new Config({
        ...baseParams,
        authType: AuthType.USE_ANTHROPIC,
        model: 'shared-model',
        fastModel: 'openai:shared-model',
        modelProvidersConfig: {
          [AuthType.USE_OPENAI]: [
            {
              id: 'shared-model',
              name: 'OpenAI shared model',
              baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
              envKey: 'DASHSCOPE_API_KEY',
            },
          ],
          [AuthType.USE_ANTHROPIC]: [
            {
              id: 'shared-model',
              name: 'Anthropic shared model',
              baseUrl: 'https://idealab.alibaba-inc.com/api/anthropic',
              envKey: 'IDEALAB_OPUS_API_KEY',
            },
          ],
        },
      });

      expect(config.getFastModel()).toBe('openai:shared-model');
    });

    it('preserves authType-qualified fast model selectors across auth types', () => {
      const config = new Config({
        ...baseParams,
        authType: AuthType.USE_OPENAI,
        model: 'qwen3.7-max',
        fastModel: 'qwen-oauth:coder-model',
        modelProvidersConfig: {
          [AuthType.USE_OPENAI]: [
            {
              id: 'qwen3.7-max',
              name: 'qwen3.7-max',
              baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
              envKey: 'DASHSCOPE_API_KEY',
            },
          ],
        },
      });

      expect(config.getFastModel()).toBe('qwen-oauth:coder-model');
    });

    it('resolves a bare fast model under the current auth type', async () => {
      const config = new Config({
        ...baseParams,
        authType: AuthType.USE_OPENAI,
        model: 'qwen3.7-max',
        fastModel: 'fast-model',
        modelProvidersConfig: {
          [AuthType.USE_OPENAI]: [
            {
              id: 'qwen3.7-max',
              name: 'qwen3.7-max',
              baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
              envKey: 'DASHSCOPE_API_KEY',
            },
            {
              id: 'fast-model',
              name: 'fast-model',
              baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
              envKey: 'DASHSCOPE_API_KEY',
            },
          ],
        },
      });

      await config.refreshAuth(AuthType.USE_OPENAI);

      expect(config.getFastModel()).toBe('fast-model');
    });

    it('keeps authType-qualified selectors when the auth type matches the current auth type', () => {
      const config = new Config({
        ...baseParams,
        authType: AuthType.USE_OPENAI,
        model: 'gpt-4',
        fastModel: 'openai:deepseek-v4-flash',
        modelProvidersConfig: {
          [AuthType.USE_OPENAI]: [
            {
              id: 'deepseek-v4-flash',
              name: 'deepseek-v4-flash',
              baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
              envKey: 'DASHSCOPE_API_KEY',
            },
          ],
        },
      });

      expect(config.getFastModel()).toBe('openai:deepseek-v4-flash');
    });

    it('accepts runtime fast models for authType-qualified selectors', () => {
      const config = new Config({
        ...baseParams,
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
            {
              id: 'registry-model',
              name: 'Registry Model',
              baseUrl: 'https://api.openai.com/v1',
              envKey: 'OPENAI_API_KEY',
            },
          ],
        },
      });
      config.getModelsConfig().detectAndCaptureRuntimeModel();

      expect(config.getFastModel()).toBe('openai:runtime-fast-model');
    });

    it('returns undefined when no active auth type is available for a bare fast model', () => {
      const config = new Config({
        ...baseParams,
        authType: AuthType.USE_ANTHROPIC,
        model: 'claude-opus-4-7',
        fastModel: 'missing-fast-model',
        modelProvidersConfig: {
          [AuthType.USE_ANTHROPIC]: [
            {
              id: 'claude-opus-4-7',
              name: 'claude-opus-4-7',
              baseUrl: 'https://idealab.alibaba-inc.com/api/anthropic',
              envKey: 'IDEALAB_OPUS_API_KEY',
            },
          ],
        },
      });

      expect(config.getFastModel()).toBeUndefined();
    });

    it('returns undefined when the fast model is not configured for the current auth type', async () => {
      const config = new Config({
        ...baseParams,
        authType: AuthType.USE_ANTHROPIC,
        model: 'claude-opus-4-7',
        fastModel: 'missing-fast-model',
        modelProvidersConfig: {
          [AuthType.USE_ANTHROPIC]: [
            {
              id: 'claude-opus-4-7',
              name: 'claude-opus-4-7',
              baseUrl: 'https://idealab.alibaba-inc.com/api/anthropic',
              envKey: 'IDEALAB_OPUS_API_KEY',
            },
          ],
        },
      });

      await config.refreshAuth(AuthType.USE_ANTHROPIC);

      expect(config.getFastModel()).toBeUndefined();
    });

    it('returns undefined when the fast model selector is malformed', () => {
      const config = new Config({
        ...baseParams,
        authType: AuthType.USE_ANTHROPIC,
        model: 'claude-opus-4-7',
        fastModel: 'openai:',
        modelProvidersConfig: {
          [AuthType.USE_OPENAI]: [
            {
              id: 'deepseek-v4-flash',
              name: 'deepseek-v4-flash',
              baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
              envKey: 'DASHSCOPE_API_KEY',
            },
          ],
        },
      });

      expect(config.getFastModel()).toBeUndefined();
    });

    it('returns undefined when fastModel points back to the fast selector', () => {
      const config = new Config({
        ...baseParams,
        authType: AuthType.USE_ANTHROPIC,
        model: 'claude-opus-4-7',
        fastModel: 'fast',
        modelProvidersConfig: {
          [AuthType.USE_ANTHROPIC]: [
            {
              id: 'claude-opus-4-7',
              name: 'claude-opus-4-7',
              baseUrl: 'https://idealab.alibaba-inc.com/api/anthropic',
              envKey: 'IDEALAB_OPUS_API_KEY',
            },
          ],
        },
      });

      expect(config.getFastModel()).toBeUndefined();
    });

    describe('getCompactionModel', () => {
      it('returns the compaction model when set', async () => {
        const config = new Config({
          ...baseParams,
          authType: AuthType.USE_OPENAI,
          model: 'gpt-4',
          compactionModel: 'compaction-model',
          modelProvidersConfig: {
            [AuthType.USE_OPENAI]: [
              {
                id: 'gpt-4',
                name: 'GPT-4',
                baseUrl: 'https://api.openai.com/v1',
                envKey: 'OPENAI_API_KEY',
              },
              {
                id: 'compaction-model',
                name: 'Compaction Model',
                baseUrl: 'https://api.openai.com/v1',
                envKey: 'OPENAI_API_KEY',
              },
            ],
          },
        });

        await config.refreshAuth(AuthType.USE_OPENAI);

        expect(config.getCompactionModel()).toBe('compaction-model');
      });

      it('resolves an authType-qualified compaction model selector', async () => {
        const config = new Config({
          ...baseParams,
          authType: AuthType.USE_ANTHROPIC,
          model: 'claude-opus-4-7',
          compactionModel: 'openai:compaction-model',
          modelProvidersConfig: {
            [AuthType.USE_OPENAI]: [
              {
                id: 'compaction-model',
                name: 'Compaction Model',
                baseUrl: 'https://api.openai.com/v1',
                envKey: 'OPENAI_API_KEY',
              },
            ],
            [AuthType.USE_ANTHROPIC]: [
              {
                id: 'claude-opus-4-7',
                name: 'claude-opus-4-7',
                baseUrl: 'https://idealab.alibaba-inc.com/api/anthropic',
                envKey: 'IDEALAB_OPUS_API_KEY',
              },
            ],
          },
        });

        await config.refreshAuth(AuthType.USE_ANTHROPIC);

        expect(config.getCompactionModel()).toBe('openai:compaction-model');
      });

      it('falls back to the main model when compactionModel is not set', async () => {
        const config = new Config({
          ...baseParams,
          authType: AuthType.USE_OPENAI,
          model: 'gpt-4',
          fastModel: 'fast-model',
          modelProvidersConfig: {
            [AuthType.USE_OPENAI]: [
              {
                id: 'gpt-4',
                name: 'GPT-4',
                baseUrl: 'https://api.openai.com/v1',
                envKey: 'OPENAI_API_KEY',
              },
              {
                id: 'fast-model',
                name: 'Fast Model',
                baseUrl: 'https://api.openai.com/v1',
                envKey: 'OPENAI_API_KEY',
              },
            ],
          },
        });

        await config.refreshAuth(AuthType.USE_OPENAI);

        // fastModel is intentionally ignored — compaction falls back to main
        expect(config.getCompactionModel()).toBe('gpt-4');
      });

      it('falls back to main model when neither compactionModel nor fastModel is set', () => {
        const config = new Config({
          ...baseParams,
          authType: AuthType.USE_OPENAI,
          model: 'gpt-4',
          modelProvidersConfig: {
            [AuthType.USE_OPENAI]: [
              {
                id: 'gpt-4',
                name: 'GPT-4',
                baseUrl: 'https://api.openai.com/v1',
                envKey: 'OPENAI_API_KEY',
              },
            ],
          },
        });

        expect(config.getCompactionModel()).toBe('gpt-4');
      });

      it('returns undefined when the compaction model is voiceOnly', async () => {
        const config = new Config({
          ...baseParams,
          authType: AuthType.USE_OPENAI,
          model: 'gpt-4',
          compactionModel: 'voice-model',
          modelProvidersConfig: {
            [AuthType.USE_OPENAI]: [
              {
                id: 'gpt-4',
                name: 'GPT-4',
                baseUrl: 'https://api.openai.com/v1',
                envKey: 'OPENAI_API_KEY',
              },
              {
                id: 'voice-model',
                name: 'Voice Model',
                voiceOnly: true,
                baseUrl: 'https://api.openai.com/v1',
                envKey: 'OPENAI_API_KEY',
              },
            ],
          },
        });

        await config.refreshAuth(AuthType.USE_OPENAI);

        expect(config.getCompactionModel()).toBeUndefined();
      });

      it('returns undefined when the compaction model is visionOnly', async () => {
        const config = new Config({
          ...baseParams,
          authType: AuthType.USE_OPENAI,
          model: 'gpt-4',
          compactionModel: 'vision-model',
          modelProvidersConfig: {
            [AuthType.USE_OPENAI]: [
              {
                id: 'gpt-4',
                name: 'GPT-4',
                baseUrl: 'https://api.openai.com/v1',
                envKey: 'OPENAI_API_KEY',
              },
              {
                id: 'vision-model',
                name: 'Vision Model',
                visionOnly: true,
                baseUrl: 'https://api.openai.com/v1',
                envKey: 'OPENAI_API_KEY',
              },
            ],
          },
        });

        await config.refreshAuth(AuthType.USE_OPENAI);

        expect(config.getCompactionModel()).toBeUndefined();
      });

      it('falls back to the main model when the compaction model selector is malformed', async () => {
        const config = new Config({
          ...baseParams,
          authType: AuthType.USE_ANTHROPIC,
          model: 'claude-opus-4-7',
          compactionModel: 'openai:',
          modelProvidersConfig: {
            [AuthType.USE_OPENAI]: [
              {
                id: 'deepseek-v4-flash',
                name: 'deepseek-v4-flash',
                baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
                envKey: 'DASHSCOPE_API_KEY',
              },
            ],
          },
        });

        await config.refreshAuth(AuthType.USE_ANTHROPIC);

        expect(config.getCompactionModel()).toBe('claude-opus-4-7');
      });

      it('returns undefined when the compaction model is not configured for the current auth type', async () => {
        const config = new Config({
          ...baseParams,
          authType: AuthType.USE_ANTHROPIC,
          model: 'claude-opus-4-7',
          compactionModel: 'missing-model',
          modelProvidersConfig: {
            [AuthType.USE_ANTHROPIC]: [
              {
                id: 'claude-opus-4-7',
                name: 'Claude Opus 4',
                baseUrl: 'https://idealab.alibaba-inc.com/api/anthropic',
                envKey: 'IDEALAB_OPUS_API_KEY',
              },
            ],
          },
        });

        await config.refreshAuth(AuthType.USE_ANTHROPIC);

        expect(config.getCompactionModel()).toBeUndefined();
      });
    });

    it('should refresh auth when switching to model with different envKey', async () => {
      // This test verifies the fix for switching between modelProvider models
      // with different envKeys (e.g., deepseek-chat with DEEPSEEK_API_KEY)
      const configWithModelProviders = new Config({
        ...baseParams,
        authType: AuthType.USE_OPENAI,
        modelProvidersConfig: {
          openai: [
            {
              id: 'model-a',
              name: 'Model A',
              baseUrl: 'https://api.example.com/v1',
              envKey: 'API_KEY_A',
            },
            {
              id: 'model-b',
              name: 'Model B',
              baseUrl: 'https://api.example.com/v1',
              envKey: 'API_KEY_B',
            },
          ],
        },
      });

      const mockContentConfigA: ContentGeneratorConfig = {
        authType: AuthType.USE_OPENAI,
        model: 'model-a',
        apiKey: 'key-a',
        baseUrl: 'https://api.example.com/v1',
      } as ContentGeneratorConfig;

      const mockContentConfigB: ContentGeneratorConfig = {
        authType: AuthType.USE_OPENAI,
        model: 'model-b',
        apiKey: 'key-b',
        baseUrl: 'https://api.example.com/v1',
      } as ContentGeneratorConfig;

      vi.mocked(resolveContentGeneratorConfigWithSources).mockImplementation(
        (_config, _authType, generationConfig) => {
          const model = generationConfig?.model;
          return {
            config:
              model === 'model-b' ? mockContentConfigB : mockContentConfigA,
            sources: {},
          };
        },
      );

      vi.mocked(createContentGenerator).mockResolvedValue({
        generateContent: vi.fn(),
        generateContentStream: vi.fn(),
        embedContent: vi.fn(),
      } as unknown as ContentGenerator);

      // Initialize with model-a
      await configWithModelProviders.refreshAuth(AuthType.USE_OPENAI);

      // Spy on refreshAuth to verify it's called when switching to model-b
      const refreshSpy = vi.spyOn(configWithModelProviders, 'refreshAuth');

      // Switch to model-b (different envKey)
      await configWithModelProviders.switchModel(
        AuthType.USE_OPENAI,
        'model-b',
      );

      // Should trigger full refresh because envKey changed
      expect(refreshSpy).toHaveBeenCalledWith(AuthType.USE_OPENAI);
      expect(configWithModelProviders.getModel()).toBe('model-b');
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

  it('Config constructor should enable runtime sleep prevention by default', () => {
    const config = new Config(baseParams);

    expect(config.getPreventSystemSleepEnabled()).toBe(true);
  });

  it('Config constructor should store runtime sleep prevention override', () => {
    const config = new Config({
      ...baseParams,
      preventSystemSleep: false,
    });

    expect(config.getPreventSystemSleepEnabled()).toBe(false);
  });

  it('refreshHierarchicalMemory should build the managed auto-memory prompt when present', async () => {
    const config = new Config(baseParams);

    vi.mocked(loadServerHierarchicalMemory).mockResolvedValue({
      memoryContent: '--- Context from: QWEN.md ---\nProject rules',
      fileCount: 1,
      contextFilePaths: [],
      ruleCount: 0,
      conditionalRules: [],
      projectRoot: '/tmp',
    });
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

  it('refreshHierarchicalMemory seeds the FileReadCache for project and user MEMORY.md indexes', async (ctx) => {
    const originalMemoryBaseDir = process.env['QWEN_CODE_MEMORY_BASE_DIR'];
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'auto-memory-cache-'));
    const projectRoot = path.join(tempDir, 'project');
    const memoryBaseDir = path.join(tempDir, 'memory-base');

    await mkdir(projectRoot, { recursive: true });
    process.env['QWEN_CODE_MEMORY_BASE_DIR'] = memoryBaseDir;
    clearAutoMemoryRootCache();

    const managedIndexPath = getAutoMemoryIndexPath(projectRoot);
    const userIndexPath = getUserAutoMemoryIndexPath();

    await mkdir(path.dirname(managedIndexPath), { recursive: true });
    await mkdir(path.dirname(userIndexPath), { recursive: true });
    await writeFile(managedIndexPath, '# managed memory\n', 'utf-8');
    await writeFile(userIndexPath, '# user memory\n', 'utf-8');

    // FileReadCache keys entries by dev:ino. On volumes where distinct
    // files report the same inode, the two index records collide under one
    // key and the second record overwrites the first's fingerprint, so the
    // managed index would be checked against the user index's stats. The
    // seeding this test pins only makes sense where inode identity is real;
    // skip where the volume cannot provide it.
    const [managedStats, userStats] = await Promise.all([
      stat(managedIndexPath),
      stat(userIndexPath),
    ]);
    if (
      Number(managedStats.ino) === 0 ||
      Number(userStats.ino) === 0 ||
      (managedStats.dev === userStats.dev && managedStats.ino === userStats.ino)
    ) {
      if (originalMemoryBaseDir === undefined) {
        delete process.env['QWEN_CODE_MEMORY_BASE_DIR'];
      } else {
        process.env['QWEN_CODE_MEMORY_BASE_DIR'] = originalMemoryBaseDir;
      }
      clearAutoMemoryRootCache();
      await rm(tempDir, { recursive: true, force: true });
      ctx.skip();
      return;
    }

    try {
      const config = new Config({
        ...baseParams,
        cwd: projectRoot,
        targetDir: projectRoot,
      });

      vi.mocked(loadServerHierarchicalMemory).mockResolvedValueOnce({
        memoryContent: '--- Context from: QWEN.md ---\nProject rules',
        fileCount: 1,
        contextFilePaths: [],
        ruleCount: 0,
        conditionalRules: [],
        projectRoot,
      });
      vi.mocked(readAutoMemoryIndexWithStats).mockResolvedValueOnce({
        content: '# managed memory\n',
        stats: await stat(managedIndexPath),
      });
      vi.mocked(readUserAutoMemoryIndexWithStats).mockResolvedValueOnce({
        content: '# user memory\n',
        stats: await stat(userIndexPath),
      });

      await config.refreshHierarchicalMemory();

      await expect(
        checkPriorRead(
          config.getFileReadCache(),
          managedIndexPath,
          'overwriting',
        ),
      ).resolves.toEqual({ ok: true });
      await expect(
        checkPriorRead(config.getFileReadCache(), userIndexPath, 'overwriting'),
      ).resolves.toEqual({ ok: true });
    } finally {
      if (originalMemoryBaseDir === undefined) {
        delete process.env['QWEN_CODE_MEMORY_BASE_DIR'];
      } else {
        process.env['QWEN_CODE_MEMORY_BASE_DIR'] = originalMemoryBaseDir;
      }
      clearAutoMemoryRootCache();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('refreshHierarchicalMemory records the stats captured with the auto-memory index read', async () => {
    const originalMemoryBaseDir = process.env['QWEN_CODE_MEMORY_BASE_DIR'];
    const tempDir = await mkdtemp(
      path.join(os.tmpdir(), 'auto-memory-cache-race-'),
    );
    const projectRoot = path.join(tempDir, 'project');
    const memoryBaseDir = path.join(tempDir, 'memory-base');

    await mkdir(projectRoot, { recursive: true });
    process.env['QWEN_CODE_MEMORY_BASE_DIR'] = memoryBaseDir;
    clearAutoMemoryRootCache();

    const managedIndexPath = getAutoMemoryIndexPath(projectRoot);

    await mkdir(path.dirname(managedIndexPath), { recursive: true });
    await writeFile(managedIndexPath, '# old managed memory\n', 'utf-8');
    const oldStats = await stat(managedIndexPath);
    await writeFile(
      managedIndexPath,
      '# newer managed memory with extra bytes\n',
      'utf-8',
    );

    try {
      const config = new Config({
        ...baseParams,
        cwd: projectRoot,
        targetDir: projectRoot,
      });

      vi.mocked(loadServerHierarchicalMemory).mockResolvedValueOnce({
        memoryContent: '--- Context from: QWEN.md ---\nProject rules',
        fileCount: 1,
        contextFilePaths: [],
        ruleCount: 0,
        conditionalRules: [],
        projectRoot,
      });
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
      if (originalMemoryBaseDir === undefined) {
        delete process.env['QWEN_CODE_MEMORY_BASE_DIR'];
      } else {
        process.env['QWEN_CODE_MEMORY_BASE_DIR'] = originalMemoryBaseDir;
      }
      clearAutoMemoryRootCache();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('refreshHierarchicalMemory should not load team memory from untrusted workspaces', async () => {
    const config = new Config({ ...baseParams, enableTeamMemory: true });
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(false);
    vi.mocked(loadServerHierarchicalMemory).mockResolvedValue({
      memoryContent: '--- Context from: QWEN.md ---\nProject rules',
      fileCount: 1,
      contextFilePaths: [],
      ruleCount: 0,
      conditionalRules: [],
      projectRoot: '/tmp',
    });
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

  it('refreshHierarchicalMemory must not sync when the team-root safety check rejects', async () => {
    // The indexer THROWS when the team root is a symlink that could redirect the
    // committed index outside the repo. Sync must respect that refusal: it must
    // never git add/commit/push a dir that failed the safety check.
    const prevSync = process.env['QWEN_CODE_MEMORY_TEAM_SYNC'];
    process.env['QWEN_CODE_MEMORY_TEAM_SYNC'] = '1';
    try {
      const config = new Config({
        ...baseParams,
        enableTeamMemory: true,
        enableTeamMemorySync: true,
      });
      vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
      vi.mocked(loadServerHierarchicalMemory).mockResolvedValue({
        memoryContent: '--- Context from: QWEN.md ---\nProject rules',
        fileCount: 1,
        contextFilePaths: [],
        ruleCount: 0,
        conditionalRules: [],
        projectRoot: '/tmp',
      });
      // Mirror the indexer's symlink-escape rejection: a SECURITY failure, which
      // is the only class that blocks sync (see indexer.ts).
      vi.mocked(rebuildTeamAutoMemoryIndex).mockRejectedValueOnce(
        new TeamMemoryRootSecurityError(
          'Refusing to write team memory index: /tmp/.qwen/team-memory is a ' +
            'symlink, which could redirect the committed index outside the repository.',
        ),
      );

      await config.refreshHierarchicalMemory();

      // Gate proof: sync is enabled, yet the security rejection must skip it
      // entirely. Stop treating TeamMemoryRootSecurityError as blocking and this
      // assertion fails.
      expect(rebuildTeamAutoMemoryIndex).toHaveBeenCalledTimes(1);
      expect(syncTeamMemory).not.toHaveBeenCalled();
    } finally {
      if (prevSync === undefined) {
        delete process.env['QWEN_CODE_MEMORY_TEAM_SYNC'];
      } else {
        process.env['QWEN_CODE_MEMORY_TEAM_SYNC'] = prevSync;
      }
    }
  });

  it('still syncs when the team-index rebuild fails for an OPERATIONAL reason', async () => {
    // An EACCES/ENOSPC/EPERM rebuild failure is not a security escape, so it must
    // NOT permanently gate legitimate sync — it self-corrects on the next
    // successful rebuild. Only TeamMemoryRootSecurityError blocks sync.
    const prevSync = process.env['QWEN_CODE_MEMORY_TEAM_SYNC'];
    process.env['QWEN_CODE_MEMORY_TEAM_SYNC'] = '1';
    try {
      const config = new Config({
        ...baseParams,
        enableTeamMemory: true,
        enableTeamMemorySync: true,
      });
      vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
      vi.mocked(loadServerHierarchicalMemory).mockResolvedValue({
        memoryContent: '--- Context from: QWEN.md ---\nProject rules',
        fileCount: 1,
        contextFilePaths: [],
        ruleCount: 0,
        conditionalRules: [],
        projectRoot: '/tmp',
      });
      // A plain Error stands in for an operational IO failure (e.g. EACCES).
      const operationalError = Object.assign(
        new Error('EACCES: permission denied, lstat'),
        {
          code: 'EACCES',
        },
      );
      vi.mocked(rebuildTeamAutoMemoryIndex).mockRejectedValueOnce(
        operationalError,
      );

      await config.refreshHierarchicalMemory();

      // Not security-gated: sync still runs despite the operational failure.
      expect(rebuildTeamAutoMemoryIndex).toHaveBeenCalledTimes(1);
      expect(syncTeamMemory).toHaveBeenCalledTimes(1);
    } finally {
      if (prevSync === undefined) {
        delete process.env['QWEN_CODE_MEMORY_TEAM_SYNC'];
      } else {
        process.env['QWEN_CODE_MEMORY_TEAM_SYNC'] = prevSync;
      }
    }
  });

  it('syncs when the rebuild succeeds and sync is enabled (positive gate)', async () => {
    // Complement to the negative branches: a successful rebuild on a trusted
    // folder with sync enabled MUST call syncTeamMemory. Inverting or removing
    // the sync condition is caught here.
    const prevSync = process.env['QWEN_CODE_MEMORY_TEAM_SYNC'];
    process.env['QWEN_CODE_MEMORY_TEAM_SYNC'] = '1';
    try {
      const config = new Config({
        ...baseParams,
        enableTeamMemory: true,
        enableTeamMemorySync: true,
      });
      vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
      vi.mocked(loadServerHierarchicalMemory).mockResolvedValue({
        memoryContent: '--- Context from: QWEN.md ---\nProject rules',
        fileCount: 1,
        contextFilePaths: [],
        ruleCount: 0,
        conditionalRules: [],
        projectRoot: '/tmp',
      });
      vi.mocked(rebuildTeamAutoMemoryIndex).mockResolvedValueOnce(
        '# Team Memory\n\n- [Shared](shared.md)',
      );

      await config.refreshHierarchicalMemory();

      expect(rebuildTeamAutoMemoryIndex).toHaveBeenCalledTimes(1);
      expect(syncTeamMemory).toHaveBeenCalledTimes(1);
    } finally {
      if (prevSync === undefined) {
        delete process.env['QWEN_CODE_MEMORY_TEAM_SYNC'];
      } else {
        process.env['QWEN_CODE_MEMORY_TEAM_SYNC'] = prevSync;
      }
    }
  });

  it('refreshHierarchicalMemory surfaces a one-time warning when team memory is not git-shareable', async () => {
    const config = new Config({ ...baseParams, enableTeamMemory: true });
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
    vi.mocked(loadServerHierarchicalMemory).mockResolvedValue({
      memoryContent: '--- Context from: QWEN.md ---\nProject rules',
      fileCount: 1,
      contextFilePaths: [],
      ruleCount: 0,
      conditionalRules: [],
      projectRoot: '/tmp',
    });
    vi.mocked(getTeamMemoryShareabilityWarning).mockReturnValue(
      'Team memory is enabled, but /tmp/.qwen/team-memory is git-ignored',
    );

    await config.refreshHierarchicalMemory();
    // A second refresh must not re-emit the warning (latched once per process).
    await config.refreshHierarchicalMemory();

    expect(getTeamMemoryShareabilityWarning).toHaveBeenCalledTimes(1);
    expect(config.getWarnings()).toContainEqual(
      expect.stringContaining('is git-ignored'),
    );
  });

  it('refreshHierarchicalMemory should expose loaded context file paths', async () => {
    const config = new Config(baseParams);

    vi.mocked(loadServerHierarchicalMemory).mockResolvedValue({
      memoryContent: '--- Context from: QWEN.md ---\nProject rules',
      fileCount: 1,
      contextFilePaths: ['QWEN.md'],
      ruleCount: 0,
      conditionalRules: [],
      projectRoot: '/tmp',
    });

    await config.refreshHierarchicalMemory();
    expect(config.getContextFilePaths()).toEqual(['QWEN.md']);

    vi.mocked(loadServerHierarchicalMemory).mockResolvedValue({
      memoryContent: '',
      fileCount: 0,
      contextFilePaths: [],
      ruleCount: 0,
      conditionalRules: [],
      projectRoot: '/tmp',
    });

    await config.refreshHierarchicalMemory();
    expect(config.getContextFilePaths()).toEqual([]);
  });

  it('refreshHierarchicalMemory should include appended auto-memory in the context warning estimate', async () => {
    const config = new Config({
      ...baseParams,
      generationConfig: { contextWindowSize: 1000 },
    });

    vi.mocked(loadServerHierarchicalMemory).mockResolvedValue({
      memoryContent: 'short project rules',
      fileCount: 1,
      contextFilePaths: [],
      ruleCount: 0,
      conditionalRules: [],
      projectRoot: '/tmp',
    });
    vi.mocked(readAutoMemoryIndexWithStats).mockResolvedValueOnce(
      mockAutoMemoryIndexRead(
        '# Managed Auto-Memory Index\n\n' + 'remember this '.repeat(80),
      ),
    );

    await config.refreshHierarchicalMemory();

    expect(config.getWarnings()).toContainEqual(
      expect.stringContaining(
        'Loaded always-on context (QWEN.md context files + auto-memory)',
      ),
    );
  });

  it('refreshHierarchicalMemory should warn when always-loaded context is large for the model window', async () => {
    const config = new Config({
      ...baseParams,
      generationConfig: { contextWindowSize: 1000 },
    });

    vi.mocked(loadServerHierarchicalMemory).mockResolvedValueOnce({
      memoryContent: 'a'.repeat(800),
      fileCount: 1,
      contextFilePaths: [],
      ruleCount: 0,
      conditionalRules: [],
      projectRoot: '/tmp',
    });

    await config.refreshHierarchicalMemory();

    expect(config.getWarnings()).toContainEqual(
      expect.stringContaining(
        'Loaded always-on context (QWEN.md context files + auto-memory)',
      ),
    );
    expect(config.getWarnings()).toContainEqual(
      expect.stringContaining("model's 1,000 token context window"),
    );
    expect(config.getWarnings()).toContainEqual(
      expect.stringContaining('more than 15%'),
    );
  });

  it('getWarnings should include oversized context before initialize refresh runs', () => {
    const config = new Config({
      ...baseParams,
      userMemory: 'a'.repeat(800),
      generationConfig: { contextWindowSize: 1000 },
    });

    expect(config.getWarnings()).toContainEqual(
      expect.stringContaining(
        'Loaded always-on context (QWEN.md context files + auto-memory)',
      ),
    );
  });

  it('getWarnings should use the model token limit when no contextWindowSize is configured', () => {
    const warningThresholdTokens = Math.floor(DEFAULT_TOKEN_LIMIT * 0.15);
    const config = new Config({
      ...baseParams,
      model: 'unknown-model-for-context-warning-test',
      userMemory: 'a'.repeat((warningThresholdTokens + 1) * 4),
    });

    expect(config.getWarnings()).toContainEqual(
      expect.stringContaining(
        `model's ${DEFAULT_TOKEN_LIMIT.toLocaleString()} token context window`,
      ),
    );
  });

  it('refreshHierarchicalMemory should not warn for small always-loaded context', async () => {
    const config = new Config({
      ...baseParams,
      bareMode: true,
      generationConfig: { contextWindowSize: 1000 },
    });

    vi.mocked(loadServerHierarchicalMemory).mockResolvedValueOnce({
      memoryContent: 'short project context',
      fileCount: 1,
      contextFilePaths: [],
      ruleCount: 0,
      conditionalRules: [],
      projectRoot: '/tmp',
    });
    vi.mocked(readAutoMemoryIndexWithStats).mockResolvedValueOnce(null);

    await config.refreshHierarchicalMemory();

    expect(
      config
        .getWarnings()
        .some((warning) =>
          warning.includes(
            'Loaded always-on context (QWEN.md context files + auto-memory)',
          ),
        ),
    ).toBe(false);
  });

  it('relocateWorkingDirectory should update the session working roots', async () => {
    const config = new Config(baseParams);
    const disposeResidentAgents = vi.spyOn(
      config.getBackgroundTaskRegistry(),
      'disposeResidentAgents',
    );
    const newDir = path.resolve('/path/to/other');
    const workspaceContext = config.getWorkspaceContext();
    const directoriesChanged = vi.fn();
    workspaceContext.onDirectoriesChanged(directoriesChanged);
    const chdirSpy = vi.spyOn(process, 'chdir').mockImplementation(() => {
      // Keep the test process in its original directory.
    });
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(newDir);

    await config.relocateWorkingDirectory(newDir);

    expect(chdirSpy).toHaveBeenCalledWith(newDir);
    expect(config.getTargetDir()).toBe(newDir);
    expect(config.getProjectRoot()).toBe(newDir);
    expect(config.getCwd()).toBe(newDir);
    expect(config.getWorkingDir()).toBe(newDir);
    expect(config.getWorkspaceContext()).toBe(workspaceContext);
    expect(config.getWorkspaceContext().getDirectories()[0]).toBe(newDir);
    expect(config.storage.getProjectRoot()).toBe(newDir);
    expect(disposeResidentAgents).toHaveBeenCalledOnce();
    expect(directoriesChanged).toHaveBeenCalled();
    expect(loadServerHierarchicalMemory).toHaveBeenCalledWith(
      newDir,
      expect.any(Array),
      expect.any(Object),
      expect.any(Array),
      expect.any(Boolean),
      expect.any(String),
      expect.any(Array),
      expect.any(Object),
    );

    chdirSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('relocateWorkingDirectory should preserve leased storage for an ACP cwd change', async () => {
    const config = new Config(baseParams);
    const generator = {} as ContentGenerator;
    (
      config as unknown as {
        contentGenerator: ContentGenerator;
      }
    ).contentGenerator = generator;
    const originalStorage = config.storage;
    const originalPersistenceRoot = originalStorage.getProjectRoot();
    const newDir = path.resolve('/path/to/other');
    (
      config as unknown as {
        chatRecordingService: { hasWriteOwnership: () => boolean };
      }
    ).chatRecordingService = { hasWriteOwnership: () => true };

    await expect(
      config.relocateWorkingDirectory(newDir, newDir, {
        skipProcessChdir: true,
        skipArtifactMigration: true,
      }),
    ).resolves.toEqual({});

    expect(config.getTargetDir()).toBe(newDir);
    expect(resetPreloadedContentGenerator).toHaveBeenCalledWith(generator);
    expect(config.storage).toBe(originalStorage);
    expect(config.getSessionService().getProjectRoot()).toBe(
      originalPersistenceRoot,
    );
    await expect(config.relocateWorkingDirectory(newDir)).rejects.toMatchObject(
      {
        errorKind: 'session_writer_unavailable',
      },
    );
  });

  it('relocateWorkingDirectory should carry the session pr-bound callback to the fresh SessionService', async () => {
    // The callback is registered once at session init; relocation resets
    // sessionService, so a later `gh pr create` must still reach it.
    const config = new Config(baseParams);
    const newDir = path.resolve('/path/to/other');
    const seen: Array<{ sessionId: string; number: number }> = [];
    config.getSessionService().setSessionPrBoundCallback((sessionId, pr) => {
      seen.push({ sessionId, number: pr.number });
    });

    await config.relocateWorkingDirectory(newDir, newDir, {
      skipProcessChdir: true,
      skipArtifactMigration: true,
    });

    config
      .getSessionService()
      .emitSessionPrBound('s1', { number: 2, url: 'https://x.y/o/r/pull/2' });

    expect(seen).toEqual([{ sessionId: 's1', number: 2 }]);
  });

  it('relocateWorkingDirectory should recreate cwd-derived file service', async () => {
    const config = new Config(baseParams);
    const newDir = path.resolve('/path/to/other');
    const chdirSpy = vi.spyOn(process, 'chdir').mockImplementation(() => {
      // Keep the test process in its original directory.
    });
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(newDir);
    const fileServiceBefore = config.getFileService();

    await config.relocateWorkingDirectory(newDir);

    expect(config.getFileService()).not.toBe(fileServiceBefore);

    chdirSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('relocateWorkingDirectory should reconcile MCP servers with the new session cwd', async () => {
    const config = new Config({
      ...baseParams,
      mcpServers: { local: { command: 'node', args: ['server.js'] } },
    });
    await config.initialize();
    const manager = (
      config.getToolRegistry() as unknown as {
        __mcpManagerMock: { discoverAllMcpToolsIncremental: Mock };
      }
    ).__mcpManagerMock;
    await config.waitForMcpReady();
    manager.discoverAllMcpToolsIncremental.mockClear();
    const newDir = path.resolve('/path/to/other');
    const chdirSpy = vi.spyOn(process, 'chdir').mockImplementation(() => {
      // Keep the test process in its original directory.
    });
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(newDir);

    await expect(config.relocateWorkingDirectory(newDir)).resolves.toEqual({});

    expect(manager.discoverAllMcpToolsIncremental).toHaveBeenCalledOnce();
    expect(manager.discoverAllMcpToolsIncremental).toHaveBeenCalledWith(config);

    chdirSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('relocateWorkingDirectory should report MCP reconcile failures after moving', async () => {
    const config = new Config({
      ...baseParams,
      mcpServers: { local: { command: 'node' } },
    });
    await config.initialize();
    const manager = (
      config.getToolRegistry() as unknown as {
        __mcpManagerMock: { discoverAllMcpToolsIncremental: Mock };
      }
    ).__mcpManagerMock;
    await config.waitForMcpReady();
    manager.discoverAllMcpToolsIncremental.mockRejectedValueOnce(
      new Error('MCP failed'),
    );
    const newDir = path.resolve('/path/to/other');
    const chdirSpy = vi.spyOn(process, 'chdir').mockImplementation(() => {
      // Keep the test process in its original directory.
    });
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(newDir);

    const result = await config.relocateWorkingDirectory(newDir);

    expect(config.getTargetDir()).toBe(newDir);
    expect(result.mcpRefreshError).toEqual(new Error('MCP failed'));

    chdirSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('relocateWorkingDirectory should continue after recording flush fails', async () => {
    const config = new Config(baseParams);
    const newDir = path.resolve('/path/to/other');
    const finalize = vi.fn();
    const flush = vi.fn().mockRejectedValue(new Error('recording failed'));
    const resetStoragePaths = vi.fn();
    (
      config as unknown as {
        chatRecordingService: {
          finalize: () => void;
          flush: () => Promise<void>;
          resetStoragePaths: () => void;
          hasWriteOwnership: () => boolean;
        };
      }
    ).chatRecordingService = {
      finalize,
      flush,
      resetStoragePaths,
      hasWriteOwnership: () => false,
    };
    const chdirSpy = vi.spyOn(process, 'chdir').mockImplementation(() => {
      // Keep the test process in its original directory.
    });
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(newDir);

    await expect(config.relocateWorkingDirectory(newDir)).resolves.toEqual({});

    expect(finalize).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledOnce();
    expect(resetStoragePaths).toHaveBeenCalledOnce();
    expect(config.getTargetDir()).toBe(newDir);

    chdirSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('relocateWorkingDirectory should move current session artifacts to the new workspace', async () => {
    const config = new Config({ ...baseParams, chatRecording: true });
    const sessionId = config.getSessionId();
    const newDir = path.resolve('/path/to/other');
    const oldStorage = new Storage(config.getTargetDir());
    const newStorage = new Storage(newDir);
    const oldChatsDir = path.join(oldStorage.getProjectDir(), 'chats');
    const newChatsDir = path.join(newStorage.getProjectDir(), 'chats');
    const oldTranscriptPath = path.join(oldChatsDir, `${sessionId}.jsonl`);
    const oldRuntimeStatusPath = path.join(
      oldChatsDir,
      `${sessionId}.runtime.json`,
    );
    const oldWorktreeSessionPath = path.join(
      oldChatsDir,
      `${sessionId}.worktree.json`,
    );
    const oldPrSessionPath = path.join(oldChatsDir, `${sessionId}.pr.json`);
    const newTranscriptPath = path.join(newChatsDir, `${sessionId}.jsonl`);
    const newRuntimeStatusPath = path.join(
      newChatsDir,
      `${sessionId}.runtime.json`,
    );
    const newWorktreeSessionPath = path.join(
      newChatsDir,
      `${sessionId}.worktree.json`,
    );
    const newPrSessionPath = path.join(newChatsDir, `${sessionId}.pr.json`);
    const chdirSpy = vi.spyOn(process, 'chdir').mockImplementation(() => {
      // Keep the test process in its original directory.
    });
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(newDir);
    const existingArtifacts = [
      oldTranscriptPath,
      oldRuntimeStatusPath,
      oldWorktreeSessionPath,
      oldPrSessionPath,
    ];
    vi.mocked(fs.existsSync).mockImplementation((pathToCheck) => {
      const checked = pathToCheck.toString();
      return existingArtifacts.includes(checked) || checked === newDir;
    });

    await config.relocateWorkingDirectory(newDir);

    expect(fs.mkdirSync).toHaveBeenCalledWith(newChatsDir, {
      recursive: true,
    });
    expect(fs.renameSync).toHaveBeenCalledWith(
      oldTranscriptPath,
      newTranscriptPath,
    );
    expect(fs.renameSync).toHaveBeenCalledWith(
      oldRuntimeStatusPath,
      newRuntimeStatusPath,
    );
    expect(fs.renameSync).toHaveBeenCalledWith(
      oldWorktreeSessionPath,
      newWorktreeSessionPath,
    );
    expect(fs.renameSync).toHaveBeenCalledWith(
      oldPrSessionPath,
      newPrSessionPath,
    );
    expect(config.getTranscriptPath()).toBe(newTranscriptPath);

    chdirSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('relocateWorkingDirectory should refresh runtime status after moving session artifacts', async () => {
    const config = new Config(baseParams);
    config.markRuntimeStatusEnabled();
    config.trackSessionRegistration(Promise.resolve(true));
    const sessionId = config.getSessionId();
    const newDir = path.resolve('/path/to/other');
    const oldStorage = new Storage(config.getTargetDir());
    const newStorage = new Storage(newDir);
    const oldRuntimeStatusPath = oldStorage.getRuntimeStatusPath(sessionId);
    const newRuntimeStatusPath = newStorage.getRuntimeStatusPath(sessionId);
    const chdirSpy = vi.spyOn(process, 'chdir').mockImplementation(() => {
      // Keep the test process in its original directory.
    });
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(newDir);
    const writeRuntimeStatusSpy = vi
      .spyOn(runtimeStatus, 'writeRuntimeStatus')
      .mockResolvedValue(newRuntimeStatusPath);
    vi.mocked(fs.existsSync).mockImplementation((pathToCheck) => {
      const checked = pathToCheck.toString();
      return checked === oldRuntimeStatusPath || checked === newDir;
    });

    // The registry patch rides its own chain and `/cd` deliberately does
    // not await it: the patch writes the HOME filesystem, and awaiting
    // it in the flush would hang `/cd` whenever HOME stalls while the
    // project directory is healthy. The settlement log pins the new
    // contract — `/cd` returns first, and `ps` settles a tick later.
    const settled: string[] = [];
    const patchSessionRecordSpy = vi
      .spyOn(sessionRegistry, 'patchSessionRecord')
      .mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        settled.push('patch');
        return true;
      });

    await config.relocateWorkingDirectory(newDir);
    settled.push('relocated');

    expect(fs.renameSync).toHaveBeenCalledWith(
      oldRuntimeStatusPath,
      newRuntimeStatusPath,
    );
    expect(writeRuntimeStatusSpy).toHaveBeenCalledWith(newRuntimeStatusPath, {
      sessionId,
      workDir: newDir,
      qwenVersion: null,
    });
    // The registry's DIRECTORY column is how a user tells two live
    // sessions apart; the switch must reach it (and the directory-derived
    // name) or `qwen sessions ps` keeps showing the folder that was left.
    await vi.waitFor(() => {
      expect(patchSessionRecordSpy).toHaveBeenCalledWith({
        cwd: newDir,
        name: sessionRegistry.deriveSessionName(newDir, sessionId),
      });
      expect(settled).toContain('patch');
    });
    expect(settled[0]).toBe('relocated');

    writeRuntimeStatusSpy.mockRestore();
    patchSessionRecordSpy.mockRestore();
    chdirSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('relocateWorkingDirectory should patch the registry even when the sidecar write failed at startup', async () => {
    // Mirror of the startNewSession divergence pin: registration writes
    // to the global dir, the sidecar to the project's chats/ dir —
    // independent failure domains, so the registered-but-sidecar-off
    // state is reachable and the /cd patch must survive it.
    const config = new Config(baseParams);
    // No markRuntimeStatusEnabled(): models the failed sidecar write.
    config.trackSessionRegistration(Promise.resolve(true));
    const sessionId = config.getSessionId();
    const newDir = path.resolve('/path/to/other');
    const chdirSpy = vi.spyOn(process, 'chdir').mockImplementation(() => {
      // Keep the test process in its original directory.
    });
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(newDir);
    const writeRuntimeStatusSpy = vi
      .spyOn(runtimeStatus, 'writeRuntimeStatus')
      .mockResolvedValue('unused');
    vi.mocked(fs.existsSync).mockImplementation(
      (pathToCheck) => pathToCheck.toString() === newDir,
    );
    const patchSessionRecordSpy = vi
      .spyOn(sessionRegistry, 'patchSessionRecord')
      .mockResolvedValue(true);

    await config.relocateWorkingDirectory(newDir);

    // The patch rides its own fire-and-forget chain; let it settle.
    await vi.waitFor(() =>
      expect(patchSessionRecordSpy).toHaveBeenCalledWith({
        cwd: newDir,
        name: sessionRegistry.deriveSessionName(newDir, sessionId),
      }),
    );
    expect(writeRuntimeStatusSpy).not.toHaveBeenCalled();

    writeRuntimeStatusSpy.mockRestore();
    patchSessionRecordSpy.mockRestore();
    chdirSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('relocateWorkingDirectory should refresh the sidecar even when registration failed', async () => {
    // The opposite divergence: the sidecar write succeeded at startup
    // but registerSession returned false (foreign-identity refusal,
    // unwritable global dir), so only the sidecar gate is armed. A gate
    // regressed to `if (!this.sessionRegistryActive) return;` would silently
    // stop refreshing runtime.json on /cd for these sessions.
    const config = new Config(baseParams);
    config.markRuntimeStatusEnabled();
    // No trackSessionRegistration(): models the failed registration.
    const sessionId = config.getSessionId();
    const newDir = path.resolve('/path/to/other');
    const newStorage = new Storage(newDir);
    const oldStorage = new Storage(config.getTargetDir());
    const oldRuntimeStatusPath = oldStorage.getRuntimeStatusPath(sessionId);
    const newRuntimeStatusPath = newStorage.getRuntimeStatusPath(sessionId);
    const chdirSpy = vi.spyOn(process, 'chdir').mockImplementation(() => {
      // Keep the test process in its original directory.
    });
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(newDir);
    const writeRuntimeStatusSpy = vi
      .spyOn(runtimeStatus, 'writeRuntimeStatus')
      .mockResolvedValue(newRuntimeStatusPath);
    vi.mocked(fs.existsSync).mockImplementation((pathToCheck) => {
      const checked = pathToCheck.toString();
      return checked === oldRuntimeStatusPath || checked === newDir;
    });
    const patchSessionRecordSpy = vi
      .spyOn(sessionRegistry, 'patchSessionRecord')
      .mockResolvedValue(true);

    await config.relocateWorkingDirectory(newDir);

    expect(writeRuntimeStatusSpy).toHaveBeenCalledWith(newRuntimeStatusPath, {
      sessionId,
      workDir: newDir,
      qwenVersion: null,
    });
    expect(patchSessionRecordSpy).not.toHaveBeenCalled();

    writeRuntimeStatusSpy.mockRestore();
    patchSessionRecordSpy.mockRestore();
    chdirSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('startNewSession patches the registry even when the sidecar write rejects', async () => {
    // The sidecar (project-local chats/) and the registry (global dir)
    // are independent failure domains: a sidecar write rejecting on a
    // read-only or full project filesystem mid-session must not skip
    // the registry patch, or `ps` advertises the pre-/clear session id
    // until process exit.
    const config = new Config(baseParams);
    config.markRuntimeStatusEnabled();
    config.trackSessionRegistration(Promise.resolve(true));
    const writeRuntimeStatusSpy = vi
      .spyOn(runtimeStatus, 'writeRuntimeStatus')
      .mockRejectedValue(new Error('read-only project fs'));
    const patchSessionRecordSpy = vi
      .spyOn(sessionRegistry, 'patchSessionRecord')
      .mockResolvedValue(true);

    const newSessionId = config.startNewSession('replacement-session');

    await vi.waitFor(() =>
      expect(patchSessionRecordSpy).toHaveBeenCalledWith({
        sessionId: newSessionId,
        cwd: config.getTargetDir(),
      }),
    );

    writeRuntimeStatusSpy.mockRestore();
    patchSessionRecordSpy.mockRestore();
  });

  it('serializes pending registration, transitions, and unregister', async () => {
    const config = new Config(baseParams);
    let finishRegistration!: (registered: boolean) => void;
    const registration = new Promise<boolean>((resolve) => {
      finishRegistration = resolve;
    });
    let finishPatch!: () => void;
    const patchSessionRecordSpy = vi
      .spyOn(sessionRegistry, 'patchSessionRecord')
      .mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            finishPatch = () => resolve(true);
          }),
      );
    const unregisterSessionSpy = vi
      .spyOn(sessionRegistry, 'unregisterSession')
      .mockResolvedValue(undefined);

    config.trackSessionRegistration(registration);
    const newSessionId = config.startNewSession('replacement-session');
    const cleanup = config.unregisterSessionRegistry();

    expect(patchSessionRecordSpy).not.toHaveBeenCalled();
    expect(unregisterSessionSpy).not.toHaveBeenCalled();

    finishRegistration(true);
    await vi.waitFor(() => {
      expect(patchSessionRecordSpy).toHaveBeenCalledWith({
        sessionId: newSessionId,
        cwd: config.getTargetDir(),
      });
    });
    expect(unregisterSessionSpy).not.toHaveBeenCalled();

    finishPatch();
    await cleanup;
    expect(unregisterSessionSpy).toHaveBeenCalledTimes(1);

    patchSessionRecordSpy.mockRestore();
    unregisterSessionSpy.mockRestore();
  });

  it('serializes the peer inbox address with session transitions', async () => {
    const config = new Config(baseParams);
    config.trackSessionRegistration(Promise.resolve(true));
    await expect(config.whenSessionRegistered()).resolves.toBe(true);

    let finishIpcPatch!: () => void;
    const calls: Array<Record<string, unknown>> = [];
    const patchSessionRecordSpy = vi
      .spyOn(sessionRegistry, 'patchSessionRecord')
      .mockImplementation(async (patch) => {
        calls.push(patch);
        if ('ipcPath' in patch) {
          await new Promise<void>((resolve) => {
            finishIpcPatch = resolve;
          });
        }
        return true;
      });

    const advertise = config.updateSessionRegistryIpcPath('/tmp/peer.sock');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const newSessionId = config.startNewSession('replacement-session');

    await Promise.resolve();
    expect(calls).toEqual([{ ipcPath: '/tmp/peer.sock' }]);

    finishIpcPatch();
    await advertise;
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual({
      sessionId: newSessionId,
      cwd: config.getTargetDir(),
    });

    patchSessionRecordSpy.mockRestore();
  });

  it('retries the peer inbox advertise when the registry patch skips', async () => {
    // The advertise is one-shot: no later /clear or /cd re-asserts
    // ipcPath, so a patch skipped on transient fd pressure must retry
    // itself or the inbox stays undiscoverable until restart.
    const config = new Config(baseParams);
    config.trackSessionRegistration(Promise.resolve(true));
    await expect(config.whenSessionRegistered()).resolves.toBe(true);
    const patchSessionRecordSpy = vi
      .spyOn(sessionRegistry, 'patchSessionRecord')
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    await config.updateSessionRegistryIpcPath('/tmp/peer.sock');

    expect(patchSessionRecordSpy).toHaveBeenCalledTimes(2);
    expect(patchSessionRecordSpy).toHaveBeenCalledWith({
      ipcPath: '/tmp/peer.sock',
    });
    patchSessionRecordSpy.mockRestore();
  });

  it('re-asserts the registry record with the current session id, retrying a skipped patch', async () => {
    // A peer message pinned to an id this process does not hold means the
    // record may be the stale side (a /clear patch skipped under fd
    // pressure); re-asserting is the fix, and it retries like the advertise.
    const config = new Config(baseParams);
    config.trackSessionRegistration(Promise.resolve(true));
    await expect(config.whenSessionRegistered()).resolves.toBe(true);
    const patchSessionRecordSpy = vi
      .spyOn(sessionRegistry, 'patchSessionRecord')
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    await config.reassertSessionRegistryRecord();

    expect(patchSessionRecordSpy).toHaveBeenCalledTimes(2);
    expect(patchSessionRecordSpy).toHaveBeenLastCalledWith({
      sessionId: config.getSessionId(),
      cwd: config.getTargetDir(),
    });
    patchSessionRecordSpy.mockRestore();
  });

  it('bounds the re-assert retry and is a no-op with no registration', async () => {
    const config = new Config(baseParams);
    config.trackSessionRegistration(Promise.resolve(true));
    await expect(config.whenSessionRegistered()).resolves.toBe(true);
    const patchSessionRecordSpy = vi
      .spyOn(sessionRegistry, 'patchSessionRecord')
      .mockResolvedValue(false);
    await expect(
      config.reassertSessionRegistryRecord(),
    ).resolves.toBeUndefined();
    expect(patchSessionRecordSpy).toHaveBeenCalledTimes(3);

    patchSessionRecordSpy.mockClear();
    const unregistered = new Config(baseParams);
    await unregistered.reassertSessionRegistryRecord();
    expect(patchSessionRecordSpy).not.toHaveBeenCalled();
    patchSessionRecordSpy.mockRestore();
  });

  it('retries the /clear session-id patch when the registry skips it', async () => {
    const config = new Config(baseParams);
    config.trackSessionRegistration(Promise.resolve(true));
    await expect(config.whenSessionRegistered()).resolves.toBe(true);
    const patchSessionRecordSpy = vi
      .spyOn(sessionRegistry, 'patchSessionRecord')
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    const before = config.getSessionId();
    config.startNewSession();
    await config.unregisterSessionRegistry();

    expect(config.getSessionId()).not.toBe(before);
    const sessionPatches = patchSessionRecordSpy.mock.calls.filter(
      ([patch]) => 'sessionId' in (patch as object),
    );
    expect(sessionPatches).toHaveLength(2);
    expect(sessionPatches[1]?.[0]).toMatchObject({
      sessionId: config.getSessionId(),
    });
    patchSessionRecordSpy.mockRestore();
  });

  it('carries the inbox token into the record, on the first patch and the retry', async () => {
    // `toMatchObject`/`toEqual` treat { ipcPath } and { ipcPath, ipcToken:
    // undefined } as equal, so the existing one-arg call sites pass whether
    // or not the token is forwarded. Dropping ipcToken from either patch
    // would publish an address peers cannot authenticate to — sends read as
    // 'sent' and are silently dropped — with the whole suite still green.
    const config = new Config(baseParams);
    config.trackSessionRegistration(Promise.resolve(true));
    await expect(config.whenSessionRegistered()).resolves.toBe(true);
    const patchSessionRecordSpy = vi
      .spyOn(sessionRegistry, 'patchSessionRecord')
      // The first patch is skipped, so the retry path carries the token too.
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    await config.updateSessionRegistryIpcPath('/tmp/peer.sock', 'tok-xyz');

    expect(patchSessionRecordSpy).toHaveBeenCalledTimes(2);
    for (const [patch] of patchSessionRecordSpy.mock.calls) {
      expect(patch).toEqual({ ipcPath: '/tmp/peer.sock', ipcToken: 'tok-xyz' });
    }
    patchSessionRecordSpy.mockRestore();
  });

  it('gives up on the peer inbox advertise after a bounded retry', async () => {
    const config = new Config(baseParams);
    config.trackSessionRegistration(Promise.resolve(true));
    await expect(config.whenSessionRegistered()).resolves.toBe(true);
    const patchSessionRecordSpy = vi
      .spyOn(sessionRegistry, 'patchSessionRecord')
      .mockResolvedValue(false);

    await expect(
      config.updateSessionRegistryIpcPath('/tmp/peer.sock'),
    ).resolves.toBeUndefined();

    expect(patchSessionRecordSpy).toHaveBeenCalledTimes(3);
    patchSessionRecordSpy.mockRestore();
  });

  it('does not unregister when initial registration was refused', async () => {
    const config = new Config(baseParams);
    const unregisterSessionSpy = vi
      .spyOn(sessionRegistry, 'unregisterSession')
      .mockResolvedValue(undefined);

    config.trackSessionRegistration(Promise.resolve(false));
    await config.unregisterSessionRegistry();

    expect(unregisterSessionSpy).not.toHaveBeenCalled();
    unregisterSessionSpy.mockRestore();
  });

  it('relocateWorkingDirectory patches the registry even when the sidecar write rejects', async () => {
    // The /cd-side mirror of the /clear pin: a rejecting sidecar write
    // must not skip the directory patch, and its rejection must not
    // surface through relocateWorkingDirectory either.
    const config = new Config(baseParams);
    config.markRuntimeStatusEnabled();
    config.trackSessionRegistration(Promise.resolve(true));
    const sessionId = config.getSessionId();
    const newDir = path.resolve('/path/to/other');
    const chdirSpy = vi.spyOn(process, 'chdir').mockImplementation(() => {
      // Keep the test process in its original directory.
    });
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(newDir);
    const writeRuntimeStatusSpy = vi
      .spyOn(runtimeStatus, 'writeRuntimeStatus')
      .mockRejectedValue(new Error('read-only project fs'));
    vi.mocked(fs.existsSync).mockImplementation(
      (pathToCheck) => pathToCheck.toString() === newDir,
    );
    const patchSessionRecordSpy = vi
      .spyOn(sessionRegistry, 'patchSessionRecord')
      .mockResolvedValue(true);

    await config.relocateWorkingDirectory(newDir);

    await vi.waitFor(() =>
      expect(patchSessionRecordSpy).toHaveBeenCalledWith({
        cwd: newDir,
        name: sessionRegistry.deriveSessionName(newDir, sessionId),
      }),
    );

    writeRuntimeStatusSpy.mockRestore();
    patchSessionRecordSpy.mockRestore();
    chdirSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('relocateWorkingDirectory should reject and roll back when session artifact migration fails', async () => {
    const config = new Config({ ...baseParams, chatRecording: true });
    const disposeResidentAgents = vi.spyOn(
      config.getBackgroundTaskRegistry(),
      'disposeResidentAgents',
    );
    const oldDir = config.getTargetDir();
    const sessionId = config.getSessionId();
    const newDir = path.resolve('/path/to/other');
    const oldStorage = new Storage(oldDir);
    const newStorage = new Storage(newDir);
    const oldChatsDir = path.join(oldStorage.getProjectDir(), 'chats');
    const newChatsDir = path.join(newStorage.getProjectDir(), 'chats');
    const oldTranscriptPath = path.join(oldChatsDir, `${sessionId}.jsonl`);
    const oldRuntimeStatusPath = path.join(
      oldChatsDir,
      `${sessionId}.runtime.json`,
    );
    const newTranscriptPath = path.join(newChatsDir, `${sessionId}.jsonl`);
    const newRuntimeStatusPath = path.join(
      newChatsDir,
      `${sessionId}.runtime.json`,
    );
    const moveError = new Error('move failed');
    const chdirSpy = vi.spyOn(process, 'chdir').mockImplementation(() => {
      // Keep the test process in its original directory.
    });
    const cwdSpy = vi
      .spyOn(process, 'cwd')
      .mockReturnValueOnce(oldDir)
      .mockReturnValue(newDir);
    const existingArtifacts = [oldTranscriptPath, oldRuntimeStatusPath];
    vi.mocked(fs.existsSync).mockImplementation((pathToCheck) => {
      const checked = pathToCheck.toString();
      return existingArtifacts.includes(checked) || checked === newDir;
    });
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (from === oldRuntimeStatusPath && to === newRuntimeStatusPath) {
        throw moveError;
      }
    });

    await expect(config.relocateWorkingDirectory(newDir)).rejects.toThrow(
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
    expect(chdirSpy).toHaveBeenCalledWith(newDir);
    expect(chdirSpy).toHaveBeenCalledWith(oldDir);
    expect(config.getTargetDir()).toBe(oldDir);
    expect(config.storage.getProjectRoot()).toBe(oldDir);
    expect(config.getTranscriptPath()).toBe(oldTranscriptPath);
    expect(disposeResidentAgents).not.toHaveBeenCalled();

    chdirSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('relocateWorkingDirectory should remove a partial EXDEV copy when source cleanup fails', async () => {
    const config = new Config(baseParams);
    const oldDir = config.getTargetDir();
    const sessionId = config.getSessionId();
    const newDir = path.resolve('/path/to/other');
    const oldStorage = new Storage(oldDir);
    const newStorage = new Storage(newDir);
    const oldRuntimeStatusPath = oldStorage.getRuntimeStatusPath(sessionId);
    const newRuntimeStatusPath = newStorage.getRuntimeStatusPath(sessionId);
    const cleanupError = new Error('cleanup failed');
    const exdevError = Object.assign(new Error('cross device'), {
      code: 'EXDEV',
    });
    const chdirSpy = vi.spyOn(process, 'chdir').mockImplementation(() => {
      // Keep the test process in its original directory.
    });
    const cwdSpy = vi
      .spyOn(process, 'cwd')
      .mockReturnValueOnce(oldDir)
      .mockReturnValue(newDir);
    vi.mocked(fs.existsSync).mockImplementation((pathToCheck) => {
      const checked = pathToCheck.toString();
      return checked === oldRuntimeStatusPath || checked === newDir;
    });
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

    await expect(config.relocateWorkingDirectory(newDir)).rejects.toThrow(
      cleanupError,
    );

    expect(fs.copyFileSync).toHaveBeenCalledWith(
      oldRuntimeStatusPath,
      newRuntimeStatusPath,
    );
    expect(fs.unlinkSync).toHaveBeenCalledWith(newRuntimeStatusPath);
    expect(chdirSpy).toHaveBeenCalledWith(oldDir);
    expect(config.getTargetDir()).toBe(oldDir);

    chdirSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('relocateWorkingDirectory should reject and roll back when the final cwd differs from the expected path', async () => {
    const config = new Config(baseParams);
    const oldDir = config.getTargetDir();
    const newDir = path.resolve('/path/to/other');
    const expectedDir = path.resolve('/path/to/confirmed');
    const chdirSpy = vi.spyOn(process, 'chdir').mockImplementation(() => {
      // Keep the test process in its original directory.
    });
    const cwdSpy = vi
      .spyOn(process, 'cwd')
      .mockReturnValueOnce(oldDir)
      .mockReturnValue(newDir);

    await expect(
      config.relocateWorkingDirectory(newDir, expectedDir),
    ).rejects.toThrow(
      `Changed directory to ${newDir}, expected ${expectedDir}.`,
    );

    expect(chdirSpy).toHaveBeenCalledWith(newDir);
    expect(chdirSpy).toHaveBeenCalledWith(oldDir);
    expect(config.getTargetDir()).toBe(oldDir);
    expect(config.storage.getProjectRoot()).toBe(oldDir);

    chdirSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('relocateWorkingDirectory should reject before mutating config when include directories are stale', async () => {
    const staleIncludeDir = path.resolve('/path/to/stale-include');
    const config = new Config({
      ...baseParams,
      includeDirectories: [staleIncludeDir],
    });
    const oldDir = config.getTargetDir();
    const newDir = path.resolve('/path/to/other');
    const chdirSpy = vi.spyOn(process, 'chdir').mockImplementation(() => {
      // Keep the test process in its original directory.
    });
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(oldDir);
    vi.mocked(fs.existsSync).mockImplementation(
      (pathToCheck) => pathToCheck !== staleIncludeDir,
    );

    await expect(config.relocateWorkingDirectory(newDir)).rejects.toThrow(
      `Directory does not exist: ${staleIncludeDir}`,
    );

    expect(chdirSpy).not.toHaveBeenCalled();
    expect(config.getTargetDir()).toBe(oldDir);
    expect(config.storage.getProjectRoot()).toBe(oldDir);
    expect(config.getWorkspaceContext().getDirectories()[0]).toBe(oldDir);

    chdirSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('relocateWorkingDirectory should return memory refresh failures after moving', async () => {
    const config = new Config(baseParams);
    const newDir = path.resolve('/path/to/other');
    const chdirSpy = vi.spyOn(process, 'chdir').mockImplementation(() => {
      // Keep the test process in its original directory.
    });
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(newDir);
    vi.mocked(loadServerHierarchicalMemory).mockRejectedValueOnce(
      new Error('memory failed'),
    );

    const result = await config.relocateWorkingDirectory(newDir);

    expect(config.getTargetDir()).toBe(newDir);
    expect(result.memoryRefreshError).toEqual(new Error('memory failed'));

    chdirSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('relocateWorkingDirectory should report both memory and MCP refresh failures after moving', async () => {
    const config = new Config({
      ...baseParams,
      mcpServers: { local: { command: 'node' } },
    });
    await config.initialize();
    const manager = (
      config.getToolRegistry() as unknown as {
        __mcpManagerMock: { discoverAllMcpToolsIncremental: Mock };
      }
    ).__mcpManagerMock;
    await config.waitForMcpReady();
    manager.discoverAllMcpToolsIncremental.mockRejectedValueOnce(
      new Error('MCP failed'),
    );
    vi.mocked(loadServerHierarchicalMemory).mockRejectedValueOnce(
      new Error('memory failed'),
    );
    const newDir = path.resolve('/path/to/other');
    const chdirSpy = vi.spyOn(process, 'chdir').mockImplementation(() => {
      // Keep the test process in its original directory.
    });
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(newDir);

    const result = await config.relocateWorkingDirectory(newDir);

    expect(config.getTargetDir()).toBe(newDir);
    expect(result.memoryRefreshError).toEqual(new Error('memory failed'));
    expect(result.mcpRefreshError).toEqual(new Error('MCP failed'));

    chdirSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('refreshHierarchicalMemory should include empty memory prompt when no managed auto-memory index exists', async () => {
    const config = new Config(baseParams);

    vi.mocked(loadServerHierarchicalMemory).mockResolvedValue({
      memoryContent: '--- Context from: QWEN.md ---\nProject rules',
      fileCount: 1,
      contextFilePaths: [],
      ruleCount: 0,
      conditionalRules: [],
      projectRoot: '/tmp',
    });
    vi.mocked(readAutoMemoryIndexWithStats).mockResolvedValue(null);

    await config.refreshHierarchicalMemory();

    expect(config.getUserMemory()).toContain('Project rules');
    expect(config.getUserMemory()).not.toContain('# auto memory');
    expect(config.getAutoMemoryPrompt()).toContain('# auto memory');
    expect(config.getAutoMemoryPrompt()).toContain(
      'MEMORY.md is currently empty',
    );
  });

  it('refreshHierarchicalMemory should omit managed auto-memory prompt when disabled', async () => {
    const config = new Config({
      ...baseParams,
      enableManagedAutoMemory: false,
    });

    vi.mocked(loadServerHierarchicalMemory).mockResolvedValue({
      memoryContent: '--- Context from: QWEN.md ---\nProject rules',
      fileCount: 1,
      contextFilePaths: [],
      ruleCount: 0,
      conditionalRules: [],
      projectRoot: '/tmp',
    });
    vi.mocked(readAutoMemoryIndexWithStats).mockResolvedValue(null);

    await config.refreshHierarchicalMemory();

    expect(config.getUserMemory()).toContain('Project rules');
    expect(config.getUserMemory()).not.toContain('# auto memory');
    expect(config.getAutoMemoryPrompt()).toBe('');
    expect(readAutoMemoryIndexWithStats).not.toHaveBeenCalled();
  });

  it('refreshHierarchicalMemory should only use explicit inputs in bare mode', async () => {
    const config = new Config({
      ...baseParams,
      bareMode: true,
    });

    vi.mocked(loadServerHierarchicalMemory).mockResolvedValue({
      memoryContent: '--- Context from: QWEN.md ---\nProject rules',
      fileCount: 1,
      contextFilePaths: [],
      ruleCount: 0,
      conditionalRules: [],
      projectRoot: '/tmp',
    });

    await config.refreshHierarchicalMemory();

    const lastCall = vi.mocked(loadServerHierarchicalMemory).mock.calls.at(-1);
    expect(lastCall?.at(-1)).toMatchObject({ explicitOnly: true });
    expect(lastCall?.[1]).toEqual([]);
    expect(readAutoMemoryIndexWithStats).not.toHaveBeenCalled();
    expect(config.getUserMemory()).toContain('Project rules');
    expect(config.getAutoMemoryPrompt()).toBe('');
  });

  describe('isManagedMemoryAvailable', () => {
    it('returns true when bareMode is false', () => {
      const config = new Config({ ...baseParams, bareMode: false });
      expect(config.isManagedMemoryAvailable()).toBe(true);
    });

    it('returns false when bareMode is true', () => {
      const config = new Config({ ...baseParams, bareMode: true });
      expect(config.isManagedMemoryAvailable()).toBe(false);
    });

    it('returns false when enableManagedAutoMemory is false', () => {
      const config = new Config({
        ...baseParams,
        enableManagedAutoMemory: false,
        bareMode: false,
      });
      expect(config.isManagedMemoryAvailable()).toBe(false);
    });
  });

  it('refreshHierarchicalMemory should exclude implicit cwd from bare include-directories', async () => {
    const explicitDir = '/tmp/explicit';
    const config = new Config({
      ...baseParams,
      bareMode: true,
      includeDirectories: [explicitDir],
      loadMemoryFromIncludeDirectories: true,
    });

    vi.mocked(loadServerHierarchicalMemory).mockResolvedValue({
      memoryContent: '--- Context from: QWEN.md ---\nProject rules',
      fileCount: 1,
      contextFilePaths: [],
      ruleCount: 0,
      conditionalRules: [],
      projectRoot: '/tmp',
    });

    await config.refreshHierarchicalMemory();

    const lastCall = vi.mocked(loadServerHierarchicalMemory).mock.calls.at(-1);
    expect(lastCall?.[1]).toEqual([explicitDir]);
    expect(lastCall?.at(-1)).toMatchObject({ explicitOnly: true });
  });

  it('refreshHierarchicalMemory should fire InstructionsLoaded hooks from memory notifications', async () => {
    const config = new Config(baseParams);
    const fireInstructionsLoadedEvent = vi.fn().mockResolvedValue(undefined);
    const signal = new AbortController().signal;
    config['hookSystem'] = {
      fireInstructionsLoadedEvent,
    } as unknown as HookSystem;

    vi.mocked(loadServerHierarchicalMemory).mockResolvedValue({
      memoryContent: '--- Context from: QWEN.md ---\nProject rules',
      fileCount: 1,
      contextFilePaths: [],
      ruleCount: 0,
      conditionalRules: [],
      projectRoot: '/tmp',
    });

    await config.refreshHierarchicalMemory('session_start', signal);

    const lastCall = vi.mocked(loadServerHierarchicalMemory).mock.calls.at(-1);
    const options = lastCall?.at(-1) as
      | LoadServerHierarchicalMemoryOptions
      | undefined;
    expect(options?.onInstructionsLoaded).toEqual(expect.any(Function));

    await options?.onInstructionsLoaded?.({
      filePath: '/tmp/project/QWEN.md',
      memoryType: 'project',
      loadReason: 'include',
      triggerFilePath: '/tmp/project/AGENTS.md',
      parentFilePath: '/tmp/project/AGENTS.md',
    });

    expect(fireInstructionsLoadedEvent).toHaveBeenCalledWith(
      '/tmp/project/QWEN.md',
      'project',
      'include',
      {
        triggerFilePath: '/tmp/project/AGENTS.md',
        parentFilePath: '/tmp/project/AGENTS.md',
      },
      signal,
    );
  });

  it('Config constructor should call setMemoryFilename with contextFileName if provided', () => {
    const contextFileName = 'CUSTOM_AGENTS.md';
    const paramsWithContextFile: ConfigParameters = {
      ...baseParams,
      contextFileName,
    };
    new Config(paramsWithContextFile);
    expect(mockSetMemoryFilename).toHaveBeenCalledWith(contextFileName);
  });

  it('Config constructor should not call setMemoryFilename if contextFileName is not provided', () => {
    new Config(baseParams); // baseParams does not have contextFileName
    expect(mockSetMemoryFilename).not.toHaveBeenCalled();
  });

  it('should set default file filtering settings when not provided', () => {
    const config = new Config(baseParams);
    expect(config.getFileFilteringRespectGitIgnore()).toBe(true);
    expect(config.getFileFilteringOptions().customIgnoreFiles).toEqual([
      '.agentignore',
      '.aiignore',
    ]);
  });

  it('should set custom file filtering settings when provided', () => {
    const paramsWithFileFiltering: ConfigParameters = {
      ...baseParams,
      fileFiltering: {
        respectGitIgnore: false,
        customIgnoreFiles: ['.cursorignore'],
      },
    };
    const config = new Config(paramsWithFileFiltering);
    expect(config.getFileFilteringRespectGitIgnore()).toBe(false);
    expect(config.getFileFilteringOptions().customIgnoreFiles).toEqual([
      '.cursorignore',
    ]);
    expect(config.getFileService().getQwenIgnoreFileNamesDisplay()).toBe(
      '.qwenignore, .cursorignore',
    );
  });

  it('should initialize WorkspaceContext with includeDirectories', () => {
    const includeDirectories = ['/path/to/dir1', '/path/to/dir2'];
    const paramsWithIncludeDirs: ConfigParameters = {
      ...baseParams,
      includeDirectories,
    };
    const config = new Config(paramsWithIncludeDirs);
    const workspaceContext = config.getWorkspaceContext();
    const directories = workspaceContext.getDirectories();

    // Should include the target directory plus the included directories
    expect(directories).toHaveLength(3);
    expect(directories).toContain(path.resolve(baseParams.targetDir));
    expect(directories).toContain('/path/to/dir1');
    expect(directories).toContain('/path/to/dir2');
  });

  it('Config constructor should set telemetry to true when provided as true', () => {
    const paramsWithTelemetry: ConfigParameters = {
      ...baseParams,
      telemetry: { enabled: true },
    };
    const config = new Config(paramsWithTelemetry);
    expect(config.getTelemetryEnabled()).toBe(true);
    expect(config.isTelemetryInitializationDeferred()).toBe(false);
    expect(initializeTelemetry).toHaveBeenCalledWith(config);
  });

  it('Config constructor should defer telemetry initialization when requested', () => {
    const paramsWithTelemetry: ConfigParameters = {
      ...baseParams,
      telemetry: { enabled: true },
      deferTelemetryInitialization: true,
    };
    const config = new Config(paramsWithTelemetry);

    expect(config.getTelemetryEnabled()).toBe(true);
    expect(config.isTelemetryInitializationDeferred()).toBe(true);
    expect(initializeTelemetry).not.toHaveBeenCalled();
  });

  it('Config shutdown should flush telemetry when SDK is initialized', async () => {
    const paramsWithTelemetry: ConfigParameters = {
      ...baseParams,
      telemetry: { enabled: true },
    };
    vi.mocked(isTelemetrySdkInitialized).mockReturnValue(true);
    const config = new Config(paramsWithTelemetry);

    await config.shutdown();

    expect(shutdownTelemetry).toHaveBeenCalledTimes(1);
  });

  it('Config shutdown should skip telemetry shutdown before SDK initialization', async () => {
    const paramsWithTelemetry: ConfigParameters = {
      ...baseParams,
      telemetry: { enabled: true },
    };
    vi.mocked(isTelemetrySdkInitialized).mockReturnValue(false);
    const config = new Config(paramsWithTelemetry);

    await config.shutdown();

    expect(shutdownTelemetry).not.toHaveBeenCalled();
  });

  it('Config constructor should set telemetry to false when provided as false', () => {
    const paramsWithTelemetry: ConfigParameters = {
      ...baseParams,
      telemetry: { enabled: false },
    };
    const config = new Config(paramsWithTelemetry);
    expect(config.getTelemetryEnabled()).toBe(false);
  });

  it('Config constructor should default telemetry to default value if not provided', () => {
    const paramsWithoutTelemetry: ConfigParameters = { ...baseParams };
    delete paramsWithoutTelemetry.telemetry;
    const config = new Config(paramsWithoutTelemetry);
    expect(config.getTelemetryEnabled()).toBe(TELEMETRY_SETTINGS.enabled);
  });

  it('Config exposes the telemetry user ID', () => {
    const config = new Config({
      ...baseParams,
      telemetry: { enabled: true, userId: '  user-079458  ' },
    });

    expect(config.getTelemetryUserId()).toBe('user-079458');
  });

  it('Config omits the telemetry user ID by default', () => {
    const config = new Config({
      ...baseParams,
      telemetry: { enabled: true },
    });

    expect(config.getTelemetryUserId()).toBeUndefined();
  });

  it('should have a getFileService method that returns FileDiscoveryService', () => {
    const config = new Config(baseParams);
    const fileService = config.getFileService();
    expect(fileService).toBeDefined();
  });

  describe('Usage Statistics', () => {
    it('defaults usage statistics to enabled if not specified', () => {
      const config = new Config({
        ...baseParams,
        usageStatisticsEnabled: undefined,
      });

      expect(config.getUsageStatisticsEnabled()).toBe(true);
    });

    it.each([{ enabled: true }, { enabled: false }])(
      'sets usage statistics based on the provided value (enabled: $enabled)',
      ({ enabled }) => {
        const config = new Config({
          ...baseParams,
          usageStatisticsEnabled: enabled,
        });
        expect(config.getUsageStatisticsEnabled()).toBe(enabled);
      },
    );

    it('logs the session start event', async () => {
      const config = new Config({
        ...baseParams,
        usageStatisticsEnabled: true,
      });
      await config.initialize();

      expect(QwenLogger.prototype.logStartSessionEvent).toHaveBeenCalledOnce();
    });
  });

  describe('GitCoAuthor Settings', () => {
    it('defaults both commit and pr to true when not specified', () => {
      const config = new Config({ ...baseParams, gitCoAuthor: undefined });
      const settings = config.getGitCoAuthor();
      expect(settings.commit).toBe(true);
      expect(settings.pr).toBe(true);
    });

    it('accepts an object with independent commit and pr toggles', () => {
      const config = new Config({
        ...baseParams,
        gitCoAuthor: { commit: true, pr: false },
      });
      const settings = config.getGitCoAuthor();
      expect(settings.commit).toBe(true);
      expect(settings.pr).toBe(false);
    });

    // Legacy shape: before commit and PR attribution were split, this
    // setting was a single boolean. Treat it as governing both toggles so
    // existing users' preferences carry over.
    it.each([true, false])(
      'coerces legacy boolean %s to { commit, pr } with the same value',
      (value) => {
        const config = new Config({ ...baseParams, gitCoAuthor: value });
        const settings = config.getGitCoAuthor();
        expect(settings.commit).toBe(value);
        expect(settings.pr).toBe(value);
      },
    );

    // settings.json is hand-editable; without intent-aware string
    // parsing a hand-edited `{ commit: "false" }` would silently
    // inflate to `commit: true` (the previous "default-to-true on
    // mismatch" policy). Honor common string disable-intent forms
    // and fall through to disabled on genuinely unrecognisable
    // input — safer-by-default than turning attribution on against
    // the user's clear opt-out.
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
        const config = new Config({
          ...baseParams,
          gitCoAuthor: {
            commit: badValue as unknown as boolean,
            pr: badValue as unknown as boolean,
          },
        });
        const settings = config.getGitCoAuthor();
        expect(settings.commit).toBe(expected);
        expect(settings.pr).toBe(expected);
      },
    );

    // A genuinely-absent sub-field still defaults to true (schema default).
    it('defaults absent commit/pr to true', () => {
      const config = new Config({
        ...baseParams,
        gitCoAuthor: {} as { commit?: boolean; pr?: boolean },
      });
      const settings = config.getGitCoAuthor();
      expect(settings.commit).toBe(true);
      expect(settings.pr).toBe(true);
    });
  });

  describe('Telemetry Settings', () => {
    it('should return default telemetry target if not provided', () => {
      const params: ConfigParameters = {
        ...baseParams,
        telemetry: { enabled: true },
      };
      const config = new Config(params);
      expect(config.getTelemetryTarget()).toBe(DEFAULT_TELEMETRY_TARGET);
    });

    it('should return provided OTLP endpoint', () => {
      const endpoint = 'http://custom.otel.collector:4317';
      const params: ConfigParameters = {
        ...baseParams,
        telemetry: { enabled: true, otlpEndpoint: endpoint },
      };
      const config = new Config(params);
      expect(config.getTelemetryOtlpEndpoint()).toBe(endpoint);
    });

    it('should return default OTLP endpoint if not provided', () => {
      const params: ConfigParameters = {
        ...baseParams,
        telemetry: { enabled: true },
      };
      const config = new Config(params);
      expect(config.getTelemetryOtlpEndpoint()).toBe(DEFAULT_OTLP_ENDPOINT);
    });

    it('should return provided logPrompts setting', () => {
      const params: ConfigParameters = {
        ...baseParams,
        telemetry: { enabled: true, logPrompts: false },
      };
      const config = new Config(params);
      expect(config.getTelemetryLogPromptsEnabled()).toBe(false);
    });

    it('should return default logPrompts setting (true) if not provided', () => {
      const params: ConfigParameters = {
        ...baseParams,
        telemetry: { enabled: true },
      };
      const config = new Config(params);
      expect(config.getTelemetryLogPromptsEnabled()).toBe(true);
    });

    it('should return default logPrompts setting (true) if telemetry object is not provided', () => {
      const paramsWithoutTelemetry: ConfigParameters = { ...baseParams };
      delete paramsWithoutTelemetry.telemetry;
      const config = new Config(paramsWithoutTelemetry);
      expect(config.getTelemetryLogPromptsEnabled()).toBe(true);
    });

    it('should return provided includeSensitiveSpanAttributes setting', () => {
      const params: ConfigParameters = {
        ...baseParams,
        telemetry: { enabled: true, includeSensitiveSpanAttributes: true },
      };
      const config = new Config(params);
      expect(config.getTelemetryIncludeSensitiveSpanAttributes()).toBe(true);
    });

    it('should default includeSensitiveSpanAttributes to false', () => {
      const configWithTelemetry = new Config({
        ...baseParams,
        telemetry: { enabled: true },
      });
      expect(
        configWithTelemetry.getTelemetryIncludeSensitiveSpanAttributes(),
      ).toBe(false);

      const paramsWithoutTelemetry: ConfigParameters = { ...baseParams };
      delete paramsWithoutTelemetry.telemetry;
      const configWithoutTelemetry = new Config(paramsWithoutTelemetry);
      expect(
        configWithoutTelemetry.getTelemetryIncludeSensitiveSpanAttributes(),
      ).toBe(false);
    });

    it('should return provided sensitiveSpanAttributeMaxLength setting', () => {
      const params: ConfigParameters = {
        ...baseParams,
        telemetry: {
          enabled: true,
          sensitiveSpanAttributeMaxLength: 65_536,
        },
      };
      const config = new Config(params);
      expect(config.getTelemetrySensitiveSpanAttributeMaxLength()).toBe(65_536);
    });

    it('should default sensitiveSpanAttributeMaxLength to 1MiB', () => {
      const configWithTelemetry = new Config({
        ...baseParams,
        telemetry: { enabled: true },
      });
      expect(
        configWithTelemetry.getTelemetrySensitiveSpanAttributeMaxLength(),
      ).toBe(1024 * 1024);

      const paramsWithoutTelemetry: ConfigParameters = { ...baseParams };
      delete paramsWithoutTelemetry.telemetry;
      const configWithoutTelemetry = new Config(paramsWithoutTelemetry);
      expect(
        configWithoutTelemetry.getTelemetrySensitiveSpanAttributeMaxLength(),
      ).toBe(1024 * 1024);
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
        expect(
          () =>
            new Config({
              ...baseParams,
              telemetry: {
                enabled: true,
                sensitiveSpanAttributeMaxLength: value,
              },
            }),
        ).toThrow(
          new RegExp(
            `Invalid telemetry\\.sensitiveSpanAttributeMaxLength.*got ${label}`,
          ),
        );
      }
    });

    it('should return default telemetry target if telemetry object is not provided', () => {
      const paramsWithoutTelemetry: ConfigParameters = { ...baseParams };
      delete paramsWithoutTelemetry.telemetry;
      const config = new Config(paramsWithoutTelemetry);
      expect(config.getTelemetryTarget()).toBe(DEFAULT_TELEMETRY_TARGET);
    });

    it('should return default OTLP endpoint if telemetry object is not provided', () => {
      const paramsWithoutTelemetry: ConfigParameters = { ...baseParams };
      delete paramsWithoutTelemetry.telemetry;
      const config = new Config(paramsWithoutTelemetry);
      expect(config.getTelemetryOtlpEndpoint()).toBe(DEFAULT_OTLP_ENDPOINT);
    });

    it('should return provided OTLP protocol', () => {
      const params: ConfigParameters = {
        ...baseParams,
        telemetry: { enabled: true, otlpProtocol: 'http' },
      };
      const config = new Config(params);
      expect(config.getTelemetryOtlpProtocol()).toBe('http');
    });

    it('should return default OTLP protocol if not provided', () => {
      const params: ConfigParameters = {
        ...baseParams,
        telemetry: { enabled: true },
      };
      const config = new Config(params);
      expect(config.getTelemetryOtlpProtocol()).toBe('grpc');
    });

    it('should return default OTLP protocol if telemetry object is not provided', () => {
      const paramsWithoutTelemetry: ConfigParameters = { ...baseParams };
      delete paramsWithoutTelemetry.telemetry;
      const config = new Config(paramsWithoutTelemetry);
      expect(config.getTelemetryOtlpProtocol()).toBe('grpc');
    });
  });

  describe('Per-Signal OTLP Endpoint Configuration', () => {
    it('should return per-signal endpoints when provided', () => {
      const params: ConfigParameters = {
        ...baseParams,
        telemetry: {
          enabled: true,
          otlpTracesEndpoint: 'http://traces:4318/v1/traces',
          otlpLogsEndpoint: 'http://logs:4318/v1/logs',
          otlpMetricsEndpoint: 'http://metrics:4318/v1/metrics',
        },
      };
      const config = new Config(params);
      expect(config.getTelemetryOtlpTracesEndpoint()).toBe(
        'http://traces:4318/v1/traces',
      );
      expect(config.getTelemetryOtlpLogsEndpoint()).toBe(
        'http://logs:4318/v1/logs',
      );
      expect(config.getTelemetryOtlpMetricsEndpoint()).toBe(
        'http://metrics:4318/v1/metrics',
      );
    });

    it('should return undefined when per-signal endpoints are not provided', () => {
      const params: ConfigParameters = {
        ...baseParams,
        telemetry: { enabled: true },
      };
      const config = new Config(params);
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
        const config = new Config({ ...baseParams, outboundCorrelation });
        expect(config.getOutboundCorrelationPropagateTraceContext()).toBe(
          expected,
        );
      },
    );
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

  describe('UseBuiltinRipgrep Configuration', () => {
    it('should default useBuiltinRipgrep to true when not provided', () => {
      const config = new Config(baseParams);
      expect(config.getUseBuiltinRipgrep()).toBe(true);
    });

    it('should set useBuiltinRipgrep to false when provided as false', () => {
      const paramsWithBuiltinRipgrep: ConfigParameters = {
        ...baseParams,
        useBuiltinRipgrep: false,
      };
      const config = new Config(paramsWithBuiltinRipgrep);
      expect(config.getUseBuiltinRipgrep()).toBe(false);
    });

    it('should set useBuiltinRipgrep to true when explicitly provided as true', () => {
      const paramsWithBuiltinRipgrep: ConfigParameters = {
        ...baseParams,
        useBuiltinRipgrep: true,
      };
      const config = new Config(paramsWithBuiltinRipgrep);
      expect(config.getUseBuiltinRipgrep()).toBe(true);
    });

    it('should default useBuiltinRipgrep to true when undefined', () => {
      const paramsWithUndefinedBuiltinRipgrep: ConfigParameters = {
        ...baseParams,
        useBuiltinRipgrep: undefined,
      };
      const config = new Config(paramsWithUndefinedBuiltinRipgrep);
      expect(config.getUseBuiltinRipgrep()).toBe(true);
    });
  });

  describe('Response tokens/sec display configuration', () => {
    it('should default to false when not provided', () => {
      const config = new Config(baseParams);
      expect(config.getShowResponseTokensPerSecond()).toBe(false);
    });

    it('should set showResponseTokensPerSecond when provided as true', () => {
      const config = new Config({
        ...baseParams,
        showResponseTokensPerSecond: true,
      });
      expect(config.getShowResponseTokensPerSecond()).toBe(true);
    });
  });

  describe('createToolRegistry', () => {
    it('registers zoom_image unconditionally so it survives model switches', async () => {
      const config = new Config(baseParams);
      // A first-run / text-only session reports no image modality, yet the tool
      // must still register: the gate moved to execute time so a hot /model
      // switch to an image model picks it up without re-running initialize().
      vi.spyOn(config, 'getEffectiveInputModalities').mockReturnValue({});

      await config.initialize();

      const registerToolMock = (
        (await vi.importMock('../tools/tool-registry')) as {
          ToolRegistry: { prototype: { registerFactory: Mock } };
        }
      ).ToolRegistry.prototype.registerFactory;
      expect(
        (registerToolMock as Mock).mock.calls.map((call) => call[0]),
      ).toContain(ToolNames.ZOOM_IMAGE);
    });

    it('does not register create_sub_session without a wired spawner', async () => {
      // The tool only works under `qwen serve`, where the ACP session wires a
      // spawner. Declaring it in every session used to pollute the action space
      // of interactive/headless runs with a tool that can never succeed there.
      const config = new Config(baseParams);
      await config.initialize();

      const { registerFactory, registerTool } = (
        (await vi.importMock('../tools/tool-registry')) as {
          ToolRegistry: {
            prototype: { registerFactory: Mock; registerTool: Mock };
          };
        }
      ).ToolRegistry.prototype;
      // Both entry points: a regression that re-adds the tool eagerly via
      // `registry.registerTool(new CreateSubSessionTool(this))` never touches
      // `registerFactory`.
      expect(registerFactory.mock.calls.map((call) => call[0])).not.toContain(
        ToolNames.CREATE_SUB_SESSION,
      );
      expect(
        registerTool.mock.calls.map((call) => call[0]?.name),
      ).not.toContain(ToolNames.CREATE_SUB_SESSION);
    });

    it('registers create_sub_session on a subagent registry rebuilt after the spawner is wired', async () => {
      // The daemon ACP session wires the spawner only after its own registry
      // exists, so a subagent registry rebuilt later must pick the tool up here
      // — `copyDiscoveredToolsFrom` never carries built-ins. The rebuild runs on
      // an `Object.create(base)` override, which reaches the spawner through
      // prototype delegation.
      const config = new Config(baseParams);
      await config.initialize();

      const registerFactory = (
        (await vi.importMock('../tools/tool-registry')) as {
          ToolRegistry: { prototype: { registerFactory: Mock } };
        }
      ).ToolRegistry.prototype.registerFactory;
      expect(registerFactory.mock.calls.map((call) => call[0])).not.toContain(
        ToolNames.CREATE_SUB_SESSION,
      );

      config.setSubSessionSpawner(async () => ({ sessionId: 'sub' }));
      registerFactory.mockClear();
      const override = Object.create(config) as Config;
      await override.createToolRegistry(undefined, {
        skipDiscovery: true,
        forSubAgent: true,
      });

      expect(registerFactory.mock.calls.map((call) => call[0])).toContain(
        ToolNames.CREATE_SUB_SESSION,
      );
    });

    it('does not register list_directory by default (opt-in tool)', async () => {
      const config = new Config(baseParams);
      await config.initialize();

      const registerToolMock = (
        (await vi.importMock('../tools/tool-registry')) as {
          ToolRegistry: { prototype: { registerFactory: Mock } };
        }
      ).ToolRegistry.prototype.registerFactory;
      expect(
        (registerToolMock as Mock).mock.calls.map((call) => call[0]),
      ).not.toContain(ToolNames.LS);
    });

    it('registers list_directory when lsToolEnabled is true', async () => {
      const config = new Config({ ...baseParams, lsToolEnabled: true });
      await config.initialize();

      const registerToolMock = (
        (await vi.importMock('../tools/tool-registry')) as {
          ToolRegistry: { prototype: { registerFactory: Mock } };
        }
      ).ToolRegistry.prototype.registerFactory;
      expect(
        (registerToolMock as Mock).mock.calls.map((call) => call[0]),
      ).toContain(ToolNames.LS);
    });

    it.each([
      { label: 'the canonical name', entry: ToolNames.LS },
      { label: 'an alias', entry: 'ListFiles' },
      { label: 'a path specifier', entry: `${ToolNames.LS}(/src)` },
    ])(
      'registers list_directory when listed in coreTools via $label',
      async ({ entry }) => {
        const config = new Config({
          ...baseParams,
          coreTools: [ToolNames.READ_FILE, entry],
        });
        await config.initialize();

        const registerToolMock = (
          (await vi.importMock('../tools/tool-registry')) as {
            ToolRegistry: { prototype: { registerFactory: Mock } };
          }
        ).ToolRegistry.prototype.registerFactory;
        expect(
          (registerToolMock as Mock).mock.calls.map((call) => call[0]),
        ).toContain(ToolNames.LS);
      },
    );

    it('does not register list_directory just because a permission rule covers it (#10075)', async () => {
      // Pins the reverted #9829 side effect: `permissions.allow` / `ask`
      // used to opt this tool in at registration. They are pure
      // auto-approval now, so the opt-in gate must stay closed and only
      // `tools.listDirectory.enabled` or `coreTools` can open it.
      const config = new Config({
        ...baseParams,
        coreTools: undefined,
        permissions: { allow: ['ListFiles'], ask: ['ListFiles'] },
      });
      await config.initialize();

      const registerToolMock = (
        (await vi.importMock('../tools/tool-registry')) as {
          ToolRegistry: { prototype: { registerFactory: Mock } };
        }
      ).ToolRegistry.prototype.registerFactory;
      expect(
        (registerToolMock as Mock).mock.calls.map((call) => call[0]),
      ).not.toContain(ToolNames.LS);
    });

    it('should ignore coreTools overrides in bare mode', async () => {
      const config = new Config({
        ...baseParams,
        bareMode: true,
        coreTools: [ToolNames.WEB_FETCH],
      });
      await config.initialize();

      const registerToolMock = (
        (await vi.importMock('../tools/tool-registry')) as {
          ToolRegistry: { prototype: { registerFactory: Mock } };
        }
      ).ToolRegistry.prototype.registerFactory;

      expect(config.getCoreTools()).toEqual([
        ToolNames.READ_FILE,
        ToolNames.EDIT,
        ToolNames.NOTEBOOK_EDIT,
        ToolNames.SHELL,
      ]);
      expect(
        (registerToolMock as Mock).mock.calls.map((call) => call[0]),
      ).toEqual([
        ToolNames.READ_FILE,
        ToolNames.EDIT,
        ToolNames.NOTEBOOK_EDIT,
        ToolNames.SHELL,
        ToolNames.GET_GOAL,
        ToolNames.UPDATE_GOAL,
      ]);
    });

    it('registers structured_output in bare mode when jsonSchema is set', async () => {
      // Bare mode strips the toolset to READ_FILE/EDIT/NOTEBOOK_EDIT/SHELL, but the
      // synthetic structured_output tool is the terminal contract for
      // --json-schema runs. Without it the model loops until
      // maxSessionTurns and exits via the "plain text" failure path —
      // expensive in tokens for what's almost always a CI use case. The
      // synthetic tool must be registered alongside the bare toolset.
      const config = new Config({
        ...baseParams,
        bareMode: true,
        jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      });
      await config.initialize();

      const registerToolMock = (
        (await vi.importMock('../tools/tool-registry')) as {
          ToolRegistry: { prototype: { registerFactory: Mock } };
        }
      ).ToolRegistry.prototype.registerFactory;

      expect(
        (registerToolMock as Mock).mock.calls.map((call) => call[0]),
      ).toEqual([
        ToolNames.READ_FILE,
        ToolNames.EDIT,
        ToolNames.NOTEBOOK_EDIT,
        ToolNames.SHELL,
        ToolNames.GET_GOAL,
        ToolNames.UPDATE_GOAL,
        ToolNames.STRUCTURED_OUTPUT,
      ]);
    });

    it('does NOT register structured_output when createToolRegistry is called with forSubAgent=true', async () => {
      // Subagent overrides reuse the parent Config via prototype
      // delegation (createApprovalModeOverride / buildSubagentContextOverride
      // → Object.create(base)) and rebuild the tool registry with
      // `forSubAgent: true`. Even though `this.jsonSchema` propagates
      // through the prototype chain, the synthetic tool MUST NOT register
      // in the subagent registry: only runNonInteractive's main / drain
      // loops detect a successful structured_output call as terminal, so
      // a subagent calling the tool would receive "Session will end now"
      // and then keep running because its own loop has no terminator —
      // wasted tokens and no structured payload on stdout.
      const config = new Config({
        ...baseParams,
        bareMode: true,
        jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      });
      await config.initialize();

      const registerToolMock = (
        (await vi.importMock('../tools/tool-registry')) as {
          ToolRegistry: { prototype: { registerFactory: Mock } };
        }
      ).ToolRegistry.prototype.registerFactory;
      // Initial bare init registers READ_FILE / EDIT / NOTEBOOK_EDIT /
      // SHELL / STRUCTURED_OUTPUT (asserted by the test above). Reset so we can
      // observe ONLY the forSubAgent rebuild's calls.
      (registerToolMock as Mock).mockClear();

      // Rebuild registry as if for a subagent override.
      await config.createToolRegistry(undefined, {
        skipDiscovery: true,
        forSubAgent: true,
      });

      const registeredNames = (registerToolMock as Mock).mock.calls.map(
        (call) => call[0],
      );
      expect(registeredNames).not.toContain(ToolNames.STRUCTURED_OUTPUT);
      // The bare tools still register so the subagent has its toolset.
      expect(registeredNames).toEqual([
        ToolNames.READ_FILE,
        ToolNames.EDIT,
        ToolNames.NOTEBOOK_EDIT,
        ToolNames.SHELL,
      ]);
    });

    // The leader-only property of request_shutdown is "enforced by absence":
    // a teammate's registry never contains it, so the call cannot be formed.
    // That only holds if the skip actually fires, which nothing asserted.
    it('registers request_shutdown for a leader but not for a subagent', async () => {
      const config = new Config({
        ...baseParams,
        agentTeamEnabled: true,
      });
      await config.initialize();

      const registerToolMock = (
        (await vi.importMock('../tools/tool-registry')) as {
          ToolRegistry: { prototype: { registerFactory: Mock } };
        }
      ).ToolRegistry.prototype.registerFactory;

      const leaderNames = (registerToolMock as Mock).mock.calls.map(
        (call) => call[0],
      );
      expect(leaderNames).toContain(ToolNames.REQUEST_SHUTDOWN);

      (registerToolMock as Mock).mockClear();
      await config.createToolRegistry(undefined, {
        skipDiscovery: true,
        forSubAgent: true,
      });

      const subagentNames = (registerToolMock as Mock).mock.calls.map(
        (call) => call[0],
      );
      expect(subagentNames).not.toContain(ToolNames.REQUEST_SHUTDOWN);
      // The rest of the team surface still registers — only the leader-only
      // control tool is withheld.
      expect(subagentNames).toContain(ToolNames.SEND_MESSAGE);
    });

    it('registers web_search when enabled with a usable env-declared backend', async () => {
      process.env['WEB_SEARCH_GATE_TEST_KEY'] = 'sk-test';
      try {
        const config = new Config({
          ...baseParams,
          webSearch: {
            enabled: true,
            model: 'qwen3.6-plus',
            baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
            apiKeyEnv: 'WEB_SEARCH_GATE_TEST_KEY',
          },
        });
        await config.initialize();

        const registerToolMock = (
          (await vi.importMock('../tools/tool-registry')) as {
            ToolRegistry: { prototype: { registerFactory: Mock } };
          }
        ).ToolRegistry.prototype.registerFactory;

        expect(
          (registerToolMock as Mock).mock.calls.map((call) => call[0]),
        ).toContain(ToolNames.WEB_SEARCH);
        expect(
          config.getWarnings().filter((w) => w.includes('WebSearch')),
        ).toEqual([]);
      } finally {
        delete process.env['WEB_SEARCH_GATE_TEST_KEY'];
      }
    });

    it('does not register web_search or push a notice when the feature is disabled', async () => {
      const config = new Config(baseParams);
      await config.initialize();

      const registerToolMock = (
        (await vi.importMock('../tools/tool-registry')) as {
          ToolRegistry: { prototype: { registerFactory: Mock } };
        }
      ).ToolRegistry.prototype.registerFactory;

      expect(
        (registerToolMock as Mock).mock.calls.map((call) => call[0]),
      ).not.toContain(ToolNames.WEB_SEARCH);
      expect(
        config.getWarnings().filter((w) => w.includes('WebSearch')),
      ).toEqual([]);
    });

    it('pushes a one-time notice when web_search is enabled but misconfigured', async () => {
      // Enabled without a model: the tool must stay off with a diagnostic
      // notice, pushed exactly once across registry rebuilds.
      const config = new Config({
        ...baseParams,
        webSearch: { enabled: true },
      });
      await config.initialize();

      const registerToolMock = (
        (await vi.importMock('../tools/tool-registry')) as {
          ToolRegistry: { prototype: { registerFactory: Mock } };
        }
      ).ToolRegistry.prototype.registerFactory;
      expect(
        (registerToolMock as Mock).mock.calls.map((call) => call[0]),
      ).not.toContain(ToolNames.WEB_SEARCH);

      const webSearchNotices = () =>
        config.getWarnings().filter((w) => w.includes('WebSearch'));
      expect(webSearchNotices()).toHaveLength(1);
      expect(webSearchNotices()[0]).toContain('no search model');

      // A registry rebuild must not duplicate the notice.
      await config.createToolRegistry(undefined, { skipDiscovery: true });
      expect(webSearchNotices()).toHaveLength(1);
    });

    it('should register a tool if coreTools contains an argument-specific pattern', async () => {
      const params: ConfigParameters = {
        ...baseParams,
        coreTools: ['Shell(git status)'], // Use display name instead of class name
      };
      const config = new Config(params);
      await config.initialize();

      // The ToolRegistry class is mocked, so we can inspect its prototype's methods.
      const registerToolMock = (
        (await vi.importMock('../tools/tool-registry')) as {
          ToolRegistry: { prototype: { registerFactory: Mock } };
        }
      ).ToolRegistry.prototype.registerFactory;

      // Check that registerTool was called for ShellTool
      const wasShellToolRegistered = (registerToolMock as Mock).mock.calls.some(
        (call) => call[0] === ToolNames.SHELL,
      );
      expect(wasShellToolRegistered).toBe(true);

      // Check that registerTool was NOT called for ReadFileTool
      const wasReadFileToolRegistered = (
        registerToolMock as Mock
      ).mock.calls.some((call) => call[0] === ToolNames.READ_FILE);
      expect(wasReadFileToolRegistered).toBe(false);
    });

    it('should register a tool if coreTools contains the displayName', async () => {
      const params: ConfigParameters = {
        ...baseParams,
        coreTools: ['Shell'],
      };
      const config = new Config(params);
      await config.initialize();

      const registerToolMock = (
        (await vi.importMock('../tools/tool-registry')) as {
          ToolRegistry: { prototype: { registerFactory: Mock } };
        }
      ).ToolRegistry.prototype.registerFactory;

      const wasShellToolRegistered = (registerToolMock as Mock).mock.calls.some(
        (call) => call[0] === ToolNames.SHELL,
      );
      expect(wasShellToolRegistered).toBe(true);
    });

    it('should register a tool if coreTools contains the displayName with argument-specific pattern', async () => {
      const params: ConfigParameters = {
        ...baseParams,
        coreTools: ['Shell(git status)'],
      };
      const config = new Config(params);
      await config.initialize();

      const registerToolMock = (
        (await vi.importMock('../tools/tool-registry')) as {
          ToolRegistry: { prototype: { registerFactory: Mock } };
        }
      ).ToolRegistry.prototype.registerFactory;

      const wasShellToolRegistered = (registerToolMock as Mock).mock.calls.some(
        (call) => call[0] === ToolNames.SHELL,
      );
      expect(wasShellToolRegistered).toBe(true);
    });

    it('should register a tool if coreTools contains a legacy tool name alias', async () => {
      const params: ConfigParameters = {
        ...baseParams,
        useRipgrep: false,
        coreTools: ['search_file_content'],
      };
      const config = new Config(params);
      await config.initialize();

      const registerToolMock = (
        (await vi.importMock('../tools/tool-registry')) as {
          ToolRegistry: { prototype: { registerFactory: Mock } };
        }
      ).ToolRegistry.prototype.registerFactory;

      const wasGrepToolRegistered = (registerToolMock as Mock).mock.calls.some(
        (call) => call[0] === ToolNames.GREP,
      );
      expect(wasGrepToolRegistered).toBe(true);
    });

    it('should not register a tool if excludeTools contains a legacy display name alias', async () => {
      const params: ConfigParameters = {
        ...baseParams,
        useRipgrep: false,
        coreTools: undefined,
        excludeTools: ['SearchFiles'],
      };
      const config = new Config(params);
      await config.initialize();

      const registerToolMock = (
        (await vi.importMock('../tools/tool-registry')) as {
          ToolRegistry: { prototype: { registerFactory: Mock } };
        }
      ).ToolRegistry.prototype.registerFactory;

      const wasGrepToolRegistered = (registerToolMock as Mock).mock.calls.some(
        (call) => call[0] === ToolNames.GREP,
      );
      expect(wasGrepToolRegistered).toBe(false);
    });

    // ── #9827 / #10075: tools.eager keeps unlisted schemas out of the eager
    // model request, but demotes (not removes) the unlisted tools ──
    it('registers tools.eager entries eagerly and demotes the rest to deferred (#9827, #10075)', async () => {
      const settingsAllow = [
        'ReadFile',
        'WriteFile',
        'Edit',
        'Grep',
        'Glob',
        'ListFiles',
        'Shell',
        'WebFetch',
      ];
      const params: ConfigParameters = {
        ...baseParams,
        useRipgrep: false,
        coreTools: undefined,
        // Mirrors the CLI wiring. `permissions.allow` is deliberately left
        // unset: the eager/deferred split is driven solely by tools.eager
        // (#10075).
        eagerTools: settingsAllow,
      };
      const config = new Config(params);
      await config.initialize();

      const { registerFactory, registerPermissionDeferredFactory } = (
        (await vi.importMock('../tools/tool-registry')) as {
          ToolRegistry: {
            prototype: {
              registerFactory: Mock;
              registerPermissionDeferredFactory: Mock;
            };
          };
        }
      ).ToolRegistry.prototype;

      const registered = (registerFactory as Mock).mock.calls.map(
        (call) => call[0],
      ) as string[];
      const deferred = (
        registerPermissionDeferredFactory as Mock
      ).mock.calls.map((call) => call[0]) as string[];

      // Allowlisted tools are registered eagerly
      expect(registered).toContain(ToolNames.READ_FILE);
      expect(registered).toContain(ToolNames.WRITE_FILE);
      expect(registered).toContain(ToolNames.EDIT);
      expect(registered).toContain(ToolNames.GREP);
      expect(registered).toContain(ToolNames.GLOB);
      expect(registered).toContain(ToolNames.SHELL);
      expect(registered).toContain(ToolNames.WEB_FETCH);

      // Unlisted built-ins are NOT registered eagerly — their schemas are
      // never sent in the eager model request (#9827). But since #10075 they
      // are demoted to deferred rather than dropped: still registered, so
      // they stay listed in /tools and loadable via ToolSearch instead of
      // silently disappearing.
      expect(registered).not.toContain(ToolNames.SEND_MESSAGE);
      expect(registered).not.toContain(ToolNames.UPDATE_GOAL);
      expect(registered).not.toContain(ToolNames.GET_GOAL);
      expect(registered).not.toContain(ToolNames.LOOP_WAKEUP);
      expect(registered).not.toContain(ToolNames.READ_MCP_RESOURCE);
      expect(registered).not.toContain(ToolNames.AGENT);
      expect(registered).not.toContain(ToolNames.TODO_WRITE);
      expect(deferred).toContain(ToolNames.SEND_MESSAGE);
      expect(deferred).toContain(ToolNames.UPDATE_GOAL);
      expect(deferred).toContain(ToolNames.GET_GOAL);
      expect(deferred).toContain(ToolNames.LOOP_WAKEUP);
      expect(deferred).toContain(ToolNames.READ_MCP_RESOURCE);
      expect(deferred).toContain(ToolNames.AGENT);
      expect(deferred).toContain(ToolNames.SKILL);
      expect(deferred).toContain(ToolNames.TODO_WRITE);
      // monitor stays registered eagerly: the "Shell" allow rule covers it
      // so the shell tool cannot be bypassed by switching to monitor.
      expect(registered).toContain(ToolNames.MONITOR);
      // tools.eager never promotes a disabled tool into existence: LS is
      // listed above, but its registration stays gated on isLsToolEnabled()
      // (tools.listDirectory.enabled / coreTools), which is off here — so
      // the eager path must neither register nor defer it.
      expect(registered).not.toContain(ToolNames.LS);
      expect(deferred).not.toContain(ToolNames.LS);
    });

    it('demotes an enabled LS to deferred when tools.eager omits it (#9827, #10075)', async () => {
      // Companion to the test above: with LS enabled via
      // tools.listDirectory.enabled but omitted from the eager list (and
      // covered by no listed meta-category — only "Shell" is listed), the
      // eager gate must demote LS to deferred via
      // registerPermissionDeferredFactory, never promote it to an eager
      // registration.
      const params: ConfigParameters = {
        ...baseParams,
        useRipgrep: false,
        coreTools: undefined,
        lsToolEnabled: true,
        eagerTools: ['Shell'],
      };
      const config = new Config(params);
      await config.initialize();

      const { registerFactory, registerPermissionDeferredFactory } = (
        (await vi.importMock('../tools/tool-registry')) as {
          ToolRegistry: {
            prototype: {
              registerFactory: Mock;
              registerPermissionDeferredFactory: Mock;
            };
          };
        }
      ).ToolRegistry.prototype;

      const registered = (registerFactory as Mock).mock.calls.map(
        (call) => call[0],
      ) as string[];
      const deferred = (
        registerPermissionDeferredFactory as Mock
      ).mock.calls.map((call) => call[0]) as string[];

      expect(registered).not.toContain(ToolNames.LS);
      expect(deferred).toContain(ToolNames.LS);
    });

    it('registers an enabled LS eagerly when tools.eager covers it (#10400)', async () => {
      // Third cell of the LS x tools.eager matrix: enabled AND covered by
      // the allowlist (via the ListFiles alias) -> registered eagerly via
      // registerFactory, not demoted to deferred. Guards against a
      // registerLazy mutant that demotes LS whenever an eager list is
      // active, ignoring entry coverage (#10400).
      const params: ConfigParameters = {
        ...baseParams,
        useRipgrep: false,
        coreTools: undefined,
        lsToolEnabled: true,
        eagerTools: ['Shell', 'ListFiles'],
      };
      const config = new Config(params);
      await config.initialize();

      const { registerFactory, registerPermissionDeferredFactory } = (
        (await vi.importMock('../tools/tool-registry')) as {
          ToolRegistry: {
            prototype: {
              registerFactory: Mock;
              registerPermissionDeferredFactory: Mock;
            };
          };
        }
      ).ToolRegistry.prototype;

      const registered = (registerFactory as Mock).mock.calls.map(
        (call) => call[0],
      ) as string[];
      const deferred = (
        registerPermissionDeferredFactory as Mock
      ).mock.calls.map((call) => call[0]) as string[];

      expect(registered).toContain(ToolNames.LS);
      expect(deferred).not.toContain(ToolNames.LS);
    });

    it('registers the full built-in set when no permissionsAllow is set (#9827 regression guard)', async () => {
      const params: ConfigParameters = {
        ...baseParams,
        useRipgrep: false,
        coreTools: undefined,
      };
      const config = new Config(params);
      await config.initialize();

      const registerToolMock = (
        (await vi.importMock('../tools/tool-registry')) as {
          ToolRegistry: { prototype: { registerFactory: Mock } };
        }
      ).ToolRegistry.prototype.registerFactory;

      const registered = (registerToolMock as Mock).mock.calls.map(
        (call) => call[0],
      ) as string[];

      // Without an allowlist nothing is gated at registry level
      expect(registered).toContain(ToolNames.SEND_MESSAGE);
      expect(registered).toContain(ToolNames.UPDATE_GOAL);
      expect(registered).toContain(ToolNames.AGENT);
      expect(registered).toContain(ToolNames.TODO_WRITE);
      expect(registered).toContain(ToolNames.READ_FILE);
    });

    it('tools.eager keeps the --exclude-tools (deny) path working (#9827)', async () => {
      const settingsAllow = ['ReadFile', 'Shell'];
      const params: ConfigParameters = {
        ...baseParams,
        useRipgrep: false,
        coreTools: undefined,
        eagerTools: settingsAllow,
        permissions: {
          deny: ['Shell'],
        },
      };
      const config = new Config(params);
      await config.initialize();

      const { registerFactory, registerPermissionDeferredFactory } = (
        (await vi.importMock('../tools/tool-registry')) as {
          ToolRegistry: {
            prototype: {
              registerFactory: Mock;
              registerPermissionDeferredFactory: Mock;
            };
          };
        }
      ).ToolRegistry.prototype;

      const registered = (registerFactory as Mock).mock.calls.map(
        (call) => call[0],
      ) as string[];
      const deferred = (
        registerPermissionDeferredFactory as Mock
      ).mock.calls.map((call) => call[0]) as string[];

      expect(registered).toContain(ToolNames.READ_FILE);
      // deny wins over allowlist membership: a denied tool is hard-disabled
      // — not registered eagerly AND not deferred either.
      expect(registered).not.toContain(ToolNames.SHELL);
      expect(deferred).not.toContain(ToolNames.SHELL);
      // An unlisted (not denied) tool is deferred, not dropped (#10075).
      expect(registered).not.toContain(ToolNames.SEND_MESSAGE);
      expect(deferred).toContain(ToolNames.SEND_MESSAGE);
    });

    it('derived getPermissionManager overrides reach the registration gate (scoped agent shims, #10075)', async () => {
      // The skill-review fork wraps the base Config with
      // createSkillScopedAgentConfig, whose scoped PermissionManager promises
      // 'registered' for its file tools. Under an active tools.eager
      // allowlist that omits them, the BASE manager demotes the same tools
      // to deferred. createToolRegistry must resolve the manager through
      // getPermissionManager() — where the derived config's override lives —
      // not the `permissionManager` field, which resolves through the
      // Object.create prototype chain to the base manager. With the field,
      // the rebuild below registers the file tools as permission-deferred
      // and prepareTools' eager filter strips them from the forked agent's
      // explicit tools list — the silent-disappearance class #10075 set out
      // to eliminate.
      const config = new Config({
        ...baseParams,
        useRipgrep: false,
        coreTools: undefined,
        eagerTools: [],
      });
      await config.initialize();

      const { registerFactory, registerPermissionDeferredFactory } = (
        (await vi.importMock('../tools/tool-registry')) as {
          ToolRegistry: {
            prototype: {
              registerFactory: Mock;
              registerPermissionDeferredFactory: Mock;
            };
          };
        }
      ).ToolRegistry.prototype;
      registerFactory.mockClear();
      (registerPermissionDeferredFactory as Mock).mockClear();

      // Mirrors runSkillReviewByAgent → createApprovalModeOverride →
      // rebuildToolRegistryOnOverride on the scoped wrapper.
      const scoped = createSkillScopedAgentConfig(config, TARGET_DIR);
      await scoped.createToolRegistry(undefined, {
        skipDiscovery: true,
        forSubAgent: true,
      });

      const registered = (registerFactory as Mock).mock.calls.map(
        (call) => call[0],
      ) as string[];
      const deferred = (
        registerPermissionDeferredFactory as Mock
      ).mock.calls.map((call) => call[0]) as string[];

      // The scoped PM's 'registered' promise for its file tools must win
      // over the base eager gate's 'deferred'.
      expect(registered).toContain(ToolNames.READ_FILE);
      expect(registered).toContain(ToolNames.WRITE_FILE);
      expect(registered).toContain(ToolNames.EDIT);
      expect(deferred).not.toContain(ToolNames.READ_FILE);
      expect(deferred).not.toContain(ToolNames.WRITE_FILE);
      expect(deferred).not.toContain(ToolNames.EDIT);
    });

    describe('with minified tool class names', () => {
      beforeEach(() => {
        Object.defineProperty(
          vi.mocked(ShellTool).prototype.constructor,
          'name',
          {
            value: '_ShellTool',
            configurable: true,
          },
        );
      });

      afterEach(() => {
        Object.defineProperty(
          vi.mocked(ShellTool).prototype.constructor,
          'name',
          {
            value: 'ShellTool',
          },
        );
      });

      it('should register a tool if coreTools contains the non-minified class name', async () => {
        const params: ConfigParameters = {
          ...baseParams,
          coreTools: ['Shell'], // Use display name instead of class name
        };
        const config = new Config(params);
        await config.initialize();

        const registerToolMock = (
          (await vi.importMock('../tools/tool-registry')) as {
            ToolRegistry: { prototype: { registerFactory: Mock } };
          }
        ).ToolRegistry.prototype.registerFactory;

        const wasShellToolRegistered = (
          registerToolMock as Mock
        ).mock.calls.some((call) => call[0] === ToolNames.SHELL);
        expect(wasShellToolRegistered).toBe(true);
      });

      it('should register a tool if coreTools contains the displayName', async () => {
        const params: ConfigParameters = {
          ...baseParams,
          coreTools: ['Shell'],
        };
        const config = new Config(params);
        await config.initialize();

        const registerToolMock = (
          (await vi.importMock('../tools/tool-registry')) as {
            ToolRegistry: { prototype: { registerFactory: Mock } };
          }
        ).ToolRegistry.prototype.registerFactory;

        const wasShellToolRegistered = (
          registerToolMock as Mock
        ).mock.calls.some((call) => call[0] === ToolNames.SHELL);
        expect(wasShellToolRegistered).toBe(true);
      });

      it('should not register a tool if excludeTools contains the non-minified class name', async () => {
        const params: ConfigParameters = {
          ...baseParams,
          coreTools: undefined, // all tools enabled by default
          excludeTools: ['Shell'], // Use display name instead of class name
        };
        const config = new Config(params);
        await config.initialize();

        const registerToolMock = (
          (await vi.importMock('../tools/tool-registry')) as {
            ToolRegistry: { prototype: { registerFactory: Mock } };
          }
        ).ToolRegistry.prototype.registerFactory;

        const wasShellToolRegistered = (
          registerToolMock as Mock
        ).mock.calls.some((call) => call[0] === ToolNames.SHELL);
        expect(wasShellToolRegistered).toBe(false);
      });

      it('should not register a tool if excludeTools contains the displayName', async () => {
        const params: ConfigParameters = {
          ...baseParams,
          coreTools: undefined, // all tools enabled by default
          excludeTools: ['Shell'],
        };
        const config = new Config(params);
        await config.initialize();

        const registerToolMock = (
          (await vi.importMock('../tools/tool-registry')) as {
            ToolRegistry: { prototype: { registerFactory: Mock } };
          }
        ).ToolRegistry.prototype.registerFactory;

        const wasShellToolRegistered = (
          registerToolMock as Mock
        ).mock.calls.some((call) => call[0] === ToolNames.SHELL);
        expect(wasShellToolRegistered).toBe(false);
      });

      it('should register a tool if coreTools contains an argument-specific pattern with the non-minified class name', async () => {
        const params: ConfigParameters = {
          ...baseParams,
          coreTools: ['Shell(git status)'], // Use display name instead of class name
        };
        const config = new Config(params);
        await config.initialize();

        const registerToolMock = (
          (await vi.importMock('../tools/tool-registry')) as {
            ToolRegistry: { prototype: { registerFactory: Mock } };
          }
        ).ToolRegistry.prototype.registerFactory;

        const wasShellToolRegistered = (
          registerToolMock as Mock
        ).mock.calls.some((call) => call[0] === ToolNames.SHELL);
        expect(wasShellToolRegistered).toBe(true);
      });

      it('should register a tool if coreTools contains an argument-specific pattern with the displayName', async () => {
        const params: ConfigParameters = {
          ...baseParams,
          coreTools: ['Shell(git status)'],
        };
        const config = new Config(params);
        await config.initialize();

        const registerToolMock = (
          (await vi.importMock('../tools/tool-registry')) as {
            ToolRegistry: { prototype: { registerFactory: Mock } };
          }
        ).ToolRegistry.prototype.registerFactory;

        const wasShellToolRegistered = (
          registerToolMock as Mock
        ).mock.calls.some((call) => call[0] === ToolNames.SHELL);
        expect(wasShellToolRegistered).toBe(true);
      });
    });
  });

  describe('getTruncateToolOutputThreshold', () => {
    it('should return the default threshold', () => {
      const config = new Config(baseParams);
      expect(config.getTruncateToolOutputThreshold()).toBe(25_000);
      expect(config.isTruncateToolOutputThresholdExplicit()).toBe(false);
    });

    it('treats a null runtime threshold as unset', () => {
      const config = new Config({
        ...baseParams,
        truncateToolOutputThreshold: null as unknown as number,
      });

      expect(config.getTruncateToolOutputThreshold()).toBe(25_000);
      expect(config.isTruncateToolOutputThresholdExplicit()).toBe(false);
    });

    it('should use a custom truncateToolOutputThreshold if provided', () => {
      const customParams = {
        ...baseParams,
        truncateToolOutputThreshold: 50000,
      };
      const config = new Config(customParams);
      expect(config.getTruncateToolOutputThreshold()).toBe(50000);
    });

    it('should return infinity when threshold is zero or negative', () => {
      const customParams = {
        ...baseParams,
        truncateToolOutputThreshold: 0,
      };
      const config = new Config(customParams);
      expect(config.getTruncateToolOutputThreshold()).toBe(
        Number.POSITIVE_INFINITY,
      );
    });

    it.each([
      [25_000, 25_000],
      [10_000, 10_000],
      [100_000, 100_000],
      [-1, Number.POSITIVE_INFINITY],
    ])('tracks an explicit threshold of %s', (threshold, expectedThreshold) => {
      const config = new Config({
        ...baseParams,
        truncateToolOutputThreshold: threshold,
      });

      expect(config.getTruncateToolOutputThreshold()).toBe(expectedThreshold);
      expect(config.isTruncateToolOutputThresholdExplicit()).toBe(true);
    });
  });

  describe('getMaxToolCallsPerTurn', () => {
    it('should return the default cap when unset', () => {
      const config = new Config(baseParams);
      expect(config.getMaxToolCallsPerTurn()).toBe(
        DEFAULT_MAX_TOOL_CALLS_PER_TURN,
      );
    });

    it('should use a custom maxToolCallsPerTurn if provided', () => {
      const config = new Config({ ...baseParams, maxToolCallsPerTurn: 42 });
      expect(config.getMaxToolCallsPerTurn()).toBe(42);
    });

    it('tracks whether maxToolCallsPerTurn was explicitly set', () => {
      expect(
        new Config({ ...baseParams }).isMaxToolCallsPerTurnExplicit(),
      ).toBe(false);
      expect(
        new Config({
          ...baseParams,
          maxToolCallsPerTurn: 42,
        }).isMaxToolCallsPerTurnExplicit(),
      ).toBe(true);
    });

    it.each([0, -1])(
      'should return infinity (cap disabled) when set to %d',
      (capValue) => {
        const config = new Config({
          ...baseParams,
          maxToolCallsPerTurn: capValue,
        });
        expect(config.getMaxToolCallsPerTurn()).toBe(Number.POSITIVE_INFINITY);
      },
    );

    it.each([0.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'should reject an invalid maxToolCallsPerTurn value: %s',
      (capValue) => {
        expect(
          () => new Config({ ...baseParams, maxToolCallsPerTurn: capValue }),
        ).toThrow(/maxToolCallsPerTurn: must be an integer/);
      },
    );
  });

  describe('getMaxSessionTurns', () => {
    it.each([-42, -1, 0, 42])('should accept %d', (maxSessionTurns) => {
      const config = new Config({ ...baseParams, maxSessionTurns });
      expect(config.getMaxSessionTurns()).toBe(maxSessionTurns);
    });

    it.each([0.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'should reject an invalid value: %s',
      (maxSessionTurns) => {
        expect(() => new Config({ ...baseParams, maxSessionTurns })).toThrow(
          /maxSessionTurns: must be an integer/,
        );
      },
    );
  });

  describe('getClearContextOnIdle', () => {
    it('should default the cumulative tool result threshold to 500000 chars', () => {
      const config = new Config(baseParams);

      expect(config.getClearContextOnIdle()).toMatchObject({
        toolResultsThresholdMinutes: 60,
        toolResultsNumToKeep: 5,
        toolResultsTotalCharsThreshold: 500_000,
      });
    });

    it('should use a custom cumulative tool result threshold if provided', () => {
      const config = new Config({
        ...baseParams,
        clearContextOnIdle: {
          toolResultsTotalCharsThreshold: 123_456,
        },
      });

      expect(
        config.getClearContextOnIdle().toolResultsTotalCharsThreshold,
      ).toBe(123_456);
    });

    it('should preserve an explicit disabled cumulative tool result threshold', () => {
      const config = new Config({
        ...baseParams,
        clearContextOnIdle: {
          toolResultsTotalCharsThreshold: -1,
        },
      });

      expect(config.getClearContextOnIdle()).toMatchObject({
        toolResultsThresholdMinutes: 60,
        toolResultsNumToKeep: 5,
        toolResultsTotalCharsThreshold: -1,
      });
    });

    it('should keep legacy disabled idle cleanup disabled for the size trigger too', () => {
      const config = new Config({
        ...baseParams,
        clearContextOnIdle: {
          toolResultsThresholdMinutes: -1,
        },
      });

      expect(config.getClearContextOnIdle()).toMatchObject({
        toolResultsThresholdMinutes: -1,
        toolResultsNumToKeep: 5,
        toolResultsTotalCharsThreshold: -1,
      });
    });

    it('should treat any negative legacy idle threshold as disabling the size trigger too', () => {
      const config = new Config({
        ...baseParams,
        clearContextOnIdle: {
          toolResultsThresholdMinutes: -2,
        },
      });

      expect(config.getClearContextOnIdle()).toMatchObject({
        toolResultsThresholdMinutes: -2,
        toolResultsNumToKeep: 5,
        toolResultsTotalCharsThreshold: -1,
      });
    });
  });

  // PR 14b fix (codex round 4 — wenshao gpt-5.5 review): the
  // `Config.setMcpBudgetEventCallback → pendingMcpBudgetCallback →
  // createToolRegistry → registry.getMcpClientManager().setOnBudgetEvent`
  // boundary previously had NO test. The acpAgent test stubs the
  // setter (proves QwenAgent calls it pre-`initialize`); the manager
  // tests bypass Config by passing `onBudgetEvent` directly to
  // `McpClientManager`. Neither covers the actual stash + apply path
  // inside Config — and that path is the safety net that prevents
  // startup-window MCP guardrail events from being dropped under
  // legacy blocking discovery + closes the progressive-mode race
  // window. These two tests exercise both call orderings (pre-init
  // and late-call).
  describe('setMcpBudgetEventCallback handoff to McpClientManager', () => {
    it('applies pending callback when registry is created during initialize()', async () => {
      const config = new Config(baseParams);
      const cb = vi.fn();
      // Setter called BEFORE initialize — value stashed on
      // `pendingMcpBudgetCallback` and applied inside
      // `createToolRegistry` after the manager is constructed but
      // BEFORE `discoverAllTools` / background discovery fires.
      config.setMcpBudgetEventCallback(cb);
      await config.initialize();

      const registry = config.getToolRegistry() as unknown as {
        __mcpManagerMock: { setOnBudgetEvent: Mock };
      };
      expect(registry.__mcpManagerMock.setOnBudgetEvent).toHaveBeenCalledWith(
        cb,
      );
      // Exactly once — the apply path fires only once per
      // `createToolRegistry` invocation.
      expect(
        registry.__mcpManagerMock.setOnBudgetEvent.mock.calls,
      ).toHaveLength(1);
    });

    it('applies callback directly to existing manager when called after initialize()', async () => {
      const config = new Config(baseParams);
      // Initialize WITHOUT a pending callback first — the
      // createToolRegistry apply branch is a no-op.
      await config.initialize();
      const registry = config.getToolRegistry() as unknown as {
        __mcpManagerMock: { setOnBudgetEvent: Mock };
      };
      // Sanity: no apply happened during init since callback was
      // never registered.
      expect(registry.__mcpManagerMock.setOnBudgetEvent).not.toHaveBeenCalled();

      // Late-call path: setter dispatches DIRECTLY to the existing
      // manager via the `if (this.toolRegistry)` branch in
      // `setMcpBudgetEventCallback`. This is the path tests/adapters
      // use when they discover the manager only after Config is up.
      const cb = vi.fn();
      config.setMcpBudgetEventCallback(cb);
      expect(registry.__mcpManagerMock.setOnBudgetEvent).toHaveBeenCalledWith(
        cb,
      );

      // Calling with `undefined` clears the registration on the
      // manager (parity with the constructor-time `off`-mode strip
      // in McpClientManager).
      config.setMcpBudgetEventCallback(undefined);
      expect(
        registry.__mcpManagerMock.setOnBudgetEvent,
      ).toHaveBeenLastCalledWith(undefined);
    });

    it('does NOT stash the callback when called after initialize() (codex round 7 fix — subagent isolation)', async () => {
      // Codex round 7 finding: pre-fix, the late-call path assigned
      // to `pendingMcpBudgetCallback` BEFORE applying directly to
      // the existing manager. A subsequent `createToolRegistry`
      // (e.g. subagent override via `createApprovalModeOverride` /
      // `buildSubagentContextOverride`) would inherit the stash and
      // wire the parent session's ACP push callback into the
      // subagent's fresh manager, routing subagent telemetry
      // through the wrong session.
      //
      // Fix: late-call path applies directly + sets
      // `pendingMcpBudgetCallback = undefined`. Pre-init path still
      // stashes (the only way to reach a manager that doesn't
      // exist yet — round 1 fix #2 contract).
      const config = new Config(baseParams);
      await config.initialize();
      const registry = config.getToolRegistry() as unknown as {
        __mcpManagerMock: { setOnBudgetEvent: Mock };
      };

      // Late-call: apply.
      const cb = vi.fn();
      config.setMcpBudgetEventCallback(cb);
      expect(registry.__mcpManagerMock.setOnBudgetEvent).toHaveBeenCalledWith(
        cb,
      );

      // Now rebuild a registry as if for a subagent override. With
      // the round-7 fix, the new manager should NOT receive the
      // parent session's callback — pre-fix this would re-apply
      // `cb` to the new manager.
      const subagentRegistry = (await config.createToolRegistry(undefined, {
        skipDiscovery: true,
        forSubAgent: true,
      })) as unknown as {
        __mcpManagerMock: { setOnBudgetEvent: Mock };
      };
      expect(
        subagentRegistry.__mcpManagerMock.setOnBudgetEvent,
      ).not.toHaveBeenCalled();
    });
  });
});

describe('setApprovalMode with folder trust', () => {
  const baseParams: ConfigParameters = {
    targetDir: '.',
    debugMode: false,
    model: 'test-model',
    cwd: '.',
    chatRecording: false,
  };

  it('should throw a TrustGateError when setting YOLO mode in an untrusted folder', () => {
    // #4297 fold-in 1 (16:32:44-round S3): assert on the typed class,
    // not just message text. The 403 mapping in `serve/server.ts`
    // matches `err instanceof TrustGateError`; an accidental revert
    // to `throw new Error(...)` would silently downgrade to 500
    // while the message text test kept passing.
    const config = new Config(baseParams);
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(false);
    expect(() => config.setApprovalMode(ApprovalMode.YOLO)).toThrow(
      TrustGateError,
    );
    expect(() => config.setApprovalMode(ApprovalMode.YOLO)).toThrow(
      'Cannot enable privileged approval modes in an untrusted folder.',
    );
  });

  it('should throw a TrustGateError when setting AUTO_EDIT mode in an untrusted folder', () => {
    const config = new Config(baseParams);
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(false);
    expect(() => config.setApprovalMode(ApprovalMode.AUTO_EDIT)).toThrow(
      TrustGateError,
    );
    expect(() => config.setApprovalMode(ApprovalMode.AUTO_EDIT)).toThrow(
      'Cannot enable privileged approval modes in an untrusted folder.',
    );
  });

  it('should NOT throw an error when setting DEFAULT mode in an untrusted folder', () => {
    const config = new Config(baseParams);
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(false);
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
    const config = new Config(baseParams);
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
    expect(() => config.setApprovalMode(ApprovalMode.YOLO)).not.toThrow();
    expect(() => config.setApprovalMode(ApprovalMode.AUTO_EDIT)).not.toThrow();
    expect(() => config.setApprovalMode(ApprovalMode.DEFAULT)).not.toThrow();
    expect(() => config.setApprovalMode(ApprovalMode.PLAN)).not.toThrow();
  });

  it('should NOT throw an error when setting any mode if trustedFolder is undefined', () => {
    const config = new Config(baseParams);
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true); // isTrustedFolder defaults to true
    expect(() => config.setApprovalMode(ApprovalMode.YOLO)).not.toThrow();
    expect(() => config.setApprovalMode(ApprovalMode.AUTO_EDIT)).not.toThrow();
    expect(() => config.setApprovalMode(ApprovalMode.DEFAULT)).not.toThrow();
    expect(() => config.setApprovalMode(ApprovalMode.PLAN)).not.toThrow();
  });

  describe('prePlanMode tracking', () => {
    it('should save pre-plan mode when entering plan mode', () => {
      const config = new Config(baseParams);
      vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);

      config.setApprovalMode(ApprovalMode.AUTO_EDIT);
      config.setApprovalMode(ApprovalMode.PLAN);
      expect(config.getPrePlanMode()).toBe(ApprovalMode.AUTO_EDIT);
    });

    it('should clear pre-plan mode when leaving plan mode', () => {
      const config = new Config(baseParams);
      vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);

      config.setApprovalMode(ApprovalMode.AUTO_EDIT);
      config.setApprovalMode(ApprovalMode.PLAN);
      config.setApprovalMode(ApprovalMode.DEFAULT);
      expect(config.getPrePlanMode()).toBe(ApprovalMode.DEFAULT);
    });

    it('should default to DEFAULT when no pre-plan mode was recorded', () => {
      const config = new Config(baseParams);
      expect(config.getPrePlanMode()).toBe(ApprovalMode.DEFAULT);
    });

    it('should not update pre-plan mode when already in plan mode', () => {
      const config = new Config(baseParams);
      vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);

      config.setApprovalMode(ApprovalMode.YOLO);
      config.setApprovalMode(ApprovalMode.PLAN);
      // Setting PLAN again should not overwrite prePlanMode
      config.setApprovalMode(ApprovalMode.PLAN);
      expect(config.getPrePlanMode()).toBe(ApprovalMode.YOLO);
    });

    it('increments the approval mode revision only for actual changes', () => {
      const config = new Config(baseParams);
      vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);

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
      const config = new Config(baseParams);
      vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);

      config.setApprovalMode(ApprovalMode.PLAN);
      config.setApprovalMode(ApprovalMode.DEFAULT);

      expect(config.consumePendingManualPlanExitNotice()).toBe(true);
      // One-shot: consumed on first read.
      expect(config.consumePendingManualPlanExitNotice()).toBe(false);
    });

    it('does not queue the exit notice for an approved plan exit', () => {
      const config = new Config(baseParams);
      vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);

      config.setApprovalMode(ApprovalMode.PLAN);
      config.setApprovalMode(ApprovalMode.DEFAULT, {
        fromApprovedPlanExit: true,
      });

      expect(config.consumePendingManualPlanExitNotice()).toBe(false);
    });

    it('clears a stale exit notice when plan mode is re-entered', () => {
      const config = new Config(baseParams);
      vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);

      config.setApprovalMode(ApprovalMode.PLAN);
      config.setApprovalMode(ApprovalMode.DEFAULT);
      config.setApprovalMode(ApprovalMode.PLAN);

      expect(config.consumePendingManualPlanExitNotice()).toBe(false);
    });

    it('does not queue the exit notice for non-plan mode changes', () => {
      const config = new Config(baseParams);
      vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);

      config.setApprovalMode(ApprovalMode.AUTO_EDIT);
      config.setApprovalMode(ApprovalMode.DEFAULT);

      expect(config.consumePendingManualPlanExitNotice()).toBe(false);
    });

    it('claims the latest non-plan mode and supports a matching restore', () => {
      const config = new Config(baseParams);
      vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);

      config.setApprovalMode(ApprovalMode.PLAN);
      config.setApprovalMode(ApprovalMode.DEFAULT);
      config.setApprovalMode(ApprovalMode.YOLO);

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
      const config = new Config(baseParams);
      vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);

      config.setApprovalMode(ApprovalMode.PLAN);
      config.setApprovalMode(ApprovalMode.DEFAULT);
      const staleNotice = config.takePendingManualPlanExitNotice()!;

      config.setApprovalMode(ApprovalMode.PLAN);
      config.setApprovalMode(ApprovalMode.AUTO_EDIT);
      config.restorePendingManualPlanExitNotice(staleNotice.version);

      const currentNotice = config.takePendingManualPlanExitNotice();
      expect(currentNotice?.version).toBeGreaterThan(staleNotice.version);
      expect(currentNotice?.currentMode).toBe(ApprovalMode.AUTO_EDIT);
      expect(config.takePendingManualPlanExitNotice()).toBeUndefined();
    });

    it('delivers the same inherited event once to each conversation', () => {
      const parent = new Config(baseParams);
      vi.spyOn(parent, 'isTrustedFolder').mockReturnValue(true);
      const child = Object.create(parent) as Config;

      parent.setApprovalMode(ApprovalMode.PLAN);
      parent.setApprovalMode(ApprovalMode.DEFAULT);

      const parentNotice = parent.takePendingManualPlanExitNotice();
      const childNotice = child.takePendingManualPlanExitNotice();
      expect(parentNotice).toEqual(childNotice);
      expect(parent.takePendingManualPlanExitNotice()).toBeUndefined();
      expect(child.takePendingManualPlanExitNotice()).toBeUndefined();
    });

    it('lets a newly created conversation claim the latest inherited event', () => {
      const parent = new Config(baseParams);
      vi.spyOn(parent, 'isTrustedFolder').mockReturnValue(true);

      parent.setApprovalMode(ApprovalMode.PLAN);
      parent.setApprovalMode(ApprovalMode.DEFAULT);
      const parentNotice = parent.takePendingManualPlanExitNotice();
      const child = Object.create(parent) as Config;

      expect(child.takePendingManualPlanExitNotice()).toEqual(parentNotice);
    });

    it('copies the event when a child first owns its approval mode', () => {
      const parent = new Config(baseParams);
      vi.spyOn(parent, 'isTrustedFolder').mockReturnValue(true);
      const child = Object.create(parent) as Config;

      parent.setApprovalMode(ApprovalMode.PLAN);
      parent.setApprovalMode(ApprovalMode.DEFAULT);
      child.setApprovalMode(ApprovalMode.AUTO_EDIT);

      expect(child.takePendingManualPlanExitNotice()?.currentMode).toBe(
        ApprovalMode.AUTO_EDIT,
      );

      parent.setApprovalMode(ApprovalMode.PLAN);
      parent.setApprovalMode(ApprovalMode.DEFAULT);
      expect(child.takePendingManualPlanExitNotice()).toBeUndefined();
      expect(parent.takePendingManualPlanExitNotice()?.currentMode).toBe(
        ApprovalMode.DEFAULT,
      );

      child.setApprovalMode(ApprovalMode.PLAN);
      child.setApprovalMode(ApprovalMode.YOLO);
      expect(child.takePendingManualPlanExitNotice()?.currentMode).toBe(
        ApprovalMode.YOLO,
      );
      expect(parent.takePendingManualPlanExitNotice()).toBeUndefined();
    });

    it('isolates an inherited event when approval mode is owned directly', () => {
      const parent = new Config(baseParams);
      vi.spyOn(parent, 'isTrustedFolder').mockReturnValue(true);
      parent.setApprovalMode(ApprovalMode.PLAN);
      parent.setApprovalMode(ApprovalMode.DEFAULT);

      const child = Object.create(parent) as Config;
      Object.defineProperty(child, 'approvalMode', {
        value: ApprovalMode.AUTO_EDIT,
        writable: true,
        configurable: true,
      });

      expect(child.takePendingManualPlanExitNotice()?.currentMode).toBe(
        ApprovalMode.AUTO_EDIT,
      );

      parent.setApprovalMode(ApprovalMode.PLAN);
      parent.setApprovalMode(ApprovalMode.DEFAULT);
      expect(child.takePendingManualPlanExitNotice()).toBeUndefined();
      expect(parent.takePendingManualPlanExitNotice()?.currentMode).toBe(
        ApprovalMode.DEFAULT,
      );
    });

    it('only exposes the latest event after rapid Plan round trips', () => {
      const config = new Config(baseParams);
      vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);

      config.setApprovalMode(ApprovalMode.PLAN);
      config.setApprovalMode(ApprovalMode.DEFAULT);
      config.setApprovalMode(ApprovalMode.PLAN);
      config.setApprovalMode(ApprovalMode.YOLO);

      expect(config.takePendingManualPlanExitNotice()?.currentMode).toBe(
        ApprovalMode.YOLO,
      );
      expect(config.takePendingManualPlanExitNotice()).toBeUndefined();
    });

    it('records prePlanMode=yolo for a Shift+Tab cycle into plan mode', () => {
      const config = new Config(baseParams);
      vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);

      // Simulate the Shift+Tab cycle order:
      // default → auto-edit → auto → yolo → plan
      config.setApprovalMode(ApprovalMode.AUTO_EDIT);
      config.setApprovalMode(ApprovalMode.AUTO);
      config.setApprovalMode(ApprovalMode.YOLO);
      config.setApprovalMode(ApprovalMode.PLAN);

      expect(config.getPrePlanMode()).toBe(ApprovalMode.YOLO);
    });

    it('does not partially apply plan exit bookkeeping when transition work fails', () => {
      const config = new Config(baseParams);
      vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
      config.setApprovalMode(ApprovalMode.AUTO);
      config.setApprovalMode(ApprovalMode.PLAN);
      const revision = config.getApprovalModeRevision();
      (
        config as unknown as {
          permissionManager: {
            stripDangerousRulesForAutoMode: () => void;
            restoreDangerousRules: () => void;
          };
        }
      ).permissionManager = {
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
    it('should throw an error when setting AUTO mode in an untrusted folder', () => {
      const config = new Config(baseParams);
      vi.spyOn(config, 'isTrustedFolder').mockReturnValue(false);
      expect(() => config.setApprovalMode(ApprovalMode.AUTO)).toThrow(
        'Cannot enable privileged approval modes in an untrusted folder.',
      );
    });

    it('should NOT throw when setting AUTO mode in a trusted folder', () => {
      const config = new Config(baseParams);
      vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
      expect(() => config.setApprovalMode(ApprovalMode.AUTO)).not.toThrow();
    });

    it('should persist AUTO as the active mode', () => {
      const config = new Config(baseParams);
      vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);

      config.setApprovalMode(ApprovalMode.AUTO);
      expect(config.getApprovalMode()).toBe(ApprovalMode.AUTO);
    });

    it('setApprovalMode resets the denial-tracking counters', () => {
      const config = new Config(baseParams);
      vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);

      // Enter AUTO and simulate having accumulated denial counters.
      config.setApprovalMode(ApprovalMode.AUTO);
      config.setAutoModeDenialState({
        consecutiveBlock: 3,
        consecutiveUnavailable: 2,
        totalBlock: 5,
        totalUnavailable: 2,
      });

      // Switch away and back; the counters must be wiped clean.
      config.setApprovalMode(ApprovalMode.DEFAULT);
      expect(config.getAutoModeDenialState()).toEqual({
        consecutiveBlock: 0,
        consecutiveUnavailable: 0,
        totalBlock: 0,
        totalUnavailable: 0,
      });

      // And entering AUTO again should also start fresh (no leftover state).
      config.setAutoModeDenialState({
        consecutiveBlock: 1,
        consecutiveUnavailable: 0,
        totalBlock: 1,
        totalUnavailable: 0,
      });
      config.setApprovalMode(ApprovalMode.AUTO);
      expect(config.getAutoModeDenialState()).toEqual({
        consecutiveBlock: 0,
        consecutiveUnavailable: 0,
        totalBlock: 0,
        totalUnavailable: 0,
      });
    });

    it('setApprovalMode(sameMode) does NOT reset counters', () => {
      const config = new Config(baseParams);
      vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);

      config.setApprovalMode(ApprovalMode.AUTO);
      const populated = {
        consecutiveBlock: 2,
        consecutiveUnavailable: 0,
        totalBlock: 2,
        totalUnavailable: 0,
      };
      config.setAutoModeDenialState(populated);

      // No-op mode set — state should be preserved.
      config.setApprovalMode(ApprovalMode.AUTO);
      expect(config.getAutoModeDenialState()).toEqual(populated);
    });

    it('should track AUTO as prePlanMode when entering PLAN from AUTO', () => {
      const config = new Config(baseParams);
      vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);

      config.setApprovalMode(ApprovalMode.AUTO);
      config.setApprovalMode(ApprovalMode.PLAN);
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
      const config = new Config(baseParams);
      expect(config.getAutoModeSettings()).toEqual({});
    });

    it('returns the provided autoMode classifier settings, hints, and environment', () => {
      const config = new Config({
        ...baseParams,
        permissions: {
          autoMode: {
            classifier: {
              timeouts: {
                stage1Ms: 12_345,
                stage2Ms: 67_890,
              },
              thinking: {
                stage2Enabled: true,
              },
            },
            hints: {
              allow: ['Allow xyz commands'],
              deny: ['Block intranet calls'],
            },
            environment: ['Open-source monorepo'],
          },
        },
      });
      expect(config.getAutoModeSettings()).toEqual({
        classifier: {
          timeouts: {
            stage1Ms: 12_345,
            stage2Ms: 67_890,
          },
          thinking: {
            stage2Enabled: true,
          },
        },
        hints: {
          allow: ['Allow xyz commands'],
          deny: ['Block intranet calls'],
        },
        environment: ['Open-source monorepo'],
      });
    });
  });

  describe('plan file persistence', () => {
    it('should save plan to disk atomically', () => {
      const config = new Config(baseParams);

      config.savePlan('# My Plan\n1. Step one\n2. Step two');

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('plans'),
        { recursive: true },
      );
      // Writes to temp file first
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        '# My Plan\n1. Step one\n2. Step two',
        'utf-8',
      );
      // Then atomically renames to final path
      expect(fs.renameSync).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        expect.stringContaining('.md'),
      );
    });

    it('should load plan from disk', () => {
      const config = new Config(baseParams);
      (fs.readFileSync as Mock).mockReturnValue('# Saved Plan');

      const plan = config.loadPlan();
      expect(plan).toBe('# Saved Plan');
    });

    it('should return undefined when no plan file exists', () => {
      const config = new Config(baseParams);
      const enoentError = new Error('ENOENT') as NodeJS.ErrnoException;
      enoentError.code = 'ENOENT';
      (fs.readFileSync as Mock).mockImplementation(() => {
        throw enoentError;
      });

      const plan = config.loadPlan();
      expect(plan).toBeUndefined();
    });

    it('should rethrow non-ENOENT errors from loadPlan', () => {
      const config = new Config(baseParams);
      const permError = new Error('EACCES') as NodeJS.ErrnoException;
      permError.code = 'EACCES';
      (fs.readFileSync as Mock).mockImplementation(() => {
        throw permError;
      });

      expect(() => config.loadPlan()).toThrow('EACCES');
    });

    it('should use session ID in plan file path', () => {
      const config = new Config({
        ...baseParams,
        sessionId: 'test-session-123',
      });

      const filePath = config.getPlanFilePath();
      expect(filePath).toContain('test-session-123');
      expect(filePath).toMatch(/\.md$/);
    });

    it('should sanitize session ID when building plan file path', () => {
      const config = new Config({
        ...baseParams,
        sessionId: '../../../escape',
        plansDirectory: './project-plans',
      });

      expect(config.getPlanFilePath()).toBe(
        path.join(
          path.resolve(baseParams.targetDir),
          'project-plans',
          'escape.md',
        ),
      );
    });

    it('should use configured plansDirectory for plan file path', () => {
      const config = new Config({
        ...baseParams,
        sessionId: 'test-session-123',
        plansDirectory: './project-plans',
      });

      expect(config.getPlansDir()).toBe(
        path.join(path.resolve(baseParams.targetDir), 'project-plans'),
      );
      expect(config.getPlanFilePath()).toBe(
        path.join(
          path.resolve(baseParams.targetDir),
          'project-plans',
          'test-session-123.md',
        ),
      );
    });

    it('should save and load plan from configured plansDirectory', () => {
      const config = new Config({
        ...baseParams,
        sessionId: 'test-session-123',
        plansDirectory: './project-plans',
      });
      const targetDir = path.resolve(baseParams.targetDir);
      const plansDir = path.join(targetDir, 'project-plans');
      const filePath = path.join(plansDir, 'test-session-123.md');
      const tmpPath = `${filePath}.tmp`;
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
        if (contents === undefined) {
          const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
          enoent.code = 'ENOENT';
          throw enoent;
        }
        return contents;
      });

      config.savePlan('# My Plan');

      expect(fs.mkdirSync).toHaveBeenCalledWith(plansDir, { recursive: true });
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        tmpPath,
        '# My Plan',
        'utf-8',
      );
      expect(fs.renameSync).toHaveBeenCalledWith(tmpPath, filePath);
      expect(config.loadPlan()).toBe('# My Plan');
      expect(fs.readFileSync).toHaveBeenCalledWith(filePath, 'utf-8');
    });

    it('saves a plan on a derived agent config whose cwd differs from the project root', () => {
      const config = new Config({
        ...baseParams,
        sessionId: 'test-session-123',
        plansDirectory: './project-plans',
      });
      // A teammate's working directory outside the parent project root.
      // The plan file still belongs to the parent's configured plans
      // directory, so the containment assertions must anchor at the
      // plans-owning base Config, not at the agent's workspace.
      const { config: agentConfig } = deriveAgentConfig(
        config,
        '/elsewhere/agent-cwd',
      );
      const targetDir = path.resolve(baseParams.targetDir);
      const plansDir = path.join(targetDir, 'project-plans');
      const filePath = path.join(plansDir, 'test-session-123.md');
      const tmpPath = `${filePath}.tmp`;
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
        if (contents === undefined) {
          const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
          enoent.code = 'ENOENT';
          throw enoent;
        }
        return contents;
      });

      expect(() => agentConfig.savePlan('# My Plan')).not.toThrow();

      expect(fs.mkdirSync).toHaveBeenCalledWith(plansDir, { recursive: true });
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        tmpPath,
        '# My Plan',
        'utf-8',
      );
      expect(fs.renameSync).toHaveBeenCalledWith(tmpPath, filePath);
      expect(agentConfig.loadPlan()).toBe('# My Plan');
      expect(config.getTargetDir()).toBe(targetDir);
    });

    it('should fall back to copyFileSync when renameSync hits EXDEV', () => {
      const config = new Config({
        ...baseParams,
        sessionId: 'test-session-123',
        plansDirectory: './project-plans',
      });
      const exdevError = new Error('EXDEV') as NodeJS.ErrnoException;
      exdevError.code = 'EXDEV';
      (fs.renameSync as Mock).mockImplementation(() => {
        throw exdevError;
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
      const config = new Config({
        ...baseParams,
        sessionId: 'test-session-123',
        plansDirectory: './project-plans',
      });
      const targetDir = path.resolve(baseParams.targetDir);
      const plansDir = path.join(targetDir, 'project-plans');
      const filePath = path.join(plansDir, 'test-session-123.md');
      const outsideFilePath = path.resolve(
        path.dirname(targetDir),
        'outside-plans',
        'test-session-123.md',
      );
      vi.mocked(fs.realpathSync).mockImplementation((pathToResolve) => {
        const resolvedPath = pathToResolve.toString();
        if (resolvedPath === targetDir || resolvedPath === plansDir) {
          return resolvedPath;
        }
        if (resolvedPath === filePath) {
          return outsideFilePath;
        }
        return resolvedPath;
      });

      try {
        expect(() => config.savePlan('# My Plan')).toThrow(
          'plansDirectory must resolve within the project root',
        );
        expect(fs.unlinkSync).toHaveBeenCalledWith(filePath);
      } finally {
        vi.mocked(fs.realpathSync).mockImplementation((pathToResolve) =>
          pathToResolve.toString(),
        );
      }
    });

    it('should reject loading a plan when final file path escapes targetDir', () => {
      const config = new Config({
        ...baseParams,
        sessionId: 'test-session-123',
        plansDirectory: './project-plans',
      });
      const targetDir = path.resolve(baseParams.targetDir);
      const plansDir = path.join(targetDir, 'project-plans');
      const filePath = path.join(plansDir, 'test-session-123.md');
      const outsideFilePath = path.resolve(
        path.dirname(targetDir),
        'outside-plans',
        'test-session-123.md',
      );
      vi.mocked(fs.readFileSync).mockClear();
      vi.mocked(fs.realpathSync).mockImplementation((pathToResolve) => {
        const resolvedPath = pathToResolve.toString();
        if (resolvedPath === targetDir || resolvedPath === plansDir) {
          return resolvedPath;
        }
        if (resolvedPath === filePath) {
          return outsideFilePath;
        }
        return resolvedPath;
      });

      try {
        expect(() => config.loadPlan()).toThrow(
          'plansDirectory must resolve within the project root',
        );
        expect(fs.readFileSync).not.toHaveBeenCalled();
      } finally {
        vi.mocked(fs.realpathSync).mockImplementation((pathToResolve) =>
          pathToResolve.toString(),
        );
      }
    });

    it('should warn when configured plansDirectory hides a legacy plan file', () => {
      const targetDir = path.resolve(baseParams.targetDir);
      const currentPlansDir = path.join(targetDir, 'project-plans');
      const legacyPlansDir = Storage.getPlansDir();
      (fs.readdirSync as Mock).mockImplementation((pathToCheck) => {
        const resolvedPath = pathToCheck.toString();
        if (resolvedPath === currentPlansDir) {
          return [];
        }
        if (resolvedPath === legacyPlansDir) {
          return ['other-session.md'];
        }
        return [];
      });

      try {
        const config = new Config({
          ...baseParams,
          plansDirectory: './project-plans',
        });

        expect(config.getWarnings()).toContainEqual(
          expect.stringContaining(legacyPlansDir),
        );
        expect(config.getWarnings()).toContainEqual(
          expect.stringContaining('plansDirectory is configured'),
        );
      } finally {
        (fs.readdirSync as Mock).mockReturnValue([]);
      }
    });

    it('should warn when configured plansDirectory has only some legacy plan files', () => {
      const targetDir = path.resolve(baseParams.targetDir);
      const currentPlansDir = path.join(targetDir, 'project-plans');
      const legacyPlansDir = Storage.getPlansDir();
      (fs.readdirSync as Mock).mockImplementation((pathToCheck) => {
        const resolvedPath = pathToCheck.toString();
        if (resolvedPath === currentPlansDir) {
          return ['migrated-session.md'];
        }
        if (resolvedPath === legacyPlansDir) {
          return ['migrated-session.md', 'hidden-session.md'];
        }
        return [];
      });

      try {
        const config = new Config({
          ...baseParams,
          plansDirectory: './project-plans',
        });

        expect(config.getWarnings()).toContainEqual(
          expect.stringContaining(legacyPlansDir),
        );
      } finally {
        (fs.readdirSync as Mock).mockReturnValue([]);
      }
    });

    it('should surface legacy plan directory read failures as warnings', () => {
      const legacyError = new Error('EACCES') as NodeJS.ErrnoException;
      legacyError.code = 'EACCES';
      (fs.readdirSync as Mock).mockImplementation((pathToCheck) => {
        const resolvedPath = pathToCheck.toString();
        if (
          resolvedPath ===
          path.join(path.resolve(baseParams.targetDir), 'project-plans')
        ) {
          return [];
        }
        throw legacyError;
      });

      try {
        const config = new Config({
          ...baseParams,
          plansDirectory: './project-plans',
        });

        expect(config.getWarnings()).toContainEqual(
          expect.stringContaining('Failed to read plan directory'),
        );
      } finally {
        (fs.readdirSync as Mock).mockReturnValue([]);
      }
    });

    it('should reject configured plansDirectory outside targetDir', () => {
      expect(
        () =>
          new Config({
            ...baseParams,
            plansDirectory: '../project-plans',
          }),
      ).toThrow('plansDirectory must resolve within the project root');
    });

    it('should revalidate configured plansDirectory before plan I/O', () => {
      const config = new Config({
        ...baseParams,
        plansDirectory: './project-plans',
      });
      vi.mocked(fs.mkdirSync).mockClear();
      vi.mocked(fs.readFileSync).mockClear();
      const targetDir = path.resolve(baseParams.targetDir);
      const plansDir = path.join(targetDir, 'project-plans');
      const outsidePlansDir = path.resolve(
        path.dirname(targetDir),
        'outside-plans',
      );
      vi.mocked(fs.realpathSync).mockImplementation((pathToResolve) => {
        const resolvedPath = pathToResolve.toString();
        if (resolvedPath === targetDir) {
          return targetDir;
        }
        if (resolvedPath === plansDir) {
          return outsidePlansDir;
        }
        return resolvedPath;
      });

      try {
        expect(() => config.savePlan('# My Plan')).toThrow(
          'plansDirectory must resolve within the project root',
        );
        expect(() => config.loadPlan()).toThrow(
          'plansDirectory must resolve within the project root',
        );
        expect(fs.mkdirSync).not.toHaveBeenCalled();
        expect(fs.readFileSync).not.toHaveBeenCalled();
      } finally {
        vi.mocked(fs.realpathSync).mockImplementation((pathToResolve) =>
          pathToResolve.toString(),
        );
      }
    });
  });

  describe('registerCoreTools', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('registers the background-agent roster tool', async () => {
      const config = new Config(baseParams);
      await config.initialize();

      const calls = (ToolRegistry.prototype.registerFactory as Mock).mock.calls;
      expect(calls.some((call) => call[0] === ToolNames.LIST_AGENTS)).toBe(
        true,
      );
    });

    it('should register grep tool when useRipgrep is true and it is available', async () => {
      (canUseRipgrep as Mock).mockResolvedValue(true);
      const config = new Config({ ...baseParams, useRipgrep: true });
      await config.initialize();

      const calls = (ToolRegistry.prototype.registerFactory as Mock).mock.calls;
      const grepRegistrations = calls.filter(
        (call) => call[0] === ToolNames.GREP,
      );

      // Exactly one grep tool should be registered
      expect(grepRegistrations.length).toBe(1);
      expect(canUseRipgrep).toHaveBeenCalledWith(true);
    });

    it('should register grep tool with system ripgrep when useBuiltinRipgrep is false', async () => {
      (canUseRipgrep as Mock).mockResolvedValue(true);
      const config = new Config({
        ...baseParams,
        useRipgrep: true,
        useBuiltinRipgrep: false,
      });
      await config.initialize();

      const calls = (ToolRegistry.prototype.registerFactory as Mock).mock.calls;
      const grepRegistrations = calls.filter(
        (call) => call[0] === ToolNames.GREP,
      );

      expect(grepRegistrations.length).toBe(1);
      expect(canUseRipgrep).toHaveBeenCalledWith(false);
    });

    it('should fall back to GrepTool and log error when useBuiltinRipgrep is false but system ripgrep is not available', async () => {
      (canUseRipgrep as Mock).mockResolvedValue(false);
      const config = new Config({
        ...baseParams,
        useRipgrep: true,
        useBuiltinRipgrep: false,
      });
      await config.initialize();

      const calls = (ToolRegistry.prototype.registerFactory as Mock).mock.calls;
      const grepRegistrations = calls.filter(
        (call) => call[0] === ToolNames.GREP,
      );

      expect(grepRegistrations.length).toBe(1);
      expect(canUseRipgrep).toHaveBeenCalledWith(false);
      expect(logRipgrepFallback).toHaveBeenCalledWith(
        config,
        expect.any(RipgrepFallbackEvent),
      );
      const event = (logRipgrepFallback as Mock).mock.calls[0][1];
      expect(event.error).toContain('ripgrep is not available');
    });

    it('should fall back to GrepTool and log error when useRipgrep is true and builtin ripgrep is not available', async () => {
      (canUseRipgrep as Mock).mockResolvedValue(false);
      const config = new Config({ ...baseParams, useRipgrep: true });
      await config.initialize();

      const calls = (ToolRegistry.prototype.registerFactory as Mock).mock.calls;
      const grepRegistrations = calls.filter(
        (call) => call[0] === ToolNames.GREP,
      );

      expect(grepRegistrations.length).toBe(1);
      expect(canUseRipgrep).toHaveBeenCalledWith(true);
      expect(logRipgrepFallback).toHaveBeenCalledWith(
        config,
        expect.any(RipgrepFallbackEvent),
      );
      const event = (logRipgrepFallback as Mock).mock.calls[0][1];
      expect(event.error).toContain('ripgrep is not available');
    });

    it('should fall back to GrepTool and log error when canUseRipgrep throws an error', async () => {
      const error = new Error('ripGrep check failed');
      (canUseRipgrep as Mock).mockRejectedValue(error);
      const config = new Config({ ...baseParams, useRipgrep: true });
      await config.initialize();

      const calls = (ToolRegistry.prototype.registerFactory as Mock).mock.calls;
      const grepRegistrations = calls.filter(
        (call) => call[0] === ToolNames.GREP,
      );

      expect(grepRegistrations.length).toBe(1);
      expect(logRipgrepFallback).toHaveBeenCalledWith(
        config,
        expect.any(RipgrepFallbackEvent),
      );
      const event = (logRipgrepFallback as Mock).mock.calls[0][1];
      expect(event.error).toBe(`ripGrep check failed`);
    });

    it('should register GrepTool when useRipgrep is false', async () => {
      const config = new Config({ ...baseParams, useRipgrep: false });
      await config.initialize();

      const calls = (ToolRegistry.prototype.registerFactory as Mock).mock.calls;
      const grepRegistrations = calls.filter(
        (call) => call[0] === ToolNames.GREP,
      );

      expect(grepRegistrations.length).toBe(1);
      expect(canUseRipgrep).not.toHaveBeenCalled();
    });
  });
});

describe('disabledTools runtime sync (#4282 fold-in 5 P2-2 / #4297 fold-in 5)', () => {
  const baseParams: ConfigParameters = {
    targetDir: '.',
    debugMode: false,
    model: 'test-model',
    cwd: '.',
    chatRecording: false,
  };

  it('initializes from `disabledTools` ConfigParameters', () => {
    const config = new Config({
      ...baseParams,
      disabledTools: ['Foo', 'Bar'],
    });
    expect(config.getDisabledTools()).toEqual(new Set(['Foo', 'Bar']));
  });

  it('defaults to an empty set when `disabledTools` is omitted', () => {
    const config = new Config(baseParams);
    expect(config.getDisabledTools()).toEqual(new Set());
  });

  it('setDisabledTools replaces the live snapshot for runtime sync', () => {
    // The daemon's `acpAgent` MCP-restart handler calls
    // `setDisabledTools(new Set(disabledList))` after re-reading
    // workspace settings, so a `tools.disabled` toggle applied
    // since this Config was constructed takes effect on the next
    // `ToolRegistry.registerTool` call. Pin that contract so a
    // future regression that drops the setter (or re-freezes the
    // field) fails this test instead of silently re-enabling
    // tools the user just disabled.
    const config = new Config({
      ...baseParams,
      disabledTools: ['A', 'B'],
    });
    expect(config.getDisabledTools()).toEqual(new Set(['A', 'B']));
    config.setDisabledTools(new Set(['B', 'C']));
    expect(config.getDisabledTools()).toEqual(new Set(['B', 'C']));
  });

  it('setDisabledTools copies the input — caller mutations do not leak', () => {
    // The setter constructs a fresh `new Set(disabled)` from the
    // input, so a caller that holds a reference to the input set
    // and later mutates it cannot retroactively change the live
    // Config snapshot. Locks this defensive-copy contract.
    const config = new Config(baseParams);
    const liveInput = new Set(['X']);
    config.setDisabledTools(liveInput);
    liveInput.add('Y');
    expect(config.getDisabledTools()).toEqual(new Set(['X']));
    expect(config.getDisabledTools().has('Y')).toBe(false);
  });

  it('setDisabledTools accepts an empty set (clears the live snapshot)', () => {
    const config = new Config({
      ...baseParams,
      disabledTools: ['A', 'B'],
    });
    config.setDisabledTools(new Set());
    expect(config.getDisabledTools()).toEqual(new Set());
  });
});

describe('visibleTools', () => {
  const baseParams: ConfigParameters = {
    targetDir: '.',
    debugMode: false,
    model: 'test-model',
    cwd: '.',
    chatRecording: false,
  };

  it('initializes from `visibleTools` ConfigParameters', () => {
    const config = new Config({
      ...baseParams,
      visibleTools: ['Foo', 'Bar'],
    });
    expect(config.getVisibleTools()).toEqual(new Set(['Foo', 'Bar']));
  });

  it('defaults to an empty set when `visibleTools` is omitted', () => {
    const config = new Config(baseParams);
    expect(config.getVisibleTools()).toEqual(new Set());
  });

  it('filters out non-string entries', () => {
    const config = new Config({
      ...baseParams,
      visibleTools: [
        'tool_a',
        42 as unknown as string,
        null as unknown as string,
        'tool_b',
      ],
    });
    expect(config.getVisibleTools()).toEqual(new Set(['tool_a', 'tool_b']));
  });

  it('is readonly — returned set preserves config state', () => {
    const config = new Config({
      ...baseParams,
      visibleTools: ['web_fetch'],
    });
    const set = config.getVisibleTools();
    expect(set.has('web_fetch')).toBe(true);
    // always returns the same reference
    expect(config.getVisibleTools()).toBe(set);
  });
});

describe('BaseLlmClient Lifecycle', () => {
  const MODEL = 'gemini-pro';
  const SANDBOX: SandboxConfig = {
    command: 'docker',
    image: 'gemini-cli-sandbox',
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
  };

  it('should throw an error if getBaseLlmClient is called before refreshAuth', () => {
    const config = new Config(baseParams);
    expect(() => config.getBaseLlmClient()).toThrow(
      'BaseLlmClient not initialized. Ensure authentication has occurred and ContentGenerator is ready.',
    );
  });

  it('should successfully initialize BaseLlmClient after refreshAuth is called', async () => {
    const config = new Config(baseParams);
    const authType = AuthType.USE_GEMINI;
    const mockContentConfig = { model: 'gemini-flash', apiKey: 'test-key' };

    vi.mocked(resolveContentGeneratorConfigWithSources).mockReturnValue({
      config: mockContentConfig,
      sources: {},
    });

    await config.refreshAuth(authType);

    // Should not throw
    const llmService = config.getBaseLlmClient();
    expect(llmService).toBeDefined();
    expect(BaseLlmClient).toHaveBeenCalledWith(
      config.getContentGenerator(),
      config,
    );
  });

  it('clears per-model generators when provider config is reloaded', async () => {
    const config = new Config(baseParams);
    vi.mocked(resolveContentGeneratorConfigWithSources).mockReturnValue({
      config: { model: 'gemini-flash', apiKey: 'test-key' },
      sources: {},
    });
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

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should update contextWindowSize when switching models with hot-update', async () => {
    const config = new Config(baseParams);

    // Initialize with first model
    const initialConfig: ContentGeneratorConfig = {
      ['model']: 'qwen3-coder-plus',
      ['authType']: AuthType.QWEN_OAUTH,
      ['apiKey']: 'test-key',
      ['contextWindowSize']: 1_000_000,
      ['samplingParams']: { temperature: 0.7 },
      ['enableCacheControl']: true,
      ['forceGlobalCacheScope']: true,
    };

    vi.mocked(resolveContentGeneratorConfigWithSources).mockReturnValue({
      config: initialConfig,
      sources: {
        model: { kind: 'settings' },
        contextWindowSize: { kind: 'computed', detail: 'auto' },
      },
    });

    await config.refreshAuth(AuthType.QWEN_OAUTH);

    // Verify initial config
    const contentGenConfig = config.getContentGeneratorConfig();
    expect(contentGenConfig['model']).toBe('qwen3-coder-plus');
    expect(contentGenConfig['contextWindowSize']).toBe(1_000_000);

    // Switch to a different model with different token limits
    const newConfig: ContentGeneratorConfig = {
      ['model']: 'qwen-max',
      ['authType']: AuthType.QWEN_OAUTH,
      ['apiKey']: 'test-key',
      ['contextWindowSize']: 128_000,
      ['samplingParams']: { temperature: 0.8 },
      ['enableCacheControl']: false,
      ['forceGlobalCacheScope']: false,
      ['toolResultContentFormat']: 'string',
      ['modalities']: { image: true },
    };

    vi.mocked(resolveContentGeneratorConfigWithSources).mockReturnValue({
      config: newConfig,
      sources: {
        model: { kind: 'programmatic', detail: 'user' },
        contextWindowSize: { kind: 'computed', detail: 'auto' },
        samplingParams: { kind: 'settings' },
        enableCacheControl: { kind: 'settings' },
        forceGlobalCacheScope: { kind: 'settings' },
        toolResultContentFormat: { kind: 'settings' },
        modalities: { kind: 'computed', detail: 'auto' },
      },
    });

    // Simulate model switch (this would be called by ModelsConfig.switchModel)
    await (
      config as unknown as {
        handleModelChange: (
          authType: AuthType,
          requiresRefresh: boolean,
        ) => Promise<void>;
      }
    ).handleModelChange(AuthType.QWEN_OAUTH, false);

    // Verify all fields are updated
    const updatedConfig = config.getContentGeneratorConfig();
    expect(updatedConfig['model']).toBe('qwen-max');
    expect(updatedConfig['contextWindowSize']).toBe(128_000);
    expect(updatedConfig['samplingParams']?.temperature).toBe(0.8);
    expect(updatedConfig['enableCacheControl']).toBe(false);
    expect(updatedConfig['forceGlobalCacheScope']).toBe(false);
    expect(updatedConfig['toolResultContentFormat']).toBe('string');
    // Modalities are model-derived; a hot switch must refresh them so the
    // vision-bridge gate reflects the new model (it reads getEffectiveInputModalities()).
    expect(updatedConfig['modalities']).toEqual({ image: true });
    expect(config.getEffectiveInputModalities()).toEqual({ image: true });

    // Verify sources are also updated
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

  it('should trigger full refresh when switching to non-qwen-oauth provider', async () => {
    const config = new Config(baseParams);

    // Initialize with qwen-oauth
    const initialConfig: ContentGeneratorConfig = {
      ['model']: 'qwen3-coder-plus',
      ['authType']: AuthType.QWEN_OAUTH,
      ['apiKey']: 'test-key',
      ['contextWindowSize']: 1_000_000,
    };

    vi.mocked(resolveContentGeneratorConfigWithSources).mockReturnValue({
      config: initialConfig,
      sources: {},
    });

    await config.refreshAuth(AuthType.QWEN_OAUTH);

    // Switch to different auth type (should trigger full refresh)
    const newConfig: ContentGeneratorConfig = {
      ['model']: 'gemini-flash',
      ['authType']: AuthType.USE_GEMINI,
      ['apiKey']: 'gemini-key',
      ['contextWindowSize']: 32_000,
    };

    vi.mocked(resolveContentGeneratorConfigWithSources).mockReturnValue({
      config: newConfig,
      sources: {},
    });

    const refreshAuthSpy = vi.spyOn(
      config as unknown as {
        refreshAuth: (authType: AuthType) => Promise<void>;
      },
      'refreshAuth',
    );

    // Simulate model switch with different auth type
    await (
      config as unknown as {
        handleModelChange: (
          authType: AuthType,
          requiresRefresh: boolean,
        ) => Promise<void>;
      }
    ).handleModelChange(AuthType.USE_GEMINI, true);

    // Verify refreshAuth was called (full refresh path)
    expect(refreshAuthSpy).toHaveBeenCalledWith(AuthType.USE_GEMINI);
  });

  it('should handle model switch when contextWindowSize is undefined', async () => {
    const config = new Config(baseParams);

    // Initialize with config that has undefined token limits
    const initialConfig: ContentGeneratorConfig = {
      ['model']: 'qwen3-coder-plus',
      ['authType']: AuthType.QWEN_OAUTH,
      ['apiKey']: 'test-key',
      ['contextWindowSize']: undefined,
    };

    vi.mocked(resolveContentGeneratorConfigWithSources).mockReturnValue({
      config: initialConfig,
      sources: {},
    });

    await config.refreshAuth(AuthType.QWEN_OAUTH);

    // Switch to model with defined limits
    const newConfig: ContentGeneratorConfig = {
      ['model']: 'qwen-max',
      ['authType']: AuthType.QWEN_OAUTH,
      ['apiKey']: 'test-key',
      ['contextWindowSize']: 128_000,
    };

    vi.mocked(resolveContentGeneratorConfigWithSources).mockReturnValue({
      config: newConfig,
      sources: {},
    });

    await (
      config as unknown as {
        handleModelChange: (
          authType: AuthType,
          requiresRefresh: boolean,
        ) => Promise<void>;
      }
    ).handleModelChange(AuthType.QWEN_OAUTH, false);

    // Verify limits are now defined
    const updatedConfig = config.getContentGeneratorConfig();
    expect(updatedConfig['contextWindowSize']).toBe(128_000);
  });

  describe('hasHooksForEvent', () => {
    it('should return false when hookSystem is not initialized', () => {
      const config = new Config(baseParams);
      expect(config.hasHooksForEvent('Stop')).toBe(false);
    });

    it('should delegate to hookSystem.hasHooksForEvent when hookSystem exists', () => {
      const config = new Config(baseParams);
      const mockHasHooksForEvent = vi.fn().mockReturnValue(true);
      const mockHookSystem = {
        hasHooksForEvent: mockHasHooksForEvent,
      };
      // @ts-expect-error - accessing private for testing
      config['hookSystem'] = mockHookSystem;

      expect(config.hasHooksForEvent('UserPromptSubmit')).toBe(true);
      expect(mockHasHooksForEvent).toHaveBeenCalledWith(
        'UserPromptSubmit',
        expect.any(String),
      );
    });

    it('should return false when hookSystem has no hooks for the event', () => {
      const config = new Config(baseParams);
      const mockHasHooksForEvent = vi.fn().mockReturnValue(false);
      const mockHookSystem = {
        hasHooksForEvent: mockHasHooksForEvent,
      };
      // @ts-expect-error - accessing private for testing
      config['hookSystem'] = mockHookSystem;

      expect(config.hasHooksForEvent('Stop')).toBe(false);
      expect(mockHasHooksForEvent).toHaveBeenCalledWith(
        'Stop',
        expect.any(String),
      );
    });
  });

  describe('runtime ContentGenerator view (AsyncLocalStorage)', () => {
    // The Config getters consult the per-run ALS view published by the
    // agent runtime when a sub-agent runs on a different model than the
    // parent. These tests pin that integration: tools that captured the
    // parent Config at construction must still resolve to the agent's
    // values when called inside the agent's runtime frame.
    function setInstanceFields(
      config: Config,
      contentGenerator: ContentGenerator,
      generatorConfig: ContentGeneratorConfig,
    ): void {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config as any).contentGenerator = contentGenerator;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config as any).contentGeneratorConfig = generatorConfig;
    }

    it('resolves getters to the runtime view inside the frame, instance fields outside', async () => {
      const { runWithRuntimeContentGenerator } = await import(
        '../agents/runtime/agent-context.js'
      );
      const config = new Config(baseParams);
      const parentGenerator = {
        generateContentStream: vi.fn(),
      } as unknown as ContentGenerator;
      const parentGeneratorConfig: ContentGeneratorConfig = {
        model: 'parent-model',
        authType: AuthType.QWEN_OAUTH,
        apiKey: 'parent-key',
      };
      setInstanceFields(config, parentGenerator, parentGeneratorConfig);

      const agentGenerator = {
        generateContentStream: vi.fn(),
      } as unknown as ContentGenerator;
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
      const config = new Config(baseParams);
      setInstanceFields(
        config,
        { generateContentStream: vi.fn() } as unknown as ContentGenerator,
        {
          model: 'parent-model',
          authType: AuthType.QWEN_OAUTH,
        } as ContentGeneratorConfig,
      );

      await runWithRuntimeContentGenerator(
        {
          contentGenerator: {
            generateContentStream: vi.fn(),
          } as unknown as ContentGenerator,
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

  describe('Config runtime MCP overlay', () => {
    it('addRuntimeMcpServer does not mutate this.mcpServers', () => {
      const config = new Config({
        ...baseParams,
        mcpServers: {
          'settings-server': new MCPServerConfig('cmd-a'),
        },
      });
      // Simulate post-init state
      (config as unknown as { initialized: boolean }).initialized = true;
      config.addRuntimeMcpServer(
        'runtime-server',
        new MCPServerConfig('cmd-b'),
      );
      const settingsLayer = (
        config as unknown as {
          mcpServers: Record<string, MCPServerConfig>;
        }
      ).mcpServers;
      expect(Object.keys(settingsLayer)).toEqual(['settings-server']);
      expect(settingsLayer['runtime-server']).toBeUndefined();
    });

    it('removeRuntimeMcpServer returns false when name not present', () => {
      const config = new Config(baseParams);
      expect(config.removeRuntimeMcpServer('does-not-exist')).toBe(false);
    });

    it('removeRuntimeMcpServer returns true and drops the entry', () => {
      const config = new Config(baseParams);
      (config as unknown as { initialized: boolean }).initialized = true;
      config.addRuntimeMcpServer('x', new MCPServerConfig('cmd'));
      expect(config.removeRuntimeMcpServer('x')).toBe(true);
      expect(config.removeRuntimeMcpServer('x')).toBe(false);
    });
  });

  describe('getMcpServers cascade with runtime overlay', () => {
    it('runtime layer overlays settings layer (last write wins)', () => {
      const config = new Config({
        ...baseParams,
        mcpServers: {
          shared: new MCPServerConfig('settings-cmd'),
        },
      });
      (config as unknown as { initialized: boolean }).initialized = true;
      config.addRuntimeMcpServer('shared', new MCPServerConfig('runtime-cmd'));
      const merged = config.getMcpServers();
      expect(merged!['shared'].command).toBe('runtime-cmd');
    });

    it('runtime-only entries appear in cascade', () => {
      const config = new Config({ ...baseParams, mcpServers: {} });
      (config as unknown as { initialized: boolean }).initialized = true;
      config.addRuntimeMcpServer('only-runtime', new MCPServerConfig('cmd'));
      const merged = config.getMcpServers();
      expect(merged!['only-runtime']).toBeDefined();
    });

    it('removing runtime entry restores settings entry', () => {
      const config = new Config({
        ...baseParams,
        mcpServers: {
          shared: new MCPServerConfig('settings-cmd'),
        },
      });
      (config as unknown as { initialized: boolean }).initialized = true;
      config.addRuntimeMcpServer('shared', new MCPServerConfig('runtime-cmd'));
      expect(config.getMcpServers()!['shared'].command).toBe('runtime-cmd');
      config.removeRuntimeMcpServer('shared');
      expect(config.getMcpServers()!['shared'].command).toBe('settings-cmd');
    });

    it('isMcpServerDisabled still flags runtime entries when excluded', () => {
      const config = new Config({ ...baseParams });
      (config as unknown as { initialized: boolean }).initialized = true;
      config.addRuntimeMcpServer('blocked', new MCPServerConfig('cmd'));
      config.setExcludedMcpServers(['blocked']);
      // The entry appears in getMcpServers (UI layer filters via isMcpServerDisabled)
      expect(config.getMcpServers()!['blocked']).toBeDefined();
      expect(config.isMcpServerDisabled('blocked')).toBe(true);
    });
  });

  describe('getModelDisplayName', () => {
    it('should return resolved name when model is in registry', () => {
      const config = new Config({
        ...baseParams,
        authType: AuthType.USE_OPENAI,
        model: 'gpt-4o',
        modelProvidersConfig: {
          [AuthType.USE_OPENAI]: [
            {
              id: 'gpt-4o',
              name: 'GPT-4o',
              baseUrl: 'https://api.openai.example.com/v1',
              envKey: 'OPENAI_API_KEY',
            },
          ],
        },
      });

      expect(config.getModelDisplayName()).toBe('GPT-4o');
    });

    it('should return raw modelId when model is not in registry', () => {
      const config = new Config({
        ...baseParams,
        authType: AuthType.USE_OPENAI,
        model: 'custom-runtime-model',
        modelProvidersConfig: {
          [AuthType.USE_OPENAI]: [
            {
              id: 'gpt-4o',
              name: 'GPT-4o',
              baseUrl: 'https://api.openai.example.com/v1',
              envKey: 'OPENAI_API_KEY',
            },
          ],
        },
      });

      expect(config.getModelDisplayName()).toBe('custom-runtime-model');
    });

    it('should return raw modelId when currentAuthType is falsy', () => {
      const config = new Config({
        ...baseParams,
        model: 'some-model',
        // authType is not set
      });

      // getModel() returns 'some-model', getModelDisplayName returns it as-is
      // because currentAuthType is falsy
      expect(config.getModelDisplayName()).toBe('some-model');
    });
  });

  describe('getAutoSkillConfirmEnabled', () => {
    it('defaults to true when autoSkillConfirm is unset', () => {
      const config = new Config({ ...baseParams });
      expect(config.getAutoSkillConfirmEnabled()).toBe(true);
    });

    it('returns false when autoSkillConfirm is explicitly disabled', () => {
      const config = new Config({ ...baseParams, autoSkillConfirm: false });
      expect(config.getAutoSkillConfirmEnabled()).toBe(false);
    });

    it('is forced false in bare mode even when autoSkillConfirm is true', () => {
      const config = new Config({
        ...baseParams,
        autoSkillConfirm: true,
        bareMode: true,
      });
      expect(config.getAutoSkillConfirmEnabled()).toBe(false);
    });
  });

  describe('MCP Stop dispatch with context usage data', () => {
    it('buildContextUsage handles MCP input patterns with runtime validation', async () => {
      // Test the buildContextUsage function that's used in MCP Stop dispatch
      // This validates the runtime type coercion and edge cases
      const { buildContextUsage } = await import('../hooks/context-usage.js');

      // Normal case: valid numbers
      expect(buildContextUsage(128000, 64000)).toEqual({
        context_usage: 0.5,
        context_limit: 128000,
        input_tokens: 64000,
      });

      // Missing context_limit: returns undefined
      expect(buildContextUsage(undefined, 64000)).toBeUndefined();

      // Missing input_tokens (defaults to 0): returns undefined
      expect(buildContextUsage(128000, 0)).toBeUndefined();

      // Both missing: returns undefined
      expect(buildContextUsage(undefined, 0)).toBeUndefined();

      // String values (MCP might send strings): Number.isFinite rejects strings
      // @ts-expect-error - testing runtime validation
      expect(buildContextUsage('128000', 64000)).toBeUndefined();

      // Invalid string values: returns undefined
      // @ts-expect-error - testing runtime validation
      expect(buildContextUsage('invalid', 64000)).toBeUndefined();

      // Negative values: returns undefined
      expect(buildContextUsage(-128000, 64000)).toBeUndefined();
      expect(buildContextUsage(128000, -64000)).toBeUndefined();

      // Zero context_limit: returns undefined
      expect(buildContextUsage(0, 64000)).toBeUndefined();
    });
  });

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
      const config = new Config({ ...baseParams });
      await config.initialize();

      const fireUserPromptSubmitEvent = vi.fn().mockResolvedValue(undefined);
      // @ts-expect-error - accessing private for testing
      config['hookSystem'] = { fireUserPromptSubmitEvent };

      const response = await config
        .getMessageBus()!
        .request<HookExecutionRequest, HookExecutionResponse>(
          {
            type: MessageBusType.HOOK_EXECUTION_REQUEST,
            eventName: 'UserPromptSubmit',
            input: {
              prompt: 'model prompt',
              submitted_prompt: submittedPrompt,
            },
          },
          MessageBusType.HOOK_EXECUTION_RESPONSE,
        );

      expect(fireUserPromptSubmitEvent).toHaveBeenCalledWith(
        'model prompt',
        undefined,
        expected,
      );
      expect(response.success).toBe(true);
    });
  });

  describe('Stop dispatch through the hook execution bridge', () => {
    it.each([
      {
        name: 'ignores non-blocking outputs',
        otherOutput: { continue: true },
        expected: false,
        expectedReason: undefined,
      },
      {
        name: 'detects another blocking output',
        otherOutput: {
          decision: 'block',
          reason: 'Policy review is still required',
        },
        expected: true,
        expectedReason: 'Policy review is still required',
      },
      {
        name: 'preserves a stop reason',
        otherOutput: {
          continue: false,
          stopReason: 'External stop hook feedback',
        },
        expected: true,
        expectedReason: 'External stop hook feedback',
      },
    ])(
      '$name when a goal hook blocks',
      async ({ otherOutput, expected, expectedReason }) => {
        const config = new Config({ ...baseParams });
        await config.initialize();
        const goalOutput = {
          decision: 'block' as const,
          reason: 'Keep working',
          hookSpecificOutput: {
            [GOAL_HOOK_ID_OUTPUT_KEY]: 'goal-hook-id',
          },
        };
        const fireStopEvent = vi.fn().mockResolvedValue({
          finalOutput: {
            ...goalOutput,
            ...otherOutput,
          },
          allOutputs: [goalOutput, otherOutput],
        });
        // @ts-expect-error - accessing private for testing
        config['hookSystem'] = { fireStopEvent };

        const response = await config
          .getMessageBus()!
          .request<HookExecutionRequest, HookExecutionResponse>(
            {
              type: MessageBusType.HOOK_EXECUTION_REQUEST,
              eventName: 'Stop',
              input: {
                stop_hook_active: true,
                last_assistant_message: 'last response',
              },
            },
            MessageBusType.HOOK_EXECUTION_RESPONSE,
          );

        expect(response.error).toBeUndefined();
        expect(response).toMatchObject({
          success: true,
          hasNonGoalBlockingStopHook: expected,
        });
        expect(response.nonGoalBlockingStopReason).toBe(expectedReason);
      },
    );
  });

  describe('MessageDisplay dispatch through the hook execution bridge', () => {
    it('extracts message_id/displayed_text/is_final from the request input and forwards them positionally', async () => {
      const config = new Config({ ...baseParams });
      await config.initialize();

      const fireMessageDisplayEvent = vi
        .fn()
        .mockResolvedValue({ finalOutput: undefined, allOutputs: [] });
      // @ts-expect-error - accessing private for testing
      config['hookSystem'] = { fireMessageDisplayEvent };

      const messageBus = config.getMessageBus();
      expect(messageBus).toBeDefined();

      const response = await messageBus!.request<
        HookExecutionRequest,
        HookExecutionResponse
      >(
        {
          type: MessageBusType.HOOK_EXECUTION_REQUEST,
          eventName: 'MessageDisplay',
          input: {
            message_id: 'msg-123',
            displayed_text: 'Hello, world',
            is_final: true,
          },
        },
        MessageBusType.HOOK_EXECUTION_RESPONSE,
      );

      expect(fireMessageDisplayEvent).toHaveBeenCalledWith(
        'msg-123',
        'Hello, world',
        true,
        undefined,
      );
      expect(response.success).toBe(true);
    });

    it('defaults missing fields (empty message_id/text, is_final false) rather than throwing', async () => {
      const config = new Config({ ...baseParams });
      await config.initialize();

      const fireMessageDisplayEvent = vi
        .fn()
        .mockResolvedValue({ finalOutput: undefined, allOutputs: [] });
      // @ts-expect-error - accessing private for testing
      config['hookSystem'] = { fireMessageDisplayEvent };

      const messageBus = config.getMessageBus();
      const response = await messageBus!.request<
        HookExecutionRequest,
        HookExecutionResponse
      >(
        {
          type: MessageBusType.HOOK_EXECUTION_REQUEST,
          eventName: 'MessageDisplay',
          input: {},
        },
        MessageBusType.HOOK_EXECUTION_RESPONSE,
      );

      expect(fireMessageDisplayEvent).toHaveBeenCalledWith(
        '',
        '',
        false,
        undefined,
      );
      expect(response.success).toBe(true);
    });
  });

  it('moves only the continued work chain Todo reminder', () => {
    const config = Object.create(Config.prototype) as Config;
    config.setActiveTodoReminder('prompt-user', 'unfinished user work');
    config.setActiveTodoReminder('prompt-cron', 'unfinished cron work');

    config.startActiveTodoWorkChain('prompt-retry', 'prompt-user');

    expect(config.getActiveTodoReminder('prompt-retry')).toBe(
      'unfinished user work',
    );
    expect(config.getActiveTodoReminder('prompt-user')).toBe(
      'unfinished user work',
    );
    expect(config.getActiveTodoReminder('prompt-cron')).toBeUndefined();
  });

  it('clears stale Todo reminders when a new ordinary work chain starts', () => {
    const config = Object.create(Config.prototype) as Config;
    config.startActiveTodoWorkChain('prompt-old');
    config.setActiveTodoReminder('prompt-old', 'old work');

    config.startActiveTodoWorkChain('prompt-new');

    expect(config.getActiveTodoReminder('prompt-new')).toBeUndefined();
    expect(config.getActiveTodoReminder('prompt-old')).toBeUndefined();
  });

  it('re-issues the active Todo reminder only every third tool turn', () => {
    const config = Object.create(Config.prototype) as Config;
    config.startActiveTodoWorkChain('prompt-user');
    config.setActiveTodoReminder('prompt-user', 'unfinished work');

    expect(config.takeActiveTodoReminder('prompt-user')).toBeUndefined();
    expect(config.takeActiveTodoReminder('prompt-user')).toBeUndefined();
    expect(config.takeActiveTodoReminder('prompt-user')).toBe(
      'unfinished work',
    );
    expect(config.takeActiveTodoReminder('prompt-user')).toBeUndefined();

    expect(config.takeActiveTodoReminder('prompt-user', true)).toBe(
      'unfinished work',
    );
    expect(config.takeActiveTodoReminder('prompt-user')).toBeUndefined();
    expect(config.takeActiveTodoReminder('prompt-user')).toBeUndefined();
    expect(config.takeActiveTodoReminder('prompt-user')).toBe(
      'unfinished work',
    );

    config.setActiveTodoReminder('prompt-user', 'updated work');
    expect(config.takeActiveTodoReminder('prompt-user')).toBeUndefined();
  });

  it('moves related automatic work without clearing unrelated reminders', () => {
    const config = Object.create(Config.prototype) as Config;
    config.startActiveTodoWorkChain('prompt-user');
    config.setActiveTodoReminder('prompt-user', 'unfinished user work');
    config.startAutomaticActiveTodoWorkChain('prompt-unrelated');
    config.setActiveTodoReminder('prompt-unrelated', 'other work');

    config.startAutomaticActiveTodoWorkChain('prompt-cron');
    config.startAutomaticActiveTodoWorkChain(
      'prompt-related-notification',
      'prompt-user',
    );

    expect(config.getActiveTodoReminder('prompt-user')).toBe(
      'unfinished user work',
    );
    expect(config.getActiveTodoReminder('prompt-cron')).toBeUndefined();
    expect(config.getActiveTodoReminder('prompt-related-notification')).toBe(
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
    expect(config.getActiveTodoReminder('prompt-unrelated')).toBe('other work');

    config.endAutomaticActiveTodoWorkChain('prompt-cron');
    config.endAutomaticActiveTodoWorkChain('prompt-related-notification');

    expect(config.getActiveTodoReminder('prompt-cron')).toBeUndefined();
    expect(config.getActiveTodoReminder('prompt-user')).toBe(
      'unfinished user work',
    );

    config.startAutomaticActiveTodoWorkChain(
      'prompt-stale-notification',
      'prompt-stale-owner',
    );
    config.setActiveTodoReminder(
      'prompt-stale-notification',
      'stale automatic work',
    );
    config.endAutomaticActiveTodoWorkChain('prompt-stale-notification');

    expect(config.getActiveTodoReminder('prompt-stale-owner')).toBeUndefined();
  });

  it('isolates active Todo reminders inherited through child Configs', () => {
    const parent = Object.create(Config.prototype) as Config;
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
});

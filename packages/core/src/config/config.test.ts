/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { ConfigParameters, SandboxConfig } from './config.js';
import {
  Config,
  ApprovalMode,
  APPROVAL_MODES,
  APPROVAL_MODE_INFO,
  MCPServerConfig,
  TrustGateError,
} from './config.js';
import { Storage } from './storage.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setGeminiMdFilename as mockSetGeminiMdFilename } from '../memory/const.js';
import {
  DEFAULT_TELEMETRY_TARGET,
  DEFAULT_OTLP_ENDPOINT,
  QwenLogger,
  isTelemetrySdkInitialized,
  shutdownTelemetry,
  refreshSessionContext,
} from '../telemetry/index.js';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../core/contentGenerator.js';
import { DEFAULT_DASHSCOPE_BASE_URL } from '../core/openaiContentGenerator/constants.js';
import {
  AuthType,
  Protocol,
  createContentGenerator,
  createContentGeneratorConfig,
  resolveContentGeneratorConfigWithSources,
} from '../core/contentGenerator.js';
import { GeminiClient } from '../core/client.js';
import { ShellTool } from '../tools/shell.js';
import { canUseRipgrep } from '../utils/ripgrepUtils.js';
import { logRipgrepFallback } from '../telemetry/loggers.js';
import { RipgrepFallbackEvent } from '../telemetry/types.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { ToolNames } from '../tools/tool-names.js';
import { fireNotificationHook } from '../core/toolHookTriggers.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { loadServerHierarchicalMemory } from '../utils/memoryDiscovery.js';
import type { LoadServerHierarchicalMemoryOptions } from '../utils/memoryDiscovery.js';
import { readAutoMemoryIndex } from '../memory/store.js';
import * as runtimeStatus from '../utils/runtimeStatus.js';
import { ExtensionManager } from '../extension/extensionManager.js';
import { SkillManager } from '../skills/skill-manager.js';
import { HookSystem } from '../hooks/index.js';
import type { FileHistorySnapshot } from '../services/fileHistoryService.js';

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

vi.mock('../utils/memoryDiscovery.js', () => ({
  loadServerHierarchicalMemory: vi.fn().mockResolvedValue({
    memoryContent: '',
    fileCount: 0,
    ruleCount: 0,
    conditionalRules: [],
    projectRoot: '/tmp',
  }),
}));

vi.mock('../memory/store.js', () => ({
  readAutoMemoryIndex: vi.fn().mockResolvedValue(null),
  readUserAutoMemoryIndex: vi.fn().mockResolvedValue(null),
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
vi.mock('../memory/const.js', () => ({
  setGeminiMdFilename: vi.fn(),
  getCurrentGeminiMdFilename: vi.fn(() => 'QWEN.md'), // Mock the original filename
  getAllGeminiMdFilenames: vi.fn(() => ['QWEN.md', 'AGENTS.md']),
  DEFAULT_CONTEXT_FILENAME: 'QWEN.md',
}));
vi.mock('../tools/memory-config', () => ({
  setGeminiMdFilename: vi.fn(),
  getCurrentGeminiMdFilename: vi.fn(() => 'QWEN.md'),
  getAllGeminiMdFilenames: vi.fn(() => ['QWEN.md', 'AGENTS.md']),
  DEFAULT_CONTEXT_FILENAME: 'QWEN.md',
  AGENT_CONTEXT_FILENAME: 'AGENTS.md',
  MEMORY_SECTION_HEADER: '## Qwen Added Memories',
}));

vi.mock('../core/contentGenerator.js');

vi.mock('../core/client.js', () => ({
  GeminiClient: vi.fn().mockImplementation(() => ({
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

vi.mock('../core/baseLlmClient.js');
// Mock fireNotificationHook from toolHookTriggers
vi.mock('../core/toolHookTriggers.js', () => ({
  fireNotificationHook: vi.fn().mockResolvedValue({}),
}));

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
    usageStatisticsEnabled: false,
    overrideExtensions: [],
  };

  beforeEach(() => {
    // Reset mocks if necessary
    vi.clearAllMocks();
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

  describe('FileReadCache isolation', () => {
    it('returns a distinct cache for child Configs created via Object.create', () => {
      // Subagent / scoped-agent / fork construction all use
      // `Object.create(parent)`, which does NOT run field initializers.
      // Without explicit handling the child would resolve fileReadCache
      // through the prototype chain back to the parent's instance, so a
      // subagent's ReadFile would see the parent's recorded reads and
      // return file_unchanged placeholders for files the subagent has
      // never received in its own transcript.
      const parent = new Config(baseParams);
      const child = Object.create(parent) as Config;

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
        } as unknown as import('node:fs').Stats,
        { full: true, cacheable: true },
      );

      expect(parentCache.size()).toBe(1);
      expect(childCache.size()).toBe(0);
    });

    it('returns the same cache instance on repeated getter calls within one Config', () => {
      // Sanity: the lazy own-property initialization in
      // getFileReadCache() must not allocate a fresh cache on every
      // call — recorded entries would vanish between operations.
      const config = new Config(baseParams);
      expect(config.getFileReadCache()).toBe(config.getFileReadCache());
    });
  });

  describe('MemoryPressureMonitor isolation', () => {
    it('returns a distinct monitor for child Configs created via Object.create', async () => {
      const parent = new Config(baseParams);
      await parent.initialize({ skipGeminiInitialization: true });
      const child = Object.create(parent) as Config;

      const parentMonitor = parent.getMemoryPressureMonitor();
      const childMonitor = child.getMemoryPressureMonitor();

      expect(parentMonitor).toBeDefined();
      expect(childMonitor).toBeDefined();
      expect(childMonitor).not.toBe(parentMonitor);
      expect(child.getMemoryPressureMonitor()).toBe(childMonitor);
    });

    it('resets monitor cleanup state when starting a new session', async () => {
      const config = new Config(baseParams);
      await config.initialize({ skipGeminiInitialization: true });
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
      await config.initialize({ skipGeminiInitialization: true });
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
      await config.initialize({ skipGeminiInitialization: true });
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
      await config.initialize({ skipGeminiInitialization: true });

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
        await config.initialize({ skipGeminiInitialization: true });
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
      await config.initialize({ skipGeminiInitialization: true });
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
      await parent.initialize({ skipGeminiInitialization: true });

      process.env['QWEN_MEMORY_PRESSURE_SOFT'] = '0.9';
      process.env['QWEN_MEMORY_PRESSURE_HARD'] = '0.95';
      process.env['QWEN_MEMORY_PRESSURE_CRITICAL'] = '0.97';
      const child = Object.create(parent) as Config;
      mockMemoryRatio(0.35);

      expect(child.getMemoryPressureMonitor()?.getPressureLevel()).toBe('soft');
    });
  });

  describe('startNewSession', () => {
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
      (
        config as unknown as {
          chatRecordingService?: {
            finalize: () => void;
            flush: () => Promise<void>;
          };
        }
      ).chatRecordingService = { finalize, flush };

      config.startNewSession();

      expect(finalize).toHaveBeenCalledTimes(1);
      expect(flush).toHaveBeenCalledTimes(1);
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

  describe('initialize', () => {
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
      ]);
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

      it('is disabled by default', () => {
        const config = new Config(baseParams);
        expect(config.isArtifactEnabled()).toBe(false);
      });

      it('honors settings when interactive and not in SDK mode', () => {
        const config = new Config({
          ...baseParams,
          artifactEnabled: true,
          interactive: true,
          sdkMode: false,
        });
        expect(config.isArtifactEnabled()).toBe(true);
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

      it('stays disabled outside interactive mode even when force-enabled', () => {
        process.env['QWEN_CODE_ENABLE_ARTIFACT'] = '1';

        const config = new Config({
          ...baseParams,
          interactive: false,
          sdkMode: false,
        });

        expect(config.isArtifactEnabled()).toBe(false);
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
      expect(GeminiClient).toHaveBeenCalledWith(config);
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
        countTokens: vi.fn(),
        embedContent: vi.fn(),
      } as unknown as ContentGenerator);

      // Establish initial qwen-oauth content generator config/content generator.
      await config.refreshAuth(AuthType.QWEN_OAUTH);

      // Spy after initial refresh to ensure model switch does not re-trigger refreshAuth.
      const refreshSpy = vi.spyOn(config, 'refreshAuth');

      await config.switchModel(AuthType.QWEN_OAUTH, 'coder-model');

      expect(config.getModel()).toBe('coder-model');
      expect(refreshSpy).not.toHaveBeenCalled();
      // Called once during initial refreshAuth + once during handleModelChange diffing.
      expect(
        vi.mocked(resolveContentGeneratorConfigWithSources),
      ).toHaveBeenCalledTimes(2);
      expect(vi.mocked(createContentGenerator)).toHaveBeenCalledTimes(1);
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
        countTokens: vi.fn(),
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
        countTokens: vi.fn(),
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

  describe('model switching with different credentials (OpenAI)', () => {
    it('returns undefined for bare Qwen OAuth fast models under active OpenAI auth', async () => {
      const config = new Config({
        ...baseParams,
        authType: AuthType.USE_OPENAI,
        model: 'qwen3.7-max',
        fastModel: 'coder-model',
        modelProvidersConfig: {
          [AuthType.USE_OPENAI]: {
            protocol: Protocol.OPENAI,
            models: [
              {
                id: 'qwen3.7-max',
                name: 'qwen3.7-max',
                baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
                envKey: 'DASHSCOPE_API_KEY',
              },
            ],
          },
          [AuthType.USE_ANTHROPIC]: {
            protocol: Protocol.ANTHROPIC,
            models: [
              {
                id: 'claude-opus-4-7',
                name: 'claude-opus-4-7',
                baseUrl: 'https://idealab.alibaba-inc.com/api/anthropic',
                envKey: 'IDEALAB_OPUS_API_KEY',
              },
            ],
          },
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
          [AuthType.USE_OPENAI]: {
            protocol: Protocol.OPENAI,
            models: [
              {
                id: 'shared-model',
                name: 'OpenAI shared model',
                baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
                envKey: 'DASHSCOPE_API_KEY',
              },
            ],
          },
          [AuthType.USE_ANTHROPIC]: {
            protocol: Protocol.ANTHROPIC,
            models: [
              {
                id: 'shared-model',
                name: 'Anthropic shared model',
                baseUrl: 'https://idealab.alibaba-inc.com/api/anthropic',
                envKey: 'IDEALAB_OPUS_API_KEY',
              },
            ],
          },
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
          [AuthType.USE_OPENAI]: {
            protocol: Protocol.OPENAI,
            models: [
              {
                id: 'qwen3.7-max',
                name: 'qwen3.7-max',
                baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
                envKey: 'DASHSCOPE_API_KEY',
              },
            ],
          },
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
          [AuthType.USE_OPENAI]: {
            protocol: Protocol.OPENAI,
            models: [
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
          [AuthType.USE_OPENAI]: {
            protocol: Protocol.OPENAI,
            models: [
              {
                id: 'deepseek-v4-flash',
                name: 'deepseek-v4-flash',
                baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
                envKey: 'DASHSCOPE_API_KEY',
              },
            ],
          },
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
          [AuthType.USE_OPENAI]: {
            protocol: Protocol.OPENAI,
            models: [
              {
                id: 'registry-model',
                name: 'Registry Model',
                baseUrl: 'https://api.openai.com/v1',
                envKey: 'OPENAI_API_KEY',
              },
            ],
          },
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
          [AuthType.USE_ANTHROPIC]: {
            protocol: Protocol.ANTHROPIC,
            models: [
              {
                id: 'claude-opus-4-7',
                name: 'claude-opus-4-7',
                baseUrl: 'https://idealab.alibaba-inc.com/api/anthropic',
                envKey: 'IDEALAB_OPUS_API_KEY',
              },
            ],
          },
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
          [AuthType.USE_ANTHROPIC]: {
            protocol: Protocol.ANTHROPIC,
            models: [
              {
                id: 'claude-opus-4-7',
                name: 'claude-opus-4-7',
                baseUrl: 'https://idealab.alibaba-inc.com/api/anthropic',
                envKey: 'IDEALAB_OPUS_API_KEY',
              },
            ],
          },
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
          [AuthType.USE_OPENAI]: {
            protocol: Protocol.OPENAI,
            models: [
              {
                id: 'deepseek-v4-flash',
                name: 'deepseek-v4-flash',
                baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
                envKey: 'DASHSCOPE_API_KEY',
              },
            ],
          },
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
          [AuthType.USE_ANTHROPIC]: {
            protocol: Protocol.ANTHROPIC,
            models: [
              {
                id: 'claude-opus-4-7',
                name: 'claude-opus-4-7',
                baseUrl: 'https://idealab.alibaba-inc.com/api/anthropic',
                envKey: 'IDEALAB_OPUS_API_KEY',
              },
            ],
          },
        },
      });

      expect(config.getFastModel()).toBeUndefined();
    });

    it('should refresh auth when switching to model with different envKey', async () => {
      // This test verifies the fix for switching between modelProvider models
      // with different envKeys (e.g., deepseek-chat with DEEPSEEK_API_KEY)
      const configWithModelProviders = new Config({
        ...baseParams,
        authType: AuthType.USE_OPENAI,
        modelProvidersConfig: {
          openai: {
            protocol: Protocol.OPENAI,
            models: [
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
        countTokens: vi.fn(),
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

  it('refreshHierarchicalMemory should append managed auto-memory index when present', async () => {
    const config = new Config(baseParams);

    vi.mocked(loadServerHierarchicalMemory).mockResolvedValue({
      memoryContent: '--- Context from: QWEN.md ---\nProject rules',
      fileCount: 1,
      ruleCount: 0,
      conditionalRules: [],
      projectRoot: '/tmp',
    });
    vi.mocked(readAutoMemoryIndex).mockResolvedValue(
      '# Managed Auto-Memory Index\n\n- [Project Memory](project.md)',
    );

    await config.refreshHierarchicalMemory();

    expect(config.getUserMemory()).toContain('Project rules');
    expect(config.getUserMemory()).toContain('# auto memory');
    expect(config.getUserMemory()).toContain('[Project Memory](project.md)');
  });

  it('refreshHierarchicalMemory should include appended auto-memory in the context warning estimate', async () => {
    const config = new Config({
      ...baseParams,
      generationConfig: { contextWindowSize: 1000 },
    });

    vi.mocked(loadServerHierarchicalMemory).mockResolvedValue({
      memoryContent: 'short project rules',
      fileCount: 1,
      ruleCount: 0,
      conditionalRules: [],
      projectRoot: '/tmp',
    });
    vi.mocked(readAutoMemoryIndex).mockResolvedValueOnce(
      '# Managed Auto-Memory Index\n\n' + 'remember this '.repeat(80),
    );

    await config.refreshHierarchicalMemory();

    expect(config.getWarnings()).toContainEqual(
      expect.stringContaining('Loaded QWEN.md/context instructions'),
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
      ruleCount: 0,
      conditionalRules: [],
      projectRoot: '/tmp',
    });

    await config.refreshHierarchicalMemory();

    expect(config.getWarnings()).toContainEqual(
      expect.stringContaining('Loaded QWEN.md/context instructions'),
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
      expect.stringContaining('Loaded QWEN.md/context instructions'),
    );
  });

  it('getWarnings should use the model token limit when no contextWindowSize is configured', () => {
    const config = new Config({
      ...baseParams,
      model: 'unknown-model-for-context-warning-test',
      userMemory: 'a'.repeat(100_000),
    });

    expect(config.getWarnings()).toContainEqual(
      expect.stringContaining("model's 131,072 token context window"),
    );
  });

  it('refreshHierarchicalMemory should not warn for small always-loaded context', async () => {
    const config = new Config({
      ...baseParams,
      enableManagedAutoMemory: false,
      generationConfig: { contextWindowSize: 1000 },
    });

    vi.mocked(loadServerHierarchicalMemory).mockResolvedValueOnce({
      memoryContent: 'short project context',
      fileCount: 1,
      ruleCount: 0,
      conditionalRules: [],
      projectRoot: '/tmp',
    });
    vi.mocked(readAutoMemoryIndex).mockResolvedValueOnce(null);

    await config.refreshHierarchicalMemory();

    expect(
      config
        .getWarnings()
        .some((warning) =>
          warning.includes('Loaded QWEN.md/context instructions'),
        ),
    ).toBe(false);
  });

  it('relocateWorkingDirectory should update the session working roots', async () => {
    const config = new Config(baseParams);
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

  it('relocateWorkingDirectory should move current session artifacts to the new workspace', async () => {
    const config = new Config(baseParams);
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
    const newTranscriptPath = path.join(newChatsDir, `${sessionId}.jsonl`);
    const newRuntimeStatusPath = path.join(
      newChatsDir,
      `${sessionId}.runtime.json`,
    );
    const newWorktreeSessionPath = path.join(
      newChatsDir,
      `${sessionId}.worktree.json`,
    );
    const chdirSpy = vi.spyOn(process, 'chdir').mockImplementation(() => {
      // Keep the test process in its original directory.
    });
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(newDir);
    const existingArtifacts = [
      oldTranscriptPath,
      oldRuntimeStatusPath,
      oldWorktreeSessionPath,
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
    expect(config.getTranscriptPath()).toBe(newTranscriptPath);

    chdirSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('relocateWorkingDirectory should refresh runtime status after moving session artifacts', async () => {
    const config = new Config(baseParams);
    config.markRuntimeStatusEnabled();
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

    await config.relocateWorkingDirectory(newDir);

    expect(fs.renameSync).toHaveBeenCalledWith(
      oldRuntimeStatusPath,
      newRuntimeStatusPath,
    );
    expect(writeRuntimeStatusSpy).toHaveBeenCalledWith(newRuntimeStatusPath, {
      sessionId,
      workDir: newDir,
      qwenVersion: null,
    });

    writeRuntimeStatusSpy.mockRestore();
    chdirSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('relocateWorkingDirectory should reject and roll back when session artifact migration fails', async () => {
    const config = new Config(baseParams);
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

  it('refreshHierarchicalMemory should include empty memory prompt when no managed auto-memory index exists', async () => {
    const config = new Config(baseParams);

    vi.mocked(loadServerHierarchicalMemory).mockResolvedValue({
      memoryContent: '--- Context from: QWEN.md ---\nProject rules',
      fileCount: 1,
      ruleCount: 0,
      conditionalRules: [],
      projectRoot: '/tmp',
    });
    vi.mocked(readAutoMemoryIndex).mockResolvedValue(null);

    await config.refreshHierarchicalMemory();

    expect(config.getUserMemory()).toContain('Project rules');
    expect(config.getUserMemory()).toContain('# auto memory');
    expect(config.getUserMemory()).toContain('MEMORY.md is currently empty');
  });

  it('refreshHierarchicalMemory should only use explicit inputs in bare mode', async () => {
    const config = new Config({
      ...baseParams,
      bareMode: true,
    });

    vi.mocked(loadServerHierarchicalMemory).mockResolvedValue({
      memoryContent: '--- Context from: QWEN.md ---\nProject rules',
      fileCount: 1,
      ruleCount: 0,
      conditionalRules: [],
      projectRoot: '/tmp',
    });

    await config.refreshHierarchicalMemory();

    const lastCall = vi.mocked(loadServerHierarchicalMemory).mock.calls.at(-1);
    expect(lastCall?.at(-1)).toMatchObject({ explicitOnly: true });
    expect(lastCall?.[1]).toEqual([]);
    expect(readAutoMemoryIndex).not.toHaveBeenCalled();
    expect(config.getUserMemory()).toContain('Project rules');
    expect(config.getUserMemory()).not.toContain('# auto memory');
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
    config['hookSystem'] = {
      fireInstructionsLoadedEvent,
    } as unknown as HookSystem;

    vi.mocked(loadServerHierarchicalMemory).mockResolvedValue({
      memoryContent: '--- Context from: QWEN.md ---\nProject rules',
      fileCount: 1,
      ruleCount: 0,
      conditionalRules: [],
      projectRoot: '/tmp',
    });

    await config.refreshHierarchicalMemory();

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
    );
  });

  it('Config constructor should call setGeminiMdFilename with contextFileName if provided', () => {
    const contextFileName = 'CUSTOM_AGENTS.md';
    const paramsWithContextFile: ConfigParameters = {
      ...baseParams,
      contextFileName,
    };
    new Config(paramsWithContextFile);
    expect(mockSetGeminiMdFilename).toHaveBeenCalledWith(contextFileName);
  });

  it('Config constructor should not call setGeminiMdFilename if contextFileName is not provided', () => {
    new Config(baseParams); // baseParams does not have contextFileName
    expect(mockSetGeminiMdFilename).not.toHaveBeenCalled();
  });

  it('should set default file filtering settings when not provided', () => {
    const config = new Config(baseParams);
    expect(config.getFileFilteringRespectGitIgnore()).toBe(true);
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

    // Regression for #5574: the gate state records whether the model or the
    // user entered plan mode, so exit_plan_mode can decide whether to gate.
    it('marks the plan gate entry as user-initiated by default', () => {
      const config = new Config(baseParams);
      vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);

      config.setApprovalMode(ApprovalMode.PLAN);
      expect(config.getPlanGateState()?.enteredByModel).toBe(false);
    });

    it('marks the plan gate entry as model-initiated when enter_plan_mode requests it', () => {
      const config = new Config(baseParams);
      vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);

      config.setApprovalMode(ApprovalMode.PLAN, { enteredByModel: true });
      expect(config.getPlanGateState()?.enteredByModel).toBe(true);
    });

    it('records prePlanMode=yolo and enteredByModel=false for a Shift+Tab cycle into plan mode (#5574)', () => {
      const config = new Config(baseParams);
      vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);

      // Simulate the Shift+Tab cycle order:
      // default → auto-edit → auto → yolo → plan
      config.setApprovalMode(ApprovalMode.AUTO_EDIT);
      config.setApprovalMode(ApprovalMode.AUTO);
      config.setApprovalMode(ApprovalMode.YOLO);
      config.setApprovalMode(ApprovalMode.PLAN);

      // prePlanMode is yolo purely because it precedes plan in the cycle —
      // it does NOT mean the user wants autonomous execution.
      expect(config.getPrePlanMode()).toBe(ApprovalMode.YOLO);
      expect(config.getPlanGateState()?.enteredByModel).toBe(false);
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
});

describe('Model Switching and Config Updates', () => {
  const baseParams: ConfigParameters = {
    cwd: '/tmp',
    targetDir: '/path/to/target',
    debugMode: false,
    model: 'qwen3-coder-plus',
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
      ['toolResultContentFormat']: 'string',
    };

    vi.mocked(resolveContentGeneratorConfigWithSources).mockReturnValue({
      config: newConfig,
      sources: {
        model: { kind: 'programmatic', detail: 'user' },
        contextWindowSize: { kind: 'computed', detail: 'auto' },
        samplingParams: { kind: 'settings' },
        enableCacheControl: { kind: 'settings' },
        toolResultContentFormat: { kind: 'settings' },
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
    expect(updatedConfig['toolResultContentFormat']).toBe('string');

    // Verify sources are also updated
    const sources = config.getContentGeneratorConfigSources();
    expect(sources['model']?.kind).toBe('programmatic');
    expect(sources['model']?.detail).toBe('user');
    expect(sources['contextWindowSize']?.kind).toBe('computed');
    expect(sources['contextWindowSize']?.detail).toBe('auto');
    expect(sources['samplingParams']?.kind).toBe('settings');
    expect(sources['enableCacheControl']?.kind).toBe('settings');
    expect(sources['toolResultContentFormat']?.kind).toBe('settings');
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
          [AuthType.USE_OPENAI]: {
            protocol: Protocol.OPENAI,
            models: [
              {
                id: 'gpt-4o',
                name: 'GPT-4o',
                baseUrl: 'https://api.openai.example.com/v1',
                envKey: 'OPENAI_API_KEY',
              },
            ],
          },
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
          [AuthType.USE_OPENAI]: {
            protocol: Protocol.OPENAI,
            models: [
              {
                id: 'gpt-4o',
                name: 'GPT-4o',
                baseUrl: 'https://api.openai.example.com/v1',
                envKey: 'OPENAI_API_KEY',
              },
            ],
          },
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
});

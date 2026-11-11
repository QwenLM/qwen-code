/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryContextManager } from './memoryContextManager.js';
import * as memoryDiscovery from '../utils/memoryDiscovery.js';
import * as agentsMdSize from '../utils/agentsMdSize.js';
import * as agentsMdSizePolicy from '../config-service/features/agentsMdSizePolicy.js';
import { OutputFormat } from '../output/types.js';
import { ENV_REMOTE_WORKER } from '../config/brand.js';
import type { Config } from '../config/config.js';
import { coreEvents, CoreEvent } from '../utils/events.js';
import { CONFIG_DIR } from '../utils/paths.js';

// Mock memoryDiscovery module
vi.mock('../utils/memoryDiscovery.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/memoryDiscovery.js')>();
  return {
    ...actual,
    getGlobalMemoryPaths: vi.fn(),
    getEnvironmentMemoryPaths: vi.fn(),
    readMemoryMdFiles: vi.fn(),
    loadJitSubdirectoryMemory: vi.fn(),
    deduplicatePathsByFileIdentity: vi.fn(),
    getUserModelDecisionRuleEntries: vi.fn().mockResolvedValue([]),
    getEnvironmentModelDecisionRuleEntries: vi.fn().mockResolvedValue([]),
    concatenateInstructions: vi
      .fn()
      .mockImplementation(actual.concatenateInstructions),
  };
});

describe('MemoryContextManager', () => {
  let memoryContextManager: MemoryContextManager;
  let mockConfig: Config;

  beforeEach(() => {
    mockConfig = {
      getSessionId: vi.fn().mockReturnValue('test-session'),
      getWorkingDir: vi.fn().mockReturnValue('/app'),
      getTargetDir: vi.fn().mockReturnValue('/app'),
      getWorktreeSettings: vi.fn().mockReturnValue(undefined),
      getImportFormat: vi.fn().mockReturnValue('tree'),
      getWorkspaceContext: vi.fn().mockReturnValue({
        getDirectories: vi.fn().mockReturnValue(['/app']),
      }),
      getMcpClientManager: vi.fn().mockReturnValue({
        getMcpInstructions: vi.fn().mockReturnValue('MCP Instructions'),
      }),
      isTrustedFolder: vi.fn().mockReturnValue(true),
      getMemoryBoundaryMarkers: vi.fn().mockReturnValue(['.git']),
      getAllContextFileNames: vi.fn().mockReturnValue(['AGENTS.md']),
      getAllLocalContextFileNames: vi.fn().mockReturnValue(['AGENTS.local.md']),
      getAgentsMdExcludes: vi.fn().mockReturnValue([]),
      getAllowedAgentSources: vi.fn().mockReturnValue(undefined),
      getHookSystem: vi.fn().mockReturnValue(undefined),
      storage: {
        getProjectMemoryDir: vi
          .fn()
          .mockReturnValue(`/home/user/${CONFIG_DIR}/memory/test-project`),
      },
    } as unknown as Config;

    memoryContextManager = new MemoryContextManager(mockConfig);
    vi.clearAllMocks();
    vi.spyOn(coreEvents, 'emit');
    // default mock: deduplication returns paths as-is (no deduplication)
    vi.mocked(
      memoryDiscovery.deduplicatePathsByFileIdentity,
    ).mockImplementation(async (paths: string[]) => ({
      paths,
      identityMap: new Map<string, string>(),
    }));
  });

  it('keeps the startup date stable when the user-context cache is rebuilt', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 8, 3, 12, 0, 0));
      expect(memoryContextManager.getUserContext()['currentDate']).toBe(
        "Today's date is 2026-09-03.",
      );

      vi.setSystemTime(new Date(2026, 8, 15, 12, 0, 0));
      memoryContextManager.clearUserContextCache();

      expect(memoryContextManager.getStartupDate()).toBe('2026-09-03');
      expect(memoryContextManager.getUserContext()['currentDate']).toBe(
        "Today's date is 2026-09-03.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  describe('refresh', () => {
    it.each([false, true])(
      'notifies once across startup/internal refreshes and an unchanged QCS threshold (internal first: %s)',
      async (internalFirst) => {
        const raw: agentsMdSize.AgentsMdSizeMeasurement = {
          files: [{ path: '/app/AGENTS.md', bytes: 33_027, depth: 0 }],
          totalBytes: 33_027,
          measuredAt: 123,
          loadStatus: 'complete',
          readErrorCount: 0,
        };
        const measure = vi
          .spyOn(agentsMdSize, 'measureAgentsMdSize')
          .mockResolvedValue(raw);
        const policy = vi
          .spyOn(agentsMdSizePolicy, 'getAgentsMdSizePolicy')
          .mockReturnValue({ projectDocMaxBytes: 32768, source: 'default' });
        let update: (policy: agentsMdSizePolicy.AgentsMdSizePolicy) => void =
          () => {};
        const subscription = vi
          .spyOn(agentsMdSizePolicy, 'onAgentsMdSizePolicyChanged')
          .mockImplementation((listener) => {
            update = listener;
            return vi.fn();
          });
        Object.assign(mockConfig, {
          isInteractive: () => true,
          getTargetDir: () => '/app',
          getSessionId: () => 'size-session',
        });
        vi.mocked(memoryDiscovery.getGlobalMemoryPaths).mockResolvedValue([]);
        vi.mocked(memoryDiscovery.getEnvironmentMemoryPaths).mockResolvedValue({
          project: ['/app/AGENTS.md'],
          local: [],
        });
        vi.mocked(memoryDiscovery.readMemoryMdFiles).mockResolvedValue([
          { filePath: '/app/AGENTS.md', content: 'x'.repeat(33_027) },
        ]);
        const manager = new MemoryContextManager(mockConfig);
        const evaluations: Array<{ notifyWarning?: boolean }> = [];
        const handle = (event: {
          sessionId: string;
          notifyWarning?: boolean;
        }) => {
          if (event.sessionId === 'size-session') evaluations.push(event);
        };
        coreEvents.on(CoreEvent.AgentsMdSizeEvaluated, handle);
        const internalRefresh = () =>
          manager.refresh('session_start', {
            notifyAgentsMdSizeWarning: false,
          });
        try {
          await (internalFirst ? internalRefresh() : manager.refresh());
          await internalRefresh();
          update({ projectDocMaxBytes: 32768, source: 'qcs' });
          await vi.waitFor(() => expect(evaluations).toHaveLength(3));
          await internalRefresh();
          expect(evaluations.map((event) => event.notifyWarning)).toEqual([
            true,
            false,
            false,
            false,
          ]);
          expect(measure).toHaveBeenCalledTimes(3);
          expect(manager.getEnvironmentMemory()).toContain('x'.repeat(33_027));
          // Explicit checks are still notified every time, without threshold-state deduplication.
          await manager.refresh();
          await manager.refresh();
          expect(evaluations.slice(-2).map((event) => event.notifyWarning)).toEqual([
            true,
            true,
          ]);
          update({ projectDocMaxBytes: 32000, source: 'qcs' });
          await vi.waitFor(() => expect(evaluations).toHaveLength(7));
          expect(evaluations.at(-1)?.notifyWarning).toBe(true);
        } finally {
          coreEvents.off(CoreEvent.AgentsMdSizeEvaluated, handle);
          manager.dispose();
          measure.mockRestore();
          policy.mockRestore();
          subscription.mockRestore();
        }
      },
    );

    it.each([
      { format: OutputFormat.TEXT, acp: false, remote: false },
      { format: OutputFormat.STREAM_JSON, acp: true, remote: false },
      { format: OutputFormat.STREAM_JSON, acp: false, remote: true },
    ])(
      'does not enable the diagnostic for unsupported entry modes: $format / $acp / $remote',
      async ({ format, acp, remote }) => {
        const measure = vi.spyOn(agentsMdSize, 'measureAgentsMdSize');
        vi.stubEnv(ENV_REMOTE_WORKER, remote ? '1' : '0');
        Object.assign(mockConfig, {
          isInteractive: () => false,
          getAcpMode: () => acp,
          getOutputFormat: () => format,
        });
        const manager = new MemoryContextManager(mockConfig);
        vi.mocked(memoryDiscovery.getGlobalMemoryPaths).mockResolvedValue([]);
        vi.mocked(memoryDiscovery.getEnvironmentMemoryPaths).mockResolvedValue({
          project: [],
          local: [],
        });
        vi.mocked(memoryDiscovery.readMemoryMdFiles).mockResolvedValue([]);
        try {
          await manager.refresh();
          expect(measure).not.toHaveBeenCalled();
          expect(manager.getAgentsMdSizeSnapshot()).toBeUndefined();
        } finally {
          manager.dispose();
          measure.mockRestore();
        }
      },
    );

    it('uses each session Config context filenames for the size measurement', async () => {
      const measure = vi
        .spyOn(agentsMdSize, 'measureAgentsMdSize')
        .mockResolvedValue({
          files: [],
          totalBytes: 0,
          measuredAt: 123,
          loadStatus: 'absent',
          readErrorCount: 0,
        });
      vi.mocked(memoryDiscovery.getGlobalMemoryPaths).mockResolvedValue([]);
      vi.mocked(memoryDiscovery.getEnvironmentMemoryPaths).mockResolvedValue({
        project: [],
        local: [],
      });
      vi.mocked(memoryDiscovery.readMemoryMdFiles).mockResolvedValue([]);
      const names = [['FIRST.md'], ['SECOND.md']];
      const managers = names.map((filenames, index) =>
        new MemoryContextManager({
          ...mockConfig,
          isInteractive: () => true,
          getTargetDir: () => `/app/session-${index}`,
          getSessionId: () => `size-session-${index}`,
          getAllContextFileNames: () => filenames,
        } as unknown as Config),
      );
      try {
        await Promise.all(managers.map((manager) => manager.refresh()));
        expect(measure).toHaveBeenCalledTimes(2);
        for (const [index, filenames] of names.entries()) {
          expect(measure).toHaveBeenCalledWith(
            expect.objectContaining({
              cwd: `/app/session-${index}`,
              fallbackFilenames: filenames,
            }),
          );
        }
      } finally {
        for (const manager of managers) manager.dispose();
        measure.mockRestore();
      }
    });

    it('shares startup/refresh/QCS evaluations, retains full content and disposes the policy listener', async () => {
      const raw: agentsMdSize.AgentsMdSizeMeasurement = {
        files: [{ path: '/app/AGENTS.md', bytes: 50_000, depth: 0 }],
        totalBytes: 50_000,
        measuredAt: 123,
        loadStatus: 'complete',
        readErrorCount: 0,
      };
      const measure = vi
        .spyOn(agentsMdSize, 'measureAgentsMdSize')
        .mockResolvedValue(raw);
      const unsubscribe = vi.fn();
      let update: (
        policy: agentsMdSizePolicy.AgentsMdSizePolicy,
      ) => void = () => {};
      const subscription = vi
        .spyOn(agentsMdSizePolicy, 'onAgentsMdSizePolicyChanged')
        .mockImplementation((listener) => {
          update = listener;
          return unsubscribe;
        });
      Object.assign(mockConfig, {
        isInteractive: () => true,
        getTargetDir: () => '/app',
        getSessionId: () => 'size-session',
      });
      const manager = new MemoryContextManager(mockConfig);
      vi.mocked(memoryDiscovery.getGlobalMemoryPaths).mockResolvedValue([]);
      vi.mocked(memoryDiscovery.getEnvironmentMemoryPaths).mockResolvedValue({
        project: ['/app/AGENTS.md'],
        local: [],
      });
      vi.mocked(memoryDiscovery.readMemoryMdFiles).mockResolvedValue([
        { filePath: '/app/AGENTS.md', content: 'x'.repeat(50_000) },
      ]);
      try {
        await manager.refresh();
        expect(manager.getAgentsMdSizeSnapshot()).toMatchObject({
          reason: 'startup',
          thresholdReached: true,
          totalBytes: 50_000,
        });
        expect(manager.getEnvironmentMemory()).toContain('x'.repeat(50_000));
        await manager.refresh();
        expect(manager.getAgentsMdSizeSnapshot()).toMatchObject({
          reason: 'refresh',
          thresholdReached: true,
        });
        expect(measure).toHaveBeenCalledTimes(2);
        update({ projectDocMaxBytes: 65536, source: 'qcs' });
        await vi.waitFor(() =>
          expect(manager.getAgentsMdSizeSnapshot()).toMatchObject({
            reason: 'qcs_update',
            thresholdReached: false,
            thresholdSource: 'qcs',
          }),
        );
        expect(measure).toHaveBeenCalledTimes(2);
        update({ projectDocMaxBytes: 32768, source: 'qcs' });
        await vi.waitFor(() =>
          expect(manager.getAgentsMdSizeSnapshot()?.thresholdReached).toBe(
            true,
          ),
        );
        const previous = manager.getAgentsMdSizeSnapshot();
        vi.mocked(
          memoryDiscovery.getUserModelDecisionRuleEntries,
        ).mockRejectedValueOnce(new Error('failed refresh'));
        await expect(manager.refresh()).rejects.toThrow('failed refresh');
        expect(manager.getAgentsMdSizeSnapshot()).toBe(previous);
        expect(measure).toHaveBeenCalledTimes(2);
      } finally {
        manager.dispose();
        measure.mockRestore();
        subscription.mockRestore();
      }
      expect(unsubscribe).toHaveBeenCalledOnce();
    });

    it('restores the previous state when a refresh fails after loading new memory', async () => {
      vi.mocked(memoryDiscovery.getGlobalMemoryPaths).mockResolvedValue([
        '/app/old-memory.md',
      ]);
      vi.mocked(memoryDiscovery.getEnvironmentMemoryPaths).mockResolvedValue({
        project: [],
        local: [],
      });
      vi.mocked(memoryDiscovery.readMemoryMdFiles).mockResolvedValue([
        { filePath: '/app/old-memory.md', content: 'Old content' },
      ]);

      await memoryContextManager.refresh();
      const previousContext = memoryContextManager.getUserContext();

      vi.mocked(memoryDiscovery.getGlobalMemoryPaths).mockResolvedValue([
        '/app/new-memory.md',
      ]);
      vi.mocked(memoryDiscovery.readMemoryMdFiles).mockResolvedValue([
        { filePath: '/app/new-memory.md', content: 'New content' },
      ]);
      vi.mocked(
        memoryDiscovery.getUserModelDecisionRuleEntries,
      ).mockRejectedValueOnce(new Error('rule index failed'));

      await expect(memoryContextManager.refresh()).rejects.toThrow(
        'rule index failed',
      );

      expect(memoryContextManager.getGlobalMemory()).toContain('Old content');
      expect(memoryContextManager.getGlobalMemory()).not.toContain(
        'New content',
      );
      expect([...memoryContextManager.getLoadedPaths()]).toEqual([
        '/app/old-memory.md',
      ]);
      expect(memoryContextManager.getUserContext()).toBe(previousContext);
    });

    it('applies JIT discovery after a failed refresh rollback', async () => {
      vi.mocked(memoryDiscovery.getGlobalMemoryPaths).mockResolvedValue([
        '/app/old-memory.md',
      ]);
      vi.mocked(memoryDiscovery.getEnvironmentMemoryPaths).mockResolvedValue({
        project: [],
        local: [],
      });
      vi.mocked(memoryDiscovery.readMemoryMdFiles).mockResolvedValue([
        { filePath: '/app/old-memory.md', content: 'Old content' },
      ]);
      await memoryContextManager.refresh();

      let rejectRuleIndex: (error: Error) => void = () => undefined;
      const ruleIndex = new Promise<never>((_resolve, reject) => {
        rejectRuleIndex = reject;
      });
      vi.mocked(
        memoryDiscovery.getUserModelDecisionRuleEntries,
      ).mockImplementationOnce(() => ruleIndex);
      vi.mocked(memoryDiscovery.loadJitSubdirectoryMemory).mockResolvedValue({
        files: [{ path: '/app/src/AGENTS.md', content: 'JIT content' }],
      });

      const refreshResult = memoryContextManager.refresh().then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.waitFor(() =>
        expect(
          memoryDiscovery.getUserModelDecisionRuleEntries,
        ).toHaveBeenCalledTimes(2),
      );

      const discovery = memoryContextManager.discoverContext(
        '/app/src/file.ts',
        ['/app'],
      );
      expect(memoryDiscovery.loadJitSubdirectoryMemory).not.toHaveBeenCalled();

      rejectRuleIndex(new Error('rule index failed'));
      await expect(refreshResult).resolves.toEqual(
        expect.objectContaining({ message: 'rule index failed' }),
      );
      await expect(discovery).resolves.toContain('JIT content');

      expect(memoryContextManager.getLoadedPaths()).toContain(
        '/app/old-memory.md',
      );
      expect(memoryContextManager.getLoadedPaths()).toContain(
        '/app/src/AGENTS.md',
      );
      expect(memoryContextManager.getJitMemory()).toContain('JIT content');
    });

    it('should load and format global and environment memory', async () => {
      const globalPaths = [`/home/user/${CONFIG_DIR}/GEMINI.md`];
      const envPaths = ['/app/GEMINI.md'];

      vi.mocked(memoryDiscovery.getGlobalMemoryPaths).mockResolvedValue(
        globalPaths,
      );
      vi.mocked(memoryDiscovery.getEnvironmentMemoryPaths).mockResolvedValue({
        project: envPaths,
        local: [],
      });

      vi.mocked(memoryDiscovery.readMemoryMdFiles).mockImplementation(
        async (paths) => {
          if (paths.includes(globalPaths[0])) {
            return [{ filePath: globalPaths[0], content: 'Global Content' }];
          }
          return [{ filePath: envPaths[0], content: 'Env Content' }];
        },
      );

      await memoryContextManager.refresh();

      expect(memoryDiscovery.getGlobalMemoryPaths).toHaveBeenCalled();
      expect(memoryDiscovery.getEnvironmentMemoryPaths).toHaveBeenCalledWith(
        ['/app'],
        ['AGENTS.md'],
        ['.git'],
        '/app',
      );
      // loadMemoryContents splits into two batches: alwaysExternal (global) and gated (project/local)
      expect(memoryDiscovery.readMemoryMdFiles).toHaveBeenCalledTimes(2);
      expect(memoryDiscovery.readMemoryMdFiles).toHaveBeenCalledWith(
        globalPaths,
        'tree',
        ['.git'],
        true, // always allow external for global paths
        ['AGENTS.md'],
      );
      expect(memoryDiscovery.readMemoryMdFiles).toHaveBeenCalledWith(
        envPaths,
        'tree',
        ['.git'],
        false, // gated paths: no approval callback, so false
        ['AGENTS.md'],
      );

      expect(memoryContextManager.getGlobalMemory()).toContain(
        'Global Content',
      );
      expect(memoryContextManager.getEnvironmentMemory()).toContain(
        'Env Content',
      );
      // MCP instructions are now injected via delta attachments
      // (mcp_instructions_delta), not baked into project memory.

      expect(memoryContextManager.getLoadedPaths()).toContain(globalPaths[0]);
      expect(memoryContextManager.getLoadedPaths()).toContain(envPaths[0]);
    });

    it('should emit MemoryChanged event when memory is refreshed', async () => {
      vi.mocked(memoryDiscovery.getGlobalMemoryPaths).mockResolvedValue([
        '/app/GEMINI.md',
      ]);
      vi.mocked(memoryDiscovery.getEnvironmentMemoryPaths).mockResolvedValue({
        project: ['/app/src/GEMINI.md'],
        local: [],
      });
      vi.mocked(memoryDiscovery.readMemoryMdFiles).mockImplementation(
        async (paths) => {
          if (paths.includes('/app/GEMINI.md')) {
            return [{ filePath: '/app/GEMINI.md', content: 'content' }];
          }
          return [{ filePath: '/app/src/GEMINI.md', content: 'env content' }];
        },
      );

      await memoryContextManager.refresh();

      expect(coreEvents.emit).toHaveBeenCalledWith(CoreEvent.MemoryChanged, {
        sessionId: 'test-session',
        fileCount: 2,
      });
    });

    it('should not load environment memory if folder is not trusted', async () => {
      vi.mocked(mockConfig.isTrustedFolder).mockReturnValue(false);
      vi.mocked(memoryDiscovery.getGlobalMemoryPaths).mockResolvedValue([
        `/home/user/${CONFIG_DIR}/GEMINI.md`,
      ]);
      vi.mocked(memoryDiscovery.readMemoryMdFiles).mockResolvedValue([
        {
          filePath: `/home/user/${CONFIG_DIR}/GEMINI.md`,
          content: 'Global Content',
        },
      ]);

      await memoryContextManager.refresh();

      expect(memoryDiscovery.getEnvironmentMemoryPaths).not.toHaveBeenCalled();
      expect(memoryContextManager.getEnvironmentMemory()).toBe('');
      expect(memoryContextManager.getGlobalMemory()).toContain(
        'Global Content',
      );
    });

    it('should deduplicate files by file identity in case-insensitive filesystems', async () => {
      const globalPaths = [`/home/user/${CONFIG_DIR}/GEMINI.md`];
      const envPaths = ['/app/gemini.md', '/app/GEMINI.md'];

      vi.mocked(memoryDiscovery.getGlobalMemoryPaths).mockResolvedValue(
        globalPaths,
      );
      vi.mocked(memoryDiscovery.getEnvironmentMemoryPaths).mockResolvedValue({
        project: envPaths,
        local: [],
      });

      // mock deduplication to return deduplicated paths (simulating same file)
      vi.mocked(
        memoryDiscovery.deduplicatePathsByFileIdentity,
      ).mockResolvedValue({
        paths: [`/home/user/${CONFIG_DIR}/GEMINI.md`, '/app/gemini.md'],
        identityMap: new Map<string, string>(),
      });

      vi.mocked(memoryDiscovery.readMemoryMdFiles).mockImplementation(
        async (paths) => {
          if (paths.includes(`/home/user/${CONFIG_DIR}/GEMINI.md`)) {
            return [
              {
                filePath: `/home/user/${CONFIG_DIR}/GEMINI.md`,
                content: 'Global Content',
              },
            ];
          }
          return [{ filePath: '/app/gemini.md', content: 'Project Content' }];
        },
      );

      await memoryContextManager.refresh();

      expect(
        memoryDiscovery.deduplicatePathsByFileIdentity,
      ).toHaveBeenCalledWith(
        expect.arrayContaining([
          `/home/user/${CONFIG_DIR}/GEMINI.md`,
          '/app/gemini.md',
          '/app/GEMINI.md',
        ]),
      );
      // Split into two batches: global (alwaysExternal) and project (gated)
      expect(memoryDiscovery.readMemoryMdFiles).toHaveBeenCalledTimes(2);
      expect(memoryDiscovery.readMemoryMdFiles).toHaveBeenCalledWith(
        [`/home/user/${CONFIG_DIR}/GEMINI.md`],
        'tree',
        ['.git'],
        true,
        ['AGENTS.md'],
      );
      expect(memoryDiscovery.readMemoryMdFiles).toHaveBeenCalledWith(
        ['/app/gemini.md'],
        'tree',
        ['.git'],
        false,
        ['AGENTS.md'],
      );
      expect(memoryContextManager.getEnvironmentMemory()).toContain(
        'Project Content',
      );
    });
  });

  describe('discoverContext', () => {
    // 取消必须释放串行队列；旧发现迟到时不能注入上下文。
    it('releases cancelled discovery and ignores its late memory result', async () => {
      let resolveLate!: (value: memoryDiscovery.MemoryLoadResult) => void;
      let started!: () => void;
      const discoveryStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      vi.mocked(memoryDiscovery.loadJitSubdirectoryMemory)
        .mockImplementationOnce(() => {
          started();
          return new Promise((resolve) => {
            resolveLate = resolve;
          });
        })
        .mockResolvedValueOnce({
          files: [{ path: '/app/next/AGENTS.md', content: 'next context' }],
        });
      const parent = new AbortController();
      const reason = new Error('Read cancelled');
      const pending = memoryContextManager.discoverContext(
        '/app/old/file.ts',
        ['/app'],
        parent.signal,
      );
      const outcome = pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      await discoveryStarted;
      parent.abort(reason);
      expect(await outcome).toBe(reason);
      await expect(
        memoryContextManager.discoverContext('/app/next/file.ts', ['/app']),
      ).resolves.toContain('next context');
      resolveLate({
        files: [{ path: '/app/old/AGENTS.md', content: 'late context' }],
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(memoryContextManager.getLoadedPaths()).not.toContain(
        '/app/old/AGENTS.md',
      );
      expect(memoryContextManager.getJitMemory()).not.toContain('late context');
      expect(memoryContextManager.getJitMemory()).toContain('next context');
    });

    it('should discover and load new context', async () => {
      const mockResult: memoryDiscovery.MemoryLoadResult = {
        files: [{ path: '/app/src/GEMINI.md', content: 'Src Content' }],
      };
      vi.mocked(memoryDiscovery.loadJitSubdirectoryMemory).mockResolvedValue(
        mockResult,
      );

      const result = await memoryContextManager.discoverContext(
        '/app/src/file.ts',
        ['/app'],
      );

      expect(memoryDiscovery.loadJitSubdirectoryMemory).toHaveBeenCalledWith(
        '/app/src/file.ts',
        ['/app'],
        expect.any(Set),
        ['AGENTS.md'],
        expect.any(Set),
        ['.git'],
        false,
      );
      expect(result).toMatch(/--- Context from: \/app\/src\/GEMINI\.md ---/);
      expect(result).toContain('Src Content');
      expect(memoryContextManager.getLoadedPaths()).toContain(
        '/app/src/GEMINI.md',
      );
    });

    it('should return empty string if no new files found', async () => {
      const mockResult: memoryDiscovery.MemoryLoadResult = { files: [] };
      vi.mocked(memoryDiscovery.loadJitSubdirectoryMemory).mockResolvedValue(
        mockResult,
      );

      const result = await memoryContextManager.discoverContext(
        '/app/src/file.ts',
        ['/app'],
      );

      expect(result).toBe('');
    });

    it('should return empty string if folder is not trusted', async () => {
      vi.mocked(mockConfig.isTrustedFolder).mockReturnValue(false);

      const result = await memoryContextManager.discoverContext(
        '/app/src/file.ts',
        ['/app'],
      );

      expect(memoryDiscovery.loadJitSubdirectoryMemory).not.toHaveBeenCalled();
      expect(result).toBe('');
    });

    it('should pass custom boundary markers from config', async () => {
      const customMarkers = ['.monorepo-root', 'package.json'];
      vi.mocked(mockConfig.getMemoryBoundaryMarkers).mockReturnValue(
        customMarkers,
      );
      vi.mocked(memoryDiscovery.loadJitSubdirectoryMemory).mockResolvedValue({
        files: [],
      });

      await memoryContextManager.discoverContext('/app/src/file.ts', ['/app']);

      expect(memoryDiscovery.loadJitSubdirectoryMemory).toHaveBeenCalledWith(
        '/app/src/file.ts',
        ['/app'],
        expect.any(Set),
        ['AGENTS.md'],
        expect.any(Set),
        customMarkers,
        false,
      );
    });
  });

  describe('JIT nested memory UI visibility', () => {
    async function seedTierPaths() {
      vi.mocked(memoryDiscovery.getGlobalMemoryPaths).mockResolvedValue([]);
      vi.mocked(memoryDiscovery.getEnvironmentMemoryPaths).mockResolvedValue({
        project: ['/app/AGENTS.md'],
        local: [],
      });
      vi.mocked(memoryDiscovery.readMemoryMdFiles).mockResolvedValue([
        { filePath: '/app/AGENTS.md', content: 'root' },
      ]);
      await memoryContextManager.refresh();
    }

    it('exposes JIT-discovered nested AGENTS.md via getCategorizedPathsWithJit while getCategorizedPaths stays tier-only', async () => {
      await seedTierPaths();
      vi.mocked(memoryDiscovery.loadJitSubdirectoryMemory).mockResolvedValue({
        files: [
          { path: '/app/subdir/AGENTS.md', content: 'nested' },
          { path: '/app/subdir/AGENTS.local.md', content: 'nested-local' },
        ],
      });
      await memoryContextManager.discoverContext('/app/subdir/file.ts', [
        '/app',
      ]);

      const tierOnly = memoryContextManager.getCategorizedPaths();
      expect(tierOnly?.project).toEqual(['/app/AGENTS.md']);
      expect(tierOnly?.local).toEqual([]);

      const withJit = memoryContextManager.getCategorizedPathsWithJit();
      expect(withJit?.project).toEqual([
        '/app/AGENTS.md',
        '/app/subdir/AGENTS.md',
      ]);
      expect(withJit?.local).toEqual(['/app/subdir/AGENTS.local.md']);
    });

    it('deduplicates JIT paths so repeated discoverContext calls do not double-list', async () => {
      await seedTierPaths();
      vi.mocked(memoryDiscovery.loadJitSubdirectoryMemory).mockResolvedValue({
        files: [{ path: '/app/subdir/AGENTS.md', content: 'nested' }],
      });
      await memoryContextManager.discoverContext('/app/subdir/file.ts', [
        '/app',
      ]);
      await memoryContextManager.discoverContext('/app/subdir/other.ts', [
        '/app',
      ]);

      const withJit = memoryContextManager.getCategorizedPathsWithJit();
      expect(withJit?.project).toEqual([
        '/app/AGENTS.md',
        '/app/subdir/AGENTS.md',
      ]);
    });

    it('preserves JIT paths across refresh (e.g. trust-change) and keeps them in loadedPaths', async () => {
      await seedTierPaths();
      vi.mocked(memoryDiscovery.loadJitSubdirectoryMemory).mockResolvedValue({
        files: [{ path: '/app/subdir/AGENTS.md', content: 'nested' }],
      });
      await memoryContextManager.discoverContext('/app/subdir/file.ts', [
        '/app',
      ]);

      // Simulate trust-change refresh
      await memoryContextManager.refresh();

      const withJit = memoryContextManager.getCategorizedPathsWithJit();
      expect(withJit?.project).toContain('/app/subdir/AGENTS.md');
      expect(memoryContextManager.getLoadedPaths()).toContain(
        '/app/subdir/AGENTS.md',
      );
    });
  });

  describe('restoreJitPathsFromMessages', () => {
    it('re-registers JIT paths from resumed relevant_memories attachments', () => {
      memoryContextManager.restoreJitPathsFromMessages([
        {
          type: 'attachment',
          attachment: {
            type: 'relevant_memories',
            files: [
              {
                filePath: '/app/subdir/AGENTS.md',
                content: 'x',
                memoryType: 'jit',
              },
              {
                filePath: '/app/subdir/AGENTS.local.md',
                content: 'y',
                memoryType: 'jit',
              },
            ],
          },
        },
        // unrelated entries should be ignored
        {
          type: 'attachment',
          attachment: { type: 'queued_command', command: 'noop' },
        },
        { type: 'user', message: {} },
      ] as never);

      expect(memoryContextManager.getLoadedPaths()).toContain(
        '/app/subdir/AGENTS.md',
      );
      const withJit = memoryContextManager.getCategorizedPathsWithJit();
      // lastPaths is null without a prior refresh, so nothing to merge against
      expect(withJit).toBeNull();
      // But once refresh runs, JIT paths are preserved and surfaced
    });

    it('is a no-op when no relevant_memories attachments present', () => {
      memoryContextManager.restoreJitPathsFromMessages([
        { type: 'user', message: {} },
      ] as never);
      expect(memoryContextManager.getLoadedPaths().size).toBe(0);
    });
  });

  describe('InstructionsLoaded hook dedup', () => {
    let mockHookSystem: {
      getRegistry: ReturnType<typeof vi.fn>;
      fireInstructionsLoadedEvent: ReturnType<typeof vi.fn>;
    };

    function setupMockHookSystem() {
      mockHookSystem = {
        getRegistry: vi.fn().mockReturnValue({
          getHooksForEvent: vi.fn().mockReturnValue([{ id: 'test-hook' }]),
        }),
        fireInstructionsLoadedEvent: vi.fn().mockResolvedValue({ results: [] }),
      };
      vi.mocked(mockConfig.getHookSystem).mockReturnValue(
        mockHookSystem as unknown as ReturnType<Config['getHookSystem']>,
      );
    }

    function setupMemoryMocks(
      globalPaths: string[] = [],
      projectPaths: string[] = [],
    ) {
      vi.mocked(memoryDiscovery.getGlobalMemoryPaths).mockResolvedValue(
        globalPaths,
      );
      vi.mocked(memoryDiscovery.getEnvironmentMemoryPaths).mockResolvedValue({
        project: projectPaths,
        local: [],
      });
      vi.mocked(memoryDiscovery.readMemoryMdFiles).mockImplementation(
        async (paths) =>
          paths.map((p) => ({
            filePath: p,
            content: `content of ${p}`,
          })),
      );
    }

    it('should fire hooks once per file on first refresh', async () => {
      setupMockHookSystem();
      setupMemoryMocks(['/global/AGENTS.md'], ['/app/AGENTS.md']);

      await memoryContextManager.refresh();

      expect(mockHookSystem.fireInstructionsLoadedEvent).toHaveBeenCalledTimes(
        2,
      );
      expect(mockHookSystem.fireInstructionsLoadedEvent).toHaveBeenCalledWith(
        '/global/AGENTS.md',
        'User',
        'session_start',
      );
      expect(mockHookSystem.fireInstructionsLoadedEvent).toHaveBeenCalledWith(
        '/app/AGENTS.md',
        'Project',
        'session_start',
      );
    });

    it('should NOT re-fire hooks on second refresh (dedup)', async () => {
      setupMockHookSystem();
      setupMemoryMocks(['/global/AGENTS.md'], ['/app/AGENTS.md']);

      await memoryContextManager.refresh();
      expect(mockHookSystem.fireInstructionsLoadedEvent).toHaveBeenCalledTimes(
        2,
      );

      mockHookSystem.fireInstructionsLoadedEvent.mockClear();
      await memoryContextManager.refresh();
      expect(mockHookSystem.fireInstructionsLoadedEvent).toHaveBeenCalledTimes(
        0,
      );
    });

    it('should re-fire hooks automatically on compact refresh', async () => {
      setupMockHookSystem();
      setupMemoryMocks(['/global/AGENTS.md']);

      await memoryContextManager.refresh();
      expect(mockHookSystem.fireInstructionsLoadedEvent).toHaveBeenCalledTimes(
        1,
      );

      mockHookSystem.fireInstructionsLoadedEvent.mockClear();
      await memoryContextManager.refresh('compact');

      expect(mockHookSystem.fireInstructionsLoadedEvent).toHaveBeenCalledTimes(
        1,
      );
      expect(mockHookSystem.fireInstructionsLoadedEvent).toHaveBeenCalledWith(
        '/global/AGENTS.md',
        'User',
        'compact',
      );
    });

    it('resets compact hook dedup after an earlier queued refresh finishes', async () => {
      setupMockHookSystem();
      setupMemoryMocks(['/global/AGENTS.md']);

      let releaseRuleIndex: () => void = () => undefined;
      const ruleIndex = new Promise<[]>((resolve) => {
        releaseRuleIndex = () => resolve([]);
      });
      vi.mocked(
        memoryDiscovery.getUserModelDecisionRuleEntries,
      ).mockImplementationOnce(() => ruleIndex);

      const ordinaryRefresh = memoryContextManager.refresh();
      await vi.waitFor(() =>
        expect(
          memoryDiscovery.getUserModelDecisionRuleEntries,
        ).toHaveBeenCalledTimes(1),
      );
      const compactRefresh = memoryContextManager.refresh('compact');

      releaseRuleIndex();
      await Promise.all([ordinaryRefresh, compactRefresh]);

      expect(mockHookSystem.fireInstructionsLoadedEvent).toHaveBeenCalledTimes(
        2,
      );
      expect(
        mockHookSystem.fireInstructionsLoadedEvent,
      ).toHaveBeenNthCalledWith(
        1,
        '/global/AGENTS.md',
        'User',
        'session_start',
      );
      expect(
        mockHookSystem.fireInstructionsLoadedEvent,
      ).toHaveBeenNthCalledWith(2, '/global/AGENTS.md', 'User', 'compact');
    });

    it('should propagate loadReason to hooks', async () => {
      setupMockHookSystem();
      setupMemoryMocks(['/global/AGENTS.md']);

      await memoryContextManager.refresh('compact');

      expect(mockHookSystem.fireInstructionsLoadedEvent).toHaveBeenCalledWith(
        '/global/AGENTS.md',
        'User',
        'compact',
      );
    });

    it('should skip hooks entirely when no hooks are configured (fast-path)', async () => {
      const emptyRegistryHookSystem = {
        getRegistry: vi.fn().mockReturnValue({
          getHooksForEvent: vi.fn().mockReturnValue([]),
        }),
        fireInstructionsLoadedEvent: vi.fn().mockResolvedValue({ results: [] }),
      };
      vi.mocked(mockConfig.getHookSystem).mockReturnValue(
        emptyRegistryHookSystem as unknown as ReturnType<
          Config['getHookSystem']
        >,
      );

      setupMemoryMocks(['/global/AGENTS.md']);

      await memoryContextManager.refresh();

      expect(
        emptyRegistryHookSystem.fireInstructionsLoadedEvent,
      ).not.toHaveBeenCalled();
    });

    it('should dedup JIT hooks against startup-loaded paths', async () => {
      setupMockHookSystem();
      setupMemoryMocks(['/global/AGENTS.md'], ['/app/AGENTS.md']);

      await memoryContextManager.refresh();
      mockHookSystem.fireInstructionsLoadedEvent.mockClear();

      // Simulate JIT discovery returning a file already loaded in refresh
      vi.mocked(memoryDiscovery.loadJitSubdirectoryMemory).mockResolvedValue({
        files: [{ path: '/app/AGENTS.md', content: 'content' }],
      });

      await memoryContextManager.discoverContext('/app/src/file.ts', ['/app']);

      // Should NOT fire because /app/AGENTS.md was already tracked by refresh
      expect(mockHookSystem.fireInstructionsLoadedEvent).not.toHaveBeenCalled();
    });

    it('should fire JIT hooks for genuinely new paths', async () => {
      setupMockHookSystem();
      setupMemoryMocks(['/global/AGENTS.md']);

      await memoryContextManager.refresh();
      mockHookSystem.fireInstructionsLoadedEvent.mockClear();

      vi.mocked(memoryDiscovery.loadJitSubdirectoryMemory).mockResolvedValue({
        files: [{ path: '/app/src/AGENTS.md', content: 'new content' }],
      });

      await memoryContextManager.discoverContext('/app/src/file.ts', ['/app']);

      expect(mockHookSystem.fireInstructionsLoadedEvent).toHaveBeenCalledTimes(
        1,
      );
      expect(mockHookSystem.fireInstructionsLoadedEvent).toHaveBeenCalledWith(
        '/app/src/AGENTS.md',
        'Project',
        'nested_traversal',
        { triggerFilePath: '/app/src/file.ts' },
      );
    });
  });

  describe('include hooks for @imported files', () => {
    let mockHookSystem: {
      getRegistry: ReturnType<typeof vi.fn>;
      fireInstructionsLoadedEvent: ReturnType<typeof vi.fn>;
    };

    function setupMockHookSystem() {
      mockHookSystem = {
        getRegistry: vi.fn().mockReturnValue({
          getHooksForEvent: vi.fn().mockReturnValue([{ id: 'test-hook' }]),
        }),
        fireInstructionsLoadedEvent: vi.fn().mockResolvedValue({ results: [] }),
      };
      vi.mocked(mockConfig.getHookSystem).mockReturnValue(
        mockHookSystem as unknown as ReturnType<Config['getHookSystem']>,
      );
    }

    function setupMemoryMocksWithImports(
      globalPaths: string[] = [],
      projectPaths: string[] = [],
      importParentMaps?: Map<string, Map<string, string>>,
    ) {
      vi.mocked(memoryDiscovery.getGlobalMemoryPaths).mockResolvedValue(
        globalPaths,
      );
      vi.mocked(memoryDiscovery.getEnvironmentMemoryPaths).mockResolvedValue({
        project: projectPaths,
        local: [],
      });
      vi.mocked(memoryDiscovery.readMemoryMdFiles).mockImplementation(
        async (paths) =>
          paths.map((p) => ({
            filePath: p,
            content: `content of ${p}`,
            importParentMap: importParentMaps?.get(p),
          })),
      );
    }

    it('should fire include hooks for @imported child files', async () => {
      setupMockHookSystem();
      const parentMap = new Map<string, string>([
        ['/app/imported.md', '/app/AGENTS.md'],
      ]);
      setupMemoryMocksWithImports(
        [],
        ['/app/AGENTS.md'],
        new Map([['/app/AGENTS.md', parentMap]]),
      );

      await memoryContextManager.refresh();

      // Should fire for the main file + the imported child
      expect(mockHookSystem.fireInstructionsLoadedEvent).toHaveBeenCalledTimes(
        2,
      );
      expect(mockHookSystem.fireInstructionsLoadedEvent).toHaveBeenCalledWith(
        '/app/AGENTS.md',
        'Project',
        'session_start',
      );
      expect(mockHookSystem.fireInstructionsLoadedEvent).toHaveBeenCalledWith(
        '/app/imported.md',
        'Project',
        'include',
        { parentFilePath: '/app/AGENTS.md' },
      );
    });

    it('should not re-fire include hooks on second refresh (dedup)', async () => {
      setupMockHookSystem();
      const parentMap = new Map<string, string>([
        ['/app/imported.md', '/app/AGENTS.md'],
      ]);
      setupMemoryMocksWithImports(
        [],
        ['/app/AGENTS.md'],
        new Map([['/app/AGENTS.md', parentMap]]),
      );

      await memoryContextManager.refresh();
      expect(mockHookSystem.fireInstructionsLoadedEvent).toHaveBeenCalledTimes(
        2,
      );

      mockHookSystem.fireInstructionsLoadedEvent.mockClear();
      await memoryContextManager.refresh();
      expect(mockHookSystem.fireInstructionsLoadedEvent).toHaveBeenCalledTimes(
        0,
      );
    });

    it('should fire include hooks for JIT-discovered @imported files', async () => {
      setupMockHookSystem();
      setupMemoryMocksWithImports(['/global/AGENTS.md']);

      await memoryContextManager.refresh();
      mockHookSystem.fireInstructionsLoadedEvent.mockClear();

      const jitImportParentMap = new Map<string, string>([
        ['/app/src/helpers.md', '/app/src/AGENTS.md'],
      ]);
      vi.mocked(memoryDiscovery.loadJitSubdirectoryMemory).mockResolvedValue({
        files: [{ path: '/app/src/AGENTS.md', content: 'jit content' }],
        importParentMap: jitImportParentMap,
      });

      await memoryContextManager.discoverContext('/app/src/file.ts', ['/app']);

      // Should fire nested_traversal for the main file + include for the imported child
      expect(mockHookSystem.fireInstructionsLoadedEvent).toHaveBeenCalledTimes(
        2,
      );
      expect(mockHookSystem.fireInstructionsLoadedEvent).toHaveBeenCalledWith(
        '/app/src/AGENTS.md',
        'Project',
        'nested_traversal',
        { triggerFilePath: '/app/src/file.ts' },
      );
      expect(mockHookSystem.fireInstructionsLoadedEvent).toHaveBeenCalledWith(
        '/app/src/helpers.md',
        'Project',
        'include',
        {
          parentFilePath: '/app/src/AGENTS.md',
          triggerFilePath: '/app/src/file.ts',
        },
      );
    });

    it('should inherit parent memoryType for imported files', async () => {
      setupMockHookSystem();
      const parentMap = new Map<string, string>([
        ['/global/imported.md', `/home/user/${CONFIG_DIR}/AGENTS.md`],
      ]);
      setupMemoryMocksWithImports(
        [`/home/user/${CONFIG_DIR}/AGENTS.md`],
        [],
        new Map([[`/home/user/${CONFIG_DIR}/AGENTS.md`, parentMap]]),
      );

      await memoryContextManager.refresh();

      expect(mockHookSystem.fireInstructionsLoadedEvent).toHaveBeenCalledWith(
        '/global/imported.md',
        'User',
        'include',
        { parentFilePath: `/home/user/${CONFIG_DIR}/AGENTS.md` },
      );
    });
  });

  describe('memory_type normalization', () => {
    let mockHookSystem: {
      getRegistry: ReturnType<typeof vi.fn>;
      fireInstructionsLoadedEvent: ReturnType<typeof vi.fn>;
    };

    it('should use Project as fallback memoryType instead of unknown', async () => {
      mockHookSystem = {
        getRegistry: vi.fn().mockReturnValue({
          getHooksForEvent: vi.fn().mockReturnValue([{ id: 'test-hook' }]),
        }),
        fireInstructionsLoadedEvent: vi.fn().mockResolvedValue({ results: [] }),
      };
      vi.mocked(mockConfig.getHookSystem).mockReturnValue(
        mockHookSystem as unknown as ReturnType<Config['getHookSystem']>,
      );

      vi.mocked(memoryDiscovery.getGlobalMemoryPaths).mockResolvedValue([]);
      vi.mocked(memoryDiscovery.getEnvironmentMemoryPaths).mockResolvedValue({
        project: ['/app/AGENTS.md'],
        local: [],
      });
      vi.mocked(memoryDiscovery.readMemoryMdFiles).mockImplementation(
        async (paths) =>
          paths.map((p) => ({
            filePath: p,
            content: `content of ${p}`,
          })),
      );

      await memoryContextManager.refresh();

      // The hook should be called with 'Project' not 'unknown'
      const calls = mockHookSystem.fireInstructionsLoadedEvent.mock.calls;
      for (const call of calls) {
        expect(call[1]).not.toBe('unknown');
      }
    });
  });

  describe('import warning emissions', () => {
    beforeEach(() => {
      vi.spyOn(coreEvents, 'emitFeedback');
    });

    it('should emit warning for blocked external imports during refresh', async () => {
      vi.mocked(memoryDiscovery.getGlobalMemoryPaths).mockResolvedValue([]);
      vi.mocked(memoryDiscovery.getEnvironmentMemoryPaths).mockResolvedValue({
        project: ['/app/AGENTS.md'],
        local: [],
      });

      vi.mocked(memoryDiscovery.readMemoryMdFiles).mockResolvedValue([
        {
          filePath: '/app/AGENTS.md',
          content: 'Content with blocked import',
          blockedExternalImports: [
            {
              importPath: '../../outside/secret.md',
              resolvedPath: '/outside/secret.md',
              sourceFile: '/app/AGENTS.md',
            },
          ],
        },
      ]);

      await memoryContextManager.refresh();

      expect(coreEvents.emitFeedback).toHaveBeenCalledWith(
        'warning',
        expect.stringContaining('external @import(s) blocked'),
      );
    });

    it('should NOT emit warning for failed imports during refresh', async () => {
      // Failed @import warnings are intentionally suppressed on load/refresh to
      // avoid false positives from npm scoped-package mentions (e.g.
      // `@scope/pkg/file.js`) that get misread as file imports.
      vi.mocked(memoryDiscovery.getGlobalMemoryPaths).mockResolvedValue([]);
      vi.mocked(memoryDiscovery.getEnvironmentMemoryPaths).mockResolvedValue({
        project: ['/app/AGENTS.md'],
        local: [],
      });

      vi.mocked(memoryDiscovery.readMemoryMdFiles).mockResolvedValue([
        {
          filePath: '/app/AGENTS.md',
          content: 'Content with failed import',
          failedImports: [
            {
              importPath: './nonexistent.md',
              resolvedPath: '/app/nonexistent.md',
              sourceFile: '/app/AGENTS.md',
              error: 'ENOENT: no such file or directory',
            },
          ],
        },
      ]);

      await memoryContextManager.refresh();

      expect(coreEvents.emitFeedback).not.toHaveBeenCalledWith(
        'warning',
        expect.stringContaining('@import(s) failed'),
      );
    });

    it('should emit warning for failed imports during JIT discovery', async () => {
      // First do a basic refresh
      vi.mocked(memoryDiscovery.getGlobalMemoryPaths).mockResolvedValue([]);
      vi.mocked(memoryDiscovery.getEnvironmentMemoryPaths).mockResolvedValue({
        project: [],
        local: [],
      });
      vi.mocked(memoryDiscovery.readMemoryMdFiles).mockResolvedValue([]);
      await memoryContextManager.refresh();

      // Now simulate JIT discovery with failed import
      vi.mocked(memoryDiscovery.loadJitSubdirectoryMemory).mockResolvedValue({
        files: [{ path: '/app/src/AGENTS.md', content: 'JIT content' }],
        failedImports: [
          {
            importPath: './missing.md',
            resolvedPath: '/app/src/missing.md',
            sourceFile: '/app/src/AGENTS.md',
            error: 'ENOENT: no such file or directory',
          },
        ],
      });

      await memoryContextManager.discoverContext('/app/src/file.ts', ['/app']);

      expect(coreEvents.emitFeedback).toHaveBeenCalledWith(
        'warning',
        expect.stringContaining('@import(s) failed'),
      );
    });

    it('should not emit warnings when no import issues', async () => {
      vi.mocked(memoryDiscovery.getGlobalMemoryPaths).mockResolvedValue([]);
      vi.mocked(memoryDiscovery.getEnvironmentMemoryPaths).mockResolvedValue({
        project: ['/app/AGENTS.md'],
        local: [],
      });

      vi.mocked(memoryDiscovery.readMemoryMdFiles).mockResolvedValue([
        {
          filePath: '/app/AGENTS.md',
          content: 'Clean content with no imports',
        },
      ]);

      await memoryContextManager.refresh();

      expect(coreEvents.emitFeedback).not.toHaveBeenCalled();
    });
  });
});

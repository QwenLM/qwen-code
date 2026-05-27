/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ---------------------------------------------------------------------------
// Mock sub-service factories — inline return values (no external refs).
// ---------------------------------------------------------------------------

vi.mock('../fileService.js', () => ({
  createFileService: vi.fn(() => ({
    resolve: vi.fn(),
    stat: vi.fn(),
    readText: vi.fn(),
    readBytes: vi.fn(),
    readBytesWindow: vi.fn(),
    list: vi.fn(),
    glob: vi.fn(),
    writeTextAtomic: vi.fn(),
    writeTextOverwrite: vi.fn(),
    edit: vi.fn(),
  })),
}));

vi.mock('../authService.js', () => ({
  createAuthService: vi.fn(() => ({
    startDeviceFlow: vi.fn(),
    getDeviceFlow: vi.fn(),
    cancelDeviceFlow: vi.fn(),
    listPendingDeviceFlows: vi.fn().mockReturnValue([]),
    getAuthStatus: vi.fn(),
  })),
}));

vi.mock('../agentsService.js', () => ({
  createAgentsService: vi.fn(() => ({
    listAgents: vi.fn(),
    getAgent: vi.fn(),
    createAgent: vi.fn(),
    updateAgent: vi.fn(),
    deleteAgent: vi.fn(),
  })),
}));

vi.mock('../memoryService.js', () => ({
  createMemoryService: vi.fn(() => ({
    list: vi.fn(),
    read: vi.fn(),
    write: vi.fn(),
    delete: vi.fn(),
  })),
}));

// Mock @qwen-code/qwen-code-core to avoid the undici dependency chain.
// This is required so @qwen-code/acp-bridge/status can load (it imports
// SkillError from core).
vi.mock('@qwen-code/qwen-code-core', () => {
  class SkillError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'SkillError';
      this.code = code;
    }
  }
  return { SkillError };
});

const { createDaemonWorkspaceService } = await import('../index.js');
import type {
  DaemonWorkspaceServiceDeps,
  WorkspaceRequestContext,
} from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(
  overrides: Partial<DaemonWorkspaceServiceDeps> = {},
): DaemonWorkspaceServiceDeps {
  return {
    boundWorkspace: '/workspace',
    contextFilename: 'QWEN.md',
    fsFactory: {
      forRequest: vi.fn(),
    } as unknown as DaemonWorkspaceServiceDeps['fsFactory'],
    deviceFlowRegistry: undefined,
    subagentManager: undefined,
    persistDisabledTools: vi.fn().mockResolvedValue(undefined),
    queryWorkspaceStatus: vi
      .fn()
      .mockImplementation((_method: string, idle: () => unknown) =>
        Promise.resolve(idle()),
      ),
    invokeWorkspaceCommand: vi.fn().mockResolvedValue({
      serverName: 'test',
      restarted: true,
      durationMs: 42,
    }),
    publishWorkspaceEvent: vi.fn(),
    knownClientIds: vi.fn().mockReturnValue(new Set(['client-1'])),
    ...overrides,
  };
}

function makeCtx(
  overrides: Partial<WorkspaceRequestContext> = {},
): WorkspaceRequestContext {
  return {
    route: 'TEST /test',
    workspaceCwd: '/workspace',
    originatorClientId: 'client-1',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createDaemonWorkspaceService', () => {
  describe('sub-service exposure', () => {
    it('exposes file, auth, agents, and memory sub-services', () => {
      const svc = createDaemonWorkspaceService(makeDeps());
      expect(svc.file).toBeDefined();
      expect(svc.auth).toBeDefined();
      expect(svc.agents).toBeDefined();
      expect(svc.memory).toBeDefined();
    });

    it('file sub-service has expected methods', () => {
      const svc = createDaemonWorkspaceService(makeDeps());
      expect(typeof svc.file.resolve).toBe('function');
      expect(typeof svc.file.readText).toBe('function');
      expect(typeof svc.file.writeTextAtomic).toBe('function');
    });

    it('auth sub-service has expected methods', () => {
      const svc = createDaemonWorkspaceService(makeDeps());
      expect(typeof svc.auth.startDeviceFlow).toBe('function');
      expect(typeof svc.auth.listPendingDeviceFlows).toBe('function');
    });

    it('agents sub-service has expected methods', () => {
      const svc = createDaemonWorkspaceService(makeDeps());
      expect(typeof svc.agents.listAgents).toBe('function');
      expect(typeof svc.agents.createAgent).toBe('function');
    });

    it('memory sub-service has expected methods', () => {
      const svc = createDaemonWorkspaceService(makeDeps());
      expect(typeof svc.memory.list).toBe('function');
      expect(typeof svc.memory.write).toBe('function');
    });
  });

  describe('status methods', () => {
    it('getWorkspaceMcpStatus delegates to queryWorkspaceStatus with correct method', async () => {
      const queryWorkspaceStatus = vi
        .fn()
        .mockResolvedValue({ v: 1, servers: [] });
      const svc = createDaemonWorkspaceService(
        makeDeps({ queryWorkspaceStatus }),
      );

      await svc.getWorkspaceMcpStatus(makeCtx());

      expect(queryWorkspaceStatus).toHaveBeenCalledWith(
        'qwen/status/workspace/mcp',
        expect.any(Function),
      );
    });

    it('getWorkspaceMcpStatus idle fallback returns correct envelope', async () => {
      const queryWorkspaceStatus = vi
        .fn()
        .mockImplementation((_m: string, idle: () => unknown) =>
          Promise.resolve(idle()),
        );
      const svc = createDaemonWorkspaceService(
        makeDeps({
          queryWorkspaceStatus,
          boundWorkspace: '/my/ws',
        }),
      );

      const result = await svc.getWorkspaceMcpStatus(makeCtx());

      expect(result.workspaceCwd).toBe('/my/ws');
      expect(result.initialized).toBe(false);
      expect(result.servers).toEqual([]);
    });

    it('getWorkspaceSkillsStatus delegates with correct method', async () => {
      const queryWorkspaceStatus = vi
        .fn()
        .mockResolvedValue({ v: 1, skills: [] });
      const svc = createDaemonWorkspaceService(
        makeDeps({ queryWorkspaceStatus }),
      );

      await svc.getWorkspaceSkillsStatus(makeCtx());

      expect(queryWorkspaceStatus).toHaveBeenCalledWith(
        'qwen/status/workspace/skills',
        expect.any(Function),
      );
    });

    it('getWorkspaceSkillsStatus idle fallback returns correct envelope', async () => {
      const queryWorkspaceStatus = vi
        .fn()
        .mockImplementation((_m: string, idle: () => unknown) =>
          Promise.resolve(idle()),
        );
      const svc = createDaemonWorkspaceService(
        makeDeps({
          queryWorkspaceStatus,
          boundWorkspace: '/ws',
        }),
      );

      const result = await svc.getWorkspaceSkillsStatus(makeCtx());

      expect(result.workspaceCwd).toBe('/ws');
      expect(result.initialized).toBe(false);
      expect(result.skills).toEqual([]);
    });

    it('getWorkspaceProvidersStatus delegates with correct method', async () => {
      const queryWorkspaceStatus = vi
        .fn()
        .mockResolvedValue({ v: 1, providers: [] });
      const svc = createDaemonWorkspaceService(
        makeDeps({ queryWorkspaceStatus }),
      );

      await svc.getWorkspaceProvidersStatus(makeCtx());

      expect(queryWorkspaceStatus).toHaveBeenCalledWith(
        'qwen/status/workspace/providers',
        expect.any(Function),
      );
    });

    it('getWorkspaceEnvStatus uses statusProvider instead of queryWorkspaceStatus', async () => {
      const queryWorkspaceStatus = vi
        .fn()
        .mockResolvedValue({ v: 1, cells: [] });
      const statusProvider: DaemonWorkspaceServiceDeps['statusProvider'] = {
        getEnvStatus: vi.fn().mockResolvedValue({
          v: 1,
          workspaceCwd: '/workspace',
          initialized: true,
          acpChannelLive: false,
          cells: [
            { kind: 'runtime', name: 'node', status: 'ok', present: true },
          ],
        }),
        getDaemonPreflightCells: vi.fn().mockResolvedValue([]),
      };
      const svc = createDaemonWorkspaceService(
        makeDeps({
          queryWorkspaceStatus,
          statusProvider,
        }),
      );

      const result = await svc.getWorkspaceEnvStatus(makeCtx());

      // Env status is daemon-local — queryWorkspaceStatus must NOT be called.
      expect(queryWorkspaceStatus).not.toHaveBeenCalled();
      expect(statusProvider.getEnvStatus).toHaveBeenCalledWith(
        '/workspace',
        false,
      );
      expect(result.initialized).toBe(true);
    });

    it('getWorkspaceEnvStatus fallback has acpChannelLive=false when no statusProvider', async () => {
      const queryWorkspaceStatus = vi
        .fn()
        .mockImplementation((_m: string, idle: () => unknown) =>
          Promise.resolve(idle()),
        );
      const svc = createDaemonWorkspaceService(
        makeDeps({
          queryWorkspaceStatus,
          statusProvider: undefined,
        }),
      );

      const result = await svc.getWorkspaceEnvStatus(makeCtx());

      expect(result.acpChannelLive).toBe(false);
      expect(result.initialized).toBe(true);
    });

    it('getWorkspacePreflightStatus queries ACP only when channel is live', async () => {
      const queryWorkspaceStatus = vi.fn().mockResolvedValue({
        cells: [{ kind: 'auth', status: 'ok', locality: 'acp' }],
      });
      const svc = createDaemonWorkspaceService(
        makeDeps({
          queryWorkspaceStatus,
          isChannelLive: () => true,
        }),
      );

      await svc.getWorkspacePreflightStatus(makeCtx());

      expect(queryWorkspaceStatus).toHaveBeenCalledWith(
        'qwen/status/workspace/preflight',
        expect.any(Function),
      );
    });

    it('getWorkspacePreflightStatus idle fallback includes ACP placeholder cells', async () => {
      const queryWorkspaceStatus = vi
        .fn()
        .mockImplementation((_m: string, idle: () => unknown) =>
          Promise.resolve(idle()),
        );
      const svc = createDaemonWorkspaceService(
        makeDeps({
          queryWorkspaceStatus,
          isChannelLive: () => false,
        }),
      );

      const result = await svc.getWorkspacePreflightStatus(makeCtx());

      expect(result.acpChannelLive).toBe(false);
      // When no statusProvider is given, daemon cells are empty; only ACP idle cells.
      const acpCells = result.cells.filter((c) => c.locality === 'acp');
      expect(acpCells.length).toBe(6);
      expect(acpCells.every((c) => c.status === 'not_started')).toBe(true);
      // queryWorkspaceStatus should NOT be called when channel is not live.
      expect(queryWorkspaceStatus).not.toHaveBeenCalled();
    });
  });

  describe('setWorkspaceToolEnabled', () => {
    it('calls persistDisabledTools with workspace, toolName, and enabled', async () => {
      const persistDisabledTools = vi.fn().mockResolvedValue(undefined);
      const svc = createDaemonWorkspaceService(
        makeDeps({
          persistDisabledTools,
          boundWorkspace: '/my/workspace',
        }),
      );

      await svc.setWorkspaceToolEnabled(makeCtx(), 'Bash', false);

      expect(persistDisabledTools).toHaveBeenCalledWith(
        '/my/workspace',
        'Bash',
        false,
      );
    });

    it('publishes tool_toggled event with originatorClientId', async () => {
      const publishWorkspaceEvent = vi.fn();
      const svc = createDaemonWorkspaceService(
        makeDeps({ publishWorkspaceEvent }),
      );

      await svc.setWorkspaceToolEnabled(
        makeCtx({ originatorClientId: 'c-42' }),
        'Read',
        true,
      );

      expect(publishWorkspaceEvent).toHaveBeenCalledWith({
        type: 'tool_toggled',
        data: { toolName: 'Read', enabled: true },
        originatorClientId: 'c-42',
      });
    });

    it('returns the toolName and enabled state', async () => {
      const svc = createDaemonWorkspaceService(makeDeps());

      const result = await svc.setWorkspaceToolEnabled(
        makeCtx(),
        'WebSearch',
        false,
      );

      expect(result).toEqual({ toolName: 'WebSearch', enabled: false });
    });
  });

  describe('restartMcpServer', () => {
    it('calls invokeWorkspaceCommand with correct method and params', async () => {
      const invokeWorkspaceCommand = vi.fn().mockResolvedValue({
        serverName: 'myServer',
        restarted: true,
        durationMs: 100,
      });
      const svc = createDaemonWorkspaceService(
        makeDeps({ invokeWorkspaceCommand }),
      );

      await svc.restartMcpServer(makeCtx(), 'myServer');

      expect(invokeWorkspaceCommand).toHaveBeenCalledWith(
        'qwen/control/workspace/mcp/restart',
        { serverName: 'myServer' },
        { timeoutMs: 300_000 },
      );
    });

    it('passes entryIndex when provided', async () => {
      const invokeWorkspaceCommand = vi.fn().mockResolvedValue({
        serverName: 's',
        restarted: true,
        durationMs: 50,
      });
      const svc = createDaemonWorkspaceService(
        makeDeps({ invokeWorkspaceCommand }),
      );

      await svc.restartMcpServer(makeCtx(), 'poolServer', { entryIndex: 3 });

      expect(invokeWorkspaceCommand).toHaveBeenCalledWith(
        'qwen/control/workspace/mcp/restart',
        { serverName: 'poolServer', entryIndex: 3 },
        { timeoutMs: 300_000 },
      );
    });

    it('publishes mcp_server_restarted event after success', async () => {
      const publishWorkspaceEvent = vi.fn();
      const invokeResult = { serverName: 'x', restarted: true, durationMs: 10 };
      const invokeWorkspaceCommand = vi.fn().mockResolvedValue(invokeResult);
      const svc = createDaemonWorkspaceService(
        makeDeps({
          invokeWorkspaceCommand,
          publishWorkspaceEvent,
        }),
      );

      await svc.restartMcpServer(makeCtx({ originatorClientId: 'c-7' }), 'x');

      expect(publishWorkspaceEvent).toHaveBeenCalledWith({
        type: 'mcp_server_restarted',
        data: { serverName: 'x', durationMs: 10 },
        originatorClientId: 'c-7',
      });
    });

    it('returns the result from invokeWorkspaceCommand', async () => {
      const invokeResult = {
        serverName: 'srv',
        restarted: false,
        skipped: true,
        reason: 'disabled',
      };
      const invokeWorkspaceCommand = vi.fn().mockResolvedValue(invokeResult);
      const svc = createDaemonWorkspaceService(
        makeDeps({ invokeWorkspaceCommand }),
      );

      const result = await svc.restartMcpServer(makeCtx(), 'srv');

      expect(result).toEqual(invokeResult);
    });
  });

  describe('initWorkspace', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'facade-test-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('creates a new file and returns action=created', async () => {
      const publishWorkspaceEvent = vi.fn();
      const svc = createDaemonWorkspaceService(
        makeDeps({
          boundWorkspace: tmpDir,
          contextFilename: 'QWEN.md',
          publishWorkspaceEvent,
        }),
      );

      const result = await svc.initWorkspace(
        makeCtx({ workspaceCwd: tmpDir }),
        {},
      );

      expect(result.action).toBe('created');
      expect(result.path).toBe(path.join(tmpDir, 'QWEN.md'));
      const stat = await fs.stat(result.path);
      expect(stat.isFile()).toBe(true);
    });

    it('publishes workspace_initialized event on create', async () => {
      const publishWorkspaceEvent = vi.fn();
      const svc = createDaemonWorkspaceService(
        makeDeps({
          boundWorkspace: tmpDir,
          contextFilename: 'QWEN.md',
          publishWorkspaceEvent,
        }),
      );

      await svc.initWorkspace(makeCtx({ originatorClientId: 'c-9' }), {});

      expect(publishWorkspaceEvent).toHaveBeenCalledWith({
        type: 'workspace_initialized',
        data: { path: path.join(tmpDir, 'QWEN.md'), action: 'created' },
        originatorClientId: 'c-9',
      });
    });

    it('returns noop when file exists but is whitespace-only', async () => {
      const target = path.join(tmpDir, 'QWEN.md');
      await fs.writeFile(target, '   \n  ', 'utf8');

      const svc = createDaemonWorkspaceService(
        makeDeps({
          boundWorkspace: tmpDir,
          contextFilename: 'QWEN.md',
        }),
      );

      const result = await svc.initWorkspace(makeCtx(), {});

      expect(result.action).toBe('noop');
    });

    it('throws when file has content and force is not set', async () => {
      const target = path.join(tmpDir, 'QWEN.md');
      await fs.writeFile(target, '# Hello', 'utf8');

      const svc = createDaemonWorkspaceService(
        makeDeps({
          boundWorkspace: tmpDir,
          contextFilename: 'QWEN.md',
        }),
      );

      await expect(svc.initWorkspace(makeCtx(), {})).rejects.toThrow(
        /already exists/,
      );
    });

    it('overwrites existing file when force=true', async () => {
      const target = path.join(tmpDir, 'QWEN.md');
      await fs.writeFile(target, '# Existing content', 'utf8');

      const svc = createDaemonWorkspaceService(
        makeDeps({
          boundWorkspace: tmpDir,
          contextFilename: 'QWEN.md',
        }),
      );

      const result = await svc.initWorkspace(makeCtx(), { force: true });

      expect(result.action).toBe('overwrote');
      const content = await fs.readFile(target, 'utf8');
      expect(content).toBe('');
    });

    it('throws for escaping filename', async () => {
      const svc = createDaemonWorkspaceService(
        makeDeps({
          boundWorkspace: tmpDir,
          contextFilename: '../escape.md',
        }),
      );

      await expect(svc.initWorkspace(makeCtx(), {})).rejects.toThrow(
        /resolves outside/,
      );
    });

    it('throws when target is a symlink', async () => {
      const realFile = path.join(tmpDir, 'real.md');
      const linkFile = path.join(tmpDir, 'QWEN.md');
      await fs.writeFile(realFile, '', 'utf8');
      await fs.symlink(realFile, linkFile);

      const svc = createDaemonWorkspaceService(
        makeDeps({
          boundWorkspace: tmpDir,
          contextFilename: 'QWEN.md',
        }),
      );

      await expect(svc.initWorkspace(makeCtx(), {})).rejects.toThrow(/symlink/);
    });
  });
});

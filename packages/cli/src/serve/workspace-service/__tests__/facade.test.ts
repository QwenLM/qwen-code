/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

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

    it('publishes mcp_server_restart_refused event when restarted is false', async () => {
      const publishWorkspaceEvent = vi.fn();
      const invokeResult = {
        serverName: 'blocked',
        restarted: false,
        skipped: true,
        reason: 'in_flight',
      };
      const invokeWorkspaceCommand = vi.fn().mockResolvedValue(invokeResult);
      const svc = createDaemonWorkspaceService(
        makeDeps({ invokeWorkspaceCommand, publishWorkspaceEvent }),
      );

      await svc.restartMcpServer(
        makeCtx({ originatorClientId: 'c-1' }),
        'blocked',
      );

      expect(publishWorkspaceEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'mcp_server_restart_refused',
          data: expect.objectContaining({ serverName: 'blocked' }),
          originatorClientId: 'c-1',
        }),
      );
    });

    it('translates mcp_server_not_found errorKind into McpServerNotFoundError', async () => {
      const err = Object.assign(new Error('not found'), {
        data: { errorKind: 'mcp_server_not_found', serverName: 'ghost' },
      });
      const invokeWorkspaceCommand = vi.fn().mockRejectedValue(err);
      const svc = createDaemonWorkspaceService(
        makeDeps({ invokeWorkspaceCommand }),
      );

      await expect(svc.restartMcpServer(makeCtx(), 'ghost')).rejects.toThrow(
        /ghost/,
      );
    });

    it('translates mcp_restart_failed errorKind into McpServerRestartFailedError', async () => {
      const err = Object.assign(new Error('restart failed'), {
        data: {
          errorKind: 'mcp_restart_failed',
          serverName: 'broken',
          mcpStatus: 'disconnected',
        },
      });
      const invokeWorkspaceCommand = vi.fn().mockRejectedValue(err);
      const svc = createDaemonWorkspaceService(
        makeDeps({ invokeWorkspaceCommand }),
      );

      await expect(svc.restartMcpServer(makeCtx(), 'broken')).rejects.toThrow(
        /broken/,
      );
    });

    it('re-throws non-errorKind errors without translation', async () => {
      const err = new Error('generic boom');
      const invokeWorkspaceCommand = vi.fn().mockRejectedValue(err);
      const svc = createDaemonWorkspaceService(
        makeDeps({ invokeWorkspaceCommand }),
      );

      await expect(svc.restartMcpServer(makeCtx(), 'srv')).rejects.toThrow(
        'generic boom',
      );
    });

    it('fans out per-entry events in pool-mode', async () => {
      const publishWorkspaceEvent = vi.fn();
      const invokeResult = {
        serverName: 'pool-srv',
        entries: [
          { entryIndex: 0, restarted: true, durationMs: 50 },
          { entryIndex: 1, restarted: false, reason: 'in_flight' },
        ],
      };
      const invokeWorkspaceCommand = vi.fn().mockResolvedValue(invokeResult);
      const svc = createDaemonWorkspaceService(
        makeDeps({ invokeWorkspaceCommand, publishWorkspaceEvent }),
      );

      await svc.restartMcpServer(
        makeCtx({ originatorClientId: 'c-pool' }),
        'pool-srv',
      );

      expect(publishWorkspaceEvent).toHaveBeenCalledTimes(2);
      expect(publishWorkspaceEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'mcp_server_restarted',
          data: expect.objectContaining({ entryIndex: 0, durationMs: 50 }),
        }),
      );
      expect(publishWorkspaceEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'mcp_server_restart_refused',
          data: expect.objectContaining({ entryIndex: 1 }),
        }),
      );
    });

    it('skips malformed pool entries without crashing', async () => {
      const publishWorkspaceEvent = vi.fn();
      const invokeResult = {
        serverName: 'pool-srv',
        entries: [
          null,
          { entryIndex: 0, restarted: true, durationMs: 10 },
          'not-an-object',
        ],
      };
      const invokeWorkspaceCommand = vi.fn().mockResolvedValue(invokeResult);
      const svc = createDaemonWorkspaceService(
        makeDeps({ invokeWorkspaceCommand, publishWorkspaceEvent }),
      );

      await svc.restartMcpServer(makeCtx(), 'pool-srv');

      expect(publishWorkspaceEvent).toHaveBeenCalledTimes(1);
      expect(publishWorkspaceEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'mcp_server_restarted',
          data: expect.objectContaining({ entryIndex: 0 }),
        }),
      );
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

    it('throws when target is a FIFO (non-regular file)', async () => {
      const target = path.join(tmpDir, 'QWEN.md');
      const { execSync } = await import('node:child_process');
      try {
        execSync(`mkfifo "${target}"`, { stdio: 'ignore' });
      } catch {
        // mkfifo may not be available on all platforms; skip gracefully
        return;
      }

      const svc = createDaemonWorkspaceService(
        makeDeps({
          boundWorkspace: tmpDir,
          contextFilename: 'QWEN.md',
        }),
      );

      await expect(svc.initWorkspace(makeCtx(), {})).rejects.toThrow(
        /not a regular file/,
      );
    });

    it('throws WorkspaceInitConflictError when existing file has content and force is unset', async () => {
      const svc = createDaemonWorkspaceService(
        makeDeps({
          boundWorkspace: tmpDir,
          contextFilename: 'QWEN.md',
        }),
      );

      // Create the file between the readFile ENOENT and the open('wx')
      // by pre-creating it — the 'wx' flag throws EEXIST atomically.
      await fs.writeFile(path.join(tmpDir, 'QWEN.md'), '# content', 'utf8');

      // Since the file has content and force is not set, it throws
      // WorkspaceInitConflictError (not the race). To test the EEXIST
      // race, we'd need to inject between lstat and open — this verifies
      // the conflict guard at least.
      await expect(svc.initWorkspace(makeCtx(), {})).rejects.toThrow(
        /already exists/,
      );
    });

    it('parent symlink outside workspace is rejected', async () => {
      // Create a subdirectory that's actually a symlink to /tmp
      const docsLink = path.join(tmpDir, 'docs');
      await fs.symlink(os.tmpdir(), docsLink);

      const svc = createDaemonWorkspaceService(
        makeDeps({
          boundWorkspace: tmpDir,
          contextFilename: 'docs/QWEN.md',
        }),
      );

      await expect(svc.initWorkspace(makeCtx(), {})).rejects.toThrow(
        /parent.*resolves outside|parent.*workspace/i,
      );
    });
  });
});

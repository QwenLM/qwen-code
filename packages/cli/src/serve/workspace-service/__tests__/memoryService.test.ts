/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock @qwen-code/qwen-code-core so the service can import it without
// pulling in the full dependency tree.
vi.mock('@qwen-code/qwen-code-core', () => ({
  Storage: {
    getGlobalQwenDir: () => '/mock-home/.qwen',
  },
  getAllGeminiMdFilenames: () => ['QWEN.md', 'AGENTS.md'],
  writeWorkspaceContextFile: vi.fn(),
}));

// Mock @qwen-code/acp-bridge/status
vi.mock('@qwen-code/acp-bridge/status', () => {
  const STATUS_SCHEMA_VERSION = 1;
  return {
    STATUS_SCHEMA_VERSION,
    createIdleWorkspaceMemoryStatus: (workspaceCwd: string) => ({
      v: STATUS_SCHEMA_VERSION,
      workspaceCwd,
      initialized: false,
      files: [],
      totalBytes: 0,
      fileCount: 0,
      ruleCount: 0,
    }),
  };
});

// Import the mocked modules so we can control behavior in tests
const { writeWorkspaceContextFile } = (await import(
  '@qwen-code/qwen-code-core'
)) as unknown as { writeWorkspaceContextFile: ReturnType<typeof vi.fn> };

import {
  createMemoryService,
  type MemoryServiceDeps,
} from '../memoryService.js';
import type { WorkspaceRequestContext } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<MemoryServiceDeps>): MemoryServiceDeps {
  return {
    boundWorkspace: '/workspace',
    publishWorkspaceEvent: vi.fn(),
    knownClientIds: () => new Set(['client-1', 'client-2']),
    ...overrides,
  };
}

function makeCtx(
  overrides?: Partial<WorkspaceRequestContext>,
): WorkspaceRequestContext {
  return {
    originatorClientId: 'client-1',
    route: 'POST /workspace/memory',
    workspaceCwd: '/workspace',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemoryService', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memoryService-'));
  });

  describe('list', () => {
    it('returns idle status when no memory files exist', async () => {
      const deps = makeDeps({ boundWorkspace: tmpDir });
      const svc = createMemoryService(deps);

      const result = await svc.list(makeCtx({ workspaceCwd: tmpDir }));

      expect(result.initialized).toBe(false);
      expect(result.files).toHaveLength(0);
      expect(result.totalBytes).toBe(0);
    });

    it('discovers workspace memory files', async () => {
      // Create a QWEN.md in the workspace dir
      const qwenMd = path.join(tmpDir, 'QWEN.md');
      await fs.writeFile(qwenMd, '# Memory\nSome content');

      const deps = makeDeps({ boundWorkspace: tmpDir });
      const svc = createMemoryService(deps);

      const result = await svc.list(makeCtx({ workspaceCwd: tmpDir }));

      expect(result.initialized).toBe(true);
      expect(result.files.length).toBeGreaterThanOrEqual(1);
      const found = result.files.find((f) => f.path === qwenMd);
      expect(found).toBeDefined();
      expect(found!.scope).toBe('workspace');
      expect(found!.bytes).toBeGreaterThan(0);
    });

    it('returns fileCount and totalBytes', async () => {
      const content = '# Memory content here';
      await fs.writeFile(path.join(tmpDir, 'QWEN.md'), content);

      const deps = makeDeps({ boundWorkspace: tmpDir });
      const svc = createMemoryService(deps);

      const result = await svc.list(makeCtx({ workspaceCwd: tmpDir }));

      expect(result.fileCount).toBe(1);
      expect(result.totalBytes).toBe(Buffer.byteLength(content, 'utf8'));
    });
  });

  describe('read', () => {
    it('reads workspace memory file content', async () => {
      const content = '# Workspace Memory\n- entry 1';
      await fs.writeFile(path.join(tmpDir, 'QWEN.md'), content);

      const deps = makeDeps({ boundWorkspace: tmpDir });
      const svc = createMemoryService(deps);

      const result = await svc.read(
        makeCtx({ workspaceCwd: tmpDir }),
        'workspace',
      );

      expect(result.content).toBe(content);
      expect(result.path).toBe(path.join(tmpDir, 'QWEN.md'));
    });

    it('throws when file does not exist', async () => {
      const deps = makeDeps({ boundWorkspace: tmpDir });
      const svc = createMemoryService(deps);

      await expect(
        svc.read(makeCtx({ workspaceCwd: tmpDir }), 'workspace'),
      ).rejects.toThrow();
    });
  });

  describe('write', () => {
    it('validates clientId before writing', async () => {
      const deps = makeDeps();
      const svc = createMemoryService(deps);
      const ctx = makeCtx({ originatorClientId: 'unknown-client' });

      await expect(
        svc.write(ctx, {
          scope: 'workspace',
          content: 'new entry',
          mode: 'append',
        }),
      ).rejects.toThrow('not registered');

      expect(writeWorkspaceContextFile).not.toHaveBeenCalled();
    });

    it('allows mutation when clientId is undefined', async () => {
      (writeWorkspaceContextFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        {
          filePath: '/workspace/QWEN.md',
          bytesWritten: 42,
          changed: true,
        },
      );

      const deps = makeDeps();
      const svc = createMemoryService(deps);
      const ctx = makeCtx({ originatorClientId: undefined });

      const result = await svc.write(ctx, {
        scope: 'workspace',
        content: 'new entry',
        mode: 'append',
      });

      expect(result.path).toBe('/workspace/QWEN.md');
      expect(writeWorkspaceContextFile).toHaveBeenCalled();
    });

    it('allows mutation when clientId is in knownClientIds', async () => {
      (writeWorkspaceContextFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        {
          filePath: '/workspace/QWEN.md',
          bytesWritten: 100,
          changed: true,
        },
      );

      const deps = makeDeps();
      const svc = createMemoryService(deps);
      const ctx = makeCtx({ originatorClientId: 'client-2' });

      const result = await svc.write(ctx, {
        scope: 'workspace',
        content: 'content',
        mode: 'replace',
      });

      expect(result.path).toBe('/workspace/QWEN.md');
      expect(result.scope).toBe('workspace');
      expect(result.bytes).toBe(100);
    });

    it('delegates to writeWorkspaceContextFile with correct params', async () => {
      (writeWorkspaceContextFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        {
          filePath: '/workspace/QWEN.md',
          bytesWritten: 50,
          changed: true,
        },
      );

      const deps = makeDeps();
      const svc = createMemoryService(deps);

      await svc.write(makeCtx(), {
        scope: 'workspace',
        content: '- new memory entry',
        mode: 'append',
      });

      expect(writeWorkspaceContextFile).toHaveBeenCalledWith({
        scope: 'workspace',
        mode: 'append',
        content: '- new memory entry',
        projectRoot: '/workspace',
      });
    });

    it('publishes memory_changed event after successful write', async () => {
      (writeWorkspaceContextFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        {
          filePath: '/workspace/QWEN.md',
          bytesWritten: 50,
          changed: true,
        },
      );

      const deps = makeDeps();
      const svc = createMemoryService(deps);
      const ctx = makeCtx({ originatorClientId: 'client-1' });

      await svc.write(ctx, {
        scope: 'workspace',
        content: 'entry',
        mode: 'append',
      });

      expect(deps.publishWorkspaceEvent).toHaveBeenCalledWith({
        type: 'memory_changed',
        data: {
          scope: 'workspace',
          filePath: '/workspace/QWEN.md',
          mode: 'append',
          bytesWritten: 50,
        },
        originatorClientId: 'client-1',
      });
    });

    it('does not publish event when write did not change anything', async () => {
      (writeWorkspaceContextFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        {
          filePath: '/workspace/QWEN.md',
          bytesWritten: 0,
          changed: false,
        },
      );

      const deps = makeDeps();
      const svc = createMemoryService(deps);

      await svc.write(makeCtx(), {
        scope: 'workspace',
        content: '   ',
        mode: 'append',
      });

      expect(deps.publishWorkspaceEvent).not.toHaveBeenCalled();
    });

    it('does not include originatorClientId in event when undefined', async () => {
      (writeWorkspaceContextFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        {
          filePath: '/workspace/QWEN.md',
          bytesWritten: 20,
          changed: true,
        },
      );

      const deps = makeDeps();
      const svc = createMemoryService(deps);
      const ctx = makeCtx({ originatorClientId: undefined });

      await svc.write(ctx, {
        scope: 'workspace',
        content: 'entry',
        mode: 'append',
      });

      expect(deps.publishWorkspaceEvent).toHaveBeenCalledWith({
        type: 'memory_changed',
        data: expect.any(Object),
      });
    });
  });

  describe('delete', () => {
    it('validates clientId before deleting', async () => {
      const deps = makeDeps();
      const svc = createMemoryService(deps);
      const ctx = makeCtx({ originatorClientId: 'unknown-client' });

      await expect(svc.delete(ctx, 'workspace')).rejects.toThrow(
        'not registered',
      );
    });

    it('allows mutation when clientId is undefined', async () => {
      // Create a file to delete
      await fs.writeFile(path.join(tmpDir, 'QWEN.md'), 'content');

      const deps = makeDeps({ boundWorkspace: tmpDir });
      const svc = createMemoryService(deps);
      const ctx = makeCtx({ originatorClientId: undefined });

      const result = await svc.delete(ctx, 'workspace');

      expect(result.deleted).toBe(true);
    });

    it('returns deleted: true when file exists', async () => {
      await fs.writeFile(path.join(tmpDir, 'QWEN.md'), 'content');

      const deps = makeDeps({ boundWorkspace: tmpDir });
      const svc = createMemoryService(deps);

      const result = await svc.delete(makeCtx(), 'workspace');

      expect(result.deleted).toBe(true);
    });

    it('returns deleted: false when file does not exist', async () => {
      const deps = makeDeps({ boundWorkspace: tmpDir });
      const svc = createMemoryService(deps);

      const result = await svc.delete(makeCtx(), 'workspace');

      expect(result.deleted).toBe(false);
    });

    it('publishes memory_changed event after successful deletion', async () => {
      await fs.writeFile(path.join(tmpDir, 'QWEN.md'), 'content');

      const deps = makeDeps({ boundWorkspace: tmpDir });
      const svc = createMemoryService(deps);
      const ctx = makeCtx({ originatorClientId: 'client-1' });

      await svc.delete(ctx, 'workspace');

      expect(deps.publishWorkspaceEvent).toHaveBeenCalledWith({
        type: 'memory_changed',
        data: {
          change: 'deleted',
          key: 'workspace',
          filePath: path.join(tmpDir, 'QWEN.md'),
        },
        originatorClientId: 'client-1',
      });
    });

    it('does not publish event when file does not exist', async () => {
      const deps = makeDeps({ boundWorkspace: tmpDir });
      const svc = createMemoryService(deps);

      await svc.delete(makeCtx(), 'workspace');

      expect(deps.publishWorkspaceEvent).not.toHaveBeenCalled();
    });

    it('does not include originatorClientId in event when undefined', async () => {
      await fs.writeFile(path.join(tmpDir, 'QWEN.md'), 'content');

      const deps = makeDeps({ boundWorkspace: tmpDir });
      const svc = createMemoryService(deps);
      const ctx = makeCtx({ originatorClientId: undefined });

      await svc.delete(ctx, 'workspace');

      expect(deps.publishWorkspaceEvent).toHaveBeenCalledWith({
        type: 'memory_changed',
        data: expect.any(Object),
      });
    });
  });
});

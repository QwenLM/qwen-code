/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { createFileService, type FileServiceDeps } from '../fileService.js';
import type { WorkspaceRequestContext } from '../types.js';
import type {
  WorkspaceFileSystem,
  WorkspaceFileSystemFactory,
  ResolvedPath,
  ReadMeta,
  ContentHash,
  WriteTextAtomicOutcome,
} from '../../fs/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockFs(): WorkspaceFileSystem {
  return {
    resolve: vi.fn().mockResolvedValue('/workspace/foo.txt' as ResolvedPath),
    stat: vi.fn().mockResolvedValue({ kind: 'file', sizeBytes: 42, modifiedMs: 1000 }),
    readText: vi.fn().mockResolvedValue({
      content: 'hello',
      meta: { lineEnding: 'lf' } as ReadMeta,
    }),
    readBytes: vi.fn().mockResolvedValue(Buffer.from('bytes')),
    readBytesWindow: vi.fn().mockResolvedValue({
      buffer: Buffer.from('window'),
      sizeBytes: 6,
      returnedBytes: 6,
      offset: 0,
      truncated: false,
    }),
    list: vi.fn().mockResolvedValue([{ name: 'a.ts', kind: 'file', ignored: false }]),
    glob: vi.fn().mockResolvedValue(['/workspace/a.ts' as ResolvedPath]),
    writeTextAtomic: vi.fn().mockResolvedValue({
      created: true,
      sizeBytes: 5,
      hash: 'sha256:abc' as ContentHash,
      meta: { lineEnding: 'lf' } as ReadMeta,
    } satisfies WriteTextAtomicOutcome),
    writeTextOverwrite: vi.fn().mockResolvedValue({
      created: false,
      sizeBytes: 5,
      hash: 'sha256:abc' as ContentHash,
      meta: { lineEnding: 'lf' } as ReadMeta,
    } satisfies WriteTextAtomicOutcome),
    writeText: vi.fn().mockResolvedValue(undefined),
    edit: vi.fn().mockResolvedValue({ writtenBytes: 5 }),
    editAtomic: vi.fn().mockResolvedValue({ writtenBytes: 5 }),
  } as unknown as WorkspaceFileSystem;
}

function makeDeps(mockFs: WorkspaceFileSystem): FileServiceDeps {
  const forRequest = vi.fn().mockReturnValue(mockFs);
  return {
    fsFactory: { forRequest } as unknown as WorkspaceFileSystemFactory,
    boundWorkspace: '/workspace',
  };
}

function makeCtx(overrides?: Partial<WorkspaceRequestContext>): WorkspaceRequestContext {
  return {
    originatorClientId: 'client-1',
    sessionId: 'session-1',
    route: 'GET /file',
    workspaceCwd: '/workspace',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FileService', () => {
  describe('forRequest context mapping', () => {
    it('calls forRequest with correct context fields from WorkspaceRequestContext', async () => {
      const mockFs = makeMockFs();
      const deps = makeDeps(mockFs);
      const svc = createFileService(deps);
      const ctx = makeCtx();

      await svc.resolve(ctx, 'foo.txt', 'read');

      expect(deps.fsFactory.forRequest).toHaveBeenCalledWith({
        originatorClientId: 'client-1',
        sessionId: 'session-1',
        route: 'GET /file',
      });
    });

    it('passes undefined originatorClientId when not provided (reads work without client identity)', async () => {
      const mockFs = makeMockFs();
      const deps = makeDeps(mockFs);
      const svc = createFileService(deps);
      const ctx = makeCtx({ originatorClientId: undefined });

      await svc.readText(ctx, '/workspace/foo.txt' as ResolvedPath);

      expect(deps.fsFactory.forRequest).toHaveBeenCalledWith({
        originatorClientId: undefined,
        sessionId: 'session-1',
        route: 'GET /file',
      });
    });

    it('passes undefined sessionId when not provided', async () => {
      const mockFs = makeMockFs();
      const deps = makeDeps(mockFs);
      const svc = createFileService(deps);
      const ctx = makeCtx({ sessionId: undefined });

      await svc.stat(ctx, '/workspace/foo.txt' as ResolvedPath);

      expect(deps.fsFactory.forRequest).toHaveBeenCalledWith({
        originatorClientId: 'client-1',
        sessionId: undefined,
        route: 'GET /file',
      });
    });
  });

  describe('method delegation', () => {
    it('resolve delegates to WorkspaceFileSystem.resolve', async () => {
      const mockFs = makeMockFs();
      const deps = makeDeps(mockFs);
      const svc = createFileService(deps);
      const ctx = makeCtx();

      const result = await svc.resolve(ctx, 'foo.txt', 'read');

      expect(mockFs.resolve).toHaveBeenCalledWith('foo.txt', 'read');
      expect(result).toBe('/workspace/foo.txt');
    });

    it('stat delegates to WorkspaceFileSystem.stat', async () => {
      const mockFs = makeMockFs();
      const deps = makeDeps(mockFs);
      const svc = createFileService(deps);
      const ctx = makeCtx();
      const p = '/workspace/foo.txt' as ResolvedPath;

      const result = await svc.stat(ctx, p);

      expect(mockFs.stat).toHaveBeenCalledWith(p);
      expect(result).toEqual({ kind: 'file', sizeBytes: 42, modifiedMs: 1000 });
    });

    it('readText delegates with options', async () => {
      const mockFs = makeMockFs();
      const deps = makeDeps(mockFs);
      const svc = createFileService(deps);
      const ctx = makeCtx();
      const p = '/workspace/foo.txt' as ResolvedPath;
      const opts = { maxBytes: 1024 };

      const result = await svc.readText(ctx, p, opts);

      expect(mockFs.readText).toHaveBeenCalledWith(p, opts);
      expect(result.content).toBe('hello');
    });

    it('readBytes delegates to WorkspaceFileSystem.readBytes', async () => {
      const mockFs = makeMockFs();
      const deps = makeDeps(mockFs);
      const svc = createFileService(deps);
      const ctx = makeCtx();
      const p = '/workspace/foo.txt' as ResolvedPath;

      const result = await svc.readBytes(ctx, p);

      expect(mockFs.readBytes).toHaveBeenCalledWith(p, undefined);
      expect(result).toEqual(Buffer.from('bytes'));
    });

    it('readBytesWindow delegates with options', async () => {
      const mockFs = makeMockFs();
      const deps = makeDeps(mockFs);
      const svc = createFileService(deps);
      const ctx = makeCtx();
      const p = '/workspace/foo.txt' as ResolvedPath;
      const opts = { offset: 10, maxBytes: 100 };

      const result = await svc.readBytesWindow(ctx, p, opts);

      expect(mockFs.readBytesWindow).toHaveBeenCalledWith(p, opts);
      expect(result.returnedBytes).toBe(6);
    });

    it('list delegates to WorkspaceFileSystem.list', async () => {
      const mockFs = makeMockFs();
      const deps = makeDeps(mockFs);
      const svc = createFileService(deps);
      const ctx = makeCtx();
      const p = '/workspace' as ResolvedPath;

      const result = await svc.list(ctx, p);

      expect(mockFs.list).toHaveBeenCalledWith(p, undefined);
      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe('a.ts');
    });

    it('glob delegates to WorkspaceFileSystem.glob', async () => {
      const mockFs = makeMockFs();
      const deps = makeDeps(mockFs);
      const svc = createFileService(deps);
      const ctx = makeCtx();

      const result = await svc.glob(ctx, '**/*.ts');

      expect(mockFs.glob).toHaveBeenCalledWith('**/*.ts', undefined);
      expect(result).toEqual(['/workspace/a.ts']);
    });

    it('writeTextAtomic delegates to WorkspaceFileSystem.writeTextAtomic', async () => {
      const mockFs = makeMockFs();
      const deps = makeDeps(mockFs);
      const svc = createFileService(deps);
      const ctx = makeCtx();
      const p = '/workspace/foo.txt' as ResolvedPath;
      const opts = { mode: 'create' as const };

      const result = await svc.writeTextAtomic(ctx, p, 'new content', opts);

      expect(mockFs.writeTextAtomic).toHaveBeenCalledWith(p, 'new content', opts);
      expect(result.created).toBe(true);
    });

    it('writeTextOverwrite delegates to WorkspaceFileSystem.writeTextOverwrite', async () => {
      const mockFs = makeMockFs();
      const deps = makeDeps(mockFs);
      const svc = createFileService(deps);
      const ctx = makeCtx();
      const p = '/workspace/foo.txt' as ResolvedPath;

      const result = await svc.writeTextOverwrite(ctx, p, 'overwritten');

      expect(mockFs.writeTextOverwrite).toHaveBeenCalledWith(p, 'overwritten');
      expect(result.created).toBe(false);
    });

    it('edit delegates to writeTextAtomic (CAS-gated write alias)', async () => {
      const mockFs = makeMockFs();
      const deps = makeDeps(mockFs);
      const svc = createFileService(deps);
      const ctx = makeCtx();
      const p = '/workspace/foo.txt' as ResolvedPath;
      const opts = { mode: 'replace' as const, expectedHash: 'sha256:abc' as ContentHash };

      const result = await svc.edit(ctx, p, 'edited', opts);

      expect(mockFs.writeTextAtomic).toHaveBeenCalledWith(p, 'edited', opts);
      expect(result.hash).toBe('sha256:abc');
    });
  });
});

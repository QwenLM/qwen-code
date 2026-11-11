/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import { StandardSessionManager } from './standard-session-manager.js';
import { FileSystemSessionReader } from '../../../infra/reader/file-system-reader.js';
import { SessionError } from '../../interface/exception/session-error.js';
import { createSessionTranscriptStore } from '../../../factory/session-transcript-store-factory.js';
import {
  resetConfigHomeDirCache,
  setConfigHomeDir,
} from '../../../config/sessions-config.js';

async function writeJsonl(
  filePath: string,
  lines: ReadonlyArray<Record<string, unknown>>,
): Promise<void> {
  const content = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
  await fs.writeFile(filePath, content, 'utf8');
}

async function touch(filePath: string, mtime: Date): Promise<void> {
  const atime = new Date();
  await fs.utimes(filePath, atime, mtime);
}

async function makeAllManager(): Promise<{
  manager: StandardSessionManager;
  store: ReturnType<typeof createSessionTranscriptStore>;
  configHome: string;
  projectA: string;
  projectB: string;
  cleanup: () => Promise<void>;
}> {
  const configHome = await fs.mkdtemp(
    nodePath.join(os.tmpdir(), 'test-sessions-all-'),
  );
  const projectA = nodePath.join(configHome, 'projects', 'bucket-a');
  const projectB = nodePath.join(configHome, 'projects', 'bucket-b');
  await fs.mkdir(projectA, { recursive: true });
  await fs.mkdir(projectB, { recursive: true });

  const store = createSessionTranscriptStore();
  const manager = new StandardSessionManager({
    repository: new FileSystemSessionReader(),
    store,
  });
  setConfigHomeDir(configHome);

  return {
    manager,
    store,
    configHome,
    projectA,
    projectB,
    cleanup: async () => {
      await store.close();
      await fs.rm(configHome, { recursive: true, force: true });
      setConfigHomeDir(undefined);
      resetConfigHomeDirCache();
    },
  };
}

async function makeManager(): Promise<{
  manager: StandardSessionManager;
  store: ReturnType<typeof createSessionTranscriptStore>;
  projectDir: string;
  bucketDir: string;
  cleanup: () => Promise<void>;
}> {
  const tmpDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'test-sessions-'));
  const projectDir = nodePath.join(tmpDir, 'project');
  const bucketDir = nodePath.join(tmpDir, 'buckets', 'project');
  await fs.mkdir(bucketDir, { recursive: true });

  const store = createSessionTranscriptStore();
  const manager = new StandardSessionManager({
    repository: new FileSystemSessionReader(),
    store,
  });

  return {
    manager,
    store,
    projectDir,
    bucketDir,
    cleanup: async () => {
      await store.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    },
  };
}

describe('StandardSessionManager', () => {
  let ctx: Awaited<ReturnType<typeof makeManager>>;

  beforeEach(async () => {
    ctx = await makeManager();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  describe('rename', () => {
    it('appends a custom title and returns the updated session', async () => {
      const pathA = nodePath.join(ctx.bucketDir, 'a.jsonl');
      await writeJsonl(pathA, [{ timestamp: '2026-01-01T00:00:00.000Z' }]);

      const renamed = await ctx.manager.rename(
        ctx.projectDir,
        'a',
        'My Custom Title',
        { bucketDir: ctx.bucketDir },
      );

      expect(renamed.getSessionId()).toBe('a');
      expect(renamed.getCustomTitle()).toBe('My Custom Title');
      expect(renamed.getDisplayName()).toBe('My Custom Title');

      const reloaded = await ctx.manager.loadById(ctx.projectDir, 'a', {
        bucketDir: ctx.bucketDir,
      });
      expect(reloaded).not.toBeNull();
      expect(reloaded!.getCustomTitle()).toBe('My Custom Title');
      expect(reloaded!.getDisplayName()).toBe('My Custom Title');
    });

    it('normalizes titles by trimming and replacing newlines', async () => {
      const pathA = nodePath.join(ctx.bucketDir, 'a.jsonl');
      await writeJsonl(pathA, [{ timestamp: '2026-01-01T00:00:00.000Z' }]);

      const renamed = await ctx.manager.rename(
        ctx.projectDir,
        'a',
        '  Line\nBreak\r\nTitle  ',
        { bucketDir: ctx.bucketDir },
      );

      expect(renamed.getCustomTitle()).toBe('Line Break Title');
    });

    it('throws SESSION_NOT_FOUND for missing sessions', async () => {
      await expect(
        ctx.manager.rename(ctx.projectDir, 'missing', 'Title', {
          bucketDir: ctx.bucketDir,
        }),
      ).rejects.toSatisfy(
        (error: SessionError) => error.code === 'SESSION_NOT_FOUND',
      );
    });

    it('throws INVALID_SESSION_TITLE for empty titles', async () => {
      const pathA = nodePath.join(ctx.bucketDir, 'a.jsonl');
      await writeJsonl(pathA, [{ timestamp: '2026-01-01T00:00:00.000Z' }]);

      await expect(
        ctx.manager.rename(ctx.projectDir, 'a', '   ', {
          bucketDir: ctx.bucketDir,
        }),
      ).rejects.toSatisfy(
        (error: SessionError) => error.code === 'INVALID_SESSION_TITLE',
      );
    });

    it('throws INVALID_SESSION_TITLE for titles that are too long', async () => {
      const pathA = nodePath.join(ctx.bucketDir, 'a.jsonl');
      await writeJsonl(pathA, [{ timestamp: '2026-01-01T00:00:00.000Z' }]);

      await expect(
        ctx.manager.rename(ctx.projectDir, 'a', 'x'.repeat(201), {
          bucketDir: ctx.bucketDir,
        }),
      ).rejects.toSatisfy(
        (error: SessionError) => error.code === 'INVALID_SESSION_TITLE',
      );
    });
  });

  describe('list', () => {
    it('returns sessions sorted by updatedAt descending', async () => {
      const pathA = nodePath.join(ctx.bucketDir, 'a.jsonl');
      const pathB = nodePath.join(ctx.bucketDir, 'b.jsonl');
      const pathC = nodePath.join(ctx.bucketDir, 'c.jsonl');

      await writeJsonl(pathA, [{ timestamp: '2026-01-01T00:00:00.000Z' }]);
      await writeJsonl(pathB, [{ timestamp: '2026-01-02T00:00:00.000Z' }]);
      await writeJsonl(pathC, [{ timestamp: '2026-01-03T00:00:00.000Z' }]);

      await touch(pathA, new Date('2026-01-01T00:00:00.000Z'));
      await touch(pathB, new Date('2026-01-03T00:00:00.000Z'));
      await touch(pathC, new Date('2026-01-02T00:00:00.000Z'));

      const sessions = await ctx.manager.list(ctx.projectDir, {
        bucketDir: ctx.bucketDir,
      });

      expect(sessions.map((s) => s.getSessionId())).toEqual(['b', 'c', 'a']);
      expect(sessions[0].getIndex()).toBe(1);
      expect(sessions[1].getIndex()).toBe(2);
      expect(sessions[2].getIndex()).toBe(3);
    });

    it('filters excludeSessionIds', async () => {
      const pathA = nodePath.join(ctx.bucketDir, 'a.jsonl');
      const pathB = nodePath.join(ctx.bucketDir, 'b.jsonl');
      await writeJsonl(pathA, [{ timestamp: '2026-01-01T00:00:00.000Z' }]);
      await writeJsonl(pathB, [{ timestamp: '2026-01-02T00:00:00.000Z' }]);

      const sessions = await ctx.manager.list(ctx.projectDir, {
        bucketDir: ctx.bucketDir,
        excludeSessionIds: ['a'],
      });

      expect(sessions.map((s) => s.getSessionId())).toEqual(['b']);
    });

    it('marks currentSessionId', async () => {
      const pathA = nodePath.join(ctx.bucketDir, 'a.jsonl');
      await writeJsonl(pathA, [{ timestamp: '2026-01-01T00:00:00.000Z' }]);

      const sessions = await ctx.manager.list(ctx.projectDir, {
        bucketDir: ctx.bucketDir,
        currentSessionId: 'a',
      });

      expect(sessions[0].isCurrentSession()).toBe(true);
    });

    it('returns empty array when projectDir does not exist', async () => {
      const sessions = await ctx.manager.list(ctx.projectDir, {
        bucketDir: nodePath.join(ctx.bucketDir, 'missing')
      });
      expect(sessions).toEqual([]);
    });
  });

  describe('listAll', () => {
    let allCtx: Awaited<ReturnType<typeof makeAllManager>>;

    beforeEach(async () => {
      allCtx = await makeAllManager();
    });

    afterEach(async () => {
      await allCtx.cleanup();
    });

    it('returns sessions across all project buckets sorted by projectDir then updatedAt', async () => {
      const pathA1 = nodePath.join(allCtx.projectA, 'a1.jsonl');
      const pathA2 = nodePath.join(allCtx.projectA, 'a2.jsonl');
      const pathB1 = nodePath.join(allCtx.projectB, 'b1.jsonl');

      await writeJsonl(pathA1, [
        { timestamp: '2026-01-01T00:00:00.000Z', sessionId: 'a1' },
        {
          type: 'workspace-directories',
          sessionId: 'a1',
          directories: ['/workspace/a'],
        },
      ]);
      await writeJsonl(pathA2, [
        { timestamp: '2026-01-01T00:00:00.000Z', sessionId: 'a2' },
        {
          type: 'workspace-directories',
          sessionId: 'a2',
          directories: ['/workspace/a'],
        },
      ]);
      await writeJsonl(pathB1, [
        { timestamp: '2026-01-01T00:00:00.000Z', sessionId: 'b1' },
        {
          type: 'workspace-directories',
          sessionId: 'b1',
          directories: ['/workspace/b'],
        },
      ]);

      await touch(pathA1, new Date('2026-01-01T00:00:00.000Z'));
      await touch(pathA2, new Date('2026-01-03T00:00:00.000Z'));
      await touch(pathB1, new Date('2026-01-02T00:00:00.000Z'));

      const sessions = await allCtx.manager.listAll();

      expect(sessions.map((s) => s.getSessionId())).toEqual(['a2', 'a1', 'b1']);
      expect(sessions.map((s) => s.getProjectDir())).toEqual([
        '/workspace/a',
        '/workspace/a',
        '/workspace/b',
      ]);
      expect(sessions.map((s) => s.getIndex())).toEqual([1, 2, 3]);
    });

    it('falls back to cwd when workspace-directories is absent', async () => {
      const pathA1 = nodePath.join(allCtx.projectA, 'a1.jsonl');
      await writeJsonl(pathA1, [
        { timestamp: '2026-01-01T00:00:00.000Z', sessionId: 'a1', cwd: '/fallback/cwd' },
      ]);
      await touch(pathA1, new Date('2026-01-01T00:00:00.000Z'));

      const sessions = await allCtx.manager.listAll();

      expect(sessions).toHaveLength(1);
      expect(sessions[0].getProjectDir()).toBe('/fallback/cwd');
    });

    it('honors excludeSessionIds and currentSessionId options', async () => {
      const pathA1 = nodePath.join(allCtx.projectA, 'a1.jsonl');
      const pathA2 = nodePath.join(allCtx.projectA, 'a2.jsonl');

      await writeJsonl(pathA1, [
        { timestamp: '2026-01-01T00:00:00.000Z', sessionId: 'a1' },
        {
          type: 'workspace-directories',
          sessionId: 'a1',
          directories: ['/workspace/a'],
        },
      ]);
      await writeJsonl(pathA2, [
        { timestamp: '2026-01-01T00:00:00.000Z', sessionId: 'a2' },
        {
          type: 'workspace-directories',
          sessionId: 'a2',
          directories: ['/workspace/a'],
        },
      ]);
      await touch(pathA1, new Date('2026-01-01T00:00:00.000Z'));
      await touch(pathA2, new Date('2026-01-02T00:00:00.000Z'));

      const sessions = await allCtx.manager.listAll({
        excludeSessionIds: ['a1'],
        currentSessionId: 'a2',
      });

      expect(sessions.map((s) => s.getSessionId())).toEqual(['a2']);
      expect(sessions[0].isCurrentSession()).toBe(true);
    });

    it('returns empty array when the config root has no project buckets', async () => {
      await fs.rm(nodePath.join(allCtx.configHome, 'projects'), {
        recursive: true,
        force: true,
      });

      const sessions = await allCtx.manager.listAll();
      expect(sessions).toEqual([]);
    });

    it('filters sessions using the bucket name as projectDir', async () => {
      const pathA1 = nodePath.join(allCtx.projectA, 'a1.jsonl');
      const pathA2 = nodePath.join(allCtx.projectA, 'a2.jsonl');
      const pathB1 = nodePath.join(allCtx.projectB, 'b1.jsonl');

      await writeJsonl(pathA1, [
        { timestamp: '2026-01-01T00:00:00.000Z', sessionId: 'a1' },
        {
          type: 'workspace-directories',
          sessionId: 'a1',
          directories: ['/workspace/a'],
        },
      ]);
      await writeJsonl(pathA2, [
        { timestamp: '2026-01-01T00:00:00.000Z', sessionId: 'a2' },
        {
          type: 'workspace-directories',
          sessionId: 'a2',
          directories: ['/workspace/a'],
        },
      ]);
      await writeJsonl(pathB1, [
        { timestamp: '2026-01-01T00:00:00.000Z', sessionId: 'b1' },
        {
          type: 'workspace-directories',
          sessionId: 'b1',
          directories: ['/workspace/b'],
        },
      ]);

      const calls: Array<{ sessionId?: string; entryPath: string }> = [];
      const sessions = await allCtx.manager.listAll({
        filter: (options) => {
          calls.push(options);
          if (options.sessionId === undefined) {
            return options.entryPath !== allCtx.projectB;
          }
          return nodePath.basename(options.entryPath, '.jsonl') !== 'a1';
        },
      });

      expect(sessions.map((s) => s.getSessionId())).toEqual(['a2']);
      expect(calls).toContainEqual({ entryPath: allCtx.projectA });
      expect(calls).toContainEqual({ entryPath: allCtx.projectB });
      expect(calls).toContainEqual({
        sessionId: 'a2',
        entryPath: nodePath.join(allCtx.projectA, 'a2.jsonl'),
      });
      expect(calls).toContainEqual({
        sessionId: 'a1',
        entryPath: nodePath.join(allCtx.projectA, 'a1.jsonl'),
      });
      expect(calls).not.toContainEqual({
        sessionId: 'b1',
        entryPath: nodePath.join(allCtx.projectB, 'b1.jsonl'),
      });
    });

    it('returns empty array when filter rejects every bucket', async () => {
      const pathA1 = nodePath.join(allCtx.projectA, 'a1.jsonl');
      await writeJsonl(pathA1, [
        { timestamp: '2026-01-01T00:00:00.000Z', sessionId: 'a1' },
        {
          type: 'workspace-directories',
          sessionId: 'a1',
          directories: ['/workspace/a'],
        },
      ]);
      await touch(pathA1, new Date('2026-01-01T00:00:00.000Z'));

      const sessions = await allCtx.manager.listAll({ filter: () => false });

      expect(sessions).toEqual([]);
    });

    it('returns empty array when filter rejects every file', async () => {
      const pathA1 = nodePath.join(allCtx.projectA, 'a1.jsonl');
      const pathA2 = nodePath.join(allCtx.projectA, 'a2.jsonl');
      await writeJsonl(pathA1, [
        { timestamp: '2026-01-01T00:00:00.000Z', sessionId: 'a1' },
        {
          type: 'workspace-directories',
          sessionId: 'a1',
          directories: ['/workspace/a'],
        },
      ]);
      await writeJsonl(pathA2, [
        { timestamp: '2026-01-01T00:00:00.000Z', sessionId: 'a2' },
        {
          type: 'workspace-directories',
          sessionId: 'a2',
          directories: ['/workspace/a'],
        },
      ]);
      await touch(pathA1, new Date('2026-01-01T00:00:00.000Z'));
      await touch(pathA2, new Date('2026-01-02T00:00:00.000Z'));

      const sessions = await allCtx.manager.listAll({
        filter: ({ sessionId }) => sessionId === undefined,
      });

      expect(sessions).toEqual([]);
    });

    it('composes filter with excludeSessionIds and currentSessionId', async () => {
      const pathA1 = nodePath.join(allCtx.projectA, 'a1.jsonl');
      const pathA2 = nodePath.join(allCtx.projectA, 'a2.jsonl');
      const pathB1 = nodePath.join(allCtx.projectB, 'b1.jsonl');

      for (const [filePath, sessionId] of [
        [pathA1, 'a1'],
        [pathA2, 'a2'],
        [pathB1, 'b1'],
      ] as const) {
        await writeJsonl(filePath, [
          { timestamp: '2026-01-01T00:00:00.000Z', sessionId },
          {
            type: 'workspace-directories',
            sessionId,
            directories: ['/workspace/a'],
          },
        ]);
        await touch(filePath, new Date('2026-01-01T00:00:00.000Z'));
      }

      const sessions = await allCtx.manager.listAll({
        excludeSessionIds: ['a2'],
        currentSessionId: 'b1',
        filter: ({ sessionId, entryPath }) => {
          if (sessionId === undefined) {
            return entryPath !== allCtx.projectB;
          }
          return sessionId !== 'a1';
        },
      });

      expect(sessions.map((s) => s.getSessionId())).toEqual([]);
      expect(sessions).toEqual([]);
    });

    it('assigns contiguous indices after filter', async () => {
      const pathA1 = nodePath.join(allCtx.projectA, 'a1.jsonl');
      const pathA2 = nodePath.join(allCtx.projectA, 'a2.jsonl');
      const pathA3 = nodePath.join(allCtx.projectA, 'a3.jsonl');

      for (const [filePath, sessionId] of [
        [pathA1, 'a1'],
        [pathA2, 'a2'],
        [pathA3, 'a3'],
      ] as const) {
        await writeJsonl(filePath, [
          { timestamp: '2026-01-01T00:00:00.000Z', sessionId },
          {
            type: 'workspace-directories',
            sessionId,
            directories: ['/workspace/a'],
          },
        ]);
      }
      await touch(pathA1, new Date('2026-01-01T00:00:00.000Z'));
      await touch(pathA2, new Date('2026-01-02T00:00:00.000Z'));
      await touch(pathA3, new Date('2026-01-03T00:00:00.000Z'));

      const sessions = await allCtx.manager.listAll({
        filter: ({ sessionId }) => sessionId !== 'a2',
      });

      expect(sessions.map((s) => s.getSessionId())).toEqual(['a3', 'a1']);
      expect(sessions.map((s) => s.getIndex())).toEqual([1, 2]);
    });
  });

  describe('loadLatest', () => {
    it('returns the most recently updated session', async () => {
      const pathA = nodePath.join(ctx.bucketDir, 'a.jsonl');
      const pathB = nodePath.join(ctx.bucketDir, 'b.jsonl');
      await writeJsonl(pathA, [{ timestamp: '2026-01-01T00:00:00.000Z' }]);
      await writeJsonl(pathB, [{ timestamp: '2026-01-02T00:00:00.000Z' }]);
      await touch(pathA, new Date('2026-01-01T00:00:00.000Z'));
      await touch(pathB, new Date('2026-01-02T00:00:00.000Z'));

      const session = await ctx.manager.loadLatest(ctx.projectDir, {
        bucketDir: ctx.bucketDir,
      });

      expect(session.getSessionId()).toBe('b');
    });

    it('throws NO_SESSIONS_FOUND when catalog is empty', async () => {
      await expect(
        ctx.manager.loadLatest(ctx.projectDir, {
          bucketDir: ctx.bucketDir,
        }),
      ).rejects.toThrow(SessionError);

      await expect(
        ctx.manager.loadLatest(ctx.projectDir, {
          bucketDir: ctx.bucketDir,
        }),
      ).rejects.toSatisfy((error: SessionError) => error.code === 'NO_SESSIONS_FOUND');
    });
  });

  describe('loadById', () => {
    it('returns the session by id', async () => {
      const pathA = nodePath.join(ctx.bucketDir, 'a.jsonl');
      await writeJsonl(pathA, [{ timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp' }]);

      const session = await ctx.manager.loadById(ctx.projectDir, 'a', {
        bucketDir: ctx.bucketDir,
      });

      expect(session).not.toBeNull();
      expect(session!.getSessionId()).toBe('a');
      expect(session!.getCwd()).toBe('/tmp');
      expect(session!.getIndex()).toBe(0);
    });

    it('returns null for non-existent id', async () => {
      const session = await ctx.manager.loadById(ctx.projectDir, 'missing', {
        bucketDir: ctx.bucketDir,
      });
      expect(session).toBeNull();
    });

    it('returns null for unsafe id', async () => {
      const session = await ctx.manager.loadById(ctx.projectDir, '../etc/passwd', {
        bucketDir: ctx.bucketDir,
      });
      expect(session).toBeNull();
    });

    it('throws SESSION_NOT_FOUND for excluded id', async () => {
      const pathA = nodePath.join(ctx.bucketDir, 'a.jsonl');
      await writeJsonl(pathA, [{ timestamp: '2026-01-01T00:00:00.000Z' }]);

      await expect(
        ctx.manager.loadById(ctx.projectDir, 'a', {
          bucketDir: ctx.bucketDir,
          excludeSessionIds: ['a'],
        }),
      ).rejects.toSatisfy(
        (error: SessionError) => error.code === 'SESSION_NOT_FOUND',
      );
    });
  });

  describe('loadByIndex', () => {
    it('returns session by 1-based index', async () => {
      const pathA = nodePath.join(ctx.bucketDir, 'a.jsonl');
      const pathB = nodePath.join(ctx.bucketDir, 'b.jsonl');
      await writeJsonl(pathA, [{ timestamp: '2026-01-01T00:00:00.000Z' }]);
      await writeJsonl(pathB, [{ timestamp: '2026-01-02T00:00:00.000Z' }]);
      await touch(pathA, new Date('2026-01-01T00:00:00.000Z'));
      await touch(pathB, new Date('2026-01-02T00:00:00.000Z'));

      const session = await ctx.manager.loadByIndex(ctx.projectDir, 1, {
        bucketDir: ctx.bucketDir,
      });

      expect(session.getSessionId()).toBe('b');
    });

    it('throws INVALID_SESSION_IDENTIFIER for out-of-range index', async () => {
      const pathA = nodePath.join(ctx.bucketDir, 'a.jsonl');
      await writeJsonl(pathA, [{ timestamp: '2026-01-01T00:00:00.000Z' }]);

      await expect(
        ctx.manager.loadByIndex(ctx.projectDir, 999, {
          bucketDir: ctx.bucketDir,
        }),
      ).rejects.toSatisfy(
        (error: SessionError) => error.code === 'INVALID_SESSION_IDENTIFIER',
      );
    });
  });

  describe('loadByIdOrIndex', () => {
    it('resolves uuid-like argument by id', async () => {
      const pathA = nodePath.join(ctx.bucketDir, 'a.jsonl');
      await writeJsonl(pathA, [{ timestamp: '2026-01-01T00:00:00.000Z' }]);

      const session = await ctx.manager.loadByIdOrIndex(ctx.projectDir, 'a', {
        bucketDir: ctx.bucketDir,
      });

      expect(session.getSessionId()).toBe('a');
    });

    it('resolves numeric argument as index', async () => {
      const pathA = nodePath.join(ctx.bucketDir, 'a.jsonl');
      const pathB = nodePath.join(ctx.bucketDir, 'b.jsonl');
      await writeJsonl(pathA, [{ timestamp: '2026-01-01T00:00:00.000Z' }]);
      await writeJsonl(pathB, [{ timestamp: '2026-01-02T00:00:00.000Z' }]);
      await touch(pathA, new Date('2026-01-01T00:00:00.000Z'));
      await touch(pathB, new Date('2026-01-02T00:00:00.000Z'));

      const session = await ctx.manager.loadByIdOrIndex(ctx.projectDir, '1', {
        bucketDir: ctx.bucketDir,
      });

      expect(session.getSessionId()).toBe('b');
    });

    it('prefers exact id match over numeric index', async () => {
      const path1 = nodePath.join(ctx.bucketDir, '1.jsonl');
      const pathA = nodePath.join(ctx.bucketDir, 'a.jsonl');
      await writeJsonl(path1, [{ timestamp: '2026-01-01T00:00:00.000Z' }]);
      await writeJsonl(pathA, [{ timestamp: '2026-01-02T00:00:00.000Z' }]);

      const session = await ctx.manager.loadByIdOrIndex(ctx.projectDir, '1', {
        bucketDir: ctx.bucketDir,
      });

      expect(session.getSessionId()).toBe('1');
    });

    it('throws INVALID_SESSION_IDENTIFIER when unresolved', async () => {
      await expect(
        ctx.manager.loadByIdOrIndex(ctx.projectDir, 'missing', {
          bucketDir: ctx.bucketDir,
        }),
      ).rejects.toSatisfy(
        (error: SessionError) => error.code === 'INVALID_SESSION_IDENTIFIER',
      );
    });
  });

  describe('delete', () => {
    it('removes the session file', async () => {
      const pathA = nodePath.join(ctx.bucketDir, 'a.jsonl');
      await writeJsonl(pathA, [{ timestamp: '2026-01-01T00:00:00.000Z' }]);

      const removed = await ctx.manager.delete(ctx.projectDir, 'a', {
        bucketDir: ctx.bucketDir,
      });
      expect(removed).toBe(true);

      const exists = await fs
        .stat(pathA)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    });

    it('returns false for non-existent id', async () => {
      const removed = await ctx.manager.delete(ctx.projectDir, 'missing', {
        bucketDir: ctx.bucketDir,
      });
      expect(removed).toBe(false);
    });

    it('returns false for unsafe id', async () => {
      const removed = await ctx.manager.delete(
        ctx.projectDir,
        '../etc/passwd',
        { bucketDir: ctx.bucketDir }
      );
      expect(removed).toBe(false);
    });
  });

  describe('loadByStamp', () => {
    it('loads from disk when file exists', async () => {
      const pathA = nodePath.join(ctx.bucketDir, 'a.jsonl');
      await writeJsonl(pathA, [{ timestamp: '2026-01-01T00:00:00.000Z', cwd: '/disk' }]);

      const session = await ctx.manager.loadByStamp({
        sessionId: 'a',
        sessionPath: pathA,
        projectDir: ctx.projectDir
      });

      expect(session.getSessionId()).toBe('a');
      expect(session.getCwd()).toBe('/disk');
    });

    it('builds from stamp when file is missing', async () => {
      const session = await ctx.manager.loadByStamp({
        sessionId: 'a',
        projectDir: ctx.projectDir,
        cwd: '/stamp',
      });

      expect(session.getSessionId()).toBe('a');
      expect(session.getCwd()).toBe('/stamp');
    });
  });

  describe('fork', () => {
    it('forks a session and stamps forkedFrom on every copied message', async () => {
      const sourceId = '11111111-1111-4111-8111-111111111111';
      const targetId = '22222222-2222-4222-8222-222222222222';
      const sourcePath = nodePath.join(ctx.bucketDir, `${sourceId}.jsonl`);
      const userUuid = 'user-uuid-1';
      const assistantUuid = 'assistant-uuid-1';

      await writeJsonl(sourcePath, [
        {
          type: 'user',
          uuid: userUuid,
          timestamp: '2026-01-01T00:00:00.000Z',
          parentUuid: null,
          isSidechain: false,
          cwd: ctx.projectDir,
          sessionId: sourceId,
          userType: 'external',
          version: '1.0.0',
          message: { role: 'user', content: 'hello' },
        },
        {
          type: 'assistant',
          uuid: assistantUuid,
          timestamp: '2026-01-01T00:00:01.000Z',
          parentUuid: userUuid,
          isSidechain: false,
          cwd: ctx.projectDir,
          sessionId: sourceId,
          userType: 'external',
          version: '1.0.0',
          message: { role: 'assistant', content: 'world' },
        },
      ]);

      const forked = await ctx.manager.fork(ctx.projectDir, sourceId, {
        bucketDir: ctx.bucketDir,
        targetSessionId: targetId,
      });

      expect(forked.getSessionId()).toBe(targetId);
      expect(forked.getMessages()).toHaveLength(2);
      // Each message's forkedFrom.messageUuid is its own UUID.
      expect(forked.getMessages()[0].getForkedFrom()).toEqual({
        sessionId: sourceId,
        messageUuid: userUuid,
      });
      expect(forked.getMessages()[1].getForkedFrom()).toEqual({
        sessionId: sourceId,
        messageUuid: assistantUuid,
      });
      // isSidechain is explicitly reset to false (verified at JSONL level below).
      const targetPath = nodePath.join(ctx.bucketDir, `${targetId}.jsonl`);
      const targetLines = (await fs.readFile(targetPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(targetLines[0]['sessionId']).toBe(targetId);
      expect(targetLines[0]['isSidechain']).toBe(false);
      expect(targetLines[0]['forkedFrom']).toEqual({
        sessionId: sourceId,
        messageUuid: userUuid,
      });
      expect(targetLines[1]['sessionId']).toBe(targetId);
      expect(targetLines[1]['isSidechain']).toBe(false);
      expect(targetLines[1]['forkedFrom']).toEqual({
        sessionId: sourceId,
        messageUuid: assistantUuid,
      });
      expect(targetLines[2]['type']).toBe('relocated');
      expect(targetLines[3]['type']).toBe('worktree-state');
    });

    it('truncates the chain when resumeSessionAt is provided', async () => {
      const sourceId = '11111111-1111-4111-8111-111111111111';
      const targetId = '22222222-2222-4222-8222-222222222222';
      const sourcePath = nodePath.join(ctx.bucketDir, `${sourceId}.jsonl`);
      const userUuid = 'user-uuid-1';

      await writeJsonl(sourcePath, [
        {
          type: 'user',
          uuid: userUuid,
          timestamp: '2026-01-01T00:00:00.000Z',
          parentUuid: null,
          isSidechain: false,
          cwd: ctx.projectDir,
          sessionId: sourceId,
          userType: 'external',
          version: '1.0.0',
          message: { role: 'user', content: 'hello' },
        },
        {
          type: 'assistant',
          uuid: 'assistant-uuid-1',
          timestamp: '2026-01-01T00:00:01.000Z',
          parentUuid: userUuid,
          isSidechain: false,
          cwd: ctx.projectDir,
          sessionId: sourceId,
          userType: 'external',
          version: '1.0.0',
          message: { role: 'assistant', content: 'world' },
        },
      ]);

      const forked = await ctx.manager.fork(ctx.projectDir, sourceId, {
        bucketDir: ctx.bucketDir,
        targetSessionId: targetId,
        resumeSessionAt: userUuid,
      });

      expect(forked.getMessages()).toHaveLength(1);
      expect(forked.getMessages()[0].getForkedFrom()).toEqual({
        sessionId: sourceId,
        messageUuid: userUuid,
      });
    });

    it('throws SESSION_NOT_FOUND for missing source sessions', async () => {
      await expect(
        ctx.manager.fork(ctx.projectDir, '11111111-1111-4111-8111-111111111111', {
          bucketDir: ctx.bucketDir,
          targetSessionId: '22222222-2222-4222-8222-222222222222',
        }),
      ).rejects.toSatisfy(
        (error: SessionError) => error.code === 'SESSION_NOT_FOUND',
      );
    });

    it('auto-generates targetSessionId when not provided', async () => {
      const sourceId = '11111111-1111-4111-8111-111111111111';
      const sourcePath = nodePath.join(ctx.bucketDir, `${sourceId}.jsonl`);
      await writeJsonl(sourcePath, [
        {
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-01-01T00:00:00.000Z',
          parentUuid: null,
          isSidechain: false,
          cwd: ctx.projectDir,
          sessionId: sourceId,
          userType: 'external',
          version: '1.0.0',
          message: { role: 'user', content: 'hello' },
        },
      ]);

      const forked = await ctx.manager.fork(ctx.projectDir, sourceId, {
        bucketDir: ctx.bucketDir,
      });

      expect(forked.getSessionId()).not.toBe(sourceId);
      expect(forked.getSessionId()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    it('throws INVALID_SESSION_IDENTIFIER when target equals source', async () => {
      const sourceId = '11111111-1111-4111-8111-111111111111';
      const sourcePath = nodePath.join(ctx.bucketDir, `${sourceId}.jsonl`);
      await writeJsonl(sourcePath, [
        {
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-01-01T00:00:00.000Z',
          parentUuid: null,
          isSidechain: false,
          cwd: ctx.projectDir,
          sessionId: sourceId,
          userType: 'external',
          version: '1.0.0',
          message: { role: 'user', content: 'hello' },
        },
      ]);

      await expect(
        ctx.manager.fork(ctx.projectDir, sourceId, {
          bucketDir: ctx.bucketDir,
          targetSessionId: sourceId,
        }),
      ).rejects.toSatisfy(
        (error: SessionError) => error.code === 'INVALID_SESSION_IDENTIFIER',
      );
    });

    it('throws INVALID_SESSION_IDENTIFIER for invalid resumeSessionAt', async () => {
      const sourceId = '11111111-1111-4111-8111-111111111111';
      const targetId = '22222222-2222-4222-8222-222222222222';
      const sourcePath = nodePath.join(ctx.bucketDir, `${sourceId}.jsonl`);
      await writeJsonl(sourcePath, [
        {
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-01-01T00:00:00.000Z',
          parentUuid: null,
          isSidechain: false,
          cwd: ctx.projectDir,
          sessionId: sourceId,
          userType: 'external',
          version: '1.0.0',
          message: { role: 'user', content: 'hello' },
        },
      ]);

      await expect(
        ctx.manager.fork(ctx.projectDir, sourceId, {
          bucketDir: ctx.bucketDir,
          targetSessionId: targetId,
          resumeSessionAt: 'non-existent-uuid',
        }),
      ).rejects.toSatisfy(
        (error: SessionError) => error.code === 'INVALID_SESSION_IDENTIFIER',
      );
    });

    it('propagates targetTitle and source metadata to forked session', async () => {
      const sourceId = '11111111-1111-4111-8111-111111111111';
      const targetId = '22222222-2222-4222-8222-222222222222';
      const sourcePath = nodePath.join(ctx.bucketDir, `${sourceId}.jsonl`);
      await writeJsonl(sourcePath, [
        {
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-01-01T00:00:00.000Z',
          parentUuid: null,
          isSidechain: false,
          cwd: ctx.projectDir,
          sessionId: sourceId,
          userType: 'external',
          version: '1.0.0',
          message: { role: 'user', content: 'hello' },
        },
        {
          type: 'custom-title',
          sessionId: sourceId,
          customTitle: 'Source Title',
        },
        {
          type: 'tag',
          sessionId: sourceId,
          tag: 'important',
        },
      ]);

      const forked = await ctx.manager.fork(ctx.projectDir, sourceId, {
        bucketDir: ctx.bucketDir,
        targetSessionId: targetId,
        targetTitle: 'Forked Copy',
      });

      expect(forked.getCustomTitle()).toBe('Forked Copy');
      expect(forked.getTag()).toBe('important');

      // Verify tag entry was written to target transcript.
      const targetPath = nodePath.join(ctx.bucketDir, `${targetId}.jsonl`);
      const targetContent = await fs.readFile(targetPath, 'utf8');
      const lines = targetContent.trim().split('\n').map((l) => JSON.parse(l));
      const tagLine = lines.find(
        (l: Record<string, unknown>) => l['type'] === 'tag',
      );
      expect(tagLine).toBeDefined();
      expect(tagLine['tag']).toBe('important');

      const titleLine = lines.find(
        (l: Record<string, unknown>) => l['type'] === 'custom-title',
      );
      expect(titleLine).toBeDefined();
      expect(titleLine['customTitle']).toBe('Forked Copy');
    });

    it('inherits source customTitle when no targetTitle is provided', async () => {
      const sourceId = '11111111-1111-4111-8111-111111111111';
      const targetId = '22222222-2222-4222-8222-222222222222';
      const sourcePath = nodePath.join(ctx.bucketDir, `${sourceId}.jsonl`);
      await writeJsonl(sourcePath, [
        {
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-01-01T00:00:00.000Z',
          parentUuid: null,
          isSidechain: false,
          cwd: ctx.projectDir,
          sessionId: sourceId,
          userType: 'external',
          version: '1.0.0',
          message: { role: 'user', content: 'hello' },
        },
        {
          type: 'custom-title',
          sessionId: sourceId,
          customTitle: 'Source Title',
        },
      ]);

      const forked = await ctx.manager.fork(ctx.projectDir, sourceId, {
        bucketDir: ctx.bucketDir,
        targetSessionId: targetId,
      });

      expect(forked.getCustomTitle()).toBe('Source Title');
    });

    it('applies explicit forkedFrom to all copied messages', async () => {
      const sourceId = '11111111-1111-4111-8111-111111111111';
      const targetId = '22222222-2222-4222-8222-222222222222';
      const sourcePath = nodePath.join(ctx.bucketDir, `${sourceId}.jsonl`);
      const explicitForkedFrom = {
        sessionId: 'original-session-id',
        messageUuid: 'original-message-uuid',
      };
      await writeJsonl(sourcePath, [
        {
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-01-01T00:00:00.000Z',
          parentUuid: null,
          isSidechain: false,
          cwd: ctx.projectDir,
          sessionId: sourceId,
          userType: 'external',
          version: '1.0.0',
          message: { role: 'user', content: 'hello' },
        },
        {
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-01-01T00:00:01.000Z',
          parentUuid: 'u1',
          isSidechain: false,
          cwd: ctx.projectDir,
          sessionId: sourceId,
          userType: 'external',
          version: '1.0.0',
          message: { role: 'assistant', content: 'world' },
        },
      ]);

      const forked = await ctx.manager.fork(ctx.projectDir, sourceId, {
        bucketDir: ctx.bucketDir,
        targetSessionId: targetId,
        forkedFrom: explicitForkedFrom,
      });

      // Both messages share the same explicit provenance.
      expect(forked.getMessages()[0].getForkedFrom()).toEqual(
        explicitForkedFrom,
      );
      expect(forked.getMessages()[1].getForkedFrom()).toEqual(
        explicitForkedFrom,
      );
    });

    it('throws INVALID_SESSION_IDENTIFIER for unsafe source sessionId', async () => {
      await expect(
        ctx.manager.fork(ctx.projectDir, '../etc-passwd', {
          bucketDir: ctx.bucketDir,
          targetSessionId: '22222222-2222-4222-8222-222222222222',
        }),
      ).rejects.toSatisfy(
        (error: SessionError) => error.code === 'INVALID_SESSION_IDENTIFIER',
      );
    });
  });

  describe('create', () => {
    it('creates a session with auto-generated UUID when no stamp is provided', async () => {
      const session = await ctx.manager.create();

      expect(session.getSessionId()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(session.getMessages()).toEqual([]);
    });

    it('creates a session with the provided stamp', async () => {
      const session = await ctx.manager.create({
        sessionId: 'custom-id',
        projectDir: '/my/project',
        cwd: '/my/project',
      });

      expect(session.getSessionId()).toBe('custom-id');
      expect(session.getProjectDir()).toBe('/my/project');
      expect(session.getCwd()).toBe('/my/project');
    });

    it('creates a session with default values for omitted stamp fields', async () => {
      const session = await ctx.manager.create({});

      expect(session.getSessionId()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(session.getMessages()).toEqual([]);
    });
  });

  describe('info', () => {
    it('returns a metadata-only session projection', async () => {
      const pathA = nodePath.join(ctx.bucketDir, 'a.jsonl');
      await writeJsonl(pathA, [
        { timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/project' },
        { type: 'custom-title', sessionId: 'a', customTitle: 'My Session' },
        { type: 'tag', sessionId: 'a', tag: 'debug' },
        { type: 'ai-title', sessionId: 'a', aiTitle: 'AI Generated Title' },
      ]);

      const session = await ctx.manager.info(ctx.projectDir, 'a', {
        bucketDir: ctx.bucketDir,
      });

      expect(session.getSessionId()).toBe('a');
      expect(session.getCustomTitle()).toBe('My Session');
      expect(session.getAiTitle()).toBe('AI Generated Title');
      expect(session.getTag()).toBe('debug');
      expect(session.getCwd()).toBe('/tmp/project');
    });

    it('throws SESSION_NOT_FOUND for non-existent session', async () => {
      await expect(
        ctx.manager.info(ctx.projectDir, 'missing', {
          bucketDir: ctx.bucketDir,
        }),
      ).rejects.toSatisfy(
        (error: SessionError) => error.code === 'SESSION_NOT_FOUND',
      );
    });

    it('throws SESSION_NOT_FOUND for unsafe sessionId', async () => {
      await expect(
        ctx.manager.info(ctx.projectDir, '../etc-passwd', {
          bucketDir: ctx.bucketDir,
        }),
      ).rejects.toSatisfy(
        (error: SessionError) => error.code === 'SESSION_NOT_FOUND',
      );
    });
  });

  describe('loadByIndex (edge cases)', () => {
    it('throws NO_SESSIONS_FOUND for empty catalog', async () => {
      await expect(
        ctx.manager.loadByIndex(ctx.projectDir, 1, {
          bucketDir: ctx.bucketDir,
        }),
      ).rejects.toSatisfy(
        (error: SessionError) => error.code === 'NO_SESSIONS_FOUND',
      );
    });

    it('throws INVALID_SESSION_IDENTIFIER for index 0', async () => {
      const pathA = nodePath.join(ctx.bucketDir, 'a.jsonl');
      await writeJsonl(pathA, [{ timestamp: '2026-01-01T00:00:00.000Z' }]);

      await expect(
        ctx.manager.loadByIndex(ctx.projectDir, 0, {
          bucketDir: ctx.bucketDir,
        }),
      ).rejects.toSatisfy(
        (error: SessionError) => error.code === 'INVALID_SESSION_IDENTIFIER',
      );
    });

    it('throws INVALID_SESSION_IDENTIFIER for negative index', async () => {
      const pathA = nodePath.join(ctx.bucketDir, 'a.jsonl');
      await writeJsonl(pathA, [{ timestamp: '2026-01-01T00:00:00.000Z' }]);

      await expect(
        ctx.manager.loadByIndex(ctx.projectDir, -1, {
          bucketDir: ctx.bucketDir,
        }),
      ).rejects.toSatisfy(
        (error: SessionError) => error.code === 'INVALID_SESSION_IDENTIFIER',
      );
    });
  });

  describe('loadByIdOrIndex (edge cases)', () => {
    it('throws INVALID_SESSION_IDENTIFIER for out-of-range numeric index', async () => {
      const pathA = nodePath.join(ctx.bucketDir, 'a.jsonl');
      await writeJsonl(pathA, [{ timestamp: '2026-01-01T00:00:00.000Z' }]);

      await expect(
        ctx.manager.loadByIdOrIndex(ctx.projectDir, '99', {
          bucketDir: ctx.bucketDir,
        }),
      ).rejects.toSatisfy(
        (error: SessionError) => error.code === 'INVALID_SESSION_IDENTIFIER',
      );
    });

    it('throws NO_SESSIONS_FOUND for numeric index with empty catalog', async () => {
      await expect(
        ctx.manager.loadByIdOrIndex(ctx.projectDir, '1', {
          bucketDir: ctx.bucketDir,
        }),
      ).rejects.toSatisfy(
        (error: SessionError) => error.code === 'NO_SESSIONS_FOUND',
      );
    });

    it('trims whitespace before resolving', async () => {
      const pathA = nodePath.join(ctx.bucketDir, 'a.jsonl');
      await writeJsonl(pathA, [{ timestamp: '2026-01-01T00:00:00.000Z' }]);

      const session = await ctx.manager.loadByIdOrIndex(
        ctx.projectDir,
        '  a  ',
        { bucketDir: ctx.bucketDir },
      );
      expect(session.getSessionId()).toBe('a');
    });
  });

  describe('rename (edge cases)', () => {
    it('accepts a title at the maximum length boundary', async () => {
      const pathA = nodePath.join(ctx.bucketDir, 'a.jsonl');
      await writeJsonl(pathA, [{ timestamp: '2026-01-01T00:00:00.000Z' }]);

      const maxTitle = 'x'.repeat(200);
      const renamed = await ctx.manager.rename(
        ctx.projectDir,
        'a',
        maxTitle,
        { bucketDir: ctx.bucketDir },
      );

      expect(renamed.getCustomTitle()).toBe(maxTitle);
    });
  });
});

/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '../config/storage.js';
import {
  deleteFileCheckpointSession,
  FileHistoryManager,
} from './file-history.js';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-history-'));
  vi.spyOn(Storage, 'getGlobalConfigDir').mockReturnValue(tempDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('FileHistoryManager', () => {
  it.each(['copyFile', 'chmod', 'rename'] as const)(
    'does not publish incomplete contents when %s fails',
    async (phase) => {
      const file = path.join(tempDir, 'file.txt');
      const backupDir = path.join(tempDir, 'file-history', 'session-1');
      const manager = new FileHistoryManager({
        cwd: tempDir,
        sessionId: 'session-1',
      });
      await fs.writeFile(file, 'original');
      await fs.mkdir(backupDir, { recursive: true });
      await manager.makeSnapshot('m1');
      if (phase === 'copyFile') {
        vi.spyOn(fs, 'copyFile').mockImplementationOnce(
          async (_source, target) => {
            await fs.writeFile(target, 'partial');
            throw new Error('copy interrupted');
          },
        );
      } else
        vi.spyOn(fs, phase).mockRejectedValueOnce(
          new Error('capture interrupted'),
        );
      await expect(manager.trackEdit(file, 'm1')).resolves.toBeUndefined();
      const backup = manager.getSnapshots()[0].trackedFileBackups['file.txt'];
      expect(backup.captureFailed).toBe(true);
      expect(typeof backup.backupFileName).toBe('string');
      expect(await fs.readdir(backupDir)).toEqual([]);
      expect(await fs.readFile(file, 'utf8')).toBe('original');
      const preview = await manager.getDiffStats('m1');
      const result = await manager.rewindDetailed('m1');
      expect(preview?.failedFiles).toEqual(result.failedFiles);
      expect(result.failedFiles).toEqual([
        {
          path: file,
          error: 'No usable backup was captured for this checkpoint.',
        },
      ]);
    },
  );

  it.each([false, true])(
    'preserves the old checkpoint without substituting it for a failed capture (new file: %s)',
    async (newFile) => {
      const file = path.join(tempDir, 'file.txt');
      const manager = new FileHistoryManager({
        cwd: tempDir,
        sessionId: 'session-1',
      });
      if (!newFile) await fs.writeFile(file, 'A');
      await manager.makeSnapshot('m1');
      await manager.trackEdit(file, 'm1');
      await fs.writeFile(file, 'accepted B');
      vi.spyOn(fs, 'chmod').mockRejectedValueOnce(
        Object.assign(new Error('backup disappeared'), { code: 'ENOENT' }),
      );
      await expect(manager.makeSnapshot('m2')).resolves.toBeUndefined();
      await manager.trackEdit(file, 'm2');
      await fs.writeFile(file, 'edited C');

      expect(
        manager.getSnapshots()[1].trackedFileBackups['file.txt'].captureFailed,
      ).toBe(true);
      expect(await manager.hasAnyChanges('m2')).toBe(true);
      expect(await manager.getDiffStats('m2')).toMatchObject({
        filesChanged: [],
        failedFiles: [{ path: file }],
      });
      expect(await manager.rewindDetailed('m2')).toMatchObject({
        filesChanged: [],
        failedFiles: [{ path: file }],
      });
      expect(await fs.readFile(file, 'utf8')).toBe('edited C');

      // A later successful capture is a new checkpoint, not a repair of m2.
      await manager.makeSnapshot('m3');
      await manager.trackEdit(file, 'm3');
      await fs.writeFile(file, 'D');
      expect((await manager.rewindDetailed('m3')).failedFiles).toEqual([]);
      expect(await fs.readFile(file, 'utf8')).toBe('edited C');
      expect((await manager.rewindDetailed('m2')).failedFiles).toHaveLength(1);
      expect((await manager.rewindDetailed('m1')).failedFiles).toEqual([]);
      if (newFile)
        await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
      else expect(await fs.readFile(file, 'utf8')).toBe('A');
    },
  );

  it('keeps a failed first capture through same-turn edits, JSON resume and strict fork', async () => {
    const file = path.join(tempDir, 'failed.txt');
    const healthy = path.join(tempDir, 'healthy.txt');
    const recordSnapshot = vi.fn();
    const manager = new FileHistoryManager({
      cwd: tempDir,
      sessionId: 'source',
      recordSnapshot,
    });
    await fs.writeFile(file, 'original A');
    await fs.writeFile(healthy, 'healthy before');
    await manager.makeSnapshot('earlier');
    await manager.makeSnapshot('m1');
    await manager.trackEdit(healthy, 'm1');
    const capture = vi
      .spyOn(fs, 'chmod')
      .mockRejectedValueOnce(new Error('capture failed'));
    await expect(manager.trackEdit(file, 'm1')).resolves.toBeUndefined();
    await fs.writeFile(file, 'B');
    await manager.trackEdit(file, 'm1');
    await fs.writeFile(file, 'C');
    expect(capture).toHaveBeenCalledTimes(1);
    expect(
      recordSnapshot.mock.calls.at(-1)?.[0].snapshot.trackedFileBackups[
        'failed.txt'
      ].captureFailed,
    ).toBe(true);
    expect((await manager.rewindDetailed('earlier')).failedFiles).toHaveLength(
      1,
    );
    expect(await fs.readFile(file, 'utf8')).toBe('C');

    const fork = new FileHistoryManager({ cwd: tempDir, sessionId: 'fork' });
    await expect(
      fork.rehydrateFromResume({
        snapshots: JSON.parse(JSON.stringify(manager.getSnapshots())),
        sourceSessionId: 'source',
        strictBackupCopy: true,
      }),
    ).resolves.toBeUndefined();
    await fs.writeFile(healthy, 'healthy edited');
    const result = await fork.rewindDetailed('m1');
    expect(result.filesChanged).toEqual([healthy]);
    expect(result.failedFiles).toEqual([
      { path: file, error: expect.stringContaining('No usable backup') },
    ]);
    expect(await fs.readFile(file, 'utf8')).toBe('C');
    expect(await fs.readFile(healthy, 'utf8')).toBe('healthy before');
  });

  it('records unavailable when source inspection fails while preparing a snapshot', async () => {
    const file = path.join(tempDir, 'file.txt');
    const manager = new FileHistoryManager({
      cwd: tempDir,
      sessionId: 'session-1',
    });
    await fs.writeFile(file, 'A');
    await manager.makeSnapshot('m1');
    await manager.trackEdit(file, 'm1');
    vi.spyOn(fs, 'stat').mockRejectedValueOnce(
      Object.assign(new Error('denied'), { code: 'EACCES' }),
    );
    await manager.makeSnapshot('m2');
    expect(
      manager.getSnapshots()[1].trackedFileBackups['file.txt'].captureFailed,
    ).toBe(true);
  });

  it.each([false, true])(
    'reports the same missing backup error in preview and rewind (source missing: %s)',
    async (sourceMissing) => {
      const file = path.join(tempDir, 'file.txt');
      const manager = new FileHistoryManager({
        cwd: tempDir,
        sessionId: 'session-1',
      });
      await fs.writeFile(file, 'before');
      await manager.makeSnapshot('m1');
      await manager.trackEdit(file, 'm1');
      await fs.rm(path.join(tempDir, 'file-history', 'session-1'), {
        recursive: true,
      });
      if (sourceMissing) await fs.unlink(file);
      const expected = [
        { path: file, error: 'The checkpoint backup is missing.' },
      ];
      expect((await manager.rewindDetailed('m1')).failedFiles).toEqual(expected);
      expect((await manager.getDiffStats('m1'))?.failedFiles).toEqual(expected);
      if (!sourceMissing) expect(await fs.readFile(file, 'utf8')).toBe('before');
    },
  );

  it('preserves permission errors instead of reporting a missing backup', async () => {
    const file = path.join(tempDir, 'file.txt');
    const manager = new FileHistoryManager({
      cwd: tempDir,
      sessionId: 'session-1',
    });
    await fs.writeFile(file, 'before');
    await manager.makeSnapshot('m1');
    await manager.trackEdit(file, 'm1');
    const denied = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    });
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(denied);
    expect((await manager.getDiffStats('m1'))?.failedFiles).toEqual([
      { path: file, error: 'permission denied' },
    ]);
    vi.spyOn(fs, 'stat').mockRejectedValueOnce(denied);
    expect((await manager.rewindDetailed('m1')).failedFiles).toEqual([
      { path: file, error: 'permission denied' },
    ]);
    expect(await fs.readFile(file, 'utf8')).toBe('before');
  });

  it('honors an explicit absent-file checkpoint instead of falling back to the first contents', async () => {
    const file = path.join(tempDir, 'file.txt');
    const manager = new FileHistoryManager({
      cwd: tempDir,
      sessionId: 'session-1',
    });
    await fs.writeFile(file, 'before');
    await manager.makeSnapshot('m1');
    await manager.trackEdit(file, 'm1');
    await fs.unlink(file);
    await manager.makeSnapshot('m2');
    await fs.writeFile(file, 'recreated');
    expect((await manager.rewindDetailed('m2')).failedFiles).toEqual([]);
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps editing and in-process failure state when checkpoint recording fails', async () => {
    const file = path.join(tempDir, 'file.txt');
    const manager = new FileHistoryManager({
      cwd: tempDir,
      sessionId: 'session-1',
      recordSnapshot: () => {
        throw new Error('disk full');
      },
    });
    await fs.writeFile(file, 'before');
    await manager.makeSnapshot('m1');
    vi.spyOn(fs, 'chmod').mockRejectedValueOnce(new Error('capture failed'));
    await expect(manager.trackEdit(file, 'm1')).resolves.toBeUndefined();
    await fs.writeFile(file, 'after');
    expect((await manager.rewindDetailed('m1')).failedFiles).toHaveLength(1);
    expect(await fs.readFile(file, 'utf8')).toBe('after');
  });

  it('keeps the default checkpoint root under the global config directory', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(tempDir, 'workspace-'));
    const filePath = path.join(workspaceDir, 'existing.txt');
    await fs.writeFile(filePath, 'before');
    const manager = new FileHistoryManager({
      cwd: workspaceDir,
      sessionId: 'session-1',
    });

    await manager.makeSnapshot('message-1');
    await manager.trackEdit(filePath, 'message-1');

    expect(
      await fs.readdir(path.join(tempDir, 'file-history', 'session-1')),
    ).not.toHaveLength(0);
  });

  it('keeps checkpoint blobs in an explicit persistent root across manager instances', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(tempDir, 'workspace-'));
    const checkpointRoot = path.join(tempDir, 'persistent-checkpoints');
    const filePath = path.join(workspaceDir, 'existing.txt');
    await fs.writeFile(filePath, 'before');

    const first = new FileHistoryManager({
      cwd: workspaceDir,
      sessionId: 'session-1',
      checkpointRoot,
    });
    await first.makeSnapshot('message-1');
    await first.trackEdit(filePath, 'message-1');
    await fs.writeFile(filePath, 'after');

    const resumed = new FileHistoryManager({
      cwd: workspaceDir,
      sessionId: 'session-1',
      checkpointRoot,
    });
    resumed.restoreStateFromSnapshots(first.getSnapshots());
    await resumed.rewind('message-1');

    expect(await fs.readFile(filePath, 'utf8')).toBe('before');
    expect(await fs.readdir(path.join(checkpointRoot, 'session-1'))).not.toHaveLength(0);
  });

  it('records the checkout that produced each persisted snapshot', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(tempDir, 'workspace-'));
    const filePath = path.join(workspaceDir, 'existing.txt');
    await fs.writeFile(filePath, 'before');
    const manager = new FileHistoryManager({
      cwd: workspaceDir,
      sessionId: 'session-1',
    });

    await manager.makeSnapshot('message-1');
    await manager.trackEdit(filePath, 'message-1');

    expect(manager.getSnapshots()[0]).toMatchObject({
      cwd: path.resolve(workspaceDir),
    });
  });

  it('does not restore snapshots produced by a different checkout', () => {
    const manager = new FileHistoryManager({
      cwd: path.join(tempDir, 'worktree'),
      sessionId: 'session-1',
    });

    manager.restoreStateFromSnapshots([
      {
        messageId: 'message-original',
        cwd: path.join(tempDir, 'original'),
        trackedFileBackups: {
          'src/example.ts': {
            backupFileName: 'backup',
            version: 1,
            backupTime: new Date(),
          },
        },
        timestamp: new Date(),
      },
    ]);

    expect(manager.getSnapshots()).toEqual([]);
  });

  it('does not restore legacy snapshots in a Worktree session', () => {
    const manager = new FileHistoryManager({
      cwd: path.join(tempDir, 'worktree'),
      sessionId: 'session-1',
      acceptLegacySnapshots: false,
    });

    manager.restoreStateFromSnapshots([
      {
        messageId: 'message-legacy',
        trackedFileBackups: {
          'src/example.ts': {
            backupFileName: 'backup',
            version: 1,
            backupTime: new Date(),
          },
        },
        timestamp: new Date(),
      },
    ]);

    expect(manager.getSnapshots()).toEqual([]);
  });

  it('keeps same-turn edits rewindable after changing checkout without reusing old backups', async () => {
    const originalCwd = await fs.mkdtemp(path.join(tempDir, 'original-'));
    const worktreeCwd = await fs.mkdtemp(path.join(tempDir, 'worktree-'));
    const filePath = path.join(originalCwd, 'existing.txt');
    const worktreeFilePath = path.join(worktreeCwd, 'existing.txt');
    await fs.writeFile(filePath, 'original before');
    await fs.writeFile(worktreeFilePath, 'worktree before');
    const manager = new FileHistoryManager({
      cwd: originalCwd,
      sessionId: 'session-1',
    });

    await manager.makeSnapshot('message-1');
    await manager.trackEdit(filePath, 'message-1');
    await fs.writeFile(filePath, 'original after');
    manager.rebaseCwd(worktreeCwd);

    expect(manager.getState().trackedFiles).toEqual(new Set());
    await manager.trackEdit(worktreeFilePath, 'message-1');
    await fs.writeFile(worktreeFilePath, 'worktree after');
    await manager.rewind('message-1');

    expect(await fs.readFile(worktreeFilePath, 'utf8')).toBe('worktree before');
    expect(await fs.readFile(filePath, 'utf8')).toBe('original after');

    const resumed = new FileHistoryManager({
      cwd: worktreeCwd,
      sessionId: 'session-1',
    });
    resumed.restoreStateFromSnapshots(manager.getSnapshots());
    await fs.writeFile(worktreeFilePath, 'changed after restart');
    await resumed.rewind('message-1');
    expect(await fs.readFile(worktreeFilePath, 'utf8')).toBe('worktree before');
  });

  it('does not publish an in-flight backup from the old checkout after rebinding', async () => {
    const originalCwd = await fs.mkdtemp(path.join(tempDir, 'original-'));
    const worktreeCwd = await fs.mkdtemp(path.join(tempDir, 'worktree-'));
    const originalFile = path.join(originalCwd, 'existing.txt');
    const worktreeFile = path.join(worktreeCwd, 'existing.txt');
    await fs.writeFile(originalFile, 'original content');
    await fs.writeFile(worktreeFile, 'worktree content');
    const manager = new FileHistoryManager({
      cwd: originalCwd,
      sessionId: 'session-1',
    });
    await manager.makeSnapshot('message-1');
    let startCopy!: () => void;
    let releaseCopy!: () => void;
    const copyStarted = new Promise<void>((resolve) => {
      startCopy = resolve;
    });
    const copyReleased = new Promise<void>((resolve) => {
      releaseCopy = resolve;
    });
    const copyFile = fs.copyFile;
    vi.spyOn(fs, 'copyFile').mockImplementation(async (source, target, mode) => {
      if (source === originalFile) {
        startCopy();
        await copyReleased;
      }
      await copyFile(source, target, mode);
    });
    const edit = manager.trackEdit(originalFile, 'message-1');
    await copyStarted;
    manager.rebaseCwd(worktreeCwd);
    releaseCopy();
    await edit;
    await manager.trackEdit(worktreeFile, 'message-1');
    await fs.writeFile(worktreeFile, 'changed');
    await manager.rewind('message-1');
    expect(await fs.readFile(worktreeFile, 'utf8')).toBe('worktree content');
  });

  it('deletes only the requested Session checkpoint directory', async () => {
    const checkpointRoot = path.join(tempDir, 'persistent-checkpoints');
    await fs.mkdir(path.join(checkpointRoot, 'session-1'), { recursive: true });
    await fs.mkdir(path.join(checkpointRoot, 'session-2'), { recursive: true });

    await deleteFileCheckpointSession(checkpointRoot, 'session-1');

    await expect(fs.stat(path.join(checkpointRoot, 'session-1'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.stat(path.join(checkpointRoot, 'session-2'))).resolves.toBeDefined();
    await expect(
      deleteFileCheckpointSession(checkpointRoot, '../outside'),
    ).rejects.toThrow('Invalid file checkpoint Session id');
  });

  it('未继续修改文件时不会重复创建新备份版本', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(tempDir, 'workspace-'));
    const manager = new FileHistoryManager({
      cwd: workspaceDir,
      sessionId: 'session-1',
    });
    const filePath = path.join(workspaceDir, 'existing.txt');

    await fs.writeFile(filePath, 'before');

    await manager.makeSnapshot('message-1');
    await manager.trackEdit(filePath, 'message-1');
    await fs.writeFile(filePath, 'after');
    await manager.makeSnapshot('message-2');
    await manager.makeSnapshot('message-3');

    const snapshots = manager.getSnapshots();
    const prompt2Backup =
      snapshots[1].trackedFileBackups[path.relative(workspaceDir, filePath)];
    const prompt3Backup =
      snapshots[2].trackedFileBackups[path.relative(workspaceDir, filePath)];

    expect(prompt2Backup.version).toBe(2);
    expect(prompt3Backup.version).toBe(2);
    expect(prompt3Backup.backupFileName).toBe(prompt2Backup.backupFileName);
  });

  it('rewind 到创建前快照时会删除新文件', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(tempDir, 'workspace-'));
    const manager = new FileHistoryManager({
      cwd: workspaceDir,
      sessionId: 'session-1',
    });
    const filePath = path.join(workspaceDir, 'new-file.txt');

    await manager.makeSnapshot('message-1');
    await manager.trackEdit(filePath, 'message-1');
    await fs.writeFile(filePath, 'hello');
    await manager.makeSnapshot('message-2');

    expect(await fs.readFile(filePath, 'utf8')).toBe('hello');

    await manager.rewind('message-1');

    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rewind 会恢复已有文件的内容和权限', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(tempDir, 'workspace-'));
    const manager = new FileHistoryManager({
      cwd: workspaceDir,
      sessionId: 'session-1',
    });
    const filePath = path.join(workspaceDir, 'existing.txt');

    await fs.writeFile(filePath, 'before');
    await fs.chmod(filePath, 0o744);

    await manager.makeSnapshot('message-1');
    await manager.trackEdit(filePath, 'message-1');
    await fs.writeFile(filePath, 'after');
    await fs.chmod(filePath, 0o600);
    await manager.makeSnapshot('message-2');

    await manager.rewind('message-1');

    expect(await fs.readFile(filePath, 'utf8')).toBe('before');
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o744);
  });

  it('rewind 遇到单个文件恢复失败时会继续处理其他文件', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(tempDir, 'workspace-'));
    const manager = new FileHistoryManager({
      cwd: workspaceDir,
      sessionId: 'session-1',
    });
    const firstFilePath = path.join(workspaceDir, 'first.txt');
    const secondFilePath = path.join(workspaceDir, 'second.txt');

    await fs.writeFile(firstFilePath, 'first-before');
    await fs.writeFile(secondFilePath, 'second-before');

    await manager.makeSnapshot('message-1');
    await manager.trackEdit(firstFilePath, 'message-1');
    await manager.trackEdit(secondFilePath, 'message-1');
    await fs.writeFile(firstFilePath, 'first-after');
    await fs.writeFile(secondFilePath, 'second-after');
    await manager.makeSnapshot('message-2');

    const snapshots = manager.getSnapshots();
    const missingBackupFileName =
      snapshots[0].trackedFileBackups[
        path.relative(workspaceDir, firstFilePath)
      ].backupFileName;

    await fs.rm(
      path.join(tempDir, 'file-history', 'session-1', missingBackupFileName!),
    );

    const result = await manager.rewindDetailed('message-1');

    expect(result.filesChanged).toEqual([secondFilePath]);
    expect(result.failedFiles).toEqual([
      expect.objectContaining({
        path: firstFilePath,
        error: expect.any(String),
      }),
    ]);
    expect(await fs.readFile(firstFilePath, 'utf8')).toBe('first-after');
    expect(await fs.readFile(secondFilePath, 'utf8')).toBe('second-before');
  });

  it('resume 到新 session 时会迁移备份并继续支持 rewind', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(tempDir, 'workspace-'));
    const sourceManager = new FileHistoryManager({
      cwd: workspaceDir,
      sessionId: 'session-1',
    });
    const filePath = path.join(workspaceDir, 'existing.txt');

    await fs.writeFile(filePath, 'before');
    await sourceManager.makeSnapshot('message-1');
    await sourceManager.trackEdit(filePath, 'message-1');
    await fs.writeFile(filePath, 'after');
    await sourceManager.makeSnapshot('message-2');

    const snapshots = sourceManager.getSnapshots();
    const backupFileName =
      snapshots[1].trackedFileBackups[path.relative(workspaceDir, filePath)]
        .backupFileName;

    const resumedManager = new FileHistoryManager({
      cwd: workspaceDir,
      sessionId: 'session-2',
    });

    await resumedManager.rehydrateFromResume({
      sourceSessionId: 'session-1',
      snapshots,
    });

    expect(
      await fs.stat(
        path.join(tempDir, 'file-history', 'session-2', backupFileName!),
      ),
    ).toBeDefined();

    await resumedManager.rewind('message-1');

    expect(await fs.readFile(filePath, 'utf8')).toBe('before');
  });

  it('copyBackupFiles=false 时只恢复内存状态，不再复制备份', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(tempDir, 'workspace-'));
    const sourceManager = new FileHistoryManager({
      cwd: workspaceDir,
      sessionId: 'session-1',
    });
    const filePath = path.join(workspaceDir, 'existing.txt');

    await fs.writeFile(filePath, 'before');
    await sourceManager.makeSnapshot('message-1');
    await sourceManager.trackEdit(filePath, 'message-1');
    const snapshots = sourceManager.getSnapshots();

    const resumedManager = new FileHistoryManager({
      cwd: workspaceDir,
      sessionId: 'session-2',
    });
    await resumedManager.rehydrateFromResume({
      sourceSessionId: 'session-1',
      snapshots,
      copyBackupFiles: false,
    });

    expect(resumedManager.getSnapshots()).toHaveLength(snapshots.length);
    await expect(
      fs.stat(path.join(tempDir, 'file-history', 'session-2')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('resume 迁移备份时遇到缺失文件会跳过并继续恢复其他备份', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(tempDir, 'workspace-'));
    const sourceManager = new FileHistoryManager({
      cwd: workspaceDir,
      sessionId: 'session-1',
    });
    const firstFilePath = path.join(workspaceDir, 'first.txt');
    const secondFilePath = path.join(workspaceDir, 'second.txt');

    await fs.writeFile(firstFilePath, 'first-before');
    await fs.writeFile(secondFilePath, 'second-before');
    await sourceManager.makeSnapshot('message-1');
    await sourceManager.trackEdit(firstFilePath, 'message-1');
    await sourceManager.trackEdit(secondFilePath, 'message-1');
    await fs.writeFile(firstFilePath, 'first-after');
    await fs.writeFile(secondFilePath, 'second-after');
    await sourceManager.makeSnapshot('message-2');

    const snapshots = sourceManager.getSnapshots();
    const missingBackupFileName =
      snapshots[0].trackedFileBackups[
        path.relative(workspaceDir, firstFilePath)
      ].backupFileName;
    const copiedBackupFileName =
      snapshots[0].trackedFileBackups[
        path.relative(workspaceDir, secondFilePath)
      ].backupFileName;

    await fs.rm(
      path.join(tempDir, 'file-history', 'session-1', missingBackupFileName!),
    );

    const resumedManager = new FileHistoryManager({
      cwd: workspaceDir,
      sessionId: 'session-2',
    });

    await resumedManager.rehydrateFromResume({
      sourceSessionId: 'session-1',
      snapshots,
    });

    await expect(
      fs.stat(
        path.join(tempDir, 'file-history', 'session-2', copiedBackupFileName!),
      ),
    ).resolves.toBeDefined();
    await expect(
      fs.stat(
        path.join(tempDir, 'file-history', 'session-2', missingBackupFileName!),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    const changedFiles = await resumedManager.rewind('message-1');

    expect(changedFiles).toEqual([secondFilePath]);
    expect(await fs.readFile(firstFilePath, 'utf8')).toBe('first-after');
    expect(await fs.readFile(secondFilePath, 'utf8')).toBe('second-before');
  });

  it('Fork 严格迁移遇到缺失备份时失败并清理不完整目标目录', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(tempDir, 'workspace-'));
    const sourceManager = new FileHistoryManager({
      cwd: workspaceDir,
      sessionId: 'session-1',
    });
    const filePath = path.join(workspaceDir, 'existing.txt');

    await fs.writeFile(filePath, 'before');
    await sourceManager.makeSnapshot('message-1');
    await sourceManager.trackEdit(filePath, 'message-1');
    const snapshots = sourceManager.getSnapshots();
    const backupFileName =
      snapshots[0].trackedFileBackups[path.relative(workspaceDir, filePath)]
        .backupFileName;
    await fs.rm(
      path.join(tempDir, 'file-history', 'session-1', backupFileName!),
    );

    const resumedManager = new FileHistoryManager({
      cwd: workspaceDir,
      sessionId: 'session-2',
    });

    await expect(
      resumedManager.rehydrateFromResume({
        sourceSessionId: 'session-1',
        snapshots,
        strictBackupCopy: true,
      }),
    ).rejects.toThrow('failed to copy 1 checkpoint backup file');
    await expect(
      fs.stat(path.join(tempDir, 'file-history', 'session-2')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('Fork 严格迁移会清理目标 Session 的残留备份', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(tempDir, 'workspace-'));
    const sourceManager = new FileHistoryManager({
      cwd: workspaceDir,
      sessionId: 'session-1',
    });
    const filePath = path.join(workspaceDir, 'existing.txt');

    await fs.writeFile(filePath, 'before');
    await sourceManager.makeSnapshot('message-1');
    await sourceManager.trackEdit(filePath, 'message-1');
    const snapshots = sourceManager.getSnapshots();
    const targetDir = path.join(tempDir, 'file-history', 'session-2');
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, 'stale-backup'), 'stale');

    const resumedManager = new FileHistoryManager({
      cwd: workspaceDir,
      sessionId: 'session-2',
    });
    await resumedManager.rehydrateFromResume({
      sourceSessionId: 'session-1',
      snapshots,
      strictBackupCopy: true,
    });

    await expect(
      fs.stat(path.join(targetDir, 'stale-backup')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readdir(targetDir)).resolves.not.toHaveLength(0);
  });

  it('只在有真实文件备份时写 transcript 快照', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(tempDir, 'workspace-'));
    const recordSnapshot = vi.fn();
    const manager = new FileHistoryManager({
      cwd: workspaceDir,
      sessionId: 'session-1',
      recordSnapshot,
    });
    const filePath = path.join(workspaceDir, 'existing.txt');

    await fs.writeFile(filePath, 'before');
    await manager.makeSnapshot('message-1');
    expect(recordSnapshot).not.toHaveBeenCalled();

    await manager.trackEdit(filePath, 'message-1');

    expect(recordSnapshot).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        messageId: 'message-1',
        isSnapshotUpdate: false,
      }),
    );
  });
});

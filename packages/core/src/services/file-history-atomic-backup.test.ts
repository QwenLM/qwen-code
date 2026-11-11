/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Make node:fs/promises spy-able for failure injection; all functions keep
// their real implementations unless a test spies on them.
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));

const mockStorageDir = vi.hoisted(() => vi.fn());
vi.mock('../config/storage.js', () => ({
  Storage: { getGlobalQwenDir: mockStorageDir },
}));

vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  FileHistoryService,
  serializeSnapshot,
  deserializeSnapshots,
} from './fileHistoryService.js';

describe('atomic backup publication', () => {
  let projectDir: string;
  let storageDir: string;
  let backupDir: string;
  let service: FileHistoryService;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(join(tmpdir(), 'fh-atomic-project-'));
    storageDir = await fs.mkdtemp(join(tmpdir(), 'fh-atomic-storage-'));
    backupDir = join(storageDir, 'file-history', 'test-session');
    // Pre-create so injected copyFile failures are plain Errors, not
    // ENOENTs that safeCopyFile would retry via its mkdir branch.
    await fs.mkdir(backupDir, { recursive: true });
    mockStorageDir.mockReturnValue(storageDir);
    service = new FileHistoryService('test-session', true, projectDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(projectDir, { recursive: true, force: true });
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  const primeTracked = async (content: string) => {
    const file = join(projectDir, 'a.txt');
    await fs.writeFile(file, content);
    await service.makeSnapshot('p1');
    return file;
  };

  const injectCaptureFailure = (phase: 'copyFile' | 'chmod' | 'rename') => {
    if (phase === 'copyFile') {
      // Simulate a crash mid-copy: some bytes landed, then the operation
      // died.
      vi.spyOn(fs, 'copyFile').mockImplementationOnce(async (_src, target) => {
        await fs.writeFile(target as string, 'partial');
        throw new Error('simulated crash mid-copyFile');
      });
    } else {
      vi.spyOn(fs, phase).mockRejectedValueOnce(
        new Error(`simulated ${phase} failure`),
      );
    }
  };

  it.each(['copyFile', 'chmod', 'rename'] as const)(
    'does not publish incomplete contents when %s fails during trackEdit',
    async (phase) => {
      const file = await primeTracked('original-content');
      injectCaptureFailure(phase);
      await service.trackEdit(file);

      // trackEdit swallows capture failures and records nothing.
      expect(
        service.getSnapshots()[0].trackedFileBackups['a.txt'],
      ).toBeUndefined();
      // No final blob and no temporary leftover.
      expect(await fs.readdir(backupDir)).toEqual([]);
      expect(await fs.readFile(file, 'utf8')).toBe('original-content');
    },
  );

  it.each(['copyFile', 'chmod', 'rename'] as const)(
    'surfaces a failed %s capture through the failed flag and filesFailed',
    async (phase) => {
      const file = await primeTracked('original-content');
      await service.trackEdit(file);
      const v1Name =
        service.getSnapshots()[0].trackedFileBackups['a.txt']!.backupFileName!;
      await fs.writeFile(file, 'edited-content');

      injectCaptureFailure(phase);
      await service.makeSnapshot('p2');

      const entry = service.getSnapshots()[1].trackedFileBackups['a.txt']!;
      expect(entry.failed).toBe(true);
      // Only the confirmed v1 blob remains; nothing incomplete published.
      expect(await fs.readdir(backupDir)).toEqual([v1Name]);

      const result = await service.rewind('p2');
      expect(result.filesFailed).toEqual([file]);
      expect(await fs.readFile(file, 'utf8')).toBe('edited-content');
    },
  );

  it('retries a transient EPERM rename and publishes the complete backup', async () => {
    const file = await primeTracked('original-content');
    vi.spyOn(fs, 'rename').mockImplementationOnce(async () => {
      throw Object.assign(new Error('transient lock'), { code: 'EPERM' });
    });
    await service.trackEdit(file);

    const entry = service.getSnapshots()[0].trackedFileBackups['a.txt']!;
    expect(entry.failed).toBeUndefined();
    expect(entry.backupFileName).toEqual(expect.any(String));
    expect(await fs.readdir(backupDir)).toEqual([entry.backupFileName]);
    expect(
      await fs.readFile(join(backupDir, entry.backupFileName!), 'utf8'),
    ).toBe('original-content');
  });

  it('surfaces a persistent EPERM rename as a failed capture after retries exhaust', async () => {
    const file = await primeTracked('original-content');
    vi.spyOn(fs, 'rename').mockImplementation(async () => {
      throw Object.assign(new Error('persistent lock'), { code: 'EPERM' });
    });
    await service.trackEdit(file);

    expect(
      service.getSnapshots()[0].trackedFileBackups['a.txt'],
    ).toBeUndefined();
    expect(await fs.readdir(backupDir)).toEqual([]);
  });

  /**
   * The confirmed crash window from issue #16896: two concurrent trackEdit
   * calls target the same deterministic hash@v1 path (trackEdit's own
   * comment acknowledges this). The first copy completes and its snapshot
   * entry is confirmed; the second copy is interrupted mid-write. The
   * interrupted copy must land on its own temporary file, never truncate
   * the blob the confirmed entry already references.
   */
  const raceCaptureWithCrash = async (file: string) => {
    const realCopyFile = fs.copyFile;
    let calls = 0;
    let signalSecond!: () => void;
    let releaseSecond!: () => void;
    const secondStarted = new Promise<void>((r) => (signalSecond = r));
    const secondReleased = new Promise<void>((r) => (releaseSecond = r));
    const spy = vi
      .spyOn(fs, 'copyFile')
      .mockImplementation(async (src, dst, mode) => {
        calls += 1;
        if (calls === 1) {
          await realCopyFile(src, dst, mode);
          return;
        }
        signalSecond();
        await secondReleased;
        await fs.writeFile(dst as string, 'partial');
        throw new Error('simulated crash mid-copyFile (concurrent overwrite)');
      });

    const first = service.trackEdit(file);
    const second = service.trackEdit(file);
    await secondStarted;
    // Let the successful capture record its confirmed entry before the
    // crash lands.
    await Promise.race([first, second]);
    releaseSecond();
    await Promise.all([first, second]);
    spy.mockRestore();
  };

  it('a concurrent capture crash must not truncate the blob referenced by a confirmed snapshot entry', async () => {
    const file = await primeTracked('original-content');
    await raceCaptureWithCrash(file);

    const entry = service.getSnapshots()[0].trackedFileBackups['a.txt']!;
    expect(entry.backupFileName).toEqual(expect.any(String));
    expect(entry.failed).toBeUndefined();
    expect(
      await fs.readFile(join(backupDir, entry.backupFileName!), 'utf8'),
    ).toBe('original-content');
    expect(await fs.readdir(backupDir)).toEqual([entry.backupFileName]);
  });

  it('rewind after a concurrent capture crash must not silently restore truncated content', async () => {
    const file = await primeTracked('original-content');
    await raceCaptureWithCrash(file);

    // Simulate process restart: persist + reload the snapshot history.
    const persisted = JSON.parse(
      JSON.stringify(service.getSnapshots().map(serializeSnapshot)),
    );
    const resumed = new FileHistoryService('test-session', true, projectDir);
    resumed.restoreFromSnapshots(deserializeSnapshots(persisted));
    await resumed.validateRestoredSnapshots();
    expect(
      resumed.getSnapshots()[0].trackedFileBackups['a.txt']!.failed,
    ).toBeUndefined();

    await fs.writeFile(file, 'edited-after-crash');
    const result = await resumed.rewind('p1');
    expect(result.filesFailed).toEqual([]);
    expect(await fs.readFile(file, 'utf8')).toBe('original-content');
  });

  it('preserves the previous complete checkpoint when a later capture fails', async () => {
    const file = await primeTracked('v1-content');
    await service.trackEdit(file);
    const v1Name =
      service.getSnapshots()[0].trackedFileBackups['a.txt']!.backupFileName!;
    await fs.writeFile(file, 'v2-content');

    vi.spyOn(fs, 'rename').mockRejectedValueOnce(
      new Error('simulated rename failure'),
    );
    await service.makeSnapshot('p2');
    expect(service.getSnapshots()[1].trackedFileBackups['a.txt']!.failed).toBe(
      true,
    );
    expect(await fs.readdir(backupDir)).toEqual([v1Name]);
    expect(await fs.readFile(join(backupDir, v1Name), 'utf8')).toBe(
      'v1-content',
    );

    await fs.writeFile(file, 'v3-content');
    const result = await service.rewind('p1');
    expect(result.filesFailed).toEqual([]);
    expect(await fs.readFile(file, 'utf8')).toBe('v1-content');
  });

  it('concurrent captures of the same file publish one complete backup without temporary leftovers', async () => {
    const file = await primeTracked('original-content');
    await Promise.all([service.trackEdit(file), service.trackEdit(file)]);

    const entry = service.getSnapshots()[0].trackedFileBackups['a.txt']!;
    expect(entry.failed).toBeUndefined();
    expect(await fs.readdir(backupDir)).toEqual([entry.backupFileName]);
    expect(
      await fs.readFile(join(backupDir, entry.backupFileName!), 'utf8'),
    ).toBe('original-content');
  });

  it('publishes the backup with the source file permissions', async () => {
    const file = await primeTracked('original-content');
    await fs.chmod(file, 0o744);
    await service.trackEdit(file);

    const entry = service.getSnapshots()[0].trackedFileBackups['a.txt']!;
    const backupStats = await fs.stat(join(backupDir, entry.backupFileName!));
    expect(backupStats.mode & 0o777).toBe(0o744);
  });

  it('records a null backup when the source vanishes before the copy', async () => {
    const file = await primeTracked('original-content');
    vi.spyOn(fs, 'copyFile').mockImplementationOnce(async () => {
      await fs.rm(file);
      throw Object.assign(new Error('source gone'), { code: 'ENOENT' });
    });
    await service.trackEdit(file);

    const entry = service.getSnapshots()[0].trackedFileBackups['a.txt']!;
    expect(entry.backupFileName).toBeNull();
    expect(entry.failed).toBeUndefined();
    expect(await fs.readdir(backupDir)).toEqual([]);
  });
});

/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileSystemSessionReader } from './file-system-reader.js';

async function makeTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'test-sessions-test-'));
}

describe('FileSystemSessionReader', () => {
  it('lists session files sorted by mtime descending', async () => {
    const dir = await makeTempDir();
    const repo = new FileSystemSessionReader();

    const fileA = path.join(dir, 'a.jsonl');
    const fileB = path.join(dir, 'b.jsonl');
    await fs.writeFile(fileA, '{}');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.writeFile(fileB, '{}');

    const files = await repo.listSessionFiles(dir);

    expect(files).toEqual([fileB, fileA]);
  });

  it('reads session metadata from a transcript file', async () => {
    const dir = await makeTempDir();
    const repo = new FileSystemSessionReader();
    const filePath = path.join(dir, 's1.jsonl');

    await fs.writeFile(
      filePath,
      '{"type":"user","uuid":"u1","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/work","gitBranch":"main","message":{}}\n',
    );

    const meta = await repo.readSessionMetadata(filePath);

    expect(meta.sessionId).toBe('s1');
    expect(meta.sessionPath).toBe(filePath);
    expect(meta.startedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(meta.cwd).toBe('/work');
    expect(meta.gitBranch).toBe('main');
  });

  it('deletes a session file and reports absence', async () => {
    const dir = await makeTempDir();
    const repo = new FileSystemSessionReader();
    const filePath = path.join(dir, 's1.jsonl');

    await fs.writeFile(filePath, '{}');
    expect(await repo.deleteSessionFile(filePath)).toBe(true);
    expect(await repo.deleteSessionFile(filePath)).toBe(false);
  });

  describe('listAllSessionFiles', () => {
    it('filters out buckets and session files', async () => {
      const configHome = await makeTempDir();
      const repo = new FileSystemSessionReader();
      const bucketA = path.join(configHome, 'projects', 'bucket-a');
      const bucketB = path.join(configHome, 'projects', 'bucket-b');
      await fs.mkdir(bucketA, { recursive: true });
      await fs.mkdir(bucketB, { recursive: true });
      await fs.writeFile(path.join(bucketA, 'a1.jsonl'), '{}');
      await fs.writeFile(path.join(bucketA, 'a2.jsonl'), '{}');
      await fs.writeFile(path.join(bucketB, 'b1.jsonl'), '{}');

      const calls: Array<{ sessionId?: string; entryPath: string }> = [];
      const files = await repo.listAllSessionFiles(configHome, (options) => {
        calls.push(options);
        if (options.sessionId === undefined) {
          return options.entryPath !== bucketB;
        }
        return path.basename(options.entryPath, '.jsonl') !== 'a1';
      });

      expect(files.map((file) => path.basename(file)).sort()).toEqual([
        'a2.jsonl',
      ]);
      expect(calls).toContainEqual({ entryPath: bucketA });
      expect(calls).toContainEqual({ entryPath: bucketB });
      expect(calls).toContainEqual({
        sessionId: 'a2',
        entryPath: path.join(bucketA, 'a2.jsonl'),
      });
      expect(calls).toContainEqual({
        sessionId: 'a1',
        entryPath: path.join(bucketA, 'a1.jsonl'),
      });
      expect(calls).not.toContainEqual({
        sessionId: 'b1',
        entryPath: path.join(bucketB, 'b1.jsonl'),
      });
    });

    it('returns all files when no filter is supplied', async () => {
      const configHome = await makeTempDir();
      const repo = new FileSystemSessionReader();
      const bucketA = path.join(configHome, 'projects', 'bucket-a');
      await fs.mkdir(bucketA, { recursive: true });
      await fs.writeFile(path.join(bucketA, 'a1.jsonl'), '{}');

      const files = await repo.listAllSessionFiles(configHome);

      expect(files.map((file) => path.basename(file))).toEqual(['a1.jsonl']);
    });

    it('returns empty array when filter rejects every bucket', async () => {
      const configHome = await makeTempDir();
      const repo = new FileSystemSessionReader();
      const bucketA = path.join(configHome, 'projects', 'bucket-a');
      await fs.mkdir(bucketA, { recursive: true });
      await fs.writeFile(path.join(bucketA, 'a1.jsonl'), '{}');

      const files = await repo.listAllSessionFiles(configHome, () => false);

      expect(files).toEqual([]);
    });

    it('returns empty array when filter rejects every file', async () => {
      const configHome = await makeTempDir();
      const repo = new FileSystemSessionReader();
      const bucketA = path.join(configHome, 'projects', 'bucket-a');
      await fs.mkdir(bucketA, { recursive: true });
      await fs.writeFile(path.join(bucketA, 'a1.jsonl'), '{}');
      await fs.writeFile(path.join(bucketA, 'a2.jsonl'), '{}');

      const bucketCalls: string[] = [];
      const files = await repo.listAllSessionFiles(configHome, (options) => {
        if (options.sessionId === undefined) {
          bucketCalls.push(options.entryPath);
          return true;
        }
        return false;
      });

      expect(files).toEqual([]);
      expect(bucketCalls).toEqual([bucketA]);
    });

    it('filters by sessionId while visiting all buckets', async () => {
      const configHome = await makeTempDir();
      const repo = new FileSystemSessionReader();
      const bucketA = path.join(configHome, 'projects', 'bucket-a');
      const bucketB = path.join(configHome, 'projects', 'bucket-b');
      await fs.mkdir(bucketA, { recursive: true });
      await fs.mkdir(bucketB, { recursive: true });
      await fs.writeFile(path.join(bucketA, 'a1.jsonl'), '{}');
      await fs.writeFile(path.join(bucketB, 'b1.jsonl'), '{}');

      const files = await repo.listAllSessionFiles(
        configHome,
        ({ sessionId }) => sessionId !== 'a1',
      );

      expect(files.map((file) => path.basename(file))).toEqual(['b1.jsonl']);
    });

    it('ignores non-directory entries in the projects directory', async () => {
      const configHome = await makeTempDir();
      const repo = new FileSystemSessionReader();
      const bucketA = path.join(configHome, 'projects', 'bucket-a');
      const strayFile = path.join(configHome, 'projects', 'not-a-dir');
      await fs.mkdir(bucketA, { recursive: true });
      await fs.writeFile(path.join(bucketA, 'a1.jsonl'), '{}');
      await fs.writeFile(strayFile, '{}');

      const calls: string[] = [];
      const files = await repo.listAllSessionFiles(configHome, (options) => {
        if (options.sessionId === undefined) {
          calls.push(options.entryPath);
        }
        return true;
      });

      expect(files.map((file) => path.basename(file))).toEqual(['a1.jsonl']);
      expect(calls).toContainEqual(bucketA);
      expect(calls).toContainEqual(strayFile);
    });

    it('still guards unsafe file stems regardless of filter', async () => {
      const configHome = await makeTempDir();
      const repo = new FileSystemSessionReader();
      const bucketA = path.join(configHome, 'projects', 'bucket-a');
      await fs.mkdir(bucketA, { recursive: true });
      await fs.writeFile(path.join(bucketA, '../etc-passwd.jsonl'), '{}');
      await fs.writeFile(path.join(bucketA, 'safe.jsonl'), '{}');

      const files = await repo.listAllSessionFiles(configHome, () => true);

      expect(files.map((file) => path.basename(file))).toEqual(['safe.jsonl']);
    });
  });
});

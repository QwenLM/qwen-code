/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  getSessionEnvDir,
  getEnvFilePath,
  createEnvFile,
  getSessionEnvScript,
  invalidateSessionEnvCache,
  clearCwdEnvFiles,
  cleanupSessionEnvDir,
  cleanupOldSessionEnvDirs,
  ENV_FILE_EVENTS,
} from './sessionEnvironment.js';
import { HookEventName } from './types.js';

vi.mock('../utils/runLogger.js', () => ({
  runLogger: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

let testDir: string;

vi.mock('../utils/paths.js', () => ({
  getConfigHomeDir: () => testDir,
}));

describe('sessionEnvironment', () => {
  const testSessionId = 'test-session-abc123';

  beforeEach(() => {
    invalidateSessionEnvCache();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-env-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('ENV_FILE_EVENTS', () => {
    it('includes Setup, SessionStart, CwdChanged, FileChanged', () => {
      expect(ENV_FILE_EVENTS.has(HookEventName.Setup)).toBe(true);
      expect(ENV_FILE_EVENTS.has(HookEventName.SessionStart)).toBe(true);
      expect(ENV_FILE_EVENTS.has(HookEventName.CwdChanged)).toBe(true);
      expect(ENV_FILE_EVENTS.has(HookEventName.FileChanged)).toBe(true);
    });

    it('does not include other events', () => {
      expect(ENV_FILE_EVENTS.has(HookEventName.PreToolUse)).toBe(false);
      expect(ENV_FILE_EVENTS.has(HookEventName.PostToolUse)).toBe(false);
      expect(ENV_FILE_EVENTS.has(HookEventName.Stop)).toBe(false);
    });
  });

  describe('getSessionEnvDir', () => {
    it('returns correct path under config home', () => {
      const dir = getSessionEnvDir(testSessionId);
      expect(dir).toBe(
        path.join(testDir, 'session-env', testSessionId),
      );
    });
  });

  describe('getEnvFilePath', () => {
    it('returns correct filename with event name and index', () => {
      const filePath = getEnvFilePath(
        testSessionId,
        HookEventName.SessionStart,
        0,
      );
      expect(filePath).toBe(
        path.join(
          testDir,
          'session-env',
          testSessionId,
          'sessionstart-hook-0.sh',
        ),
      );
    });

    it('uses lowercase event name', () => {
      const filePath = getEnvFilePath(
        testSessionId,
        HookEventName.CwdChanged,
        2,
      );
      expect(path.basename(filePath)).toBe('cwdchanged-hook-2.sh');
    });
  });

  describe('createEnvFile', () => {
    it('creates empty file with correct permissions', () => {
      const filePath = createEnvFile(
        testSessionId,
        HookEventName.SessionStart,
        0,
      );
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('');
      const stats = fs.statSync(filePath);
      expect(stats.mode & 0o777).toBe(0o600);
    });

    it('creates parent directory automatically', () => {
      const dir = getSessionEnvDir(testSessionId);
      expect(fs.existsSync(dir)).toBe(false);

      createEnvFile(testSessionId, HookEventName.Setup, 0);
      expect(fs.existsSync(dir)).toBe(true);
    });

    it('overwrites existing file', () => {
      const filePath = createEnvFile(
        testSessionId,
        HookEventName.SessionStart,
        0,
      );
      fs.writeFileSync(filePath, 'export OLD=value');

      const filePath2 = createEnvFile(
        testSessionId,
        HookEventName.SessionStart,
        0,
      );
      expect(filePath2).toBe(filePath);
      expect(fs.readFileSync(filePath2, 'utf-8')).toBe('');
    });
  });

  describe('getSessionEnvScript', () => {
    it('returns null when directory does not exist', async () => {
      const result = await getSessionEnvScript(testSessionId);
      expect(result).toBeNull();
    });

    it('returns null when directory is empty', async () => {
      const dir = getSessionEnvDir(testSessionId);
      fs.mkdirSync(dir, { recursive: true });

      const result = await getSessionEnvScript(testSessionId);
      expect(result).toBeNull();
    });

    it('returns null when all files are empty', async () => {
      createEnvFile(testSessionId, HookEventName.SessionStart, 0);
      createEnvFile(testSessionId, HookEventName.CwdChanged, 0);

      const result = await getSessionEnvScript(testSessionId);
      expect(result).toBeNull();
    });

    it('returns concatenated content of non-empty files', async () => {
      const f1 = createEnvFile(
        testSessionId,
        HookEventName.SessionStart,
        0,
      );
      fs.writeFileSync(f1, 'export FOO=bar');

      const f2 = createEnvFile(
        testSessionId,
        HookEventName.CwdChanged,
        0,
      );
      fs.writeFileSync(f2, 'export BAZ=qux');

      const result = await getSessionEnvScript(testSessionId);
      expect(result).toBe('export FOO=bar\nexport BAZ=qux\n');
    });

    it('sorts files by event priority', async () => {
      const f1 = createEnvFile(
        testSessionId,
        HookEventName.FileChanged,
        0,
      );
      fs.writeFileSync(f1, 'export FILE=1');

      const f2 = createEnvFile(
        testSessionId,
        HookEventName.Setup,
        0,
      );
      fs.writeFileSync(f2, 'export SETUP=1');

      const f3 = createEnvFile(
        testSessionId,
        HookEventName.SessionStart,
        0,
      );
      fs.writeFileSync(f3, 'export START=1');

      const result = await getSessionEnvScript(testSessionId);
      expect(result).toBe(
        'export SETUP=1\nexport START=1\nexport FILE=1\n',
      );
    });

    it('sorts files by hook index within same event', async () => {
      const f1 = createEnvFile(
        testSessionId,
        HookEventName.SessionStart,
        2,
      );
      fs.writeFileSync(f1, 'export B=2');

      const f2 = createEnvFile(
        testSessionId,
        HookEventName.SessionStart,
        0,
      );
      fs.writeFileSync(f2, 'export A=0');

      const result = await getSessionEnvScript(testSessionId);
      expect(result).toBe('export A=0\nexport B=2\n');
    });

    it('caches result after first read', async () => {
      const f1 = createEnvFile(
        testSessionId,
        HookEventName.SessionStart,
        0,
      );
      fs.writeFileSync(f1, 'export CACHED=yes');

      const result1 = await getSessionEnvScript(testSessionId);
      expect(result1).toBe('export CACHED=yes\n');

      // Modify file on disk — cached value should be returned
      fs.writeFileSync(f1, 'export CACHED=no');
      const result2 = await getSessionEnvScript(testSessionId);
      expect(result2).toBe('export CACHED=yes\n');
    });

    it('re-reads from disk after cache invalidation', async () => {
      const f1 = createEnvFile(
        testSessionId,
        HookEventName.SessionStart,
        0,
      );
      fs.writeFileSync(f1, 'export V=1');

      await getSessionEnvScript(testSessionId);

      fs.writeFileSync(f1, 'export V=2');
      invalidateSessionEnvCache();

      const result = await getSessionEnvScript(testSessionId);
      expect(result).toBe('export V=2\n');
    });

    it('caches null when no files exist', async () => {
      const dir = getSessionEnvDir(testSessionId);
      fs.mkdirSync(dir, { recursive: true });

      const result1 = await getSessionEnvScript(testSessionId);
      expect(result1).toBeNull();

      // Create a file — should still return null (cached)
      const f1 = createEnvFile(
        testSessionId,
        HookEventName.SessionStart,
        0,
      );
      fs.writeFileSync(f1, 'export NEW=1');
      const result2 = await getSessionEnvScript(testSessionId);
      expect(result2).toBeNull();
    });

    it('keeps each session cache entry independent', async () => {
      const otherSessionId = 'test-session-other';
      const f1 = createEnvFile(testSessionId, HookEventName.SessionStart, 0);
      fs.writeFileSync(f1, 'export FROM=first');
      const f2 = createEnvFile(otherSessionId, HookEventName.SessionStart, 0);
      fs.writeFileSync(f2, 'export FROM=second');

      expect(await getSessionEnvScript(testSessionId)).toBe(
        'export FROM=first\n',
      );
      expect(await getSessionEnvScript(otherSessionId)).toBe(
        'export FROM=second\n',
      );
      // 交替调用各自命中自己的条目，不会退回读盘
      expect(await getSessionEnvScript(testSessionId)).toBe(
        'export FROM=first\n',
      );
    });

    it('invalidates only the named session', async () => {
      const otherSessionId = 'test-session-other';
      const f1 = createEnvFile(testSessionId, HookEventName.SessionStart, 0);
      fs.writeFileSync(f1, 'export V=1');
      const f2 = createEnvFile(otherSessionId, HookEventName.SessionStart, 0);
      fs.writeFileSync(f2, 'export V=1');

      await getSessionEnvScript(testSessionId);
      await getSessionEnvScript(otherSessionId);

      fs.writeFileSync(f1, 'export V=2');
      fs.writeFileSync(f2, 'export V=2');
      invalidateSessionEnvCache(testSessionId);

      expect(await getSessionEnvScript(testSessionId)).toBe('export V=2\n');
      // 另一个会话的 hook 没有跑，不该被别人的失效波及
      expect(await getSessionEnvScript(otherSessionId)).toBe('export V=1\n');
    });

    it('skips non-matching files', async () => {
      const dir = getSessionEnvDir(testSessionId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'random-file.txt'), 'export BAD=1');

      const f1 = createEnvFile(
        testSessionId,
        HookEventName.SessionStart,
        0,
      );
      fs.writeFileSync(f1, 'export GOOD=1');

      const result = await getSessionEnvScript(testSessionId);
      expect(result).toBe('export GOOD=1\n');
    });
  });

  describe('clearCwdEnvFiles', () => {
    it('truncates cwdchanged and filechanged files', () => {
      const f1 = createEnvFile(
        testSessionId,
        HookEventName.CwdChanged,
        0,
      );
      fs.writeFileSync(f1, 'export CWD=old');

      const f2 = createEnvFile(
        testSessionId,
        HookEventName.FileChanged,
        0,
      );
      fs.writeFileSync(f2, 'export FILE=old');

      clearCwdEnvFiles(testSessionId);

      expect(fs.readFileSync(f1, 'utf-8')).toBe('');
      expect(fs.readFileSync(f2, 'utf-8')).toBe('');
    });

    it('preserves setup and sessionstart files', () => {
      const fSetup = createEnvFile(
        testSessionId,
        HookEventName.Setup,
        0,
      );
      fs.writeFileSync(fSetup, 'export SETUP=keep');

      const fStart = createEnvFile(
        testSessionId,
        HookEventName.SessionStart,
        0,
      );
      fs.writeFileSync(fStart, 'export START=keep');

      const fCwd = createEnvFile(
        testSessionId,
        HookEventName.CwdChanged,
        0,
      );
      fs.writeFileSync(fCwd, 'export CWD=clear');

      clearCwdEnvFiles(testSessionId);

      expect(fs.readFileSync(fSetup, 'utf-8')).toBe('export SETUP=keep');
      expect(fs.readFileSync(fStart, 'utf-8')).toBe('export START=keep');
      expect(fs.readFileSync(fCwd, 'utf-8')).toBe('');
    });

    it('invalidates cache', async () => {
      const f1 = createEnvFile(
        testSessionId,
        HookEventName.SessionStart,
        0,
      );
      fs.writeFileSync(f1, 'export A=1');

      const f2 = createEnvFile(
        testSessionId,
        HookEventName.CwdChanged,
        0,
      );
      fs.writeFileSync(f2, 'export B=2');

      // Prime cache
      const result1 = await getSessionEnvScript(testSessionId);
      expect(result1).toBe('export A=1\nexport B=2\n');

      // Clear cwd files (also invalidates cache)
      clearCwdEnvFiles(testSessionId);

      // Re-read should show only sessionstart content
      const result2 = await getSessionEnvScript(testSessionId);
      expect(result2).toBe('export A=1\n');
    });

    it('handles missing directory gracefully', () => {
      expect(() => clearCwdEnvFiles('nonexistent-session')).not.toThrow();
    });
  });

  describe('cleanupSessionEnvDir', () => {
    it('removes the session env directory', () => {
      createEnvFile(testSessionId, HookEventName.SessionStart, 0);
      const dir = getSessionEnvDir(testSessionId);
      expect(fs.existsSync(dir)).toBe(true);

      cleanupSessionEnvDir(testSessionId);
      expect(fs.existsSync(dir)).toBe(false);
    });

    it('handles non-existent directory gracefully', () => {
      expect(() =>
        cleanupSessionEnvDir('nonexistent-session'),
      ).not.toThrow();
    });
  });

  describe('cleanupOldSessionEnvDirs', () => {
    it('removes directories older than max age', () => {
      const baseDir = path.join(testDir, 'session-env');
      const oldDir = path.join(baseDir, 'old-session');
      const newDir = path.join(baseDir, 'new-session');

      fs.mkdirSync(oldDir, { recursive: true });
      fs.mkdirSync(newDir, { recursive: true });

      // Set old dir's mtime to 10 days ago
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      fs.utimesSync(oldDir, tenDaysAgo, tenDaysAgo);

      expect(cleanupOldSessionEnvDirs(7 * 24 * 60 * 60 * 1000)).toBe(true);

      expect(fs.existsSync(oldDir)).toBe(false);
      expect(fs.existsSync(newDir)).toBe(true);
    });

    it('handles missing base directory gracefully', () => {
      expect(cleanupOldSessionEnvDirs()).toBe(true);
    });
  });
});

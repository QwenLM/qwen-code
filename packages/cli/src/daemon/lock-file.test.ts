/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import {
  writeLockFile,
  readLockFile,
  removeLockFile,
  isDaemonRunning,
} from './lock-file.js';
import type { DaemonLockInfo } from './types.js';

vi.mock('node:fs');

describe('lock-file', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const sampleLock: DaemonLockInfo = {
    pid: 12345,
    port: 8080,
    authToken: 'test-token',
    cwd: '/test/dir',
    startedAt: '2025-01-01T00:00:00.000Z',
  };

  describe('writeLockFile', () => {
    it('should create directory and write lock file', () => {
      writeLockFile(sampleLock);

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('daemon'),
        { recursive: true },
      );
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('daemon.lock'),
        JSON.stringify(sampleLock, null, 2),
        'utf-8',
      );
    });
  });

  describe('readLockFile', () => {
    it('should read and parse lock file', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(sampleLock));

      const result = readLockFile();
      expect(result).toEqual(sampleLock);
    });

    it('should return null when file does not exist', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const result = readLockFile();
      expect(result).toBeNull();
    });

    it('should return null for invalid JSON', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('not json');

      const result = readLockFile();
      expect(result).toBeNull();
    });
  });

  describe('removeLockFile', () => {
    it('should remove the lock file', () => {
      removeLockFile();
      expect(fs.unlinkSync).toHaveBeenCalled();
    });

    it('should not throw when file does not exist', () => {
      vi.mocked(fs.unlinkSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      expect(() => removeLockFile()).not.toThrow();
    });
  });

  describe('isDaemonRunning', () => {
    it('should return true when process exists', () => {
      vi.spyOn(process, 'kill').mockReturnValue(true);

      expect(isDaemonRunning(sampleLock)).toBe(true);
      expect(process.kill).toHaveBeenCalledWith(12345, 0);
    });

    it('should return false when process does not exist', () => {
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw new Error('ESRCH');
      });

      expect(isDaemonRunning(sampleLock)).toBe(false);
    });
  });
});

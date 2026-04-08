/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ModeSessionManager } from './mode-session.js';
import type { SessionState } from './mode-session.js';

vi.mock('fs/promises');
vi.mock('fs');
vi.mock('os');
vi.mock('path');

const mockFs = vi.mocked(fs);
const mockFsSync = vi.mocked(fsSync);
const mockPath = vi.mocked(path);
const mockOs = vi.mocked(os);

describe('ModeSessionManager', () => {
  const mockTargetDir = '/test/project';
  const mockHomeDir = '/mock/home';

  beforeEach(() => {
    vi.clearAllMocks();
    mockOs.homedir.mockReturnValue(mockHomeDir);
    mockPath.join.mockImplementation((...args: string[]) => args.join('/'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createManager(): ModeSessionManager {
    return new ModeSessionManager(mockTargetDir);
  }

  describe('saveSession', () => {
    it('should create the sessions directory and write the session file', async () => {
      const manager = createManager();
      mockFs.mkdir.mockResolvedValue(undefined as never);
      mockFs.writeFile.mockResolvedValue(undefined as never);

      await manager.saveSession('developer', 'default');

      expect(mockFs.mkdir).toHaveBeenCalledWith(
        expect.stringContaining('sessions'),
        { recursive: true },
      );
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('last-session.json'),
        expect.any(String),
        'utf-8',
      );
    });

    it('should silently fail on write errors', async () => {
      const manager = createManager();
      mockFs.mkdir.mockRejectedValue(new Error('Permission denied'));

      // Should not throw
      await expect(
        manager.saveSession('developer', 'default'),
      ).resolves.toBeUndefined();
    });
  });

  describe('loadLastSession', () => {
    it('should return null when no session file exists', () => {
      const manager = createManager();
      mockFsSync.existsSync.mockReturnValue(false);

      const result = manager.loadLastSession();

      expect(result).toBeNull();
    });

    it('should return parsed session data', () => {
      const manager = createManager();
      const mockSession: SessionState = {
        modeName: 'developer',
        approvalMode: 'default',
        workingDirectory: '/test/project',
        savedAt: new Date('2025-01-01T12:00:00Z'),
      };

      mockFsSync.existsSync.mockReturnValue(true);
      mockFsSync.readFileSync.mockReturnValue(JSON.stringify(mockSession));

      const result = manager.loadLastSession();

      expect(result).not.toBeNull();
      expect(result?.modeName).toBe('developer');
      expect(result?.approvalMode).toBe('default');
    });

    it('should return null on parse errors', () => {
      const manager = createManager();
      mockFsSync.existsSync.mockReturnValue(true);
      mockFsSync.readFileSync.mockReturnValue('invalid json');

      const result = manager.loadLastSession();

      expect(result).toBeNull();
    });
  });

  describe('hasSavedSession', () => {
    it('should return true when session file exists', () => {
      const manager = createManager();
      mockFsSync.existsSync.mockReturnValue(true);

      expect(manager.hasSavedSession()).toBe(true);
    });

    it('should return false when session file does not exist', () => {
      const manager = createManager();
      mockFsSync.existsSync.mockReturnValue(false);

      expect(manager.hasSavedSession()).toBe(false);
    });
  });

  describe('clearSavedSession', () => {
    it('should delete the session file', () => {
      const manager = createManager();
      mockFsSync.existsSync.mockReturnValue(true);
      mockFsSync.unlinkSync.mockReturnValue(undefined as never);

      manager.clearSavedSession();

      expect(mockFsSync.unlinkSync).toHaveBeenCalled();
    });

    it('should do nothing when no session file exists', () => {
      const manager = createManager();
      mockFsSync.existsSync.mockReturnValue(false);

      manager.clearSavedSession();

      expect(mockFsSync.unlinkSync).not.toHaveBeenCalled();
    });
  });

  describe('listSessions', () => {
    it('should return an empty array when no session exists', () => {
      const manager = createManager();
      mockFsSync.existsSync.mockReturnValue(false);

      const result = manager.listSessions();

      expect(result).toEqual([]);
    });

    it('should return the last session as a single-element array', () => {
      const manager = createManager();
      const mockSession: SessionState = {
        modeName: 'architect',
        approvalMode: 'plan',
        workingDirectory: '/test/project',
        savedAt: new Date('2025-01-01T12:00:00Z'),
      };

      mockFsSync.existsSync.mockReturnValue(true);
      mockFsSync.readFileSync.mockReturnValue(JSON.stringify(mockSession));

      const result = manager.listSessions();

      expect(result).toHaveLength(1);
      expect(result[0].modeName).toBe('architect');
    });
  });
});

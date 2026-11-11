/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import * as os from 'node:os';
import {
  deleteSessionArtifactsAsync,
  deleteSubagentTranscriptDirAndArtifactsAsync,
  validateAndSanitizeSessionId,
} from './sessionOperations.js';
import { getSubagentTranscriptDir } from '../services/subagent-transcript.js';
import { runLogger } from './runLogger.js';
import { setConfigHomeDirOverride } from './paths.js';

describe('sessionOperations', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Create a real temporary directory for each test
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ops-test-'));
    setConfigHomeDirOverride(tempDir);
    vi.stubEnv('HOME', tempDir);
    projectRoot = '/workspace/demo';
    vi.spyOn(runLogger, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    setConfigHomeDirOverride(undefined);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    // Clean up the temporary directory
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe('validateAndSanitizeSessionId', () => {
    it('should throw for empty or dangerous IDs', () => {
      expect(() => validateAndSanitizeSessionId('')).toThrow(
        'Invalid sessionId',
      );
      expect(() => validateAndSanitizeSessionId('.')).toThrow(
        'Invalid sessionId',
      );
      expect(() => validateAndSanitizeSessionId('..')).toThrow(
        'Invalid sessionId',
      );
    });

    it('should sanitize valid IDs', () => {
      expect(validateAndSanitizeSessionId('abc/def')).toBe('abc_def');
      expect(validateAndSanitizeSessionId('valid-id')).toBe('valid-id');
    });
  });

  describe('deleteSessionArtifactsAsync', () => {
    it('should delete logs and tool outputs', async () => {
      const sessionId = 'test-session';
      const logsDir = path.join(tempDir, 'logs');
      const toolOutputsDir = path.join(
        tempDir,
        'tool-outputs',
        `session-${sessionId}`,
      );
      const sessionDir = path.join(tempDir, sessionId);

      await fs.mkdir(logsDir, { recursive: true });
      await fs.mkdir(toolOutputsDir, { recursive: true });
      await fs.mkdir(sessionDir, { recursive: true });

      const logFile = path.join(logsDir, `session-${sessionId}.jsonl`);
      await fs.writeFile(logFile, '{}');

      // Verify files exist before call
      expect(await fs.stat(logFile)).toBeTruthy();
      expect(await fs.stat(toolOutputsDir)).toBeTruthy();
      expect(await fs.stat(sessionDir)).toBeTruthy();

      const result = await deleteSessionArtifactsAsync(sessionId, tempDir);

      // Verify files are deleted
      expect(result).toEqual({ failed: 0 });
      await expect(fs.stat(logFile)).rejects.toThrow();
      await expect(fs.stat(toolOutputsDir)).rejects.toThrow();
      await expect(fs.stat(sessionDir)).rejects.toThrow();
    });

    it('should ignore ENOENT errors during deletion', async () => {
      // Don't create any files. Calling delete on non-existent files should not throw.
      await expect(
        deleteSessionArtifactsAsync('non-existent', tempDir),
      ).resolves.toEqual({ failed: 0 });
    });

    it('should report a failed artifact deletion', async () => {
      const sessionId = 'blocked-session';
      const logPath = path.join(
        tempDir,
        'logs',
        `session-${sessionId}.jsonl`,
      );
      await fs.mkdir(logPath, { recursive: true });

      const result = await deleteSessionArtifactsAsync(sessionId, tempDir);

      expect(result).toEqual({ failed: 1 });
      await expect(fs.stat(logPath)).resolves.toBeDefined();
    });
  });

  describe('deleteSubagentTranscriptDirAndArtifactsAsync', () => {
    it('should iterate subagent files and delete their artifacts', async () => {
      const parentSessionId = 'parent-123';
      const subDir = getSubagentTranscriptDir(projectRoot, parentSessionId);
      await fs.mkdir(subDir, { recursive: true });

      await fs.writeFile(path.join(subDir, 'agent-sub1.jsonl'), '{}');
      await fs.writeFile(path.join(subDir, 'agent-sub2.jsonl'), '{}');

      const logsDir = path.join(tempDir, 'logs');
      await fs.mkdir(logsDir, { recursive: true });
      await fs.writeFile(path.join(logsDir, 'session-sub1.jsonl'), '{}');
      await fs.writeFile(path.join(logsDir, 'session-sub2.jsonl'), '{}');

      const result = await deleteSubagentTranscriptDirAndArtifactsAsync(
        projectRoot,
        parentSessionId,
        tempDir,
      );

      // Verify subagent directory is deleted
      expect(result).toEqual({ failed: 0 });
      await expect(fs.stat(subDir)).rejects.toThrow();

      // Verify artifacts are deleted
      await expect(
        fs.stat(path.join(logsDir, 'session-sub1.jsonl')),
      ).rejects.toThrow();
      await expect(
        fs.stat(path.join(logsDir, 'session-sub2.jsonl')),
      ).rejects.toThrow();
    });

    it('should resolve for safe path even if input contains traversals (due to sanitization)', async () => {
      // Should sanitize '../unsafe' to '.._unsafe' and resolve (directory won't exist, so readdir returns [] naturally)
      await expect(
        deleteSubagentTranscriptDirAndArtifactsAsync(
          projectRoot,
          '../unsafe',
          tempDir,
        ),
      ).resolves.toEqual({ failed: 0 });
    });

    it('should handle ENOENT for readdir gracefully', async () => {
      // Non-existent directory should not throw
      await expect(
        deleteSubagentTranscriptDirAndArtifactsAsync(
          projectRoot,
          'non-existent-parent',
          tempDir,
        ),
      ).resolves.toEqual({ failed: 0 });
    });

    it('should preserve subagent transcripts when artifact cleanup fails', async () => {
      const parentSessionId = 'parent-with-failure';
      const subDir = getSubagentTranscriptDir(projectRoot, parentSessionId);
      await fs.mkdir(subDir, { recursive: true });
      await fs.writeFile(path.join(subDir, 'agent-blocked.jsonl'), '{}');

      const blockedLogPath = path.join(
        tempDir,
        'logs',
        'session-blocked.jsonl',
      );
      await fs.mkdir(blockedLogPath, { recursive: true });

      const result = await deleteSubagentTranscriptDirAndArtifactsAsync(
        projectRoot,
        parentSessionId,
        tempDir,
      );

      expect(result).toEqual({ failed: 1 });
      await expect(fs.stat(subDir)).resolves.toBeDefined();
    });
  });
});

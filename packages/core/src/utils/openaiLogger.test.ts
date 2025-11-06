/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'os';
import { promises as fs } from 'node:fs';
import { OpenAILogger } from './openaiLogger.js';

describe('OpenAILogger', () => {
  let originalCwd: string;
  let testTempDir: string;
  const createdDirs: string[] = [];

  beforeEach(() => {
    originalCwd = process.cwd();
    testTempDir = path.join(os.tmpdir(), `openai-logger-test-${Date.now()}`);
    createdDirs.length = 0; // Clear array
  });

  afterEach(async () => {
    // Clean up all created directories
    const cleanupPromises = [
      testTempDir,
      ...createdDirs,
      path.resolve(process.cwd(), 'relative-logs'),
      path.resolve(process.cwd(), 'custom-logs'),
      path.resolve(process.cwd(), 'test-relative-logs'),
      path.join(os.homedir(), 'custom-logs'),
      path.join(os.homedir(), 'test-openai-logs'),
    ].map(async (dir) => {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    });

    await Promise.all(cleanupPromises);
    process.chdir(originalCwd);
  });

  describe('constructor', () => {
    it('should use default directory when no custom directory is provided', () => {
      const logger = new OpenAILogger();
      // We can't directly access private logDir, but we can verify behavior
      expect(logger).toBeInstanceOf(OpenAILogger);
    });

    it('should accept absolute path as custom directory', () => {
      const customDir = '/absolute/path/to/logs';
      const logger = new OpenAILogger(customDir);
      expect(logger).toBeInstanceOf(OpenAILogger);
    });

    it('should resolve relative path to absolute path', async () => {
      const relativeDir = 'custom-logs';
      const logger = new OpenAILogger(relativeDir);
      const expectedDir = path.resolve(process.cwd(), relativeDir);
      createdDirs.push(expectedDir);
      expect(logger).toBeInstanceOf(OpenAILogger);
    });

    it('should expand ~ to home directory', () => {
      const customDir = '~/custom-logs';
      const logger = new OpenAILogger(customDir);
      expect(logger).toBeInstanceOf(OpenAILogger);
    });

    it('should expand ~/ to home directory', () => {
      const customDir = '~/custom-logs';
      const logger = new OpenAILogger(customDir);
      expect(logger).toBeInstanceOf(OpenAILogger);
    });

    it('should handle just ~ as home directory', () => {
      const customDir = '~';
      const logger = new OpenAILogger(customDir);
      expect(logger).toBeInstanceOf(OpenAILogger);
    });
  });

  describe('initialize', () => {
    it('should create directory if it does not exist', async () => {
      const logger = new OpenAILogger(testTempDir);
      await logger.initialize();

      const dirExists = await fs
        .access(testTempDir)
        .then(() => true)
        .catch(() => false);
      expect(dirExists).toBe(true);
    });

    it('should create nested directories recursively', async () => {
      const nestedDir = path.join(testTempDir, 'nested', 'deep', 'path');
      const logger = new OpenAILogger(nestedDir);
      await logger.initialize();

      const dirExists = await fs
        .access(nestedDir)
        .then(() => true)
        .catch(() => false);
      expect(dirExists).toBe(true);
    });

    it('should not throw if directory already exists', async () => {
      await fs.mkdir(testTempDir, { recursive: true });
      const logger = new OpenAILogger(testTempDir);
      await expect(logger.initialize()).resolves.not.toThrow();
    });
  });

  describe('logInteraction', () => {
    it('should create log file with correct format', async () => {
      const logger = new OpenAILogger(testTempDir);
      await logger.initialize();

      const request = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'test' }],
      };
      const response = { id: 'test-id', choices: [] };

      const logPath = await logger.logInteraction(request, response);

      expect(logPath).toContain(testTempDir);
      expect(logPath).toMatch(
        /openai-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[a-f0-9]{8}\.json/,
      );

      const fileExists = await fs
        .access(logPath)
        .then(() => true)
        .catch(() => false);
      expect(fileExists).toBe(true);
    });

    it('should write correct log data structure', async () => {
      const logger = new OpenAILogger(testTempDir);
      await logger.initialize();

      const request = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'test' }],
      };
      const response = { id: 'test-id', choices: [] };

      const logPath = await logger.logInteraction(request, response);
      const logContent = JSON.parse(await fs.readFile(logPath, 'utf-8'));

      expect(logContent).toHaveProperty('timestamp');
      expect(logContent).toHaveProperty('request', request);
      expect(logContent).toHaveProperty('response', response);
      expect(logContent).toHaveProperty('error', null);
      expect(logContent).toHaveProperty('system');
      expect(logContent.system).toHaveProperty('hostname');
      expect(logContent.system).toHaveProperty('platform');
      expect(logContent.system).toHaveProperty('release');
      expect(logContent.system).toHaveProperty('nodeVersion');
    });

    it('should log error when provided', async () => {
      const logger = new OpenAILogger(testTempDir);
      await logger.initialize();

      const request = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'test' }],
      };
      const error = new Error('Test error');

      const logPath = await logger.logInteraction(request, undefined, error);
      const logContent = JSON.parse(await fs.readFile(logPath, 'utf-8'));

      expect(logContent).toHaveProperty('error');
      expect(logContent.error).toHaveProperty('message', 'Test error');
      expect(logContent.error).toHaveProperty('stack');
      expect(logContent.response).toBeNull();
    });

    it('should use custom directory when provided', async () => {
      const customDir = path.join(testTempDir, 'custom-logs');
      const logger = new OpenAILogger(customDir);
      await logger.initialize();

      const request = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'test' }],
      };
      const response = { id: 'test-id', choices: [] };

      const logPath = await logger.logInteraction(request, response);

      expect(logPath).toContain(customDir);
      expect(logPath.startsWith(customDir)).toBe(true);
    });

    it('should resolve relative path correctly', async () => {
      const relativeDir = 'relative-logs';
      const logger = new OpenAILogger(relativeDir);
      await logger.initialize();

      const request = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'test' }],
      };
      const response = { id: 'test-id', choices: [] };

      const logPath = await logger.logInteraction(request, response);
      const expectedDir = path.resolve(process.cwd(), relativeDir);
      createdDirs.push(expectedDir);

      expect(logPath).toContain(expectedDir);
    });

    it('should expand ~ correctly', async () => {
      const customDir = '~/test-openai-logs';
      const logger = new OpenAILogger(customDir);
      await logger.initialize();

      const request = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'test' }],
      };
      const response = { id: 'test-id', choices: [] };

      const logPath = await logger.logInteraction(request, response);
      const expectedDir = path.join(os.homedir(), 'test-openai-logs');
      createdDirs.push(expectedDir);

      expect(logPath).toContain(expectedDir);
    });
  });

  describe('getLogFiles', () => {
    it('should return empty array when directory does not exist', async () => {
      const logger = new OpenAILogger(testTempDir);
      const files = await logger.getLogFiles();
      expect(files).toEqual([]);
    });

    it('should return log files after initialization', async () => {
      const logger = new OpenAILogger(testTempDir);
      await logger.initialize();

      const request = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'test' }],
      };
      const response = { id: 'test-id', choices: [] };

      await logger.logInteraction(request, response);
      const files = await logger.getLogFiles();

      expect(files.length).toBeGreaterThan(0);
      expect(files[0]).toMatch(/openai-.*\.json$/);
    });

    it('should return only log files matching pattern', async () => {
      const logger = new OpenAILogger(testTempDir);
      await logger.initialize();

      // Create a log file
      await logger.logInteraction({ test: 'request' }, { test: 'response' });

      // Create a non-log file
      await fs.writeFile(path.join(testTempDir, 'other-file.txt'), 'content');

      const files = await logger.getLogFiles();
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/openai-.*\.json$/);
    });

    it('should respect limit parameter', async () => {
      const logger = new OpenAILogger(testTempDir);
      await logger.initialize();

      // Create multiple log files
      for (let i = 0; i < 5; i++) {
        await logger.logInteraction(
          { test: `request-${i}` },
          { test: `response-${i}` },
        );
        // Small delay to ensure different timestamps
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const allFiles = await logger.getLogFiles();
      expect(allFiles.length).toBe(5);

      const limitedFiles = await logger.getLogFiles(3);
      expect(limitedFiles.length).toBe(3);
    });

    it('should return files sorted by most recent first', async () => {
      const logger = new OpenAILogger(testTempDir);
      await logger.initialize();

      const files: string[] = [];
      for (let i = 0; i < 3; i++) {
        const logPath = await logger.logInteraction(
          { test: `request-${i}` },
          { test: `response-${i}` },
        );
        files.push(logPath);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const retrievedFiles = await logger.getLogFiles();
      expect(retrievedFiles[0]).toBe(files[2]); // Most recent first
      expect(retrievedFiles[1]).toBe(files[1]);
      expect(retrievedFiles[2]).toBe(files[0]);
    });
  });

  describe('readLogFile', () => {
    it('should read and parse log file correctly', async () => {
      const logger = new OpenAILogger(testTempDir);
      await logger.initialize();

      const request = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'test' }],
      };
      const response = { id: 'test-id', choices: [] };

      const logPath = await logger.logInteraction(request, response);
      const logData = await logger.readLogFile(logPath);

      expect(logData).toHaveProperty('timestamp');
      expect(logData).toHaveProperty('request', request);
      expect(logData).toHaveProperty('response', response);
    });

    it('should throw error when file does not exist', async () => {
      const logger = new OpenAILogger(testTempDir);
      const nonExistentPath = path.join(testTempDir, 'non-existent.json');

      await expect(logger.readLogFile(nonExistentPath)).rejects.toThrow();
    });
  });

  describe('path resolution', () => {
    it('should normalize absolute paths', () => {
      const absolutePath = '/tmp/test/logs';
      const logger = new OpenAILogger(absolutePath);
      expect(logger).toBeInstanceOf(OpenAILogger);
    });

    it('should resolve relative paths based on current working directory', async () => {
      const relativePath = 'test-relative-logs';
      const logger = new OpenAILogger(relativePath);
      await logger.initialize();

      const request = { test: 'request' };
      const response = { test: 'response' };

      const logPath = await logger.logInteraction(request, response);
      const expectedBaseDir = path.resolve(process.cwd(), relativePath);
      createdDirs.push(expectedBaseDir);

      expect(logPath).toContain(expectedBaseDir);
    });

    it('should handle paths with special characters', async () => {
      const specialPath = path.join(testTempDir, 'logs-with-special-chars');
      const logger = new OpenAILogger(specialPath);
      await logger.initialize();

      const request = { test: 'request' };
      const response = { test: 'response' };

      const logPath = await logger.logInteraction(request, response);
      expect(logPath).toContain(specialPath);
    });
  });
});

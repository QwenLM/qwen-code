/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'os';
import { promises as fs } from 'node:fs';
import { OpenAILogger, resolveOpenAILogDir } from './openaiLogger.js';

const chatRequest = (model = 'gpt-4') => ({
  model,
  messages: [{ role: 'user', content: 'test' }],
});
const chatResponse = () => ({ id: 'test-id', choices: [] });
// Log file name: timestamp, 8-hex id, then the optional prompt-id suffix.
const logName = (suffix = '') =>
  new RegExp(
    String.raw`openai-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[a-f0-9]{8}${suffix}\.json`,
  );
const exists = (p: string) =>
  fs
    .access(p)
    .then(() => true)
    .catch(() => false);
const readLog = async (logPath: string) =>
  JSON.parse(await fs.readFile(logPath, 'utf-8'));

async function initLogger(dir?: string, cwd?: string) {
  const logger = new OpenAILogger(dir, cwd);
  await logger.initialize();
  return logger;
}

// Logs one interaction through a freshly initialized logger (chat request
// and response unless given).
async function logOnce(opts: {
  dir?: string;
  cwd?: string;
  request?: object;
  response?: object;
  promptId?: string;
}) {
  const logger = await initLogger(opts.dir, opts.cwd);
  const { request = chatRequest(), response = chatResponse() } = opts;
  return logger.logInteraction(request, response, undefined, opts.promptId);
}

const logTestPair = (dir: string | undefined, cwd?: string) =>
  logOnce({
    dir,
    cwd,
    request: { test: 'request' },
    response: { test: 'response' },
  });

// Logs `n` interactions 10ms apart so each file gets a distinct timestamp.
async function logSeries(logger: OpenAILogger, n: number) {
  const files: string[] = [];
  for (let i = 0; i < n; i++) {
    files.push(
      await logger.logInteraction(
        { test: `request-${i}` },
        { test: `response-${i}` },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return files;
}

describe('OpenAILogger', () => {
  let originalCwd: string;
  let originalHome: string | undefined;
  let testTempDir: string;
  const createdDirs: string[] = [];
  const testHomeDir = path.join(os.tmpdir(), 'openai-logger-home');

  beforeEach(() => {
    originalCwd = process.cwd();
    originalHome = process.env['HOME'];
    process.env['HOME'] = testHomeDir;
    testTempDir = path.join(os.tmpdir(), `openai-logger-test-${Date.now()}`);
    createdDirs.length = 0;
  });

  afterEach(async () => {
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
    if (originalHome === undefined) {
      delete process.env['HOME'];
    } else {
      process.env['HOME'] = originalHome;
    }
  });

  describe('constructor', () => {
    // The private logDir is not observable here; these only check construction.
    // ('should expand ~ to home directory' duplicated the '~/' row exactly.)
    it.each([
      [
        'should use default directory when no custom directory is provided',
        undefined,
      ],
      [
        'should accept absolute path as custom directory',
        '/absolute/path/to/logs',
      ],
      ['should resolve relative path to absolute path', 'custom-logs'],
      ['should expand ~/ to home directory', '~/custom-logs'],
      ['should handle just ~ as home directory', '~'],
    ])('%s', (_title, dir) => {
      expect(new OpenAILogger(dir)).toBeInstanceOf(OpenAILogger);
    });

    it('should resolve OpenAI log directories without constructing a logger', () => {
      const customCwd = path.join(testTempDir, 'project-root');

      expect(resolveOpenAILogDir(undefined, customCwd)).toBe(
        path.join(customCwd, 'logs', 'openai'),
      );
      expect(resolveOpenAILogDir('relative-logs', customCwd)).toBe(
        path.resolve(customCwd, 'relative-logs'),
      );
      expect(resolveOpenAILogDir('~/custom-logs', customCwd)).toBe(
        path.join(os.homedir(), 'custom-logs'),
      );
    });
  });

  describe('initialize', () => {
    it('should create directory if it does not exist', async () => {
      await initLogger(testTempDir);
      expect(await exists(testTempDir)).toBe(true);
    });

    it('should create nested directories recursively', async () => {
      const nestedDir = path.join(testTempDir, 'nested', 'deep', 'path');
      await initLogger(nestedDir);
      expect(await exists(nestedDir)).toBe(true);
    });

    it('should not throw if directory already exists', async () => {
      await fs.mkdir(testTempDir, { recursive: true });
      const logger = new OpenAILogger(testTempDir);
      await expect(logger.initialize()).resolves.not.toThrow();
    });
  });

  describe('logInteraction', () => {
    it('should create log file with correct format', async () => {
      const logPath = await logOnce({ dir: testTempDir });

      expect(logPath).toContain(testTempDir);
      expect(logPath).toMatch(logName());
      expect(await exists(logPath)).toBe(true);
    });

    it('should include sanitized internal prompt id suffix when provided', async () => {
      const logPath = await logOnce({
        dir: testTempDir,
        promptId: 'side-query:session-title',
      });

      expect(path.basename(logPath)).toMatch(
        logName('-side-query-session-title'),
      );
      expect(await readLog(logPath)).not.toHaveProperty('metadata');
    });

    it('should not include a filename suffix for non-internal prompt ids', async () => {
      const logPath = await logOnce({
        dir: testTempDir,
        promptId: 'user_query',
      });
      expect(path.basename(logPath)).toMatch(logName());
    });

    it('should include a subagent suffix without the session id', async () => {
      const logPath = await logOnce({
        dir: testTempDir,
        request: chatRequest('claude-opus-4-7'),
        promptId: 'e097d32b-82d6-422a-afa6-f6184565a8ab#Explore-g2tss0#7',
      });

      const basename = path.basename(logPath);
      expect(basename).toMatch(logName('-subagent-Explore-g2tss0'));
      expect(basename).not.toContain('e097d32b');
    });

    it('should not include a suffix for main-session prompt ids', async () => {
      const logPath = await logOnce({
        dir: testTempDir,
        request: chatRequest('claude-opus-4-7'),
        promptId: 'e097d32b-82d6-422a-afa6-f6184565a8ab########0',
      });

      expect(path.basename(logPath)).toMatch(logName());
      expect((await readLog(logPath)).context).toEqual({
        promptId: 'e097d32b-82d6-422a-afa6-f6184565a8ab########0',
        sessionId: 'e097d32b-82d6-422a-afa6-f6184565a8ab',
      });
    });

    it.each([
      ['should derive session id from bare UUID prompt ids', ''],
      [
        'should derive session id from subagent prompt ids with extra separators',
        '#Explore#nested#7',
      ],
    ])('%s', async (_title, promptSuffix) => {
      const sessionId = 'e097d32b-82d6-422a-afa6-f6184565a8ab';
      const promptId = `${sessionId}${promptSuffix}`;
      const logPath = await logOnce({
        dir: testTempDir,
        request: { model: 'claude-opus-4-7' },
        promptId,
      });

      expect((await readLog(logPath)).context).toEqual({ promptId, sessionId });
    });

    it('should write correct log data structure', async () => {
      const request = chatRequest();
      const response = chatResponse();
      const logContent = await readLog(
        await logOnce({ dir: testTempDir, request, response }),
      );

      expect(logContent).toHaveProperty('timestamp');
      expect(logContent).toHaveProperty('request', request);
      expect(logContent).toHaveProperty('response', response);
      expect(logContent).toHaveProperty('error', null);
      expect(logContent).toHaveProperty('context', null);
      expect(logContent).toHaveProperty('system');
      expect(logContent.system).toHaveProperty('hostname');
      expect(logContent.system).toHaveProperty('platform');
      expect(logContent.system).toHaveProperty('release');
      expect(logContent.system).toHaveProperty('nodeVersion');
    });

    const logError = async (request: object, error: Error) =>
      readLog(
        await (
          await initLogger(testTempDir)
        ).logInteraction(request, undefined, error),
      );

    it('should log error when provided', async () => {
      const logContent = await logError(chatRequest(), new Error('Test error'));

      expect(logContent).toHaveProperty('error');
      expect(logContent.error).toHaveProperty('message', 'Test error');
      expect(logContent.error).toHaveProperty('stack');
      expect(logContent.response).toBeNull();
    });

    it('should log request id from OpenAI API errors', async () => {
      const error = Object.assign(new Error('Server error'), {
        requestID: 'req-server-123',
      });
      const logContent = await logError({ model: 'gpt-4' }, error);

      expect(logContent.error).toMatchObject({
        message: 'Server error',
        requestId: 'req-server-123',
      });
    });

    it('should log request id from provider error payloads', async () => {
      const error = new Error(
        'event:error\n:HTTP_STATUS/429\ndata:{"request_id":"req-provider-456","code":"Throttling.AllocationQuota","message":"Allocated quota exceeded"}',
      );
      const logContent = await logError({ model: 'qwen-plus' }, error);

      expect(logContent.error.requestId).toBe('req-provider-456');
    });

    it('should use custom directory when provided', async () => {
      const customDir = path.join(testTempDir, 'custom-logs');
      const logPath = await logOnce({ dir: customDir });

      expect(logPath).toContain(customDir);
      expect(logPath.startsWith(customDir)).toBe(true);
    });

    it('should resolve relative path correctly', async () => {
      const logPath = await logOnce({ dir: 'relative-logs' });
      const expectedDir = path.resolve(process.cwd(), 'relative-logs');
      createdDirs.push(expectedDir);

      expect(logPath).toContain(expectedDir);
    });

    it('should expand ~ correctly', async () => {
      const logPath = await logOnce({ dir: '~/test-openai-logs' });
      const expectedDir = path.join(os.homedir(), 'test-openai-logs');
      createdDirs.push(expectedDir);

      expect(logPath).toContain(expectedDir);
    });
  });

  describe('getLogFiles', () => {
    it('should return empty array when directory does not exist', async () => {
      const logger = new OpenAILogger(testTempDir);
      expect(await logger.getLogFiles()).toEqual([]);
    });

    it('should return log files after initialization', async () => {
      const logger = await initLogger(testTempDir);
      await logger.logInteraction(chatRequest(), chatResponse());
      const files = await logger.getLogFiles();

      expect(files.length).toBeGreaterThan(0);
      expect(files[0]).toMatch(/openai-.*\.json$/);
    });

    it('should return only log files matching pattern', async () => {
      const logger = await initLogger(testTempDir);
      await logger.logInteraction({ test: 'request' }, { test: 'response' });
      await fs.writeFile(path.join(testTempDir, 'other-file.txt'), 'content');

      const files = await logger.getLogFiles();
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/openai-.*\.json$/);
    });

    it('should respect limit parameter', async () => {
      const logger = await initLogger(testTempDir);
      await logSeries(logger, 5);

      expect((await logger.getLogFiles()).length).toBe(5);
      expect((await logger.getLogFiles(3)).length).toBe(3);
    });

    it('should respect a zero limit', async () => {
      const logger = await initLogger(testTempDir);
      await logger.logInteraction({ test: 'request' }, { test: 'response' });

      expect(await logger.getLogFiles(0)).toEqual([]);
    });

    it('should return files sorted by most recent first', async () => {
      const logger = await initLogger(testTempDir);
      const files = await logSeries(logger, 3);

      const retrievedFiles = await logger.getLogFiles();
      expect(retrievedFiles[0]).toBe(files[2]); // Most recent first
      expect(retrievedFiles[1]).toBe(files[1]);
      expect(retrievedFiles[2]).toBe(files[0]);
    });
  });

  describe('readLogFile', () => {
    it('should read and parse log file correctly', async () => {
      const logger = await initLogger(testTempDir);
      const request = chatRequest();
      const response = chatResponse();
      const logData = await logger.readLogFile(
        await logger.logInteraction(request, response),
      );

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
      expect(new OpenAILogger('/tmp/test/logs')).toBeInstanceOf(OpenAILogger);
    });

    it('should handle paths with special characters', async () => {
      const specialPath = path.join(testTempDir, 'logs-with-special-chars');
      expect(await logTestPair(specialPath)).toContain(specialPath);
    });
  });

  describe('cwd parameter', () => {
    it('should use provided cwd for default log directory instead of process.cwd()', async () => {
      const customCwd = path.join(testTempDir, 'project-root');
      await fs.mkdir(customCwd, { recursive: true });
      const logPath = await logTestPair(undefined, customCwd);
      const expectedDir = path.join(customCwd, 'logs', 'openai');
      createdDirs.push(expectedDir);

      expect(logPath).toContain(expectedDir);
    });

    it('should resolve relative customLogDir against provided cwd', async () => {
      const customCwd = path.join(testTempDir, 'project-root-2');
      await fs.mkdir(customCwd, { recursive: true });
      const logPath = await logTestPair('my-logs', customCwd);
      const expectedDir = path.resolve(customCwd, 'my-logs');
      createdDirs.push(expectedDir);

      expect(logPath).toContain(expectedDir);
    });

    it('should not use cwd when customLogDir is an absolute path', async () => {
      const customCwd = path.join(testTempDir, 'project-root-3');
      const absoluteLogDir = path.join(testTempDir, 'absolute-logs');
      const logPath = await logTestPair(absoluteLogDir, customCwd);
      createdDirs.push(absoluteLogDir);

      expect(logPath).toContain(absoluteLogDir);
      expect(logPath).not.toContain(customCwd);
    });

    it('should not use cwd when customLogDir starts with ~', async () => {
      const customCwd = path.join(testTempDir, 'project-root-4');
      const logPath = await logTestPair('~/test-openai-logs', customCwd);
      const expectedDir = path.join(os.homedir(), 'test-openai-logs');
      createdDirs.push(expectedDir);

      expect(logPath).toContain(expectedDir);
      expect(logPath).not.toContain(customCwd);
    });

    // Also covers the former 'path resolution > should resolve relative paths
    // based on current working directory' (an exact duplicate).
    it('should fall back to process.cwd() when cwd is not provided', async () => {
      const logPath = await logTestPair('test-relative-logs');
      const expectedDir = path.resolve(process.cwd(), 'test-relative-logs');
      createdDirs.push(expectedDir);

      expect(logPath).toContain(expectedDir);
    });
  });
});

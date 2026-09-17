/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  afterAll,
} from 'vitest';
import type { LogEntry } from './logger.js';
import {
  Logger,
  MessageSenderType,
  encodeTagName,
  decodeTagName,
} from './logger.js';
import { Storage } from '../config/storage.js';
import { getProjectHash } from '../utils/paths.js';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import type { Content } from '@google/genai';

import os from 'node:os';

const GEMINI_DIR_NAME = '.qwen';
const TMP_DIR_NAME = 'tmp';
const LOG_FILE_NAME = 'logs.json';
const CHECKPOINT_FILE_NAME = 'checkpoint.json';

const projectDir = process.cwd();
const hash = getProjectHash(projectDir);
const TEST_HOME_DIR = path.join(os.tmpdir(), 'qwen-core-logger-home');

let originalHome: string | undefined;
let originalRuntimeDir: string | undefined;
let testGeminiDir: string;
let testLogFilePath: string;
let testCheckpointFilePath: string;

const setTestPaths = () => {
  testGeminiDir = path.join(os.homedir(), GEMINI_DIR_NAME, TMP_DIR_NAME, hash);
  testLogFilePath = path.join(testGeminiDir, LOG_FILE_NAME);
  testCheckpointFilePath = path.join(testGeminiDir, CHECKPOINT_FILE_NAME);
};

async function cleanupLogAndCheckpointFiles() {
  try {
    if (!testGeminiDir) return;
    await fs.rm(testGeminiDir, { recursive: true, force: true });
  } catch (_error) {
    // Ignore errors, as the directory may not exist, which is fine.
  }
}

async function readLogFile(): Promise<LogEntry[]> {
  try {
    const content = await fs.readFile(testLogFilePath, 'utf-8');
    return JSON.parse(content) as LogEntry[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

vi.mock('../utils/session.js', () => ({
  sessionId: 'test-session-id',
}));

// Re-export the real atomicWriteFile so tests can override individual
// calls (e.g. .mockRejectedValueOnce) while preserving normal behavior.
// The default implementation is re-attached in `beforeEach` because the
// suite calls `vi.resetAllMocks()` which strips vi.fn(impl) back to no-op.
vi.mock('../utils/atomicFileWrite.js', async () => {
  const actual = await vi.importActual<
    typeof import('../utils/atomicFileWrite.js')
  >('../utils/atomicFileWrite.js');
  return {
    ...actual,
    atomicWriteFile: vi.fn(actual.atomicWriteFile),
  };
});

const realAtomicWriteFile = (
  await vi.importActual<typeof import('../utils/atomicFileWrite.js')>(
    '../utils/atomicFileWrite.js',
  )
).atomicWriteFile;

vi.mock('../utils/debugLogger.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../utils/debugLogger.js')>();
  return {
    ...original,
    createDebugLogger: () => ({
      debug: (...args: unknown[]) => console.debug(...args),
      info: (...args: unknown[]) => console.info(...args),
      warn: (...args: unknown[]) => console.warn(...args),
      error: (...args: unknown[]) => console.error(...args),
    }),
  };
});

describe('Logger', () => {
  let logger: Logger;
  const testSessionId = 'test-session-id';

  beforeEach(async () => {
    vi.resetAllMocks();
    // resetAllMocks blanks the vi.fn(actual) delegation — re-attach so the
    // logger's initialize/append paths still hit the real disk.
    vi.mocked(atomicWriteFile).mockImplementation(realAtomicWriteFile);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T12:00:00.000Z'));
    originalHome = process.env['HOME'];
    process.env['HOME'] = TEST_HOME_DIR;
    // Self-hosted CI runners export QWEN_RUNTIME_DIR for their own qwen
    // tooling; it outranks HOME-derived paths in Storage, so these
    // path-expectation tests must run with it cleared.
    originalRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
    delete process.env['QWEN_RUNTIME_DIR'];
    setTestPaths();
    // Clean up before the test
    await cleanupLogAndCheckpointFiles();
    // Ensure the directory exists for the test
    await fs.mkdir(testGeminiDir, { recursive: true });
    logger = new Logger(testSessionId, new Storage(process.cwd()));
    await logger.initialize();
  });

  afterEach(async () => {
    if (logger) {
      logger.close();
    }
    // Clean up after the test
    await cleanupLogAndCheckpointFiles();
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalHome === undefined) {
      delete process.env['HOME'];
    } else {
      process.env['HOME'] = originalHome;
    }
    if (originalRuntimeDir === undefined) {
      delete process.env['QWEN_RUNTIME_DIR'];
    } else {
      process.env['QWEN_RUNTIME_DIR'] = originalRuntimeDir;
    }
  });

  afterAll(async () => {
    // Final cleanup
    await cleanupLogAndCheckpointFiles();
  });

  describe('initialize', () => {
    it('should create .gemini directory and an empty log file if none exist', async () => {
      const dirExists = await fs
        .access(testGeminiDir)
        .then(() => true)
        .catch(() => false);
      expect(dirExists).toBe(true);

      const fileExists = await fs
        .access(testLogFilePath)
        .then(() => true)
        .catch(() => false);
      expect(fileExists).toBe(true);

      const logContent = await readLogFile();
      expect(logContent).toEqual([]);
    });

    it('should load existing logs and set correct messageId for the current session', async () => {
      const currentSessionId = 'session-123';
      const anotherSessionId = 'session-456';
      const existingLogs: LogEntry[] = [
        {
          sessionId: currentSessionId,
          messageId: 0,
          timestamp: new Date('2025-01-01T10:00:05.000Z').toISOString(),
          type: MessageSenderType.USER,
          message: 'Msg1',
        },
        {
          sessionId: anotherSessionId,
          messageId: 5,
          timestamp: new Date('2025-01-01T09:00:00.000Z').toISOString(),
          type: MessageSenderType.USER,
          message: 'OldMsg',
        },
        {
          sessionId: currentSessionId,
          messageId: 1,
          timestamp: new Date('2025-01-01T10:00:10.000Z').toISOString(),
          type: MessageSenderType.USER,
          message: 'Msg2',
        },
      ];
      await fs.writeFile(
        testLogFilePath,
        JSON.stringify(existingLogs, null, 2),
      );
      const newLogger = new Logger(
        currentSessionId,
        new Storage(process.cwd()),
      );
      await newLogger.initialize();
      expect(newLogger['messageId']).toBe(2);
      expect(newLogger['logs']).toEqual(existingLogs);
      newLogger.close();
    });

    it('should set messageId to 0 for a new session if log file exists but has no logs for current session', async () => {
      const existingLogs: LogEntry[] = [
        {
          sessionId: 'some-other-session',
          messageId: 5,
          timestamp: new Date().toISOString(),
          type: MessageSenderType.USER,
          message: 'OldMsg',
        },
      ];
      await fs.writeFile(
        testLogFilePath,
        JSON.stringify(existingLogs, null, 2),
      );
      const newLogger = new Logger('a-new-session', new Storage(process.cwd()));
      await newLogger.initialize();
      expect(newLogger['messageId']).toBe(0);
      newLogger.close();
    });

    it('should be idempotent', async () => {
      await logger.logMessage(MessageSenderType.USER, 'test message');
      const initialMessageId = logger['messageId'];
      const initialLogCount = logger['logs'].length;

      await logger.initialize(); // Second call should not change state

      expect(logger['messageId']).toBe(initialMessageId);
      expect(logger['logs'].length).toBe(initialLogCount);
      const logsFromFile = await readLogFile();
      expect(logsFromFile.length).toBe(1);
    });

    it('should handle invalid JSON in log file by backing it up and starting fresh', async () => {
      await fs.writeFile(testLogFilePath, 'invalid json');

      const newLogger = new Logger(testSessionId, new Storage(process.cwd()));
      await newLogger.initialize();

      const logContent = await readLogFile();
      expect(logContent).toEqual([]);
      const dirContents = await fs.readdir(testGeminiDir);
      expect(
        dirContents.some(
          (f) =>
            f.startsWith(LOG_FILE_NAME + '.invalid_json') && f.endsWith('.bak'),
        ),
      ).toBe(true);
      newLogger.close();
    });

    it('should handle non-array JSON in log file by backing it up and starting fresh', async () => {
      await fs.writeFile(testLogFilePath, JSON.stringify({ not: 'an array' }));

      const newLogger = new Logger(testSessionId, new Storage(process.cwd()));
      await newLogger.initialize();

      const logContent = await readLogFile();
      expect(logContent).toEqual([]);
      const dirContents = await fs.readdir(testGeminiDir);
      expect(
        dirContents.some(
          (f) =>
            f.startsWith(LOG_FILE_NAME + '.malformed_array') &&
            f.endsWith('.bak'),
        ),
      ).toBe(true);
      newLogger.close();
    });
  });

  describe('logMessage', () => {
    it('should append a message to the log file and update in-memory logs', async () => {
      await logger.logMessage(MessageSenderType.USER, 'Hello, world!');
      const logsFromFile = await readLogFile();
      expect(logsFromFile.length).toBe(1);
      expect(logsFromFile[0]).toMatchObject({
        sessionId: testSessionId,
        messageId: 0,
        type: MessageSenderType.USER,
        message: 'Hello, world!',
        timestamp: new Date('2025-01-01T12:00:00.000Z').toISOString(),
      });
      expect(logger['logs'].length).toBe(1);
      expect(logger['logs'][0]).toEqual(logsFromFile[0]);
      expect(logger['messageId']).toBe(1);
    });

    it('should correctly increment messageId for subsequent messages in the same session', async () => {
      await logger.logMessage(MessageSenderType.USER, 'First');
      vi.advanceTimersByTime(1000);
      await logger.logMessage(MessageSenderType.USER, 'Second');
      const logs = await readLogFile();
      expect(logs.length).toBe(2);
      expect(logs[0].messageId).toBe(0);
      expect(logs[1].messageId).toBe(1);
      expect(logs[1].timestamp).not.toBe(logs[0].timestamp);
      expect(logger['messageId']).toBe(2);
    });

    it('should handle logger not initialized', async () => {
      const uninitializedLogger = new Logger(
        testSessionId,
        new Storage(process.cwd()),
      );
      uninitializedLogger.close(); // Ensure it's treated as uninitialized
      await uninitializedLogger.logMessage(MessageSenderType.USER, 'test');
      expect((await readLogFile()).length).toBe(0);
      uninitializedLogger.close();
    });

    it('should simulate concurrent writes from different logger instances to the same file', async () => {
      const concurrentSessionId = 'concurrent-session';
      const logger1 = new Logger(
        concurrentSessionId,
        new Storage(process.cwd()),
      );
      await logger1.initialize();

      const logger2 = new Logger(
        concurrentSessionId,
        new Storage(process.cwd()),
      );
      await logger2.initialize();
      expect(logger2['sessionId']).toEqual(logger1['sessionId']);

      await logger1.logMessage(MessageSenderType.USER, 'L1M1');
      vi.advanceTimersByTime(10);
      await logger2.logMessage(MessageSenderType.USER, 'L2M1');
      vi.advanceTimersByTime(10);
      await logger1.logMessage(MessageSenderType.USER, 'L1M2');
      vi.advanceTimersByTime(10);
      await logger2.logMessage(MessageSenderType.USER, 'L2M2');

      const logsFromFile = await readLogFile();
      expect(logsFromFile.length).toBe(4);
      const messageIdsInFile = logsFromFile
        .map((log) => log.messageId)
        .sort((a, b) => a - b);
      expect(messageIdsInFile).toEqual([0, 1, 2, 3]);

      const messagesInFile = logsFromFile
        .sort((a, b) => a.messageId - b.messageId)
        .map((l) => l.message);
      expect(messagesInFile).toEqual(['L1M1', 'L2M1', 'L1M2', 'L2M2']);

      // Check internal state (next messageId each logger would use for that session)
      expect(logger1['messageId']).toBe(3);
      expect(logger2['messageId']).toBe(4);

      logger1.close();
      logger2.close();
    });

    it('updates lastLoggedUserEntry to the new entry when _updateLogFile skips a USER write (duplicate-skip)', async () => {
      // Regression for PR #4023: when `_updateLogFile` detects another
      // instance already wrote an identical row and returns null, the
      // skipped write must still shift `lastLoggedUserEntry` to the
      // new entry. Otherwise the tracker would lie about the most
      // recent USER row and a subsequent cancel/auto-restore would
      // delete an older, unrelated prompt.
      //
      // The natural race (max+1 colliding with an existing messageId)
      // can't be triggered with sequential awaits because
      // `_updateLogFile`'s snapshot is always max+1-strict. Drive the
      // contract directly by mocking the private method to return null
      // — the post-condition we care about is on `lastLoggedUserEntry`,
      // not on the _readLogFile/writeFile machinery.
      await logger.logMessage(MessageSenderType.USER, 'first');
      const trackerAfterFirst = logger['lastLoggedUserEntry'];
      expect(trackerAfterFirst?.message).toBe('first');

      // Force the duplicate-skip path: _updateLogFile resolves to null.
      const updateSpy = vi
        .spyOn(
          logger as unknown as { _updateLogFile: (e: LogEntry) => unknown },
          '_updateLogFile',
        )
        .mockResolvedValueOnce(null);
      vi.advanceTimersByTime(1000);
      await logger.logMessage(MessageSenderType.USER, 'second');
      expect(updateSpy).toHaveBeenCalled();

      // Tracker MUST have advanced — point at the entry "second" so a
      // follow-up undo targets that row, not the older "first".
      const trackerAfterSkip = logger['lastLoggedUserEntry'];
      expect(trackerAfterSkip).not.toBe(trackerAfterFirst);
      expect(trackerAfterSkip?.message).toBe('second');
      expect(trackerAfterSkip?.type).toBe(MessageSenderType.USER);
    });

    it('removeLastUserMessage targets the duplicate-skipped row, not the older USER', async () => {
      // Identity contract: when `_updateLogFile` returns null on a USER
      // write, the tracker advances to the new entry — and that 5-tuple
      // must match the row that actually IS on disk so a follow-up
      // `removeLastUserMessage()` deletes the duplicate-skipped row
      // rather than wiping out the prior USER prompt.
      //
      // Set up by manually seeding disk with [first (msgId 0), second
      // (msgId 1)] and stubbing `_updateLogFile` for the second call to
      // mimic what the duplicate-skip branch does: align
      // newEntryObject.messageId with the disk row (1) and return null.
      await logger.logMessage(MessageSenderType.USER, 'first');
      const firstOnDisk = (await readLogFile())[0]!;
      expect(firstOnDisk.message).toBe('first');

      vi.advanceTimersByTime(1000);
      const secondTimestamp = new Date().toISOString();
      const secondRow: LogEntry = {
        sessionId: testSessionId,
        messageId: 1,
        timestamp: secondTimestamp,
        type: MessageSenderType.USER,
        message: 'second',
      };
      await fs.writeFile(
        testLogFilePath,
        JSON.stringify([firstOnDisk, secondRow], null, 2),
        'utf-8',
      );

      // Drive the duplicate-skip branch: _updateLogFile mutates
      // newEntryObject to match the disk row (messageId 1, same
      // timestamp), then returns null. logMessage's
      // `else if (type === USER)` branch will then assign
      // lastLoggedUserEntry = newEntryObject — the same 5-tuple as
      // secondRow.
      vi.spyOn(
        logger as unknown as {
          _updateLogFile: (e: LogEntry) => Promise<LogEntry | null>;
        },
        '_updateLogFile',
      ).mockImplementationOnce(async (entry: LogEntry) => {
        entry.messageId = secondRow.messageId;
        entry.timestamp = secondRow.timestamp;
        return null;
      });
      await logger.logMessage(MessageSenderType.USER, 'second');

      // Sanity: tracker points at the secondRow 5-tuple.
      const tracker = logger['lastLoggedUserEntry'];
      expect(tracker).toMatchObject({
        messageId: secondRow.messageId,
        timestamp: secondRow.timestamp,
        message: 'second',
      });

      const removed = await logger.removeLastUserMessage();
      expect(removed).toBe(true);

      // 'second' removed, 'first' untouched.
      const after = await readLogFile();
      expect(after.map((e) => e.message)).toEqual(['first']);
    });

    it('should not throw, not increment messageId, and log error if writing to file fails', async () => {
      vi.mocked(atomicWriteFile).mockRejectedValueOnce(new Error('Disk full'));
      const initialMessageId = logger['messageId'];
      const initialLogCount = logger['logs'].length;

      await logger.logMessage(MessageSenderType.USER, 'test fail write');

      expect(logger['messageId']).toBe(initialMessageId); // Not incremented
      expect(logger['logs'].length).toBe(initialLogCount); // Log not added to in-memory cache
    });
  });

  describe('getPreviousUserMessages', () => {
    it('should retrieve all user messages from logs, sorted newest first', async () => {
      const loggerSort = new Logger('session-1', new Storage(process.cwd()));
      await loggerSort.initialize();
      await loggerSort.logMessage(MessageSenderType.USER, 'S1M0_ts100000');
      vi.advanceTimersByTime(1000);
      await loggerSort.logMessage(MessageSenderType.USER, 'S1M1_ts101000');
      vi.advanceTimersByTime(1000);
      // Switch to a different session to log
      const loggerSort2 = new Logger('session-2', new Storage(process.cwd()));
      await loggerSort2.initialize();
      await loggerSort2.logMessage(MessageSenderType.USER, 'S2M0_ts102000');
      vi.advanceTimersByTime(1000);
      await loggerSort2.logMessage(
        'model' as MessageSenderType,
        'S2_Model_ts103000',
      );
      vi.advanceTimersByTime(1000);
      await loggerSort2.logMessage(MessageSenderType.USER, 'S2M1_ts104000');
      loggerSort.close();
      loggerSort2.close();

      const finalLogger = new Logger(
        'final-session',
        new Storage(process.cwd()),
      );
      await finalLogger.initialize();

      const messages = await finalLogger.getPreviousUserMessages();
      expect(messages).toEqual([
        'S2M1_ts104000',
        'S2M0_ts102000',
        'S1M1_ts101000',
        'S1M0_ts100000',
      ]);
      finalLogger.close();
    });

    it('should return empty array if no user messages exist', async () => {
      await logger.logMessage('system' as MessageSenderType, 'System boot');
      const messages = await logger.getPreviousUserMessages();
      expect(messages).toEqual([]);
    });

    it('should return empty array if logger not initialized', async () => {
      const uninitializedLogger = new Logger(
        testSessionId,
        new Storage(process.cwd()),
      );
      uninitializedLogger.close();
      const messages = await uninitializedLogger.getPreviousUserMessages();
      expect(messages).toEqual([]);
      uninitializedLogger.close();
    });
  });

  describe('saveCheckpoint', () => {
    const conversation: Content[] = [
      { role: 'user', parts: [{ text: 'Hello' }] },
      { role: 'model', parts: [{ text: 'Hi there' }] },
    ];

    it.each([
      {
        tag: 'test-tag',
        encodedTag: 'test-tag',
      },
      {
        tag: '你好世界',
        encodedTag: '%E4%BD%A0%E5%A5%BD%E4%B8%96%E7%95%8C',
      },
      {
        tag: 'japanese-ひらがなひらがな形声',
        encodedTag:
          'japanese-%E3%81%B2%E3%82%89%E3%81%8C%E3%81%AA%E3%81%B2%E3%82%89%E3%81%8C%E3%81%AA%E5%BD%A2%E5%A3%B0',
      },
      {
        tag: '../../secret',
        encodedTag: '..%2F..%2Fsecret',
      },
    ])('should save a checkpoint', async ({ tag, encodedTag }) => {
      await logger.saveCheckpoint(conversation, tag);
      const taggedFilePath = path.join(
        testGeminiDir,
        `checkpoint-${encodedTag}.json`,
      );
      const fileContent = await fs.readFile(taggedFilePath, 'utf-8');
      expect(JSON.parse(fileContent)).toEqual(conversation);
    });

    it('should not throw if logger is not initialized', async () => {
      const uninitializedLogger = new Logger(
        testSessionId,
        new Storage(process.cwd()),
      );
      uninitializedLogger.close();

      await expect(
        uninitializedLogger.saveCheckpoint(conversation, 'tag'),
      ).resolves.not.toThrow();
    });
  });

  describe('loadCheckpoint', () => {
    const conversation: Content[] = [
      { role: 'user', parts: [{ text: 'Hello' }] },
      { role: 'model', parts: [{ text: 'Hi there' }] },
    ];

    beforeEach(async () => {
      await fs.writeFile(
        testCheckpointFilePath,
        JSON.stringify(conversation, null, 2),
      );
    });

    it.each([
      {
        tag: 'test-tag',
        encodedTag: 'test-tag',
      },
      {
        tag: '你好世界',
        encodedTag: '%E4%BD%A0%E5%A5%BD%E4%B8%96%E7%95%8C',
      },
      {
        tag: 'japanese-ひらがなひらがな形声',
        encodedTag:
          'japanese-%E3%81%B2%E3%82%89%E3%81%8C%E3%81%AA%E3%81%B2%E3%82%89%E3%81%8C%E3%81%AA%E5%BD%A2%E5%A3%B0',
      },
      {
        tag: '../../secret',
        encodedTag: '..%2F..%2Fsecret',
      },
    ])('should load from a checkpoint', async ({ tag, encodedTag }) => {
      const taggedConversation = [
        ...conversation,
        { role: 'user', parts: [{ text: 'hello' }] },
      ];
      const taggedFilePath = path.join(
        testGeminiDir,
        `checkpoint-${encodedTag}.json`,
      );
      await fs.writeFile(
        taggedFilePath,
        JSON.stringify(taggedConversation, null, 2),
      );

      const loaded = await logger.loadCheckpoint(tag);
      expect(loaded).toEqual(taggedConversation);
      expect(encodeTagName(tag)).toBe(encodedTag);
      expect(decodeTagName(encodedTag)).toBe(tag);
    });

    it('should return an empty array if a tagged checkpoint file does not exist', async () => {
      const loaded = await logger.loadCheckpoint('nonexistent-tag');
      expect(loaded).toEqual([]);
    });

    it('should return an empty array if the checkpoint file does not exist', async () => {
      await fs.unlink(testCheckpointFilePath); // Ensure it's gone
      const loaded = await logger.loadCheckpoint('missing');
      expect(loaded).toEqual([]);
    });

    it('should return an empty array if the file contains invalid JSON', async () => {
      const tag = 'invalid-json-tag';
      const encodedTag = 'invalid-json-tag';
      const taggedFilePath = path.join(
        testGeminiDir,
        `checkpoint-${encodedTag}.json`,
      );
      await fs.writeFile(taggedFilePath, 'invalid json');
      const loadedCheckpoint = await logger.loadCheckpoint(tag);
      expect(loadedCheckpoint).toEqual([]);
    });

    it('should return an empty array if logger is not initialized', async () => {
      const uninitializedLogger = new Logger(
        testSessionId,
        new Storage(process.cwd()),
      );
      uninitializedLogger.close();
      const loadedCheckpoint = await uninitializedLogger.loadCheckpoint('tag');
      expect(loadedCheckpoint).toEqual([]);
    });
  });

  describe('deleteCheckpoint', () => {
    const conversation: Content[] = [
      { role: 'user', parts: [{ text: 'Content to be deleted' }] },
    ];
    const tag = 'delete-me';
    const encodedTag = 'delete-me';
    let taggedFilePath: string;

    beforeEach(async () => {
      taggedFilePath = path.join(
        testGeminiDir,
        `checkpoint-${encodedTag}.json`,
      );
      // Create a file to be deleted
      await fs.writeFile(taggedFilePath, JSON.stringify(conversation));
    });

    it('should delete the specified checkpoint file and return true', async () => {
      const result = await logger.deleteCheckpoint(tag);
      expect(result).toBe(true);

      // Verify the file is actually gone
      await expect(fs.access(taggedFilePath)).rejects.toThrow(/ENOENT/);
    });

    it('should delete both new and old checkpoint files if they exist', async () => {
      const oldTag = 'delete-me(old)';
      const oldStylePath = path.join(
        testGeminiDir,
        `checkpoint-${oldTag}.json`,
      );
      const newStylePath = logger['_checkpointPath'](oldTag);

      // Create both files
      await fs.writeFile(oldStylePath, '{}');
      await fs.writeFile(newStylePath, '{}');

      // Verify both files exist before deletion
      expect(existsSync(oldStylePath)).toBe(true);
      expect(existsSync(newStylePath)).toBe(true);

      const result = await logger.deleteCheckpoint(oldTag);
      expect(result).toBe(true);

      // Verify both are gone
      expect(existsSync(oldStylePath)).toBe(false);
      expect(existsSync(newStylePath)).toBe(false);
    });

    it('should return false if the checkpoint file does not exist', async () => {
      const result = await logger.deleteCheckpoint('non-existent-tag');
      expect(result).toBe(false);
    });

    it('should re-throw an error if file deletion fails for reasons other than not existing', async () => {
      // Simulate a different error (e.g., permission denied)
      vi.spyOn(fs, 'unlink').mockRejectedValueOnce(
        Object.assign(new Error('EACCES: permission denied'), {
          code: 'EACCES',
        }),
      );

      await expect(logger.deleteCheckpoint(tag)).rejects.toThrow(
        'EACCES: permission denied',
      );
    });

    it('should return false if logger is not initialized', async () => {
      const uninitializedLogger = new Logger(
        testSessionId,
        new Storage(process.cwd()),
      );
      uninitializedLogger.close();

      const result = await uninitializedLogger.deleteCheckpoint(tag);
      expect(result).toBe(false);
    });
  });

  describe('checkpointExists', () => {
    const tag = 'exists-test';
    const encodedTag = 'exists-test';
    let taggedFilePath: string;

    beforeEach(() => {
      taggedFilePath = path.join(
        testGeminiDir,
        `checkpoint-${encodedTag}.json`,
      );
    });

    it('should return true if the checkpoint file exists', async () => {
      await fs.writeFile(taggedFilePath, '{}');
      const exists = await logger.checkpointExists(tag);
      expect(exists).toBe(true);
    });

    it('should return false if the checkpoint file does not exist', async () => {
      const exists = await logger.checkpointExists('non-existent-tag');
      expect(exists).toBe(false);
    });

    it('should throw an error if logger is not initialized', async () => {
      const uninitializedLogger = new Logger(
        testSessionId,
        new Storage(process.cwd()),
      );
      uninitializedLogger.close();

      await expect(uninitializedLogger.checkpointExists(tag)).rejects.toThrow(
        'Logger not initialized. Cannot check for checkpoint existence.',
      );
    });

    it('should re-throw an error if fs.access fails for reasons other than not existing', async () => {
      vi.spyOn(fs, 'access').mockRejectedValueOnce(
        Object.assign(new Error('EACCES: permission denied'), {
          code: 'EACCES',
        }),
      );

      await expect(logger.checkpointExists(tag)).rejects.toThrow(
        'EACCES: permission denied',
      );
    });
  });

  describe('Backward compatibility', () => {
    const conversation: Content[] = [
      { role: 'user', parts: [{ text: 'Hello' }] },
      { role: 'model', parts: [{ text: 'Hi there' }] },
    ];
    it('should load from a checkpoint with a raw special character tag', async () => {
      const taggedConversation = [
        ...conversation,
        { role: 'user', parts: [{ text: 'hello' }] },
      ];
      const tag = 'special(char)';
      const taggedFilePath = path.join(testGeminiDir, `checkpoint-${tag}.json`);
      await fs.writeFile(
        taggedFilePath,
        JSON.stringify(taggedConversation, null, 2),
      );

      const loaded = await logger.loadCheckpoint(tag);
      expect(loaded).toEqual(taggedConversation);
    });
  });

  describe('close', () => {
    it('should reset logger state', async () => {
      await logger.logMessage(MessageSenderType.USER, 'A message');
      logger.close();
      await logger.logMessage(MessageSenderType.USER, 'Another message');
      const messages = await logger.getPreviousUserMessages();
      expect(messages).toEqual([]);
      expect(logger['initialized']).toBe(false);
      expect(logger['logFilePath']).toBeUndefined();
      expect(logger['logs']).toEqual([]);
      expect(logger['sessionId']).toBeUndefined();
      expect(logger['messageId']).toBe(0);
      expect(logger['lastLoggedUserEntry']).toBeNull();
    });
  });

  describe('removeLastUserMessage', () => {
    it('removes the most recently persisted USER entry from disk and cache', async () => {
      await logger.logMessage(MessageSenderType.USER, 'kept');
      vi.advanceTimersByTime(1000);
      await logger.logMessage(MessageSenderType.USER, 'cancelled');

      const removed = await logger.removeLastUserMessage();
      expect(removed).toBe(true);

      const onDisk = await readLogFile();
      expect(onDisk.map((e) => e.message)).toEqual(['kept']);
      const inMemory = await logger.getPreviousUserMessages();
      expect(inMemory).toEqual(['kept']);
      expect(logger['lastLoggedUserEntry']).toBeNull();
      // messageId rolled back so the next write reuses the freed slot.
      expect(logger['messageId']).toBe(1);
    });

    it('is a no-op (returns false) when there is nothing to undo', async () => {
      const removed = await logger.removeLastUserMessage();
      expect(removed).toBe(false);
    });

    it('is one-shot — a second call without a new logMessage is a no-op', async () => {
      await logger.logMessage(MessageSenderType.USER, 'one');
      expect(await logger.removeLastUserMessage()).toBe(true);
      expect(await logger.removeLastUserMessage()).toBe(false);
      expect(await readLogFile()).toEqual([]);
    });

    it('only undoes USER entries (model_switch is left intact)', async () => {
      await logger.logMessage(MessageSenderType.USER, 'real prompt');
      vi.advanceTimersByTime(1000);
      await logger.logMessage(MessageSenderType.MODEL_SWITCH, 'qwen→qwen-max');

      // The model-switch write does NOT update lastLoggedUserEntry, so undo
      // still targets the earlier USER row.
      const removed = await logger.removeLastUserMessage();
      expect(removed).toBe(true);
      const onDisk = await readLogFile();
      expect(onDisk.map((e) => e.message)).toEqual(['qwen→qwen-max']);
    });

    it('returns false when the tracked entry is no longer on disk', async () => {
      await logger.logMessage(MessageSenderType.USER, 'one');
      // External rotation — wipe the file, then ask the logger to undo.
      await fs.writeFile(testLogFilePath, '[]', 'utf-8');
      const removed = await logger.removeLastUserMessage();
      expect(removed).toBe(false);
      expect(logger['lastLoggedUserEntry']).toBeNull();
    });

    it('returns false when the logger is uninitialized', async () => {
      const fresh = new Logger(testSessionId, new Storage(process.cwd()));
      // No initialize() call.
      expect(await fresh.removeLastUserMessage()).toBe(false);
    });

    it('serializes against a concurrent logMessage so a fast resubmit is not clobbered', async () => {
      // Race scenario flagged in PR review: cancel A → fire-and-forget
      // removeLastUserMessage; user immediately submits B → logMessage
      // appends B. Without serialization the two read/splice/write ops
      // interleave: removeLast reads [..., A] (no B yet), logMessage reads
      // [..., A] (no aware of removeLast in flight), logMessage writes
      // [..., A, B], removeLast writes [...] (lost B). With the
      // per-instance writeQueue, both ops serialize on the same Logger so
      // removeLast sees B's write or B's logMessage sees the post-removal
      // state — either way B survives.
      await logger.logMessage(MessageSenderType.USER, 'A');

      // Kick off both without awaiting the first.
      const undoPromise = logger.removeLastUserMessage();
      const resubmitPromise = logger.logMessage(MessageSenderType.USER, 'B');

      const [undone] = await Promise.all([undoPromise, resubmitPromise]);
      expect(undone).toBe(true);

      const onDisk = await readLogFile();
      expect(onDisk.map((e) => e.message)).toEqual(['B']);
    });

    it('clears the tracker when logMessage hits a transient write error', async () => {
      // Regression: without clearing on failed write, a subsequent
      // removeLastUserMessage would target the previous successful
      // USER entry — silently deleting an unrelated row from disk.
      await logger.logMessage(MessageSenderType.USER, 'kept');
      vi.advanceTimersByTime(1000);

      vi.mocked(atomicWriteFile).mockRejectedValueOnce(new Error('Disk full'));
      await logger.logMessage(MessageSenderType.USER, 'failed write');

      expect(logger['lastLoggedUserEntry']).toBeNull();
      // No entry to undo → no-op, "kept" stays on disk.
      expect(await logger.removeLastUserMessage()).toBe(false);
      const onDisk = await readLogFile();
      expect(onDisk.map((e) => e.message)).toEqual(['kept']);
    });

    it('updates the in-memory logs cache synchronously so consumers see the removal without awaiting', async () => {
      // Regression: AppContainer's `userMessages` effect calls
      // `getPreviousUserMessages()` (which reads `this.logs`) on the
      // same render that history truncation fires. Without sync
      // optimistic removal, the effect would surface the cancelled
      // prompt until the disk write completed and some unrelated
      // future render forced the effect to re-run.
      await logger.logMessage(MessageSenderType.USER, 'cancelled prompt');
      expect(await logger.getPreviousUserMessages()).toEqual([
        'cancelled prompt',
      ]);

      // Fire-and-forget the undo; do NOT await.
      const undoPromise = logger.removeLastUserMessage();

      // The very next read must already reflect the removal — that's
      // what AppContainer's effect relies on.
      expect(await logger.getPreviousUserMessages()).toEqual([]);

      // Background disk reconciliation still completes successfully.
      expect(await undoPromise).toBe(true);
      expect(await readLogFile()).toEqual([]);
    });

    it('rolls back the optimistic in-memory removal when the disk write fails', async () => {
      // Regression for the copilot review on #4023: removeLastUserMessage
      // optimistically removes from `this.logs` BEFORE the disk write.
      // If writeFile fails, the contract MUST hold: returning false has
      // to mean the entry is still observable in-memory (otherwise
      // callers see a `false` return AND a removed entry — the
      // worst-of-both inconsistency the JSDoc forbids).
      await logger.logMessage(MessageSenderType.USER, 'cancelled prompt');
      expect(await logger.getPreviousUserMessages()).toEqual([
        'cancelled prompt',
      ]);

      vi.mocked(atomicWriteFile).mockRejectedValueOnce(new Error('Disk full'));
      const removed = await logger.removeLastUserMessage();
      expect(removed).toBe(false);

      // In-memory state restored: the cancelled prompt is observable
      // again (so AppContainer's userMessages effect doesn't show a
      // false-removed state).
      expect(await logger.getPreviousUserMessages()).toEqual([
        'cancelled prompt',
      ]);
      // Tracker also restored so a follow-up retry can find the target.
      expect(logger['lastLoggedUserEntry']).not.toBeNull();
    });

    it('rolls back the optimistic in-memory removal when the disk READ fails', async () => {
      // Companion to the write-failure regression: if _readLogFile throws
      // (filesystem permission change, mid-rotation, etc.) the
      // restoreOptimistic path must run too — otherwise the same
      // false-but-removed contract violation appears on the read leg.
      await logger.logMessage(MessageSenderType.USER, 'cancelled prompt');
      expect(await logger.getPreviousUserMessages()).toEqual([
        'cancelled prompt',
      ]);

      vi.spyOn(fs, 'readFile').mockRejectedValueOnce(
        new Error('Permission denied'),
      );
      const removed = await logger.removeLastUserMessage();
      expect(removed).toBe(false);

      // In-memory state restored: caller observes the entry again, so
      // AppContainer's userMessages effect doesn't display a stale
      // "removed but disk still has it" view.
      expect(await logger.getPreviousUserMessages()).toEqual([
        'cancelled prompt',
      ]);
      // Tracker also restored so a follow-up retry has a target.
      expect(logger['lastLoggedUserEntry']).not.toBeNull();
    });

    it('preserves the USER undo target when a non-USER write (MODEL_SWITCH) fails', async () => {
      // Regression: blanket-clearing the tracker in the catch branch
      // would discard a still-valid undo target whenever an unrelated
      // non-USER write hits a transient error. Only USER-write failures
      // should invalidate the tracker.
      await logger.logMessage(MessageSenderType.USER, 'still cancellable');
      const trackedAfterUser = logger['lastLoggedUserEntry'];
      expect(trackedAfterUser).not.toBeNull();

      vi.mocked(atomicWriteFile).mockRejectedValueOnce(new Error('Disk full'));
      await logger.logMessage(MessageSenderType.MODEL_SWITCH, 'qwen→qwen-max');

      // Tracker is unchanged — the non-USER failure didn't shift which
      // row was the most recent user prompt.
      expect(logger['lastLoggedUserEntry']).toBe(trackedAfterUser);
      expect(await logger.removeLastUserMessage()).toBe(true);
      expect(await readLogFile()).toEqual([]);
    });
  });

  describe('removeSessionMessages', () => {
    // `/delete` removes a session's transcript, but its prompts also sit in
    // the project-shared logs.json that backs cross-session ↑-history —
    // issue #11762. These cover the purge that closes that gap.

    /** Write one prompt as `sessionId`, then advance the clock 1s. */
    const logPromptAs = async (sessionId: string, message: string) => {
      const sessionLogger = new Logger(sessionId, new Storage(process.cwd()));
      await sessionLogger.initialize();
      await sessionLogger.logMessage(MessageSenderType.USER, message);
      sessionLogger.close();
      vi.advanceTimersByTime(1000);
    };

    /** A logger for the session doing the deleting, started after the writes. */
    const currentSessionLogger = async () => {
      const current = new Logger('current-session', new Storage(process.cwd()));
      await current.initialize();
      return current;
    };

    it('purges the deleted session from disk and ↑-history, keeping the others', async () => {
      await logPromptAs('doomed-session', 'ssh root@prod-db');
      await logPromptAs('kept-session', 'what does this repo do?');
      const current = await currentSessionLogger();
      await current.logMessage(MessageSenderType.USER, 'current prompt');
      expect(await current.getPreviousUserMessages()).toEqual([
        'current prompt',
        'what does this repo do?',
        'ssh root@prod-db',
      ]);

      expect(await current.removeSessionMessages('doomed-session')).toBe(true);

      // Gone from ↑-history — and only that session: cross-session history
      // is deliberate, so the sessions that still exist must keep theirs.
      expect(await current.getPreviousUserMessages()).toEqual([
        'current prompt',
        'what does this repo do?',
      ]);
      // Gone from the file too, which is the half `/delete` used to miss.
      const onDisk = await readLogFile();
      expect(onDisk.map((e) => e.sessionId)).toEqual([
        'kept-session',
        'current-session',
      ]);
      current.close();
    });

    it('drops the purged rows from the in-memory cache synchronously', async () => {
      // The delete flow fires this without awaiting, and AppContainer's
      // userMessages effect re-reads getPreviousUserMessages() on the render
      // caused by the "Session deleted" history item — that read happens
      // long before the disk write settles.
      await logPromptAs('doomed-session', 'ssh root@prod-db');
      const current = await currentSessionLogger();

      const purge = current.removeSessionMessages('doomed-session');

      expect(await current.getPreviousUserMessages()).toEqual([]);
      expect(await purge).toBe(true);
      expect(await readLogFile()).toEqual([]);
      current.close();
    });

    it('returns false and leaves the file alone when the session has no rows', async () => {
      await logger.logMessage(MessageSenderType.USER, 'kept');

      expect(await logger.removeSessionMessages('never-logged')).toBe(false);

      expect((await readLogFile()).map((e) => e.message)).toEqual(['kept']);
      expect(await logger.getPreviousUserMessages()).toEqual(['kept']);
    });

    it('returns false when the logger is uninitialized', async () => {
      const fresh = new Logger(testSessionId, new Storage(process.cwd()));
      // No initialize() call.
      expect(await fresh.removeSessionMessages('doomed-session')).toBe(false);
    });

    it('rolls back the optimistic removal when the disk write fails', async () => {
      // Same contract as removeLastUserMessage: `false` must never mean
      // "dropped from the cache but still on disk", or ↑-history would hide
      // prompts the file still holds.
      await logPromptAs('doomed-session', 'ssh root@prod-db');
      const current = await currentSessionLogger();

      vi.mocked(atomicWriteFile).mockRejectedValueOnce(new Error('Disk full'));
      expect(await current.removeSessionMessages('doomed-session')).toBe(false);

      expect(await current.getPreviousUserMessages()).toEqual([
        'ssh root@prod-db',
      ]);
      expect((await readLogFile()).map((e) => e.message)).toEqual([
        'ssh root@prod-db',
      ]);
      current.close();
    });

    it('rolls back the optimistic removal when the disk READ fails', async () => {
      await logPromptAs('doomed-session', 'ssh root@prod-db');
      const current = await currentSessionLogger();

      vi.spyOn(fs, 'readFile').mockRejectedValueOnce(
        new Error('Permission denied'),
      );
      expect(await current.removeSessionMessages('doomed-session')).toBe(false);

      expect(await current.getPreviousUserMessages()).toEqual([
        'ssh root@prod-db',
      ]);
      current.close();
    });

    it('serializes against a concurrent logMessage so a parallel prompt survives', async () => {
      // The purge is fire-and-forget, so the user can type the next prompt
      // while it is still in flight. Without the shared write queue the
      // purge's read/filter/write would clobber that prompt.
      await logPromptAs('doomed-session', 'ssh root@prod-db');
      const current = await currentSessionLogger();

      const purge = current.removeSessionMessages('doomed-session');
      const logged = current.logMessage(
        MessageSenderType.USER,
        'typed while deleting',
      );

      const [purged] = await Promise.all([purge, logged]);
      expect(purged).toBe(true);
      expect((await readLogFile()).map((e) => e.message)).toEqual([
        'typed while deleting',
      ]);
      current.close();
    });

    it('purges a whole batch in ONE file rewrite', async () => {
      // Per-id calls each read, filter and rewrite the entire project-shared file,
      // and the next logMessage queues behind all of them.
      await logPromptAs('doomed-a', 'ssh root@prod-db');
      await logPromptAs('doomed-b', 'cat ~/.aws/credentials');
      await logPromptAs('kept-session', 'what does this repo do?');
      const current = await currentSessionLogger();
      vi.mocked(atomicWriteFile).mockClear();

      expect(
        await current.removeSessionsMessages(['doomed-a', 'doomed-b']),
      ).toBe(true);

      expect(vi.mocked(atomicWriteFile)).toHaveBeenCalledTimes(1);
      expect((await readLogFile()).map((e) => e.sessionId)).toEqual([
        'kept-session',
      ]);
      current.close();
    });

    it('does not re-adopt rows a queued purge already dropped', async () => {
      // Each queued op assigns the cache from its OWN disk snapshot, which still holds
      // the rows of the purge behind it. Without the pending-purge filter the first op
      // puts the second session's prompts back, and a read in that window returns a
      // prompt from a session the user was just told was deleted.
      await logPromptAs('doomed-a', 'ssh root@prod-db');
      await logPromptAs('doomed-b', 'cat ~/.aws/credentials');
      const current = await currentSessionLogger();

      const first = current.removeSessionMessages('doomed-a');
      const second = current.removeSessionMessages('doomed-b');

      expect(await first).toBe(true);
      // After only the FIRST has resolved, neither session may be observable.
      expect(await current.getPreviousUserMessages()).toEqual([]);
      expect(await second).toBe(true);
      expect(await readLogFile()).toEqual([]);
      current.close();
    });

    it('stops hiding a session once its purge has failed', async () => {
      // A failed purge leaves its rows on disk. If its id stayed pending, the next
      // purge would still filter those rows out of the cache it adopts.
      await logPromptAs('doomed-a', 'ssh root@prod-db');
      await logPromptAs('doomed-b', 'cat ~/.aws/credentials');
      const current = await currentSessionLogger();

      vi.mocked(atomicWriteFile).mockRejectedValueOnce(new Error('Disk full'));
      expect(await current.removeSessionMessages('doomed-a')).toBe(false);
      expect(await current.removeSessionMessages('doomed-b')).toBe(true);

      expect(await current.getPreviousUserMessages()).toEqual([
        'ssh root@prod-db',
      ]);
      expect((await readLogFile()).map((e) => e.message)).toEqual([
        'ssh root@prod-db',
      ]);
      current.close();
    });

    it('keeps a queued purge applied when the purge ahead of it finds nothing', async () => {
      await logPromptAs('doomed-b', 'ssh root@prod-db');
      const current = await currentSessionLogger();

      const first = current.removeSessionMessages('never-logged');
      const second = current.removeSessionMessages('doomed-b');

      expect(await first).toBe(false);
      // The first op adopted a disk snapshot that still holds doomed-b's row.
      expect(await current.getPreviousUserMessages()).toEqual([]);
      expect(await second).toBe(true);
      expect(await readLogFile()).toEqual([]);
      current.close();
    });

    it('purges rows this logger has never seen on disk', async () => {
      // The helper above initializes the purging logger AFTER the writes, so its cache
      // is warm. The multi-instance shape is the one where the purge is the only thing
      // that can clean the shared file: a logger that started BEFORE those rows existed.
      const current = await currentSessionLogger(); // cache: empty
      await logPromptAs('doomed-session', 'ssh root@prod-db');

      expect(await current.removeSessionMessages('doomed-session')).toBe(true);

      expect(await readLogFile()).toEqual([]);
      current.close();
    });

    it('clears a pending undo target that belonged to the purged session', async () => {
      // Otherwise removeLastUserMessage would still be pointing at a row the
      // purge deleted. Also covers purging the logger's own session.
      const doomed = new Logger('doomed-session', new Storage(process.cwd()));
      await doomed.initialize();
      await doomed.logMessage(MessageSenderType.USER, 'ssh root@prod-db');
      expect(doomed['lastLoggedUserEntry']).not.toBeNull();

      expect(await doomed.removeSessionMessages('doomed-session')).toBe(true);

      expect(doomed['lastLoggedUserEntry']).toBeNull();
      expect(await doomed.removeLastUserMessage()).toBe(false);
      expect(await readLogFile()).toEqual([]);
      doomed.close();
    });
  });
});

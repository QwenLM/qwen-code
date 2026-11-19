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
import { modelText, userText } from '../test-utils/model-fixtures.js';

import os from 'node:os';

const GEMINI_DIR_NAME = '.qwen';
const TMP_DIR_NAME = 'tmp';
const LOG_FILE_NAME = 'logs.json';
const CHECKPOINT_FILE_NAME = 'checkpoint.json';
const USER = MessageSenderType.USER;
const SSH = 'ssh root@prod-db';

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

const messagesOnDisk = async () => (await readLogFile()).map((e) => e.message);
const sessionsOnDisk = async () =>
  (await readLogFile()).map((e) => e.sessionId);
const checkpointFile = (encodedTag: string) =>
  path.join(testGeminiDir, `checkpoint-${encodedTag}.json`);
const pathExists = (p: string) =>
  fs
    .access(p)
    .then(() => true)
    .catch(() => false);
const eacces = () =>
  Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
const failNextWrite = () =>
  vi.mocked(atomicWriteFile).mockRejectedValueOnce(new Error('Disk full'));
const failNextRead = () =>
  vi
    .spyOn(fs, 'readFile')
    .mockRejectedValueOnce(new Error('Permission denied'));
const restoreEnv = (key: string, value: string | undefined) => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

const newLogger = (sessionId: string) =>
  new Logger(sessionId, new Storage(process.cwd()));
async function initLogger(sessionId: string) {
  const logger = newLogger(sessionId);
  await logger.initialize();
  return logger;
}
const userEntry = (
  sessionId: string,
  messageId: number,
  timestamp: string,
  message: string,
): LogEntry => ({ sessionId, messageId, timestamp, type: USER, message });

// Tags and their on-disk encodings, shared by the save and load tables.
const TAG_CASES = [
  { tag: 'test-tag', encodedTag: 'test-tag' },
  { tag: '你好世界', encodedTag: '%E4%BD%A0%E5%A5%BD%E4%B8%96%E7%95%8C' },
  {
    tag: 'japanese-ひらがなひらがな形声',
    encodedTag:
      'japanese-%E3%81%B2%E3%82%89%E3%81%8C%E3%81%AA%E3%81%B2%E3%82%89%E3%81%8C%E3%81%AA%E5%BD%A2%E5%A3%B0',
  },
  { tag: '../../secret', encodedTag: '..%2F..%2Fsecret' },
];

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
  const conversation: Content[] = [userText('Hello'), modelText('Hi there')];
  const history = (l: Logger = logger) => l.getPreviousUserMessages();
  // A logger that close() has forced into the uninitialized state.
  const uninitialized = () => {
    const l = newLogger(testSessionId);
    l.close();
    return l;
  };

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
    await cleanupLogAndCheckpointFiles();
    await fs.mkdir(testGeminiDir, { recursive: true });
    logger = newLogger(testSessionId);
    await logger.initialize();
  });

  afterEach(async () => {
    if (logger) {
      logger.close();
    }
    await cleanupLogAndCheckpointFiles();
    vi.useRealTimers();
    vi.restoreAllMocks();
    restoreEnv('HOME', originalHome);
    restoreEnv('QWEN_RUNTIME_DIR', originalRuntimeDir);
  });

  afterAll(async () => {
    await cleanupLogAndCheckpointFiles();
  });

  describe('initialize', () => {
    it('should create .gemini directory and an empty log file if none exist', async () => {
      expect(await pathExists(testGeminiDir)).toBe(true);
      expect(await pathExists(testLogFilePath)).toBe(true);
      expect(await readLogFile()).toEqual([]);
    });

    it('should load existing logs and set correct messageId for the current session', async () => {
      const existingLogs: LogEntry[] = [
        userEntry('session-123', 0, '2025-01-01T10:00:05.000Z', 'Msg1'),
        userEntry('session-456', 5, '2025-01-01T09:00:00.000Z', 'OldMsg'),
        userEntry('session-123', 1, '2025-01-01T10:00:10.000Z', 'Msg2'),
      ];
      await fs.writeFile(
        testLogFilePath,
        JSON.stringify(existingLogs, null, 2),
      );
      const current = await initLogger('session-123');
      expect(current['messageId']).toBe(2);
      expect(current['logs']).toEqual(existingLogs);
      current.close();
    });

    it('should set messageId to 0 for a new session if log file exists but has no logs for current session', async () => {
      const existingLogs: LogEntry[] = [
        userEntry('some-other-session', 5, new Date().toISOString(), 'OldMsg'),
      ];
      await fs.writeFile(
        testLogFilePath,
        JSON.stringify(existingLogs, null, 2),
      );
      const fresh = await initLogger('a-new-session');
      expect(fresh['messageId']).toBe(0);
      fresh.close();
    });

    it('should be idempotent', async () => {
      await logger.logMessage(USER, 'test message');
      const initialMessageId = logger['messageId'];
      const initialLogCount = logger['logs'].length;

      await logger.initialize(); // Second call should not change state

      expect(logger['messageId']).toBe(initialMessageId);
      expect(logger['logs'].length).toBe(initialLogCount);
      expect((await readLogFile()).length).toBe(1);
    });

    // A fresh logger over a corrupt log file starts empty and leaves a
    // `logs.json<backupTag>...bak` backup beside it.
    async function expectBackedUpFresh(fileContent: string, backupTag: string) {
      await fs.writeFile(testLogFilePath, fileContent);
      const fresh = await initLogger(testSessionId);

      expect(await readLogFile()).toEqual([]);
      const dirContents = await fs.readdir(testGeminiDir);
      expect(
        dirContents.some(
          (f) => f.startsWith(LOG_FILE_NAME + backupTag) && f.endsWith('.bak'),
        ),
      ).toBe(true);
      fresh.close();
    }

    it('should handle invalid JSON in log file by backing it up and starting fresh', async () => {
      await expectBackedUpFresh('invalid json', '.invalid_json');
    });

    it('should handle non-array JSON in log file by backing it up and starting fresh', async () => {
      await expectBackedUpFresh(
        JSON.stringify({ not: 'an array' }),
        '.malformed_array',
      );
    });
  });

  describe('logMessage', () => {
    const spyUpdateLogFile = () =>
      vi.spyOn(
        logger as unknown as {
          _updateLogFile: (e: LogEntry) => Promise<LogEntry | null>;
        },
        '_updateLogFile',
      );

    it('should append a message to the log file and update in-memory logs', async () => {
      await logger.logMessage(USER, 'Hello, world!');
      const logsFromFile = await readLogFile();
      expect(logsFromFile.length).toBe(1);
      expect(logsFromFile[0]).toMatchObject({
        sessionId: testSessionId,
        messageId: 0,
        type: USER,
        message: 'Hello, world!',
        timestamp: new Date('2025-01-01T12:00:00.000Z').toISOString(),
      });
      expect(logger['logs'].length).toBe(1);
      expect(logger['logs'][0]).toEqual(logsFromFile[0]);
      expect(logger['messageId']).toBe(1);
    });

    it('should correctly increment messageId for subsequent messages in the same session', async () => {
      await logger.logMessage(USER, 'First');
      vi.advanceTimersByTime(1000);
      await logger.logMessage(USER, 'Second');
      const logs = await readLogFile();
      expect(logs.length).toBe(2);
      expect(logs[0].messageId).toBe(0);
      expect(logs[1].messageId).toBe(1);
      expect(logs[1].timestamp).not.toBe(logs[0].timestamp);
      expect(logger['messageId']).toBe(2);
    });

    it('should handle logger not initialized', async () => {
      const uninitializedLogger = uninitialized();
      await uninitializedLogger.logMessage(USER, 'test');
      expect((await readLogFile()).length).toBe(0);
      uninitializedLogger.close();
    });

    it('should simulate concurrent writes from different logger instances to the same file', async () => {
      const logger1 = await initLogger('concurrent-session');
      const logger2 = await initLogger('concurrent-session');
      expect(logger2['sessionId']).toEqual(logger1['sessionId']);

      await logger1.logMessage(USER, 'L1M1');
      vi.advanceTimersByTime(10);
      await logger2.logMessage(USER, 'L2M1');
      vi.advanceTimersByTime(10);
      await logger1.logMessage(USER, 'L1M2');
      vi.advanceTimersByTime(10);
      await logger2.logMessage(USER, 'L2M2');

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

      // Next messageId each logger would use for that session
      expect(logger1['messageId']).toBe(3);
      expect(logger2['messageId']).toBe(4);

      logger1.close();
      logger2.close();
    });

    it('updates lastLoggedUserEntry to the new entry when _updateLogFile skips a USER write (duplicate-skip)', async () => {
      // Regression for PR #4023: when `_updateLogFile` sees another instance
      // already wrote an identical row and returns null, the skipped write
      // must still move `lastLoggedUserEntry` to the new entry, or a later
      // cancel/auto-restore would delete an older, unrelated prompt. The
      // natural race (max+1 colliding with an existing messageId) can't occur
      // with sequential awaits, as the snapshot is always max+1-strict, so
      // the private method is mocked to return null: only the tracker matters.
      await logger.logMessage(USER, 'first');
      const trackerAfterFirst = logger['lastLoggedUserEntry'];
      expect(trackerAfterFirst?.message).toBe('first');

      const updateSpy = spyUpdateLogFile().mockResolvedValueOnce(null);
      vi.advanceTimersByTime(1000);
      await logger.logMessage(USER, 'second');
      expect(updateSpy).toHaveBeenCalled();

      // The tracker MUST point at "second" so a follow-up undo targets that
      // row, not the older "first".
      const trackerAfterSkip = logger['lastLoggedUserEntry'];
      expect(trackerAfterSkip).not.toBe(trackerAfterFirst);
      expect(trackerAfterSkip?.message).toBe('second');
      expect(trackerAfterSkip?.type).toBe(USER);
    });

    it('removeLastUserMessage targets the duplicate-skipped row, not the older USER', async () => {
      // Identity contract: after a null `_updateLogFile` USER write, the
      // tracker's 5-tuple must match the row actually on disk, so
      // `removeLastUserMessage()` deletes that duplicate-skipped row rather
      // than the prior USER prompt. Disk is seeded with [first (0), second
      // (1)] and the stub mimics the duplicate-skip branch.
      await logger.logMessage(USER, 'first');
      const firstOnDisk = (await readLogFile())[0]!;
      expect(firstOnDisk.message).toBe('first');

      vi.advanceTimersByTime(1000);
      const secondRow = userEntry(
        testSessionId,
        1,
        new Date().toISOString(),
        'second',
      );
      await fs.writeFile(
        testLogFilePath,
        JSON.stringify([firstOnDisk, secondRow], null, 2),
        'utf-8',
      );

      // The stub aligns newEntryObject with the disk row (messageId 1, same
      // timestamp) and returns null; logMessage's `else if (type === USER)`
      // branch then sets lastLoggedUserEntry to secondRow's 5-tuple.
      spyUpdateLogFile().mockImplementationOnce(async (entry: LogEntry) => {
        entry.messageId = secondRow.messageId;
        entry.timestamp = secondRow.timestamp;
        return null;
      });
      await logger.logMessage(USER, 'second');

      expect(logger['lastLoggedUserEntry']).toMatchObject({
        messageId: secondRow.messageId,
        timestamp: secondRow.timestamp,
        message: 'second',
      });

      expect(await logger.removeLastUserMessage()).toBe(true);
      // 'second' removed, 'first' untouched.
      expect(await messagesOnDisk()).toEqual(['first']);
    });

    it('should not throw, not increment messageId, and log error if writing to file fails', async () => {
      failNextWrite();
      const initialMessageId = logger['messageId'];
      const initialLogCount = logger['logs'].length;

      await logger.logMessage(USER, 'test fail write');

      expect(logger['messageId']).toBe(initialMessageId); // Not incremented
      expect(logger['logs'].length).toBe(initialLogCount); // Not cached
    });
  });

  describe('getPreviousUserMessages', () => {
    it('should retrieve all user messages from logs, sorted newest first', async () => {
      const loggerSort = await initLogger('session-1');
      await loggerSort.logMessage(USER, 'S1M0_ts100000');
      vi.advanceTimersByTime(1000);
      await loggerSort.logMessage(USER, 'S1M1_ts101000');
      vi.advanceTimersByTime(1000);
      // Switch to a different session to log
      const loggerSort2 = await initLogger('session-2');
      await loggerSort2.logMessage(USER, 'S2M0_ts102000');
      vi.advanceTimersByTime(1000);
      await loggerSort2.logMessage(
        'model' as MessageSenderType,
        'S2_Model_ts103000',
      );
      vi.advanceTimersByTime(1000);
      await loggerSort2.logMessage(USER, 'S2M1_ts104000');
      loggerSort.close();
      loggerSort2.close();

      const finalLogger = await initLogger('final-session');
      expect(await history(finalLogger)).toEqual([
        'S2M1_ts104000',
        'S2M0_ts102000',
        'S1M1_ts101000',
        'S1M0_ts100000',
      ]);
      finalLogger.close();
    });

    it('should return empty array if no user messages exist', async () => {
      await logger.logMessage('system' as MessageSenderType, 'System boot');
      expect(await history()).toEqual([]);
    });

    it('should return empty array if logger not initialized', async () => {
      const uninitializedLogger = uninitialized();
      expect(await history(uninitializedLogger)).toEqual([]);
      uninitializedLogger.close();
    });
  });

  describe('saveCheckpoint', () => {
    it.each(TAG_CASES)(
      'should save a checkpoint',
      async ({ tag, encodedTag }) => {
        await logger.saveCheckpoint(conversation, tag);
        const fileContent = await fs.readFile(
          checkpointFile(encodedTag),
          'utf-8',
        );
        expect(JSON.parse(fileContent)).toEqual(conversation);
      },
    );

    it('should not throw if logger is not initialized', async () => {
      await expect(
        uninitialized().saveCheckpoint(conversation, 'tag'),
      ).resolves.not.toThrow();
    });
  });

  // Writes the conversation plus a 'hello' turn to the checkpoint file for
  // `fileTag` and expects loadCheckpoint(tag) to return it.
  async function expectLoadsTagged(tag: string, fileTag: string) {
    const taggedConversation = [...conversation, userText('hello')];
    await fs.writeFile(
      checkpointFile(fileTag),
      JSON.stringify(taggedConversation, null, 2),
    );
    expect(await logger.loadCheckpoint(tag)).toEqual(taggedConversation);
  }

  describe('loadCheckpoint', () => {
    beforeEach(async () => {
      await fs.writeFile(
        testCheckpointFilePath,
        JSON.stringify(conversation, null, 2),
      );
    });

    it.each(TAG_CASES)(
      'should load from a checkpoint',
      async ({ tag, encodedTag }) => {
        await expectLoadsTagged(tag, encodedTag);
        expect(encodeTagName(tag)).toBe(encodedTag);
        expect(decodeTagName(encodedTag)).toBe(tag);
      },
    );

    it('should return an empty array if a tagged checkpoint file does not exist', async () => {
      expect(await logger.loadCheckpoint('nonexistent-tag')).toEqual([]);
    });

    it('should return an empty array if the checkpoint file does not exist', async () => {
      await fs.unlink(testCheckpointFilePath); // Ensure it's gone
      expect(await logger.loadCheckpoint('missing')).toEqual([]);
    });

    it('should return an empty array if the file contains invalid JSON', async () => {
      await fs.writeFile(checkpointFile('invalid-json-tag'), 'invalid json');
      expect(await logger.loadCheckpoint('invalid-json-tag')).toEqual([]);
    });

    it('should return an empty array if logger is not initialized', async () => {
      expect(await uninitialized().loadCheckpoint('tag')).toEqual([]);
    });
  });

  describe('deleteCheckpoint', () => {
    const tag = 'delete-me';

    beforeEach(async () => {
      // Create a file to be deleted
      await fs.writeFile(
        checkpointFile(tag),
        JSON.stringify([userText('Content to be deleted')]),
      );
    });

    it('should delete the specified checkpoint file and return true', async () => {
      expect(await logger.deleteCheckpoint(tag)).toBe(true);
      await expect(fs.access(checkpointFile(tag))).rejects.toThrow(/ENOENT/);
    });

    it('should delete both new and old checkpoint files if they exist', async () => {
      const oldTag = 'delete-me(old)';
      const oldStylePath = checkpointFile(oldTag);
      const newStylePath = logger['_checkpointPath'](oldTag);
      await fs.writeFile(oldStylePath, '{}');
      await fs.writeFile(newStylePath, '{}');
      expect(existsSync(oldStylePath)).toBe(true);
      expect(existsSync(newStylePath)).toBe(true);

      expect(await logger.deleteCheckpoint(oldTag)).toBe(true);

      expect(existsSync(oldStylePath)).toBe(false);
      expect(existsSync(newStylePath)).toBe(false);
    });

    it('should return false if the checkpoint file does not exist', async () => {
      expect(await logger.deleteCheckpoint('non-existent-tag')).toBe(false);
    });

    it('should re-throw an error if file deletion fails for reasons other than not existing', async () => {
      // e.g. permission denied
      vi.spyOn(fs, 'unlink').mockRejectedValueOnce(eacces());
      await expect(logger.deleteCheckpoint(tag)).rejects.toThrow(
        'EACCES: permission denied',
      );
    });

    it('should return false if logger is not initialized', async () => {
      expect(await uninitialized().deleteCheckpoint(tag)).toBe(false);
    });
  });

  describe('checkpointExists', () => {
    const tag = 'exists-test';

    it('should return true if the checkpoint file exists', async () => {
      await fs.writeFile(checkpointFile(tag), '{}');
      expect(await logger.checkpointExists(tag)).toBe(true);
    });

    it('should return false if the checkpoint file does not exist', async () => {
      expect(await logger.checkpointExists('non-existent-tag')).toBe(false);
    });

    it('should throw an error if logger is not initialized', async () => {
      await expect(uninitialized().checkpointExists(tag)).rejects.toThrow(
        'Logger not initialized. Cannot check for checkpoint existence.',
      );
    });

    it('should re-throw an error if fs.access fails for reasons other than not existing', async () => {
      vi.spyOn(fs, 'access').mockRejectedValueOnce(eacces());
      await expect(logger.checkpointExists(tag)).rejects.toThrow(
        'EACCES: permission denied',
      );
    });
  });

  describe('Backward compatibility', () => {
    it('should load from a checkpoint with a raw special character tag', async () => {
      await expectLoadsTagged('special(char)', 'special(char)');
    });
  });

  describe('close', () => {
    it('should reset logger state', async () => {
      await logger.logMessage(USER, 'A message');
      logger.close();
      await logger.logMessage(USER, 'Another message');
      expect(await history()).toEqual([]);
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
      await logger.logMessage(USER, 'kept');
      vi.advanceTimersByTime(1000);
      await logger.logMessage(USER, 'cancelled');

      expect(await logger.removeLastUserMessage()).toBe(true);

      expect(await messagesOnDisk()).toEqual(['kept']);
      expect(await history()).toEqual(['kept']);
      expect(logger['lastLoggedUserEntry']).toBeNull();
      // messageId rolled back so the next write reuses the freed slot.
      expect(logger['messageId']).toBe(1);
    });

    it('is a no-op (returns false) when there is nothing to undo', async () => {
      expect(await logger.removeLastUserMessage()).toBe(false);
    });

    it('is one-shot — a second call without a new logMessage is a no-op', async () => {
      await logger.logMessage(USER, 'one');
      expect(await logger.removeLastUserMessage()).toBe(true);
      expect(await logger.removeLastUserMessage()).toBe(false);
      expect(await readLogFile()).toEqual([]);
    });

    it('only undoes USER entries (model_switch is left intact)', async () => {
      await logger.logMessage(USER, 'real prompt');
      vi.advanceTimersByTime(1000);
      await logger.logMessage(MessageSenderType.MODEL_SWITCH, 'qwen→qwen-max');

      // The model-switch write does NOT update lastLoggedUserEntry, so undo
      // still targets the earlier USER row.
      expect(await logger.removeLastUserMessage()).toBe(true);
      expect(await messagesOnDisk()).toEqual(['qwen→qwen-max']);
    });

    it('returns false when the tracked entry is no longer on disk', async () => {
      await logger.logMessage(USER, 'one');
      // External rotation — wipe the file, then ask the logger to undo.
      await fs.writeFile(testLogFilePath, '[]', 'utf-8');
      expect(await logger.removeLastUserMessage()).toBe(false);
      expect(logger['lastLoggedUserEntry']).toBeNull();
    });

    it('returns false when the logger is uninitialized', async () => {
      // No initialize() call.
      expect(await newLogger(testSessionId).removeLastUserMessage()).toBe(
        false,
      );
    });

    it('serializes against a concurrent logMessage so a fast resubmit is not clobbered', async () => {
      // Race flagged in PR review: cancel A fires removeLastUserMessage
      // without awaiting, then the user submits B. Unserialized, both read
      // [..., A], logMessage writes [..., A, B] and removeLast then writes
      // [...], losing B. The per-instance writeQueue serializes them, so B
      // survives either way.
      await logger.logMessage(USER, 'A');

      // Kick off both without awaiting the first.
      const undoPromise = logger.removeLastUserMessage();
      const resubmitPromise = logger.logMessage(USER, 'B');

      const [undone] = await Promise.all([undoPromise, resubmitPromise]);
      expect(undone).toBe(true);
      expect(await messagesOnDisk()).toEqual(['B']);
    });

    it('clears the tracker when logMessage hits a transient write error', async () => {
      // Regression: without clearing on failed write, a subsequent
      // removeLastUserMessage would target the previous successful
      // USER entry — silently deleting an unrelated row from disk.
      await logger.logMessage(USER, 'kept');
      vi.advanceTimersByTime(1000);

      failNextWrite();
      await logger.logMessage(USER, 'failed write');

      expect(logger['lastLoggedUserEntry']).toBeNull();
      // No entry to undo → no-op, "kept" stays on disk.
      expect(await logger.removeLastUserMessage()).toBe(false);
      expect(await messagesOnDisk()).toEqual(['kept']);
    });

    it('updates the in-memory logs cache synchronously so consumers see the removal without awaiting', async () => {
      // Regression: AppContainer's `userMessages` effect reads `this.logs`
      // via `getPreviousUserMessages()` on the same render that history
      // truncation fires. Without sync optimistic removal it would show the
      // cancelled prompt until the disk write completed and some unrelated
      // later render re-ran the effect.
      await logger.logMessage(USER, 'cancelled prompt');
      expect(await history()).toEqual(['cancelled prompt']);

      const undoPromise = logger.removeLastUserMessage(); // not awaited

      // The very next read must already reflect the removal.
      expect(await history()).toEqual([]);

      // Background disk reconciliation still completes successfully.
      expect(await undoPromise).toBe(true);
      expect(await readLogFile()).toEqual([]);
    });

    // Logs 'cancelled prompt', makes the undo's disk op fail via `inject`, and
    // expects `false` with the entry observable in-memory again (so
    // AppContainer's userMessages effect shows no false-removed state) and
    // the tracker restored so a follow-up retry has a target.
    async function expectUndoRolledBack(inject: () => unknown) {
      await logger.logMessage(USER, 'cancelled prompt');
      expect(await history()).toEqual(['cancelled prompt']);

      inject();
      expect(await logger.removeLastUserMessage()).toBe(false);

      expect(await history()).toEqual(['cancelled prompt']);
      expect(logger['lastLoggedUserEntry']).not.toBeNull();
    }

    it('rolls back the optimistic in-memory removal when the disk write fails', async () => {
      // Regression for the copilot review on #4023: the removal from
      // `this.logs` happens BEFORE the disk write, and returning false must
      // mean the entry is still in memory; a `false` return AND a removed
      // entry is the worst-of-both inconsistency the JSDoc forbids.
      await expectUndoRolledBack(failNextWrite);
    });

    it('rolls back the optimistic in-memory removal when the disk READ fails', async () => {
      // Companion: if _readLogFile throws (permission change, mid-rotation,
      // etc.) restoreOptimistic must run too, or the same false-but-removed
      // violation appears on the read leg.
      await expectUndoRolledBack(failNextRead);
    });

    it('preserves the USER undo target when a non-USER write (MODEL_SWITCH) fails', async () => {
      // Regression: blanket-clearing the tracker in the catch branch would
      // drop a still-valid undo target whenever an unrelated non-USER write
      // hits a transient error. Only USER-write failures invalidate it.
      await logger.logMessage(USER, 'still cancellable');
      const trackedAfterUser = logger['lastLoggedUserEntry'];
      expect(trackedAfterUser).not.toBeNull();

      failNextWrite();
      await logger.logMessage(MessageSenderType.MODEL_SWITCH, 'qwen→qwen-max');

      // Unchanged: the non-USER failure didn't shift the latest user prompt.
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
      const sessionLogger = await initLogger(sessionId);
      await sessionLogger.logMessage(USER, message);
      sessionLogger.close();
      vi.advanceTimersByTime(1000);
    };

    /** A logger for the session doing the deleting, started after the writes. */
    const currentSessionLogger = () => initLogger('current-session');

    /** Log SSH as 'doomed-session', then start the current-session logger. */
    const afterDoomedPrompt = async () => {
      await logPromptAs('doomed-session', SSH);
      return currentSessionLogger();
    };

    it('purges the deleted session from disk and ↑-history, keeping the others', async () => {
      await logPromptAs('doomed-session', SSH);
      await logPromptAs('kept-session', 'what does this repo do?');
      const current = await currentSessionLogger();
      await current.logMessage(USER, 'current prompt');
      expect(await history(current)).toEqual([
        'current prompt',
        'what does this repo do?',
        SSH,
      ]);

      expect(await current.removeSessionMessages('doomed-session')).toBe(true);

      // Gone from ↑-history — and only that session: cross-session history
      // is deliberate, so the sessions that still exist must keep theirs.
      expect(await history(current)).toEqual([
        'current prompt',
        'what does this repo do?',
      ]);
      // Gone from the file too, which is the half `/delete` used to miss.
      expect(await sessionsOnDisk()).toEqual([
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
      const current = await afterDoomedPrompt();

      const purge = current.removeSessionMessages('doomed-session');

      expect(await history(current)).toEqual([]);
      expect(await purge).toBe(true);
      expect(await readLogFile()).toEqual([]);
      current.close();
    });

    it('returns false and leaves the file alone when the session has no rows', async () => {
      await logger.logMessage(USER, 'kept');

      expect(await logger.removeSessionMessages('never-logged')).toBe(false);

      expect(await messagesOnDisk()).toEqual(['kept']);
      expect(await history()).toEqual(['kept']);
    });

    it('returns false when the logger is uninitialized', async () => {
      // No initialize() call.
      expect(
        await newLogger(testSessionId).removeSessionMessages('doomed-session'),
      ).toBe(false);
    });

    it('rolls back the optimistic removal when the disk write fails', async () => {
      // Same contract as removeLastUserMessage: `false` must never mean
      // "dropped from the cache but still on disk", or ↑-history would hide
      // prompts the file still holds.
      const current = await afterDoomedPrompt();

      failNextWrite();
      expect(await current.removeSessionMessages('doomed-session')).toBe(false);

      expect(await history(current)).toEqual([SSH]);
      expect(await messagesOnDisk()).toEqual([SSH]);
      current.close();
    });

    it('rolls back the optimistic removal when the disk READ fails', async () => {
      const current = await afterDoomedPrompt();

      failNextRead();
      expect(await current.removeSessionMessages('doomed-session')).toBe(false);

      expect(await history(current)).toEqual([SSH]);
      current.close();
    });

    it('serializes against a concurrent logMessage so a parallel prompt survives', async () => {
      // The purge is fire-and-forget, so the user can type the next prompt
      // while it is still in flight. Without the shared write queue the
      // purge's read/filter/write would clobber that prompt.
      const current = await afterDoomedPrompt();

      const purge = current.removeSessionMessages('doomed-session');
      const logged = current.logMessage(USER, 'typed while deleting');

      const [purged] = await Promise.all([purge, logged]);
      expect(purged).toBe(true);
      expect(await messagesOnDisk()).toEqual(['typed while deleting']);
      current.close();
    });

    it('purges a whole batch in ONE file rewrite', async () => {
      // Per-id calls each read, filter and rewrite the entire project-shared file,
      // and the next logMessage queues behind all of them.
      await logPromptAs('doomed-a', SSH);
      await logPromptAs('doomed-b', 'cat ~/.aws/credentials');
      await logPromptAs('kept-session', 'what does this repo do?');
      const current = await currentSessionLogger();
      vi.mocked(atomicWriteFile).mockClear();

      expect(
        await current.removeSessionsMessages(['doomed-a', 'doomed-b']),
      ).toBe(true);

      expect(vi.mocked(atomicWriteFile)).toHaveBeenCalledTimes(1);
      expect(await sessionsOnDisk()).toEqual(['kept-session']);
      current.close();
    });

    it('does not re-adopt rows a queued purge already dropped', async () => {
      // Each queued op assigns the cache from its OWN disk snapshot, which still holds
      // the rows of the purge behind it. Without the pending-purge filter the first op
      // puts the second session's prompts back, and a read in that window returns a
      // prompt from a session the user was just told was deleted.
      await logPromptAs('doomed-a', SSH);
      await logPromptAs('doomed-b', 'cat ~/.aws/credentials');
      const current = await currentSessionLogger();

      const first = current.removeSessionMessages('doomed-a');
      const second = current.removeSessionMessages('doomed-b');

      expect(await first).toBe(true);
      // After only the FIRST has resolved, neither session may be observable.
      expect(await history(current)).toEqual([]);
      expect(await second).toBe(true);
      expect(await readLogFile()).toEqual([]);
      current.close();
    });

    it.each([
      ['logMessage', (l: Logger) => l.logMessage(USER, 'typed while deleting')],
      ['removeLastUserMessage', (l: Logger) => l.removeLastUserMessage()],
    ])(
      'does not re-adopt purged rows from a %s queued ahead of the purge',
      async (_name, queueAhead) => {
        // That op's disk snapshot still holds the rows the purge behind it has
        // already dropped from the cache.
        const current = await afterDoomedPrompt();
        await current.logMessage(USER, 'cancelled prompt');

        const ahead = queueAhead(current);
        const purge = current.removeSessionMessages('doomed-session');

        await ahead;
        // The op ahead has landed; the purge behind it has not written yet.
        expect(await history(current)).not.toContain(SSH);
        expect(await purge).toBe(true);
        expect(await sessionsOnDisk()).not.toContain('doomed-session');
        current.close();
      },
    );

    it('does not re-adopt purged rows from an undo whose row is already gone', async () => {
      const current = await afterDoomedPrompt();
      await current.logMessage(USER, 'cancelled prompt');
      // Another instance drops the undo target from disk first, so the undo takes
      // the branch that adopts its snapshot without writing.
      const other = await currentSessionLogger();
      await other.removeSessionMessages('current-session');
      other.close();

      const undo = current.removeLastUserMessage();
      const purge = current.removeSessionMessages('doomed-session');

      expect(await undo).toBe(false);
      expect(await history(current)).toEqual([]);
      expect(await purge).toBe(true);
      expect(await readLogFile()).toEqual([]);
      current.close();
    });

    it('keeps the row an append ahead of a failed purge wrote, and the purged rows', async () => {
      // The append filters pending purges out of the cache it adopts, but not out of
      // the file it writes, and not its own row: the purge's rollback only restores
      // the rows the purge itself removed.
      const current = await afterDoomedPrompt();
      vi.mocked(atomicWriteFile)
        .mockImplementationOnce(realAtomicWriteFile)
        .mockRejectedValueOnce(new Error('Disk full'));

      const logged = current.logMessage(USER, 'typed while deleting');
      const purge = current.removeSessionsMessages([
        'doomed-session',
        'current-session',
      ]);

      await logged;
      expect(await purge).toBe(false);
      expect(await messagesOnDisk()).toEqual([SSH, 'typed while deleting']);
      expect(await history(current)).toEqual(['typed while deleting', SSH]);
      current.close();
    });

    it('stops hiding a session once its purge has failed', async () => {
      // A failed purge leaves its rows on disk. If its id stayed pending, the next
      // purge would still filter those rows out of the cache it adopts.
      await logPromptAs('doomed-a', SSH);
      await logPromptAs('doomed-b', 'cat ~/.aws/credentials');
      const current = await currentSessionLogger();

      failNextWrite();
      expect(await current.removeSessionMessages('doomed-a')).toBe(false);
      expect(await current.removeSessionMessages('doomed-b')).toBe(true);

      expect(await history(current)).toEqual([SSH]);
      expect(await messagesOnDisk()).toEqual([SSH]);
      current.close();
    });

    it('keeps a queued purge applied when the purge ahead of it finds nothing', async () => {
      await logPromptAs('doomed-b', SSH);
      const current = await currentSessionLogger();

      const first = current.removeSessionMessages('never-logged');
      const second = current.removeSessionMessages('doomed-b');

      expect(await first).toBe(false);
      // The first op adopted a disk snapshot that still holds doomed-b's row.
      expect(await history(current)).toEqual([]);
      expect(await second).toBe(true);
      expect(await readLogFile()).toEqual([]);
      current.close();
    });

    it('purges rows this logger has never seen on disk', async () => {
      // The helper above initializes the purging logger AFTER the writes, so its cache
      // is warm. The multi-instance shape is the one where the purge is the only thing
      // that can clean the shared file: a logger that started BEFORE those rows existed.
      const current = await currentSessionLogger(); // cache: empty
      await logPromptAs('doomed-session', SSH);

      expect(await current.removeSessionMessages('doomed-session')).toBe(true);

      expect(await readLogFile()).toEqual([]);
      current.close();
    });

    it('clears a pending undo target that belonged to the purged session', async () => {
      // Otherwise removeLastUserMessage would still be pointing at a row the
      // purge deleted. Also covers purging the logger's own session.
      const doomed = await initLogger('doomed-session');
      await doomed.logMessage(USER, SSH);
      expect(doomed['lastLoggedUserEntry']).not.toBeNull();

      expect(await doomed.removeSessionMessages('doomed-session')).toBe(true);

      expect(doomed['lastLoggedUserEntry']).toBeNull();
      expect(await doomed.removeLastUserMessage()).toBe(false);
      expect(await readLogFile()).toEqual([]);
      doomed.close();
    });
  });
});

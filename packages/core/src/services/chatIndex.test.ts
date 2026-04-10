/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';

// Mock os.homedir to avoid writing to real home directory
// Must use vi.hoisted because vi.mock is hoisted to the top
const { mockHomeDir } = vi.hoisted(() => ({
  mockHomeDir: require('path').join(process.env['TEMP'] || '/tmp', 'mock-home-test'),
}));

vi.mock('node:os', () => ({
  default: {
    homedir: () => mockHomeDir,
  },
}));

import path from 'node:path';
import {
  saveSessionToIndex,
  deleteSessionFromIndex,
  getSessionIdByName,
  listNamedSessions,
  readChatIndex,
} from './chatIndex.js';

describe('chatIndex', () => {
  const qwenDir = path.join(mockHomeDir, '.qwen');
  const indexPath = path.join(qwenDir, 'chat-index.json');

  beforeEach(async () => {
    // Clean up mock directory
    try {
      await fs.rm(mockHomeDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  afterEach(async () => {
    // Clean up
    try {
      await fs.rm(mockHomeDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('saveSessionToIndex', () => {
    it('should save a session to the index', async () => {
      const name = 'test-session';
      const sessionId = 'session-123';

      await saveSessionToIndex(name, sessionId);

      const index = await readChatIndex();
      expect(index[name]).toBe(sessionId);
    });

    it('should overwrite an existing session with the same name', async () => {
      const name = 'test-session';
      const sessionId1 = 'session-123';
      const sessionId2 = 'session-456';

      await saveSessionToIndex(name, sessionId1);
      await saveSessionToIndex(name, sessionId2);

      const index = await readChatIndex();
      expect(index[name]).toBe(sessionId2);
    });

    it('should create the .qwen directory if it does not exist', async () => {
      const name = 'test-session';
      const sessionId = 'session-123';

      await saveSessionToIndex(name, sessionId);

      const stat = await fs.stat(qwenDir);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe('deleteSessionFromIndex', () => {
    it('should delete a session from the index', async () => {
      const name = 'test-session';
      const sessionId = 'session-123';

      await saveSessionToIndex(name, sessionId);
      const deleted = await deleteSessionFromIndex(name);

      expect(deleted).toBe(true);
      const index = await readChatIndex();
      expect(index[name]).toBeUndefined();
    });

    it('should return false if session does not exist', async () => {
      const deleted = await deleteSessionFromIndex('nonexistent');
      expect(deleted).toBe(false);
    });
  });

  describe('getSessionIdByName', () => {
    it('should return the session ID if it exists', async () => {
      const name = 'test-session';
      const sessionId = 'session-123';

      await saveSessionToIndex(name, sessionId);
      const foundId = await getSessionIdByName(name);

      expect(foundId).toBe(sessionId);
    });

    it('should return undefined if session does not exist', async () => {
      const foundId = await getSessionIdByName('nonexistent');
      expect(foundId).toBeUndefined();
    });
  });

  describe('listNamedSessions', () => {
    it('should return all named sessions', async () => {
      await saveSessionToIndex('session1', 'id-1');
      await saveSessionToIndex('session2', 'id-2');

      const sessions = await listNamedSessions();

      expect(Object.keys(sessions)).toHaveLength(2);
      expect(sessions['session1']).toBe('id-1');
      expect(sessions['session2']).toBe('id-2');
    });

    it('should return empty object when no sessions exist', async () => {
      const sessions = await listNamedSessions();
      expect(Object.keys(sessions)).toHaveLength(0);
    });
  });

  describe('readChatIndex', () => {
    it('should return empty object when file does not exist', async () => {
      const index = await readChatIndex();
      expect(index).toEqual({});
    });

    it('should handle corrupted index files gracefully', async () => {
      await fs.mkdir(qwenDir, { recursive: true });
      await fs.writeFile(indexPath, 'invalid json', 'utf-8');

      const index = await readChatIndex();
      expect(index).toEqual({});
    });
  });
});

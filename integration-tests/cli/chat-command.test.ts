/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E test for /chat command functionality
 * Tests the underlying chat index and session management APIs directly
 * since slash commands require interactive TUI which is not available on Windows
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// Import the core functions that /chat command uses
import {
  saveSessionToIndex,
  deleteSessionFromIndex,
  getSessionIdByName,
  listNamedSessions,
} from '@qwen-code/qwen-code-core';

describe('/chat command E2E - Core API Tests', () => {
  let testDir: string;

  beforeAll(async () => {
    // Create a temporary test directory
    testDir = path.join(os.tmpdir(), 'chat-e2e-test-' + Date.now());
    await fs.mkdir(testDir, { recursive: true });
  });

  afterAll(async () => {
    // Clean up
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('chat list functionality', () => {
    it('should start with no saved sessions (empty .qwen directory)', async () => {
      const sessions = await listNamedSessions(testDir);
      expect(Object.keys(sessions).length).toBe(0);
    });
  });

  describe('chat save functionality', () => {
    it('should save a session to the index', async () => {
      const sessionId = 'test-session-id-001';
      const sessionName = 'test-session-1';

      await saveSessionToIndex(testDir, sessionName, sessionId);

      // Verify it was saved
      const sessions = await listNamedSessions(testDir);
      expect(sessions[sessionName]).toBe(sessionId);
    });

    it('should save multiple sessions', async () => {
      const sessionId1 = 'test-session-id-002';
      const sessionId2 = 'test-session-id-003';

      await saveSessionToIndex(testDir, 'session-alpha', sessionId1);
      await saveSessionToIndex(testDir, 'session-beta', sessionId2);

      const sessions = await listNamedSessions(testDir);
      expect(sessions['session-alpha']).toBe(sessionId1);
      expect(sessions['session-beta']).toBe(sessionId2);
    });
  });

  describe('chat list after saves', () => {
    it('should list all saved sessions', async () => {
      const sessions = await listNamedSessions(testDir);
      const names = Object.keys(sessions);

      expect(names.length).toBeGreaterThanOrEqual(3);
      expect(names).toContain('test-session-1');
      expect(names).toContain('session-alpha');
      expect(names).toContain('session-beta');
    });
  });

  describe('chat resume functionality', () => {
    it('should get session ID by name for existing session', async () => {
      const sessionId = await getSessionIdByName(testDir, 'test-session-1');
      expect(sessionId).toBe('test-session-id-001');
    });

    it('should return undefined for non-existent session', async () => {
      const sessionId = await getSessionIdByName(
        testDir,
        'non-existent-session',
      );
      expect(sessionId).toBeUndefined();
    });
  });

  describe('chat delete functionality', () => {
    it('should delete a session from the index', async () => {
      const result = await deleteSessionFromIndex(testDir, 'test-session-1');
      expect(result).toBe(true);

      // Verify it's deleted
      const sessions = await listNamedSessions(testDir);
      expect(sessions['test-session-1']).toBeUndefined();
    });

    it('should return false when deleting non-existent session', async () => {
      const result = await deleteSessionFromIndex(
        testDir,
        'non-existent-session',
      );
      expect(result).toBe(false);
    });

    it('should delete all sessions and leave empty index', async () => {
      // Delete remaining sessions
      await deleteSessionFromIndex(testDir, 'session-alpha');
      await deleteSessionFromIndex(testDir, 'session-beta');

      const sessions = await listNamedSessions(testDir);
      expect(Object.keys(sessions).length).toBe(0);
    });
  });

  describe('chat-index.json file management', () => {
    it('should create .qwen/chat-index.json file', async () => {
      // Save a session to create the file
      await saveSessionToIndex(testDir, 'temp-session', 'temp-id-001');

      const indexPath = path.join(testDir, '.qwen', 'chat-index.json');

      // Verify file exists
      const stat = await fs.stat(indexPath);
      expect(stat.isFile()).toBe(true);

      // Verify content
      const content = await fs.readFile(indexPath, 'utf-8');
      const index = JSON.parse(content);
      expect(index['temp-session']).toBe('temp-id-001');

      // Clean up
      await deleteSessionFromIndex(testDir, 'temp-session');
    });

    it('should handle session file deletion gracefully', async () => {
      // Create a session
      const sessionId = 'orphan-session-id';
      await saveSessionToIndex(testDir, 'orphan-session', sessionId);

      // Note: The session file would normally be in the chats directory
      // We're testing that delete works even if session file is missing

      // Delete from index (session file doesn't actually exist)
      const indexDeleted = await deleteSessionFromIndex(
        testDir,
        'orphan-session',
      );
      expect(indexDeleted).toBe(true);

      // Verify it's removed from index
      const sessions = await listNamedSessions(testDir);
      expect(sessions['orphan-session']).toBeUndefined();
    });
  });

  describe('edge cases and error handling', () => {
    it('should handle special characters in session names', async () => {
      const specialName = 'session-with-special_name.123';
      const sessionId = 'special-id-001';

      await saveSessionToIndex(testDir, specialName, sessionId);

      const retrieved = await getSessionIdByName(testDir, specialName);
      expect(retrieved).toBe(sessionId);

      // Clean up
      await deleteSessionFromIndex(testDir, specialName);
    });

    it('should overwrite existing session with same name', async () => {
      const name = 'overwrite-test';
      const sessionId1 = 'old-session-id';
      const sessionId2 = 'new-session-id';

      // Save with same name twice
      await saveSessionToIndex(testDir, name, sessionId1);
      await saveSessionToIndex(testDir, name, sessionId2);

      // Should have the new ID
      const retrieved = await getSessionIdByName(testDir, name);
      expect(retrieved).toBe(sessionId2);

      // Clean up
      await deleteSessionFromIndex(testDir, name);
    });
  });
});

/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GoalStorage } from './GoalStorage.js';
import { type Goal, GoalStatus } from './types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'goal-storage-test-'));
}

function sampleGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: 'test-id-001',
    objective: 'Sample objective',
    status: GoalStatus.Active,
    turnsUsed: 2,
    timeUsedSeconds: 5,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('GoalStorage', () => {
  let tempDir: string;
  let storage: GoalStorage;

  beforeEach(() => {
    tempDir = makeTempDir();
    storage = new GoalStorage(tempDir, 'test-session');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ── Basic read/write ─────────────────────────────────────────────────

  describe('basic read/write', () => {
    it('save then load returns the same data', () => {
      const goal = sampleGoal();
      storage.save(goal);

      // Create a fresh storage instance to bypass in-memory cache
      const freshStorage = new GoalStorage(tempDir, 'test-session');
      const loaded = freshStorage.load();

      expect(loaded).toEqual(goal);
    });

    it('persists customContext across storage instances', () => {
      const customContext = Object.freeze({ tenant: 'alpha' });
      storage.save(sampleGoal({ customContext }));

      const freshStorage = new GoalStorage(tempDir, 'test-session');
      expect(freshStorage.load()?.customContext).toEqual(customContext);
    });

    it('load returns null when file does not exist', () => {
      const emptyDir = makeTempDir();
      try {
        const emptyStorage = new GoalStorage(emptyDir, 'test-session');
        expect(emptyStorage.load()).toBeNull();
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    it('delete then load returns null', () => {
      const goal = sampleGoal();
      storage.save(goal);
      storage.delete();

      // Fresh instance to skip cache
      const freshStorage = new GoalStorage(tempDir, 'test-session');
      expect(freshStorage.load()).toBeNull();
    });
  });

  // ── Error handling ───────────────────────────────────────────────────

  describe('error handling', () => {
    it('load returns null for invalid JSON (does not throw)', () => {
      const goalsDir = path.join(tempDir, 'goals');
      fs.mkdirSync(goalsDir, { recursive: true });
      fs.writeFileSync(
        path.join(goalsDir, 'test-session.json'),
        '{bad json!!!',
      );

      const corruptStorage = new GoalStorage(tempDir, 'test-session');
      expect(corruptStorage.load()).toBeNull();
    });

    it('save auto-creates the goals directory', () => {
      const freshDir = makeTempDir();
      try {
        const freshStorage = new GoalStorage(freshDir, 'test-session');
        const goal = sampleGoal();

        // Directory doesn't exist yet
        expect(fs.existsSync(path.join(freshDir, 'goals'))).toBe(false);

        freshStorage.save(goal);

        // Now it should exist
        expect(fs.existsSync(path.join(freshDir, 'goals'))).toBe(true);
      } finally {
        fs.rmSync(freshDir, { recursive: true, force: true });
      }
    });
  });

  // ── Caching ──────────────────────────────────────────────────────────

  describe('caching', () => {
    it('second load uses cache (no extra file read)', () => {
      const goal = sampleGoal();
      storage.save(goal);

      // First load (populates cache internally via save)
      const first = storage.load();
      // Overwrite the file with different content
      const goalsDir = path.join(tempDir, 'goals');
      fs.writeFileSync(
        path.join(goalsDir, 'test-session.json'),
        JSON.stringify(sampleGoal({ objective: 'Changed on disk' })),
      );
      // Second load should return cached value, not the new file content
      const second = storage.load();
      expect(second).toEqual(first);
    });

    it('save updates the cache', () => {
      const goal1 = sampleGoal({ objective: 'First' });
      storage.save(goal1);
      expect(storage.load()?.objective).toBe('First');

      const goal2 = sampleGoal({ objective: 'Second' });
      storage.save(goal2);
      expect(storage.load()?.objective).toBe('Second');
    });

    it('delete clears the cache', () => {
      storage.save(sampleGoal());
      storage.delete();
      expect(storage.load()).toBeNull();
    });
  });
});

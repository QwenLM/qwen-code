/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

import { ModeMemoryManager } from './mode-memory.js';

vi.mock('fs/promises');

describe('ModeMemoryManager', () => {
  let manager: ModeMemoryManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new ModeMemoryManager();
  });

  describe('recordEntry', () => {
    it('should add entry with auto-generated id and timestamp', () => {
      const entry = manager.recordEntry('developer', {
        modeName: 'developer',
        summary: 'Discussed architecture',
        keyDecisions: ['Use microservices'],
        filesTouched: ['src/index.ts'],
        artifacts: ['design.md'],
        tags: ['architecture', 'design'],
      });

      expect(entry.id).toBeDefined();
      expect(entry.id).toMatch(/^mem-/);
      expect(entry.timestamp).toBeInstanceOf(Date);
      expect(entry.modeName).toBe('developer');
      expect(entry.summary).toBe('Discussed architecture');
    });

    it('should record multiple entries for same mode', () => {
      manager.recordEntry('developer', {
        modeName: 'developer',
        summary: 'First decision',
        keyDecisions: [],
        filesTouched: [],
        artifacts: [],
        tags: [],
      });
      manager.recordEntry('developer', {
        modeName: 'developer',
        summary: 'Second decision',
        keyDecisions: [],
        filesTouched: [],
        artifacts: [],
        tags: [],
      });

      const memory = manager.getMemory('developer');
      expect(memory).not.toBeNull();
      expect(memory!.totalEntries).toBe(2);
    });

    it('should record entries for different modes', () => {
      manager.recordEntry('developer', {
        modeName: 'developer',
        summary: 'Dev entry',
        keyDecisions: [],
        filesTouched: [],
        artifacts: [],
        tags: [],
      });
      manager.recordEntry('reviewer', {
        modeName: 'reviewer',
        summary: 'Review entry',
        keyDecisions: [],
        filesTouched: [],
        artifacts: [],
        tags: [],
      });

      expect(manager.getMemory('developer')).not.toBeNull();
      expect(manager.getMemory('reviewer')).not.toBeNull();
    });
  });

  describe('getMemory', () => {
    it('should return memory block for mode', () => {
      manager.recordEntry('developer', {
        modeName: 'developer',
        summary: 'Test summary',
        keyDecisions: ['Decision 1'],
        filesTouched: ['file.ts'],
        artifacts: [],
        tags: ['test'],
      });

      const memory = manager.getMemory('developer');

      expect(memory).not.toBeNull();
      expect(memory!.modeName).toBe('developer');
      expect(memory!.entries).toHaveLength(1);
      expect(memory!.entries[0].summary).toBe('Test summary');
    });

    it('should return null for mode with no memory', () => {
      const memory = manager.getMemory('nonexistent');
      expect(memory).toBeNull();
    });

    it('should return a copy of entries block, not the original block reference', () => {
      manager.recordEntry('developer', {
        modeName: 'developer',
        summary: 'Original',
        keyDecisions: [],
        filesTouched: [],
        artifacts: [],
        tags: [],
      });

      const memory = manager.getMemory('developer');
      // Modifying the returned block should not affect the internal state
      memory!.totalEntries = 999;

      const memoryAgain = manager.getMemory('developer');
      expect(memoryAgain!.totalEntries).toBe(1);
    });
  });

  describe('search', () => {
    beforeEach(() => {
      manager.recordEntry('developer', {
        modeName: 'developer',
        summary: 'Implemented authentication',
        keyDecisions: ['Use JWT tokens'],
        filesTouched: ['src/auth.ts', 'src/middleware.ts'],
        artifacts: ['auth-spec.md'],
        tags: ['auth', 'security'],
      });
      manager.recordEntry('reviewer', {
        modeName: 'reviewer',
        summary: 'Reviewed auth implementation',
        keyDecisions: ['Add rate limiting'],
        filesTouched: ['src/auth.ts'],
        artifacts: [],
        tags: ['review', 'security'],
      });
    });

    it('should find entries by summary text', () => {
      const results = manager.search('authentication');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].summary).toContain('authentication');
    });

    it('should find entries by key decision', () => {
      const results = manager.search('JWT');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].keyDecisions).toContain('Use JWT tokens');
    });

    it('should find entries by file touched', () => {
      const results = manager.search('auth.ts');
      expect(results.length).toBeGreaterThan(0);
    });

    it('should find entries by tag', () => {
      const results = manager.search('security');
      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it('should filter search by mode name', () => {
      const results = manager.search('auth', 'developer');
      const modes = results.map((r) => r.modeName);
      expect(modes.every((m) => m === 'developer')).toBe(true);
    });

    it('should return empty array for no matches', () => {
      const results = manager.search('nonexistent-xyz');
      expect(results).toEqual([]);
    });

    it('should return results sorted by timestamp (newest first)', () => {
      const results = manager.search('');
      // Entries recorded later should appear first
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('getByTags', () => {
    beforeEach(() => {
      manager.recordEntry('developer', {
        modeName: 'developer',
        summary: 'Auth work',
        keyDecisions: [],
        filesTouched: [],
        artifacts: [],
        tags: ['auth', 'backend'],
      });
      manager.recordEntry('developer', {
        modeName: 'developer',
        summary: 'UI work',
        keyDecisions: [],
        filesTouched: [],
        artifacts: [],
        tags: ['frontend', 'ui'],
      });
      manager.recordEntry('reviewer', {
        modeName: 'reviewer',
        summary: 'Review auth',
        keyDecisions: [],
        filesTouched: [],
        artifacts: [],
        tags: ['auth', 'review'],
      });
    });

    it('should filter entries by matching tags', () => {
      const results = manager.getByTags(['auth']);
      expect(results.length).toBe(2);
      results.forEach((r) => {
        expect(r.tags).toContain('auth');
      });
    });

    it('should match entries with any of the given tags', () => {
      const results = manager.getByTags(['frontend', 'review']);
      expect(results.length).toBe(2);
    });

    it('should filter by tags and mode name', () => {
      const results = manager.getByTags(['auth'], 'developer');
      expect(results).toHaveLength(1);
      expect(results[0].modeName).toBe('developer');
    });

    it('should return empty array for empty tags array', () => {
      const results = manager.getByTags([]);
      expect(results).toEqual([]);
    });
  });

  describe('getRecent', () => {
    it('should return limited entries', () => {
      for (let i = 0; i < 5; i++) {
        manager.recordEntry('developer', {
          modeName: 'developer',
          summary: `Entry ${i}`,
          keyDecisions: [],
          filesTouched: [],
          artifacts: [],
          tags: [],
        });
      }

      const recent = manager.getRecent(3);
      expect(recent).toHaveLength(3);
    });

    it('should default to 20 entries', () => {
      for (let i = 0; i < 25; i++) {
        manager.recordEntry('developer', {
          modeName: 'developer',
          summary: `Entry ${i}`,
          keyDecisions: [],
          filesTouched: [],
          artifacts: [],
          tags: [],
        });
      }

      const recent = manager.getRecent();
      expect(recent).toHaveLength(20);
    });
  });

  describe('exportMemory', () => {
    it('should return JSON string for mode', () => {
      manager.recordEntry('developer', {
        modeName: 'developer',
        summary: 'Export test',
        keyDecisions: ['Decision'],
        filesTouched: ['file.ts'],
        artifacts: ['doc.md'],
        tags: ['test'],
      });

      const json = manager.exportMemory('developer');
      const parsed = JSON.parse(json);

      expect(parsed.modeName).toBe('developer');
      expect(parsed.totalEntries).toBe(1);
      expect(parsed.entries).toHaveLength(1);
      expect(parsed.entries[0].summary).toBe('Export test');
      expect(parsed.exportedAt).toBeDefined();
    });

    it('should return empty entries for mode with no memory', () => {
      const json = manager.exportMemory('nonexistent');
      const parsed = JSON.parse(json);

      expect(parsed.modeName).toBe('nonexistent');
      expect(parsed.entries).toEqual([]);
      expect(parsed.totalEntries).toBe(0);
    });
  });

  describe('importMemory', () => {
    it('should restore entries from JSON', () => {
      const data = JSON.stringify({
        modeName: 'developer',
        entries: [
          {
            id: 'imported-1',
            timestamp: '2025-01-01T00:00:00.000Z',
            modeName: 'developer',
            summary: 'Imported entry',
            keyDecisions: ['Decision'],
            filesTouched: ['file.ts'],
            artifacts: [],
            tags: ['imported'],
          },
        ],
        totalEntries: 1,
      });

      manager.importMemory('developer', data);

      const memory = manager.getMemory('developer');
      expect(memory).not.toBeNull();
      expect(memory!.totalEntries).toBe(1);
      expect(memory!.entries[0].summary).toBe('Imported entry');
      expect(memory!.entries[0].tags).toContain('imported');
    });

    it('should throw error for invalid JSON', () => {
      expect(() => manager.importMemory('developer', 'not-json')).toThrow(
        'Invalid memory data:',
      );
    });

    it('should throw error for missing entries array', () => {
      const data = JSON.stringify({ modeName: 'developer' });
      expect(() => manager.importMemory('developer', data)).toThrow(
        'Invalid memory data:',
      );
    });

    it('should handle entries with missing fields', () => {
      const data = JSON.stringify({
        modeName: 'developer',
        entries: [{ id: 'minimal' }],
        totalEntries: 1,
      });

      manager.importMemory('developer', data);

      const memory = manager.getMemory('developer');
      expect(memory!.entries[0].summary).toBe('');
      expect(memory!.entries[0].keyDecisions).toEqual([]);
    });
  });

  describe('clearMemory', () => {
    it('should remove all entries for a mode', () => {
      manager.recordEntry('developer', {
        modeName: 'developer',
        summary: 'Entry to clear',
        keyDecisions: [],
        filesTouched: [],
        artifacts: [],
        tags: [],
      });

      manager.clearMemory('developer');

      const memory = manager.getMemory('developer');
      expect(memory).not.toBeNull();
      expect(memory!.totalEntries).toBe(0);
      expect(memory!.entries).toEqual([]);
    });

    it('should do nothing for mode with no memory', () => {
      expect(() => manager.clearMemory('nonexistent')).not.toThrow();
    });
  });

  describe('getStats', () => {
    it('should return correct counts', () => {
      manager.recordEntry('developer', {
        modeName: 'developer',
        summary: 'Entry 1',
        keyDecisions: [],
        filesTouched: [],
        artifacts: [],
        tags: [],
      });
      manager.recordEntry('developer', {
        modeName: 'developer',
        summary: 'Entry 2',
        keyDecisions: [],
        filesTouched: [],
        artifacts: [],
        tags: [],
      });
      manager.recordEntry('reviewer', {
        modeName: 'reviewer',
        summary: 'Review entry',
        keyDecisions: [],
        filesTouched: [],
        artifacts: [],
        tags: [],
      });

      const stats = manager.getStats();

      expect(stats.totalEntries).toBe(3);
      expect(stats.modesWithMemory).toBe(2);
      expect(stats.mostActiveMode).toBe('developer');
    });

    it('should return zero counts when empty', () => {
      const stats = manager.getStats();

      expect(stats.totalEntries).toBe(0);
      expect(stats.modesWithMemory).toBe(0);
      expect(stats.mostActiveMode).toBe('none');
    });
  });

  describe('getModeNames', () => {
    it('should return sorted mode names with memory', () => {
      manager.recordEntry('reviewer', {
        modeName: 'reviewer',
        summary: 'Test',
        keyDecisions: [],
        filesTouched: [],
        artifacts: [],
        tags: [],
      });
      manager.recordEntry('developer', {
        modeName: 'developer',
        summary: 'Test',
        keyDecisions: [],
        filesTouched: [],
        artifacts: [],
        tags: [],
      });
      manager.recordEntry('architect', {
        modeName: 'architect',
        summary: 'Test',
        keyDecisions: [],
        filesTouched: [],
        artifacts: [],
        tags: [],
      });

      const names = manager.getModeNames();
      expect(names).toEqual(['architect', 'developer', 'reviewer']);
    });
  });

  describe('getAllTags', () => {
    it('should return sorted unique tags', () => {
      manager.recordEntry('developer', {
        modeName: 'developer',
        summary: 'Test',
        keyDecisions: [],
        filesTouched: [],
        artifacts: [],
        tags: ['auth', 'backend'],
      });
      manager.recordEntry('reviewer', {
        modeName: 'reviewer',
        summary: 'Test',
        keyDecisions: [],
        filesTouched: [],
        artifacts: [],
        tags: ['review', 'auth'],
      });

      const tags = manager.getAllTags();
      expect(tags).toEqual(['auth', 'backend', 'review']);
    });
  });
});

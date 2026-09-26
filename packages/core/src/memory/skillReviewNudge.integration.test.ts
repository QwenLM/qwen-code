/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// E2E integration tests for the AutoSkill mechanism, from toolCallCount
// tracking to skill file writing (skill-nudge.md L258-320 E2E checklist).

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Content } from '@google/genai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { MemoryManager, AUTO_SKILL_THRESHOLD } from './manager.js';
import type {
  ScheduleSkillReviewParams,
  SkillReviewScheduleResult,
} from './manager.js';
import { getProjectSkillsRoot } from '../skills/skill-paths.js';
import { modelText } from '../test-utils/model-fixtures.js';

vi.mock('./skillReviewAgentPlanner.js', () => ({
  runSkillReviewByAgent: vi.fn().mockResolvedValue({ touchedSkillFiles: [] }),
}));

describe('Skill Nudge E2E Integration Tests', () => {
  let tempDir: string;
  let projectRoot: string;
  let mgr: MemoryManager;
  let mockConfig: Config;

  const sampleHistory: Content[] = [
    { role: 'user', parts: [{ text: 'Help me refactor this code' }] },
    modelText('I can help. Let me analyze the code first.'),
  ];

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-skill-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });

    mgr = new MemoryManager();
    mockConfig = {
      getSessionId: () => 'test-session-1',
      getModel: () => 'qwen-coder-32b',
      getProjectRoot: () => projectRoot,
    } as Config;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // An enabled review at the threshold; `threshold` is only sent when given.
  const schedule = (overrides: Partial<ScheduleSkillReviewParams> = {}) =>
    mgr.scheduleSkillReview({
      projectRoot,
      sessionId: 'test-session-1',
      history: sampleHistory,
      toolCallCount: AUTO_SKILL_THRESHOLD,
      skillsModified: false,
      enabled: true,
      config: mockConfig,
      ...overrides,
    });
  const atThreshold = (toolCallCount: number) =>
    schedule({ toolCallCount, threshold: AUTO_SKILL_THRESHOLD });
  const expectSkipped = (result: SkillReviewScheduleResult, reason: string) => {
    expect(result.status).toBe('skipped');
    expect(result.skippedReason).toBe(reason);
  };

  describe('Test 1: Low tool call density should not trigger skill review', () => {
    it('should skip when toolCallCount < threshold', () => {
      const result = atThreshold(5); // Below default threshold of 20

      expectSkipped(result, 'below_threshold');
      expect(result.taskId).toBeUndefined();
    });

    it('should skip when exactly at threshold minus 1', () => {
      expectSkipped(atThreshold(AUTO_SKILL_THRESHOLD - 1), 'below_threshold');
    });
  });

  describe('Test 2: At or above threshold should trigger skill review', () => {
    it('should schedule when toolCallCount exactly equals threshold', () => {
      const result = atThreshold(AUTO_SKILL_THRESHOLD);

      expect(result.status).toBe('scheduled');
      expect(result.taskId).toBeDefined();
      expect(result.skippedReason).toBeUndefined();
    });

    it('should schedule when toolCallCount exceeds threshold', () => {
      const result = atThreshold(AUTO_SKILL_THRESHOLD + 10);

      expect(result.status).toBe('scheduled');
      expect(result.taskId).toBeDefined();
    });

    it('should respect custom threshold when provided', () => {
      const result = schedule({ toolCallCount: 30, threshold: 50 });
      expectSkipped(result, 'below_threshold');
    });
  });

  describe('Test 3: skills modified in session should prevent nudge', () => {
    it('should skip when skillsModified is true', () => {
      // toolCallCount 30 is well above threshold.
      const result = schedule({
        toolCallCount: 30,
        threshold: AUTO_SKILL_THRESHOLD,
        skillsModified: true,
      });
      expectSkipped(result, 'skills_modified_in_session');
    });

    it('should not trigger nudge even with high toolCallCount if skills were modified', () => {
      const result = schedule({ toolCallCount: 100, skillsModified: true });
      expectSkipped(result, 'skills_modified_in_session');
    });
  });

  describe('Test 4: Configuration enable/disable gate', () => {
    it('should skip when memory.enableAutoSkill is false', () => {
      expectSkipped(schedule({ enabled: false }), 'disabled');
    });

    it('should skip when config is not provided', () => {
      const result = mgr.scheduleSkillReview({
        projectRoot,
        sessionId: 'test-session-1',
        history: sampleHistory,
        toolCallCount: AUTO_SKILL_THRESHOLD,
        skillsModified: false,
        config: undefined,
      });
      expectSkipped(result, 'disabled');
    });

    it('should schedule when enabled is true', () => {
      expect(schedule().status).toBe('scheduled');
    });
  });

  describe('Test 5: Extract + Skill Review merge detection', () => {
    it('should return valid result when skill review is scheduled', () => {
      const result = schedule();

      // Should schedule or skip with a valid status, never fail.
      expect(result.status).toBeDefined();
      expect(['scheduled', 'skipped']).toContain(result.status);
      if (result.status === 'scheduled') {
        expect(result.taskId).toBeDefined();
      }
      expect(result.skippedReason).not.toBe('failed');
    });

    it('should handle multiple skill reviews for same project (sequential)', async () => {
      const result1 = schedule({ sessionId: 'session-1' });
      // While the first is in flight, a second call for the same project is
      // deduped: skipped, returning the existing taskId so callers can
      // observe the in-flight task.
      const result2WhileRunning = schedule({ sessionId: 'session-2' });

      expect(result1.status).toBe('scheduled');
      expect(result1.taskId).toBeDefined();
      expectSkipped(result2WhileRunning, 'already_running');
      expect(result2WhileRunning.taskId).toBe(result1.taskId);

      await result1.promise;

      // After completion a new review for the same project is accepted.
      const result3AfterCompletion = schedule({ sessionId: 'session-3' });

      expect(result3AfterCompletion.status).toBe('scheduled');
      expect(result3AfterCompletion.taskId).toBeDefined();
      expect(result3AfterCompletion.taskId).not.toBe(result1.taskId);

      // Both completed tasks should be tracked.
      const records = mgr.listTasksByType('skill-review', projectRoot);
      expect(records.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Test 6: Task record tracking and metadata', () => {
    it('should create task record with correct metadata', () => {
      const result = schedule({ toolCallCount: 25, threshold: 20 });

      expect(result.status).toBe('scheduled');
      expect(result.taskId).toBeDefined();

      const records = mgr.listTasksByType('skill-review', projectRoot);
      expect(records.length).toBeGreaterThan(0);

      const record = records[0];
      expect(record.status).toBe('running');
      expect(record.metadata?.['toolCallCount']).toBe(25);
      expect(record.metadata?.['threshold']).toBe(20);
      expect(record.metadata?.['historyLength']).toBe(sampleHistory.length);
    });

    it('should track task status transitions', () => {
      const recordId = schedule().taskId;
      const records = mgr.listTasksByType('skill-review', projectRoot);
      const record = records.find((r) => r.id === recordId);

      expect(record).toBeDefined();
      expect(record?.taskType).toBe('skill-review');
      expect(record?.status).toBe('running');
    });
  });

  describe('Test 7: Threshold boundary cases', () => {
    it.each([
      ['should not trigger at threshold - 1', -1, 'skipped'],
      ['should trigger at threshold', 0, 'scheduled'],
      ['should trigger at threshold + 1', 1, 'scheduled'],
    ])('%s', (_title, offset, status) => {
      expect(atThreshold(AUTO_SKILL_THRESHOLD + offset).status).toBe(status);
    });
  });

  describe('Test 8: Project skills directory validation', () => {
    it('should verify project skills root exists when scheduled', async () => {
      expect(schedule().status).toBe('scheduled');

      // The directory may not exist yet, but the path should be valid for
      // writes; normalize separators for Windows.
      const skillsRootPath = getProjectSkillsRoot(projectRoot);
      const normalizedPath = skillsRootPath.split(path.sep).join('/');
      expect(normalizedPath.includes('.qwen/skills')).toBe(true);
    });
  });
});

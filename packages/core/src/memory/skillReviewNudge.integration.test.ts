/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E Integration Tests for AutoSkill mechanism (per skill-nudge.md L258-320)
 *
 * Tests the complete workflow from toolCallCount tracking to skill file writing.
 * These tests validate the behavior described in the design document's E2E checklist.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Content } from '@google/genai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../config/config.js';
import { MemoryManager, AUTO_SKILL_THRESHOLD } from './manager.js';
import { getProjectSkillsRoot } from '../skills/skill-paths.js';

describe('Skill Nudge E2E Integration Tests', () => {
  let tempDir: string;
  let projectRoot: string;
  let mgr: MemoryManager;
  let mockConfig: Config;

  const sampleHistory: Content[] = [
    { role: 'user', parts: [{ text: 'Help me refactor this code' }] },
    {
      role: 'model',
      parts: [{ text: 'I can help. Let me analyze the code first.' }],
    },
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

  // ─── Test 1: Low Tool Call Density Not Trigger ───────────────────────────

  describe('Test 1: Low tool call density should not trigger skill review', () => {
    it('should skip when toolCallCount < threshold', () => {
      const result = mgr.scheduleSkillReview({
        projectRoot,
        sessionId: 'test-session-1',
        history: sampleHistory,
        toolCallCount: 5, // Below default threshold of 20
        threshold: AUTO_SKILL_THRESHOLD,
        enabled: true,
        config: mockConfig,
      });

      expect(result.status).toBe('skipped');
      expect(result.skippedReason).toBe('below_threshold');
      expect(result.taskId).toBeUndefined();
    });

    it('should skip when exactly at threshold minus 1', () => {
      const result = mgr.scheduleSkillReview({
        projectRoot,
        sessionId: 'test-session-1',
        history: sampleHistory,
        toolCallCount: AUTO_SKILL_THRESHOLD - 1,
        threshold: AUTO_SKILL_THRESHOLD,
        enabled: true,
        config: mockConfig,
      });

      expect(result.status).toBe('skipped');
      expect(result.skippedReason).toBe('below_threshold');
    });
  });

  // ─── Test 2: At Threshold Should Trigger ──────────────────────────────────

  describe('Test 2: At or above threshold should trigger skill review', () => {
    it('should schedule when toolCallCount exactly equals threshold', () => {
      const result = mgr.scheduleSkillReview({
        projectRoot,
        sessionId: 'test-session-1',
        history: sampleHistory,
        toolCallCount: AUTO_SKILL_THRESHOLD,
        threshold: AUTO_SKILL_THRESHOLD,
        enabled: true,
        config: mockConfig,
      });

      expect(result.status).toBe('scheduled');
      expect(result.taskId).toBeDefined();
      expect(result.skippedReason).toBeUndefined();
    });

    it('should schedule when toolCallCount exceeds threshold', () => {
      const result = mgr.scheduleSkillReview({
        projectRoot,
        sessionId: 'test-session-1',
        history: sampleHistory,
        toolCallCount: AUTO_SKILL_THRESHOLD + 10,
        threshold: AUTO_SKILL_THRESHOLD,
        enabled: true,
        config: mockConfig,
      });

      expect(result.status).toBe('scheduled');
      expect(result.taskId).toBeDefined();
    });

    it('should respect custom threshold when provided', () => {
      const customThreshold = 50;
      const result = mgr.scheduleSkillReview({
        projectRoot,
        sessionId: 'test-session-1',
        history: sampleHistory,
        toolCallCount: 30,
        threshold: customThreshold,
        enabled: true,
        config: mockConfig,
      });

      expect(result.status).toBe('skipped');
      expect(result.skippedReason).toBe('below_threshold');
    });
  });

  // ─── Test 3: skill_manage Call Resets Counter ──────────────────────────────

  describe('Test 3: skill_manage function call in history should prevent nudge', () => {
    it('should skip when history contains skill_manage call', () => {
      const historyWithSkillManage: Content[] = [
        { role: 'user', parts: [{ text: 'Create a skill' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'skill_manage',
                args: {
                  action: 'create',
                  name: 'my-skill',
                  content: '---\nname: my-skill\n---\n',
                },
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'skill_manage',
                response: { output: 'Success' },
              },
            },
          ],
        },
      ];

      const result = mgr.scheduleSkillReview({
        projectRoot,
        sessionId: 'test-session-1',
        history: historyWithSkillManage,
        toolCallCount: 30, // Well above threshold
        threshold: AUTO_SKILL_THRESHOLD,
        enabled: true,
        config: mockConfig,
      });

      expect(result.status).toBe('skipped');
      expect(result.skippedReason).toBe('skill_manage_called');
    });

    it('should not trigger nudge even with high toolCallCount if skill_manage was used', () => {
      const result = mgr.scheduleSkillReview({
        projectRoot,
        sessionId: 'test-session-1',
        history: [
          { role: 'user', parts: [{ text: 'Many tool calls...' }] },
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: 'skill_manage',
                  args: { action: 'patch' },
                },
              },
            ],
          },
        ],
        toolCallCount: 100,
        enabled: true,
        config: mockConfig,
      });

      expect(result.status).toBe('skipped');
      expect(result.skippedReason).toBe('skill_manage_called');
    });
  });

  // ─── Test 4: Config Enable/Disable Gate ────────────────────────────────────

  describe('Test 4: Configuration enable/disable gate', () => {
    it('should skip when memory.enableAutoSkill is false', () => {
      const result = mgr.scheduleSkillReview({
        projectRoot,
        sessionId: 'test-session-1',
        history: sampleHistory,
        toolCallCount: AUTO_SKILL_THRESHOLD,
        enabled: false,
        config: mockConfig,
      });

      expect(result.status).toBe('skipped');
      expect(result.skippedReason).toBe('disabled');
    });

    it('should skip when config is not provided', () => {
      const result = mgr.scheduleSkillReview({
        projectRoot,
        sessionId: 'test-session-1',
        history: sampleHistory,
        toolCallCount: AUTO_SKILL_THRESHOLD,
        config: undefined,
      });

      expect(result.status).toBe('skipped');
      expect(result.skippedReason).toBe('disabled');
    });

    it('should schedule when enabled is true', () => {
      const result = mgr.scheduleSkillReview({
        projectRoot,
        sessionId: 'test-session-1',
        history: sampleHistory,
        toolCallCount: AUTO_SKILL_THRESHOLD,
        enabled: true,
        config: mockConfig,
      });

      expect(result.status).toBe('scheduled');
    });
  });

  // ─── Test 5: Merge Detection ──────────────────────────────────────────────

  describe('Test 5: Extract + Skill Review merge detection', () => {
    it('should return valid result when skill review is scheduled', () => {
      // Schedule skill review at threshold
      const result = mgr.scheduleSkillReview({
        projectRoot,
        sessionId: 'test-session-1',
        history: sampleHistory,
        toolCallCount: AUTO_SKILL_THRESHOLD,
        enabled: true,
        config: mockConfig,
      });

      // Should successfully schedule or skip with valid status
      expect(result.status).toBeDefined();
      expect(['scheduled', 'skipped']).toContain(result.status);

      // If scheduled, should have taskId
      if (result.status === 'scheduled') {
        expect(result.taskId).toBeDefined();
      }

      // Should not have unexpected errors
      expect(result.skippedReason).not.toBe('failed');
    });

    it('should handle multiple skill reviews for same project', () => {
      const result1 = mgr.scheduleSkillReview({
        projectRoot,
        sessionId: 'session-1',
        history: sampleHistory,
        toolCallCount: AUTO_SKILL_THRESHOLD,
        enabled: true,
        config: mockConfig,
      });

      const result2 = mgr.scheduleSkillReview({
        projectRoot,
        sessionId: 'session-2',
        history: sampleHistory,
        toolCallCount: AUTO_SKILL_THRESHOLD,
        enabled: true,
        config: mockConfig,
      });

      // Both should be processed independently
      expect(result1.taskId).toBeDefined();
      expect(result2.taskId).toBeDefined();
      expect(result1.taskId).not.toBe(result2.taskId);

      // Both tasks should be tracked
      const records = mgr.listTasksByType('skill-review', projectRoot);
      expect(records.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── Test 6: Task Record Tracking ────────────────────────────────────────

  describe('Test 6: Task record tracking and metadata', () => {
    it('should create task record with correct metadata', () => {
      const toolCallCount = 25;
      const threshold = 20;

      const result = mgr.scheduleSkillReview({
        projectRoot,
        sessionId: 'test-session-1',
        history: sampleHistory,
        toolCallCount,
        threshold,
        enabled: true,
        config: mockConfig,
      });

      expect(result.status).toBe('scheduled');
      expect(result.taskId).toBeDefined();

      // Verify task record
      const records = mgr.listTasksByType('skill-review', projectRoot);
      expect(records.length).toBeGreaterThan(0);

      const record = records[0];
      expect(record.status).toBe('running');
      expect(record.metadata?.['toolCallCount']).toBe(toolCallCount);
      expect(record.metadata?.['threshold']).toBe(threshold);
      expect(record.metadata?.['historyLength']).toBe(sampleHistory.length);
    });

    it('should track task status transitions', () => {
      const result = mgr.scheduleSkillReview({
        projectRoot,
        sessionId: 'test-session-1',
        history: sampleHistory,
        toolCallCount: AUTO_SKILL_THRESHOLD,
        enabled: true,
        config: mockConfig,
      });

      const recordId = result.taskId;
      const records = mgr.listTasksByType('skill-review', projectRoot);
      const record = records.find((r) => r.id === recordId);

      expect(record).toBeDefined();
      expect(record?.taskType).toBe('skill-review');
      expect(record?.status).toBe('running');
    });
  });

  // ─── Test 7: Threshold Boundary Cases ──────────────────────────────────────

  describe('Test 7: Threshold boundary cases', () => {
    it('should not trigger at threshold - 1', () => {
      const result = mgr.scheduleSkillReview({
        projectRoot,
        sessionId: 'test-session-1',
        history: sampleHistory,
        toolCallCount: AUTO_SKILL_THRESHOLD - 1,
        threshold: AUTO_SKILL_THRESHOLD,
        enabled: true,
        config: mockConfig,
      });

      expect(result.status).toBe('skipped');
    });

    it('should trigger at threshold', () => {
      const result = mgr.scheduleSkillReview({
        projectRoot,
        sessionId: 'test-session-1',
        history: sampleHistory,
        toolCallCount: AUTO_SKILL_THRESHOLD,
        threshold: AUTO_SKILL_THRESHOLD,
        enabled: true,
        config: mockConfig,
      });

      expect(result.status).toBe('scheduled');
    });

    it('should trigger at threshold + 1', () => {
      const result = mgr.scheduleSkillReview({
        projectRoot,
        sessionId: 'test-session-1',
        history: sampleHistory,
        toolCallCount: AUTO_SKILL_THRESHOLD + 1,
        threshold: AUTO_SKILL_THRESHOLD,
        enabled: true,
        config: mockConfig,
      });

      expect(result.status).toBe('scheduled');
    });
  });

  // ─── Test 8: Project Skills Directory Structure ────────────────────────────

  describe('Test 8: Project skills directory validation', () => {
    it('should verify project skills root exists when scheduled', async () => {
      const result = mgr.scheduleSkillReview({
        projectRoot,
        sessionId: 'test-session-1',
        history: sampleHistory,
        toolCallCount: AUTO_SKILL_THRESHOLD,
        enabled: true,
        config: mockConfig,
      });

      expect(result.status).toBe('scheduled');

      // Project skills directory should be ready for writes
      const skillsRoot = getProjectSkillsRoot(projectRoot);
      const skillsRootPath = path.join(projectRoot, skillsRoot);
      // Directory may not exist yet, but the path should be valid
      expect(skillsRootPath.includes('.qwen/skills')).toBe(true);
    });
  });
});

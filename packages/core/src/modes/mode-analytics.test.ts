/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs/promises';

import { ModeAnalytics } from './mode-analytics.js';

vi.mock('fs/promises');

const mockFs = vi.mocked(fs);

describe('ModeAnalytics', () => {
  let analytics: ModeAnalytics;

  beforeEach(() => {
    vi.clearAllMocks();
    analytics = new ModeAnalytics();
  });

  describe('recordSession', () => {
    it('should record a session with provided data', () => {
      analytics.recordSession('developer', 120, {
        toolCalls: 15,
        messages: 8,
        filesModified: 3,
      });

      expect(analytics.getSessionCount()).toBe(1);
    });

    it('should record multiple sessions', () => {
      analytics.recordSession('developer', 120, {
        toolCalls: 15,
        messages: 8,
        filesModified: 3,
      });
      analytics.recordSession('reviewer', 60, {
        toolCalls: 5,
        messages: 2,
        filesModified: 0,
      });

      expect(analytics.getSessionCount()).toBe(2);
    });
  });

  describe('getModeStats', () => {
    beforeEach(() => {
      analytics.recordSession('developer', 120, {
        toolCalls: 15,
        messages: 8,
        filesModified: 3,
      });
      analytics.recordSession('developer', 180, {
        toolCalls: 25,
        messages: 12,
        filesModified: 5,
      });
      analytics.recordSession('reviewer', 60, {
        toolCalls: 5,
        messages: 2,
        filesModified: 0,
      });
    });

    it('should return aggregated stats for a mode', () => {
      const stats = analytics.getModeStats('developer');

      expect(stats).not.toBeNull();
      expect(stats!.modeName).toBe('developer');
      expect(stats!.totalTimeSeconds).toBe(300);
      expect(stats!.sessionCount).toBe(2);
      expect(stats!.averageSessionTime).toBe(150);
      expect(stats!.toolCallCount).toBe(40);
      expect(stats!.messagesExchanged).toBe(20);
      expect(stats!.filesModified).toBe(8);
    });

    it('should return null for unknown mode', () => {
      const stats = analytics.getModeStats('nonexistent');
      expect(stats).toBeNull();
    });

    it('should return correct stats for single-session mode', () => {
      const stats = analytics.getModeStats('reviewer');

      expect(stats).not.toBeNull();
      expect(stats!.totalTimeSeconds).toBe(60);
      expect(stats!.sessionCount).toBe(1);
      expect(stats!.averageSessionTime).toBe(60);
    });
  });

  describe('getAllStats', () => {
    it('should return empty array when no sessions', () => {
      const stats = analytics.getAllStats();
      expect(stats).toEqual([]);
    });

    it('should return stats sorted by total time descending', () => {
      analytics.recordSession('reviewer', 60, {
        toolCalls: 5,
        messages: 2,
        filesModified: 0,
      });
      analytics.recordSession('developer', 300, {
        toolCalls: 15,
        messages: 8,
        filesModified: 3,
      });
      analytics.recordSession('architect', 120, {
        toolCalls: 10,
        messages: 5,
        filesModified: 1,
      });

      const stats = analytics.getAllStats();

      expect(stats).toHaveLength(3);
      expect(stats[0].modeName).toBe('developer');
      expect(stats[1].modeName).toBe('architect');
      expect(stats[2].modeName).toBe('reviewer');
    });
  });

  describe('getProductivityReport', () => {
    it('should return report with no data', () => {
      const report = analytics.getProductivityReport();

      expect(report.totalTime).toBe(0);
      expect(report.mostUsedMode).toBe('general');
      expect(report.modeDistribution).toEqual({});
      expect(report.suggestions.length).toBeGreaterThan(0);
    });

    it('should return report with time distribution', () => {
      analytics.recordSession('developer', 200, {
        toolCalls: 15,
        messages: 8,
        filesModified: 3,
      });
      analytics.recordSession('reviewer', 100, {
        toolCalls: 5,
        messages: 2,
        filesModified: 0,
      });

      const report = analytics.getProductivityReport();

      expect(report.totalTime).toBe(300);
      expect(report.mostUsedMode).toBe('developer');
      expect(report.modeDistribution['developer']).toBeCloseTo(66.67, 1);
      expect(report.modeDistribution['reviewer']).toBeCloseTo(33.33, 1);
    });

    it('should include suggestions for over-reliance on single mode', () => {
      analytics.recordSession('developer', 900, {
        toolCalls: 50,
        messages: 20,
        filesModified: 15,
      });
      analytics.recordSession('reviewer', 30, {
        toolCalls: 2,
        messages: 1,
        filesModified: 0,
      });

      const report = analytics.getProductivityReport();

      const overRelianceSuggestion = report.suggestions.find(
        (s) => s.includes('spend') && s.includes('% of your time'),
      );
      expect(overRelianceSuggestion).toBeDefined();
    });

    it('should include suggestions for underutilized specialized modes', () => {
      analytics.recordSession('developer', 120, {
        toolCalls: 10,
        messages: 5,
        filesModified: 2,
      });

      const report = analytics.getProductivityReport();

      const underutilizedSuggestion = report.suggestions.find((s) =>
        s.includes('Try using these specialized modes'),
      );
      expect(underutilizedSuggestion).toBeDefined();
    });

    it('should suggest reviewer when many files modified', () => {
      analytics.recordSession('developer', 600, {
        toolCalls: 50,
        messages: 20,
        filesModified: 15,
      });

      const report = analytics.getProductivityReport();

      const reviewerSuggestion = report.suggestions.find((s) =>
        s.includes('reviewer'),
      );
      expect(reviewerSuggestion).toBeDefined();
    });
  });

  describe('save and load persistence', () => {
    it('should save analytics data to file', async () => {
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);

      analytics.recordSession('developer', 120, {
        toolCalls: 15,
        messages: 8,
        filesModified: 3,
      });

      await analytics.save('/test/analytics.json');

      expect(mockFs.mkdir).toHaveBeenCalledWith('/test', { recursive: true });
      expect(mockFs.writeFile).toHaveBeenCalled();

      const writeCall = mockFs.writeFile.mock.calls[0];
      const data = JSON.parse(writeCall[1]);
      expect(data.sessions).toHaveLength(1);
      expect(data.sessions[0].modeName).toBe('developer');
      expect(data.sessions[0].duration).toBe(120);
    });

    it('should load analytics data from file', async () => {
      const mockData = {
        sessions: [
          {
            modeName: 'developer',
            duration: 120,
            toolCalls: 15,
            messages: 8,
            filesModified: 3,
            timestamp: '2025-01-01T00:00:00.000Z',
          },
          {
            modeName: 'reviewer',
            duration: 60,
            toolCalls: 5,
            messages: 2,
            filesModified: 0,
            timestamp: '2025-01-01T01:00:00.000Z',
          },
        ],
      };

      mockFs.readFile.mockResolvedValue(JSON.stringify(mockData));

      await analytics.load('/test/analytics.json');

      expect(mockFs.readFile).toHaveBeenCalledWith(
        '/test/analytics.json',
        'utf-8',
      );
      expect(analytics.getSessionCount()).toBe(2);

      const stats = analytics.getModeStats('developer');
      expect(stats).not.toBeNull();
      expect(stats!.totalTimeSeconds).toBe(120);
    });

    it('should handle load failure gracefully', async () => {
      mockFs.readFile.mockRejectedValue(new Error('File not found'));

      await analytics.load('/test/nonexistent.json');

      expect(analytics.getSessionCount()).toBe(0);
    });
  });

  describe('clear', () => {
    it('should clear all recorded sessions', () => {
      analytics.recordSession('developer', 120, {
        toolCalls: 15,
        messages: 8,
        filesModified: 3,
      });
      analytics.recordSession('reviewer', 60, {
        toolCalls: 5,
        messages: 2,
        filesModified: 0,
      });

      expect(analytics.getSessionCount()).toBe(2);

      analytics.clear();

      expect(analytics.getSessionCount()).toBe(0);
      expect(analytics.getAllStats()).toEqual([]);
    });
  });

  describe('getSessionCount', () => {
    it('should return correct session count', () => {
      expect(analytics.getSessionCount()).toBe(0);

      analytics.recordSession('developer', 100, {
        toolCalls: 10,
        messages: 5,
        filesModified: 2,
      });
      expect(analytics.getSessionCount()).toBe(1);

      analytics.recordSession('reviewer', 50, {
        toolCalls: 3,
        messages: 1,
        filesModified: 0,
      });
      expect(analytics.getSessionCount()).toBe(2);
    });
  });
});

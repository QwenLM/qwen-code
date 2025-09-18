/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SubagentStatistics } from './subagent-statistics.js';

describe('SubagentStatistics', () => {
  let stats: SubagentStatistics;
  const baseTime = 1000000000000; // Fixed timestamp for consistent testing

  beforeEach(() => {
    stats = new SubagentStatistics();
  });

  describe('basic statistics tracking', () => {
    it('should track execution time', () => {
      stats.start(baseTime);
      const summary = stats.getSummary(baseTime + 5000);

      expect(summary.totalDurationMs).toBe(5000);
    });

    it('should track rounds', () => {
      stats.setRounds(3);
      const summary = stats.getSummary();

      expect(summary.rounds).toBe(3);
    });

    it('should track tool calls', () => {
      stats.recordToolCall('file_read', true, 100);
      stats.recordToolCall('web_search', false, 200, 'Network timeout');

      const summary = stats.getSummary();
      expect(summary.totalToolCalls).toBe(2);
      expect(summary.successfulToolCalls).toBe(1);
      expect(summary.failedToolCalls).toBe(1);
      expect(summary.successRate).toBe(50);
    });

    it('should track tokens', () => {
      stats.recordTokens(1000, 500);
      stats.recordTokens(200, 100);

      const summary = stats.getSummary();
      expect(summary.inputTokens).toBe(1200);
      expect(summary.outputTokens).toBe(600);
      expect(summary.totalTokens).toBe(1800);
    });
  });

  describe('tool usage statistics', () => {
    it('should track individual tool usage', () => {
      stats.recordToolCall('file_read', true, 100);
      stats.recordToolCall('file_read', false, 150, 'Permission denied');
      stats.recordToolCall('web_search', true, 300);

      const summary = stats.getSummary();
      const fileReadTool = summary.toolUsage.find(
        (t) => t.name === 'file_read',
      );
      const webSearchTool = summary.toolUsage.find(
        (t) => t.name === 'web_search',
      );

      expect(fileReadTool).toEqual({
        name: 'file_read',
        count: 2,
        success: 1,
        failure: 1,
        lastError: 'Permission denied',
        totalDurationMs: 250,
        averageDurationMs: 125,
      });

      expect(webSearchTool).toEqual({
        name: 'web_search',
        count: 1,
        success: 1,
        failure: 0,
        lastError: undefined,
        totalDurationMs: 300,
        averageDurationMs: 300,
      });
    });
  });

  describe('formatCompact', () => {
    it('should format basic execution summary', () => {
      stats.start(baseTime);
      stats.setRounds(2);
      stats.recordToolCall('file_read', true, 100);
      stats.recordTokens(1000, 500);

      const result = stats.formatCompact('Test task', baseTime + 5000);

      expect(result).toContain('📋 Task Completed: Test task');
      expect(result).toContain('🔧 Tool Usage: 1 calls, 100.0% success');
      expect(result).toContain('⏱️ Duration: 5.0s | 🔁 Rounds: 2');
      expect(result).toContain('🔢 Tokens: 1,500 (in 1000, out 500)');
    });

    it('should handle zero tool calls', () => {
      stats.start(baseTime);

      const result = stats.formatCompact('Empty task', baseTime + 1000);

      expect(result).toContain('🔧 Tool Usage: 0 calls');
      expect(result).not.toContain('% success');
    });

    it('should show zero tokens when no tokens recorded', () => {
      stats.start(baseTime);
      stats.recordToolCall('test', true, 100);

      const result = stats.formatCompact('No tokens task', baseTime + 1000);

      expect(result).toContain('🔢 Tokens: 0');
    });
  });

  describe('formatDetailed', () => {
    beforeEach(() => {
      stats.start(baseTime);
      stats.setRounds(3);
      stats.recordToolCall('file_read', true, 100);
      stats.recordToolCall('file_read', true, 150);
      stats.recordToolCall('web_search', false, 2000, 'Network timeout');
      stats.recordTokens(2000, 1000);
    });

    it('should include quality assessment', () => {
      const result = stats.formatDetailed('Complex task', baseTime + 30000);

      expect(result).toContain(
        '✅ Quality: Poor execution (66.7% tool success)',
      );
    });

    it('should include speed assessment', () => {
      const result = stats.formatDetailed('Fast task', baseTime + 5000);

      expect(result).toContain('🚀 Speed: Fast completion - under 10 seconds');
    });

    it('should show top tools', () => {
      const result = stats.formatDetailed('Tool-heavy task', baseTime + 15000);

      expect(result).toContain('Top tools:');
      expect(result).toContain('- file_read: 2 calls (2 ok, 0 fail');
      expect(result).toContain('- web_search: 1 calls (0 ok, 1 fail');
      expect(result).toContain('last error: Network timeout');
    });

    it('should include performance insights', () => {
      const result = stats.formatDetailed('Slow task', baseTime + 120000);

      expect(result).toContain('💡 Performance Insights:');
      expect(result).toContain(
        'Long execution time - consider breaking down complex tasks',
      );
    });
  });

  describe('quality categories', () => {
    it('should categorize excellent execution', () => {
      stats.recordToolCall('test', true, 100);
      stats.recordToolCall('test', true, 100);

      const result = stats.formatDetailed('Perfect task');
      expect(result).toContain('Excellent execution (100.0% tool success)');
    });

    it('should categorize good execution', () => {
      // Need 85% success rate for "Good execution" - 17 success, 3 failures = 85%
      for (let i = 0; i < 17; i++) {
        stats.recordToolCall('test', true, 100);
      }
      for (let i = 0; i < 3; i++) {
        stats.recordToolCall('test', false, 100);
      }

      const result = stats.formatDetailed('Good task');
      expect(result).toContain('Good execution (85.0% tool success)');
    });

    it('should categorize poor execution', () => {
      stats.recordToolCall('test', false, 100);
      stats.recordToolCall('test', false, 100);

      const result = stats.formatDetailed('Poor task');
      expect(result).toContain('Poor execution (0.0% tool success)');
    });
  });

  describe('speed categories', () => {
    it('should categorize fast completion', () => {
      stats.start(baseTime);
      const result = stats.formatDetailed('Fast task', baseTime + 5000);
      expect(result).toContain('Fast completion - under 10 seconds');
    });

    it('should categorize good speed', () => {
      stats.start(baseTime);
      const result = stats.formatDetailed('Medium task', baseTime + 30000);
      expect(result).toContain('Good speed - under a minute');
    });

    it('should categorize moderate duration', () => {
      stats.start(baseTime);
      const result = stats.formatDetailed('Slow task', baseTime + 120000);
      expect(result).toContain('Moderate duration - a few minutes');
    });

    it('should categorize long execution', () => {
      stats.start(baseTime);
      const result = stats.formatDetailed('Very slow task', baseTime + 600000);
      expect(result).toContain('Long execution - consider breaking down tasks');
    });
  });

  describe('performance tips', () => {
    it('should suggest reviewing low success rate', () => {
      stats.recordToolCall('test', false, 100);
      stats.recordToolCall('test', false, 100);
      stats.recordToolCall('test', true, 100);

      const result = stats.formatDetailed('Failing task');
      expect(result).toContain(
        'Low tool success rate - review inputs and error messages',
      );
    });

    it('should suggest breaking down long tasks', () => {
      stats.start(baseTime);

      const result = stats.formatDetailed('Long task', baseTime + 120000);
      expect(result).toContain(
        'Long execution time - consider breaking down complex tasks',
      );
    });

    it('should suggest optimizing high token usage', () => {
      stats.recordTokens(80000, 30000);

      const result = stats.formatDetailed('Token-heavy task');
      expect(result).toContain(
        'High token usage - consider optimizing prompts or narrowing scope',
      );
    });

    it('should identify high token usage per call', () => {
      stats.recordToolCall('test', true, 100);
      stats.recordTokens(6000, 0);

      const result = stats.formatDetailed('Verbose task');
      expect(result).toContain(
        'High token usage per tool call (~6000 tokens/call)',
      );
    });

    it('should identify network failures', () => {
      stats.recordToolCall('web_search', false, 100, 'Network timeout');

      const result = stats.formatDetailed('Network task');
      expect(result).toContain(
        'Network operations had failures - consider increasing timeout or checking connectivity',
      );
    });

    it('should identify slow tools', () => {
      stats.recordToolCall('slow_tool', true, 15000);

      const result = stats.formatDetailed('Slow tool task');
      expect(result).toContain(
        'Consider optimizing slow_tool operations (avg 15.0s)',
      );
    });
  });

  describe('duration formatting', () => {
    it('should format milliseconds', () => {
      stats.start(baseTime);
      const result = stats.formatCompact('Quick task', baseTime + 500);
      expect(result).toContain('500ms');
    });

    it('should format seconds', () => {
      stats.start(baseTime);
      const result = stats.formatCompact('Second task', baseTime + 2500);
      expect(result).toContain('2.5s');
    });

    it('should format minutes and seconds', () => {
      stats.start(baseTime);
      const result = stats.formatCompact('Minute task', baseTime + 125000);
      expect(result).toContain('2m 5s');
    });

    it('should format hours and minutes', () => {
      stats.start(baseTime);
      const result = stats.formatCompact('Hour task', baseTime + 4500000);
      expect(result).toContain('1h 15m');
    });
  });
});

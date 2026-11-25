/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  looksLikePrompt,
  startStallWatchdog,
  STALL_CHECK_INTERVAL_MS,
  STALL_THRESHOLD_MS,
  STALL_TAIL_BYTES,
} from './stallDetection.js';
import {
  _resetQueueForTest,
  getCommandQueueSnapshot,
} from './messageQueueManager.js';

// ---------------------------------------------------------------------------
// Mock fs/promises.stat and tailFile
// ---------------------------------------------------------------------------

const mockStat = vi.fn<(path: string) => Promise<{ size: number }>>();
const mockTailFile =
  vi.fn<
    (
      path: string,
      maxBytes: number,
    ) => Promise<{ content: string; bytesRead: number; bytesTotal: number }>
  >();

vi.mock('node:fs/promises', () => ({
  stat: (...args: [string]) => mockStat(...args),
}));

vi.mock('../utils/fsOperations.js', () => ({
  tailFile: (...args: [string, number]) => mockTailFile(...args),
}));

/**
 * Helper: advance fake timers by `ms` and flush all pending microtasks.
 * Uses advanceTimersByTimeAsync to avoid the infinite-loop problem that
 * runAllTimersAsync has with setInterval.
 */
async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('stallDetection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetQueueForTest();
    mockStat.mockReset();
    mockTailFile.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // looksLikePrompt
  // =========================================================================

  describe('looksLikePrompt', () => {
    it('detects (y/n) prompts', () => {
      expect(looksLikePrompt('Install packages? (y/n)')).toBe(true);
      expect(looksLikePrompt('Continue? (Y/N)')).toBe(true);
    });

    it('detects [y/n] prompts', () => {
      expect(looksLikePrompt('Proceed? [y/n]')).toBe(true);
      expect(looksLikePrompt('Replace file? [Y/N]')).toBe(true);
    });

    it('detects (yes/no) prompts', () => {
      expect(looksLikePrompt('Are you sure? (yes/no)')).toBe(true);
    });

    it('detects directed question prompts', () => {
      expect(looksLikePrompt('Do you want to continue?')).toBe(true);
      expect(looksLikePrompt('Would you like to overwrite the file?')).toBe(
        true,
      );
      expect(looksLikePrompt('Are you sure you want to delete?')).toBe(true);
    });

    it('detects "Press Enter" prompts', () => {
      expect(looksLikePrompt('Press Enter to continue')).toBe(true);
      expect(looksLikePrompt('Press any key to continue')).toBe(true);
    });

    it('detects Continue? and Overwrite? prompts', () => {
      expect(looksLikePrompt('Continue?')).toBe(true);
      expect(looksLikePrompt('Overwrite?')).toBe(true);
    });

    it('returns false for normal output', () => {
      expect(looksLikePrompt('Compiling main.ts...')).toBe(false);
      expect(looksLikePrompt('Build succeeded')).toBe(false);
      expect(looksLikePrompt('')).toBe(false);
    });

    it('only checks the last non-empty line', () => {
      expect(looksLikePrompt('Continue?\nBuild completed')).toBe(false);
      expect(looksLikePrompt('Building...\nContinue?')).toBe(true);
    });

    it('trims trailing whitespace before checking', () => {
      expect(looksLikePrompt('Continue?\n   \n  ')).toBe(true);
    });
  });

  // =========================================================================
  // Constants
  // =========================================================================

  describe('constants', () => {
    it('exports expected constant values', () => {
      expect(STALL_CHECK_INTERVAL_MS).toBe(5_000);
      expect(STALL_THRESHOLD_MS).toBe(45_000);
      expect(STALL_TAIL_BYTES).toBe(1024);
    });
  });

  // =========================================================================
  // startStallWatchdog
  // =========================================================================

  describe('startStallWatchdog', () => {
    const OUTPUT_PATH = '/tmp/tasks/task-123.output';

    it('returns a cancel function', () => {
      mockStat.mockResolvedValue({ size: 0 });
      const cancel = startStallWatchdog({
        taskId: 123,
        outputPath: OUTPUT_PATH,
        description: 'npm test',
      });
      expect(typeof cancel).toBe('function');
      cancel();
    });

    it('does not enqueue if output keeps growing', async () => {
      let size = 100;
      mockStat.mockImplementation(async () => ({ size: size++ }));

      const cancel = startStallWatchdog({
        taskId: 123,
        outputPath: OUTPUT_PATH,
        description: 'npm test',
      });

      // Advance 20 intervals — file keeps growing
      for (let i = 0; i < 20; i++) {
        await tick(STALL_CHECK_INTERVAL_MS);
      }

      expect(getCommandQueueSnapshot().length).toBe(0);
      cancel();
    });

    it('does not enqueue if stalled but no prompt detected', async () => {
      mockStat.mockResolvedValue({ size: 100 });
      mockTailFile.mockResolvedValue({
        content: 'Compiling main.ts...',
        bytesRead: 20,
        bytesTotal: 100,
      });

      const cancel = startStallWatchdog({
        taskId: 123,
        outputPath: OUTPUT_PATH,
        description: 'npm test',
      });

      // Advance well past the stall threshold
      await tick(STALL_THRESHOLD_MS + STALL_CHECK_INTERVAL_MS * 3);

      expect(getCommandQueueSnapshot().length).toBe(0);
      cancel();
    });

    it('enqueues notification when stalled with prompt detected', async () => {
      mockStat.mockResolvedValue({ size: 100 });
      mockTailFile.mockResolvedValue({
        content: 'Do you want to continue?',
        bytesRead: 24,
        bytesTotal: 100,
      });

      const cancel = startStallWatchdog({
        taskId: '123',
        outputPath: OUTPUT_PATH,
        description: 'npm test',
      });

      // Advance past the stall threshold + one more interval to trigger tail check
      await tick(STALL_THRESHOLD_MS + STALL_CHECK_INTERVAL_MS * 2);

      const queue = getCommandQueueSnapshot();
      expect(queue.length).toBe(1);
      expect(queue[0]?.commandMode).toBe('task-notification');
      expect(queue[0]?.priority).toBe('next');
      expect(queue[0]?.prompt).toContain('<task-notification>');
      expect(queue[0]?.prompt).toContain('<task-id>123</task-id>');
      expect(queue[0]?.prompt).toContain(
        'appears to be waiting for interactive input',
      );
      // Should NOT contain <status> tag
      expect(queue[0]?.prompt).not.toContain('<status>');
      // Should contain the last output
      expect(queue[0]?.prompt).toContain('Do you want to continue?');

      cancel();
    });

    it('is a one-shot notification (does not re-enqueue)', async () => {
      mockStat.mockResolvedValue({ size: 100 });
      mockTailFile.mockResolvedValue({
        content: 'Continue?',
        bytesRead: 9,
        bytesTotal: 100,
      });

      const cancel = startStallWatchdog({
        taskId: '123',
        outputPath: OUTPUT_PATH,
        description: 'npm test',
      });

      // Advance past threshold — should fire once
      await tick(STALL_THRESHOLD_MS + STALL_CHECK_INTERVAL_MS * 2);
      expect(getCommandQueueSnapshot().length).toBe(1);

      // Advance further — should NOT fire again (cancelled itself)
      await tick(STALL_THRESHOLD_MS * 2);
      expect(getCommandQueueSnapshot().length).toBe(1);

      cancel();
    });

    it('cancel stops the watchdog before it fires', async () => {
      mockStat.mockResolvedValue({ size: 100 });
      mockTailFile.mockResolvedValue({
        content: 'Continue?',
        bytesRead: 9,
        bytesTotal: 100,
      });

      const cancel = startStallWatchdog({
        taskId: '123',
        outputPath: OUTPUT_PATH,
        description: 'npm test',
      });

      // Advance a bit but NOT past the threshold
      await tick(STALL_CHECK_INTERVAL_MS * 2);

      // Cancel while still within threshold
      cancel();

      // Now advance past threshold — should NOT fire
      await tick(STALL_THRESHOLD_MS + STALL_CHECK_INTERVAL_MS * 2);

      expect(getCommandQueueSnapshot().length).toBe(0);
    });

    it('includes toolUseId when provided', async () => {
      mockStat.mockResolvedValue({ size: 100 });
      mockTailFile.mockResolvedValue({
        content: 'Overwrite?',
        bytesRead: 10,
        bytesTotal: 100,
      });

      const cancel = startStallWatchdog({
        taskId: '123',
        outputPath: OUTPUT_PATH,
        description: 'npm test',
        toolUseId: 'tool-abc',
      });

      await tick(STALL_THRESHOLD_MS + STALL_CHECK_INTERVAL_MS * 2);

      const queue = getCommandQueueSnapshot();
      expect(queue.length).toBe(1);
      expect(queue[0]?.prompt).toContain('<tool-use-id>tool-abc</tool-use-id>');

      cancel();
    });

    it('passes session and agent routing through to the queue entry', async () => {
      mockStat.mockResolvedValue({ size: 100 });
      mockTailFile.mockResolvedValue({
        content: 'Continue?',
        bytesRead: 9,
        bytesTotal: 100,
      });

      const cancel = startStallWatchdog({
        taskId: '123',
        outputPath: OUTPUT_PATH,
        description: 'npm test',
        targetAgentId: 'agent-1',
        sessionId: 'session-1',
      });

      await tick(STALL_THRESHOLD_MS + STALL_CHECK_INTERVAL_MS * 2);

      const queue = getCommandQueueSnapshot();
      expect(queue.length).toBe(1);
      expect(queue[0]?.targetAgentId).toBe('agent-1');
      expect(queue[0]?.sessionId).toBe('session-1');

      cancel();
    });

    it('handles stat errors gracefully', async () => {
      mockStat.mockRejectedValue(new Error('ENOENT'));

      const cancel = startStallWatchdog({
        taskId: '123',
        outputPath: OUTPUT_PATH,
        description: 'npm test',
      });

      // Advance multiple intervals — should not throw
      await tick(STALL_CHECK_INTERVAL_MS * 5);

      expect(getCommandQueueSnapshot().length).toBe(0);
      cancel();
    });
  });
});

/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TaskOutput } from './TaskOutput.js';
import * as fsOperations from '../fsOperations.js';
import {
  setTaskOutputDir,
  _resetTaskOutputDirForTest,
  _clearOutputsForTest,
  getTaskOutputPath,
} from './diskOutput.js';
import { runLogger } from '../runLogger.js';

describe('TaskOutput', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-output-test-'));
    setTaskOutputDir(tmpDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    TaskOutput._resetForTest();
    vi.useRealTimers();
    await _clearOutputsForTest();
    _resetTaskOutputDirForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('pipe mode (stdoutToFile=false)', () => {
    it('accumulates stdout in memory', async () => {
      const to = new TaskOutput('pipe-1', null, false);
      to.writeStdout('hello ');
      to.writeStdout('world');
      const stdout = await to.getStdout();
      expect(stdout).toBe('hello world');
    });

    it('accumulates stderr in memory', () => {
      const to = new TaskOutput('pipe-2', null, false);
      to.writeStderr('error msg');
      expect(to.getStderr()).toBe('error msg');
    });

    it('tracks totalBytes and totalLines', () => {
      const to = new TaskOutput('pipe-3', null, false);
      to.writeStdout('line1\nline2\nline3\n');
      expect(to.totalBytes).toBe(18);
      expect(to.totalLines).toBe(3);
    });

    it('calls onProgress in pipe mode', () => {
      const progressFn = vi.fn();
      const to = new TaskOutput('pipe-4', progressFn, false);
      to.writeStdout('line1\nline2\nline3\n');
      expect(progressFn).toHaveBeenCalled();
      const [lastLines, , totalLines, totalBytes] = progressFn.mock.calls[0];
      expect(totalLines).toBe(3);
      expect(totalBytes).toBe(18);
      expect(lastLines).toBeTruthy();
    });

    it('spills to disk when exceeding memory limit', async () => {
      // Use a small memory limit for testing
      const to = new TaskOutput('pipe-5', null, false, 100);
      to.writeStdout('a'.repeat(50));
      expect(to.isOverflowed).toBe(false);
      to.writeStdout('b'.repeat(60)); // Total 110 > 100
      expect(to.isOverflowed).toBe(true);

      const stdout = await to.getStdout();
      // After overflow, getStdout returns recent lines + truncation notice
      expect(stdout).toContain('Output truncated');
    });

    it('returns empty stderr after spill', () => {
      const to = new TaskOutput('pipe-6', null, false, 50);
      to.writeStdout('a'.repeat(60)); // Triggers spill
      expect(to.getStderr()).toBe('');
    });

    it('persists pipe-mode stdout and stderr from the first chunk', async () => {
      const onStdout = vi.fn();
      const to = new TaskOutput(
        'pipe-persist',
        null,
        false,
        undefined,
        onStdout,
        true,
      );

      to.writeStdout('ready\n');
      to.writeStderr('warning\n');

      expect(onStdout).toHaveBeenCalledWith('ready\n');
      expect(await to.getStdout()).toBe('ready\n[stderr] warning\n');
      expect(fs.readFileSync(to.path, 'utf8')).toBe(
        'ready\n[stderr] warning\n',
      );
    });
  });

  describe('file mode (stdoutToFile=true)', () => {
    it('reads stdout from file', async () => {
      const to = new TaskOutput('file-1', null, true);
      // Manually write to the output file
      const outputPath = getTaskOutputPath('file-1');
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, 'file content here');

      const stdout = await to.getStdout();
      expect(stdout).toBe('file content here');
      expect(to.outputFileRedundant).toBe(true);
    });

    it('returns error message when file is missing', async () => {
      const warnSpy = vi
        .spyOn(runLogger, 'warn')
        .mockImplementation(() => {});
      const to = new TaskOutput('file-2', null, true);
      const stdout = await to.getStdout();
      expect(stdout).toContain('bash output unavailable');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `taskId=file-2, path=${getTaskOutputPath('file-2')}, code=ENOENT`,
        ),
        expect.objectContaining({ code: 'ENOENT' }),
      );
    });

    it('sets outputFileSize after read', async () => {
      const to = new TaskOutput('file-3', null, true);
      const outputPath = getTaskOutputPath('file-3');
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, 'hello');

      await to.getStdout();
      expect(to.outputFileSize).toBe(5);
    });
  });

  describe('spillToDisk', () => {
    it('forces spill even when under limit', () => {
      const to = new TaskOutput('spill-1', null, false);
      to.writeStdout('data');
      expect(to.isOverflowed).toBe(false);
      to.spillToDisk();
      expect(to.isOverflowed).toBe(true);
    });
  });

  describe('clear', () => {
    it('clears all state', () => {
      const to = new TaskOutput('clear-1', null, false);
      to.writeStdout('data\n');
      to.clear();
      expect(to.getStderr()).toBe('');
    });
  });

  describe('polling', () => {
    it('startPolling and stopPolling do not throw', () => {
      const to = new TaskOutput('poll-1', vi.fn(), true);
      expect(() => TaskOutput.startPolling('poll-1')).not.toThrow();
      expect(() => TaskOutput.stopPolling('poll-1')).not.toThrow();
      to.clear();
    });

    it('startPolling with no progress callback is a no-op', () => {
      // Create instance to register in registry, but no progress callback
      new TaskOutput('poll-2', null, true);
      expect(() => TaskOutput.startPolling('poll-2')).not.toThrow();
    });

    it('startPolling with unknown taskId is a no-op', () => {
      expect(() => TaskOutput.startPolling('unknown')).not.toThrow();
    });

    it('does not count a trailing newline as an extra progress line', async () => {
      vi.useFakeTimers();
      const progressFn = vi.fn();
      const to = new TaskOutput('poll-lines', progressFn, true);
      const outputPath = getTaskOutputPath('poll-lines');
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, 'line1\nline2\nline3\nline4\nline5\n');

      TaskOutput.startPolling('poll-lines');
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(progressFn).toHaveBeenCalled());

      const [lastLines, , totalLines] = progressFn.mock.lastCall ?? [];
      expect(totalLines).toBe(5);
      expect(lastLines).toBe('line1\nline2\nline3\nline4\nline5\n');

      TaskOutput.stopPolling('poll-lines');
      to.clear();
    });

    it('counts variable-length large output exactly across appended partial lines', async () => {
      vi.useFakeTimers();
      const progress = vi.fn();
      const output = new TaskOutput('exact-large', progress, true);
      output.setExactLineCounting(true);
      fs.mkdirSync(path.dirname(output.path), { recursive: true });
      fs.writeFileSync(output.path, 'long'.repeat(20000) + '\n' + '短\n'.repeat(100000) + 'partial');
      TaskOutput.startPolling('exact-large');
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(progress.mock.lastCall?.[2]).toBe(100002));
      fs.appendFileSync(output.path, '-continued\nlast\n');
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(progress.mock.lastCall?.[2]).toBe(100003));
      expect(progress.mock.lastCall?.[1].length).toBeLessThanOrEqual(4096);
      TaskOutput.stopPolling('exact-large');
      output.clear();
    });

    it('does not scan file contents for exact counts unless enabled', async () => {
      vi.useFakeTimers();
      const reads = vi.spyOn(fsOperations, 'readFileRange');
      const progress = vi.fn();
      const output = new TaskOutput('opt-out', progress, true);
      fs.mkdirSync(path.dirname(output.path), { recursive: true });
      fs.writeFileSync(output.path, 'line\n'.repeat(300000));
      TaskOutput.startPolling('opt-out');
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(progress).toHaveBeenCalled());
      expect(reads).not.toHaveBeenCalled();
      output.clear();
    });

    it('bounds counting per poll and omits partial totals while publishing the tail', async () => {
      vi.useFakeTimers();
      const reads = vi.spyOn(fsOperations, 'readFileRange');
      const progress = vi.fn();
      const output = new TaskOutput('bounded-count', progress, true);
      output.setExactLineCounting(true);
      fs.mkdirSync(path.dirname(output.path), { recursive: true });
      fs.writeFileSync(output.path, 'x\n'.repeat(1024 * 1024));
      TaskOutput.startPolling('bounded-count');
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(progress).toHaveBeenCalledTimes(1));
      expect(reads.mock.calls.reduce((sum, call) => sum + call[2], 0)).toBeLessThanOrEqual(1024 * 1024);
      expect(progress.mock.lastCall?.[1]).toContain('x\n');
      expect(progress.mock.lastCall?.[5]).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(progress.mock.lastCall?.[5]).toBe(1024 * 1024));
      output.setExactLineCounting(false);
      reads.mockClear();
      fs.appendFileSync(output.path, 'next\n');
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(progress).toHaveBeenCalledTimes(3));
      expect(reads).not.toHaveBeenCalled();
      expect(progress.mock.lastCall?.[5]).toBeUndefined();
      output.clear();
    });

    it('counts a leading blank line and still returns only the last five lines', async () => {
      vi.useFakeTimers();
      const progressFn = vi.fn();
      const to = new TaskOutput('poll-leading-blank', progressFn, true);
      const outputPath = getTaskOutputPath('poll-leading-blank');
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(
        outputPath,
        '\nline1\nline2\nline3\nline4\nline5\n',
      );

      TaskOutput.startPolling('poll-leading-blank');
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(progressFn).toHaveBeenCalled());

      const [lastLines, , totalLines] = progressFn.mock.lastCall ?? [];
      expect(totalLines).toBe(6);
      expect(lastLines).toBe('line1\nline2\nline3\nline4\nline5\n');

      TaskOutput.stopPolling('poll-leading-blank');
      to.clear();
    });
  });

  describe('deleteOutputFile', () => {
    it('deletes the output file', async () => {
      const to = new TaskOutput('del-1', null, true);
      const outputPath = getTaskOutputPath('del-1');
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, 'data');

      await to.deleteOutputFile();
      expect(fs.existsSync(outputPath)).toBe(false);
    });

    it('does not throw for non-existent file', async () => {
      const to = new TaskOutput('del-2', null, true);
      await expect(to.deleteOutputFile()).resolves.not.toThrow();
    });
  });
});

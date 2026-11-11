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
import { BRAND_CLI_SLUG } from '../../config/brand.js';
import {
  DiskTaskOutput,
  setTaskOutputDir,
  getTaskOutputDir,
  getTaskOutputPath,
  initTaskOutput,
  initTaskOutputAsSymlink,
  appendTaskOutput,
  flushTaskOutput,
  getTaskOutput,
  getTaskOutputDelta,
  getTaskOutputSize,
  cleanupTaskOutput,
  _resetTaskOutputDirForTest,
  _clearOutputsForTest,
  MAX_TASK_OUTPUT_BYTES_DISPLAY,
} from './diskOutput.js';

describe('diskOutput', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-output-test-'));
    setTaskOutputDir(tmpDir);
  });

  afterEach(async () => {
    await _clearOutputsForTest();
    _resetTaskOutputDirForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getTaskOutputDir / setTaskOutputDir', () => {
    it('returns the set directory', () => {
      expect(getTaskOutputDir()).toBe(tmpDir);
    });

    it('falls back to os.tmpdir() based path when not set', () => {
      _resetTaskOutputDirForTest();
      const dir = getTaskOutputDir();
      expect(dir).toContain(`${BRAND_CLI_SLUG}-tasks`);
    });
  });

  describe('base tmpdir resolution', () => {
    const originalTmpDir = process.env['TMPDIR'];

    afterEach(() => {
      if (originalTmpDir === undefined) {
        delete process.env['TMPDIR'];
      } else {
        process.env['TMPDIR'] = originalTmpDir;
      }
      _resetTaskOutputDirForTest();
    });

    it.skipIf(process.platform === 'win32')(
      'prefers an explicitly configured $TMPDIR',
      async () => {
        const sandboxTmp = fs.mkdtempSync(
          path.join(os.tmpdir(), 'sandbox-tmp-'),
        );
        process.env['TMPDIR'] = sandboxTmp;
        _resetTaskOutputDirForTest();

        const { computeIsolatedTaskOutputDir } = await import(
          './diskOutput.js'
        );
        expect(computeIsolatedTaskOutputDir('proj', 'sess')).toContain(
          sandboxTmp,
        );

        fs.rmSync(sandboxTmp, { recursive: true, force: true });
      },
    );

    it.skipIf(process.platform === 'win32')(
      'falls back to os.tmpdir() when /tmp is not writable',
      async () => {
        // The HarmonyOS app sandbox exposes a /tmp that resolves but cannot be
        // written, so resolution must not accept it on existence alone.
        delete process.env['TMPDIR'];
        const fallbackTmp = fs.mkdtempSync(
          path.join(os.tmpdir(), 'fallback-tmp-'),
        );
        vi.resetModules();
        vi.doMock('node:fs', async () => {
          const actual =
            await vi.importActual<typeof import('node:fs')>('node:fs');
          return {
            ...actual,
            accessSync: vi.fn(() => {
              throw new Error('EACCES: permission denied');
            }),
          };
        });
        // Without TMPDIR, os.tmpdir() resolves to /tmp itself on macOS, which
        // would make the assertion below hold either way. Point it elsewhere so
        // the test actually distinguishes the two branches.
        vi.doMock('node:os', async () => {
          const actual =
            await vi.importActual<typeof import('node:os')>('node:os');
          return {
            ...actual,
            default: { ...actual, tmpdir: () => fallbackTmp },
          };
        });

        const { computeIsolatedTaskOutputDir } = await import(
          './diskOutput.js'
        );
        expect(computeIsolatedTaskOutputDir('proj', 'sess')).toContain(
          fallbackTmp,
        );

        vi.doUnmock('node:fs');
        vi.doUnmock('node:os');
        vi.resetModules();
        fs.rmSync(fallbackTmp, { recursive: true, force: true });
      },
    );
  });

  describe('getTaskOutputPath', () => {
    it('returns path with .output extension', () => {
      const p = getTaskOutputPath('task-123');
      expect(p).toBe(path.join(tmpDir, 'task-123.output'));
    });
  });

  describe('initTaskOutput', () => {
    it('creates an empty file', async () => {
      const outputPath = await initTaskOutput('init-test');
      expect(fs.existsSync(outputPath)).toBe(true);
      expect(fs.readFileSync(outputPath, 'utf-8')).toBe('');
    });

    it('creates a new output directory after the configured directory changes', async () => {
      const firstDir = path.join(tmpDir, 'first');
      const secondDir = path.join(tmpDir, 'second');

      setTaskOutputDir(firstDir);
      const firstPath = await initTaskOutput('first-task');
      setTaskOutputDir(secondDir);
      const secondPath = await initTaskOutput('second-task');

      expect(firstPath).toBe(path.join(firstDir, 'first-task.output'));
      expect(secondPath).toBe(path.join(secondDir, 'second-task.output'));
      expect(fs.existsSync(firstPath)).toBe(true);
      expect(fs.existsSync(secondPath)).toBe(true);
    });

    it('initializes the captured output path instead of the current global directory', async () => {
      const capturedPath = path.join(
        tmpDir,
        'captured',
        'captured-task.output',
      );
      const laterDir = path.join(tmpDir, 'later');
      setTaskOutputDir(laterDir);

      const outputPath = await initTaskOutput(
        'captured-task',
        capturedPath,
      );

      expect(outputPath).toBe(capturedPath);
      expect(fs.existsSync(capturedPath)).toBe(true);
      expect(
        fs.existsSync(path.join(laterDir, 'captured-task.output')),
      ).toBe(false);
    });

    it('creates a symlink output when requested', async () => {
      const targetPath = path.join(tmpDir, 'target.jsonl');
      fs.writeFileSync(targetPath, 'transcript');

      const outputPath = await initTaskOutputAsSymlink('link-test', targetPath);

      expect(fs.lstatSync(outputPath).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(outputPath, 'utf-8')).toBe('transcript');
    });
  });

  describe('DiskTaskOutput', () => {
    it('appends content and flushes to file', async () => {
      const output = new DiskTaskOutput('disk-test-1');
      output.append('hello ');
      output.append('world');
      await output.flush();

      const content = fs.readFileSync(
        getTaskOutputPath('disk-test-1'),
        'utf-8',
      );
      expect(content).toBe('hello world');
    });

    it('cancel stops pending writes', async () => {
      const output = new DiskTaskOutput('disk-cancel');
      output.append('data1');
      output.cancel();
      // After cancel, flush should resolve but file may be empty or partial
      await output.flush();
    });
  });

  describe('appendTaskOutput / flushTaskOutput', () => {
    it('writes content via the global registry', async () => {
      appendTaskOutput('global-task', 'chunk1');
      appendTaskOutput('global-task', 'chunk2');
      await flushTaskOutput('global-task');

      const content = fs.readFileSync(
        getTaskOutputPath('global-task'),
        'utf-8',
      );
      expect(content).toBe('chunk1chunk2');
    });
  });

  describe('getTaskOutput', () => {
    it('reads the tail of the output file', async () => {
      appendTaskOutput('tail-task', 'line1\nline2\nline3');
      await flushTaskOutput('tail-task');

      const content = await getTaskOutput('tail-task');
      expect(content).toBe('line1\nline2\nline3');
    });

    it('returns empty string for non-existent task', async () => {
      const content = await getTaskOutput('no-such-task');
      expect(content).toBe('');
    });
  });

  describe('getTaskOutputDelta', () => {
    it('reads delta from offset', async () => {
      appendTaskOutput('delta-task', 'AAABBBCCC');
      await flushTaskOutput('delta-task');

      const { content, newOffset } = await getTaskOutputDelta(
        'delta-task',
        3,
        3,
      );
      expect(content).toBe('BBB');
      expect(newOffset).toBe(6);
    });

    it('returns empty for offset beyond file', async () => {
      appendTaskOutput('delta-past', 'short');
      await flushTaskOutput('delta-past');

      const { content, newOffset } = await getTaskOutputDelta(
        'delta-past',
        1000,
      );
      expect(content).toBe('');
      expect(newOffset).toBe(1000);
    });
  });

  describe('getTaskOutputSize', () => {
    it('returns 0 for non-existent task', async () => {
      const size = await getTaskOutputSize('no-task');
      expect(size).toBe(0);
    });

    it('returns correct size after writes', async () => {
      appendTaskOutput('size-task', 'hello');
      await flushTaskOutput('size-task');

      const size = await getTaskOutputSize('size-task');
      expect(size).toBe(5);
    });
  });

  describe('cleanupTaskOutput', () => {
    it('deletes the output file', async () => {
      appendTaskOutput('cleanup-task', 'data');
      await flushTaskOutput('cleanup-task');

      const outputPath = getTaskOutputPath('cleanup-task');
      expect(fs.existsSync(outputPath)).toBe(true);

      await cleanupTaskOutput('cleanup-task');
      expect(fs.existsSync(outputPath)).toBe(false);
    });

    it('does not throw for non-existent task', async () => {
      await expect(cleanupTaskOutput('no-task')).resolves.not.toThrow();
    });
  });

  describe('MAX_TASK_OUTPUT_BYTES_DISPLAY', () => {
    it('is a human-readable string', () => {
      expect(MAX_TASK_OUTPUT_BYTES_DISPLAY).toBe('5GB');
    });
  });
});

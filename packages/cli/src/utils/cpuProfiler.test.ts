/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock cleanup.ts to avoid pulling in @qwen-code/qwen-code-core dependency chain
vi.mock('./cleanup.js', () => ({
  registerCleanup: vi.fn(),
}));

import {
  _resetCpuProfilerForTest,
  _setSessionFactoryForTest,
  clearCpuProfileRateLimit,
  isCpuProfileRecording,
  startCpuProfile,
  stopCpuProfile,
} from './cpuProfiler.js';

function createMockSession() {
  const mockProfile = {
    nodes: [
      {
        id: 1,
        callFrame: {
          functionName: 'test',
          scriptId: '1',
          url: '',
          lineNumber: 0,
          columnNumber: 0,
        },
        hitCount: 10,
        children: [],
      },
    ],
    startTime: 0,
    endTime: 1000000,
    samples: [1],
    timeDeltas: [100],
  };

  const post = vi.fn().mockImplementation((method: string) => {
    if (method === 'Profiler.stop') {
      return Promise.resolve({ profile: mockProfile });
    }
    return Promise.resolve(undefined);
  });
  const connect = vi.fn();
  const disconnect = vi.fn();

  return { post, connect, disconnect };
}

describe('cpuProfiler', () => {
  let tmpDir: string;
  let mockSession: ReturnType<typeof createMockSession>;

  beforeEach(() => {
    _resetCpuProfilerForTest();
    clearCpuProfileRateLimit();

    mockSession = createMockSession();
    _setSessionFactoryForTest(async () => mockSession);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpu-profiler-test-'));
  });

  afterEach(() => {
    _resetCpuProfilerForTest();
    _setSessionFactoryForTest(null);
    vi.restoreAllMocks();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('isCpuProfileRecording', () => {
    it('returns false when not recording', () => {
      expect(isCpuProfileRecording()).toBe(false);
    });

    it('returns true when recording', async () => {
      await startCpuProfile();
      expect(isCpuProfileRecording()).toBe(true);
    });
  });

  describe('startCpuProfile', () => {
    it('starts profiling successfully', async () => {
      const result = await startCpuProfile();
      expect(result).toEqual({ ok: true });
      expect(mockSession.post).toHaveBeenCalledWith('Profiler.enable');
      expect(mockSession.post).toHaveBeenCalledWith(
        'Profiler.setSamplingInterval',
        { interval: 1000 },
      );
      expect(mockSession.post).toHaveBeenCalledWith('Profiler.start');
    });

    it('accepts custom sampling interval', async () => {
      await startCpuProfile({ samplingInterval: 500 });
      expect(mockSession.post).toHaveBeenCalledWith(
        'Profiler.setSamplingInterval',
        { interval: 500 },
      );
    });

    it('returns error when already recording', async () => {
      await startCpuProfile();
      const result = await startCpuProfile();
      expect(result).toEqual({
        ok: false,
        error: 'CPU profiling is already in progress.',
      });
    });

    it('returns error and resets state on session failure', async () => {
      _setSessionFactoryForTest(async () => {
        throw new Error('Connection refused');
      });

      const result = await startCpuProfile();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Connection refused');
      }
      expect(isCpuProfileRecording()).toBe(false);
    });
  });

  describe('stopCpuProfile', () => {
    it('stops and writes profile file', async () => {
      await startCpuProfile();
      const result = await stopCpuProfile({ outputDir: tmpDir });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.filePath).toMatch(/qwen-code-cpu-\d+-.*\.cpuprofile$/);
        expect(fs.existsSync(result.filePath)).toBe(true);

        const content = JSON.parse(fs.readFileSync(result.filePath, 'utf8'));
        expect(content.nodes).toBeDefined();
        expect(content.startTime).toBeDefined();
      }
    });

    it('returns error when not recording', async () => {
      const result = await stopCpuProfile({ outputDir: tmpDir });
      expect(result).toEqual({
        ok: false,
        error: 'CPU profiler is not recording.',
      });
    });

    it('calls Profiler.stop and Profiler.disable', async () => {
      await startCpuProfile();
      mockSession.post.mockClear();
      await stopCpuProfile({ outputDir: tmpDir });

      expect(mockSession.post).toHaveBeenCalledWith('Profiler.stop');
      expect(mockSession.post).toHaveBeenCalledWith('Profiler.disable');
    });

    it('sets file permissions to 0o600', async () => {
      await startCpuProfile();
      const result = await stopCpuProfile({ outputDir: tmpDir });

      if (result.ok && process.platform !== 'win32') {
        const stats = fs.statSync(result.filePath);
        expect(stats.mode & 0o777).toBe(0o600);
      }
    });
  });

  describe('rate limiting', () => {
    it('enforces rate limit between writes', async () => {
      const now = new Date('2026-05-29T10:00:00.000Z');

      await startCpuProfile();
      const first = await stopCpuProfile({ outputDir: tmpDir, now });
      expect(first.ok).toBe(true);

      // Second write within rate limit window
      await startCpuProfile();
      const second = await stopCpuProfile({
        outputDir: tmpDir,
        now: new Date(now.getTime() + 5000), // 5s later, within 30s limit
      });
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.error).toContain('rate limit');
      }
    });

    it('allows write after rate limit expires', async () => {
      const now = new Date('2026-05-29T10:00:00.000Z');

      await startCpuProfile();
      await stopCpuProfile({ outputDir: tmpDir, now });

      // After rate limit window
      await startCpuProfile();
      const result = await stopCpuProfile({
        outputDir: tmpDir,
        now: new Date(now.getTime() + 31000), // 31s later
      });
      expect(result.ok).toBe(true);
    });
  });

  describe('old profile cleanup', () => {
    it('removes old profiles beyond max count', async () => {
      // Create 5 existing profiles
      for (let i = 0; i < 5; i++) {
        const name = `qwen-code-cpu-99999-2026-05-29T0${i}-00-00-000Z.cpuprofile`;
        fs.writeFileSync(path.join(tmpDir, name), '{}');
        // Stagger mtime so sort is deterministic
        const mtime = new Date(Date.now() - (5 - i) * 1000);
        fs.utimesSync(path.join(tmpDir, name), mtime, mtime);
      }

      clearCpuProfileRateLimit();
      await startCpuProfile();
      const result = await stopCpuProfile({
        outputDir: tmpDir,
        maxProfiles: 5,
      });
      expect(result.ok).toBe(true);

      const files = fs
        .readdirSync(tmpDir)
        .filter((f) => f.endsWith('.cpuprofile'));
      // Should have at most 5 files (new one replaces oldest)
      expect(files.length).toBeLessThanOrEqual(5);
    });
  });

  describe('conflict handling', () => {
    it('rejects second start while recording', async () => {
      const first = await startCpuProfile();
      expect(first.ok).toBe(true);

      const second = await startCpuProfile();
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.error).toContain('already in progress');
      }
    });

    it('resets state after stop so new recording can start', async () => {
      await startCpuProfile();
      await stopCpuProfile({ outputDir: tmpDir });

      clearCpuProfileRateLimit();
      const result = await startCpuProfile();
      expect(result.ok).toBe(true);
    });
  });

  describe('initCpuProfiler', () => {
    it('is idempotent — calling twice does not error', async () => {
      const { initCpuProfiler } = await import('./cpuProfiler.js');
      // First call
      initCpuProfiler();
      // Second call should be a no-op
      initCpuProfiler();
      // No error thrown means success
    });

    it('does not start recording when env var is unset', async () => {
      _resetCpuProfilerForTest();
      delete process.env['QWEN_CODE_CPU_PROFILE'];
      const { initCpuProfiler } = await import('./cpuProfiler.js');
      _resetCpuProfilerForTest();
      initCpuProfiler();
      expect(isCpuProfileRecording()).toBe(false);
    });
  });

  describe('SIGUSR1 toggle (via start/stop cycle)', () => {
    it('simulates signal toggle: start then stop', async () => {
      // Simulate what handleSigusr1 does internally
      expect(isCpuProfileRecording()).toBe(false);

      // First signal: start
      const startResult = await startCpuProfile();
      expect(startResult.ok).toBe(true);
      expect(isCpuProfileRecording()).toBe(true);

      // Second signal: stop
      const stopResult = await stopCpuProfile({ outputDir: tmpDir });
      expect(stopResult.ok).toBe(true);
      expect(isCpuProfileRecording()).toBe(false);
    });

    it('ignores stop when in idle state', async () => {
      const result = await stopCpuProfile({ outputDir: tmpDir });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('not recording');
      }
    });
  });

  describe('empty profile guard', () => {
    it('returns error when V8 returns empty profile', async () => {
      _resetCpuProfilerForTest();
      const emptyMock = {
        post: vi.fn().mockImplementation((method: string) => {
          if (method === 'Profiler.stop') {
            return Promise.resolve({ profile: undefined });
          }
          return Promise.resolve(undefined);
        }),
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      _setSessionFactoryForTest(async () => emptyMock);

      await startCpuProfile();
      const result = await stopCpuProfile({ outputDir: tmpDir });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('empty profile');
      }
    });
  });
});

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import {
  initStartupProfiler,
  profileCheckpoint,
  finalizeStartupProfile,
  getStartupReport,
  resetStartupProfiler,
} from './startupProfiler.js';

vi.mock('node:fs');

describe('startupProfiler', () => {
  const savedEnv: Record<string, string | undefined> = {};

  function saveEnv(...keys: string[]) {
    for (const k of keys) {
      savedEnv[k] = process.env[k];
    }
  }

  function restoreEnv() {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v !== undefined) {
        process.env[k] = v;
      } else {
        delete process.env[k];
      }
    }
  }

  beforeEach(() => {
    resetStartupProfiler();
    vi.restoreAllMocks();
    saveEnv('QWEN_CODE_PROFILE_STARTUP', 'SANDBOX');
    delete process.env['QWEN_CODE_PROFILE_STARTUP'];
    delete process.env['SANDBOX'];
  });

  afterEach(() => {
    restoreEnv();
  });

  function enableProfiler() {
    process.env['QWEN_CODE_PROFILE_STARTUP'] = '1';
    process.env['SANDBOX'] = '1';
  }

  describe('when disabled (no env var)', () => {
    it('should return null from getStartupReport', () => {
      initStartupProfiler();
      profileCheckpoint('test');
      expect(getStartupReport()).toBeNull();
    });

    it('should not write any files on finalize', () => {
      initStartupProfiler();
      profileCheckpoint('test');
      finalizeStartupProfile('session-1');
      expect(fs.mkdirSync).not.toHaveBeenCalled();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe('when outside sandbox (SANDBOX not set)', () => {
    it('should not enable profiler even with QWEN_CODE_PROFILE_STARTUP=1', () => {
      process.env['QWEN_CODE_PROFILE_STARTUP'] = '1';
      delete process.env['SANDBOX'];

      initStartupProfiler();
      profileCheckpoint('test');
      expect(getStartupReport()).toBeNull();
    });
  });

  describe('when enabled (QWEN_CODE_PROFILE_STARTUP=1 + SANDBOX)', () => {
    beforeEach(() => {
      enableProfiler();
    });

    it('should collect checkpoints and return a report', () => {
      initStartupProfiler();
      profileCheckpoint('phase_a');
      profileCheckpoint('phase_b');
      profileCheckpoint('phase_c');

      const report = getStartupReport();
      expect(report).not.toBeNull();
      expect(report!.phases).toHaveLength(3);
      expect(report!.phases[0]!.name).toBe('phase_a');
      expect(report!.phases[1]!.name).toBe('phase_b');
      expect(report!.phases[2]!.name).toBe('phase_c');
      expect(report!.totalMs).toBeGreaterThanOrEqual(0);
      expect(report!.nodeVersion).toBe(process.version);
      expect(report!.platform).toBe(process.platform);
      expect(report!.arch).toBe(process.arch);
    });

    it('should have non-negative durations for each phase', () => {
      initStartupProfiler();
      profileCheckpoint('a');
      profileCheckpoint('b');

      const report = getStartupReport();
      for (const phase of report!.phases) {
        expect(phase.durationMs).toBeGreaterThanOrEqual(0);
        expect(phase.startMs).toBeGreaterThanOrEqual(0);
      }
    });

    it('should write JSON file on finalize and print path to stderr', () => {
      vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockReturnValue(true);

      initStartupProfiler();
      profileCheckpoint('main_entry');
      profileCheckpoint('after_load_settings');
      finalizeStartupProfile('test-session-123');

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('startup-perf'),
        { recursive: true },
      );
      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);

      const writtenPath = vi.mocked(fs.writeFileSync).mock
        .calls[0]![0] as string;
      expect(writtenPath).toContain('startup-perf');
      expect(writtenPath).toContain('test-session-123');
      expect(writtenPath).toMatch(/\.json$/);

      const writtenContent = JSON.parse(
        vi.mocked(fs.writeFileSync).mock.calls[0]![1] as string,
      );
      expect(writtenContent.sessionId).toBe('test-session-123');
      expect(writtenContent.phases).toHaveLength(2);
      expect(writtenContent.totalMs).toBeGreaterThanOrEqual(0);

      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('Startup profile written to:'),
      );
    });

    it('should use report timestamp for filename (no double Date call)', () => {
      vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      initStartupProfiler();
      profileCheckpoint('test');
      finalizeStartupProfile('s1');

      const writtenPath = vi.mocked(fs.writeFileSync).mock
        .calls[0]![0] as string;
      const writtenContent = JSON.parse(
        vi.mocked(fs.writeFileSync).mock.calls[0]![1] as string,
      );
      // Filename should contain the same timestamp as the report (with colons/dots replaced)
      const expectedTs = writtenContent.timestamp.replace(/[:.]/g, '-');
      expect(writtenPath).toContain(expectedTs);
    });

    it('should not finalize twice', () => {
      vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      initStartupProfiler();
      profileCheckpoint('test');
      finalizeStartupProfile('s1');
      finalizeStartupProfile('s1');

      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    });

    it('should use "unknown" as sessionId in both filename and JSON when not provided', () => {
      vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      initStartupProfiler();
      profileCheckpoint('test');
      finalizeStartupProfile();

      const writtenPath = vi.mocked(fs.writeFileSync).mock
        .calls[0]![0] as string;
      expect(writtenPath).toContain('unknown');

      const writtenContent = JSON.parse(
        vi.mocked(fs.writeFileSync).mock.calls[0]![1] as string,
      );
      expect(writtenContent.sessionId).toBe('unknown');
    });

    it('should not throw when file write fails', () => {
      vi.mocked(fs.mkdirSync).mockImplementation(() => {
        throw new Error('Permission denied');
      });
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockReturnValue(true);

      initStartupProfiler();
      profileCheckpoint('test');

      expect(() => finalizeStartupProfile('s1')).not.toThrow();
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('Warning'),
      );
    });

    it('should return null after reset', () => {
      initStartupProfiler();
      profileCheckpoint('test');
      expect(getStartupReport()).not.toBeNull();

      resetStartupProfiler();
      expect(getStartupReport()).toBeNull();
    });
  });
});

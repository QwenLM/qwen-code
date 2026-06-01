/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MemoryDiagnosticsDumper } from './memoryDiagnosticsDumper.js';
import type { Config } from '../config/config.js';

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('../utils/memoryDiagnostics.js', () => ({
  collectMemoryDiagnostics: vi.fn().mockResolvedValue({
    timestamp: '2026-05-31T00:00:00.000Z',
    memoryUsage: {
      rss: 2_000_000_000,
      heapUsed: 1_800_000_000,
      heapTotal: 2_048_000_000,
      external: 50_000_000,
      arrayBuffers: 10_000_000,
    },
    v8HeapStats: {
      heapSizeLimit: 4_096_000_000,
      totalHeapSize: 2_048_000_000,
      usedHeapSize: 1_800_000_000,
    },
  }),
}));

function createMockConfig(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getSessionId: vi.fn().mockReturnValue('test-session-id-12345678'),
    getCliVersion: vi.fn().mockReturnValue('0.17.0'),
    getGeminiClient: vi.fn().mockReturnValue({
      getChat: () => ({
        getHistoryLength: () => 500,
      }),
    }),
    storage: {
      getProjectDir: vi.fn().mockReturnValue('/tmp/test-project'),
    },
    ...overrides,
  } as unknown as Config;
}

describe('MemoryDiagnosticsDumper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes diagnostics JSON on first dump', async () => {
    const config = createMockConfig();
    const dumper = new MemoryDiagnosticsDumper(config);

    const result = await dumper.dump('hard');

    expect(result).toBeDefined();
    expect(result!.trigger).toBe('hard');
    expect(result!.filePath).toContain(
      path.join('/tmp/test-project', 'diagnostics') + path.sep,
    );
    expect(result!.filePath).toContain('memory-test-ses');
    expect(fs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('diagnostics'),
      { recursive: true },
    );
    expect(fs.writeFileSync).toHaveBeenCalledOnce();

    const writtenContent = JSON.parse(
      vi.mocked(fs.writeFileSync).mock.calls[0][1] as string,
    );
    expect(writtenContent.trigger).toBe('hard');
    expect(writtenContent.dumpNumber).toBe(1);
    expect(writtenContent.memoryUsage.rss).toBe(2_000_000_000);
    expect(writtenContent.session.historyEntries).toBe(500);
    expect(writtenContent.suggestion).toContain('/compact');
  });

  it('respects per-session cap of 3 dumps', async () => {
    const config = createMockConfig();
    const dumper = new MemoryDiagnosticsDumper(config);

    // Bypass cooldown by mocking Date.now
    let mockNow = 1000000;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      mockNow += 60_000;
      return mockNow;
    });

    const r1 = await dumper.dump('hard');
    const r2 = await dumper.dump('critical');
    const r3 = await dumper.dump('hard');
    const r4 = await dumper.dump('critical');

    expect(r1).toBeDefined();
    expect(r2).toBeDefined();
    expect(r3).toBeDefined();
    expect(r4).toBeUndefined();
    expect(fs.writeFileSync).toHaveBeenCalledTimes(3);
  });

  it('respects cooldown between dumps', async () => {
    const config = createMockConfig();
    const dumper = new MemoryDiagnosticsDumper(config);

    const mockNow = 1000000;
    vi.spyOn(Date, 'now').mockReturnValue(mockNow);

    const r1 = await dumper.dump('hard');
    const r2 = await dumper.dump('hard');

    expect(r1).toBeDefined();
    expect(r2).toBeUndefined();
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it('resets state on new session', async () => {
    const config = createMockConfig();
    const dumper = new MemoryDiagnosticsDumper(config);

    let mockNow = 1000000;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      mockNow += 60_000;
      return mockNow;
    });

    await dumper.dump('hard');
    await dumper.dump('hard');
    await dumper.dump('hard');

    // Cap reached
    const r4 = await dumper.dump('hard');
    expect(r4).toBeUndefined();

    // Reset
    dumper.resetForNewSession();

    const r5 = await dumper.dump('critical');
    expect(r5).toBeDefined();
    expect(r5!.trigger).toBe('critical');
  });

  it('includes critical suggestion for critical pressure', async () => {
    const config = createMockConfig();
    const dumper = new MemoryDiagnosticsDumper(config);

    await dumper.dump('critical');

    const writtenContent = JSON.parse(
      vi.mocked(fs.writeFileSync).mock.calls[0][1] as string,
    );
    expect(writtenContent.suggestion).toContain('critically high');
  });

  it('handles missing geminiClient gracefully', async () => {
    const config = createMockConfig({
      getGeminiClient: vi.fn().mockReturnValue(null),
    });
    const dumper = new MemoryDiagnosticsDumper(config);

    const result = await dumper.dump('hard');

    expect(result).toBeDefined();
    const writtenContent = JSON.parse(
      vi.mocked(fs.writeFileSync).mock.calls[0][1] as string,
    );
    expect(writtenContent.session.available).toBe(false);
  });
});

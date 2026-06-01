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

vi.mock('node:v8', () => ({
  getHeapStatistics: vi.fn().mockReturnValue({
    heap_size_limit: 4_096_000_000,
    total_heap_size: 2_048_000_000,
    used_heap_size: 1_800_000_000,
    total_available_size: 2_000_000_000,
  }),
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
    // Two-phase write: Phase 1 (minimal) + Phase 2 (full)
    expect(fs.writeFileSync).toHaveBeenCalledTimes(2);

    const phase1Content = JSON.parse(
      vi.mocked(fs.writeFileSync).mock.calls[0][1] as string,
    );
    expect(phase1Content.trigger).toBe('hard');
    expect(phase1Content.dumpNumber).toBe(1);
    expect(phase1Content.collectionComplete).toBe(false);
    expect(phase1Content.memoryUsage).toBeDefined();
    expect(phase1Content.v8HeapStats).toBeDefined();

    const phase2Content = JSON.parse(
      vi.mocked(fs.writeFileSync).mock.calls[1][1] as string,
    );
    expect(phase2Content.trigger).toBe('hard');
    expect(phase2Content.dumpNumber).toBe(1);
    expect(phase2Content.collectionComplete).toBe(true);
    expect(phase2Content.memoryUsage.rss).toBe(2_000_000_000);
    expect(phase2Content.session.historyEntries).toBe(500);
    expect(phase2Content.suggestion).toContain('/compact');
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
    // 3 successful dumps × 2 writes each (Phase 1 + Phase 2)
    expect(fs.writeFileSync).toHaveBeenCalledTimes(6);
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
    // 1 successful dump × 2 writes (Phase 1 + Phase 2)
    expect(fs.writeFileSync).toHaveBeenCalledTimes(2);
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

    // Phase 2 (full payload) is the second write
    const writtenContent = JSON.parse(
      vi.mocked(fs.writeFileSync).mock.calls[1][1] as string,
    );
    expect(writtenContent.suggestion).toContain('critically high');
    expect(writtenContent.collectionComplete).toBe(true);
  });

  it('writes Phase 1 synchronously before any await (survives crash during Phase 2)', async () => {
    const config = createMockConfig();
    const dumper = new MemoryDiagnosticsDumper(config);

    // Fire dump() but do not await — Phase 1 must have already written to disk
    // because async functions execute synchronously up to the first await.
    const promise = dumper.dump('hard');

    // At this point Phase 2 has not run yet (its await is pending), but Phase 1
    // must have completed its writeFileSync call.
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    const phase1Content = JSON.parse(
      vi.mocked(fs.writeFileSync).mock.calls[0][1] as string,
    );
    expect(phase1Content.collectionComplete).toBe(false);

    await promise;
    // Phase 2 has now overwritten the file
    expect(fs.writeFileSync).toHaveBeenCalledTimes(2);
  });

  it('reserves slot synchronously to prevent concurrent dumps from bypassing cap', async () => {
    const config = createMockConfig();
    const dumper = new MemoryDiagnosticsDumper(config);

    let mockNow = 1000000;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      mockNow += 60_000;
      return mockNow;
    });

    // Fire 4 concurrent dumps without awaiting between them. The synchronous
    // slot reservation must enforce the cap of 3 even though all 4 calls happen
    // before any of them complete their async Phase 2.
    const results = await Promise.all([
      dumper.dump('hard'),
      dumper.dump('hard'),
      dumper.dump('hard'),
      dumper.dump('hard'),
    ]);

    const successful = results.filter((r) => r !== undefined);
    expect(successful).toHaveLength(3);
    expect(results[3]).toBeUndefined();
  });

  it('handles missing geminiClient gracefully', async () => {
    const config = createMockConfig({
      getGeminiClient: vi.fn().mockReturnValue(null),
    });
    const dumper = new MemoryDiagnosticsDumper(config);

    const result = await dumper.dump('hard');

    expect(result).toBeDefined();
    // Phase 2 (full payload) is the second write
    const writtenContent = JSON.parse(
      vi.mocked(fs.writeFileSync).mock.calls[1][1] as string,
    );
    expect(writtenContent.session.available).toBe(false);
  });
});

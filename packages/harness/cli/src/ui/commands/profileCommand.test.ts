/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from './types.js';
import { profileCommand } from './profileCommand.js';
import {
  getOrInitRuntimeProfiler,
  isRunningWithBun,
} from '@qwen-code/core';

const mockProfiler = vi.hoisted(() => ({
  getLightweightLogIntervalMs: vi.fn(),
  getOutputDir: vi.fn(),
  hasPendingCpuProfile: vi.fn(),
  hasPendingHeapAllocationProfile: vi.fn(),
  isCpuProfilingActive: vi.fn(),
  isHeapAllocationProfilingActive: vi.fn(),
  isLightweightLoggingActive: vi.fn(),
  recordLightweightSample: vi.fn(),
  startCpuProfiling: vi.fn(),
  startHeapAllocationProfiling: vi.fn(),
  startLightweightLogging: vi.fn(),
  stopCpuProfiling: vi.fn(),
  stopHeapAllocationProfiling: vi.fn(),
  stopLightweightLogging: vi.fn(),
  takeHeapSnapshot: vi.fn(),
}));

vi.mock('@qwen-code/core', () => ({
  BUN_CPU_PROFILING_UNSUPPORTED_MESSAGE:
    'CPU profiling is not supported under Bun because Bun does not implement node:inspector/promises. Use /profile snapshot for heap snapshots, or run with Node.js for V8 CPU profiles.',
  formatLightweightProfileSample: vi.fn(() => 'formatted sample'),
  getErrorMessage: vi.fn((err: unknown) =>
    err instanceof Error ? err.message : String(err),
  ),
  getOrInitRuntimeProfiler: vi.fn(() => mockProfiler),
  isRunningWithBun: vi.fn(() => false),
  parseProfileLogIntervalMs: vi.fn(() => 30_000),
}));

describe('profileCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProfiler.getLightweightLogIntervalMs.mockReturnValue(60_000);
    mockProfiler.getOutputDir.mockReturnValue('/tmp/profile');
    mockProfiler.hasPendingCpuProfile.mockReturnValue(false);
    mockProfiler.hasPendingHeapAllocationProfile.mockReturnValue(false);
    mockProfiler.isCpuProfilingActive.mockReturnValue(false);
    mockProfiler.isHeapAllocationProfilingActive.mockReturnValue(false);
    mockProfiler.isLightweightLoggingActive.mockReturnValue(false);
    vi.mocked(isRunningWithBun).mockReturnValue(false);
    mockProfiler.stopCpuProfiling.mockResolvedValue({
      durationMs: 123,
      filePath: '/tmp/profile/cpu.cpuprofile.enc',
      sizeBytes: 456,
      type: 'cpu',
    });
    mockProfiler.stopHeapAllocationProfiling.mockResolvedValue({
      durationMs: 234,
      filePath: '/tmp/profile/heap.heapprofile.enc',
      sizeBytes: 567,
      type: 'heap-allocation',
    });
    mockProfiler.takeHeapSnapshot.mockResolvedValue({
      filePath: '/tmp/profile/heap.heapsnapshot.enc',
      sizeBytes: 678,
      type: 'heap-snapshot',
    });
  });

  it('includes usage in the command description shown by slash completion', () => {
    expect(profileCommand.description).toContain('Usage: /profile');
    expect(profileCommand.description).toContain('heap-alloc start');
    expect(profileCommand.description).not.toContain('log ');
    expect(profileCommand.description).not.toContain('|heap|');
  });

  it('shows usage including heap allocation controls', async () => {
    const result = await runProfileCommand('');

    expect(result).toMatchObject({
      messageType: 'info',
      type: 'message',
    });
    expect(result.content).toContain('heap-alloc start');
    expect(result.content).not.toContain('log ');
    expect(getOrInitRuntimeProfiler).not.toHaveBeenCalled();
  });

  it('shows only Bun-compatible controls in Bun usage', async () => {
    vi.mocked(isRunningWithBun).mockReturnValue(true);

    for (const args of ['', 'not-a-command']) {
      const result = await runProfileCommand(args);

      expect(result.content).toBe('Usage: /profile [snapshot|status]');
    }
  });

  it('supports /profile cpu as a start shortcut', async () => {
    const result = await runProfileCommand('cpu');

    expect(mockProfiler.startCpuProfiling).toHaveBeenCalled();
    expect(result).toMatchObject({
      content: 'CPU profiling started.',
      messageType: 'info',
      type: 'message',
    });
  });

  it('supports /profile cpu as a stop shortcut when active', async () => {
    mockProfiler.isCpuProfilingActive.mockReturnValue(true);

    const result = await runProfileCommand('cpu');

    expect(mockProfiler.stopCpuProfiling).toHaveBeenCalled();
    expect(result.content).toContain('Encrypted CPU profile saved');
  });

  it('reports CPU profiling as unsupported under Bun without starting it', async () => {
    vi.mocked(isRunningWithBun).mockReturnValue(true);

    for (const args of ['cpu', 'cpu start']) {
      const result = await runProfileCommand(args);

      expect(result).toMatchObject({
        content: expect.stringContaining(
          'CPU profiling is not supported under Bun',
        ),
        messageType: 'warning',
        type: 'message',
      });
    }
    expect(mockProfiler.startCpuProfiling).not.toHaveBeenCalled();
  });

  it('starts heap allocation profiling explicitly', async () => {
    const result = await runProfileCommand('heap-alloc start');

    expect(mockProfiler.startHeapAllocationProfiling).toHaveBeenCalled();
    expect(result).toMatchObject({
      content: 'Heap allocation profiling started.',
      messageType: 'info',
      type: 'message',
    });
  });

  it('stops heap allocation profiling and reports encrypted output', async () => {
    mockProfiler.isHeapAllocationProfilingActive.mockReturnValue(true);

    const result = await runProfileCommand('heap-alloc stop');

    expect(mockProfiler.stopHeapAllocationProfiling).toHaveBeenCalled();
    expect(result.content).toContain(
      'Encrypted heap allocation profile saved',
    );
    expect(result.content).toContain('.enc');
  });

  it('keeps heap as a heap snapshot alias', async () => {
    const result = await runProfileCommand('heap');

    expect(mockProfiler.takeHeapSnapshot).toHaveBeenCalled();
    expect(result.content).toContain('Encrypted heap snapshot saved');
  });

  it('includes heap allocation state in status output', async () => {
    const result = await runProfileCommand('status');

    expect(result.content).toContain(
      'Heap allocation profiling: inactive',
    );
  });

  it('reports CPU profiling as unsupported in Bun status output', async () => {
    vi.mocked(isRunningWithBun).mockReturnValue(true);

    const result = await runProfileCommand('status');

    expect(result.content).toContain('Runtime: Bun (JSC)');
    expect(result.content).toContain('CPU profiling: unsupported under Bun');
  });

  it('allows retrying a pending CPU profile save', async () => {
    mockProfiler.hasPendingCpuProfile.mockReturnValue(true);

    const result = await runProfileCommand('cpu stop');

    expect(mockProfiler.stopCpuProfiling).toHaveBeenCalled();
    expect(result.content).toContain('Encrypted CPU profile saved');
  });

  it('reports pending profile saves in status output', async () => {
    mockProfiler.hasPendingCpuProfile.mockReturnValue(true);
    mockProfiler.hasPendingHeapAllocationProfile.mockReturnValue(true);

    const result = await runProfileCommand('status');

    expect(result.content).toContain('CPU profiling: pending save');
    expect(result.content).toContain(
      'Heap allocation profiling: pending save',
    );
  });
});

interface MessageResult {
  content: string;
  messageType: 'info' | 'warning' | 'error';
  type: 'message';
}

async function runProfileCommand(args: string): Promise<MessageResult> {
  return (await profileCommand.action?.(
    {
      invocation: {
        args,
        name: 'profile',
        raw: `/profile ${args}`.trim(),
      },
    } as CommandContext,
    args,
  )) as MessageResult;
}

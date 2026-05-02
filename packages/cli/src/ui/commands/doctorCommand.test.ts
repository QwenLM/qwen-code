/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { doctorCommand } from './doctorCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import * as doctorChecksModule from '../../utils/doctorChecks.js';
import * as memoryDiagnosticsModule from '../../utils/memoryDiagnostics.js';
import { collectMemoryDiagnostics } from '@qwen-code/qwen-code-core';
import type { DoctorCheckResult } from '../types.js';

vi.mock('../../utils/doctorChecks.js');
vi.mock('../../utils/memoryDiagnostics.js');
vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/qwen-code-core')>()),
  collectMemoryDiagnostics: vi.fn(),
}));

describe('doctorCommand', () => {
  let mockContext: CommandContext;

  const getMemoryCommand = () => {
    const memoryCommand = doctorCommand.subCommands?.find(
      (command) => command.name === 'memory',
    );
    expect(memoryCommand).toBeDefined();
    return memoryCommand!;
  };

  const mockChecks: DoctorCheckResult[] = [
    {
      category: 'System',
      name: 'Node.js version',
      status: 'pass',
      message: 'v20.0.0',
    },
    {
      category: 'Authentication',
      name: 'API key',
      status: 'fail',
      message: 'not configured',
      detail: 'Run /auth to configure authentication.',
    },
  ];

  function mockMemoryDiagnostics() {
    vi.mocked(memoryDiagnosticsModule.getMemoryDiagnostics).mockReturnValue({
      generatedAt: '2026-05-15T12:00:00.000Z',
      process: {
        pid: 123,
        nodeVersion: 'v22.0.0',
        platform: 'linux',
        arch: 'x64',
        uptimeSeconds: 42,
      },
      memory: {
        rss: 100,
        heapTotal: 80,
        heapUsed: 40,
        external: 5,
        arrayBuffers: 2,
      },
      v8: {
        heapStatistics: {},
        heapSpaces: [],
      },
      activeHandles: { count: 3, unavailable: false },
      activeRequests: { count: 1, unavailable: false },
    });
    vi.mocked(memoryDiagnosticsModule.formatMemoryDiagnostics).mockReturnValue(
      'Memory diagnostics\nRSS: 100.0 MiB\nActive handles: 3',
    );
    vi.mocked(memoryDiagnosticsModule.writeMemoryHeapSnapshot).mockReturnValue(
      '/tmp/qwen-code-heap.heapsnapshot',
    );
    vi.mocked(
      memoryDiagnosticsModule.collectMemoryPressureSamples,
    ).mockResolvedValue([
      {
        index: 1,
        timestamp: '2026-05-15T12:00:00.000Z',
        rss: 100,
        heapTotal: 80,
        heapUsed: 40,
        external: 5,
        arrayBuffers: 2,
      },
    ]);
    vi.mocked(
      memoryDiagnosticsModule.formatMemoryPressureSamples,
    ).mockReturnValue('Memory pressure samples\nSample count: 1');
    vi.mocked(memoryDiagnosticsModule.isHighHeapPressure).mockReturnValue(
      false,
    );
  }

  beforeEach(() => {
    mockContext = createMockCommandContext({
      executionMode: 'interactive',
      ui: {
        addItem: vi.fn(),
        setPendingItem: vi.fn(),
      },
    } as unknown as CommandContext);

    vi.mocked(doctorChecksModule.runDoctorChecks).mockResolvedValue(mockChecks);
    mockMemoryDiagnostics();
    vi.mocked(collectMemoryDiagnostics).mockResolvedValue({
      timestamp: '2026-05-01T10:00:00.000Z',
      uptimeSeconds: 60,
      memoryUsage: {
        heapUsed: 1_000,
        heapTotal: 2_000,
        rss: 3_000,
        external: 100,
        arrayBuffers: 50,
      },
      v8HeapStats: {
        heapSizeLimit: 4_000,
        totalHeapSize: 2_000,
        usedHeapSize: 1_000,
        mallocedMemory: 10,
        peakMallocedMemory: 20,
        detachedContexts: 0,
        nativeContexts: 1,
      },
      resourceUsage: {
        maxRSS: 4_000,
        userCPUTime: 10,
        systemCPUTime: 20,
      },
      activeHandles: 2,
      activeRequests: 0,
      platform: 'darwin',
      nodeVersion: 'v20.19.0',
      analysis: {
        risks: [],
        recommendation: 'No obvious leak indicators.',
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should have the correct name and description', () => {
    expect(doctorCommand.name).toBe('doctor');
    expect(doctorCommand.description).toBe(
      'Run installation and environment diagnostics',
    );
  });

  it('should complete memory subcommand names', async () => {
    await expect(doctorCommand.completion!(mockContext, '')).resolves.toEqual([
      'memory',
    ]);
    await expect(
      doctorCommand.completion!(mockContext, 'mem'),
    ).resolves.toEqual(['memory']);
    await expect(doctorCommand.completion!(mockContext, 'x')).resolves.toEqual(
      [],
    );
  });

  it('should show pending item and then add doctor item in interactive mode', async () => {
    await doctorCommand.action!(mockContext, '');

    expect(mockContext.ui.setPendingItem).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Running diagnostics...' }),
    );
    expect(mockContext.ui.setPendingItem).toHaveBeenCalledWith(null);
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'doctor',
        checks: mockChecks,
        summary: { pass: 1, warn: 0, fail: 1 },
      }),
      expect.any(Number),
    );
  });

  it('should return JSON message in non-interactive mode', async () => {
    mockContext = createMockCommandContext({
      executionMode: 'non_interactive',
      ui: {
        addItem: vi.fn(),
        setPendingItem: vi.fn(),
      },
    } as unknown as CommandContext);

    const result = await doctorCommand.action!(mockContext, '');

    expect(result).toEqual(
      expect.objectContaining({
        type: 'message',
        messageType: 'error',
      }),
    );
    expect(mockContext.ui.addItem).not.toHaveBeenCalled();
  });

  it('should return info messageType when no failures', async () => {
    vi.mocked(doctorChecksModule.runDoctorChecks).mockResolvedValue([
      {
        category: 'System',
        name: 'Node.js version',
        status: 'pass',
        message: 'v20.0.0',
      },
    ]);

    mockContext = createMockCommandContext({
      executionMode: 'non_interactive',
      ui: {
        addItem: vi.fn(),
        setPendingItem: vi.fn(),
      },
    } as unknown as CommandContext);

    const result = await doctorCommand.action!(mockContext, '');

    expect(result).toEqual(
      expect.objectContaining({
        type: 'message',
        messageType: 'info',
      }),
    );
  });

  it('should render memory diagnostics in interactive mode', async () => {
    await doctorCommand.action!(mockContext, 'memory');

    expect(memoryDiagnosticsModule.getMemoryDiagnostics).toHaveBeenCalled();
    expect(memoryDiagnosticsModule.formatMemoryDiagnostics).toHaveBeenCalled();
    expect(doctorChecksModule.runDoctorChecks).not.toHaveBeenCalled();
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        text: expect.stringContaining('Memory diagnostics'),
      }),
      expect.any(Number),
    );
  });

  it('should return memory diagnostics in non-interactive mode', async () => {
    mockContext = createMockCommandContext({
      executionMode: 'non_interactive',
      ui: {
        addItem: vi.fn(),
        setPendingItem: vi.fn(),
      },
    } as unknown as CommandContext);

    const result = await doctorCommand.action!(mockContext, 'memory');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Memory diagnostics\nRSS: 100.0 MiB\nActive handles: 3',
    });
    expect(doctorChecksModule.runDoctorChecks).not.toHaveBeenCalled();
  });

  it('should capture a heap snapshot when requested', async () => {
    mockContext = createMockCommandContext({
      executionMode: 'non_interactive',
      ui: {
        addItem: vi.fn(),
        setPendingItem: vi.fn(),
      },
    } as unknown as CommandContext);

    const result = await doctorCommand.action!(
      mockContext,
      'memory --snapshot',
    );

    expect(memoryDiagnosticsModule.writeMemoryHeapSnapshot).toHaveBeenCalled();
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'Memory diagnostics\nRSS: 100.0 MiB\nActive handles: 3\n\nHeap snapshot written: /tmp/qwen-code-heap.heapsnapshot\nHeap snapshot may contain prompts, file contents, tool results, and other sensitive data. Do not share it publicly without reviewing it first.',
    });
  });

  it('should render sampled memory diagnostics in interactive mode', async () => {
    await doctorCommand.action!(mockContext, 'memory --sample');

    expect(
      memoryDiagnosticsModule.collectMemoryPressureSamples,
    ).toHaveBeenCalled();
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        text: expect.stringContaining('Memory pressure samples'),
      }),
      expect.any(Number),
    );
  });

  it('should refuse heap snapshot when heap pressure is already high', async () => {
    vi.mocked(memoryDiagnosticsModule.isHighHeapPressure).mockReturnValue(true);

    mockContext = createMockCommandContext({
      executionMode: 'non_interactive',
      ui: {
        addItem: vi.fn(),
        setPendingItem: vi.fn(),
      },
    } as unknown as CommandContext);

    const result = await doctorCommand.action!(
      mockContext,
      'memory --snapshot',
    );

    expect(
      memoryDiagnosticsModule.writeMemoryHeapSnapshot,
    ).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        messageType: 'error',
        content: expect.stringContaining('Heap snapshot skipped'),
      }),
    );
  });

  it('should render heap snapshot diagnostics in interactive mode', async () => {
    await doctorCommand.action!(mockContext, 'memory --snapshot');

    expect(memoryDiagnosticsModule.writeMemoryHeapSnapshot).toHaveBeenCalled();
    expect(mockContext.ui.setPendingItem).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Writing heap snapshot, this may take a moment...',
      }),
    );
    expect(mockContext.ui.setPendingItem).toHaveBeenCalledWith(null);
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        text: expect.stringContaining('Heap snapshot written'),
      }),
      expect.any(Number),
    );
  });

  it('should render sampled heap snapshot diagnostics in interactive mode', async () => {
    await doctorCommand.action!(mockContext, 'memory --sample --snapshot');

    expect(
      memoryDiagnosticsModule.collectMemoryPressureSamples,
    ).toHaveBeenCalledWith({
      sampleCount: 3,
      intervalMs: 1000,
      signal: undefined,
    });
    expect(memoryDiagnosticsModule.getMemoryDiagnostics).toHaveBeenCalledTimes(
      2,
    );
    expect(memoryDiagnosticsModule.writeMemoryHeapSnapshot).toHaveBeenCalled();
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        text: expect.stringContaining('Memory pressure samples'),
      }),
      expect.any(Number),
    );
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        text: expect.stringContaining('Heap snapshot written'),
      }),
      expect.any(Number),
    );
  });

  it('should render heap snapshot failures as error items in interactive mode', async () => {
    vi.mocked(
      memoryDiagnosticsModule.writeMemoryHeapSnapshot,
    ).mockImplementation(() => {
      throw new Error('disk full');
    });

    await doctorCommand.action!(mockContext, 'memory --snapshot');

    expect(mockContext.ui.setPendingItem).toHaveBeenCalledWith(null);
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text: expect.stringContaining('Heap snapshot failed: disk full'),
      }),
      expect.any(Number),
    );
  });

  it('should not write heap snapshot when aborted before the snapshot side effect', async () => {
    const abortController = new AbortController();
    vi.mocked(
      memoryDiagnosticsModule.formatMemoryDiagnostics,
    ).mockImplementation(() => {
      abortController.abort();
      return 'Memory diagnostics';
    });
    mockContext = createMockCommandContext({
      executionMode: 'interactive',
      abortSignal: abortController.signal,
      ui: {
        addItem: vi.fn(),
        setPendingItem: vi.fn(),
      },
    } as unknown as CommandContext);

    const result = await doctorCommand.action!(
      mockContext,
      'memory --snapshot',
    );

    expect(result).toBeUndefined();
    expect(
      memoryDiagnosticsModule.writeMemoryHeapSnapshot,
    ).not.toHaveBeenCalled();
    expect(mockContext.ui.addItem).not.toHaveBeenCalled();
  });

  it('should report heap snapshot failures without dropping memory diagnostics', async () => {
    vi.mocked(
      memoryDiagnosticsModule.writeMemoryHeapSnapshot,
    ).mockImplementation(() => {
      throw new Error('disk full');
    });
    mockContext = createMockCommandContext({
      executionMode: 'non_interactive',
      ui: {
        addItem: vi.fn(),
        setPendingItem: vi.fn(),
      },
    } as unknown as CommandContext);

    const result = await doctorCommand.action!(
      mockContext,
      'memory --snapshot',
    );

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content:
        'Memory diagnostics\nRSS: 100.0 MiB\nActive handles: 3\n\nHeap snapshot failed: disk full',
    });
  });

  it('should capture a short memory pressure sample when requested', async () => {
    mockContext = createMockCommandContext({
      executionMode: 'non_interactive',
      ui: {
        addItem: vi.fn(),
        setPendingItem: vi.fn(),
      },
    } as unknown as CommandContext);

    const result = await doctorCommand.action!(mockContext, 'memory --sample');

    expect(
      memoryDiagnosticsModule.collectMemoryPressureSamples,
    ).toHaveBeenCalledWith({
      sampleCount: 3,
      intervalMs: 1000,
      signal: undefined,
    });
    expect(
      memoryDiagnosticsModule.formatMemoryPressureSamples,
    ).toHaveBeenCalled();
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'Memory diagnostics\nRSS: 100.0 MiB\nActive handles: 3\n\nMemory pressure samples\nSample count: 1',
    });
  });

  it('should render completed sample diagnostics when aborted after sampling', async () => {
    const abortController = new AbortController();
    vi.mocked(
      memoryDiagnosticsModule.collectMemoryPressureSamples,
    ).mockImplementation(async () => {
      abortController.abort();
      return [
        {
          index: 1,
          timestamp: '2026-05-15T12:00:00.000Z',
          rss: 100,
          heapTotal: 80,
          heapUsed: 40,
          external: 5,
          arrayBuffers: 2,
        },
      ];
    });

    mockContext = createMockCommandContext({
      executionMode: 'interactive',
      abortSignal: abortController.signal,
      ui: {
        addItem: vi.fn(),
        setPendingItem: vi.fn(),
      },
    } as unknown as CommandContext);

    const result = await doctorCommand.action!(mockContext, 'memory --sample');

    expect(result).toBeUndefined();
    expect(
      memoryDiagnosticsModule.collectMemoryPressureSamples,
    ).toHaveBeenCalled();
    expect(
      memoryDiagnosticsModule.formatMemoryPressureSamples,
    ).toHaveBeenCalled();
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        text: expect.stringContaining('Memory pressure samples'),
      }),
      expect.any(Number),
    );
    expect(doctorChecksModule.runDoctorChecks).not.toHaveBeenCalled();
  });

  it('should recheck heap pressure after sampling before writing snapshot', async () => {
    vi.mocked(memoryDiagnosticsModule.isHighHeapPressure).mockReturnValue(true);

    mockContext = createMockCommandContext({
      executionMode: 'non_interactive',
      ui: {
        addItem: vi.fn(),
        setPendingItem: vi.fn(),
      },
    } as unknown as CommandContext);

    const result = await doctorCommand.action!(
      mockContext,
      'memory --sample --snapshot',
    );

    expect(memoryDiagnosticsModule.getMemoryDiagnostics).toHaveBeenCalledTimes(
      2,
    );
    expect(
      memoryDiagnosticsModule.writeMemoryHeapSnapshot,
    ).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        messageType: 'error',
        content: expect.stringContaining('Heap snapshot skipped'),
      }),
    );
  });

  it('should stop memory diagnostics when aborted before collection', async () => {
    const abortController = new AbortController();
    abortController.abort();

    mockContext = createMockCommandContext({
      executionMode: 'interactive',
      abortSignal: abortController.signal,
      ui: {
        addItem: vi.fn(),
        setPendingItem: vi.fn(),
      },
    } as unknown as CommandContext);

    const result = await doctorCommand.action!(mockContext, 'memory');

    expect(result).toBeUndefined();
    expect(memoryDiagnosticsModule.getMemoryDiagnostics).not.toHaveBeenCalled();
    expect(
      memoryDiagnosticsModule.formatMemoryDiagnostics,
    ).not.toHaveBeenCalled();
    expect(mockContext.ui.addItem).not.toHaveBeenCalled();
    expect(doctorChecksModule.runDoctorChecks).not.toHaveBeenCalled();
  });

  it('should not add memory diagnostics when aborted after collection', async () => {
    const abortController = new AbortController();
    vi.mocked(memoryDiagnosticsModule.getMemoryDiagnostics).mockImplementation(
      () => {
        const diagnostics = {
          generatedAt: '2026-05-15T12:00:00.000Z',
          process: {
            pid: 123,
            nodeVersion: 'v22.0.0',
            platform: 'linux' as const,
            arch: 'x64',
            uptimeSeconds: 42,
          },
          memory: {
            rss: 100,
            heapTotal: 80,
            heapUsed: 40,
            external: 5,
            arrayBuffers: 2,
          },
          v8: {
            heapStatistics: {},
            heapSpaces: [],
          },
          activeHandles: { count: 3, unavailable: false },
          activeRequests: { count: 1, unavailable: false },
        };
        abortController.abort();
        return diagnostics;
      },
    );

    mockContext = createMockCommandContext({
      executionMode: 'interactive',
      abortSignal: abortController.signal,
      ui: {
        addItem: vi.fn(),
        setPendingItem: vi.fn(),
      },
    } as unknown as CommandContext);

    const result = await doctorCommand.action!(mockContext, 'memory');

    expect(result).toBeUndefined();
    expect(memoryDiagnosticsModule.getMemoryDiagnostics).toHaveBeenCalled();
    expect(
      memoryDiagnosticsModule.formatMemoryDiagnostics,
    ).not.toHaveBeenCalled();
    expect(mockContext.ui.addItem).not.toHaveBeenCalled();
    expect(doctorChecksModule.runDoctorChecks).not.toHaveBeenCalled();
  });

  it('should not add item when aborted', async () => {
    const abortController = new AbortController();
    abortController.abort();

    mockContext = createMockCommandContext({
      executionMode: 'interactive',
      abortSignal: abortController.signal,
      ui: {
        addItem: vi.fn(),
        setPendingItem: vi.fn(),
      },
    } as unknown as CommandContext);

    await doctorCommand.action!(mockContext, '');

    expect(mockContext.ui.addItem).not.toHaveBeenCalled();
    // setPendingItem(null) should still be called via finally
    expect(mockContext.ui.setPendingItem).toHaveBeenCalledWith(null);
  });

  it('should return memory diagnostics as JSON for /doctor memory --json', async () => {
    mockContext = createMockCommandContext({
      executionMode: 'non_interactive',
      ui: {
        addItem: vi.fn(),
        setPendingItem: vi.fn(),
      },
    } as unknown as CommandContext);

    const result = await getMemoryCommand().action!(mockContext, '--json');

    expect(doctorChecksModule.runDoctorChecks).not.toHaveBeenCalled();
    expect(collectMemoryDiagnostics).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({
        type: 'message',
        messageType: 'info',
      }),
    );
    expect(
      JSON.parse(result?.type === 'message' ? result.content : '{}'),
    ).toMatchObject({
      memoryUsage: {
        heapUsed: 1_000,
      },
      analysis: {
        risks: [],
      },
    });
  });

  it('should return a readable memory diagnostics summary for /doctor memory', async () => {
    mockContext = createMockCommandContext({
      executionMode: 'non_interactive',
      ui: {
        addItem: vi.fn(),
        setPendingItem: vi.fn(),
      },
    } as unknown as CommandContext);

    const result = await getMemoryCommand().action!(mockContext, '');

    expect(result).toEqual(
      expect.objectContaining({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('Memory Diagnostics'),
      }),
    );
    expect(result?.type === 'message' ? result.content : '').toContain(
      'heapUsed',
    );
  });

  it('should render small memory values without rounding to zero MiB', async () => {
    const result = await getMemoryCommand().action!(mockContext, '');

    expect(result?.type === 'message' ? result.content : '').toContain(
      'heapUsed: 1.0 KB',
    );
    expect(result?.type === 'message' ? result.content : '').not.toContain(
      '0.00 MiB',
    );
  });

  it('should register memory as a real doctor subcommand', () => {
    expect(doctorCommand.subCommands?.map((command) => command.name)).toContain(
      'memory',
    );
  });

  it('should keep memory diagnostics successful when risk indicators exist', async () => {
    vi.mocked(collectMemoryDiagnostics).mockResolvedValue({
      timestamp: '2026-05-01T10:00:00.000Z',
      uptimeSeconds: 60,
      memoryUsage: {
        heapUsed: 3_500,
        heapTotal: 4_000,
        rss: 8_000,
        external: 100,
        arrayBuffers: 50,
      },
      v8HeapStats: {
        heapSizeLimit: 4_000,
        totalHeapSize: 4_000,
        usedHeapSize: 3_500,
        mallocedMemory: 10,
        peakMallocedMemory: 20,
        detachedContexts: 0,
        nativeContexts: 1,
      },
      resourceUsage: {
        maxRSS: 8_000,
        userCPUTime: 10,
        systemCPUTime: 20,
      },
      activeHandles: 2,
      activeRequests: 0,
      platform: 'darwin',
      nodeVersion: 'v20.19.0',
      analysis: {
        risks: [{ type: 'heap-pressure', message: 'Heap pressure detected.' }],
        recommendation: 'WARNING: 1 potential leak indicator(s) found.',
      },
    });
    const result = await getMemoryCommand().action!(mockContext, '--json');

    expect(result).toEqual(
      expect.objectContaining({
        type: 'message',
        messageType: 'info',
      }),
    );
  });
});

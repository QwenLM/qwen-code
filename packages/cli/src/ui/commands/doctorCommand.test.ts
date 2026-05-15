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
import type { DoctorCheckResult } from '../types.js';

vi.mock('../../utils/doctorChecks.js');
vi.mock('../../utils/memoryDiagnostics.js');

describe('doctorCommand', () => {
  let mockContext: CommandContext;

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

  beforeEach(() => {
    mockContext = createMockCommandContext({
      executionMode: 'interactive',
      ui: {
        addItem: vi.fn(),
        setPendingItem: vi.fn(),
      },
    } as unknown as CommandContext);

    vi.mocked(doctorChecksModule.runDoctorChecks).mockResolvedValue(mockChecks);
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
});

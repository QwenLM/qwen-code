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
import type { DoctorCheckResult } from '../types.js';

vi.mock('../../utils/doctorChecks.js');

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

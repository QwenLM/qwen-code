/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, type Mock } from 'vitest';

const mockLoadSettings = vi.hoisted(() => vi.fn());
const mockSetRuntimeBaseDir = vi.hoisted(() => vi.fn());
const mockSessionServiceConstructor = vi.hoisted(() => vi.fn());

vi.mock('../../config/settings.js', () => ({
  loadSettings: mockLoadSettings,
}));

vi.mock('@qwen-code/qwen-code-core', () => ({
  Storage: {
    setRuntimeBaseDir: mockSetRuntimeBaseDir,
  },
  SessionService: mockSessionServiceConstructor,
}));

import { initSessionService } from './common.js';

const mockedLoadSettings = mockLoadSettings as Mock;
const mockedSetRuntimeBaseDir = mockSetRuntimeBaseDir as Mock;

describe('common', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should call Storage.setRuntimeBaseDir with correct args', () => {
    mockedLoadSettings.mockReturnValue({
      merged: { advanced: { runtimeOutputDir: '/custom/runtime' } },
    });
    mockSessionServiceConstructor.mockReturnValue({});

    initSessionService();

    expect(mockedSetRuntimeBaseDir).toHaveBeenCalledWith(
      '/custom/runtime',
      process.cwd(),
    );
  });

  it('should pass undefined when runtimeOutputDir is not configured', () => {
    mockedLoadSettings.mockReturnValue({
      merged: { advanced: {} },
    });
    mockSessionServiceConstructor.mockReturnValue({});

    initSessionService();

    expect(mockedSetRuntimeBaseDir).toHaveBeenCalledWith(
      undefined,
      process.cwd(),
    );
  });

  it('should return a SessionService instance', () => {
    const mockInstance = { listSessions: vi.fn() };
    mockedLoadSettings.mockReturnValue({
      merged: { advanced: {} },
    });
    mockSessionServiceConstructor.mockReturnValue(mockInstance);

    const result = initSessionService();

    expect(result).toBe(mockInstance);
    expect(mockSessionServiceConstructor).toHaveBeenCalledWith(process.cwd());
  });
});

/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getPrefetchedStartupWarnings,
  getStartupWarnings,
  prefetchStartupWarnings,
  resetPrefetchedStartupWarningsForTesting,
} from './startupWarnings.js';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getErrorMessage } from '@qwen-code/core';

vi.mock('node:fs/promises', { spy: true });
vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    getErrorMessage: vi.fn(),
  };
});

describe('startupWarnings', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should return warnings from the file and delete it', async () => {
    const mockWarnings = 'Warning 1\nWarning 2';
    vi.mocked(fs.access).mockResolvedValue();
    vi.mocked(fs.readFile).mockResolvedValue(mockWarnings);
    vi.mocked(fs.unlink).mockResolvedValue();

    const warnings = await getStartupWarnings();

    const slug = process.env['BRAND_CLI_SLUG'] || 'qwen-code';
    const warningsPath = join(tmpdir(), `${slug}-dev-startup-warnings.txt`);
    expect(fs.access).toHaveBeenCalledWith(warningsPath);
    expect(fs.readFile).toHaveBeenCalledWith(warningsPath, 'utf-8');
    expect(fs.unlink).toHaveBeenCalledWith(warningsPath);
    expect(warnings).toEqual(['Warning 1', 'Warning 2']);
  });

  it('should return an empty array if the file does not exist', async () => {
    const error = new Error('File not found');
    (error as Error & { code: string }).code = 'ENOENT';
    vi.mocked(fs.access).mockRejectedValue(error);

    const warnings = await getStartupWarnings();

    expect(warnings).toEqual([]);
  });

  it('should return an error message if reading the file fails', async () => {
    const error = new Error('Permission denied');
    vi.mocked(fs.access).mockRejectedValue(error);
    vi.mocked(getErrorMessage).mockReturnValue('Permission denied');

    const warnings = await getStartupWarnings();

    expect(warnings).toEqual([
      'Error checking/reading warnings file: Permission denied',
    ]);
  });

  it('should return a warning if deleting the file fails', async () => {
    const mockWarnings = 'Warning 1';
    vi.mocked(fs.access).mockResolvedValue();
    vi.mocked(fs.readFile).mockResolvedValue(mockWarnings);
    vi.mocked(fs.unlink).mockRejectedValue(new Error('Permission denied'));

    const warnings = await getStartupWarnings();

    expect(warnings).toEqual([
      'Warning 1',
      'Warning: Could not delete temporary warnings file.',
    ]);
  });
});

describe('startupWarnings prefetch', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetPrefetchedStartupWarningsForTesting();
  });

  it('memoizes a single read across prefetch and repeated consumers', async () => {
    vi.mocked(fs.access).mockResolvedValue();
    vi.mocked(fs.readFile).mockResolvedValue('Warning 1');
    vi.mocked(fs.unlink).mockResolvedValue();

    prefetchStartupWarnings();
    const first = await getPrefetchedStartupWarnings();
    const second = await getPrefetchedStartupWarnings();

    expect(first).toEqual(['Warning 1']);
    expect(second).toBe(first);
    expect(fs.readFile).toHaveBeenCalledTimes(1);
    expect(fs.unlink).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh read when consumed without a prefetch', async () => {
    const error = new Error('File not found');
    (error as Error & { code: string }).code = 'ENOENT';
    vi.mocked(fs.access).mockRejectedValue(error);

    const warnings = await getPrefetchedStartupWarnings();

    expect(warnings).toEqual([]);
    expect(fs.access).toHaveBeenCalledTimes(1);
  });

  it('reads again after a test reset', async () => {
    vi.mocked(fs.access).mockResolvedValue();
    vi.mocked(fs.readFile).mockResolvedValueOnce('Warning 1');
    vi.mocked(fs.readFile).mockResolvedValueOnce('Warning 2');
    vi.mocked(fs.unlink).mockResolvedValue();

    prefetchStartupWarnings();
    expect(await getPrefetchedStartupWarnings()).toEqual(['Warning 1']);

    resetPrefetchedStartupWarningsForTesting();
    expect(await getPrefetchedStartupWarnings()).toEqual(['Warning 2']);
  });
});

/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// We need a controllable tmpDir for HOME override
let testHomeDir: string;
let testTmpDir: string;

vi.mock('@qwen-code/core', () => ({
  runLogger: {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
  BRAND_CLI_BIN: 'qwen',
  GLOBAL_CONFIG_DIR: '.qwen',
}));

const mockIsProcessRunning = vi.fn();
vi.mock('../updateLock.js', () => ({
  isProcessRunning: mockIsProcessRunning,
}));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const origHome = process.env['HOME'];

beforeEach(async () => {
  vi.clearAllMocks();
  // Create isolated HOME directory
  testHomeDir = await mkdtemp(join(tmpdir(), 'cleanup-home-'));
  testTmpDir = await mkdtemp(join(tmpdir(), 'cleanup-tmp-'));
  process.env['HOME'] = testHomeDir;

  // Create the BIN_DIR structure
  const binDir = join(testHomeDir, '.qwen', 'bin', 'qwen');
  await mkdir(binDir, { recursive: true });
});

afterEach(async () => {
  process.env['HOME'] = origHome;
  await rm(testHomeDir, { recursive: true, force: true });
  await rm(testTmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('performCleanup', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('should complete without error on empty directories', async () => {
    const { performCleanup } = await import('../startupCleanup.js');
    await expect(performCleanup()).resolves.toBeUndefined();
  });

  it('should remove stale temp files when process is dead', async () => {
    mockIsProcessRunning.mockReturnValue(false);

    const binDir = join(testHomeDir, '.qwen', 'bin', 'qwen');
    // Create a stale temp file matching the pattern: *.tmp.{pid}.{timestamp}
    const staleTempFile = 'qwen-0.2.0.tmp.99999.1700000000000';
    await writeFile(join(binDir, staleTempFile), 'stale');

    const { performCleanup } = await import('../startupCleanup.js');
    await performCleanup();

    expect(existsSync(join(binDir, staleTempFile))).toBe(false);
    expect(mockIsProcessRunning).toHaveBeenCalledWith(99999);
  });

  it('should NOT remove temp files when process is still running', async () => {
    mockIsProcessRunning.mockReturnValue(true);

    const binDir = join(testHomeDir, '.qwen', 'bin', 'qwen');
    const activeTempFile = 'qwen-0.2.0.tmp.12345.1700000000000';
    await writeFile(join(binDir, activeTempFile), 'active');

    const { performCleanup } = await import('../startupCleanup.js');
    await performCleanup();

    // File should still exist since process is running
    expect(existsSync(join(binDir, activeTempFile))).toBe(true);
  });

  it('should skip non-temp files', async () => {
    const binDir = join(testHomeDir, '.qwen', 'bin', 'qwen');
    // Create a regular versioned binary
    await writeFile(join(binDir, 'qwen-0.2.0'), 'binary-content');

    const { performCleanup } = await import('../startupCleanup.js');
    await performCleanup();

    // Regular binary should be untouched
    expect(existsSync(join(binDir, 'qwen-0.2.0'))).toBe(true);
  });

  it('should handle missing BIN_DIR gracefully', async () => {
    // Delete the BIN_DIR
    await rm(join(testHomeDir, '.qwen', 'bin', 'qwen'), {
      recursive: true,
      force: true,
    });

    const { performCleanup } = await import('../startupCleanup.js');
    await expect(performCleanup()).resolves.toBeUndefined();
  });
});

describe('scheduleStartupCleanup', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should schedule cleanup after 2 seconds delay', async () => {
    const { scheduleStartupCleanup } = await import('../startupCleanup.js');

    scheduleStartupCleanup();

    // Before 2s, cleanup should not have run
    // After advancing timers, it should execute
    // We just verify it doesn't throw synchronously
    expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
  });
});

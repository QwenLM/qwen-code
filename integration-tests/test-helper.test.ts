/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestRig } from './test-helper.js';

describe('TestRig', () => {
  const originalKeepOutput = process.env['KEEP_OUTPUT'];

  afterEach(() => {
    if (originalKeepOutput === undefined) {
      delete process.env['KEEP_OUTPUT'];
    } else {
      process.env['KEEP_OUTPUT'] = originalKeepOutput;
    }
    vi.restoreAllMocks();
  });

  it('resets a reused test directory during setup', async () => {
    const rig = new TestRig();
    await rig.setup('reused test directory');
    const staleFile = rig.createFile('stale.txt', 'stale');

    await rig.setup('reused test directory');

    expect(existsSync(staleFile)).toBe(false);
    expect(rig.testDir).not.toBeNull();
    expect(existsSync(rig.testDir!)).toBe(true);
  });

  it('removes the test directory during cleanup', async () => {
    delete process.env['KEEP_OUTPUT'];
    const rig = new TestRig();
    await rig.setup('cleanup test directory');
    const testDir = rig.testDir!;

    await rig.cleanup();

    expect(existsSync(testDir)).toBe(false);
  });

  it('keeps the test directory during cleanup when KEEP_OUTPUT is set', async () => {
    process.env['KEEP_OUTPUT'] = 'true';
    const rig = new TestRig();
    await rig.setup('keep output test directory');
    const testDir = rig.testDir!;

    await rig.cleanup();

    expect(existsSync(testDir)).toBe(true);
  });

  it('keeps polling for telemetry events when telemetry is not ready yet', async () => {
    const rig = new TestRig();
    vi.spyOn(rig, 'waitForTelemetryReady').mockResolvedValue(false);
    const poll = vi.spyOn(rig, 'poll').mockResolvedValue(false);

    await expect(rig.waitForTelemetryEvent('tool_call')).resolves.toBe(false);
    expect(poll).toHaveBeenCalled();
  });

  it('keeps polling for tool calls when telemetry is not ready yet', async () => {
    const rig = new TestRig();
    vi.spyOn(rig, 'waitForTelemetryReady').mockResolvedValue(false);
    const poll = vi.spyOn(rig, 'poll').mockResolvedValue(false);

    await expect(rig.waitForToolCall('read_file')).resolves.toBe(false);
    expect(poll).toHaveBeenCalled();
  });

  it('keeps polling for any tool call when telemetry is not ready yet', async () => {
    const rig = new TestRig();
    vi.spyOn(rig, 'waitForTelemetryReady').mockResolvedValue(false);
    const poll = vi.spyOn(rig, 'poll').mockResolvedValue(false);

    await expect(
      rig.waitForAnyToolCall(['read_file', 'write_file']),
    ).resolves.toBe(false);
    expect(poll).toHaveBeenCalled();
  });
});

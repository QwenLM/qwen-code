/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestRig } from './test-helper.js';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// How long the stand-in below stays alive after it is signalled. The real CLI
// traps SIGHUP and exits only once its own exit-cleanup chain has drained, so
// a stand-in that dies on the default action would let cleanup() return early
// and still look correct.
const STAND_IN_EXIT_DELAY_MS = 750;

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

  it('waits for an interactive session a test never closed to end', async () => {
    // KEEP_OUTPUT is what CI sets, and it makes cleanup() keep the test
    // directory — the spawned child must not survive that path either.
    process.env['KEEP_OUTPUT'] = 'true';
    const rig = new TestRig();
    await rig.setup('cleanup kills interactive session');
    // Stands in for the CLI bundle: what is under test is that cleanup ends
    // whatever runInteractive spawned, not what the CLI itself does.
    rig.bundlePath = rig.createFile(
      'slow-exit-cli.js',
      'process.on("SIGHUP", () => setTimeout(() => process.exit(129), ' +
        `${STAND_IN_EXIT_DELAY_MS}));\n` +
        'setInterval(() => {}, 1000);\n' +
        'process.stdout.write("STAND_IN_READY\\n");\n',
    );

    const { ptyProcess } = rig.runInteractive();
    expect(isProcessAlive(ptyProcess.pid)).toBe(true);
    // Signal before the handler is installed and the default action ends the
    // child at once, measuring nothing. A real session is booted by the time
    // its test ends, so wait for the stand-in to report itself up.
    expect(await rig.waitForText('STAND_IN_READY', 30_000)).toBe(true);

    const cleanupStartedAt = Date.now();
    await rig.cleanup();
    const cleanupTookMs = Date.now() - cleanupStartedAt;

    // Signalling alone returns straight through the delay above, leaving the
    // child forwarding PTY bytes into a worker vitest is tearing down.
    expect(
      cleanupTookMs,
      'cleanup() returned before the interactive CLI child exited',
    ).toBeGreaterThanOrEqual(STAND_IN_EXIT_DELAY_MS);
    await expect
      .poll(() => isProcessAlive(ptyProcess.pid), {
        message: 'the interactive CLI child outlived cleanup()',
        timeout: 10_000,
      })
      .toBe(false);
  });

  it.each([
    [
      'telemetry events',
      (rig: TestRig) => rig.waitForTelemetryEvent('tool_call'),
    ],
    ['tool calls', (rig: TestRig) => rig.waitForToolCall('read_file')],
    [
      'any tool call',
      (rig: TestRig) => rig.waitForAnyToolCall(['read_file', 'write_file']),
    ],
  ])(
    'keeps polling for %s when telemetry is not ready yet',
    async (_label, waitFor) => {
      const rig = new TestRig();
      vi.spyOn(rig, 'waitForTelemetryReady').mockResolvedValue(undefined);
      const poll = vi.spyOn(rig, 'poll').mockResolvedValue(false);

      await expect(waitFor(rig)).resolves.toBe(false);
      expect(poll).toHaveBeenCalled();
    },
  );
});

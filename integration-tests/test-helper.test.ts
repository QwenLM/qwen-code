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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Emitted by the stand-in CLI below; nothing else in the run writes it. */
const FORWARD_CANARY = 'PTY_FORWARD_CANARY_11002';

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

  it('kills an interactive session a test never closed during cleanup', async () => {
    // KEEP_OUTPUT is what CI sets, and it makes cleanup() keep the test
    // directory — the spawned child must not survive that path either.
    process.env['KEEP_OUTPUT'] = 'true';
    const rig = new TestRig();
    await rig.setup('cleanup kills interactive session');
    // Stands in for the CLI bundle: what is under test is that cleanup ends
    // whatever runInteractive spawned, not what the CLI itself does.
    rig.bundlePath = rig.createFile(
      'idle-cli.js',
      'setInterval(() => {}, 1000);\n',
    );

    const { ptyProcess } = rig.runInteractive();
    expect(isProcessAlive(ptyProcess.pid)).toBe(true);

    await rig.cleanup();

    await expect
      .poll(() => isProcessAlive(ptyProcess.pid), {
        message: 'the interactive CLI child outlived cleanup()',
        timeout: 10_000,
      })
      .toBe(false);
  });

  it("detaches a session's output forwarding during cleanup", async () => {
    // KEEP_OUTPUT is what the OpenTUI leg sets, and it is what makes the rig
    // forward every PTY byte into this worker's stdout.
    process.env['KEEP_OUTPUT'] = 'true';
    const rig = new TestRig();
    await rig.setup('cleanup detaches interactive output');
    // Stands in for the CLI bundle, which traps the SIGHUP that node-pty's
    // signal-less kill() sends and keeps rendering while its exit cleanup
    // drains. The child therefore outlives cleanup() on purpose and keeps
    // producing bytes: what is under test is whether the harness still
    // forwards them into a stdout pipe vitest is about to destroy (#11002).
    rig.bundlePath = rig.createFile(
      'slow-exit-cli.js',
      [
        "process.on('SIGHUP', () => {});",
        `setInterval(() => process.stdout.write('${FORWARD_CANARY}\\n'), 20);`,
        'setTimeout(() => process.exit(0), 30000);',
        '',
      ].join('\n'),
    );

    const { ptyProcess } = rig.runInteractive();
    try {
      await expect
        .poll(() => rig._interactiveOutput.includes(FORWARD_CANARY), {
          message: 'the stand-in CLI never produced output',
          timeout: 20_000,
        })
        .toBe(true);

      const forwarded: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        forwarded.push(String(chunk));
        return true;
      });

      await rig.cleanup();
      // Still alive: it swallowed SIGHUP. That is the window the real CLI's
      // graceful shutdown opens between cleanup() and the child's own exit.
      expect(isProcessAlive(ptyProcess.pid)).toBe(true);

      forwarded.length = 0;
      await sleep(500);

      expect(
        forwarded.filter((chunk) => chunk.includes(FORWARD_CANARY)),
        'cleanup() left the session forwarding PTY bytes into stdout',
      ).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      try {
        process.kill(ptyProcess.pid, 'SIGKILL');
      } catch {
        // Already gone
      }
    }
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

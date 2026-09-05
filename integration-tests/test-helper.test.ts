/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INTERACTIVE_EXIT_GRACE_MS, TestRig } from './test-helper.js';

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

// Every interactive case below stands in for the CLI through rig.bundlePath.
// The installed-release lane spawns the installed CLI instead and never runs a
// stand-in, so these cases cannot measure that lane directly — the wrapper
// stand-in below reproduces its process topology on the bundle lane instead.
const usesInstalledCli =
  process.env['INTEGRATION_TEST_USE_INSTALLED_GEMINI'] === 'true';

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

  it.skipIf(usesInstalledCli)(
    'waits for an interactive session a test never closed to end',
    async () => {
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
      // Nor may it fall through the whole grace, which is what cleanup() does
      // when `exited` never settles — i.e. when the onExit wiring breaks. The
      // bound sits far above the stand-in's exit delay, far below the grace.
      expect(cleanupTookMs).toBeLessThan(5_000);
      await expect
        .poll(() => isProcessAlive(ptyProcess.pid), {
          message: 'the interactive CLI child outlived cleanup()',
          timeout: 10_000,
        })
        .toBe(false);
    },
  );

  it.skipIf(usesInstalledCli)(
    'waits for the CLI the installed bin wrapper relaunched to end',
    async () => {
      process.env['KEEP_OUTPUT'] = 'true';
      const rig = new TestRig();
      await rig.setup('cleanup waits past the bin wrapper');
      // Mimics the installed-release lane, where the bin wrapper node-pty
      // spawns relaunches the real CLI with spawnSync and installs no signal
      // handler: SIGHUP ends the wrapper at once, while the relaunched CLI
      // traps it and keeps draining. That CLI, not the wrapper, is what
      // cleanup() must not return early on.
      const relaunched = rig.createFile(
        'relaunched-cli.cjs',
        'process.on("SIGHUP", () => setTimeout(() => process.exit(129), ' +
          `${STAND_IN_EXIT_DELAY_MS}));\n` +
          'setInterval(() => {}, 1000);\n' +
          'process.stdout.write("RELAUNCHED_PID=" + process.pid + ' +
          '"\\nRELAUNCHED_READY\\n");\n',
      );
      rig.bundlePath = rig.createFile(
        'bin-wrapper.cjs',
        "const { spawnSync } = require('node:child_process');\n" +
          `const result = spawnSync(process.execPath, [${JSON.stringify(
            relaunched,
          )}], {\n` +
          "  stdio: 'inherit',\n" +
          '});\n' +
          'if (result.signal) process.kill(process.pid, result.signal);\n' +
          'else process.exit(result.status ?? 1);\n',
      );

      const { ptyProcess } = rig.runInteractive();
      expect(await rig.waitForText('RELAUNCHED_READY', 30_000)).toBe(true);
      const reported = /RELAUNCHED_PID=(\d+)/.exec(rig._interactiveOutput);
      expect(
        reported,
        'the relaunched CLI never reported its pid',
      ).not.toBeNull();
      const relaunchedPid = Number(reported![1]);
      expect(isProcessAlive(relaunchedPid)).toBe(true);

      const cleanupStartedAt = Date.now();
      await rig.cleanup();

      // The wrapper dies on SIGHUP's default action within milliseconds, so
      // only a wait that sees past it can still be running here.
      expect(Date.now() - cleanupStartedAt).toBeGreaterThanOrEqual(
        STAND_IN_EXIT_DELAY_MS,
      );
      expect(
        isProcessAlive(relaunchedPid),
        'cleanup() returned while the relaunched CLI was still draining',
      ).toBe(false);
      expect(isProcessAlive(ptyProcess.pid)).toBe(false);
    },
  );

  it.skipIf(usesInstalledCli)(
    'stops waiting for an interactive child that never exits',
    async () => {
      process.env['KEEP_OUTPUT'] = 'true';
      const rig = new TestRig();
      await rig.setup('cleanup gives up on a child that never exits');
      rig.bundlePath = rig.createFile(
        'never-exit-cli.js',
        'process.on("SIGHUP", () => {});\n' +
          'setInterval(() => {}, 1000);\n' +
          'process.stdout.write("STAND_IN_READY\\n");\n',
      );

      const { ptyProcess } = rig.runInteractive();
      expect(await rig.waitForText('STAND_IN_READY', 30_000)).toBe(true);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const cleanupStartedAt = Date.now();
      try {
        await rig.cleanup();
      } finally {
        // cleanup() gave up on this child, so the rig no longer tracks it.
        ptyProcess.kill('SIGKILL');
      }
      const cleanupTookMs = Date.now() - cleanupStartedAt;

      // Literals, not the constant: a bound derived from it retunes with the
      // value it polices. Floor is the CLI's 5s exit-cleanup chain, ceiling
      // vitest's 10s default hookTimeout — see INTERACTIVE_EXIT_GRACE_MS.
      expect(INTERACTIVE_EXIT_GRACE_MS).toBeGreaterThan(5_000);
      expect(INTERACTIVE_EXIT_GRACE_MS).toBeLessThan(10_000);
      // Bounded, or a child that ignores SIGHUP hangs teardown forever.
      expect(cleanupTookMs).toBeLessThan(INTERACTIVE_EXIT_GRACE_MS + 5_000);
      // Giving up has to name the child it abandoned, or the EPIPE crash this
      // wait exists to prevent returns with nothing pointing back at it.
      expect(warn.mock.calls.flat().join(' ')).toContain(
        String(ptyProcess.pid),
      );
    },
  );

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

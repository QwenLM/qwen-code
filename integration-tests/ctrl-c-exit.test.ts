/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { TestRig } from './test-helper.js';

describe('Ctrl+C exit', () => {
  // (#9782) Temporarily disabling on windows because it is failing on main and every
  // PR, which is potentially hiding other failures
  it.skip('should exit gracefully on second Ctrl+C', async () => {
    const rig = new TestRig();
    await rig.setup('should exit gracefully on second Ctrl+C');

    const { ptyProcess, promise } = rig.runInteractive();

    let output = '';
    ptyProcess.onData((data) => {
      output += data;
    });

    const isReady = await rig.waitForText('Type your message', 15000);
    expect(isReady, 'CLI did not start up in interactive mode correctly').toBe(
      true,
    );

    // Send first Ctrl+C
    ptyProcess.write(String.fromCharCode(3));

    // Wait for the exit prompt
    const showedExitPrompt = await rig.poll(
      () => output.includes('Press Ctrl+C again to exit'),
      1500,
      50,
    );
    expect(showedExitPrompt, `Exit prompt not shown. Output: ${output}`).toBe(
      true,
    );

    // Send second Ctrl+C
    ptyProcess.write(String.fromCharCode(3));

    // Wait for process exit with timeout to fail fast
    const EXIT_TIMEOUT = 5000;
    const result = await Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `Process did not exit within ${EXIT_TIMEOUT}ms. Output: ${output}`,
              ),
            ),
          EXIT_TIMEOUT,
        ),
      ),
    ]);

    // Expect a graceful exit (code 0)
    expect(
      result.exitCode,
      `Process exited with code ${result.exitCode}. Output: ${result.output}`,
    ).toBe(0);

    // Check that the quitting message is displayed
    const quittingMessage = 'Agent powering down. Goodbye!';
    // The regex below is intentionally matching the ESC control character (\x1b)
    // to strip ANSI color codes from the terminal output.
    // eslint-disable-next-line no-control-regex
    const cleanOutput = output.replace(/\x1b\[[0-9;]*m/g, '');
    expect(cleanOutput).toContain(quittingMessage);
  });
});

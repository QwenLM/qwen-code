/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestRig } from './test-helper.js';

describe('/hooks command', () => {
  let rig: TestRig;

  beforeEach(async () => {
    rig = new TestRig();
    await rig.setup('/hooks command test');
  });

  afterEach(async () => {
    await rig.cleanup();
  });

  it('should display hooks dialog when /hooks command is entered', async () => {
    const { ptyProcess } = rig.runInteractive();

    let output = '';
    ptyProcess.onData((data) => {
      output += data;
    });

    // Wait for CLI to be ready
    const isReady = await rig.waitForText('Type your message', 15000);
    expect(isReady, 'CLI did not start up in interactive mode correctly').toBe(
      true,
    );

    // Type /hooks command
    ptyProcess.write('/hooks');

    // Wait a bit for the command to be typed
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Press Enter to execute the command
    ptyProcess.write('\r');

    // Wait for hooks dialog to appear
    const showedHooksDialog = await rig.poll(
      () => output.includes('Hooks') || output.includes('hooks'),
      5000,
      200,
    );

    // Print output for debugging
    console.log('Output after /hooks command:');
    console.log(output);

    expect(showedHooksDialog, `Hooks dialog not shown. Output: ${output}`).toBe(
      true,
    );

    // Close the dialog with Escape
    ptyProcess.write('\x1b');

    // Wait a bit
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Exit with Ctrl+C twice
    ptyProcess.write('\x03');
    await new Promise((resolve) => setTimeout(resolve, 300));
    ptyProcess.write('\x03');
  });
});

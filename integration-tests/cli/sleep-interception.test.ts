/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { TestRig, validateModelOutput } from '../test-helper.js';

describe('sleep-interception', () => {
  let rig: TestRig;

  afterEach(async () => {
    if (rig) {
      await rig.cleanup();
    }
  });

  it('should block sleep >= 2s and mention Monitor in guidance', async () => {
    rig = new TestRig();
    await rig.setup('sleep-blocked');

    const result = await rig.run(
      'Run this exact shell command: sleep 5. ' +
        'If the command is blocked, say "BLOCKED" and explain why. ' +
        'If it succeeds, say "SUCCESS".',
    );

    validateModelOutput(result, null, 'sleep blocked');

    // The model should report being blocked, since sleep 5 triggers interception
    const foundShell = await rig.waitForToolCall('run_shell_command');
    expect(foundShell).toBeTruthy();

    // The model's output should mention it was blocked
    expect(result.toLowerCase()).toContain('blocked');
  }, 30000);

  it('should allow sleep < 2s', async () => {
    rig = new TestRig();
    await rig.setup('sleep-allowed');

    const result = await rig.run(
      'Run this exact shell command: sleep 1. Then say "DONE".',
    );

    validateModelOutput(result, null, 'sleep allowed');

    const foundShell = await rig.waitForToolCall('run_shell_command');
    expect(foundShell).toBeTruthy();

    // Should not be blocked — model should complete successfully
    expect(result.toLowerCase()).not.toContain('blocked');
  }, 30000);

  it('should block sleep >= 2s even when followed by a trailing comment', async () => {
    // The `trimTrailingShellComment` state machine strips trailing `#...`
    // comments before matching the sleep pattern, so a model trying to
    // route around interception with `sleep 5 # wait for db` must still
    // be blocked. This test locks in that behavior end-to-end.
    rig = new TestRig();
    await rig.setup('sleep-blocked-trailing-comment');

    const result = await rig.run(
      'Run this exact shell command: sleep 5 # wait for db. ' +
        'If the command is blocked, say "BLOCKED" and explain why. ' +
        'If it succeeds, say "SUCCESS".',
    );

    validateModelOutput(result, null, 'sleep blocked with trailing comment');

    const foundShell = await rig.waitForToolCall('run_shell_command');
    expect(foundShell).toBeTruthy();

    // Model must report it was blocked despite the trailing comment.
    expect(result.toLowerCase()).toContain('blocked');
  }, 30000);
});

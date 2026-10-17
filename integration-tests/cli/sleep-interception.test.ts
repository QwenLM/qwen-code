/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  getCapturedToolCallStringArg,
  TestRig,
  printDebugInfo,
  validateModelOutput,
} from '../test-helper.js';

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

    const capture = await rig.runWithToolCapture(
      'Use the run_shell_command tool to run this exact command in the ' +
        'foreground: sleep 5. You must actually call run_shell_command — ' +
        'do not predict the outcome without calling the tool, do not set ' +
        'is_background, and do not modify the command. If the tool reports ' +
        'the command was blocked, say "BLOCKED". If it executed ' +
        'successfully, say "SUCCESS".',
    );
    const result = capture.result;
    const shellCalls = capture.toolCalls.filter(
      (call) => call.name === 'run_shell_command',
    );

    const blockedCall = shellCalls.find(
      (call) =>
        getCapturedToolCallStringArg(call, 'command') === 'sleep 5' &&
        call.success === false,
    );

    if (!blockedCall) {
      printDebugInfo(rig, result, {
        'Captured shell calls': JSON.stringify(shellCalls),
      });
    }

    expect(
      blockedCall,
      'Expected a blocked (success: false) run_shell_command call for sleep 5',
    ).toBeDefined();

    expect(blockedCall?.error).toContain('Monitor');

    // Narration is best-effort: warns instead of failing if the model
    // phrases the block differently.
    validateModelOutput(result, 'blocked', 'sleep blocked');
  });

  it('should allow sleep < 2s', async () => {
    rig = new TestRig();
    await rig.setup('sleep-allowed');

    const capture = await rig.runWithToolCapture(
      'Use the run_shell_command tool to run this exact command: sleep 1. ' +
        'You must actually call run_shell_command with that command — do ' +
        'not skip it. After it completes, say "DONE".',
    );
    const result = capture.result;

    const successfulCall = capture.toolCalls.find(
      (call) =>
        call.name === 'run_shell_command' &&
        getCapturedToolCallStringArg(call, 'command') === 'sleep 1' &&
        call.success === true,
    );

    if (!successfulCall) {
      printDebugInfo(rig, result, {
        'Captured tool calls': JSON.stringify(capture.toolCalls),
      });
    }

    expect(
      successfulCall,
      'Expected a successful run_shell_command call for sleep 1',
    ).toBeDefined();

    validateModelOutput(result, 'done', 'sleep allowed');
  });

  it('should allow retrying blocked sleep with an intentional sleep comment', async () => {
    rig = new TestRig();
    await rig.setup('sleep-intentional-retry');

    const capture = await rig.runWithToolCapture(
      'Use the run_shell_command tool to run this exact command in the ' +
        'foreground: sleep 5. You must actually call run_shell_command — ' +
        'do not predict the outcome without calling the tool. When that ' +
        'call is blocked, call run_shell_command again with this exact ' +
        'command: sleep 2 # intentional-sleep: wait for MCP rate limit ' +
        'reset. Then say "DONE".',
    );
    const result = capture.result;

    // The escape hatch worked iff a call carrying the intentional-sleep
    // comment completed successfully.
    const intentionalCall = capture.toolCalls.find(
      (call) =>
        call.name === 'run_shell_command' &&
        getCapturedToolCallStringArg(call, 'command') ===
          'sleep 2 # intentional-sleep: wait for MCP rate limit reset' &&
        call.success === true,
    );

    if (!intentionalCall) {
      printDebugInfo(rig, result, {
        'Captured tool calls': JSON.stringify(capture.toolCalls),
      });
    }

    expect(
      intentionalCall,
      'Expected a successful run_shell_command call with an intentional-sleep comment',
    ).toBeDefined();

    validateModelOutput(result, 'done', 'sleep intentional retry');
  });

  it('should block sleep >= 2s even when followed by a trailing comment', async () => {
    // The `trimTrailingShellComment` state machine strips trailing `#...`
    // comments before matching the sleep pattern, so a model trying to
    // route around interception with `sleep 5 # wait for db` must still
    // be blocked. This test locks in that behavior end-to-end.
    rig = new TestRig();
    await rig.setup('sleep-blocked-trailing-comment');

    const capture = await rig.runWithToolCapture(
      'Use the run_shell_command tool to run this exact command in the ' +
        'foreground: sleep 5 # wait for db. You must actually call ' +
        'run_shell_command — do not predict the outcome without calling ' +
        'the tool, do not set is_background, and do not modify the ' +
        'command. If the tool reports the command was blocked, say ' +
        '"BLOCKED". If it executed successfully, say "SUCCESS".',
    );
    const result = capture.result;

    const blockedCall = capture.toolCalls.find(
      (call) =>
        call.name === 'run_shell_command' &&
        getCapturedToolCallStringArg(call, 'command') ===
          'sleep 5 # wait for db' &&
        call.success === false,
    );

    if (!blockedCall) {
      printDebugInfo(rig, result, {
        'Captured tool calls': JSON.stringify(capture.toolCalls),
      });
    }

    expect(
      blockedCall,
      'Expected a blocked (success: false) run_shell_command call for sleep 5 with trailing comment',
    ).toBeDefined();

    validateModelOutput(
      result,
      'blocked',
      'sleep blocked with trailing comment',
    );
  });
});

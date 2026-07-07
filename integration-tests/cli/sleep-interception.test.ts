/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
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

  type ShellCall = {
    args: string;
    success: boolean;
    error?: string;
  };

  /**
   * Poll telemetry for a run_shell_command call matching the predicate.
   * The model's narration is unreliable (it may retry, paraphrase, or skip
   * the scripted reply), so assertions key off the recorded tool calls —
   * blocked calls are logged too, with success: false and the block
   * message in the error attribute.
   */
  const waitForShellCall = (predicate: (call: ShellCall) => boolean) =>
    rig.poll(
      () =>
        rig
          .readToolLogs()
          .some(
            (log) =>
              log.toolRequest.name === 'run_shell_command' &&
              predicate(log.toolRequest),
          ),
      rig.getDefaultTimeout(),
      100,
    );

  const shellCalls = (): ShellCall[] =>
    rig
      .readToolLogs()
      .filter((log) => log.toolRequest.name === 'run_shell_command')
      .map((log) => log.toolRequest);

  it('should block sleep >= 2s and mention Monitor in guidance', async () => {
    rig = new TestRig();
    await rig.setup('sleep-blocked');

    const result = await rig.run(
      'Use the run_shell_command tool to run this exact command in the ' +
        'foreground: sleep 5. You must actually call run_shell_command — ' +
        'do not predict the outcome without calling the tool, do not set ' +
        'is_background, and do not modify the command. If the tool reports ' +
        'the command was blocked, say "BLOCKED". If it executed ' +
        'successfully, say "SUCCESS".',
    );

    const foundBlockedCall = await waitForShellCall(
      (call) => call.args.includes('sleep 5') && !call.success,
    );

    if (!foundBlockedCall) {
      printDebugInfo(rig, result, {
        'Shell calls': JSON.stringify(shellCalls()),
      });
    }

    expect(
      foundBlockedCall,
      'Expected a blocked (success: false) run_shell_command call for sleep 5',
    ).toBeTruthy();

    // The block guidance must point the model at the Monitor tool. The
    // error attribute is only available from file-based telemetry; the
    // podman stdout fallback leaves it undefined.
    const blockedCall = shellCalls().find(
      (call) => call.args.includes('sleep 5') && !call.success,
    );
    if (blockedCall?.error !== undefined) {
      expect(blockedCall.error).toContain('Monitor');
    }

    // Narration is best-effort: warns instead of failing if the model
    // phrases the block differently.
    validateModelOutput(result, 'blocked', 'sleep blocked');
  });

  it('should allow sleep < 2s', async () => {
    rig = new TestRig();
    await rig.setup('sleep-allowed');

    const result = await rig.run(
      'Use the run_shell_command tool to run this exact command: sleep 1. ' +
        'You must actually call run_shell_command with that command — do ' +
        'not skip it. After it completes, say "DONE".',
    );

    const foundSuccessfulCall = await waitForShellCall(
      (call) => call.args.includes('sleep 1') && call.success,
    );

    if (!foundSuccessfulCall) {
      printDebugInfo(rig, result, {
        'Shell calls': JSON.stringify(shellCalls()),
      });
    }

    expect(
      foundSuccessfulCall,
      'Expected a successful run_shell_command call for sleep 1',
    ).toBeTruthy();

    validateModelOutput(result, 'done', 'sleep allowed');
  });

  it('should allow retrying blocked sleep with an intentional sleep comment', async () => {
    rig = new TestRig();
    await rig.setup('sleep-intentional-retry');

    const result = await rig.run(
      'Use the run_shell_command tool to run this exact command in the ' +
        'foreground: sleep 5. You must actually call run_shell_command — ' +
        'do not predict the outcome without calling the tool. When that ' +
        'call is blocked, call run_shell_command again with this exact ' +
        'command: sleep 2 # intentional-sleep: wait for MCP rate limit ' +
        'reset. Then say "DONE".',
    );

    // The escape hatch worked iff a call carrying the intentional-sleep
    // comment completed successfully.
    const foundIntentionalCall = await waitForShellCall(
      (call) => call.args.includes('intentional-sleep') && call.success,
    );

    if (!foundIntentionalCall) {
      printDebugInfo(rig, result, {
        'Shell calls': JSON.stringify(shellCalls()),
      });
    }

    expect(
      foundIntentionalCall,
      'Expected a successful run_shell_command call with an intentional-sleep comment',
    ).toBeTruthy();

    validateModelOutput(result, 'done', 'sleep intentional retry');
  });

  it('should block sleep >= 2s even when followed by a trailing comment', async () => {
    // The `trimTrailingShellComment` state machine strips trailing `#...`
    // comments before matching the sleep pattern, so a model trying to
    // route around interception with `sleep 5 # wait for db` must still
    // be blocked. This test locks in that behavior end-to-end.
    rig = new TestRig();
    await rig.setup('sleep-blocked-trailing-comment');

    const result = await rig.run(
      'Use the run_shell_command tool to run this exact command in the ' +
        'foreground: sleep 5 # wait for db. You must actually call ' +
        'run_shell_command — do not predict the outcome without calling ' +
        'the tool, do not set is_background, and do not modify the ' +
        'command. If the tool reports the command was blocked, say ' +
        '"BLOCKED". If it executed successfully, say "SUCCESS".',
    );

    const foundBlockedCall = await waitForShellCall(
      (call) => call.args.includes('sleep 5') && !call.success,
    );

    if (!foundBlockedCall) {
      printDebugInfo(rig, result, {
        'Shell calls': JSON.stringify(shellCalls()),
      });
    }

    expect(
      foundBlockedCall,
      'Expected a blocked (success: false) run_shell_command call for sleep 5 with trailing comment',
    ).toBeTruthy();

    validateModelOutput(
      result,
      'blocked',
      'sleep blocked with trailing comment',
    );
  });
});

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A project skill's frontmatter `hooks:` must fire regardless of who invoked
 * the skill. Regression for #11067, where the `/<skill-name>` slash-command
 * path injected the skill body and granted its allowedTools but never
 * registered its hooks — so a `PreToolUse` gate silently failed open exactly
 * when the user started the skill by hand.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { fakeServerHostOptions, TestRig } from './test-helper.js';
import { fakeToolCall, startFakeOpenAIServer } from './fake-openai-server.js';
import type { FakeOpenAIServer } from './fake-openai-server.js';
import {
  EXECUTED_FLAG,
  GATE_MARKER,
  SKILL_DESCRIPTION_PREFIX,
  SKILL_NAME,
  exitInteractive,
  fakeModelLaunchArgs,
  installGatedSkill,
  makeWaitFor,
  stubFakeModelEnv,
} from './helpers/gated-skill-fixture.js';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

describe('skill hooks fire on both invocation paths', () => {
  let rig: TestRig;
  let fakeServer: FakeOpenAIServer;
  let restoreNoProxy: (() => void) | undefined;

  afterEach(async () => {
    restoreNoProxy?.();
    restoreNoProxy = undefined;
    await fakeServer?.close();
    await rig?.cleanup();
  });

  /**
   * Drives one interactive session. `modelInvokesSkill` controls whether the
   * model calls the Skill tool itself (control) or the user typed the slash
   * command first (repro).
   */
  async function driveSession(options: {
    testName: string;
    modelInvokesSkill: boolean;
  }): Promise<{ output: string; executed: boolean }> {
    rig = new TestRig();
    await rig.setup(options.testName);
    installGatedSkill(rig.testDir!);

    let streamingRequestIndex = 0;
    fakeServer = await startFakeOpenAIServer(({ body }) => {
      if (body['stream'] !== true) {
        return { content: '{"selected_memories":[]}' };
      }
      const i = streamingRequestIndex++;
      if (options.modelInvokesSkill && i === 0) {
        return {
          toolCalls: [
            fakeToolCall('skill', { skill: SKILL_NAME }, 'call-skill'),
          ],
        };
      }
      const shellTurn = options.modelInvokesSkill ? 1 : 0;
      if (i === shellTurn) {
        return {
          toolCalls: [
            fakeToolCall(
              'run_shell_command',
              { command: `touch ${EXECUTED_FLAG}` },
              'call-shell',
            ),
          ],
        };
      }
      return { content: 'done' };
    }, fakeServerHostOptions());

    restoreNoProxy = stubFakeModelEnv(rig, fakeServer);

    const { ptyProcess } = rig.runInteractive(
      ...fakeModelLaunchArgs(fakeServer),
    );

    let output = '';
    ptyProcess.onData((d) => {
      output += d;
    });

    const ready = await rig.waitForText('Type your message', 30000);
    expect(ready, `CLI did not start. Output:\n${output}`).toBe(true);

    const waitFor = makeWaitFor(rig, () => output);

    if (!options.modelInvokesSkill) {
      // USER path: start the skill by hand. Wait for the command to exist,
      // not merely for the typed text to come back: the echo lands long
      // before the skill command registry does, and submitting into that gap
      // gets `Unknown command: /<skill>` instead of the skill. That failure
      // is undetectable downstream — the error text contains the typed
      // command, so any inclusion check on it matches the error too. The
      // completion menu rendering the skill's own description is a signal
      // only a registered command can produce.
      ptyProcess.write(`/${SKILL_NAME}`);
      await waitFor('the skill command to be registered', () =>
        output.includes(SKILL_DESCRIPTION_PREFIX),
      );
      // The body is submitted as a prompt rather than echoed, so the
      // observable signal is the model call it produces.
      const before = fakeServer.requests.length;
      ptyProcess.write('\r');
      await waitFor(
        'the skill body to reach the model',
        () => fakeServer.requests.length > before,
      );
      // Guards the wait above rather than the CLI: the command was never
      // submitted before it existed, so this string must never appear.
      expect(
        output,
        'the slash command was submitted before it was registered',
      ).not.toContain(`Unknown command: /${SKILL_NAME}`);
    }

    const prompt = 'run the downstream command';
    ptyProcess.write(prompt);
    await waitFor('the prompt to echo', () => output.includes(prompt));
    ptyProcess.write('\r');

    const flagPath = join(rig.testDir!, EXECUTED_FLAG);
    await waitFor(
      'the shell call to be gated or to run',
      () => existsSync(flagPath) || output.includes(GATE_MARKER),
    );

    await exitInteractive(ptyProcess, waitFor, () => output);

    return { output, executed: existsSync(flagPath) };
  }

  it('model-invoked skill: the gate fires and blocks the shell call', async () => {
    const { output, executed } = await driveSession({
      testName: 'skill hooks model invoked',
      modelInvokesSkill: true,
    });
    expect(
      output,
      `gate did not fire. Output tail:\n${output.slice(-1500)}`,
    ).toContain(GATE_MARKER);
    expect(executed).toBe(false);
  }, 120000);

  it('user-invoked skill (/<skill-name>): the gate fires and blocks the shell call', async () => {
    const { output, executed } = await driveSession({
      testName: 'skill hooks slash invoked',
      modelInvokesSkill: false,
    });
    expect(
      output,
      `gate did not fire. Output tail:\n${output.slice(-1500)}`,
    ).toContain(GATE_MARKER);
    expect(executed).toBe(false);
  }, 120000);
});

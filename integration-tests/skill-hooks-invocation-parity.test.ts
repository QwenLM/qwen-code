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
import {
  CI_DEFAULT_WAIT_MS,
  fakeServerHostOptions,
  TestRig,
} from './test-helper.js';
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
import {
  MAX_READY_PROMPT_BUDGET_MS,
  readyPromptBudgetMs,
} from './ready-prompt-budget.js';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

// Per-case ceilings over a stalled boot: the ready-prompt budget plus 3/5
// waits at the harness's 60s CI default. Derived from the budget so a raise
// moves both ceilings. retry: 0 because the suite retries twice by default,
// and a stall that exhausts the ready budget cannot recover on a retry —
// three attempts would burn 18 minutes of the docker leg's 60-minute job.
const CI_WAIT_MS = CI_DEFAULT_WAIT_MS;
const SLACK_MS = 60_000;
const MODEL_CASE_TIMEOUT =
  MAX_READY_PROMPT_BUDGET_MS + 3 * CI_WAIT_MS + SLACK_MS;
const USER_CASE_TIMEOUT =
  MAX_READY_PROMPT_BUDGET_MS + 5 * CI_WAIT_MS + SLACK_MS;

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

    const { ptyProcess, promise: exited } = rig.runInteractive(
      ...fakeModelLaunchArgs(fakeServer),
    );

    let output = '';
    ptyProcess.onData((d) => {
      output += d;
    });

    // The docker leg's container boot has stalled past 30s before the prompt
    // renders (#13552, #14191); use the measured self-hosted budget instead of
    // the old fixed 30s. A child that dies during startup fails fast with its
    // exit code, and cleanup() stops the abandoned waitForText poll within one
    // tick instead of leaving it to scan the dead pty for the whole budget;
    // only a live-but-slow boot pays that budget.
    let startupUndecided = true;
    const ready = await Promise.race([
      rig.waitForText('Type your message', readyPromptBudgetMs(process.env)),
      exited.then(({ exitCode, signal }) => {
        // cleanup() kills the child on every healthy session's teardown, when
        // the race is already settled: the abandoned arm must not reject.
        if (!startupUndecided) return false;
        throw new Error(
          `CLI exited during startup (code ${exitCode}, signal ${signal})\n` +
            `Output:\n${output}`,
        );
      }),
    ]);
    startupUndecided = false;
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

  it(
    'model-invoked skill: the gate fires and blocks the shell call',
    { timeout: MODEL_CASE_TIMEOUT, retry: 0 },
    async () => {
      const { output, executed } = await driveSession({
        testName: 'skill hooks model invoked',
        modelInvokesSkill: true,
      });
      expect(
        output,
        `gate did not fire. Output tail:\n${output.slice(-1500)}`,
      ).toContain(GATE_MARKER);
      expect(executed).toBe(false);
    },
  );

  it(
    'user-invoked skill (/<skill-name>): the gate fires and blocks the shell call',
    { timeout: USER_CASE_TIMEOUT, retry: 0 },
    async () => {
      const { output, executed } = await driveSession({
        testName: 'skill hooks slash invoked',
        modelInvokesSkill: false,
      });
      expect(
        output,
        `gate did not fire. Output tail:\n${output.slice(-1500)}`,
      ).toContain(GATE_MARKER);
      expect(executed).toBe(false);
    },
  );
});

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

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  applyContainerSandboxNoProxy,
  fakeServerHostOptions,
  TestRig,
} from './test-helper.js';
import { fakeToolCall, startFakeOpenAIServer } from './fake-openai-server.js';
import type { FakeOpenAIServer } from './fake-openai-server.js';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, chmodSync, existsSync } from 'node:fs';

const GATE_MARKER = 'GATE_BLOCKED_DOWNSTREAM_SESSION_ID_MISSING';
const EXECUTED_FLAG = 'executed.flag';
const SKILL_DESCRIPTION =
  'Calls the downstream CLI using a runtime-injected session ID';
// Only a loaded skill command can render its own description in the
// completion menu, which is what the user path polls for. Match on a prefix
// short enough to survive a narrow terminal truncating the rest.
const SKILL_DESCRIPTION_PREFIX = 'Calls the downstream CLI';

function installGatedSkill(testDir: string) {
  const skillDir = join(testDir, '.qwen', 'skills', 'gated-skill');
  mkdirSync(join(skillDir, 'scripts'), { recursive: true });

  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---
name: gated-skill
description: ${SKILL_DESCRIPTION}
hooks:
  PreToolUse:
    - matcher: Shell
      hooks:
        - type: command
          command: "$QWEN_SKILL_ROOT/scripts/gate-session-id.sh"
---

Only use the exact runtime-injected ID (\`DOWNSTREAM_SESSION_ID\`).
Never fabricate a fallback; stop if it is missing.
`,
  );

  const gate = join(skillDir, 'scripts', 'gate-session-id.sh');
  writeFileSync(
    gate,
    `#!/usr/bin/env bash
if [ -z "\${DOWNSTREAM_SESSION_ID:-}" ]; then
  echo "${GATE_MARKER}" >&2
  exit 2
fi
exit 0
`,
  );
  chmodSync(gate, 0o755);
}

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
            fakeToolCall('skill', { skill: 'gated-skill' }, 'call-skill'),
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

    vi.stubEnv('OPENAI_API_KEY', 'fake-key');
    vi.stubEnv('OPENAI_BASE_URL', fakeServer.baseUrl);
    vi.stubEnv('OPENAI_MODEL', 'fake-model');
    vi.stubEnv('QWEN_MODEL', 'fake-model');
    vi.stubEnv('QWEN_HOME', join(rig.testDir!, '.qwen-home'));
    vi.stubEnv('QWEN_RUNTIME_DIR', join(rig.testDir!, '.qwen-home'));
    // Under the docker/podman sandbox legs the CLI is containerized, so the
    // fake server must be reachable as host.docker.internal and excluded from
    // the proxy. Both helpers are no-ops outside a container sandbox.
    restoreNoProxy = applyContainerSandboxNoProxy();
    // The gate's required value is deliberately absent.
    vi.stubEnv('DOWNSTREAM_SESSION_ID', '');

    const { ptyProcess } = rig.runInteractive(
      '--auth-type',
      'openai',
      '--model',
      'fake-model',
      '--openai-base-url',
      fakeServer.baseUrl,
      '--openai-api-key',
      'fake-key',
    );

    let output = '';
    ptyProcess.onData((d) => {
      output += d;
    });

    const ready = await rig.waitForText('Type your message', 30000);
    expect(ready, `CLI did not start. Output:\n${output}`).toBe(true);

    // Every wait below polls for the condition it is actually waiting on, so
    // the test neither burns a fixed budget on a fast runner nor gives up
    // early on a slow one.
    const waitFor = async (label: string, done: () => boolean) => {
      const ok = await rig.poll(done, 30000, 100);
      expect(ok, `timed out waiting for ${label}. Output:\n${output}`).toBe(
        true,
      );
    };

    if (!options.modelInvokesSkill) {
      // USER path: start the skill by hand. Wait for the command to exist,
      // not merely for the typed text to come back: the echo lands long
      // before the skill command registry does, and submitting into that gap
      // gets `Unknown command: /gated-skill` instead of the skill. That
      // failure is undetectable downstream — the error text contains
      // `/gated-skill`, so any inclusion check on the typed command matches
      // it too. The completion menu rendering the skill's own description is
      // a signal only a registered command can produce.
      ptyProcess.write('/gated-skill');
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
      ).not.toContain('Unknown command: /gated-skill');
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

    // Ctrl+C twice to exit; the second only registers once the first has been
    // acknowledged.
    ptyProcess.write('\x03');
    await waitFor('the exit confirmation', () =>
      output.includes('Ctrl+C again to exit'),
    );
    ptyProcess.write('\x03');

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

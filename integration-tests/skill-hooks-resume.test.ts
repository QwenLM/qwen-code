/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A Skill's frontmatter `hooks:` must still be in force after the session is
 * resumed. Regression for #11180, where `--continue` replayed the Skill's
 * instructions into the model's context but restored none of the session
 * state that enforces them: `restoreLoadedSkillsFromHistory` re-populated the
 * dedup sets and never re-applied the Skill's side effects, so a `PreToolUse`
 * gate that blocked a call in the first session silently let the same call
 * through in the resumed one.
 *
 * The evidence here is a hit counter the gate appends to on every fire, not
 * the transcript: a resumed session replays the earlier turn's `GATE_BLOCKED`
 * message, which reads exactly like a gate that is still armed. The count is
 * what tells the two apart.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  applyContainerSandboxNoProxy,
  fakeServerHostOptions,
  TestRig,
} from './test-helper.js';
import { fakeToolCall, startFakeOpenAIServer } from './fake-openai-server.js';
import type {
  FakeOpenAIResponse,
  FakeOpenAIServer,
} from './fake-openai-server.js';
import { join } from 'node:path';
import {
  mkdirSync,
  writeFileSync,
  chmodSync,
  existsSync,
  readFileSync,
} from 'node:fs';

const GATE_MARKER = 'GATE_BLOCKED_DOWNSTREAM_SESSION_ID_MISSING';
const EXECUTED_FLAG = 'executed.flag';
/** Present in the Skill body, so a resumed request can be recognized. */
const SKILL_BODY_SENTINEL = 'Never fabricate a fallback';
/** Typed by the "user"; the fake model dispatches on these. */
const START_SKILL = 'load the gated skill';
const RUN_DOWNSTREAM = 'run the downstream command';

function installGatedSkill(testDir: string) {
  const skillDir = join(testDir, '.qwen', 'skills', 'gated-skill');
  mkdirSync(join(skillDir, 'scripts'), { recursive: true });

  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---
name: gated-skill
description: Calls the downstream CLI using a runtime-injected session ID
hooks:
  PreToolUse:
    - matcher: Shell
      hooks:
        - type: command
          command: "$QWEN_SKILL_ROOT/scripts/gate-session-id.sh"
---

Only use the exact runtime-injected ID (\`DOWNSTREAM_SESSION_ID\`).
${SKILL_BODY_SENTINEL}; stop if it is missing.
`,
  );

  const gate = join(skillDir, 'scripts', 'gate-session-id.sh');
  writeFileSync(
    gate,
    `#!/usr/bin/env bash
echo fired >> "$QWEN_SKILL_ROOT/gate-hits.log"
if [ -z "\${DOWNSTREAM_SESSION_ID:-}" ]; then
  echo "${GATE_MARKER}" >&2
  exit 2
fi
exit 0
`,
  );
  chmodSync(gate, 0o755);

  return { skillDir, hitsLog: join(skillDir, 'gate-hits.log') };
}

/** How many times the gate has actually run. */
function gateHits(hitsLog: string): number {
  if (!existsSync(hitsLog)) return 0;
  return readFileSync(hitsLog, 'utf8').split('\n').filter(Boolean).length;
}

describe('skill hooks survive session resume', () => {
  let rig: TestRig;
  let fakeServer: FakeOpenAIServer;
  let restoreNoProxy: (() => void) | undefined;

  afterEach(async () => {
    restoreNoProxy?.();
    restoreNoProxy = undefined;
    await fakeServer?.close();
    await rig?.cleanup();
  });

  it('a gate that blocked in the first session still blocks after --continue', async () => {
    rig = new TestRig();
    await rig.setup('skill hooks survive resume');
    const { hitsLog } = installGatedSkill(rig.testDir!);

    // The fake model dispatches on the last user message rather than on a
    // request counter, so the script does not have to predict how many
    // requests each session makes — and the second session's turns are
    // scripted identically to the first's regardless of what came before.
    fakeServer = await startFakeOpenAIServer(({ body }): FakeOpenAIResponse => {
      if (body['stream'] !== true) {
        return { content: '{"selected_memories":[]}' };
      }
      const messages =
        (body['messages'] as Array<{ role?: string; content?: unknown }>) ?? [];
      const last = messages[messages.length - 1];
      // Anything that is not a fresh user turn (a tool result, most
      // importantly) ends the turn, so a tool call is never re-issued in a
      // loop.
      if (!last || last.role !== 'user') {
        return { content: 'done' };
      }
      const text =
        typeof last.content === 'string'
          ? last.content
          : JSON.stringify(last.content ?? '');
      if (text.includes(START_SKILL)) {
        return {
          toolCalls: [
            // No fixed id: the CLI suppresses a tool call whose id already
            // appears earlier in the conversation, and the resumed session
            // replays the first session's calls.
            fakeToolCall('skill', { skill: 'gated-skill' }),
          ],
        };
      }
      if (text.includes(RUN_DOWNSTREAM)) {
        return {
          toolCalls: [
            fakeToolCall('run_shell_command', {
              command: `touch ${EXECUTED_FLAG}`,
            }),
          ],
        };
      }
      return { content: 'done' };
    }, fakeServerHostOptions());

    vi.stubEnv('OPENAI_API_KEY', 'fake-key');
    vi.stubEnv('OPENAI_BASE_URL', fakeServer.baseUrl);
    vi.stubEnv('OPENAI_MODEL', 'fake-model');
    vi.stubEnv('QWEN_MODEL', 'fake-model');
    // Both launches share one home so `--continue` can find the recorded
    // session, and neither can reach the developer's real one.
    vi.stubEnv('QWEN_HOME', join(rig.testDir!, '.qwen-home'));
    vi.stubEnv('QWEN_RUNTIME_DIR', join(rig.testDir!, '.qwen-home'));
    restoreNoProxy = applyContainerSandboxNoProxy();
    // The gate's required value is deliberately absent, in both sessions.
    vi.stubEnv('DOWNSTREAM_SESSION_ID', '');

    const flagPath = join(rig.testDir!, EXECUTED_FLAG);

    /**
     * Launches the CLI, sends each prompt, and waits for the shell call to be
     * gated or to run. Returns once the process has been asked to exit.
     */
    const runSession = async (options: {
      extraArgs: string[];
      prompts: string[];
    }): Promise<string> => {
      // Session 1 leaves its own hit behind, so every wait and assertion in a
      // later session has to be relative to what was already on disk.
      const hitsAtLaunch = gateHits(hitsLog);
      const { ptyProcess, promise: exited } = rig.runInteractiveWith(
        { chatRecording: true },
        ...options.extraArgs,
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

      const waitFor = async (label: string, done: () => boolean) => {
        const ok = await rig.poll(done, 30000, 100);
        expect(ok, `timed out waiting for ${label}. Output:\n${output}`).toBe(
          true,
        );
      };

      const ready = await rig.waitForText('Type your message', 30000);
      expect(ready, `CLI did not start. Output:\n${output}`).toBe(true);

      /**
       * Types one prompt and waits for it to reach the model.
       *
       * Both waits are retried rather than done once, because a resumed
       * session renders its input box while it is still restoring and drops
       * anything typed into that window. Echo is matched only against output
       * produced after the write: the resumed transcript replays the earlier
       * turn's prompt verbatim, so a plain `output.includes(prompt)` reports
       * an echo that never happened.
       */
      const send = async (prompt: string) => {
        const before = fakeServer.requests.length;
        let echoed = false;
        for (let attempt = 0; attempt < 6 && !echoed; attempt++) {
          const mark = output.length;
          ptyProcess.write(prompt);
          echoed = await rig.poll(
            () => output.slice(mark).includes(prompt),
            5000,
            100,
          );
        }
        expect(
          echoed,
          `the prompt "${prompt}" never echoed. Output:\n${output}`,
        ).toBe(true);

        let sent = false;
        for (let attempt = 0; attempt < 3 && !sent; attempt++) {
          ptyProcess.write('\r');
          sent = await rig.poll(
            () => fakeServer.requests.length > before,
            10000,
            100,
          );
        }
        expect(
          sent,
          `the prompt "${prompt}" never reached the model. Output:\n${output}`,
        ).toBe(true);
      };

      for (const prompt of options.prompts) {
        await send(prompt);
      }

      await waitFor(
        'the shell call to be gated or to run',
        () => existsSync(flagPath) || gateHits(hitsLog) > hitsAtLaunch,
      );

      // Ctrl+C twice to exit; the second only registers once the first has
      // been acknowledged.
      ptyProcess.write('\x03');
      await waitFor('the exit confirmation', () =>
        output.includes('Ctrl+C again to exit'),
      );
      ptyProcess.write('\x03');
      // Wait for the process to actually exit before the next launch: the
      // conversation `--continue` reads is written on the way out, so racing
      // it produces a resumed session with an empty history — which looks
      // exactly like the bug under test.
      await exited;
      return output;
    };

    // Session 1 — the control. The model loads the skill, then tries the
    // downstream command; the gate blocks it.
    const first = await runSession({
      extraArgs: [],
      prompts: [START_SKILL, RUN_DOWNSTREAM],
    });
    expect(
      gateHits(hitsLog),
      `gate did not fire in the first session. Output tail:\n${first.slice(-1500)}`,
    ).toBe(1);
    expect(existsSync(flagPath)).toBe(false);

    // Session 2 — resume. Only the downstream prompt is sent: the skill body
    // comes back with the replayed conversation, so nothing re-invokes the
    // skill, which is exactly the condition under which the gate went missing.
    const requestsBeforeResume = fakeServer.requests.length;
    const second = await runSession({
      extraArgs: ['--continue'],
      prompts: [RUN_DOWNSTREAM],
    });

    // Guard against a false negative: if `--continue` had found no session,
    // the skill's instructions would be absent too and the gate would be
    // rightly missing for an unrelated reason.
    const resumedRequests = fakeServer.requests
      .slice(requestsBeforeResume)
      .filter((r) => r.body['stream'] === true);
    expect(
      resumedRequests.some((r) =>
        JSON.stringify(r.body['messages'] ?? '').includes(SKILL_BODY_SENTINEL),
      ),
      'the resumed session did not carry the skill body, so this run proves nothing',
    ).toBe(true);

    expect(
      gateHits(hitsLog),
      `the gate did not fire after --continue. Output tail:\n${second.slice(-1500)}`,
    ).toBe(2);
    expect(
      existsSync(flagPath),
      'the shell command ran in the resumed session',
    ).toBe(false);
  }, 240000);
});

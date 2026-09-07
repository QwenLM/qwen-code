/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The skill fixture both `PreToolUse`-gate suites drive, and the launch
 * scaffolding around it.
 *
 * `skill-hooks-invocation-parity` (#11067: the gate must fire whoever invoked
 * the skill) and `skill-hooks-resume` (#11180: it must still fire after
 * `--continue`) need the same on-disk skill, the same fake-model environment
 * and the same interactive launch. They were two copies, already diverged in
 * the one place that decides the assertions: only the resume suite wrote the
 * hit counter, and nothing at the other call site said why. A shared fixture
 * that always writes it keeps the divergence from mattering — a renamed
 * skill, a different gate shell, or a changed auth flag is now one edit, not
 * two, and a missed one is a compile error rather than a timeout inside a
 * four-minute PTY test.
 *
 * What is deliberately NOT shared is the fake model itself: parity dispatches
 * on a request counter, resume on the last user message's text (its second
 * session replays the first one's turns, so a counter would mis-script it).
 * Those are different scripts for different questions, not two copies of one.
 */

import { join } from 'node:path';
import {
  mkdirSync,
  writeFileSync,
  chmodSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { expect, vi } from 'vitest';
import { applyContainerSandboxNoProxy, type TestRig } from '../test-helper.js';
import type { FakeOpenAIServer } from '../fake-openai-server.js';

/** Written to stderr by the gate when it blocks a call. */
export const GATE_MARKER = 'GATE_BLOCKED_DOWNSTREAM_SESSION_ID_MISSING';
/** The file the gated shell command would create if the gate let it through. */
export const EXECUTED_FLAG = 'executed.flag';
export const SKILL_NAME = 'gated-skill';
export const SKILL_DESCRIPTION =
  'Calls the downstream CLI using a runtime-injected session ID';
/**
 * Only a loaded skill command can render its own description in the
 * completion menu, which is what the user path polls for. Match on a prefix
 * short enough to survive a narrow terminal truncating the rest.
 */
export const SKILL_DESCRIPTION_PREFIX = 'Calls the downstream CLI';
/** Present in the skill body, so a resumed request can be recognized. */
export const SKILL_BODY_SENTINEL = 'Never fabricate a fallback';

/**
 * Writes the gated skill into `testDir` and returns where its evidence lands.
 *
 * The gate appends to `gate-hits.log` on every fire, unconditionally. The
 * resume suite needs that counter — a resumed session replays the earlier
 * turn's `GATE_BLOCKED` line, which reads exactly like a gate that is still
 * armed, so only the count tells the two apart — and the parity suite simply
 * ignores it. Making it conditional is what let the two copies drift.
 */
export function installGatedSkill(testDir: string): {
  skillDir: string;
  hitsLog: string;
} {
  const skillDir = join(testDir, '.qwen', 'skills', SKILL_NAME);
  mkdirSync(join(skillDir, 'scripts'), { recursive: true });

  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---
name: ${SKILL_NAME}
description: ${SKILL_DESCRIPTION}
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
export function gateHits(hitsLog: string): number {
  if (!existsSync(hitsLog)) return 0;
  return readFileSync(hitsLog, 'utf8').split('\n').filter(Boolean).length;
}

/**
 * Points the CLI at the fake model and away from the developer's real home,
 * and leaves the gate's required value absent so it always blocks.
 *
 * `QWEN_HOME` and `QWEN_RUNTIME_DIR` land inside the rig's own directory, so
 * a suite that launches twice (resume) finds its recorded session there and
 * neither launch can reach the real one.
 *
 * Returns the no-proxy restore function: under the docker/podman sandbox legs
 * the CLI is containerized, so the fake server must be reachable as
 * host.docker.internal and excluded from the proxy. Both halves are no-ops
 * outside a container sandbox.
 */
export function stubFakeModelEnv(
  rig: TestRig,
  fakeServer: FakeOpenAIServer,
): () => void {
  vi.stubEnv('OPENAI_API_KEY', 'fake-key');
  vi.stubEnv('OPENAI_BASE_URL', fakeServer.baseUrl);
  vi.stubEnv('OPENAI_MODEL', 'fake-model');
  vi.stubEnv('QWEN_MODEL', 'fake-model');
  vi.stubEnv('QWEN_HOME', join(rig.testDir!, '.qwen-home'));
  vi.stubEnv('QWEN_RUNTIME_DIR', join(rig.testDir!, '.qwen-home'));
  const restoreNoProxy = applyContainerSandboxNoProxy();
  // The gate's required value is deliberately absent, in every session.
  vi.stubEnv('DOWNSTREAM_SESSION_ID', '');
  return restoreNoProxy;
}

/** The launch arguments that select the fake model over the real auth flow. */
export function fakeModelLaunchArgs(fakeServer: FakeOpenAIServer): string[] {
  return [
    '--auth-type',
    'openai',
    '--model',
    'fake-model',
    '--openai-base-url',
    fakeServer.baseUrl,
    '--openai-api-key',
    'fake-key',
  ];
}

/**
 * Builds the `waitFor` both suites use: poll for the condition actually being
 * waited on, so a fast runner does not burn a fixed budget and a slow one is
 * not given up on early, and name it in the failure so a timeout says which
 * step never happened.
 */
export function makeWaitFor(rig: TestRig, getOutput: () => string) {
  return async (label: string, done: () => boolean): Promise<void> => {
    const ok = await rig.poll(done, 30000, 100);
    expect(ok, `timed out waiting for ${label}. Output:\n${getOutput()}`).toBe(
      true,
    );
  };
}

/**
 * Ctrl+C twice to exit; the second only registers once the first has been
 * acknowledged.
 */
export async function exitInteractive(
  ptyProcess: { write(data: string): void },
  waitFor: (label: string, done: () => boolean) => Promise<void>,
  getOutput: () => string,
): Promise<void> {
  ptyProcess.write('\x03');
  await waitFor('the exit confirmation', () =>
    getOutput().includes('Ctrl+C again to exit'),
  );
  ptyProcess.write('\x03');
}

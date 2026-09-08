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
 * two. Every constant a suite depends on is imported rather than re-spelled,
 * and every path written from inside a generated file is named once here, so
 * a change that the type checker cannot catch cannot silently disarm the gate
 * and surface as a timeout inside a four-minute PTY test.
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
/**
 * Only a loaded skill command can render its own description in the
 * completion menu, which is what the user path polls for. Match on a prefix
 * short enough to survive a narrow terminal truncating the rest.
 */
export const SKILL_DESCRIPTION_PREFIX = 'Calls the downstream CLI';
/**
 * Derived from the prefix rather than repeating it, so the two cannot drift:
 * a hand-copied prefix that no longer prefixes the description sends the user
 * path polling for text the completion menu never renders, and it fails as
 * `timed out waiting for the skill command to be registered` — the product
 * regression that wait exists to rule out.
 */
export const SKILL_DESCRIPTION = `${SKILL_DESCRIPTION_PREFIX} using a runtime-injected session ID`;
/** Present in the skill body, so a resumed request can be recognized. */
export const SKILL_BODY_SENTINEL = 'Never fabricate a fallback';
/**
 * On-disk paths spelled once each. Both are written from inside a generated
 * file and read back from TypeScript, so a second spelling is a silent
 * disagreement: rename half of the gate path and the hook never runs, rename
 * half of the counter path and `gateHits` returns the same 0 it returns for
 * "the gate never fired" — blaming the code under test for a fixture typo,
 * deterministically, three times under `retry: 2`.
 */
const GATE_SCRIPT = 'scripts/gate-session-id.sh';
const GATE_HITS_LOG = 'gate-hits.log';

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

  // The description is emitted as a quoted YAML flow scalar, not a bare plain
  // scalar. A value YAML treats specially — a colon-space, a leading `-`, an
  // embedded ` #` — does not fail loudly here: the frontmatter parser catches
  // the error and falls back to a line-based parse that rescues `description`
  // and flattens the nested `hooks:` block, which `parseHooksConfig` then
  // discards. The skill loads, the command registers, and the gate simply
  // does not exist. `JSON.stringify` is valid YAML flow syntax and round-trips
  // to the identical string, so the hazard becomes unrepresentable rather
  // than merely detectable — and it leaks no quote characters into the parsed
  // value, which the user path asserts against the rendered menu text.
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---
name: ${JSON.stringify(SKILL_NAME)}
description: ${JSON.stringify(SKILL_DESCRIPTION)}
hooks:
  PreToolUse:
    - matcher: Shell
      hooks:
        - type: command
          command: "$QWEN_SKILL_ROOT/${GATE_SCRIPT}"
---

Only use the exact runtime-injected ID (\`DOWNSTREAM_SESSION_ID\`).
${SKILL_BODY_SENTINEL}; stop if it is missing.
`,
  );

  const gate = join(skillDir, GATE_SCRIPT);
  writeFileSync(
    gate,
    `#!/usr/bin/env bash
echo fired >> "$QWEN_SKILL_ROOT/${GATE_HITS_LOG}"
if [ -z "\${DOWNSTREAM_SESSION_ID:-}" ]; then
  echo "${GATE_MARKER}" >&2
  exit 2
fi
exit 0
`,
  );
  chmodSync(gate, 0o755);

  return { skillDir, hitsLog: join(skillDir, GATE_HITS_LOG) };
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

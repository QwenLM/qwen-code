/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InteractiveSession } from './interactive-session.js';

// #13552's CI failure was the ready-prompt wait in InteractiveSession.start
// dying at 30s while the sandbox:docker leg's container was still booting —
// `Timeout (30000ms) waiting for text: "Type your message"` on all three
// retries. The budget decision itself is pinned state-by-state in
// scripts/tests/ready-prompt-budget.test.ts (no PR-triggered job executes
// integration-tests/**); these real-spawn cases keep the wiring proof that
// start() passes the resolved budget to waitFor, honours options.command,
// closes the session it refuses to hand out, and fails fast on a dead child.
const PROMPT_DELAY_MS = 35_000;

describe('InteractiveSession.start ready-prompt budget', () => {
  let session: InteractiveSession | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    vi.unstubAllEnvs();
  });

  it('keeps the tight 30s signal outside self-hosted runners', async () => {
    vi.stubEnv('RUNNER_ENVIRONMENT', 'github-hosted');
    // The stub prints its ready prompt 5s past the tight budget and writes
    // its pid down so the cleanup is observable: a rejected start() must
    // kill the child, not orphan it.
    const dir = mkdtempSync(join(tmpdir(), 'qwen-interactive-session-'));
    const pidFile = join(dir, 'stub.pid');
    const stub = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setTimeout(() => console.log('Type your message'), ${PROMPT_DELAY_MS});
setTimeout(() => {}, 120_000);`;
    try {
      // Capture through the outer binding inside .then: an unexpected
      // resolve must not put the session object itself into the assertion
      // error — it does not survive vitest's RPC serialization — but the
      // leaked session still needs afterEach to close it.
      await expect(
        InteractiveSession.start({
          command: { bin: process.execPath, args: ['-e', stub] },
        }).then((s) => {
          session = s;
        }),
      ).rejects.toThrow(
        'Timeout (30000ms) waiting for text: "Type your message"',
      );
      const pid = Number(readFileSync(pidFile, 'utf8'));
      let alive = true;
      for (let i = 0; i < 50 && alive; i++) {
        try {
          process.kill(pid, 0);
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails fast when the CLI exits before the ready prompt', async () => {
    const startedAt = Date.now();
    await expect(
      InteractiveSession.start({
        command: { bin: process.execPath, args: ['-e', 'process.exit(3)'] },
      }).then((s) => {
        session = s;
      }),
    ).rejects.toThrow('CLI exited before the ready prompt (code 3');
    expect(Date.now() - startedAt).toBeLessThan(30_000);
  });
});

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
// retries. No PR-triggered job collects this file — the PR-gated
// integration_no_ak leg runs an explicit allow-list under
// --root ./integration-tests that does not name it, and the whole-root legs
// run post-merge and at release — so the budget decision and start()'s
// contract are pinned byte-wise in scripts/tests/ (ready-prompt-budget.test.ts
// and interactive-session-start.test.ts), which test:scripts runs on every
// PR. These real-spawn cases cover the behaviour a source pin cannot: the
// tight branch's 30s value, options.command, refused-session cleanup,
// dead-child fail-fast with its captured tail, the exit line's neutral
// wording for a post-prompt death, and a pending waitFor stopping at
// close().
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
    // The marker must survive into the rejection: the exit path carries the
    // same captured tail as waitFor's timeout, or a dead child's boot log is
    // discarded unread (the sandbox-hop lines that made #13552 diagnosable).
    // The exit is delayed so the write reaches the pty before the child dies.
    const attempt = InteractiveSession.start({
      command: {
        bin: process.execPath,
        args: [
          '-e',
          "console.error('BOOTCRASH_MARKER'); setTimeout(() => process.exit(3), 300)",
        ],
      },
    }).then((s) => {
      session = s;
    });
    await expect(attempt).rejects.toThrow('CLI exited during startup (code 3');
    await expect(attempt).rejects.toThrow('BOOTCRASH_MARKER');
    expect(Date.now() - startedAt).toBeLessThan(30_000);
  });

  it('words an immediate post-prompt death from the captured output', async () => {
    // A >4KB burst ending in the prompt, then an immediate exit: on a fast
    // host the exit beats waitFor's 200ms scan grid by two orders of
    // magnitude, and under read lag the burst outruns the parent's final
    // read so the prompt never reaches rawOutput and waitFor cannot win —
    // either way the rejection is deterministic, unlike a prompt-then-die
    // gap whose outcome rode the scan grid's phase. The CLI did print its
    // prompt, so the line must not claim it exited before it; reverting to
    // the 'before the ready prompt' wording reds this case.
    const attempt = InteractiveSession.start({
      command: {
        bin: process.execPath,
        args: [
          '-e',
          "process.stdout.write('BOOT LINE\\n'.repeat(600) + 'Type your message\\n'); process.exit(4)",
        ],
      },
    }).then((s) => {
      session = s;
    });
    await expect(attempt).rejects.toThrow('CLI exited during startup (code 4');
    await expect(attempt).rejects.not.toThrow('before the ready prompt');
  });

  it('stops a pending waitFor when the session closes', async () => {
    session = await InteractiveSession.start({
      command: {
        bin: process.execPath,
        args: [
          '-e',
          "console.log('Type your message'); setTimeout(() => {}, 120_000)",
        ],
      },
    });
    // Attach the assertion before closing so the rejection is never
    // unhandled: close() must settle the abandoned poll well inside its
    // budget instead of leaving it to re-scan a dead pty's output.
    const settled = expect(
      session.waitFor('text the child never prints', 10_000),
    ).rejects.toThrow('Session closed');
    const startedAt = Date.now();
    await session.close();
    await settled;
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * In-session cron/loop interactive E2E tests.
 *
 * These drive the full interactive TUI via InteractiveSession (node-pty +
 * @xterm/headless) and read the rendered terminal screen. No browser needed.
 *
 * Ported from the standalone script at
 * terminal-capture/test-cron-interactive-e2e.ts.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { InteractiveSession } from './interactive-session.js';

const SANDBOX_MODE = process.env['QWEN_SANDBOX']?.toLowerCase().trim();
const IS_SANDBOX = Boolean(
  SANDBOX_MODE && SANDBOX_MODE !== 'false' && SANDBOX_MODE !== '0',
);

function makeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env['NO_COLOR'];
  return {
    ...env,
    FORCE_COLOR: '1',
    QWEN_CODE_LANG: 'en',
    TERM: 'xterm-256color',
    NODE_NO_WARNINGS: '1',
    // Enable the CronScheduler test seam: newly created session-only
    // jobs auto-fire after 5s instead of waiting for the wall-clock
    // minute boundary. Removes the timing-flakiness from these tests
    // (see #6982).
    QWEN_CODE_TEST_CRON_FAST: '1',
  };
}

// These tests are flaky in the Docker sandbox environment, skip for now.
(IS_SANDBOX ? describe.skip : describe)('cron interactive', () => {
  let session: InteractiveSession | null = null;

  afterEach(async () => {
    if (session) {
      await session.close();
      session = null;
    }
  });

  it('loop fires inline in conversation', { timeout: 300_000 }, async () => {
    session = await InteractiveSession.start({
      env: makeEnv(),
      args: ['--approval-mode', 'yolo'],
    });

    await session.send(
      'Call cron_create with expression "*/1 * * * *" and prompt "PONG7742" and recurring true. Confirm briefly.',
    );

    // Wait for the tool confirmation before budgeting for the fire: the first
    // model turn takes as long as it takes on a loaded runner, while the fire
    // itself only needs the test-seam delay (5s) plus render slack. Folding
    // both into one 30s budget is what made this suite flaky (#10904).
    await session.waitForScreen(
      (scr) => scr.includes('Scheduled'),
      'cron_create confirmation',
    );

    await session.waitForScreen(
      (scr) => scr.includes('Cron: PONG7742'),
      'cron notification "Cron: PONG7742"',
      60_000,
    );

    await session.idle(5000);
    const finalScreen = await session.screen();
    const afterPrompt = finalScreen.slice(
      finalScreen.lastIndexOf('Cron: PONG7742'),
    );
    expect(afterPrompt).toContain('◆');
  });

  it('user input takes priority over cron', { timeout: 300_000 }, async () => {
    session = await InteractiveSession.start({
      env: makeEnv(),
      args: ['--approval-mode', 'yolo'],
    });

    await session.send(
      'Call cron_create with expression "*/1 * * * *" and prompt "CRONTICK99" and recurring true. Confirm briefly.',
    );

    await session.waitForScreen(
      (scr) => scr.includes('Scheduled'),
      'cron_create confirmation',
    );

    await session.waitForScreen(
      (scr) => scr.includes('Cron: CRONTICK99'),
      'first cron fire "Cron: CRONTICK99"',
      60_000,
    );

    await session.idle(5000);
    const userPriorityMarker = 'USERPRIORITY77';
    await session.send(`Reply with exactly ${userPriorityMarker} nothing else`);

    await session.waitForScreen(
      (scr) =>
        scr.indexOf(userPriorityMarker) !== scr.lastIndexOf(userPriorityMarker),
      'model response containing USERPRIORITY77',
    );
  });

  it(
    'error during cron turn does not kill the loop',
    { timeout: 300_000 },
    async () => {
      session = await InteractiveSession.start({
        env: makeEnv(),
        args: ['--approval-mode', 'yolo'],
      });

      await session.send(
        'Call cron_create with expression "*/1 * * * *" and prompt "Read the file /tmp/nonexistent_e2e_99.txt and report its contents. If it does not exist say FILEERR88." and recurring true. Confirm briefly.',
      );

      await session.waitForScreen(
        (scr) => scr.includes('Scheduled'),
        'cron_create confirmation',
      );

      // FILEERR88 must show up three times before the model's cron turn is
      // proven: once from this typed prompt echo, once from the fired cron
      // prompt rendering, and once from the model's reply. A bare includes()
      // would pass on the echo alone and never observe the fire. This assumes
      // the cron notification renders the full prompt text (test 1 above
      // relies on the same for PONG7742); if a long prompt ever gets
      // truncated there, this count needs adjusting, not the budget.
      await session.waitForScreen(
        (scr) => (scr.match(/FILEERR88/g) ?? []).length >= 3,
        'model reporting FILEERR88 from cron prompt',
      );

      await session.idle(5000);
      await session.send('Reply with exactly ALIVE99 nothing else');
      // Same echo discipline as USERPRIORITY77 above: the marker must appear
      // in the reply, not only in the typed prompt.
      await session.waitForScreen(
        (scr) => scr.indexOf('ALIVE99') !== scr.lastIndexOf('ALIVE99'),
        'model response ALIVE99',
      );
    },
  );
});

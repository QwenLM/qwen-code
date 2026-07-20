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

  it('loop fires inline in conversation', { timeout: 180_000 }, async () => {
    session = await InteractiveSession.start({
      env: makeEnv(),
      args: ['--approval-mode', 'yolo'],
    });

    await session.send(
      'Call cron_create with expression "*/1 * * * *" and prompt "PONG7742" and recurring true. Confirm briefly.',
    );

    await session.waitForScreen(
      (scr) => scr.includes('Cron: PONG7742'),
      'cron notification "Cron: PONG7742"',
      30_000,
    );

    await session.idle(5000);
    const finalScreen = await session.screen();
    const afterPrompt = finalScreen.slice(
      finalScreen.lastIndexOf('Cron: PONG7742'),
    );
    expect(afterPrompt).toContain('◆');
  });

  it('user input takes priority over cron', { timeout: 180_000 }, async () => {
    session = await InteractiveSession.start({
      env: makeEnv(),
      args: ['--approval-mode', 'yolo'],
    });

    await session.send(
      'Call cron_create with expression "*/1 * * * *" and prompt "CRONTICK99" and recurring true. Confirm briefly.',
    );

    await session.waitForScreen(
      (scr) => scr.includes('Cron: CRONTICK99'),
      'first cron fire "Cron: CRONTICK99"',
      30_000,
    );

    await session.idle(5000);
    await session.send('Reply with exactly USERPRIORITY77 nothing else');

    await session.waitForScreen(
      (scr) => scr.includes('USERPRIORITY77'),
      'model response containing USERPRIORITY77',
    );

    const screen = await session.screen();
    expect(screen).toContain('Type your message');
  });

  it(
    'error during cron turn does not kill the loop',
    { timeout: 180_000 },
    async () => {
      session = await InteractiveSession.start({
        env: makeEnv(),
        args: ['--approval-mode', 'yolo'],
      });

      await session.send(
        'Call cron_create with expression "*/1 * * * *" and prompt "Read the file /tmp/nonexistent_e2e_99.txt and report its contents. If it does not exist say FILEERR88." and recurring true. Confirm briefly.',
      );

      await session.waitForScreen(
        (scr) => scr.includes('FILEERR88'),
        'model reporting FILEERR88 from cron prompt',
        30_000,
      );

      await session.idle(5000);
      await session.send('Reply with exactly ALIVE99 nothing else');
      await session.waitForScreen(
        (scr) => scr.includes('ALIVE99'),
        'model response ALIVE99',
      );
    },
  );
});

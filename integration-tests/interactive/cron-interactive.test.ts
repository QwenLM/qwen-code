/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * In-session cron/loop interactive E2E tests.
 *
 * These drive the full interactive TUI via TerminalCapture (node-pty + xterm.js
 * + Playwright) and read the rendered terminal screen. Ported from the
 * standalone script at terminal-capture/test-cron-interactive-e2e.ts.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { TerminalCapture } from '../terminal-capture/terminal-capture.js';

const MODEL_TIMEOUT = 120_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env['NO_COLOR'];
  return {
    ...env,
    QWEN_CODE_ENABLE_CRON: '1',
    FORCE_COLOR: '1',
    TERM: 'xterm-256color',
    NODE_NO_WARNINGS: '1',
  };
}

class Session {
  private constructor(private t: TerminalCapture) {}

  static async start(): Promise<Session> {
    const t = await TerminalCapture.create({
      cols: 100,
      rows: 40,
      chrome: false,
      cwd: process.cwd(),
      env: makeEnv(),
    });
    await t.spawn('node', ['dist/cli.js', '--approval-mode', 'yolo']);
    const s = new Session(t);
    await s.waitFor('Type your message', 30_000);
    return s;
  }

  async send(text: string): Promise<void> {
    await this.t.type(text);
    await sleep(300);
    await this.t.type('\n');
  }

  async waitFor(text: string, timeout = MODEL_TIMEOUT): Promise<void> {
    await this.t.waitFor(text, { timeout });
  }

  async idle(stableMs = 5000, timeout = MODEL_TIMEOUT): Promise<void> {
    await this.t.idle(stableMs, timeout);
  }

  async screen(): Promise<string> {
    return this.t.getScreenText();
  }

  async waitForScreen(
    predicate: (screen: string) => boolean,
    description: string,
    timeout = MODEL_TIMEOUT,
  ): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      await sleep(3000);
      const s = await this.screen();
      if (predicate(s)) return s;
    }
    const finalScreen = await this.screen();
    throw new Error(
      `Timeout (${timeout}ms) waiting for: ${description}\n` +
        `Screen (last 600):\n${finalScreen.slice(-600)}`,
    );
  }

  async close(): Promise<void> {
    await this.t.close();
  }
}

describe('cron interactive (terminal-capture)', () => {
  let session: Session | null = null;

  afterEach(async () => {
    if (session) {
      await session.close();
      session = null;
    }
  });

  it(
    'loop fires inline in conversation',
    async () => {
      session = await Session.start();

      await session.send(
        'Call cron_create with expression "*/1 * * * *" and prompt "PONG7742" and recurring true. Confirm briefly.',
      );

      await session.waitForScreen(
        (scr) => scr.split('\n').some((l) => l.trim() === '> PONG7742'),
        'cron-injected prompt "> PONG7742"',
        90_000,
      );

      await session.idle(5000);
      const finalScreen = await session.screen();
      const afterPrompt = finalScreen.slice(
        finalScreen.lastIndexOf('> PONG7742'),
      );
      expect(afterPrompt).toContain('✦');
    },
    { timeout: 180_000 },
  );

  it(
    'user input takes priority over cron',
    async () => {
      session = await Session.start();

      await session.send(
        'Call cron_create with expression "*/1 * * * *" and prompt "CRONTICK99" and recurring true. Confirm briefly.',
      );

      await session.waitForScreen(
        (scr) => scr.split('\n').some((l) => l.trim() === '> CRONTICK99'),
        'first cron fire "> CRONTICK99"',
        90_000,
      );

      await session.idle(5000);
      await session.send('Reply with exactly USERPRIORITY77 nothing else');

      await session.waitForScreen(
        (scr) => scr.includes('USERPRIORITY77'),
        'model response containing USERPRIORITY77',
      );

      const screen = await session.screen();
      expect(screen).toContain('Type your message');
    },
    { timeout: 180_000 },
  );

  it(
    'error during cron turn does not kill the loop',
    async () => {
      session = await Session.start();

      await session.send(
        'Call cron_create with expression "*/1 * * * *" and prompt "Read the file /tmp/nonexistent_e2e_99.txt and report its contents. If it does not exist say FILEERR88." and recurring true. Confirm briefly.',
      );

      await session.waitForScreen(
        (scr) => scr.includes('FILEERR88'),
        'model reporting FILEERR88 from cron prompt',
        90_000,
      );

      await session.idle(5000);
      await session.send('Reply with exactly ALIVE99 nothing else');
      await session.waitForScreen(
        (scr) => scr.includes('ALIVE99'),
        'model response ALIVE99',
      );

      await session.send(
        'Call cron_list and tell me how many jobs exist. Say "COUNT: N"',
      );
      await session.idle(8000);
      const screen = await session.screen();
      expect(
        screen.includes('COUNT: 1') ||
          screen.includes('1 job') ||
          screen.includes('Active cron jobs (1)'),
      ).toBe(true);
    },
    { timeout: 180_000 },
  );
});

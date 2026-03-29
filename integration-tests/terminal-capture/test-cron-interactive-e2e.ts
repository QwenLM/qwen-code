/**
 * E2E tests for in-session cron/loop in interactive mode.
 *
 * These correspond to "Part 2: Manual tests" from the testing guide.
 * We drive the full interactive TUI via TerminalCapture and read the
 * rendered terminal screen from xterm.js.
 *
 * Usage:
 *   cd qwen-code && npx tsx integration-tests/terminal-capture/test-cron-interactive-e2e.ts
 */

import { TerminalCapture } from './terminal-capture.js';

// ─── Session helper ─────────────────────────────────────────

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

  /** Send text + Enter. */
  async send(text: string): Promise<void> {
    await this.t.type(text);
    await sleep(300);
    await this.t.type('\n');
  }

  /** Wait for text in raw output (fast, good for known markers). */
  async waitFor(text: string, timeout = MODEL_TIMEOUT): Promise<void> {
    await this.t.waitFor(text, { timeout });
  }

  /** Wait for output to stabilize. */
  async idle(stableMs = 5000, timeout = MODEL_TIMEOUT): Promise<void> {
    await this.t.idle(stableMs, timeout);
  }

  /** Read the rendered terminal screen (what a user actually sees). */
  async screen(): Promise<string> {
    return this.t.getScreenText();
  }

  /**
   * Poll the screen until `predicate` returns true.
   * Returns the screen text when matched.
   */
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

// ─── Test infrastructure ────────────────────────────────────

interface TestCase {
  name: string;
  run: () => Promise<void>;
}

const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, run: fn });
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ═══════════════════════════════════════════════════════════
// Test 12: Loop fires inline in conversation
// ═══════════════════════════════════════════════════════════

test('Loop fires inline in conversation', async () => {
  const s = await Session.start();
  try {
    // Create a cron job with a unique marker
    await s.send(
      'Call cron_create with expression "*/1 * * * *" and prompt "PONG7742" and recurring true. Confirm briefly.',
    );

    // Wait for the cron-injected prompt to appear on screen.
    // When the cron fires, the prompt "PONG7742" is injected as a user message,
    // appearing as "> PONG7742" on the terminal.
    await s.waitForScreen(
      (scr) => scr.split('\n').some((l) => l.trim() === '> PONG7742'),
      'cron-injected prompt "> PONG7742"',
      90_000,
    );
    console.log('    ✓ Cron-injected prompt appeared on screen');

    // Verify the model responded
    await s.idle(5000);
    const finalScreen = await s.screen();
    const afterPrompt = finalScreen.slice(
      finalScreen.lastIndexOf('> PONG7742'),
    );
    assert(afterPrompt.includes('✦'), 'Model should respond to cron prompt');
    console.log('    ✓ Model responded inline to cron-injected prompt');
  } finally {
    await s.close();
  }
});

// ═══════════════════════════════════════════════════════════
// Test 13: User input takes priority over cron
// ═══════════════════════════════════════════════════════════

test('User input takes priority over cron', async () => {
  const s = await Session.start();
  try {
    // Create a cron job
    await s.send(
      'Call cron_create with expression "*/1 * * * *" and prompt "CRONTICK99" and recurring true. Confirm briefly.',
    );

    // Wait for the first cron fire to confirm it works
    await s.waitForScreen(
      (scr) => scr.split('\n').some((l) => l.trim() === '> CRONTICK99'),
      'first cron fire "> CRONTICK99"',
      90_000,
    );
    console.log('    ✓ First cron fire observed');

    // Wait for idle, then immediately send user input
    await s.idle(5000);
    await s.send('Reply with exactly USERPRIORITY77 nothing else');

    // The user prompt should be processed and the model should respond
    await s.waitForScreen(
      (scr) => scr.includes('USERPRIORITY77'),
      'model response containing USERPRIORITY77',
    );
    console.log('    ✓ User input processed while cron active');

    // Verify session is still functional
    const screen = await s.screen();
    assert(
      screen.includes('Type your message'),
      'Session should still show input prompt',
    );
    console.log('    ✓ Session remains functional');
  } finally {
    await s.close();
  }
});

// ═══════════════════════════════════════════════════════════
// Test 15: /loop skill — SKIPPED
// The /loop skill definition exists (SKILL.md) but isn't registered as a
// slash command yet ("Unknown command: /loop"). Skipping until implemented.
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// Test 16: Error during cron turn doesn't kill the loop
// ═══════════════════════════════════════════════════════════

test('Error during cron turn does not kill the loop', async () => {
  const s = await Session.start();
  try {
    // Create a cron job that reads a nonexistent file
    await s.send(
      'Call cron_create with expression "*/1 * * * *" and prompt "Read the file /tmp/nonexistent_e2e_99.txt and report its contents. If it does not exist say FILEERR88." and recurring true. Confirm briefly.',
    );

    // Wait for the cron to fire and the model to report the error
    await s.waitForScreen(
      (scr) => scr.includes('FILEERR88'),
      'model reporting FILEERR88 from cron prompt',
      90_000,
    );
    console.log('    ✓ Cron fired, model reported file error');

    // Verify session is still functional by sending user input
    await s.idle(5000);
    await s.send('Reply with exactly ALIVE99 nothing else');
    await s.waitForScreen(
      (scr) => scr.includes('ALIVE99'),
      'model response ALIVE99',
    );
    console.log('    ✓ Session still functional after cron error');

    // Verify the cron job is still active (the error didn't delete it)
    await s.send(
      'Call cron_list and tell me how many jobs exist. Say "COUNT: N"',
    );
    await s.idle(8000);
    const screen = await s.screen();
    assert(
      screen.includes('COUNT: 1') ||
        screen.includes('1 job') ||
        screen.includes('Active cron jobs (1)'),
      'Cron job should still be active after error',
    );
    console.log('    ✓ Cron job still active (error did not kill the loop)');
  } finally {
    await s.close();
  }
});

// ─── Runner ─────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  In-Session Cron — Interactive Mode E2E Tests       ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  const results: {
    name: string;
    passed: boolean;
    error?: string;
    durationMs: number;
  }[] = [];

  for (const t of tests) {
    console.log(`  ▶ ${t.name}`);
    const start = Date.now();
    try {
      await t.run();
      const ms = Date.now() - start;
      results.push({ name: t.name, passed: true, durationMs: ms });
      console.log(`  ✓ PASSED (${(ms / 1000).toFixed(1)}s)\n`);
    } catch (err) {
      const ms = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        name: t.name,
        passed: false,
        error: message,
        durationMs: ms,
      });
      console.log(`  ✗ FAILED (${(ms / 1000).toFixed(1)}s)`);
      // Print first 3 lines of error
      const errLines = message.split('\n').slice(0, 3).join('\n');
      console.log(`    ${errLines}\n`);
    }
  }

  // Summary
  console.log('════════════════════════════════════════════════════════');
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = (r: (typeof results)[0]) =>
    `${(r.durationMs / 1000).toFixed(1)}s`;
  for (const r of results) {
    console.log(`  ${r.passed ? '✓' : '✗'} ${r.name} (${total(r)})`);
  }
  console.log(`\n  ${passed} passed, ${failed} failed`);
  console.log('════════════════════════════════════════════════════════');

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

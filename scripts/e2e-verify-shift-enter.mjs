/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E Shift+Enter Verification Script
 *
 * Tests that key sequences for newline insertion vs message submission
 * work correctly in the real CLI via a pseudo-terminal (node-pty +
 * @xterm/headless for proper screen rendering).
 *
 * No LLM API key required — tests only the input-handling layer,
 * never submits a message.
 *
 * Usage:
 *   node scripts/e2e-verify-shift-enter.mjs
 *   node scripts/e2e-verify-shift-enter.mjs --markdown
 *
 * Prerequisites:
 *   npm run build -w packages/web-templates
 *   npm run build -w packages/cli
 */

import * as pty from '@lydell/node-pty';
import stripAnsi from 'strip-ansi';
import xtermHeadless from '@xterm/headless';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import process from 'node:process';

const { Terminal } = xtermHeadless;
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CLI_PATH = join(ROOT, 'packages/cli/dist/index.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const markdownMode = process.argv.includes('--markdown');

// ─── Terminal colours ──────────────────────────────────────────────────────
const C = markdownMode
  ? { pass: '', fail: '', reset: '', bold: '', dim: '' }
  : {
      pass: '\x1b[32m',
      fail: '\x1b[31m',
      reset: '\x1b[0m',
      bold: '\x1b[1m',
      dim: '\x1b[2m',
    };

// ─── Test case definitions ────────────────────────────────────────────────
const TESTS = [
  {
    name: 'Plain Enter',
    keySeq: '\r',
    expectLine: false,
    note: 'CR (0x0d) — baseline SUBMIT',
  },
  {
    name: 'Ctrl+J',
    keySeq: '\x0a',
    expectLine: true,
    note: 'LF (0x0a) — universal newline fallback',
  },
  {
    name: 'VSCode ESC+CR',
    keySeq: '\x1b\r',
    expectLine: true,
    note: 'ESC(0x1b)+CR — VSCode Shift+Enter keybinding',
  },
  {
    name: 'Kitty CSI-u Shift+Enter',
    keySeq: '\x1b[13;2u',
    expectLine: true,
    kittyMode: true, // Simulate Kitty protocol handshake
    note: 'CSI 13;2u — Kitty keyboard protocol (handshake simulated)',
  },
  {
    name: 'Backslash then Enter (≤5 ms)',
    keySeq: null, // special handling
    special: 'backslash_enter',
    expectLine: true,
    note: 'Backward-compat: \\\\ followed by CR within 5 ms',
  },
];

// ─── PTY session helper ───────────────────────────────────────────────────

class PtySession {
  constructor() {
    this.rawOutput = '';
    this.pendingWrite = Promise.resolve();
    this.terminal = new Terminal({
      cols: 100,
      rows: 30,
      scrollback: 500,
      allowProposedApi: true,
    });
  }

  async start(kittyMode = false) {
    const env = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      NODE_ENV: 'test',
    };

    this.proc = pty.spawn('node', [CLI_PATH], {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: ROOT,
      env,
    });

    this.proc.onData((data) => {
      this.rawOutput += data;
      this.pendingWrite = this.pendingWrite.then(
        () =>
          new Promise((resolve) => {
            this.terminal.write(data, resolve);
          }),
      );

      // Kitty protocol simulation: respond to terminal capability queries.
      // The CLI sends '\x1b[?u\x1b[c' at startup. We reply with:
      //   \x1b[?1u  — progressive enhancement (Kitty supported)
      //   \x1b[?64c — device attributes (VT420 compatible)
      // This tells the CLI that Kitty keyboard protocol is available.
      if (kittyMode && !this._kittyHandshakeSent) {
        if (data.includes('\x1b[?u') || data.includes('\x1b[c')) {
          this._kittyHandshakeSent = true;
          // Write Kitty response and device attributes response to CLI stdin
          setTimeout(() => {
            this.proc.write('\x1b[?1u');   // Kitty progressive enhancement
            this.proc.write('\x1b[?64c');  // Device attributes
          }, 10);
        }
      }
    });

    this._kittyHandshakeSent = false;

    // Wait for the input prompt
    await this.waitFor('Type your message', 15_000);
    await sleep(500); // extra settle
  }

  async flush() {
    await this.pendingWrite;
  }

  /** Get the rendered screen (what the user actually sees). */
  async screen() {
    await this.flush();
    const buf = this.terminal.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true) : '');
    }
    // Trim trailing blank lines
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }
    return lines.join('\n');
  }

  /** Wait until `text` appears in raw output (ANSI stripped). */
  async waitFor(text, timeout = 15_000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (stripAnsi(this.rawOutput).includes(text)) return;
      await sleep(150);
    }
    throw new Error(`Timeout waiting for "${text}"`);
  }

  /** Type text character-by-character to bypass paste detection. */
  async type(text) {
    for (const ch of text) {
      this.proc.write(ch);
      await sleep(5);
    }
  }

  async close() {
    try {
      this.proc.kill();
    } catch (_e) {
      // Process may have already exited — ignore
    }
    this.terminal.dispose();
    await sleep(100);
  }
}

// ─── Screen analysis helpers ──────────────────────────────────────────────

/**
 * Returns true when the rendered screen shows the input box with
 * at least two lines (newline was inserted into the input field).
 *
 * Heuristic: after typing "hello" and pressing a newline key,
 * the Ink textarea renders:
 *   > hello
 *     █          ← cursor on 2nd line
 *
 * We detect this by counting lines that contain "hello" AND checking
 * for a subsequent blank (cursor) line, OR by checking that the input
 * area spans more than one row.
 */
function detectNewlineInserted(screen) {
  const lines = screen.split('\n').map((l) => l.trimEnd());

  // Find the "> hello" input line
  const helloIdx = lines.findIndex((l) => l.includes('> hello') || l.match(/^>\s*hello/));
  if (helloIdx === -1) return false;

  // The line immediately after the input text should exist and NOT be a
  // separator (────) or a status line (shortcuts / verbose). A blank or
  // whitespace line at helloIdx+1 means the cursor is on a 2nd input row.
  const nextLine = lines[helloIdx + 1];
  if (nextLine === undefined) return false;
  const isBlankOrCursor = nextLine.trim() === '' || nextLine.trim() === '​'; // zero-width space
  const isSeparator = nextLine.includes('───') || nextLine.includes('shortcuts');

  return isBlankOrCursor && !isSeparator;
}

/**
 * Returns true when the rendered screen shows the input box has been
 * cleared (message submitted) — the placeholder text or a spinner appears.
 */
function detectSubmitted(screen) {
  return (
    screen.includes('Type your message') ||
    screen.includes('Confuzzling') ||
    screen.includes('Thinking') ||
    screen.includes('⠋') ||
    screen.includes('⠙') ||
    screen.includes('⠹')
  );
}

// ─── Run a single test ────────────────────────────────────────────────────

async function runTest(tc) {
  const session = new PtySession();
  let pass = false;
  let error = null;
  let debugScreen = '';

  try {
    await session.start(tc.kittyMode ?? false);

    // Type the test payload
    await session.type('hello');
    await sleep(150);

    // Send the key sequence
    if (tc.special === 'backslash_enter') {
      session.proc.write('\\');
      await sleep(3); // within 5 ms to trigger backslash+Enter detection
      session.proc.write('\r');
    } else {
      session.proc.write(tc.keySeq);
    }

    await sleep(600);
    debugScreen = await session.screen();

    if (tc.expectLine) {
      pass = detectNewlineInserted(debugScreen);
    } else {
      // For SUBMIT: the input cleared OR the hello text is gone from input
      pass = detectSubmitted(debugScreen);
    }
  } catch (e) {
    error = e.message;
    pass = false;
  } finally {
    await session.close();
  }

  return { ...tc, result: pass ? 'PASS' : 'FAIL', pass, error, debugScreen };
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  const date = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const platform = `${os.platform()} ${os.arch()}`;
  const nodeVersion = process.version;

  if (markdownMode) {
    console.log('# E2E Shift+Enter Verification Report\n');
    console.log(`**Date**: ${date}  `);
    console.log(`**Platform**: ${platform}  `);
    console.log(`**Node.js**: ${nodeVersion}  `);
    console.log(`**CLI**: \`packages/cli/dist/index.js\`  `);
    console.log(`**Method**: Real PTY session (node-pty + @xterm/headless), no LLM API key required\n`);
  } else {
    console.log(`${C.bold}E2E Shift+Enter Verification Report${C.reset}`);
    console.log(`${C.dim}${date} | ${platform} | Node ${nodeVersion}${C.reset}\n`);
  }

  const results = [];

  for (const tc of TESTS) {
    if (!markdownMode) {
      process.stdout.write(`  Testing: ${tc.name.padEnd(35)} `);
    }
    const result = await runTest(tc);
    results.push(result);
    if (!markdownMode) {
      if (result.pass) {
        console.log(`${C.pass}PASS${C.reset}`);
      } else {
        console.log(`${C.fail}FAIL${C.reset}${result.error ? ` (${result.error})` : ''}`);
      }
    }
  }

  // ─── Output report ─────────────────────────────────────────────────────
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;

  if (markdownMode) {
    console.log('## Results\n');
    console.log('| # | Scenario | Key Sequence | Expected | Result | Notes |');
    console.log('|---|----------|-------------|----------|--------|-------|');
    results.forEach((r, i) => {
      let seq;
      if (r.special === 'backslash_enter') {
        seq = '`\\\\` + `\\r` (≤5 ms)';
      } else {
        seq = '`' +
          r.keySeq
            // eslint-disable-next-line no-control-regex
            .replace(/\x1b/g, '\\x1b')
            .replace(/\r/g, '\\r')
            // eslint-disable-next-line no-control-regex
            .replace(/\x0a/g, '\\x0a') +
          '`';
      }
      const expected = r.expectLine ? 'NEWLINE' : 'SUBMIT';
      const icon = r.pass ? '✅' : '❌';
      console.log(`| ${i + 1} | **${r.name}** | ${seq} | \`${expected}\` | ${icon} ${r.result} | ${r.note} |`);
    });

    console.log(`\n## Summary\n`);
    console.log(`**${passed}/${total} tests passed** ${passed === total ? '✅' : '❌'}\n`);

    if (passed < total) {
      console.log('### Failures\n');
      results
        .filter((r) => !r.pass)
        .forEach((r) => {
          console.log(`- **${r.name}**: ${r.error ?? 'assertion failed'}`);
        });
    }

    console.log('## Test Environment\n');
    console.log(`- Terminal emulation: \`xterm-256color\` via \`@xterm/headless\``);
    console.log(`- PTY: \`@lydell/node-pty\``);
    console.log(`- Input simulation: character-by-character (5ms delay) to bypass paste detection`);
    console.log(`- Screen capture: xterm headless buffer rendering (ANSI-aware)`);
  } else {
    console.log(`\n${'─'.repeat(50)}`);
    results.forEach((r, i) => {
      const icon = r.pass ? `${C.pass}✅${C.reset}` : `${C.fail}❌${C.reset}`;
      console.log(`  ${i + 1}. ${icon} ${r.name}${r.error ? ` — ${r.error}` : ''}`);
    });
    const summary = passed === total ? C.pass : C.fail;
    console.log(`\n${summary}${passed}/${total} passed${C.reset}`);
  }

  // Show debug screens for failures
  const failures = results.filter((r) => !r.pass);
  if (failures.length > 0 && !markdownMode) {
    console.log(`\n${C.dim}=== Debug screens for failures ===${C.reset}`);
    failures.forEach((r) => {
      console.log(`\n${C.dim}--- ${r.name} ---${C.reset}`);
      console.log(r.debugScreen?.slice(-400) ?? '(no screen captured)');
    });
  }

  process.exit(passed === total ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});

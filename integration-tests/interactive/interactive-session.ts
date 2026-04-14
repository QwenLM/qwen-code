/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * InteractiveSession — lightweight terminal session driver for interactive
 * integration tests.
 *
 * Architecture:
 *   node-pty (pseudo-terminal)
 *     ↓  raw ANSI byte stream
 *   @xterm/headless (pure Node.js terminal emulator)
 *     ↓  proper ANSI processing: cursor movement, line clearing, scrollback
 *   buffer.active.getLine()  →  rendered screen text
 *
 * No browser, no Playwright — runs entirely in Node.js.
 */

import * as pty from '@lydell/node-pty';
import stripAnsi from 'strip-ansi';
// @xterm/headless is CJS — use default import + destructure
import xtermHeadless from '@xterm/headless';
const { Terminal } = xtermHeadless;
type Terminal = InstanceType<typeof Terminal>;
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface InteractiveSessionOptions {
  /** Terminal columns, default 100 */
  cols?: number;
  /** Terminal rows, default 40 */
  rows?: number;
  /** Working directory, default project root */
  cwd?: string;
  /** Environment variables */
  env?: NodeJS.ProcessEnv;
  /** Extra CLI arguments (e.g. ['--approval-mode', 'yolo']) */
  args?: string[];
}

export class InteractiveSession {
  private ptyProcess: pty.IPty;
  private terminal: Terminal;
  private rawOutput = '';
  private pendingWrite: Promise<void> = Promise.resolve();

  private constructor(ptyProcess: pty.IPty, terminal: Terminal) {
    this.ptyProcess = ptyProcess;
    this.terminal = terminal;

    ptyProcess.onData((data) => {
      this.rawOutput += data;
      // Chain writes so flush() can await all pending data
      this.pendingWrite = this.pendingWrite.then(
        () =>
          new Promise<void>((resolve) => {
            terminal.write(data, resolve);
          }),
      );
    });
  }

  /** Wait for all pending PTY data to be processed by xterm. */
  private async flush(): Promise<void> {
    await this.pendingWrite;
  }

  /**
   * Start a new interactive session with the CLI.
   *
   * @example
   * ```ts
   * const session = await InteractiveSession.start({
   *   env: { QWEN_CODE_ENABLE_CRON: '1' },
   *   args: ['--approval-mode', 'yolo'],
   * });
   * ```
   */
  static async start(
    options?: InteractiveSessionOptions,
  ): Promise<InteractiveSession> {
    const cols = options?.cols ?? 100;
    const rows = options?.rows ?? 40;
    const cwd = options?.cwd ?? join(__dirname, '..', '..');
    const args = options?.args ?? [];

    const baseEnv = { ...process.env };
    delete baseEnv['NO_COLOR'];
    const env = options?.env ?? baseEnv;

    const terminal = new Terminal({
      cols,
      rows,
      scrollback: 1000,
      allowProposedApi: true,
    });

    const bundlePath = join(__dirname, '..', '..', 'dist/cli.js');
    const ptyProcess = pty.spawn('node', [bundlePath, ...args], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: env as Record<string, string>,
    });

    const session = new InteractiveSession(ptyProcess, terminal);
    await session.waitFor('Type your message', 30_000);
    return session;
  }

  /** Send text followed by Enter. */
  async send(text: string): Promise<void> {
    // Type character by character to avoid paste detection
    for (const char of text) {
      this.ptyProcess.write(char);
      await sleep(5);
    }
    await sleep(300);
    this.ptyProcess.write('\r');
  }

  /** Wait for text to appear in raw output. */
  async waitFor(text: string, timeout = 120_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (
        stripAnsi(this.rawOutput).toLowerCase().includes(text.toLowerCase())
      ) {
        return;
      }
      await sleep(200);
    }
    throw new Error(
      `Timeout (${timeout}ms) waiting for text: "${text}"\n` +
        `Last 500 chars: ${stripAnsi(this.rawOutput).slice(-500)}`,
    );
  }

  /** Wait for output to stabilize (no new output for `stableMs`). */
  async idle(stableMs = 5000, timeout = 120_000): Promise<void> {
    const start = Date.now();
    let lastLength = this.rawOutput.length;
    let lastChangeTime = Date.now();

    while (Date.now() - start < timeout) {
      await sleep(100);
      if (this.rawOutput.length !== lastLength) {
        lastLength = this.rawOutput.length;
        lastChangeTime = Date.now();
      } else if (Date.now() - lastChangeTime >= stableMs) {
        return;
      }
    }
  }

  /**
   * Read the rendered terminal screen — what a user would actually see.
   * Uses @xterm/headless buffer to get properly processed output,
   * handling cursor movement, line clearing, and scrollback.
   */
  async screen(): Promise<string> {
    await this.flush();
    const buf = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true) : '');
    }
    // Trim trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }
    return lines.join('\n');
  }

  /**
   * Poll the screen until `predicate` returns true.
   * Returns the screen text when matched.
   */
  async waitForScreen(
    predicate: (screen: string) => boolean,
    description: string,
    timeout = 120_000,
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

  /** Kill the PTY process and dispose the terminal. */
  async close(): Promise<void> {
    try {
      this.ptyProcess.kill();
    } catch {
      // Process may have already exited
    }
    this.terminal.dispose();
  }
}

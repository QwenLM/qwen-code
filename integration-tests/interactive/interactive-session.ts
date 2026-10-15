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
import {
  e2eRendererEnv,
  pickE2eRenderer,
  resolveE2eCliCommand,
} from '../renderer-matrix.js';
import { readyPromptBudgetMs } from '../ready-prompt-budget.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A field label only `/about` renders, spelled the same by both renderers. */
export const ABOUT_FIELD = 'Memory Usage';
const ABOUT_UNKNOWN = 'Unknown command: /about';

/**
 * Ink loads commands after the prompt appears; parallel CLI boots can keep
 * winning that race for several attempts. Retry only this read-only command
 * for up to 90 seconds so readiness does not invoke the workflow twice.
 * A missing transcript row still fails via waitForScreen rather than retrying.
 */
export async function sendAboutUntilRendered(
  session: InteractiveSession,
): Promise<void> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    await session.idle(500);
    await session.send('/about');
    const screen = await session.waitForScreen(
      (s) => s.includes(ABOUT_FIELD) || s.includes(ABOUT_UNKNOWN),
      `neither the /about row ("${ABOUT_FIELD}") nor "${ABOUT_UNKNOWN}" reached the screen`,
      20_000,
    );
    if (screen.includes(ABOUT_FIELD)) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `the /about transcript row ("${ABOUT_FIELD}") never reached the screen: ` +
          `ink still reported "${ABOUT_UNKNOWN}" at the end of the retry window.\n` +
          `Screen (last 600):\n${screen.slice(-600)}`,
      );
    }
  }
}

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
  /** Spawn this instead of the built CLI bundle (drives stub processes in tests). */
  command?: { bin: string; args: string[] };
}

export class InteractiveSession {
  private ptyProcess: pty.IPty;
  private terminal: Terminal;
  private rawOutput = '';
  private pendingWrite: Promise<void> = Promise.resolve();
  private closed = false;

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
   *   env: { QWEN_CODE_DISABLE_CRON: '1' },
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
    // The renderer matrix pins QWEN_TUI_RENDERER last so a test's own env
    // cannot silently switch the renderer mid-matrix.
    const env = {
      ...baseEnv,
      ...options?.env,
      ...e2eRendererEnv(pickE2eRenderer()),
    };

    const terminal = new Terminal({
      cols,
      rows,
      scrollback: 1000,
      allowProposedApi: true,
    });

    const target = options?.command ?? {
      bin: resolveE2eCliCommand(pickE2eRenderer()),
      args: [join(__dirname, '..', '..', 'dist/cli.js'), ...args],
    };
    const ptyProcess = pty.spawn(target.bin, target.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: env as Record<string, string>,
    });

    const session = new InteractiveSession(ptyProcess, terminal);
    // A child that dies during startup fails fast with its exit code instead
    // of waiting the budget out; only a live-but-slow boot (#13552) pays the
    // full readyPromptBudgetMs window. The tail reuses waitFor's spelling so
    // both failure paths grep the same in a job log — the catch below closes
    // the session, which disposes the terminal and would otherwise discard
    // the boot log unread.
    let startupUndecided = true;
    const exited = new Promise<never>((_, reject) => {
      ptyProcess.onExit(({ exitCode, signal }) => {
        // close()'s kill() fires this handler on every healthy session's
        // teardown; the strip pass over an unbounded transcript and the
        // rejection a settled race never observes are waste once startup is
        // decided.
        if (!startupUndecided) return;
        // Worded neutrally: whether the prompt reached rawOutput is not
        // decidable here — a child that out-writes the parent's read loop
        // loses every byte past the first 4095-byte chunk — so the tail is
        // best-effort, not necessarily the fatal lines.
        reject(
          new Error(
            `CLI exited during startup (code ${exitCode}, signal ${signal})\n` +
              `Last 500 chars: ${stripAnsi(session.rawOutput).slice(-500)}`,
          ),
        );
      });
    });
    try {
      await Promise.race([
        session.waitFor('Type your message', readyPromptBudgetMs(process.env)),
        exited,
      ]);
      startupUndecided = false;
    } catch (err) {
      startupUndecided = false;
      // start() must not orphan the child, pty, and terminal it refuses to
      // hand out.
      try {
        await session.close();
      } catch {
        // Cleanup must not mask the startup failure.
      }
      throw err;
    }
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

  /** Send a terminal key sequence without typing text or pressing Enter. */
  pressKey(sequence: string): void {
    this.ptyProcess.write(sequence);
  }

  /** Wait for text to appear in raw output. */
  async waitFor(text: string, timeout = 120_000): Promise<void> {
    const start = Date.now();
    while (!this.closed && Date.now() - start < timeout) {
      if (
        stripAnsi(this.rawOutput).toLowerCase().includes(text.toLowerCase())
      ) {
        return;
      }
      await sleep(200);
    }
    if (this.closed) {
      throw new Error(`Session closed while waiting for text: "${text}"`);
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
    // Set the flag first so a waitFor poll abandoned by start()'s fail-fast
    // race stops at its next tick instead of re-scanning a dead pty's output
    // until its own budget expires.
    this.closed = true;
    try {
      this.ptyProcess.kill();
    } catch {
      // Process may have already exited
    }
    this.terminal.dispose();
  }
}

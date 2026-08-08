/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 *
 * Phase 0 feature-case skeleton for the four OpenTUI migration painpoints
 * (tracking QwenLM/qwen-code#8662):
 *
 *   (a) flicker / duplicate rendering  — hard requirement
 *   (b) virtual scrolling              — sticky-bottom + wheel scrollback
 *   (c) click to expand                — SGR click on a tool card
 *   (d) selection + copy               — SGR drag then copy
 *
 * Runs with `bun test` inside tui-poc-lab, using tui-poc-lab/node_modules;
 * no dependencies beyond node built-ins are imported.
 *
 * PTY strategy: node-pty is not a dependency, so the harness allocates a
 * real PTY via the POSIX `script` utility (`script -q /dev/null bun
 * src/main.tsx` on macOS / BSD; Linux's util-linux `script` wants
 * `script -q -c 'bun src/main.tsx' /dev/null`). stdin writes reach the app
 * through the PTY, stdout carries the raw ANSI stream we assert on.
 *
 * Degradation note (per Phase 0 plan): the POC app (`src/main.tsx` and its
 * `stream-script.ts` fixture) does not exist in this worktree yet, so the
 * PTY cases skip until it lands — they then become real PTY assertions with
 * no edits beyond coordinate/marker tuning. The harness self-checks below
 * are renderer-level assertions that run today, so this file is green
 * before the POC arrives. Once PTY runs prove unreliable on a platform,
 * degrade (b)/(c)/(d) to renderer-behaviour assertions the same way and
 * mark each degraded case with a comment.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pocRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pocEntry = resolve(pocRoot, 'src', 'main.tsx');

const STREAM_TIMEOUT_MS = 6000;
const QUIET_AFTER_FIRST_OUTPUT_MS = 1500;

const ESC = '\u001b';

const eraseLineRe = /\u001b\[2K/g;
const syncOutputOnRe = /\u001b\[\?2026h/g;
const osc52ClipboardRe = /\u001b\]52;c;/g;

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function sgrPress(col: number, row: number): string {
  return `${ESC}[<0;${col};${row}M`;
}

function sgrMotion(col: number, row: number): string {
  return `${ESC}[<32;${col};${row}M`;
}

function sgrRelease(col: number, row: number): string {
  return `${ESC}[<0;${col};${row}m`;
}

function sgrWheelUp(col: number, row: number): string {
  return `${ESC}[<64;${col};${row}M`;
}

function sgrWheelDown(col: number, row: number): string {
  return `${ESC}[<65;${col};${row}M`;
}

function bunAvailable(): boolean {
  try {
    return spawnSync('bun', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

// PTY cases skip while the POC app is absent; see the degradation note in
// the file header.
const canRunPty = existsSync(pocEntry) && bunAvailable();

interface PtySessionOptions {
  inputs?: Array<{ data: string; delayMs: number }>;
}

interface PtySession {
  output: string;
  timedOut: boolean;
}

/**
 * Run `bun src/main.tsx` on a PTY, optionally writing mouse/input escape
 * sequences mid-stream, and collect the raw ANSI output until the stream
 * goes quiet or the deadline passes.
 */
async function runPtySession(
  options: PtySessionOptions = {},
): Promise<PtySession> {
  const child = spawn('script', ['-q', '/dev/null', 'bun', pocEntry], {
    cwd: pocRoot,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      LINES: '40',
      COLUMNS: '120',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });

  for (const input of options.inputs ?? []) {
    await new Promise((r) => setTimeout(r, input.delayMs));
    child.stdin.write(input.data);
  }

  const timedOut = await new Promise<boolean>((resolvePromise) => {
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    const onData = () => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        cleanup();
        resolvePromise(false);
      }, QUIET_AFTER_FIRST_OUTPUT_MS);
    };
    const deadline = setTimeout(() => {
      cleanup();
      resolvePromise(true);
    }, STREAM_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(deadline);
      if (quietTimer) clearTimeout(quietTimer);
      child.stdout.off('data', onData);
      try {
        child.kill();
      } catch {
        // already exited
      }
    };
    child.stdout.on('data', onData);
  });

  return { output, timedOut };
}

interface PainpointMatcher {
  toBe(expected: unknown): void;
  toBeGreaterThan(expected: number): void;
  toContain(expected: string): void;
}
declare const describe: (name: string, body: () => void) => void;
declare const it: {
  (name: string, body: () => void | Promise<void>): void;
  skipIf(
    condition: boolean,
  ): (name: string, body: () => void | Promise<void>) => void;
};
declare const expect: (value: unknown) => PainpointMatcher;

describe('painpoint harness self-checks (renderer-level, run today)', () => {
  it('counts flicker-related ANSI sequences correctly', () => {
    const sample = `${ESC}[2K${ESC}[?2026h${ESC}[?2026l${ESC}[2K`;
    expect(countMatches(sample, eraseLineRe)).toBe(2);
    expect(countMatches(sample, syncOutputOnRe)).toBe(1);
    expect(countMatches('plain output', eraseLineRe)).toBe(0);
  });

  it('encodes SGR mouse events (mode 1006) as the POC expects', () => {
    expect(sgrPress(3, 5)).toBe(`${ESC}[<0;3;5M`);
    expect(sgrMotion(4, 5)).toBe(`${ESC}[<32;4;5M`);
    expect(sgrRelease(9, 5)).toBe(`${ESC}[<0;9;5m`);
    expect(sgrWheelUp(1, 1)).toBe(`${ESC}[<64;1;1M`);
    expect(sgrWheelDown(1, 1)).toBe(`${ESC}[<65;1;1M`);
  });
});

describe('painpoint feature cases (PTY-level, need the POC app)', () => {
  it.skipIf(!canRunPty)(
    '(a) flicker: never erases lines, batches via synchronized output',
    async () => {
      const session = await runPtySession();
      // Full-line erase is ink's redraw fingerprint; OpenTUI's diff renderer
      // must not emit it at all, and must batch frames inside DEC private
      // mode 2026 so the terminal never paints a partial frame.
      expect(countMatches(session.output, eraseLineRe)).toBe(0);
      expect(countMatches(session.output, syncOutputOnRe)).toBeGreaterThan(0);
    },
  );

  it.skipIf(!canRunPty)(
    '(b) virtual scrolling: sticky bottom, wheel scrolls back',
    async () => {
      const session = await runPtySession({
        inputs: [
          // Let the stream pin the viewport to the bottom, then wheel up
          // into scrollback and back down to re-arm sticky-bottom.
          { data: sgrWheelUp(60, 10), delayMs: 2500 },
          { data: sgrWheelUp(60, 10), delayMs: 200 },
          { data: sgrWheelDown(60, 10), delayMs: 300 },
        ],
      });
      // The automated signal is weaker than a human eyeball here: we assert
      // the scripted scenario ran to completion after the wheel inputs
      // (status bar flips to `ready · … wheel to scroll` only after `done`)
      // and that synchronized-output frames kept flowing. Visual sticky
      // scrollback remains a manual check (see tui-poc-lab/README.md).
      expect(session.timedOut).toBe(false);
      expect(session.output).toContain('wheel to scroll');
      expect(countMatches(session.output, syncOutputOnRe)).toBeGreaterThan(0);
    },
  );

  it.skipIf(!canRunPty)(
    '(c) click-to-expand: SGR click on a tool card reveals its output',
    async () => {
      const session = await runPtySession({
        inputs: [
          // Coordinates target the first tool card row once the stream has
          // produced it; tune to the POC layout if the card moves.
          { data: sgrPress(4, 12) + sgrRelease(4, 12), delayMs: 2500 },
        ],
      });
      // `thoughtExpanded` only exists in the tool's *output* content
      // (stream-script.ts TOOL_READ_OUTPUT), so it can only appear once the
      // click expanded the card.
      expect(session.output).toContain('thoughtExpanded');
    },
  );

  it.skipIf(!canRunPty)(
    '(d) selection + copy: SGR drag selects and triggers a copy',
    async () => {
      const session = await runPtySession({
        inputs: [
          {
            data:
              sgrPress(5, 8) +
              sgrMotion(15, 8) +
              sgrMotion(25, 8) +
              sgrRelease(25, 8),
            delayMs: 2500,
          },
        ],
      });
      // copyText() writes OSC 52 (skipped only under Warp) and toasts
      // `✓ Copied N chars to clipboard`; either marker proves the copy path.
      const copied =
        countMatches(session.output, osc52ClipboardRe) > 0 ||
        session.output.includes('Copied ');
      expect(copied).toBe(true);
    },
  );
});

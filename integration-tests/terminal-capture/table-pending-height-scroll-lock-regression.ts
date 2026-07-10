#!/usr/bin/env npx tsx
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Deterministic TUI ratchet for the streaming-table pending-height fix.
 *
 * Streams ten horizontal 7-column tables whose cells hold ~200 chars of
 * wrapping text (the user's repro) into the real TUI at a fixed terminal size,
 * progressively, via a chunked OpenAI-compatible fake server. On a wide
 * terminal these wrap tall, so TableRenderer falls back to the vertical
 * layout. Without the pending-height estimator fix the live frame is
 * under-charged, overflows the viewport, and Ink repaints from scratch by
 * emitting a full-screen clear (`\x1b[2J\x1b[3J\x1b[H`). Each such clear
 * resets the terminal's scroll position — so a user who scrolled up to read
 * gets yanked back to the top ("跳頂"). With the fix the estimator charges the
 * table's real (wrapped / vertical) height, the frame stays inside the
 * viewport budget, and the app updates in place instead of clearing.
 *
 * This script counts the full-screen clears the app writes to the PTY while
 * the tables stream — the same escape-sequence-ratchet methodology as
 * `subagent-flicker-regression.ts` and `table-inline-code-wrap-regression.ts`.
 *
 * Reference numbers (100×28 terminal, 10 tables, ~200-char cells):
 *
 *   With the pending-height fix (current branch):
 *     clearTerminalTriples=0, clear2J=0, eraseLine≈3270, ptyBytes≈0.32 MB
 *   Without it (estimator under-charges the wrapped/vertical height):
 *     clearTerminalTriples≈300 (≈172 mid-stream), eraseLine≈315, ptyBytes≈4.8 MB
 *
 * The signal is `clearTerminalTriples`: it collapses from ~300 to 0 with the
 * fix. The default threshold (20) sits far below the no-fix count so a full
 * regression trips the ratchet, and far above 0 so incidental start-up/exit
 * clears never flake it.
 *
 * Usage:
 *   npm run build && npm run bundle
 *   cd integration-tests/terminal-capture
 *   npx tsx table-pending-height-scroll-lock-regression.ts
 *
 * Env:
 *   QWEN_TUI_E2E_MAX_FULL_CLEARS   pass threshold on clearTerminalTriples (default 20)
 *   QWEN_TUI_E2E_EXPECT_PASS       set to "false" to assert the ratchet FAILS
 *                                  (use when running against pre-fix code)
 *   QWEN_TUI_E2E_OUT               output dir (default under os.tmpdir())
 *   QWEN_TUI_E2E_REPO              repo root whose dist/cli.js is launched
 */
import { createServer, type AddressInfo } from 'node:http';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TerminalCapture } from './terminal-capture.js';

const TERMINAL_COLS = 100;
const TERMINAL_ROWS = 28;
const NUM_TABLES = 10;
const DONE_MARKER = 'ALL_TABLES_DONE';
const MID_STREAM_MARKER = 'Table 5';
const PROMPT_TEXT = 'Print ten wide tables with long wrapping cells.';

const WORDS =
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure reprehenderit voluptate velit esse cillum'.split(
    ' ',
  );

/** A deterministic ~200-char cell that wraps across several lines. */
function longCell(seed: number): string {
  let s = '';
  let i = seed;
  while (s.length < 190) {
    s += (s ? ' ' : '') + WORDS[i % WORDS.length];
    i += 1;
  }
  return s;
}

function buildMarkdown(): string {
  const lines: string[] = ['Here are the requested tables:', ''];
  for (let t = 1; t <= NUM_TABLES; t++) {
    lines.push(`### Table ${t}`, '');
    lines.push('| C1 | C2 | C3 | C4 | C5 | C6 | C7 |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (let r = 0; r < 2; r++) {
      const cells: string[] = [];
      for (let c = 0; c < 7; c++) cells.push(longCell(t * 100 + r * 7 + c));
      lines.push(`| ${cells.join(' | ')} |`);
    }
    lines.push('');
  }
  lines.push(DONE_MARKER);
  return lines.join('\n');
}

/** Minimal OpenAI-compatible server that streams `content` in small delayed
 *  chunks, so the TUI grows its pending frame progressively (like a live
 *  model) rather than receiving the whole reply in one delta. */
function startChunkedServer(content: string): Promise<{
  baseUrl: string;
  requestCount: () => number;
  close: () => void;
}> {
  let requests = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    await new Promise<void>((r) => {
      req.on('data', () => {});
      req.on('end', () => r());
    });
    const index = requests++;
    res.writeHead(200, {
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'content-type': 'text/event-stream',
    });
    const id = `chatcmpl-${index}`;
    const send = (delta: object, finish: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'dummy',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`,
      );
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    send({ role: 'assistant' });
    // Only the first turn streams the tables; any later turn ends fast.
    const body = index === 0 ? content : 'OK.';
    const PIECE = 55;
    for (let i = 0; i < body.length; i += PIECE) {
      send({ content: body.slice(i, i + PIECE) });
      if (index === 0) await sleep(18);
    }
    send({}, 'stop');
    res.write('data: [DONE]\n\n');
    res.end();
  });

  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolveServer({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        requestCount: () => requests,
        close: () => server.close(),
      });
    });
  });
}

function countAll(hay: string, needle: string): number {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

function envNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function qwenArgs(baseUrl: string): string[] {
  return [
    'dist/cli.js',
    '--no-chat-recording',
    '--approval-mode',
    'yolo',
    '--auth-type',
    'openai',
    '--openai-api-key',
    'dummy',
    '--openai-base-url',
    baseUrl,
    '--model',
    'dummy',
  ];
}

async function main(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(
    process.env['QWEN_TUI_E2E_REPO'] ?? resolve(scriptDir, '../..'),
  );
  const outputDir = resolve(
    process.env['QWEN_TUI_E2E_OUT'] ??
      join(tmpdir(), 'qwen-table-scroll-lock', basename(repoRoot)),
  );
  const maxFullClears = envNumber('QWEN_TUI_E2E_MAX_FULL_CLEARS', 20);
  const expectedPass = process.env['QWEN_TUI_E2E_EXPECT_PASS'] !== 'false';

  if (existsSync(outputDir)) rmSync(outputDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  const server = await startChunkedServer(buildMarkdown());
  const homeDir = join(outputDir, 'home');
  mkdirSync(homeDir, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FORCE_COLOR: '1',
    HOME: homeDir,
    USERPROFILE: homeDir,
    NODE_NO_WARNINGS: '1',
    QWEN_CODE_DISABLE_SYNCHRONIZED_OUTPUT: '1',
    QWEN_CODE_NO_RELAUNCH: '1',
    QWEN_SANDBOX: 'false',
    TERM: 'xterm-256color',
  };
  delete env['NO_COLOR'];
  delete env['QWEN_CODE_SIMPLE'];
  for (const key of [
    'HTTP_PROXY',
    'http_proxy',
    'HTTPS_PROXY',
    'https_proxy',
    'ALL_PROXY',
    'all_proxy',
  ]) {
    delete env[key];
  }

  const terminal = await TerminalCapture.create({
    chrome: false,
    cols: TERMINAL_COLS,
    rows: TERMINAL_ROWS,
    cwd: repoRoot,
    env,
    fontSize: 14,
    outputDir,
    theme: 'github-dark',
    title: 'table pending-height scroll lock regression',
  });

  try {
    await terminal.spawn('node', qwenArgs(server.baseUrl));
    // The TUI's input hint is localized; match on a stable ASCII marker of the
    // ready prompt instead. The '❯' prompt glyph shows once input is ready.
    await terminal.waitFor('YOLO', { timeout: 30000 });
    await terminal.type(PROMPT_TEXT, { delay: 8, slow: true });
    await terminal.idle(300, 4000);
    await terminal.type('\n');

    // Sample the clear count mid-stream (while tables are still arriving — the
    // window where a scrolled-up viewport gets yanked).
    await terminal.waitFor(MID_STREAM_MARKER, { timeout: 30000 });
    const midStreamClears = countAll(terminal.getRawOutput(), '\x1b[2J');

    await terminal.waitForAndIdle(DONE_MARKER, {
      stableMs: 1500,
      timeout: 45000,
    });

    const raw = terminal.getRawOutput();
    const clearTerminalTriples = countAll(raw, '\x1b[2J\x1b[3J\x1b[H');
    const pass = clearTerminalTriples <= maxFullClears;

    const summary = {
      repoRoot,
      outputDir,
      cols: TERMINAL_COLS,
      rows: TERMINAL_ROWS,
      requestCount: server.requestCount(),
      ptyBytes: raw.length,
      clearTerminalTriples,
      clear2J: countAll(raw, '\x1b[2J'),
      midStreamClear2J: midStreamClears,
      eraseLine: countAll(raw, '\x1b[2K'),
      maxFullClears,
      pass,
      expectedPass,
    };
    writeFileSync(join(outputDir, 'raw.ansi.log'), raw);
    writeFileSync(
      join(outputDir, 'summary.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    console.log(JSON.stringify(summary, null, 2));

    if (pass !== expectedPass) {
      throw new Error(
        `Expected pass=${expectedPass} but observed pass=${pass} ` +
          `(clearTerminalTriples=${clearTerminalTriples}, threshold=${maxFullClears}). ` +
          `See ${join(outputDir, 'summary.json')}`,
      );
    }
  } finally {
    await terminal.close();
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

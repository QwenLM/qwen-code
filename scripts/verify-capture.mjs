#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Render a command's terminal output to a PNG, for `/verify` evidence images.
 *
 * Why this exists: the `verify-pr` skill asked the agent to build its own
 * node-pty -> xterm.js -> Playwright pipeline. Neither `node-pty` nor the
 * `playwright` package is a dependency of this repo, and node-pty needs a
 * native build — so the documented route did not exist, and three rounds of
 * rewording the instruction produced zero images across four live runs. This
 * turns a capture into one command using deps that are already installed.
 *
 * Pipeline: run the command, feed its bytes to @xterm/headless (which parses
 * ANSI into a cell grid with colour and bold attributes), emit that grid as
 * SVG, and let sharp rasterise it. No browser, no pseudo-terminal.
 *
 * Usage:
 *   node scripts/verify-capture.mjs --out evidence/01-ab.png -- npm test -w pkg
 *   some-harness | node scripts/verify-capture.mjs --out evidence/02-matrix.png
 *
 * Options:
 *   --out <path>     required; parent dirs are created
 *   --cols <n>       terminal width  (default 100)
 *   --rows <n>       max rows kept   (default 40, trailing blanks trimmed)
 *   --title <text>   caption drawn above the output
 *
 * Exit codes: 0 on a written PNG, 1 on usage or render failure. The captured
 * command's own exit code is reported on stderr but does NOT fail the capture —
 * a failing command is usually exactly what is being captured.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);

// xterm's headless build is CommonJS; a named ESM import of `Terminal` throws.
const { Terminal } = require('@xterm/headless');
const sharp = require('sharp');

// The 16 ANSI colours as xterm reports them from getFgColor()/getBgColor().
const ANSI = [
  '#1e1e1e',
  '#cd3131',
  '#0dbc79',
  '#e5e510',
  '#2472c8',
  '#bc3fbc',
  '#11a8cd',
  '#e5e5e5',
  '#666666',
  '#f14c4c',
  '#23d18b',
  '#f5f543',
  '#3b8eea',
  '#d670d6',
  '#29b8db',
  '#ffffff',
];
const FG_DEFAULT = '#d4d4d4';
const BG = '#1e1e1e';
const CELL_W = 8.4;
const CELL_H = 18;
const PAD = 12;
const FONT_SIZE = 14;

function usage(message) {
  process.stderr.write(`verify-capture: ${message}\n`);
  process.stderr.write(
    'usage: verify-capture.mjs --out <png> [--cols n] [--rows n] [--title s] [-- cmd ...]\n',
  );
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { cols: 100, rows: 40, out: '', title: '' };
  const cmd = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      cmd.push(...argv.slice(i + 1));
      break;
    }
    const next = () => {
      i += 1;
      if (i >= argv.length) usage(`${arg} needs a value`);
      return argv[i];
    };
    switch (arg) {
      case '--out':
        opts.out = next();
        break;
      case '--cols':
        opts.cols = Number(next());
        break;
      case '--rows':
        opts.rows = Number(next());
        break;
      case '--title':
        opts.title = next();
        break;
      default:
        usage(`unknown option ${arg}`);
    }
  }
  if (!opts.out) usage('--out is required');
  // Guard the geometry: a NaN or absurd value would otherwise reach sharp as a
  // broken SVG and fail with something unrelated to the real mistake.
  for (const key of ['cols', 'rows']) {
    if (!Number.isInteger(opts[key]) || opts[key] < 1 || opts[key] > 500) {
      usage(`--${key} must be an integer between 1 and 500`);
    }
  }
  return { opts, cmd };
}

const escapeXml = (s) =>
  s.replace(
    /[<>&"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c],
  );

/** Collect the bytes to render: either a child command's output, or stdin. */
function collectOutput(cmd) {
  if (cmd.length === 0) {
    try {
      return readFileSync(0, 'utf8');
    } catch {
      usage('no command given and stdin is empty');
    }
  }
  const res = spawnSync(cmd[0], cmd.slice(1), {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    // Ask for colour without a pty: most tools honour one of these, and a
    // purpose-built harness emits ANSI unconditionally anyway.
    env: { ...process.env, FORCE_COLOR: '1', CLICOLOR_FORCE: '1' },
  });
  if (res.error) {
    process.stderr.write(`verify-capture: ${res.error.message}\n`);
    process.exit(1);
  }
  // A non-zero exit is not a capture failure — capturing a failing base arm is
  // the normal case for an A/B cell.
  process.stderr.write(`verify-capture: command exited ${res.status}\n`);
  return `${res.stdout ?? ''}${res.stderr ?? ''}`;
}

/** Parse ANSI into a cell grid, then emit it as SVG. */
async function render(raw, opts) {
  const term = new Terminal({
    cols: opts.cols,
    rows: opts.rows,
    scrollback: 0,
    allowProposedApi: true,
  });
  // xterm needs CRLF; a bare LF leaves the cursor in the old column and every
  // line after the first renders indented by the previous line's length.
  term.write(raw.replace(/\r?\n/g, '\r\n'));
  // write() is asynchronous internally; without a turn of the loop the buffer
  // is still empty and the capture silently comes out blank.
  await new Promise((r) => setTimeout(r, 120));

  const buf = term.buffer.active;
  const rows = [];
  for (let y = 0; y < opts.rows; y += 1) {
    const line = buf.getLine(y);
    if (!line) break;
    const cells = [];
    for (let x = 0; x < opts.cols; x += 1) {
      const cell = line.getCell(x);
      const chars = cell?.getChars();
      if (!chars) continue;
      cells.push({
        x,
        chars,
        fg: cell.getFgColor(),
        bold: cell.isBold() !== 0,
        blank: chars === ' ',
      });
    }
    rows.push(cells);
  }
  // Trim trailing blank rows so a 40-row default does not pad every capture
  // with empty space.
  while (rows.length > 0 && rows.at(-1).every((c) => c.blank)) rows.pop();
  if (rows.length === 0) {
    process.stderr.write('verify-capture: nothing to render (empty output)\n');
    process.exit(1);
  }

  const titleRows = opts.title ? 1 : 0;
  const width = Math.round(PAD * 2 + opts.cols * CELL_W);
  const height = PAD * 2 + (rows.length + titleRows) * CELL_H;
  let body = '';
  if (opts.title) {
    body +=
      `<text x="${PAD}" y="${PAD + CELL_H - 5}" fill="#9cdcfe" ` +
      `font-weight="bold">${escapeXml(opts.title)}</text>`;
  }
  rows.forEach((cells, y) => {
    const baseline = PAD + (y + titleRows + 1) * CELL_H - 5;
    for (const cell of cells) {
      if (cell.blank) continue;
      const colour =
        cell.fg >= 0 && cell.fg < ANSI.length ? ANSI[cell.fg] : FG_DEFAULT;
      body +=
        `<text x="${(PAD + cell.x * CELL_W).toFixed(1)}" y="${baseline}" ` +
        `fill="${colour}"${cell.bold ? ' font-weight="bold"' : ''}>` +
        `${escapeXml(cell.chars)}</text>`;
    }
  });

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="${BG}"/>` +
    `<g font-family="DejaVu Sans Mono,Menlo,Consolas,monospace" ` +
    `font-size="${FONT_SIZE}" xml:space="preserve">${body}</g></svg>`;

  const out = resolve(opts.out);
  mkdirSync(dirname(out), { recursive: true });
  const info = await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9 })
    .toFile(out);
  process.stdout.write(
    `${out} ${info.width}x${info.height} ${info.size}B ${rows.length} rows\n`,
  );
}

const { opts, cmd } = parseArgs(process.argv.slice(2));
try {
  await render(collectOutput(cmd), opts);
} catch (error) {
  process.stderr.write(`verify-capture: ${error?.message ?? error}\n`);
  process.exit(1);
}

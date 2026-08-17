#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Render a command's terminal output to a PNG, for `/verify` evidence images.
 *
 * Why this exists: the `verify-pr` skill asked the agent to assemble its own
 * node-pty -> xterm.js -> Playwright pipeline. Those dependencies do resolve
 * from this repo (node-pty is a root optionalDependency shipping prebuilt
 * binaries; playwright is declared in packages/webui and
 * integration-tests/terminal-capture), but the route needs a browser, is slow,
 * and — the real fragility — integration-tests/terminal-capture is not a root
 * workspace, so its package.json is never installed as a unit and resolves only
 * because every dependency happens to be hoisted. Four live runs still produced
 * zero images. This makes a capture one fast command on deps already installed:
 * no browser, no pseudo-terminal.
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
    if (process.stdin.isTTY)
      usage('no command given and nothing piped to stdin');
    try {
      return readFileSync(0, 'utf8');
    } catch {
      usage('no command given and stdin is empty');
    }
  }
  const env = { ...process.env };
  delete env.NO_COLOR;
  const res = spawnSync(cmd[0], cmd.slice(1), {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    // Ask for colour without a pty: most tools honour one of these, and a
    // purpose-built harness emits ANSI unconditionally anyway.
    env: { ...env, FORCE_COLOR: '1', CLICOLOR_FORCE: '1' },
  });
  if (res.error) {
    process.stderr.write(`verify-capture: ${res.error.message}\n`);
    process.exit(1);
  }
  // A non-zero exit is not a capture failure — capturing a failing base arm is
  // the normal case for an A/B cell. A signal-killed child has status === null,
  // so name the signal rather than printing "exited null".
  const how =
    res.signal != null ? `killed by ${res.signal}` : `exited ${res.status}`;
  process.stderr.write(`verify-capture: command ${how}\n`);
  // Only insert a separator when stdout lacks a trailing newline; a
  // console.log-terminated stdout already ends with \n, and join('\n') would
  // add a phantom blank row that never appeared on the real terminal.
  return res.stdout && res.stderr && !res.stdout.endsWith('\n')
    ? res.stdout + '\n' + res.stderr
    : res.stdout + res.stderr;
}

/** Parse ANSI into a cell grid, then emit it as SVG. */
async function render(raw, opts) {
  const term = new Terminal({
    cols: opts.cols,
    rows: opts.rows,
    scrollback: 0,
    allowProposedApi: true,
  });
  // U+FE0F (emoji variation selector) makes Pango abort() in native code when
  // no colour-emoji font exists — uncatchable here — so strip it; the base
  // codepoint still renders. CRLF is required or a bare LF leaves the cursor in
  // the old column and indents every later line. Await xterm's write callback
  // (fires once the parser has drained the input) rather than a fixed sleep, so
  // a large capture is not read mid-parse and silently come out blank.
  await new Promise((r) =>
    term.write(raw.replace(/\uFE0F/g, '').replace(/\r?\n/g, '\r\n'), r),
  );

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
      const mapped =
        cell.fg >= 0 && cell.fg < ANSI.length ? ANSI[cell.fg] : FG_DEFAULT;
      // SGR 30 maps to #1e1e1e — identical to the canvas BG — so black-foreground
      // text (the normal way to label a coloured badge, e.g. vitest's project
      // badge) would vanish as black-on-black; lift it to the default grey.
      const colour = mapped === BG ? FG_DEFAULT : mapped;
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
  // scrollback: 0 keeps only the last --rows rows, so a taller input loses its
  // top — often the header — with no visible sign; say so rather than shipping
  // an image that looks complete but starts halfway down. Count wrapped rows
  // (a line wider than --cols occupies ceil(len / cols) terminal rows) so the
  // warning also fires when wrapping, not just newlines, pushes past --rows.
  const ESC = String.fromCharCode(27);
  const stripAnsi = (s) =>
    s.replace(new RegExp(`${ESC}\\[[0-9;]*[a-zA-Z]`, 'g'), '');
  const wrappedRows = raw
    .replace(/\r?\n$/, '')
    .split(/\r?\n/)
    .reduce(
      (sum, line) =>
        sum + Math.max(1, Math.ceil(stripAnsi(line).length / opts.cols)),
      0,
    );
  // Newline-terminated output needs one row BEYOND its last line: the final
  // CRLF advances the cursor off the viewport and scrolls one row away, so with
  // scrollback: 0 the usable capacity is rows - 1, not rows. Comparing against
  // opts.rows instead let input of exactly --rows lines lose its top silently —
  // the very case this warning exists for.
  const capacity = /\r?\n$/.test(raw) ? opts.rows - 1 : opts.rows;
  if (wrappedRows > capacity) {
    process.stderr.write(
      `verify-capture: warning: input occupies ${wrappedRows} terminal rows; ` +
        `--rows ${opts.rows} kept the last ${capacity} and dropped the top ` +
        `${wrappedRows - capacity}\n`,
    );
  }
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

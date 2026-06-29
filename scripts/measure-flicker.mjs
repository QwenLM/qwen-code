#!/usr/bin/env node
/**
 * Quick-and-dirty TUI flicker quantifier.
 *
 * Counts the ANSI escape sequences that betray flicker — clearing the screen,
 * erasing lines, or jumping the cursor up to redraw — inside a recorded raw
 * terminal stream. Useful for "before/after" sanity checks when refactoring
 * TUI components.
 *
 * Recording phase (do this yourself; this script doesn't drive interactive
 * TUIs — it just analyses what you recorded):
 *
 *   # macOS / BSD `script`:
 *   script -q /tmp/qwen.before.raw node dist/cli.js --yolo
 *   # …drive a SubAgent scenario, then exit qwen with /quit or Ctrl-D
 *
 *   # Linux / util-linux `script`:
 *   script -q -c 'node dist/cli.js --yolo' /tmp/qwen.before.raw
 *
 *   # tmux variant: a tmux session preserves whatever you do live; pipe-pane
 *   # gives you the same raw bytes.
 *   tmux new -s flicker -d 'node dist/cli.js --yolo'
 *   tmux pipe-pane -t flicker -o 'cat > /tmp/qwen.before.raw'
 *   tmux attach -t flicker
 *
 * Then:
 *
 *   node scripts/measure-flicker.mjs /tmp/qwen.before.raw
 *   node scripts/measure-flicker.mjs /tmp/qwen.after.raw /tmp/qwen.before.raw
 *
 * The second form prints both, and the delta — lower clearTerminalPair on
 * "current" vs "baseline" is the win condition for a flicker fix.
 */

import { readFileSync, statSync } from 'node:fs';
import { argv, exit, stdout } from 'node:process';

if (argv.length < 3 || argv.length > 4) {
  stdout.write(
    'usage: node scripts/measure-flicker.mjs <raw-stream> [baseline-raw-stream]\n',
  );
  exit(64);
}

/* eslint-disable no-control-regex -- ANSI escape patterns deliberately match ESC */
const PATTERNS = [
  {
    name: 'clearTerminalPair',
    description: 'ESC [ 2 J  ESC [ 3 J  ESC [ H  (Ink full-screen redraw)',
    regex: /\x1b\[2J\x1b\[3J\x1b\[H/g,
  },
  {
    name: 'clearScreen',
    description: 'ESC [ 2 J  |  ESC [ 3 J  |  ESC c  (any clear-screen op)',
    regex: /\x1b\[2J|\x1b\[3J|\x1bc/g,
  },
  {
    name: 'eraseLine',
    description: 'ESC [ 0|1|2 K  (erase part/all of current line)',
    regex: /\x1b\[[0-2]?K/g,
  },
  {
    name: 'cursorUp',
    description: 'ESC [ N A  (cursor up — Ink uses this for in-place redraw)',
    regex: /\x1b\[\d+A/g,
  },
];
/* eslint-enable no-control-regex */

function readBytes(path) {
  try {
    statSync(path);
  } catch {
    stdout.write(`error: ${path} not found\n`);
    exit(66);
  }
  // Read as binary so a NUL doesn't truncate the buffer; toString('binary')
  // preserves byte values 0x00..0xFF as code points 0x00..0xFF, which is
  // exactly what our regex patterns expect (they match \x1b literally).
  return readFileSync(path).toString('binary');
}

function summarize(label, path) {
  const raw = readBytes(path);
  const counts = Object.fromEntries(
    PATTERNS.map((p) => [p.name, raw.match(p.regex)?.length ?? 0]),
  );
  return {
    label,
    path,
    bytes: raw.length,
    counts,
  };
}

function render(summary) {
  const { label, path, bytes, counts } = summary;
  stdout.write(`── ${label}\n`);
  stdout.write(`    file:  ${path}\n`);
  stdout.write(`    bytes: ${bytes}\n`);
  for (const p of PATTERNS) {
    stdout.write(`    ${p.name.padEnd(18)} ${counts[p.name]}\n`);
  }
}

function renderDelta(current, baseline) {
  stdout.write('\n── delta (current − baseline)\n');
  for (const p of PATTERNS) {
    const c = current.counts[p.name];
    const b = baseline.counts[p.name];
    const d = c - b;
    const arrow = d < 0 ? '↓' : d > 0 ? '↑' : '·';
    stdout.write(`    ${p.name.padEnd(18)} ${d > 0 ? '+' : ''}${d}  ${arrow}\n`);
  }
  stdout.write(
    '\ntip: lower clearTerminalPair (and lower clearScreen) on "current" wins.\n',
  );
}

if (process.env.QWEN_FLICKER_VERBOSE) {
  stdout.write('patterns:\n');
  for (const p of PATTERNS) {
    stdout.write(`  ${p.name.padEnd(18)} = ${p.description}\n`);
  }
  stdout.write('\n');
}

const current = summarize('current', argv[2]);
render(current);

if (argv[3]) {
  stdout.write('\n');
  const baseline = summarize('baseline', argv[3]);
  render(baseline);
  renderDelta(current, baseline);
}

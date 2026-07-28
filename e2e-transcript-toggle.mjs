// PR 7816 real-CLI E2E: drive the BUILT qwen TUI (dist/cli.js, ink patched by
// this PR) through the exact #6820 trigger: Ctrl+O opens the transcript, which
// unmounts <App/> (an ancestor of MainContent's <Static>); renders while open
// hit the window where the base code left rootNode.staticNode dangling.
// Oracle: process survives N toggle cycles with live renders in between; raw
// output contains no WASM RuntimeError.
import pty from '@lydell/node-pty';
import xterm from '@xterm/headless';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WT = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] ?? path.join(WT, 'e2e-out');
fs.mkdirSync(OUT, { recursive: true });

const COLS = 100;
const ROWS = 32;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// isolated HOME with onboarding bypass
const home = path.join(OUT, 'home');
fs.mkdirSync(path.join(home, '.qwen'), { recursive: true });
fs.mkdirSync(path.join(home, 'ws'), { recursive: true });
fs.writeFileSync(
  path.join(home, '.qwen', 'settings.json'),
  JSON.stringify(
    {
      ui: { theme: 'Qwen Dark', hideTips: true },
      security: { auth: { selectedType: 'openai' } },
      general: { enableAutoUpdate: false },
    },
    null,
    2,
  ),
);

const term = new xterm.Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
let raw = '';
const proc = pty.spawn('node', [path.join(WT, 'dist', 'cli.js'), '--no-chat-recording'], {
  name: 'xterm-256color',
  cols: COLS,
  rows: ROWS,
  cwd: path.join(home, 'ws'),
  env: {
    ...process.env,
    HOME: home,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    OPENAI_API_KEY: 'dummy-key',
    OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
    OPENAI_MODEL: 'dummy-model',
    QWEN_HOME: home,
  },
});
let exited = null;
proc.onExit((e) => {
  exited = e;
});
proc.onData((d) => {
  raw += d;
  term.write(d);
  // kitty keyboard handshake (memory recipe): reply so CSI-u detection settles
  if (d.includes('\x1b[?u')) {
    proc.write('\x1b[?0u\x1b[?62c');
  }
});

function screenText() {
  const buf = term.buffer.active;
  const lines = [];
  for (let y = 0; y < ROWS; y++) {
    const line = buf.getLine(buf.viewportY + y);
    lines.push(line ? line.translateToString(true) : '');
  }
  return lines.join('\n');
}

// serialize styled cells for later HTML rendering
function snapshotCells(name) {
  const buf = term.buffer.active;
  const grid = [];
  for (let y = 0; y < ROWS; y++) {
    const line = buf.getLine(buf.viewportY + y);
    const row = [];
    if (line) {
      for (let x = 0; x < COLS; x++) {
        const c = line.getCell(x);
        if (!c) continue;
        row.push({
          ch: c.getChars() || ' ',
          w: c.getWidth(),
          bold: !!c.isBold(),
          dim: !!c.isDim(),
          fg: c.isFgRGB()
            ? [(c.getFgColor() >> 16) & 255, (c.getFgColor() >> 8) & 255, c.getFgColor() & 255]
            : c.isFgPalette()
              ? { p: c.getFgColor() }
              : null,
          bg: c.isBgRGB()
            ? [(c.getBgColor() >> 16) & 255, (c.getBgColor() >> 8) & 255, c.getBgColor() & 255]
            : c.isBgPalette()
              ? { p: c.getBgColor() }
              : null,
        });
      }
    }
    grid.push(row);
  }
  fs.writeFileSync(path.join(OUT, `${name}.cells.json`), JSON.stringify(grid));
  fs.writeFileSync(path.join(OUT, `${name}.txt`), screenText());
}

async function waitFor(pred, what, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (exited) throw new Error(`process exited (${JSON.stringify(exited)}) while waiting for: ${what}`);
    if (pred(screenText())) return;
    await sleep(120);
  }
  fs.writeFileSync(path.join(OUT, 'timeout-screen.txt'), screenText());
  throw new Error(`timeout waiting for: ${what}`);
}

const report = { toggles: 0, stages: [] };
const stage = (s) => {
  report.stages.push(s);
  console.error(`[stage] ${s}`);
};

try {
  await waitFor((s) => /Type your message|@path\/to\/file/.test(s), 'main UI prompt');
  stage('boot: main UI rendered');
  await sleep(800);

  // populate <Static> history with a real command
  proc.write('/about');
  await sleep(500);
  proc.write('\r');
  await sleep(700);
  if (!/Session ID|Base URL/i.test(screenText())) {
    proc.write('\r'); // autocomplete ate the first Enter
  }
  await waitFor((s) => /Session ID|Base URL/i.test(s), '/about output in history');
  stage('/about output committed to <Static> history');
  snapshotCells('1-main-before');

  const transcriptOpen = (s) => /Transcript/.test(s) && !/Type your message/.test(s);
  const mainUi = (s) => /Type your message|@path\/to\/file/.test(s);

  for (let i = 1; i <= 5; i++) {
    proc.write('\x0f'); // Ctrl+O -> opens transcript, unmounts <App/> (ancestor of <Static>)
    await waitFor(transcriptOpen, `transcript open #${i}`);
    if (i === 1) snapshotCells('2-transcript-open');
    // force renders while <App/> is unmounted — the #6820 dangling window
    for (let k = 0; k < 6; k++) {
      proc.write('\x1b[B'); // arrow down (scroll)
      await sleep(80);
    }
    proc.write('\x0f'); // Ctrl+O -> close transcript, remount <App/>
    await waitFor(mainUi, `main UI back #${i}`);
    report.toggles = i;
    if (exited) throw new Error(`process died after toggle #${i}`);
    await sleep(200);
  }
  stage(`survived ${report.toggles} transcript open/close cycles with renders in the unmount window`);
  snapshotCells('3-main-after-toggles');

  report.alive = exited === null;
  report.wasmError = /memory access out of bounds|RuntimeError/.test(raw);
  report.pid = proc.pid;

  // clean quit
  proc.write('/quit');
  await sleep(400);
  proc.write('\r');
  await sleep(600);
  if (exited === null) proc.write('\r');
  await sleep(1500);
  if (exited === null) {
    proc.kill();
    report.exit = 'killed after clean-quit attempt (still alive = pass)';
  } else {
    report.exit = exited;
  }
  report.pass = report.alive && !report.wasmError;
} catch (e) {
  report.error = String(e);
  report.pass = false;
  try {
    proc.kill();
  } catch {}
}
fs.writeFileSync(path.join(OUT, 'raw-output.log'), raw);
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.pass ? 0 : 1);

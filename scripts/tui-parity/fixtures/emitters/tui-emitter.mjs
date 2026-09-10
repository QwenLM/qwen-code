#!/usr/bin/env node
// Deterministic fixture TUI for the parity harness.
// Same flags => identical bytes.
// Flags:
//   --frames N            frames to render (default 3)
//   --clears-per-frame N  ESC[2J full-screen clears before each frame
//   --scrollback-clears N ESC[3J clears emitted once at start (default 0)
//   --el-mode 0|1|2       ESC[K mode used while erasing lines (default 0)
//   --no-line-erases      skip ESC[K entirely
//   --dups N              duplicate event markers per frame (default 0)
//   --sync                wrap each frame in DEC 2026 begin/end
//   --exit-code N         process exit code (default 0)
//   --hang-ms N           sleep after the last frame before exit (default 0)
//   --tree-hang           spawn an idle grandchild and hang, to exercise
//                         process-tree kill on capture timeout
//   --stubborn-hang       spawn a grandchild that ignores SIGTERM and detaches
//                         stdio, print its pid, then hang; exercises kill
//                         escalation that must survive the main child closing
//   --rows N              override $LINES (default 24)
import { spawn } from 'node:child_process';
import process from 'node:process';

function parseArgs(argv) {
  const opts = {
    frames: 3,
    clearsPerFrame: 0,
    scrollbackClears: 0,
    elMode: 0,
    lineErases: true,
    dups: 0,
    sync: false,
    exitCode: 0,
    hangMs: 0,
    treeHang: false,
    stubbornHang: false,
    rows: null,
  };
  const value = (flag, index) => {
    const v = Number.parseInt(argv[index + 1], 10);
    if (Number.isNaN(v)) {
      console.error(`tui-emitter: missing numeric value for ${flag}`);
      process.exit(2);
    }
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case '--frames':
        opts.frames = value(flag, i);
        i += 1;
        break;
      case '--clears-per-frame':
        opts.clearsPerFrame = value(flag, i);
        i += 1;
        break;
      case '--scrollback-clears':
        opts.scrollbackClears = value(flag, i);
        i += 1;
        break;
      case '--el-mode':
        opts.elMode = value(flag, i);
        i += 1;
        break;
      case '--no-line-erases':
        opts.lineErases = false;
        break;
      case '--dups':
        opts.dups = value(flag, i);
        i += 1;
        break;
      case '--sync':
        opts.sync = true;
        break;
      case '--exit-code':
        opts.exitCode = value(flag, i);
        i += 1;
        break;
      case '--hang-ms':
        opts.hangMs = value(flag, i);
        i += 1;
        break;
      case '--tree-hang':
        opts.treeHang = true;
        break;
      case '--stubborn-hang':
        opts.stubbornHang = true;
        break;
      case '--rows':
        opts.rows = value(flag, i);
        i += 1;
        break;
      default:
        console.error(`tui-emitter: unknown flag ${flag}`);
        process.exit(2);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.stubbornHang) {
  // Ignores SIGTERM and detaches stdio, but stays in the capture's process
  // group, so only a SIGKILL that survives the main child closing can reap it.
  const stubborn = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    { stdio: 'ignore' },
  );
  process.stdout.write(`STUBBORN=${stubborn.pid}\n`);
  setTimeout(() => {}, 60000);
  process.exitCode = opts.exitCode;
} else if (opts.treeHang) {
  const grandchild = spawn(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 60000)'],
    { stdio: 'inherit' },
  );
  process.stdout.write(`GRANDCHILD=${grandchild.pid}\n`);
  setTimeout(() => {}, 60000);
  process.exitCode = opts.exitCode;
} else {
  main(opts);
}

function main(opts) {
  const rows =
    opts.rows ?? (Number.parseInt(process.env.LINES ?? '', 10) || 24);

  const out = (text) => process.stdout.write(text);
  const marker = (seq) => out(`\x1b]697;live-line;${seq}\x07`);

  for (let k = 0; k < opts.scrollbackClears; k += 1) out('\x1b[3J');

  const contentRows = Math.max(1, rows - 1);
  let seq = 0;
  for (let frame = 1; frame <= opts.frames; frame += 1) {
    if (opts.sync) out('\x1b[?2026h');
    if (opts.clearsPerFrame > 0) {
      for (let k = 0; k < opts.clearsPerFrame; k += 1) out('\x1b[2J');
    }
    out('\x1b[H');
    for (let r = 1; r <= contentRows; r += 1) {
      out(`\x1b[${r};1H`);
      out(`frame=${frame} row=${r}`);
      if (opts.lineErases) out(`\x1b[${opts.elMode}K`);
    }
    seq += 1;
    marker(seq);
    for (let d = 0; d < opts.dups; d += 1) marker(seq);
    if (opts.sync) out('\x1b[?2026l');
  }
  out('\n');

  if (opts.hangMs > 0) {
    setTimeout(() => process.exit(opts.exitCode), opts.hangMs);
  } else {
    process.exitCode = opts.exitCode;
  }
}

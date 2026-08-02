/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review capture-tui`: run a command in a throwaway terminal and hand
// back what it actually rendered — the evidence producer for rendering claims.
//
// A verifier ruling on "the panel clips at 80 columns" without this command
// reads the layout code and imagines a terminal; measured on this repo, the
// imagining is where rendering verdicts go wrong. This command makes the
// terminal real and the evidence a file:
//
//   tmux (PRIVATE server, -L)  →  .ans (pane text with escapes, always)
//                              →  .png (freeze-rendered, when available)
//
// The safety property is isolation, and it is structural: every tmux call is
// scoped to a per-run private server socket, so the capture cannot see —
// let alone resize or kill — the user's own tmux sessions. The measured
// failure mode of desktop-automation verification was exactly "drives the
// user's own windows"; a private server makes that impossible rather than
// discouraged. `kill-server` at the end reaps everything the capture started.
//
// Degradation is explicit, not silent: the manifest names which evidence rung
// was reached (`png` / `ans-only` / `none`) and why, because a verifier must
// say which rung its verdict stands on — a PNG is publishable rendering
// evidence, an .ans proves bytes but not pixels, and prose is neither.

import type { CommandModule } from 'yargs';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  captureServerName,
  freezePlan,
  tmuxPlan,
  validGeometry,
  type CaptureManifest,
} from './lib/tui-capture.js';

interface CaptureTuiArgs {
  command: string;
  cwd: string | undefined;
  cols: number;
  rows: number;
  settleMs: number;
  until: string | undefined;
  keys: string[] | undefined;
  out: string;
  timeoutMs: number;
}

function which(bin: string): boolean {
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  return r.status === 0;
}

function tmux(server: string, argv: string[]): string {
  return execFileSync('tmux', argv, {
    encoding: 'utf8',
    // A pane of text is small; a runaway TUI writing a scrollback is not our
    // problem — capture-pane returns the visible pane only.
    maxBuffer: 8 * 1024 * 1024,
  }) as string;
}

function sleepSync(ms: number): void {
  const buf = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buf), 0, 0, ms);
}

export function runCaptureTui(args: CaptureTuiArgs): void {
  const refuse = (reason: string): void => {
    writeStderrLine(`capture-tui: refused — ${reason}`);
    writeStdoutLine(JSON.stringify({ captured: false }));
    process.exitCode = 3;
  };

  if (!which('tmux')) {
    refuse(
      'tmux is not installed. Rendering claims stay argued from the code on ' +
        'this host; say so in the finding rather than describing an imagined ' +
        'terminal as evidence.',
    );
    return;
  }
  const geometry = validGeometry(args.cols, args.rows);
  if (!geometry.ok) {
    refuse(geometry.reason);
    return;
  }
  if (args.command.trim() === '') {
    refuse('--command must not be empty.');
    return;
  }

  const outBase = resolve(args.out);
  mkdirSync(dirname(outBase), { recursive: true });
  const ansPath = `${outBase}.ans`;
  const pngPath = `${outBase}.png`;
  const manifestPath = `${outBase}.json`;

  const server = captureServerName(process.pid, randomBytes(4).toString('hex'));
  const session = 'cap';
  const plan = tmuxPlan({
    server,
    session,
    cols: args.cols,
    rows: args.rows,
    command: args.command,
    cwd: args.cwd ? resolve(args.cwd) : process.cwd(),
  });

  let ansText = '';
  let settledBy: CaptureManifest['settledBy'] = 'fixed-delay';
  try {
    tmux(server, plan.start);
    for (const key of args.keys ?? []) {
      // One send-keys per token, verbatim: quoting-by-joining is how a key
      // sequence silently becomes a different key sequence.
      tmux(server, ['-L', server, 'send-keys', '-t', session, key]);
    }
    if (args.until) {
      // Poll the pane for the settle marker; on timeout, capture anyway and
      // SAY SO — a late frame is degraded evidence, not no evidence.
      const re = new RegExp(args.until);
      const deadline = Date.now() + args.timeoutMs;
      settledBy = 'timeout';
      for (;;) {
        const text = tmux(server, plan.capture);
        if (re.test(text)) {
          settledBy = 'until-match';
          break;
        }
        if (Date.now() >= deadline) break;
        sleepSync(250);
      }
    } else {
      sleepSync(args.settleMs);
    }
    ansText = tmux(server, plan.capture);
  } finally {
    // Always, even when start/capture threw: the private server holds every
    // process this capture launched, and an orphaned TUI outliving the
    // review is the mess this command exists to make impossible.
    try {
      tmux(server, plan.kill);
    } catch {
      // A kill failing because the server already died is the goal state.
    }
    // tmux does not always unlink the socket of a killed server; a review
    // that captures often would litter /tmp/tmux-<uid>/ with dead sockets.
    try {
      const uid = process.getuid?.();
      if (uid !== undefined) {
        rmSync(join(tmpdir(), `tmux-${uid}`, server), { force: true });
        rmSync(`/tmp/tmux-${uid}/${server}`, { force: true });
      }
    } catch {
      // Litter is cosmetic; never let cleanup mask the capture's own result.
    }
  }

  writeFileSync(ansPath, ansText, 'utf8');

  // .ans FIRST, then render: freeze has hung mid-render on this repo's own
  // workflows, and the text evidence must already be on disk when it does.
  let png: string | null = null;
  let degradedBecause: string | undefined;
  if (!which('freeze')) {
    degradedBecause =
      'freeze is not installed — .ans text captured, no image rendered';
  } else {
    // stdin MUST be /dev/null: freeze treats a pipe stdin — Node's spawnSync
    // default — as "the input is stdin" and ignores the positional file. A
    // pipe that EOFs promptly produces `ERROR No input` (exit 1); a pipe that
    // stays open hangs freeze indefinitely. Both modes were measured on this
    // machine in one evening — the historical "freeze hangs" incidents on
    // this repo's workflows are this exact shape. The timeout stays as the
    // second belt.
    const r = spawnSync('freeze', freezePlan(ansPath, pngPath), {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status === 0) {
      png = pngPath;
    } else {
      // The stderr tail rides along: a bare exit code is undiagnosable from a
      // manifest, and the whole point of recording degradation is that a
      // reader can tell WHY the ladder stopped.
      const errTail = `${r.stderr ?? ''} ${r.stdout ?? ''}`
        .trim()
        .split('\n')
        .slice(-2)
        .join(' ');
      degradedBecause = `freeze failed (${
        r.signal ? `signal ${r.signal}` : `exit ${String(r.status)}`
      }${errTail ? `: ${errTail}` : ''}) — .ans text captured, no image rendered`;
    }
  }

  const manifest: CaptureManifest = {
    command: args.command,
    cols: args.cols,
    rows: args.rows,
    ansPath,
    pngPath: png,
    evidence: png ? 'png' : 'ans-only',
    ...(degradedBecause ? { degradedBecause } : {}),
    settledBy,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  writeStderrLine(
    `capture-tui: ${manifest.evidence} at ${args.cols}x${args.rows} ` +
      `(settled by ${settledBy})${degradedBecause ? ` — ${degradedBecause}` : ''}`,
  );
  writeStdoutLine(
    JSON.stringify({
      captured: true,
      evidence: manifest.evidence,
      manifest: manifestPath,
    }),
  );
}

export const captureTuiCommand: CommandModule = {
  command: 'capture-tui',
  describe:
    'Run a command in a throwaway PRIVATE tmux server and capture what it rendered — .ans always, .png when freeze is available — as evidence for rendering claims',
  builder: (yargs) =>
    yargs
      .option('command', {
        type: 'string',
        demandOption: true,
        describe: 'The command to run inside the capture terminal',
      })
      .option('cwd', {
        type: 'string',
        describe: 'Working directory for the command (default: current)',
      })
      .option('cols', {
        type: 'number',
        default: DEFAULT_COLS,
        describe: 'Terminal width — layout claims are claims about a width',
      })
      .option('rows', {
        type: 'number',
        default: DEFAULT_ROWS,
        describe: 'Terminal height',
      })
      .option('settle-ms', {
        type: 'number',
        default: 3000,
        describe: 'Fixed delay before capturing (ignored when --until is set)',
      })
      .option('until', {
        type: 'string',
        describe:
          'Capture as soon as the pane text matches this regex; on timeout, capture anyway and record that the marker never appeared',
      })
      .option('keys', {
        type: 'string',
        array: true,
        describe:
          'tmux send-keys tokens sent after start, one per token (e.g. --keys "/review" Enter)',
      })
      .option('out', {
        type: 'string',
        demandOption: true,
        describe:
          'Output basename: <out>.ans, <out>.png (when rendered) and <out>.json (the manifest) are written',
      })
      .option('timeout-ms', {
        type: 'number',
        default: 60_000,
        describe: 'Deadline for --until polling',
      }),
  handler: (argv) => {
    runCaptureTui({
      command: argv['command'] as string,
      cwd: argv['cwd'] as string | undefined,
      cols: argv['cols'] as number,
      rows: argv['rows'] as number,
      settleMs: argv['settle-ms'] as number,
      until: argv['until'] as string | undefined,
      keys: argv['keys'] as string[] | undefined,
      out: argv['out'] as string,
      timeoutMs: argv['timeout-ms'] as number,
    });
  },
};

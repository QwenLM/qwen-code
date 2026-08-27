#!/usr/bin/env node
/**
 * TUI Render Throughput PTY Benchmark
 *
 * The shared reference driver for the paired PTY measurements recorded in
 * docs/design/2026-08-25-tui-render-throughput.md. Run it against a control
 * build (pre-change bundle) and a candidate build to reproduce the Results
 * tables, or to evaluate the deferred 60 ms -> 33 ms flush-interval change
 * ("paired PTY re-run against the baseline recorded in Results").
 *
 * The CLI under test runs inside a deterministic 100x32 PTY against a local
 * fake OpenAI-compatible SSE provider that emits 180 Markdown chunks at
 * 10 ms intervals. Workloads mirror the design doc: a 212-character burst
 * paste, 213 paced input characters, streamed Markdown, 24 PageUp/PageDown
 * keys, 200 SGR wheel events, and 112 paced characters after the long
 * response is visible.
 *
 * Per phase the driver records PTY write counts and byte volume, child CPU
 * time, event-loop delay percentiles (via a NODE_OPTIONS preload installed in
 * the child), and keystroke-to-output latency for typing phases.
 *
 * Usage:
 *   npm run bundle                 # first build the bundle under test
 *   node scripts/benchmark-tui-pty.mjs
 *
 * Environment variables:
 *   QWEN_BENCH_CMD='node dist/cli.js'      Command that starts the CLI under
 *                                          test in the PTY (shell-split).
 *   QWEN_BENCH_PTY_COLS=100                PTY width.
 *   QWEN_BENCH_PTY_ROWS=32                 PTY height.
 *   QWEN_BENCH_PORT=4819                 Fake SSE provider port.
 *   QWEN_BENCH_MODEL='fake-bench-model'    Model name the CLI is configured
 *                                          to use.
 *   QWEN_BENCH_PACE_MS=30                  Interval between paced keystrokes.
 *   QWEN_BENCH_EXTRA_ENV='K=V K2=V2'       Extra env for the CLI child.
 *
 * The driver scrubs CI markers (CI, CONTINUOUS_INTEGRATION, CI_*) from the
 * child env and sets QWEN_CODE_NO_RELAUNCH=1, so the CLI under test stays
 * interactive (VP mode) in the PTY-root process on any host — an ambient CI
 * marker would otherwise silently switch it to legacy non-VP rendering.
 * QWEN_BENCH_EXTRA_ENV can override QWEN_CODE_NO_RELAUNCH but cannot
 * reintroduce a CI marker.
 *
 * The CLI must be configured for the OpenAI-compatible endpoint at
 * http://127.0.0.1:$QWEN_BENCH_PORT/v1 with any non-empty API key (the fake
 * provider accepts every request). How that configuration is supplied is
 * install-specific (settings.json, env passthrough via QWEN_BENCH_EXTRA_ENV,
 * or a wrapper in QWEN_BENCH_CMD); the driver injects OPENAI_BASE_URL and
 * OPENAI_API_KEY into the child env in addition to anything you provide.
 */

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
// Root devDependency (same package the CLI's shell tooling uses).
const pty = require('@lydell/node-pty');

const CMD = process.env['QWEN_BENCH_CMD'] ?? 'node dist/cli.js';
const COLS = parseInt(process.env['QWEN_BENCH_PTY_COLS'] ?? '100', 10);
const ROWS = parseInt(process.env['QWEN_BENCH_PTY_ROWS'] ?? '32', 10);
const PORT = parseInt(process.env['QWEN_BENCH_PORT'] ?? '4819', 10);
const MODEL = process.env['QWEN_BENCH_MODEL'] ?? 'fake-bench-model';
const PACE_MS = parseInt(process.env['QWEN_BENCH_PACE_MS'] ?? '30', 10);
const SSE_CHUNKS = 180;
const SSE_INTERVAL_MS = 10;

// ---------------------------------------------------------------------------
// Fake OpenAI-compatible SSE provider

function startFakeProvider() {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    req.resume();
    req.on('end', () => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      let i = 0;
      const timer = setInterval(() => {
        if (i >= SSE_CHUNKS) {
          res.write('data: [DONE]\n\n');
          clearInterval(timer);
          res.end();
          return;
        }
        const delta =
          i % 20 === 0 ? `## Section ${i / 20 + 1}\n\n` : `chunk-${i} text. `;
        const payload = {
          id: `bench-${i}`,
          object: 'chat.completion.chunk',
          choices: [
            { index: 0, delta: { content: delta }, finish_reason: null },
          ],
        };
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
        i += 1;
      }, SSE_INTERVAL_MS);
      req.socket.on('close', () => clearInterval(timer));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

// ---------------------------------------------------------------------------
// Event-loop delay preload installed into the CLI child via NODE_OPTIONS

function writeEventLoopPreload(dir, outFile) {
  const preload = `
const { monitorEventLoopDelay } = require('node:perf_hooks');
const fs = require('node:fs');
const h = monitorEventLoopDelay({ resolution: 20 });
h.enable();
setInterval(() => {
  const row = {
    t: Date.now(),
    p50: h.percentile(50) / 1e6,
    p95: h.percentile(95) / 1e6,
    max: h.max / 1e6,
  };
  try { fs.appendFileSync(${JSON.stringify(outFile)}, JSON.stringify(row) + '\\n'); } catch {}
  h.reset();
}, 250);
`;
  const file = join(dir, 'event-loop-preload.cjs');
  writeFileSync(file, preload);
  return file;
}

function readEventLoopSamples(file) {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// CPU time sampling.
//
// Linux: clock ticks from /proc/<pid>/stat (utime + stime, fields 14+15)
// scaled by CLK_TCK — 10 ms granularity at the usual CLK_TCK=100. ps
// cputime/time only report whole seconds there, which cannot resolve the
// sub-second CPU deltas in the Results tables.
// Other platforms (macOS/BSD): `ps -o time=` ([[HH:]MM:]SS, whole seconds —
// state this resolution when comparing sub-second deltas). `time` is the one
// CPU-time keyword both procps-ng and BSD ps accept; cputime is
// procps-ng-only. Unavailable (process gone, unsupported output) -> null,
// which the Results table prints as n/a — never a fabricated 0.

let clkTck;
function getClkTck() {
  if (clkTck === undefined) {
    try {
      clkTck = parseInt(execSync('getconf CLK_TCK').toString().trim(), 10);
    } catch {
      clkTck = NaN;
    }
    if (!Number.isFinite(clkTck) || clkTck <= 0) clkTck = 100;
  }
  return clkTck;
}

function linuxTicksCpuMs(pid) {
  let stat;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  // comm (field 2) may contain spaces and parens, so split after the last
  // ')': rest[0] is field 3, utime/stime are fields 14/15 -> rest[11/12].
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ticks = Number(rest[11]) + Number(rest[12]);
  if (!Number.isFinite(ticks)) return null;
  return (ticks * 1000) / getClkTck();
}

function cpuTimeMs(pid) {
  if (process.platform === 'linux') {
    return Promise.resolve(linuxTicksCpuMs(pid));
  }
  return new Promise((resolve) => {
    const child = spawn('ps', ['-o', 'time=', '-p', String(pid)], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', () => {
      const trimmed = out.trim();
      if (!trimmed) return resolve(null);
      const parts = trimmed.split(':').map(Number);
      if (parts.some(Number.isNaN)) return resolve(null);
      const [s, m = 0, h = 0] = [...parts].reverse();
      resolve(((h * 60 + m) * 60 + s) * 1000);
    });
    child.on('error', () => resolve(null));
  });
}

// ---------------------------------------------------------------------------
// PTY session

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Session {
  constructor(env) {
    this.writes = 0;
    this.bytes = 0;
    this.pendingKeyAt = null;
    this.latencies = [];
    this.onData = null;
    const childEnv = {
      ...process.env,
      OPENAI_BASE_URL: `http://127.0.0.1:${PORT}/v1`,
      OPENAI_API_KEY: 'bench-fake-key',
      OPENAI_MODEL: MODEL,
      // Keep the TUI in the PTY-root process: otherwise the CLI relaunches
      // itself into a child (gemini.tsx boot relaunch) and measureCpu samples
      // the idle launcher, whose CPU stops accumulating, instead of the TUI.
      // Before ...env so QWEN_BENCH_EXTRA_ENV can still override it.
      QWEN_CODE_NO_RELAUNCH: '1',
      ...env,
    };
    // CI markers flip the child's isInteractiveTerminal() to false and would
    // silently measure legacy non-VP rendering — the mode this VP-only
    // benchmark must not measure. Scrub after the ...env spread so no
    // passthrough can reintroduce one, mirroring the child's own predicate
    // (isCiEnvKey, ui/utils/terminal-buffer.ts) like pty-host.ts's workers.
    for (const key of Object.keys(childEnv)) {
      if (
        key === 'CI' ||
        key === 'CONTINUOUS_INTEGRATION' ||
        key.startsWith('CI_')
      ) {
        delete childEnv[key];
      }
    }
    this.term = pty.spawn(...splitCmd(CMD), {
      name: 'xterm-256color',
      cols: COLS,
      rows: ROWS,
      cwd: process.cwd(),
      env: childEnv,
    });
    this.pid = this.term.pid;
    this.term.onData((data) => {
      this.writes += 1;
      this.bytes += Buffer.byteLength(data);
      if (this.pendingKeyAt !== null) {
        this.latencies.push(performance.now() - this.pendingKeyAt);
        this.pendingKeyAt = null;
      }
      this.onData?.(data);
    });
  }

  waitForOutput(pattern, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for ${pattern}`)),
        timeoutMs,
      );
      this.onData = (data) => {
        if (pattern.test(data)) {
          clearTimeout(timer);
          this.onData = null;
          resolve();
        }
      };
    });
  }

  // Keystroke with latency tracking: time from the write to the first
  // responding PTY output.
  async key(input, gapMs = 0) {
    this.pendingKeyAt = performance.now();
    this.term.write(input);
    if (gapMs > 0) await sleep(gapMs);
  }

  async paste(input) {
    this.term.write(input);
  }

  async measureCpu(fn) {
    const before = await cpuTimeMs(this.pid);
    await fn();
    const after = await cpuTimeMs(this.pid);
    return before !== null && after !== null ? after - before : null;
  }

  kill() {
    try {
      this.term.kill();
    } catch {
      /* already gone */
    }
  }
}

function splitCmd(cmd) {
  const parts = cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const args = parts.map((p) =>
    p.replace(/"([^"]*)"|'([^']*)'/g, (_m, dq, sq) => dq ?? sq),
  );
  return [args[0], args.slice(1)];
}

// ---------------------------------------------------------------------------
// Workloads (design doc, Verification / Measurement setup)

const BURST = 'a'.repeat(212);
const PACED_FIRST = 'the quick brown fox jumps over the lazy dog. '
  .repeat(5)
  .slice(0, 213);
const PACED_AFTER = 'second pass over the same composer after history. '
  .repeat(3)
  .slice(0, 112);
const PROMPT = 'Stream a long markdown answer, please.';

async function runPhase(session, name, fn) {
  const elStart = eventLoopSampleCount();
  const cpu = await session.measureCpu(async () => {
    await fn(session);
  });
  // Let the frame pipeline settle before closing the phase.
  await sleep(500);
  const phase = {
    name,
    writes: session.writes,
    bytes: session.bytes,
    cpuMs: cpu,
    latencies: session.latencies.splice(0),
    elFrom: elStart,
    elTo: eventLoopSampleCount(),
  };
  session.writes = 0;
  session.bytes = 0;
  return phase;
}

const workDir = mkdtempSync(join(tmpdir(), 'qwen-tui-bench-'));
const elFile = join(workDir, 'event-loop.jsonl');
const preload = writeEventLoopPreload(workDir, elFile);
let eventLoopSamples = [];
const eventLoopSampleCount = () => readEventLoopSamples(elFile).length;

async function main() {
  console.log('=== Qwen Code TUI Render Throughput PTY Benchmark ===');
  console.log(`Command          : ${CMD}`);
  console.log(`PTY              : ${COLS}x${ROWS}`);
  console.log(
    `Fake SSE provider: http://127.0.0.1:${PORT}/v1 (${SSE_CHUNKS} chunks @ ${SSE_INTERVAL_MS}ms)`,
  );

  const server = await startFakeProvider();
  const extraEnv = {};
  for (const pair of (process.env['QWEN_BENCH_EXTRA_ENV'] ?? '').match(
    /(?:[^\s"']+|"[^"]*"|'[^']*')+/g,
  ) ?? []) {
    const eq = pair.indexOf('=');
    if (eq > 0) {
      extraEnv[pair.slice(0, eq)] = pair
        .slice(eq + 1)
        .replace(/^["']|["']$/g, '');
    }
  }
  extraEnv['NODE_OPTIONS'] = [
    extraEnv['NODE_OPTIONS'] ?? process.env['NODE_OPTIONS'] ?? '',
    `--require "${preload}"`,
  ]
    .filter(Boolean)
    .join(' ');

  const session = new Session(extraEnv);
  const phases = [];
  try {
    // Wait for the prompt to come up (the composer input marker).
    await session.waitForOutput(/❯|>/, 60_000);
    // Startup output (banner, tips, composer frame) is not part of any
    // phase; drop what the readiness gate consumed.
    session.writes = 0;
    session.bytes = 0;

    phases.push(
      // Paste-only, matching the recorded protocol: no in-window submit,
      // so the fake provider's streamed response does not land in the burst
      // metrics and no committed turn is visible before the paced phases.
      await runPhase(session, 'burst paste (212 chars)', async (s) => {
        await s.paste(BURST);
        await sleep(2_000);
      }),
    );

    phases.push(
      await runPhase(session, 'paced input (213 chars)', async (s) => {
        for (const ch of PACED_FIRST) await s.key(ch, PACE_MS);
        await sleep(1_000);
        // Clear the composer without committing it to the transcript. Size it
        // to everything typed so far: the burst paste is never submitted, so
        // its characters are still in the composer and must be cleared too,
        // or the streaming phase commits them as a stray first message and
        // phases 3-6 render history containing that turn.
        const clearChars = BURST.length + PACED_FIRST.length;
        for (let i = 0; i < clearChars; i += 32) {
          await s.key('\x7f'.repeat(Math.min(32, clearChars - i)), 10);
        }
      }),
    );

    phases.push(
      await runPhase(session, 'streaming Markdown', async (s) => {
        for (const ch of PROMPT) await s.key(ch, 5);
        await s.key('\r');
        await sleep(SSE_CHUNKS * SSE_INTERVAL_MS + 3_000);
      }),
    );

    phases.push(
      await runPhase(session, '24 PageUp/PageDown keys', async (s) => {
        for (let i = 0; i < 12; i++) {
          await s.key('\x1b[5~', 120); // PageUp
          await s.key('\x1b[6~', 120); // PageDown
        }
      }),
    );

    phases.push(
      await runPhase(session, '200 wheel events (SGR)', async (s) => {
        for (let i = 0; i < 100; i++) {
          await s.paste('\x1b[<64;50;16M\x1b[<64;50;16m'); // wheel up press+release
          await s.paste('\x1b[<65;50;16M\x1b[<65;50;16m'); // wheel down press+release
          await sleep(15);
        }
      }),
    );

    phases.push(
      await runPhase(
        session,
        'paced input after long history (112 chars)',
        async (s) => {
          for (const ch of PACED_AFTER) await s.key(ch, PACE_MS);
        },
      ),
    );
  } finally {
    session.kill();
    server.close();
  }
  eventLoopSamples = readEventLoopSamples(elFile);

  // ---------------------------------------------------------------------
  console.log('\n=== Results ===\n');
  console.log(
    'Phase'.padEnd(42) +
      'Writes'.padStart(8) +
      'Bytes'.padStart(10) +
      'CPU ms'.padStart(9) +
      'EL p95 ms'.padStart(11) +
      'Key p50 ms'.padStart(12),
  );
  console.log('─'.repeat(92));
  for (const p of phases) {
    const el = eventLoopSamples.slice(p.elFrom, p.elTo);
    const p95 = el.length ? Math.max(...el.map((r) => r.p95)) : Number.NaN;
    const keyP50 = p.latencies.length
      ? [...p.latencies].sort((a, b) => a - b)[
          Math.floor(p.latencies.length / 2)
        ]
      : Number.NaN;
    console.log(
      p.name.slice(0, 41).padEnd(42) +
        String(p.writes).padStart(8) +
        String(p.bytes).padStart(10) +
        (p.cpuMs === null ? 'n/a' : Math.round(p.cpuMs).toString()).padStart(
          9,
        ) +
        (Number.isNaN(p95) ? 'n/a' : p95.toFixed(2)).padStart(11) +
        (Number.isNaN(keyP50) ? 'n/a' : keyP50.toFixed(2)).padStart(12),
    );
  }
  console.log(
    '\nCompare two runs of this script (control vs candidate build) to fill the\npaired Results tables in docs/design/2026-08-25-tui-render-throughput.md.',
  );

  rmSync(workDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
});

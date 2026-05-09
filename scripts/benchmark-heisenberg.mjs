#!/usr/bin/env node
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Measures the Heisenberg overhead of the startup profiler.
 *
 * Runs the no-mcp fixture under three configurations × N samples:
 *   1. profiler-off       — QWEN_CODE_PROFILE_STARTUP unset
 *   2. profiler-on-noheap — PROFILE_STARTUP=1 + NO_HEAP=1 (events + checkpoints, no memoryUsage)
 *   3. profiler-on-heap   — PROFILE_STARTUP=1 (full instrumentation)
 *
 * Compares total wall time (Hi-res, measured in this harness, NOT inside the
 * profiler) so we can detect any drift caused by the profiler itself.
 *
 * Acceptance criterion (design § 9.3): profiler overhead must stay < 1% of
 * total startup. If exceeded, PR0+1 needs changes (e.g. lazy heap snapshot,
 * fewer checkpoints) before downstream PRs can trust the t-test methodology.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'dist/cli.js');
const FIXTURE = path.join(
  REPO_ROOT,
  'docs/design/first-screen-performance-optimization/fixtures/no-mcp',
);

function parseArgs(argv) {
  const out = { runs: 30, out: '' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs') {
      out.runs = parseInt(argv[++i], 10);
    } else if (a === '--out') {
      out.out = argv[++i];
    }
  }
  if (!out.out) {
    process.stderr.write('Usage: benchmark-heisenberg.mjs --runs N --out PATH\n');
    process.exit(2);
  }
  return out;
}

async function runOne(env) {
  return new Promise((resolve) => {
    const startNs = performance.now();
    const child = spawn(process.execPath, [CLI, '--prompt', 'noop'], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'ignore'],
      cwd: FIXTURE,
    });
    child.on('close', () => {
      const endNs = performance.now();
      resolve(endNs - startNs);
    });
  });
}

async function runConfig(name, baseEnv, runs) {
  const samples = [];
  process.stderr.write(`\n[${name}] running ${runs} samples...\n`);
  for (let i = 1; i <= runs; i++) {
    const ms = await runOne(baseEnv);
    samples.push(ms);
    process.stderr.write(`  ${i}/${runs}: ${ms.toFixed(1)} ms\n`);
  }
  return samples;
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const variance =
    sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1);
  return {
    n,
    mean: round(mean),
    stdev: round(Math.sqrt(variance)),
    p50: round(sorted[Math.floor(n * 0.5)]),
    p90: round(sorted[Math.floor(n * 0.9)]),
    min: round(sorted[0]),
    max: round(sorted[n - 1]),
    samples,
  };
}

function round(x) {
  return Math.round(x * 100) / 100;
}

// Welch's t-test (two-sided) — simplified, p approximated with Lentz/Lanczos.
function welchT(a, b) {
  const na = a.length;
  const nb = b.length;
  const ma = a.reduce((s, v) => s + v, 0) / na;
  const mb = b.reduce((s, v) => s + v, 0) / nb;
  const va = a.reduce((s, v) => s + (v - ma) ** 2, 0) / (na - 1);
  const vb = b.reduce((s, v) => s + (v - mb) ** 2, 0) / (nb - 1);
  const t = (ma - mb) / Math.sqrt(va / na + vb / nb);
  const df =
    (va / na + vb / nb) ** 2 /
    ((va / na) ** 2 / (na - 1) + (vb / nb) ** 2 / (nb - 1));
  const p = 2 * (1 - studentTCdf(Math.abs(t), df));
  return { t: round(t), df: round(df), p: round(p * 1000) / 1000 };
}
function studentTCdf(t, df) {
  const x = df / (df + t * t);
  return 1 - 0.5 * incompleteBeta(x, df / 2, 0.5);
}
function incompleteBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;
  let f = 1, c = 1, d = 0;
  for (let m = 0; m < 200; m++) {
    let aa;
    if (m === 0) aa = 1;
    else {
      const m2 = m * 2;
      aa = m % 2 === 1
        ? (-(a + (m + 1) / 2 - 1) * (a + b + (m + 1) / 2 - 1) * x) / ((a + m2 - 1) * (a + m2))
        : ((m / 2) * (b - m / 2) * x) / ((a + m2 - 1) * (a + m2));
    }
    d = 1 + aa * d; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = 1 + aa / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const delta = d * c;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-10) break;
  }
  return front * (f - 1);
}
function lnGamma(z) {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < 9; i++) x += c[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

async function main() {
  const opts = parseArgs(process.argv);

  if (!fs.existsSync(CLI)) {
    process.stderr.write(`CLI not found: ${CLI}. Run 'npm run bundle' first.\n`);
    process.exit(2);
  }

  // CRITICAL: SANDBOX=1 must be present in ALL configs. Without it the cli
  // would re-launch itself as a sandbox child process, which adds ~700ms
  // unrelated to profiler overhead and would entirely dominate the
  // comparison. The first iteration of this script omitted SANDBOX in the
  // "off" config and produced nonsensical "profiler is faster than no
  // profiler" numbers — left this comment as a foot-gun marker.
  const baseEnv = {
    QWEN_HOME: path.join(FIXTURE, '.qwen'),
    HOME: FIXTURE,
    NO_COLOR: '1',
    QWEN_CODE_NO_UPDATE_CHECK: '1',
    SANDBOX: '1',
  };

  const off = await runConfig('profiler-off', baseEnv, opts.runs);
  const onNoHeap = await runConfig('profiler-on-noheap', {
    ...baseEnv,
    QWEN_CODE_PROFILE_STARTUP: '1',
    QWEN_CODE_PROFILE_STARTUP_NO_HEAP: '1',
  }, opts.runs);
  const onHeap = await runConfig('profiler-on-heap', {
    ...baseEnv,
    QWEN_CODE_PROFILE_STARTUP: '1',
  }, opts.runs);

  const offS = summarize(off);
  const noHeapS = summarize(onNoHeap);
  const heapS = summarize(onHeap);

  const noHeapVsOff = welchT(off, onNoHeap);
  const heapVsOff = welchT(off, onHeap);
  const heapVsNoHeap = welchT(onNoHeap, onHeap);

  const overheadNoHeapPct = round(((noHeapS.p50 - offS.p50) / offS.p50) * 100);
  const overheadHeapPct = round(((heapS.p50 - offS.p50) / offS.p50) * 100);

  const summary = {
    date: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    runs: opts.runs,
    fixture: 'no-mcp',
    cli: CLI,
    configs: {
      'profiler-off': offS,
      'profiler-on-noheap': noHeapS,
      'profiler-on-heap': heapS,
    },
    comparisons: {
      'noheap-vs-off': { ...noHeapVsOff, deltaP50Ms: round(noHeapS.p50 - offS.p50), deltaP50Pct: overheadNoHeapPct },
      'heap-vs-off':   { ...heapVsOff,   deltaP50Ms: round(heapS.p50 - offS.p50),   deltaP50Pct: overheadHeapPct },
      'heap-vs-noheap': { ...heapVsNoHeap, deltaP50Ms: round(heapS.p50 - noHeapS.p50), deltaP50Pct: round(((heapS.p50 - noHeapS.p50) / noHeapS.p50) * 100) },
    },
    verdicts: {
      'noheap-vs-off': overheadAccept(overheadNoHeapPct),
      'heap-vs-off': overheadAccept(overheadHeapPct),
    },
  };

  fs.writeFileSync(opts.out + '.summary.json', JSON.stringify(summary, null, 2));

  // Markdown report
  const md = [
    '# Heisenberg Overhead Report',
    '',
    `- Date: ${summary.date}`,
    `- Runs per config: ${opts.runs}`,
    `- CLI: \`${CLI}\``,
    `- Node: ${process.version}, Platform: ${process.platform} ${process.arch}`,
    '',
    '## Wall-clock totals (measured by harness, not by profiler)',
    '',
    '| Config | n | mean | stdev | p50 | p90 | min | max |',
    '| ------ | - | ---- | ----- | --- | --- | --- | --- |',
    `| profiler-off       | ${offS.n} | ${offS.mean} | ${offS.stdev} | ${offS.p50} | ${offS.p90} | ${offS.min} | ${offS.max} |`,
    `| profiler-on-noheap | ${noHeapS.n} | ${noHeapS.mean} | ${noHeapS.stdev} | ${noHeapS.p50} | ${noHeapS.p90} | ${noHeapS.min} | ${noHeapS.max} |`,
    `| profiler-on-heap   | ${heapS.n} | ${heapS.mean} | ${heapS.stdev} | ${heapS.p50} | ${heapS.p90} | ${heapS.min} | ${heapS.max} |`,
    '',
    '## Overhead vs profiler-off (Welch\'s t-test)',
    '',
    '| Comparison | Δp50 (ms) | Δp50 (%) | t-test p | Verdict |',
    '| ---------- | --------- | -------- | -------- | ------- |',
    `| noheap-vs-off | ${summary.comparisons['noheap-vs-off'].deltaP50Ms} | ${summary.comparisons['noheap-vs-off'].deltaP50Pct}% | ${summary.comparisons['noheap-vs-off'].p} | ${summary.verdicts['noheap-vs-off']} |`,
    `| heap-vs-off   | ${summary.comparisons['heap-vs-off'].deltaP50Ms} | ${summary.comparisons['heap-vs-off'].deltaP50Pct}% | ${summary.comparisons['heap-vs-off'].p} | ${summary.verdicts['heap-vs-off']} |`,
    `| heap-vs-noheap | ${summary.comparisons['heap-vs-noheap'].deltaP50Ms} | ${summary.comparisons['heap-vs-noheap'].deltaP50Pct}% | ${summary.comparisons['heap-vs-noheap'].p} | informational |`,
    '',
    '## Acceptance criterion',
    '',
    'Design § 9.3 requires profiler Heisenberg overhead < 1%. The "heap-vs-off"',
    'row is the strict test (full instrumentation enabled). If verdict is "fail",',
    'PR0+1 needs to lazy-snapshot heap or coarsen checkpoints before merge.',
    '',
  ].join('\n');
  fs.writeFileSync(opts.out + '.report.md', md);
  process.stderr.write(`\nWrote ${opts.out}.{summary.json,report.md}\n`);
}

function overheadAccept(pct) {
  if (pct < 1) return 'pass (< 1%)';
  if (pct < 2) return 'borderline (1-2%)';
  return 'fail (>= 2%)';
}

main().catch((err) => {
  process.stderr.write(`heisenberg failed: ${err?.stack || err}\n`);
  process.exit(1);
});

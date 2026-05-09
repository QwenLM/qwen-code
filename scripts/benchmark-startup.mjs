#!/usr/bin/env node
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Startup benchmark harness for first-screen performance work.
 *
 * Usage:
 *   scripts/benchmark-startup.mjs \
 *     --fixture <no-mcp|one-fast-mcp|three-mixed-mcp|flaky-mcp> \
 *     --runs 30 \
 *     --out /tmp/baseline-no-mcp \
 *     [--baseline /path/to/prev.summary.json]   # enable t-test against prior run
 *
 * Outputs:
 *   <out>.raw.jsonl         — one StartupReport JSON per line
 *   <out>.summary.json      — aggregated p50/p90/p99/mean/stdev per metric
 *   <out>.report.md         — markdown table; if --baseline given, includes Δ + Welch's t-test
 *
 * Each run executes `node packages/cli/dist/index.js --prompt "noop"` as a
 * sandbox child process with QWEN_CODE_PROFILE_STARTUP=1 and SANDBOX=1, so the
 * profiler activates and writes its JSON report. We then read the latest
 * report from ~/.qwen/startup-perf/ and aggregate.
 *
 * Note: we set SANDBOX=1 to satisfy the profiler's gate; we do NOT actually
 * spawn the OS sandbox. This is consistent with how the existing profiler
 * tests run (see packages/cli/src/utils/startupProfiler.test.ts).
 *
 * Scope: this harness uses `--prompt noop` (non-interactive path). The
 * non-interactive path captures `processUptimeAtT0Ms`, `after_load_settings`,
 * `after_load_cli_config`, `after_initialize_app`, and `before_render`. It
 * does NOT capture interactive-only metrics (`first_paint`,
 * `config_initialize_*`, `input_enabled`, MCP events, `gemini_tools_updated`)
 * because those are emitted from `AppContainer`'s mount effect. Capturing
 * those requires a TTY — see follow-up "interactive benchmark mode" in
 * `docs/design/first-screen-performance-optimization/05-rollout-and-rollback.md`.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURES_DIR = path.join(
  REPO_ROOT,
  'docs/design/first-screen-performance-optimization/fixtures',
);
// Each run writes its profile relative to the fixture's HOME (since HOME and
// QWEN_HOME are both set to the fixture dir). `getPerfDir(fixture)` resolves
// it. This keeps benchmark output isolated from the developer's real
// ~/.qwen/startup-perf and avoids cross-contamination between concurrent runs.
function getPerfDir(fixture) {
  // Mirrors `Storage.getGlobalQwenDir()` resolution: QWEN_HOME = <fixture>/.qwen,
  // and the profiler writes to <QWEN_HOME>/startup-perf.
  return path.join(fixture.dir, '.qwen', 'startup-perf');
}
// Prefer the production bundle so the V8 module-load profile matches what
// users actually see. Fall back to the workspace build if the bundle is
// missing (useful during dev iteration).
const BUNDLED_CLI = path.join(REPO_ROOT, 'dist/cli.js');
const WORKSPACE_CLI = path.join(REPO_ROOT, 'packages/cli/dist/index.js');
const CLI_ENTRY = fs.existsSync(BUNDLED_CLI) ? BUNDLED_CLI : WORKSPACE_CLI;

// Metrics we care about. Each entry maps a "logical metric name" to either a
// derivedPhases key (from the StartupReport) OR a function of the report.
const METRICS = [
  { name: 'processUptimeAtT0Ms', from: (r) => r.processUptimeAtT0Ms },
  {
    name: 'after_load_settings',
    from: (r) => phaseAbs(r, 'after_load_settings'),
  },
  {
    name: 'after_load_cli_config',
    from: (r) => phaseAbs(r, 'after_load_cli_config'),
  },
  {
    name: 'after_initialize_app',
    from: (r) => phaseAbs(r, 'after_initialize_app'),
  },
  { name: 'before_render', from: (r) => r.derivedPhases?.pre_render },
  { name: 'first_paint', from: (r) => r.derivedPhases?.to_first_paint },
  { name: 'config_initialize_dur', from: (r) => r.derivedPhases?.config_initialize_dur },
  { name: 'input_enabled', from: (r) => r.derivedPhases?.to_input_enabled },
  { name: 'mcp_first_tool', from: (r) => r.derivedPhases?.mcp_first_tool },
  { name: 'mcp_all_settled', from: (r) => r.derivedPhases?.mcp_all_settled },
  { name: 'gemini_tools_lag', from: (r) => r.derivedPhases?.gemini_tools_lag },
];

function phaseAbs(report, name) {
  let cumulative = 0;
  for (const phase of report.phases || []) {
    cumulative = phase.startMs + phase.durationMs;
    if (phase.name === name) return cumulative;
  }
  return undefined;
}

function parseArgs(argv) {
  const out = {
    fixture: 'no-mcp',
    runs: 30,
    out: '',
    baseline: '',
    cliEntry: CLI_ENTRY,
    nonInteractive: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--fixture':
        out.fixture = next;
        i++;
        break;
      case '--runs':
        out.runs = parseInt(next, 10);
        i++;
        break;
      case '--out':
        out.out = next;
        i++;
        break;
      case '--baseline':
        out.baseline = next;
        i++;
        break;
      case '--cli-entry':
        out.cliEntry = next;
        i++;
        break;
      case '--non-interactive':
        out.nonInteractive = true;
        break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
        break; // unreachable; satisfies no-fallthrough
      default:
        process.stderr.write(`Unknown argument: ${a}\n`);
        printHelp();
        process.exit(2);
    }
  }
  if (!out.out) {
    process.stderr.write('Missing required --out\n');
    printHelp();
    process.exit(2);
  }
  return out;
}

function printHelp() {
  process.stderr.write(
    `Usage: scripts/benchmark-startup.mjs --fixture <name> --runs <N> --out <path> [--baseline <prev.summary.json>] [--non-interactive]\n` +
      `Fixtures: ${listFixtures().join(', ')}\n`,
  );
}

function listFixtures() {
  if (!fs.existsSync(FIXTURES_DIR)) return [];
  return fs
    .readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function loadFixture(name) {
  const dir = path.join(FIXTURES_DIR, name);
  if (!fs.existsSync(dir)) {
    process.stderr.write(
      `Fixture '${name}' not found in ${FIXTURES_DIR}. Available: ${listFixtures().join(', ')}\n`,
    );
    process.exit(2);
  }
  // A fixture is a directory containing optional `qwen.json`, MCP server
  // implementations, etc. We point QWEN_HOME at the fixture so the cli reads
  // its settings from there.
  return { dir };
}

function listExistingProfiles(perfDir) {
  if (!fs.existsSync(perfDir)) return new Set();
  return new Set(fs.readdirSync(perfDir));
}

async function runOne(opts, fixture, attempt) {
  const env = {
    ...process.env,
    QWEN_CODE_PROFILE_STARTUP: '1',
    // Force the profiler to activate without an actual OS sandbox.
    SANDBOX: '1',
    // QWEN_HOME points at the directory that *contains* `settings.json`
    // directly (it becomes `~/.qwen/`). Each fixture stores settings under
    // `<fixture>/.qwen/settings.json`, so QWEN_HOME = <fixture>/.qwen.
    QWEN_HOME: path.join(fixture.dir, '.qwen'),
    // HOME is set so any code path that falls back to `os.homedir()` lands
    // in the fixture rather than the developer's real home.
    HOME: fixture.dir,
    // Avoid colored output in benchmarks.
    NO_COLOR: '1',
    QWEN_CODE_NO_UPDATE_CHECK: '1',
  };

  const perfDir = getPerfDir(fixture);
  // Snapshot existing perf files so we can identify the new one.
  const before = listExistingProfiles(perfDir);

  // We deliberately do NOT pass `--bare`: bare mode flips
  // `createToolRegistry({ skipDiscovery: true })` (`packages/core/src/config/config.ts`)
  // which bypasses MCP discovery entirely and would invalidate the MCP-related
  // fixtures (one-fast-mcp / three-mixed-mcp / flaky-mcp).
  //
  // To avoid auth being a confound, fixtures may set `auth.useExternal=true`
  // in their settings.json, or the env passes a fake auth token if needed.
  const args = [opts.cliEntry, '--prompt', 'noop'];

  return await new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // The fixture's MCP server `args` use paths relative to the fixture
      // dir (e.g. `../../_servers/echo-mcp.mjs`). Set cwd accordingly so
      // those resolve regardless of where the benchmark was invoked.
      cwd: fixture.dir,
    });
    let stderr = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('close', (code) => {
      // Find the new profile file
      const after = listExistingProfiles(perfDir);
      const created = [...after].filter((f) => !before.has(f));
      if (created.length === 0) {
        resolve({
          attempt,
          ok: false,
          reason: 'no profile produced',
          stderr,
          code,
        });
        return;
      }
      // Pick the most recent.
      const file = path.join(perfDir, created[created.length - 1]);
      try {
        const report = JSON.parse(fs.readFileSync(file, 'utf-8'));
        resolve({ attempt, ok: true, file, report, code });
      } catch (err) {
        resolve({
          attempt,
          ok: false,
          reason: `parse failure: ${err.message}`,
          stderr,
          code,
        });
      }
    });
  });
}

function aggregate(reports) {
  const out = {};
  for (const m of METRICS) {
    const samples = [];
    for (const r of reports) {
      const v = m.from(r);
      if (typeof v === 'number' && !Number.isNaN(v)) {
        samples.push(v);
      }
    }
    if (samples.length === 0) {
      out[m.name] = null;
      continue;
    }
    samples.sort((a, b) => a - b);
    const n = samples.length;
    const sum = samples.reduce((a, b) => a + b, 0);
    const mean = sum / n;
    const variance =
      samples.reduce((a, b) => a + (b - mean) * (b - mean), 0) /
      Math.max(1, n - 1);
    const stdev = Math.sqrt(variance);
    out[m.name] = {
      n,
      mean: round(mean),
      stdev: round(stdev),
      p50: round(percentile(samples, 0.5)),
      p90: round(percentile(samples, 0.9)),
      p99: round(percentile(samples, 0.99)),
      min: round(samples[0]),
      max: round(samples[n - 1]),
      samples,
    };
  }
  return out;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(p * (sorted.length - 1))),
  );
  return sorted[idx];
}

function round(x) {
  return Math.round(x * 100) / 100;
}

// Welch's t-test, two-sided.
function welchTTest(a, b) {
  const na = a.length;
  const nb = b.length;
  if (na < 2 || nb < 2) return { p: NaN, t: NaN };
  const ma = a.reduce((s, v) => s + v, 0) / na;
  const mb = b.reduce((s, v) => s + v, 0) / nb;
  const va = a.reduce((s, v) => s + (v - ma) ** 2, 0) / (na - 1);
  const vb = b.reduce((s, v) => s + (v - mb) ** 2, 0) / (nb - 1);
  const t = (ma - mb) / Math.sqrt(va / na + vb / nb);
  // Welch–Satterthwaite degrees of freedom
  const df =
    (va / na + vb / nb) ** 2 /
    ((va / na) ** 2 / (na - 1) + (vb / nb) ** 2 / (nb - 1));
  // Two-sided p-value via numerical Student's t CDF approximation.
  const p = 2 * (1 - studentTCdf(Math.abs(t), df));
  return { p: round(p * 1000) / 1000, t: round(t * 1000) / 1000, df: round(df) };
}

// Numerical Student's t CDF using the regularized incomplete beta function.
// Source-of-truth: standard textbook recurrence; sufficient for sample sizes
// in benchmark range (n=30 per arm).
function studentTCdf(t, df) {
  const x = df / (df + t * t);
  const beta = incompleteBetaRegularized(x, df / 2, 0.5);
  return 1 - 0.5 * beta;
}
function incompleteBetaRegularized(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;
  // Continued fraction expansion (Lentz's method).
  let f = 1;
  let c = 1;
  let d = 0;
  const FPMIN = 1e-300;
  for (let m = 0; m < 200; m++) {
    let aa;
    if (m === 0) aa = 1;
    else {
      const m2 = m * 2;
      aa =
        m % 2 === 1
          ? (-(a + (m + 1) / 2 - 1) * (a + b + (m + 1) / 2 - 1) * x) /
            ((a + m2 - 1) * (a + m2))
          : ((m / 2) * (b - m / 2) * x) / ((a + m2 - 1) * (a + m2));
    }
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const delta = d * c;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-10) break;
  }
  return front * (f - 1);
}
function lnGamma(z) {
  // Lanczos approximation
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return (
      Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z)
    );
  }
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function buildMarkdown(summary, baseline, opts) {
  const lines = [];
  lines.push(`# Startup Benchmark Report`);
  lines.push('');
  lines.push(`- Fixture: \`${opts.fixture}\``);
  lines.push(`- Runs: ${opts.runs}`);
  lines.push(`- CLI: ${opts.cliEntry}`);
  lines.push(`- Date: ${new Date().toISOString()}`);
  lines.push(`- Node: ${process.version}`);
  lines.push(`- Platform: ${process.platform} ${process.arch}`);
  lines.push('');
  if (baseline) {
    lines.push(`Baseline: \`${opts.baseline}\``);
    lines.push('');
    lines.push(
      `| Metric | n | Baseline p50 / p90 | After p50 / p90 | Δp50 (ms) | Δp50 (%) | t-test p | Verdict |`,
    );
    lines.push(
      `| ------ | - | ------------------ | --------------- | --------- | -------- | -------- | ------- |`,
    );
  } else {
    lines.push(
      `| Metric | n | mean | stdev | p50 | p90 | p99 | min | max |`,
    );
    lines.push(
      `| ------ | - | ---- | ----- | --- | --- | --- | --- | --- |`,
    );
  }
  for (const m of METRICS) {
    const cur = summary[m.name];
    if (!cur) continue;
    if (baseline) {
      const prev = baseline[m.name];
      if (!prev) {
        lines.push(`| ${m.name} | ${cur.n} | — | ${cur.p50} / ${cur.p90} | — | — | — | n/a |`);
        continue;
      }
      const dpAbs = round(cur.p50 - prev.p50);
      const dpPct = prev.p50 === 0 ? 0 : round(((cur.p50 - prev.p50) / prev.p50) * 100);
      const tt = welchTTest(prev.samples, cur.samples);
      const verdict = verdictFor(dpAbs, dpPct, tt.p);
      lines.push(
        `| ${m.name} | ${cur.n} | ${prev.p50} / ${prev.p90} | ${cur.p50} / ${cur.p90} | ${dpAbs} | ${dpPct}% | ${tt.p} | ${verdict} |`,
      );
    } else {
      lines.push(
        `| ${m.name} | ${cur.n} | ${cur.mean} | ${cur.stdev} | ${cur.p50} | ${cur.p90} | ${cur.p99} | ${cur.min} | ${cur.max} |`,
      );
    }
  }
  lines.push('');
  if (baseline) {
    lines.push(`### Verdict legend`);
    lines.push('');
    lines.push(
      `- **improve**: p50 改善 ≥ 50ms 或 ≥ 10% (取较大者)，且 Welch's t-test p < 0.05`,
    );
    lines.push(`- **regress**: p50 退化 > 5% (拒绝合并)`);
    lines.push(`- **noise**: 改动落在统计噪声内`);
  }
  return lines.join('\n') + '\n';
}

function verdictFor(absMs, pct, p) {
  // Direction: lower is better for all our metrics.
  if (pct < -10 || (absMs < -50 && p < 0.05)) return 'improve';
  if (pct > 5) return 'regress';
  return 'noise';
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!fs.existsSync(opts.cliEntry)) {
    process.stderr.write(
      `CLI entry not found: ${opts.cliEntry}\nRun "npm run bundle" first.\n`,
    );
    process.exit(2);
  }
  const fixture = loadFixture(opts.fixture);
  const reports = [];
  const failures = [];

  process.stderr.write(
    `Running ${opts.runs} samples for fixture '${opts.fixture}'…\n`,
  );
  for (let i = 1; i <= opts.runs; i++) {
    const r = await runOne(opts, fixture, i);
    if (r.ok) {
      reports.push(r.report);
      process.stderr.write(`  [${i}/${opts.runs}] ok\n`);
    } else {
      failures.push(r);
      process.stderr.write(
        `  [${i}/${opts.runs}] FAILED: ${r.reason || 'exit ' + r.code}\n`,
      );
    }
  }

  if (reports.length === 0) {
    process.stderr.write(
      'All runs failed; not producing summary. First failure stderr:\n',
    );
    process.stderr.write((failures[0]?.stderr || '').slice(0, 4000));
    process.exit(1);
  }

  // Write raw jsonl
  const rawPath = `${opts.out}.raw.jsonl`;
  fs.writeFileSync(rawPath, reports.map((r) => JSON.stringify(r)).join('\n') + '\n');

  // Aggregate
  const summary = aggregate(reports);
  const summaryWrapper = {
    fixture: opts.fixture,
    runs: reports.length,
    requestedRuns: opts.runs,
    failures: failures.length,
    cli: opts.cliEntry,
    date: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    metrics: summary,
  };
  const summaryPath = `${opts.out}.summary.json`;
  fs.writeFileSync(summaryPath, JSON.stringify(summaryWrapper, null, 2));

  // Optional baseline
  let baseline = null;
  if (opts.baseline) {
    if (!fs.existsSync(opts.baseline)) {
      process.stderr.write(`Baseline not found: ${opts.baseline}\n`);
      process.exit(2);
    }
    const baselineWrapper = JSON.parse(fs.readFileSync(opts.baseline, 'utf-8'));
    baseline = baselineWrapper.metrics || baselineWrapper;
  }

  const reportPath = `${opts.out}.report.md`;
  fs.writeFileSync(reportPath, buildMarkdown(summary, baseline, opts));

  process.stderr.write(
    `\nWrote:\n  ${rawPath}\n  ${summaryPath}\n  ${reportPath}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`benchmark-startup failed: ${err?.stack || err}\n`);
  process.exit(1);
});

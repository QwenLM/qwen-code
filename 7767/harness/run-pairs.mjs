/**
 * Paired AB/BA runner for the PR #7767 direct-ACP probe.
 *
 * Each pair runs control and candidate back to back; the order alternates so
 * drift in the host affects both arms equally. Reports paired medians with
 * seeded bootstrap 95% CIs and an AB/BA order-sensitivity split.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : argv[i + 1];
};

const CONTROL = path.resolve(arg('control'));
const CANDIDATE = path.resolve(arg('candidate'));
const PAIRS = Number(arg('pairs', '10'));
const DWELL = arg('dwell', '100');
const MODE = arg('mode', 'prompt');
const SESSIONS = arg('sessions', '1');
const OUT = arg('out', path.join(__dirname, `pairs-${MODE}-${DWELL}.json`));

// Fixed, per-variant V8 compile caches, warmed before measurement, so neither
// arm is charged for first-run bytecode compilation (design doc §formal runs).
const CACHE_ROOT = path.resolve(arg('cache-root', path.join(__dirname, '.compile-cache')));
const cacheDirFor = (bundle) =>
  path.join(CACHE_ROOT, bundle === CONTROL ? 'control' : 'candidate');

async function probe(bundle) {
  const args = [
    path.join(__dirname, 'acp-probe.mjs'),
    '--bundle',
    bundle,
    '--dwell',
    DWELL,
    '--mode',
    MODE,
    '--sessions',
    SESSIONS,
    '--compile-cache',
    cacheDirFor(bundle),
  ];
  try {
    const { stdout } = await execFileAsync(process.execPath, args, {
      maxBuffer: 32 * 1024 * 1024,
    });
    const line = stdout.split('\n').find((l) => l.startsWith('@@SAMPLE@@'));
    return JSON.parse(line.slice('@@SAMPLE@@'.length));
  } catch (e) {
    const stdout = e.stdout ?? '';
    const line = String(stdout)
      .split('\n')
      .find((l) => l.startsWith('@@SAMPLE@@'));
    if (line) return JSON.parse(line.slice('@@SAMPLE@@'.length));
    return { ok: false, error: String(e.message ?? e) };
  }
}

// deterministic PRNG so the bootstrap is reproducible
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function bootstrapMedianCi(deltas, iters = 10000, seed = 7767) {
  if (deltas.length < 2) return [null, null];
  const rand = mulberry32(seed);
  const meds = [];
  for (let i = 0; i < iters; i++) {
    const s = [];
    for (let j = 0; j < deltas.length; j++) {
      s.push(deltas[(rand() * deltas.length) | 0]);
    }
    meds.push(median(s));
  }
  meds.sort((a, b) => a - b);
  const lo = meds[Math.floor(0.025 * (meds.length - 1))];
  const hi = meds[Math.ceil(0.975 * (meds.length - 1))];
  return [lo, hi];
}

const METRICS = [
  'processToSessionReadyMs',
  'sessionCreateMs',
  'promptToProviderRequestArrivalMs',
  'promptToFirstModelOutputMs',
  'processToFirstModelOutputMs',
  'promptTurnMs',
];

const run = async () => {
  const warmups = Number(arg('warmups', '2'));
  for (let i = 0; i < warmups; i++) {
    await probe(CONTROL);
    await probe(CANDIDATE);
    process.stderr.write(`warmup ${i + 1}/${warmups} done\n`);
  }
  const pairs = [];
  for (let i = 0; i < PAIRS; i++) {
    const controlFirst = i % 2 === 0;
    let control, candidate;
    if (controlFirst) {
      control = await probe(CONTROL);
      candidate = await probe(CANDIDATE);
    } else {
      candidate = await probe(CANDIDATE);
      control = await probe(CONTROL);
    }
    const valid =
      control.ok &&
      candidate.ok &&
      control.gates?.providerRequestsDuringPreloadWindow === 0 &&
      candidate.gates?.providerRequestsDuringPreloadWindow === 0 &&
      control.childExitCode === 0 &&
      candidate.childExitCode === 0 &&
      !control.gates?.unhandledRejection &&
      !candidate.gates?.unhandledRejection;
    pairs.push({ index: i, order: controlFirst ? 'AB' : 'BA', valid, control, candidate });
    process.stderr.write(
      `pair ${i + 1}/${PAIRS} ${controlFirst ? 'AB' : 'BA'} valid=${valid}` +
        (MODE === 'prompt'
          ? ` ctl=${control.metrics?.promptToProviderRequestArrivalMs?.toFixed(1)}ms cand=${candidate.metrics?.promptToProviderRequestArrivalMs?.toFixed(1)}ms`
          : '') +
        '\n',
    );
  }

  const validPairs = pairs.filter((p) => p.valid);
  const stats = {};
  for (const m of METRICS) {
    const deltas = [];
    const ab = [];
    const ba = [];
    for (const p of validPairs) {
      const c = p.control.metrics?.[m];
      const k = p.candidate.metrics?.[m];
      if (typeof c !== 'number' || typeof k !== 'number') continue;
      const d = k - c;
      deltas.push(d);
      (p.order === 'AB' ? ab : ba).push(d);
    }
    if (!deltas.length) continue;
    const [lo, hi] = bootstrapMedianCi(deltas);
    stats[m] = {
      n: deltas.length,
      controlP50: median(validPairs.map((p) => p.control.metrics[m]).filter((x) => typeof x === 'number')),
      candidateP50: median(validPairs.map((p) => p.candidate.metrics[m]).filter((x) => typeof x === 'number')),
      pairedMedianDelta: median(deltas),
      ci95: [lo, hi],
      candidateFasterIn: deltas.filter((d) => d < 0).length,
      abMedian: ab.length ? median(ab) : null,
      baMedian: ba.length ? median(ba) : null,
    };
  }

  const out = {
    mode: MODE,
    dwellMs: Number(DWELL),
    sessions: Number(SESSIONS),
    pairs: PAIRS,
    validPairs: validPairs.length,
    controlBundle: CONTROL,
    candidateBundle: CANDIDATE,
    platform: `${process.platform} ${process.arch} node ${process.version}`,
    gateSummary: {
      preloadWindowProviderRequests: pairs.reduce(
        (a, p) =>
          a +
          (p.control.gates?.providerRequestsDuringPreloadWindow ?? 0) +
          (p.candidate.gates?.providerRequestsDuringPreloadWindow ?? 0),
        0,
      ),
      unhandledRejections: pairs.filter(
        (p) => p.control.gates?.unhandledRejection || p.candidate.gates?.unhandledRejection,
      ).length,
      nonZeroExits: pairs.filter(
        (p) => p.control.childExitCode !== 0 || p.candidate.childExitCode !== 0,
      ).length,
    },
    stats,
    samples: pairs,
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  process.stderr.write(`\nwrote ${OUT}\n`);
  const summary = { ...out };
  delete summary.samples;
  console.log(JSON.stringify(summary, null, 2));
};

run();

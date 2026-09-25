#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Interleaved A/B wall-clock benchmark of fresh startup, for manual runs:
//   J1  launch until a typed key shows in the input box
//   J3  launch until the first visible glyph
//   J2  `qwen -p` launch until its first model request
//   M1  process-tree RSS when the prompt is typeable (peak RSS for `-p`)
//   S1  whether the screen changes after the prompt is typeable
//
//   node scripts/startup-benchmark/benchmark.mjs \
//     --base /tmp/base/dist/cli-entry.js --head /tmp/head/dist/cli-entry.js
//
// Lay both builds out at the same path depth; each keeps its own compile
// cache unless --cold. Linux only (RSS comes from /proc). See
// docs/design/2026-09-25-startup-benchmark-harness.md.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  makeRunEnvironment,
  quantiles,
  runHeadless,
  runInteractive,
  startModelServer,
} from './lib.mjs';

const { values: options } = parseArgs({
  options: {
    base: { type: 'string' },
    head: { type: 'string' },
    pairs: { type: 'string', default: '20' },
    warmup: { type: 'string', default: '2' },
    mode: { type: 'string', default: 'both' },
    cold: { type: 'boolean', default: false },
    'silent-terminal': { type: 'boolean', default: false },
    json: { type: 'string' },
  },
});
if (!options.base || !options.head) {
  console.error(
    'Usage: benchmark.mjs --base <cli-entry.js> --head <cli-entry.js> [--pairs N] [--mode interactive|headless|both] [--cold] [--silent-terminal] [--json file]',
  );
  process.exit(2);
}

const builds = {
  base: path.resolve(options.base),
  head: path.resolve(options.head),
};
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-startup-bench-'));
const cacheDirs = {
  base: path.join(root, 'cache-base'),
  head: path.join(root, 'cache-head'),
};
const modelServer = await startModelServer();
const modes =
  options.mode === 'both' ? ['interactive', 'headless'] : [options.mode];

async function runOnce(build, mode) {
  const run = makeRunEnvironment({
    root,
    modelServer,
    tmpDir: options.cold ? undefined : cacheDirs[build],
  });
  const args = [
    builds[build],
    ...(mode === 'headless' ? ['-p', 'say hi'] : []),
  ];
  if (mode === 'interactive') {
    return runInteractive({
      command: process.execPath,
      args,
      cwd: run.cwd,
      env: run.env,
      answerQueries: !options['silent-terminal'],
    });
  }
  const r = await runHeadless({
    command: process.execPath,
    args,
    cwd: run.cwd,
    env: run.env,
    modelServer,
    runId: run.runId,
  });
  if (r.exitCode !== 0)
    throw new Error(`${build}: qwen -p exited with ${r.exitCode}`);
  return r;
}

const metrics = {
  interactive: ['ttiMs', 'firstContentMs', 'rssMb'],
  headless: ['firstRequestMs', 'totalMs', 'peakRssMb'],
};
const report = {};
try {
  for (const mode of modes) {
    for (let i = 0; i < Number(options.warmup); i++) {
      for (const build of ['base', 'head']) await runOnce(build, mode);
    }
    const pairs = [];
    for (let i = 0; i < Number(options.pairs); i++) {
      const order = i % 2 === 0 ? ['base', 'head'] : ['head', 'base'];
      const pair = {};
      for (const build of order) pair[build] = await runOnce(build, mode);
      pairs.push(pair);
      process.stderr.write(`${mode} pair ${i + 1}/${options.pairs}\r`);
    }
    process.stderr.write('\n');
    report[mode] = { pairs };
    for (const metric of metrics[mode]) {
      const deltas = pairs.map((p) => p.head[metric] - p.base[metric]);
      report[mode][metric] = {
        base: quantiles(pairs.map((p) => p.base[metric])),
        head: quantiles(pairs.map((p) => p.head[metric])),
        pairedMedianDelta: quantiles(deltas).p50,
        headWins: deltas.filter((d) => d < 0).length,
      };
    }
    if (mode === 'interactive') {
      report[mode].screenChanged = {
        base: pairs.filter((p) => p.base.screenChanged).length,
        head: pairs.filter((p) => p.head.screenChanged).length,
      };
    }
  }
} finally {
  await modelServer.close();
  fs.rmSync(root, { recursive: true, force: true });
}

const fmt = (v, metric) =>
  metric.endsWith('Mb') ? `${v.toFixed(0)} MB` : `${v.toFixed(0)} ms`;
for (const mode of modes) {
  console.log(`\n${mode} (${options.pairs} pairs)`);
  console.log(
    'metric            base p50/p75        head p50/p75        paired Δ   head won',
  );
  for (const metric of metrics[mode]) {
    const r = report[mode][metric];
    console.log(
      `${metric.padEnd(16)}  ${`${fmt(r.base.p50, metric)} / ${fmt(r.base.p75, metric)}`.padEnd(18)}  ${`${fmt(r.head.p50, metric)} / ${fmt(r.head.p75, metric)}`.padEnd(18)}  ${fmt(r.pairedMedianDelta, metric).padStart(8)}   ${r.headWins}/${options.pairs}`,
    );
  }
  if (report[mode].screenChanged) {
    console.log(
      `screen changed after the prompt: base ${report[mode].screenChanged.base}/${options.pairs}, head ${report[mode].screenChanged.head}/${options.pairs}`,
    );
  }
}
if (options.json)
  fs.writeFileSync(
    options.json,
    JSON.stringify({ builds, options, report }, null, 2),
  );

#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Startup proxies for one build, which move only when the process chain or
// the module graph loaded at startup changes:
//   D1  Node processes started before the prompt is typeable (and for `-p`,
//       before it exits)
//   D2  bytes of JavaScript those processes opened
//
//   node scripts/startup-benchmark/proxies.mjs [--entry <cli-entry.js>] [--runs N] \
//     [--credentials shell|settings|dotenv]
//
// `--credentials settings|dotenv` moves the model key and URL from the shell
// into the settings file or `~/.qwen/.env`. Linux only: it needs strace. See
// docs/design/2026-09-25-startup-benchmark-harness.md.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  CREDENTIAL_SOURCES,
  makeRunEnvironment,
  parseStrace,
  quantiles,
  runHeadless,
  runInteractive,
  startModelServer,
} from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { values: options } = parseArgs({
  options: {
    entry: { type: 'string', default: path.join(here, '..', 'cli-entry.js') },
    runs: { type: 'string', default: '3' },
    credentials: { type: 'string', default: 'shell' },
  },
});
if (!CREDENTIAL_SOURCES.includes(options.credentials)) {
  console.error('--credentials must be shell, settings or dotenv');
  process.exit(2);
}

// Containers can ship strace without the right to trace, so try it once.
try {
  execFileSync(
    'strace',
    ['-qq', '-o', os.devNull, process.execPath, '-e', '0'],
    { stdio: 'ignore', timeout: 30_000 },
  );
} catch {
  console.error('startup proxies need Linux with a working strace');
  process.exit(1);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-startup-proxies-'));
const modelServer = await startModelServer();
const entry = path.resolve(options.entry);
const results = { interactive: [], headless: [] };
try {
  for (let i = 0; i < Number(options.runs); i++) {
    for (const mode of ['interactive', 'headless']) {
      const run = makeRunEnvironment({
        root,
        modelServer,
        credentials: options.credentials,
      });
      const trace = path.join(run.dir, 'strace.txt');
      const args = [
        '-f',
        '-qq',
        '-ttt',
        '-e',
        'trace=execve,openat',
        '-e',
        'signal=none',
        '-o',
        trace,
        process.execPath,
        entry,
        ...(mode === 'headless' ? ['-p', 'say hi'] : []),
      ];
      let cutoff = Infinity;
      if (mode === 'interactive') {
        const r = await runInteractive({
          command: 'strace',
          args,
          cwd: run.cwd,
          env: run.env,
          observeMs: 0,
        });
        cutoff = r.ttiEpochMs;
      } else {
        const r = await runHeadless({
          command: 'strace',
          args,
          cwd: run.cwd,
          env: run.env,
          modelServer,
          runId: run.runId,
        });
        if (r.exitCode !== 0) {
          throw new Error(`qwen -p exited with ${r.exitCode}`);
        }
      }
      results[mode].push(parseStrace(fs.readFileSync(trace, 'utf8'), cutoff));
    }
  }
} finally {
  await modelServer.close();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`credentials: ${options.credentials}`);
for (const mode of ['interactive', 'headless']) {
  const counts = results[mode].map((r) => r.nodeProcesses);
  const megabytes = (
    quantiles(results[mode].map((r) => r.jsBytes)).p50 / 1e6
  ).toFixed(1);
  console.log(
    `${mode.padEnd(11)}  Node processes: ${counts.join(', ')}  JS loaded (median): ${megabytes} MB`,
  );
}

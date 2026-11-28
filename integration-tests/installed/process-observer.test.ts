/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { it } from 'vitest';

// observe() forks ps/lsof on a 100ms timer while the distribution product
// boots inside a PTY. Walking only catches children that are freshly
// reparented or moved between groups, yet one probe per captured process per
// tick blocks the loop for the whole walk — and a timer on that loop, the
// runner adapter's flush in #18567, then cannot fire: the CLI paints its
// banner and never reaches its prompt. Two walks a second already come from
// the model, so the sweep interval and its probe cap are read from the source
// and the probe below measures what a tick costs.
const source = fs.readFileSync(
  path.join(__dirname, 'process-observer.ts'),
  'utf8',
);
const sweepMs = Number(/const SWEEP_MS = ([\d_]+);/.exec(source)?.[1]);
const sweepCap = Number(/const SWEEP_PROBES = ([\d_]+);/.exec(source)?.[1]);
// The distribution launcher tree: the sh launcher, npm/npx, the product and a
// pooled child apiece for a few levels, shaped like a wide npm install.
const launcherTree = 16;
const probeBudgetMs = 150;

const tsx = execFileSync(
  process.execPath,
  [
    '-e',
    "process.stdout.write(require.resolve('tsx/esm', { paths: [process.cwd()] }))",
  ],
  { encoding: 'utf8' },
);

// Runs the real observe() against a live tree: argv carries the module, the
// number of direct children and the mode. 'tick' ticks the copy's timer for
// three seconds and reports how many walks that cost; 'busy' times a single
// sweep; 'exit' shows that an exit is still recorded once the root is gone.
const probe = String.raw`
import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
const [modulePath, widthArg, mode, sweepArg] = (process.env['OBSERVER_PROBE'] ?? '').split('|');
const width = Number(widthArg);
const sweepMs = Number(sweepArg);
const { observe } = await import(pathToFileURL(modulePath).href);
const payload = [
  "const { spawn } = require('node:child_process');",
  "const kids = [];",
  "for (let i = 0; i < " + width + "; i++) {",
  "  const mid = spawn('sh', ['-c', 'sleep 60 & sleep 60'], { stdio: 'ignore' });",
  "  kids.push(mid);",
  "}",
  "process.on('SIGTERM', () => { for (const k of kids) k.kill('SIGKILL'); process.exit(0); });",
  "setTimeout(() => { for (const k of kids) k.kill('SIGKILL'); process.exit(0); }, 120000);",
].join("\n");
const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'observer-')), 'pid');
const child = spawn(process.execPath, ['-e', payload], { stdio: 'ignore', detached: true });
fs.writeFileSync(pidFile, String(child.pid));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const observer = observe(pidFile);
// Memoize cleanup WITHOUT running it: cleanup() opens with clearInterval, so
// calling it here would stop the very timer the 'tick' mode measures.
const realCleanup = observer.cleanup;
let cleaning;
observer.cleanup = () => (cleaning ??= realCleanup());
for (let i = 0; i < 60 && observer.snapshot().length < width + 1; i++) {
  observer.poll();
  await sleep(50);
}
const captured = observer.snapshot().length;
assert.ok(captured >= width + 1, 'tree observed: ' + captured);
if (mode === 'tick') {
  // sweeps, not polls: polls counts every tick, gated ones included.
  const before = observer.timing().sweeps;
  await sleep(3000);
  const after = observer.timing().sweeps;
  observer.stop();
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  console.log(JSON.stringify({ captured, sweeps: after - before }));
} else if (mode === 'busy') {
  observer.stop();
  // Open the throttle first: it is measured from the previous sweep's
  // completion, so a timed poll inside the window would time a no-op.
  await sleep(sweepMs + 50);
  const before = observer.timing().sweeps;
  const started = performance.now();
  observer.poll();
  const elapsed = Math.round(performance.now() - started);
  const swept = observer.timing().sweeps - before;
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  console.log(JSON.stringify({ captured, sweepMs: elapsed, swept }));
} else {
  const sweepsAtExit = observer.timing().sweeps;
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  // The root is gone, so the walk must stop sweeping. captured is append-only
  // on purpose (cleanup needs every row), so the count can never shrink; the
  // observable is that no further sweep runs.
  await sleep(sweepMs * 2 + 200);
  const sweepsAfterExit = observer.timing().sweeps;
  const afterExit = observer.snapshot().length;
  observer.stop();
  await observer.cleanup();
  console.log(JSON.stringify({ captured, afterExit, sweepsAtExit, sweepsAfterExit }));
}
`;

function runProbe(
  modulePath: string,
  width: number,
  mode: string,
  intervalMs = sweepMs,
) {
  const result = execFileSync(
    process.execPath,
    ['--import', tsx, '--input-type=module', '-e', probe],
    {
      cwd: __dirname,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        OBSERVER_PROBE: [
          modulePath,
          String(width),
          mode,
          String(intervalMs),
        ].join('|'),
      },
    },
  );
  return JSON.parse(result.trim().split('\n').at(-1)!) as {
    captured: number;
    sweeps?: number;
    swept?: number;
    sweepMs?: number;
    afterExit?: number;
    sweepsAtExit?: number;
    sweepsAfterExit?: number;
  };
}

function observerCopy(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-copy-'));
  fs.copyFileSync(
    path.join(__dirname, 'process-observer.ts'),
    path.join(directory, 'process-observer.ts'),
  );
  fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
  return path.join(directory, 'process-observer.ts');
}

it('keeps the launcher sweep well inside the tick it runs on', () => {
  assert.ok(Number.isInteger(sweepMs) && sweepMs >= 250, 'SWEEP_MS declared');
  assert.ok(
    Number.isInteger(sweepCap) && sweepCap >= launcherTree,
    `SWEEP_PROBES (${sweepCap}) covers the ${launcherTree}-process launcher tree`,
  );
  const facts = runProbe(observerCopy(), launcherTree / 2, 'busy');
  // The timed call must actually be a sweep: inside the throttle window it
  // would be a no-op, and the budget below would bound nothing.
  assert.equal(facts.swept, 1, 'the timed poll performed one sweep');
  assert.ok(
    facts.sweepMs! < probeBudgetMs,
    `${facts.sweepMs}ms per sweep for ${facts.captured} processes`,
  );
});

it('walks once per sweep interval, not on the 100ms tick', () => {
  const facts = runProbe(observerCopy(), 2, 'tick');
  const expected = Math.ceil(3000 / sweepMs) + 1;
  // Lower bound first: a timer that never ran (or was cleared before the
  // window) sweeps 0 times and would satisfy the upper bound alone.
  assert.ok(facts.sweeps! >= 1, 'the interval swept at all in 3s');
  assert.ok(
    facts.sweeps! <= expected,
    `${facts.sweeps} sweeps in 3s for ${facts.captured} processes, expected <= ${expected}`,
  );
});

it('stops sweeping once the root is gone', () => {
  const exited = runProbe(observerCopy(), 6, 'exit');
  assert.ok(exited.captured >= 7);
  // `captured` is append-only by construction — cleanup needs every row — so
  // its length cannot shrink and a "< before" assertion could never hold.
  assert.equal(
    exited.afterExit,
    exited.captured,
    `the exit must not add rows (${exited.afterExit} vs ${exited.captured})`,
  );
  // What is actually guaranteed: a dead root ends the sweep.
  assert.equal(
    exited.sweepsAfterExit,
    exited.sweepsAtExit,
    `the walk swept ${exited.sweepsAfterExit! - exited.sweepsAtExit!} more times after the root exited`,
  );
});

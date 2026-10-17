/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bun-leg regression for the real PTY seam.
 *
 * A fixture imports the actual `getPty.ts` source, asserts the Bun runtime
 * gets a loadable `qwen-bun-pty` backend, and runs a full PTY round-trip
 * through it: spawn, output streaming, resize, and kill/exit. This is the
 * automated form of the Desktop hang repro — under Bun, @lydell/node-pty's
 * `tty.ReadStream` dies on the first EAGAIN and no output ever arrives.
 *
 * The suite runs under vitest/Node and spawns the `bun` binary as a child
 * (BUN_TEST_BIN pins it), matching runtime-boundary.node-bun.test.ts. The
 * fixture is skipped silently when no `bun` is on PATH — pinning the shipped
 * Bun version belongs to the standalone packaging acceptance.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const bunBin = process.env['BUN_TEST_BIN'] ?? 'bun';
const bunAvailable =
  spawnSync(bunBin, ['--version'], { timeout: 15_000 }).status === 0;

const getPtyModulePath = fileURLToPath(new URL('./getPty.ts', import.meta.url));
const getPtyDistPath = fileURLToPath(
  new URL('../../dist/src/utils/getPty.js', import.meta.url),
);

const roundtripFixtureSource = `
import { loadPty } from ${JSON.stringify(getPtyModulePath)};

const result = await loadPty();
if (!result.impl) {
  console.error('loadPty returned no backend: ' + result.loadError);
  process.exit(1);
}
if (result.impl.name !== 'qwen-bun-pty') {
  console.error('unexpected backend: ' + result.impl.name);
  process.exit(1);
}
const pty = result.impl.module.spawn('/bin/sh', [], {
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env,
});
let output = '';
pty.onData((data) => { output += data; });
pty.write('echo BUN_ROUNDTRIP_OK\\n');
const deadline = Date.now() + 15_000;
while (!output.includes('BUN_ROUNDTRIP_OK') && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
if (!output.includes('BUN_ROUNDTRIP_OK')) {
  console.error('no output ever arrived from the child');
  process.exit(1);
}
pty.resize(100, 40);
pty.write('stty size\\n');
while (!output.includes('40 100') && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
if (!output.includes('40 100')) {
  console.error('resize did not reach the child terminal');
  process.exit(1);
}
let exit = null;
pty.onExit((e) => { exit = e; });
pty.kill('SIGHUP');
while (exit === null && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
if (!exit) {
  console.error('no exit event after kill');
  process.exit(1);
}
console.log(
  JSON.stringify({
    backend: result.impl.name,
    pid: typeof pty.pid === 'number' && pty.pid > 0,
    cols: pty.cols,
    rows: pty.rows,
    exit,
  }),
);
`;

// The overflow fixture is the Bun-leg regression for the bounded pause hold:
// under the real Bun runtime a paused flood past the configured cap must
// converge through exactly one structured QWEN_PTY_OUTPUT_LIMIT error, keep
// onExit reserved for real native exits, kill the child tree, release the
// master fd, replay nothing on resume, and leave the host event loop free to
// drain (the fixture never calls process.exit on its success path).
const overflowFixtureSource = `
import * as fs from 'node:fs';
import { loadPty } from ${JSON.stringify(getPtyModulePath)};

const result = await loadPty();
if (!result.impl) {
  console.error('loadPty returned no backend: ' + result.loadError);
  process.exit(1);
}
if (result.impl.name !== 'qwen-bun-pty') {
  console.error('unexpected backend: ' + result.impl.name);
  process.exit(1);
}
const LIMIT = 128 * 1024;
const errors = [];
const pty = result.impl.module.spawn(
  '/bin/sh',
  ['-c', 'yes X | head -c 2097152; sleep 30'],
  {
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: process.env,
    limits: { pausedHoldBytes: LIMIT },
  },
);
pty.on('error', (e) => {
  errors.push({
    name: e.name,
    code: e.code,
    limitKind: e.limitKind,
    limit: e.limit,
    acceptedBytes: e.acceptedBytes,
    hasUndeliveredData: e.hasUndeliveredData,
  });
});
let output = '';
let exits = 0;
pty.onData((data) => { output += data; });
pty.onExit(() => { exits += 1; });
pty.pause();
const deadline = Date.now() + 20_000;
while (errors.length === 0 && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
if (errors.length !== 1) {
  console.error('expected exactly one limit error, got ' + errors.length);
  process.exit(1);
}
const failure = errors[0];
if (
  failure.code !== 'QWEN_PTY_OUTPUT_LIMIT' ||
  failure.limitKind !== 'paused-hold-per-pty' ||
  failure.limit !== LIMIT ||
  !(failure.acceptedBytes > 0 && failure.acceptedBytes <= LIMIT) ||
  failure.hasUndeliveredData !== true
) {
  console.error('unexpected limit error: ' + JSON.stringify(failure));
  process.exit(1);
}
await new Promise((resolve) => setTimeout(resolve, 900));
if (exits !== 0) {
  console.error('onExit must stay reserved for real native exits');
  process.exit(1);
}
let fdState = 'OPEN';
try {
  fs.fstatSync(pty.fd);
} catch (e) {
  fdState = 'closed(' + (e.code || '') + ')';
}
if (fdState !== 'closed(EBADF)') {
  console.error('master fd not released: ' + fdState);
  process.exit(1);
}
let childGone = false;
while (!childGone && Date.now() < deadline) {
  try {
    process.kill(pty.pid, 0);
  } catch {
    childGone = true;
  }
  if (!childGone) await new Promise((resolve) => setTimeout(resolve, 25));
}
if (!childGone) {
  console.error('child process tree survived the limit termination');
  process.exit(1);
}
const before = output;
pty.resume();
await new Promise((resolve) => setTimeout(resolve, 300));
if (output !== before) {
  console.error('resume replayed data after the limit termination');
  process.exit(1);
}
console.log(
  JSON.stringify({ backend: result.impl.name, limitKind: failure.limitKind, exits, childGone, fd: fdState }),
);
`;

// The paused-exit fixture is the automated P1/P2 regression: a child that
// exits (or is cancelled) while the backend is paused must still deliver
// onExit exactly once, close the master fd, and — because the fixture never
// calls process.exit on its success path — leave the host event loop free to
// drain. The same fixture runs under both interpreters: under Bun through
// the qwen-bun-pty backend, under Node through the wrapper it must match.
const pausedExitFixtureSource = `
import * as fs from 'node:fs';
import { loadPty } from ${JSON.stringify(getPtyDistPath)};

const result = await loadPty();
if (!result.impl) {
  console.error('loadPty returned no backend: ' + result.loadError);
  process.exit(1);
}
const pty = result.impl.module.spawn(
  '/bin/sh',
  ['-c', 'echo READY; sleep 0.3; echo TAIL_AFTER; exit 7'],
  { cols: 80, rows: 24, cwd: process.cwd(), env: process.env },
);
let output = '';
let exits = 0;
let lastExit = null;
pty.onData((data) => { output += data; });
pty.onExit((e) => { exits += 1; lastExit = e; });
const deadline = Date.now() + 15_000;
while (!output.includes('READY') && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
pty.pause();
while (exits === 0 && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
if (exits !== 1) {
  console.error('expected exactly one exit event, got ' + exits);
  process.exit(1);
}
let fdState = 'OPEN';
try {
  fs.fstatSync(pty.fd);
} catch (e) {
  fdState = 'closed(' + (e.code || '') + ')';
}
if (fdState !== 'closed(EBADF)') {
  console.error('master fd not released: ' + fdState);
  process.exit(1);
}
console.log(
  JSON.stringify({ backend: result.impl.name, exits, exit: lastExit, fd: fdState }),
);
`;

// The toggle fixture is the automated F1 regression: pause/resume toggles
// with no gap between them land on top of in-flight master-fd reads, and the
// full stream must come out byte-exact and line-complete on every runtime.
const toggleFixtureSource = `
import { loadPty } from ${JSON.stringify(getPtyDistPath)};

const LINES = 5000;
const result = await loadPty();
if (!result.impl) {
  console.error('loadPty returned no backend: ' + result.loadError);
  process.exit(1);
}
const pty = result.impl.module.spawn(
  '/bin/sh',
  ['-c', "awk 'BEGIN{for(i=0;i<" + LINES + ";i++)print \\"LINE \\" i}'; sleep 30"],
  { cols: 80, rows: 24, cwd: process.cwd(), env: process.env },
);
let output = '';
pty.onData((data) => { output += data; });
const deadline = Date.now() + 20_000;
while (output.length === 0 && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
for (let i = 0; i < 300; i += 1) {
  pty.pause();
  pty.resume();
}
const expected =
  Array.from({ length: LINES }, (_, i) => 'LINE ' + i).join('\\r\\n') + '\\r\\n';
while (!output.includes('LINE ' + (LINES - 1)) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
pty.kill();
await new Promise((resolve) => setTimeout(resolve, 200));
const lines = output.split('\\r\\n').filter((l) => l.length > 0);
const byteExact = output === expected;
const linesComplete = lines.length === LINES &&
  lines.every((l, i) => l === 'LINE ' + i);
if (!byteExact || !linesComplete) {
  console.error(
    'stream corrupted: byteExact=' + byteExact + ' linesComplete=' +
      linesComplete + ' gotLines=' + lines.length + ' expected=' + LINES +
      ' bytes=' + output.length + '/' + expected.length,
  );
  process.exit(1);
}
console.log(
  JSON.stringify({ backend: result.impl.name, byteExact, lines: lines.length }),
);
`;

describe.skipIf(!bunAvailable || process.platform === 'win32')(
  'PTY under the real Bun runtime',
  () => {
    let tempRoot: string;
    let fixturePath: string;

    beforeEach(() => {
      tempRoot = mkdtempSync(path.join(tmpdir(), 'bun-pty-test-'));
      fixturePath = path.join(tempRoot, 'pty-fixture.mjs');
      writeFileSync(fixturePath, roundtripFixtureSource);
    });

    afterEach(() => {
      rmSync(tempRoot, { recursive: true, force: true });
    });

    it(
      'round-trips spawn, output, resize and kill through getPty()',
      { timeout: 60_000 },
      () => {
        const result = spawnSync(bunBin, [fixturePath], {
          encoding: 'utf8',
          timeout: 55_000,
        });
        if (result.status !== 0) {
          throw new Error(
            `bun PTY fixture failed (code ${result.status}):\n${result.stdout}${result.stderr}`,
          );
        }
        const parsed = JSON.parse(result.stdout.trim()) as {
          backend: string;
          pid: boolean;
          cols: number;
          rows: number;
          exit: { exitCode: number; signal?: number };
        };
        expect(parsed.backend).toBe('qwen-bun-pty');
        expect(parsed.pid).toBe(true);
        expect(parsed.cols).toBe(100);
        expect(parsed.rows).toBe(40);
        expect(parsed.exit.signal).toBe(1);
      },
    );
  },
);

describe.skipIf(!bunAvailable || process.platform === 'win32')(
  'bounded pause hold under the real Bun runtime',
  () => {
    let tempRoot: string;
    let fixturePath: string;

    beforeEach(() => {
      tempRoot = mkdtempSync(path.join(tmpdir(), 'bun-pty-overflow-test-'));
      fixturePath = path.join(tempRoot, 'pty-overflow-fixture.mjs');
      writeFileSync(fixturePath, overflowFixtureSource);
    });

    afterEach(() => {
      rmSync(tempRoot, { recursive: true, force: true });
    });

    it(
      'terminates a paused flood past the cap with one explicit structured error',
      { timeout: 60_000 },
      () => {
        const result = spawnSync(bunBin, [fixturePath], {
          encoding: 'utf8',
          timeout: 55_000,
        });
        if (result.status !== 0) {
          throw new Error(
            `overflow fixture failed (code ${result.status}):\n${result.stdout}${result.stderr}`,
          );
        }
        const parsed = JSON.parse(result.stdout.trim()) as {
          backend: string;
          limitKind: string;
          exits: number;
          childGone: boolean;
          fd: string;
        };
        expect(parsed.backend).toBe('qwen-bun-pty');
        expect(parsed.limitKind).toBe('paused-hold-per-pty');
        expect(parsed.exits).toBe(0);
        expect(parsed.childGone).toBe(true);
        expect(parsed.fd).toBe('closed(EBADF)');
        // Reaching a spawnSync result at all proves the host drained: the
        // fixture never calls process.exit on its success path.
      },
    );
  },
);

describe.skipIf(process.platform === 'win32')(
  'paused-exit lifecycle on every runtime',
  () => {
    let tempRoot: string;
    let fixturePath: string;

    beforeEach(() => {
      tempRoot = mkdtempSync(path.join(tmpdir(), 'bun-pty-pause-test-'));
      fixturePath = path.join(tempRoot, 'pty-pause-fixture.mjs');
      writeFileSync(fixturePath, pausedExitFixtureSource);
    });

    afterEach(() => {
      rmSync(tempRoot, { recursive: true, force: true });
    });

    const runtimes: Array<{ name: string; bin: string }> = [
      { name: 'node', bin: process.execPath },
    ];
    if (bunAvailable) runtimes.push({ name: 'bun', bin: bunBin });

    it.each(runtimes)(
      '$name: delivers exit once and releases the fd when paused at exit',
      { timeout: 60_000 },
      ({ bin }) => {
        const result = spawnSync(bin, [fixturePath], {
          encoding: 'utf8',
          timeout: 55_000,
        });
        if (result.status !== 0) {
          throw new Error(
            `paused-exit fixture failed under ${bin} (code ${result.status}):\n${result.stdout}${result.stderr}`,
          );
        }
        const parsed = JSON.parse(result.stdout.trim()) as {
          backend: string;
          exits: number;
          exit: { exitCode: number; signal?: number };
          fd: string;
        };
        expect(parsed.exits).toBe(1);
        expect(parsed.exit.exitCode).toBe(7);
        expect(parsed.fd).toBe('closed(EBADF)');
        // Reaching a spawnSync result at all proves the host drained: the
        // fixture never calls process.exit on its success path.
      },
    );
  },
);

describe.skipIf(process.platform === 'win32')(
  'no-gap pause/resume toggle keeps the stream byte-exact on every runtime',
  () => {
    let tempRoot: string;
    let fixturePath: string;

    beforeEach(() => {
      tempRoot = mkdtempSync(path.join(tmpdir(), 'bun-pty-toggle-test-'));
      fixturePath = path.join(tempRoot, 'pty-toggle-fixture.mjs');
      writeFileSync(fixturePath, toggleFixtureSource);
    });

    afterEach(() => {
      rmSync(tempRoot, { recursive: true, force: true });
    });

    const runtimes: Array<{ name: string; bin: string }> = [
      { name: 'node', bin: process.execPath },
    ];
    if (bunAvailable) runtimes.push({ name: 'bun', bin: bunBin });

    it.each(runtimes)(
      '$name: 300 no-gap toggles during a 5000-line flood stay byte-exact',
      { timeout: 60_000 },
      ({ bin }) => {
        const result = spawnSync(bin, [fixturePath], {
          encoding: 'utf8',
          timeout: 55_000,
        });
        if (result.status !== 0) {
          throw new Error(
            `toggle fixture failed under ${bin} (code ${result.status}):\n${result.stdout}${result.stderr}`,
          );
        }
        const parsed = JSON.parse(result.stdout.trim()) as {
          backend: string;
          byteExact: boolean;
          lines: number;
        };
        expect(parsed.byteExact).toBe(true);
        expect(parsed.lines).toBe(5000);
      },
    );
  },
);

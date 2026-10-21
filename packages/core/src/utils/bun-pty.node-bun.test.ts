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

const outputDeadline = Date.now() + 15_000;
while (!output.includes('BUN_ROUNDTRIP_OK') && Date.now() < outputDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
if (!output.includes('BUN_ROUNDTRIP_OK')) {
  console.error('timed out waiting for child output');
  process.exit(1);
}
pty.resize(100, 40);
pty.write('stty size\\n');
const resizeDeadline = Date.now() + 15_000;
while (!output.includes('40 100') && Date.now() < resizeDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
if (!output.includes('40 100')) {
  console.error('timed out waiting for resized child geometry');
  process.exit(1);
}
let exit = null;
pty.onExit((e) => { exit = e; });
pty.kill('SIGHUP');
const exitDeadline = Date.now() + 15_000;
while (exit === null && Date.now() < exitDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
if (!exit) {
  console.error('timed out waiting for native exit after kill');
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

// The park fixture is the Bun-leg regression for the bounded pause hold:
// under the real Bun runtime a paused flood past the configured cap must
// park the reads rather than fail — no error, the child alive and blocked
// on write, the hold within the cap and no longer growing, nothing
// delivered while paused — and resume() must deliver the whole stream
// without loss or duplication (the OS pty's CR jitter aside), after which
// the child exits naturally, the master fd is released, and the host event
// loop drains (the fixture never calls process.exit on its success path).
const parkFixtureSource = `
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
const LINES = 200_000;
const errors = [];
const pty = result.impl.module.spawn(
  '/bin/sh',
  ['-c', "awk 'BEGIN{for(i=0;i<" + LINES + ";i++)print \\"P\\" i}'; echo PARK_DONE"],
  {
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: process.env,
    limits: { pausedHoldBytes: LIMIT },
  },
);
pty.on('error', (e) => {
  errors.push({ name: e.name, code: e.code, message: e.message });
});
let output = '';
let exits = 0;
pty.onData((data) => { output += data; });
pty.onExit(() => { exits += 1; });
pty.pause();

const parkDeadline = Date.now() + 20_000;
while (!pty.stats.readParked && Date.now() < parkDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
if (!pty.stats.readParked) {
  console.error('timed out waiting for the paused reads to park');
  process.exit(1);
}
const heldAtPark = pty.stats.pausedBytes;
await new Promise((resolve) => setTimeout(resolve, 500));
let childAlive = true;
try {
  process.kill(pty.pid, 0);
} catch {
  childAlive = false;
}
const parked = {
  errors: errors.length,
  childAlive,
  exits,
  delivered: output.length,
  heldWithinCap: heldAtPark > 0 && heldAtPark <= LIMIT,
  heldGrew: pty.stats.pausedBytes !== heldAtPark,
  stillParked: pty.stats.readParked,
};
if (
  parked.errors !== 0 ||
  !parked.childAlive ||
  parked.exits !== 0 ||
  parked.delivered !== 0 ||
  !parked.heldWithinCap ||
  parked.heldGrew ||
  !parked.stillParked
) {
  console.error('unexpected parked state: ' + JSON.stringify(parked));
  process.exit(1);
}
pty.resume();
const exitDeadline = Date.now() + 20_000;
while (exits === 0 && Date.now() < exitDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
if (exits !== 1) {
  console.error('expected one natural exit after resume, got ' + exits);
  process.exit(1);
}
let expected = '';
for (let i = 0; i < LINES; i += 1) expected += 'P' + i + '\\r\\n';
expected += 'PARK_DONE\\r\\n';
// macOS's pty driver occasionally emits an extra CR before LF (the same
// jitter a plain script(1) probe shows), so collapse repeated CRs before LF
// rather than requiring OS-level byte identity.
const normalized = output.replace(/\\r+\\n/g, '\\r\\n');
if (normalized !== expected) {
  console.error(
    'resumed stream lost or duplicated data: got ' + output.length +
      ' chars, expected ' + expected.length,
  );
  process.exit(1);
}
if (errors.length !== 0) {
  console.error('unexpected error after resume: ' + JSON.stringify(errors));
  process.exit(1);
}
let fdState = 'OPEN';
try {
  fs.fstatSync(pty.fd);
} catch (e) {
  fdState = 'closed(' + (e.code || '') + ')';
}
console.log(
  JSON.stringify({ backend: result.impl.name, parked, exits, bytes: output.length, fd: fdState }),
);
`;

// The write-limit fixture is the Bun-leg regression for the bounded write
// queue: an input burst past the configured cap must converge through
// exactly one structured QWEN_PTY_WRITE_LIMIT error, keep onExit reserved
// for real native exits, kill the child tree, release the master fd, and
// leave the host event loop free to drain (the fixture never calls
// process.exit on its success path).
const writeLimitFixtureSource = `
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
const LIMIT = 64 * 1024;
const errors = [];
const pty = result.impl.module.spawn('/bin/sh', ['-c', 'sleep 30'], {
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env,
  limits: { writeQueueBytes: LIMIT },
});
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
let exits = 0;
pty.onExit(() => { exits += 1; });
let beforeFailure = null;
const chunk = Buffer.alloc(4096, 0x57);
for (let i = 0; i < 40 && errors.length === 0; i += 1) {
  beforeFailure = { queued: pty.stats.writeQueuedBytes, active: pty.stats.writeActive };
  pty.write(chunk);
}


const errorDeadline = Date.now() + 20_000;
while (errors.length === 0 && Date.now() < errorDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
if (errors.length === 0) {
  console.error('timed out waiting for the resource-limit error');
  process.exit(1);
}
if (errors.length !== 1) {
  console.error('expected exactly one limit error, got ' + errors.length);
  process.exit(1);
}
const failure = errors[0];
if (
  failure.code !== 'QWEN_PTY_WRITE_LIMIT' ||
  failure.limitKind !== 'write-queue-per-pty' ||
  failure.limit !== LIMIT ||
  failure.acceptedBytes !== LIMIT ||
  failure.hasUndeliveredData !== true
) {
  console.error('unexpected limit error: ' + JSON.stringify(failure));
  process.exit(1);
}
if (!beforeFailure?.active || beforeFailure.queued !== LIMIT) {
  console.error('no real in-flight queued-write witness: ' + JSON.stringify(beforeFailure));
  process.exit(1);
}
if (pty.stats.writeQueuedBytes !== 0) {
  console.error('write queue not released: ' + pty.stats.writeQueuedBytes);
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
const reapDeadline = Date.now() + 20_000;
while (!childGone && Date.now() < reapDeadline) {
  try {
    process.kill(pty.pid, 0);
  } catch {
    childGone = true;
  }
  if (!childGone) await new Promise((resolve) => setTimeout(resolve, 25));
}
if (!childGone) {
  console.error('timed out waiting for the owned PTY leader to be reaped');
  process.exit(1);
}
console.log(
  JSON.stringify({
    backend: result.impl.name,
    limitKind: failure.limitKind,
    exits,
    childGone,
    fd: fdState,
    writeQueuedBytes: pty.stats.writeQueuedBytes,
    beforeFailure,
  }),
);
`;

// The paused-exit fixture is the P1/P2 regression: a child that exits (or
// is cancelled) while the backend is paused must still deliver onExit
// exactly once, close the master fd, and — because the fixture never calls
// process.exit on its success path — leave the host event loop free to
// drain. The same fixture runs under both interpreters: under Bun through
// the qwen-bun-pty backend, under Node through the wrapper it must match.
// Bun rows run only where an interpreter is installed (BUN_TEST_BIN).
// The Node leg runs everywhere; a skipped Bun row is not compatibility evidence.
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
  ['-c', 'echo READY; sleep 1; echo TAIL_AFTER; exit 7'],
  { cols: 80, rows: 24, cwd: process.cwd(), env: process.env },
);
let output = '';
let exits = 0;
let lastExit = null;
pty.onData((data) => { output += data; });
pty.onExit((e) => { exits += 1; lastExit = e; });

const readyDeadline = Date.now() + 15_000;
while (!output.includes('READY') && Date.now() < readyDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
if (!output.includes('READY')) {
  console.error('timed out waiting for READY before pause');
  process.exit(1);
}
pty.pause();
const exitDeadline = Date.now() + 15_000;
while (exits === 0 && Date.now() < exitDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
if (exits === 0) {
  console.error('timed out waiting for the paused child exit');
  process.exit(1);
}
if (exits !== 1) {
  console.error('expected exactly one exit event, got ' + exits);
  process.exit(1);
}
// Paused-ness oracle: the tail the child writes a second before exiting is
// held while paused and discarded with the hold, so it is never delivered.
// Without this check the fixture passes even with pty.pause() deleted.
if (output.includes('TAIL_AFTER')) {
  console.error('tail was delivered — no pause was ever in effect');
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

// The toggle fixture is the F1 regression: pause/resume toggles with no gap
// between them land on top of in-flight master-fd reads, and the full stream
// must come out byte-exact and line-complete on every runtime. As above, the
// Bun leg runs only where a Bun binary is installed.
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

const readyDeadline = Date.now() + 20_000;
while (output.length === 0 && Date.now() < readyDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
if (output.length === 0) {
  console.error('timed out waiting for initial toggle output');
  pty.kill();
  await new Promise((resolve) => setTimeout(resolve, 200));
  process.exit(1);
}
for (let i = 0; i < 300; i += 1) {
  pty.pause();
  pty.resume();
}
const expected =
  Array.from({ length: LINES }, (_, i) => 'LINE ' + i).join('\\r\\n') + '\\r\\n';
const streamDeadline = Date.now() + 20_000;
while (!output.includes('LINE ' + (LINES - 1)) && Date.now() < streamDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
if (!output.includes('LINE ' + (LINES - 1))) {
  console.error('timed out waiting for the complete toggled stream');
  pty.kill();
  await new Promise((resolve) => setTimeout(resolve, 200));
  process.exit(1);
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
      tempRoot = mkdtempSync(path.join(tmpdir(), 'bun-pty-park-test-'));
      fixturePath = path.join(tempRoot, 'pty-park-fixture.mjs');
      writeFileSync(fixturePath, parkFixtureSource);
    });

    afterEach(() => {
      rmSync(tempRoot, { recursive: true, force: true });
    });

    it(
      'parks a paused flood at the cap and resumes it without loss',
      { timeout: 60_000 },
      () => {
        const result = spawnSync(bunBin, [fixturePath], {
          encoding: 'utf8',
          timeout: 55_000,
        });
        if (result.status !== 0) {
          throw new Error(
            `park fixture failed (code ${result.status}):\n${result.stdout}${result.stderr}`,
          );
        }
        const parsed = JSON.parse(result.stdout.trim()) as {
          backend: string;
          parked: { childAlive: boolean; errors: number; stillParked: boolean };
          exits: number;
          fd: string;
        };
        expect(parsed.backend).toBe('qwen-bun-pty');
        expect(parsed.parked).toMatchObject({
          childAlive: true,
          errors: 0,
          stillParked: true,
        });
        expect(parsed.exits).toBe(1);
        expect(parsed.fd).toBe('closed(EBADF)');
        // Reaching a spawnSync result at all proves the host drained: the
        // fixture never calls process.exit on its success path.
      },
    );
  },
);

describe.skipIf(!bunAvailable || process.platform === 'win32')(
  'bounded write queue under the real Bun runtime',
  () => {
    let tempRoot: string;
    let fixturePath: string;

    beforeEach(() => {
      tempRoot = mkdtempSync(path.join(tmpdir(), 'bun-pty-write-limit-test-'));
      fixturePath = path.join(tempRoot, 'pty-write-limit-fixture.mjs');
      writeFileSync(fixturePath, writeLimitFixtureSource);
    });

    afterEach(() => {
      rmSync(tempRoot, { recursive: true, force: true });
    });

    it(
      'terminates an input burst past the cap with one explicit structured error',
      { timeout: 60_000 },
      () => {
        const result = spawnSync(bunBin, [fixturePath], {
          encoding: 'utf8',
          timeout: 55_000,
        });
        if (result.status !== 0) {
          throw new Error(
            `write-limit fixture failed (code ${result.status}):\n${result.stdout}${result.stderr}`,
          );
        }
        const parsed = JSON.parse(result.stdout.trim()) as {
          backend: string;
          limitKind: string;
          exits: number;
          childGone: boolean;
          fd: string;
          writeQueuedBytes: number;
        };
        expect(parsed.backend).toBe('qwen-bun-pty');
        expect(parsed.limitKind).toBe('write-queue-per-pty');
        expect(parsed.exits).toBe(0);
        expect(parsed.childGone).toBe(true);
        expect(parsed.fd).toBe('closed(EBADF)');
        expect(parsed.writeQueuedBytes).toBe(0);
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

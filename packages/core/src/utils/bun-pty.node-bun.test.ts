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

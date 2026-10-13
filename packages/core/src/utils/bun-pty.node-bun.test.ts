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

const fixtureSource = `
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

describe.skipIf(!bunAvailable || process.platform === 'win32')(
  'PTY under the real Bun runtime',
  () => {
    let tempRoot: string;
    let fixturePath: string;

    beforeEach(() => {
      tempRoot = mkdtempSync(path.join(tmpdir(), 'bun-pty-test-'));
      fixturePath = path.join(tempRoot, 'pty-fixture.mjs');
      writeFileSync(fixturePath, fixtureSource);
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

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Same-fixture cross-runtime regression for the runtime boundary.
 *
 * One fixture script is spawned as a child under BOTH the Node interpreter
 * and Bun (when a `bun` binary is available), and the observable child
 * behaviour is asserted to match: stdio JSON framing, exit-code propagation,
 * SIGTERM handling, the Node IPC channel, and the interpreter flags the
 * entry/worker paths rely on (`--expose-gc`, `--input-type=commonjs --eval`).
 *
 * The suite itself runs under vitest/Node; the Bun leg simply spawns the
 * `bun` binary as a child, so no Bun test-runner migration is involved.
 * Without Bun on PATH (or with BUN_TEST_BIN pointing at nothing) the Bun leg
 * is skipped rather than failing — pinning the *shipped* Bun version belongs
 * to the standalone packaging acceptance, not this regression.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// argv[2] contract: 'exit' (default) exits 0 after printing the identity
// line, 'exit:<code>' exits with that code, 'stay' keeps the event loop
// alive (for signal tests). A child with an IPC channel always stays alive.
const fixtureSource = `
const runtime = process.isBun ? 'bun' : 'node';
process.stdout.write(
  JSON.stringify({
    runtime,
    bun: process.versions.bun ?? null,
    node: process.versions.node ?? null,
    hasSend: typeof process.send === 'function',
    gcType: typeof globalThis.gc,
  }) + '\\n',
);
if (typeof process.send === 'function') {
  process.on('message', (message) => {
    if (message && message.type === 'ping') {
      process.send({ type: 'pong', saw: message.type });
    }
  });
  process.send({ type: 'ready' });
}
process.on('SIGTERM', () => {
  process.stdout.write(JSON.stringify({ got: 'SIGTERM' }) + '\\n');
  process.exit(0);
});
const mode = process.argv[2] ?? 'exit';
if (mode === 'stay' || typeof process.send === 'function') {
  setInterval(() => {}, 1000);
} else {
  process.exit(Number(mode.replace('exit:', '')) || 0);
}
`;

const evalFixtureSource = `console.log(JSON.stringify({ eval: true, runtime: process.isBun ? 'bun' : 'node' }));`;

describe('runtime boundary: same fixture under node and bun', () => {
  let tempRoot: string;
  let fixturePath: string;
  const bunBin = process.env['BUN_TEST_BIN'] ?? 'bun';
  const bunAvailable =
    spawnSync(bunBin, ['--version'], { timeout: 15_000 }).status === 0;
  const runtimes: Array<'node' | 'bun'> = ['node'];
  if (bunAvailable) runtimes.push('bun');

  const interpreterFor = (runtime: 'node' | 'bun'): string =>
    runtime === 'bun' ? bunBin : (process.env['NODE_TEST_BIN'] ?? process.execPath);

  const collectIdentityLines = async (
    child: ReturnType<typeof spawn>,
  ): Promise<string[]> => {
    const lines: string[] = [];
    child.stdout!.on('data', (chunk: string | Buffer) => {
      for (const line of String(chunk).split('\n')) {
        if (line.length > 0) lines.push(line);
      }
    });
    await new Promise<void>((resolve) => {
      child.stdout!.on('data', () => {
        if (lines.length > 0) resolve();
      });
    });
    return lines;
  };

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'runtime-boundary-test-'));
    fixturePath = path.join(tempRoot, 'fixture.js');
    writeFileSync(fixturePath, fixtureSource);
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it.each(runtimes)(
    '%s: reports runtime identity over the stdio protocol',
    { timeout: 30_000 },
    (runtime) => {
      const result = spawnSync(interpreterFor(runtime), [fixturePath], {
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout.trim()) as {
        runtime: string;
        bun: string | null;
      };
      expect(parsed.runtime).toBe(runtime);
      if (runtime === 'bun') expect(parsed.bun).toBeTypeOf('string');
    },
  );

  it.each(runtimes)(
    '%s: propagates child exit codes',
    { timeout: 30_000 },
    (runtime) => {
      const result = spawnSync(
        interpreterFor(runtime),
        [fixturePath, 'exit:7'],
        { encoding: 'utf8', timeout: 30_000 },
      );
      expect(result.status).toBe(7);
    },
  );

  it.each(runtimes)(
    '%s: delivers SIGTERM to a handler and exits gracefully',
    { skip: process.platform === 'win32', timeout: 30_000 },
    async (runtime) => {
      const child = spawn(interpreterFor(runtime), [fixturePath, 'stay'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const lines = await collectIdentityLines(child);
      child.kill('SIGTERM');
      const [exitCode, signal] = await new Promise<
        [number | null, string | null]
      >((resolve) => {
        child.on('exit', (code, sig) => resolve([code, sig]));
      });
      const termLine = lines.find((line) => line.includes('SIGTERM'));
      expect(termLine).toBeDefined();
      expect(JSON.parse(termLine!)).toEqual({ got: 'SIGTERM' });
      expect(exitCode).toBe(0);
      expect(signal).toBeNull();
    },
  );

  it.each(runtimes)(
    '%s: round-trips messages over the Node IPC channel',
    { timeout: 30_000 },
    async (runtime) => {
      const child = spawn(
        interpreterFor(runtime),
        [fixturePath, 'stay'],
        { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] },
      );
      const types: string[] = [];
      child.on('message', (message) => {
        const type = (message as { type?: string }).type ?? '';
        types.push(type);
        if (type === 'ready') child.send({ type: 'ping' });
        if (type === 'pong') child.kill();
      });
      const [exitCode] = await new Promise<[number | null, string | null]>(
        (resolve) => {
          child.on('exit', (code, sig) => resolve([code, sig]));
        },
      );
      expect(types).toEqual(['ready', 'pong']);
      expect(exitCode).toBe(0);
    },
  );

  it.each(runtimes)(
    '%s: exposes gc under --expose-gc (entry child contract)',
    { timeout: 30_000 },
    (runtime) => {
      const result = spawnSync(
        interpreterFor(runtime),
        ['--expose-gc', fixturePath],
        { encoding: 'utf8', timeout: 30_000 },
      );
      expect(result.status).toBe(0);
      const identity = JSON.parse(result.stdout.trim()) as { gcType: string };
      expect(identity.gcType).toBe('function');
    },
  );

  it.each(runtimes)(
    '%s: runs --input-type=commonjs --eval (hook supervisor contract)',
    { timeout: 30_000 },
    (runtime) => {
      const result = spawnSync(
        interpreterFor(runtime),
        ['--input-type=commonjs', '--eval', evalFixtureSource],
        { encoding: 'utf8', timeout: 30_000 },
      );
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout.trim()) as {
        eval: boolean;
        runtime: string;
      };
      expect(parsed).toEqual({ eval: true, runtime });
    },
  );

  it.skipIf(!bunAvailable)(
    'bun leg records the interpreter version it ran with',
    { timeout: 30_000 },
    () => {
      const version = spawnSync(bunBin, ['--version'], {
        encoding: 'utf8',
        timeout: 15_000,
      });
      // Emitted for the run log; the shipped-version pin is asserted by the
      // standalone packaging acceptance, not here.
      console.info(
        `[runtime-boundary] bun leg ran with bun ${version.stdout.trim()}`,
      );
      expect(version.status).toBe(0);
    },
  );
});

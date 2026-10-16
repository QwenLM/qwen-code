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

import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// argv[2] contract: 'exit' (default) exits 0 after printing the identity
// line, 'exit:<code>' exits with that code, 'stay' keeps the event loop
// alive (for signal tests). A child with an IPC channel always stays alive.
const fixtureSource = `
process.on('SIGTERM', () => {
  process.stdout.write(JSON.stringify({ got: 'SIGTERM' }) + '\\n');
  process.exit(0);
});
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
    if (message && message.type === 'shutdown') process.exit(0);
    if (message && message.type === 'ping') {
      process.send({ type: 'pong', saw: message.type });
    }
  });
  process.send({ type: 'ready' });
}
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
  const bunVersionResult = spawnSync(bunBin, ['--version'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  const bunAvailable = bunVersionResult.status === 0;
  const bunVersion = bunVersionResult.stdout?.trim() ?? '';
  const runtimes: Array<'node' | 'bun'> = ['node'];
  if (bunAvailable) runtimes.push('bun');

  const interpreterFor = (runtime: 'node' | 'bun'): string =>
    runtime === 'bun'
      ? bunBin
      : (process.env['NODE_TEST_BIN'] ?? process.execPath);

  const waitForClose = (
    child: ReturnType<typeof spawn>,
    timeout = 5000,
  ): Promise<[number | null, string | null]> => {
    const onError = (error: Error) => child.emit('error', error);
    child.stdout?.on('error', onError);
    child.stderr?.on('error', onError);
    return once(child, 'close', { signal: AbortSignal.timeout(timeout) })
      .then(([code, signal]): [number | null, string | null] => [code, signal])
      .finally(() => {
        child.stdout?.off('error', onError);
        child.stderr?.off('error', onError);
      });
  };

  const cleanupChild = async (
    child: ReturnType<typeof spawn>,
  ): Promise<void> => {
    try {
      if (
        child.pid !== undefined &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        const closed = waitForClose(child, 2000);
        child.kill('SIGKILL');
        await closed;
      }
    } finally {
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (child.connected) child.disconnect();
    }
  };

  const collectIdentityLines = async (
    child: ReturnType<typeof spawn>,
  ): Promise<string[]> => {
    const lines: string[] = [];
    let pending = '';
    child.stdout!.setEncoding('utf8');
    return new Promise((resolve, reject) => {
      const done = (error?: Error) => {
        clearTimeout(timer);
        child.off('error', onError);
        child.stdout!.off('error', onError);
        child.stderr!.off('error', onError);
        child.stdout!.off('close', onClose);
        if (error) reject(error);
        else resolve(lines);
      };
      const onError = (error: Error) => done(error);
      const onClose = () =>
        done(new Error('Child closed before identity line'));
      const timer = setTimeout(
        () => done(new Error('Timed out waiting for child identity')),
        5000,
      );
      child.on('error', onError);
      child.stdout!.on('error', onError);
      child.stderr!.on('error', onError);
      child.stdout!.once('close', onClose);
      child.stdout!.on('data', (chunk: string) => {
        const complete = (pending + chunk).split('\n');
        pending = complete.pop() ?? '';
        for (const line of complete) {
          if (line.length > 0) lines.push(line);
        }
        if (lines.length > 0) done();
      });
    });
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
      try {
        const lines = await collectIdentityLines(child);
        const closed = waitForClose(child);
        child.kill('SIGTERM');
        const [exitCode, signal] = await closed;
        const termLine = lines.find((line) => line.includes('SIGTERM'));
        expect(termLine).toBeDefined();
        expect(JSON.parse(termLine!)).toEqual({ got: 'SIGTERM' });
        expect(exitCode).toBe(0);
        expect(signal).toBeNull();
      } finally {
        await cleanupChild(child);
      }
    },
  );

  it.each(runtimes)(
    '%s: round-trips messages over the Node IPC channel',
    { timeout: 30_000 },
    async (runtime) => {
      const child = spawn(interpreterFor(runtime), [fixturePath, 'stay'], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });
      try {
        const types: string[] = [];
        const closed = waitForClose(child);
        child.on('message', (message) => {
          const type = (message as { type?: string }).type ?? '';
          types.push(type);
          if (type === 'ready') child.send({ type: 'ping' });
          if (type === 'pong') child.send({ type: 'shutdown' });
        });
        const [exitCode, signal] = await closed;
        expect(types).toEqual(['ready', 'pong']);
        expect(exitCode).toBe(0);
        expect(signal).toBeNull();
      } finally {
        await cleanupChild(child);
      }
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
    `bun leg records interpreter version: ${bunVersion || 'unavailable'}`,
    { timeout: 30_000 },
    () => {
      expect(bunVersion).toMatch(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/);
      process.stdout.write(
        `[runtime-boundary] bun leg ran with bun ${bunVersion}\n`,
      );
    },
  );
});

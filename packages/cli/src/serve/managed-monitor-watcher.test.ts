/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import type {
  ChildRunSpawnSpec,
  ManagedChildRunProcess,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-supervisor.js';
import { getShellConfiguration } from '@qwen-code/qwen-code-core/utils/shell-utils.js';
import { ManagedMonitorWatcher } from './managed-monitor-watcher.js';

function fakeProcess(unitName: string): ManagedChildRunProcess & {
  child: ChildProcess;
  terminateCalls: Array<number | undefined>;
} {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  child.stdout = stdout as ChildProcess['stdout'];
  child.stderr = stderr as ChildProcess['stderr'];
  (child as unknown as { pid: number }).pid = 7373;
  const terminateCalls: Array<number | undefined> = [];
  const process = {
    unitName,
    child,
    terminateCalls,
    async terminate(graceMs?: number) {
      terminateCalls.push(graceMs);
      return { exitCode: 0, exitSignal: null };
    },
  };
  return process as unknown as ManagedChildRunProcess & {
    child: ChildProcess;
    terminateCalls: Array<number | undefined>;
  };
}

function rig() {
  const spec: { given?: ChildRunSpawnSpec } = {};
  const process = fakeProcess('qwen-mon-unit');
  const supervisor = {
    spec,
    process,
    failure: undefined as Error | undefined,
    start: vi.fn(async (given: ChildRunSpawnSpec) => {
      spec.given = given;
      if (supervisor.failure !== undefined) throw supervisor.failure;
      return supervisor.process;
    }),
  };
  const watcher = new ManagedMonitorWatcher(supervisor as unknown as never);
  const lines: string[] = [];
  const exits: boolean[] = [];
  return { supervisor, process, watcher, lines, exits };
}

describe('ManagedMonitorWatcher', () => {
  it('refuses a watch without a command', async () => {
    const { watcher } = rig();
    await expect(
      watcher.start(
        {},
        () => {},
        () => {},
      ),
    ).rejects.toThrow('watch names no command');
  });

  it('spawns under the identity unit through the supervisor', async () => {
    const { supervisor, watcher, lines, exits } = rig();
    const handle = await watcher.start(
      { command: 'tail -f build.log' },
      (line) => lines.push(line),
      (failed) => exits.push(failed),
      { unitName: 'qwen-mon-watch-1', cwd: '/workspace' },
    );
    const shell = getShellConfiguration();
    expect(supervisor.spec.given).toMatchObject({
      unitName: 'qwen-mon-watch-1',
      executable: shell.executable,
      args: [...shell.argsPrefix, 'tail -f build.log'],
      cwd: '/workspace',
    });
    expect(handle.receipt).toMatchObject({
      unitName: 'qwen-mon-watch-1',
      pid: 7373,
      started: true,
    });
    expect(exits).toEqual([]);
  });

  it('splits observations on line boundaries and flushes the tail at exit', async () => {
    const { supervisor, process, watcher, lines, exits } = rig();
    await watcher.start(
      { command: 'du -sh .' },
      (line) => lines.push(line),
      (failed) => exits.push(failed),
    );
    const onOutput = supervisor.spec.given!.onOutput;
    onOutput('stdout', Buffer.from('first par'));
    onOutput('stdout', Buffer.from('tial\nsecond\nthird-partial'));
    onOutput('stderr', Buffer.from('never an observation\n'));
    expect(lines).toEqual(['first partial', 'second']);
    process.child.emit('exit', 0, null);
    expect(lines).toEqual(['first partial', 'second', 'third-partial']);
    expect(exits).toEqual([false]);
  });

  it('keeps a rune intact across chunk ends and the capture byte-exact', async () => {
    const { supervisor, process, watcher, lines, exits } = rig();
    const chunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    await watcher.start(
      { command: 'du -sh .' },
      (line) => lines.push(line),
      (failed) => exits.push(failed),
      {
        unitName: 'qwen-mon-watch-1',
        onChunk: (stream, chunk) => {
          if (stream === 'stdout') chunks.push(chunk);
          else stderrChunks.push(chunk);
        },
      },
    );
    const onOutput = supervisor.spec.given!.onOutput;
    const cjk = Buffer.from('中');
    onOutput(
      'stdout',
      Buffer.concat([Buffer.from('first\n\n'), cjk.subarray(0, 2)]),
    );
    onOutput('stdout', Buffer.concat([cjk.subarray(2), Buffer.from('\nlast')]));
    onOutput('stderr', Buffer.from('du: cannot read\n'));
    process.child.emit('exit', 0, null);
    // Observation lines drop blanks like the Legacy emit path does; the
    // raw-hunk stream reproduces the command's stdout byte for byte, and
    // the durable capture keeps stderr too rather than sealing a discard.
    expect(lines).toEqual(['first', '中', 'last']);
    expect(Buffer.concat(chunks).toString()).toBe('first\n\n中\nlast');
    expect(Buffer.concat(stderrChunks).toString()).toBe('du: cannot read\n');
    expect(exits).toEqual([false]);
  });

  it('still ends a watch that exited before its listeners attached', async () => {
    const { supervisor, process, watcher, lines, exits } = rig();
    (process.child as unknown as { exitCode: number | null }).exitCode = 0;
    await watcher.start(
      { command: 'echo before; exit 7' },
      (line) => lines.push(line),
      (failed) => exits.push(failed),
    );
    supervisor.spec.given!.onOutput('stdout', Buffer.from('before'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(lines).toEqual(['before']);
    expect(exits).toEqual([false]);
    (process.child as unknown as { exitCode: number | null }).exitCode = null;
  });

  it('drops a partial line beyond the Legacy cap', async () => {
    const { supervisor, process, watcher, lines, exits } = rig();
    await watcher.start(
      { command: 'du -sh .' },
      (line) => lines.push(line),
      (failed) => exits.push(failed),
    );
    const onOutput = supervisor.spec.given!.onOutput;
    onOutput('stdout', Buffer.alloc(4097, 0x61));
    process.child.emit('exit', 0, null);
    expect(lines).toEqual([]);
    expect(exits).toEqual([false]);
  });

  it('reports a spawn-level error as a failed watch', async () => {
    const { process, watcher, exits } = rig();
    await watcher.start(
      { command: 'du -sh .' },
      () => {},
      (failed) => exits.push(failed),
    );
    process.child.emit('error', new Error('spawn blew up'));
    expect(exits).toEqual([true]);
  });

  it('rejects the start when the supervisor cannot prove the unit', async () => {
    const { supervisor, watcher, exits } = rig();
    supervisor.failure = new Error('could not prove membership');
    await expect(
      watcher.start(
        { command: 'du -sh .' },
        () => {},
        (failed) => exits.push(failed),
      ),
    ).rejects.toThrow('could not prove membership');
    expect(exits).toEqual([]);
  });

  it('terminates through the supervisor evidence rules', async () => {
    const { process, watcher } = rig();
    const handle = await watcher.start(
      { command: 'du -sh .' },
      () => {},
      () => {},
    );
    await handle.terminate();
    expect(process.terminateCalls).toEqual([5_000]);
  });
});

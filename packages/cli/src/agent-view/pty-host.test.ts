/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { AgentViewLaunchFile } from './protocol.js';
import {
  AgentViewLaunchConfigError,
  AgentViewPtyUnavailableError,
  BoundedOutputRing,
  checkAgentViewPtyAvailability,
  launchAgentViewPtyHost,
  validateAgentViewLaunchConfig,
  type AgentViewPtyImplementation,
  type AgentViewPtyProcess,
  type AgentViewPtySpawnOptions,
} from './pty-host.js';

describe('BoundedOutputRing', () => {
  it('retains only the newest bytes', () => {
    const ring = new BoundedOutputRing(5);

    ring.append('abc');
    ring.append('def');

    expect(ring.toString()).toBe('bcdef');
    expect(ring.totalBytes).toBe(6);
    expect(ring.retainedBytes).toBe(5);
    expect(ring.droppedBytes).toBe(1);
  });

  it('truncates oversized chunks to the tail', () => {
    const ring = new BoundedOutputRing(4);

    ring.append('123456');

    expect(ring.toString()).toBe('3456');
    expect(ring.totalBytes).toBe(6);
    expect(ring.retainedBytes).toBe(4);
  });

  it('does not retain partial UTF-8 characters when trimming', () => {
    const ring = new BoundedOutputRing(4);

    ring.append('a你b');

    expect(ring.toString()).toBe('你b');
    expect(ring.toString()).not.toContain('\uFFFD');
    expect(ring.retainedBytes).toBeLessThanOrEqual(5);
  });

  it('does not retain partial UTF-8 characters from oversized chunks', () => {
    const ring = new BoundedOutputRing(5);

    ring.append('🙂你');

    expect(ring.toString()).toBe('你');
    expect(ring.toString()).not.toContain('\uFFFD');
    expect(ring.retainedBytes).toBeLessThanOrEqual(5);
  });
});

describe('PTY availability', () => {
  it('reports injected PTY availability', async () => {
    await expect(
      checkAgentViewPtyAvailability(async () => createFakePty()),
    ).resolves.toEqual({
      available: true,
      implementationName: 'injected',
    });
  });

  it('reports missing PTY without throwing', async () => {
    await expect(
      checkAgentViewPtyAvailability(async () => null),
    ).resolves.toEqual({
      available: false,
      reason: 'missing',
    });
  });
});

describe('validateAgentViewLaunchConfig', () => {
  it('accepts a minimal launch config', () => {
    const result = validateAgentViewLaunchConfig(createLaunch());

    expect(result.ok).toBe(true);
  });

  it('rejects malformed launch config fields', () => {
    const result = validateAgentViewLaunchConfig({
      ...createLaunch(),
      argv: [],
      env: { OK: 'yes', BAD: 1 },
      terminal: { columns: 0, rows: 24 },
    });

    expect(result).toEqual({
      ok: false,
      errors: expect.arrayContaining([
        'argv must not be empty',
        'env must contain only string values',
        'terminal.columns must be a positive integer',
      ]),
    });
  });
});

describe('launchAgentViewPtyHost', () => {
  it('spawns the provided fake command in a PTY and captures output', async () => {
    const pty = createFakePty();
    const handle = await launchAgentViewPtyHost(createLaunch(), {
      pty,
      fakeCommand: ['fake-worker', '--script', 'ready'],
      maxOutputBytes: 8,
    });

    expect(pty.spawnCalls).toEqual([
      {
        file: 'fake-worker',
        args: ['--script', 'ready'],
        options: expect.objectContaining({
          cwd: '/repo',
          cols: 100,
          rows: 30,
          handleFlowControl: true,
        }),
      },
    ]);
    expect(handle.workerPid).toBe(1234);

    pty.process.emitData('hello');
    pty.process.emitData(' world');
    pty.process.emitExit({ exitCode: 0 });

    await expect(handle.exited).resolves.toEqual({ exitCode: 0 });
    expect(handle.output.toString()).toBe('lo world');
  });

  it('uses launch argv when no fake command is provided', async () => {
    const pty = createFakePty();

    await launchAgentViewPtyHost(createLaunch(), { pty });

    expect(pty.spawnCalls[0]?.file).toBe('qwen');
    expect(pty.spawnCalls[0]?.args).toEqual(['--agent-view-worker']);
  });

  it('exposes PTY write, data subscription, and resize controls', async () => {
    const pty = createFakePty();
    const handle = await launchAgentViewPtyHost(createLaunch(), { pty });
    const data: string[] = [];
    const disposable = handle.onData((chunk) => data.push(chunk));

    handle.write(Buffer.from('hello'));
    handle.resize({ columns: 120, rows: 40 });
    pty.process.emitData('output');
    disposable?.dispose();
    pty.process.emitData('ignored');

    expect(pty.process.input).toBe('hello');
    expect(pty.process.resizes).toEqual([{ columns: 120, rows: 40 }]);
    expect(data).toEqual(['output']);
  });

  it('throws a typed error when PTY is unavailable', async () => {
    await expect(
      launchAgentViewPtyHost(createLaunch(), { pty: null }),
    ).rejects.toBeInstanceOf(AgentViewPtyUnavailableError);
  });

  it('throws a typed error for invalid launch config', async () => {
    await expect(
      launchAgentViewPtyHost({ ...createLaunch(), terminal: undefined }),
    ).rejects.toBeInstanceOf(AgentViewLaunchConfigError);
  });
});

function createLaunch(): AgentViewLaunchFile {
  return {
    schemaVersion: 1,
    sessionId: 'session-1',
    argv: ['qwen', '--agent-view-worker'],
    env: { QWEN_AGENT_VIEW_WORKER: '1' },
    entrypoint: 'qwen',
    projectCwd: '/repo',
    activeCwd: '/repo',
    includeDirectories: [],
    terminal: {
      columns: 100,
      rows: 30,
    },
  };
}

function createFakePty(): AgentViewPtyImplementation & {
  process: FakePtyProcess;
  spawnCalls: Array<{
    file: string;
    args: readonly string[] | string;
    options: AgentViewPtySpawnOptions;
  }>;
} {
  const process = new FakePtyProcess();
  const spawnCalls: Array<{
    file: string;
    args: readonly string[] | string;
    options: AgentViewPtySpawnOptions;
  }> = [];

  return {
    name: 'injected',
    process,
    spawnCalls,
    module: {
      spawn(file, args, options): AgentViewPtyProcess {
        spawnCalls.push({ file, args, options });
        return process;
      },
    },
  };
}

class FakePtyProcess implements AgentViewPtyProcess {
  readonly pid = 1234;
  private dataCallbacks: Array<(data: string) => void> = [];
  private exitCallbacks: Array<
    (event: { exitCode: number; signal?: number }) => void
  > = [];
  input = '';
  resizes: Array<{ columns: number; rows: number }> = [];
  killedWith: string | undefined;

  write(data: string): void {
    this.input += data;
  }

  onData(callback: (data: string) => void) {
    this.dataCallbacks.push(callback);
    return {
      dispose: () => {
        this.dataCallbacks = this.dataCallbacks.filter(
          (item) => item !== callback,
        );
      },
    };
  }

  onExit(callback: (event: { exitCode: number; signal?: number }) => void) {
    this.exitCallbacks.push(callback);
    return {
      dispose: () => {
        this.exitCallbacks = this.exitCallbacks.filter(
          (item) => item !== callback,
        );
      },
    };
  }

  kill(signal?: string): void {
    this.killedWith = signal;
  }

  resize(columns: number, rows: number): void {
    this.resizes.push({ columns, rows });
  }

  emitData(data: string): void {
    for (const callback of this.dataCallbacks) {
      callback(data);
    }
  }

  emitExit(event: { exitCode: number; signal?: number }): void {
    for (const callback of this.exitCallbacks) {
      callback(event);
    }
  }
}

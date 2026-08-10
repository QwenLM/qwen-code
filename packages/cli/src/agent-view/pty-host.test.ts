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

  it('does not retain partial UTF-8 characters across chunks', () => {
    const ring = new BoundedOutputRing(4);

    ring.append(Buffer.from([0x41, 0xe2, 0x82]));
    ring.append(Buffer.from([0xac, 0x42, 0x43]));

    expect(ring.toString()).toBe('BC');
    expect(ring.toString()).not.toContain('\uFFFD');
    expect(ring.retainedBytes).toBeLessThanOrEqual(4);
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

  it('rejects a non-string initialPrompt', () => {
    const result = validateAgentViewLaunchConfig({
      ...createLaunch(),
      initialPrompt: 42,
    });

    expect(result).toEqual({
      ok: false,
      errors: expect.arrayContaining([
        'initialPrompt must be a string when present',
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
          cwd: '/repo/work',
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

  it('does not inherit color-disabling supervisor environment into workers', async () => {
    const pty = createFakePty();
    const originalTerm = process.env['TERM'];
    const originalNoColor = process.env['NO_COLOR'];
    const originalForceColor = process.env['FORCE_COLOR'];
    const originalCi = process.env['CI'];
    process.env['TERM'] = 'dumb';
    process.env['NO_COLOR'] = '1';
    process.env['FORCE_COLOR'] = '0';
    process.env['CI'] = '1';
    try {
      await launchAgentViewPtyHost(createLaunch(), { pty });
    } finally {
      if (originalTerm === undefined) {
        delete process.env['TERM'];
      } else {
        process.env['TERM'] = originalTerm;
      }
      if (originalNoColor === undefined) {
        delete process.env['NO_COLOR'];
      } else {
        process.env['NO_COLOR'] = originalNoColor;
      }
      if (originalForceColor === undefined) {
        delete process.env['FORCE_COLOR'];
      } else {
        process.env['FORCE_COLOR'] = originalForceColor;
      }
      if (originalCi === undefined) {
        delete process.env['CI'];
      } else {
        process.env['CI'] = originalCi;
      }
    }

    expect(pty.spawnCalls[0]?.options.name).toBe('xterm-256color');
    expect(pty.spawnCalls[0]?.options.env['TERM']).toBe('xterm-256color');
    expect(pty.spawnCalls[0]?.options.env['NO_COLOR']).toBeUndefined();
    expect(pty.spawnCalls[0]?.options.env['FORCE_COLOR']).toBeUndefined();
    expect(pty.spawnCalls[0]?.options.env['CI']).toBe('1');
  });

  it('falls back when launch TERM is empty', async () => {
    const pty = createFakePty();

    await launchAgentViewPtyHost(
      {
        ...createLaunch(),
        env: { TERM: '' },
      },
      { pty },
    );

    expect(pty.spawnCalls[0]?.options.name).toBe('xterm-256color');
    expect(pty.spawnCalls[0]?.options.env['TERM']).toBe('xterm-256color');
  });

  it('exposes PTY write, data subscription, and resize controls', async () => {
    const pty = createFakePty();
    const handle = await launchAgentViewPtyHost(createLaunch(), { pty });
    const data: string[] = [];
    const disposable = handle.onData((chunk) => data.push(chunk));

    handle.write(Buffer.from('hello '));
    handle.write(Buffer.from([0xe4, 0xbd]));
    handle.write(Buffer.from([0xa0, 0xe5, 0xa5, 0xbd]));
    handle.resize({ columns: 120, rows: 40 });
    pty.process.emitData('output');
    disposable?.dispose();
    pty.process.emitData('ignored');

    expect(pty.process.input).toBe('hello 你好');
    expect(pty.process.resizes).toEqual([{ columns: 120, rows: 40 }]);
    expect(data).toEqual(['output']);
  });

  it('passes worker env while stripping host-only secrets', async () => {
    const pty = createFakePty();
    const previousToken = process.env['QWEN_AGENT_VIEW_PTY_HOST_TOKEN'];
    const previousTerm = process.env['TERM'];
    process.env['QWEN_AGENT_VIEW_PTY_HOST_TOKEN'] = 'host-secret';
    process.env['TERM'] = 'ambient-term';
    try {
      await launchAgentViewPtyHost(createLaunch(), { pty });
    } finally {
      if (previousToken === undefined) {
        delete process.env['QWEN_AGENT_VIEW_PTY_HOST_TOKEN'];
      } else {
        process.env['QWEN_AGENT_VIEW_PTY_HOST_TOKEN'] = previousToken;
      }
      if (previousTerm === undefined) {
        delete process.env['TERM'];
      } else {
        process.env['TERM'] = previousTerm;
      }
    }

    expect(pty.spawnCalls[0]?.options.env).toEqual(
      expect.objectContaining({
        QWEN_AGENT_VIEW_WORKER: '1',
        TERM: 'xterm-256color',
      }),
    );
    expect(
      pty.spawnCalls[0]?.options.env['QWEN_AGENT_VIEW_PTY_HOST_TOKEN'],
    ).toBeUndefined();
  });

  it('kills the PTY process when disposed', async () => {
    const pty = createFakePty();
    const handle = await launchAgentViewPtyHost(createLaunch(), { pty });

    handle.dispose();

    expect(pty.process.killedWith).toBeUndefined();
    expect(pty.process.killCalls).toEqual([undefined]);
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
    activeCwd: '/repo/work',
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
  killCalls: Array<string | undefined> = [];

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
    this.killCalls.push(signal);
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

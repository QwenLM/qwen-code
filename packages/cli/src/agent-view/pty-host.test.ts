/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { AgentViewLaunchFile } from './protocol.js';
import { PTY_HOST_AUTH_TOKEN_ENV, PTY_HOST_ID_ENV } from './pty-host-env.js';
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

  it('does not retain partial UTF-8 characters when sub-capacity chunks overflow', () => {
    const ring = new BoundedOutputRing(6);

    ring.append('ab你');
    ring.append('你x');

    expect(ring.toString()).toBe('你x');
    expect(ring.toString()).not.toContain('\uFFFD');
    expect(ring.retainedBytes).toBeLessThanOrEqual(6);
  });

  it('keeps leading continuation bytes when the window never overflowed', () => {
    const ring = new BoundedOutputRing(23);

    ring.append(Buffer.from('aa35d7e816b5', 'hex'));

    expect(ring.toBuffer().toString('hex')).toBe('aa35d7e816b5');
    expect(ring.droppedBytes).toBe(0);
  });

  it('copies the retained tail of oversized chunks off the source buffer', () => {
    const ring = new BoundedOutputRing(4);
    const source = Buffer.alloc(1024, 0x61);

    ring.append(source);
    // A retained subarray view would observe this mutation.
    source.fill(0x62);

    expect(ring.toString()).toBe('aaaa');
  });

  it('coalesces small chunks while preserving the byte cap', () => {
    const ring = new BoundedOutputRing(1024 * 1024);

    for (let index = 0; index < 10_000; index++) {
      ring.append('x');
    }

    expect(ring.retainedBytes).toBe(10_000);
    expect(ring.toString()).toBe('x'.repeat(10_000));
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
  it('rejects commands containing empty segments', async () => {
    const pty = createFakePty();

    await expect(
      launchAgentViewPtyHost(createLaunch(), {
        pty,
        fakeCommand: ['fake-worker', ''],
      }),
    ).rejects.toThrow('command must contain at least one non-empty string');

    expect(pty.spawnCalls).toEqual([]);
  });

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
          handleFlowControl: false,
        }),
      },
    ]);
    expect(handle.workerPid).toBe(1234);

    pty.process.emitData('hello');
    pty.process.emitData(' world');
    pty.process.emitExit({ exitCode: 0 });

    await expect(handle.exited).resolves.toEqual({
      kind: 'exited',
      exitCode: 0,
    });
    expect(handle.output.toString()).toBe('lo world');
  });

  it('uses launch argv when no fake command is provided', async () => {
    const pty = createFakePty();

    await launchAgentViewPtyHost(createLaunch(), { pty });

    expect(pty.spawnCalls[0]?.file).toBe('qwen');
    expect(pty.spawnCalls[0]?.args).toEqual(['--agent-view-worker']);
  });

  it('does not inherit color-disabling or CI supervisor environment into workers', async () => {
    const pty = createFakePty();
    const originalTerm = process.env['TERM'];
    const originalNoColor = process.env['NO_COLOR'];
    const originalForceColor = process.env['FORCE_COLOR'];
    const originalCi = process.env['CI'];
    const originalBare = process.env['QWEN_CODE_SIMPLE'];
    process.env['TERM'] = 'dumb';
    process.env['NO_COLOR'] = '1';
    process.env['FORCE_COLOR'] = '0';
    process.env['CI'] = '1';
    process.env['QWEN_CODE_SIMPLE'] = '1';
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
      if (originalBare === undefined) {
        delete process.env['QWEN_CODE_SIMPLE'];
      } else {
        process.env['QWEN_CODE_SIMPLE'] = originalBare;
      }
    }

    expect(pty.spawnCalls[0]?.options.name).toBe('xterm-256color');
    expect(pty.spawnCalls[0]?.options.env['TERM']).toBe('xterm-256color');
    expect(pty.spawnCalls[0]?.options.env['NO_COLOR']).toBeUndefined();
    expect(pty.spawnCalls[0]?.options.env['FORCE_COLOR']).toBeUndefined();
    expect(pty.spawnCalls[0]?.options.env['CI']).toBeUndefined();
    // A --bare caller's marker in the daemon env must not silently turn
    // every background worker into bare mode.
    expect(pty.spawnCalls[0]?.options.env['QWEN_CODE_SIMPLE']).toBeUndefined();
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

  it('honours a launch-provided TERM for the pty name and worker env', async () => {
    const pty = createFakePty();

    await launchAgentViewPtyHost(
      {
        ...createLaunch(),
        env: { TERM: 'xterm-direct' },
      },
      { pty },
    );

    expect(pty.spawnCalls[0]?.options.name).toBe('xterm-direct');
    expect(pty.spawnCalls[0]?.options.env['TERM']).toBe('xterm-direct');
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
    handle.pause?.();
    handle.resume?.();
    pty.process.emitData('output');
    disposable?.dispose();
    pty.process.emitData('ignored');

    expect(pty.process.input).toBe('hello 你好');
    expect(pty.process.resizes).toEqual([{ columns: 120, rows: 40 }]);
    expect(pty.process.pauses).toBe(1);
    expect(pty.process.resumes).toBe(1);
    expect(data).toEqual(['output']);
  });

  it('passes no signal to the pty on Windows', async () => {
    const pty = createFakePty();
    const handle = await launchAgentViewPtyHost(createLaunch(), { pty });

    const original = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    try {
      handle.kill('SIGKILL');
      handle.shutdown?.();
    } finally {
      Object.defineProperty(process, 'platform', {
        value: original,
        configurable: true,
      });
    }

    expect(pty.process.killCalls).toEqual([undefined, undefined]);
  });

  it('resets the input decoder between attach sessions', async () => {
    const pty = createFakePty();
    const handle = await launchAgentViewPtyHost(createLaunch(), { pty });

    // 0xE4 0xBD are the first two bytes of U+4F60 (你); without a reset
    // they would leak into the next session as a replacement character.
    handle.write(Buffer.from([0xe4, 0xbd]));
    handle.resetInput?.();
    handle.write(Buffer.from('A'));

    expect(pty.process.input).toBe('A');
  });

  it('passes worker env while stripping host-only secrets', async () => {
    const pty = createFakePty();
    const previousToken = process.env[PTY_HOST_AUTH_TOKEN_ENV];
    const previousTerm = process.env['TERM'];
    const previousMarker = process.env['QWEN_AGENT_VIEW_AMBIENT_MARKER'];
    const previousTmux = process.env['TMUX'];
    const previousColumns = process.env['COLUMNS'];
    process.env[PTY_HOST_AUTH_TOKEN_ENV] = 'host-secret';
    process.env['TERM'] = 'ambient-term';
    process.env['QWEN_AGENT_VIEW_AMBIENT_MARKER'] = 'ambient-value';
    process.env['TMUX'] = '/tmp/tmux-501/default,123,0';
    process.env['COLUMNS'] = '200';
    try {
      await launchAgentViewPtyHost(createLaunch(), { pty });
    } finally {
      if (previousToken === undefined) {
        delete process.env[PTY_HOST_AUTH_TOKEN_ENV];
      } else {
        process.env[PTY_HOST_AUTH_TOKEN_ENV] = previousToken;
      }
      if (previousTerm === undefined) {
        delete process.env['TERM'];
      } else {
        process.env['TERM'] = previousTerm;
      }
      if (previousMarker === undefined) {
        delete process.env['QWEN_AGENT_VIEW_AMBIENT_MARKER'];
      } else {
        process.env['QWEN_AGENT_VIEW_AMBIENT_MARKER'] = previousMarker;
      }
      if (previousTmux === undefined) {
        delete process.env['TMUX'];
      } else {
        process.env['TMUX'] = previousTmux;
      }
      if (previousColumns === undefined) {
        delete process.env['COLUMNS'];
      } else {
        process.env['COLUMNS'] = previousColumns;
      }
    }

    expect(pty.spawnCalls[0]?.options.env).toEqual(
      expect.objectContaining({
        QWEN_AGENT_VIEW_WORKER: '1',
        QWEN_AGENT_VIEW_AMBIENT_MARKER: 'ambient-value',
        TERM: 'xterm-256color',
      }),
    );
    expect(
      pty.spawnCalls[0]?.options.env[PTY_HOST_AUTH_TOKEN_ENV],
    ).toBeUndefined();
    expect(pty.spawnCalls[0]?.options.env['TMUX']).toBeUndefined();
    expect(pty.spawnCalls[0]?.options.env['COLUMNS']).toBeUndefined();
  });

  it('strips host-only secrets even when the launch env re-adds them', async () => {
    const pty = createFakePty();

    await launchAgentViewPtyHost(
      {
        ...createLaunch(),
        env: {
          QWEN_AGENT_VIEW_WORKER: '1',
          [PTY_HOST_AUTH_TOKEN_ENV]: 'injected-token',
          [PTY_HOST_ID_ENV]: 'injected-host-id',
          TMUX: '/tmp/tmux-501/default,456,0',
          TMUX_PANE: '%1',
          STY: '12345.pts-0.host',
          WINDOW: '2',
          WINDOWID: '77594631',
          TERMCAP: 'SC|screen|VT 100/ANSI X3.64 virtual terminal',
          COLUMNS: '80',
          LINES: '60',
        },
      },
      { pty },
    );

    expect(pty.spawnCalls[0]?.options.env).toEqual(
      expect.objectContaining({ QWEN_AGENT_VIEW_WORKER: '1' }),
    );
    for (const key of [
      PTY_HOST_AUTH_TOKEN_ENV,
      PTY_HOST_ID_ENV,
      'TMUX',
      'TMUX_PANE',
      'STY',
      'WINDOW',
      'WINDOWID',
      'TERMCAP',
      'COLUMNS',
      'LINES',
    ]) {
      expect(pty.spawnCalls[0]?.options.env[key]).toBeUndefined();
    }
  });

  it('strips the inherited sideband identity but honors the launch env', async () => {
    const pty = createFakePty();
    const savedEnv: Record<string, string | undefined> = {};
    const outerKeys = [
      'QWEN_AGENT_VIEW_WORKER',
      'QWEN_AGENT_VIEW_SESSION_ID',
      'QWEN_AGENT_VIEW_SIDEBAND',
      'QWEN_AGENT_VIEW_TOKEN',
      'QWEN_AGENT_VIEW_ACTIVE_CWD',
    ];
    for (const key of outerKeys) {
      savedEnv[key] = process.env[key];
      process.env[key] = `outer-${key}`;
    }
    try {
      await launchAgentViewPtyHost(
        {
          ...createLaunch(),
          env: {
            QWEN_AGENT_VIEW_WORKER: '1',
            QWEN_AGENT_VIEW_TOKEN: 'inner-token',
          },
        },
        { pty },
      );
    } finally {
      for (const key of outerKeys) {
        if (savedEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = savedEnv[key];
        }
      }
    }

    const env = pty.spawnCalls[0]?.options.env ?? {};
    expect(env['QWEN_AGENT_VIEW_TOKEN']).toBe('inner-token');
    expect(env['QWEN_AGENT_VIEW_WORKER']).toBe('1');
    expect(env['QWEN_AGENT_VIEW_SESSION_ID']).toBeUndefined();
    expect(env['QWEN_AGENT_VIEW_SIDEBAND']).toBeUndefined();
    expect(env['QWEN_AGENT_VIEW_ACTIVE_CWD']).toBeUndefined();
  });

  it('lets the launch env override inherited process env values', async () => {
    const pty = createFakePty();
    const key = 'QWEN_AGENT_VIEW_MERGE_TEST';
    const previous = process.env[key];
    process.env[key] = 'inherited';
    try {
      await launchAgentViewPtyHost(
        { ...createLaunch(), env: { [key]: 'from-launch' } },
        { pty },
      );
    } finally {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }

    expect(pty.spawnCalls[0]?.options.env[key]).toBe('from-launch');
  });

  it('spawns the PTY with an explicit xterm-256color terminal name', async () => {
    const pty = createFakePty();

    await launchAgentViewPtyHost(createLaunch(), { pty });

    // node-pty overrides env.TERM with the spawn name, so both must agree.
    expect(pty.spawnCalls[0]?.options.name).toBe('xterm-256color');
    expect(pty.spawnCalls[0]?.options.env['TERM']).toBe('xterm-256color');
  });

  it('strips an inherited sideband token the launch env does not replace', async () => {
    const pty = createFakePty();
    const previous = process.env['QWEN_AGENT_VIEW_TOKEN'];
    process.env['QWEN_AGENT_VIEW_TOKEN'] = 'outer-token';
    try {
      await launchAgentViewPtyHost(createLaunch(), { pty });
    } finally {
      if (previous === undefined) {
        delete process.env['QWEN_AGENT_VIEW_TOKEN'];
      } else {
        process.env['QWEN_AGENT_VIEW_TOKEN'] = previous;
      }
    }

    expect(
      pty.spawnCalls[0]?.options.env['QWEN_AGENT_VIEW_TOKEN'],
    ).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')(
    'passes kill signals through to the PTY process',
    async () => {
      const pty = createFakePty();
      const handle = await launchAgentViewPtyHost(createLaunch(), { pty });

      handle.kill('SIGKILL');

      expect(pty.process.killCalls).toEqual(['SIGKILL']);
    },
  );

  it('stops capturing output after dispose', async () => {
    const pty = createFakePty();
    const handle = await launchAgentViewPtyHost(createLaunch(), { pty });
    pty.process.emitData('before');

    handle.dispose();
    pty.process.emitData('leak');

    expect(handle.output.toString()).toBe('before');
  });

  it('kills the PTY process when disposed', async () => {
    const pty = createFakePty();
    const handle = await launchAgentViewPtyHost(createLaunch(), { pty });

    handle.dispose();

    expect(pty.process.killedWith).toBe(
      process.platform === 'win32' ? undefined : 'SIGTERM',
    );
    expect(pty.process.killCalls).toEqual(
      process.platform === 'win32' ? [undefined] : ['SIGTERM'],
    );
    await expect(handle.exited).resolves.toEqual({ kind: 'unreachable' });
  });

  it.skipIf(process.platform === 'win32')(
    'gracefully shuts down the PTY process with SIGTERM',
    async () => {
      const pty = createFakePty();
      const handle = await launchAgentViewPtyHost(createLaunch(), { pty });

      handle.shutdown?.();

      expect(pty.process.killedWith).toBe('SIGTERM');
    },
  );

  it('loads PTY through the configured loader', async () => {
    const pty = createFakePty();
    const handle = await launchAgentViewPtyHost(createLaunch(), {
      loadPty: async () => pty,
    });

    expect(handle.workerPid).toBe(1234);
    expect(pty.spawnCalls).toHaveLength(1);
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
  pauses = 0;
  resumes = 0;

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

  pause(): void {
    this.pauses += 1;
  }

  resume(): void {
    this.resumes += 1;
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

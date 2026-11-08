/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yargs from 'yargs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  minimal: vi.fn(),
  legacy: vi.fn(),
  probe: vi.fn(),
  execute: vi.fn(),
  stdout: vi.fn(),
  stderr: vi.fn(),
}));
vi.mock('../config/settings.js', () => ({
  loadSettings: mocks.settings,
  createMinimalSettings: mocks.minimal,
}));
vi.mock('../config/sandboxConfig.js', () => ({
  loadSandboxConfig: mocks.legacy,
}));
vi.mock('../config/execution-sandbox-config.js', () => ({
  createExecutionSandboxPolicy: (policy: object, workspace: string) => ({
    ...policy,
    requestedBackend: 'auto',
    workspace,
    state: '/state',
    installation: '/install',
  }),
}));
vi.mock('@qwen-code/qwen-code-core/sandbox/runtime-shell-policy.js', () => ({
  admitShellSandbox: (params: { shellExecutionSandbox: unknown }) =>
    params.shellExecutionSandbox,
  probeShellSandbox: mocks.probe,
}));
vi.mock('@qwen-code/qwen-code-core/sandbox/execute-sandbox.js', () => ({
  executeSandbox: mocks.execute,
}));
vi.mock('../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mocks.stdout,
  writeStderrLine: mocks.stderr,
}));
import { sandboxCommand } from './sandbox.js';
const configured = {
  tools: {
    executionSandbox: { filesystem: 'workspace-write', network: 'closed' },
  },
};
async function run(args: Record<string, unknown> = {}) {
  await (sandboxCommand.handler as (argv: unknown) => Promise<void>)({
    _: ['sandbox'],
    $0: 'qwen',
    ...args,
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  for (const key of [
    'SANDBOX',
    'QWEN_SANDBOX',
    'QWEN_SANDBOX_NET',
    'QWEN_SANDBOX_PROXY_COMMAND',
    'PROXY_COMMAND',
    'QWEN_CODE_SIMPLE',
  ])
    vi.stubEnv(key, undefined);
  mocks.settings.mockReturnValue({ merged: configured });
  mocks.minimal.mockReturnValue({ merged: configured });
  mocks.legacy.mockResolvedValue(undefined);
  mocks.probe.mockImplementation(async (policy: object) => ({
    ...policy,
    effectiveBackend: 'bwrap',
    enforcement: 'full',
  }));
  mocks.execute.mockResolvedValue({
    result: Promise.resolve({ exitCode: 42, error: null, aborted: false }),
  });
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});
describe('qwen sandbox tool boundary', () => {
  it.each([
    [[], undefined],
    [['--sandbox'], true],
    [['-s'], true],
    [['--sandbox', 'Docker'], 'docker'],
    [['-s', 'PODMAN'], 'podman'],
    [['--sandbox=FALSE'], false],
    [['--sandbox', '1'], true],
    [['--sandbox', '0'], false],
    [['--sandbox', 'docker', '-s', 'PODMAN'], 'podman'],
  ])('normalizes diagnostic selections %j to %s', async (flags, expected) => {
    mocks.settings.mockReturnValue({ merged: {} });
    await yargs(['sandbox', ...flags])
      .command(sandboxCommand)
      .exitProcess(false)
      .parseAsync();
    expect(mocks.legacy).toHaveBeenCalledOnce();
    expect(mocks.legacy.mock.calls[0]?.[0]).toEqual({});
    expect(mocks.legacy.mock.calls[0]?.[1].sandbox).toBe(expected);
    expect(process.exitCode).toBeUndefined();
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('reports actual scope and probes without running a user payload', async () => {
    await run();
    expect(mocks.stdout.mock.calls.flat().join('\n')).toContain(
      'Boundary: tools; backend: auto → bwrap (full)',
    );
    expect(mocks.stdout.mock.calls.flat().join('\n')).toContain(
      'traffic stay on the host',
    );
    expect(mocks.probe).toHaveBeenCalledOnce();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('does not run an unconfined payload when no policy is configured', async () => {
    mocks.settings.mockReturnValue({ merged: {} });
    await run({ '--': ['touch', '/outside'] });
    expect(process.exitCode).toBe(1);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('does not replay a payload after the backend probe fails', async () => {
    mocks.probe.mockRejectedValueOnce(new Error('fixture userns unavailable'));
    await run({ '--': ['touch', '/outside'] });
    expect(process.exitCode).toBe(1);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('reports an unusable host TMPDIR before attempting the backend probe', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-tmpdir-'));
    const temporaryRoot = path.join(root, 'not-a-directory');
    fs.writeFileSync(temporaryRoot, 'ordinary file');
    for (const key of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(key, temporaryRoot);
    try {
      await run({ verify: true });
      expect(process.exitCode).toBe(1);
      expect(mocks.stderr.mock.calls.flat().join('\n')).toContain(
        `host temporary directory ${temporaryRoot}`,
      );
      expect(mocks.stderr.mock.calls.flat().join('\n')).toContain(
        'Check TMPDIR and its permissions',
      );
      expect(mocks.probe).not.toHaveBeenCalled();
      expect(mocks.execute).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it.each(['SANDBOX', 'QWEN_SANDBOX'])(
    'migrates legacy %s without probing or launching',
    async (key) => {
      vi.stubEnv(key, 'bwrap');
      await run({ '--': ['touch', '/outside'] });
      expect(mocks.stderr.mock.calls.flat().join('\n')).toContain(
        'Whole-CLI bwrap has been removed',
      );
      expect(process.exitCode).toBe(52);
      expect(mocks.probe).not.toHaveBeenCalled();
      expect(mocks.execute).not.toHaveBeenCalled();
    },
  );
  it('reports inherited whole-CLI state separately from tool confinement', async () => {
    mocks.settings.mockReturnValue({ merged: {} });
    vi.stubEnv('SANDBOX', 'docker');
    await run();
    expect(mocks.stdout.mock.calls.flat().join('\n')).toContain(
      'Tool execution sandbox: none (inherited whole-CLI marker: docker)',
    );
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('retains the operator policy in bare mode', async () => {
    await run({ bare: true });
    expect(mocks.minimal).toHaveBeenCalledOnce();
    expect(mocks.settings).not.toHaveBeenCalled();
    expect(mocks.probe).toHaveBeenCalledOnce();
  });
  it('preserves literal argv after yargs parsing and child exit status', async () => {
    await yargs([
      'sandbox',
      'printf',
      '--',
      '%s',
      '1e5',
      '0x10',
      'space separated',
      '$(touch /outside)',
    ])
      .command(sandboxCommand)
      .exitProcess(false)
      .parseAsync();
    expect(mocks.execute.mock.calls[0]?.[1]).toMatchObject({
      executable: '/usr/bin/env',
      args: [
        '--',
        'printf',
        '%s',
        '1e5',
        '0x10',
        'space separated',
        '$(touch /outside)',
      ],
    });
    expect(process.exitCode).toBe(42);
    expect(mocks.stdout).not.toHaveBeenCalled();
  });
  it('inherits redirected stdin and preserves byte-exact output', async () => {
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk, callback) => {
        if (typeof callback === 'function')
          (callback as (error?: Error | null) => void)();
        return true;
      });
    mocks.execute.mockImplementationOnce(
      async (_policy, _payload, onOutput: (event: object) => void) => {
        onOutput({
          type: 'raw_data',
          chunk: Buffer.from([0xff, 0x00]),
          stream: 'stdout',
        });
        return {
          result: Promise.resolve({
            exitCode: 0,
            error: null,
            aborted: false,
          }),
        };
      },
    );

    await run({ '--': ['cat'] });

    expect(mocks.execute.mock.calls[0]?.[1]).toMatchObject({
      inheritStdin: true,
    });
    expect(mocks.execute.mock.calls[0]?.[6]).toEqual({
      streamStdout: true,
      streamRawOutput: true,
    });
    expect(write.mock.calls[0]?.[0]).toEqual(Buffer.from([0xff, 0x00]));
  });
  it('aborts the confined command when a downstream reader closes', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(false);
    mocks.execute.mockImplementationOnce(
      async (
        _policy,
        _payload,
        onOutput: (event: object) => void,
        signal: AbortSignal,
      ) => {
        onOutput({
          type: 'raw_data',
          chunk: Buffer.from('payload'),
          stream: 'stdout',
        });
        return {
          result: new Promise((resolve) => {
            signal.addEventListener(
              'abort',
              () =>
                resolve({
                  exitCode: null,
                  error: null,
                  aborted: true,
                }),
              { once: true },
            );
          }),
        };
      },
    );
    const completion = run({ '--': ['yes'] });
    await vi.waitFor(() => expect(write).toHaveBeenCalled());

    process.stdout.emit(
      'error',
      Object.assign(new Error('broken pipe'), { code: 'EPIPE' }),
    );

    await completion;
    expect(mocks.execute.mock.calls[0]?.[3].aborted).toBe(true);
    expect(process.exitCode).toBe(141);
    expect(mocks.stderr.mock.calls.flat().join('\n')).not.toContain('EPIPE');
  });
  it('preserves EPIPE exit status when the payload finishes before the final write fails', async () => {
    const error = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
    vi.spyOn(process.stdout, 'write').mockImplementation((_chunk, callback) => {
      if (typeof callback === 'function')
        queueMicrotask(() => {
          (callback as (error?: Error | null) => void)(error);
          process.stdout.emit('error', error);
        });
      return false;
    });
    mocks.execute.mockImplementationOnce(
      async (_policy, _payload, onOutput: (event: object) => void) => {
        onOutput({
          type: 'raw_data',
          stream: 'stdout',
          chunk: Buffer.from('tail'),
        });
        return {
          result: Promise.resolve({ exitCode: 0, error: null, aborted: false }),
        };
      },
    );
    await run({ '--': ['printf', 'tail'] });
    expect(process.exitCode).toBe(141);
  });

  it('waits for redirected output backpressure before completing', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(false);
    mocks.execute.mockImplementationOnce(
      async (_policy, _payload, onOutput: (event: object) => void) => {
        onOutput({
          type: 'raw_data',
          chunk: Buffer.from('payload'),
          stream: 'stdout',
        });
        return {
          result: Promise.resolve({
            exitCode: 0,
            error: null,
            aborted: false,
          }),
        };
      },
    );
    let completed = false;
    const completion = run({ '--': ['printf', 'payload'] }).then(() => {
      completed = true;
    });
    await vi.waitFor(() => expect(write).toHaveBeenCalled());
    await Promise.resolve();
    expect(completed).toBe(false);
    const callback = write.mock.calls.at(-1)?.[1];
    if (typeof callback !== 'function')
      throw new Error('missing flush callback');
    (callback as (error?: Error | null) => void)();
    await completion;
    expect(completed).toBe(true);
  });
  it('restores signal listeners after failure', async () => {
    const signals = ['SIGINT', 'SIGTERM'] as const;
    const before = signals.map((signal) => process.listeners(signal));
    mocks.execute.mockRejectedValueOnce(new Error('fixture launch failure'));
    await run({ '--': ['false'] });
    for (const [index, signal] of signals.entries())
      expect(process.listeners(signal)).toEqual(before[index]);
    expect(process.exitCode).toBe(1);
  });
  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)(
    'fences accepted output after %s cancellation',
    async (signal, code) => {
      const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(false);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(false);
      mocks.execute.mockImplementationOnce(
        async (_policy, _payload, onOutput: (event: object) => void) => {
          for (const stream of ['stdout', 'stderr'])
            onOutput({ type: 'raw_data', stream, chunk: Buffer.from('tail') });
          process.emit(signal);
          return {
            result: Promise.resolve({
              aborted: true,
              exitCode: null,
              error: null,
            }),
          };
        },
      );
      let completed = false;
      const completion = run({ '--': ['fixture'] }).then(() => {
        completed = true;
      });
      await vi.waitFor(() => expect(stdout.mock.calls).toHaveLength(2));
      expect(completed).toBe(false);
      const finish = (write: typeof stdout) => {
        const callback = write.mock.calls.at(-1)?.[1];
        if (typeof callback !== 'function')
          throw new Error('missing flush callback');
        (callback as (error?: Error | null) => void)();
      };
      finish(stdout);
      await Promise.resolve();
      expect(completed).toBe(false);
      finish(stderr);
      await completion;
      expect(process.exitCode).toBe(code);
    },
  );
  it('drains valid stderr after stdout closes, including after cancellation', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(false);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(false);
    mocks.execute.mockImplementationOnce(
      async (_policy, _payload, onOutput: (event: object) => void) => {
        for (const stream of ['stdout', 'stderr'])
          onOutput({ type: 'raw_data', stream, chunk: Buffer.from('tail') });
        process.emit('SIGINT');
        process.stdout.emit(
          'error',
          Object.assign(new Error('broken pipe'), { code: 'EPIPE' }),
        );
        return {
          result: Promise.resolve({
            aborted: true,
            exitCode: null,
            error: null,
          }),
        };
      },
    );
    let completed = false;
    const completion = run({ '--': ['fixture'] }).then(() => {
      completed = true;
    });
    await vi.waitFor(() => expect(stderr.mock.calls).toHaveLength(2));
    expect(stdout.mock.calls).toHaveLength(1);
    expect(completed).toBe(false);
    const callback = stderr.mock.calls.at(-1)?.[1];
    if (typeof callback !== 'function')
      throw new Error('missing stderr flush callback');
    (callback as (error?: Error | null) => void)();
    await completion;
    expect(process.exitCode).toBe(141);
  });
  it('forwards cancellation to the confined execution only', async () => {
    let done: (value: object) => void;
    mocks.execute.mockResolvedValueOnce({
      result: new Promise((resolve) => {
        done = resolve;
      }),
    });
    const completion = run({ '--': ['sleep', '99'] });
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
    process.emit('SIGINT');
    expect(mocks.execute.mock.calls[0]?.[3].aborted).toBe(true);
    done!({ aborted: true, exitCode: null, error: null });
    await completion;
    expect(process.exitCode).toBe(130);
  });
});

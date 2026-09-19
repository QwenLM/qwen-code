/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yargs from 'yargs';
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
  it.each(['SANDBOX', 'QWEN_SANDBOX'])(
    'migrates legacy %s without probing or launching',
    async (key) => {
      vi.stubEnv(key, 'bwrap');
      await run({ '--': ['touch', '/outside'] });
      expect(mocks.stderr.mock.calls.flat().join('\n')).toContain(
        'Whole-CLI bwrap has been removed',
      );
      expect(process.exitCode).toBe(1);
      expect(mocks.probe).not.toHaveBeenCalled();
      expect(mocks.execute).not.toHaveBeenCalled();
    },
  );
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
  it('restores signal listeners after failure', async () => {
    const signals = ['SIGINT', 'SIGTERM'] as const;
    const before = signals.map((signal) => process.listeners(signal));
    mocks.execute.mockRejectedValueOnce(new Error('fixture launch failure'));
    await run({ '--': ['false'] });
    for (const [index, signal] of signals.entries())
      expect(process.listeners(signal)).toEqual(before[index]);
    expect(process.exitCode).toBe(1);
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

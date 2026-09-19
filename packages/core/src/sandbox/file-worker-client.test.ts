/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeSandboxFile } from './file-worker-client.js';
import { executeSandbox } from './execute-sandbox.js';
import type { SandboxExecutionResult } from './sandbox-execution.js';
import { readSandboxWriteRequest } from './file-worker-protocol.js';
import { Readable } from 'node:stream';

vi.mock('./execute-sandbox.js', () => ({
  executeSandbox: vi.fn(),
}));
vi.mock('./sandbox-execution.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sandbox-execution.js')>()),
  sandboxAsset: () => '/installed/file-worker.js',
}));
const policy = {
  workspace: '/workspace',
  installation: '/installation',
  state: '/state',
  filesystem: 'workspace-write' as const,
  network: 'closed' as const,
  effectiveBackend: 'bwrap' as const,
  enforcement: 'full' as const,
};
const request = {
  operation: 'write' as const,
  destination: '/workspace/file',
  expected: null,
  content: Buffer.from([0, 0xff, 10]),
};
function result(
  overrides: Partial<SandboxExecutionResult> = {},
  reply = '{"ok":true}',
  diagnostics = '',
) {
  vi.mocked(executeSandbox).mockImplementation(async (...args) => {
    args[2]({ type: 'data', chunk: reply, stream: 'stdout' });
    if (diagnostics)
      args[2]({ type: 'data', chunk: diagnostics, stream: 'stderr' });
    return {
      pid: 1,
      settled: Promise.resolve({ state: 'confirmed', exitCode: 0 }),
      result: Promise.resolve({
        output: '{"ok":true}',
        exitCode: 0,
        signal: null,
        error: null,
        aborted: false,
        pid: 1,
        executionMethod: 'child_process',
        sandboxStatus: { state: 'confirmed', exitCode: 0 },
        ...overrides,
      } as SandboxExecutionResult),
    };
  });
}
describe('sandbox file worker client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    result();
  });
  it('uses only pipe stdin and accepts a confirmed successful reply', async () => {
    await writeSandboxFile(policy, request, new AbortController().signal);
    const launch = vi.mocked(executeSandbox).mock.calls[0][1];
    expect(launch.args).toEqual(['/installed/file-worker.js']);
    expect(launch.env).toEqual({ PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' });
    expect(vi.mocked(executeSandbox).mock.calls[0][6]).toEqual({
      streamStdout: true,
    });
    expect(
      await readSandboxWriteRequest(Readable.from([launch.stdin])),
    ).toEqual(request);
  });
  it('accepts a confirmed successful write despite display-channel noise', async () => {
    result({ output: 'node warning on stderr' });
    await expect(
      writeSandboxFile(policy, request, new AbortController().signal),
    ).resolves.toBeUndefined();
  });
  it('reports a confirmed nonzero exit before parsing an invalid reply', async () => {
    result(
      {
        exitCode: 1,
        sandboxStatus: { state: 'confirmed', exitCode: 1 },
        output: 'worker terminated before replying',
      },
      '',
    );
    await expect(
      writeSandboxFile(policy, request, new AbortController().signal),
    ).rejects.toThrow(
      'Sandbox file worker exited 1: worker terminated before replying',
    );
  });
  it('preserves transport errors together with bounded stderr diagnostics', async () => {
    result(
      {
        sandboxStatus: { state: 'unconfirmed' },
        error: new Error('spawn denied'),
      },
      '',
      'bwrap: permission denied',
    );
    await expect(
      writeSandboxFile(policy, request, new AbortController().signal),
    ).rejects.toThrow('spawn denied\nbwrap: permission denied');
  });
  it('forwards the caller abort signal and stays on the pipe transport', async () => {
    const signal = new AbortController().signal;
    await writeSandboxFile(policy, request, signal);
    const call = vi.mocked(executeSandbox).mock.calls[0];
    // The caller's signal is the only cancellation path for a sandboxed
    // write; swapping it for a fresh controller lets a cancelled write run
    // to completion and commit after the caller gave up (PR #12067 review).
    expect(call[3]).toBe(signal);
    // The wire protocol frames the request on stdin; a PTY would merge the
    // reply into a terminal stream.
    expect(call[4] ?? false).toBe(false);
  });
  it.each(['ESTALE', 'EACCES', 'ENOSPC'])(
    'preserves worker error code %s',
    async (code) => {
      result(
        {
          exitCode: 1,
          sandboxStatus: { state: 'confirmed', exitCode: 1 },
          output: JSON.stringify({ ok: false, code, error: 'worker failure' }),
        },
        JSON.stringify({ ok: false, code, error: 'worker failure' }),
        'node warning',
      );
      await expect(
        writeSandboxFile(policy, request, new AbortController().signal),
      ).rejects.toMatchObject({ code });
      expect(executeSandbox).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    { sandboxStatus: { state: 'unconfirmed' as const } },
    { sandboxStatus: { state: 'interrupted' as const } },
    {
      sandboxStatus: { state: 'confirmed' as const, exitCode: 1 },
      exitCode: 1,
    },
  ])(
    'rejects ambiguous or unsuccessful completion without replay',
    async (overrides) => {
      result(overrides);
      await expect(
        writeSandboxFile(policy, request, new AbortController().signal),
      ).rejects.toThrow();
      expect(executeSandbox).toHaveBeenCalledTimes(1);
    },
  );
  it('rejects read-only and pre-aborted requests before launching', async () => {
    await expect(
      writeSandboxFile(
        { ...policy, filesystem: 'read-only' },
        request,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'EROFS' });
    const ac = new AbortController();
    ac.abort(new Error('stopped'));
    await expect(writeSandboxFile(policy, request, ac.signal)).rejects.toThrow(
      'stopped',
    );
    expect(executeSandbox).not.toHaveBeenCalled();
  });
});

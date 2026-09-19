/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatSshWorkspaceUrl,
  parseSshWorkspaceUrl,
  quoteSshArgument,
  sshCommand,
  SshWorkspaceClient,
} from './ssh-workspace.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: vi.fn(() => true),
  });
  return child;
}

describe('SSH workspace addresses and command construction', () => {
  it('round trips an SSH config alias with a user, port and encoded path', () => {
    const workspace = parseSshWorkspaceUrl(
      'ssh://dev@work-alias:2222/home/dev/a%20b/%E4%BD%A0%E5%A5%BD',
    );
    expect(workspace).toEqual({
      host: 'dev@work-alias',
      port: 2222,
      directory: '/home/dev/a b/你好',
    });
    expect(formatSshWorkspaceUrl(workspace)).toBe(
      'ssh://dev@work-alias:2222/home/dev/a%20b/%E4%BD%A0%E5%A5%BD',
    );
    expect(parseSshWorkspaceUrl('ssh://user@[::1]/project')).toEqual({
      host: 'user@::1',
      directory: '/project',
    });
    expect(
      formatSshWorkspaceUrl({ host: 'user@::1', directory: '/project' }),
    ).toBe('ssh://user@[::1]/project');
  });

  it.each([
    'file:///project',
    'ssh://host',
    'ssh://user:password@host/project',
    'ssh://user:@host/project',
    'ssh://@host/project',
    'ssh://host/project?token=value',
    'ssh://host/project#fragment',
    'ssh://-oProxyCommand=bad/project',
    'ssh://host\n/project',
    'ssh://user%20-oProxyCommand@host/project',
    'ssh://host/project%00name',
    'ssh://host:65536/project',
    'ssh://host:0/project',
  ])('rejects malformed or unsafe address %s', (value) => {
    expect(() => parseSshWorkspaceUrl(value)).toThrow();
  });

  it('uses fixed SSH options and keeps the target and quoted shell data separate', () => {
    const quoted = quoteSshArgument("/tmp/a'b; $(touch sentinel)");
    expect(quoted).toBe("'/tmp/a'\"'\"'b; $(touch sentinel)'");
    const command = sshCommand(
      { host: 'dev@alias', port: 2222, directory: '/work' },
      `cd ${quoted}`,
      true,
    );
    expect(command.file).toBe('ssh');
    expect(command.args).toContain('-tt');
    expect(command.args).toContain('BatchMode=yes');
    expect(command.args).toContain('StrictHostKeyChecking=yes');
    expect(command.args).toContain('ConnectionAttempts=1');
    expect(command.args.slice(-5)).toEqual([
      '-p',
      '2222',
      '--',
      'dev@alias',
      `cd ${quoted}`,
    ]);
    expect(() =>
      sshCommand({ host: '-Fconfig', directory: '/work' }, 'true'),
    ).toThrow();
  });
});

describe('SSH workspace transport', () => {
  let child: ReturnType<typeof fakeChild>;
  let client: SshWorkspaceClient;
  beforeEach(() => {
    child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    client = new SshWorkspaceClient({ host: 'host', directory: '/work' });
  });
  afterEach(() => {
    client.dispose();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  function finish(stdout: string, exitCode = 0, stderr = '') {
    child.stdout.write(stdout);
    child.stderr.write(stderr);
    child.exitCode = exitCode;
    child.emit('close', exitCode, null);
  }

  it('sends JSON through stdin and propagates a structured filesystem error', async () => {
    const pending = client.request('write', {
      path: 'name; $(bad)',
      content: "a'\nb",
    });
    const input = child.stdin.read()?.toString() as string;
    expect(JSON.parse(input)).toEqual({
      root: '/work',
      operation: 'write',
      params: { path: 'name; $(bad)', content: "a'\nb" },
    });
    const args = mocks.spawn.mock.calls[0]![1] as string[];
    expect(args.at(-1)).not.toContain('name; $(bad)');
    finish(
      JSON.stringify({
        ok: false,
        error: { code: 'hash_mismatch', message: 'File changed' },
      }),
    );
    await expect(pending).rejects.toMatchObject({
      code: 'hash_mismatch',
      message: 'File changed',
    });
  });

  it('decodes filesystem results and streams shell stdout and stderr separately', async () => {
    const pending = client.request<{ directory: string }>('probe', {});
    finish(JSON.stringify({ ok: true, result: { directory: '/work' } }));
    await expect(pending).resolves.toEqual({ directory: '/work' });
    child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    const onOutput = vi.fn();
    const shell = client.execute('exit 7', {
      directory: '/work/sub',
      onOutput,
    });
    finish('output', 7, 'error');
    await expect(shell).resolves.toEqual({
      stdout: 'output',
      stderr: 'error',
      exitCode: 7,
    });
    expect(onOutput.mock.calls).toEqual([['output'], ['error']]);
  });

  it('rejects a disconnected SSH request without killing an exited process or retrying', async () => {
    const pending = client.execute('touch remote-marker');
    finish('', 255, 'connection lost');
    await expect(pending).rejects.toMatchObject({
      code: 'ssh_failed',
      message: expect.stringMatching(/status is uncertain.*not retried/),
    });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('cancels an active connection and reports uncertain remote command status', async () => {
    const controller = new AbortController();
    const pending = client.execute('sleep 100', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: 'cancelled',
      message: expect.stringContaining('status is uncertain'),
    });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('times out and kills the local SSH child without replaying a write', async () => {
    vi.useFakeTimers();
    const pending = client
      .execute('sleep 100', { timeoutMs: 20 })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toMatchObject({ code: 'timeout' });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('bounds combined output and releases active children on disposal', async () => {
    const pending = client.execute('yes');
    child.stdout.write('x'.repeat(32 * 1024 * 1024));
    child.stderr.write('overflow');
    await expect(pending).rejects.toMatchObject({ code: 'output_limit' });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    const next = client.execute('sleep 100');
    client.dispose();
    await expect(next).rejects.toMatchObject({ code: 'cancelled' });
    await expect(client.request('probe', {})).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });
});

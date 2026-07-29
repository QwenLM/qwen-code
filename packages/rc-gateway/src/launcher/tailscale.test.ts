/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect } from 'vitest';
import { ensureUp, nodeIdentity } from './tailscale.js';
import type { RunCommand, CommandResult } from './exec.js';

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '' });
const fail = (code: number, stderr: string): CommandResult => ({
  code,
  stdout: '',
  stderr,
});

const STATUS_RUNNING = JSON.stringify({
  BackendState: 'Running',
  Self: {
    DNSName: 'laptop-wsl.tailnet-abc.ts.net.',
    TailscaleIPs: ['100.101.102.103', 'fd7a::1'],
  },
});

function stub(map: Record<string, CommandResult>): RunCommand {
  return async (argv) =>
    map[argv.join(' ')] ?? fail(1, `unstubbed: ${argv.join(' ')}`);
}

describe('nodeIdentity', () => {
  it('parses host (trailing dot stripped) and the IPv4 100.x address', async () => {
    const run = stub({ 'tailscale status --json': ok(STATUS_RUNNING) });
    expect(await nodeIdentity(run)).toEqual({
      host: 'laptop-wsl.tailnet-abc.ts.net',
      ip: '100.101.102.103',
    });
  });
  it('returns null when not running/parseable', async () => {
    const run = stub({ 'tailscale status --json': fail(1, 'stopped') });
    expect(await nodeIdentity(run)).toBeNull();
  });
  it('returns null when status exits 0 but stdout is not JSON', async () => {
    const run = stub({ 'tailscale status --json': ok('not json') });
    expect(await nodeIdentity(run)).toBeNull();
  });
  it('returns null when JSON lacks Self.DNSName/TailscaleIPs', async () => {
    const run = stub({
      'tailscale status --json': ok(
        JSON.stringify({ BackendState: 'Running', Self: {} }),
      ),
    });
    expect(await nodeIdentity(run)).toBeNull();
  });
});

describe('ensureUp', () => {
  it('running when status is already Running', async () => {
    const run = stub({ 'tailscale status --json': ok(STATUS_RUNNING) });
    expect(await ensureUp(run)).toEqual({ kind: 'running' });
  });
  it('needs-auth surfaces the login URL', async () => {
    const run: RunCommand = async (argv) => {
      if (argv.join(' ') === 'tailscale status --json')
        return ok(JSON.stringify({ BackendState: 'NeedsLogin', Self: {} }));
      if (argv[1] === 'up')
        return fail(
          1,
          'To authenticate, visit:\n\n\thttps://login.tailscale.com/a/deadbeef\n',
        );
      return fail(1, 'x');
    };
    expect(await ensureUp(run)).toEqual({
      kind: 'needs-auth',
      authUrl: 'https://login.tailscale.com/a/deadbeef',
    });
  });
  it('not-installed when the binary is absent (code 127)', async () => {
    const run: RunCommand = async () => ({
      code: 127,
      stdout: '',
      stderr: 'tailscale: not found',
    });
    expect(await ensureUp(run)).toEqual({ kind: 'not-installed' });
  });
  it('needs-operator on a permission error', async () => {
    const run: RunCommand = async (argv) => {
      if (argv.join(' ') === 'tailscale status --json')
        return ok(JSON.stringify({ BackendState: 'Stopped', Self: {} }));
      if (argv[1] === 'up')
        return fail(
          1,
          'Access denied: this operation requires operator access.',
        );
      return fail(1, 'x');
    };
    expect(await ensureUp(run)).toEqual({ kind: 'needs-operator' });
  });
  it('error fallback for an unrecognized failure', async () => {
    const run: RunCommand = async (argv) => {
      if (argv.join(' ') === 'tailscale status --json')
        return ok(JSON.stringify({ BackendState: 'Stopped', Self: {} }));
      if (argv[1] === 'up') return fail(1, 'connection timed out');
      return fail(1, 'x');
    };
    const out = await ensureUp(run);
    expect(out.kind).toBe('error');
    if (out.kind === 'error') {
      expect(out.message).toContain('connection timed out');
    }
  });
});

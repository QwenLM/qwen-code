import { describe, it, expect } from 'vitest';
import { up, down, status, readPairingCode } from './launcherClient.js';
import type { RunWsl, CommandResult } from './wsl.js';

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '' });
const stub =
  (map: Record<string, CommandResult>): RunWsl =>
  async (cmd) =>
    map[cmd] ?? { code: 1, stdout: '', stderr: `unstubbed: ${cmd}` };

describe('up', () => {
  it('maps a running result', async () => {
    const run = stub({
      'qwen-rc up --json': ok(
        JSON.stringify({
          status: 'running',
          url: 'https://h.ts.net:8443/ui/',
          host: 'h.ts.net',
          port: 8443,
          unit: 'qwen-rc-gateway',
          certExpiry: '2036-01-01T00:00:00.000Z',
        }),
      ),
    });
    expect(await up(run)).toEqual({
      ok: true,
      url: 'https://h.ts.net:8443/ui/',
      host: 'h.ts.net',
      port: 8443,
      unit: 'qwen-rc-gateway',
      certExpiry: '2036-01-01T00:00:00.000Z',
    });
  });
  it('maps an error result with the hint', async () => {
    const run = stub({
      'qwen-rc up --json': ok(
        JSON.stringify({ status: 'error', hint: 'enable HTTPS/MagicDNS' }),
      ),
    });
    expect(await up(run)).toEqual({ ok: false, hint: 'enable HTTPS/MagicDNS' });
  });
  it('surfaces a hint when the command itself fails / output is unparseable', async () => {
    const run: RunWsl = async () => ({
      code: 1,
      stdout: 'bash: qwen-rc: command not found',
      stderr: '',
    });
    const r = await up(run);
    expect(r.ok).toBe(false);
    expect(r.hint).toContain('qwen-rc');
  });
});

describe('status', () => {
  it('maps running + url', async () => {
    const run = stub({
      'qwen-rc status --json': ok(
        JSON.stringify({ running: true, url: 'https://h.ts.net:8443/ui/' }),
      ),
    });
    expect(await status(run)).toEqual({
      running: true,
      url: 'https://h.ts.net:8443/ui/',
    });
  });
  it('reports stopped on an unparseable/failed status', async () => {
    const run: RunWsl = async () => ({ code: 1, stdout: '', stderr: 'x' });
    expect(await status(run)).toEqual({ running: false });
  });
});

describe('down', () => {
  it('ok on stopped', async () => {
    const run = stub({
      'qwen-rc down --json': ok(JSON.stringify({ status: 'stopped' })),
    });
    expect(await down(run)).toEqual({ ok: true });
  });
});

describe('readPairingCode', () => {
  it('returns the trimmed code', async () => {
    const run = stub({
      'cat ~/.qwen/rc/owner-bootstrap.code 2>/dev/null': ok('ABCD-1234\n'),
    });
    expect(await readPairingCode(run)).toBe('ABCD-1234');
  });
  it('returns undefined when absent', async () => {
    const run: RunWsl = async () => ({ code: 1, stdout: '', stderr: '' });
    expect(await readPairingCode(run)).toBeUndefined();
  });
});

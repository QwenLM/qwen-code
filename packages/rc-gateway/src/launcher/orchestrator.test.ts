/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { up, down, status } from './orchestrator.js';
import type { RunCommand, CommandResult } from './exec.js';

const RUNNING = JSON.stringify({
  BackendState: 'Running',
  Self: { DNSName: 'laptop-wsl.tn.ts.net.', TailscaleIPs: ['100.1.2.3'] },
});
const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });

let dir: string | undefined;
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});
const mkdir = () => (dir = mkdtempSync(join(tmpdir(), 'launcher-')));

const DEPS = (d: string, run: RunCommand) => ({
  run,
  dir: d,
  port: 8443,
  unit: 'qwen-rc-gateway',
  serveCmd: ['qwen-rc'],
});

// tailnet Running + cert ok; the is-active answer is read live from `active()`,
// and `onStart` fires when the gateway unit is launched — so a test can model
// "inactive until started" (exercises the start path + idempotency).
function base(active: () => boolean, onStart?: () => void): RunCommand {
  return async (argv) => {
    const k = argv.join(' ');
    if (k === 'tailscale status --json') return ok(RUNNING);
    if (argv[0] === 'tailscale' && argv[1] === 'cert') return ok();
    if (argv[0] === 'systemd-run') {
      onStart?.();
      return ok();
    }
    if (k.startsWith('systemctl --user is-active'))
      return active()
        ? ok('active\n')
        : { code: 3, stdout: 'inactive\n', stderr: '' };
    if (k.startsWith('systemctl --user stop')) return ok();
    return { code: 1, stdout: '', stderr: `unstubbed ${k}` };
  };
}

describe('up', () => {
  it('starts the stack and returns connect info + QR + bootstrap code', async () => {
    const d = mkdir();
    writeFileSync(join(d, 'owner-bootstrap.code'), 'ABCD-1234\n');
    let starts = 0;
    const run = base(
      () => starts > 0,
      () => {
        starts++;
      },
    ); // inactive until started
    const res = await up(DEPS(d, run));
    expect(res.ok).toBe(true);
    expect(starts).toBe(1); // the start path ran
    expect(res.url).toBe('https://laptop-wsl.tn.ts.net:8443/ui/');
    expect(res.host).toBe('laptop-wsl.tn.ts.net');
    expect(res.port).toBe(8443);
    expect(res.bootstrapCode).toBe('ABCD-1234');
    expect(typeof res.qr).toBe('string');
    expect(res.qr!.length).toBeGreaterThan(0);
  });

  it('is idempotent — a second up does not start a second unit', async () => {
    const d = mkdir();
    let starts = 0;
    const run = base(
      () => starts > 0,
      () => {
        starts++;
      },
    );
    await up(DEPS(d, run)); // starts (was inactive)
    await up(DEPS(d, run)); // sees is-active → skips
    expect(starts).toBe(1);
  });

  it('surfaces the HTTPS-not-enabled hint and starts nothing', async () => {
    const d = mkdir();
    let started = false;
    const run: RunCommand = async (argv) => {
      const k = argv.join(' ');
      if (k === 'tailscale status --json') return ok(RUNNING);
      if (argv[0] === 'tailscale' && argv[1] === 'cert')
        return {
          code: 1,
          stdout: '',
          stderr: 'HTTPS is not enabled in the admin console',
        };
      if (argv[0] === 'systemd-run') {
        started = true;
        return ok();
      }
      return { code: 1, stdout: '', stderr: k };
    };
    const res = await up(DEPS(d, run));
    expect(res.ok).toBe(false);
    expect(res.hint).toMatch(/HTTPS.*admin console/i);
    expect(started).toBe(false); // cert fails before the start step is reached
  });

  it('surfaces the needs-auth URL when logged out', async () => {
    const d = mkdir();
    const run: RunCommand = async (argv) => {
      if (argv.join(' ') === 'tailscale status --json')
        return ok(JSON.stringify({ BackendState: 'NeedsLogin', Self: {} }));
      if (argv[1] === 'up')
        return {
          code: 1,
          stdout: '',
          stderr:
            'To authenticate, visit:\n\thttps://login.tailscale.com/a/deadbeef\n',
        };
      return { code: 1, stdout: '', stderr: 'x' };
    };
    const res = await up(DEPS(d, run));
    expect(res.ok).toBe(false);
    expect(res.hint).toContain('https://login.tailscale.com/a/deadbeef');
  });

  it('gives the D-Bus remedy when systemd --user is unavailable', async () => {
    const d = mkdir();
    const run: RunCommand = async (argv) => {
      const k = argv.join(' ');
      if (k === 'tailscale status --json') return ok(RUNNING);
      if (argv[0] === 'tailscale' && argv[1] === 'cert') return ok();
      if (k.startsWith('systemctl --user is-active'))
        return {
          code: 1,
          stdout: '',
          stderr: 'Failed to connect to bus: No such file or directory',
        };
      if (argv[0] === 'systemd-run')
        return {
          code: 1,
          stdout: '',
          stderr: 'Failed to connect to bus: No such file or directory',
        };
      return { code: 1, stdout: '', stderr: k };
    };
    const res = await up(DEPS(d, run));
    expect(res.ok).toBe(false);
    expect(res.hint).toMatch(/XDG_RUNTIME_DIR|enable-linger/);
  });
});

describe('renderQr', () => {
  it('returns a non-empty multi-line QR string', async () => {
    const { renderQr } = await import('./qr.js');
    const out = await renderQr('https://example.ts.net:8443/ui/');
    expect(out.length).toBeGreaterThan(0);
    expect(out.split('\n').length).toBeGreaterThan(3);
  });
});

describe('down', () => {
  it('stops and clears state (idempotent)', async () => {
    const d = mkdir();
    const res = await down(
      DEPS(
        d,
        base(() => true),
      ),
    );
    expect(res.ok).toBe(true);
  });
});

describe('status', () => {
  it('reports running with the connect url after up', async () => {
    const d = mkdir();
    writeFileSync(join(d, 'owner-bootstrap.code'), 'X\n');
    let starts = 0;
    const run = base(
      () => starts > 0,
      () => {
        starts++;
      },
    );
    await up(DEPS(d, run));
    const s = await status(DEPS(d, run));
    expect(s.running).toBe(true);
    expect(s.url).toBe('https://laptop-wsl.tn.ts.net:8443/ui/');
  });
});

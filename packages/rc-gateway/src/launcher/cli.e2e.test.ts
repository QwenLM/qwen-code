/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { up, status, down } from './orchestrator.js';
import type { RunCommand } from './exec.js';

const RUNNING = JSON.stringify({
  BackendState: 'Running',
  Self: { DNSName: 'l.tn.ts.net.', TailscaleIPs: ['100.9.9.9'] },
});

let dir: string | undefined;
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

describe('cli launcher e2e (up -> status -> down, orchestrator wired to a stubbed run)', () => {
  it('up -> status(running) -> down -> status(stopped)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'launcher-e2e-'));
    writeFileSync(join(dir, 'owner-bootstrap.code'), 'PAIR-9\n');
    let active = false;
    const run: RunCommand = async (argv) => {
      const k = argv.join(' ');
      if (k === 'tailscale status --json')
        return { code: 0, stdout: RUNNING, stderr: '' };
      if (argv[0] === 'tailscale' && argv[1] === 'cert')
        return { code: 0, stdout: '', stderr: '' };
      if (argv[0] === 'systemd-run') {
        active = true;
        return { code: 0, stdout: '', stderr: '' };
      }
      if (k.startsWith('systemctl --user is-active'))
        return {
          code: active ? 0 : 3,
          stdout: active ? 'active\n' : 'inactive\n',
          stderr: '',
        };
      if (k.startsWith('systemctl --user stop')) {
        active = false;
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: k };
    };
    const deps = {
      run,
      dir,
      port: 8443,
      unit: 'qwen-rc-gateway',
      serveCmd: ['qwen-rc'],
    };

    const u = await up(deps);
    expect(u.ok).toBe(true);
    expect(u.url).toBe('https://l.tn.ts.net:8443/ui/');
    expect(u.bootstrapCode).toBe('PAIR-9');

    expect((await status(deps)).running).toBe(true);
    await down(deps);
    expect((await status(deps)).running).toBe(false);
  });
});

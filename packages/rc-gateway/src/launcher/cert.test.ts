/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect } from 'vitest';
import { ensureCert } from './cert.js';
import type { RunCommand } from './exec.js';

describe('ensureCert', () => {
  it('runs tailscale cert and returns the pair paths', async () => {
    const calls: string[][] = [];
    const run: RunCommand = async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: '', stderr: '' };
    };
    const out = await ensureCert(run, 'laptop-wsl.tailnet.ts.net', '/tmp/tls');
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      expect(out.pair.certPath).toBe('/tmp/tls/laptop-wsl.tailnet.ts.net.crt');
      expect(out.pair.keyPath).toBe('/tmp/tls/laptop-wsl.tailnet.ts.net.key');
    }
    // invoked tailscale cert with explicit output paths
    expect(calls.some((c) => c[0] === 'tailscale' && c[1] === 'cert')).toBe(
      true,
    );
  });
  it('classifies the HTTPS-not-enabled failure', async () => {
    const run: RunCommand = async () => ({
      code: 1,
      stdout: '',
      stderr: 'HTTPS is not enabled in the admin console',
    });
    expect(await ensureCert(run, 'h.ts.net', '/tmp/tls')).toEqual({
      kind: 'https-not-enabled',
    });
  });
});

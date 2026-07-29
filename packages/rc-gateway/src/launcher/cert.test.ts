/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureCert } from './cert.js';
import type { RunCommand } from './exec.js';

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), 'cert-'));
}

describe('ensureCert', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures
      }
    }
    dirs.length = 0;
  });

  it('runs tailscale cert and returns the pair paths', async () => {
    const dir = mkTmp();
    dirs.push(dir);
    const calls: string[][] = [];
    const run: RunCommand = async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: '', stderr: '' };
    };
    const out = await ensureCert(run, 'laptop-wsl.tailnet.ts.net', dir);
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      expect(out.pair.certPath).toBe(
        join(dir, 'laptop-wsl.tailnet.ts.net.crt'),
      );
      expect(out.pair.keyPath).toBe(join(dir, 'laptop-wsl.tailnet.ts.net.key'));
    }
    // invoked tailscale cert with explicit output paths
    expect(calls.some((c) => c[0] === 'tailscale' && c[1] === 'cert')).toBe(
      true,
    );
  });

  it('classifies the HTTPS-not-enabled failure', async () => {
    const dir = mkTmp();
    dirs.push(dir);
    const run: RunCommand = async () => ({
      code: 1,
      stdout: '',
      stderr: 'HTTPS is not enabled in the admin console',
    });
    expect(await ensureCert(run, 'h.ts.net', dir)).toEqual({
      kind: 'https-not-enabled',
    });
  });

  it('falls back to error for a non-https failure', async () => {
    const dir = mkTmp();
    dirs.push(dir);
    const run: RunCommand = async () => ({
      code: 1,
      stdout: '',
      stderr: 'connection refused',
    });
    const out = await ensureCert(run, 'h.ts.net', dir);
    expect(out.kind).toBe('error');
    if (out.kind === 'error') {
      expect(out.message).toContain('connection refused');
    }
  });

  it('does not misclassify an unrelated "admin console" message as https-not-enabled', async () => {
    const dir = mkTmp();
    dirs.push(dir);
    const run: RunCommand = async () => ({
      code: 1,
      stdout: '',
      stderr: 'device not authorized; approve it in the admin console',
    });
    const out = await ensureCert(run, 'h.ts.net', dir);
    expect(out.kind).toBe('error');
  });
});

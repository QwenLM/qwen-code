/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import type { RunWsl } from './wsl.js';

export interface UpResult {
  ok: boolean;
  url?: string;
  host?: string;
  port?: number;
  unit?: string;
  certExpiry?: string;
  hint?: string;
}
export interface StatusResult {
  running: boolean;
  url?: string;
  certExpiry?: string;
}

function parseJson(stdout: string): Record<string, unknown> | null {
  try {
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function up(run: RunWsl): Promise<UpResult> {
  const r = await run('qwen-rc up --json');
  const j = parseJson(r.stdout);
  if (!j) {
    return {
      ok: false,
      hint: (r.stdout || r.stderr).trim().slice(0, 500) || 'launcher up failed',
    };
  }
  const ok = j['status'] === 'running';
  return {
    ok,
    url: typeof j['url'] === 'string' ? j['url'] : undefined,
    host: typeof j['host'] === 'string' ? j['host'] : undefined,
    port: typeof j['port'] === 'number' ? j['port'] : undefined,
    unit: typeof j['unit'] === 'string' ? j['unit'] : undefined,
    certExpiry:
      typeof j['certExpiry'] === 'string' ? j['certExpiry'] : undefined,
    hint: typeof j['hint'] === 'string' ? j['hint'] : undefined,
  };
}

export async function down(
  run: RunWsl,
): Promise<{ ok: boolean; hint?: string }> {
  const r = await run('qwen-rc down --json');
  const j = parseJson(r.stdout);
  if (j && j['status'] === 'stopped') return { ok: true };
  return {
    ok: r.code === 0,
    hint: j ? undefined : (r.stderr || r.stdout).trim().slice(0, 300),
  };
}

export async function status(run: RunWsl): Promise<StatusResult> {
  const r = await run('qwen-rc status --json');
  const j = parseJson(r.stdout);
  if (!j) return { running: false };
  return {
    running: j['running'] === true,
    url: typeof j['url'] === 'string' ? j['url'] : undefined,
    certExpiry:
      typeof j['certExpiry'] === 'string' ? j['certExpiry'] : undefined,
  };
}

export async function readPairingCode(
  run: RunWsl,
): Promise<string | undefined> {
  const r = await run('cat ~/.qwen/rc/owner-bootstrap.code 2>/dev/null');
  const code = r.stdout.trim();
  return r.code === 0 && code.length > 0 ? code : undefined;
}

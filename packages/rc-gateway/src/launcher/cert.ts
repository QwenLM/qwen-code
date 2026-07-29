/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RunCommand } from './exec.js';

export interface CertPair {
  certPath: string;
  keyPath: string;
  expiry?: Date;
}

export type CertOutcome =
  | { kind: 'ok'; pair: CertPair }
  | { kind: 'https-not-enabled' }
  | { kind: 'error'; message: string };

/**
 * Obtain a Tailscale TLS cert for `host` into `dir` (`<host>.crt` / `<host>.key`).
 * `tailscale cert` itself is idempotent — it reuses a valid cert and renews when
 * near expiry — so we always invoke it and let it decide.
 */
export async function ensureCert(
  run: RunCommand,
  host: string,
  dir: string,
): Promise<CertOutcome> {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { kind: 'error', message: (e as Error).message };
  }
  const certPath = join(dir, `${host}.crt`);
  const keyPath = join(dir, `${host}.key`);
  const r = await run([
    'tailscale',
    'cert',
    '--cert-file',
    certPath,
    '--key-file',
    keyPath,
    host,
  ]);
  if (r.code === 0) return { kind: 'ok', pair: { certPath, keyPath } };
  const out = `${r.stdout}\n${r.stderr}`;
  if (/https .*not enabled|enable https/i.test(out)) {
    return { kind: 'https-not-enabled' };
  }
  return { kind: 'error', message: out.trim().slice(0, 500) };
}

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import type { RunCommand } from './exec.js';

export interface NodeIdentity {
  host: string; // <name>.<tailnet>.ts.net (trailing dot stripped)
  ip: string; // 100.x IPv4
}

export type UpOutcome =
  | { kind: 'running' }
  | { kind: 'needs-auth'; authUrl: string }
  | { kind: 'not-installed' }
  | { kind: 'needs-operator' }
  | { kind: 'error'; message: string };

interface RawStatus {
  BackendState?: string;
  Self?: { DNSName?: string; TailscaleIPs?: string[] };
}

async function readStatus(run: RunCommand): Promise<RawStatus | null> {
  const r = await run(['tailscale', 'status', '--json']);
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout) as RawStatus;
  } catch {
    return null;
  }
}

export async function nodeIdentity(
  run: RunCommand,
): Promise<NodeIdentity | null> {
  const st = await readStatus(run);
  const dns = st?.Self?.DNSName;
  const ip = st?.Self?.TailscaleIPs?.find((a) => /^100\.\d/.test(a));
  if (!dns || !ip) return null;
  return { host: dns.replace(/\.$/, ''), ip };
}

/**
 * Ensure the tailnet node is up. Checks status first; only invokes `tailscale up`
 * (bounded, so it cannot hang) when not already Running. Classifies the outcome —
 * on a logged-out node it surfaces the auth URL for the operator's one-time
 * browser authorization (they authenticate, then re-run `qwen-rc up`).
 */
export async function ensureUp(run: RunCommand): Promise<UpOutcome> {
  const st = await readStatus(run);
  if (st?.BackendState === 'Running') return { kind: 'running' };

  const r = await run(['tailscale', 'up', '--timeout', '3s']);
  if (r.code === 0) return { kind: 'running' };

  const out = `${r.stdout}\n${r.stderr}`;
  if (r.code === 127 || /not found|not installed|ENOENT/i.test(out)) {
    return { kind: 'not-installed' };
  }
  const url = /(https:\/\/login\.tailscale\.com\/\S+)/.exec(out)?.[1];
  if (url) return { kind: 'needs-auth', authUrl: url };
  if (/operator|permission denied|access denied/i.test(out)) {
    return { kind: 'needs-operator' };
  }
  return { kind: 'error', message: out.trim().slice(0, 500) };
}

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import type { RunWsl } from './wsl.js';

export interface ProviderEnv {
  OPENAI_BASE_URL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
}

const KEYS = ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL'] as const;

export function parseEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

/** Update the provider keys in `existing`, preserving all other lines. */
export function mergeEnv(existing: string, updates: ProviderEnv): string {
  const lines = existing.split('\n');
  const seen = new Set<string>();
  const result = lines.map((line) => {
    const eq = line.indexOf('=');
    if (eq <= 0) return line;
    const key = line.slice(0, eq).trim();
    if (
      (KEYS as readonly string[]).includes(key) &&
      updates[key as keyof ProviderEnv] !== undefined
    ) {
      seen.add(key);
      return `${key}=${updates[key as keyof ProviderEnv]}`;
    }
    return line;
  });
  // Append any provided keys not already present.
  for (const key of KEYS) {
    if (updates[key] !== undefined && !seen.has(key)) {
      result.push(`${key}=${updates[key]}`);
    }
  }
  return result.join('\n');
}

export async function readEnv(run: RunWsl): Promise<ProviderEnv> {
  const r = await run('cat ~/.qwen/.env 2>/dev/null');
  const parsed = r.code === 0 ? parseEnv(r.stdout) : {};
  const out: ProviderEnv = {};
  for (const k of KEYS) if (parsed[k] !== undefined) out[k] = parsed[k];
  return out;
}

/**
 * Write the merged `.env` back with mode 0600. The new content is base64'd and
 * decoded in WSL so arbitrary values (keys, URLs) never hit shell quoting.
 */
export async function writeEnv(
  run: RunWsl,
  updates: ProviderEnv,
): Promise<{ ok: boolean }> {
  const existing = await run('cat ~/.qwen/.env 2>/dev/null');
  const merged = mergeEnv(existing.code === 0 ? existing.stdout : '', updates);
  const b64 = Buffer.from(merged, 'utf8').toString('base64');
  const r = await run(
    `mkdir -p ~/.qwen && echo ${b64} | base64 -d > ~/.qwen/.env && chmod 600 ~/.qwen/.env`,
  );
  return { ok: r.code === 0 };
}

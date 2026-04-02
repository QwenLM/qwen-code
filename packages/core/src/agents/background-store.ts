/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type BackgroundAgentPersistedStatus = 'running' | 'completed' | 'error';

export interface PersistedBackgroundAgent {
  agentId: string;
  agentName: string;
  description: string;
  startTime: number;
  completedTime?: number;
  status: BackgroundAgentPersistedStatus;
  result?: string;
  error?: string;
}

const PRUNE_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

function getStorePath(): string {
  // Use the same ~/.proto dir convention as Storage.getGlobalQwenDir()
  const protoDir = path.join(os.homedir(), '.proto');
  return path.join(protoDir, 'agents', 'background.json');
}

function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function loadStore(): PersistedBackgroundAgent[] {
  const storePath = getStorePath();
  try {
    const raw = fs.readFileSync(storePath, 'utf-8');
    const entries = JSON.parse(raw) as PersistedBackgroundAgent[];
    const cutoff = Date.now() - PRUNE_AGE_MS;
    return entries.filter((e) => e.startTime > cutoff);
  } catch {
    return [];
  }
}

export function saveStore(entries: PersistedBackgroundAgent[]): void {
  const storePath = getStorePath();
  try {
    ensureDir(storePath);
    const cutoff = Date.now() - PRUNE_AGE_MS;
    const pruned = entries.filter((e) => e.startTime > cutoff);
    fs.writeFileSync(
      storePath,
      JSON.stringify(pruned, null, 2) + '\n',
      'utf-8',
    );
  } catch {
    // non-fatal: persistence is best-effort
  }
}

export function upsertEntry(
  entries: PersistedBackgroundAgent[],
  update: PersistedBackgroundAgent,
): PersistedBackgroundAgent[] {
  const idx = entries.findIndex((e) => e.agentId === update.agentId);
  if (idx >= 0) {
    const next = [...entries];
    next[idx] = update;
    return next;
  }
  return [...entries, update];
}

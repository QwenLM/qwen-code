/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const PROJECT_ROOT = '/agent-workspace-lock-test';

function runWorker(runtimeDir: string, count: number): Promise<number[]> {
  const tsx = path.resolve(process.cwd(), '../../node_modules/.bin/tsx');
  const worker = fileURLToPath(
    new URL('./workspace-lock-worker.ts', import.meta.url),
  );
  return new Promise((resolve, reject) => {
    const child = spawn(tsx, [worker], {
      env: {
        ...process.env,
        AGENT_LOCK_RUNTIME_DIR: runtimeDir,
        AGENT_LOCK_PROJECT_ROOT: PROJECT_ROOT,
        AGENT_LOCK_COUNT: String(count),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`workspace lock worker exited ${code}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout) as number[]);
    });
  });
}

describe('agent workspace lock', () => {
  let runtimeDir: string;

  beforeEach(async () => {
    runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-lock-test-'));
  });

  afterEach(async () => {
    await fs.rm(runtimeDir, { recursive: true, force: true });
  });

  it('issues unique increasing run sequences across two processes', async () => {
    const count = 8;
    const [first, second] = await Promise.all([
      runWorker(runtimeDir, count),
      runWorker(runtimeDir, count),
    ]);

    expect(first).toHaveLength(count);
    expect(second).toHaveLength(count);
    expect(
      first.every((value, index) => index === 0 || value > first[index - 1]!),
    ).toBe(true);
    expect(
      second.every((value, index) => index === 0 || value > second[index - 1]!),
    ).toBe(true);
    expect(new Set([...first, ...second]).size).toBe(count * 2);
    expect([...first, ...second].sort((a, b) => a - b)).toEqual(
      Array.from({ length: count * 2 }, (_, index) => index + 1),
    );
  });
});

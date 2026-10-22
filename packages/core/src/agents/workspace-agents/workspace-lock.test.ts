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
import { Storage } from '../../config/storage.js';
import { readWorkspaceAgents } from './store.js';

const PROJECT_ROOT = '/agent-workspace-lock-test';

function runWorker(
  runtimeDir: string,
  tag: string,
  count: number,
): Promise<string[]> {
  const worker = fileURLToPath(
    new URL('./workspace-lock-worker.ts', import.meta.url),
  );
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', worker], {
      env: {
        ...process.env,
        AGENT_LOCK_RUNTIME_DIR: runtimeDir,
        AGENT_LOCK_PROJECT_ROOT: PROJECT_ROOT,
        AGENT_LOCK_TAG: tag,
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
      resolve(JSON.parse(stdout) as string[]);
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

  it('loses no roster update when two processes write at once', async () => {
    const count = 8;
    const [first, second] = await Promise.all([
      runWorker(runtimeDir, 'a', count),
      runWorker(runtimeDir, 'b', count),
    ]);

    expect(first).toHaveLength(count);
    expect(second).toHaveLength(count);
    Storage.setRuntimeBaseDir(runtimeDir);
    try {
      const names = (await readWorkspaceAgents(PROJECT_ROOT)).map(
        (agent) => agent.name,
      );
      expect(names.sort()).toEqual([...first, ...second].sort());
    } finally {
      Storage.setRuntimeBaseDir(null);
    }
  });
});

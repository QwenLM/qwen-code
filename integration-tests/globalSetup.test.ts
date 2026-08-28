/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The env keys globalSetup's setup() writes, saved so a case can restore the
// suite-wide values after re-importing the module and running its lifecycle.
const SETUP_ENV_KEYS = [
  'INTEGRATION_TEST_FILE_DIR',
  'QWEN_CODE_INTEGRATION_TEST',
  'TELEMETRY_LOG_FILE',
  'E2E_TEST_FILE_DIR',
  'TEST_CLI_PATH',
  'VERBOSE',
  'KEEP_OUTPUT',
] as const;

describe('globalSetup memory-file save/restore', () => {
  let qwenHome: string;
  let savedEnv: Map<string, string | undefined>;

  beforeEach(async () => {
    qwenHome = await mkdtemp(join(tmpdir(), 'qwen-globalsetup-test-'));
    savedEnv = new Map(
      [...SETUP_ENV_KEYS, 'QWEN_HOME'].map((key) => [key, process.env[key]]),
    );
    process.env['QWEN_HOME'] = qwenHome;
    // Let teardown remove the run directories this case creates.
    process.env['KEEP_OUTPUT'] = 'false';
  });

  afterEach(async () => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    vi.resetModules();
    await rm(qwenHome, { recursive: true, force: true });
  });

  // memoryFilePath is captured at module import time, so point QWEN_HOME at
  // the scratch dir BEFORE a fresh import of the module.
  async function loadGlobalSetup() {
    vi.resetModules();
    return import('./globalSetup.js');
  }

  it('restores the saved memory file after the run', async () => {
    await writeFile(join(qwenHome, 'QWEN.md'), 'original content', 'utf-8');
    const { setup, teardown } = await loadGlobalSetup();
    await setup();
    await writeFile(join(qwenHome, 'QWEN.md'), 'mutated by tests', 'utf-8');

    await expect(teardown()).resolves.toBeUndefined();

    await expect(readFile(join(qwenHome, 'QWEN.md'), 'utf-8')).resolves.toBe(
      'original content',
    );
  });

  it('does not exit an all-green run red when the restore cannot write', async () => {
    // The persistent pool runners can carry a readable-but-unwritable
    // QWEN.md left behind by a privileged job; before #10325 the teardown
    // restore threw on it and exited every all-green E2E run on that host
    // red with no failing test. Swap the file for a directory after setup()
    // read it — the write then fails regardless of privilege, since root
    // bypasses permission bits.
    await writeFile(join(qwenHome, 'QWEN.md'), 'original content', 'utf-8');
    const { setup, teardown } = await loadGlobalSetup();
    await setup();
    await rm(join(qwenHome, 'QWEN.md'), { force: true });
    await mkdir(join(qwenHome, 'QWEN.md'));

    await expect(teardown()).resolves.toBeUndefined();
  });
});

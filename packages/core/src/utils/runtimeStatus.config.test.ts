/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Integration coverage for the runtime.json sidecar wiring through
 * Config.startNewSession(). The unit tests in runtimeStatus.test.ts
 * exercise the module in isolation; this file pins the contract that
 * /clear, /reset, /new and /resume — all of which flow through
 * startNewSession() — actually drive the sidecar swap, and only when
 * the interactive UI bootstrap has flipped runtimeStatusEnabled on.
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Config } from '../config/config.js';
import { Storage } from '../config/storage.js';
import { readRuntimeStatus, writeRuntimeStatus } from './runtimeStatus.js';

let tmpDir: string;
let runtimeDir: string;
let prevRuntimeEnv: string | undefined;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'qwen-rt-cfg-'));
  runtimeDir = path.join(tmpDir, 'runtime');
  prevRuntimeEnv = process.env['QWEN_RUNTIME_DIR'];
  process.env['QWEN_RUNTIME_DIR'] = runtimeDir;
});

afterEach(async () => {
  if (prevRuntimeEnv === undefined) {
    delete process.env['QWEN_RUNTIME_DIR'];
  } else {
    process.env['QWEN_RUNTIME_DIR'] = prevRuntimeEnv;
  }
  await rm(tmpDir, { recursive: true, force: true });
});

function makeConfig(sessionId: string): Config {
  return new Config({
    sessionId,
    cwd: tmpDir,
    targetDir: tmpDir,
    debugMode: false,
    model: 'test-model',
    usageStatisticsEnabled: false,
    bareMode: true,
    cliVersion: '0.0.0-test',
  });
}

async function waitForRuntimeStatus(filePath: string) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const status = await readRuntimeStatus(filePath);
    if (status) return status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

describe('Config.startNewSession runtime.json swap', () => {
  it('leaves sibling sidecars alone when this process did not bootstrap one', async () => {
    const sessionA = 'aaaaaaaa-1111-2222-3333-aaaaaaaaaaaa';
    const sessionB = 'bbbbbbbb-1111-2222-3333-bbbbbbbbbbbb';
    const config = makeConfig(sessionA);

    // Pretend a *different* process owns this session id and wrote its
    // own sidecar (e.g. a long-lived shell). A non-interactive `/clear`
    // in our process must not delete it.
    const aPath = config.storage.getRuntimeStatusPath(sessionA);
    await writeRuntimeStatus(aPath, {
      sessionId: sessionA,
      workDir: tmpDir,
      qwenVersion: '0.0.0-test',
    });

    config.startNewSession(sessionB);
    // Drain microtasks + any in-flight I/O the IIFE could have queued.
    await new Promise((r) => setTimeout(r, 100));

    expect(await readRuntimeStatus(aPath)).not.toBeNull();
    const bPath = config.storage.getRuntimeStatusPath(sessionB);
    expect(await readRuntimeStatus(bPath)).toBeNull();
  });

  it('does not arm an ownerless legacy sidecar', async () => {
    const sessionA = 'aaaaaaaa-1111-2222-3333-aaaaaaaaaaaa';
    const sessionB = 'bbbbbbbb-1111-2222-3333-bbbbbbbbbbbb';
    const config = makeConfig(sessionA);

    const aPath = config.storage.getRuntimeStatusPath(sessionA);
    await writeRuntimeStatus(aPath, {
      sessionId: sessionA,
      workDir: tmpDir,
      qwenVersion: '0.0.0-test',
    });
    config.markRuntimeStatusEnabled();

    config.startNewSession(sessionB);

    const bPath = config.storage.getRuntimeStatusPath(sessionB);
    await new Promise((r) => setTimeout(r, 100));
    expect(await readRuntimeStatus(bPath)).toBeNull();
    expect(await readRuntimeStatus(aPath)).not.toBeNull();
  });

  it('skips the swap when the session id does not change', async () => {
    const sessionA = 'aaaaaaaa-1111-2222-3333-aaaaaaaaaaaa';
    const config = makeConfig(sessionA);

    const aPath = config.storage.getRuntimeStatusPath(sessionA);
    await writeRuntimeStatus(aPath, {
      sessionId: sessionA,
      workDir: tmpDir,
      qwenVersion: '0.0.0-test',
    });
    config.markRuntimeStatusEnabled();

    const before = await readRuntimeStatus(aPath);

    // Pass the same id back in — startNewSession should be a no-op for
    // the sidecar so we don't churn the file (and lose started_at).
    config.startNewSession(sessionA);
    await new Promise((r) => setTimeout(r, 100));

    const after = await readRuntimeStatus(aPath);
    expect(after?.startedAt).toBe(before?.startedAt);

    // No stray sidecars created in the chats/ dir.
    const chatsDir = path.dirname(aPath);
    const entries = await readdir(chatsDir);
    expect(entries.filter((e) => e.endsWith('.runtime.json'))).toEqual([
      `${sessionA}.runtime.json`,
    ]);
  });

  it('drains an initial background write before shutdown cleanup', async () => {
    const sessionId = 'aaaaaaaa-1111-2222-3333-aaaaaaaaaaaa';
    const config = makeConfig(sessionId);
    const statusPath = config.storage.getRuntimeStatusPath(sessionId);

    try {
      await config.initialize({
        skipGeminiInitialization: true,
        skipHooks: true,
        skipMcpDiscovery: true,
        skipSkillManager: true,
        skipFileCheckpointing: true,
      });
      config.startRuntimeStatus();
      const status = await waitForRuntimeStatus(statusPath);
      expect(status?.ownerId).toBe(config.getSessionWriterOwnerId());
    } finally {
      await config.shutdown();
    }

    await expect(readRuntimeStatus(statusPath)).resolves.toMatchObject({
      sessionId,
      ownerId: config.getSessionWriterOwnerId(),
      active: false,
    });
  });
});

describe('Storage.getRuntimeStatusPath', () => {
  it('co-locates the sidecar under <projectDir>/chats/', () => {
    const storage = new Storage(tmpDir);
    const p = storage.getRuntimeStatusPath('abc-123');
    expect(p.endsWith(path.join('chats', 'abc-123.runtime.json'))).toBe(true);
    expect(p.startsWith(storage.getProjectDir())).toBe(true);
  });
});

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
import {
  listLiveSessions,
  registerSession,
  unregisterSession,
} from '../services/session-registry.js';

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

// The IIFE in startNewSession is fire-and-forget. Poll the filesystem
// briefly instead of guessing a fixed sleep — keeps the test fast on
// happy paths and resilient on slow CI.
async function waitFor<T>(
  predicate: () => Promise<T | null>,
  timeoutMs = 1000,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value !== null) return value;
    await new Promise((r) => setTimeout(r, 25));
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

  it('clears the old sidecar and writes a new one when this process owns it', async () => {
    const sessionA = 'aaaaaaaa-1111-2222-3333-aaaaaaaaaaaa';
    const sessionB = 'bbbbbbbb-1111-2222-3333-bbbbbbbbbbbb';
    const config = makeConfig(sessionA);

    // Mimic what startInteractiveUI() does on launch: write the initial
    // sidecar, then mark this Config as the owner.
    const aPath = config.storage.getRuntimeStatusPath(sessionA);
    await writeRuntimeStatus(aPath, {
      sessionId: sessionA,
      workDir: tmpDir,
      qwenVersion: '0.0.0-test',
    });
    config.markRuntimeStatusEnabled();

    config.startNewSession(sessionB);

    const bPath = config.storage.getRuntimeStatusPath(sessionB);
    const after = await waitFor(() => readRuntimeStatus(bPath));
    expect(after).not.toBeNull();
    expect(after!.sessionId).toBe(sessionB);
    expect(after!.pid).toBe(process.pid);

    expect(await readRuntimeStatus(aPath)).toBeNull();
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
});

describe('Config.startNewSession session-registry patch', () => {
  let prevQwenHome: string | undefined;

  beforeEach(() => {
    // Keep the registry inside this test's tmpdir — the patch seam must
    // be exercised against the real registerSession/listLiveSessions
    // round trip, and the default location is the runner's real home.
    prevQwenHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = path.join(tmpDir, 'qwen-home');
  });

  afterEach(async () => {
    await unregisterSession();
    if (prevQwenHome === undefined) {
      delete process.env['QWEN_HOME'];
    } else {
      process.env['QWEN_HOME'] = prevQwenHome;
    }
  });

  it('keeps the registry record pointing at the swapped session id', async () => {
    const sessionA = 'aaaaaaaa-1111-2222-3333-aaaaaaaaaaaa';
    const sessionB = 'bbbbbbbb-1111-2222-3333-bbbbbbbbbbbb';
    const config = makeConfig(sessionA);
    config.markRuntimeStatusEnabled();
    // registerSession never throws — it returns false on a failed write.
    // Assert the seam itself before relying on anything downstream of
    // it, or a write failure surfaces as a confusing patch-path error.
    expect(
      await registerSession({
        sessionId: sessionA,
        cwd: tmpDir,
        qwenVersion: '0.0.0-test',
      }),
    ).toBe(true);
    config.trackSessionRegistration(Promise.resolve(true));

    const [before] = await listLiveSessions();

    config.startNewSession(sessionB);

    // Without the patch seam, `qwen sessions ps --json` would keep
    // advertising sessionA's transcript for this live session — the exact
    // stale-pointer bug the seam exists to prevent.
    const after = await waitFor(async () => {
      const [record] = await listLiveSessions();
      return record?.sessionId === sessionB ? record : null;
    });
    expect(after).not.toBeNull();
    expect(after!.pid).toBe(process.pid);
    expect(after!.cwd).toBe(tmpDir);
    // `name` is deliberately not patched on /clear: deriveSessionName
    // hashes the session id into the suffix, so re-deriving it would
    // rename the session a user just read out of `ps`.
    expect(after!.name).toBe(before!.name);
  });

  it('patches the registry even when the sidecar write failed at startup', async () => {
    // The two failure domains are independent: the sidecar lives in the
    // project's chats/ dir, the registry in the global dir. When the
    // sidecar write fails but registration succeeds, the patches must
    // keep going — otherwise `ps` shows stale values until exit.
    const sessionA = 'aaaaaaaa-1111-2222-3333-aaaaaaaaaaaa';
    const sessionB = 'bbbbbbbb-1111-2222-3333-bbbbbbbbbbbb';
    const config = makeConfig(sessionA);
    // No markRuntimeStatusEnabled(): models the failed sidecar write.
    expect(
      await registerSession({
        sessionId: sessionA,
        cwd: tmpDir,
        qwenVersion: '0.0.0-test',
      }),
    ).toBe(true);
    config.trackSessionRegistration(Promise.resolve(true));

    config.startNewSession(sessionB);

    const after = await waitFor(async () => {
      const [record] = await listLiveSessions();
      return record?.sessionId === sessionB ? record : null;
    });
    expect(after).not.toBeNull();
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

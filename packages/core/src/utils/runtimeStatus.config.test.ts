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

import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRegistryRecord } from '../services/session-registry.js';
import { Config } from '../config/config.js';
import { Storage } from '../config/storage.js';
import { readRuntimeStatus, writeRuntimeStatus } from './runtimeStatus.js';

/** Lets one test make the sidecar half of the swap fail. */
const failSidecarWrite = vi.hoisted(() => ({ value: false }));

/**
 * Records what the swap asked the machine-wide registry to do. Stubbed
 * rather than exercised for real: `patchSessionRecord` writes under the
 * developer's actual `~/.qwen/sessions`, and it no-ops when this PID has
 * no record — so a real call would both pollute the home directory and
 * silently pass no matter what the swap did.
 */
const patchCalls = vi.hoisted(
  () => [] as Array<Partial<SessionRegistryRecord>>,
);

vi.mock('./runtimeStatus.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtimeStatus.js')>();
  return {
    ...actual,
    writeRuntimeStatus: async (
      ...args: Parameters<typeof actual.writeRuntimeStatus>
    ) => {
      if (failSidecarWrite.value) {
        throw new Error('chats dir is read-only');
      }
      return actual.writeRuntimeStatus(...args);
    },
  };
});

vi.mock('../services/session-registry.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../services/session-registry.js')>();
  return {
    ...actual,
    patchSessionRecord: async (patch: Partial<SessionRegistryRecord>) => {
      patchCalls.push(patch);
    },
  };
});

let tmpDir: string;
let runtimeDir: string;
let prevRuntimeEnv: string | undefined;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'qwen-rt-cfg-'));
  runtimeDir = path.join(tmpDir, 'runtime');
  prevRuntimeEnv = process.env['QWEN_RUNTIME_DIR'];
  process.env['QWEN_RUNTIME_DIR'] = runtimeDir;
  patchCalls.length = 0;
  failSidecarWrite.value = false;
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

describe('Config.startNewSession session-registry swap', () => {
  const sessionA = 'aaaaaaaa-1111-2222-3333-aaaaaaaaaaaa';
  const sessionB = 'bbbbbbbb-1111-2222-3333-bbbbbbbbbbbb';

  /** Resolves once the fire-and-forget swap has reached the registry. */
  const waitForPatch = () =>
    waitFor(async () => (patchCalls.length > 0 ? patchCalls[0] : null));

  it('repoints the record for this PID at the new session', async () => {
    const config = makeConfig(sessionA);
    const aPath = config.storage.getRuntimeStatusPath(sessionA);
    await writeRuntimeStatus(aPath, {
      sessionId: sessionA,
      workDir: tmpDir,
      qwenVersion: '0.0.0-test',
    });
    config.markRuntimeStatusEnabled();

    config.startNewSession(sessionB);

    const patch = await waitForPatch();
    expect(patch).not.toBeNull();
    expect(patch).toMatchObject({ sessionId: sessionB, cwd: tmpDir });
    expect(patch!.name).toMatch(/^[\w.-]+$/);
  });

  it('patches the record even when this process never bootstrapped a sidecar', async () => {
    // Registration and the sidecar are separate signals: a startup where
    // the sidecar write failed but registerSession() succeeded leaves
    // runtimeStatusEnabled off with a live record still on disk. Gating
    // the patch on the sidecar flag would strand that record on the old
    // session id for the rest of the process's life. Unlike
    // clearRuntimeStatus, the patch is keyed by PID and cannot touch a
    // sibling's record, so it needs no ownership gate of its own.
    const config = makeConfig(sessionA);

    config.startNewSession(sessionB);

    expect(await waitForPatch()).toMatchObject({ sessionId: sessionB });
    // ...and the sibling sidecar rule above still holds: nothing written.
    const bPath = config.storage.getRuntimeStatusPath(sessionB);
    expect(await readRuntimeStatus(bPath)).toBeNull();
  });

  it('patches the record even when the sidecar half of the swap throws', async () => {
    const config = makeConfig(sessionA);
    const aPath = config.storage.getRuntimeStatusPath(sessionA);
    await writeRuntimeStatus(aPath, {
      sessionId: sessionA,
      workDir: tmpDir,
      qwenVersion: '0.0.0-test',
    });
    config.markRuntimeStatusEnabled();

    // Full disk, or a chats/ directory that went read-only after startup.
    failSidecarWrite.value = true;
    config.startNewSession(sessionB);

    // The queue swallows the rejection, so without isolating the two
    // halves the patch is simply never reached and nothing reports it.
    expect(await waitForPatch()).toMatchObject({ sessionId: sessionB });
  });

  it('does not touch the record when the session id does not change', async () => {
    const config = makeConfig(sessionA);
    config.markRuntimeStatusEnabled();

    config.startNewSession(sessionA);
    await new Promise((r) => setTimeout(r, 100));

    expect(patchCalls).toEqual([]);
  });
});

describe('Config.relocateWorkingDirectory session-registry patch', () => {
  const sessionA = 'aaaaaaaa-1111-2222-3333-aaaaaaaaaaaa';

  it('repoints the record at the directory the session moved to', async () => {
    const config = makeConfig(sessionA);
    const target = path.join(tmpDir, 'project-b');
    await mkdir(target);
    const expected = await realpath(target);

    // `/cd` refreshes the sidecar; the registry is the other half of the
    // same claim, and a reader of `qwen sessions ps` sees only the
    // registry. Left unpatched, `cwd` and the name derived from it
    // advertise the directory the session left until the next session
    // swap — possibly never.
    await config.relocateWorkingDirectory(target, expected, {
      skipProcessChdir: true,
      skipArtifactMigration: true,
    });

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]).toMatchObject({ cwd: expected });
    expect(patchCalls[0].name).toMatch(/^project-b-[0-9a-f]{2}$/);
  });

  it('patches the record even when this process never bootstrapped a sidecar', async () => {
    // Same asymmetry as the swap above: refreshCurrentRuntimeStatus
    // returns early when the sidecar was never claimed, and the registry
    // patch must not inherit that gate.
    const config = makeConfig(sessionA);
    const target = path.join(tmpDir, 'project-c');
    await mkdir(target);
    const expected = await realpath(target);

    await config.relocateWorkingDirectory(target, expected, {
      skipProcessChdir: true,
      skipArtifactMigration: true,
    });

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]).toMatchObject({ cwd: expected });
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

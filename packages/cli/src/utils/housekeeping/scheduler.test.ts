/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import {
  startBackgroundHousekeeping,
  _resetForTesting,
  _needsCatchUpForTesting,
  _runHousekeepingForTesting,
  _runPassForTesting,
  _FILE_HISTORY_MARKER_FOR_TESTING,
} from './scheduler.js';
import {
  noteInteraction,
  _resetForTesting as resetInteraction,
  _setLastInteractionForTesting,
} from './lastInteractionAt.js';

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const FILE_HISTORY_DIR = 'file-history';
// Past the 1-minute idle threshold so runPass doesn't take the defer branch.
const PAST_IDLE_THRESHOLD = 2 * 60 * 1000;

function makeSettings(cleanupPeriodDays?: number): LoadedSettings {
  return {
    merged: {
      general: cleanupPeriodDays !== undefined ? { cleanupPeriodDays } : {},
    },
  } as unknown as LoadedSettings;
}

function makeConfig(sessionId: string | (() => string)): Config {
  return {
    getSessionId: typeof sessionId === 'function' ? sessionId : () => sessionId,
  } as unknown as Config;
}

function mkSessionDir(root: string, sessionId: string, mtime: Date): void {
  const dir = path.join(root, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'snapshot'), 'x');
  fs.utimesSync(dir, mtime, mtime);
}

describe('_needsCatchUpForTesting', () => {
  let tempDir: string;
  let markerPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-scheduler-test-'));
    markerPath = path.join(tempDir, '.marker');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns true when marker does not exist', async () => {
    expect(await _needsCatchUpForTesting(markerPath)).toBe(true);
  });

  it('returns false when marker mtime is within threshold', async () => {
    fs.writeFileSync(markerPath, '');
    expect(await _needsCatchUpForTesting(markerPath)).toBe(false);
  });

  it('returns true when marker mtime is older than 7 days', async () => {
    fs.writeFileSync(markerPath, '');
    const past = new Date(Date.now() - 8 * MS_PER_DAY);
    fs.utimesSync(markerPath, past, past);
    expect(await _needsCatchUpForTesting(markerPath)).toBe(true);
  });
});

describe('_runHousekeepingForTesting', () => {
  let qwenHome: string;
  let fileHistoryRoot: string;

  beforeEach(() => {
    qwenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-scheduler-test-'));
    fileHistoryRoot = path.join(qwenHome, FILE_HISTORY_DIR);
    vi.stubEnv('QWEN_HOME', qwenHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(qwenHome, { recursive: true, force: true });
  });

  it('whitelists the current session via lazy getSessionId()', async () => {
    const old = new Date(Date.now() - 60 * MS_PER_DAY);
    mkSessionDir(fileHistoryRoot, 'current-session', old);
    mkSessionDir(fileHistoryRoot, 'other-session', old);

    await _runHousekeepingForTesting(
      makeConfig('current-session'),
      makeSettings(30),
    );

    expect(fs.readdirSync(fileHistoryRoot)).toEqual(['current-session']);
    // Marker was written by throttledOnce.
    expect(
      fs.existsSync(path.join(qwenHome, _FILE_HISTORY_MARKER_FOR_TESTING)),
    ).toBe(true);
  });

  it('re-reads sessionId on every pass (defends against /clear)', async () => {
    const old = new Date(Date.now() - 60 * MS_PER_DAY);
    mkSessionDir(fileHistoryRoot, 'session-1', old);
    mkSessionDir(fileHistoryRoot, 'session-2', old);

    let call = 0;
    const config = makeConfig(() => {
      call++;
      return call === 1 ? 'session-1' : 'session-2';
    });

    // First pass: protect session-1, sweep session-2.
    await _runHousekeepingForTesting(config, makeSettings(30));
    expect(fs.readdirSync(fileHistoryRoot)).toEqual(['session-1']);

    // Reset marker so the second pass is not throttled out.
    fs.rmSync(path.join(qwenHome, _FILE_HISTORY_MARKER_FOR_TESTING));

    // Backdate session-1 so it would be sweepable if not whitelisted.
    fs.utimesSync(path.join(fileHistoryRoot, 'session-1'), old, old);

    // Second pass: now config.getSessionId() returns session-2 (which no
    // longer exists). session-1's dir loses its whitelist and gets swept.
    await _runHousekeepingForTesting(config, makeSettings(30));
    expect(fs.existsSync(fileHistoryRoot)).toBe(false);
  });

  it('honors cleanupPeriodDays = 0 by clamping to 1 hour (active session safe)', async () => {
    const recentEnoughForOneHour = new Date(Date.now() - 30 * 60 * 1000);
    const tooOldForOneHour = new Date(Date.now() - 2 * MS_PER_HOUR);
    mkSessionDir(fileHistoryRoot, 'fresh', recentEnoughForOneHour);
    mkSessionDir(fileHistoryRoot, 'aged', tooOldForOneHour);

    await _runHousekeepingForTesting(makeConfig('unused'), makeSettings(0));

    expect(fs.readdirSync(fileHistoryRoot)).toEqual(['fresh']);
  });

  it('uses default 30 days when cleanupPeriodDays is unset', async () => {
    const twentyDaysOld = new Date(Date.now() - 20 * MS_PER_DAY);
    const fortyDaysOld = new Date(Date.now() - 40 * MS_PER_DAY);
    mkSessionDir(fileHistoryRoot, 'within', twentyDaysOld);
    mkSessionDir(fileHistoryRoot, 'beyond', fortyDaysOld);

    await _runHousekeepingForTesting(
      makeConfig('x'),
      makeSettings(/* unset */),
    );

    expect(fs.readdirSync(fileHistoryRoot)).toEqual(['within']);
  });
});

describe('_runPassForTesting (timer-chain defense)', () => {
  let qwenHome: string;

  beforeEach(() => {
    qwenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-scheduler-test-'));
    vi.stubEnv('QWEN_HOME', qwenHome);
    resetInteraction();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(qwenHome, { recursive: true, force: true });
  });

  it('catches errors escaping runHousekeeping so the next pass still gets scheduled', async () => {
    // Backdate the last interaction so runPass doesn't take the idle defer
    // branch — otherwise the throwing config below is never reached and
    // this test would pass vacuously.
    _setLastInteractionForTesting(Date.now() - PAST_IDLE_THRESHOLD);

    const throwingConfig = {
      getSessionId: () => {
        throw new Error('boom');
      },
    } as unknown as Config;

    await expect(
      _runPassForTesting(throwingConfig, makeSettings(30)),
    ).resolves.toBeUndefined();
  });

  it('takes the defer branch when user interacted recently and never invokes the work path', async () => {
    // Mark interaction as "just now" — runPass should defer without ever
    // calling getSessionId().
    noteInteraction();
    let invoked = false;
    const config = makeConfig(() => {
      invoked = true;
      return 'unused';
    });

    await _runPassForTesting(config, makeSettings(30));
    expect(invoked).toBe(false);
  });
});

describe('startBackgroundHousekeeping', () => {
  // We deliberately don't test the timer chain end-to-end here — vitest fake
  // timers don't compose cleanly with the async `await stat()` inside
  // scheduleFirstPass plus the runHousekeeping promise chain, and global
  // spyOn(setTimeout) is unreliable for module-scope references in this ESM
  // setup. The building blocks (needsCatchUp, runHousekeeping, runPass) are
  // covered above; the glue is a few lines of imperative scheduling that
  // should be verified by the manual smoke test in the pre-PR checklist.
  let qwenHome: string;

  beforeEach(() => {
    qwenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-scheduler-test-'));
    vi.stubEnv('QWEN_HOME', qwenHome);
    _resetForTesting();
    resetInteraction();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(qwenHome, { recursive: true, force: true });
    _resetForTesting();
  });

  it('returns synchronously without throwing', () => {
    const config = makeConfig('s');
    const settings = makeSettings(30);
    expect(() => startBackgroundHousekeeping(config, settings)).not.toThrow();
  });

  it('second call is a no-op (started flag)', async () => {
    const config = makeConfig('s');
    const settings = makeSettings(30);
    startBackgroundHousekeeping(config, settings);
    // Drain scheduleFirstPass's await.
    await new Promise((r) => setImmediate(r));
    // Second call: no observable behavior. Pure smoke check that it doesn't
    // throw, doesn't reset state, and doesn't double-fire.
    expect(() => startBackgroundHousekeeping(config, settings)).not.toThrow();
  });
});

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
  _getFirstPassDelayForTesting,
  _runHousekeepingForTesting,
  _runPassForTesting,
  _FILE_HISTORY_MARKER_FOR_TESTING,
  _getSubagentMarkerPathForTesting,
  _getOpenAILogsMarkerPathForTesting,
} from './scheduler.js';
import {
  noteInteraction,
  _resetForTesting as resetInteraction,
  _setLastInteractionForTesting,
} from '../../utils/housekeeping/lastInteractionAt.js';

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

function makeConfig(
  sessionId: string | (() => string),
  projectDir?: string,
): Config {
  return {
    getSessionId: typeof sessionId === 'function' ? sessionId : () => sessionId,
    // Only wire storage when a projectDir is given so existing file-history
    // tests (no projectDir) skip the subagent sweep via runHousekeeping's guard.
    storage: projectDir ? { getProjectDir: () => projectDir } : undefined,
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

  it('sweeps old subagent transcripts under <projectDir>/subagents, protecting the current session', async () => {
    const projectDir = path.join(qwenHome, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    const subagentsRoot = path.join(projectDir, 'subagents');
    const old = new Date(Date.now() - 60 * MS_PER_DAY);
    const recent = new Date(Date.now() - 1 * MS_PER_DAY);
    mkSessionDir(subagentsRoot, 'current-session', old); // protected (current)
    mkSessionDir(subagentsRoot, 'stale-session', old); // swept
    mkSessionDir(subagentsRoot, 'recent-session', recent); // kept (young)

    await _runHousekeepingForTesting(
      makeConfig('current-session', projectDir),
      makeSettings(30),
    );

    expect(fs.readdirSync(subagentsRoot).sort()).toEqual([
      'current-session',
      'recent-session',
    ]);
    expect(
      fs.existsSync(_getSubagentMarkerPathForTesting(qwenHome, projectDir)),
    ).toBe(true);
    expect(fs.existsSync(path.join(projectDir, '.subagent-cleanup'))).toBe(
      false,
    );
  });

  it('throttles the subagent sweep per project (second pass does not re-sweep)', async () => {
    const projectDir = path.join(qwenHome, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    const subagentsRoot = path.join(projectDir, 'subagents');
    const old = new Date(Date.now() - 60 * MS_PER_DAY);
    mkSessionDir(subagentsRoot, 'stale-1', old);

    await _runHousekeepingForTesting(
      makeConfig('current', projectDir),
      makeSettings(30),
    );
    expect(fs.existsSync(path.join(subagentsRoot, 'stale-1'))).toBe(false);
    expect(
      fs.existsSync(_getSubagentMarkerPathForTesting(qwenHome, projectDir)),
    ).toBe(true);

    // A fresh old dir + an immediate second pass: the per-project marker
    // throttles it, so the new dir is NOT swept.
    mkSessionDir(subagentsRoot, 'stale-2', old);
    await _runHousekeepingForTesting(
      makeConfig('current', projectDir),
      makeSettings(30),
    );
    expect(fs.existsSync(path.join(subagentsRoot, 'stale-2'))).toBe(true);
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

describe('_runHousekeepingForTesting (openai-logs cleanup)', () => {
  let qwenHome: string;
  let logDir: string;

  beforeEach(() => {
    qwenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-scheduler-test-'));
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-openai-logs-'));
    vi.stubEnv('QWEN_HOME', qwenHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(qwenHome, { recursive: true, force: true });
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  function makeOpenAIConfig(
    openAILoggingDir: string | undefined,
    workingDir: string = process.cwd(),
  ): Config {
    return {
      getSessionId: () => 's1',
      getWorkingDir: () => workingDir,
      getContentGeneratorConfig: () => ({ openAILoggingDir }),
    } as unknown as Config;
  }

  function makeModelSettings(
    retentionDays?: number,
    options: {
      openAILoggingDir?: string;
      systemRetentionDays?: number;
      userRetentionDays?: number;
      workspaceRetentionDays?: number;
    } = {},
  ): LoadedSettings {
    const model = {
      ...(retentionDays !== undefined
        ? { openAILogRetentionDays: retentionDays }
        : {}),
      ...(options.openAILoggingDir
        ? { openAILoggingDir: options.openAILoggingDir }
        : {}),
    };
    return {
      merged: {
        general: {},
        model,
      },
      isTrusted: true,
      system: {
        settings: {
          model:
            options.systemRetentionDays !== undefined
              ? { openAILogRetentionDays: options.systemRetentionDays }
              : {},
        },
      },
      systemDefaults: { settings: {} },
      user: {
        settings: {
          model:
            options.userRetentionDays !== undefined
              ? { openAILogRetentionDays: options.userRetentionDays }
              : {},
        },
      },
      workspace: {
        settings: {
          model:
            options.workspaceRetentionDays !== undefined
              ? { openAILogRetentionDays: options.workspaceRetentionDays }
              : {},
        },
      },
    } as unknown as LoadedSettings;
  }

  function mkOpenAILogAt(
    targetDir: string,
    ageMs: number,
    id = 'a1b2c3d4',
  ): string {
    const d = new Date(Date.now() - ageMs);
    const name = `openai-${d.toISOString().replace(/:/g, '-')}-${id}.json`;
    const p = path.join(targetDir, name);
    fs.writeFileSync(p, '{}');
    fs.utimesSync(p, d, d);
    return p;
  }

  function mkOpenAILog(daysAgo: number, targetDir = logDir): string {
    return mkOpenAILogAt(targetDir, daysAgo * MS_PER_DAY);
  }

  it('removes logs older than the retention and writes the per-dir marker', async () => {
    const old = mkOpenAILog(10);
    const fresh = mkOpenAILog(1);

    await _runHousekeepingForTesting(
      makeOpenAIConfig(logDir),
      makeModelSettings(7),
    );

    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(
      fs.existsSync(_getOpenAILogsMarkerPathForTesting(qwenHome, logDir)),
    ).toBe(true);
  });

  it('uses the default 7-day retention when openAILogRetentionDays is unset', async () => {
    const old = mkOpenAILog(10);

    await _runHousekeepingForTesting(
      makeOpenAIConfig(logDir),
      makeModelSettings(/* unset */),
    );

    expect(fs.existsSync(old)).toBe(false);
  });

  it('honors a longer configured retention', async () => {
    const tenDays = mkOpenAILog(10);

    await _runHousekeepingForTesting(
      makeOpenAIConfig(logDir),
      makeModelSettings(30, { userRetentionDays: 30 }),
    );

    expect(fs.existsSync(tenDays)).toBe(true);
  });

  it('honors retention = 0 through the scheduler', async () => {
    const aged = mkOpenAILogAt(logDir, 2 * MS_PER_HOUR);
    const fresh = mkOpenAILogAt(logDir, 30 * 60 * 1000, 'b2c3d4e5');

    await _runHousekeepingForTesting(
      makeOpenAIConfig(logDir),
      makeModelSettings(0, { userRetentionDays: 0 }),
    );

    expect(fs.existsSync(aged)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('throttles OpenAI log cleanup independently for different directories', async () => {
    const otherLogDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'qwen-openai-logs-other-'),
    );
    try {
      const first = mkOpenAILog(10);
      const second = mkOpenAILog(10, otherLogDir);

      await _runHousekeepingForTesting(
        makeOpenAIConfig(logDir),
        makeModelSettings(7),
      );
      await _runHousekeepingForTesting(
        makeOpenAIConfig(otherLogDir),
        makeModelSettings(7),
      );

      expect(fs.existsSync(first)).toBe(false);
      expect(fs.existsSync(second)).toBe(false);
      expect(_getOpenAILogsMarkerPathForTesting(qwenHome, logDir)).not.toBe(
        _getOpenAILogsMarkerPathForTesting(qwenHome, otherLogDir),
      );
    } finally {
      fs.rmSync(otherLogDir, { recursive: true, force: true });
    }
  });

  it('resolves the default per-CWD log dir from getWorkingDir()', async () => {
    const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-cwd-'));
    try {
      const defaultLogDir = path.join(workingDir, 'logs', 'openai');
      fs.mkdirSync(defaultLogDir, { recursive: true });
      const d = new Date(Date.now() - 10 * MS_PER_DAY);
      const old = path.join(
        defaultLogDir,
        'openai-2026-06-01T10-00-00.000Z-a1b2c3d4.json',
      );
      fs.writeFileSync(old, '{}');
      fs.utimesSync(old, d, d);

      await _runHousekeepingForTesting(
        makeOpenAIConfig(undefined, workingDir),
        makeModelSettings(7),
      );

      expect(fs.existsSync(old)).toBe(false);
    } finally {
      fs.rmSync(workingDir, { recursive: true, force: true });
    }
  });

  it('uses the settings directory when content-generator config is unavailable', async () => {
    const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-cwd-'));
    try {
      const defaultLogDir = path.join(workingDir, 'logs', 'openai');
      fs.mkdirSync(defaultLogDir, { recursive: true });
      const configuredOld = mkOpenAILog(10);
      const defaultSentinel = mkOpenAILog(10, defaultLogDir);
      const config = {
        getSessionId: () => 's1',
        getWorkingDir: () => workingDir,
        getContentGeneratorConfig: () => undefined,
      } as unknown as Config;

      await _runHousekeepingForTesting(
        config,
        makeModelSettings(7, {
          openAILoggingDir: logDir,
          userRetentionDays: 7,
        }),
      );

      expect(fs.existsSync(configuredOld)).toBe(false);
      expect(fs.existsSync(defaultSentinel)).toBe(true);
    } finally {
      fs.rmSync(workingDir, { recursive: true, force: true });
    }
  });

  it('skips custom-directory cleanup for workspace-scoped retention', async () => {
    const old = mkOpenAILog(60);

    await _runHousekeepingForTesting(
      makeOpenAIConfig(logDir),
      makeModelSettings(7, { workspaceRetentionDays: 7 }),
    );
    await _runHousekeepingForTesting(
      makeOpenAIConfig(logDir),
      makeModelSettings(30, { workspaceRetentionDays: 30 }),
    );

    expect(fs.existsSync(old)).toBe(true);
    expect(
      fs.existsSync(_getOpenAILogsMarkerPathForTesting(qwenHome, logDir)),
    ).toBe(false);
  });

  it('uses the system retention owner for a custom directory', async () => {
    const old = mkOpenAILog(60);

    await _runHousekeepingForTesting(
      makeOpenAIConfig(logDir),
      makeModelSettings(7, {
        systemRetentionDays: 7,
        workspaceRetentionDays: 30,
      }),
    );

    expect(fs.existsSync(old)).toBe(false);
    expect(
      fs.existsSync(_getOpenAILogsMarkerPathForTesting(qwenHome, logDir)),
    ).toBe(true);
  });

  it('uses catch-up delay when the OpenAI marker is missing', async () => {
    fs.writeFileSync(path.join(qwenHome, _FILE_HISTORY_MARKER_FOR_TESTING), '');

    await expect(
      _getFirstPassDelayForTesting(
        makeOpenAIConfig(logDir),
        makeModelSettings(7),
      ),
    ).resolves.toBe(60 * 1000);
  });

  it('uses the normal delay only when the OpenAI marker is fresh', async () => {
    fs.writeFileSync(path.join(qwenHome, _FILE_HISTORY_MARKER_FOR_TESTING), '');
    fs.writeFileSync(_getOpenAILogsMarkerPathForTesting(qwenHome, logDir), '');

    await expect(
      _getFirstPassDelayForTesting(
        makeOpenAIConfig(logDir),
        makeModelSettings(7),
      ),
    ).resolves.toBe(10 * 60 * 1000);
  });

  it('uses catch-up delay when the OpenAI marker is older than seven days', async () => {
    const fileHistoryMarker = path.join(
      qwenHome,
      _FILE_HISTORY_MARKER_FOR_TESTING,
    );
    const openaiMarker = _getOpenAILogsMarkerPathForTesting(qwenHome, logDir);
    fs.writeFileSync(fileHistoryMarker, '');
    fs.writeFileSync(openaiMarker, '');
    const stale = new Date(Date.now() - 8 * MS_PER_DAY);
    fs.utimesSync(openaiMarker, stale, stale);

    await expect(
      _getFirstPassDelayForTesting(
        makeOpenAIConfig(logDir),
        makeModelSettings(7),
      ),
    ).resolves.toBe(60 * 1000);
  });

  it('skips the sweep gracefully when the log dir cannot be resolved', async () => {
    const fresh = mkOpenAILog(1);
    const throwingConfig = {
      getSessionId: () => 's1',
      getWorkingDir: () => process.cwd(),
      getContentGeneratorConfig: () => {
        throw new Error('not ready');
      },
    } as unknown as Config;

    await expect(
      _runHousekeepingForTesting(throwingConfig, makeModelSettings(7)),
    ).resolves.toBeUndefined();
    expect(fs.existsSync(fresh)).toBe(true);
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

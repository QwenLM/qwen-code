/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ENV_CONFIG_DIR } from '@qwen-code/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const cleanupMocks = vi.hoisted(() => ({
  cleanupExpiredSessions: vi.fn().mockResolvedValue({ failed: 0 }),
  cleanupToolOutputFiles: vi.fn().mockResolvedValue({ failed: 0 }),
  cleanupDiagnosticLogs: vi.fn().mockResolvedValue({ failed: 0 }),
  cleanupBackgroundLogs: vi.fn().mockResolvedValue({ failed: 0 }),
  cleanupOldSessionEnvDirs: vi.fn().mockReturnValue(true),
}));

vi.mock('./sessionCleanup.js', async (importActual) => {
  const actual = await importActual<typeof import('./sessionCleanup.js')>();
  return {
    ...actual,
    cleanupExpiredSessions: cleanupMocks.cleanupExpiredSessions,
    cleanupToolOutputFiles: cleanupMocks.cleanupToolOutputFiles,
  };
});

vi.mock('./diagnosticLogCleanup.js', () => ({
  cleanupDiagnosticLogs: cleanupMocks.cleanupDiagnosticLogs,
}));

vi.mock('./logCleanup.js', () => ({
  cleanupBackgroundLogs: cleanupMocks.cleanupBackgroundLogs,
}));

vi.mock('@qwen-code/core', async (importActual) => {
  const actual =
    await importActual<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    cleanupOldSessionEnvDirs: cleanupMocks.cleanupOldSessionEnvDirs,
  };
});

import {
  _resetConfigHomeDirCache,
  type Config,
} from '@qwen-code/core';
import type { Settings } from '../config/settings.js';
import {
  cancelDeferredStartupCleanup,
  runStartupCleanupNow,
  startDeferredStartupCleanup,
} from './deferredStartupTasks.js';

describe('deferred startup cleanup', () => {
  let configDir: string;
  let projectTempDir: string;
  let config: Config;

  beforeEach(async () => {
    configDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'deferred-startup-cleanup-'),
    );
    projectTempDir = path.join(configDir, 'projects', 'current-project');
    vi.stubEnv(ENV_CONFIG_DIR, configDir);
    _resetConfigHomeDirCache();
    config = {
      storage: { getProjectTempDir: () => projectTempDir },
      getDebugMode: () => false,
    } as Config;
    cleanupMocks.cleanupExpiredSessions.mockReset().mockResolvedValue({
      failed: 0,
    });
    cleanupMocks.cleanupToolOutputFiles.mockReset().mockResolvedValue({
      failed: 0,
    });
    cleanupMocks.cleanupDiagnosticLogs.mockReset().mockResolvedValue({
      failed: 0,
    });
    cleanupMocks.cleanupBackgroundLogs.mockReset().mockResolvedValue({
      failed: 0,
    });
    cleanupMocks.cleanupOldSessionEnvDirs.mockReset().mockReturnValue(true);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    _resetConfigHomeDirCache();
    await fs.rm(configDir, { recursive: true, force: true });
  });

  it.each([false, true])(
    'cleans WebFetch independently of retention and shares the global daily marker (recent=%s)',
    async (recent) => {
      const outputs = path.join(
        configDir,
        'tmp',
        'another-project',
        'tool-outputs',
        'session-old',
      );
      await fs.mkdir(outputs, { recursive: true });
      const file = path.join(
        outputs,
        'webfetch-11111111-1111-4111-8111-111111111111.md',
      );
      await fs.writeFile(file, 'old page');
      const old = new Date(Date.now() - 8 * 86400000);
      await fs.utimes(file, old, old);
      if (recent)
        await fs.writeFile(
          path.join(configDir, '.last-cleanup'),
          'already ran',
        );
      const settings = {
        general: { sessionRetention: { enabled: false } },
      } as Settings;
      await runStartupCleanupNow(settings, undefined);
      if (recent) await expect(fs.stat(file)).resolves.toBeDefined();
      else
        await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.stat(outputs)).toBeDefined();
      expect(cleanupMocks.cleanupDiagnosticLogs).toHaveBeenCalledTimes(
        recent ? 0 : 1,
      );
    },
  );

  it('runs all cleanup operations and records successful completion', async () => {
    const settings = {} as Settings;

    await runStartupCleanupNow(settings, config);

    expect(cleanupMocks.cleanupExpiredSessions).toHaveBeenCalledWith(
      config,
      settings,
    );
    expect(cleanupMocks.cleanupToolOutputFiles).toHaveBeenCalledWith(
      settings,
      false,
      projectTempDir,
    );
    expect(cleanupMocks.cleanupDiagnosticLogs).toHaveBeenCalledWith();
    expect(cleanupMocks.cleanupBackgroundLogs).toHaveBeenCalledOnce();
    expect(cleanupMocks.cleanupOldSessionEnvDirs).toHaveBeenCalledOnce();
    await expect(fs.stat(path.join(configDir, '.last-cleanup'))).resolves.toBeDefined();
    await expect(
      fs.stat(path.join(projectTempDir, '.last-cleanup')),
    ).resolves.toBeDefined();
    await expect(fs.stat(path.join(configDir, '.cleanup.lock'))).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
    await expect(
      fs.stat(path.join(projectTempDir, '.cleanup.lock')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('only stats the markers when cleanup completed within the last day', async () => {
    await fs.mkdir(projectTempDir, { recursive: true });
    await fs.writeFile(path.join(configDir, '.last-cleanup'), 'recent\n');
    await fs.writeFile(path.join(projectTempDir, '.last-cleanup'), 'recent\n');

    await runStartupCleanupNow({} as Settings, config);

    for (const cleanup of Object.values(cleanupMocks)) {
      expect(cleanup).not.toHaveBeenCalled();
    }
  });

  it('allows only one settings instance to clean the same config directory', async () => {
    let releaseCleanup: (() => void) | undefined;
    cleanupMocks.cleanupExpiredSessions.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        }),
    );

    const first = runStartupCleanupNow({} as Settings, config);
    await vi.waitFor(() => {
      expect(cleanupMocks.cleanupExpiredSessions).toHaveBeenCalledOnce();
    });

    await runStartupCleanupNow({} as Settings, config);
    expect(cleanupMocks.cleanupExpiredSessions).toHaveBeenCalledOnce();

    releaseCleanup?.();
    await first;
  });

  it('does not record project completion when project cleanup rejects', async () => {
    cleanupMocks.cleanupExpiredSessions.mockRejectedValueOnce(
      new Error('cleanup failed'),
    );

    await runStartupCleanupNow({} as Settings, config);

    await expect(
      fs.stat(path.join(projectTempDir, '.last-cleanup')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(configDir, '.last-cleanup'))).resolves.toBeDefined();
  });

  it('does not record completion when cleanup reports partial failures', async () => {
    cleanupMocks.cleanupExpiredSessions.mockResolvedValueOnce({ failed: 1 });
    cleanupMocks.cleanupDiagnosticLogs.mockResolvedValueOnce({ failed: 1 });

    await runStartupCleanupNow({} as Settings, config);

    await expect(
      fs.stat(path.join(projectTempDir, '.last-cleanup')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.stat(path.join(configDir, '.last-cleanup')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('skips project cleanup without recording its sentinel', async () => {
    await runStartupCleanupNow({} as Settings, config, {
      includeProjectCleanup: false,
    });

    expect(cleanupMocks.cleanupExpiredSessions).not.toHaveBeenCalled();
    expect(cleanupMocks.cleanupToolOutputFiles).not.toHaveBeenCalled();
    expect(cleanupMocks.cleanupDiagnosticLogs).toHaveBeenCalledOnce();
    await expect(fs.stat(path.join(configDir, '.last-cleanup'))).resolves.toBeDefined();
    await expect(
      fs.stat(path.join(projectTempDir, '.last-cleanup')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cancels cleanup that has not reached its delay', async () => {
    vi.useFakeTimers();
    const settings = {} as Settings;
    startDeferredStartupCleanup(settings, config, {
      delayMs: 5000,
      ref: false,
    });

    cancelDeferredStartupCleanup(settings);
    await vi.advanceTimersByTimeAsync(5000);

    for (const cleanup of Object.values(cleanupMocks)) {
      expect(cleanup).not.toHaveBeenCalled();
    }
  });
});

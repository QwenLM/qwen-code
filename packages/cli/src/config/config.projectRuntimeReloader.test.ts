/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalMode, Storage } from '@qwen-code/qwen-code-core';
import {
  createProjectRuntimeReloader,
  parseArguments,
  resolvePersistenceSettings,
} from './config.js';
import type { CliArgs } from './config.js';
import {
  createMinimalSettings,
  loadSettings,
  resetHomeEnvBootstrapForTesting,
  type LoadedSettings,
} from './settings.js';
import { AppEvent, appEvents } from '../utils/events.js';

/**
 * Drives the real reloader against real settings files and `.env` files
 * on disk — every other layer mocks the layer below it, so this is the
 * only place the settings→runtime assembly and the commit/rollback
 * transaction are actually executed.
 */
describe('createProjectRuntimeReloader', () => {
  let tempDir: string;
  let projectA: string;
  let projectB: string;
  let previousQwenHome: string | undefined;
  let argv: CliArgs;
  const ENV_KEYS = ['A_KEY', 'B_TOKEN'];

  const writeProject = (
    dir: string,
    settings: Record<string, unknown>,
    env?: string,
  ) => {
    const settingsPath = new Storage(dir).getWorkspaceSettingsPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    if (env !== undefined) {
      fs.writeFileSync(path.join(path.dirname(settingsPath), '.env'), env);
    }
  };

  const writeUserSettings = (settings: Record<string, unknown>) => {
    const userPath = Storage.getGlobalSettingsPath();
    fs.mkdirSync(path.dirname(userPath), { recursive: true });
    fs.writeFileSync(userPath, JSON.stringify(settings));
  };

  const startupSettings = (): LoadedSettings =>
    loadSettings(projectA, {
      consumeCorruptionEnvVars: false,
      workspaceTrusted: true,
    });

  const makeReloader = (
    loaded: LoadedSettings,
    overrides: {
      bareMode?: boolean;
      safeMode?: boolean;
      modelDisablesToolSearch?: boolean;
      settingsWatcher?: { pauseWorkspaceWatching?: () => Promise<() => void> };
    } = {},
  ) =>
    createProjectRuntimeReloader(
      loaded,
      overrides.settingsWatcher,
      argv,
      undefined,
      overrides.bareMode ?? false,
      overrides.safeMode ?? false,
      [],
      overrides.modelDisablesToolSearch ?? false,
    );

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-runtime-reloader-'));
    previousQwenHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = path.join(tempDir, 'home');
    resetHomeEnvBootstrapForTesting();
    projectA = path.join(tempDir, 'project-a');
    projectB = path.join(tempDir, 'project-b');
    fs.mkdirSync(projectA, { recursive: true });
    fs.mkdirSync(projectB, { recursive: true });
    for (const key of ENV_KEYS) delete process.env[key];
    process.argv = ['node', 'script.js'];
    argv = await parseArguments();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    if (previousQwenHome === undefined) {
      delete process.env['QWEN_HOME'];
    } else {
      process.env['QWEN_HOME'] = previousQwenHome;
    }
    resetHomeEnvBootstrapForTesting();
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('applies the target project environment on commit and restores it on rollback', async () => {
    // The assembled MCP servers inherit `process.env` at spawn; without
    // this step project B's server started without `B_TOKEN` while A's
    // `A_KEY` was still leaking into B's subprocesses.
    writeProject(projectA, {}, 'A_KEY=from-a\n');
    writeProject(projectB, {}, 'B_TOKEN=from-b\n');
    const loaded = startupSettings();
    expect(process.env['A_KEY']).toBe('from-a');
    expect(process.env['B_TOKEN']).toBeUndefined();

    const prepared = await makeReloader(loaded).prepare(
      projectB,
      true,
      ApprovalMode.DEFAULT,
      projectA,
    );
    expect(process.env['B_TOKEN']).toBeUndefined();

    await prepared.commit();
    expect(process.env['B_TOKEN']).toBe('from-b');
    expect(process.env['A_KEY']).toBeUndefined();

    await prepared.rollback();
    expect(process.env['A_KEY']).toBe('from-a');
    expect(process.env['B_TOKEN']).toBeUndefined();
  });

  it('keeps a bare session on minimal settings instead of loading the user files', async () => {
    // Bare startup never reads `~/.qwen/settings.json`; a `/cd` that did
    // would make ambient command hooks (bugCommand, artifact upload) live
    // mid-session and point later settings writes at the real files.
    writeUserSettings({
      experimental: { cron: false },
      advanced: { bugCommand: { urlTemplate: 'https://bugs.example/{title}' } },
    });
    writeProject(projectB, { experimental: { cron: false } });
    const loaded = createMinimalSettings();

    const prepared = await makeReloader(loaded, { bareMode: true }).prepare(
      projectB,
      true,
      ApprovalMode.DEFAULT,
      projectA,
    );

    expect(prepared.config.cronEnabled).toBe(true);
    expect(prepared.config.bugCommand).toBeUndefined();
    await prepared.commit();
    expect(loaded.user.path).toBe('');
    expect(loaded.workspace.path).toBe('');
  });

  it('replicates the startup tool_search denial', async () => {
    writeProject(projectA, {});
    const denyOf = async (
      settings: Record<string, unknown>,
      modelDisablesToolSearch: boolean,
    ) => {
      writeProject(projectB, settings);
      const prepared = await makeReloader(startupSettings(), {
        modelDisablesToolSearch,
      }).prepare(projectB, true, ApprovalMode.DEFAULT, projectA);
      return {
        deny: prepared.config.permissions?.deny ?? [],
        exclude: prepared.config.excludeTools ?? [],
      };
    };

    // Explicitly disabled in the target's settings.
    const explicit = await denyOf(
      { tools: { toolSearch: { enabled: false } } },
      false,
    );
    expect(explicit.deny).toContain('tool_search');
    expect(explicit.exclude).toContain('tool_search');

    // Disabled by the session model, nothing in settings.
    const byModel = await denyOf({}, true);
    expect(byModel.deny).toContain('tool_search');

    // An explicit enable wins over the model-derived default, as at startup.
    const enabled = await denyOf(
      { tools: { toolSearch: { enabled: true } } },
      true,
    );
    expect(enabled.deny).not.toContain('tool_search');
  });

  it('projects agents settings the same way startup does', async () => {
    // Startup drops schema keys the runtime ignores (`team`, …); a raw
    // passthrough here applied `team.maxTeammates` only after a `/cd`.
    writeProject(projectA, {});
    writeProject(projectB, {
      agents: { allowedGrades: ['fast'], team: { maxTeammates: 7 } },
    });

    const prepared = await makeReloader(startupSettings()).prepare(
      projectB,
      true,
      ApprovalMode.DEFAULT,
      projectA,
    );

    expect(prepared.config.agents?.allowedGrades).toEqual(['fast']);
    expect('team' in (prepared.config.agents ?? {})).toBe(false);
  });

  it('swaps the loaded settings on commit, restores them on rollback, and resumes the watcher', async () => {
    writeProject(projectA, { disableAllHooks: true });
    writeProject(projectB, { disableAllHooks: false });
    const loaded = startupSettings();
    const workspacePathA = loaded.workspace.path;
    const resume = vi.fn();
    const pauseWorkspaceWatching = vi.fn().mockResolvedValue(resume);
    const emit = vi.spyOn(appEvents, 'emit');

    const prepared = await makeReloader(loaded, {
      settingsWatcher: { pauseWorkspaceWatching },
    }).prepare(projectB, true, ApprovalMode.DEFAULT, projectA);
    expect(prepared.config.disableAllHooks).toBe(false);
    expect(loaded.merged.disableAllHooks).toBe(true);

    await prepared.commit();
    expect(pauseWorkspaceWatching).toHaveBeenCalledOnce();
    expect(resume).not.toHaveBeenCalled();
    expect(loaded.workspace.path).toBe(
      new Storage(projectB).getWorkspaceSettingsPath(),
    );
    expect(loaded.merged.disableAllHooks).toBe(false);

    await prepared.rollback();
    expect(loaded.workspace.path).toBe(workspacePathA);
    expect(loaded.merged.disableAllHooks).toBe(true);
    expect(resume).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(AppEvent.McpPendingApprovalChanged);
  });

  it('never persists permission rules through a minimal (bare) settings instance', () => {
    // Bare mode's LoadedSettings has no file behind any scope; writing an
    // "Always allow" rule through it threw on `rename('.tmp', '')` and the
    // rule landed neither on disk nor in memory.
    writeProject(projectA, {});
    const minimal = createMinimalSettings();
    const resolved = resolvePersistenceSettings(minimal, projectA);
    expect(resolved).not.toBe(minimal);
    expect(resolved.user.path).toBe(Storage.getGlobalSettingsPath());

    const real = startupSettings();
    expect(resolvePersistenceSettings(real, projectA)).toBe(real);
  });

  it('resumes the watcher when the settings swap itself throws', async () => {
    // Otherwise a one-off `replaceWith` failure leaves the workspace
    // watcher stopped for the rest of the session.
    writeProject(projectA, {});
    writeProject(projectB, {});
    const loaded = startupSettings();
    const resume = vi.fn();
    vi.spyOn(loaded, 'replaceWith').mockImplementationOnce(() => {
      throw new Error('swap failed');
    });

    const prepared = await makeReloader(loaded, {
      settingsWatcher: { pauseWorkspaceWatching: async () => resume },
    }).prepare(projectB, true, ApprovalMode.DEFAULT, projectA);

    await expect(prepared.commit()).rejects.toThrow('swap failed');
    expect(resume).toHaveBeenCalledOnce();
  });
});

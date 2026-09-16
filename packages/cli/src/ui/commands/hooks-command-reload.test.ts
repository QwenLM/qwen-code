/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Config, HookSystem } from '@qwen-code/qwen-code-core';
import {
  LoadedSettings,
  type Settings,
  type SettingsFile,
} from '../../config/settings.js';
import { resolveHookSettingsForConfig } from '../../config/hook-settings.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { hooksCommand } from './hooksCommand.js';

const hook = (command: string) => [
  { matcher: '*', hooks: [{ type: 'command' as const, command }] },
];

describe('/hooks reload with real settings files', () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-reload-'));
    vi.stubEnv('QWEN_HOME', path.join(directory, 'user'));
    vi.stubEnv(
      'QWEN_CODE_SYSTEM_SETTINGS_PATH',
      path.join(directory, 'system.json'),
    );
    vi.stubEnv(
      'QWEN_CODE_SYSTEM_DEFAULTS_PATH',
      path.join(directory, 'defaults.json'),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function settingsFile(
    filePath: string,
    value: Record<string, unknown>,
  ): SettingsFile {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const rawJson = JSON.stringify({ $version: 4, ...value });
    const settings = JSON.parse(rawJson) as Settings;
    fs.writeFileSync(filePath, rawJson);
    return {
      path: filePath,
      settings,
      originalSettings: structuredClone(settings),
      rawJson,
    };
  }

  async function setup(worktree = false, trusted = true) {
    const repo = path.join(directory, 'repo');
    const settings = new LoadedSettings(
      settingsFile(path.join(directory, 'system.json'), {}),
      settingsFile(path.join(directory, 'defaults.json'), {}),
      settingsFile(path.join(directory, 'user/settings.json'), {
        hooks: { Stop: hook('echo user') },
      }),
      settingsFile(path.join(repo, '.qwen/settings.json'), {
        hooks: { PreToolUse: hook('echo project') },
      }),
      trusted,
      new Set(),
    );
    const cwd = worktree ? path.join(repo, '.qwen/worktrees/session') : repo;
    fs.mkdirSync(cwd, { recursive: true });
    const config = new Config({
      sessionId: 'hooks-reload',
      targetDir: cwd,
      cwd,
      debugMode: false,
      trustedFolder: trusted,
      usageStatisticsEnabled: false,
      ...resolveHookSettingsForConfig(
        settings.merged.hooks,
        {
          userHooks: settings.getUserHooks(),
          projectHooks: settings.getProjectHooks(),
        },
        false,
      ),
    });
    const system = new HookSystem(config);
    await system.initialize();
    vi.spyOn(config, 'getHookSystem').mockReturnValue(system);
    const setHooks = vi.spyOn(config, 'setHooksFromSettings');
    const context = createMockCommandContext();
    context.services.config = config;
    context.services.settings = settings;
    const entries = () => system.getRegistry().getAllHooks();
    return { config, settings, system, setHooks, context, entries };
  }

  it('reloads the startup workspace even when the session cwd is a worktree', async () => {
    const { config, settings, context, entries } = await setup(true);
    expect(path.dirname(path.dirname(settings.workspace.path))).not.toBe(
      config.getWorkingDir(),
    );
    fs.writeFileSync(
      settings.workspace.path,
      JSON.stringify({
        hooks: {
          PostToolUse: hook('echo replacement'),
        },
      }),
    );

    await hooksCommand.action!(context, '');

    expect(
      entries().map(({ eventName, source }) => ({ eventName, source })),
    ).toEqual([
      { eventName: 'Stop', source: 'user' },
      { eventName: 'PostToolUse', source: 'project' },
    ]);
    expect(context.ui.addItem).not.toHaveBeenCalled();
  });

  it.each(['user', 'workspace'] as const)(
    'preserves both scopes and active hooks when %s JSON is malformed',
    async (scope) => {
      const { settings, context, entries, setHooks } = await setup();
      const before = entries();
      const mergedBefore = structuredClone(settings.merged);
      const malformed = '{"hooks": INVALID EDIT';
      fs.writeFileSync(settings[scope].path, malformed);
      const other = scope === 'user' ? 'workspace' : 'user';
      fs.writeFileSync(
        settings[other].path,
        JSON.stringify({ hooks: { PostToolUse: hook('echo edited') } }),
      );

      expect(await hooksCommand.action!(context, '')).toEqual({
        type: 'dialog',
        dialog: 'hooks',
      });

      expect(fs.readFileSync(settings[scope].path, 'utf8')).toBe(malformed);
      expect(fs.existsSync(`${settings[scope].path}.corrupted`)).toBe(false);
      expect(settings.merged).toEqual(mergedBefore);
      expect(entries()).toEqual(before);
      expect(setHooks).not.toHaveBeenCalled();
      expect(context.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error' }),
        expect.any(Number),
      );
    },
  );

  it('removes deleted project hooks from the live registry', async () => {
    const { settings, context, entries } = await setup();
    fs.writeFileSync(settings.workspace.path, '{}');

    await hooksCommand.action!(context, '');

    expect(entries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventName: 'Stop', source: 'user' }),
      ]),
    );
    expect(entries().some(({ eventName }) => eventName === 'PreToolUse')).toBe(
      false,
    );
  });

  it('does not admit project hooks from an untrusted startup workspace', async () => {
    const { settings, context, entries } = await setup(false, false);
    fs.writeFileSync(
      settings.workspace.path,
      JSON.stringify({ hooks: { PostToolUse: hook('echo untrusted') } }),
    );

    await hooksCommand.action!(context, '');

    expect(entries().some(({ eventName }) => eventName === 'PostToolUse')).toBe(
      false,
    );
  });
});

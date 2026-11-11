/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HookRegistry,
  createHookConfigurationRef,
  type Config,
} from '@qwen-code/core';
import { loadFlagSettings, type LoadedSettings } from './config/settings.js';
import { SettingsService } from '@qwen-code/resource';
import { getSettingsZodSchema } from './config/settings-validation.js';
import { getSettingsSchema } from './config/settingsSchema.js';
import { buildHookDiagnostics } from './hookDiagnostics.js';

const disposers: Array<() => void> = [];
afterEach(() => disposers.splice(0).forEach((dispose) => dispose()));

describe('Hook diagnostic original configuration associations', () => {
  it.each(
    [
      ...(['user', 'project', 'local', 'flag'] as const).flatMap((source) =>
        ['legacy', 'service'].map((loader) => ({ source, loader })),
      ),
      { source: 'flag' as const, loader: 'inline' },
    ],
  )(
    'keeps original Hook associations after multiple group removals in $source settings via $loader',
    async ({ source, loader }) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'hook-association-'),
      );
      disposers.push(() =>
        fs.rmSync(directory, { recursive: true, force: true }),
      );
      const userConfigDir = path.join(directory, 'user');
      const projectPath = path.join(directory, 'project');
      fs.mkdirSync(userConfigDir);
      fs.mkdirSync(path.join(projectPath, '.qwen'), { recursive: true });
      const filePath =
        source === 'user'
          ? path.join(userConfigDir, 'settings.json')
          : source === 'project'
            ? path.join(projectPath, '.qwen/settings.json')
            : source === 'local'
              ? path.join(projectPath, '.qwen/settings.local.json')
              : path.join(directory, 'flag.json');
      const service = new SettingsService(
        { schema: getSettingsSchema(), validation: getSettingsZodSchema() },
        {
          headless: true,
          homeDir: path.join(directory, 'home'),
          environment: {},
        },
      );
      disposers.push(() => {
        void service.dispose();
      });
      let inlineFlag: Record<string, unknown> | undefined;
      const resolve = () =>
        service.resolve({
          projectPath,
          sources: source === 'flag' ? [] : [source],
          ...(source === 'flag' ? { flagSettings: inlineFlag ?? filePath } : {}),
        });
      const rows = [
        { command: 'echo missing-type' },
        { type: 'command', command: 'echo invalid-args-1', args: 'bad' },
        { type: 'command', command: 'echo healthy', timeout: 10 },
        { type: 'command' },
        { type: 'command', command: 'echo invalid-args-2', args: 'bad' },
        { type: 'command' },
      ];
      const write = (hooks: unknown[], duplicateLast = false) => {
        const settings = {
          hooks: {
            PermissionRequest: hooks.map((hook, index) => ({
              matcher: '*',
              hooks:
                duplicateLast && index === hooks.length - 1
                  ? [hook, hook]
                  : [hook],
            })),
          },
        };
        if (loader === 'inline') inlineFlag = settings;
        else fs.writeFileSync(filePath, JSON.stringify(settings));
      };
      write(rows, true);
      service.initialize({ userConfigDir });
      const loaded = loadFlagSettings(filePath, getSettingsZodSchema());
      let settings =
        loader !== 'legacy'
          ? resolve()
          : ({
              errors: loaded.errors,
              ...Object.fromEntries(
                ['user', 'project', 'local', 'flag'].map((scope) => [
                  scope,
                  scope === source
                    ? loaded.flag
                    : {
                        path: `/unused/${scope}`,
                        settings: {},
                        originalSettings: {},
                      },
                ]),
              ),
            } as unknown as LoadedSettings);
      const config = {
        getSessionId: () => 'association-test',
        isSettingSourceAllowed: () => true,
        isTrustedFolder: () => true,
        getUserHooks: () => settings.user.settings.hooks,
        getProjectHooks: () => settings.project.settings.hooks,
        getLocalHooks: () => settings.local.settings.hooks,
        getFlagHooks: () => settings.flag.settings.hooks,
        getEnabledPlugins: () => [],
        getBuiltinPluginContributions: () => undefined,
        getPluginErrors: () => [],
        getHookSystem: () => ({ getRegistry: () => registry }),
      } as unknown as Config;
      const registry = new HookRegistry(config);
      await registry.initialize({ emitToFeed: false });
      const expectedRef = (index: number) =>
        createHookConfigurationRef(
          `settings:${source}`,
          'PermissionRequest',
          index,
          0,
          rows[index],
        );
      const snapshot = buildHookDiagnostics(config, settings);
      expect(snapshot.diagnostics.map((issue) => issue.hook_ref)).toEqual([
        expectedRef(0),
        expectedRef(3),
        expectedRef(5),
        createHookConfigurationRef(
          `settings:${source}`,
          'PermissionRequest',
          5,
          1,
          rows[5],
        ),
        expectedRef(1),
        expectedRef(4),
      ]);
      expect(
        snapshot.diagnostics
          .filter((issue) => issue.field)
          .map((issue) => issue.field),
      ).toEqual([
        'hooks.PermissionRequest[1].hooks[0].args',
        'hooks.PermissionRequest[4].hooks[0].args',
      ]);
      expect(
        snapshot.diagnostics.some((issue) => issue.hook_ref === expectedRef(2)),
      ).toBe(false);
      // Existing recovery still removes the same two groups; no validation rules change.
      expect(settings[source].settings.hooks?.PermissionRequest).toHaveLength(
        4,
      );
      if (loader === 'inline') {
        expect(settings.flag.path).toBe('<flag>');
        expect(fs.existsSync(filePath)).toBe(false);
      } else {
        expect(fs.readFileSync(filePath, 'utf8')).toContain('invalid-args-2');
      }

      write(
        rows.map((_, index) => ({
          type: 'command',
          command: `echo repaired-${index}`,
        })),
      );
      if (loader !== 'legacy') {
        if (source === 'flag') settings = resolve();
        else settings.reload();
      } else {
        const repaired = loadFlagSettings(filePath, getSettingsZodSchema());
        Object.assign(settings[source], repaired.flag);
        settings.errors.splice(0, settings.errors.length, ...repaired.errors);
      }
      await registry.initialize({ emitToFeed: false });
      expect(buildHookDiagnostics(config, settings).diagnostics).toEqual([]);
    },
  );
});

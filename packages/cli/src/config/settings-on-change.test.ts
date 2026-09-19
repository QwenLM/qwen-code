/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  LoadedSettings,
  SettingScope,
  type Settings,
  type SettingsFile,
} from './settings.js';

function settingsFile(settings: Settings, filePath: string): SettingsFile {
  return { settings, originalSettings: settings, path: filePath };
}

describe('LoadedSettings.onChange', () => {
  let dir: string;
  let workspacePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-settings-change-'));
    workspacePath = path.join(dir, 'settings.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('tells listeners after a reload, with the new merged value in place', () => {
    const settings = new LoadedSettings(
      settingsFile({}, path.join(dir, 'system.json')),
      settingsFile({}, path.join(dir, 'system-defaults.json')),
      settingsFile({}, path.join(dir, 'user.json')),
      settingsFile({}, workspacePath),
      true,
      new Set(),
    );
    const seen: unknown[] = [];
    settings.onChange(() => {
      throw new Error('a broken listener');
    });
    const unsubscribe = settings.onChange(() =>
      seen.push(settings.merged.agents?.crossSessionInbound),
    );

    fs.writeFileSync(
      workspacePath,
      JSON.stringify({ agents: { crossSessionInbound: 'hold' } }),
    );
    expect(settings.reloadScopeFromDisk(SettingScope.Workspace)).toBe(true);
    expect(seen).toEqual(['hold']);

    unsubscribe();
    settings.recomputeMerged();
    expect(seen).toHaveLength(1);
  });
});

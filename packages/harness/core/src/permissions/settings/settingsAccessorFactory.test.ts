/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { createSettingsAccessor } from './settingsAccessorFactory.js';
import { Storage } from '../../config/storage.js';
import { CONFIG_DIR } from '../../utils/paths.js';

vi.mock('node:fs');

describe('createSettingsAccessor', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = {
      getWorkspaceSettingsPath: () =>
        `/project/${CONFIG_DIR}/settings.json`,
      getWorkspaceLocalSettingsPath: () =>
        `/project/${CONFIG_DIR}/settings.local.json`,
    } as unknown as Storage;

    vi.spyOn(Storage, 'getGlobalSettingsPath').mockReturnValue(
      '/home/user/.qwen/settings.json',
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns enabled sources in correct order', () => {
    const accessor = createSettingsAccessor({ storage });
    expect(accessor.getEnabledSources()).toEqual([
      'userSettings',
      'projectSettings',
      'localSettings',
    ]);
  });

  it('includes additional sources when provided', () => {
    const accessor = createSettingsAccessor({
      storage,
      additionalSources: ['policySettings'],
    });
    expect(accessor.getEnabledSources()).toEqual([
      'userSettings',
      'projectSettings',
      'localSettings',
      'policySettings',
    ]);
  });

  it('reads user settings from global path', () => {
    const settingsJson = {
      permissions: { allow: ['read_file: src/**'] },
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(settingsJson));

    const accessor = createSettingsAccessor({ storage });
    const result = accessor.getSettingsForSource('userSettings');

    expect(fs.readFileSync).toHaveBeenCalledWith(
      '/home/user/.qwen/settings.json',
      'utf-8',
    );
    expect(result).toEqual(settingsJson);
  });

  it('reads project settings from workspace path', () => {
    const settingsJson = {
      permissions: { deny: ['bash: rm -rf /'] },
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(settingsJson));

    const accessor = createSettingsAccessor({ storage });
    const result = accessor.getSettingsForSource('projectSettings');

    expect(fs.readFileSync).toHaveBeenCalledWith(
      `/project/${CONFIG_DIR}/settings.json`,
      'utf-8',
    );
    expect(result).toEqual(settingsJson);
  });

  it('reads local settings from workspace local path', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('{"permissions": {}}');

    const accessor = createSettingsAccessor({ storage });
    accessor.getSettingsForSource('localSettings');

    expect(fs.readFileSync).toHaveBeenCalledWith(
      `/project/${CONFIG_DIR}/settings.local.json`,
      'utf-8',
    );
  });

  it('returns null for non-existent files', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const accessor = createSettingsAccessor({ storage });
    expect(accessor.getSettingsForSource('userSettings')).toBeNull();
  });

  it('returns null for unsupported sources like session', () => {
    const accessor = createSettingsAccessor({ storage });
    expect(accessor.getSettingsForSource('session')).toBeNull();
  });

  it('returns null on parse error', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('not valid json');

    const accessor = createSettingsAccessor({ storage });
    expect(accessor.getSettingsForSource('userSettings')).toBeNull();
  });
});

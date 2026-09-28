/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getGlobalQwenDirLite,
  getSystemDefaultsPath,
  getSystemSettingsPath,
  isFullyQualifiedPath,
} from './storage-paths-lite.js';

describe('settings locations in a given environment', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const runOn = (value: string) =>
    Object.defineProperty(process, 'platform', { value });
  const home = path.resolve('/located', 'qwen-home');
  const settingsPath = path.resolve('/located', 'settings.json');
  const defaultsPath = path.resolve('/located', 'system-defaults.json');

  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
  });

  it('finds a name spelled in another case on Windows', () => {
    runOn('win32');

    expect(getGlobalQwenDirLite({ qwen_home: home })).toBe(home);
    expect(
      getSystemSettingsPath({ Qwen_Code_System_Settings_Path: settingsPath }),
    ).toBe(settingsPath);
    expect(
      getSystemDefaultsPath({ qwen_code_system_defaults_path: defaultsPath }),
    ).toBe(defaultsPath);
  });

  it('passes on the first spelling in sorted order on Windows, as spawn does', () => {
    runOn('win32');
    const other = path.resolve('/other');

    // Upper case sorts first, so the exact name wins over other spellings.
    expect(getGlobalQwenDirLite({ qwen_home: other, QWEN_HOME: home })).toBe(
      home,
    );
    expect(getGlobalQwenDirLite({ qwen_home: other, Qwen_Home: home })).toBe(
      home,
    );
    // A first spelling without a value is not passed on at all.
    expect(
      getGlobalQwenDirLite({ QWEN_HOME: undefined, qwen_home: other }),
    ).toBe(path.join(os.homedir(), '.qwen'));
  });

  it.each([
    ['C:\\qwen', true],
    ['c:/qwen', true],
    ['\\\\server\\share\\qwen', true],
    ['//server/share/qwen', true],
    ['\\\\?\\C:\\qwen', true],
    ['\\\\', false],
    ['\\\\server', false],
    ['\\qwen', false],
    ['/qwen', false],
    ['C:qwen', false],
    ['qwen', false],
  ])('on Windows, treats %s as fully qualified: %s', (location, expected) => {
    runOn('win32');

    expect(isFullyQualifiedPath(location)).toBe(expected);
  });

  it('matches names exactly on other platforms', () => {
    runOn('linux');

    expect(getGlobalQwenDirLite({ qwen_home: home })).toBe(
      path.join(os.homedir(), '.qwen'),
    );
  });
});

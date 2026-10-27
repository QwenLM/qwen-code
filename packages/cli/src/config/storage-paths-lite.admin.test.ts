/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Paths reported as present (installed) or as failing to check for a reason
// other than absence; every other path goes to the real accessSync.
const installed = new Set<string>();
const uninspectable = new Set<string>();

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  const accessSync = (location: fs.PathLike, mode?: number) => {
    const text = String(location);
    if (installed.has(text)) return;
    if (uninspectable.has(text)) {
      throw Object.assign(new Error(`EACCES: ${text}`), { code: 'EACCES' });
    }
    actual.accessSync(location, mode);
  };
  return { ...actual, default: { ...actual, accessSync }, accessSync };
});

type Resolver = typeof import('./storage-paths-lite.js');

describe('system settings path overrides while an administrator file is installed', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const runOn = (value: string) =>
    Object.defineProperty(process, 'platform', { value });
  const settingsOverride = path.resolve('/override', 'settings.json');
  const defaultsOverride = path.resolve('/override', 'system-defaults.json');
  let warn: ReturnType<typeof vi.spyOn>;
  let resolver: Resolver;

  beforeEach(async () => {
    // A fresh module per test resets the one-shot warnings.
    vi.resetModules();
    resolver = await import('./storage-paths-lite.js');
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    runOn('linux');
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    installed.clear();
    uninspectable.clear();
    warn.mockRestore();
  });

  it('honors both overrides as before while no administrator file is installed', () => {
    expect(
      resolver.getSystemSettingsPath({
        QWEN_CODE_SYSTEM_SETTINGS_PATH: settingsOverride,
      }),
    ).toBe(settingsOverride);
    expect(
      resolver.getSystemDefaultsPath({
        QWEN_CODE_SYSTEM_DEFAULTS_PATH: defaultsOverride,
      }),
    ).toBe(defaultsOverride);
    expect(
      resolver.getSystemDefaultsPath({
        QWEN_CODE_SYSTEM_SETTINGS_PATH: settingsOverride,
      }),
    ).toBe(path.join(path.dirname(settingsOverride), 'system-defaults.json'));
    expect(warn).not.toHaveBeenCalled();
  });

  it('ignores the settings override once the administrator settings file is installed', () => {
    installed.add('/etc/qwen-code/settings.json');
    const env = { QWEN_CODE_SYSTEM_SETTINGS_PATH: settingsOverride };

    expect(resolver.getSystemSettingsPath(env)).toBe(
      '/etc/qwen-code/settings.json',
    );
    expect(resolver.getSystemSettingsPath(env)).toBe(
      '/etc/qwen-code/settings.json',
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      'QWEN_CODE_SYSTEM_SETTINGS_PATH',
    );
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      '"/etc/qwen-code/settings.json"',
    );
  });

  it('keeps both layers in the platform directory when both overrides are set', () => {
    installed.add('/etc/qwen-code/settings.json');
    const env = {
      QWEN_CODE_SYSTEM_SETTINGS_PATH: settingsOverride,
      QWEN_CODE_SYSTEM_DEFAULTS_PATH: defaultsOverride,
    };

    expect(resolver.getSystemSettingsPath(env)).toBe(
      '/etc/qwen-code/settings.json',
    );
    expect(resolver.getSystemDefaultsPath(env)).toBe(
      '/etc/qwen-code/system-defaults.json',
    );
    const warnings = warn.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(warnings).toHaveLength(2);
    expect(
      warnings.some((text: string) =>
        text.startsWith('QWEN_CODE_SYSTEM_DEFAULTS_PATH is set'),
      ),
    ).toBe(true);
  });

  it('does not derive the defaults beside an ignored settings override', () => {
    installed.add('/etc/qwen-code/settings.json');

    expect(
      resolver.getSystemDefaultsPath({
        QWEN_CODE_SYSTEM_SETTINGS_PATH: settingsOverride,
      }),
    ).toBe('/etc/qwen-code/system-defaults.json');
  });

  it('treats an installed system defaults file as an administrator file', () => {
    installed.add('/etc/qwen-code/system-defaults.json');

    expect(
      resolver.getSystemSettingsPath({
        QWEN_CODE_SYSTEM_SETTINGS_PATH: settingsOverride,
      }),
    ).toBe('/etc/qwen-code/settings.json');
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      '"/etc/qwen-code/system-defaults.json"',
    );
  });

  it('treats an administrator path that cannot be inspected as installed', () => {
    uninspectable.add('/etc/qwen-code/settings.json');

    expect(
      resolver.getSystemSettingsPath({
        QWEN_CODE_SYSTEM_SETTINGS_PATH: settingsOverride,
      }),
    ).toBe('/etc/qwen-code/settings.json');
  });

  it('applies the same rule to the macOS location', () => {
    runOn('darwin');
    installed.add('/Library/Application Support/QwenCode/settings.json');

    expect(
      resolver.getSystemSettingsPath({
        QWEN_CODE_SYSTEM_SETTINGS_PATH: settingsOverride,
      }),
    ).toBe('/Library/Application Support/QwenCode/settings.json');
  });

  it('applies the same rule to the Windows location', () => {
    runOn('win32');
    const windowsOverride = 'D:\\override\\settings.json';
    const env = { QWEN_CODE_SYSTEM_SETTINGS_PATH: windowsOverride };

    expect(resolver.getSystemSettingsPath(env)).toBe(windowsOverride);

    installed.add('C:\\ProgramData\\qwen-code\\settings.json');
    expect(resolver.getSystemSettingsPath(env)).toBe(
      'C:\\ProgramData\\qwen-code\\settings.json',
    );
  });
});

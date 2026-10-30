/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Entries the resolver may stat, with the ownership metadata it reads;
// every other path goes to the real lstatSync/statSync/realpathSync. A
// symlink entry resolves to its `target` when one is registered, and to
// nothing (ENOENT) when the link dangles.
type Entry = {
  uid: number;
  kind: 'file' | 'directory' | 'symlink';
  target?: string;
};
const entries = new Map<string, Entry>();
const uninspectable = new Set<string>();

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  const statsFor = (entry: Entry): fs.Stats =>
    ({
      uid: entry.uid,
      isFile: () => entry.kind === 'file',
      isDirectory: () => entry.kind === 'directory',
      isSymbolicLink: () => entry.kind === 'symlink',
    }) as unknown as fs.Stats;
  const lstatSync = (location: fs.PathLike) => {
    const text = String(location);
    if (uninspectable.has(text)) {
      throw Object.assign(new Error(`EACCES: ${text}`), { code: 'EACCES' });
    }
    const entry = entries.get(text);
    return entry ? statsFor(entry) : actual.lstatSync(location);
  };
  const statSync = (location: fs.PathLike) => {
    const text = String(location);
    if (uninspectable.has(text)) {
      throw Object.assign(new Error(`EACCES: ${text}`), { code: 'EACCES' });
    }
    const entry = entries.get(text);
    return entry ? statsFor(entry) : actual.statSync(location);
  };
  const realpathSync = (location: fs.PathLike) => {
    const text = String(location);
    if (uninspectable.has(text)) {
      throw Object.assign(new Error(`EACCES: ${text}`), { code: 'EACCES' });
    }
    const entry = entries.get(text);
    if (entry?.kind === 'symlink') {
      if (entry.target === undefined) {
        throw Object.assign(new Error(`ENOENT: ${text}`), { code: 'ENOENT' });
      }
      return entry.target;
    }
    if (entry) return text;
    return actual.realpathSync(location);
  };
  const existsSync = (location: fs.PathLike) => {
    const text = String(location);
    if (uninspectable.has(text)) return false;
    if (entries.has(text)) return true;
    return actual.existsSync(location);
  };
  return {
    ...actual,
    default: { ...actual, lstatSync, statSync, realpathSync, existsSync },
    lstatSync,
    statSync,
    realpathSync,
    existsSync,
  };
});

type Resolver = typeof import('./storage-paths-lite.js');

describe('system settings path overrides while an administrator file is installed', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const runOn = (value: string) =>
    Object.defineProperty(process, 'platform', { value });
  const settingsOverride = path.resolve('/override', 'settings.json');
  const defaultsOverride = path.resolve('/override', 'system-defaults.json');
  const trust = (location: string, uid = 0) => {
    entries.set(location, { uid, kind: 'file' });
    // The gate also requires the containing directory to be root-owned.
    entries.set(path.dirname(location), { uid: 0, kind: 'directory' });
  };
  const install = (file: string, uid = 0) => {
    entries.set(file, { uid, kind: 'file' });
    entries.set(path.dirname(file), { uid: 0, kind: 'directory' });
  };
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
    entries.clear();
    uninspectable.clear();
    warn.mockRestore();
  });

  it('honors trusted overrides while no administrator file is installed', () => {
    trust(settingsOverride);
    trust(defaultsOverride);

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

  it('rejects a user-owned regular file override even while no administrator file is installed', () => {
    trust(settingsOverride, 1000);

    expect(
      resolver.getSystemSettingsPath({
        QWEN_CODE_SYSTEM_SETTINGS_PATH: settingsOverride,
      }),
    ).toBe('/etc/qwen-code/settings.json');
    expect(String(warn.mock.calls[0]?.[0])).toBe(
      `QWEN_CODE_SYSTEM_SETTINGS_PATH is set to ${JSON.stringify(settingsOverride)}, which is not a regular root-owned file, so the platform default is used instead.`,
    );
  });

  it('ignores the settings override once the administrator settings file is installed', () => {
    install('/etc/qwen-code/settings.json');
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
    install('/etc/qwen-code/settings.json');
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
    install('/etc/qwen-code/settings.json');

    expect(
      resolver.getSystemDefaultsPath({
        QWEN_CODE_SYSTEM_SETTINGS_PATH: settingsOverride,
      }),
    ).toBe('/etc/qwen-code/system-defaults.json');
  });

  it('treats an installed system defaults file as an administrator file', () => {
    install('/etc/qwen-code/system-defaults.json');

    expect(
      resolver.getSystemSettingsPath({
        QWEN_CODE_SYSTEM_SETTINGS_PATH: settingsOverride,
      }),
    ).toBe('/etc/qwen-code/settings.json');
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      '"/etc/qwen-code/system-defaults.json"',
    );
  });

  it('keeps honoring a trusted override while the installed entry is user-owned', () => {
    install('/etc/qwen-code/settings.json', 1000);
    trust(settingsOverride);

    expect(
      resolver.getSystemSettingsPath({
        QWEN_CODE_SYSTEM_SETTINGS_PATH: settingsOverride,
      }),
    ).toBe(settingsOverride);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps honoring a trusted override while the entry parent directory is user-owned', () => {
    entries.set('/etc/qwen-code/settings.json', { uid: 0, kind: 'file' });
    entries.set('/etc/qwen-code', { uid: 1000, kind: 'directory' });
    trust(settingsOverride);

    expect(
      resolver.getSystemSettingsPath({
        QWEN_CODE_SYSTEM_SETTINGS_PATH: settingsOverride,
      }),
    ).toBe(settingsOverride);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps honoring a trusted override while the installed entry is a symlink', () => {
    entries.set('/etc/qwen-code/settings.json', { uid: 0, kind: 'symlink' });
    entries.set('/etc/qwen-code', { uid: 0, kind: 'directory' });
    trust(settingsOverride);

    expect(
      resolver.getSystemSettingsPath({
        QWEN_CODE_SYSTEM_SETTINGS_PATH: settingsOverride,
      }),
    ).toBe(settingsOverride);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps honoring a trusted override while the administrator path cannot be inspected', () => {
    uninspectable.add('/etc/qwen-code/settings.json');
    trust(settingsOverride);

    expect(
      resolver.getSystemSettingsPath({
        QWEN_CODE_SYSTEM_SETTINGS_PATH: settingsOverride,
      }),
    ).toBe(settingsOverride);
    expect(warn).not.toHaveBeenCalled();
  });

  it('applies the same rule to the macOS location', () => {
    runOn('darwin');
    install('/Library/Application Support/QwenCode/settings.json');

    expect(
      resolver.getSystemSettingsPath({
        QWEN_CODE_SYSTEM_SETTINGS_PATH: settingsOverride,
      }),
    ).toBe('/Library/Application Support/QwenCode/settings.json');
  });

  it('fails closed to the platform default for a Windows override outside the system directory', () => {
    runOn('win32');
    const windowsOverride = 'D:\\override\\settings.json';
    const env = { QWEN_CODE_SYSTEM_SETTINGS_PATH: windowsOverride };

    expect(resolver.getSystemSettingsPath(env)).toBe(
      'C:\\ProgramData\\qwen-code\\settings.json',
    );
    expect(String(warn.mock.calls[0]?.[0])).toBe(
      `QWEN_CODE_SYSTEM_SETTINGS_PATH is set to ${JSON.stringify(windowsOverride)}, which does not point inside C:\\ProgramData\\qwen-code\\, so the platform default is used instead.`,
    );
  });

  it('honors a Windows override that stays inside the system directory', () => {
    runOn('win32');
    const windowsOverride = 'C:\\ProgramData\\qwen-code\\policy.json';
    entries.set(windowsOverride, { uid: 0, kind: 'file' });

    expect(
      resolver.getSystemSettingsPath({
        QWEN_CODE_SYSTEM_SETTINGS_PATH: windowsOverride,
      }),
    ).toBe(windowsOverride);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps honoring a trusted Windows override while a file is planted at the platform default', () => {
    runOn('win32');
    // C:\ProgramData lets ordinary users create subdirectories they own, and
    // Node exposes no ACL: no entry at the platform default proves the layers
    // are managed, so it must not suppress the override, even one reported
    // root-owned. '.' is the parent a Unix host derives for a Windows path,
    // registered so a mutant that removes the Windows guard is deterministic.
    entries.set('C:\\ProgramData\\qwen-code\\settings.json', {
      uid: 0,
      kind: 'file',
    });
    entries.set('.', { uid: 0, kind: 'directory' });
    const windowsOverride = 'C:\\ProgramData\\qwen-code\\policy.json';
    entries.set(windowsOverride, { uid: 0, kind: 'file' });

    expect(
      resolver.getSystemSettingsPath({
        QWEN_CODE_SYSTEM_SETTINGS_PATH: windowsOverride,
      }),
    ).toBe(windowsOverride);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps honoring a trusted Windows override while a user-owned file is planted at the platform default', () => {
    runOn('win32');
    entries.set('C:\\ProgramData\\qwen-code\\settings.json', {
      uid: 1000,
      kind: 'file',
    });
    const windowsOverride = 'C:\\ProgramData\\qwen-code\\policy.json';
    entries.set(windowsOverride, { uid: 0, kind: 'file' });

    expect(
      resolver.getSystemSettingsPath({
        QWEN_CODE_SYSTEM_SETTINGS_PATH: windowsOverride,
      }),
    ).toBe(windowsOverride);
    expect(warn).not.toHaveBeenCalled();
  });

  it('fails closed for a Windows override that names no file inside the system directory', () => {
    runOn('win32');
    const windowsOverride = 'C:\\ProgramData\\qwen-code\\no-such-file.json';

    expect(
      resolver.getSystemSettingsPath({
        QWEN_CODE_SYSTEM_SETTINGS_PATH: windowsOverride,
      }),
    ).toBe('C:\\ProgramData\\qwen-code\\settings.json');
    expect(String(warn.mock.calls[0]?.[0])).toBe(
      `QWEN_CODE_SYSTEM_SETTINGS_PATH is set to ${JSON.stringify(windowsOverride)}, which does not name an existing file inside C:\\ProgramData\\qwen-code\\, so the platform default is used instead.`,
    );
  });

  it('honors an override delivered by a symlink to a root-owned file in a root-owned directory', () => {
    const link = '/override/link.json';
    entries.set(settingsOverride, { uid: 0, kind: 'file' });
    entries.set('/override', { uid: 0, kind: 'directory' });
    entries.set(link, {
      uid: 0,
      kind: 'symlink',
      target: settingsOverride,
    });

    expect(
      resolver.getSystemSettingsPath({
        QWEN_CODE_SYSTEM_SETTINGS_PATH: link,
      }),
    ).toBe(link);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps rejecting a link whose target sits in a user-owned directory', () => {
    const link = '/override/link.json';
    entries.set('/user-owned/settings.json', { uid: 0, kind: 'file' });
    entries.set('/user-owned', { uid: 1000, kind: 'directory' });
    entries.set(link, {
      uid: 0,
      kind: 'symlink',
      target: '/user-owned/settings.json',
    });

    expect(
      resolver.getSystemSettingsPath({
        QWEN_CODE_SYSTEM_SETTINGS_PATH: link,
      }),
    ).toBe('/etc/qwen-code/settings.json');
    expect(String(warn.mock.calls[0]?.[0])).toBe(
      `QWEN_CODE_SYSTEM_SETTINGS_PATH is set to ${JSON.stringify(link)}, which is not a regular root-owned file, so the platform default is used instead.`,
    );
  });

  it('counts an administrator file delivered by a symlink as installed', () => {
    entries.set('/etc/qwen-code/settings.json', {
      uid: 0,
      kind: 'symlink',
      target: '/etc/qwen-code/..data/settings.json',
    });
    entries.set('/etc/qwen-code/..data/settings.json', {
      uid: 0,
      kind: 'file',
    });
    entries.set('/etc/qwen-code/..data', { uid: 0, kind: 'directory' });
    trust(settingsOverride);

    expect(
      resolver.getSystemSettingsPath({
        QWEN_CODE_SYSTEM_SETTINGS_PATH: settingsOverride,
      }),
    ).toBe('/etc/qwen-code/settings.json');
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      '"/etc/qwen-code/settings.json"',
    );
  });
});
